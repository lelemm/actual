use serde_json::Value;

use super::{integration_bank, util::extract_payee_name_from_remittance_info::extract};

pub const INSTITUTION_IDS: &[&str] = &["KBC_KREDBEBB", "KBC_BRUSSELS_KREDBEBB"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    let amount = transaction["transactionAmount"]["amount"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let remittance = transaction
        .get("remittanceInformationUnstructured")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payee = if amount > 0.0 {
        transaction
            .get("debtorName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| (!remittance.is_empty()).then_some(remittance))
            .unwrap_or("undefined")
    } else {
        transaction
            .get("creditorName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                extract(
                    remittance,
                    &["Betaling met", "Domiciliëring", "Overschrijving"],
                )
            })
    };
    edited["payeeName"] = Value::String(payee.into());
    integration_bank::normalize_transaction_with(transaction, &edited)
}
