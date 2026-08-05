use std::{
    collections::HashMap,
    future::{Future, ready},
    io::{self, Cursor, Write},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
use axum::{
    Json, Router, ServiceExt,
    body::{Body, to_bytes},
    extract::{
        DefaultBodyLimit, FromRequestParts, OriginalUri, State, WebSocketUpgrade, ws::Message,
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader},
    net::TcpListener,
};
use tokio_tungstenite::{
    WebSocketStream, connect_async,
    tungstenite::{self, client::IntoClientRequest},
};
use tokio_util::io::StreamReader;
use tower::ServiceExt as TowerServiceExt;
use tower_http::{
    normalize_path::NormalizePath,
    services::{ServeDir, ServeFile},
};

use crate::{
    app_account, app_admin, app_akahu, app_cors_proxy, app_enablebanking, app_gocardless,
    app_openid, app_pluggyai, app_secrets, app_simplefin, app_sync,
    db::{Database, open_database},
    load_config::Config,
    migrations,
    util::{http::with_node_extra_ca, validate_user::client_ip},
};

const GLOBAL_RATE_LIMIT: u64 = 500;
const GLOBAL_RATE_WINDOW: Duration = Duration::from_secs(60);
const COMPRESSED_BODY_OVERHEAD: usize = 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
    pub auth_rate_limiter: app_account::AuthRateLimiter,
    pub openid_config_rate_limiter: app_openid::OpenIdConfigRateLimiter,
    pub gocardless: app_gocardless::services::gocardless_service::GoCardlessService,
    pub pluggyai: app_pluggyai::pluggyai_service::PluggyAiService,
    pub akahu_refresh: Arc<tokio::sync::Mutex<()>>,
    pub cors_proxy: app_cors_proxy::CorsProxyState,
    pub enablebanking: app_enablebanking::EnableBankingState,
    pub started_at: Instant,
    pub global_rate_limiter: GlobalRateLimiter,
}

#[derive(Clone, Default)]
pub struct GlobalRateLimiter {
    entries: Arc<Mutex<HashMap<IpAddr, GlobalRateEntry>>>,
}

struct GlobalRateEntry {
    count: u64,
    reset: Instant,
}

struct GlobalRateAttempt {
    remaining: u64,
    reset_after: Duration,
}

impl GlobalRateLimiter {
    fn begin(&self, address: IpAddr) -> Result<GlobalRateAttempt, Response> {
        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let entry = entries.entry(address).or_insert_with(|| GlobalRateEntry {
            count: 0,
            reset: now + GLOBAL_RATE_WINDOW,
        });
        if now >= entry.reset {
            entry.count = 0;
            entry.reset = now + GLOBAL_RATE_WINDOW;
        }
        entry.count += 1;
        let attempt = GlobalRateAttempt {
            remaining: GLOBAL_RATE_LIMIT.saturating_sub(entry.count),
            reset_after: entry.reset.saturating_duration_since(now),
        };
        if entry.count > GLOBAL_RATE_LIMIT {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests, please try again later.",
            )
                .into_response();
            add_global_rate_headers(&mut response, &attempt, true);
            return Err(response);
        }
        Ok(attempt)
    }
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

#[derive(Serialize)]
struct BuildInfo {
    build: Build,
}

