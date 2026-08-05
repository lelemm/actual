use super::super::enablebanking_service::get_application;
use crate::{services::secrets_service, test_support::TestApp};

static ENABLEBANKING_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn get_application_uses_configured_credentials() {
    let app = TestApp::new();
    let error = get_application(&app.state).await.unwrap_err();
    assert_eq!(error.error_code, "NOT_CONFIGURED");
    assert_eq!(error.message, "Enable Banking is not configured");

    let _env = ENABLEBANKING_ENV.lock().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 1024];
            let read = stream.read(&mut chunk).await.unwrap();
            request.extend_from_slice(&chunk[..read]);
            if read == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 43\r\nConnection: close\r\n\r\n{\"name\":\"Configured application\",\"ok\":true}",
            )
            .await
            .unwrap();
        String::from_utf8(request).unwrap()
    });
    {
        let connection = app.connection();
        secrets_service::set(
            &connection,
            "enablebanking_applicationId",
            Some("configured-application"),
            None,
        )
        .unwrap();
        secrets_service::set(
            &connection,
            "enablebanking_secretKey",
            Some(include_str!("../../../util/http-test-server-key.txt")),
            None,
        )
        .unwrap();
    }
    let previous_url = std::env::var_os("ENABLEBANKING_API_URL");
    unsafe { std::env::set_var("ENABLEBANKING_API_URL", format!("http://{address}")) };
    let result = get_application(&app.state).await.unwrap();
    if let Some(previous_url) = previous_url {
        unsafe { std::env::set_var("ENABLEBANKING_API_URL", previous_url) };
    } else {
        unsafe { std::env::remove_var("ENABLEBANKING_API_URL") };
    }
    assert_eq!(result["name"], "Configured application");
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /application HTTP/1.1\r\n"));
    assert!(request.contains("authorization: Bearer "));
}
