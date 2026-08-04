use serde_json::{Value, json};

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ENTERCARD_SWEDNOKK"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["date"] = transaction.get("valueDate").cloned().unwrap_or(Value::Null);
    let mut transaction = transaction.clone();
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(amount) = remittance.strip_prefix("billingAmount: ") {
        transaction["transactionAmount"] = json!({ "amount": amount, "currency": "SEK" });
    }
    integration_bank::normalize_transaction_with(&transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    let balance = balances
        .first()
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
