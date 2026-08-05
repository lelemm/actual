use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use reqwest::Url;
use serde_json::{Value, json};

use crate::{
    app::AppState,
    util::{
        http::with_node_extra_ca,
        ssrf::is_blocked_ip,
        validate_user::{SessionError, client_ip, validate_session},
    },
};

const ALLOWLIST_URL: &str =
    "https://raw.githubusercontent.com/actualbudget/plugin-store/refs/heads/main/plugins.json";
const ALLOWLIST_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const RATE_LIMIT: u64 = 25;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 20;

#[derive(Clone)]
pub struct CorsProxyState {
    allowlist: Arc<Mutex<AllowlistCache>>,
    rate_limits: Arc<Mutex<HashMap<IpAddr, RateEntry>>>,
    http: reqwest::Client,
}

struct AllowlistCache {
    repositories: Vec<String>,
    last_fetch: Option<Instant>,
}

struct RateEntry {
    count: u64,
    reset: Instant,
}

struct RateAttempt {
    remaining: u64,
    reset_after: Duration,
}

impl CorsProxyState {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            allowlist: Arc::new(Mutex::new(AllowlistCache {
                repositories: Vec::new(),
                last_fetch: None,
            })),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            http: direct_client_builder()
                .redirect(reqwest::redirect::Policy::limited(20))
                .build()
                .map_err(|error| error.to_string())?,
        })
    }

    fn begin(&self, address: IpAddr) -> Result<RateAttempt, Response> {
        let now = Instant::now();
        let mut entries = self
            .rate_limits
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let entry = entries.entry(address).or_insert_with(|| RateEntry {
            count: 0,
            reset: now + RATE_WINDOW,
        });
        if now >= entry.reset {
            entry.count = 0;
            entry.reset = now + RATE_WINDOW;
        }
        entry.count += 1;
        let attempt = RateAttempt {
            remaining: RATE_LIMIT.saturating_sub(entry.count),
            reset_after: entry.reset.saturating_duration_since(now),
        };
        if entry.count > RATE_LIMIT {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests, please try again later.",
            )
                .into_response();
            add_rate_headers(&mut response, &attempt, true);
            return Err(response);
        }
        Ok(attempt)
    }

    async fn fetch_allowlist(&self) -> Vec<String> {
        {
            let cache = self
                .allowlist
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !cache.repositories.is_empty()
                && cache
                    .last_fetch
                    .is_some_and(|last_fetch| last_fetch.elapsed() < ALLOWLIST_CACHE_TTL)
            {
                return cache.repositories.clone();
            }
        }
        let allowlist_url =
            std::env::var("CORS_PROXY_ALLOWLIST_URL").unwrap_or_else(|_| ALLOWLIST_URL.into());
        let repositories = match self.http.get(allowlist_url).send().await {
            Ok(response) if response.status().is_success() => response
                .json::<Vec<Value>>()
                .await
                .ok()
                .map(|plugins| {
                    plugins
                        .into_iter()
                        .filter_map(|plugin| plugin.get("url")?.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut cache = self
            .allowlist
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.repositories.clone_from(&repositories);
        cache.last_fetch = (!repositories.is_empty()).then(Instant::now);
        repositories
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/", any(proxy))
}

async fn proxy(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<Value>>,
) -> Response {
    let address = client_ip(peer, &headers, &state.config.trusted_proxies).unwrap_or(peer.ip());
    let attempt = match state.cors_proxy.begin(address) {
        Ok(attempt) => attempt,
        Err(response) => return response,
    };
    let mut response = proxy_inner(state, method, headers, query, body).await;
    add_rate_headers(&mut response, &attempt, false);
    response
}

async fn proxy_inner(
    state: AppState,
    method: Method,
    headers: HeaderMap,
    query: HashMap<String, String>,
    body: Option<Json<Value>>,
) -> Response {
    if method == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET,HEAD,PUT,PATCH,POST,DELETE"),
        );
        return response;
    }
    let Some(target) = query.get("url").filter(|target| !target.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing url parameter" })),
        )
            .into_response();
    };
    let body = body.map(|body| body.0).unwrap_or_else(|| json!({}));
    let body_token = body
        .get("token")
        .filter(|value| javascript_truthy(value))
        .and_then(Value::as_str);
    if let Err(error) = validate_session(&state.database, &headers, body_token) {
        return session_error(error);
    }
    let url = match Url::parse(target) {
        Ok(url) => url,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid url parameter" })),
            )
                .into_response();
        }
    };
    let allowlist = state.cors_proxy.fetch_allowlist().await;
    let is_development = state.config.environment == "development";
    if !is_url_allowed(&url, &allowlist, is_development) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "URL not allowed",
                "message": "Only allowlisted plugin repositories are allowed (localhost only in development)"
            })),
        )
            .into_response();
    }
    let proxy_method = match body.get("method") {
        None => Method::GET,
        Some(Value::String(method)) => match method.to_uppercase().as_str() {
            "GET" => Method::GET,
            "HEAD" => Method::HEAD,
            _ => {
                return (
                    StatusCode::METHOD_NOT_ALLOWED,
                    Json(json!({ "error": "Method not allowed" })),
                )
                    .into_response();
            }
        },
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid method parameter" })),
            )
                .into_response();
        }
    };
    let mut outgoing_headers = headers;
    if let Some(custom) = body.get("headers").and_then(Value::as_object) {
        for (name, value) in custom {
            let name = match HeaderName::try_from(name) {
                Ok(name) => name,
                Err(error) => return proxy_error(error.to_string()),
            };
            let value = match HeaderValue::try_from(javascript_string(value)) {
                Ok(value) => value,
                Err(error) => return proxy_error(error.to_string()),
            };
            outgoing_headers.insert(name, value);
        }
    }
    for name in [
        "x-actual-token",
        "content-length",
        "cookie",
        "cookie2",
        "host",
    ] {
        outgoing_headers.remove(name);
    }
    let host = url.port().map_or_else(
        || url.host_str().unwrap_or_default().to_owned(),
        |port| format!("{}:{port}", url.host_str().unwrap_or_default()),
    );
    if let Ok(host) = HeaderValue::try_from(host) {
        outgoing_headers.insert("host", host);
    }
    add_github_auth(&mut outgoing_headers, &state.config.github.token, &url);
    let test_allowed_origin = is_development
        .then(|| std::env::var("CORS_PROXY_TEST_ALLOWED_ORIGIN").ok())
        .flatten();
    let upstream = match send_upstream(
        proxy_method,
        url.clone(),
        outgoing_headers,
        test_allowed_origin.as_deref(),
    )
    .await
    {
        Ok(response) => response,
        Err(UpstreamError::Blocked) => return url_not_allowed(),
        Err(UpstreamError::Request(error)) => return proxy_error(error),
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let target_lower = url.as_str().to_lowercase();
    let likely_json = content_type.contains("application/json")
        || target_lower.contains(".json")
        || target_lower.contains("/manifest")
        || target_lower.contains("manifest.json")
        || target_lower.contains("package.json");
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "Error proxying request",
                    "details": error.to_string()
                })),
            )
                .into_response();
        }
    };
    let parsed_json = likely_json
        .then(|| serde_json::from_slice::<Value>(&bytes).ok())
        .flatten();
    let mut response = if let Some(json) = parsed_json.clone() {
        (status, Json(json)).into_response()
    } else if likely_json || content_type.contains("text/") {
        (status, Body::from(bytes.clone())).into_response()
    } else {
        (
            status,
            Json(json!({
                "data": bytes.to_vec(),
                "contentType": content_type,
                "isBinary": true
            })),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert("access-control-allow-origin", HeaderValue::from_static("*"));
    let response_content_type = if parsed_json.is_some() {
        "application/json"
    } else if likely_json || content_type.contains("text/") {
        &content_type
    } else {
        "application/json"
    };
    if let Ok(value) = HeaderValue::try_from(response_content_type) {
        response.headers_mut().insert("content-type", value);
    }
    response
}

#[derive(Debug)]
enum UpstreamError {
    Blocked,
    Request(String),
}

async fn send_upstream(
    method: Method,
    mut url: Url,
    mut headers: HeaderMap,
    test_allowed_origin: Option<&str>,
) -> Result<reqwest::Response, UpstreamError> {
    for redirects in 0..=MAX_REDIRECTS {
        set_host_header(&mut headers, &url);
        let client = client_for_url(&url, test_allowed_origin).await?;
        let response = client
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            .send()
            .await
            .map_err(|error| UpstreamError::Request(error.to_string()))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if redirects == MAX_REDIRECTS {
            return Err(UpstreamError::Request("redirect limit exceeded".into()));
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| UpstreamError::Request("redirect missing location".into()))?;
        let next = url
            .join(location)
            .map_err(|error| UpstreamError::Request(error.to_string()))?;
        if url.origin() != next.origin() {
            headers.remove("authorization");
        }
        url = next;
    }
    unreachable!("redirect loop returns at the configured limit")
}

async fn client_for_url(
    url: &Url,
    test_allowed_origin: Option<&str>,
) -> Result<reqwest::Client, UpstreamError> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(UpstreamError::Blocked);
    }
    let hostname = url
        .host_str()
        .ok_or(UpstreamError::Blocked)?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let port = url.port_or_known_default().ok_or(UpstreamError::Blocked)?;
    let addresses = if let Ok(address) = hostname.parse::<IpAddr>() {
        vec![SocketAddr::new(address, port)]
    } else {
        tokio::net::lookup_host((hostname, port))
            .await
            .map_err(|error| UpstreamError::Request(error.to_string()))?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(UpstreamError::Request(format!(
            "Unable to resolve host: {hostname}"
        )));
    }
    let is_test_origin = test_allowed_origin == Some(url.origin().ascii_serialization().as_str());
    if !is_test_origin
        && addresses
            .iter()
            .any(|address| is_blocked_ip(address.ip(), false))
    {
        return Err(UpstreamError::Blocked);
    }
    let mut builder = direct_client_builder().redirect(reqwest::redirect::Policy::none());
    if hostname.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(hostname, &addresses);
    }
    builder
        .build()
        .map_err(|error| UpstreamError::Request(error.to_string()))
}

