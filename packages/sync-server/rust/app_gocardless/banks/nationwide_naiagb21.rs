use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["NATIONWIDE_NAIAGB21"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    let mut transaction = transaction.clone();
    let mut edited = transaction.clone();
    if !booked {
        let date = transaction
            .get("bookingDate")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(&format!("{value}T00:00:00Z")).ok())
            .map(|value| value.with_timezone(&Utc))
            .unwrap_or_else(Utc::now)
            .min(Utc::now());
        edited["date"] = Value::String(date.format("%Y-%m-%d").to_string());
    }
    let id = transaction.get("transactionId").and_then(Value::as_str);
    let malformed = Regex::new(r"^00(?:DEB|CRED)IT.+$")
        .expect("valid bank pattern")
        .is_match(id.unwrap_or_default());
    if malformed || !matches!(id.map(str::len), Some(32 | 40)) {
        transaction.as_object_mut()?.remove("transactionId");
    }
    integration_bank::normalize_transaction_with(&transaction, &edited)
}
