use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &[
    "SPARNORD_SPNODK22",
    "LAGERNES_BANK_LAPNDKK1",
    "ANDELSKASSEN_FALLESKASSEN_FAELDKK1",
];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["remittanceInformationUnstructured"] = transaction
        .get("additionalInformation")
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