fn direct_client_builder() -> reqwest::ClientBuilder {
    with_node_extra_ca(reqwest::Client::builder())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
}

fn set_host_header(headers: &mut HeaderMap, url: &Url) {
    headers.remove("host");
    let host = url.port().map_or_else(
        || url.host_str().unwrap_or_default().to_owned(),
        |port| format!("{}:{port}", url.host_str().unwrap_or_default()),
    );
    if let Ok(host) = HeaderValue::try_from(host) {
        headers.insert("host", host);
    }
}

fn url_not_allowed() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "URL not allowed",
            "message": "Only allowlisted plugin repositories are allowed (localhost only in development)"
        })),
    )
        .into_response()
}

fn proxy_error(details: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "error": "Error proxying request",
            "details": details
        })),
    )
        .into_response()
}

fn is_url_allowed(url: &Url, allowlist: &[String], is_development: bool) -> bool {
    let Some(hostname) = url.host_str() else {
        return false;
    };
    let test_allowed_origin = std::env::var("CORS_PROXY_TEST_ALLOWED_ORIGIN").ok();
    if hostname
        .parse()
        .is_ok_and(|address| is_blocked_ip(address, false))
        && (!is_development
            || test_allowed_origin.as_deref() != Some(url.origin().ascii_serialization().as_str()))
    {
        return false;
    }
    if url.as_str() == ALLOWLIST_URL {
        return true;
    }
    allowlist.iter().any(|repository| {
        if url.as_str() == repository || url.as_str().starts_with(&format!("{repository}/")) {
            return true;
        }
        let Ok(repository_url) = Url::parse(repository) else {
            return false;
        };
        let mut segments = repository_url.path_segments().into_iter().flatten();
        let (Some(owner), Some(repository_name)) = (segments.next(), segments.next()) else {
            return false;
        };
        (hostname == "api.github.com"
            && (url.path() == format!("/repos/{owner}/{repository_name}")
                || url
                    .path()
                    .starts_with(&format!("/repos/{owner}/{repository_name}/"))))
            || (hostname == "raw.githubusercontent.com"
                && url
                    .path()
                    .starts_with(&format!("/{owner}/{repository_name}/")))
            || (hostname == "github.com"
                && url
                    .path()
                    .starts_with(&format!("/{owner}/{repository_name}/releases/")))
    })
}

