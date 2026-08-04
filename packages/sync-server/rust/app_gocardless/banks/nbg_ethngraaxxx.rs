use serde_json::{Value, json};

use super::{ing_ingddeff, integration_bank};

pub const INSTITUTION_IDS: &[&str] = &["NBG_ETHNGRAAXXX"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut transaction = transaction.clone();
    let pending_purchase = transaction.get("transactionId").is_none_or(Value::is_null)
        && transaction
            .get("remittanceInformationUnstructured")
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with("ΑΓΟΡΑ "));
    if pending_purchase {
        let amount = transaction["transactionAmount"]["amount"]
            .as_str()
            .unwrap_or_default();
        transaction["transactionAmount"] = json!({
            "amount": format!("-{amount}"),
            "currency": transaction["transactionAmount"]["currency"].clone()
        });
        edited["remittanceInformationUnstructured"] = Value::String(
            edited["remittanceInformationUnstructured"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .skip(6)
                .collect(),
        );
    }
    integration_bank::normalize_transaction_with(&transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    ing_ingddeff::reduce_from_balance(transactions, balances, "interimAvailable")
}
