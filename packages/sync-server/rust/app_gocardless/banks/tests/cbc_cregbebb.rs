use serde_json::json;

use super::super::cbc_cregbebb;

const REMITTANCE: &str = "ONKART FR Viry Paiement Maestro par Carte de débit CBC 05-09-2024 à 15.43 heures 6703 19XX XXXX X201 5 JOHN DOE";

#[test]
fn extracts_outgoing_payee_from_remittance() {
    let normalized = cbc_cregbebb::normalize_transaction(&json!({
        "remittanceInformationUnstructured": REMITTANCE,
        "transactionAmount": { "amount": "-45.00", "currency": "EUR" },
        "date": "2024-09-05T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "ONKART FR Viry");
}

#[test]
fn uses_debtor_for_incoming_payment() {
    let normalized = cbc_cregbebb::normalize_transaction(&json!({
        "debtorName": "ONKART FR Viry",
        "remittanceInformationUnstructured": REMITTANCE,
        "transactionAmount": { "amount": "10.99", "currency": "EUR" },
        "date": "2024-09-05T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "ONKART FR Viry");
}
