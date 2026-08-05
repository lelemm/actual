use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tower::ServiceExt;
use uuid::Uuid;

use super::router;
use crate::{
    account_db,
    test_support::{TestApp, TestResponse},
};

async fn request(
    app: &TestApp,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> TestResponse {
    app.send(router(), method, path, token, None, body).await
}

async fn login_from_forwarded_client(app: &TestApp, forwarded_for: &str) -> StatusCode {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", forwarded_for)
        .body(Body::from(r#"{"password":"wrong"}"#))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 12345))));
    router()
        .with_state(app.state.clone())
        .oneshot(request)
        .await
        .unwrap()
        .status()
}

fn insert_auth(app: &TestApp, method: &str, active: bool, extra_data: Option<&str>) {
    app.connection()
        .execute(
            "INSERT INTO auth (method, display_name, extra_data, active) VALUES (?, ?, ?, ?)",
            params![method, method, extra_data, active],
        )
        .unwrap();
}

fn user_with_session(app: &TestApp, role: &str, auth_method: Option<&str>) -> (String, String) {
    let id = Uuid::new_v4().to_string();
    let token = format!("token-{}", Uuid::new_v4());
    app.create_user(&id, &format!("user-{id}"), role, false, true);
    app.create_session(&id, &token, auth_method);
    (id, token)
}

fn bootstrap_password(app: &TestApp, password: &str) {
    account_db::bootstrap(
        &app.state.database,
        &json!({ "password": password }),
        &app.state.config.token_expiration,
    )
    .unwrap();
}

#[tokio::test]
async fn rate_limits_login_after_five_failures() {
    let app = TestApp::new();
    for _ in 0..5 {
        assert_eq!(
            request(
                &app,
                Method::POST,
                "/login",
                None,
                Some(json!({ "password": "wrong" })),
            )
            .await
            .status,
            StatusCode::BAD_REQUEST
        );
    }
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "password": "wrong" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "too-many-requests" })
    );
}

