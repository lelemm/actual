use serde_json::json;

use super::super::fortuneo_ftnofrp1xxx;

fn normalize(remittance: &str, amount: &str) -> serde_json::Value {
    fortuneo_ftnofrp1xxx::normalize_transaction(&json!({
        "bookingDate": "2024-07-05",
        "valueDate": "2024-07-05",
        "transactionAmount": { "amount": amount, "currency": "EUR" },
        "remittanceInformationUnstructuredArray": [remittance],
        "internalTransactionId": "674323725470140d5caaf7b85a135817",
        "date": "2024-07-05"
    }))
    .unwrap()
}

#[test]
fn sets_a_payee_for_both_amount_directions() {
    assert!(normalize("PRLV ONG", "-12.0")["payeeName"].is_string());
    assert!(normalize("ANN CARTE WEEZEVENT SOMEPLACE", "26.52")["payeeName"].is_string());
}

#[test]
fn extracts_payees_from_every_source_example() {
    for (remittance, amount, expected) in [
        ("PRLV ONG", "-12.0", "Ong"),
        ("VIR XXXYYYYZZZ", "-500.0", "Xxxyyyyzzz"),
        (
            "CARTE 04/07 Google Payment I Dublin",
            "-10.49",
            "Google Payment I Dublin",
        ),
        ("CARTE 03/07 SPORT MARKET", "-6.38", "Sport Market"),
        (
            "ANN CARTE WEEZEVENT SOMEPLACE",
            "26.52",
            "Weezevent Someplace",
        ),
        (
            "VIR INST Leclerc XXXX  Leclerc XXXX  44321IXCRT211141232",
            "-22.95",
            "Leclerc Xxxx  Leclerc Xxxx  44321ixcrt211141232",
        ),
    ] {
        assert_eq!(
            normalize(remittance, amount)["payeeName"],
            expected,
            "{remittance}"
        );
    }
}