#[derive(Serialize)]
struct Build {
    name: &'static str,
    description: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUsage {
    rss: u64,
    heap_total: u64,
    heap_used: u64,
    external: u64,
    array_buffers: u64,
}

#[derive(Serialize)]
struct Metrics {
    mem: MemoryUsage,
    uptime: f64,
}

pub fn router(state: AppState) -> Router {
    let general_limit = state.config.upload.file_size_limit_mb;
    let mut router = Router::new()
        .route("/health", get(|| async { Json(Health { status: "UP" }) }))
        .route(
            "/mode",
            get({
                let mode = state.config.mode.clone();
                move || async move { Html(mode) }
            }),
        )
        .route(
            "/metrics",
            get({
                let started_at = state.started_at;
                move || async move { metrics_response(started_at) }
            }),
        )
        .route(
            "/info",
            get(|| async {
                Json(BuildInfo {
                    build: Build {
                        name: "@actual-app/sync-server",
                        description: "actual syncing server",
                        version: env!("CARGO_PKG_VERSION"),
                    },
                })
            }),
        )
        .nest("/account", limited(app_account::router(), general_limit))
        .nest("/admin", limited(app_admin::router(), general_limit))
        .nest(
            "/akahu",
            limited(app_akahu::router(general_limit), general_limit),
        )
        .nest(
            "/enablebanking",
            limited(app_enablebanking::router(), general_limit),
        )
        .nest(
            "/gocardless",
            limited(
                app_gocardless::app_gocardless::router(state.clone()),
                general_limit,
            ),
        )
        .nest("/openid", limited(app_openid::router(), general_limit))
        .nest(
            "/pluggyai",
            limited(app_pluggyai::app_pluggyai::router(), general_limit),
        )
        .nest("/secret", limited(app_secrets::router(), general_limit))
        .nest(
            "/simplefin",
            limited(app_simplefin::app_simplefin::router(), general_limit),
        )
        .nest(
            "/sync",
            app_sync::router(
                state.config.upload.file_size_limit_mb,
                state.config.upload.file_size_sync_limit_mb,
                state.config.upload.sync_encrypted_file_size_limit_mb,
            ),
        );
    if state.config.cors_proxy.enabled {
        router = router.nest(
            "/cors-proxy",
            limited(app_cors_proxy::router(), general_limit),
        );
    }
    if state.config.environment == "development" {
        router = router.fallback(dev_proxy);
        router = router.layer(middleware::from_fn_with_state(
            state.clone(),
            parse_request_body,
        ));
    } else {
        router = router.fallback(production_frontend);
        router = router.layer(middleware::from_fn_with_state(
            state.clone(),
            parse_request_body,
        ));
        router = router.layer(middleware::from_fn_with_state(
            state.clone(),
            global_rate_limit,
        ));
    }
    router
        .layer(middleware::from_fn(express_content_type))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

fn limited(router: Router<AppState>, megabytes: u64) -> Router<AppState> {
    let bytes = megabytes.saturating_mul(1024 * 1024).min(usize::MAX as u64) as usize;
    router.layer(DefaultBodyLimit::max(bytes))
}

pub(crate) fn has_content_type(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
}

async fn parse_request_body(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let (megabytes, validate_json) = if has_content_type(request.headers(), "application/json") {
        (state.config.upload.file_size_limit_mb, true)
    } else if has_content_type(request.headers(), "application/actual-sync") {
        (state.config.upload.file_size_sync_limit_mb, false)
    } else if has_content_type(request.headers(), "application/encrypted-file") {
        (state.config.upload.sync_encrypted_file_size_limit_mb, false)
    } else {
        return next.run(request).await;
    };
    let limit = megabytes.saturating_mul(1024 * 1024).min(usize::MAX as u64) as usize;
    let (mut parts, body) = request.into_parts();
    let encoding = parts
        .headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("identity")
        .to_ascii_lowercase();
    let body = match decode_request_body(body, &encoding, limit).await {
        Ok(body) => body,
        Err((status, message)) => return express_body_error(status, message),
    };
    parts.headers.remove(header::CONTENT_ENCODING);
    parts.headers.remove(header::CONTENT_LENGTH);
    if validate_json && !body.is_empty() {
        let first = body
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace());
        if !matches!(first, Some(b'{') | Some(b'['))
            || serde_json::from_slice::<serde_json::Value>(&body).is_err()
        {
            return express_body_error(StatusCode::BAD_REQUEST, "Unexpected token in JSON");
        }
    }
    next.run(Request::from_parts(parts, Body::from(body))).await
}

async fn decode_request_body(
    body: Body,
    encoding: &str,
    limit: usize,
) -> Result<Vec<u8>, (StatusCode, &'static str)> {
    let encoded_limit = if encoding == "identity" {
        limit
    } else {
        limit.saturating_add(COMPRESSED_BODY_OVERHEAD)
    };
    let stream = body.into_data_stream().map_err(io::Error::other).scan(
        (0usize, false),
        move |(seen, stopped), item| {
            let result = if *stopped {
                None
            } else {
                match item {
                    Ok(bytes) if bytes.len() <= encoded_limit.saturating_sub(*seen) => {
                        *seen += bytes.len();
                        Some(Ok(bytes))
                    }
                    Ok(_) => {
                        *stopped = true;
                        Some(Err(io::Error::other(EncodedBodyTooLarge)))
                    }
                    Err(error) => {
                        *stopped = true;
                        Some(Err(error))
                    }
                }
            };
            ready(result)
        },
    );
    let reader = BufReader::new(StreamReader::new(stream));
    let reader: Pin<Box<dyn AsyncRead + Send>> = match encoding {
        "identity" => Box::pin(reader),
        "gzip" | "x-gzip" => Box::pin(GzipDecoder::new(reader)),
        "deflate" => Box::pin(ZlibDecoder::new(reader)),
        "br" => Box::pin(BrotliDecoder::new(reader)),
        _ => {
            return Err((
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported content encoding",
            ));
        }
    };
    let mut decoded = Vec::new();
    let read = reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut decoded)
        .await;
    if let Err(error) = read {
        if error
            .get_ref()
            .is_some_and(|error| error.is::<EncodedBodyTooLarge>())
        {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "request entity too large"));
        }
        return Err((StatusCode::BAD_REQUEST, "invalid compressed body"));
    }
    if decoded.len() > limit {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "request entity too large"));
    }
    Ok(decoded)
}

