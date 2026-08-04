use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    account_db::{self, AccountError},
    accounts::openid,
    app::AppState,
    util::validate_user::{SessionError, validate_auth_header, validate_session},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/needs-bootstrap", get(needs_bootstrap))
        .route("/bootstrap", post(bootstrap))
        .route("/login-methods", get(login_methods))
        .route("/login", post(login))
        .route("/change-password", post(change_password))
        .route("/server-prefs", post(server_prefs))
        .route("/validate", get(validate))
}

const AUTH_RATE_LIMIT: u64 = 5;
const AUTH_RATE_WINDOW: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default)]
pub struct AuthRateLimiter(Arc<Mutex<HashMap<IpAddr, RateEntry>>>);

struct RateEntry {
    count: u64,
    reset: Instant,
}

struct RateAttempt {
    address: IpAddr,
    remaining: u64,
    reset_after: Duration,
}

impl AuthRateLimiter {
    fn begin(&self, address: IpAddr) -> Result<RateAttempt, Response> {
        let now = Instant::now();
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let entry = entries.entry(address).or_insert_with(|| RateEntry {
            count: 0,
            reset: now + AUTH_RATE_WINDOW,
        });
        if now >= entry.reset {
            entry.count = 0;
            entry.reset = now + AUTH_RATE_WINDOW;
        }
        entry.count += 1;
        let attempt = RateAttempt {
            address,
            remaining: AUTH_RATE_LIMIT.saturating_sub(entry.count),
            reset_after: entry.reset.saturating_duration_since(now),
        };
        if entry.count > AUTH_RATE_LIMIT {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "status": "error", "reason": "too-many-requests" })),
            )
                .into_response();
            add_rate_headers(&mut response, &attempt, true);
            return Err(response);
        }
        Ok(attempt)
    }

    fn finish(&self, mut response: Response, attempt: RateAttempt) -> Response {
        add_rate_headers(&mut response, &attempt, false);
        if response.status().is_success()
            && let Ok(mut entries) = self.0.lock()
            && let Some(entry) = entries.get_mut(&attempt.address)
        {
            entry.count = entry.count.saturating_sub(1);
        }
        response
    }
}

fn add_rate_headers(response: &mut Response, attempt: &RateAttempt, retry_after: bool) {
    let reset = attempt.reset_after.as_secs().max(1);
    let headers = response.headers_mut();
    headers.insert("ratelimit-policy", "5;w=900".parse().unwrap());
    headers.insert("ratelimit-limit", "5".parse().unwrap());
    headers.insert(
        "ratelimit-remaining",
        attempt.remaining.to_string().parse().unwrap(),
    );
    headers.insert("ratelimit-reset", reset.to_string().parse().unwrap());
    if retry_after {
        headers.insert("retry-after", reset.to_string().parse().unwrap());
    }
}

async fn needs_bootstrap(State(state): State<AppState>) -> Response {
    let needs_bootstrap = match account_db::needs_bootstrap(&state.database) {
        Ok(value) => value,
        Err(error) => return internal_error(error),
    };
    let methods = match account_db::list_login_methods(&state.database) {
        Ok(value) => value,
        Err(error) => return internal_error(error),
    };
    let active = match account_db::get_active_login_method(&state.database) {
        Ok(value) => value,
        Err(error) => return internal_error(error),
    };
    let login_method = if methods.len() == 1 {
        methods[0].method.clone()
    } else {
        active.clone().unwrap_or_else(|| "password".into())
    };

    Json(json!({
        "status": "ok",
        "data": {
            "bootstrapped": !needs_bootstrap,
            "loginMethod": login_method,
            "availableLoginMethods": methods,
            "multiuser": active.as_deref() == Some("openid")
        }
    }))
    .into_response()
}

async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> Response {
    let attempt = match state.auth_rate_limiter.begin(peer.ip()) {
        Ok(attempt) => attempt,
        Err(response) => return response,
    };
    let limiter = state.auth_rate_limiter.clone();
    let response =
        match tokio::task::spawn_blocking(move || account_db::bootstrap(&state.database, &body))
            .await
        {
            Ok(Ok(token)) => {
                Json(json!({ "status": "ok", "data": { "token": token } })).into_response()
            }
            Ok(Err(AccountError::Reason(reason))) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": reason })),
            )
                .into_response(),
            Ok(Err(error)) => internal_error(error),
            Err(_) => internal_error_message(),
        };
    limiter.finish(response, attempt)
}

async fn login_methods(State(state): State<AppState>) -> Response {
    match account_db::list_login_methods(&state.database) {
        Ok(methods) => Json(json!({ "status": "ok", "methods": methods })).into_response(),
        Err(error) => internal_error(error),
    }
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let attempt = match state.auth_rate_limiter.begin(peer.ip()) {
        Ok(attempt) => attempt,
        Err(response) => return response,
    };
    let limiter = state.auth_rate_limiter.clone();
    limiter.finish(login_inner(state, peer, headers, body).await, attempt)
}

