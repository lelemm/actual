use serde_json::{Value, json};

use super::super::ssk_dusseldorf_dussdeddxxx;

fn booked_transaction_one() -> Value {
    json!({
        "transactionId": "2024102900000000-1",
        "bookingDate": "2024-10-29",
        "valueDate": "2024-10-29",
        "transactionAmount": { "amount": "-99.99", "currency": "EUR" },
        "creditorName": "a useful creditor name",
        "remittanceInformationStructured": "structured information",
        "remittanceInformationUnstructured": "unstructured information",
        "additionalInformation": "some additional information"
    })
}

fn booked_transaction_two() -> Value {
    json!({
        "transactionId": "2024102900000000-2",
        "bookingDate": "2024-10-29",
        "valueDate": "2024-10-29",
        "transactionAmount": { "amount": "-99.99", "currency": "EUR" },
        "creditorName": "a useful creditor name",
        "ultimateCreditor": "ultimate creditor",
        "remittanceInformationStructured": "structured information",
        "additionalInformation": "some additional information"
    })
}

#[test]
fn combines_remittance_information() {
    let first =
        ssk_dusseldorf_dussdeddxxx::normalize_transaction(&booked_transaction_one(), true).unwrap();
    let second =
        ssk_dusseldorf_dussdeddxxx::normalize_transaction(&booked_transaction_two(), true).unwrap();

    assert_eq!(
        first["notes"],
        "unstructured information some additional information"
    );
    assert_eq!(
        second["notes"],
        "structured information some additional information"
    );
}

#[test]
fn prioritizes_creditor_names() {
    let first =
        ssk_dusseldorf_dussdeddxxx::normalize_transaction(&booked_transaction_one(), true).unwrap();
    let second =
        ssk_dusseldorf_dussdeddxxx::normalize_transaction(&booked_transaction_two(), true).unwrap();

    assert_eq!(first["payeeName"], "A Useful Creditor Name");
    assert_eq!(second["payeeName"], "Ultimate Creditor");
}

#[test]
fn returns_none_for_unbooked_transactions() {
    let transaction = json!({
        "transactionId": "2024102900000000-1",
        "valueDate": "2024-10-29",
        "transactionAmount": { "amount": "-99.99", "currency": "EUR" },
        "creditorName": "some nonsensical creditor",
        "remittanceInformationUnstructured": "some nonsensical information"
    });

    assert!(ssk_dusseldorf_dussdeddxxx::normalize_transaction(&transaction, false).is_none());
}
