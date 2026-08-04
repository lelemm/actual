use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub user_name: String,
    pub display_name: Option<String>,
    pub enabled: bool,
    pub owner: bool,
    pub role: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccess {
    pub user_id: String,
    pub user_name: String,
    pub owner: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUserAccess {
    pub user_id: String,
    pub user_name: String,
    pub display_name: Option<String>,
    pub have_access: i64,
    pub owner: i64,
}

pub fn get_user_by_username(
    connection: &Connection,
    user_name: &str,
) -> rusqlite::Result<Option<String>> {
    if user_name.is_empty() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id FROM users WHERE user_name = ?",
            [user_name],
            |row| row.get(0),
        )
        .optional()
}

pub fn get_user_by_id(connection: &Connection, user_id: &str) -> rusqlite::Result<Option<String>> {
    if user_id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row("SELECT id FROM users WHERE id = ?", [user_id], |row| {
            row.get(0)
        })
        .optional()
}

pub fn get_file_by_id(connection: &Connection, file_id: &str) -> rusqlite::Result<Option<String>> {
    if file_id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row("SELECT id FROM files WHERE id = ?", [file_id], |row| {
            row.get(0)
        })
        .optional()
}

pub fn validate_role(role: &str) -> bool {
    matches!(role, "BASIC" | "ADMIN")
}

pub fn get_owner_count(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT count(*) FROM users WHERE user_name <> '' AND owner = 1",
        [],
        |row| row.get(0),
    )
}

pub fn get_owner_id(connection: &Connection) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT id FROM users WHERE user_name <> '' AND owner = 1",
            [],
            |row| row.get(0),
        )
        .optional()
}

pub fn get_all_users(connection: &Connection) -> rusqlite::Result<Vec<User>> {
    let mut statement = connection.prepare(
        "SELECT id, user_name, display_name, enabled, ifnull(owner, 0), role
         FROM users WHERE user_name <> ''",
    )?;
    statement
        .query_map([], |row| {
            Ok(User {
                id: row.get(0)?,
                user_name: row.get(1)?,
                display_name: row.get(2)?,
                enabled: row.get::<_, i64>(3)? == 1,
                owner: row.get::<_, i64>(4)? == 1,
                role: row.get(5)?,
            })
        })?
        .collect()
}

pub fn insert_user(
    connection: &Connection,
    user_id: &str,
    user_name: &str,
    display_name: Option<&str>,
    enabled: bool,
    role: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO users (id, user_name, display_name, enabled, owner, role)
         VALUES (?, ?, ?, ?, 0, ?)",
        params![user_id, user_name, display_name, i64::from(enabled), role],
    )?;
    Ok(())
}

pub fn update_user_with_role(
    connection: &mut Connection,
    user_id: &str,
    user_name: &str,
    display_name: Option<&str>,
    enabled: bool,
    role: &str,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "UPDATE users SET user_name = ?, display_name = ?, enabled = ?, role = ? WHERE id = ?",
        params![user_name, display_name, i64::from(enabled), role, user_id],
    )?;
    if !enabled {
        transaction.execute("DELETE FROM sessions WHERE user_id = ?", [user_id])?;
    }
    transaction.commit()
}

pub fn delete_user(connection: &mut Connection, user_id: &str) -> rusqlite::Result<usize> {
    let transaction = connection.transaction()?;
    let changes = transaction.execute("DELETE FROM users WHERE id = ? AND owner = 0", [user_id])?;
    if changes > 0 {
        transaction.execute("DELETE FROM sessions WHERE user_id = ?", [user_id])?;
    }
    transaction.commit()?;
    Ok(changes)
}

pub fn delete_user_access(connection: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    connection.execute("DELETE FROM user_access WHERE user_id = ?", [user_id])
}

pub fn transfer_all_files_from_user(
    connection: &Connection,
    owner_id: &str,
    old_user_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE files SET owner = ? WHERE owner = ?",
        params![owner_id, old_user_id],
    )?;
    Ok(())
}

pub fn update_file_owner(
    connection: &Connection,
    owner_id: &str,
    file_id: &str,
) -> rusqlite::Result<bool> {
    Ok(connection.execute(
        "UPDATE files SET owner = ? WHERE id = ?",
        params![owner_id, file_id],
    )? > 0)
}

pub fn get_user_access(
    connection: &Connection,
    file_id: &str,
    user_id: &str,
    is_admin: bool,
) -> rusqlite::Result<Vec<UserAccess>> {
    let mut statement = connection.prepare(
        "SELECT users.id, user_name, files.owner, display_name
         FROM users
         JOIN user_access ON user_access.user_id = users.id
         JOIN files ON files.id = user_access.file_id
         WHERE files.id = ? AND (files.owner = ? OR 1 = ?)",
    )?;
    statement
        .query_map(params![file_id, user_id, i64::from(is_admin)], |row| {
            Ok(UserAccess {
                user_id: row.get(0)?,
                user_name: row.get(1)?,
                owner: row.get(2)?,
                display_name: row.get(3)?,
            })
        })?
        .collect()
}

pub fn count_user_access(
    connection: &Connection,
    file_id: &str,
    user_id: &str,
) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM files
         WHERE files.id = ? AND (files.owner = ? OR EXISTS (
           SELECT 1 FROM user_access
           WHERE user_access.user_id = ? AND user_access.file_id = ?))",
        params![file_id, user_id, user_id, file_id],
        |row| row.get(0),
    )
}

pub fn check_file_permission(
    connection: &Connection,
    file_id: &str,
    user_id: &str,
) -> rusqlite::Result<bool> {
    Ok(connection.query_row(
        "SELECT count(*) FROM files WHERE id = ? AND owner = ?",
        params![file_id, user_id],
        |row| row.get::<_, i64>(0),
    )? > 0)
}

pub fn add_user_access(
    connection: &Connection,
    user_id: &str,
    file_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO user_access (user_id, file_id) VALUES (?, ?)",
        params![user_id, file_id],
    )?;
    Ok(())
}

pub fn delete_user_access_by_file_id(
    connection: &mut Connection,
    user_ids: &[String],
    file_id: &str,
) -> rusqlite::Result<usize> {
    let transaction = connection.transaction()?;
    let mut changes = 0;
    for user_id in user_ids {
        changes += transaction.execute(
            "DELETE FROM user_access WHERE user_id = ? AND file_id = ?",
            params![user_id, file_id],
        )?;
    }
    transaction.commit()?;
    Ok(changes)
}

pub fn get_all_user_access(
    connection: &Connection,
    file_id: &str,
) -> rusqlite::Result<Vec<AvailableUserAccess>> {
    let mut statement = connection.prepare(
        "SELECT users.id, user_name, display_name,
                CASE WHEN user_access.file_id IS NULL THEN 0 ELSE 1 END,
                CASE WHEN files.id IS NULL THEN 0 ELSE 1 END
         FROM users
         LEFT JOIN user_access ON user_access.file_id = ? AND user_access.user_id = users.id
         LEFT JOIN files ON files.id = ? AND files.owner = users.id
         WHERE users.enabled = 1 AND users.user_name <> ''",
    )?;
    statement
        .query_map(params![file_id, file_id], |row| {
            Ok(AvailableUserAccess {
                user_id: row.get(0)?,
                user_name: row.get(1)?,
                display_name: row.get(2)?,
                have_access: row.get(3)?,
                owner: row.get(4)?,
            })
        })?
        .collect()
}

pub fn is_admin(connection: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    Ok(connection
        .query_row("SELECT role FROM users WHERE id = ?", [user_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten()
        .as_deref()
        == Some("ADMIN"))
}
