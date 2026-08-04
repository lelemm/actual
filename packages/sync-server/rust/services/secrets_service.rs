use rusqlite::{Connection, OptionalExtension, params};

pub const SECRET_NAMES: [&str; 11] = [
    "gocardless_secretId",
    "gocardless_secretKey",
    "simplefin_token",
    "simplefin_accessKey",
    "pluggyai_clientId",
    "pluggyai_clientSecret",
    "pluggyai_itemIds",
    "akahu_userToken",
    "akahu_appToken",
    "enablebanking_applicationId",
    "enablebanking_secretKey",
];

pub fn is_valid_name(name: &str) -> bool {
    SECRET_NAMES.contains(&name)
}

fn key(name: &str, file_id: Option<&str>) -> String {
    file_id.map_or_else(|| name.into(), |file_id| format!("{name}:{file_id}"))
}

pub fn set(
    connection: &Connection,
    name: &str,
    value: Option<&str>,
    file_id: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR REPLACE INTO secrets (name, value) VALUES (?, ?)",
        params![key(name, file_id), value],
    )?;
    Ok(())
}

pub fn get(
    connection: &Connection,
    name: &str,
    file_id: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM secrets WHERE name = ?",
            [key(name, file_id)],
            |row| row.get(0),
        )
        .optional()
}

pub fn reset(connection: &Connection, name: &str, file_id: Option<&str>) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM secrets WHERE name = ?", [key(name, file_id)])?;
    Ok(())
}