#[derive(Debug)]
struct EncodedBodyTooLarge;

impl std::fmt::Display for EncodedBodyTooLarge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("encoded request entity too large")
    }
}

impl std::error::Error for EncodedBodyTooLarge {}

fn express_body_error(status: StatusCode, message: &str) -> Response {
    let mut response = (
        status,
        Html(format!(
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{message}</pre>\n</body>\n</html>\n"
        )),
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn express_content_type(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let replacement = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| match value.as_bytes() {
            b"application/json" => {
                Some(HeaderValue::from_static("application/json; charset=utf-8"))
            }
            b"text/html" => Some(HeaderValue::from_static("text/html; charset=utf-8")),
            _ => None,
        });
    if let Some(replacement) = replacement {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, replacement);
    }
    response
}

pub async fn run(config: Config) -> std::io::Result<()> {
    run_with_ready(config, notify_started).await
}

pub async fn run_with_ready<F>(config: Config, notify_ready: F) -> std::io::Result<()>
where
    F: FnOnce(&Config) -> std::io::Result<()>,
{
    run_with_ready_and_shutdown(config, notify_ready, shutdown()).await
}

pub async fn run_with_ready_and_shutdown<F, S>(
    config: Config,
    notify_ready: F,
    shutdown: S,
) -> std::io::Result<()>
where
    F: FnOnce(&Config) -> std::io::Result<()>,
    S: Future<Output = ()> + Send + 'static,
{
    migrations::run(&config).map_err(|error| std::io::Error::other(error.to_string()))?;
    let database = Arc::new(Mutex::new(
        open_database(&config.server_files.join("account.sqlite"))
            .map_err(std::io::Error::other)?,
    ));
    let http = with_node_extra_ca(reqwest::Client::builder())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(std::io::Error::other)?;
    let state = AppState {
        database,
        config: Arc::new(config),
        http,
        auth_rate_limiter: app_account::AuthRateLimiter::default(),
        openid_config_rate_limiter: app_openid::OpenIdConfigRateLimiter::default(),
        gocardless: app_gocardless::services::gocardless_service::GoCardlessService::default(),
        pluggyai: app_pluggyai::pluggyai_service::PluggyAiService::default(),
        akahu_refresh: Arc::new(tokio::sync::Mutex::new(())),
        cors_proxy: app_cors_proxy::CorsProxyState::new().map_err(std::io::Error::other)?,
        enablebanking: app_enablebanking::EnableBankingState::default(),
        started_at: Instant::now(),
        global_rate_limiter: GlobalRateLimiter::default(),
    };
    bootstrap_openid(&state).await;
    let address = state.config.address;
    let https = state.config.https.clone();
    let service = ServiceExt::<Request<Body>>::into_make_service_with_connect_info::<SocketAddr>(
        NormalizePath::trim_trailing_slash(router(state.clone())),
    );
    if !https.key.is_empty() && !https.cert.is_empty() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = tls_config(&https)?;
        let listener = std::net::TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        notify_ready(&state.config)?;
        let handle = axum_server::Handle::new();
        let shutdown_handle = handle.clone();
        tokio::spawn(async move {
            shutdown.await;
            shutdown_handle.graceful_shutdown(None);
        });
        axum_server::from_tcp_rustls(listener, tls)?
            .handle(handle)
            .serve(service)
            .await
    } else {
        let listener = TcpListener::bind(address).await?;
        notify_ready(&state.config)?;
        axum::serve(listener, service)
            .with_graceful_shutdown(shutdown)
            .await
    }
}

