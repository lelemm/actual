use regex::Regex;
use serde_json::Value;

use super::integration_bank;
use crate::util::{payee_name::format_payee_name, title::title};

pub const INSTITUTION_IDS: &[&str] = &["EASYBANK_BAWAATWW"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let transaction_object = transaction.as_object()?;
    let mut edited = transaction.clone();
    let mut payee = format_payee_name(transaction_object);
    let creditor = transaction
        .get("creditorName")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
        || transaction
            .get("creditorAccount")
            .is_some_and(|account| match account {
                Value::String(value) => !value.is_empty(),
                Value::Object(account) => account
                    .get("iban")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty()),
                _ => false,
            });
    let negative = transaction["transactionAmount"]["amount"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .is_some_and(|value| value < 0.0);
    if payee.is_empty() || (negative && !creditor) {
        let structured = transaction
            .get("remittanceInformationStructured")
            .and_then(Value::as_str)
            .unwrap_or_default();
        payee = Regex::new(r"\d{2}\.\d{2}\. \d{2}:\d{2}(.*)\\\\")
            .expect("valid bank pattern")
            .captures(structured)
            .and_then(|captures| captures.get(1))
            .map_or_else(|| structured.into(), |value| title(value.as_str()));
    }
    edited["payeeName"] = Value::String(payee);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn sort_transactions(transactions: &mut [Value]) {
    transactions.sort_by(|left, right| {
        transaction_date(right)
            .cmp(transaction_date(left))
            .then_with(|| {
                let id = |transaction: &Value| {
                    transaction
                        .get("transactionId")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(0)
                };
                id(right).cmp(&id(left))
            })
    });
}

fn transaction_date(transaction: &Value) -> &str {
    transaction
        .get("valueDate")
        .or_else(|| transaction.get("bookingDate"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}
