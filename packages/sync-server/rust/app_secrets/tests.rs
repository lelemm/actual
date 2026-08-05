use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::router;
use crate::{
    services::secrets_service,
    test_support::{TestApp, TestResponse},
};

const NAME: &str = "simplefin_token";
const VALUE: &str = "testValue";
const FILE_ID: &str = "test-file-id";

fn set(app: &TestApp, value: &str, file_id: Option<&str>) {
    secrets_service::set(&app.connection(), NAME, Some(value), file_id).unwrap();
}

fn get(app: &TestApp, file_id: Option<&str>) -> Option<String> {
    secrets_service::get(&app.connection(), NAME, file_id).unwrap()
}

fn api_fixture() -> (TestApp, String, String) {
    let app = TestApp::new();
    app.create_user("genericAdmin", "genericAdmin", "ADMIN", false, true);
    app.create_user("genericUser", "genericUser", "BASIC", false, true);
    app.create_session("genericAdmin", "valid-token", None);
    app.create_session("genericAdmin", "valid-token-admin", None);
    app.create_session("genericUser", "valid-token-user", None);
    (app, "valid-token".into(), "valid-token-user".into())
}

async fn request(
    app: &TestApp,
    method: Method,
    uri: &str,
    token: Option<&str>,
    file_id: Option<&str>,
    body: Option<Value>,
) -> TestResponse {
    app.send(router(), method, uri, token, file_id, body).await
}

#[test]
fn sets_a_secret() {
    let app = TestApp::new();
    set(&app, VALUE, Some(FILE_ID));
    let stored = app
        .connection()
        .query_row(
            "SELECT name, value FROM secrets WHERE name = ?",
            [format!("{NAME}:{FILE_ID}")],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (format!("{NAME}:{FILE_ID}"), VALUE.into()));
}

#[test]
fn gets_a_secret() {
    let app = TestApp::new();
    set(&app, VALUE, Some(FILE_ID));
    assert_eq!(get(&app, Some(FILE_ID)).as_deref(), Some(VALUE));
}

#[test]
fn checks_whether_a_secret_exists() {
    let app = TestApp::new();
    set(&app, VALUE, Some(FILE_ID));
    assert!(get(&app, Some(FILE_ID)).is_some());
    assert!(
        secrets_service::get(&app.connection(), "nonExistentSecret", Some(FILE_ID))
            .unwrap()
            .is_none()
    );
}

#[test]
fn updates_a_secret() {
    let app = TestApp::new();
    set(&app, VALUE, Some(FILE_ID));
    set(&app, "newValue", Some(FILE_ID));
    assert_eq!(get(&app, Some(FILE_ID)).as_deref(), Some("newValue"));
}

#[test]
fn keeps_global_secrets_compatible_without_a_file_id() {
    let app = TestApp::new();
    set(&app, "global-value", None);
    assert_eq!(get(&app, None).as_deref(), Some("global-value"));
}

#[test]
fn treats_empty_string_secrets_as_existing() {
    let app = TestApp::new();
    set(&app, "", Some(FILE_ID));
    assert_eq!(get(&app, Some(FILE_ID)).as_deref(), Some(""));
    assert!(get(&app, Some(FILE_ID)).is_some());
}

#[test]
fn scoped_lookup_does_not_fall_back_to_global_credentials() {
    let app = TestApp::new();
    set(&app, "global-value", None);
    assert_eq!(get(&app, Some("test-file-a")), None);
}

#[test]
fn returns_credentials_for_the_requested_scope() {
    let app = TestApp::new();
    set(&app, "global-value", None);
    set(&app, "file-value", Some("test-file-a"));
    assert_eq!(
        get(&app, Some("test-file-a")).as_deref(),
        Some("file-value")
    );
}

#[test]
fn saving_global_credentials_preserves_scoped_credentials() {
    let app = TestApp::new();
    set(&app, "file-value", Some("test-file-a"));
    set(&app, "global-value", None);
    assert_eq!(
        get(&app, Some("test-file-a")).as_deref(),
        Some("file-value")
    );
    assert_eq!(get(&app, Some("test-file-b")), None);
    assert_eq!(get(&app, None).as_deref(), Some("global-value"));
}

#[test]
fn resetting_scoped_credentials_preserves_global_credentials() {
    let app = TestApp::new();
    set(&app, "global-value", None);
    set(&app, "file-value", Some("test-file-a"));
    secrets_service::reset(&app.connection(), NAME, Some("test-file-a")).unwrap();
    assert_eq!(get(&app, Some("test-file-a")), None);
    assert_eq!(get(&app, None).as_deref(), Some("global-value"));
}

#[tokio::test]
async fn api_requires_authentication() {
    let (app, _, _) = api_fixture();
    set(&app, VALUE, Some(FILE_ID));
    let response = request(&app, Method::GET, &format!("/{NAME}"), None, None, None).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json(),
        json!({ "details": "token-not-found", "reason": "unauthorized", "status": "error" })
    );
}

