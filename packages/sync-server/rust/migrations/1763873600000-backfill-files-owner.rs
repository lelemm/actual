use rusqlite::{Connection, OptionalExtension};

pub fn up(connection: &Connection) -> rusqlite::Result<()> {
    let admin = connection
        .query_row(
            "SELECT id FROM users WHERE role = ? ORDER BY id LIMIT 1",
            ["ADMIN"],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(admin) = admin {
        connection.execute("UPDATE files SET owner = ? WHERE owner IS NULL", [admin])?;
    }
    Ok(())
}

pub fn down(_connection: &Connection) -> rusqlite::Result<()> {
    Ok(())
}
