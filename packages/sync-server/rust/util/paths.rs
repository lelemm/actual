use std::path::PathBuf;

use crate::load_config::Config;

pub fn is_valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn is_valid_group_id(id: &str) -> bool {
    is_valid_file_id(id)
}

pub fn get_path_for_user_file(config: &Config, file_id: &str) -> PathBuf {
    config.user_files.join(format!("file-{file_id}.blob"))
}

pub fn get_path_for_group_file(config: &Config, group_id: &str) -> PathBuf {
    config.user_files.join(format!("group-{group_id}.sqlite"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_existing_id_alphabet() {
        assert!(is_valid_file_id("abc-DEF_012"));
        assert!(!is_valid_file_id(""));
        assert!(!is_valid_file_id("budget@2026"));
        assert!(!is_valid_file_id("../budget"));
    }
}
