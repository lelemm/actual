use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router, ServiceExt,
    body::Body,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::{
    normalize_path::NormalizePath,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

use crate::{
    app_account, app_admin, app_akahu, app_cors_proxy, app_enablebanking, app_gocardless,
    app_openid, app_pluggyai, app_secrets, app_simplefin, app_sync,
    db::{Database, open_database},
    load_config::Config,
    migrations,
    util::validate_user::client_ip,
};

const GLOBAL_RATE_LIMIT: u64 = 500;
const GLOBAL_RATE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
    pub auth_rate_limiter: app_account::AuthRateLimiter,
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
                move || async move {
                    Json(Metrics {
                        mem: memory_usage(),
                        uptime: started_at.elapsed().as_secs_f64(),
                    })
                }
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
        .nest("/akahu", limited(app_akahu::router(), general_limit))
        .nest(
            "/enablebanking",
            limited(app_enablebanking::router(), general_limit),
        )
        .nest(
            "/gocardless",
            limited(app_gocardless::app_gocardless::router(), general_limit),
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
    if state.config.environment != "development" {
        let csp = HeaderValue::from_static(
            "default-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src http: https:",
        );
        let index = state.config.web_root.join("index.html");
        let static_files = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                header::HeaderName::from_static("cross-origin-opener-policy"),
                HeaderValue::from_static("same-origin"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::HeaderName::from_static("cross-origin-embedder-policy"),
                HeaderValue::from_static("require-corp"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::CONTENT_SECURITY_POLICY,
                csp,
            ))
            .service(
                ServeDir::new(&state.config.web_root)
                    .append_index_html_on_directories(false)
                    .fallback(ServeFile::new(index)),
            );
        router = router.fallback_service(static_files);
        router = router.layer(middleware::from_fn_with_state(
            state.clone(),
            global_rate_limit,
        ));
    }
    router.layer(middleware::from_fn(cors)).with_state(state)
}

fn limited(router: Router<AppState>, megabytes: u64) -> Router<AppState> {
    let bytes = megabytes.saturating_mul(1024 * 1024).min(usize::MAX as u64) as usize;
    router.layer(DefaultBodyLimit::max(bytes))
}

pub async fn run(config: Config) -> std::io::Result<()> {
    migrations::run(&config).map_err(|error| std::io::Error::other(error.to_string()))?;
    let database = Arc::new(Mutex::new(
        open_database(&config.server_files.join("account.sqlite"))
            .map_err(std::io::Error::other)?,
    ));
    let listener = TcpListener::bind(config.address).await?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(std::io::Error::other)?;
    println!("Listening on {}...", listener.local_addr()?);
    axum::serve(
        listener,
        ServiceExt::<Request<Body>>::into_make_service_with_connect_info::<SocketAddr>(
            NormalizePath::trim_trailing_slash(router(AppState {
                database,
                config: Arc::new(config),
                http,
                auth_rate_limiter: app_account::AuthRateLimiter::default(),
                gocardless:
                    app_gocardless::services::gocardless_service::GoCardlessService::default(),
                pluggyai: app_pluggyai::pluggyai_service::PluggyAiService::default(),
                akahu_refresh: Arc::new(tokio::sync::Mutex::new(())),
                cors_proxy: app_cors_proxy::CorsProxyState::new().map_err(std::io::Error::other)?,
                enablebanking: app_enablebanking::EnableBankingState::default(),
                started_at: Instant::now(),
                global_rate_limiter: GlobalRateLimiter::default(),
            })),
        ),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
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

fn memory_usage() -> MemoryUsage {
    let rss = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        })
        .unwrap_or(0)
        * 1024;
    MemoryUsage {
        rss,
        heap_total: 0,
        heap_used: 0,
        external: 0,
        array_buffers: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
