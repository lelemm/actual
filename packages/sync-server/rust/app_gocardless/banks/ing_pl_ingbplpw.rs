use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ING_PL_INGBPLPW"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["date"] = transaction.get("valueDate").cloned().unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn sort_transactions(transactions: &mut [Value]) {
    transactions.sort_by_key(|transaction| {
        std::cmp::Reverse(
            transaction
                .get("transactionId")
                .and_then(Value::as_str)
                .and_then(|value| value.get(2..))
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0),
        )
    });
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    if let Some(oldest) = transactions.last() {
        let balance = oldest
            .get("balanceAfterTransaction")
            .and_then(|value| value.get("balanceAmount"))
            .and_then(|value| value.get("amount"))
            .map(amount_to_integer)
            .unwrap_or(0);
        let amount = oldest
            .get("transactionAmount")
            .and_then(|value| value.get("amount"))
            .map(amount_to_integer)
            .unwrap_or(0);
        balance - amount
    } else {
        balances
            .iter()
            .find(|balance| {
                balance.get("balanceType").and_then(Value::as_str) == Some("interimBooked")
            })
            .and_then(|value| value.get("balanceAmount"))
            .and_then(|value| value.get("amount"))
            .map(amount_to_integer)
            .unwrap_or(0)
    }
}
