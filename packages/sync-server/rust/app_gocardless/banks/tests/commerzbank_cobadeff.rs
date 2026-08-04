use serde_json::json;

use super::super::commerzbank_cobadeff;

#[test]
fn matches_the_typescript_transaction_examples() {
    let examples = [
        (
            json!({
                "bookingDate": "2024-12-20",
                "transactionAmount": { "amount": "-12.34", "currency": "EUR" },
                "creditorName": "SHOP NAME CITY DE",
                "remittanceInformationUnstructuredArray": ["SHOP NAME//CITY/DE", "2024-12-19T15:34:31 KFN 1 AB 1234", "Kartenzahlung"]
            }),
            "2024-12-19T15:34:31 KFN 1 AB 1234, Kartenzahlung",
        ),
        (
            json!({
                "bookingDate": "2024-10-11",
                "transactionAmount": { "amount": "-56.78", "currency": "EUR" },
                "creditorName": "Long payee name that is eaxtly 35ch",
                "remittanceInformationUnstructuredArray": ["Long payee name that is eaxtly 35ch", "901234567890/. Long description tha", "t gets cut and is very long, did I", "mention it is long", "End-to-En", "d-Ref.: 901234567890", "Mandatsref: ABC123DEF456", "Gläubiger-ID:", "AB12CDE0000000000000000012", "SEPA-BASISLASTSCHRIFT wiederholend"]
            }),
            "901234567890/. Long description tha t gets cut and is very long, did I mention it is long, End-to-End-Ref.: 901234567890, Mandatsref: ABC123DEF456, Gläubiger-ID: AB12CDE0000000000000000012, SEPA-BASISLASTSCHRIFT wiederholend",
        ),
        (
            json!({
                "bookingDate": "2024-12-02",
                "transactionAmount": { "amount": "-9", "currency": "EUR" },
                "creditorName": "CREDITOR NAME",
                "remittanceInformationUnstructuredArray": ["CREDITOR NAME", "CREDITOR00BIC", "CREDITOR000IBAN", "DESCRIPTION", "End-to-End-Ref.: NOTPROVIDED", "Dauerauftrag"]
            }),
            "CREDITOR00BIC CREDITOR000IBAN DESCRIPTION, Dauerauftrag",
        ),
        (
            json!({
                "bookingDate": "2025-04-18",
                "transactionAmount": { "amount": "-1", "currency": "EUR" },
                "creditorName": "Netto Marken-Discount Halle (Saale",
                "remittanceInformationUnstructuredArray": ["Example"]
            }),
            "Example",
        ),
    ];

    for (transaction, expected_notes) in examples {
        let normalized = commerzbank_cobadeff::normalize_transaction(&transaction).unwrap();
        assert_eq!(normalized["notes"], expected_notes, "{transaction}");
    }
}
