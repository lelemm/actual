use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["FORTUNEO_FTNOFRP1XXX"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let details = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let keywords =
        Regex::new(r"VIR INST|VIR|PRLV|ANN CARTE|CARTE \d{2}/\d{2}").expect("valid bank pattern");
    let payee = keywords.replace_all(&details, "").trim().to_owned();
    let outgoing = transaction
        .get("transactionAmount")
        .and_then(|value| value.get("amount"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .is_some_and(|value| value < 0.0);
    edited["creditorName"] = outgoing
        .then(|| Value::String(payee.clone()))
        .unwrap_or(Value::Null);
    edited["debtorName"] = (!outgoing)
        .then(|| Value::String(payee))
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
