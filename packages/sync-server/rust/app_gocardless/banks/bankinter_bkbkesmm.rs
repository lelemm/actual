use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BANKINTER_BKBKESMM"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let marker = Regex::new(r"(?i)/Txt/(?:\w\|)?").expect("valid bank pattern");
    let remittance = marker
        .replace_all(
            transaction
                .get("remittanceInformationUnstructured")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "",
        )
        .replace(';', " ");
    edited["remittanceInformationUnstructured"] = Value::String(remittance.clone());
    if let Some(name) = transaction.get("debtorName").and_then(Value::as_str) {
        edited["debtorName"] = Value::String(name.replace(';', " "));
    }
    edited["creditorName"] = Value::String(
        transaction
            .get("creditorName")
            .and_then(Value::as_str)
            .map(|name| name.replace(';', " "))
            .unwrap_or(remittance),
    );
    integration_bank::normalize_transaction_with(transaction, &edited)
}
