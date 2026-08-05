use crate::{account_db, accounts::openid, load_config::Config, util::prompt::prompt_password};

use super::app_state;

pub fn run(config: Config) -> Result<(), (u8, String)> {
    let state = app_state(config).map_err(|error| (2, error))?;
    if account_db::needs_bootstrap(&state.database).map_err(|error| (2, format!("{error:?}")))? {
        return Err((
            1,
            "System needs to be bootstrapped first. OpenID is not enabled.".into(),
        ));
    }

    println!("To disable OpenID, you have to enter your server password:");
    let login_method = account_db::get_active_login_method(&state.database)
        .map_err(|error| (2, format!("{error:?}")))?;
    println!(
        "Current login method: {}",
        login_method.as_deref().unwrap_or("undefined")
    );
    if login_method.as_deref() == Some("password") {
        println!("OpenID already disabled.");
        return Ok(());
    }

    let password = prompt_password().map_err(|error| (2, error.to_string()))?;
    openid::disable(&state, Some(&password))
        .map_err(|error| (2, format!("Error disabling OpenID: {error}")))?;
    println!("OpenID disabled!");
    println!(
        "Note: you will need to log in with the password on any browsers or devices that are currently logged in."
    );
    Ok(())
}
