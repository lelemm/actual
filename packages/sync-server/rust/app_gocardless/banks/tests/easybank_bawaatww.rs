use serde_json::json;

use super::super::easybank_bawaatww;

#[test]
fn matches_the_typescript_transaction_examples() {
    let examples = [
        (
            json!({
                "creditorName": "Some Payee Name",
                "transactionAmount": { "amount": "-100", "currency": "EUR" },
                "bookingDate": "2024-01-01",
                "creditorAccount": "AT611904300234573201",
                "debtorAccount": { "iban": "AT611904300234573202" }
            }),
            "Some Payee Name",
        ),
        (
            json!({
                "payeeName": "",
                "transactionAmount": { "amount": "-100", "currency": "EUR" },
                "remittanceInformationStructured": "Bezahlung Karte MC/000001234POS 1234 K001 12.12. 23:59SOME PAYEE NAME\\\\LOCATION\\1",
                "bookingDate": "2023-12-31",
                "debtorAccount": { "iban": "AT611904300234573202" }
            }),
            "Some Payee Name",
        ),
        (
            json!({
                "payeeName": "",
                "transactionAmount": { "amount": "-100", "currency": "EUR" },
                "remittanceInformationStructured": "Auszahlung Karte MC/000001234AUTOMAT 00012345 K001 31.12. 23:59",
                "bookingDate": "2023-12-31",
                "debtorAccount": { "iban": "AT611904300234573202" }
            }),
            "Auszahlung Karte MC/000001234AUTOMAT 00012345 K001 31.12. 23:59",
        ),
    ];

    for (transaction, expected_payee) in examples {
        let normalized = easybank_bawaatww::normalize_transaction(&transaction).unwrap();
        assert_eq!(normalized["payeeName"], expected_payee, "{transaction}");
    }
}
