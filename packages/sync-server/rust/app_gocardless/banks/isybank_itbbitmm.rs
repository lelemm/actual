use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ISYBANK_ITBBITMM"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["date"] = transaction
        .get("valueDate")
        .filter(|value| !value.is_null())
        .or_else(|| transaction.get("bookingDate"))
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
