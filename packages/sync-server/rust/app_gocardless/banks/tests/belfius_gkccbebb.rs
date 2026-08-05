use serde_json::json;

use super::super::belfius_gkccbebb;

#[test]
fn uses_internal_transaction_id() {
    let normalized = belfius_gkccbebb::normalize_transaction(&json!({
        "transactionId": "non-unique-id",
        "internalTransactionId": "D202301180000003",
        "transactionAmount": { "amount": "100", "currency": "EUR" },
        "date": "2024-01-01T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(normalized["transactionId"], "D202301180000003");
}
