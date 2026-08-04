use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BERLINER_SPARKASSE_BELADEBEXXX"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .or_else(|| {
            transaction
                .get("remittanceInformationStructured")
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
        .or_else(|| {
            transaction
                .get("remittanceInformationStructuredArray")
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
        })
        .unwrap_or_default();
    if let Some(additional) = transaction
        .get("additionalInformation")
        .and_then(Value::as_str)
    {
        remittance.push(' ');
        remittance.push_str(additional);
    }
    edited["creditorName"] = ["ultimateCreditor", "creditorName", "debtorName"]
        .iter()
        .find_map(|field| {
            transaction
                .get(*field)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .map_or(Value::Null, |value| Value::String(value.into()));
    edited["remittanceInformationUnstructured"] = Value::String(remittance);
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
