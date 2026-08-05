use std::net::{IpAddr, Ipv4Addr};

use axum::http::{Method, StatusCode};
use rusqlite::params;
use serde_json::json;

use super::router;
use crate::{account_db, test_support::TestApp};

#[tokio::test]
async fn config_is_rejected_after_an_owner_has_been_created() {
    let app = TestApp::new();
    app.create_user("named-owner", "named-owner", "ADMIN", true, true);
    account_db::bootstrap(
        &app.state.database,
        &json!({ "password": "bootstrap-password" }),
        &app.state.config.token_expiration,
    )
    .unwrap();
    app.connection()
        .execute(
            "INSERT INTO auth (method, display_name, extra_data, active) VALUES (?, ?, ?, ?)",
            params![
                "openid",
                "OpenID",
                json!({
                    "client_id": "client-id",
                    "client_secret": "client-secret",
                    "issuer": "https://issuer.example.com"
                })
                .to_string(),
                true
            ],
        )
        .unwrap();

    let response = app
        .send(
            router(),
            Method::POST,
            "/config",
            None,
            None,
            Some(json!({ "password": "bootstrap-password" })),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "already-bootstraped" })
    );
}

#[tokio::test]
async fn config_is_rate_limited_after_five_attempts_with_express_headers() {
    let app = TestApp::new();
    for remaining in (0..5).rev() {
        let response = app
            .send(
                router(),
                Method::POST,
                "/config",
                None,
                None,
                Some(json!({ "password": "wrong" })),
            )
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.headers["ratelimit-policy"], "5;w=900");
        assert_eq!(response.headers["ratelimit-limit"], "5");
        assert_eq!(
            response.headers["ratelimit-remaining"],
            remaining.to_string()
        );
        assert_eq!(response.headers["ratelimit-reset"], "900");
    }
    let response = app
        .send(
            router(),
            Method::POST,
            "/config",
            None,
            None,
            Some(json!({ "password": "wrong" })),
        )
        .await;
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.json(),
        json!({ "status": "error", "reason": "too-many-requests" })
    );
    assert_eq!(
        response.headers["content-type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(response.headers["ratelimit-policy"], "5;w=900");
    assert_eq!(response.headers["ratelimit-limit"], "5");
    assert_eq!(response.headers["ratelimit-remaining"], "0");
    assert_eq!(response.headers["ratelimit-reset"], "900");
    assert_eq!(response.headers["retry-after"], "900");
}

#[test]
fn config_rate_limit_starts_a_fresh_window_after_expiry() {
    let limiter = super::OpenIdConfigRateLimiter::default();
    let address = IpAddr::V4(Ipv4Addr::LOCALHOST);
    for _ in 0..super::CONFIG_RATE_LIMIT {
        limiter.check(address).unwrap();
    }

    limiter.expire(address);
    let (remaining, reset) = limiter.check(address).unwrap();

    assert_eq!(remaining, super::CONFIG_RATE_LIMIT - 1);
    assert!(reset <= super::CONFIG_RATE_WINDOW);
    assert!(reset > super::CONFIG_RATE_WINDOW - std::time::Duration::from_secs(1));
}

#[test]
fn config_rate_limit_groups_ipv6_clients_by_56_bit_subnet() {
    let limiter = super::OpenIdConfigRateLimiter::default();
    let first = "2001:db8:abcd:1200::1".parse().unwrap();
    let same_subnet = "2001:db8:abcd:12ff::2".parse().unwrap();
    let different_subnet = "2001:db8:abcd:1300::1".parse().unwrap();

    for _ in 0..super::CONFIG_RATE_LIMIT {
        limiter.check(first).unwrap();
    }
    assert!(limiter.check(same_subnet).is_err());
    assert_eq!(
        limiter.check(different_subnet).unwrap().0,
        super::CONFIG_RATE_LIMIT - 1
    );
}

#[test]
fn config_rate_limit_prunes_expired_client_entries() {
    let limiter = super::OpenIdConfigRateLimiter::default();
    let expired = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
    let active = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));
    {
        let mut entries = limiter.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.insert(expired, (1, std::time::Instant::now()));
        entries.insert(
            active,
            (1, std::time::Instant::now() + super::CONFIG_RATE_WINDOW),
        );
    }

    limiter
        .check(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 3)))
        .unwrap();
    let entries = limiter.0.lock().unwrap_or_else(|error| error.into_inner());
    assert!(!entries.contains_key(&expired));
    assert!(entries.contains_key(&active));
    assert_eq!(entries.len(), 2);
}
