use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["BPER_RETAIL_BPMOIT22"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let description = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !description.is_empty() {
        edited["remittanceInformationUnstructured"] = Value::String(description.into());
    }
    let payee = if description.starts_with("PAGAMENTO SU CIRCUITO INTERNAZIONALE") {
        description
            .split("Operazione carta")
            .next()
            .unwrap_or_default()
            .replace("PAGAMENTO SU CIRCUITO INTERNAZIONALE", "")
            .trim()
            .to_owned()
    } else if description.starts_with("BONIFICO") || description.starts_with("BONIFICI ESTERI") {
        capture(
            description,
            r"(?i)o/c:\s*([A-Z0-9\s.'/&-]+?)(?:ABI|BIC|IBAN|a favore di|Num|EUR|$)",
        )
    } else if description.starts_with("ADDEBITO SDD") {
        capture(
            description,
            r"(?i)ADDEBITO SDD\s+([A-Z0-9\s.'/&-]+?)(?:N:|ID:|$)",
        )
    } else if description.contains("CREDITORE:") {
        capture(description, r"(?i)CREDITORE:\s*([A-Z0-9\s.'/&-]+)")
    } else {
        String::new()
    };
    if !payee.is_empty() {
        edited["creditorName"] = Value::String(payee.clone());
        edited["debtorName"] = Value::String(payee);
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}

fn capture(value: &str, pattern: &str) -> String {
    Regex::new(pattern)
        .expect("valid bank pattern")
        .captures(value)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_owned())
        .unwrap_or_default()
}
