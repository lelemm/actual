use axum::http::{Method, StatusCode};
use rusqlite::params;
use serde_json::{Value, json};
use uuid::Uuid;

use super::router;
use crate::test_support::{TestApp, TestResponse};

fn user(app: &TestApp, name: &str, role: &str) -> (String, String) {
    let id = Uuid::new_v4().to_string();
    let token = format!("token-{}", Uuid::new_v4());
    app.create_user(&id, name, role, false, true);
    app.create_session(&id, &token, None);
    (id, token)
}

fn create_owner(app: &TestApp) {
    app.create_user("test-owner", "test-owner", "ADMIN", true, true);
}

async fn request(
    app: &TestApp,
    method: Method,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> TestResponse {
    app.send(router(), method, uri, Some(token), None, body)
        .await
}

fn reason(response: &TestResponse) -> String {
    response.json()["reason"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn disabled_user_session_returns_unauthorized() {
    let app = TestApp::new();
    let (id, token) = user(&app, "targetForRevocation", "BASIC");
    app.connection()
        .execute("UPDATE users SET enabled = 0 WHERE id = ?", [&id])
        .unwrap();
    let response = request(&app, Method::GET, "/users", &token, None).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "unauthorized", "details": "token-not-found" })
    );
}

#[tokio::test]
async fn disabling_a_user_removes_existing_sessions() {
    let app = TestApp::new();
    let (_, admin_token) = user(&app, "adminForRevocation", "ADMIN");
    let (target_id, target_token) = user(&app, "targetForRevocation", "BASIC");
    let response = request(
        &app,
        Method::PATCH,
        "/users",
        &admin_token,
        Some(json!({
            "id": target_id, "userName": "targetForRevocation", "displayName": "Target",
            "enabled": false, "role": "BASIC"
        })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        app.connection()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE token = ?",
                [&target_token],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn deleting_a_user_removes_existing_sessions() {
    let app = TestApp::new();
    create_owner(&app);
    let (_, admin_token) = user(&app, "adminForRevocation", "ADMIN");
    let (target_id, target_token) = user(&app, "targetForRevocation", "BASIC");
    let response = request(
        &app,
        Method::DELETE,
        "/users",
        &admin_token,
        Some(json!({ "ids": [target_id] })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        app.connection()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE token = ?",
                [&target_token],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn owner_created_returns_true() {
    let app = TestApp::new();
    let id = Uuid::new_v4().to_string();
    let token = format!("token-{}", Uuid::new_v4());
    app.create_user(&id, "admin", "ADMIN", true, true);
    app.create_session(&id, &token, None);
    let response = request(&app, Method::GET, "/owner-created", &token, None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!(true));
}

#[tokio::test]
async fn users_returns_a_list() {
    let app = TestApp::new();
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let id = Uuid::new_v4().to_string();
    app.create_user(&id, "testUser", "ADMIN", false, true);
    let response = request(&app, Method::GET, "/users", &token, None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(!response.json().as_array().unwrap().is_empty());
}

#[tokio::test]
async fn creating_a_user_returns_its_id() {
    let app = TestApp::new();
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let response = request(&app, Method::POST, "/users", &token, Some(json!({
        "userName": "user1", "displayName": "User One", "enabled": 1, "owner": 0, "role": "BASIC"
    }))).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["status"], "ok");
    let id = response.json()["data"]["id"].as_str().unwrap().to_owned();
    let stored = app
        .connection()
        .query_row(
            "SELECT user_name, display_name, enabled, owner, role FROM users WHERE id = ?",
            [&id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        stored,
        ("user1".into(), Some("User One".into()), true, false, None)
    );
}

#[tokio::test]
async fn creating_a_duplicate_user_is_rejected() {
    let app = TestApp::new();
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let body = json!({ "userName": "user1", "displayName": "User One", "enabled": 1, "owner": 0, "role": "BASIC" });
    assert_eq!(
        request(&app, Method::POST, "/users", &token, Some(body.clone()))
            .await
            .status,
        StatusCode::OK
    );
    let response = request(&app, Method::POST, "/users", &token, Some(body)).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(reason(&response), "user-already-exists");
}

#[tokio::test]
async fn updating_an_existing_user_returns_its_id() {
    let app = TestApp::new();
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let id = Uuid::new_v4().to_string();
    app.create_user(&id, "testUser", "ADMIN", false, true);
    let response = request(&app, Method::PATCH, "/users", &token, Some(json!({
        "id": id, "userName": "updatedUser", "displayName": "Updated User", "enabled": true, "role": "BASIC"
    }))).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["data"]["id"], id);
    let stored = app
        .connection()
        .query_row(
            "SELECT user_name, display_name, enabled, role FROM users WHERE id = ?",
            [&id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        stored,
        (
            "updatedUser".into(),
            Some("Updated User".into()),
            true,
            Some("BASIC".into())
        )
    );
}

#[tokio::test]
async fn updating_a_missing_user_is_rejected() {
    let app = TestApp::new();
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let response = request(&app, Method::PATCH, "/users", &token, Some(json!({
        "id": "non-existing-id", "userName": "nonexistinguser", "displayName": "Non-existing User", "enabled": true, "role": "BASIC"
    }))).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(reason(&response), "cannot-find-user-to-update");
}

#[tokio::test]
async fn deleting_existing_users_reports_complete_success() {
    let app = TestApp::new();
    create_owner(&app);
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let id = Uuid::new_v4().to_string();
    app.create_user(&id, "testUser", "ADMIN", false, true);
    let response = request(
        &app,
        Method::DELETE,
        "/users",
        &token,
        Some(json!({ "ids": [id] })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["data"]["someDeletionsFailed"], false);
    assert_eq!(
        app.connection()
            .query_row("SELECT COUNT(*) FROM users WHERE id = ?", [&id], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn deleting_missing_users_is_rejected() {
    let app = TestApp::new();
    create_owner(&app);
    let (_, token) = user(&app, "sessionUser", "ADMIN");
    let response = request(
        &app,
        Method::DELETE,
        "/users",
        &token,
        Some(json!({ "ids": ["non-existing-id"] })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(reason(&response), "not-all-deleted");
}

fn access_fixture(app: &TestApp) -> (String, String, String) {
    let (admin_id, token) = user(app, "sessionUser", "ADMIN");
    let target_id = Uuid::new_v4().to_string();
    let file_id = Uuid::new_v4().to_string();
    app.create_user(&target_id, "testUser", "ADMIN", false, true);
    app.create_file(&file_id, &admin_id);
    (token, target_id, file_id)
}

#[tokio::test]
async fn granting_access_succeeds() {
    let app = TestApp::new();
    let (token, target_id, file_id) = access_fixture(&app);
    let response = request(
        &app,
        Method::POST,
        "/access",
        &token,
        Some(json!({ "fileId": file_id, "userId": target_id })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["status"], "ok");
}

#[tokio::test]
async fn granting_duplicate_access_is_rejected() {
    let app = TestApp::new();
    let (token, target_id, file_id) = access_fixture(&app);
    let body = json!({ "fileId": file_id, "userId": target_id });
    assert_eq!(
        request(&app, Method::POST, "/access", &token, Some(body.clone()))
            .await
            .status,
        StatusCode::OK
    );
    let response = request(&app, Method::POST, "/access", &token, Some(body)).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(reason(&response), "user-already-have-access");
}

#[tokio::test]
async fn deleting_existing_access_reports_complete_success() {
    let app = TestApp::new();
    let (token, target_id, file_id) = access_fixture(&app);
    app.connection()
        .execute(
            "INSERT INTO user_access (user_id, file_id) VALUES (?, ?)",
            params![target_id, file_id],
        )
        .unwrap();
    let response = request(
        &app,
        Method::DELETE,
        &format!("/access?fileId={file_id}"),
        &token,
        Some(json!({ "ids": [target_id] })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["data"]["someDeletionsFailed"], false);
}

#[tokio::test]
async fn deleting_missing_access_is_rejected() {
    let app = TestApp::new();
    let (token, _, file_id) = access_fixture(&app);
    let response = request(
        &app,
        Method::DELETE,
        &format!("/access?fileId={file_id}"),
        &token,
        Some(json!({ "ids": ["non-existing-id"] })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(reason(&response), "not-all-deleted");
}
