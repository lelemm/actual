use std::{
    collections::BTreeMap,
    fs,
    net::{IpAddr, Ipv4Addr},
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Direction, TITLES, run, run_direction};
use crate::{db::open_database, load_config::Config};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoricalGolden {
    version: usize,
    migration_titles: Vec<String>,
    account_base_sql: String,
    account_steps: Vec<AccountStep>,
    current_account_tables: Vec<String>,
    current_account_schema: BTreeMap<String, Vec<String>>,
    state_variants: Vec<StateVariant>,
    rollback: RollbackFixture,
    downgrade_states: Vec<DowngradeState>,
    downgrade_rollback: DowngradeRollback,
}

#[derive(Deserialize)]
struct AccountStep {
    completed: usize,
    sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateVariant {
    id: String,
    completed: usize,
    format: StateFormat,
    title: Option<String>,
    result: StateResult,
    expected_error: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StateFormat {
    Absent,
    Empty,
    LegacyPosition,
    UnknownUnrun,
    UnknownRun,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StateResult {
    Success,
    MissingMigration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DowngradeState {
    title: String,
    directories_exist: bool,
    account_database_exists: bool,
    tables: Vec<String>,
    schema: BTreeMap<String, Vec<String>>,
    rows: BTreeMap<String, Vec<Vec<Value>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DowngradeRollback {
    conflict_sql: String,
    expected_last_run: String,
    expected_tables: Vec<String>,
    expected_conflict_schema: Vec<String>,
    expected_rows: BTreeMap<String, Vec<Vec<Value>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackFixture {
    completed: usize,
    conflict_sql: String,
    expected_last_run: String,
    expected_sessions_columns: Vec<String>,
    expected_user_access_columns: Vec<String>,
}

fn golden() -> HistoricalGolden {
    serde_json::from_str(include_str!(
        "../../../contract/fixtures/historical-sqlite-golden.json"
    ))
    .unwrap()
}

struct HistoricalFixture {
    root: PathBuf,
    config: Config,
}

impl HistoricalFixture {
    fn at(completed: usize) -> Self {
        let root = std::env::temp_dir().join(format!(
            "actual-rust-historical-migration-{}-{completed}",
            Uuid::new_v4()
        ));
        let config = Config {
            address: (IpAddr::V4(Ipv4Addr::LOCALHOST), 0).into(),
            data_dir: root.clone(),
            server_files: root.join("server-files"),
            user_files: root.join("user-files"),
            mode: "development".into(),
            ..Config::default()
        };
        fs::create_dir_all(&root).unwrap();
        if completed >= 1 {
            fs::create_dir_all(&config.server_files).unwrap();
            fs::create_dir_all(&config.user_files).unwrap();
        }

        if completed > 1 {
            let connection = open_database(&config.server_files.join("account.sqlite")).unwrap();
            create_historical_database(&connection, completed);
        }
        write_current_state(&root.join(".migrate"), completed);

        Self { root, config }
    }

    fn connection(&self) -> Connection {
        open_database(&self.config.server_files.join("account.sqlite")).unwrap()
    }
}

impl Drop for HistoricalFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn upgrades_every_historical_schema_without_changing_stored_data() {
    assert_eq!(golden().version, 2);
    assert_eq!(golden().migration_titles, TITLES);
    for completed in 0..=TITLES.len() {
        let fixture = HistoricalFixture::at(completed);

        run(&fixture.config).unwrap();

        assert_ne!(fixture.config.server_files, fixture.config.user_files);
        assert!(fixture.config.server_files.is_dir());
        assert!(fixture.config.user_files.is_dir());
        assert!(fixture.config.server_files.join("account.sqlite").is_file());
        assert_current_schema(&fixture.connection());
        assert_preserved_data(&fixture.connection(), completed);
        assert_current_state(&fixture.root.join(".migrate"));
    }
}

#[test]
fn matches_every_shared_migration_state_variant() {
    for variant in golden().state_variants {
        let fixture = HistoricalFixture::at(variant.completed);
        let state_path = fixture.root.join(".migrate");
        match variant.format {
            StateFormat::Absent => fs::remove_file(&state_path).unwrap(),
            StateFormat::Empty => fs::write(&state_path, []).unwrap(),
            StateFormat::LegacyPosition => fs::write(
                &state_path,
                serde_json::to_vec_pretty(&json!({
                    "pos": variant.completed,
                    "migrations": TITLES[..variant.completed]
                        .iter()
                        .map(|title| json!({ "title": title, "timestamp": null }))
                        .collect::<Vec<_>>(),
                }))
                .unwrap(),
            )
            .unwrap(),
            StateFormat::UnknownUnrun | StateFormat::UnknownRun => {
                let mut state: Value =
                    serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
                state["migrations"].as_array_mut().unwrap().push(json!({
                    "title": variant.title.as_deref().unwrap(),
                    "timestamp": matches!(variant.format, StateFormat::UnknownRun).then_some(42),
                }));
                fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
            }
        }
        let before = fs::read(&state_path).ok();

        match variant.result {
            StateResult::Success => {
                run(&fixture.config).unwrap();
                assert_current_schema(&fixture.connection());
                assert_preserved_data(&fixture.connection(), variant.completed);
                assert_current_state(&state_path);
            }
            StateResult::MissingMigration => {
                let error = run(&fixture.config).unwrap_err();
                assert_eq!(
                    error.to_string(),
                    variant.expected_error.unwrap(),
                    "{}",
                    variant.id
                );
                assert_eq!(fs::read(&state_path).ok(), before, "{}", variant.id);
            }
        }
    }
}

#[test]
fn rolls_back_a_failed_transactional_migration_without_advancing_state() {
    let rollback = golden().rollback;
    let fixture = HistoricalFixture::at(rollback.completed);
    fixture
        .connection()
        .execute_batch(&rollback.conflict_sql)
        .unwrap();

    assert!(run(&fixture.config).is_err());

    let connection = fixture.connection();
    assert!(!table_exists(&connection, "users"));
    assert_eq!(
        columns(&connection, "user_access"),
        rollback.expected_user_access_columns
    );
    assert_eq!(
        columns(&connection, "sessions"),
        rollback.expected_sessions_columns,
        "ALTER TABLE statements must roll back with the failed migration"
    );
    let state: Value =
        serde_json::from_slice(&fs::read(fixture.root.join(".migrate")).unwrap()).unwrap();
    assert_eq!(state["lastRun"], rollback.expected_last_run);
    assert_eq!(
        state["migrations"].as_array().unwrap().len(),
        rollback.completed
    );
}

#[test]
fn matches_every_shared_intermediate_downgrade_state() {
    let golden = golden();
    assert_eq!(
        golden
            .downgrade_states
            .iter()
            .map(|state| state.title.as_str())
            .collect::<Vec<_>>(),
        TITLES.iter().rev().copied().collect::<Vec<_>>()
    );
    let fixture = HistoricalFixture::at(TITLES.len());
    for state in &golden.downgrade_states {
        write_single_migration_state(&fixture.root.join(".migrate"), &state.title);
        run_direction(&fixture.config, Direction::Down).unwrap();
        assert_downgrade_state(&fixture, state);
    }
}

#[test]
fn rolls_back_a_failing_transactional_downgrade_without_advancing_its_state() {
    let golden = golden();
    let fixture = HistoricalFixture::at(TITLES.len());
    fixture
        .connection()
        .execute_batch(&golden.downgrade_rollback.conflict_sql)
        .unwrap();

    assert!(run_direction(&fixture.config, Direction::Down).is_err());

    let connection = fixture.connection();
    assert_eq!(
        tables(&connection),
        golden.downgrade_rollback.expected_tables
    );
    assert_eq!(
        schema(&connection, "sessions"),
        golden.current_account_schema["sessions"]
    );
    assert_eq!(
        schema(&connection, "user_access"),
        golden.current_account_schema["user_access"]
    );
    assert_eq!(
        schema(&connection, "sessions_backup"),
        golden.downgrade_rollback.expected_conflict_schema
    );
    assert_eq!(
        golden
            .downgrade_rollback
            .expected_rows
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        golden.downgrade_rollback.expected_tables
    );
    for (table, expected) in &golden.downgrade_rollback.expected_rows {
        assert_eq!(
            rows(&connection, table, expected.first().map_or(0, Vec::len)),
            *expected,
            "rollback:{table}"
        );
    }
    let state: Value =
        serde_json::from_slice(&fs::read(fixture.root.join(".migrate")).unwrap()).unwrap();
    assert_eq!(
        state["lastRun"],
        golden.downgrade_rollback.expected_last_run
    );
    let expected_run = TITLES
        .iter()
        .take_while(|title| **title != golden.downgrade_rollback.expected_last_run)
        .count()
        + 1;
    assert_eq!(
        state["migrations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| !entry["timestamp"].is_null())
            .count(),
        expected_run
    );
}

fn write_single_migration_state(path: &Path, title: &str) {
    fs::write(
        path,
        serde_json::to_vec_pretty(&json!({
            "lastRun": title,
            "migrations": TITLES.map(|migration_title| json!({
                "title": migration_title,
                "timestamp": (migration_title == title).then_some(1),
            })),
        }))
        .unwrap(),
    )
    .unwrap();
}

fn assert_downgrade_state(fixture: &HistoricalFixture, state: &DowngradeState) {
    assert_eq!(
        fixture.config.server_files.exists(),
        state.directories_exist,
        "{}:server-files",
        state.title
    );
    assert_eq!(
        fixture.config.user_files.exists(),
        state.directories_exist,
        "{}:user-files",
        state.title
    );
    let database_path = fixture.config.server_files.join("account.sqlite");
    assert_eq!(
        database_path.exists(),
        state.account_database_exists,
        "{}:account.sqlite",
        state.title
    );
    if !state.account_database_exists {
        return;
    }

    let connection = fixture.connection();
    assert_eq!(tables(&connection), state.tables, "{}:tables", state.title);
    for (table, expected) in &state.schema {
        assert_eq!(
            schema(&connection, table),
            *expected,
            "{}:{table}",
            state.title
        );
    }
    assert_eq!(
        state.rows.keys().cloned().collect::<Vec<_>>(),
        state.tables,
        "{}:row tables",
        state.title
    );
    for (table, expected) in &state.rows {
        assert_eq!(
            rows(&connection, table, state.schema[table].len()),
            *expected,
            "{}:{table}:rows",
            state.title
        );
    }
}

fn write_current_state(path: &Path, completed: usize) {
    let migrations = TITLES[..completed]
        .iter()
        .enumerate()
        .map(|(index, title)| json!({ "title": title, "timestamp": index + 1 }))
        .collect::<Vec<_>>();
    fs::write(
        path,
        serde_json::to_vec_pretty(&json!({
            "lastRun": completed.checked_sub(1).map(|index| TITLES[index]),
            "migrations": migrations,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn create_historical_database(connection: &Connection, completed: usize) {
    let golden = golden();
    connection.execute_batch(&golden.account_base_sql).unwrap();
    for step in golden
        .account_steps
        .iter()
        .filter(|step| step.completed <= completed)
    {
        connection.execute_batch(&step.sql).unwrap();
    }
}

fn assert_current_schema(connection: &Connection) {
    let golden = golden();
    let tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(tables, golden.current_account_tables);
    for (table, expected) in golden.current_account_schema {
        assert_eq!(schema(connection, &table), expected, "{table}");
    }

    assert_eq!(
        columns(connection, "auth"),
        ["method", "display_name", "extra_data", "active"]
    );
    assert_eq!(
        columns(connection, "sessions"),
        ["token", "expires_at", "user_id", "auth_method"]
    );
    assert_eq!(
        columns(connection, "files"),
        [
            "id",
            "group_id",
            "sync_version",
            "encrypt_meta",
            "encrypt_keyid",
            "encrypt_salt",
            "encrypt_test",
            "deleted",
            "name",
            "owner",
        ]
    );
    assert_eq!(columns(connection, "secrets"), ["name", "value"]);
    assert_eq!(
        columns(connection, "pending_openid_requests"),
        ["state", "code_verifier", "return_url", "expiry_time"]
    );
    assert_eq!(
        columns(connection, "users"),
        [
            "id",
            "user_name",
            "display_name",
            "role",
            "enabled",
            "owner"
        ]
    );
    assert_eq!(columns(connection, "user_access"), ["user_id", "file_id"]);
    assert_eq!(columns(connection, "server_prefs"), ["key", "value"]);

    assert_eq!(
        schema(connection, "auth"),
        [
            "method|TEXT|0||1",
            "display_name|TEXT|0||0",
            "extra_data|TEXT|0||0",
            "active|INTEGER|0||0"
        ]
    );
    assert_eq!(
        schema(connection, "sessions"),
        [
            "token|TEXT|0||1",
            "expires_at|INTEGER|0||0",
            "user_id|TEXT|0||0",
            "auth_method|TEXT|0||0"
        ]
    );
    assert_eq!(
        schema(connection, "files"),
        [
            "id|TEXT|0||1",
            "group_id|TEXT|0||0",
            "sync_version|SMALLINT|0||0",
            "encrypt_meta|TEXT|0||0",
            "encrypt_keyid|TEXT|0||0",
            "encrypt_salt|TEXT|0||0",
            "encrypt_test|TEXT|0||0",
            "deleted|BOOLEAN|0|FALSE|0",
            "name|TEXT|0||0",
            "owner|TEXT|0||0",
        ]
    );
    assert_eq!(
        schema(connection, "secrets"),
        ["name|TEXT|0||1", "value|BLOB|0||0"]
    );
    assert_eq!(
        schema(connection, "pending_openid_requests"),
        [
            "state|TEXT|0||1",
            "code_verifier|TEXT|0||0",
            "return_url|TEXT|0||0",
            "expiry_time|INTEGER|0||0"
        ]
    );
    assert_eq!(
        schema(connection, "users"),
        [
            "id|TEXT|0||1",
            "user_name|TEXT|0||0",
            "display_name|TEXT|0||0",
            "role|TEXT|0||0",
            "enabled|INTEGER|1|1|0",
            "owner|INTEGER|1|0|0",
        ]
    );
    assert_eq!(
        schema(connection, "user_access"),
        ["user_id|TEXT|0||1", "file_id|TEXT|0||2"]
    );
    assert_eq!(
        schema(connection, "server_prefs"),
        ["key|TEXT|1||1", "value|TEXT|0||0"]
    );

    let foreign_keys = connection
        .prepare("PRAGMA foreign_key_list(user_access)")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        foreign_keys,
        [
            ("files".into(), "file_id".into(), "id".into()),
            ("users".into(), "user_id".into(), "id".into()),
        ]
    );
}

fn assert_preserved_data(connection: &Connection, completed: usize) {
    if completed <= 1 {
        return;
    }

    let password = connection
        .query_row(
            "SELECT display_name, extra_data, active FROM auth WHERE method = 'password'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        password,
        ("Password".into(), "legacy-password-hash".into(), 1)
    );

    let admin_id = connection
        .query_row(
            "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    let session = connection
        .query_row(
            "SELECT expires_at, user_id, auth_method FROM sessions WHERE token = 'legacy-session'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(session, (-1, admin_id.clone(), "password".into()));

    let file = connection
        .query_row(
            "SELECT group_id, sync_version, encrypt_meta, encrypt_keyid,
                    encrypt_salt, encrypt_test, deleted, name, owner
               FROM files WHERE id = 'file-id'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        file,
        (
            "group-id".into(),
            7,
            "encrypt-meta".into(),
            "encrypt-key-id".into(),
            "encrypt-salt".into(),
            "encrypt-test".into(),
            0,
            "Budget".into(),
            admin_id.clone(),
        )
    );

    if completed >= 3 {
        let secret_id = connection
            .query_row(
                "SELECT value FROM secrets WHERE name = 'gocardless_secretId'",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .unwrap();
        let secret_key = connection
            .query_row(
                "SELECT value FROM secrets WHERE name = 'gocardless_secretKey'",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .unwrap();
        assert_eq!(secret_id, [0, 1, 127, 128, 255]);
        assert_eq!(secret_key, [255, 0, 42]);
    }

    let openid_request = connection
        .query_row(
            "SELECT code_verifier, return_url, expiry_time
               FROM pending_openid_requests WHERE state = 'openid-state'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .unwrap();
    assert_eq!(
        openid_request,
        (completed >= 5).then(|| (
            "verifier".into(),
            "actual://return".into(),
            4_102_444_800_000
        ))
    );

    let access_count = connection
        .query_row(
            "SELECT COUNT(*) FROM user_access WHERE user_id = ? AND file_id = 'file-id'",
            [&admin_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(access_count, i64::from(completed >= 6));

    let prefs = connection
        .query_row(
            "SELECT value FROM server_prefs WHERE key = 'prefs-key'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap();
    assert_eq!(prefs, (completed >= 7).then(|| "{\"enabled\":true}".into()));
}

fn assert_current_state(path: &Path) {
    let state: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(state["lastRun"], TITLES[TITLES.len() - 1]);
    let migrations = state["migrations"].as_array().unwrap();
    assert_eq!(migrations.len(), TITLES.len());
    for (entry, title) in migrations.iter().zip(TITLES) {
        assert_eq!(entry["title"], title);
        assert!(entry["timestamp"].as_u64().is_some());
    }
}

fn columns(connection: &Connection, table: &str) -> Vec<String> {
    connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn tables(connection: &Connection) -> Vec<String> {
    connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn rows(connection: &Connection, table: &str, column_count: usize) -> Vec<Vec<Value>> {
    let order = (1..=column_count)
        .map(|index| index.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
        .unwrap();
    assert_eq!(statement.column_count(), column_count, "{table}:columns");
    let mut query = statement.query([]).unwrap();
    let mut result = Vec::new();
    while let Some(row) = query.next().unwrap() {
        result.push(
            (0..column_count)
                .map(|index| match row.get_ref(index).unwrap() {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(value) => json!(value),
                    rusqlite::types::ValueRef::Real(value) => json!(value),
                    rusqlite::types::ValueRef::Text(value) => {
                        json!(std::str::from_utf8(value).unwrap())
                    }
                    rusqlite::types::ValueRef::Blob(value) => {
                        json!({ "blobHex": bytes_to_hex(value) })
                    }
                })
                .collect(),
        );
    }
    result
}

fn schema(connection: &Connection, table: &str) -> Vec<String> {
    connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap()
        .query_map([], |row| {
            Ok(format!(
                "{}|{}|{}|{}|{}",
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, i64>(5)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            [table],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
