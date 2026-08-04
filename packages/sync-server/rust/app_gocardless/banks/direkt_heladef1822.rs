use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["DIREKT_HELADEF1822"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["remittanceInformationUnstructured"] = transaction
        .get("remittanceInformationUnstructured")
        .filter(|value| !value.is_null())
        .or_else(|| transaction.get("remittanceInformationStructured"))
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