fn notify_started(config: &Config) -> std::io::Result<()> {
    if let Some(port) = std::env::var_os("ACTUAL_SERVER_READY_PORT") {
        let port = port
            .to_string_lossy()
            .parse::<u16>()
            .map_err(|_| std::io::Error::other("invalid ACTUAL_SERVER_READY_PORT"))?;
        let mut channel = std::net::TcpStream::connect(("127.0.0.1", port))?;
        channel.write_all(b"{\"type\":\"server-started\"}\n")?;
        channel.flush()?;
    }
    println!("Listening on {}:{}...", config.hostname, config.port);
    Ok(())
}

async fn bootstrap_openid(state: &AppState) {
    let open_id = &state.config.open_id;
    if open_id.discovery_url.is_empty() && open_id.issuer.authorization_endpoint.is_empty() {
        return;
    }
    println!("OpenID configuration found. Preparing server to use it");
    let config = match serde_json::to_value(open_id) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    match crate::accounts::openid::bootstrap_openid(state, &config).await {
        Ok(()) => println!("OpenID configured!"),
        Err(error) => println!("{error}"),
    }
}

fn https_value(value: &str) -> std::io::Result<Vec<u8>> {
    if value.starts_with("-----BEGIN") {
        Ok(value.as_bytes().to_vec())
    } else {
        std::fs::read(value)
    }
}

fn tls_config(
    https: &crate::load_config::HttpsConfig,
) -> std::io::Result<axum_server::tls_rustls::RustlsConfig> {
    let certificates = rustls_pemfile::certs(&mut Cursor::new(https_value(&https.cert)?))
        .collect::<Result<Vec<_>, _>>()?;
    let private_key = rustls_pemfile::private_key(&mut Cursor::new(https_value(&https.key)?))?
        .ok_or_else(|| std::io::Error::other("HTTPS key did not contain a private key"))?;
    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, private_key)
        .map_err(std::io::Error::other)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(axum_server::tls_rustls::RustlsConfig::from_config(
        Arc::new(config),
    ))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn dev_proxy(State(state): State<AppState>, request: Request<Body>) -> Response {
    let uri = request
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| request.uri().clone(), |uri| uri.0.clone());
    let mut response = if request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        let (mut parts, _) = request.into_parts();
        let mut websocket = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(websocket) => websocket,
            Err(error) => {
                let mut response = error.into_response();
                add_frontend_headers(&mut response, true);
                return response;
            }
        };
        let target = format!("ws://localhost:3001{uri}");
        let (upstream, upstream_response) =
            match connect_upstream_websocket(&target, &parts.headers).await {
                Ok(upstream) => upstream,
                Err(mut response) => {
                    add_frontend_headers(&mut response, true);
                    return response;
                }
            };
        if let Some(protocol) = upstream_response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|protocol| protocol.to_str().ok())
        {
            websocket = websocket.protocols([protocol.to_owned()]);
        }
        websocket
            .on_upgrade(move |downstream| proxy_websocket(downstream, upstream))
            .into_response()
    } else {
        let (parts, body) = request.into_parts();
        proxy_http(&state, parts.method, uri.to_string(), parts.headers, body).await
    };
    add_frontend_headers(&mut response, true);
    response
}

type UpstreamWebSocket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_upstream_websocket(
    target: &str,
    headers: &HeaderMap,
) -> Result<(UpstreamWebSocket, tungstenite::handshake::client::Response), Response> {
    let mut request = match target.into_client_request() {
        Ok(request) => request,
        Err(error) => return Err((StatusCode::BAD_GATEWAY, error.to_string()).into_response()),
    };
    for (name, value) in headers {
        if !matches!(
            name.as_str(),
            "host"
                | "connection"
                | "upgrade"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
        ) {
            request.headers_mut().append(name, value.clone());
        }
    }
    match connect_async(request).await {
        Ok(upstream) => Ok(upstream),
        Err(tungstenite::Error::Http(upstream)) => {
            let status = upstream.status();
            let headers = upstream.headers().clone();
            let body = upstream.into_body().unwrap_or_default();
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            for (name, value) in headers {
                if let Some(name) = name {
                    response.headers_mut().append(name, value);
                }
            }
            Err(response)
        }
        Err(error) => Err((StatusCode::BAD_GATEWAY, error.to_string()).into_response()),
    }
}

