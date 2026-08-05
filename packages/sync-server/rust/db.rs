use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::Connection;

pub type Database = Arc<Mutex<Connection>>;

pub fn open_database(filename: &Path) -> rusqlite::Result<Connection> {
    Connection::open(filename)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use rusqlite::{ErrorCode, OptionalExtension, params};
    use serde::Deserialize;
    use uuid::Uuid;

    use super::open_database;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        version: usize,
        rows: Vec<ExpectedRow>,
        number_bindings: Vec<NumberBinding>,
        mutation: ExpectedMutations,
        transaction: ExpectedTransactions,
        errors: ExpectedErrors,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedRow {
        id: i64,
        text_value: String,
        number_value: f64,
        nullable_value: Option<String>,
        blob_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NumberBinding {
        id: String,
        source: String,
        rust_binding: RustBinding,
        rust_storage_class: String,
        read_value: String,
        is_negative_zero: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum RustBinding {
        Integer,
        Real,
    }

    #[derive(Debug, PartialEq)]
    struct RollbackSentinel {
        code: u8,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedMutations {
        first_insert: Mutation,
        second_insert: Mutation,
        update: Mutation,
        no_change: Mutation,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Mutation {
        changes: usize,
        insert_id: i64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedTransactions {
        return_value: String,
        after_rollback: Vec<String>,
        after_nested_rollback: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedErrors {
        constraint_code: String,
        invalid_database_code: String,
        locked_code: String,
        invalid_path_code: String,
        read_only_code: String,
    }

    struct TemporaryRoot(PathBuf);

    impl TemporaryRoot {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("actual-rust-db-{label}-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn database(&self) -> PathBuf {
            self.0.join("database.sqlite")
        }
    }

    impl Drop for TemporaryRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../contract/fixtures/db-golden.json")).unwrap()
    }

    fn mutation(
        connection: &rusqlite::Connection,
        sql: &str,
        values: &[&dyn rusqlite::ToSql],
    ) -> Mutation {
        Mutation {
            changes: connection.execute(sql, values).unwrap(),
            insert_id: connection.last_insert_rowid(),
        }
    }

    fn error_code(error: &rusqlite::Error) -> (ErrorCode, i32) {
        match error {
            rusqlite::Error::SqliteFailure(value, _) => (value.code, value.extended_code),
            _ => panic!("expected SQLite error, got {error}"),
        }
    }

    fn error_name((code, extended_code): (ErrorCode, i32)) -> &'static str {
        match (code, extended_code) {
            (ErrorCode::ConstraintViolation, 2067) => "SQLITE_CONSTRAINT_UNIQUE",
            (ErrorCode::NotADatabase, _) => "SQLITE_NOTADB",
            (ErrorCode::DatabaseBusy, _) => "SQLITE_BUSY",
            (ErrorCode::CannotOpen, _) => "SQLITE_CANTOPEN",
            (ErrorCode::ReadOnly, _) => "SQLITE_READONLY",
            _ => panic!("unexpected SQLite error code: {code:?}/{extended_code}"),
        }
    }

    #[test]
    fn matches_shared_query_binding_mutation_and_persistence_fixture() {
        let expected = fixture();
        assert_eq!(expected.version, 1);
        let root = TemporaryRoot::new("operations");
        let path = root.database();
        let connection = open_database(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE values_table (
                    id INTEGER PRIMARY KEY,
                    text_value TEXT NOT NULL,
                    number_value REAL,
                    nullable_value TEXT,
                    blob_value BLOB
                 );
                 CREATE TABLE exec_marker (value TEXT);
                 INSERT INTO exec_marker VALUES ('batch-one'), ('batch-two');",
            )
            .unwrap();

        assert_eq!(
            mutation(
                &connection,
                "INSERT INTO values_table(text_value, number_value, nullable_value, blob_value) VALUES (?, ?, ?, ?)",
                params!["alpha", 7, Option::<String>::None, vec![0_u8, 1, 127, 255]],
            ),
            expected.mutation.first_insert
        );
        assert_eq!(
            mutation(
                &connection,
                "INSERT INTO values_table(text_value, number_value, nullable_value, blob_value) VALUES (?, ?, ?, ?)",
                params!["", -1.25, Option::<String>::None, Vec::<u8>::new()],
            ),
            expected.mutation.second_insert
        );

        let rows = connection
            .prepare(
                "SELECT id, text_value, number_value, nullable_value,
                        lower(hex(blob_value))
                   FROM values_table ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok(ExpectedRow {
                    id: row.get(0)?,
                    text_value: row.get(1)?,
                    number_value: row.get(2)?,
                    nullable_value: row.get(3)?,
                    blob_hex: row.get(4)?,
                })
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, expected.rows);
        let missing: Option<i64> = connection
            .query_row("SELECT id FROM values_table WHERE id = ?", [99], |row| {
                row.get(0)
            })
            .optional()
            .unwrap();
        assert_eq!(missing, None);
        let marker_count: i64 = connection
            .query_row("SELECT count(*) FROM exec_marker", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker_count, 2);
        assert_eq!(
            mutation(
                &connection,
                "UPDATE values_table SET text_value = ?",
                params!["updated"],
            ),
            expected.mutation.update
        );
        assert_eq!(
            mutation(
                &connection,
                "UPDATE values_table SET text_value = ? WHERE id = ?",
                params!["missing", 99],
            ),
            expected.mutation.no_change
        );
        connection.close().unwrap();

        let reopened = open_database(&path).unwrap();
        let values = reopened
            .prepare("SELECT text_value FROM values_table ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(values, ["updated", "updated"]);
    }

    #[test]
    fn records_intentional_rust_integer_and_real_binding_types() {
        let fixture = fixture();
        let connection = open_database(Path::new(":memory:")).unwrap();
        for vector in fixture.number_bindings {
            let (storage_class, read_value, is_negative_zero) = match vector.rust_binding {
                RustBinding::Integer => {
                    let value = vector.source.parse::<i64>().unwrap();
                    let (storage_class, read_value): (String, i64) = connection
                        .query_row("SELECT typeof(?), ?", params![value, value], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })
                        .unwrap();
                    (storage_class, read_value.to_string(), false)
                }
                RustBinding::Real => {
                    let value = vector.source.parse::<f64>().unwrap();
                    let (storage_class, read_value): (String, f64) = connection
                        .query_row("SELECT typeof(?), ?", params![value, value], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })
                        .unwrap();
                    (
                        storage_class,
                        if read_value == 0.0 {
                            "0".into()
                        } else {
                            read_value.to_string()
                        },
                        read_value.is_sign_negative() && read_value == 0.0,
                    )
                }
            };
            assert_eq!(storage_class, vector.rust_storage_class, "{}", vector.id);
            assert_eq!(read_value, vector.read_value, "{}", vector.id);
            assert_eq!(is_negative_zero, vector.is_negative_zero, "{}", vector.id);
        }
    }

    #[test]
    fn matches_return_rollback_and_nested_savepoint_behavior() {
        let expected = fixture().transaction;
        let root = TemporaryRoot::new("transactions");
        let mut connection = open_database(&root.database()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE values_table (id INTEGER PRIMARY KEY, text_value TEXT);
                 INSERT INTO values_table(text_value) VALUES ('updated'), ('updated');",
            )
            .unwrap();

        let return_value = {
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO values_table(text_value) VALUES (?)",
                    ["committed"],
                )
                .unwrap();
            transaction.commit().unwrap();
            expected.return_value.clone()
        };
        assert_eq!(return_value, expected.return_value);
        let mut rollback = || {
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO values_table(text_value) VALUES (?)",
                    ["rolled-back"],
                )
                .unwrap();
            Err(RollbackSentinel { code: 17 })
        };
        let result: Result<(), RollbackSentinel> = rollback();
        assert_eq!(result, Err(RollbackSentinel { code: 17 }));
        assert_eq!(text_values(&connection), expected.after_rollback);

        {
            let mut transaction = connection.transaction().unwrap();
            transaction
                .execute("INSERT INTO values_table(text_value) VALUES (?)", ["outer"])
                .unwrap();
            {
                let savepoint = transaction.savepoint().unwrap();
                savepoint
                    .execute("INSERT INTO values_table(text_value) VALUES (?)", ["inner"])
                    .unwrap();
            }
            transaction.commit().unwrap();
        }
        assert_eq!(text_values(&connection), expected.after_nested_rollback);
    }

    fn text_values(connection: &rusqlite::Connection) -> Vec<String> {
        connection
            .prepare("SELECT text_value FROM values_table ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn propagates_constraint_locking_invalid_file_and_path_errors() {
        let expected = fixture().errors;
        let root = TemporaryRoot::new("errors");
        let path = root.database();
        let first = open_database(&path).unwrap();
        first
            .execute_batch(
                "CREATE TABLE values_table (value TEXT UNIQUE);
                 INSERT INTO values_table VALUES ('duplicate');",
            )
            .unwrap();
        let error = first
            .execute("INSERT INTO values_table VALUES (?)", ["duplicate"])
            .unwrap_err();
        assert_eq!(error_name(error_code(&error)), expected.constraint_code);

        let second = open_database(&path).unwrap();
        second
            .busy_timeout(std::time::Duration::from_millis(1))
            .unwrap();
        first.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let error = second
            .execute("INSERT INTO values_table VALUES (?)", ["locked"])
            .unwrap_err();
        assert_eq!(error_name(error_code(&error)), expected.locked_code);
        first.execute_batch("ROLLBACK").unwrap();

        let invalid_path = root.0.join("invalid.sqlite");
        fs::write(&invalid_path, "not a sqlite database").unwrap();
        let invalid = open_database(&invalid_path).unwrap();
        let error = invalid
            .query_row("SELECT * FROM sqlite_master", [], |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            error_name(error_code(&error)),
            expected.invalid_database_code
        );
        let error = open_database(&root.0).unwrap_err();
        assert_eq!(error_name(error_code(&error)), expected.invalid_path_code);

        let read_only_path = root.0.join("read-only.sqlite");
        let writable = open_database(&read_only_path).unwrap();
        writable
            .execute_batch(
                "CREATE TABLE persisted (value TEXT);
                 INSERT INTO persisted VALUES ('readable');",
            )
            .unwrap();
        writable.close().unwrap();
        let writable_permissions = fs::metadata(&read_only_path).unwrap().permissions();
        let mut read_only_permissions = writable_permissions.clone();
        read_only_permissions.set_readonly(true);
        fs::set_permissions(&read_only_path, read_only_permissions).unwrap();
        let read_only = open_database(&read_only_path).unwrap();
        assert_eq!(
            read_only
                .query_row("SELECT value FROM persisted", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "readable"
        );
        let error = read_only
            .execute("INSERT INTO persisted VALUES (?)", ["no"])
            .unwrap_err();
        assert_eq!(error_name(error_code(&error)), expected.read_only_code);
        read_only.close().unwrap();
        fs::set_permissions(&read_only_path, writable_permissions).unwrap();
    }
}
