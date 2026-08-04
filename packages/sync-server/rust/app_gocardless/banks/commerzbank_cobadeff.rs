use regex::{Regex, escape};
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["COMMERZBANK_COBADEFF"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut remittance = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");

    for keyword in [
        "End-to-End-Ref.:",
        "Mandatsref:",
        "Gläubiger-ID:",
        "SEPA-BASISLASTSCHRIFT",
        "Kartenzahlung",
        "Dauerauftrag",
    ] {
        let pattern = keyword
            .chars()
            .map(|character| escape(&character.to_string()))
            .collect::<Vec<_>>()
            .join(r"\s*");
        remittance = Regex::new(&format!("(?i){pattern}"))
            .expect("valid bank pattern")
            .replace_all(&remittance, format!(", {keyword} "))
            .into_owned();
    }

    remittance = Regex::new(r"\s*(,)?\s+")
        .expect("valid bank pattern")
        .replace_all(&remittance, "$1 ")
        .into_owned();
    let payee = transaction
        .get("creditorName")
        .or_else(|| transaction.get("debtorName"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !payee.is_empty() {
        let pattern = payee
            .split(' ')
            .map(escape)
            .collect::<Vec<_>>()
            .join(r"(?:/*| )");
        remittance = Regex::new(&format!("(?i){pattern}"))
            .expect("escaped payee pattern")
            .replace_all(&remittance, " ")
            .into_owned();
    }
    remittance = remittance
        .replace(", End-to-End-Ref.: NOTPROVIDED", "")
        .trim()
        .to_owned();
    edited["remittanceInformationUnstructured"] = Value::String(remittance);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
