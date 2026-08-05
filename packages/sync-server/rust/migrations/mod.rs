use std::{
    collections::HashMap,
    fs,
    str::FromStr,
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

#[derive(Deserialize)]
struct LegacyMigrationState {
    pos: usize,
    migrations: Vec<MigrationEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Up,
    Down,
}

impl FromStr for Direction {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            _ => Err(format!("Unknown migration direction: {value}")),
        }
    }
}

pub fn run(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    run_direction(config, Direction::Up)
}

pub fn run_direction(
    config: &Config,
    direction: Direction,
) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "Checking if there are any migrations to run for direction \"{}\"...",
        match direction {
            Direction::Up => "up",
            Direction::Down => "down",
        }
    );
    match direction {
        Direction::Up => up(config)?,
        Direction::Down => down(config)?,
    }
    println!("Migrations: DONE");
    Ok(())
}

fn up(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(&config.data_dir)?;
    let state_path = config.data_dir.join(if config.mode == "test" {
        ".migrate-test"
    } else {
        ".migrate"
    });
    let mut state = load_state(&state_path)?;

    for entry in &state.migrations {
        if entry.timestamp.is_some() && !TITLES.contains(&entry.title.as_str()) {
            return Err(format!("Missing migration file: {}", entry.title).into());
        }
    }
    let timestamps = state
        .migrations
        .drain(..)
        .filter(|entry| TITLES.contains(&entry.title.as_str()))
        .map(|entry| (entry.title, entry.timestamp))
        .collect::<HashMap<_, _>>();
    state.migrations = TITLES
        .map(|title| MigrationEntry {
            title: title.into(),
            timestamp: timestamps.get(title).copied().flatten(),
        })
        .into();

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

fn down(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let state_path = config.data_dir.join(if config.mode == "test" {
        ".migrate-test"
    } else {
        ".migrate"
    });
    if !state_path.exists() {
        return Ok(());
    }
    let mut state = load_state(&state_path)?;
    let last_run = state
        .last_run
        .as_deref()
        .and_then(|title| {
            state
                .migrations
                .iter()
                .position(|entry| entry.title == title)
        })
        .or_else(|| {
            state
                .migrations
                .iter()
                .rposition(|entry| entry.timestamp.is_some())
        });
    let Some(last_run) = last_run else {
        return Ok(());
    };

    let mut connection = if config.server_files.join("account.sqlite").exists() {
        Some(open_database(&config.server_files.join("account.sqlite"))?)
    } else {
        None
    };
    let indices = (0..=last_run)
        .rev()
        .filter(|index| state.migrations[*index].timestamp.is_some())
        .collect::<Vec<_>>();

    for index in indices {
        let title = state.migrations[index].title.clone();
        apply_down(&title, connection.as_mut(), config)?;
        state.migrations[index].timestamp = None;
        state.last_run = state.migrations[..index]
            .iter()
            .rfind(|entry| entry.timestamp.is_some())
            .map(|entry| entry.title.clone());
        fs::write(&state_path, serde_json::to_string_pretty(&state)?)?;

        if title == "1694360479680-create-account-db.js" {
            connection = None;
        }
    }
    Ok(())
}

fn load_state(path: &std::path::Path) -> Result<MigrationState, Box<dyn std::error::Error>> {
    if !path.exists() {
        return Ok(MigrationState {
            last_run: None,
            migrations: Vec::new(),
        });
    }

    let contents = fs::read_to_string(path)?;
    if contents.is_empty() {
        return Ok(MigrationState {
            last_run: None,
            migrations: Vec::new(),
        });
    }

    let value = serde_json::from_str::<serde_json::Value>(&contents)?;
    if value.get("lastRun").is_some() {
        return Ok(serde_json::from_value(value)?);
    }

    if value.get("pos").is_some() {
        let mut legacy = serde_json::from_value::<LegacyMigrationState>(value)?;
        if legacy.pos > legacy.migrations.len() {
            return Err("Store file contains invalid pos property".into());
        }
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
        for migration in &mut legacy.migrations[..legacy.pos] {
            migration.timestamp = Some(timestamp);
        }
        return Ok(MigrationState {
            last_run: legacy
                .pos
                .checked_sub(1)
                .map(|index| legacy.migrations[index].title.clone()),
            migrations: legacy.migrations,
        });
    }

    Err("Invalid store file".into())
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

fn apply_down(
    title: &str,
    connection: Option<&mut Connection>,
    config: &Config,
) -> Result<(), Box<dyn std::error::Error>> {
    match title {
        "1694360000000-create-folders.js" => create_folders::down(config)?,
        "1694360479680-create-account-db.js" => {
            create_account_db::down(required_connection(connection)?)?
        }
        "1694362247011-create-secret-table.js" => {
            create_secret_table::down(required_connection(connection)?)?
        }
        "1702667624000-rename-nordigen-secrets.js" => {
            rename_nordigen_secrets::down(required_connection(connection)?)?
        }
        "1718889148000-openid.js" => openid::down(required_connection(connection)?)?,
        "1719409568000-multiuser.js" => multiuser::down(required_connection(connection)?)?,
        "1763873568237-server-global-prefs.js" => {
            server_global_prefs::down(required_connection(connection)?)?
        }
        "1763873600000-backfill-files-owner.js" => {
            backfill_files_owner::down(required_connection(connection)?)?
        }
        _ => return Err(format!("Missing migration file: {title}").into()),
    }
    Ok(())
}

fn required_connection(
    connection: Option<&mut Connection>,
) -> Result<&mut Connection, Box<dyn std::error::Error>> {
    connection.ok_or_else(|| "account database does not exist".into())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::*;
    use uuid::Uuid;

    #[test]
    fn parses_only_the_two_existing_directions() {
        assert_eq!("up".parse(), Ok(Direction::Up));
        assert_eq!("down".parse(), Ok(Direction::Down));
        assert!("sideways".parse::<Direction>().is_err());
    }

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

    #[test]
    fn reverses_the_complete_migration_history() {
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
        run_direction(&config, Direction::Down).unwrap();

        assert!(!config.server_files.exists());
        assert!(!config.user_files.exists());
        let state: MigrationState =
            serde_json::from_str(&fs::read_to_string(root.join(".migrate")).unwrap()).unwrap();
        assert!(state.last_run.is_none());
        assert!(
            state
                .migrations
                .iter()
                .all(|entry| entry.timestamp.is_none())
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path = "tests/historical.rs"]
mod historical_tests;