#[tokio::test]
async fn api_returns_not_found_when_a_secret_is_missing() {
    let (app, token, _) = api_fixture();
    let response = request(
        &app,
        Method::GET,
        "/gocardless_secretKey",
        Some(&token),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_hides_unknown_secret_names() {
    let (app, token, _) = api_fixture();
    let response = request(
        &app,
        Method::GET,
        "/thiskeydoesnotexist",
        Some(&token),
        None,
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_reports_an_existing_global_secret() {
    let (app, token, _) = api_fixture();
    set(&app, VALUE, None);
    let response = request(
        &app,
        Method::GET,
        &format!("/{NAME}"),
        Some(&token),
        None,
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn api_reports_an_existing_scoped_secret() {
    let (app, token, _) = api_fixture();
    set(&app, VALUE, Some(FILE_ID));
    let response = request(
        &app,
        Method::GET,
        &format!("/{NAME}"),
        Some(&token),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn scoped_lookup_does_not_report_a_global_secret() {
    let (app, token, _) = api_fixture();
    set(&app, VALUE, None);
    let response = request(
        &app,
        Method::GET,
        &format!("/{NAME}"),
        Some(&token),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_sets_a_global_secret() {
    let (app, token, _) = api_fixture();
    let response = request(
        &app,
        Method::POST,
        "/",
        Some(&token),
        None,
        Some(json!({ "name": NAME, "value": VALUE })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok" }));
}

#[tokio::test]
async fn api_deletes_only_scoped_credentials() {
    let (app, token, _) = api_fixture();
    set(&app, "global-value", None);
    set(&app, "file-value", Some(FILE_ID));
    let response = request(
        &app,
        Method::DELETE,
        &format!("/{NAME}"),
        Some(&token),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok" }));
    assert_eq!(get(&app, Some(FILE_ID)), None);
    assert_eq!(get(&app, None).as_deref(), Some("global-value"));
}

#[tokio::test]
async fn api_deletes_global_credentials() {
    let (app, token, _) = api_fixture();
    set(&app, "global-value", None);
    let response = request(
        &app,
        Method::DELETE,
        &format!("/{NAME}"),
        Some(&token),
        None,
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok" }));
    assert_eq!(get(&app, None), None);
}

#[tokio::test]
async fn shared_users_cannot_manage_another_owners_file_credentials() {
    let (app, _, user_token) = api_fixture();
    app.create_file("shared-user-secret-file", "genericAdmin");
    app.connection()
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES (?, ?)",
            ["shared-user-secret-file", "genericUser"],
        )
        .unwrap();
    let response = request(
        &app,
        Method::POST,
        "/",
        Some(&user_token),
        Some("shared-user-secret-file"),
        Some(json!({ "name": NAME, "value": VALUE })),
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "file-access-denied", "details": "You don't have permissions over this file" })
    );
    assert_eq!(get(&app, Some("shared-user-secret-file")), None);
}

#[tokio::test]
async fn api_rejects_unknown_secret_names() {
    let (app, token, _) = api_fixture();
    let response = request(
        &app,
        Method::POST,
        "/",
        Some(&token),
        None,
        Some(json!({ "name": "thiskeydoesnotexist", "value": "whatever" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "invalid-secret-name", "details": "Unknown secret name" })
    );
}

#[tokio::test]
async fn openid_non_owner_cannot_check_scoped_credentials() {
    let (app, _, user_token) = api_fixture();
    set(&app, VALUE, Some(FILE_ID));
    let response = request(
        &app,
        Method::GET,
        &format!("/{NAME}"),
        Some(&user_token),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.json()["reason"], "file-access-denied");
}

#[tokio::test]
async fn openid_admin_can_check_scoped_credentials() {
    let (app, _, _) = api_fixture();
    set(&app, VALUE, Some(FILE_ID));
    let response = request(
        &app,
        Method::GET,
        &format!("/{NAME}"),
        Some("valid-token-admin"),
        Some(FILE_ID),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn openid_non_admin_owner_can_set_scoped_credentials() {
    let (app, _, user_token) = api_fixture();
    app.create_file("owner-secret-file", "genericUser");
    let response = request(
        &app,
        Method::POST,
        "/",
        Some(&user_token),
        Some("owner-secret-file"),
        Some(json!({ "name": NAME, "value": VALUE })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok" }));
    let stored = app
        .connection()
        .query_row(
            "SELECT name, value FROM secrets WHERE name = ?",
            [format!("{NAME}:owner-secret-file")],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (format!("{NAME}:owner-secret-file"), VALUE.into()));
}

#[tokio::test]
async fn openid_non_admin_cannot_set_global_credentials() {
    let (app, _, user_token) = api_fixture();
    app.create_file("owner-global-secret-file", "genericUser");
    let response = request(
        &app,
        Method::POST,
        "/",
        Some(&user_token),
        None,
        Some(json!({ "name": NAME, "value": VALUE })),
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "not-admin", "details": "You have to be admin to manage global secrets" })
    );
    assert_eq!(get(&app, None), None);
}

#[tokio::test]
async fn openid_admin_can_set_global_credentials() {
    let (app, _, _) = api_fixture();
    let response = request(
        &app,
        Method::POST,
        "/",
        Some("valid-token-admin"),
        None,
        Some(json!({ "name": NAME, "value": "newValue" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok" }));
}
