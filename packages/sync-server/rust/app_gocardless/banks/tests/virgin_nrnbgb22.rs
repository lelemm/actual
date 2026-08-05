use serde_json::json;

use super::super::virgin_nrnbgb22;

fn normalize(remittance: &str) -> serde_json::Value {
    virgin_nrnbgb22::normalize_transaction(&json!({
        "bookingDate": "2024-01-01T00:00:00Z",
        "remittanceInformationUnstructured": remittance,
        "transactionAmount": { "amount": "100", "currency": "EUR" }
    }))
    .unwrap()
}

#[test]
fn does_not_alter_simple_payee_information() {
    let normalized = normalize("DIRECT DEBIT PAYMENT");
    assert_eq!(normalized["payeeName"], "Direct Debit Payment");
    assert_eq!(normalized["notes"], "DIRECT DEBIT PAYMENT");
}

#[test]
fn formats_bank_transfer_payee_and_references() {
    let normalized = normalize("FPS, Joe Bloggs, Food");
    assert_eq!(normalized["payeeName"], "Joe Bloggs");
    assert_eq!(normalized["notes"], "Food");
}

#[test]
fn removes_method_information_from_payee_name() {
    let normalized = normalize("Card 99, Tesco Express");
    assert_eq!(normalized["payeeName"], "Tesco Express");
    assert_eq!(normalized["notes"], "Card 99, Tesco Express");
}
