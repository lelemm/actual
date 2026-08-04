use regex::Regex;
use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["ING_INGBROBU"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    let mut transaction = transaction.clone();
    let mut edited = transaction.clone();
    if transaction.get("transactionId").and_then(Value::as_str) == Some("NOTPROVIDED") {
        let remittance = transaction
            .get("remittanceInformationUnstructured")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if remittance.is_empty()
            && let Some(code) = transaction
                .get("proprietaryBankTransactionCode")
                .and_then(Value::as_str)
        {
            edited["remittanceInformationUnstructured"] = Value::String(code.into());
        }
        if booked {
            transaction["transactionId"] = transaction
                .get("internalTransactionId")
                .cloned()
                .unwrap_or(Value::Null);
            edited["creditorName"] = Value::String(
                if remittance.to_ascii_lowercase().contains("card no:") {
                    remittance.split(',').next().unwrap_or_default()
                } else {
                    &remittance
                }
                .into(),
            );
        } else {
            transaction.as_object_mut()?.remove("transactionId");
            edited["creditorName"] =
                Value::String(if remittance.to_ascii_lowercase().contains("card no:") {
                    Regex::new(r"x{4}")
                        .expect("valid bank pattern")
                        .replace_all(&remittance, "Xxxx ")
                        .into_owned()
                } else {
                    remittance.clone()
                });
            edited
                .as_object_mut()?
                .remove("remittanceInformationUnstructured");
        }
    }
    integration_bank::normalize_transaction_with(&transaction, &edited)
}
