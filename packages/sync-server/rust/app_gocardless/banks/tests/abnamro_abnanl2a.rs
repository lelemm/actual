use serde_json::json;

use super::super::abnamro_abnanl2a;

fn transaction(lines: &[&str]) -> serde_json::Value {
    json!({
        "transactionId": "0123456789012345",
        "bookingDate": "2023-12-11",
        "valueDateTime": "2023-12-09T15:43:37.950",
        "transactionAmount": { "amount": "-10.00", "currency": "EUR" },
        "remittanceInformationUnstructuredArray": lines
    })
}

#[test]
fn extracts_card_payee_and_notes() {
    let lines = [
        "BEA, Betaalpas",
        "My Payee Name,PAS123",
        "NR:123A4B, 09.12.23/15:43",
        "CITY",
    ];
    let normalized = abnamro_abnanl2a::normalize_transaction(&transaction(&lines)).unwrap();
    assert_eq!(normalized["payeeName"], "My Payee Name");
    assert_eq!(normalized["notes"], lines.join(", "));
}

#[test]
fn extracts_google_pay_payee_and_notes() {
    let lines = [
        "BEA, Google Pay",
        "CCV*Other payee name,PAS123",
        "NR:123A4B, 09.12.23/15:43",
        "CITY",
    ];
    let normalized = abnamro_abnanl2a::normalize_transaction(&transaction(&lines)).unwrap();
    assert_eq!(normalized["payeeName"], "Other Payee Name");
    assert_eq!(normalized["notes"], lines.join(", "));
}
