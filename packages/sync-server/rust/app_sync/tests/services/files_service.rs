use rusqlite::{Connection, params};
use serde_json::json;

use crate::app_sync::{
    errors::FileError,
    services::files_service::{self, File, FileUpdate, SqliteText},
};
use crate::util::paths::{FileId, GroupId};

fn database() -> Connection {
    let database = Connection::open_in_memory().unwrap();
    database
        .execute_batch(
            "CREATE TABLE users
               (id TEXT PRIMARY KEY, user_name TEXT, display_name TEXT, role TEXT,
                enabled INTEGER NOT NULL DEFAULT 1, owner INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE files
               (id TEXT PRIMARY KEY, group_id TEXT, sync_version SMALLINT, encrypt_meta TEXT,
                encrypt_keyid TEXT, encrypt_salt TEXT, encrypt_test TEXT,
                deleted BOOLEAN DEFAULT FALSE, name TEXT, owner TEXT);
             CREATE TABLE user_access
               (user_id TEXT, file_id TEXT, PRIMARY KEY (user_id, file_id));
             INSERT INTO users (id, role) VALUES ('genericAdmin', 'ADMIN'), ('genericUser', 'USER');",
        )
        .unwrap();
    database
}

fn toy_file(owner: Option<&str>) -> File {
    File {
        id: FileId::new("1"),
        group_id: Some(GroupId::new("group1")),
        sync_version: Some(1),
        name: Some("file1".into()),
        encrypt_meta: Some(r#"{"key":"value"}"#.into()),
        encrypt_salt: Some("salt".into()),
        encrypt_test: Some("test".into()),
        encrypt_key_id: Some("keyid".into()),
        deleted: false,
        owner: owner.map(str::to_owned),
    }
}

#[test]
fn get_returns_file_and_rejects_deleted_or_missing() {
    let database = database();
    files_service::set(&database, &toy_file(None)).unwrap();
    let file_id = FileId::new("1");
    let file = files_service::get(&database, &file_id).unwrap();
    assert_eq!(file.name.as_deref(), Some("file1"));
    database
        .execute("UPDATE files SET deleted = 1", [])
        .unwrap();
    assert!(matches!(
        files_service::get(&database, &file_id),
        Err(FileError::NotFound { .. })
    ));
    assert!(matches!(
        files_service::get(&database, &FileId::new("missing")),
        Err(FileError::NotFound { .. })
    ));
}

#[test]
fn set_preserves_deleted_and_nullable_defaults() {
    let database = database();
    for (id, deleted) in [("active", false), ("deleted", true)] {
        let file = File {
            id: FileId::new(id),
            group_id: Some(GroupId::new("group2")),
            sync_version: Some(1),
            name: Some("file2".into()),
            encrypt_meta: Some(r#"{"key":"value2"}"#.into()),
            encrypt_salt: None,
            encrypt_test: None,
            encrypt_key_id: None,
            deleted,
            owner: None,
        };
        files_service::set(&database, &file).unwrap();
        let raw_deleted: i64 = database
            .query_row("SELECT deleted FROM files WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw_deleted != 0, deleted);
    }
}

#[test]
fn find_respects_admin_access_user_access_and_limit() {
    let database = database();
    files_service::set(&database, &toy_file(Some("genericUser"))).unwrap();
    let mut second = toy_file(Some("genericAdmin"));
    second.id = FileId::new("2");
    files_service::set(&database, &second).unwrap();
    assert_eq!(
        files_service::find(&database, "genericAdmin")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        files_service::find_with_limit(&database, "genericAdmin", 1)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        files_service::find(&database, "genericUser").unwrap().len(),
        1
    );
    database
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES ('2', 'genericUser')",
            [],
        )
        .unwrap();
    assert_eq!(
        files_service::find(&database, "genericUser").unwrap().len(),
        2
    );
}

#[test]
fn update_distinguishes_omitted_fields_from_explicit_nulls() {
    let database = database();
    files_service::set(&database, &toy_file(None)).unwrap();
    let file_id = FileId::new("1");
    let group_id = GroupId::new("updatedGroup1");
    let updated = files_service::update(
        &database,
        &file_id,
        &FileUpdate {
            name: Some(Some(SqliteText::Text("updatedFile1"))),
            group_id: Some(Some(&group_id)),
            encrypt_salt: Some(Some(SqliteText::Text("updatedSalt"))),
            encrypt_test: Some(Some(SqliteText::Text("updatedTest"))),
            encrypt_key_id: Some(Some(SqliteText::Text("updatedKeyId"))),
            encrypt_meta: Some(Some(r#"{"key":"updatedValue"}"#)),
            sync_version: Some(Some(2)),
            deleted: Some(true),
        },
    )
    .unwrap();
    assert_eq!(updated.name.as_deref(), Some("updatedFile1"));
    assert_eq!(
        updated.group_id.as_ref().map(GroupId::as_str),
        Some("updatedGroup1")
    );
    assert!(updated.deleted);

    let unchanged = files_service::update(&database, &file_id, &FileUpdate::default()).unwrap();
    assert_eq!(unchanged.name.as_deref(), Some("updatedFile1"));
    assert_eq!(
        unchanged.group_id.as_ref().map(GroupId::as_str),
        Some("updatedGroup1")
    );
    assert_eq!(unchanged.encrypt_salt.as_deref(), Some("updatedSalt"));
    assert_eq!(unchanged.encrypt_test.as_deref(), Some("updatedTest"));
    assert_eq!(unchanged.encrypt_key_id.as_deref(), Some("updatedKeyId"));
    assert_eq!(
        unchanged.encrypt_meta.as_deref(),
        Some(r#"{"key":"updatedValue"}"#)
    );
    assert_eq!(unchanged.sync_version, Some(2));
    assert!(unchanged.deleted);

    let cleared = files_service::update(
        &database,
        &file_id,
        &FileUpdate {
            name: Some(None),
            group_id: Some(None),
            encrypt_salt: Some(None),
            encrypt_test: Some(None),
            encrypt_key_id: Some(None),
            encrypt_meta: Some(None),
            sync_version: Some(None),
            ..FileUpdate::default()
        },
    )
    .unwrap();
    assert_eq!(cleared.group_id, None);
    assert_eq!(cleared.name, None);
    assert_eq!(cleared.encrypt_salt, None);
    assert_eq!(cleared.encrypt_test, None);
    assert_eq!(cleared.encrypt_key_id, None);
    assert_eq!(cleared.encrypt_meta, None);
    assert_eq!(cleared.sync_version, None);
    assert!(cleared.deleted);
}

#[test]
fn update_and_validation_preserve_source_generic_error_messages_and_details() {
    let database = database();
    let missing = FileId::new("missing");
    assert_generic(
        files_service::update(
            &database,
            &missing,
            &FileUpdate {
                name: Some(Some(SqliteText::Text("name"))),
                ..FileUpdate::default()
            },
        )
        .unwrap_err(),
        "Could not update File",
        json!({ "id": "missing" }),
    );
    assert_generic(
        files_service::update(&database, &missing, &FileUpdate::default()).unwrap_err(),
        "File not found",
        json!({ "id": "missing" }),
    );

    database
        .execute(
            "INSERT INTO files (id, group_id, deleted) VALUES (?, ?, 0)",
            params!["invalid@file", "group"],
        )
        .unwrap();
    assert_generic(
        files_service::find(&database, "genericAdmin").unwrap_err(),
        "Invalid file ID",
        json!({ "fileId": "invalid@file" }),
    );
    database.execute("DELETE FROM files", []).unwrap();
    database
        .execute(
            "INSERT INTO files (id, group_id, deleted) VALUES (?, ?, 0)",
            params!["valid-file", "invalid@group"],
        )
        .unwrap();
    assert_generic(
        files_service::find(&database, "genericAdmin").unwrap_err(),
        "Invalid group ID",
        json!({ "groupId": "invalid@group" }),
    );
}

fn assert_generic(error: FileError, expected_message: &str, expected_details: serde_json::Value) {
    match error {
        FileError::Generic { message, details } => {
            assert_eq!(message, expected_message);
            assert_eq!(details, expected_details);
        }
        error => panic!("expected generic file error, got {error:?}"),
    }
}

#[test]
fn access_list_contains_shared_users_and_owner() {
    let database = database();
    files_service::set(&database, &toy_file(Some("genericAdmin"))).unwrap();
    database
        .execute(
            "INSERT INTO user_access (file_id, user_id) VALUES (?, ?)",
            params!["1", "genericUser"],
        )
        .unwrap();
    let access = files_service::find_users_with_access(&database, &FileId::new("1")).unwrap();
    assert_eq!(access.len(), 2);
    assert!(access.iter().any(|entry| entry.user_id == "genericAdmin"));
    assert!(access.iter().any(|entry| entry.user_id == "genericUser"));
}
