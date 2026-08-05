pub mod errors;
pub mod services;
pub mod validation;

#[cfg(test)]
mod tests;

use std::{borrow::Cow, fs, sync::MutexGuard};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use percent_encoding::percent_decode_str;
use prost::Message;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::AppState,
    app_sync::{
        errors::FileError,
        services::files_service::{self, File, FileUpdate, SqliteText},
        validation::{validate_synced_file, validate_uploaded_file},
    },
    proto::{SyncRequest, SyncResponse},
    sync_simple,
    util::{
        middlewares::ValidatedSession,
        paths::{
            FileId, GroupId, get_path_for_group_file, get_path_for_user_file, parse_file_id,
            parse_group_id,
        },
    },
};

pub fn router(
    file_size_limit_mb: u64,
    sync_limit_mb: u64,
    encrypted_limit_mb: u64,
) -> Router<AppState> {
    let general = Router::new()
        .route("/user-get-key", post(user_get_key))
        .route("/user-create-key", post(user_create_key))
        .route("/reset-user-file", post(reset_user_file))
        .route("/download-user-file", get(download_user_file))
        .route("/update-user-filename", post(update_user_filename))
        .route("/list-user-files", get(list_user_files))
        .route("/get-user-file-info", get(get_user_file_info))
        .route("/delete-user-file", post(delete_user_file))
        .layer(DefaultBodyLimit::max(megabytes(file_size_limit_mb)));
    Router::new()
        .route(
            "/sync",
            post(sync).layer(DefaultBodyLimit::max(megabytes(sync_limit_mb))),
        )
        .route(
            "/upload-user-file",
            post(upload_user_file).layer(DefaultBodyLimit::max(megabytes(encrypted_limit_mb))),
        )
        .merge(general)
}

fn megabytes(value: u64) -> usize {
    value.saturating_mul(1024 * 1024).min(usize::MAX as u64) as usize
}

async fn sync(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !has_media_type(&headers, "application/actual-sync") {
        return internal_error();
    }
    let request = match SyncRequest::decode(body) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("Error parsing sync request: {error}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "reason": "internal-error" })),
            )
                .into_response();
        }
    };
    if request.since.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "details": "since-required",
                "reason": "unprocessable-entity",
                "status": "error"
            })),
        )
            .into_response();
    }
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file_id = match valid_file_id(&request.file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_access(&connection, &file, &session.user_id) {
        return response;
    }
    let group_id = nonempty(&request.group_id);
    let key_id = nonempty(&request.key_id);
    if let Some(error) = validate_synced_file(group_id, key_id, &file) {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    drop(connection);

    let (trie, messages) = match sync_simple::sync(
        &state.config,
        &request.messages,
        &request.since,
        group_id.expect("validated group id"),
    ) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("Sync error: {error}");
            return internal_error();
        }
    };
    let response = SyncResponse {
        messages,
        merkle: match serde_json::to_string(&trie) {
            Ok(merkle) => merkle,
            Err(_) => return internal_error(),
        },
    };
    let mut encoded = Vec::new();
    if response.encode(&mut encoded).is_err() {
        return internal_error();
    }
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/actual-sync"),
            ),
            (
                HeaderName::from_static("x-actual-sync-method"),
                HeaderValue::from_static("simple"),
            ),
        ],
        encoded,
    )
        .into_response()
}

async fn user_get_key(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body
        .get("fileId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_access(&connection, &file, &session.user_id) {
        return response;
    }
    Json(json!({
        "status": "ok",
        "data": {
            "id": file.encrypt_key_id,
            "salt": file.encrypt_salt,
            "test": file.encrypt_test
        }
    }))
    .into_response()
}

async fn user_create_key(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body
        .get("fileId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_owner(&connection, &file, &session.user_id) {
        return response;
    }
    let key_id = match sqlite_text(&body, "keyId") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let key_salt = match sqlite_text(&body, "keySalt") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let test_content = match sqlite_text(&body, "testContent") {
        Ok(value) => value,
        Err(response) => return response,
    };
    match files_service::update(
        &connection,
        &file_id,
        &FileUpdate {
            encrypt_key_id: key_id,
            encrypt_salt: key_salt,
            encrypt_test: test_content,
            ..FileUpdate::default()
        },
    ) {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(error) => file_error(error, "file-not-found"),
    }
}

async fn reset_user_file(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body
        .get("fileId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "User or file not found"),
    };
    if let Err(response) = require_file_owner(&connection, &file, &session.user_id) {
        return response;
    }
    if let Err(error) = files_service::update(
        &connection,
        &file_id,
        &FileUpdate {
            group_id: Some(None),
            ..FileUpdate::default()
        },
    ) {
        return file_error(error, "User or file not found");
    }
    drop(connection);
    if let Some(group_id) = file.group_id {
        let _ = fs::remove_file(get_path_for_group_file(&state.config, group_id.as_str()));
    }
    Json(json!({ "status": "ok" })).into_response()
}

