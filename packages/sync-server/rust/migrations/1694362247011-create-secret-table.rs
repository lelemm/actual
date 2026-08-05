use rusqlite::Connection;

pub fn up(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS secrets (
           name TEXT PRIMARY KEY,
           value BLOB
         );",
    )
}

pub fn down(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("DROP TABLE secrets;")
}
