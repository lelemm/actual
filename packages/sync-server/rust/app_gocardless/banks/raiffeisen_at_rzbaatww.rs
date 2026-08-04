use regex::Regex;
use serde_json::Value;

use super::integration_bank;
use crate::util::{payee_name::format_payee_name, title::title};

pub const INSTITUTION_IDS: &[&str] = &["RAIFFEISEN_AT_RZBAATWW"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut payee = transaction
        .as_object()
        .map(format_payee_name)
        .unwrap_or_default();
    if payee.is_empty() {
        let structured = transaction
            .get("remittanceInformationStructured")
            .and_then(Value::as_str)
            .unwrap_or_default();
        payee = Regex::new(r"(.{12}) \d{4} .* \d{2}\.\d{2}\. \d{2}:\d{2}")
            .expect("valid bank pattern")
            .captures(structured)
            .and_then(|captures| captures.get(1))
            .map_or_else(|| structured.into(), |value| title(value.as_str()));
    }
    edited["payeeName"] = Value::String(payee);
    edited["remittanceInformationUnstructured"] = [
        "remittanceInformationUnstructured",
        "remittanceInformationStructured",
        "endToEndId",
    ]
    .iter()
    .find_map(|field| transaction.get(*field).filter(|value| !value.is_null()))
    .cloned()
    .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
