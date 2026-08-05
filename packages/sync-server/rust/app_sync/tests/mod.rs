mod services;

use std::{fs, path::PathBuf};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode, header},
    response::Response,
};
use prost::Message;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use super::{file_error, router, services::files_service::File, validation};
use crate::{
    app::AppState,
    app_sync::errors::FileError,
    load_config::Config,
    proto::{MessageEnvelope, SyncRequest, SyncResponse},
    scripts,
    util::paths::{FileId, GroupId, get_path_for_group_file, get_path_for_user_file},
};

#[tokio::test]
async fn generic_file_errors_preserve_the_express_json_key_order() {
    let response = file_error(
        FileError::Generic {
            message: "generic failure".into(),
            details: json!({ "source": "contract" }),
        },
        "file-not-found",
    );

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap(),
        r#"{"status":"error","reason":"internal-error"}"#
    );
}

struct TestApp {
    state: AppState,
    root: PathBuf,
}

impl TestApp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("actual-sync-tests-{}", Uuid::new_v4()));
        let server_files = root.join("server");
        let user_files = root.join("user");
        fs::create_dir_all(&server_files).unwrap();
        fs::create_dir_all(&user_files).unwrap();
        let config = Config {
            server_files,
            user_files,
            ..Config::default()
        };
        let state = scripts::app_state(config).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE users
                   (id TEXT PRIMARY KEY, user_name TEXT, display_name TEXT, role TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1, owner INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE sessions
                   (token TEXT PRIMARY KEY, expires_at INTEGER, user_id TEXT, auth_method TEXT);
                 CREATE TABLE files
                   (id TEXT PRIMARY KEY, group_id TEXT, sync_version SMALLINT, encrypt_meta TEXT,
                    encrypt_keyid TEXT, encrypt_salt TEXT, encrypt_test TEXT,
                    deleted BOOLEAN DEFAULT FALSE, name TEXT, owner TEXT);
                 CREATE TABLE user_access
                   (user_id TEXT, file_id TEXT, PRIMARY KEY (user_id, file_id));
                 INSERT INTO users (id, user_name, display_name, role) VALUES
                   ('admin', 'admin', 'Admin', 'ADMIN'),
                   ('owner', 'owner', 'Owner', 'USER'),
                   ('shared', 'shared', 'Shared', 'USER'),
                   ('other', 'other', 'Other', 'USER');
                 INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES
                   ('admin-token', -1, 'admin', 'password'),
                   ('owner-token', -1, 'owner', 'password'),
                   ('shared-token', -1, 'shared', 'password'),
                   ('other-token', -1, 'other', 'password');",
            )
            .unwrap();
        Self { state, root }
    }

    fn router(&self) -> Router {
        router(20, 20, 20).with_state(self.state.clone())
    }

    fn insert_file(&self, file: &File) {
        super::services::files_service::set(&self.state.database.lock().unwrap(), file).unwrap();
    }

    fn restart(&mut self) {
        self.state = scripts::app_state((*self.state.config).clone()).unwrap();
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn file(id: &str, owner: &str) -> File {
    File {
        id: FileId::new(id),
        group_id: Some(GroupId::new("group-1")),
        sync_version: Some(2),
        name: Some("Budget".into()),
        encrypt_meta: Some(r#"{"keyId":"key-1"}"#.into()),
        encrypt_salt: Some("salt".into()),
        encrypt_test: Some("test".into()),
        encrypt_key_id: Some("key-1".into()),
        deleted: false,
        owner: Some(owner.into()),
    }
}

async fn send(app: Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = respond(app, request).await;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, body)
}

async fn respond(app: Router, request: Request<Body>) -> Response {
    app.oneshot(request).await.unwrap()
}

fn json_request(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header("x-actual-token", token);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn authentication_and_key_authorization_match_the_route_matrix() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    app.state
        .database
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES ('budget', 'shared')",
            [],
        )
        .unwrap();

    let (status, body) = send(
        app.router(),
        json_request("POST", "/user-get-key", None, json!({ "fileId": "budget" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["details"],
        "token-not-found"
    );

    for token in ["owner-token", "shared-token", "admin-token"] {
        let (status, body) = send(
            app.router(),
            json_request(
                "POST",
                "/user-get-key",
                Some(token),
                json!({ "fileId": "budget" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"]["id"],
            "key-1"
        );
    }
    let (status, body) = send(
        app.router(),
        json_request(
            "POST",
            "/user-get-key",
            Some("other-token"),
            json!({ "fileId": "budget" }),
        ),
    )
    .await;
    assert_eq!(
        (status, body.as_slice()),
        (StatusCode::FORBIDDEN, b"file-access-not-allowed".as_slice())
    );

    for token in ["shared-token", "other-token"] {
        let (status, _) = send(
            app.router(),
            json_request(
                "POST",
                "/user-create-key",
                Some(token),
                json!({
                    "fileId": "budget", "keyId": "new", "keySalt": "new", "testContent": "new"
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let key_state: (String, String, String) = app
        .state
        .database
        .lock()
        .unwrap()
        .query_row(
            "SELECT encrypt_keyid, encrypt_salt, encrypt_test FROM files WHERE id = 'budget'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(key_state, ("key-1".into(), "salt".into(), "test".into()));
    for token in ["owner-token", "admin-token"] {
        let (status, _) = send(
            app.router(),
            json_request(
                "POST",
                "/user-create-key",
                Some(token),
                json!({
                    "fileId": "budget", "keyId": token, "keySalt": "new", "testContent": "new"
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
}

#[tokio::test]
async fn upload_download_reset_and_restart_preserve_filesystem_and_database_state() {
    let mut app = TestApp::new();
    let upload = Request::builder()
        .method("POST")
        .uri("/upload-user-file")
        .header("x-actual-token", "owner-token")
        .header(header::CONTENT_TYPE, "application/encrypted-file")
        .header("x-actual-name", "My%20Budget")
        .header("x-actual-file-id", "budget")
        .header("x-actual-format", "2")
        .header("x-actual-encrypt-meta", r#"{"keyId":"key-1"}"#)
        .body(Body::from("encrypted bytes"))
        .unwrap();
    let (status, body) = send(app.router(), upload).await;
    assert_eq!(status, StatusCode::OK);
    let group_id = serde_json::from_slice::<Value>(&body).unwrap()["groupId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        fs::read(get_path_for_user_file(&app.state.config, "budget")).unwrap(),
        b"encrypted bytes"
    );

    let download = Request::builder()
        .uri("/download-user-file")
        .header("x-actual-token", "owner-token")
        .header("x-actual-file-id", "budget")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        send(app.router(), download).await,
        (StatusCode::OK, b"encrypted bytes".to_vec())
    );

    fs::write(
        get_path_for_group_file(&app.state.config, &group_id),
        b"group",
    )
    .unwrap();
    let (status, _) = send(
        app.router(),
        json_request(
            "POST",
            "/reset-user-file",
            Some("owner-token"),
            json!({ "fileId": "budget" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!get_path_for_group_file(&app.state.config, &group_id).exists());
    let group: Option<String> = app
        .state
        .database
        .lock()
        .unwrap()
        .query_row(
            "SELECT group_id FROM files WHERE id = 'budget'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(group, None);

    app.restart();
    let persisted_group: Option<String> = app
        .state
        .database
        .lock()
        .unwrap()
        .query_row(
            "SELECT group_id FROM files WHERE id = 'budget'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_group, None);
    assert_eq!(
        fs::read(get_path_for_user_file(&app.state.config, "budget")).unwrap(),
        b"encrypted bytes"
    );
}

#[tokio::test]
async fn existing_upload_checks_group_key_access_and_supports_unencrypted_files() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));

    async fn upload(
        app: &TestApp,
        token: &str,
        group: Option<&str>,
        meta: Option<&str>,
    ) -> (StatusCode, Vec<u8>) {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/upload-user-file")
            .header("x-actual-token", token)
            .header(header::CONTENT_TYPE, "application/encrypted-file")
            .header("x-actual-name", "Budget")
            .header("x-actual-file-id", "budget")
            .header("x-actual-format", "2");
        if let Some(group) = group {
            builder = builder.header("x-actual-group-id", group);
        }
        if let Some(meta) = meta {
            builder = builder.header("x-actual-encrypt-meta", meta);
        }
        send(
            app.router(),
            builder.body(Body::from("replacement")).unwrap(),
        )
        .await
    }

    assert_eq!(
        upload(
            &app,
            "other-token",
            Some("group-1"),
            Some(r#"{"keyId":"key-1"}"#)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(!get_path_for_user_file(&app.state.config, "budget").exists());
    assert_eq!(
        app.state
            .database
            .lock()
            .unwrap()
            .query_row("SELECT name FROM files WHERE id = 'budget'", [], |row| {
                row.get::<_, String>(0)
            },)
            .unwrap(),
        "Budget"
    );
    let (status, body) = upload(
        &app,
        "owner-token",
        Some("wrong"),
        Some(r#"{"keyId":"key-1"}"#),
    )
    .await;
    assert_eq!(
        (status, body.as_slice()),
        (StatusCode::BAD_REQUEST, b"file-has-reset".as_slice())
    );
    let (status, body) = upload(
        &app,
        "owner-token",
        Some("group-1"),
        Some(r#"{"keyId":"wrong"}"#),
    )
    .await;
    assert_eq!(
        (status, body.as_slice()),
        (StatusCode::BAD_REQUEST, b"file-has-new-key".as_slice())
    );
    assert_eq!(
        upload(
            &app,
            "admin-token",
            Some("group-1"),
            Some(r#"{"keyId":"key-1"}"#)
        )
        .await
        .0,
        StatusCode::OK
    );

    app.state
        .database
        .lock()
        .unwrap()
        .execute(
            "UPDATE files SET encrypt_keyid = NULL, encrypt_meta = NULL WHERE id = 'budget'",
            [],
        )
        .unwrap();
    assert_eq!(
        upload(&app, "owner-token", Some("group-1"), None).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn malformed_upload_metadata_and_names_do_not_mutate_and_numbers_use_sqlite_text_affinity() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    let path = get_path_for_user_file(&app.state.config, "budget");
    fs::write(&path, b"original").unwrap();

    for (name, encrypt_meta) in [
        ("Budget", "{"),
        ("Budget", "null"),
        ("%ZZ", r#"{"keyId":"key-1"}"#),
    ] {
        let response = Request::builder()
            .method("POST")
            .uri("/upload-user-file")
            .header("x-actual-token", "owner-token")
            .header(header::CONTENT_TYPE, "application/encrypted-file")
            .header("x-actual-name", name)
            .header("x-actual-file-id", "budget")
            .header("x-actual-group-id", "group-1")
            .header("x-actual-format", "2")
            .header("x-actual-encrypt-meta", encrypt_meta)
            .body(Body::from("replacement"))
            .unwrap();
        assert_eq!(
            send(app.router(), response).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(
            app.state
                .database
                .lock()
                .unwrap()
                .query_row(
                    "SELECT encrypt_meta FROM files WHERE id = 'budget'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            r#"{"keyId":"key-1"}"#
        );
    }

    assert_eq!(
        send(
            app.router(),
            Request::builder()
                .method("POST")
                .uri("/update-user-filename")
                .header("content-type", "application/json")
                .header("x-actual-token", "owner-token")
                .body(Body::from(r#"{"fileId":"budget","name":1e20}"#))
                .unwrap(),
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        send(
            app.router(),
            Request::builder()
                .method("POST")
                .uri("/user-create-key")
                .header("content-type", "application/json")
                .header("x-actual-token", "owner-token")
                .body(Body::from(
                    r#"{"fileId":"budget","keyId":-0,"keySalt":1e20,"testContent":1.5}"#,
                ))
                .unwrap(),
        )
        .await
        .0,
        StatusCode::OK
    );
    let values: (String, String, String, String) = app
        .state
        .database
        .lock()
        .unwrap()
        .query_row(
            "SELECT name, encrypt_keyid, encrypt_salt, encrypt_test FROM files WHERE id = 'budget'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        values,
        (
            "1.0e+20".into(),
            "0.0".into(),
            "1.0e+20".into(),
            "1.5".into()
        )
    );
}

#[tokio::test]
async fn route_validation_returns_the_source_status_and_error_bodies() {
    let app = TestApp::new();
    let cases = [
        (
            "/user-get-key",
            json!({ "fileId": "budget@2026" }),
            StatusCode::BAD_REQUEST,
            "invalid fileId",
        ),
        (
            "/user-create-key",
            json!({ "fileId": "missing" }),
            StatusCode::BAD_REQUEST,
            "file-not-found",
        ),
        (
            "/reset-user-file",
            json!({ "fileId": "missing" }),
            StatusCode::BAD_REQUEST,
            "User or file not found",
        ),
    ];
    for (uri, body, expected_status, expected_body) in cases {
        let (status, body) = send(
            app.router(),
            json_request("POST", uri, Some("owner-token"), body),
        )
        .await;
        assert_eq!(
            (status, body.as_slice()),
            (expected_status, expected_body.as_bytes())
        );
    }
    let (status, body) = send(
        app.router(),
        json_request("POST", "/delete-user-file", Some("owner-token"), json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["details"],
        "fileId-required"
    );

    for (request, expected_body) in [
        (
            Request::builder()
                .method("POST")
                .uri("/upload-user-file")
                .header("x-actual-token", "owner-token")
                .body(Body::empty())
                .unwrap(),
            "single x-actual-name is required",
        ),
        (
            Request::builder()
                .method("POST")
                .uri("/upload-user-file")
                .header("x-actual-token", "owner-token")
                .header("x-actual-name", "Budget")
                .header(header::CONTENT_TYPE, "application/encrypted-file")
                .body(Body::empty())
                .unwrap(),
            "fileId is required",
        ),
    ] {
        assert_eq!(
            send(app.router(), request).await,
            (StatusCode::BAD_REQUEST, expected_body.as_bytes().to_vec())
        );
    }

    for content_type in [None, Some("application/json")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/upload-user-file")
            .header("x-actual-token", "owner-token")
            .header("x-actual-name", "Budget")
            .header("x-actual-file-id", "new-budget");
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        let response = respond(app.router(), request.body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            r#"{"status":"error"}"#
        );
    }
}

#[tokio::test]
async fn corrupted_stored_identifiers_propagate_as_internal_file_errors() {
    for (file_id, group_id) in [("invalid@file", "group"), ("valid-file", "invalid@group")] {
        let app = TestApp::new();
        app.state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO files (id, group_id, deleted, owner) VALUES (?, ?, 0, 'owner')",
                rusqlite::params![file_id, group_id],
            )
            .unwrap();
        let (status, body) = send(
            app.router(),
            Request::builder()
                .uri("/list-user-files")
                .header("x-actual-token", "owner-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "status": "error", "reason": "internal-error" })
        );
    }
}

#[tokio::test]
async fn metadata_listing_rename_and_delete_enforce_access_and_owner_rules() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    app.state
        .database
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES ('budget', 'shared')",
            [],
        )
        .unwrap();

    for token in ["owner-token", "shared-token", "admin-token"] {
        let request = Request::builder()
            .uri("/list-user-files")
            .header("x-actual-token", token)
            .body(Body::empty())
            .unwrap();
        let (status, body) = send(app.router(), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let (status, _) = send(
        app.router(),
        json_request(
            "POST",
            "/update-user-filename",
            Some("shared-token"),
            json!({ "fileId": "budget", "name": "Shared name" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        app.router(),
        json_request(
            "POST",
            "/delete-user-file",
            Some("shared-token"),
            json!({ "fileId": "budget" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        app.router(),
        json_request(
            "POST",
            "/delete-user-file",
            Some("owner-token"),
            json!({ "fileId": "budget" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        app.state
            .database
            .lock()
            .unwrap()
            .query_row("SELECT deleted FROM files WHERE id = 'budget'", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn download_and_file_info_cover_missing_files_and_owner_admin_shared_access() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    fs::write(
        get_path_for_user_file(&app.state.config, "budget"),
        b"content",
    )
    .unwrap();
    app.state
        .database
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES ('budget', 'shared')",
            [],
        )
        .unwrap();

    let response = respond(
        app.router(),
        Request::builder()
            .uri("/download-user-file")
            .header("x-actual-token", "owner-token")
            .header("x-actual-file-id", "budget")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION],
        "attachment;filename=budget"
    );

    async fn get(app: &TestApp, uri: &str, token: &str, file_id: &str) -> (StatusCode, Vec<u8>) {
        send(
            app.router(),
            Request::builder()
                .uri(uri)
                .header("x-actual-token", token)
                .header("x-actual-file-id", file_id)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    for token in ["owner-token", "shared-token", "admin-token"] {
        assert_eq!(
            get(&app, "/download-user-file", token, "budget").await.0,
            StatusCode::OK
        );
        let (status, body) = get(&app, "/get-user-file-info", token, "budget").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["data"]["fileId"],
            "budget"
        );
    }
    for uri in ["/download-user-file", "/get-user-file-info"] {
        assert_eq!(
            get(&app, uri, "other-token", "budget").await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            get(&app, uri, "owner-token", "missing").await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(&app, uri, "owner-token", "budget@2026").await.0,
            StatusCode::BAD_REQUEST
        );
    }
    app.insert_file(&file("missing-blob", "owner"));
    assert_eq!(
        get(&app, "/download-user-file", "owner-token", "missing-blob")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn owner_only_mutations_allow_admin_and_reject_shared_users_without_changing_state() {
    let app = TestApp::new();
    for id in ["reset", "delete", "rename"] {
        app.insert_file(&file(id, "owner"));
        app.state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO user_access (file_id, user_id) VALUES (?, 'shared')",
                [id],
            )
            .unwrap();
    }
    let reset_group_file = get_path_for_group_file(&app.state.config, "group-1");
    fs::write(&reset_group_file, b"sync state").unwrap();

    for token in ["shared-token", "other-token"] {
        assert_eq!(
            send(
                app.router(),
                json_request(
                    "POST",
                    "/reset-user-file",
                    Some(token),
                    json!({ "fileId": "reset" }),
                )
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send(
                app.router(),
                json_request(
                    "POST",
                    "/delete-user-file",
                    Some(token),
                    json!({ "fileId": "delete" }),
                )
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    {
        let database = app.state.database.lock().unwrap();
        assert_eq!(
            database
                .query_row("SELECT group_id FROM files WHERE id = 'reset'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "group-1"
        );
        assert_eq!(
            database
                .query_row("SELECT deleted FROM files WHERE id = 'delete'", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(fs::read(&reset_group_file).unwrap(), b"sync state");
    }
    assert_eq!(
        send(
            app.router(),
            json_request(
                "POST",
                "/reset-user-file",
                Some("admin-token"),
                json!({ "fileId": "reset" }),
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(!reset_group_file.exists());
    assert_eq!(
        send(
            app.router(),
            json_request(
                "POST",
                "/delete-user-file",
                Some("admin-token"),
                json!({ "fileId": "delete" }),
            )
        )
        .await
        .0,
        StatusCode::OK
    );

    assert_eq!(
        send(
            app.router(),
            json_request(
                "POST",
                "/update-user-filename",
                Some("other-token"),
                json!({ "fileId": "rename", "name": "forbidden" }),
            )
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.state
            .database
            .lock()
            .unwrap()
            .query_row("SELECT name FROM files WHERE id = 'rename'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "Budget"
    );
    assert_eq!(
        send(
            app.router(),
            json_request(
                "POST",
                "/update-user-filename",
                Some("admin-token"),
                json!({ "fileId": "rename", "name": "admin name" }),
            )
        )
        .await
        .0,
        StatusCode::OK
    );

    let database = app.state.database.lock().unwrap();
    let reset_group: Option<String> = database
        .query_row("SELECT group_id FROM files WHERE id = 'reset'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(reset_group, None);
    assert_eq!(
        database
            .query_row("SELECT deleted FROM files WHERE id = 'delete'", [], |row| {
                row.get::<_, i64>(0)
            },)
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row("SELECT name FROM files WHERE id = 'rename'", [], |row| {
                row.get::<_, String>(0)
            },)
            .unwrap(),
        "admin name"
    );
}

#[tokio::test]
async fn sync_reports_invalid_body_missing_since_missing_file_and_attribute_conflicts() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    let request = Request::builder()
        .method("POST")
        .uri("/sync")
        .header("x-actual-token", "owner-token")
        .header(header::CONTENT_TYPE, "application/actual-sync")
        .body(Body::from("not protobuf"))
        .unwrap();
    assert_eq!(
        send(app.router(), request).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );

    async fn sync_status(app: &TestApp, request: SyncRequest) -> (StatusCode, Vec<u8>) {
        let mut bytes = Vec::new();
        request.encode(&mut bytes).unwrap();
        send(
            app.router(),
            Request::builder()
                .method("POST")
                .uri("/sync")
                .header("x-actual-token", "owner-token")
                .header(header::CONTENT_TYPE, "application/actual-sync")
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
    }
    assert_eq!(
        sync_status(
            &app,
            SyncRequest {
                file_id: "budget".into(),
                ..Default::default()
            }
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sync_status(
            &app,
            SyncRequest {
                file_id: "missing".into(),
                since: "0".into(),
                ..Default::default()
            }
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for (group_id, key_id, expected) in [
        ("wrong", "key-1", "file-has-reset"),
        ("group-1", "wrong", "file-has-new-key"),
    ] {
        let (status, body) = sync_status(
            &app,
            SyncRequest {
                file_id: "budget".into(),
                group_id: group_id.into(),
                key_id: key_id.into(),
                since: "0".into(),
                messages: vec![],
            },
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, expected.as_bytes());
    }
}

#[tokio::test]
async fn sync_requires_the_actual_sync_media_type_and_returns_protocol_headers() {
    let app = TestApp::new();
    app.insert_file(&file("budget", "owner"));
    let request = SyncRequest {
        file_id: "budget".into(),
        group_id: "group-1".into(),
        key_id: "key-1".into(),
        since: "2024-01-01T00:00:00.000Z".into(),
        messages: vec![],
    };
    let mut bytes = Vec::new();
    request.encode(&mut bytes).unwrap();

    for content_type in [None, Some("application/json")] {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/sync")
            .header("x-actual-token", "owner-token");
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let response = respond(
            app.router(),
            builder.body(Body::from(bytes.clone())).unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/json; charset=utf-8"
        );
    }

    let response = respond(
        app.router(),
        Request::builder()
            .method("POST")
            .uri("/sync")
            .header("x-actual-token", "owner-token")
            .header(
                header::CONTENT_TYPE,
                "Application/Actual-Sync; charset=binary",
            )
            .body(Body::from(bytes))
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/actual-sync"
    );
    assert_eq!(response.headers()["x-actual-sync-method"], "simple");
}

#[test]
fn validation_covers_old_upload_reset_and_key_mismatch_states() {
    let mut current = file("budget", "owner");
    assert_eq!(
        validation::validate_synced_file(Some("group-1"), Some("key-1"), &current),
        None
    );
    current.sync_version = Some(1);
    assert_eq!(
        validation::validate_synced_file(Some("group-1"), Some("key-1"), &current),
        Some("file-old-version")
    );
    current.sync_version = Some(2);
    current.group_id = None;
    assert_eq!(
        validation::validate_synced_file(None, Some("key-1"), &current),
        Some("file-needs-upload")
    );
    current.group_id = Some(GroupId::new("group-1"));
    current.encrypt_meta = Some(r#"{"keyId":"different"}"#.into());
    assert_eq!(
        validation::validate_synced_file(Some("group-1"), Some("key-1"), &current),
        Some("file-key-mismatch")
    );
}

#[tokio::test]
async fn http_crdt_matches_the_golden_merkle_order_encryption_conflict_and_since() {
    let mut app = TestApp::new();
    let mut budget = file("budget", "owner");
    budget.group_id = Some(GroupId::new("group-crdt"));
    app.insert_file(&budget);
    let first = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.001Z-0000-0000000000000001".into(),
        is_encrypted: false,
        content: vec![1, 2, 3],
    };
    let later = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.002Z-0000-0000000000000002".into(),
        is_encrypted: true,
        content: vec![4, 5, 6],
    };

    async fn exchange(
        app: &TestApp,
        messages: Vec<MessageEnvelope>,
        since: &str,
    ) -> (HeaderMap, SyncResponse) {
        let request = SyncRequest {
            file_id: "budget".into(),
            group_id: "group-crdt".into(),
            key_id: "key-1".into(),
            since: since.into(),
            messages,
        };
        let mut bytes = Vec::new();
        request.encode(&mut bytes).unwrap();
        let response = respond(
            app.router(),
            Request::builder()
                .method("POST")
                .uri("/sync")
                .header("x-actual-token", "owner-token")
                .header(header::CONTENT_TYPE, "application/actual-sync")
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (headers, SyncResponse::decode(body).unwrap())
    }

    let (_, inserted) = exchange(
        &app,
        vec![later.clone(), first.clone()],
        "2025-01-01T00:00:00.000Z",
    )
    .await;
    assert!(inserted.messages.is_empty());
    assert_eq!(
        inserted.merkle,
        r#"{"2":{"0":{"0":{"1":{"1":{"0":{"2":{"1":{"0":{"1":{"2":{"2":{"2":{"0":{"0":{"0":{"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395},"hash":471510395}"#
    );

    let (headers, read_back) = exchange(&app, vec![], "2025-01-01T00:00:00.000Z").await;
    assert_eq!(headers[header::CONTENT_TYPE], "application/actual-sync");
    assert_eq!(read_back.messages, vec![first.clone(), later.clone()]);
    assert_eq!(read_back.merkle, inserted.merkle);

    let mut conflicting = first.clone();
    conflicting.content = vec![9, 9, 9];

    let (_, exact_duplicate) =
        exchange(&app, vec![first.clone()], "2025-01-01T00:00:00.000Z").await;
    assert_eq!(exact_duplicate.messages, vec![first.clone(), later.clone()]);
    assert_eq!(exact_duplicate.merkle, inserted.merkle);

    let (_, duplicate) = exchange(&app, vec![conflicting], "2025-01-01T00:00:00.000Z").await;
    assert_eq!(duplicate.messages, vec![first.clone(), later.clone()]);
    assert_eq!(duplicate.merkle, inserted.merkle);

    let (_, after_first) = exchange(&app, vec![], &first.timestamp).await;
    assert_eq!(after_first.messages, vec![later.clone()]);
    assert_eq!(after_first.merkle, inserted.merkle);

    let (_, strictly_between) = exchange(
        &app,
        vec![],
        "2026-01-01T00:00:00.001Z-0000-0000000000000002",
    )
    .await;
    assert_eq!(strictly_between.messages, vec![later.clone()]);
    assert_eq!(strictly_between.merkle, inserted.merkle);

    let non_canonical = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.003+00:00-0x10-1".into(),
        is_encrypted: false,
        content: vec![7],
    };
    let canonical = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.003Z-0010-0000000000000001".into(),
        content: vec![8],
        ..non_canonical.clone()
    };
    let (_, non_canonical_result) = exchange(
        &app,
        vec![non_canonical.clone()],
        "2025-01-01T00:00:00.000Z",
    )
    .await;
    assert_ne!(
        serde_json::from_str::<Value>(&non_canonical_result.merkle).unwrap()["hash"],
        471_510_395
    );
    let (_, canonical_result) =
        exchange(&app, vec![canonical.clone()], "2025-01-01T00:00:00.000Z").await;
    assert_eq!(
        serde_json::from_str::<Value>(&canonical_result.merkle).unwrap()["hash"],
        471_510_395
    );

    let signed = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.004+00:00-+10-2".into(),
        is_encrypted: false,
        content: vec![9],
    };
    let signed_canonical = MessageEnvelope {
        timestamp: "2026-01-01T00:00:00.004Z-0010-0000000000000002".into(),
        content: vec![10],
        ..signed.clone()
    };
    let (_, signed_result) = exchange(&app, vec![signed.clone()], "2025-01-01T00:00:00.000Z").await;
    assert_ne!(
        serde_json::from_str::<Value>(&signed_result.merkle).unwrap()["hash"],
        471_510_395
    );
    let (_, signed_canonical_result) = exchange(
        &app,
        vec![signed_canonical.clone()],
        "2025-01-01T00:00:00.000Z",
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&signed_canonical_result.merkle).unwrap()["hash"],
        471_510_395
    );

    app.restart();
    let (_, after_restart) = exchange(&app, vec![], "2025-01-01T00:00:00.000Z").await;
    assert_eq!(
        after_restart.messages,
        vec![
            first,
            later,
            non_canonical,
            canonical,
            signed,
            signed_canonical,
        ]
    );
    assert_eq!(after_restart.merkle, inserted.merkle);
}
