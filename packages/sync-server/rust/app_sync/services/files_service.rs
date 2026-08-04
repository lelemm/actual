use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::{
    app_sync::errors::FileError,
    util::paths::{is_valid_file_id, is_valid_group_id},
};

#[derive(Clone, Debug)]
pub struct File {
    pub id: String,
    pub name: Option<String>,
    pub group_id: Option<String>,
    pub encrypt_salt: Option<String>,
    pub encrypt_test: Option<String>,
    pub encrypt_key_id: Option<String>,
    pub encrypt_meta: Option<String>,
    pub sync_version: Option<i64>,
    pub deleted: bool,
    pub owner: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccess {
    pub user_id: String,
    pub display_name: Option<String>,
    pub user_name: Option<String>,
}

pub fn get(connection: &Connection, file_id: &str) -> Result<File, FileError> {
    if !is_valid_file_id(file_id) {
        return Err(FileError::InvalidId);
    }
    let file = connection
        .query_row("SELECT * FROM files WHERE id = ?", [file_id], row_to_file)
        .optional()?;
    match file {
        Some(file) if !file.deleted => validate(file),
        _ => Err(FileError::NotFound),
    }
}

pub fn set(connection: &Connection, file: &File) -> Result<(), FileError> {
    connection.execute(
        "INSERT INTO files
         (id, group_id, sync_version, name, encrypt_meta, encrypt_salt,
          encrypt_test, encrypt_keyid, deleted, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            file.id,
            file.group_id,
            file.sync_version,
            file.name,
            file.encrypt_meta,
            file.encrypt_salt,
            file.encrypt_test,
            file.encrypt_key_id,
            i64::from(file.deleted),
            file.owner,
        ],
    )?;
    Ok(())
}

pub fn find(connection: &Connection, user_id: &str) -> Result<Vec<File>, FileError> {
    let is_admin = connection
        .query_row("SELECT role FROM users WHERE id = ?", [user_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .as_deref()
        == Some("ADMIN");
    let sql = if is_admin {
        "SELECT * FROM files WHERE deleted = 0 LIMIT ?"
    } else {
        "SELECT files.* FROM files
         WHERE files.owner = ?1 and deleted = 0
         UNION
         SELECT files.* FROM files
         JOIN user_access ON user_access.file_id = files.id
           AND user_access.user_id = ?1
         WHERE files.deleted = 0 LIMIT ?2"
    };
    let mut statement = connection.prepare(sql)?;
    let files = if is_admin {
        statement
            .query_map([1000], row_to_file)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        statement
            .query_map(params![user_id, 1000], row_to_file)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    files.into_iter().map(validate).collect()
}

pub fn find_users_with_access(
    connection: &Connection,
    file_id: &str,
) -> Result<Vec<UserAccess>, FileError> {
    let mut statement = connection.prepare(
        "SELECT UA.user_id, users.display_name, users.user_name
         FROM files
         JOIN user_access UA ON UA.file_id = files.id
         JOIN users ON users.id = UA.user_id
         WHERE files.id = ?1
         UNION ALL
         SELECT users.id, users.display_name, users.user_name
         FROM files JOIN users ON users.id = files.owner
         WHERE files.id = ?1",
    )?;
    Ok(statement
        .query_map([file_id], |row| {
            Ok(UserAccess {
                user_id: row.get(0)?,
                display_name: row.get(1)?,
                user_name: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn count_user_access(
    connection: &Connection,
    file_id: &str,
    user_id: &str,
) -> Result<i64, FileError> {
    Ok(connection.query_row(
        "SELECT count(*) FROM user_access WHERE file_id = ? AND user_id = ?",
        params![file_id, user_id],
        |row| row.get(0),
    )?)
}

pub fn is_admin(connection: &Connection, user_id: &str) -> Result<bool, FileError> {
    Ok(connection
        .query_row("SELECT role FROM users WHERE id = ?", [user_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .as_deref()
        == Some("ADMIN"))
}

pub fn update_upload(
    connection: &Connection,
    file_id: &str,
    group_id: &str,
    sync_version: Option<&str>,
    encrypt_meta: Option<&str>,
    name: &str,
) -> Result<(), FileError> {
    let changes = connection.execute(
        "UPDATE files SET group_id = ?, sync_version = ?, encrypt_meta = ?, name = ? WHERE id = ?",
        params![group_id, sync_version, encrypt_meta, name, file_id],
    )?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

pub fn update_name(connection: &Connection, file_id: &str, name: &Value) -> Result<(), FileError> {
    let value = match name {
        Value::Null => rusqlite::types::Null,
        Value::String(value) => return update_name_string(connection, file_id, value),
        _ => return update_name_string(connection, file_id, &name.to_string()),
    };
    let changes = connection.execute(
        "UPDATE files SET name = ? WHERE id = ?",
        params![value, file_id],
    )?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

fn update_name_string(connection: &Connection, file_id: &str, name: &str) -> Result<(), FileError> {
    let changes = connection.execute(
        "UPDATE files SET name = ? WHERE id = ?",
        params![name, file_id],
    )?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

pub fn update_key(
    connection: &Connection,
    file_id: &str,
    key_id: Option<&str>,
    key_salt: Option<&str>,
    test_content: Option<&str>,
) -> Result<(), FileError> {
    let changes = connection.execute(
        "UPDATE files SET encrypt_keyid = ?, encrypt_salt = ?, encrypt_test = ? WHERE id = ?",
        params![key_id, key_salt, test_content, file_id],
    )?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

pub fn reset_group(connection: &Connection, file_id: &str) -> Result<(), FileError> {
    let changes = connection.execute("UPDATE files SET group_id = NULL WHERE id = ?", [file_id])?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

pub fn mark_deleted(connection: &Connection, file_id: &str) -> Result<(), FileError> {
    let changes = connection.execute("UPDATE files SET deleted = 1 WHERE id = ?", [file_id])?;
    if changes == 1 {
        Ok(())
    } else {
        Err(FileError::NotFound)
    }
}

fn row_to_file(row: &Row<'_>) -> rusqlite::Result<File> {
    Ok(File {
        id: row.get("id")?,
        group_id: row.get("group_id")?,
        sync_version: row.get("sync_version")?,
        name: row.get("name")?,
        encrypt_meta: row.get("encrypt_meta")?,
        encrypt_salt: row.get("encrypt_salt")?,
        encrypt_test: row.get("encrypt_test")?,
        encrypt_key_id: row.get("encrypt_keyid")?,
        deleted: row.get::<_, i64>("deleted")? != 0,
        owner: row.get("owner")?,
    })
}

fn validate(file: File) -> Result<File, FileError> {
    if !is_valid_file_id(&file.id)
        || file
            .group_id
            .as_deref()
            .is_some_and(|group_id| !is_valid_group_id(group_id))
    {
        return Err(FileError::InvalidId);
    }
    Ok(file)
}

use serde_json::Value;
