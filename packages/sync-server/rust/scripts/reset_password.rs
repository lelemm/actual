use crate::{account_db, load_config::Config, util::prompt::prompt_password};

use super::app_state;

const ISSUE_URL: &str = "https://github.com/actualbudget/actual-server/issues";

pub fn run(config: Config) -> Result<(), u8> {
    let state = app_state(config).map_err(unexpected)?;
    let needs_bootstrap = account_db::needs_bootstrap(&state.database)
        .map_err(|error| unexpected(format!("{error:?}")))?;

    if needs_bootstrap {
        println!("It looks like you don't have a password set yet. Let's set one up now!");
        let password = prompt_password().map_err(|error| unexpected(error.to_string()))?;
        if let Err(error) = account_db::bootstrap(
            &state.database,
            &serde_json::json!({ "password": password }),
            &state.config.token_expiration,
        ) {
            println!("Error setting password: {}", account_error(error));
            println!("Please report this as an issue: {ISSUE_URL}");
            return Err(1);
        }
        println!("Password set!");
    } else {
        println!("It looks like you already have a password set. Let's reset it!");
        let password = prompt_password().map_err(|error| unexpected(error.to_string()))?;
        if let Err(error) = account_db::change_password(&state.database, Some(&password)) {
            println!("Error changing password: {}", account_error(error));
            println!("Please report this as an issue: {ISSUE_URL}");
            return Err(1);
        }
        println!("Password changed!");
        println!(
            "Note: you will need to log in with the new password on any browsers or devices that are currently logged in."
        );
    }
    Ok(())
}

fn account_error(error: account_db::AccountError) -> String {
    match error {
        account_db::AccountError::Reason(reason) => reason.into(),
        error => format!("{error:?}"),
    }
}

fn unexpected(error: String) -> u8 {
    println!("Unexpected error: {error}");
    println!("Please report this as an issue: {ISSUE_URL}");
    1
}
