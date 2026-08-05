use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    app::AppState,
    services::secrets_service,
    util::{
        middlewares::ValidatedSession,
        paths::{FileId, parse_file_id},
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(set_secret))
        .route("/{name}", get(has_secret).delete(delete_secret))
}

async fn set_secret(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let name = body.get("name").and_then(Value::as_str).unwrap_or_default();
    if !secrets_service::is_valid_name(name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "reason": "invalid-secret-name",
                "details": "Unknown secret name"
            })),
        )
            .into_response();
    }
    let file_id = header_string(&headers, "x-actual-file-id");
    let connection = match state.database.lock() {
        Ok(connection) => connection,
        Err(_) => return internal_error(),
    };
    let file_id = match authorize(&connection, file_id, &session.user_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let value = body.get("value").and_then(Value::as_str);
    match secrets_service::set(
        &connection,
        name,
        value,
        file_id.as_ref().map(FileId::as_str),
    ) {
        Ok(()) => Json(json!({ "status": "ok" })).into_response(),
        Err(_) => internal_error(),
    }
}

async fn delete_secret(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if !secrets_service::is_valid_name(&name) {
        return (StatusCode::NOT_FOUND, "key not found").into_response();
    }
    let file_id = header_string(&headers, "x-actual-file-id");
    let connection = match state.database.lock() {
        Ok(connection) => connection,
        Err(_) => return internal_error(),
    };
    let file_id = match authorize(&connection, file_id, &session.user_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    match secrets_service::reset(&connection, &name, file_id.as_ref().map(FileId::as_str)) {
        Ok(()) => Json(json!({ "status": "ok" })).into_response(),
        Err(_) => internal_error(),
    }
}

async fn has_secret(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if !secrets_service::is_valid_name(&name) {
        return (StatusCode::NOT_FOUND, "key not found").into_response();
    }
    let file_id = header_string(&headers, "x-actual-file-id");
    let connection = match state.database.lock() {
        Ok(connection) => connection,
        Err(_) => return internal_error(),
    };
    let file_id = match authorize(&connection, file_id, &session.user_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    match secrets_service::get(&connection, &name, file_id.as_ref().map(FileId::as_str)) {
        Ok(Some(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "key not found").into_response(),
        Err(_) => internal_error(),
    }
}

fn authorize(
    connection: &Connection,
    file_id: Option<&str>,
    user_id: &str,
) -> Result<Option<FileId>, Response> {
    let is_admin = connection
        .query_row("SELECT role FROM users WHERE id = ?", [user_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|_| internal_error())?
        .as_deref()
        == Some("ADMIN");
    let Some(file_id) = file_id else {
        return if is_admin {
            Ok(None)
        } else {
            Err((
                StatusCode::FORBIDDEN,
                Json(json!({
                    "status": "error",
                    "reason": "not-admin",
                    "details": "You have to be admin to manage global secrets"
                })),
            )
                .into_response())
        };
    };
    let file_id = parse_file_id(file_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "reason": "invalid-file-id",
                "details": "invalid fileId"
            })),
        )
            .into_response()
    })?;
    let is_owner = connection
        .query_row(
            "SELECT 1 FROM files WHERE id = ? AND owner = ?",
            params![&file_id, user_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| internal_error())?
        .is_some();
    if is_admin || is_owner {
        Ok(Some(file_id))
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "reason": "file-access-denied",
                "details": "You don't have permissions over this file"
            })),
        )
            .into_response())
    }
}

fn header_string<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": "internal-error" })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "app_secrets/tests.rs"]
mod tests;
