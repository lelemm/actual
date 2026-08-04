use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["DANSKEBANK_DABADKKK", "DANSKEBANK_DABANO22"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["remittanceInformationUnstructured"] = Value::String(
        transaction
            .get("remittanceInformationUnstructured")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace("\nEndToEndID: NOTPROVIDED", ""),
    );
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    let balance = balances
        .iter()
        .find(|balance| {
            balance.get("balanceType").and_then(Value::as_str) == Some("interimAvailable")
        })
        .and_then(|value| value.get("balanceAmount"))
        .and_then(|value| value.get("amount"))
        .map(amount_to_integer)
        .unwrap_or(0);
    transactions.iter().fold(balance, |total, transaction| {
        total
            - transaction
                .get("transactionAmount")
                .and_then(|value| value.get("amount"))
                .map(amount_to_integer)
                .unwrap_or(0)
    })
}
