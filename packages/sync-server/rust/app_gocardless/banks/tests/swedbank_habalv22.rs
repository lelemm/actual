use serde_json::{Value, json};

use super::super::swedbank_habalv22;

fn booked_card_transaction() -> Value {
    json!({
        "transactionId": "2024102900000000-1",
        "bookingDate": "2024-10-29",
        "valueDate": "2024-10-29",
        "transactionAmount": { "amount": "-22.99", "currency": "EUR" },
        "creditorName": "SOME CREDITOR NAME",
        "remittanceInformationUnstructured":
            "PIRKUMS 424242******4242 28.10.2024 22.99 EUR (111111) SOME CREDITOR NAME",
        "bankTransactionCode": "PMNT-CCRD-POSD",
        "internalTransactionId": "fa000f86afb2cc7678bcff0000000000"
    })
}

#[test]
fn extracts_card_transaction_date() {
    let normalized =
        swedbank_habalv22::normalize_transaction(&booked_card_transaction(), true).unwrap();
    assert_eq!(normalized["date"], "2024-10-28");
}

#[test]
fn leaves_non_card_transaction_date_unchanged() {
    for remittance in [json!("Some info"), json!("PIRKUMS xxx"), Value::Null] {
        let mut transaction = booked_card_transaction();
        transaction["remittanceInformationUnstructured"] = remittance;
        let normalized = swedbank_habalv22::normalize_transaction(&transaction, true).unwrap();

        assert_eq!(normalized["bookingDate"], "2024-10-29");
        assert_eq!(normalized["date"], "2024-10-29");
    }
}

#[test]
fn extracts_pending_card_transaction_creditor_name() {
    let normalized = swedbank_habalv22::normalize_transaction(
        &json!({
            "transactionId": "2024102900000000-1",
            "valueDate": "2024-10-29",
            "transactionAmount": { "amount": "-22.99", "currency": "EUR" },
            "remittanceInformationUnstructured":
                "PIRKUMS 424242******4242 28.10.24 13:37 22.99 EUR (111111) SOME CREDITOR NAME"
        }),
        false,
    )
    .unwrap();

    assert_eq!(normalized["payeeName"], "Some Creditor Name");
}