async fn login_inner(
    state: AppState,
    peer: SocketAddr,
    headers: HeaderMap,
    body: Value,
) -> Response {
    let methods = match account_db::list_login_methods(&state.database) {
        Ok(methods) => methods,
        Err(error) => return internal_error(error),
    };
    let requested = body.get("loginMethod").and_then(Value::as_str);
    let method = if requested.is_some_and(|requested| {
        state
            .config
            .allowed_login_methods
            .iter()
            .any(|allowed| allowed == requested)
            && methods.iter().any(|method| method.method == requested)
    }) {
        requested.expect("checked requested method").to_owned()
    } else if state.config.login_method == "header"
        && state
            .config
            .allowed_login_methods
            .iter()
            .any(|method| method == "header")
    {
        "header".into()
    } else {
        match account_db::get_active_login_method(&state.database) {
            Ok(method) => method.unwrap_or_else(|| state.config.login_method.clone()),
            Err(error) => return internal_error(error),
        }
    };
    if method == "openid" {
        let return_url = body.get("returnUrl").and_then(Value::as_str);
        if !return_url.is_some_and(|return_url| openid::is_valid_redirect_url(&state, return_url)) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": "Invalid redirect URL" })),
            )
                .into_response();
        }
        return match openid::login_setup(
            &state,
            return_url,
            body.get("password").and_then(Value::as_str),
        )
        .await
        {
            Ok(url) => {
                Json(json!({ "status": "ok", "data": { "returnUrl": url } })).into_response()
            }
            Err(reason) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": reason })),
            )
                .into_response(),
        };
    }
    let password = if method == "header" {
        let password = headers
            .get("x-actual-password")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if password.is_empty() {
            return Json(json!({ "status": "error", "reason": "invalid-header" })).into_response();
        }
        match validate_auth_header(peer, &state.config.trusted_auth_proxies) {
            Ok(true) => password.to_owned(),
            Ok(false) => {
                return Json(json!({ "status": "error", "reason": "proxy-not-trusted" }))
                    .into_response();
            }
            Err(error) => {
                eprintln!("Header authentication configuration error: {error}");
                return internal_error_message();
            }
        }
    } else {
        body.get("password")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    match tokio::task::spawn_blocking(move || {
        account_db::login_with_password(&state.database, Some(&password))
    })
    .await
    {
        Ok(Ok(token)) => {
            Json(json!({ "status": "ok", "data": { "token": token } })).into_response()
        }
        Ok(Err(AccountError::Reason(reason))) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": reason })),
        )
            .into_response(),
        Ok(Err(error)) => internal_error(error),
        Err(_) => internal_error_message(),
    }
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let session = match validate_session(
        &state.database,
        &headers,
        body.get("token").and_then(Value::as_str),
    ) {
        Ok(session) => session,
        Err(error) => return session_error(error),
    };
    let user = match account_db::get_user_info(&state.database, &session.user_id) {
        Ok(Some(user)) => user,
        Ok(None) => return internal_error_message(),
        Err(error) => return internal_error(error),
    };
    if user.role.as_deref() != Some("ADMIN") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "reason": "forbidden",
                "details": "permission-not-found"
            })),
        )
            .into_response();
    }
    if session.auth_method != "password" {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "reason": "forbidden",
                "details": "password-auth-not-active"
            })),
        )
            .into_response();
    }
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match tokio::task::spawn_blocking(move || {
        account_db::change_password(&state.database, password.as_deref())
    })
    .await
    {
        Ok(Ok(())) => Json(json!({ "status": "ok", "data": {} })).into_response(),
        Ok(Err(AccountError::Reason(reason))) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": reason })),
        )
            .into_response(),
        Ok(Err(error)) => internal_error(error),
        Err(_) => internal_error_message(),
    }
}

async fn server_prefs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let session = match validate_session(
        &state.database,
        &headers,
        body.get("token").and_then(Value::as_str),
    ) {
        Ok(session) => session,
        Err(error) => return session_error(error),
    };
    let user = match account_db::get_user_info(&state.database, &session.user_id) {
        Ok(Some(user)) => user,
        Ok(None) => return internal_error_message(),
        Err(error) => return internal_error(error),
    };
    if user.role.as_deref() != Some("ADMIN") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "reason": "forbidden",
                "details": "permission-not-found"
            })),
        )
            .into_response();
    }
    let Some(prefs) = body.get("prefs").and_then(Value::as_object) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": "invalid-prefs" })),
        )
            .into_response();
    };
    match account_db::set_server_prefs(&state.database, prefs) {
        Ok(()) => Json(json!({ "status": "ok", "data": {} })).into_response(),
        Err(error) => internal_error(error),
    }
}

async fn validate(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let session = match validate_session(&state.database, &headers, None) {
        Ok(session) => session,
        Err(error) => return session_error(error),
    };
    let user = match account_db::get_user_info(&state.database, &session.user_id) {
        Ok(Some(user)) => user,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": "User not found" })),
            )
                .into_response();
        }
        Err(error) => return internal_error(error),
    };
    let prefs = match account_db::get_server_prefs(&state.database) {
        Ok(prefs) => prefs,
        Err(error) => return internal_error(error),
    };
    Json(json!({
        "status": "ok",
        "data": {
            "validated": true,
            "userName": user.user_name,
            "permission": user.role,
            "userId": session.user_id,
            "displayName": user.display_name,
            "loginMethod": session.auth_method,
            "prefs": prefs
        }
    }))
    .into_response()
}

fn session_error(error: SessionError) -> Response {
    match error {
        SessionError::TokenNotFound => (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "status": "error",
                "reason": "unauthorized",
                "details": "token-not-found"
            })),
        )
            .into_response(),
        SessionError::TokenExpired => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "status": "error", "reason": "token-expired" })),
        )
            .into_response(),
        SessionError::Database(error) => internal_error(error),
    }
}

fn internal_error(error: AccountError) -> Response {
    match error {
        AccountError::Database(error) => eprintln!("Database error: {error}"),
        AccountError::Password(error) => eprintln!("Password error: {error}"),
        AccountError::Lock => eprintln!("Account database lock was poisoned"),
        AccountError::Reason(reason) => eprintln!("Account error: {reason}"),
    }
    internal_error_message()
}

fn internal_error_message() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": "internal-error" })),
    )
        .into_response()
}
