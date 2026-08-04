use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["REVOLUT_REVOLT21"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let info = transaction
        .get("remittanceInformationUnstructuredArray")
        .and_then(Value::as_array);
    if let Some(first) = info
        .and_then(|values| values.first())
        .and_then(Value::as_str)
    {
        if let Some(payee) = first.strip_prefix("Bizum payment from: ") {
            edited["payeeName"] = Value::String(payee.into());
            edited["remittanceInformationUnstructured"] = info
                .and_then(|values| values.get(1))
                .cloned()
                .unwrap_or(Value::Null);
        }
        if first.starts_with("Bizum payment to: ") {
            edited["remittanceInformationUnstructured"] = info
                .and_then(|values| values.get(1))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    integration_bank::normalize_transaction_with(transaction, &edited)
}
