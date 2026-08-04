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
        ssrf::is_blocked_ip,
        validate_user::{SessionError, validate_session},
    },
};

const ALLOWLIST_URL: &str =
    "https://raw.githubusercontent.com/actualbudget/plugin-store/refs/heads/main/plugins.json";
const ALLOWLIST_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const RATE_LIMIT: u64 = 25;
const RATE_WINDOW: Duration = Duration::from_secs(60);

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
            http: reqwest::Client::builder()
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
    let attempt = match state.cors_proxy.begin(peer.ip()) {
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
    let Some(target) = query.get("url") else {
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
    if !is_url_allowed(&url, &allowlist) {
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
            if let (Ok(name), Ok(value)) = (
                HeaderName::try_from(name),
                HeaderValue::try_from(javascript_string(value)),
            ) {
                outgoing_headers.insert(name, value);
            }
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
    if !state.config.github.token.is_empty() && is_github_download(&url) {
        outgoing_headers.insert(
            "authorization",
            HeaderValue::try_from(format!("Bearer {}", state.config.github.token)).unwrap(),
        );
        outgoing_headers.insert(
            "user-agent",
            HeaderValue::from_static("Actual-Budget-Plugin-System"),
        );
    }
    let upstream = match state
        .cors_proxy
        .http
        .request(proxy_method, url.clone())
        .headers(outgoing_headers)
        .send()
        .await
    {
        Ok(response) => response,
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

fn is_url_allowed(url: &Url, allowlist: &[String]) -> bool {
    let Some(hostname) = url.host_str() else {
        return false;
    };
    let test_allowed_origin = std::env::var("CORS_PROXY_TEST_ALLOWED_ORIGIN").ok();
    if hostname
        .parse()
        .is_ok_and(|address| is_blocked_ip(address, false))
        && test_allowed_origin.as_deref() != Some(url.origin().ascii_serialization().as_str())
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

fn add_rate_headers(response: &mut Response, attempt: &RateAttempt, retry_after: bool) {
    let reset = attempt.reset_after.as_secs().max(1);
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
    use super::*;

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
            assert!(is_url_allowed(&Url::parse(allowed).unwrap(), &allowlist));
        }
        assert!(!is_url_allowed(
            &Url::parse("https://api.github.com/repos/user/repo1-private/contents/.env").unwrap(),
            &allowlist
        ));
        assert!(is_url_allowed(
            &Url::parse("https://plugins.example/repo/file.json").unwrap(),
            &["https://plugins.example/repo".into()]
        ));
    }
}
