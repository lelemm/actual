use serde_json::json;

use super::super::raiffeisen_at_rzbaatww;

#[test]
fn matches_the_typescript_transaction_examples() {
    let payee_examples = [
        (
            json!({
                "bookingDate": "2025-01-01",
                "transactionAmount": { "amount": "100", "currency": "EUR" },
                "remittanceInformationStructured": "NOTHING STRUCTURED"
            }),
            "NOTHING STRUCTURED",
        ),
        (
            json!({
                "bookingDate": "2025-01-01",
                "transactionAmount": { "amount": "100", "currency": "EUR" },
                "remittanceInformationStructured": "COMPANY ABCD 2610  D5   01.01. 13:37"
            }),
            "Company Abcd",
        ),
        (
            json!({
                "bookingDate": "2025-01-01",
                "transactionAmount": { "amount": "100", "currency": "EUR" },
                "creditorName": "Reci Pient",
                "creditorAccount": { "iban": "AT201100021493538935" },
                "remittanceInformationStructured": "just some text here"
            }),
            "Reci Pient (AT20 XXX 8935)",
        ),
        (
            json!({
                "bookingDate": "2025-01-01",
                "transactionAmount": { "amount": "100", "currency": "EUR" },
                "remittanceInformationUnstructured": "COMPANY NAME CITY 1010",
                "remittanceInformationStructured": "POS           1,11 AT  D4   01.01. 13:37"
            }),
            "Company Name City 1010",
        ),
    ];
    for (transaction, expected_payee) in payee_examples {
        let normalized = raiffeisen_at_rzbaatww::normalize_transaction(&transaction).unwrap();
        assert_eq!(normalized["payeeName"], expected_payee, "{transaction}");
    }

    let transaction = json!({
        "bookingDate": "2025-01-01",
        "transactionAmount": { "amount": "100", "currency": "EUR" },
        "creditorName": "Creditor",
        "endToEndId": "Transaction 1234"
    });
    let normalized = raiffeisen_at_rzbaatww::normalize_transaction(&transaction).unwrap();
    assert_eq!(normalized["notes"], "Transaction 1234");
}
