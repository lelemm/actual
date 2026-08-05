use tokio::sync::oneshot;

use super::super::EnableBankingState;

#[test]
fn poll_timeout_configuration_matches_javascript_safe_integer_rules() {
    use std::time::Duration;

    for (configured, expected) in [
        (Some("1e3"), Duration::from_millis(1_000)),
        (Some(" \t\n"), Duration::ZERO),
        (Some("\u{FEFF}100"), Duration::from_millis(100)),
        (Some("-0"), Duration::ZERO),
        (Some("0x10"), Duration::from_millis(16)),
        (Some("0o10"), Duration::from_millis(8)),
        (Some("0b10"), Duration::from_millis(2)),
        (
            Some("9007199254740991"),
            Duration::from_millis(9_007_199_254_740_991),
        ),
        (None, super::super::DEFAULT_POLL_TIMEOUT),
        (Some("-1"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("1.5"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("NaN"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("Infinity"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("9007199254740992"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("not-a-number"), super::super::DEFAULT_POLL_TIMEOUT),
        (Some("\u{0085}100"), super::super::DEFAULT_POLL_TIMEOUT),
    ] {
        assert_eq!(super::super::parse_poll_timeout(configured), expected);
    }
}

#[test]
fn psu_headers_use_the_client_address_from_configured_proxies() {
    let mut app = crate::test_support::TestApp::new();
    std::sync::Arc::make_mut(&mut app.state.config).trusted_proxies = vec!["127.0.0.1/32".into()];
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-forwarded-for", "8.8.8.8".parse().unwrap());
    headers.insert("user-agent", "contract-agent".parse().unwrap());

    assert_eq!(
        super::super::psu_headers(&app.state, "127.0.0.1:1234".parse().unwrap(), &headers,),
        vec![
            ("Psu-Ip-Address", "8.8.8.8".into()),
            ("Psu-User-Agent", "contract-agent".into()),
        ]
    );
}

#[tokio::test]
async fn completion_is_cached_and_resolves_the_current_waiter() {
    let state = EnableBankingState::default();
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .unwrap()
        .insert("state".into(), (1, sender));
    state.complete(
        "state",
        serde_json::json!({ "session_id": "session" }),
        None,
    );
    assert_eq!(receiver.await.unwrap().unwrap()["session_id"], "session");
    assert_eq!(
        state.completed.lock().unwrap()["state"]["session_id"],
        "session"
    );
}

#[tokio::test]
async fn disconnected_http_poll_removes_its_pending_waiter() {
    let app = crate::test_support::TestApp::new();
    app.create_user("poll-user", "poll-user", "ADMIN", false, true);
    app.create_session("poll-user", "poll-token", None);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = app.state.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            super::super::router()
                .with_state(state)
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("http://{address}/poll-auth"))
            .header("x-actual-token", "poll-token")
            .json(&serde_json::json!({ "state": "disconnect-state" }))
            .send()
            .await
    });
    for _ in 0..100 {
        if app
            .state
            .enablebanking
            .pending
            .lock()
            .unwrap()
            .contains_key("disconnect-state")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        app.state
            .enablebanking
            .pending
            .lock()
            .unwrap()
            .contains_key("disconnect-state")
    );
    let aborted_at = std::time::Instant::now();
    request.abort();
    for _ in 0..100 {
        if !app
            .state
            .enablebanking
            .pending
            .lock()
            .unwrap()
            .contains_key("disconnect-state")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        !app.state
            .enablebanking
            .pending
            .lock()
            .unwrap()
            .contains_key("disconnect-state")
    );
    assert!(aborted_at.elapsed() < super::super::POLL_TIMEOUT);
    server.abort();
}

#[tokio::test]
async fn pending_http_poll_returns_the_timeout_error() {
    let app = crate::test_support::TestApp::new();
    app.create_user("timeout-user", "timeout-user", "ADMIN", false, true);
    app.create_session("timeout-user", "timeout-token", None);
    let started_at = std::time::Instant::now();
    let response = app
        .send(
            super::super::router(),
            axum::http::Method::POST,
            "/poll-auth",
            Some("timeout-token"),
            None,
            Some(serde_json::json!({ "state": "timeout-state" })),
        )
        .await;
    assert!(started_at.elapsed() >= super::super::POLL_TIMEOUT);
    assert_eq!(
        response.json(),
        serde_json::json!({ "status": "ok", "data": { "error": "Polling timed out" } })
    );
    assert!(
        !app.state
            .enablebanking
            .pending
            .lock()
            .unwrap()
            .contains_key("timeout-state")
    );
}
