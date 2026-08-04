use serde_json::{Value, json};

use super::super::boursobank_bousfrppxxx;

#[test]
fn matches_the_typescript_transaction_examples() {
    let examples: &[(&[&str], &str, &str)] = &[
        (
            &["CARTE 01/03/25 PAYEE NAME CB*4567"],
            "Payee Name",
            "Carte 01/03/25",
        ),
        (
            &["CARTE 01/03/25 PAYEE NAME 713621 CB*4567"],
            "Payee Name",
            "Carte 01/03/25",
        ),
        (
            &["CARTE 01/03/25 PAYEE NAME"],
            "Payee Name",
            "Carte 01/03/25",
        ),
        (
            &["CARTE 01/03/25 PAYEE NAME 7428347"],
            "Payee Name",
            "Carte 01/03/25",
        ),
        (
            &[
                "CARTE 03/02/25 PAYEE NAME CB*1234",
                "2,80 NZD / 1 euro = 1,818181818",
            ],
            "Payee Name",
            "Carte 03/02/25 2,80 NZD / 1 euro = 1,818181818",
        ),
        (
            &[
                "2,80 NZD / 1 euro = 1,818181818",
                "CARTE 03/02/25 PAYEE NAME CB*1234",
            ],
            "Payee Name",
            "Carte 03/02/25 2,80 NZD / 1 euro = 1,818181818",
        ),
        (
            &[
                "110,04 GBP / 1 euro = 0,860763454",
                "CARTE 13/07/25 PAYEE NAME",
            ],
            "Payee Name",
            "Carte 13/07/25 110,04 GBP / 1 euro = 0,860763454",
        ),
        (
            &["RETRAIT DAB 01/03/25 My location CB*9876"],
            "Retrait DAB",
            "Retrait 01/03/25 My location",
        ),
        (
            &[
                "RETRAIT DAB 01/03/25 My location CB*9876",
                "2,80 NZD / 1 euro = 1,818181818",
            ],
            "Retrait DAB",
            "Retrait 01/03/25 My location 2,80 NZD / 1 euro = 1,818181818",
        ),
        (
            &[
                "2,80 NZD / 1 euro = 1,818181818",
                "RETRAIT DAB 01/03/25 My location CB*9876",
            ],
            "Retrait DAB",
            "Retrait 01/03/25 My location 2,80 NZD / 1 euro = 1,818181818",
        ),
        (
            &["VIR Text put by the sender", "PAYEE NAME"],
            "Payee Name",
            "Text put by the sender",
        ),
        (
            &["PAYEE NAME", "VIR Text put by the sender"],
            "Payee Name",
            "Text put by the sender",
        ),
        (
            &[
                "VIR Text put by the sender",
                "PAYEE NAME",
                "Réf : SOME TEXT PUT BY THE BANK",
            ],
            "Payee Name",
            "Text put by the sender",
        ),
        (
            &["VIR INST PAYEE NAME", "Text put by the sender"],
            "Payee Name",
            "Text put by the sender",
        ),
        (
            &["Text put by the sender", "VIR INST PAYEE NAME"],
            "Payee Name",
            "Text put by the sender",
        ),
        (&["VIR INST PAYEE NAME"], "Payee Name", ""),
        (
            &[
                "VIR SEPA PAYEE NAME",
                "SOME TEXT",
                "ANOTHER TEXT",
                "YET ANOTHER TEXT",
            ],
            "Payee Name",
            "SOME TEXT ANOTHER TEXT YET ANOTHER TEXT",
        ),
        (
            &[
                "SOME TEXT",
                "ANOTHER TEXT",
                "VIR SEPA PAYEE NAME",
                "YET ANOTHER TEXT",
            ],
            "Payee Name",
            "SOME TEXT ANOTHER TEXT YET ANOTHER TEXT",
        ),
        (
            &[
                "PRLV SEPA PAYEE NAME",
                "HERE IS SOMETHING",
                "SOME OTHER TEXT",
                "30/04/2025",
                "PRELEVEMENT FOO BAR BAZ du",
            ],
            "Payee Name",
            "HERE IS SOMETHING SOME OTHER TEXT 30/04/2025 PRELEVEMENT FOO BAR BAZ du",
        ),
        (
            &[
                "30/05/2025",
                "SOME.TEXT.123.456",
                "PRELEVEMENT FOO BAR BAZ du",
                "PRLV SEPA Payee Name",
                "ABC 1934821371",
            ],
            "Payee Name",
            "30/05/2025 SOME.TEXT.123.456 PRELEVEMENT FOO BAR BAZ du ABC 1934821371",
        ),
        (
            &["ECH PRET:1823918329832913"],
            "Prêt bancaire",
            "ECH PRET:1823918329832913",
        ),
        (&["PAYEE NAME 411"], "Payee Name", ""),
        (&["PAYEE NAME\\PARIS\\ FR"], "Payee Name", ""),
        (&["PAYEE NAME 1\\PARIS\\ FR"], "Payee Name", ""),
        (
            &["AVOIR 17/06/25 PAYEE NAME CB*1234"],
            "Payee Name",
            "Avoir 17/06/25",
        ),
    ];

    for (lines, expected_payee, expected_notes) in examples {
        let transaction = json!({
            "transactionId": "1234567890",
            "bookingDate": "2025-01-01",
            "valueDate": "2025-01-01",
            "transactionAmount": { "amount": "100.00", "currency": "EUR" },
            "remittanceInformationUnstructuredArray": lines,
            "internalTransactionId": "abcdef1234567890"
        });
        let normalized = boursobank_bousfrppxxx::normalize_transaction(&transaction).unwrap();
        assert_eq!(
            normalized.get("payeeName"),
            Some(&Value::String((*expected_payee).into())),
            "{lines:?}"
        );
        assert_eq!(
            normalized.get("notes"),
            Some(&Value::String((*expected_notes).into())),
            "{lines:?}"
        );
    }
}
