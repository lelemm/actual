use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use chrono::{TimeZone, Utc};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{
    app::AppState,
    services::secrets_service,
    util::{middlewares::ValidatedSession, ssrf::is_blocked_ip},
};

use super::{
    services::enablebanking_service::{
        PsuHeaders, create_session, get_all_transactions, get_aspsps, get_balances, is_configured,
        is_importable_transaction, normalize_account, normalize_balance, normalize_transaction,
        start_auth, validate_credentials,
    },
    utils::errors::EnableBankingError,
};

const APPLICATION_ID: &str = "enablebanking_applicationId";
const SECRET_KEY: &str = "enablebanking_secretKey";
const POLL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const COMPLETED_AUTH_TTL: Duration = Duration::from_secs(30);

type PendingSender = oneshot::Sender<Result<Value, String>>;

#[derive(Clone, Default)]
pub struct EnableBankingState {
    pending: Arc<Mutex<HashMap<String, (u64, PendingSender)>>>,
    completed: Arc<Mutex<HashMap<String, Value>>>,
    next_waiter_id: Arc<Mutex<u64>>,
}

impl EnableBankingState {
    fn complete(&self, auth_state: &str, result: Value, error: Option<String>) {
        self.completed
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(auth_state.into(), result.clone());
        if let Some((_, sender)) = self
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(auth_state)
        {
            let _ = sender.send(error.map_or(Ok(result), Err));
        }
        let completed = self.completed.clone();
        let auth_state = auth_state.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(COMPLETED_AUTH_TTL).await;
            completed
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&auth_state);
        });
    }

    fn next_waiter(&self) -> u64 {
        let mut next = self
            .next_waiter_id
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *next += 1;
        *next
    }

    fn cleanup_pending(&self, auth_state: &str, waiter_id: u64) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if pending
            .get(auth_state)
            .is_some_and(|(existing_id, _)| *existing_id == waiter_id)
        {
            pending.remove(auth_state);
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth_callback", get(auth_callback))
        .route("/status", post(status))
        .route("/configure", post(configure))
        .route("/aspsps", post(aspsps))
        .route("/start-auth", post(start_auth_route))
        .route("/complete-auth", post(complete_auth))
        .route("/poll-auth", post(poll_auth))
        .route("/transactions", post(transactions))
}

async fn auth_callback(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(code) = query.get("code").filter(|value| !value.is_empty()) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html("<html><body><p>Authorization failed: missing code.</p></body></html>"),
        )
            .into_response();
    };
    let Some(auth_state) = query.get("state").filter(|value| !value.is_empty()) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html("<html><body><p>Authorization failed: missing state parameter.</p></body></html>"),
        )
            .into_response();
    };
    match create_session(&state, code).await {
        Ok(session) => {
            match build_session_result(&state, &session, &psu_headers(peer, &headers)).await {
                Ok(result) => {
                    state.enablebanking.complete(auth_state, result, None);
                    Html(
                    "<html><body><p>Authorization successful. This window will close.</p><script>setTimeout(function(){window.close()},1000)</script></body></html>",
                )
                .into_response()
                }
                Err(error) => callback_error(&state, auth_state, error),
            }
        }
        Err(error) => callback_error(&state, auth_state, error),
    }
}

fn callback_error(state: &AppState, auth_state: &str, error: EnableBankingError) -> Response {
    state.enablebanking.complete(
        auth_state,
        json!({ "error": error.message }),
        Some(error.message),
    );
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Html("<html><body><p>Authorization failed. You can close this window and try again.</p></body></html>"),
    )
        .into_response()
}

async fn status(State(state): State<AppState>, ValidatedSession(_): ValidatedSession) -> Response {
    match is_configured(&state) {
        Ok(configured) => ok(json!({ "configured": configured })),
        Err(error) => internal_error(error),
    }
}

