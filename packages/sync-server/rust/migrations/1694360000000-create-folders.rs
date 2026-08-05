use std::fs;

use crate::load_config::Config;

pub fn up(config: &Config) -> std::io::Result<()> {
    fs::create_dir_all(&config.server_files)?;
    fs::create_dir_all(&config.user_files)
}

pub fn down(config: &Config) -> std::io::Result<()> {
    if config.server_files.exists() {
        fs::remove_dir_all(&config.server_files)?;
    }
    if config.user_files.exists() {
        fs::remove_dir_all(&config.user_files)?;
    }
    Ok(())
}
