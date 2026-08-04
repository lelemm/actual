use std::fs;

use crate::load_config::Config;

pub fn up(config: &Config) -> std::io::Result<()> {
    fs::create_dir_all(&config.server_files)?;
    fs::create_dir_all(&config.user_files)
}
