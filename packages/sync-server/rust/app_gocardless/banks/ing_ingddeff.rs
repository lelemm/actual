use regex::Regex;
use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ING_INGDDEFF"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pattern = Regex::new(r"remittanceinformation:(.*)$").expect("valid bank pattern");
    edited["remittanceInformationUnstructured"] = Value::String(
        pattern
            .captures(remittance)
            .and_then(|captures| captures.get(1))
            .map_or(remittance, |value| value.as_str())
            .into(),
    );
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn sort_transactions(transactions: &mut [Value]) {
    transactions.sort_by(|left, right| {
        let left_date = left
            .get("valueDate")
            .or_else(|| left.get("bookingDate"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_date = right
            .get("valueDate")
            .or_else(|| right.get("bookingDate"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        right_date.cmp(left_date).then_with(|| {
            let left_id = left
                .get("transactionId")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok());
            let right_id = right
                .get("transactionId")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok());
            match (left_id, right_id) {
                (Some(left), Some(right)) => right.cmp(&left),
                _ => std::cmp::Ordering::Equal,
            }
        })
    });
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    reduce_from_balance(transactions, balances, "interimBooked")
}

pub fn reduce_from_balance(transactions: &[Value], balances: &[Value], balance_type: &str) -> i64 {
    let balance = balances
        .iter()
        .find(|balance| balance.get("balanceType").and_then(Value::as_str) == Some(balance_type))
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
