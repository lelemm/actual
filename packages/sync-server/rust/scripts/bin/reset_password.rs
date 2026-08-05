use actual_sync_server::{load_config, scripts::reset_password};

fn main() {
    let result = match load_config::load() {
        Ok(config) => reset_password::run(config),
        Err(error) => {
            println!("Unexpected error: {error}");
            println!(
                "Please report this as an issue: https://github.com/actualbudget/actual-server/issues"
            );
            Err(1)
        }
    };
    if let Err(code) = result {
        std::process::exit(code.into());
    }
}
