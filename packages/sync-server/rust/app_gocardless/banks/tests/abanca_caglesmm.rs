use serde_json::json;

use super::super::abanca_caglesmm;

#[test]
fn returns_structured_remittance_as_payee() {
    let normalized = abanca_caglesmm::normalize_transaction(&json!({
        "transactionId": "non-unique-id",
        "internalTransactionId": "D202301180000003",
        "transactionAmount": { "amount": "100", "currency": "EUR" },
        "remittanceInformationStructured": "some-creditor-name",
        "date": "2024-01-01T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["payeeName"], "Some-Creditor-Name");
}
