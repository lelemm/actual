use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["LHV_LHVBEE22"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    let mut edited = transaction.clone();
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(captures) = Regex::new(r"^\(\.\.(\d{4})\) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+)$")
        .expect("valid bank pattern")
        .captures(remittance)
    {
        edited["payeeName"] = Value::String(
            captures
                .get(4)
                .map(|value| value.as_str())
                .unwrap_or_default()
                .split('\\')
                .next()
                .unwrap_or_default()
                .trim()
                .into(),
        );
        if booked {
            edited["date"] = Value::String(
                captures
                    .get(2)
                    .map(|value| value.as_str())
                    .unwrap_or_default()
                    .into(),
            );
        }
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}
