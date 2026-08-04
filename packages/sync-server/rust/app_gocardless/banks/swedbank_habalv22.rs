use chrono::NaiveDate;
use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["SWEDBANK_HABALV22"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    let mut edited = transaction.clone();
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if remittance.starts_with("PIRKUMS") {
        if !booked
            && transaction.get("creditorName").is_none_or(Value::is_null)
            && let Some(name) = Regex::new(
                r"PIRKUMS [\d*]+ \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} [\d.]+ \w{3} \(\d+\) (.+)",
            )
            .expect("valid bank pattern")
            .captures(remittance)
            .and_then(|captures| captures.get(1))
        {
            edited["creditorName"] = Value::String(name.as_str().into());
        }
        if let Some(date) = Regex::new(r"PIRKUMS [\d*]+ (\d{2}\.\d{2}\.\d{4})")
            .expect("valid bank pattern")
            .captures(remittance)
            .and_then(|captures| captures.get(1))
            .and_then(|date| NaiveDate::parse_from_str(date.as_str(), "%d.%m.%Y").ok())
        {
            edited["date"] = Value::String(format!("{}T00:00:00.000Z", date.format("%Y-%m-%d")));
        }
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}
