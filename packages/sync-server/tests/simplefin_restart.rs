use std::{
    net::{Ipv4Addr, TcpListener},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    extract::State,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use uuid::Uuid;

fn available_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn start_server(port: u16, data_dir: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_actual-server"))
        .env("ACTUAL_HOSTNAME", "127.0.0.1")
        .env("ACTUAL_PORT", port.to_string())
        .env("ACTUAL_DATA_DIR", data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

async fn wait_until_healthy(client: &reqwest::Client, base_url: &str, child: &mut Child) {
    for _ in 0..100 {
        assert!(child.try_wait().unwrap().is_none(), "server exited early");
        if client
            .get(format!("{base_url}/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("server did not become healthy");
}

async fn authenticate(client: &reqwest::Client, base_url: &str, path: &str) -> String {
    client
        .post(format!("{base_url}/account/{path}"))
        .json(&json!({ "password": "restart-password" }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["data"]["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn claimed_access_key_survives_a_real_process_restart() {
    let claims = Arc::new(AtomicUsize::new(0));
    let mock_port = available_port();
    let mock_url = format!("http://127.0.0.1:{mock_port}");
    let mock = Router::new()
        .route(
            "/claim",
            post(move |State(claims): State<Arc<AtomicUsize>>| async move {
                claims.fetch_add(1, Ordering::SeqCst);
                format!("http://user:password@127.0.0.1:{mock_port}/simplefin")
            }),
        )
        .route(
            "/simplefin/accounts",
            get(|| async { axum::Json(json!({ "accounts": [], "errors": [] })) }),
        )
        .with_state(claims.clone());
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, mock_port))
        .await
        .unwrap();
    let mock_task = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });

    let data_dir =
        std::env::temp_dir().join(format!("actual-simplefin-restart-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let port = available_port();
    let base_url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let mut first = start_server(port, &data_dir);
    wait_until_healthy(&client, &base_url, &mut first).await;
    let token = authenticate(&client, &base_url, "bootstrap").await;
    client
        .post(format!("{base_url}/secret/"))
        .header("x-actual-token", &token)
        .json(&json!({
            "name": "simplefin_token",
            "value": STANDARD.encode(format!("{mock_url}/claim"))
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    client
        .post(format!("{base_url}/simplefin/accounts"))
        .header("x-actual-token", &token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(claims.load(Ordering::SeqCst), 1);
    first.kill().unwrap();
    first.wait().unwrap();

    let mut second = start_server(port, &data_dir);
    wait_until_healthy(&client, &base_url, &mut second).await;
    let token = authenticate(&client, &base_url, "login").await;
    client
        .post(format!("{base_url}/simplefin/accounts"))
        .header("x-actual-token", token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(claims.load(Ordering::SeqCst), 1);

    second.kill().unwrap();
    second.wait().unwrap();
    mock_task.abort();
    std::fs::remove_dir_all(data_dir).unwrap();
}
