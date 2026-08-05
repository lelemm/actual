use serde_json::json;

use super::super::revolut_revolt21;

#[test]
fn uses_bizum_description_for_expense_notes() {
    let normalized = revolut_revolt21::normalize_transaction(&json!({
        "transactionAmount": { "amount": "-1.00", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": [
            "Bizum payment to: CREDITOR NAME",
            "Bizum description"
        ],
        "bookingDate": "2024-09-21"
    }))
    .unwrap();

    assert_eq!(normalized["notes"], "Bizum description");
}

#[test]
fn uses_bizum_sender_and_description_for_income() {
    let normalized = revolut_revolt21::normalize_transaction(&json!({
        "transactionAmount": { "amount": "1.00", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": [
            "Bizum payment from: DEBTOR NAME",
            "Bizum description"
        ],
        "bookingDate": "2024-09-21"
    }))
    .unwrap();

    assert_eq!(normalized["payeeName"], "DEBTOR NAME");
    assert_eq!(normalized["notes"], "Bizum description");
}