async fn configure(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let body = body.map(|body| body.0).unwrap_or(Value::Null);
    let application_id = body.get("applicationId").and_then(Value::as_str);
    let secret_key = body.get("secretKey").and_then(Value::as_str);
    let (Some(application_id), Some(secret_key)) = (application_id, secret_key) else {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing applicationId or secretKey"
        }));
    };
    if application_id.is_empty() || secret_key.is_empty() {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing applicationId or secretKey"
        }));
    }
    if let Err(error) = validate_credentials(&state, application_id, secret_key).await {
        return ok(json!({
            "error_code": "CONFIGURATION_FAILED",
            "error_type": error.message
        }));
    }
    let connection = state
        .database
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Err(error) =
        secrets_service::set(&connection, APPLICATION_ID, Some(application_id), None)
            .and_then(|()| secrets_service::set(&connection, SECRET_KEY, Some(secret_key), None))
    {
        return internal_error(EnableBankingError::new(
            "INTERNAL_ERROR",
            "INTERNAL_ERROR",
            Some(error.to_string()),
        ));
    }
    ok(json!({ "configured": true }))
}

async fn aspsps(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let country = body
        .as_ref()
        .and_then(|body| body.get("country"))
        .and_then(Value::as_str);
    match get_aspsps(&state, country).await {
        Ok(value) => ok(value),
        Err(error) => ok(json!({ "error": error.message })),
    }
}

async fn start_auth_route(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let body = body.map(|body| body.0).unwrap_or(Value::Null);
    let aspsp = body.get("aspsp").filter(|value| javascript_truthy(value));
    let redirect_url = body
        .get("redirectUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let (Some(aspsp), Some(redirect_url)) = (aspsp, redirect_url) else {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing aspsp or redirectUrl"
        }));
    };
    let auth_state = uuid::Uuid::new_v4().to_string();
    let psu_type = if body.get("psuType").and_then(Value::as_str) == Some("business") {
        "business"
    } else {
        "personal"
    };
    match start_auth(
        &state,
        aspsp,
        redirect_url,
        &auth_state,
        body.get("maxConsentValidity").and_then(Value::as_f64),
        psu_type,
    )
    .await
    {
        Ok(response) => ok(json!({
            "url": response.get("url").cloned().unwrap_or(Value::Null),
            "state": auth_state
        })),
        Err(error) => ok(json!({ "error": error.message })),
    }
}

async fn complete_auth(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let body = body.map(|body| body.0).unwrap_or(Value::Null);
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(code) = code else {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing code"
        }));
    };
    let auth_state = body
        .get("state")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let result = match create_session(&state, code).await {
        Ok(session) => build_session_result(&state, &session, &psu_headers(peer, &headers)).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(result) => {
            if let Some(auth_state) = auth_state {
                state
                    .enablebanking
                    .complete(auth_state, result.clone(), None);
            }
            ok(result)
        }
        Err(error) => {
            let result = json!({ "error": error.message });
            if let Some(auth_state) = auth_state {
                state.enablebanking.complete(
                    auth_state,
                    result.clone(),
                    result
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                );
            }
            ok(result)
        }
    }
}

async fn poll_auth(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let auth_state = body
        .as_ref()
        .and_then(|body| body.get("state"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(auth_state) = auth_state else {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing state"
        }));
    };
    if let Some(result) = state
        .enablebanking
        .completed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(auth_state)
    {
        return ok(result);
    }
    let waiter_id = state.enablebanking.next_waiter();
    let (sender, receiver) = oneshot::channel();
    if let Some((_, existing)) = state
        .enablebanking
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(auth_state.into(), (waiter_id, sender))
    {
        let _ = existing.send(Err("Poll superseded".into()));
    }
    let result = tokio::time::timeout(POLL_TIMEOUT, receiver).await;
    state.enablebanking.cleanup_pending(auth_state, waiter_id);
    match result {
        Ok(Ok(Ok(value))) => ok(value),
        Ok(Ok(Err(error))) => ok(json!({ "error": error })),
        Ok(Err(_)) => ok(json!({ "error": "Poll superseded" })),
        Err(_) => ok(json!({ "error": "Polling timed out" })),
    }
}

