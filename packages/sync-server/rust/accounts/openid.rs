use std::time::{SystemTime, UNIX_EPOCH};

use openidconnect::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet, EndpointSet,
    IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse, TokenUrl, UserInfoUrl,
    core::{CoreAuthenticationFlow, CoreClient, CoreJsonWebKeySet, CoreProviderMetadata},
};
use reqwest::Url;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    account_db::TOKEN_EXPIRATION_NEVER,
    accounts::password::{hash_password, verify_password},
    app::AppState,
    load_config::TokenExpiration,
};

type OpenIdClient = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
    EndpointSet,
>;

pub async fn bootstrap_openid(state: &AppState, config: &Value) -> Result<(), &'static str> {
    let Some(config) = config.as_object() else {
        return Err("invalid-login-settings");
    };
    if !config.contains_key("issuer") && !config.contains_key("discoveryURL") {
        return Err("missing-issuer-or-discoveryURL");
    }
    for (key, error) in [
        ("client_id", "missing-client-id"),
        ("client_secret", "missing-client-secret"),
        ("server_hostname", "missing-server-hostname"),
    ] {
        if !config.contains_key(key) {
            return Err(error);
        }
    }
    let mut config = config.clone();
    if let Some(discovery_url) = config.remove("discoveryURL") {
        config.insert("issuer".into(), discovery_url);
    }
    let config = Value::Object(config);
    setup_client(state, &config)
        .await
        .map_err(|_| "configuration-error")?;
    let serialized = serde_json::to_string(&config).map_err(|_| "configuration-error")?;
    let mut connection = state.database.lock().map_err(|_| "database-error")?;
    let transaction = connection.transaction().map_err(|_| "database-error")?;
    transaction
        .execute("DELETE FROM auth WHERE method = 'openid'", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute("UPDATE auth SET active = 0", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute(
            "INSERT INTO auth (method, display_name, extra_data, active)
             VALUES ('openid', 'OpenID', ?, 1)",
            [serialized],
        )
        .map_err(|_| "database-error")?;
    transaction.commit().map_err(|_| "database-error")
}

pub async fn login_setup(
    state: &AppState,
    return_url: Option<&str>,
    first_time_password: Option<&str>,
) -> Result<String, &'static str> {
    let return_url = return_url.ok_or("return-url-missing")?;
    if !is_valid_redirect_url(state, return_url) {
        return Err("invalid-return-url");
    }
    let (count, has_password, config) = {
        let connection = state.database.lock().map_err(|_| "openid-setup-failed")?;
        let count = connection
            .query_row(
                "SELECT count(*) FROM users WHERE user_name <> ''",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "openid-setup-failed")?;
        let has_password = connection
            .query_row(
                "SELECT count(*) FROM auth WHERE method = 'password'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "openid-setup-failed")?
            > 0;
        let config = connection
            .query_row(
                "SELECT extra_data FROM auth WHERE method = 'openid'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "openid-setup-failed")?;
        (count, has_password, config)
    };
    if count == 0 && has_password && !check_password(state, first_time_password) {
        return Err("invalid-password");
    }
    let config = config.ok_or("openid-not-configured")?;
    let config: Value = serde_json::from_str(&config).map_err(|_| "openid-setup-failed")?;
    let client = setup_client(state, &config)
        .await
        .map_err(|_| "openid-setup-failed")?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let state_token = CsrfToken::new_random();
    let state_value = state_token.secret().clone();
    let nonce_value = state_value.clone();
    let (mut url, _, _) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            || state_token,
            || Nonce::new(nonce_value),
        )
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge)
        .url();
    let query = url
        .query_pairs()
        .filter(|(key, _)| key != "nonce")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(query);
    let now = now_seconds().map_err(|_| "openid-setup-failed")? * 1000;
    let connection = state.database.lock().map_err(|_| "openid-setup-failed")?;
    connection
        .execute(
            "DELETE FROM pending_openid_requests WHERE expiry_time < ?",
            [now],
        )
        .map_err(|_| "openid-setup-failed")?;
    connection
        .execute(
            "INSERT INTO pending_openid_requests
             (state, code_verifier, return_url, expiry_time) VALUES (?, ?, ?, ?)",
            params![state_value, verifier.secret(), return_url, now + 300_000],
        )
        .map_err(|_| "openid-setup-failed")?;
    Ok(url.to_string())
}

