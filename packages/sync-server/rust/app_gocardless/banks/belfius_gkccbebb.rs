use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BELFIUS_GKCCBEBB"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut transaction = transaction.clone();
    transaction["transactionId"] = transaction
        .get("internalTransactionId")
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction(&transaction)
}
