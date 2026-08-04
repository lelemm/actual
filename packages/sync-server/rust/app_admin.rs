use std::sync::MutexGuard;

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{app::AppState, services::user_service, util::middlewares::ValidatedSession};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileQuery {
    file_id: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/owner-created", get(owner_created))
        .route(
            "/users",
            get(users)
                .post(create_user)
                .patch(update_user)
                .delete(delete_users),
        )
        .route(
            "/access",
            get(access).post(add_access).delete(delete_access),
        )
        .route("/access/users", get(access_users))
        .route(
            "/access/transfer-ownership",
            get(not_found).post(transfer_ownership),
        )
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

async fn owner_created(State(state): State<AppState>) -> Response {
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    match user_service::get_owner_count(&connection) {
        Ok(count) => Json(json!(count > 0)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Failed to retrieve owner count" })),
        )
            .into_response(),
    }
}

async fn users(State(state): State<AppState>, ValidatedSession(_): ValidatedSession) -> Response {
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    match user_service::get_all_users(&connection) {
        Ok(users) => Json(users).into_response(),
        Err(_) => internal_error(),
    }
}

async fn create_user(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !admin(&connection, &session.user_id) {
        return forbidden();
    }
    let user_name = body.get("userName").and_then(Value::as_str).unwrap_or("");
    let role = body.get("role").and_then(Value::as_str).unwrap_or("");
    if user_name.is_empty() || role.is_empty() {
        return empty_user_or_role(user_name.is_empty());
    }
    if !user_service::validate_role(role) {
        return bad_request(
            "role-does-not-exists",
            "Selected role does not exist".into(),
        );
    }
    match user_service::get_user_by_username(&connection, user_name) {
        Ok(Some(_)) => {
            return bad_request(
                "user-already-exists",
                format!("User {user_name} already exists"),
            );
        }
        Ok(None) => {}
        Err(_) => return internal_error(),
    }
    let user_id = Uuid::new_v4().to_string();
    let display_name = body.get("displayName").and_then(Value::as_str);
    let enabled = truthy(body.get("enabled"));
    // The JavaScript route currently omits the validated role when inserting.
    if user_service::insert_user(
        &connection,
        &user_id,
        user_name,
        display_name,
        enabled,
        None,
    )
    .is_err()
    {
        return internal_error();
    }
    Json(json!({ "status": "ok", "data": { "id": user_id } })).into_response()
}

async fn update_user(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let mut connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !admin(&connection, &session.user_id) {
        return forbidden();
    }
    let user_name = body.get("userName").and_then(Value::as_str).unwrap_or("");
    let role = body.get("role").and_then(Value::as_str).unwrap_or("");
    if user_name.is_empty() || role.is_empty() {
        return empty_user_or_role(user_name.is_empty());
    }
    if !user_service::validate_role(role) {
        return bad_request(
            "role-does-not-exists",
            "Selected role does not exist".into(),
        );
    }
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    let user_id = match user_service::get_user_by_id(&connection, id) {
        Ok(Some(user_id)) => user_id,
        Ok(None) => {
            return bad_request(
                "cannot-find-user-to-update",
                format!("Cannot find user {user_name} to update"),
            );
        }
        Err(_) => return internal_error(),
    };
    if user_service::update_user_with_role(
        &mut connection,
        &user_id,
        user_name,
        body.get("displayName").and_then(Value::as_str),
        truthy(body.get("enabled")),
        role,
    )
    .is_err()
    {
        return internal_error();
    }
    Json(json!({ "status": "ok", "data": { "id": user_id } })).into_response()
}

async fn delete_users(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let mut connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !admin(&connection, &session.user_id) {
        return forbidden();
    }
    let Some(ids) = string_array(body.get("ids")) else {
        return internal_error();
    };
    let owner_id = match user_service::get_owner_id(&connection) {
        Ok(owner_id) => owner_id,
        Err(_) => return internal_error(),
    };
    let mut total_deleted = 0;
    for id in &ids {
        if owner_id.as_deref() == Some(id) {
            continue;
        }
        if user_service::delete_user_access(&connection, id).is_err() {
            return internal_error();
        }
        let Some(owner_id) = owner_id.as_deref() else {
            return internal_error();
        };
        if user_service::transfer_all_files_from_user(&connection, owner_id, id).is_err() {
            return internal_error();
        }
        match user_service::delete_user(&mut connection, id) {
            Ok(changes) => total_deleted += changes,
            Err(_) => return internal_error(),
        }
    }
    if ids.len() == total_deleted {
        Json(json!({
            "status": "ok",
            "data": { "someDeletionsFailed": false }
        }))
        .into_response()
    } else {
        bad_request("not-all-deleted", "".into())
    }
}

async fn access(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Query(query): Query<FileQuery>,
) -> Response {
    let file_id = query.file_id.as_deref().unwrap_or("");
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let is_admin = admin(&connection, &session.user_id);
    if !file_permission(&connection, file_id, &session.user_id) && !is_admin {
        return forbidden();
    }
    if !file_exists(&connection, file_id) {
        return invalid_file();
    }
    match user_service::get_user_access(&connection, file_id, &session.user_id, is_admin) {
        Ok(access) => Json(access).into_response(),
        Err(_) => internal_error(),
    }
}

async fn add_access(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body.get("fileId").and_then(Value::as_str).unwrap_or("");
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !file_permission(&connection, file_id, &session.user_id)
        && !admin(&connection, &session.user_id)
    {
        return file_denied();
    }
    if !file_exists(&connection, file_id) {
        return invalid_file();
    }
    let user_id = body.get("userId").and_then(Value::as_str).unwrap_or("");
    if user_id.is_empty() {
        return bad_request("user-cant-be-empty", "User cannot be empty".into());
    }
    match user_service::count_user_access(&connection, file_id, user_id) {
        Ok(count) if count > 0 => {
            return bad_request(
                "user-already-have-access",
                "User already have access".into(),
            );
        }
        Ok(_) => {}
        Err(_) => return internal_error(),
    }
    match user_service::get_user_by_id(&connection, user_id) {
        Ok(Some(_)) => {}
        _ => return internal_error(),
    }
    if user_service::add_user_access(&connection, user_id, file_id).is_err() {
        return internal_error();
    }
    Json(json!({ "status": "ok", "data": {} })).into_response()
}

async fn delete_access(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Query(query): Query<FileQuery>,
    Json(body): Json<Value>,
) -> Response {
    let file_id = query.file_id.as_deref().unwrap_or("");
    let mut connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !file_permission(&connection, file_id, &session.user_id)
        && !admin(&connection, &session.user_id)
    {
        return file_denied();
    }
    if !file_exists(&connection, file_id) {
        return invalid_file();
    }
    let Some(ids) = string_array(body.get("ids")) else {
        return internal_error();
    };
    match user_service::delete_user_access_by_file_id(&mut connection, &ids, file_id) {
        Ok(changes) if changes == ids.len() => Json(json!({
            "status": "ok",
            "data": { "someDeletionsFailed": false }
        }))
        .into_response(),
        Ok(_) => bad_request("not-all-deleted", "".into()),
        Err(_) => internal_error(),
    }
}

async fn access_users(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Query(query): Query<FileQuery>,
) -> Response {
    let file_id = query.file_id.as_deref().unwrap_or("");
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !file_permission(&connection, file_id, &session.user_id)
        && !admin(&connection, &session.user_id)
    {
        return file_denied();
    }
    if !file_exists(&connection, file_id) {
        return invalid_file();
    }
    match user_service::get_all_user_access(&connection, file_id) {
        Ok(users) => Json(users).into_response(),
        Err(_) => internal_error(),
    }
}

async fn transfer_ownership(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body.get("fileId").and_then(Value::as_str).unwrap_or("");
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !file_permission(&connection, file_id, &session.user_id)
        && !admin(&connection, &session.user_id)
    {
        return file_denied();
    }
    if !file_exists(&connection, file_id) {
        return invalid_file();
    }
    let new_user_id = body.get("newUserId").and_then(Value::as_str).unwrap_or("");
    if new_user_id.is_empty() {
        return bad_request("user-cant-be-empty", "Username cannot be empty".into());
    }
    match user_service::update_file_owner(&connection, new_user_id, file_id) {
        Ok(true) => Json(json!({ "status": "ok", "data": {} })).into_response(),
        _ => internal_error(),
    }
}

fn connection(state: &AppState) -> Result<MutexGuard<'_, Connection>, Response> {
    state.database.lock().map_err(|_| internal_error())
}

fn admin(connection: &Connection, user_id: &str) -> bool {
    user_service::is_admin(connection, user_id).unwrap_or(false)
}

fn file_permission(connection: &Connection, file_id: &str, user_id: &str) -> bool {
    user_service::check_file_permission(connection, file_id, user_id).unwrap_or(false)
}

fn file_exists(connection: &Connection, file_id: &str) -> bool {
    user_service::get_file_by_id(connection, file_id).is_ok_and(|file| file.is_some())
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
        Some(Value::Null) | None => false,
    }
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

fn file_denied() -> Response {
    bad_request(
        "file-denied",
        "You don't have permissions over this file".into(),
    )
}

fn invalid_file() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "status": "error",
            "reason": "invalid-file-id",
            "details": "File not found at server"
        })),
    )
        .into_response()
}

fn empty_user_or_role(user_empty: bool) -> Response {
    bad_request(
        if user_empty {
            "user-cant-be-empty"
        } else {
            "role-cant-be-empty"
        },
        if user_empty {
            "Username cannot be empty".into()
        } else {
            "Role cannot be empty".into()
        },
    )
}

fn bad_request(reason: &'static str, details: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "status": "error", "reason": reason, "details": details })),
    )
        .into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error" })),
    )
        .into_response()
}