async fn transactions(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ValidatedSession(_): ValidatedSession,
    body: Option<Json<Value>>,
) -> Response {
    let body = body.map(|body| body.0).unwrap_or(Value::Null);
    let account_id = body
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let start_date = body
        .get("startDate")
        .filter(|value| javascript_truthy(value));
    let (Some(account_id), Some(start_date)) = (account_id, start_date) else {
        return ok(json!({
            "error_code": "INVALID_INPUT",
            "error_type": "Missing accountId or startDate"
        }));
    };
    let date_from = match date_string(start_date) {
        Some(value) => value,
        None => {
            return ok(json!({ "error_type": "INTERNAL_ERROR", "error_code": "INTERNAL_ERROR" }));
        }
    };
    let date_to = Utc::now().format("%Y-%m-%d").to_string();
    let psu_headers = psu_headers(peer, &headers);
    let result = async {
        let balances_result = get_balances(&state, account_id, &psu_headers).await?;
        let balances = balances_result
            .get("balances")
            .and_then(Value::as_array)
            .map(|balances| balances.iter().map(normalize_balance).collect::<Vec<_>>())
            .unwrap_or_default();
        let starting_balance = balances
            .iter()
            .find(|balance| balance.get("balanceType").and_then(Value::as_str) == Some("CLAV"))
            .or_else(|| balances.first())
            .and_then(|balance| balance.pointer("/balanceAmount/amount"))
            .cloned()
            .unwrap_or_else(|| Value::from(0));
        let raw =
            get_all_transactions(&state, account_id, &date_from, &date_to, &psu_headers).await?;
        let all = raw
            .iter()
            .map(normalize_transaction)
            .filter(is_importable_transaction)
            .collect::<Vec<_>>();
        let booked = all
            .iter()
            .filter(|transaction| transaction.get("booked").and_then(Value::as_bool) == Some(true))
            .cloned()
            .collect::<Vec<_>>();
        let pending = all
            .iter()
            .filter(|transaction| transaction.get("booked").and_then(Value::as_bool) == Some(false))
            .cloned()
            .collect::<Vec<_>>();
        Ok::<_, EnableBankingError>(json!({
            "transactions": { "all": all, "booked": booked, "pending": pending },
            "balances": balances,
            "startingBalance": starting_balance
        }))
    }
    .await;
    match result {
        Ok(value) => ok(value),
        Err(error) if error.error_code == "INVALID_ACCESS_TOKEN" => ok(json!({
            "error_type": "ITEM_ERROR",
            "error_code": "ITEM_LOGIN_REQUIRED"
        })),
        Err(error) => {
            let error_type = if error.error_code == "NOT_FOUND" {
                "INVALID_INPUT"
            } else {
                &error.error_code
            };
            ok(json!({ "error_type": error_type, "error_code": error.error_code }))
        }
    }
}

async fn build_session_result(
    state: &AppState,
    session: &Value,
    psu_headers: &PsuHeaders,
) -> Result<Value, EnableBankingError> {
    let aspsp = session.get("aspsp");
    let mut accounts = Vec::new();
    for account in session
        .get("accounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut normalized = normalize_account(account, aspsp)
            .as_object()
            .cloned()
            .unwrap_or_default();
        let balances = match account.get("uid").and_then(Value::as_str) {
            Some(uid) => get_balances(state, uid, psu_headers)
                .await
                .ok()
                .and_then(|value| value.get("balances").and_then(Value::as_array).cloned())
                .unwrap_or_default()
                .iter()
                .map(normalize_balance)
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        let balance = balances
            .iter()
            .find(|balance| balance.get("balanceType").and_then(Value::as_str) == Some("CLAV"))
            .or_else(|| balances.first())
            .and_then(|balance| balance.pointer("/balanceAmount/amount"))
            .cloned()
            .unwrap_or_else(|| Value::from(0));
        normalized.insert("balance".into(), balance);
        normalized.insert("balances".into(), Value::Array(balances));
        accounts.push(Value::Object(normalized));
    }
    Ok(json!({
        "session_id": session.get("session_id").cloned().unwrap_or(Value::Null),
        "accounts": accounts,
        "aspsp": session.get("aspsp").cloned().unwrap_or(Value::Null)
    }))
}

fn psu_headers(peer: SocketAddr, headers: &HeaderMap) -> PsuHeaders {
    if is_blocked_ip(peer.ip(), false) {
        return Vec::new();
    }
    let mut result = vec![("Psu-Ip-Address", peer.ip().to_string())];
    if let Some(user_agent) = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
    {
        result.push(("Psu-User-Agent", user_agent.into()));
    }
    result
}

fn date_string(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return Some(value.into());
    }
    let milliseconds = value.as_f64()? as i64;
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn ok(data: Value) -> Response {
    Json(json!({ "status": "ok", "data": data })).into_response()
}

fn internal_error(error: EnableBankingError) -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": "internal-error", "details": error.message })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;
