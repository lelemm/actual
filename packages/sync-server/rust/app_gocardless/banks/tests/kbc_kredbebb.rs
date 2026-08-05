use serde_json::json;

use super::super::kbc_kredbebb;

const REMITTANCE: &str = "CARREFOUR ST GIL BE1060 BRUXELLES Betaling met Google Pay via Debit Mastercard 28-08-2024 om 19.15 uur 5127 04XX XXXX 1637 5853 98XX XXXX 2266 JOHN SMITH";

#[test]
fn extracts_outgoing_payee_from_remittance() {
    let normalized = kbc_kredbebb::normalize_transaction(&json!({
        "remittanceInformationUnstructured": REMITTANCE,
        "transactionAmount": { "amount": "-10.99", "currency": "EUR" },
        "date": "2024-08-28T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "CARREFOUR ST GIL BE1060 BRUXELLES");
}

#[test]
fn uses_debtor_for_incoming_payment() {
    let normalized = kbc_kredbebb::normalize_transaction(&json!({
        "debtorName": "CARREFOUR ST GIL BE1060 BRUXELLES",
        "remittanceInformationUnstructured": REMITTANCE,
        "transactionAmount": { "amount": "10.99", "currency": "EUR" },
        "date": "2024-08-28T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "CARREFOUR ST GIL BE1060 BRUXELLES");
}
