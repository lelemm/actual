use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BANK_OF_IRELAND_B365_BOFIIE2D"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut payee = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for pattern in [
        r"^(?:POS)?(?:C)?[0-9]{1,2}\w{3}",
        r"(?i)sepa dd$",
        r"(?i)^365 online",
        r"^CRV\*",
    ] {
        payee = Regex::new(pattern)
            .expect("valid bank pattern")
            .replace(&payee, "")
            .trim()
            .to_owned();
    }
    edited["remittanceInformationUnstructured"] = Value::String(payee);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
