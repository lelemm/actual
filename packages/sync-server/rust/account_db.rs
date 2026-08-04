use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    accounts::password::{hash_password, is_legacy_hash, is_valid_password, verify_password},
    db::Database,
};

pub const TOKEN_EXPIRATION_NEVER: i64 = -1;

#[derive(Debug)]
pub enum AccountError {
    Reason(&'static str),
    Database(rusqlite::Error),
    Password(argon2::password_hash::Error),
    Lock,
}

impl From<rusqlite::Error> for AccountError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<argon2::password_hash::Error> for AccountError {
    fn from(error: argon2::password_hash::Error) -> Self {
        Self::Password(error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginMethod {
    pub method: String,
    pub active: i64,
    pub display_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub token: String,
    pub expires_at: i64,
    pub user_id: String,
    pub auth_method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub user_name: Option<String>,
    pub display_name: Option<String>,
    pub role: Option<String>,
    pub enabled: i64,
    pub owner: i64,
}

fn lock(database: &Database) -> Result<std::sync::MutexGuard<'_, Connection>, AccountError> {
    database.lock().map_err(|_| AccountError::Lock)
}

pub fn needs_bootstrap(database: &Database) -> Result<bool, AccountError> {
    let connection = lock(database)?;
    let count =
        connection.query_row("SELECT count(*) FROM auth", [], |row| row.get::<_, i64>(0))?;
    Ok(count == 0)
}

pub fn list_login_methods(database: &Database) -> Result<Vec<LoginMethod>, AccountError> {
    let connection = lock(database)?;
    let mut statement = connection.prepare("SELECT method, display_name, active FROM auth")?;
    Ok(statement
        .query_map([], |row| {
            Ok(LoginMethod {
                method: row.get(0)?,
                display_name: row.get(1)?,
                active: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_active_login_method(database: &Database) -> Result<Option<String>, AccountError> {
    let connection = lock(database)?;
    Ok(connection
        .query_row("SELECT method FROM auth WHERE active = 1", [], |row| {
            row.get(0)
        })
        .optional()?)
}

pub fn bootstrap(database: &Database, settings: &Value) -> Result<String, AccountError> {
    let Some(settings) = settings.as_object() else {
        return Err(AccountError::Reason("invalid-login-settings"));
    };
    let password = settings.get("password").and_then(Value::as_str);
    let pass_enabled = settings.contains_key("password");
    let openid_enabled = settings.contains_key("openId");
    if pass_enabled && !is_valid_password(password) {
        return Err(AccountError::Reason("invalid-password"));
    }
    if !pass_enabled && !openid_enabled {
        return Err(AccountError::Reason("no-auth-method-selected"));
    }
    if pass_enabled && openid_enabled {
        return Err(AccountError::Reason("max-one-method-allowed"));
    }
    if openid_enabled {
        return Err(AccountError::Reason("invalid-openid-discovery-url"));
    }

    let password = password.expect("validated password presence");
    let password_hash = hash_password(password)?;
    {
        let mut connection = lock(database)?;
        let transaction = connection.transaction()?;
        let auth_count =
            transaction.query_row("SELECT count(*) FROM auth", [], |row| row.get::<_, i64>(0))?;
        if auth_count != 0 {
            return Err(AccountError::Reason("already-bootstrapped"));
        }
        transaction.execute("DELETE FROM auth WHERE method = ?", ["password"])?;
        transaction.execute("UPDATE auth SET active = 0", [])?;
        transaction.execute(
            "INSERT INTO auth (method, display_name, extra_data, active)
             VALUES ('password', 'Password', ?, 1)",
            [password_hash],
        )?;
        transaction.commit()?;
    }
    login_with_password(database, Some(password))
}

pub fn login_with_password(
    database: &Database,
    password: Option<&str>,
) -> Result<String, AccountError> {
    if !is_valid_password(password) {
        return Err(AccountError::Reason("invalid-password"));
    }
    let password = password.expect("validated password presence");
    let connection = lock(database)?;
    let password_hash = connection
        .query_row(
            "SELECT extra_data FROM auth WHERE method = ?",
            ["password"],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(password_hash) = password_hash else {
        return Err(AccountError::Reason("invalid-password"));
    };
    if !verify_password(password, &password_hash) {
        return Err(AccountError::Reason("invalid-password"));
    }
    if is_legacy_hash(&password_hash) {
        let rehashed = hash_password(password)?;
        connection.execute(
            "UPDATE auth SET extra_data = ? WHERE method = 'password' AND extra_data = ?",
            params![rehashed, password_hash],
        )?;
    }

    let session = connection
        .query_row(
            "SELECT token FROM sessions WHERE auth_method = ?",
            ["password"],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let token = session.unwrap_or_else(|| Uuid::new_v4().to_string());
    let user_id = connection
        .query_row("SELECT id FROM users WHERE user_name = ?", [""], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .ok_or(AccountError::Reason("user-not-found"))?;

    if connection.query_row(
        "SELECT count(*) FROM sessions WHERE token = ?",
        [&token],
        |row| row.get::<_, i64>(0),
    )? == 0
    {
        connection.execute(
            "INSERT INTO sessions (token, expires_at, user_id, auth_method)
             VALUES (?, ?, ?, ?)",
            params![token, TOKEN_EXPIRATION_NEVER, user_id, "password"],
        )?;
    } else {
        connection.execute(
            "UPDATE sessions SET user_id = ?, expires_at = ? WHERE token = ?",
            params![user_id, TOKEN_EXPIRATION_NEVER, token],
        )?;
    }
    let clear_threshold = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        - 3600;
    connection.execute(
        "DELETE FROM sessions WHERE expires_at <> -1 and expires_at < ?",
        [clear_threshold],
    )?;
    Ok(token)
}

pub fn get_session(database: &Database, token: &str) -> Result<Option<Session>, AccountError> {
    let connection = lock(database)?;
    Ok(connection
        .query_row(
            "SELECT sessions.token, sessions.expires_at, sessions.user_id, sessions.auth_method
             FROM sessions JOIN users ON users.id = sessions.user_id
             WHERE sessions.token = ? AND users.enabled = 1",
            [token],
            |row| {
                Ok(Session {
                    token: row.get(0)?,
                    expires_at: row.get(1)?,
                    user_id: row.get(2)?,
                    auth_method: row.get(3)?,
                })
            },
        )
        .optional()?)
}

pub fn get_user_info(database: &Database, user_id: &str) -> Result<Option<UserInfo>, AccountError> {
    let connection = lock(database)?;
    Ok(connection
        .query_row(
            "SELECT id, user_name, display_name, role, enabled, owner FROM users WHERE id = ?",
            [user_id],
            |row| {
                Ok(UserInfo {
                    id: row.get(0)?,
                    user_name: row.get(1)?,
                    display_name: row.get(2)?,
                    role: row.get(3)?,
                    enabled: row.get(4)?,
                    owner: row.get(5)?,
                })
            },
        )
        .optional()?)
}

pub fn get_server_prefs(
    database: &Database,
) -> Result<BTreeMap<String, Option<String>>, AccountError> {
    let connection = lock(database)?;
    let mut statement = connection.prepare("SELECT key, value FROM server_prefs")?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn set_server_prefs(
    database: &Database,
    prefs: &serde_json::Map<String, Value>,
) -> Result<(), AccountError> {
    let mut connection = lock(database)?;
    let transaction = connection.transaction()?;
    for (key, value) in prefs {
        let value = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        transaction.execute(
            "INSERT INTO server_prefs (key, value) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn change_password(database: &Database, password: Option<&str>) -> Result<(), AccountError> {
    if !is_valid_password(password) {
        return Err(AccountError::Reason("invalid-password"));
    }
    let hash = hash_password(password.expect("validated password presence"))?;
    let connection = lock(database)?;
    connection.execute(
        "UPDATE auth SET extra_data = ? WHERE method = 'password'",
        [hash],
    )?;
    Ok(())
}
