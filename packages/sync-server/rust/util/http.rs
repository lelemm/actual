use std::{ffi::OsStr, path::Path};

pub fn with_node_extra_ca(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    with_extra_ca_path(builder, std::env::var_os("NODE_EXTRA_CA_CERTS").as_deref())
}

fn with_extra_ca_path(
    mut builder: reqwest::ClientBuilder,
    path: Option<&OsStr>,
) -> reqwest::ClientBuilder {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return builder;
    };
    let Ok(contents) = std::fs::read(Path::new(path)) else {
        return builder;
    };
    let Ok(certificates) = reqwest::Certificate::from_pem_bundle(&contents) else {
        return builder;
    };
    for certificate in certificates {
        builder = builder.add_root_certificate(certificate);
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_blank_unreadable_and_invalid_extra_ca_paths() {
        assert!(
            with_extra_ca_path(reqwest::Client::builder(), Some(OsStr::new("")))
                .build()
                .is_ok()
        );
        assert!(
            with_extra_ca_path(
                reqwest::Client::builder(),
                Some(OsStr::new("/path/that/does/not/exist")),
            )
            .build()
            .is_ok()
        );

        let path = std::env::temp_dir().join(format!("actual-invalid-ca-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "not a certificate").unwrap();
        assert!(
            with_extra_ca_path(reqwest::Client::builder(), Some(path.as_os_str()))
                .build()
                .is_ok()
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn extra_ca_is_required_to_complete_a_local_tls_request() {
        use std::{
            io::{BufReader, Read, Write},
            net::TcpListener,
            sync::Arc,
            thread,
        };

        let _ = rustls::crypto::ring::default_provider().install_default();
        let certificates = rustls_pemfile::certs(&mut BufReader::new(
            include_bytes!("http-test-server-cert.txt").as_slice(),
        ))
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
        let private_key = rustls_pemfile::private_key(&mut BufReader::new(
            include_bytes!("http-test-server-key.txt").as_slice(),
        ))
        .unwrap()
        .unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certificates, private_key)
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = rustls::StreamOwned::new(
                    rustls::ServerConnection::new(Arc::new(config.clone())).unwrap(),
                    stream.unwrap(),
                );
                let mut request = [0; 1024];
                if stream.read(&mut request).is_ok() {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .unwrap();
                }
            }
        });

        let url = format!("https://localhost:{}/", address.port());
        assert!(reqwest::get(&url).await.is_err());

        let ca_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("rust/util/http-test-ca.txt");
        let client = with_extra_ca_path(reqwest::Client::builder(), Some(ca_path.as_os_str()))
            .build()
            .unwrap();
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "ok");
        server.join().unwrap();
    }
}
