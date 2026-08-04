use actual_sync_server::{app, load_config};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let config = load_config::load().map_err(std::io::Error::other)?;
    app::run(config).await
}
