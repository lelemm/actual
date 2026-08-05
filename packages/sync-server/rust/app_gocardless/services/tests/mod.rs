mod fixtures;
mod gocardless_service;

use serde_json::{Value, json};

#[test]
fn shared_fixtures_exactly_preserve_typescript_values_and_composite_merges() {
    assert_eq!(
        fixtures::mocked_balances(),
        json!({ "balances": [
        { "balanceAmount": { "amount": "657.49", "currency": "string" }, "balanceType": "interimAvailable", "referenceDate": "2021-11-22" },
        { "balanceAmount": { "amount": "185.67", "currency": "string" }, "balanceType": "interimAvailable", "referenceDate": "2021-11-19" }
    ] })
    );
    assert_eq!(
        fixtures::mock_transactions(),
        json!({ "transactions": {
        "booked": [
            { "transactionId": "string", "debtorName": "string", "debtorAccount": { "iban": "string" }, "transactionAmount": { "currency": "EUR", "amount": "328.18" }, "bankTransactionCode": "string", "bookingDate": "2000-01-01", "valueDate": "2000-01-01" },
            { "transactionId": "string", "transactionAmount": { "currency": "EUR", "amount": "947.26" }, "bankTransactionCode": "string", "bookingDate": "2000-01-01", "valueDate": "2000-01-01" }
        ],
        "pending": [{ "transactionAmount": { "currency": "EUR", "amount": "947.26" }, "valueDate": "2000-01-01" }]
    } })
    );

    let account_details = json!({ "account": {
        "resourceId": "PL00000000000000000987654321", "iban": "PL00000000000000000987654321",
        "currency": "PLN", "ownerName": "JOHN EXAMPLE", "product": "Savings Account for Individuals (Retail)",
        "bic": "INGBPLPW", "ownerAddressUnstructured": ["EXAMPLE STREET 100/001", "00-000 EXAMPLE CITY"]
    } });
    let account_metadata = json!({
        "id": "f0e49aa6-f6db-48fc-94ca-4a62372fadf4", "created": "2022-07-24T20:45:47.847062Z",
        "last_accessed": "2023-01-25T22:12:27.814618Z", "iban": "PL00000000000000000987654321",
        "institution_id": "SANDBOXFINANCE_SFIN0000", "status": "READY", "owner_name": "JOHN EXAMPLE"
    });
    assert_eq!(fixtures::mock_account_details(), account_details);
    assert_eq!(fixtures::mock_account_metadata(), account_metadata);
    let detailed_account = json!({
        "resourceId": "PL00000000000000000987654321", "iban": "PL00000000000000000987654321",
        "currency": "PLN", "ownerName": "JOHN EXAMPLE", "product": "Savings Account for Individuals (Retail)",
        "bic": "INGBPLPW", "ownerAddressUnstructured": ["EXAMPLE STREET 100/001", "00-000 EXAMPLE CITY"],
        "id": "f0e49aa6-f6db-48fc-94ca-4a62372fadf4", "created": "2022-07-24T20:45:47.847062Z",
        "last_accessed": "2023-01-25T22:12:27.814618Z", "institution_id": "SANDBOXFINANCE_SFIN0000",
        "status": "READY", "owner_name": "JOHN EXAMPLE"
    });
    assert_eq!(fixtures::mock_detailed_account(), detailed_account);

    let institution = json!({
        "id": "N26_NTSBDEB1", "name": "N26 Bank", "bic": "NTSBDEB1", "transaction_total_days": "90",
        "max_access_valid_for_days": "90", "countries": ["GB", "NO", "SE"],
        "logo": "https://cdn.nordigen.com/ais/N26_SANDBOX_NTSBDEB1.png"
    });
    assert_eq!(fixtures::mock_institution(), institution);
    let requisition = json!({
        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "created": "2023-01-31T18:15:50.172Z",
        "redirect": "string", "status": "LN", "institution_id": "string",
        "agreement": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "reference": "string",
        "accounts": ["f0e49aa6-f6db-48fc-94ca-4a62372fadf4"], "user_language": "string",
        "link": "https://ob.nordigen.com/psd2/start/3fa85f64-5717-4562-b3fc-2c963f66afa6/{$INSTITUTION_ID}",
        "ssn": "string", "account_selection": false, "redirect_immediate": false
    });
    assert_eq!(fixtures::mock_requisition(), requisition);
    assert_eq!(
        fixtures::mock_delete_requisition(),
        json!({
            "summary": "Requisition deleted",
            "detail": "Requisition '$REQUISITION_ID' deleted with all its End User Agreements"
        })
    );
    let mut created = requisition.as_object().unwrap().clone();
    created.insert("created".into(), json!("2023-02-01T15:53:29.481Z"));
    created.insert("status".into(), json!("CR"));
    created.insert("accounts".into(), json!([]));
    assert_eq!(fixtures::mock_create_requisition(), Value::Object(created));

    let mut example_one = detailed_account.as_object().unwrap().clone();
    example_one.insert("name".into(), json!("account-example-one"));
    let mut example_two = detailed_account.as_object().unwrap().clone();
    example_two.insert("name".into(), json!("account-example-two"));
    assert_eq!(
        fixtures::mock_detailed_account_example_one(),
        Value::Object(example_one.clone())
    );
    assert_eq!(
        fixtures::mock_detailed_account_example_two(),
        Value::Object(example_two.clone())
    );
    example_one.insert("institution".into(), institution.clone());
    example_two.insert("institution".into(), institution);
    assert_eq!(
        fixtures::mock_extended_accounts_about_institutions(),
        json!([example_one, example_two])
    );
    let mut requisition_with_examples = requisition.as_object().unwrap().clone();
    requisition_with_examples.insert(
        "accounts".into(),
        json!([
            "f0e49aa6-f6db-48fc-94ca-4a62372fadf4",
            "f0e49aa6-f6db-48fc-94ca-4a62372fadf4"
        ]),
    );
    assert_eq!(
        fixtures::mock_requisition_with_example_accounts(),
        Value::Object(requisition_with_examples)
    );
    assert_eq!(
        fixtures::mock_transaction_amount(),
        json!({ "amount": "100", "currency": "EUR" })
    );
}
