use actual_sync_server::{
    load_config,
    scripts::{disable_openid, invalid_config_exit},
};

fn main() {
    let result = load_config::load()
        .map_err(invalid_config_exit)
        .and_then(disable_openid::run);
    if let Err((code, error)) = result {
        println!("{error}");
        if code == 2 {
            println!(
                "Please report this as an issue: https://github.com/actualbudget/actual-server/issues"
            );
        }
        std::process::exit(code.into());
    }
}
