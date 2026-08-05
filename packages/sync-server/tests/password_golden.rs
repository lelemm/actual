use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use actual_sync_server::{
    account_db::{self, AccountError},
    accounts::password::verify_password,
    db::Database,
    load_config::TokenExpiration,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Argon2Parameters {
    algorithm: String,
    version: u32,
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
}

#[derive(Deserialize)]
struct VerificationCase {
    id: String,
    password: String,
    hash: String,
    expected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workflow {
    password: String,
    stored_hash: String,
    result: String,
    hash_after: String,
    session_count: usize,
    user_count: usize,
    users_before: String,
    user_after: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapWorkflow {
    password: String,
    result: String,
    hash_after: String,
    session_count: usize,
    user_count: usize,
    users_before: String,
    user_after: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    user_id: String,
    auth_method: String,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAuth {
    method: String,
    display_name: String,
    active: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    version: u32,
    current_argon2: Argon2Parameters,
    verification_cases: Vec<VerificationCase>,
    workflows: BTreeMap<String, Workflow>,
    bootstrap_empty_users: BootstrapWorkflow,
    persisted_session: PersistedSession,
    persisted_auth: PersistedAuth,
}

fn fixture() -> GoldenFixture {
    serde_json::from_str(include_str!(
        "../contract/fixtures/password-hash-golden.json"
    ))
    .unwrap()
}

fn database(owner_id: &str, has_owner: bool, hash: Option<&str>) -> Database {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE auth
               (method TEXT PRIMARY KEY, display_name TEXT, extra_data TEXT, active INTEGER);
             CREATE TABLE users
               (id TEXT PRIMARY KEY, user_name TEXT, display_name TEXT, role TEXT,
                enabled INTEGER NOT NULL DEFAULT 1, owner INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE sessions
               (token TEXT PRIMARY KEY, expires_at INTEGER, user_id TEXT, auth_method TEXT);",
        )
        .unwrap();
    if has_owner {
        connection
            .execute(
                "INSERT INTO users (id, user_name, display_name, role, enabled, owner)
                 VALUES (?, '', '', 'ADMIN', 1, 1)",
                [owner_id],
            )
            .unwrap();
    }
    if let Some(hash) = hash {
        connection
            .execute(
                "INSERT INTO auth (method, display_name, extra_data, active)
                 VALUES ('password', 'Password', ?, 1)",
                [hash],
            )
            .unwrap();
    }
    Arc::new(Mutex::new(connection))
}

#[test]
fn rust_matches_typescript_password_hash_vectors() {
    let fixture = fixture();
    assert_eq!(fixture.version, 1);
    for item in &fixture.verification_cases {
        assert_eq!(
            verify_password(&item.password, &item.hash),
            item.expected,
            "{}",
            item.id
        );
    }
}

#[test]
fn fixture_encodes_current_parameters_and_multiple_parsed_costs() {
    let fixture = fixture();
    let parameters = fixture.current_argon2;
    assert_eq!(parameters.algorithm, "argon2id");
    assert_eq!(parameters.version, 19);
    assert_eq!(parameters.memory_cost, 47_104);
    assert_eq!(parameters.time_cost, 1);
    assert_eq!(parameters.parallelism, 1);

    let current = fixture
        .verification_cases
        .iter()
        .find(|item| item.id == "argon2-current-success")
        .unwrap();
    assert!(current.hash.starts_with(&format!(
        "${}$v={}$m={},t={},p={}$",
        parameters.algorithm,
        parameters.version,
        parameters.memory_cost,
        parameters.time_cost,
        parameters.parallelism
    )));
    let alternate = fixture
        .verification_cases
        .iter()
        .find(|item| item.id == "argon2-alternate-parameters-success")
        .unwrap();
    assert!(alternate.hash.contains("$m=19456,t=2,p=1$"));
    assert!(
        fixture
            .verification_cases
            .iter()
            .any(|item| item.hash.starts_with("$2b$10$"))
    );
    assert!(
        fixture
            .verification_cases
            .iter()
            .any(|item| item.hash.starts_with("$2b$04$"))
    );
}

#[test]
fn rust_matches_typescript_login_upgrade_and_persistence_side_effects() {
    let fixture = fixture();
    for (id, workflow) in &fixture.workflows {
        let database = database(
            &fixture.persisted_session.user_id,
            workflow.users_before == "existing-owner",
            Some(&workflow.stored_hash),
        );
        let result = account_db::login_with_password(
            &database,
            Some(&workflow.password),
            &TokenExpiration::Named("never".into()),
        );
        let connection = database.lock().unwrap();
        let stored_auth = connection
            .query_row(
                "SELECT method, display_name, extra_data, active
                 FROM auth WHERE method = 'password'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        let (method, display_name, stored_hash, active) = stored_auth;
        assert_eq!(method, fixture.persisted_auth.method, "{id}");
        assert_eq!(display_name, fixture.persisted_auth.display_name, "{id}");
        assert_eq!(active, fixture.persisted_auth.active, "{id}");
        let session = connection
            .query_row(
                "SELECT token, expires_at, user_id, auth_method
                 FROM sessions WHERE auth_method = 'password'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .unwrap();
        let session_count = connection
            .query_row(
                "SELECT count(*) FROM sessions WHERE auth_method = 'password'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(session_count, workflow.session_count as i64, "{id}");
        let user = connection
            .query_row(
                "SELECT id, user_name, display_name, enabled, owner, role
                 FROM users WHERE user_name = ''",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        let user_count = connection
            .query_row(
                "SELECT count(*) FROM users
                 WHERE user_name = '' AND display_name = '' AND enabled = 1 AND owner = 1 AND role = 'ADMIN'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(user_count, workflow.user_count as i64, "{id}");
        assert_eq!(user.1, "", "{id}");
        assert_eq!(user.2, "", "{id}");
        assert_eq!(user.3, 1, "{id}");
        assert_eq!(user.4, 1, "{id}");
        assert_eq!(user.5, "ADMIN", "{id}");
        if workflow.user_after == "existing-owner" {
            assert_eq!(user.0, fixture.persisted_session.user_id, "{id}");
        }

        if workflow.result == "token" {
            let token = result.unwrap_or_else(|_| panic!("{id}: expected login token"));
            let (persisted_token, expires_at, user_id, auth_method) = session.unwrap();
            assert_eq!(persisted_token, token, "{id}");
            assert_eq!(expires_at, fixture.persisted_session.expires_at, "{id}");
            assert_eq!(user_id, user.0, "{id}");
            assert_eq!(auth_method, fixture.persisted_session.auth_method, "{id}");
        } else {
            assert!(
                matches!(result, Err(AccountError::Reason("invalid-password"))),
                "{id}"
            );
            assert!(session.is_none(), "{id}");
        }

        if workflow.hash_after == "unchanged" {
            assert_eq!(stored_hash, workflow.stored_hash, "{id}");
        } else {
            assert!(
                stored_hash.starts_with("$argon2id$v=19$m=47104,t=1,p=1$"),
                "{id}"
            );
            assert!(verify_password(&workflow.password, &stored_hash), "{id}");
            assert_ne!(stored_hash, workflow.stored_hash, "{id}");
        }
    }
}

#[test]
fn rust_bootstraps_an_empty_users_table_with_an_owner_and_session() {
    let fixture = fixture();
    let workflow = &fixture.bootstrap_empty_users;
    assert_eq!(workflow.users_before, "empty");
    assert_eq!(workflow.user_after, "created-blank-admin-owner");
    assert_eq!(workflow.result, "token");
    assert_eq!(workflow.hash_after, "argon2id-current");
    let database = database(&fixture.persisted_session.user_id, false, None);

    let token = account_db::bootstrap(
        &database,
        &serde_json::json!({ "password": workflow.password }),
        &TokenExpiration::Named("never".into()),
    )
    .unwrap();
    let connection = database.lock().unwrap();
    let user = connection
        .query_row(
            "SELECT id, user_name, display_name, enabled, owner, role
             FROM users WHERE user_name = ''",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(user.1, "");
    assert_eq!(user.2, "");
    assert_eq!(user.3, 1);
    assert_eq!(user.4, 1);
    assert_eq!(user.5, "ADMIN");
    let hash = connection
        .query_row(
            "SELECT extra_data FROM auth WHERE method = 'password'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert!(hash.starts_with("$argon2id$v=19$m=47104,t=1,p=1$"));
    assert!(verify_password(&workflow.password, &hash));
    let session = connection
        .query_row(
            "SELECT token, expires_at, user_id, auth_method FROM sessions WHERE auth_method = 'password'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )
        .unwrap();
    let user_count = connection
        .query_row(
            "SELECT count(*) FROM users
             WHERE user_name = '' AND display_name = '' AND enabled = 1 AND owner = 1 AND role = 'ADMIN'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let session_count = connection
        .query_row(
            "SELECT count(*) FROM sessions WHERE auth_method = 'password'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(user_count, workflow.user_count as i64);
    assert_eq!(session_count, workflow.session_count as i64);
    assert_eq!(
        session,
        (
            token,
            fixture.persisted_session.expires_at,
            user.0,
            fixture.persisted_session.auth_method
        )
    );
}
