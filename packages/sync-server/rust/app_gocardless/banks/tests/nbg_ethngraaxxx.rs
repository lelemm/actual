use serde_json::json;

use super::super::nbg_ethngraaxxx;

#[test]
fn negates_pending_amount_and_removes_payee_prefix() {
    let normalized = nbg_ethngraaxxx::normalize_transaction(&json!({
        "bookingDate": "2024-09-03",
        "date": "2024-09-03",
        "remittanceInformationUnstructured": "ΑΓΟΡΑ testingson",
        "transactionAmount": { "amount": "100.00", "currency": "EUR" },
        "valueDate": "2024-09-03"
    }))
    .unwrap();
    assert_eq!(normalized["transactionAmount"]["amount"], "-100.00");
    assert_eq!(normalized["payeeName"], "Testingson");
}

#[test]
fn preserves_booked_amount_and_payee() {
    let normalized = nbg_ethngraaxxx::normalize_transaction(&json!({
        "transactionId": "O244015L68IK",
        "bookingDate": "2024-09-03",
        "date": "2024-09-03",
        "remittanceInformationUnstructured": "testingson",
        "transactionAmount": { "amount": "-100.00", "currency": "EUR" },
        "valueDate": "2024-09-03"
    }))
    .unwrap();
    assert_eq!(normalized["transactionAmount"]["amount"], "-100.00");
    assert_eq!(normalized["payeeName"], "Testingson");
}