async fn upload_user_file(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(name) = header_string(&headers, "x-actual-name") else {
        return (StatusCode::BAD_REQUEST, "single x-actual-name is required").into_response();
    };
    let name = match decode_uri_component(name) {
        Ok(name) => name,
        Err(response) => return response,
    };
    let Some(file_id) = header_string(&headers, "x-actual-file-id") else {
        return (StatusCode::BAD_REQUEST, "fileId is required").into_response();
    };
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let group_id = match header_string(&headers, "x-actual-group-id") {
        Some(group_id) => match parse_group_id(group_id) {
            Some(group_id) => Some(group_id),
            None => return (StatusCode::BAD_REQUEST, "invalid groupId").into_response(),
        },
        None => None,
    };
    let encrypt_meta = header_string(&headers, "x-actual-encrypt-meta");
    let key_id = match encrypt_meta {
        Some(value) => match serde_json::from_str::<Value>(value) {
            Ok(Value::Null) => return internal_error(),
            Ok(value) => value
                .get("keyId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            Err(_) => return internal_error(),
        },
        None => None,
    };
    let sync_version = header_string(&headers, "x-actual-format");
    if !has_media_type(&headers, "application/encrypted-file") {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error" })),
        )
            .into_response();
    }

    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let current_file = match files_service::get(&connection, &file_id) {
        Ok(file) => Some(file),
        Err(FileError::NotFound { .. }) => None,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Some(current_file) = &current_file {
        if let Err(response) = require_file_access(&connection, current_file, &session.user_id) {
            return response;
        }
        if let Some(error) = validate_uploaded_file(
            group_id.as_ref().map(GroupId::as_str),
            key_id.as_deref(),
            current_file,
        ) {
            return (StatusCode::BAD_REQUEST, error).into_response();
        }
    }
    if let Err(error) = fs::write(
        get_path_for_user_file(&state.config, file_id.as_str()),
        &body,
    ) {
        eprintln!("Error writing file: {error}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error" })),
        )
            .into_response();
    }

    let group_id = match current_file {
        None => {
            let group_id = new_group_id();
            let sync_version = sync_version.and_then(|value| value.parse::<i64>().ok());
            let file = File {
                id: file_id.clone(),
                group_id: Some(group_id.clone()),
                sync_version,
                name: Some(name),
                encrypt_meta: encrypt_meta.map(str::to_owned),
                encrypt_salt: None,
                encrypt_test: None,
                encrypt_key_id: None,
                deleted: false,
                owner: Some(session.user_id),
            };
            if let Err(error) = files_service::set(&connection, &file) {
                return file_error(error, "file-not-found");
            }
            group_id
        }
        Some(current_file) => {
            let group_id = current_file.group_id.unwrap_or_else(new_group_id);
            if let Err(error) = files_service::update(
                &connection,
                &file_id,
                &FileUpdate {
                    group_id: Some(Some(&group_id)),
                    sync_version: Some(sync_version.and_then(|value| value.parse().ok())),
                    encrypt_meta: Some(encrypt_meta),
                    name: Some(Some(SqliteText::Text(&name))),
                    ..FileUpdate::default()
                },
            ) {
                return file_error(error, "file-not-found");
            }
            group_id
        }
    };
    Json(json!({ "status": "ok", "groupId": group_id })).into_response()
}

async fn download_user_file(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
) -> Response {
    let Some(file_id) = header_string(&headers, "x-actual-file-id") else {
        return (StatusCode::BAD_REQUEST, "Single file ID is required").into_response();
    };
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "User or file not found"),
    };
    if let Err(response) = require_file_access(&connection, &file, &session.user_id) {
        return response;
    }
    drop(connection);
    let bytes = match fs::read(get_path_for_user_file(&state.config, file_id.as_str())) {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
    };
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment;filename={file_id}"))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
}

async fn update_user_filename(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let file_id = body
        .get("fileId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_access(&connection, &file, &session.user_id) {
        return response;
    }
    let name = match sqlite_text(&body, "name") {
        Ok(value) => value,
        Err(response) => return response,
    };
    match files_service::update(
        &connection,
        &file_id,
        &FileUpdate {
            name,
            ..FileUpdate::default()
        },
    ) {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(error) => file_error(error, "file-not-found"),
    }
}

async fn list_user_files(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
) -> Response {
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let files = match files_service::find(&connection, &session.user_id) {
        Ok(files) => files,
        Err(error) => return file_error(error, "file-not-found"),
    };
    let mut data = Vec::new();
    for file in files {
        let users = match users_with_access_json(&connection, &file) {
            Ok(users) => users,
            Err(error) => return file_error(error, "file-not-found"),
        };
        data.push(json!({
            "deleted": i64::from(file.deleted),
            "fileId": file.id,
            "groupId": file.group_id,
            "name": file.name,
            "encryptKeyId": file.encrypt_key_id,
            "owner": file.owner,
            "usersWithAccess": users
        }));
    }
    Json(json!({ "status": "ok", "data": data })).into_response()
}

