use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, header},
    middleware,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};

use crate::{
    app::AppState,
    app_simplefin::core::{self, TransactionsError},
    services::secrets_service,
    util::middlewares::ValidatedSession,
};

const SIMPLEFIN_TOKEN: &str = "simplefin_token";
const SIMPLEFIN_ACCESS_KEY: &str = "simplefin_accessKey";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", post(status))
        .route("/accounts", post(accounts))
        .route("/transactions", post(transactions))
        .layer(middleware::map_response(express_json_content_type))
}

async fn express_json_content_type(mut response: Response) -> Response {
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes().starts_with(b"application/json"))
    {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    response
}

async fn status(State(state): State<AppState>, ValidatedSession(_): ValidatedSession) -> Response {
    let token = match get_secret(&state, SIMPLEFIN_TOKEN) {
        Ok(token) => token,
        Err(response) => return response,
    };
    Json(json!({ "status": "ok", "data": core::status_data(token.as_deref()) })).into_response()
}

async fn accounts(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
) -> Response {
    let token = match get_secret(&state, SIMPLEFIN_TOKEN) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let access_key = match get_secret(&state, SIMPLEFIN_ACCESS_KEY) {
        Ok(access_key) => access_key,
        Err(response) => return response,
    };
    let result = core::accounts(&state.http, token.as_deref(), access_key.as_deref()).await;
    if result.claimed {
        let Some(access_key) = result.access_key.as_deref() else {
            return internal_error();
        };
        let connection = match state.database.lock() {
            Ok(connection) => connection,
            Err(_) => return internal_error(),
        };
        if secrets_service::set(&connection, SIMPLEFIN_ACCESS_KEY, Some(access_key), None).is_err()
        {
            return internal_error();
        }
    }
    Json(json!({ "status": "ok", "data": result.data })).into_response()
}

async fn transactions(
    State(state): State<AppState>,
    ValidatedSession(_): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let access_key = match get_secret(&state, SIMPLEFIN_ACCESS_KEY) {
        Ok(access_key) => access_key,
        Err(response) => return response,
    };
    match core::transactions(&state.http, access_key.as_deref(), &body).await {
        Ok(data) => Json(json!({ "status": "ok", "data": data })).into_response(),
        Err(TransactionsError::InvalidToken) => {
            Json(json!({ "status": "ok", "data": core::invalid_token_data() })).into_response()
        }
        Err(TransactionsError::ServerDown) => {
            Json(json!({ "status": "ok", "data": core::server_down_data() })).into_response()
        }
        Err(TransactionsError::ProviderInternal(reason)) => Json(json!({
            "status": "ok",
            "data": core::provider_internal_error_data(&reason)
        }))
        .into_response(),
        Err(TransactionsError::Internal) => internal_error(),
    }
}

fn get_secret(state: &AppState, name: &str) -> Result<Option<String>, Response> {
    let connection = state.database.lock().map_err(|_| internal_error())?;
    secrets_service::get(&connection, name, None).map_err(|_| internal_error())
}

fn internal_error() -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": "internal-error" })),
    )
        .into_response()
}
