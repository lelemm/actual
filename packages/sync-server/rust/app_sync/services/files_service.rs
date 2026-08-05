use rusqlite::{Connection, OptionalExtension, Row, ToSql, params, types::ToSqlOutput};
use serde::Serialize;
use serde_json::json;

use crate::{
    app_sync::errors::FileError,
    util::paths::{FileId, GroupId, parse_file_id, parse_group_id},
};

#[derive(Clone, Debug)]
pub struct File {
    pub id: FileId,
    pub name: Option<String>,
    pub group_id: Option<GroupId>,
    pub encrypt_salt: Option<String>,
    pub encrypt_test: Option<String>,
    pub encrypt_key_id: Option<String>,
    pub encrypt_meta: Option<String>,
    pub sync_version: Option<i64>,
    pub deleted: bool,
    pub owner: Option<String>,
}

#[derive(Default)]
pub struct FileUpdate<'a> {
    pub name: Option<Option<SqliteText<'a>>>,
    pub group_id: Option<Option<&'a GroupId>>,
    pub encrypt_salt: Option<Option<SqliteText<'a>>>,
    pub encrypt_test: Option<Option<SqliteText<'a>>>,
    pub encrypt_key_id: Option<Option<SqliteText<'a>>>,
    pub encrypt_meta: Option<Option<&'a str>>,
    pub sync_version: Option<Option<i64>>,
    pub deleted: Option<bool>,
}

#[derive(Clone, Copy, Debug)]
pub enum SqliteText<'a> {
    Text(&'a str),
    Number(f64),
}

impl ToSql for SqliteText<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        match self {
            Self::Text(value) => value.to_sql(),
            Self::Number(value) => value.to_sql(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccess {
    pub user_id: String,
    pub display_name: Option<String>,
    pub user_name: Option<String>,
}

pub fn get(connection: &Connection, file_id: &FileId) -> Result<File, FileError> {
    let file = connection
        .query_row("SELECT * FROM files WHERE id = ?", [file_id], row_to_file)
        .optional()?;
    match file {
        Some(file) if !file.deleted => validate(file),
        _ => Err(FileError::not_found(None)),
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
    find_with_limit(connection, user_id, 1000)
}

pub fn find_with_limit(
    connection: &Connection,
    user_id: &str,
    limit: i64,
) -> Result<Vec<File>, FileError> {
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
            .query_map([limit], row_to_file)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        statement
            .query_map(params![user_id, limit], row_to_file)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    files.into_iter().map(validate).collect()
}

pub fn update(
    connection: &Connection,
    file_id: &FileId,
    update: &FileUpdate<'_>,
) -> Result<File, FileError> {
    let has_updates = update.name.is_some()
        || update.group_id.is_some()
        || update.encrypt_salt.is_some()
        || update.encrypt_test.is_some()
        || update.encrypt_key_id.is_some()
        || update.encrypt_meta.is_some()
        || update.sync_version.is_some()
        || update.deleted.is_some();
    if has_updates {
        let changes = connection.execute(
            "UPDATE files SET
             name = CASE WHEN ?1 THEN ?2 ELSE name END,
             group_id = CASE WHEN ?3 THEN ?4 ELSE group_id END,
             encrypt_salt = CASE WHEN ?5 THEN ?6 ELSE encrypt_salt END,
             encrypt_test = CASE WHEN ?7 THEN ?8 ELSE encrypt_test END,
             encrypt_keyid = CASE WHEN ?9 THEN ?10 ELSE encrypt_keyid END,
             encrypt_meta = CASE WHEN ?11 THEN ?12 ELSE encrypt_meta END,
             sync_version = CASE WHEN ?13 THEN ?14 ELSE sync_version END,
             deleted = CASE WHEN ?15 THEN ?16 ELSE deleted END
             WHERE id = ?17",
            params![
                update.name.is_some(),
                update.name.flatten(),
                update.group_id.is_some(),
                update.group_id.flatten(),
                update.encrypt_salt.is_some(),
                update.encrypt_salt.flatten(),
                update.encrypt_test.is_some(),
                update.encrypt_test.flatten(),
                update.encrypt_key_id.is_some(),
                update.encrypt_key_id.flatten(),
                update.encrypt_meta.is_some(),
                update.encrypt_meta.flatten(),
                update.sync_version.is_some(),
                update.sync_version.flatten(),
                update.deleted.is_some(),
                update.deleted.map(i64::from),
                file_id,
            ],
        )?;
        if changes != 1 {
            return Err(FileError::generic(
                "Could not update File",
                Some(json!({ "id": file_id.as_str() })),
            ));
        }
    }
    let file = connection
        .query_row("SELECT * FROM files WHERE id = ?", [file_id], row_to_file)
        .optional()?
        .ok_or_else(|| {
            FileError::generic("File not found", Some(json!({ "id": file_id.as_str() })))
        })?;
    validate(file)
}

pub fn find_users_with_access(
    connection: &Connection,
    file_id: &FileId,
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
    file_id: &FileId,
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

struct RawFile {
    id: String,
    name: Option<String>,
    group_id: Option<String>,
    encrypt_salt: Option<String>,
    encrypt_test: Option<String>,
    encrypt_key_id: Option<String>,
    encrypt_meta: Option<String>,
    sync_version: Option<i64>,
    deleted: bool,
    owner: Option<String>,
}

fn row_to_file(row: &Row<'_>) -> rusqlite::Result<RawFile> {
    Ok(RawFile {
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

fn validate(file: RawFile) -> Result<File, FileError> {
    let raw_file_id = file.id.clone();
    Ok(File {
        id: parse_file_id(&file.id).ok_or_else(|| {
            FileError::generic("Invalid file ID", Some(json!({ "fileId": raw_file_id })))
        })?,
        group_id: match file.group_id.as_deref() {
            Some(group_id) => Some(parse_group_id(group_id).ok_or_else(|| {
                FileError::generic("Invalid group ID", Some(json!({ "groupId": group_id })))
            })?),
            None => None,
        },
        sync_version: file.sync_version,
        name: file.name,
        encrypt_meta: file.encrypt_meta,
        encrypt_salt: file.encrypt_salt,
        encrypt_test: file.encrypt_test,
        encrypt_key_id: file.encrypt_key_id,
        deleted: file.deleted,
        owner: file.owner,
    })
}