async fn production_frontend(State(state): State<AppState>, request: Request<Body>) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        let body = format!(
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot {} {}</pre>\n</body>\n</html>\n",
            request.method(),
            request.uri().path()
        );
        let mut response = (StatusCode::NOT_FOUND, Html(body)).into_response();
        add_frontend_headers(&mut response, false);
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'"),
        );
        response.headers_mut().insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        return response;
    }
    let index = state.config.web_root.join("index.html");
    let service = ServeDir::new(&state.config.web_root)
        .append_index_html_on_directories(false)
        .fallback(ServeFile::new(index));
    let mut response = match service.oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(error) => match error {},
    };
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value == "text/plain")
    {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
    }
    add_frontend_headers(&mut response, false);
    response
}

async fn proxy_http(
    state: &AppState,
    method: Method,
    path: String,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match to_bytes(body, usize::MAX).await {
        Ok(body) => body,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let mut outgoing = state
        .http
        .request(method, format!("http://localhost:3001{path}"));
    for (name, value) in &headers {
        if !matches!(
            name.as_str(),
            "host" | "connection" | "content-length" | "upgrade"
        ) {
            outgoing = outgoing.header(name, value);
        }
    }
    let upstream = match outgoing.body(body).send().await {
        Ok(response) => response,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, error.to_string()).into_response();
        }
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let body = match upstream.bytes().await {
        Ok(body) => body,
        Err(error) => return (StatusCode::BAD_GATEWAY, error.to_string()).into_response(),
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    for (name, value) in headers {
        if let Some(name) = name
            && !matches!(
                name.as_str(),
                "connection" | "content-length" | "transfer-encoding"
            )
        {
            response.headers_mut().append(name, value);
        }
    }
    response
}

async fn proxy_websocket(downstream: axum::extract::ws::WebSocket, upstream: UpstreamWebSocket) {
    let (mut upstream_write, mut upstream_read) = upstream.split();
    let (mut downstream_write, mut downstream_read) = downstream.split();
    loop {
        tokio::select! {
            message = downstream_read.next() => {
                let Some(Ok(message)) = message else { break };
                if upstream_write.send(to_upstream_message(message)).await.is_err() { break; }
            }
            message = upstream_read.next() => {
                let Some(Ok(message)) = message else { break };
                if let Some(message) = to_downstream_message(message)
                    && downstream_write.send(message).await.is_err() { break; }
            }
        }
    }
}

fn to_upstream_message(message: Message) -> tungstenite::Message {
    match message {
        Message::Text(value) => tungstenite::Message::Text(value.to_string().into()),
        Message::Binary(value) => tungstenite::Message::Binary(value),
        Message::Ping(value) => tungstenite::Message::Ping(value),
        Message::Pong(value) => tungstenite::Message::Pong(value),
        Message::Close(_) => tungstenite::Message::Close(None),
    }
}

fn to_downstream_message(message: tungstenite::Message) -> Option<Message> {
    match message {
        tungstenite::Message::Text(value) => Some(Message::Text(value.to_string().into())),
        tungstenite::Message::Binary(value) => Some(Message::Binary(value)),
        tungstenite::Message::Ping(value) => Some(Message::Ping(value)),
        tungstenite::Message::Pong(value) => Some(Message::Pong(value)),
        tungstenite::Message::Close(_) => Some(Message::Close(None)),
        tungstenite::Message::Frame(_) => None,
    }
}

fn add_frontend_headers(response: &mut Response, development: bool) {
    let script = if development {
        "'self' 'unsafe-inline' 'unsafe-eval' blob:"
    } else {
        "'self' 'unsafe-eval' blob:"
    };
    let connect = if development {
        "'self' ws: wss: http: https:"
    } else {
        "http: https:"
    };
    for (name, value) in [
        ("cross-origin-opener-policy", "same-origin".to_owned()),
        ("cross-origin-embedder-policy", "require-corp".to_owned()),
        (
            "content-security-policy",
            format!(
                "default-src 'self' blob:; img-src 'self' blob: data:; script-src {script}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src {connect}"
            ),
        ),
    ] {
        response.headers_mut().insert(
            header::HeaderName::from_static(name),
            HeaderValue::try_from(value).expect("static frontend header"),
        );
    }
}

async fn global_rate_limit(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let address = match client_ip(peer, request.headers(), &state.config.trusted_proxies) {
        Ok(address) => address,
        Err(_) => peer.ip(),
    };
    let attempt = match state.global_rate_limiter.begin(address) {
        Ok(attempt) => attempt,
        Err(response) => return response,
    };
    let mut response = next.run(request).await;
    add_global_rate_headers(&mut response, &attempt, false);
    response
}

fn add_global_rate_headers(
    response: &mut Response,
    attempt: &GlobalRateAttempt,
    retry_after: bool,
) {
    let reset = attempt.reset_after.as_secs().max(1);
    let headers = response.headers_mut();
    for (name, value) in [
        ("ratelimit-policy", "500;w=60".to_owned()),
        ("ratelimit-limit", "500".to_owned()),
        ("ratelimit-remaining", attempt.remaining.to_string()),
        ("ratelimit-reset", reset.to_string()),
    ] {
        if !headers.contains_key(name) {
            headers.insert(
                header::HeaderName::from_static(name),
                HeaderValue::try_from(value).unwrap(),
            );
        }
    }
    if retry_after {
        headers.insert(
            header::RETRY_AFTER,
            HeaderValue::try_from(reset.to_string()).unwrap(),
        );
    }
}

async fn cors(request: Request<Body>, next: Next) -> Response {
    let is_preflight = request.method() == Method::OPTIONS;
    let requested_headers = request
        .headers()
        .get("access-control-request-headers")
        .cloned();
    let mut response = if is_preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    if is_preflight {
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,HEAD,PUT,PATCH,POST,DELETE"),
        );
        if let Some(requested_headers) = requested_headers {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested_headers);
            response.headers_mut().insert(
                header::VARY,
                HeaderValue::from_static("Access-Control-Request-Headers"),
            );
        }
    }
    response
}

