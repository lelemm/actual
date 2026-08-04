use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BANCSABADELL_BSABESBB"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let outgoing = transaction
        .get("transactionAmount")
        .and_then(|value| value.get("amount"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .is_some_and(|value| value < 0.0);
    let payee = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    edited["creditorName"] = outgoing
        .then(|| Value::String(payee.clone()))
        .unwrap_or(Value::Null);
    edited["debtorName"] = (!outgoing)
        .then(|| Value::String(payee))
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
