use serde_json::{Value, json};

use super::super::errors::handle_enable_banking_error;

#[test]
fn maps_enable_banking_api_errors() {
    assert_eq!(
        handle_enable_banking_error(401, &json!({ "message": "Unauthorized" })).error_code,
        "INVALID_ACCESS_TOKEN"
    );
    assert_eq!(
        handle_enable_banking_error(
            400,
            &json!({ "error": "CLOSED_SESSION", "message": "closed" })
        )
        .error_code,
        "INVALID_ACCESS_TOKEN"
    );
    assert_eq!(
        handle_enable_banking_error(429, &json!({ "message": "slow down" })).error_code,
        "RATE_LIMIT_EXCEEDED"
    );
    assert_eq!(
        handle_enable_banking_error(500, &Value::String("raw error".into())).error_type,
        "raw error"
    );
}
