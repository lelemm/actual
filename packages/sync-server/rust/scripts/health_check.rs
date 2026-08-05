use serde::Deserialize;

use crate::{load_config::Config, util::http::with_node_extra_ca};

#[derive(Deserialize)]
struct Health {
    status: String,
}

pub async fn run(config: &Config) -> Result<(), String> {
    let protocol = if config.https.key.is_empty() || config.https.cert.is_empty() {
        "http"
    } else {
        "https"
    };
    let hostname = if config.hostname == "::" {
        "localhost"
    } else {
        &config.hostname
    };
    let health = with_node_extra_ca(reqwest::Client::builder())
        .build()
        .map_err(|error| format!("Health check failed: {error}"))?
        .get(format!("{protocol}://{hostname}:{}/health", config.port))
        .send()
        .await
        .map_err(|error| format!("Health check failed: {error}"))?
        .json::<Health>()
        .await
        .map_err(|error| format!("Health check failed: {error}"))?;

    validate(health)
}

fn validate(health: Health) -> Result<(), String> {
    (health.status == "UP").then_some(()).ok_or_else(|| {
        format!(
            "Health check failed: Server responded to health check with status {}",
            health.status
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_payload_requires_up() {
        assert!(validate(serde_json::from_str(r#"{"status":"UP"}"#).unwrap()).is_ok());
        assert!(validate(serde_json::from_str(r#"{"status":"DOWN"}"#).unwrap()).is_err());
    }
}