#[tokio::test]
async fn shares_the_rate_limit_between_login_and_bootstrap() {
    let app = TestApp::new();
    for _ in 0..5 {
        request(
            &app,
            Method::POST,
            "/login",
            None,
            Some(json!({ "password": "wrong" })),
        )
        .await;
    }
    let response = request(
        &app,
        Method::POST,
        "/bootstrap",
        None,
        Some(json!({ "password": "test" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "too-many-requests" })
    );
}

#[tokio::test]
async fn rate_limit_keys_distinct_clients_behind_a_trusted_proxy() {
    let mut app = TestApp::new();
    Arc::make_mut(&mut app.state.config).trusted_proxies = vec!["127.0.0.0/8".into()];
    for _ in 0..5 {
        assert_eq!(
            login_from_forwarded_client(&app, "198.51.100.10").await,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        login_from_forwarded_client(&app, "198.51.100.11").await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        login_from_forwarded_client(&app, "198.51.100.10").await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn does_not_rate_limit_needs_bootstrap() {
    let app = TestApp::new();
    for _ in 0..6 {
        request(
            &app,
            Method::POST,
            "/login",
            None,
            Some(json!({ "password": "wrong" })),
        )
        .await;
    }
    assert_eq!(
        request(&app, Method::GET, "/needs-bootstrap", None, None)
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn change_password_requires_a_session() {
    let app = TestApp::new();
    let response = request(
        &app,
        Method::POST,
        "/change-password",
        None,
        Some(json!({ "password": "newpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "unauthorized", "details": "token-not-found" })
    );
}

#[tokio::test]
async fn change_password_forbids_a_basic_user() {
    let app = TestApp::new();
    bootstrap_password(&app, "oldpassword");
    let (_, token) = user_with_session(&app, "BASIC", Some("password"));
    let response = request(
        &app,
        Method::POST,
        "/change-password",
        Some(&token),
        Some(json!({ "password": "newpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "forbidden", "details": "permission-not-found" })
    );
}

#[tokio::test]
async fn change_password_requires_password_authentication() {
    let app = TestApp::new();
    bootstrap_password(&app, "oldpassword");
    let (_, token) = user_with_session(&app, "ADMIN", Some("openid"));
    let response = request(
        &app,
        Method::POST,
        "/change-password",
        Some(&token),
        Some(json!({ "password": "newpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "forbidden", "details": "password-auth-not-active" })
    );
}

#[tokio::test]
async fn change_password_rejects_an_empty_password() {
    let app = TestApp::new();
    bootstrap_password(&app, "oldpassword");
    let (_, token) = user_with_session(&app, "ADMIN", Some("password"));
    let response = request(
        &app,
        Method::POST,
        "/change-password",
        Some(&token),
        Some(json!({ "password": "" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "invalid-password" })
    );
}

#[tokio::test]
async fn change_password_accepts_an_admin_password_session() {
    let app = TestApp::new();
    bootstrap_password(&app, "oldpassword");
    let (_, token) = user_with_session(&app, "ADMIN", Some("password"));
    let response = request(
        &app,
        Method::POST,
        "/change-password",
        Some(&token),
        Some(json!({ "password": "newpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok", "data": {} }));
    assert!(
        account_db::login_with_password(
            &app.state.database,
            Some("newpassword"),
            &app.state.config.token_expiration,
        )
        .is_ok()
    );
}

#[tokio::test]
async fn reports_the_active_login_method_without_a_request() {
    let app = TestApp::new();
    insert_auth(&app, "password", true, None);
    let response = request(&app, Method::GET, "/needs-bootstrap", None, None).await;
    assert_eq!(response.json()["data"]["loginMethod"], "password");
}

#[tokio::test]
async fn honors_an_active_requested_login_method() {
    let app = TestApp::new();
    insert_auth(&app, "openid", true, None);
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "loginMethod": "openid" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["reason"], "Invalid redirect URL");
}

#[tokio::test]
async fn honors_an_inactive_requested_login_method() {
    let app = TestApp::new();
    bootstrap_password(&app, "testpassword");
    insert_auth(&app, "openid", true, None);
    app.connection()
        .execute("UPDATE auth SET active = 0 WHERE method = 'password'", [])
        .unwrap();
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "loginMethod": "password", "password": "testpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.json()["data"]["token"].is_string());
}

#[tokio::test]
async fn ignores_a_requested_method_that_is_not_in_the_database() {
    let app = TestApp::new();
    insert_auth(&app, "openid", true, None);
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "loginMethod": "password" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["reason"], "Invalid redirect URL");
}

#[tokio::test]
async fn falls_back_to_the_config_method_when_auth_is_empty() {
    let app = TestApp::new();
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "password": "wrong" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["reason"], "invalid-password");
}

#[tokio::test]
async fn password_login_remains_available_when_openid_is_active() {
    let app = TestApp::new();
    bootstrap_password(&app, "testpassword");
    insert_auth(&app, "openid", true, None);
    app.connection()
        .execute("UPDATE auth SET active = 0 WHERE method = 'password'", [])
        .unwrap();
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "loginMethod": "password", "password": "testpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.json()["data"]["token"].is_string());
}

#[tokio::test]
async fn password_login_rejects_a_wrong_explicit_password() {
    let app = TestApp::new();
    bootstrap_password(&app, "testpassword");
    insert_auth(&app, "openid", true, None);
    app.connection()
        .execute("UPDATE auth SET active = 0 WHERE method = 'password'", [])
        .unwrap();
    let response = request(
        &app,
        Method::POST,
        "/login",
        None,
        Some(json!({ "loginMethod": "password", "password": "wrongpassword" })),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["reason"], "invalid-password");
}

async fn server_prefs_request(app: &TestApp, token: Option<&str>, prefs: Value) -> TestResponse {
    request(
        app,
        Method::POST,
        "/server-prefs",
        token,
        Some(json!({ "prefs": prefs })),
    )
    .await
}

#[tokio::test]
async fn server_prefs_requires_a_session() {
    let app = TestApp::new();
    let response = server_prefs_request(&app, None, json!({ "flags.plugins": "true" })).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json()["reason"], "unauthorized");
}

#[tokio::test]
async fn server_prefs_requires_an_admin() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "BASIC", None);
    let response =
        server_prefs_request(&app, Some(&token), json!({ "flags.plugins": "true" })).await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "forbidden", "details": "permission-not-found" })
    );
}

#[tokio::test]
async fn server_prefs_rejects_a_non_object() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    let response = server_prefs_request(&app, Some(&token), json!("invalid")).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "invalid-prefs" })
    );
}

#[tokio::test]
async fn server_prefs_rejects_null() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    let response = server_prefs_request(&app, Some(&token), Value::Null).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "invalid-prefs" })
    );
}

#[tokio::test]
async fn server_prefs_rejects_a_missing_value() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    let response = request(
        &app,
        Method::POST,
        "/server-prefs",
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["reason"], "invalid-prefs");
}

#[tokio::test]
async fn server_prefs_saves_values_for_an_admin() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    let response =
        server_prefs_request(&app, Some(&token), json!({ "flags.plugins": "true" })).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({ "status": "ok", "data": {} }));
    assert_eq!(
        account_db::get_server_prefs(&app.state.database).unwrap()["flags.plugins"],
        Some("true".into())
    );
}

#[tokio::test]
async fn server_prefs_updates_existing_values() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    app.connection()
        .execute(
            "INSERT INTO server_prefs (key, value) VALUES (?, ?)",
            params!["flags.plugins", "false"],
        )
        .unwrap();
    assert_eq!(
        server_prefs_request(&app, Some(&token), json!({ "flags.plugins": "true" }),)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        account_db::get_server_prefs(&app.state.database).unwrap()["flags.plugins"],
        Some("true".into())
    );
}

#[tokio::test]
async fn server_prefs_saves_multiple_values() {
    let app = TestApp::new();
    let (_, token) = user_with_session(&app, "ADMIN", None);
    let prefs = json!({ "flags.plugins": "true", "anotherKey": "anotherValue" });
    assert_eq!(
        server_prefs_request(&app, Some(&token), prefs).await.status,
        StatusCode::OK
    );
    let saved = account_db::get_server_prefs(&app.state.database).unwrap();
    assert_eq!(saved["flags.plugins"], Some("true".into()));
    assert_eq!(saved["anotherKey"], Some("anotherValue".into()));
}
