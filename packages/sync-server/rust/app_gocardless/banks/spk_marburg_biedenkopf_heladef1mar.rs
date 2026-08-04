use serde_json::Value;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &["SPK_MARBURG_BIEDENKOPF_HELADEF1MAR"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["remittanceInformationUnstructured"] = transaction
        .get("remittanceInformationUnstructured")
        .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
        .or_else(|| transaction.get("remittanceInformationStructured"))
        .cloned()
        .or_else(|| {
            transaction
                .get("remittanceInformationStructuredArray")
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty())
                .map(|values| {
                    Value::String(
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" "),
                    )
                })
        })
        .unwrap_or(Value::Null);
    integration_bank::normalize_transaction_with(transaction, &edited)
}
