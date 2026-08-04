use serde_json::{Value, json};

use super::super::bper_retail_bpmoit22;

#[test]
fn matches_the_typescript_transaction_examples() {
    let examples = [
        (
            "PAGAMENTO SU CIRCUITO INTERNAZIONALE HEALTHCARE DISTRICT ZX042 METROPOLIS ITA Operazione carta ****8005 del 15.09.2025",
            "-17.80",
            "Healthcare District Zx042 Metropolis Ita",
        ),
        (
            "BONIFICO o/c: ACME CONSULTING SRL ABI-CAB: 03015-03200 a favore di Example Recipient Num. Bon.Sepa 252531000195141 Note di cortesia",
            "1000.00",
            "Acme Consulting Srl",
        ),
        (
            "BONIFICI ESTERI o/c: GLOBAL PARTNERS LTD BIC: EXAMPGB2L a favore di Example Recipient (BPER) Num. Bon.Sepa 252131000238275BE Memo casuale 1.000,00 EUR",
            "1000.00",
            "Global Partners Ltd",
        ),
        (
            "ADDEBITO SDD CLOUD HOSTING LTD N: 1057087621/48 ID:0210000049513 Cod.Cl. K309846700/ Fatt. 109993626070 Deb: Example Account Owner",
            "-1.22",
            "Cloud Hosting Ltd",
        ),
        (
            "PAGAMENTI DIVERSI DA INTERNET BANKING E CSA PAGAMENTO BOLLETTINO POSTALE 420251388002409360 DEL 22/06/2025 TRAMITE I.B. / CSA TIPO : 896 CCPOST : 000000000000 CREDITORE: UTILITY COMPANY S.P.A.",
            "-171.34",
            "Utility Company S.P.A.",
        ),
        (
            "COMPETENZE SPESE ED ONERI",
            "-4.90",
            "Competenze Spese Ed Oneri",
        ),
    ];

    for (description, amount, expected_payee) in examples {
        let transaction = json!({
            "bookingDate": "2025-09-17",
            "remittanceInformationUnstructured": description,
            "transactionAmount": { "amount": amount, "currency": "EUR" }
        });
        let normalized = bper_retail_bpmoit22::normalize_transaction(&transaction).unwrap();
        assert_eq!(
            normalized.get("payeeName"),
            Some(&Value::String(expected_payee.into())),
            "{description}"
        );
        assert_eq!(
            normalized.get("notes"),
            Some(&Value::String(description.into())),
            "{description}"
        );
    }
}
