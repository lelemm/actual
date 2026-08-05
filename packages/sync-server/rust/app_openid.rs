use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    accounts::openid,
    app::AppState,
    services::user_service,
    util::{middlewares::ValidatedSession, validate_user::client_ip},
};

const CONFIG_RATE_LIMIT: u64 = 5;
const CONFIG_RATE_WINDOW: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default)]
pub struct OpenIdConfigRateLimiter(Arc<Mutex<HashMap<IpAddr, (u64, Instant)>>>);

impl OpenIdConfigRateLimiter {
    fn check(&self, address: IpAddr) -> Result<(u64, Duration), Response> {
        let now = Instant::now();
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|_, (_, reset)| *reset > now);
        let address = rate_limit_key(address);
        let entry = entries
            .entry(address)
            .or_insert((0, now + CONFIG_RATE_WINDOW));
        if now >= entry.1 {
            *entry = (0, now + CONFIG_RATE_WINDOW);
        }
        entry.0 += 1;
        let remaining = CONFIG_RATE_LIMIT.saturating_sub(entry.0);
        let reset = entry.1.saturating_duration_since(now);
        if entry.0 > CONFIG_RATE_LIMIT {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "status": "error", "reason": "too-many-requests" })),
            )
                .into_response();
            add_rate_headers(&mut response, remaining, reset, true);
            return Err(response);
        }
        Ok((remaining, reset))
    }

    #[cfg(test)]
    fn expire(&self, address: IpAddr) {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.insert(address, (CONFIG_RATE_LIMIT, Instant::now()));
    }
}

fn rate_limit_key(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(_) => address,
        IpAddr::V6(address) => {
            const HOST_BITS: u32 = 128 - 56;
            IpAddr::V6((u128::from(address) >> HOST_BITS << HOST_BITS).into())
        }
    }
}

fn add_rate_headers(response: &mut Response, remaining: u64, reset: Duration, retry: bool) {
    let reset = (reset.as_secs() + u64::from(reset.subsec_nanos() > 0))
        .max(1)
        .to_string();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert("ratelimit-policy", "5;w=900".parse().unwrap());
    headers.insert("ratelimit-limit", "5".parse().unwrap());
    headers.insert(
        "ratelimit-remaining",
        remaining.to_string().parse().unwrap(),
    );
    headers.insert("ratelimit-reset", reset.parse().unwrap());
    if retry {
        headers.insert("retry-after", reset.parse().unwrap());
    }
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    iss: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/enable", post(enable))
        .route("/disable", post(disable))
        .route("/config", post(config))
        .route("/callback", get(callback))
}

async fn enable(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    if !is_admin(&state, &session.user_id) {
        return forbidden();
    }
    let Some(config) = body.get("openId") else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "reason": "invalid-login-settings" })),
        )
            .into_response();
    };
    match openid::bootstrap_openid(&state, config).await {
        Ok(()) => {
            let Ok(connection) = state.database.lock() else {
                return internal_error("database-error");
            };
            if connection.execute("DELETE FROM sessions", []).is_err() {
                return internal_error("database-error");
            }
            Json(json!({ "status": "ok" })).into_response()
        }
        Err(reason) => internal_error(reason),
    }
}

async fn disable(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    if !is_admin(&state, &session.user_id) {
        return forbidden();
    }
    match openid::disable(&state, body.get("password").and_then(Value::as_str)) {
        Ok(()) => Json(json!({ "status": "ok" })).into_response(),
        Err(reason) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "status": "error", "reason": reason })),
        )
            .into_response(),
    }
}

async fn config(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let address = client_ip(peer, &headers, &state.config.trusted_proxies).unwrap_or(peer.ip());
    let (remaining, reset) = match state.openid_config_rate_limiter.check(address) {
        Ok(attempt) => attempt,
        Err(response) => return response,
    };
    let mut response = config_inner(&state, &body);
    add_rate_headers(&mut response, remaining, reset, false);
    response
}

fn config_inner(state: &AppState, body: &Value) -> Response {
    let owner_count = state
        .database
        .lock()
        .ok()
        .and_then(|connection| user_service::get_owner_count(&connection).ok());
    match owner_count {
        Some(count) if count > 0 => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": "already-bootstraped" })),
            )
                .into_response();
        }
        Some(_) => {}
        None => return internal_error("database-error"),
    }
    if !openid::check_password(state, body.get("password").and_then(Value::as_str)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": "invalid-password" })),
        )
            .into_response();
    }
    match openid::get_config(state) {
        Ok(Some(config)) => {
            Json(json!({ "status": "ok", "data": { "openId": config } })).into_response()
        }
        Ok(None) => internal_error("OpenID configuration not found"),
        Err(reason) => internal_error(&reason),
    }
}

async fn callback(State(state): State<AppState>, Query(query): Query<CallbackQuery>) -> Response {
    let url = match openid::login_finalize(
        &state,
        query.code.as_deref(),
        query.state.as_deref(),
        query.iss.as_deref(),
    )
    .await
    {
        Ok(url) => url,
        Err(reason) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": reason })),
            )
                .into_response();
        }
    };
    if !openid::is_valid_redirect_url(&state, &url) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": "Invalid redirect URL" })),
        )
            .into_response();
    }
    let Ok(location) = HeaderValue::from_str(&url) else {
        return internal_error("Invalid redirect URL");
    };
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(header::LOCATION, location);
    response
}

fn is_admin(state: &AppState, user_id: &str) -> bool {
    state
        .database
        .lock()
        .ok()
        .and_then(|connection| user_service::is_admin(&connection, user_id).ok())
        .unwrap_or(false)
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "status": "error",
            "reason": "forbidden",
            "details": "permission-not-found"
        })),
    )
        .into_response()
}

fn internal_error(reason: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": reason })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "app_openid/tests.rs"]
mod tests;
