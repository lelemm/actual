use regex::Regex;
use serde_json::Value;

use super::{ing_ingddeff, integration_bank};

pub const INSTITUTION_IDS: &[&str] = &[
    "NORWEGIAN_NO_NORWNOK1",
    "NORWEGIAN_SE_NORWNOK1",
    "NORWEGIAN_DE_NORWNOK1",
    "NORWEGIAN_DK_NORWNOK1",
    "NORWEGIAN_ES_NORWNOK1",
    "NORWEGIAN_FI_NORWNOK1",
];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    let mut edited = transaction.clone();
    if booked {
        edited["date"] = transaction
            .get("bookingDate")
            .cloned()
            .unwrap_or(Value::Null);
    } else if let Some(value_date) = transaction.get("valueDate") {
        edited["date"] = value_date.clone();
    } else if let Some(date) = transaction
        .get("remittanceInformationStructured")
        .and_then(Value::as_str)
        .and_then(|value| {
            Regex::new(r" (\d{4}-\d{2}-\d{2}) ")
                .expect("valid bank pattern")
                .captures(value)
                .and_then(|captures| captures.get(1))
                .map(|value| value.as_str().to_owned())
        })
    {
        edited["date"] = Value::String(date);
    } else {
        return None;
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    ing_ingddeff::reduce_from_balance(transactions, balances, "expected")
}
