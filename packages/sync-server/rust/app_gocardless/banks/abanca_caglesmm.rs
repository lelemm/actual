use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] =
    &["ABANCA_CAGLESMM", "ABANCA_CAGLPTPL", "ABANCA_CORP_CAGLPTPL"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let name = transaction
        .get("remittanceInformationStructured")
        .cloned()
        .unwrap_or(Value::Null);
    edited["creditorName"] = name.clone();
    edited["debtorName"] = name;
    integration_bank::normalize_transaction_with(transaction, &edited)
}
