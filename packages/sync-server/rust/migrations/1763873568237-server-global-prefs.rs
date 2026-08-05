use rusqlite::Connection;

pub fn up(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS server_prefs
           (key TEXT NOT NULL PRIMARY KEY, value TEXT);",
    )
}

pub fn down(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("DROP TABLE IF EXISTS server_prefs;")
}
