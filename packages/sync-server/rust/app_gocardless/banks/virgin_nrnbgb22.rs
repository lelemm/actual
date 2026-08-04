use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["VIRGIN_NRNBGB22"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let parts = remittance.split(", ").collect::<Vec<_>>();
    let transfer = matches!(parts.first().copied(), Some("MOB" | "FPS"));
    let card = parts.first().is_some_and(|part| {
        Regex::new(r"^(?:Card|WLT)\s\d+")
            .expect("valid bank pattern")
            .is_match(part)
    });
    if transfer || card {
        let payee = parts.get(1).copied().unwrap_or_default();
        edited["creditorName"] = Value::String(payee.into());
        edited["debtorName"] = Value::String(payee.into());
        if transfer {
            edited["remittanceInformationUnstructured"] = parts
                .get(2)
                .map_or(Value::Null, |value| Value::String((*value).into()));
        }
    } else {
        edited["creditorName"] = Value::String(remittance.into());
        edited["debtorName"] = Value::String(remittance.into());
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}
