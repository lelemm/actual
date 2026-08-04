use rusqlite::{Connection, params};
use uuid::Uuid;

pub fn up(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE users
           (id TEXT PRIMARY KEY,
            user_name TEXT,
            display_name TEXT,
            role TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            owner INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE user_access
           (user_id TEXT,
            file_id TEXT,
            PRIMARY KEY (user_id, file_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES files(id));
         ALTER TABLE files ADD COLUMN owner TEXT;
         ALTER TABLE sessions ADD COLUMN expires_at INTEGER;
         ALTER TABLE sessions ADD COLUMN user_id TEXT;
         ALTER TABLE sessions ADD COLUMN auth_method TEXT;",
    )?;
    let user_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO users (id, user_name, display_name, enabled, owner, role)
         VALUES (?, ?, ?, 1, 1, ?)",
        params![user_id, "", "", "ADMIN"],
    )?;
    transaction.execute(
        "UPDATE sessions SET user_id = ?, expires_at = ?, auth_method = ?
         WHERE auth_method IS NULL",
        params![user_id, -1, "password"],
    )?;
    transaction.commit()
}