fn metrics_response(started_at: Instant) -> Response {
    let stats = memory_stats::memory_stats()
        .map(|stats| (stats.physical_mem as u64, stats.virtual_mem as u64));
    metrics_response_from(started_at, stats)
}

fn metrics_response_from(started_at: Instant, stats: Option<(u64, u64)>) -> Response {
    let Some((physical, virtual_size)) = stats else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "status": "error",
                "reason": "memory-metrics-unavailable"
            })),
        )
            .into_response();
    };
    Json(Metrics {
        mem: memory_usage_from(physical, virtual_size),
        uptime: started_at.elapsed().as_secs_f64(),
    })
    .into_response()
}

fn memory_usage_from(physical: u64, virtual_size: u64) -> MemoryUsage {
    // Rust has no V8 heap/external/ArrayBuffer categories. Preserve the Node
    // response keys with an explicit native mapping: resident-like fields use
    // current physical memory and reserved/external-like fields use current
    // virtual memory. Both are measured cross-platform for this process.
    MemoryUsage {
        rss: physical,
        heap_total: virtual_size,
        heap_used: physical,
        external: virtual_size,
        array_buffers: physical,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    #[test]
    fn exposes_the_sync_server_build_identity() {
        let json = serde_json::to_value(BuildInfo {
            build: Build {
                name: "@actual-app/sync-server",
                description: "actual syncing server",
                version: env!("CARGO_PKG_VERSION"),
            },
        })
        .unwrap();

        assert_eq!(json["build"]["name"], "@actual-app/sync-server");
        assert_eq!(json["build"]["version"], "26.8.0");
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[tokio::test]
    async fn accepts_compressed_body_at_decoded_limit() {
        let decoded = vec![b'a'; 1024];
        let encoded = gzip(&decoded);

        assert_eq!(
            decode_request_body(Body::from(encoded), "gzip", decoded.len())
                .await
                .unwrap(),
            decoded
        );
    }

    #[tokio::test]
    async fn rejects_compressed_bomb_above_decoded_limit() {
        let encoded = gzip(&vec![b'a'; 1025]);

        assert_eq!(
            decode_request_body(Body::from(encoded), "gzip", 1024)
                .await
                .unwrap_err(),
            (StatusCode::PAYLOAD_TOO_LARGE, "request entity too large")
        );
    }

    #[test]
    fn maps_cross_platform_process_memory_to_node_metric_keys() {
        let usage = memory_usage_from(11, 29);

        assert_eq!(usage.rss, 11);
        assert_eq!(usage.heap_total, 29);
        assert_eq!(usage.heap_used, 11);
        assert_eq!(usage.external, 29);
        assert_eq!(usage.array_buffers, 11);
    }

    #[tokio::test]
    async fn reports_metric_collection_failure_instead_of_zero_placeholders() {
        let response = metrics_response_from(Instant::now(), None);

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "status": "error",
                "reason": "memory-metrics-unavailable"
            })
        );
    }
}