fn is_github_download(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("api.github.com" | "raw.githubusercontent.com")
    ) || (url.host_str() == Some("github.com") && url.path().contains("/releases/"))
}

fn add_github_auth(headers: &mut HeaderMap, token: &str, url: &Url) {
    if !token.is_empty() && is_github_download(url) {
        headers.insert(
            "authorization",
            HeaderValue::try_from(format!("Bearer {token}")).unwrap(),
        );
        headers.insert(
            "user-agent",
            HeaderValue::from_static("Actual-Budget-Plugin-System"),
        );
    }
}

fn add_rate_headers(response: &mut Response, attempt: &RateAttempt, retry_after: bool) {
    let reset = attempt
        .reset_after
        .as_secs()
        .saturating_add(u64::from(attempt.reset_after.subsec_nanos() != 0))
        .max(1);
    let headers = response.headers_mut();
    headers.insert("ratelimit-policy", HeaderValue::from_static("25;w=60"));
    headers.insert("ratelimit-limit", HeaderValue::from_static("25"));
    headers.insert(
        "ratelimit-remaining",
        HeaderValue::try_from(attempt.remaining.to_string()).unwrap(),
    );
    headers.insert(
        "ratelimit-reset",
        HeaderValue::try_from(reset.to_string()).unwrap(),
    );
    if retry_after {
        headers.insert(
            "retry-after",
            HeaderValue::try_from(reset.to_string()).unwrap(),
        );
    }
}

