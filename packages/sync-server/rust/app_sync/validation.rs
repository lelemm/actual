use serde_json::Value;

use crate::app_sync::services::files_service::File;

const SYNC_FORMAT_VERSION: i64 = 2;

pub fn validate_synced_file(
    group_id: Option<&str>,
    key_id: Option<&str>,
    current_file: &File,
) -> Option<&'static str> {
    if current_file
        .sync_version
        .is_none_or(|version| version < SYNC_FORMAT_VERSION)
    {
        return Some("file-old-version");
    }
    if current_file.group_id.is_none() {
        return Some("file-needs-upload");
    }
    let uploaded_key_id = current_file
        .encrypt_meta
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| {
            value
                .get("keyId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    if uploaded_key_id.as_deref() != current_file.encrypt_key_id.as_deref() {
        return Some("file-key-mismatch");
    }
    if group_id != current_file.group_id.as_deref() {
        return Some("file-has-reset");
    }
    if key_id != current_file.encrypt_key_id.as_deref() {
        return Some("file-has-new-key");
    }
    None
}

pub fn validate_uploaded_file(
    group_id: Option<&str>,
    key_id: Option<&str>,
    current_file: &File,
) -> Option<&'static str> {
    if group_id != current_file.group_id.as_deref() {
        return Some("file-has-reset");
    }
    if key_id != current_file.encrypt_key_id.as_deref() {
        return Some("file-has-new-key");
    }
    None
}
