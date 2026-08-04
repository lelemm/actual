use std::collections::HashMap;

use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] =
    &["FINTRO_BE_GEBABEBB", "HELLO_BE_GEBABEBB", "BNP_BE_GEBABEBB"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let mut creditor = transaction
        .get("creditorName")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(additional) = transaction
        .get("additionalInformation")
        .and_then(Value::as_str)
    {
        let field_pattern =
            Regex::new(r"(?:, )?([^:]+): ((\[.*?\])|([^,]*))").expect("valid bank pattern");
        let quote_pattern = Regex::new(r"'(.+?)'").expect("valid bank pattern");
        let cleanup = Regex::new(r"[\[\]',]").expect("valid bank pattern");
        let mut fields = HashMap::new();
        let mut narrative_name = None;
        for captures in field_pattern.captures_iter(additional) {
            let key = captures
                .get(1)
                .map(|value| value.as_str().trim())
                .unwrap_or_default();
            let raw = captures
                .get(2)
                .map(|value| value.as_str().trim())
                .unwrap_or_default();
            if key == "narrative" {
                narrative_name = quote_pattern
                    .captures(raw)
                    .and_then(|captures| captures.get(1))
                    .map(|value| value.as_str().trim().to_owned());
            }
            fields.insert(key, cleanup.replace_all(raw, "").into_owned());
        }
        let mut info = transaction
            .get("remittanceInformationUnstructuredArray")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for key in ["atmPosName", "narrative"] {
            if let Some(value) = fields.get(key).filter(|value| !value.is_empty()) {
                info.push(Value::String(value.clone()));
            }
        }
        edited["remittanceInformationUnstructuredArray"] = Value::Array(info);
        if creditor.is_null() {
            creditor = fields
                .get("atmPosName")
                .filter(|value| !value.is_empty())
                .cloned()
                .or(narrative_name)
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
    }
    edited["creditorName"] = creditor;
    integration_bank::normalize_transaction_with(transaction, &edited)
}