async fn get_user_file_info(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
) -> Response {
    let file_id = header_string(&headers, "x-actual-file-id").unwrap_or_default();
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(FileError::NotFound { .. }) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "status": "error", "reason": "file-not-found" })),
            )
                .into_response();
        }
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_access(&connection, &file, &session.user_id) {
        return response;
    }
    let users = match users_with_access_json(&connection, &file) {
        Ok(users) => users,
        Err(error) => return file_error(error, "file-not-found"),
    };
    let encrypt_meta = file
        .encrypt_meta
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    Json(json!({
        "status": "ok",
        "data": {
            "deleted": i64::from(file.deleted),
            "fileId": file.id,
            "groupId": file.group_id,
            "name": file.name,
            "encryptMeta": encrypt_meta,
            "usersWithAccess": users
        }
    }))
    .into_response()
}

async fn delete_user_file(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let Some(file_id) = body.get("fileId").and_then(Value::as_str) else {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "details": "fileId-required",
                "reason": "unprocessable-entity",
                "status": "error"
            })),
        )
            .into_response();
    };
    let file_id = match valid_file_id(file_id) {
        Ok(file_id) => file_id,
        Err(response) => return response,
    };
    let connection = match connection(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let file = match files_service::get(&connection, &file_id) {
        Ok(file) => file,
        Err(error) => return file_error(error, "file-not-found"),
    };
    if let Err(response) = require_file_owner(&connection, &file, &session.user_id) {
        return response;
    }
    match files_service::update(
        &connection,
        &file_id,
        &FileUpdate {
            deleted: Some(true),
            ..FileUpdate::default()
        },
    ) {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(error) => file_error(error, "file-not-found"),
    }
}

fn connection(state: &AppState) -> Result<MutexGuard<'_, Connection>, Response> {
    state.database.lock().map_err(|_| internal_error())
}

fn require_file_owner(connection: &Connection, file: &File, user_id: &str) -> Result<(), Response> {
    match files_service::is_admin(connection, user_id) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(error) => return Err(file_error(error, "file-not-found")),
    }
    if file.owner.as_deref() == Some(user_id) {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "file-access-not-allowed").into_response())
    }
}

fn require_file_access(
    connection: &Connection,
    file: &File,
    user_id: &str,
) -> Result<(), Response> {
    if require_file_owner(connection, file, user_id).is_ok() {
        return Ok(());
    }
    match files_service::count_user_access(connection, &file.id, user_id) {
        Ok(count) if count > 0 => Ok(()),
        Ok(_) => Err((StatusCode::FORBIDDEN, "file-access-not-allowed").into_response()),
        Err(error) => Err(file_error(error, "file-not-found")),
    }
}

fn users_with_access_json(connection: &Connection, file: &File) -> Result<Vec<Value>, FileError> {
    Ok(files_service::find_users_with_access(connection, &file.id)?
        .into_iter()
        .map(|access| {
            json!({
                "userId": access.user_id,
                "displayName": access.display_name,
                "userName": access.user_name,
                "owner": file.owner.as_deref() == Some(&access.user_id)
            })
        })
        .collect())
}

fn file_error(error: FileError, not_found: &'static str) -> Response {
    match error {
        FileError::NotFound { .. } => (StatusCode::BAD_REQUEST, not_found).into_response(),
        FileError::Generic { message, details } => {
            eprintln!("File error: {message}; details={details}");
            internal_error()
        }
        FileError::Database(error) => {
            eprintln!("File database error: {error}");
            internal_error()
        }
    }
}

fn internal_error() -> Response {
    #[derive(Serialize)]
    struct InternalError {
        status: &'static str,
        reason: &'static str,
    }
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        )],
        Json(InternalError {
            status: "error",
            reason: "internal-error",
        }),
    )
        .into_response()
}

fn header_string<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn has_media_type(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
}

fn sqlite_text<'a>(body: &'a Value, key: &str) -> Result<Option<Option<SqliteText<'a>>>, Response> {
    Ok(match body.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(SqliteText::Text(value))),
        Some(Value::Number(value)) => {
            let value = value.as_f64().ok_or_else(internal_error)?;
            Some(Some(SqliteText::Number(value)))
        }
        Some(_) => return Err(internal_error()),
    })
}

fn decode_uri_component(value: &str) -> Result<String, Response> {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (bytes
                .get(index + 1)
                .is_none_or(|byte| !byte.is_ascii_hexdigit())
                || bytes
                    .get(index + 2)
                    .is_none_or(|byte| !byte.is_ascii_hexdigit()))
        {
            return Err(internal_error());
        }
    }
    percent_decode_str(value)
        .decode_utf8()
        .map(Cow::into_owned)
        .map_err(|_| internal_error())
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn valid_file_id(value: &str) -> Result<FileId, Response> {
    parse_file_id(value).ok_or_else(|| (StatusCode::BAD_REQUEST, "invalid fileId").into_response())
}

fn new_group_id() -> GroupId {
    parse_group_id(&Uuid::new_v4().to_string()).expect("UUID must be a valid group ID")
}
