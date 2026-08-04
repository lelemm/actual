use serde_json::{Value, json};

use crate::app_gocardless::utils::amount_to_integer;

use super::integration_bank;

pub const INSTITUTION_IDS: &[&str] = &[
    "SEB_KORT_AB_NO_SKHSFI21",
    "SEB_KORT_AB_SE_SKHSFI21",
    "SEB_CARD_ESSESESS",
    "NORDIC_CHOICE_CLUB_NO_SKHSFI21",
    "NORDIC_CHOICE_CLUB_SE_SKHSFI21",
    "EUROCARD_SE_SKHSFI21",
    "EUROCARD_DK_SKHSFI21",
    "EUROCARD_FI_SKHSFI21",
    "EUROCARD_NO_SKHSFI21",
    "GLOBECARD_DK_SKHSFI21",
    "GLOBECARD_NO_SKHSFI21",
    "OPEL_MASTERCARD_SKHSFI21",
    "SAAB_MASTERCARD_SKHSFI21",
    "SAS_MASTERCARD_NO_SKHSFI21",
    "SAS_MASTERCARD_SE_SKHSFI21",
    "SAS_MASTERCARD_FI_SKHSFI21",
    "SAS_MASTERCARD_DK_SKHSFI21",
    "SJ_PRIO_MASTERCARD_SKHSFI21",
    "CIRCLE_K_MASTERCARD_NO_SKHSFI21",
    "CIRCLE_K_MASTERCARD_SE_SKHSFI21",
    "CIRCLE_K_MASTERCARD_DK_SKHSFI21",
    "WALLET_SKHSFI21",
    "INGO_MASTERCARD_SKHSFI21",
    "SCANDIC_SKHSFI21",
];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    let mut edited = transaction.clone();
    edited["creditorName"] = transaction
        .get("additionalInformation")
        .cloned()
        .unwrap_or(Value::Null);
    let mut transaction = transaction.clone();
    let amount = transaction["transactionAmount"]["amount"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    transaction["transactionAmount"] = json!({
        "amount": (-amount).to_string(),
        "currency": transaction["transactionAmount"]["currency"].clone()
    });
    integration_bank::normalize_transaction_with(&transaction, &edited)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    let balance = |kind| {
        balances
            .iter()
            .find(|balance| balance.get("balanceType").and_then(Value::as_str) == Some(kind))
            .and_then(|value| value.get("balanceAmount"))
            .and_then(|value| value.get("amount"))
            .map(amount_to_integer)
            .unwrap_or(0)
    };
    transactions.iter().fold(
        -balance("expected") + balance("nonInvoiced"),
        |total, transaction| {
            total
                - transaction
                    .get("transactionAmount")
                    .and_then(|value| value.get("amount"))
                    .map(amount_to_integer)
                    .unwrap_or(0)
        },
    )
}
