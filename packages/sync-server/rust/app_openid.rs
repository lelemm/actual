use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    accounts::openid, app::AppState, services::user_service, util::middlewares::ValidatedSession,
};

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

async fn config(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
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
    if !openid::check_password(&state, body.get("password").and_then(Value::as_str)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": "invalid-password" })),
        )
            .into_response();
    }
    match openid::get_config(&state) {
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
