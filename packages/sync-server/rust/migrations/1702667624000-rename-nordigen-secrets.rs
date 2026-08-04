use rusqlite::Connection;

pub fn up(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE secrets SET name = 'gocardless_secretId' WHERE name = 'nordigen_secretId'",
        [],
    )?;
    connection.execute(
        "UPDATE secrets SET name = 'gocardless_secretKey' WHERE name = 'nordigen_secretKey'",
        [],
    )?;
    Ok(())
}
