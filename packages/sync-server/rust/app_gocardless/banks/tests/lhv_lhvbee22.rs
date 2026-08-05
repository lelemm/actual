use serde_json::{Value, json};

use super::super::lhv_lhvbee22;

fn booked(remittance: Value) -> Value {
    lhv_lhvbee22::normalize_transaction(
        &json!({
            "transactionId": "2025010300000000-1",
            "bookingDate": "2025-01-03",
            "valueDate": "2025-01-03",
            "transactionAmount": { "amount": "-22.99", "currency": "EUR" },
            "creditorName": null,
            "remittanceInformationUnstructured": remittance,
            "bankTransactionCode": "PMNT-CCRD-POSD",
            "internalTransactionId": "fa000f86afb2cc7678bcff0000000000"
        }),
        true,
    )
    .unwrap()
}

#[test]
fn extracts_booked_card_payee() {
    assert_eq!(
        booked(json!(
            "(..1234) 2025-01-02 09:32 CrustumOU\\Poordi 3\\Tallinn\\10156     ESTEST"
        ))["payeeName"],
        "CrustumOU"
    );
}

#[test]
fn extracts_booked_card_date() {
    assert_eq!(
        booked(json!(
            "(..1234) 2025-01-02 09:32 CrustumOU\\Poordi 3\\Tallinn\\10156     ESTEST"
        ))["date"],
        "2025-01-02"
    );
}

#[test]
fn keeps_booking_date_for_non_card_remittances() {
    for remittance in [
        json!("Some info"),
        json!("PIRKUMS xxx"),
        Value::Null,
        json!("(..1234) 2025-13-45 09:32 Merchant\\Address"),
        json!("(..1234) 0000-01-02 09:32 Merchant\\Address"),
    ] {
        assert_eq!(booked(remittance)["date"], "2025-01-03");
    }
}

fn pending() -> Value {
    lhv_lhvbee22::normalize_transaction(&json!({
        "transactionId": "2025010300000000-1",
        "valueDate": "2025-01-03",
        "transactionAmount": { "amount": "-22.99", "currency": "EUR" },
        "remittanceInformationUnstructured": "(..1234) 2025-01-02 09:32 CrustumOU\\Poordi 3\\Tallinn\\10156     ESTEST"
    }), false).unwrap()
}

#[test]
fn extracts_pending_card_payee() {
    assert_eq!(pending()["payeeName"], "CrustumOU");
}

#[test]
fn keeps_pending_value_date() {
    assert_eq!(pending()["date"], "2025-01-03");
}
