use regex::Regex;
use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ABNAMRO_ABNANL2A"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let info = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    edited["remittanceInformationUnstructured"] = Value::String(
        info.iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
    );
    let pattern = Regex::new(r"^(?:.*\*)?(.+),PAS\d+$").expect("valid bank pattern");
    let payee = info.iter().filter_map(Value::as_str).find_map(|value| {
        pattern
            .captures(value)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_owned())
    });
    for field in ["debtorName", "creditorName"] {
        if transaction.get(field).is_none_or(Value::is_null)
            && let Some(payee) = &payee
        {
            edited[field] = Value::String(payee.clone());
        }
    }
    edited["date"] = Value::String(
        transaction
            .get("valueDateTime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .get(..10)
            .unwrap_or_default()
            .into(),
    );
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn sort_transactions(transactions: &mut [Value]) {
    transactions.sort_by(|left, right| {
        right
            .get("valueDateTime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                left.get("valueDateTime")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
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
