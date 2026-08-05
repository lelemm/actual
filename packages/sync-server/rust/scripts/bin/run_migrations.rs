use actual_sync_server::{load_config, scripts::run_migrations};

fn main() {
    let result = (|| {
        let config = load_config::load()?;
        let direction = std::env::args()
            .nth(1)
            .unwrap_or_else(|| "up".into())
            .parse()?;
        run_migrations::run(&config, direction).map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        eprintln!("Migration failed: {error}");
        std::process::exit(1);
    }
}
