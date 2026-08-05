use std::{collections::BTreeMap, fs, path::PathBuf};

use actual_sync_server::{load_config::Config, sync_simple};
use rusqlite::Connection;
use serde::Deserialize;
use uuid::Uuid;

const BEFORE_ALL_MESSAGES: &str = "2025-01-01T00:00:00.000Z";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPaths {
    message_database_pattern: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedRow {
    timestamp: String,
    is_encrypted: i64,
    content_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageState {
    id: String,
    group_id: String,
    sql: Option<String>,
    expected_messages: usize,
    expected_rows: Vec<ExpectedRow>,
    expected_merkle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    stored_paths: StoredPaths,
    message_schema: BTreeMap<String, Vec<String>>,
    message_states: Vec<MessageState>,
}

struct TemporaryRoot(PathBuf);

impl TemporaryRoot {
    fn new(id: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "actual-rust-historical-message-{id}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(path.join("user-files")).unwrap();
        Self(path)
    }
}

impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn fixture() -> GoldenFixture {
    serde_json::from_str(include_str!(
        "../contract/fixtures/historical-sqlite-golden.json"
    ))
    .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn rust_opens_every_shared_historical_message_database_in_isolation() {
    let fixture = fixture();
    assert!(
        fixture
            .message_states
            .iter()
            .any(|state| state.sql.is_none())
    );
    let expected_state_count = fixture.message_states.len();
    let mut roots = Vec::new();
    for state in fixture.message_states {
        let root = TemporaryRoot::new(&state.id);
        assert!(!roots.contains(&root.0));
        roots.push(root.0.clone());
        let user_files = root.0.join("user-files");
        let database_path = root.0.join(
            fixture
                .stored_paths
                .message_database_pattern
                .replace("{groupId}", &state.group_id),
        );
        if let Some(sql) = &state.sql {
            let connection = Connection::open(&database_path).unwrap();
            connection.execute_batch(sql).unwrap();
            for (table, expected) in &fixture.message_schema {
                assert_eq!(
                    schema(&connection, table),
                    *expected,
                    "{}:fixture:{table}",
                    state.id
                );
            }
        }
        let config = Config {
            user_files,
            ..Config::default()
        };

        let (merkle, messages) =
            sync_simple::sync(&config, &[], BEFORE_ALL_MESSAGES, &state.group_id).unwrap();

        assert_eq!(messages.len(), state.expected_messages, "{}", state.id);
        assert_eq!(
            serde_json::to_string(&merkle).unwrap(),
            state.expected_merkle,
            "{}",
            state.id
        );
        let connection =
            Connection::open_with_flags(&database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        for (table, expected) in &fixture.message_schema {
            assert_eq!(
                schema(&connection, table),
                *expected,
                "{}:opened:{table}",
                state.id
            );
        }
        let rows = connection
            .prepare(
                "SELECT timestamp, is_encrypted, content
                 FROM messages_binary ORDER BY timestamp",
            )
            .unwrap()
            .query_map([], |row| {
                Ok(ExpectedRow {
                    timestamp: row.get(0)?,
                    is_encrypted: row.get(1)?,
                    content_hex: hex(&row.get::<_, Vec<u8>>(2)?),
                })
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows.len(), state.expected_rows.len(), "{}", state.id);
        for (actual, expected) in rows.iter().zip(&state.expected_rows) {
            assert_eq!(actual.timestamp, expected.timestamp, "{}", state.id);
            assert_eq!(actual.is_encrypted, expected.is_encrypted, "{}", state.id);
            assert_eq!(actual.content_hex, expected.content_hex, "{}", state.id);
        }
    }
    assert_eq!(roots.len(), expected_state_count);
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
