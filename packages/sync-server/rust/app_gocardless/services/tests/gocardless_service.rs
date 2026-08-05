use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{Method, StatusCode, Uri},
    response::IntoResponse,
    routing::any,
};
use reqwest::Url;
use serde_json::{Value, json};

use crate::{
    app_gocardless::{
        errors::{GoCardlessError, GoCardlessErrorKind},
        services::{
            gocardless_api::{GoCardlessApi, GoCardlessApiError},
            gocardless_service::GoCardlessService,
        },
    },
    services::secrets_service,
    test_support::TestApp,
};

use super::fixtures;

const TS_CASES: [&str; 30] = [
    "linked requisition",
    "unlinked requisition",
    "requisition accounts",
    "transactions balance",
    "account not linked",
    "create requisition",
    "default history",
    "separate history cap",
    "delete requisition",
    "get requisition",
    "merge details",
    "ignore empty metadata",
    "get institutions",
    "get institution",
    "extend institutions",
    "missing institution",
    "normalize transactions",
    "get balances",
    "error 400",
    "error 401",
    "expired EUA",
    "unrelated 401",
    "error 403",
    "error 404",
    "error 409",
    "error 429",
    "error 500",
    "error 503",
    "unknown status",
    "non API error",
];

#[derive(Clone, Debug)]
struct RequestRecord {
    method: Method,
    path: String,
    body: Value,
}

#[derive(Clone, Default)]
struct FakeState {
    requests: Arc<Mutex<Vec<RequestRecord>>>,
    planned: Arc<Mutex<HashMap<String, VecDeque<(StatusCode, Value)>>>>,
}

impl FakeState {
    fn plan(&self, method: Method, path: &str, status: StatusCode, body: Value) {
        self.planned
            .lock()
            .unwrap()
            .entry(format!("{method} {path}"))
            .or_default()
            .push_back((status, body));
    }

    fn count(&self, method: Method, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == method && request.path == path)
            .count()
    }

    fn bodies(&self, method: Method, path: &str) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == method && request.path == path)
            .map(|request| request.body.clone())
            .collect()
    }

    fn paths(&self, method: Method) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == method)
            .map(|request| request.path.clone())
            .collect()
    }
}

async fn upstream(
    State(state): State<FakeState>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> impl IntoResponse {
    let path = uri.path_and_query().unwrap().as_str().to_owned();
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    state.requests.lock().unwrap().push(RequestRecord {
        method: method.clone(),
        path: path.clone(),
        body,
    });
    if let Some(response) = state
        .planned
        .lock()
        .unwrap()
        .get_mut(&format!("{method} {path}"))
        .and_then(VecDeque::pop_front)
    {
        return (response.0, axum::Json(response.1));
    }
    let value = match (method, path.as_str()) {
        (Method::POST, "/api/v2/token/new/") => json!({
            "access": "header.eyJleHAiOjQxMDI0NDQ4MDB9.signature", "refresh": "refresh",
            "access_expires": 86400, "refresh_expires": 2592000
        }),
        (Method::GET, "/api/v2/institutions/?country=IE") => json!([fixtures::mock_institution()]),
        (Method::GET, path) if path.starts_with("/api/v2/institutions/") => {
            fixtures::mock_institution()
        }
        (Method::POST, "/api/v2/agreements/enduser/") => json!({ "id": "agreement-id" }),
        (Method::POST, "/api/v2/requisitions/") => fixtures::mock_create_requisition(),
        (Method::GET, path) if path.starts_with("/api/v2/requisitions/") => {
            fixtures::mock_requisition()
        }
        (Method::DELETE, path) if path.starts_with("/api/v2/requisitions/") => {
            fixtures::mock_delete_requisition()
        }
        (Method::GET, path) if path.ends_with("/details/") => fixtures::mock_account_details(),
        (Method::GET, path) if path.ends_with("/balances/") => fixtures::mocked_balances(),
        (Method::GET, path) if path.contains("/transactions/") => fixtures::mock_transactions(),
        (Method::GET, path) if path.starts_with("/api/v2/accounts/") => {
            fixtures::mock_account_metadata()
        }
        _ => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "detail": "missing fake" })),
            );
        }
    };
    (StatusCode::OK, axum::Json(value))
}