fn session_error(error: SessionError) -> Response {
    match error {
        SessionError::TokenNotFound => (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "status": "error",
                "reason": "unauthorized",
                "details": "token-not-found"
            })),
        )
            .into_response(),
        SessionError::TokenExpired => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "status": "error", "reason": "token-expired" })),
        )
            .into_response(),
        SessionError::Database(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "reason": "internal-error" })),
        )
            .into_response(),
    }
}

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn javascript_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(javascript_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::{net::Ipv4Addr, sync::Arc};

    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use tower::ServiceExt;

    use super::*;
    use crate::test_support::TestApp;

    #[test]
    fn matches_repository_allowlist_variants_without_prefix_confusion() {
        let allowlist = vec!["https://github.com/user/repo1".into()];
        for allowed in [
            "https://github.com/user/repo1",
            "https://github.com/user/repo1/releases/download/v1/file.zip",
            "https://api.github.com/repos/user/repo1",
            "https://api.github.com/repos/user/repo1/releases",
            "https://raw.githubusercontent.com/user/repo1/main/file.txt",
        ] {
            assert!(is_url_allowed(
                &Url::parse(allowed).unwrap(),
                &allowlist,
                false
            ));
        }
        assert!(!is_url_allowed(
            &Url::parse("https://api.github.com/repos/user/repo1-private/contents/.env").unwrap(),
            &allowlist,
            false
        ));
        assert!(is_url_allowed(
            &Url::parse("https://plugins.example/repo/file.json").unwrap(),
            &["https://plugins.example/repo".into()],
            false
        ));
        assert!(!is_url_allowed(
            &Url::parse("http://127.0.0.1/repo/file.json").unwrap(),
            &["http://127.0.0.1/repo".into()],
            false
        ));
        assert!(!is_url_allowed(
            &Url::parse("https://objects.githubusercontent.com/asset.zip").unwrap(),
            &allowlist,
            false
        ));
    }

    #[test]
    fn adds_github_auth_only_for_supported_github_downloads() {
        let mut headers = HeaderMap::new();
        add_github_auth(
            &mut headers,
            "github-token",
            &Url::parse("https://api.github.com/repos/user/repo").unwrap(),
        );
        assert_eq!(headers.get("authorization").unwrap(), "Bearer github-token");
        assert_eq!(
            headers.get("user-agent").unwrap(),
            "Actual-Budget-Plugin-System"
        );

        let mut headers = HeaderMap::new();
        add_github_auth(
            &mut headers,
            "github-token",
            &Url::parse("https://example.com/repo").unwrap(),
        );
        assert!(headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn blocks_unsafe_schemes_userinfo_literals_and_dns_destinations() {
        for target in [
            "file:///etc/passwd",
            "http://user@example.com/repo",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::ffff:127.0.0.1]/private",
            "http://localhost/private",
        ] {
            assert!(matches!(
                client_for_url(&Url::parse(target).unwrap(), None).await,
                Err(UpstreamError::Blocked)
            ));
        }
    }

    #[tokio::test]
    async fn follows_a_safe_redirect_outside_the_initial_repository_path() {
        let app = Router::new()
            .route(
                "/repo/release",
                axum::routing::get(|| async {
                    (StatusCode::FOUND, [("location", "/download/asset.zip")])
                }),
            )
            .route(
                "/download/asset.zip",
                axum::routing::get(|| async { "release asset" }),
            );
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let response = send_upstream(
            Method::GET,
            Url::parse(&format!("{origin}/repo/release")).unwrap(),
            HeaderMap::new(),
            Some(&origin),
        )
        .await
        .unwrap();
        assert_eq!(response.text().await.unwrap(), "release asset");
        server.abort();
    }

    #[test]
    fn rate_limit_is_atomic_and_resets_after_its_window() {
        let state = Arc::new(CorsProxyState::new().unwrap());
        let address = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 10));
        let attempts = (0..26)
            .map(|_| {
                let state = Arc::clone(&state);
                std::thread::spawn(move || state.begin(address).is_ok())
            })
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(attempts.iter().filter(|allowed| **allowed).count(), 25);

        state
            .rate_limits
            .lock()
            .unwrap()
            .get_mut(&address)
            .unwrap()
            .reset = Instant::now() - Duration::from_secs(1);
        assert_eq!(state.begin(address).unwrap().remaining, 24);
    }

    #[test]
    fn rate_limit_headers_round_reset_up_to_the_next_second() {
        let mut response = StatusCode::OK.into_response();
        add_rate_headers(
            &mut response,
            &RateAttempt {
                remaining: 1,
                reset_after: Duration::from_millis(1_001),
            },
            true,
        );
        assert_eq!(response.headers()["ratelimit-reset"], "2");
        assert_eq!(response.headers()["retry-after"], "2");
    }

    #[tokio::test]
    async fn app_mounts_the_proxy_only_when_enabled() {
        async fn status(app: &TestApp) -> StatusCode {
            let mut request = Request::builder()
                .uri("/cors-proxy")
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 12345))));
            crate::app::router(app.state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status()
        }

        let disabled = TestApp::new();
        assert_eq!(status(&disabled).await, StatusCode::NOT_FOUND);

        let mut enabled = TestApp::new();
        Arc::make_mut(&mut enabled.state.config).cors_proxy.enabled = true;
        Arc::make_mut(&mut enabled.state.config).environment = "development".into();
        assert_eq!(status(&enabled).await, StatusCode::BAD_REQUEST);
    }
}
