use serde_json::Value;

use super::{ing_ingddeff, integration_bank};

pub const INSTITUTION_IDS: &[&str] = &["MBANK_RETAIL_BREXPLPW"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["date"] = [
        "valueDate",
        "valueDateTime",
        "bookingDate",
        "bookingDateTime",
    ]
    .iter()
    .find_map(|field| transaction.get(*field).filter(|value| !value.is_null()))
    .cloned()
    .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn sort_transactions(transactions: &mut [Value]) {
    transactions.sort_by_key(|transaction| {
        std::cmp::Reverse(
            transaction
                .get("transactionId")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0),
        )
    });
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    ing_ingddeff::reduce_from_balance(transactions, balances, "interimBooked")
}
