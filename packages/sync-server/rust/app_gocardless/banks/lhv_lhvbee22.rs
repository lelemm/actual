use chrono::NaiveDate;
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
        if booked
            && let Some(date) = captures
                .get(2)
                .and_then(|value| NaiveDate::parse_from_str(value.as_str(), "%Y-%m-%d").ok())
                .filter(|date| chrono::Datelike::year(date) != 0)
        {
            edited["date"] = Value::String(date.format("%Y-%m-%d").to_string());
        }
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}
