use chrono::{TimeZone, Utc};
use serde_json::json;

use super::super::{date_string, javascript_truthy};

#[test]
fn accepts_existing_start_date_forms_and_javascript_truthiness() {
    assert_eq!(
        date_string(&json!("2026-07-01")).as_deref(),
        Some("2026-07-01")
    );
    let milliseconds = Utc
        .with_ymd_and_hms(2026, 7, 1, 0, 0, 0)
        .unwrap()
        .timestamp_millis();
    assert_eq!(
        date_string(&json!(milliseconds)).as_deref(),
        Some("2026-07-01")
    );
    assert!(javascript_truthy(&json!({})));
    assert!(!javascript_truthy(&json!("")));
}
