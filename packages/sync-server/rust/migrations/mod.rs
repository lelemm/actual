use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{db::open_database, load_config::Config};

#[path = "1763873600000-backfill-files-owner.rs"]
mod backfill_files_owner;
#[path = "1694360479680-create-account-db.rs"]
mod create_account_db;
#[path = "1694360000000-create-folders.rs"]
mod create_folders;
#[path = "1694362247011-create-secret-table.rs"]
mod create_secret_table;
#[path = "1719409568000-multiuser.rs"]
mod multiuser;
#[path = "1718889148000-openid.rs"]
mod openid;
#[path = "1702667624000-rename-nordigen-secrets.rs"]
mod rename_nordigen_secrets;
#[path = "1763873568237-server-global-prefs.rs"]
mod server_global_prefs;

const TITLES: [&str; 8] = [
    "1694360000000-create-folders.js",
    "1694360479680-create-account-db.js",
    "1694362247011-create-secret-table.js",
    "1702667624000-rename-nordigen-secrets.js",
    "1718889148000-openid.js",
    "1719409568000-multiuser.js",
    "1763873568237-server-global-prefs.js",
    "1763873600000-backfill-files-owner.js",
];

#[derive(Deserialize, Serialize)]
struct MigrationState {
    #[serde(rename = "lastRun")]
    last_run: Option<String>,
    migrations: Vec<MigrationEntry>,
}

#[derive(Deserialize, Serialize)]
struct MigrationEntry {
    title: String,
    timestamp: Option<u128>,
}

pub fn run(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(&config.data_dir)?;
    let state_path = config.data_dir.join(if config.mode == "test" {
        ".migrate-test"
    } else {
        ".migrate"
    });
    let mut state = if state_path.exists() {
        serde_json::from_str::<MigrationState>(&fs::read_to_string(&state_path)?)?
    } else {
        MigrationState {
            last_run: None,
            migrations: Vec::new(),
        }
    };

    for entry in &state.migrations {
        if entry.timestamp.is_some() && !TITLES.contains(&entry.title.as_str()) {
            return Err(format!("Missing migration file: {}", entry.title).into());
        }
    }
    for title in TITLES {
        if !state.migrations.iter().any(|entry| entry.title == title) {
            state.migrations.push(MigrationEntry {
                title: title.into(),
                timestamp: None,
            });
        }
    }
    state
        .migrations
        .sort_by(|left, right| left.title.cmp(&right.title));

    fs::create_dir_all(&config.server_files)?;
    fs::create_dir_all(&config.user_files)?;
    let mut connection = open_database(&config.server_files.join("account.sqlite"))?;

    for index in 0..state.migrations.len() {
        if state.migrations[index].timestamp.is_some() {
            continue;
        }
        let title = state.migrations[index].title.clone();
        apply(&title, &mut connection, config)?;
        state.migrations[index].timestamp =
            Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis());
        state.last_run = Some(title);
        fs::write(&state_path, serde_json::to_string_pretty(&state)?)?;
    }
    Ok(())
}

fn apply(
    title: &str,
    connection: &mut Connection,
    config: &Config,
) -> Result<(), Box<dyn std::error::Error>> {
    match title {
        "1694360000000-create-folders.js" => create_folders::up(config)?,
        "1694360479680-create-account-db.js" => create_account_db::up(connection)?,
        "1694362247011-create-secret-table.js" => create_secret_table::up(connection)?,
        "1702667624000-rename-nordigen-secrets.js" => rename_nordigen_secrets::up(connection)?,
        "1718889148000-openid.js" => openid::up(connection)?,
        "1719409568000-multiuser.js" => multiuser::up(connection)?,
        "1763873568237-server-global-prefs.js" => server_global_prefs::up(connection)?,
        "1763873600000-backfill-files-owner.js" => backfill_files_owner::up(connection)?,
        _ => return Err(format!("Missing migration file: {title}").into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::*;
    use uuid::Uuid;

    #[test]
    fn creates_the_current_schema_and_migrate_state() {
        let root = std::env::temp_dir().join(format!("actual-rust-migration-{}", Uuid::new_v4()));
        let config = Config {
            address: (IpAddr::V4(Ipv4Addr::LOCALHOST), 0).into(),
            data_dir: root.clone(),
            server_files: root.join("server-files"),
            user_files: root.join("user-files"),
            mode: "development".into(),
            ..Config::default()
        };

        run(&config).unwrap();
        let connection = open_database(&config.server_files.join("account.sqlite")).unwrap();
        let tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(
            tables,
            [
                "auth",
                "files",
                "pending_openid_requests",
                "secrets",
                "server_prefs",
                "sessions",
                "user_access",
                "users",
            ]
        );
        assert!(root.join(".migrate").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
