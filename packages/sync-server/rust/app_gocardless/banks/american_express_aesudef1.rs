use serde_json::Value;

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["AMERICAN_EXPRESS_AESUDEF1"];

pub fn normalize_account(account: &serde_json::Map<String, Value>) -> Value {
    let mut normalized = integration_bank::normalize_account(account);
    let iban = account
        .get("iban")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mask = iban.get(iban.len().saturating_sub(5)..).unwrap_or(iban);
    let details = account
        .get("details")
        .and_then(Value::as_str)
        .unwrap_or_default();
    normalized["mask"] = Value::String(mask.into());
    normalized["iban"] = Value::Null;
    normalized["name"] = Value::String(format!("{details} ({mask})"));
    normalized["official_name"] = Value::String(details.into());
    normalized
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    let balance = balances
        .iter()
        .find(|balance| balance.get("balanceType").and_then(Value::as_str) == Some("information"))
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
