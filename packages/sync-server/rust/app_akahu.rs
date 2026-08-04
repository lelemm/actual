use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use chrono_tz::Pacific::Auckland;
use reqwest::{Method, Url};
use serde_json::{Map, Value, json};

use crate::{app::AppState, services::secrets_service, util::middlewares::ValidatedSession};

const USER_TOKEN: &str = "akahu_userToken";
const APP_TOKEN: &str = "akahu_appToken";
const REFRESH_INTERVAL_SECONDS: i64 = 60 * 60;

enum TransactionError {
    Direct(&'static str),
    Fetch(String),
}

impl From<String> for TransactionError {
    fn from(error: String) -> Self {
        Self::Fetch(error)
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", post(status))
        .route("/accounts", post(accounts))
        .route("/transactions", post(transactions))
}

async fn status(State(state): State<AppState>, ValidatedSession(_): ValidatedSession) -> Response {
    match tokens(&state) {
        Ok((user_token, app_token)) => Json(json!({
            "status": "ok",
            "data": { "configured": user_token.is_some() && app_token.is_some() }
        }))
        .into_response(),
        Err(error) => internal_error(error),
    }
}

async fn accounts(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
) -> Response {
    let (user_token, app_token) = match tokens(&state) {
        Ok((Some(user_token), Some(app_token)))
            if !user_token.is_empty() && !app_token.is_empty() =>
        {
            (user_token, app_token)
        }
        Ok(_) => return missing_tokens(),
        Err(error) => return internal_error(error),
    };
    match api_call(
        &state,
        &app_token,
        &user_token,
        Method::GET,
        "/accounts",
        &[],
    )
    .await
    {
        Ok(accounts) => {
            Json(json!({ "status": "ok", "data": { "accounts": accounts } })).into_response()
        }
        Err(error) => {
            Json(json!({ "status": "error", "data": { "error": error } })).into_response()
        }
    }
}

async fn transactions(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let account_id = body.get("accountId").and_then(Value::as_str);
    let start_date = body.get("startDate").and_then(Value::as_str);
    let (Some(account_id), Some(start_date)) = (account_id, start_date) else {
        return Json(json!({
            "status": "error",
            "data": { "error": "accountId and startDate are required" }
        }))
        .into_response();
    };
    if account_id.is_empty() || start_date.is_empty() {
        return Json(json!({
            "status": "error",
            "data": { "error": "accountId and startDate are required" }
        }))
        .into_response();
    }
    let (user_token, app_token) = match tokens(&state) {
        Ok((Some(user_token), Some(app_token)))
            if !user_token.is_empty() && !app_token.is_empty() =>
        {
            (user_token, app_token)
        }
        Ok(_) => return missing_tokens(),
        Err(error) => return internal_error(error),
    };
    match transactions_data(&state, &app_token, &user_token, account_id, start_date).await {
        Ok(data) => Json(json!({ "status": "ok", "data": data })).into_response(),
        Err(TransactionError::Direct(error)) => {
            Json(json!({ "status": "error", "data": { "error": error } })).into_response()
        }
        Err(TransactionError::Fetch(error)) => Json(json!({
            "status": "error",
            "data": { "error": format!("Failed to fetch transactions: {error}") }
        }))
        .into_response(),
    }
}

async fn transactions_data(
    state: &AppState,
    app_token: &str,
    user_token: &str,
    account_id: &str,
    start_date: &str,
) -> Result<Value, TransactionError> {
    let account = get_refreshed_account(state, app_token, user_token, account_id)
        .await?
        .ok_or(TransactionError::Direct("Account not found"))?;
    let balance = account
        .get("balance")
        .and_then(Value::as_object)
        .ok_or(TransactionError::Direct("Account balance unavailable"))?;
    let start = parse_javascript_date(start_date)?;
    let end = first_day_next_local_month()?;
    let start_iso = javascript_iso(start);
    let end_iso = javascript_iso(end);
    let mut booked_source = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut query = vec![("start", start_iso.as_str()), ("end", end_iso.as_str())];
        if let Some(cursor) = cursor.as_deref() {
            query.push(("cursor", cursor));
        }
        let page = api_call(
            state,
            app_token,
            user_token,
            Method::GET,
            &format!("/accounts/{account_id}/transactions"),
            &query,
        )
        .await?;
        booked_source.extend(
            page.get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        cursor = page
            .get("cursor")
            .and_then(|cursor| cursor.get("next"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    let pending_source = api_call(
        state,
        app_token,
        user_token,
        Method::GET,
        &format!("/accounts/{account_id}/transactions/pending"),
        &[],
    )
    .await?
    .as_array()
    .cloned()
    .unwrap_or_default();

    let reference = account
        .get("refreshed")
        .and_then(|refreshed| refreshed.get("balance"))
        .and_then(Value::as_str)
        .map(parse_javascript_date)
        .transpose()?
        .unwrap_or_else(Utc::now);
    let reference_date = nz_date(reference);
    let current_balance = js_cents(balance.get("current").unwrap_or(&Value::Null));
    let currency = balance.get("currency").cloned().unwrap_or(Value::Null);
    let mut balances = vec![json!({
        "balanceAmount": { "amount": current_balance, "currency": currency },
        "balanceType": "expected",
        "referenceDate": reference_date
    })];
    if balance.get("available").is_some_and(javascript_truthy) {
        balances.push(json!({
            "balanceAmount": {
                "amount": js_cents(balance.get("available").unwrap()),
                "currency": balance.get("currency").cloned().unwrap_or(Value::Null)
            },
            "balanceType": "interimAvailable",
            "referenceDate": reference_date
        }));
    }

    let mut booked = booked_source
        .into_iter()
        .filter_map(|transaction| {
            let date = parse_javascript_date(transaction.get("date")?.as_str()?).ok()?;
            (date >= start).then(|| process_transaction(transaction, balance, true))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut pending = pending_source
        .into_iter()
        .filter_map(|transaction| {
            let date = parse_javascript_date(transaction.get("date")?.as_str()?).ok()?;
            (date >= start).then(|| process_transaction(transaction, balance, false))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut all = booked.iter().chain(&pending).cloned().collect::<Vec<_>>();
    let descending =
        |left: &Value, right: &Value| right["sortOrder"].as_i64().cmp(&left["sortOrder"].as_i64());
    booked.sort_by(descending);
    pending.sort_by(descending);
    all.sort_by(descending);
    Ok(json!({
        "balances": balances,
        "startingBalance": current_balance,
        "transactions": { "all": all, "booked": booked, "pending": pending }
    }))
}

async fn get_refreshed_account(
    state: &AppState,
    app_token: &str,
    user_token: &str,
    account_id: &str,
) -> Result<Option<Value>, String> {
    let _guard = state.akahu_refresh.lock().await;
    let path = format!("/accounts/{account_id}");
    let mut account = api_call(state, app_token, user_token, Method::GET, &path, &[]).await?;
    if account.is_null() {
        return Ok(None);
    }
    if !should_refresh_account(
        account
            .get("refreshed")
            .and_then(|refreshed| refreshed.get("transactions"))
            .and_then(Value::as_str),
    ) {
        return Ok(Some(account));
    }
    api_call(state, app_token, user_token, Method::POST, "/refresh", &[]).await?;
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        account = api_call(state, app_token, user_token, Method::GET, &path, &[]).await?;
        if account.is_null() {
            return Ok(None);
        }
        if !should_refresh_account(
            account
                .get("refreshed")
                .and_then(|refreshed| refreshed.get("transactions"))
                .and_then(Value::as_str),
        ) {
            tokio::time::sleep(Duration::from_secs(3)).await;
            break;
        }
    }
    Ok(Some(account))
}

async fn api_call(
    state: &AppState,
    app_token: &str,
    user_token: &str,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    if !app_token.starts_with("app_token_") {
        return Err(format!(
            "Invalid appToken value: {app_token}. appToken must be a string beginning with app_token_"
        ));
    }
    let mut url = akahu_base_url()?
        .join(path.trim_start_matches('/'))
        .map_err(|error| error.to_string())?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().copied());
    }
    let is_post = method == Method::POST;
    let mut request = state
        .http
        .request(method, url)
        .header("X-Akahu-Sdk", "akahu-sdk-js/2.5.1")
        .header("X-Akahu-Id", app_token)
        .header("User-Agent", "akahu-sdk-js/2.5.1")
        .header("Authorization", format!("Bearer {user_token}"));
    if is_post {
        request = request.header("Idempotency-Key", uuid::Uuid::new_v4().to_string());
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let body = serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?;
    if !status.is_success() || body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Akahu API request failed")
            .into());
    }
    if let Some(cursor) = body.get("cursor").filter(|cursor| !cursor.is_null()) {
        return Ok(json!({
            "cursor": cursor,
            "items": body.get("items").cloned().unwrap_or(Value::Null)
        }));
    }
    for key in ["item", "item_id", "items"] {
        if let Some(value) = body.get(key).filter(|value| !value.is_null()) {
            return Ok(value.clone());
        }
    }
    let mut payload = body.as_object().cloned().unwrap_or_default();
    payload.remove("success");
    Ok(if payload.is_empty() {
        Value::Null
    } else {
        Value::Object(payload)
    })
}

fn process_transaction(
    transaction: Value,
    balance: &Map<String, Value>,
    booked: bool,
) -> Result<Value, String> {
    let mut output = transaction.as_object().cloned().unwrap_or_default();
    let transaction_date = parse_javascript_date(
        output
            .get("date")
            .and_then(Value::as_str)
            .ok_or_else(|| "Akahu transaction date is missing".to_owned())?,
    )?;
    let payee_name = merchant_name(&output)
        .or_else(|| other_account(&output))
        .or_else(|| output.get("description").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned();
    let merchant = if booked {
        output
            .get("merchant")
            .cloned()
            .unwrap_or_else(|| json!({ "name": other_account(&output).unwrap_or_default() }))
    } else {
        json!({ "name": other_account(&output).unwrap_or_default() })
    };
    let category = booked
        .then(|| output.get("category")?.get("name").cloned())
        .flatten();
    let transaction_id = booked.then(|| output.get("_id").cloned()).flatten();
    output.insert("booked".into(), Value::Bool(booked));
    output.insert("date".into(), Value::String(nz_date(transaction_date)));
    output.insert("payeeName".into(), Value::String(payee_name));
    output.insert("merchant".into(), merchant);
    output.insert(
        "notes".into(),
        output.get("description").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "sortOrder".into(),
        json!(transaction_date.timestamp_millis()),
    );
    output.insert(
        "transactionAmount".into(),
        json!({
            "amount": js_currency(output.get("amount").unwrap_or(&Value::Null)),
            "currency": balance.get("currency").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("NZD".into()))
        }),
    );
    if let Some(category) = category {
        output.insert("category".into(), category);
    } else {
        output.remove("category");
    }
    if let Some(transaction_id) = transaction_id {
        output.insert("transactionId".into(), transaction_id);
    }
    Ok(Value::Object(output))
}

fn tokens(state: &AppState) -> Result<(Option<String>, Option<String>), String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    Ok((
        secrets_service::get(&connection, USER_TOKEN, None).map_err(|error| error.to_string())?,
        secrets_service::get(&connection, APP_TOKEN, None).map_err(|error| error.to_string())?,
    ))
}

fn akahu_base_url() -> Result<Url, String> {
    let configured =
        std::env::var("AKAHU_API_URL").unwrap_or_else(|_| "https://api.akahu.io/v1/".into());
    let mut url = Url::parse(&configured).map_err(|error| error.to_string())?;
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn parse_javascript_date(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").map(|date| {
                DateTime::from_naive_utc_and_offset(date.and_hms_opt(0, 0, 0).unwrap(), Utc)
            })
        })
        .map_err(|error| error.to_string())
}

fn first_day_next_local_month() -> Result<DateTime<Utc>, String> {
    let now = Local::now();
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    Local
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .map(|date| date.with_timezone(&Utc))
        .ok_or_else(|| "Could not construct Akahu end date".into())
}

fn javascript_iso(date: DateTime<Utc>) -> String {
    date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn nz_date(date: DateTime<Utc>) -> String {
    date.with_timezone(&Auckland).format("%Y-%m-%d").to_string()
}

fn should_refresh_account(refreshed_at: Option<&str>) -> bool {
    refreshed_at
        .and_then(|value| parse_javascript_date(value).ok())
        .is_some_and(|date| Utc::now().timestamp() - date.timestamp() > REFRESH_INTERVAL_SECONDS)
}

fn merchant_name(transaction: &Map<String, Value>) -> Option<&str> {
    transaction
        .get("merchant")
        .and_then(Value::as_object)
        .and_then(|merchant| merchant.get("name"))
        .and_then(Value::as_str)
}

fn other_account(transaction: &Map<String, Value>) -> Option<&str> {
    transaction
        .get("meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("other_account"))
        .and_then(Value::as_str)
}

fn js_cents(value: &Value) -> i64 {
    let amount = value.as_f64().unwrap_or(0.0);
    amount.mul_add(100.0, 0.5).floor() as i64
}

fn js_currency(value: &Value) -> f64 {
    let amount = value.as_f64().unwrap_or(f64::NAN);
    amount.mul_add(100.0, 0.5).floor() / 100.0
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

fn missing_tokens() -> Response {
    Json(json!({ "status": "ok", "data": { "error": "Missing user or app token" } }))
        .into_response()
}

fn internal_error(error: String) -> Response {
    Json(json!({ "status": "error", "data": { "error": error } })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_auckland_dates_javascript_rounding_and_refresh_age() {
        assert_eq!(
            nz_date(parse_javascript_date("2024-01-01T11:30:00.000Z").unwrap()),
            "2024-01-02"
        );
        assert_eq!(js_cents(&json!(-1.005)), -100);
        assert!(!should_refresh_account(None));
    }
}
