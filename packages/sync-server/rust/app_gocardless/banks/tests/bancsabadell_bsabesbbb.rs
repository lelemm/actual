use serde_json::json;

use super::super::bancsabadell_bsabesbbb;

#[test]
fn extracts_outgoing_payee() {
    let normalized = bancsabadell_bsabesbbb::normalize_transaction(&json!({
        "transactionAmount": { "amount": "-100", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": ["some-creditor-name"],
        "internalTransactionId": "d7dca139cf31d9",
        "transactionId": "04704109322",
        "bookingDate": "2022-05-01"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "Some-Creditor-Name");
}

#[test]
fn extracts_incoming_payee() {
    let normalized = bancsabadell_bsabesbbb::normalize_transaction(&json!({
        "transactionAmount": { "amount": "100", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": ["some-debtor-name"],
        "internalTransactionId": "d7dca139cf31d9",
        "transactionId": "04704109322",
        "bookingDate": "2022-05-01"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "Some-Debtor-Name");
}

#[test]
fn uses_booking_date() {
    let normalized = bancsabadell_bsabesbbb::normalize_transaction(&json!({
        "transactionAmount": { "amount": "-100", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": ["some-creditor-name"],
        "internalTransactionId": "d7dca139cf31d9",
        "transactionId": "04704109322",
        "bookingDate": "2024-10-02",
        "valueDate": "2024-10-05"
    }))
    .unwrap();
    assert_eq!(normalized["date"], "2024-10-02");
}
