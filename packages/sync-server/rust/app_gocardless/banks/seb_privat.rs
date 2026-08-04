use serde_json::Value;

use super::{ing_ingddeff, integration_bank};

pub const INSTITUTION_IDS: &[&str] = &["SEB_ESSESESS_PRIVATE"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["creditorName"] = transaction
        .get("additionalInformation")
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    ing_ingddeff::reduce_from_balance(transactions, balances, "interimBooked")
}
