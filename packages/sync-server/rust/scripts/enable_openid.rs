use crate::{account_db, accounts::openid, load_config::Config};

use super::app_state;

pub async fn run(config: Config) -> Result<(), (u8, String)> {
    let state = app_state(config).map_err(|error| (2, error))?;
    if account_db::needs_bootstrap(&state.database).map_err(|error| (2, format!("{error:?}")))? {
        return Err((
            1,
            "It looks like you don't have a password set yet. Password is the fallback authentication method when using OpenID. Execute the command reset-password before using this command!".into(),
        ));
    }

    println!("Enabling openid based on Environment variables or config.json");
    let login_method = account_db::get_active_login_method(&state.database)
        .map_err(|error| (2, format!("{error:?}")))?;
    println!(
        "Current login method: {}",
        login_method.as_deref().unwrap_or("undefined")
    );
    if login_method.as_deref() == Some("openid") {
        println!("OpenID already enabled.");
        return Ok(());
    }

    let settings = open_id_settings(&state.config.open_id).map_err(|error| (2, error))?;
    openid::bootstrap_openid(&state, &settings)
        .await
        .map_err(|error| {
            (
                openid_exit_code(error),
                format!("Error enabling openid: {error}"),
            )
        })?;
    state
        .database
        .lock()
        .map_err(|_| (2, "database-error".into()))?
        .execute("DELETE FROM sessions", [])
        .map_err(|error| (2, error.to_string()))?;
    println!("OpenID enabled!");
    println!("Note: The first user to login with OpenID will be the owner of the server.");
    Ok(())
}

fn openid_exit_code(error: &str) -> u8 {
    if error == "invalid-login-settings" {
        1
    } else {
        2
    }
}

fn open_id_settings(
    config: &crate::load_config::OpenIdConfig,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(config).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_discovery_url_preserves_direct_issuer_configuration() {
        let settings = open_id_settings(&Config::default().open_id).unwrap();
        assert_eq!(
            settings
                .get("discoveryURL")
                .and_then(serde_json::Value::as_str),
            Some("")
        );
        assert!(
            settings
                .get("issuer")
                .is_some_and(serde_json::Value::is_object)
        );
    }

    #[test]
    fn only_invalid_login_settings_is_an_expected_cli_error() {
        assert_eq!(openid_exit_code("invalid-login-settings"), 1);
        for error in [
            "missing-issuer-or-discoveryURL",
            "missing-client-id",
            "missing-client-secret",
            "missing-server-hostname",
            "configuration-error",
            "database-error",
        ] {
            assert_eq!(openid_exit_code(error), 2);
        }
    }
}
