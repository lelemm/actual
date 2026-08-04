use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["HYPE_HYEEIT22"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let code = transaction
        .get("proprietaryBankTransactionCode")
        .and_then(Value::as_str);
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code == Some("crd") {
        edited["debtorName"] = Value::String(
            remittance
                .strip_prefix("PAGAMENTO PRESSO ")
                .unwrap_or_default()
                .into(),
        );
    }
    if matches!(code, Some("p2p" | "bon")) {
        edited["remittanceInformationUnstructured"] = Value::String(
            remittance
                .find(" - ")
                .map_or(remittance, |index| remittance[index + 3..].trim())
                .into(),
        );
    }
    if code == Some("p2p") {
        edited["remittanceInformationUnstructured"] = Value::String(decode_unicode(remittance));
    }
    edited["date"] = transaction
        .get("valueDate")
        .filter(|value| !value.is_null())
        .or_else(|| transaction.get("bookingDate"))
        .cloned()
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}

fn decode_unicode(value: &str) -> String {
    Regex::new(r"(?:\\U[0-9a-fA-F]{4})+")
        .expect("valid bank pattern")
        .replace_all(value, |captures: &regex::Captures<'_>| {
            captures[0]
                .as_bytes()
                .chunks(6)
                .filter_map(|chunk| std::str::from_utf8(&chunk[2..]).ok())
                .filter_map(|hex| u32::from_str_radix(hex, 16).ok())
                .filter_map(char::from_u32)
                .collect::<String>()
        })
        .into_owned()
}
