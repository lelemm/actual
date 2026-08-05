use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use rusqlite::{Connection, params};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    app::{AppState, GlobalRateLimiter},
    app_account::AuthRateLimiter,
    app_cors_proxy::CorsProxyState,
    app_enablebanking::EnableBankingState,
    app_gocardless::services::gocardless_service::GoCardlessService,
    app_openid::OpenIdConfigRateLimiter,
    app_pluggyai::pluggyai_service::PluggyAiService,
    db::open_database,
    load_config::Config,
    migrations,
};

pub struct TestApp {
    pub state: AppState,
    root: PathBuf,
}

impl TestApp {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("actual-rust-route-test-{}", Uuid::new_v4()));
        let config = Config {
            address: (IpAddr::V4(Ipv4Addr::LOCALHOST), 0).into(),
            environment: "test".into(),
            mode: "test".into(),
            data_dir: root.clone(),
            server_files: root.join("server-files"),
            user_files: root.join("user-files"),
            ..Config::default()
        };
        migrations::run(&config).unwrap();
        let database = Arc::new(Mutex::new(
            open_database(&config.server_files.join("account.sqlite")).unwrap(),
        ));
        {
            let connection = database.lock().unwrap();
            connection.execute("DELETE FROM user_access", []).unwrap();
            connection.execute("DELETE FROM files", []).unwrap();
            connection.execute("DELETE FROM sessions", []).unwrap();
            connection.execute("DELETE FROM auth", []).unwrap();
            connection.execute("DELETE FROM secrets", []).unwrap();
            connection.execute("DELETE FROM server_prefs", []).unwrap();
        }
        Self {
            state: AppState {
                database,
                config: Arc::new(config),
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
                auth_rate_limiter: AuthRateLimiter::default(),
                openid_config_rate_limiter: OpenIdConfigRateLimiter::default(),
                gocardless: GoCardlessService::default(),
                pluggyai: PluggyAiService::default(),
                akahu_refresh: Arc::new(tokio::sync::Mutex::new(())),
                cors_proxy: CorsProxyState::new().unwrap(),
                enablebanking: EnableBankingState::default(),
                started_at: Instant::now(),
                global_rate_limiter: GlobalRateLimiter::default(),
            },
            root,
        }
    }

    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.state.database.lock().unwrap()
    }

    pub fn create_user(&self, id: &str, name: &str, role: &str, owner: bool, enabled: bool) {
        self.connection()
            .execute(
                "INSERT INTO users
                   (id, user_name, display_name, enabled, owner, role)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id, name, format!("{name} display"), enabled, owner, role],
            )
            .unwrap();
    }

    pub fn create_session(&self, user_id: &str, token: &str, auth_method: Option<&str>) {
        let expires_at = chrono::Utc::now().timestamp() + 3600;
        self.connection()
            .execute(
                "INSERT INTO sessions (token, user_id, expires_at, auth_method)
                 VALUES (?, ?, ?, ?)",
                params![token, user_id, expires_at, auth_method],
            )
            .unwrap();
    }

    pub fn create_file(&self, id: &str, owner: &str) {
        self.connection()
            .execute(
                "INSERT INTO files (id, deleted, owner) VALUES (?, FALSE, ?)",
                params![id, owner],
            )
            .unwrap();
    }

    pub async fn send(
        &self,
        router: Router<AppState>,
        method: Method,
        uri: &str,
        token: Option<&str>,
        file_id: Option<&str>,
        body: Option<Value>,
    ) -> TestResponse {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            request = request.header("x-actual-token", token);
        }
        if let Some(file_id) = file_id {
            request = request.header("x-actual-file-id", file_id);
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(&body).unwrap())
            }
            None => Body::empty(),
        };
        let mut request = request.body(body).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 12345))));
        let response = router
            .with_state(self.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        TestResponse {
            status,
            headers,
            body: body.to_vec(),
        }
    }
}

impl Default for TestApp {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
}

impl TestResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}