pub async fn login_finalize(
    state: &AppState,
    code: Option<&str>,
    state_value: Option<&str>,
    issuer: Option<&str>,
) -> Result<String, String> {
    let code = code.ok_or("missing-authorization-code")?;
    let state_value = state_value.ok_or("missing-state")?;
    let (config, verifier, return_url) = {
        let connection = state.database.lock().map_err(|_| "openid-grant-failed")?;
        let config = connection
            .query_row(
                "SELECT extra_data FROM auth WHERE method = 'openid' AND active = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "openid-grant-failed")?
            .ok_or("openid-not-configured")?;
        let now = now_seconds().map_err(|_| "openid-grant-failed")? * 1000;
        let pending = connection
            .query_row(
                "SELECT code_verifier, return_url FROM pending_openid_requests
                 WHERE state = ? AND expiry_time > ?",
                params![state_value, now],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| "openid-grant-failed")?
            .ok_or("invalid-or-expired-state")?;
        (config, pending.0, pending.1)
    };
    let config: Value = serde_json::from_str(&config).map_err(|_| "openid-setup-failed")?;
    let client = setup_client(state, &config)
        .await
        .map_err(|_| "openid-setup-failed")?;
    if let Some(callback_issuer) = issuer {
        let configured_issuer = config
            .get("issuer")
            .and_then(|issuer| {
                issuer
                    .as_str()
                    .or_else(|| issuer.get("name").and_then(Value::as_str))
            })
            .ok_or("openid-grant-failed")?;
        if callback_issuer != configured_issuer {
            return Err("openid-grant-failed".into());
        }
    }
    let token = client
        .exchange_code(AuthorizationCode::new(code.into()))
        .set_pkce_verifier(PkceCodeVerifier::new(verifier))
        .request_async(&state.http)
        .await
        .map_err(|_| "openid-grant-failed")?;
    let auth_method = config
        .get("authMethod")
        .and_then(Value::as_str)
        .unwrap_or("openid");
    if auth_method == "openid" {
        let id_token = token.id_token().ok_or("openid-grant-failed")?;
        id_token
            .claims(&client.id_token_verifier(), |nonce: Option<&Nonce>| {
                nonce
                    .is_none()
                    .then_some(())
                    .ok_or_else(|| "unexpected nonce claim".to_owned())
            })
            .map_err(|_| "openid-grant-failed")?;
    }
    let user_info_endpoint = client.user_info_url().as_str();
    let user_info: Value = state
        .http
        .get(user_info_endpoint)
        .bearer_auth(token.access_token().secret())
        .send()
        .await
        .map_err(|_| "openid-grant-failed")?
        .error_for_status()
        .map_err(|_| "openid-grant-failed")?
        .json()
        .await
        .map_err(|_| "openid-grant-failed")?;
    let identity = ["preferred_username", "login", "email", "id", "sub"]
        .into_iter()
        .find_map(|key| user_info.get(key).and_then(Value::as_str))
        .ok_or("openid-grant-failed: no identification was found")?;
    let display_name = user_info
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| user_info.get("email").and_then(Value::as_str))
        .unwrap_or(identity);
    let user_id = upsert_user(state, identity, display_name)?;
    let expiration = match &state.config.token_expiration {
        TokenExpiration::Named(value) if value == "openid-provider" => token
            .expires_in()
            .map(|expires| now_seconds().unwrap_or_default() + expires.as_secs() as i64)
            .unwrap_or(TOKEN_EXPIRATION_NEVER),
        TokenExpiration::Named(value) if value == "never" => TOKEN_EXPIRATION_NEVER,
        TokenExpiration::Seconds(seconds) => {
            now_seconds().map_err(|_| "openid-grant-failed")? + *seconds as i64
        }
        TokenExpiration::Named(_) => now_seconds().map_err(|_| "openid-grant-failed")? + 600,
    };
    let session_token = Uuid::new_v4().to_string();
    let connection = state.database.lock().map_err(|_| "openid-grant-failed")?;
    connection
        .execute(
            "INSERT INTO sessions (token, expires_at, user_id, auth_method)
             VALUES (?, ?, ?, 'openid')",
            params![session_token, expiration, user_id],
        )
        .map_err(|_| "openid-grant-failed")?;
    clear_expired_sessions(&connection).map_err(|_| "openid-grant-failed")?;
    Ok(format!(
        "{}/openid-cb?token={session_token}",
        return_url.trim_end_matches('/')
    ))
}

