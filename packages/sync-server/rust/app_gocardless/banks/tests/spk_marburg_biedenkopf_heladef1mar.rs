use serde_json::{Value, json};

use crate::app_gocardless::bank_factory;

use super::super::spk_marburg_biedenkopf_heladef1mar;

fn raw_transactions() -> Vec<Value> {
    json!([
        { "transactionId": "fefa0b605ac14a7eb14f4c8ab6a6af55", "bookingDate": "2023-12-29", "valueDate": "2023-12-29", "transactionAmount": { "amount": "-40.00", "currency": "EUR" }, "creditorName": "JET Tankstelle", "remittanceInformationStructured": "AUTORISATION  28.12. 18:30", "proprietaryBankTransactionCode": "NSTO+000+0000+000-AA", "internalTransactionId": "761660c052ed48e78c2be39775f08da9", "date": "2023-12-29" },
        { "transactionId": "1a8e5d0df259472694f13132001af0a6", "bookingDate": "2023-12-28", "valueDate": "2023-12-28", "transactionAmount": { "amount": "-1242.47", "currency": "EUR" }, "creditorName": "Peter Muster", "remittanceInformationStructured": "Miete 12/2023", "proprietaryBankTransactionCode": "NSTO+111+1111+111-BB", "internalTransactionId": "5a20ac78b146401e940b6fee30ee404b", "date": "2023-12-28" },
        { "transactionId": "166983e65ec54000a361a952e6161f33", "bookingDate": "2023-12-27", "valueDate": "2023-12-27", "transactionAmount": { "amount": "1541.23", "currency": "EUR" }, "debtorName": "Arbeitgeber AG", "remittanceInformationStructured": "Lohn/Gehalt 12/2023", "proprietaryBankTransactionCode": "NSTO+222+2222+222-CC", "internalTransactionId": "51630dda877f45f186d315b8058d891a", "date": "2023-12-27" },
        { "transactionId": "4dd9f4c9968a45739c0705ebc675b54b", "bookingDate": "2023-12-26", "valueDate": "2023-12-26", "transactionAmount": { "amount": "-8.00", "currency": "EUR" }, "remittanceInformationStructuredArray": ["Entgeltabrechnung", "siehe Anlage"], "proprietaryBankTransactionCode": "NSTO+333+3333+333-DD", "internalTransactionId": "9c58c87c2d1644e4a5e149c837c16bbb", "date": "2023-12-26" }
    ])
    .as_array()
    .unwrap()
    .clone()
}

fn normalized_transactions() -> Vec<Value> {
    raw_transactions()
        .iter()
        .filter_map(spk_marburg_biedenkopf_heladef1mar::normalize_transaction)
        .collect()
}

#[test]
fn normalizes_account_for_frontend() {
    let account = json!({
        "resourceId": "e896eec6-6096-4efc-a941-756bd9d74765", "iban": "DE50533500000123456789", "currency": "EUR",
        "ownerName": "JANE DOE", "product": "Sichteinlagen", "bic": "HELADEF1MAR", "usage": "PRIV",
        "id": "a787ba27-02ee-4fd6-be86-73831adc5498", "created": "2024-01-01T14:17:11.630352Z",
        "last_accessed": "2024-01-01T14:19:42.709478Z", "institution_id": "SPK_MARBURG_BIEDENKOPF_HELADEF1MAR",
        "status": "READY", "owner_name": "JANE DOE",
        "institution": {
            "id": "SPK_MARBURG_BIEDENKOPF_HELADEF1MAR", "name": "Sparkasse Marburg-Biedenkopf", "bic": "HELADEF1MAR",
            "transaction_total_days": "360", "max_access_valid_for_days": "90", "countries": ["DE"],
            "logo": "https://storage.googleapis.com/gc-prd-institution_icons-production/DE/PNG/sparkasse.png",
            "supported_payments": { "single-payment": ["SCT", "ISCT"] },
            "supported_features": ["card_accounts", "payments", "pending_transactions"]
        }
    });
    let normalized = bank_factory::normalize_account(
        "SPK_MARBURG_BIEDENKOPF_HELADEF1MAR",
        account.as_object().unwrap(),
    );
    assert_eq!(
        normalized,
        json!({
            "account_id": "a787ba27-02ee-4fd6-be86-73831adc5498", "iban": "DE50533500000123456789",
            "institution": account["institution"].clone(), "mask": "6789",
            "name": "Sichteinlagen (XXX 6789) EUR", "official_name": "Sichteinlagen", "type": "checking"
        })
    );
}

#[test]
fn falls_back_to_structured_remittance() {
    let normalized =
        spk_marburg_biedenkopf_heladef1mar::normalize_transaction(&raw_transactions()[0]).unwrap();
    assert_eq!(normalized["notes"], "AUTORISATION  28.12. 18:30");
}

#[test]
fn falls_back_to_structured_remittance_array() {
    let normalized =
        spk_marburg_biedenkopf_heladef1mar::normalize_transaction(&raw_transactions()[3]).unwrap();
    assert_eq!(normalized["notes"], "Entgeltabrechnung siehe Anlage");
}

#[test]
fn generic_sort_handles_empty_inputs() {
    let mut empty: Vec<Value> = Vec::new();
    bank_factory::sort_transactions("SPK_MARBURG_BIEDENKOPF_HELADEF1MAR", &mut empty);
    assert!(empty.is_empty());
}

#[test]
fn sorts_unsorted_inputs_back_to_original_order() {
    let original = normalized_transactions();
    let mut shuffled = vec![
        original[2].clone(),
        original[3].clone(),
        original[0].clone(),
        original[1].clone(),
    ];
    bank_factory::sort_transactions("SPK_MARBURG_BIEDENKOPF_HELADEF1MAR", &mut shuffled);
    assert_eq!(shuffled, original);
}

#[test]
fn calculates_starting_balance() {
    assert_eq!(
        bank_factory::calculate_starting_balance("SPK_MARBURG_BIEDENKOPF_HELADEF1MAR", &[], &[]),
        0
    );
    let balances = json!([{ "balanceAmount": { "amount": "3596.87", "currency": "EUR" }, "balanceType": "closingBooked", "referenceDate": "2023-12-29" }]);
    let mut transactions = normalized_transactions();
    bank_factory::sort_transactions("SPK_MARBURG_BIEDENKOPF_HELADEF1MAR", &mut transactions);
    assert_eq!(
        bank_factory::calculate_starting_balance(
            "SPK_MARBURG_BIEDENKOPF_HELADEF1MAR",
            &transactions,
            balances.as_array().unwrap()
        ),
        334_611
    );
    assert_eq!(
        bank_factory::calculate_starting_balance(
            "SPK_MARBURG_BIEDENKOPF_HELADEF1MAR",
            &[],
            balances.as_array().unwrap()
        ),
        359_687
    );
}
