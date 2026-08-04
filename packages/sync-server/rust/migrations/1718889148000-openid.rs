use rusqlite::Connection;

pub fn up(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "BEGIN TRANSACTION;
         CREATE TABLE auth_new
           (method TEXT PRIMARY KEY,
            display_name TEXT,
            extra_data TEXT, active INTEGER);
         INSERT INTO auth_new (method, display_name, extra_data, active)
           SELECT 'password', 'Password', password, 1 FROM auth;
         DROP TABLE auth;
         ALTER TABLE auth_new RENAME TO auth;
         CREATE TABLE pending_openid_requests
           (state TEXT PRIMARY KEY,
            code_verifier TEXT,
            return_url TEXT,
            expiry_time INTEGER);
         COMMIT;",
    )
}
