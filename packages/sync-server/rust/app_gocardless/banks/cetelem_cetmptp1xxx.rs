use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["CETELEM_CETMPTP1XXX"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let edited = transaction.clone();
    let mut transaction = transaction.clone();
    let amount = transaction
        .get("transactionAmount")
        .and_then(|value| value.get("amount"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    transaction["transactionAmount"]["amount"] = Value::String((-amount).to_string());
    integration_bank::normalize_transaction_with(&transaction, &edited)
}
