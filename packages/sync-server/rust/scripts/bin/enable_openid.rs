use actual_sync_server::{
    load_config,
    scripts::{enable_openid, invalid_config_exit},
};

#[tokio::main]
async fn main() {
    let result = match load_config::load() {
        Ok(config) => enable_openid::run(config).await,
        Err(error) => Err(invalid_config_exit(error)),
    };
    if let Err((code, error)) = result {
        println!("{error}");
        if code == 1 && error.starts_with("Error enabling openid:") {
            println!(
                "Error configuring OpenID. Please verify that the configuration file or environment variables are correct."
            );
        } else if code == 2 {
            println!(
                "Please report this as an issue: https://github.com/actualbudget/actual-server/issues"
            );
        }
        std::process::exit(code.into());
    }
}
