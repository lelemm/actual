use actual_sync_server::{load_config, scripts::health_check};

#[tokio::main]
async fn main() {
    let result = async {
        let config =
            load_config::load().map_err(|error| format!("Health check failed: {error}"))?;
        health_check::run(&config).await
    }
    .await;
    if let Err(error) = result {
        println!("{error}");
        std::process::exit(1);
    }
}