pub fn is_valid_redirect_url(state: &AppState, target: &str) -> bool {
    let server_hostname = {
        let Ok(connection) = state.database.lock() else {
            return false;
        };
        let Ok(config) = connection
            .query_row(
                "SELECT extra_data FROM auth WHERE method = 'openid' AND active = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
        else {
            return false;
        };
        config
            .and_then(|config| serde_json::from_str::<Value>(&config).ok())
            .and_then(|config| {
                config
                    .get("server_hostname")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    };
    let (Some(server_hostname), Ok(target)) = (server_hostname, Url::parse(target)) else {
        return false;
    };
    let Ok(server) = Url::parse(&server_hostname) else {
        return false;
    };
    target.host_str() == server.host_str() || target.host_str() == Some("localhost")
}

pub fn check_password(state: &AppState, password: Option<&str>) -> bool {
    let Some(password) = password else {
        return false;
    };
    let Ok(connection) = state.database.lock() else {
        return false;
    };
    connection
        .query_row(
            "SELECT extra_data FROM auth WHERE method = 'password'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|hash| verify_password(password, &hash))
}

pub fn disable(state: &AppState, password: Option<&str>) -> Result<(), &'static str> {
    if !check_password(state, password) {
        return Err("invalid-password");
    }
    let hash = hash_password(password.expect("checked password")).map_err(|_| "database-error")?;
    let mut connection = state.database.lock().map_err(|_| "database-error")?;
    let transaction = connection.transaction().map_err(|_| "database-error")?;
    transaction
        .execute("DELETE FROM auth WHERE method = 'password'", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute("UPDATE auth SET active = 0", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute(
            "INSERT INTO auth (method, display_name, extra_data, active)
             VALUES ('password', 'Password', ?, 1)",
            [hash],
        )
        .map_err(|_| "database-error")?;
    transaction
        .execute("DELETE FROM sessions", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute(
            "DELETE FROM user_access WHERE user_id IN
             (SELECT id FROM users WHERE user_name <> '')",
            [],
        )
        .map_err(|_| "database-error")?;
    transaction
        .execute("DELETE FROM users WHERE user_name <> ''", [])
        .map_err(|_| "database-error")?;
    transaction
        .execute("DELETE FROM auth WHERE method = 'openid'", [])
        .map_err(|_| "database-error")?;
    transaction.commit().map_err(|_| "database-error")
}

pub fn get_config(state: &AppState) -> Result<Option<Value>, String> {
    let connection = state.database.lock().map_err(|_| "database-error")?;
    let config = connection
        .query_row(
            "SELECT extra_data FROM auth WHERE method = 'openid'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "database-error")?;
    config
        .map(|config| {
            serde_json::from_str(&config).map_err(|_| "Invalid OpenID configuration".into())
        })
        .transpose()
}

async fn setup_client(state: &AppState, config: &Value) -> Result<OpenIdClient, String> {
    let issuer = config.get("issuer").ok_or("missing issuer")?;
    let (issuer, authorization, token, user_info, jwks) = if let Some(issuer) = issuer.as_str() {
        let metadata = CoreProviderMetadata::discover_async(
            IssuerUrl::new(issuer.to_owned()).map_err(|error| error.to_string())?,
            &state.http,
        )
        .await
        .map_err(|error| error.to_string())?;
        (
            metadata.issuer().clone(),
            metadata.authorization_endpoint().clone(),
            metadata
                .token_endpoint()
                .cloned()
                .ok_or("missing token endpoint")?,
            metadata
                .userinfo_endpoint()
                .cloned()
                .ok_or("missing userinfo endpoint")?,
            metadata.jwks().clone(),
        )
    } else {
        let issuer = issuer.as_object().ok_or("invalid issuer")?;
        (
            IssuerUrl::new(required(issuer, "name")?).map_err(|error| error.to_string())?,
            AuthUrl::new(required(issuer, "authorization_endpoint")?)
                .map_err(|error| error.to_string())?,
            TokenUrl::new(required(issuer, "token_endpoint")?)
                .map_err(|error| error.to_string())?,
            UserInfoUrl::new(required(issuer, "userinfo_endpoint")?)
                .map_err(|error| error.to_string())?,
            CoreJsonWebKeySet::new(Vec::new()),
        )
    };
    let redirect = Url::parse(required_value(config, "server_hostname")?.as_str())
        .and_then(|url| url.join("/openid/callback"))
        .map_err(|error| error.to_string())?;
    Ok(CoreClient::new(
        ClientId::new(required_value(config, "client_id")?),
        issuer,
        jwks,
    )
    .set_client_secret(ClientSecret::new(required_value(config, "client_secret")?))
    .set_auth_uri(authorization)
    .set_token_uri(token)
    .set_user_info_url(user_info)
    .set_redirect_uri(RedirectUrl::new(redirect.to_string()).map_err(|error| error.to_string())?))
}

fn required(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key}"))
}

fn required_value(config: &Value, key: &str) -> Result<String, String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key}"))
}

fn upsert_user(state: &AppState, identity: &str, display_name: &str) -> Result<String, String> {
    let mut connection = state.database.lock().map_err(|_| "openid-grant-failed")?;
    let transaction = connection
        .transaction()
        .map_err(|_| "openid-grant-failed")?;
    let count = transaction
        .query_row(
            "SELECT count(*) FROM users WHERE user_name <> ''",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "openid-grant-failed")?;
    let existing = transaction
        .query_row(
            "SELECT id, display_name FROM users WHERE user_name = ?",
            [identity],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|_| "openid-grant-failed")?;
    let user_id =
        if existing.is_none() && (count == 0 || state.config.user_creation_mode == "login") {
            let user_id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO users (id, user_name, display_name, enabled, owner, role)
                 VALUES (?, ?, ?, 1, ?, ?)",
                    params![
                        user_id,
                        identity,
                        display_name,
                        i64::from(count == 0),
                        if count == 0 { "ADMIN" } else { "BASIC" }
                    ],
                )
                .map_err(|_| "openid-grant-failed")?;
            user_id
        } else {
            let (user_id, old_display) = transaction
                .query_row(
                    "SELECT id, display_name FROM users WHERE user_name = ? AND enabled = 1",
                    [identity],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|_| "openid-grant-failed")?
                .ok_or("openid-grant-failed")?;
            if old_display.as_deref().is_none_or(str::is_empty) && !display_name.is_empty() {
                transaction
                    .execute(
                        "UPDATE users SET display_name = ? WHERE id = ?",
                        params![display_name, user_id],
                    )
                    .map_err(|_| "openid-grant-failed")?;
            }
            user_id
        };
    transaction.commit().map_err(|_| "openid-grant-failed")?;
    Ok(user_id)
}

fn clear_expired_sessions(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM sessions WHERE expires_at <> -1 AND expires_at < ?",
        [now_seconds().unwrap_or_default() - 3600],
    )?;
    Ok(())
}

fn now_seconds() -> Result<i64, std::time::SystemTimeError> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_precedence_matches_the_javascript_server() {
        let user = json!({
            "sub": "subject",
            "email": "email@example.com",
            "preferred_username": "preferred"
        });
        let identity = ["preferred_username", "login", "email", "id", "sub"]
            .into_iter()
            .find_map(|key| user.get(key).and_then(Value::as_str));
        assert_eq!(identity, Some("preferred"));
    }
}
