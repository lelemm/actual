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

pub fn down(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE secrets SET name = 'nordigen_secretId' WHERE name = 'gocardless_secretId'",
        [],
    )?;
    connection.execute(
        "UPDATE secrets SET name = 'nordigen_secretKey' WHERE name = 'gocardless_secretKey'",
        [],
    )?;
    Ok(())
}