async fn harness() -> (TestApp, GoCardlessService, FakeState) {
    harness_with_token(None).await
}

async fn harness_with_token(token: Option<&str>) -> (TestApp, GoCardlessService, FakeState) {
    let fake = FakeState::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .fallback(any(upstream))
        .with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let app = TestApp::new();
    {
        let connection = app.connection();
        secrets_service::set(&connection, "gocardless_secretId", Some("secret-id"), None).unwrap();
        secrets_service::set(
            &connection,
            "gocardless_secretKey",
            Some("secret-key"),
            None,
        )
        .unwrap();
    }
    let mut api = GoCardlessApi::for_test(
        app.state.http.clone(),
        Url::parse(&format!("http://{address}/api/v2")).unwrap(),
    );
    api.set_token(token.map(str::to_owned));
    (app, GoCardlessService::for_test(api), fake)
}

#[tokio::test]
async fn source_corresponding_typescript_service_matrix() {
    assert_eq!(TS_CASES.len(), 30);
    assert_eq!(TS_CASES.iter().collect::<HashSet<_>>().len(), 30);
    let mut covered = HashSet::new();
    let (app, service, fake) = harness().await;
    let state = &app.state;
    let account_metadata = fixtures::mock_account_metadata();
    let requisition = fixtures::mock_requisition();
    let account_id = account_metadata["id"].as_str().unwrap();
    let requisition_id = requisition["id"].as_str().unwrap();

    assert_eq!(
        service
            .get_requisition(state, requisition_id)
            .await
            .unwrap(),
        fixtures::mock_requisition()
    );
    covered.insert("linked requisition");
    fake.plan(
        Method::GET,
        &format!("/api/v2/requisitions/{requisition_id}/"),
        StatusCode::OK,
        json!({ "status": "ER", "accounts": [] }),
    );
    assert_eq!(
        service
            .get_transactions(state, requisition_id, account_id, None, None, false)
            .await
            .unwrap_err()
            .kind,
        GoCardlessErrorKind::RequisitionNotLinked
    );
    covered.insert("unlinked requisition");

    let (requisition, accounts) = service
        .get_requisition_with_accounts(state, requisition_id)
        .await
        .unwrap();
    assert_eq!(requisition, fixtures::mock_requisition());
    assert_eq!(accounts.len(), 1);
    covered.insert("requisition accounts");
    let with_balance = service
        .get_transactions(state, requisition_id, account_id, None, None, true)
        .await
        .unwrap();
    assert_eq!(
        with_balance["balances"],
        fixtures::mocked_balances()["balances"]
    );
    assert!(with_balance["startingBalance"].is_number());
    covered.insert("transactions balance");
    assert_eq!(
        service
            .get_transactions(state, requisition_id, "missing", None, None, false)
            .await
            .unwrap_err()
            .kind,
        GoCardlessErrorKind::AccountNotLinked
    );
    covered.insert("account not linked");

    let created = service
        .create_requisition(state, "N26_NTSBDEB1", "https://example.com")
        .await
        .unwrap();
    assert!(!created.0.is_empty() && !created.1.is_empty());
    covered.insert("create requisition");
    let agreement_bodies = fake.bodies(Method::POST, "/api/v2/agreements/enduser/");
    assert_eq!(
        agreement_bodies.last().unwrap()["max_historical_days"],
        json!(90)
    );
    let requisition_body = fake
        .bodies(Method::POST, "/api/v2/requisitions/")
        .pop()
        .unwrap();
    assert!(requisition_body.get("ssn").is_none());
    assert!(requisition_body.get("reference").is_some());
    fake.plan(
        Method::GET,
        "/api/v2/institutions/N26_NTSBDEB1/",
        StatusCode::OK,
        json!({
            "id": "N26_NTSBDEB1", "transaction_total_days": "730", "max_access_valid_for_days": "90"
        }),
    );
    service
        .create_requisition(state, "N26_NTSBDEB1", "https://example.com")
        .await
        .unwrap();
    assert_eq!(
        fake.bodies(Method::POST, "/api/v2/agreements/enduser/")
            .last()
            .unwrap()["max_historical_days"],
        json!(730)
    );
    covered.insert("default history");
    fake.plan(Method::GET, "/api/v2/institutions/N26_NTSBDEB1/", StatusCode::OK, json!({
        "id": "N26_NTSBDEB1", "transaction_total_days": "730", "max_access_valid_for_days": "90",
        "supported_features": ["separate_continuous_history_consent"]
    }));
    service
        .create_requisition(state, "N26_NTSBDEB1", "https://example.com")
        .await
        .unwrap();
    assert_eq!(
        fake.bodies(Method::POST, "/api/v2/agreements/enduser/")
            .last()
            .unwrap()["max_historical_days"],
        json!(90)
    );
    covered.insert("separate history cap");
    fake.plan(
        Method::POST,
        "/api/v2/agreements/enduser/",
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "detail": "retry with fallback limits" }),
    );
    service
        .create_requisition(state, "N26_NTSBDEB1", "https://example.com")
        .await
        .unwrap();
    let agreement_bodies = fake.bodies(Method::POST, "/api/v2/agreements/enduser/");
    assert_eq!(
        agreement_bodies[agreement_bodies.len() - 1]["max_historical_days"],
        json!(89)
    );
    assert_eq!(
        agreement_bodies[agreement_bodies.len() - 1]["access_valid_for_days"],
        json!(90)
    );

    assert_eq!(
        service
            .delete_requisition(state, requisition_id)
            .await
            .unwrap(),
        fixtures::mock_delete_requisition()
    );
    covered.insert("delete requisition");
    assert_eq!(
        service
            .get_requisition(state, requisition_id)
            .await
            .unwrap(),
        fixtures::mock_requisition()
    );
    covered.insert("get requisition");
    let merged = service
        .get_detailed_account(state, account_id)
        .await
        .unwrap();
    assert_eq!(merged, fixtures::mock_detailed_account());
    covered.insert("merge details");
    fake.plan(
        Method::GET,
        &format!("/api/v2/accounts/{account_id}/"),
        StatusCode::OK,
        json!({ "id": account_id, "name": "" }),
    );
    fake.plan(
        Method::GET,
        &format!("/api/v2/accounts/{account_id}/details/"),
        StatusCode::OK,
        json!({ "account": { "name": "kept" } }),
    );
    assert_eq!(
        service
            .get_detailed_account(state, account_id)
            .await
            .unwrap()["name"],
        "kept"
    );
    covered.insert("ignore empty metadata");
    assert_eq!(
        service.get_institutions(state, "IE").await.unwrap(),
        json!([fixtures::mock_institution()])
    );
    covered.insert("get institutions");
    assert_eq!(
        service
            .get_institution(state, "N26_NTSBDEB1")
            .await
            .unwrap(),
        fixtures::mock_institution()
    );
    covered.insert("get institution");
    let extended = GoCardlessService::extend_accounts_about_institutions(
        &[fixtures::mock_detailed_account()],
        &[fixtures::mock_institution()],
    );
    assert_eq!(extended[0]["institution"], Value::Null);
    covered.insert("missing institution");
    let mut matching = fixtures::mock_institution();
    matching["id"] = fixtures::mock_detailed_account()["institution_id"].clone();
    assert_eq!(
        GoCardlessService::extend_accounts_about_institutions(
            &[fixtures::mock_detailed_account()],
            &[matching]
        )[0]["institution"]["id"],
        fixtures::mock_detailed_account()["institution_id"]
    );
    covered.insert("extend institutions");
    assert_eq!(
        service
            .get_account_transactions(
                state,
                "SANDBOXFINANCE_SFIN0000",
                account_id,
                Some(""),
                Some("")
            )
            .await
            .unwrap()["transactions"]["booked"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    covered.insert("normalize transactions");
    assert_eq!(
        fake.count(
            Method::GET,
            &format!("/api/v2/accounts/{account_id}/transactions/?date_from=&date_to=")
        ),
        0,
        "empty dates are omitted like falsy TypeScript values"
    );
    let paths = fake.paths(Method::GET);
    assert!(
        paths
            .iter()
            .any(|path| path == &format!("/api/v2/accounts/{account_id}/transactions/")),
        "recorded GET paths: {paths:?}"
    );
    assert_eq!(
        service.get_balances(state, account_id).await.unwrap(),
        fixtures::mocked_balances()
    );
    covered.insert("get balances");

    assert_eq!(
        fake.count(Method::POST, "/api/v2/token/new/"),
        1,
        "valid token is cached across service calls"
    );
    assert_eq!(covered, TS_CASES[..18].iter().copied().collect());
}

#[test]
fn maps_the_twelve_typescript_error_cases() {
    let mut covered = HashSet::new();
    for (name, status, kind, message) in [
        (
            "error 400",
            400,
            GoCardlessErrorKind::Client,
            "Invalid provided parameters",
        ),
        (
            "error 401",
            401,
            GoCardlessErrorKind::Client,
            "Token is invalid or expired",
        ),
        (
            "error 403",
            403,
            GoCardlessErrorKind::Client,
            "IP address access denied",
        ),
        (
            "error 404",
            404,
            GoCardlessErrorKind::Client,
            "Resource not found",
        ),
        (
            "error 409",
            409,
            GoCardlessErrorKind::Client,
            "Resource was suspended due to numerous errors that occurred while accessing it",
        ),
        (
            "error 429",
            429,
            GoCardlessErrorKind::RateLimit,
            "Daily request limit set by the Institution has been exceeded",
        ),
        (
            "error 500",
            500,
            GoCardlessErrorKind::Client,
            "Request to Institution returned an error",
        ),
        (
            "error 503",
            503,
            GoCardlessErrorKind::Client,
            "Institution service unavailable",
        ),
        (
            "unknown status",
            0,
            GoCardlessErrorKind::Generic,
            "GoCardless returned error",
        ),
    ] {
        let error = GoCardlessError::from(GoCardlessApiError {
            status,
            headers: HashMap::new(),
            data: Some(json!({})),
        });
        assert_eq!(error.kind, kind, "{status}");
        assert_eq!(error.message, message, "{status}");
        covered.insert(name);
    }
    let expired = GoCardlessError::from(GoCardlessApiError {
        status: 401,
        headers: HashMap::new(),
        data: Some(json!({ "summary": "End User Agreement abc has expired" })),
    });
    assert_eq!(expired.kind, GoCardlessErrorKind::EndUserAgreementExpired);
    covered.insert("expired EUA");
    let unrelated = GoCardlessError::from(GoCardlessApiError {
        status: 401,
        headers: HashMap::new(),
        data: Some(json!({ "summary": "Authentication credentials were not provided." })),
    });
    assert_eq!(unrelated.kind, GoCardlessErrorKind::Client);
    covered.insert("unrelated 401");
    assert_eq!(covered, TS_CASES[18..29].iter().copied().collect());
}

#[tokio::test]
async fn maps_a_real_transport_failure_through_the_service_to_generic() {
    let app = TestApp::new();
    {
        let connection = app.connection();
        secrets_service::set(&connection, "gocardless_secretId", Some("secret-id"), None).unwrap();
        secrets_service::set(
            &connection,
            "gocardless_secretKey",
            Some("secret-key"),
            None,
        )
        .unwrap();
    }
    let mut api = GoCardlessApi::for_test(
        app.state.http.clone(),
        Url::parse("http://127.0.0.1:0/api/v2").unwrap(),
    );
    api.set_token(Some("header.eyJleHAiOjQxMDI0NDQ4MDB9.signature".to_owned()));
    let error = GoCardlessService::for_test(api)
        .get_institutions(&app.state, "IE")
        .await
        .unwrap_err();

    assert_eq!(TS_CASES[29], "non API error");
    assert_eq!(error.kind, GoCardlessErrorKind::Generic);
    assert_eq!(error.message, "GoCardless returned error");
    assert_eq!(error.details["response"]["status"], 0);
    assert_eq!(error.details["response"]["headers"], json!({}));
    assert!(
        error.details["response"]["data"]
            .as_str()
            .is_some_and(|message| !message.is_empty())
    );
}

#[tokio::test]
async fn preserves_javascript_number_array_and_nan_bodies_at_the_upstream_boundary() {
    let (app, service, fake) =
        harness_with_token(Some("header.eyJleHAiOjQxMDI0NDQ4MDB9.signature")).await;
    for (input, expected) in [
        (json!("not-a-number"), Value::Null),
        (json!(["90"]), json!(90)),
        (json!([null]), json!(0)),
        (json!([]), json!(0)),
    ] {
        fake.plan(
            Method::GET,
            "/api/v2/institutions/COERCION_BANK/",
            StatusCode::OK,
            json!({
                "id": "COERCION_BANK",
                "transaction_total_days": input,
                "max_access_valid_for_days": input
            }),
        );
        service
            .create_requisition(&app.state, "COERCION_BANK", "https://example.com")
            .await
            .unwrap();
        let body = fake
            .bodies(Method::POST, "/api/v2/agreements/enduser/")
            .pop()
            .unwrap();
        let fields = body.as_object().unwrap();
        assert!(fields.contains_key("max_historical_days"));
        assert!(fields.contains_key("access_valid_for_days"));
        assert_eq!(body["max_historical_days"], expected);
        assert_eq!(body["access_valid_for_days"], expected);
    }
}

#[tokio::test]
async fn injected_api_survives_credential_rotation_and_restoration() {
    let (app, service, fake) =
        harness_with_token(Some("header.eyJleHAiOjQxMDI0NDQ4MDB9.signature")).await;
    service.get_institutions(&app.state, "IE").await.unwrap();
    assert_eq!(fake.count(Method::POST, "/api/v2/token/new/"), 0);

    {
        let connection = app.connection();
        secrets_service::set(&connection, "gocardless_secretId", Some("rotated-id"), None).unwrap();
        secrets_service::set(
            &connection,
            "gocardless_secretKey",
            Some("rotated-key"),
            None,
        )
        .unwrap();
    }
    service.get_institutions(&app.state, "IE").await.unwrap();
    assert_eq!(
        fake.bodies(Method::POST, "/api/v2/token/new/")
            .last()
            .unwrap(),
        &json!({ "secret_id": "rotated-id", "secret_key": "rotated-key" })
    );

    {
        let connection = app.connection();
        secrets_service::set(&connection, "gocardless_secretId", Some("secret-id"), None).unwrap();
        secrets_service::set(
            &connection,
            "gocardless_secretKey",
            Some("secret-key"),
            None,
        )
        .unwrap();
    }
    service.get_institutions(&app.state, "IE").await.unwrap();
    assert_eq!(
        fake.count(Method::POST, "/api/v2/token/new/"),
        1,
        "restoring credentials reuses the original injected client and token"
    );
}

#[tokio::test]
async fn classifies_expired_eua_summaries_with_typescript_regex_ordering() {
    let (app, service, fake) =
        harness_with_token(Some("header.eyJleHAiOjQxMDI0NDQ4MDB9.signature")).await;
    for (summary, expected) in [
        (
            "END USER AGREEMENT abc EXPIRED",
            GoCardlessErrorKind::EndUserAgreementExpired,
        ),
        ("expired end user agreement", GoCardlessErrorKind::Client),
        (
            "end user agreement\nhas expired",
            GoCardlessErrorKind::Client,
        ),
        (
            "end user agreement\rhas expired",
            GoCardlessErrorKind::Client,
        ),
        (
            "end user agreement\u{2028}has expired",
            GoCardlessErrorKind::Client,
        ),
        (
            "end user agreement\u{2029}has expired",
            GoCardlessErrorKind::Client,
        ),
    ] {
        fake.plan(
            Method::GET,
            "/api/v2/institutions/?country=IE",
            StatusCode::UNAUTHORIZED,
            json!({ "summary": summary }),
        );
        assert_eq!(
            service
                .get_institutions(&app.state, "IE")
                .await
                .unwrap_err()
                .kind,
            expected,
            "{summary:?}"
        );
    }
}

#[tokio::test]
async fn refreshes_expired_or_malformed_tokens_and_preserves_a_valid_token() {
    for token in ["malformed", "header.eyJleHAiOjF9.signature"] {
        let (app, service, fake) = harness_with_token(Some(token)).await;
        service.get_institutions(&app.state, "IE").await.unwrap();
        assert_eq!(fake.count(Method::POST, "/api/v2/token/new/"), 1, "{token}");
    }
    let (app, service, fake) =
        harness_with_token(Some("header.eyJleHAiOjQxMDI0NDQ4MDB9.signature")).await;
    service.get_institutions(&app.state, "IE").await.unwrap();
    assert_eq!(fake.count(Method::POST, "/api/v2/token/new/"), 0);
}
