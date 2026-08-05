use serde_json::{Value, json};

pub fn mocked_balances() -> Value {
    json!({ "balances": [
        { "balanceAmount": { "amount": "657.49", "currency": "string" }, "balanceType": "interimAvailable", "referenceDate": "2021-11-22" },
        { "balanceAmount": { "amount": "185.67", "currency": "string" }, "balanceType": "interimAvailable", "referenceDate": "2021-11-19" }
    ] })
}

pub fn mock_transactions() -> Value {
    json!({ "transactions": {
        "booked": [
            { "transactionId": "string", "debtorName": "string", "debtorAccount": { "iban": "string" }, "transactionAmount": { "currency": "EUR", "amount": "328.18" }, "bankTransactionCode": "string", "bookingDate": "2000-01-01", "valueDate": "2000-01-01" },
            { "transactionId": "string", "transactionAmount": { "currency": "EUR", "amount": "947.26" }, "bankTransactionCode": "string", "bookingDate": "2000-01-01", "valueDate": "2000-01-01" }
        ],
        "pending": [{ "transactionAmount": { "currency": "EUR", "amount": "947.26" }, "valueDate": "2000-01-01" }]
    } })
}

pub fn mock_account_details() -> Value {
    json!({ "account": {
        "resourceId": "PL00000000000000000987654321", "iban": "PL00000000000000000987654321",
        "currency": "PLN", "ownerName": "JOHN EXAMPLE", "product": "Savings Account for Individuals (Retail)",
        "bic": "INGBPLPW", "ownerAddressUnstructured": ["EXAMPLE STREET 100/001", "00-000 EXAMPLE CITY"]
    } })
}

pub fn mock_account_metadata() -> Value {
    json!({
        "id": "f0e49aa6-f6db-48fc-94ca-4a62372fadf4", "created": "2022-07-24T20:45:47.847062Z",
        "last_accessed": "2023-01-25T22:12:27.814618Z", "iban": "PL00000000000000000987654321",
        "institution_id": "SANDBOXFINANCE_SFIN0000", "status": "READY", "owner_name": "JOHN EXAMPLE"
    })
}

pub fn mock_detailed_account() -> Value {
    let mut account = mock_account_details()["account"]
        .as_object()
        .unwrap()
        .clone();
    account.extend(mock_account_metadata().as_object().unwrap().clone());
    Value::Object(account)
}

pub fn mock_institution() -> Value {
    json!({
        "id": "N26_NTSBDEB1", "name": "N26 Bank", "bic": "NTSBDEB1", "transaction_total_days": "90",
        "max_access_valid_for_days": "90", "countries": ["GB", "NO", "SE"],
        "logo": "https://cdn.nordigen.com/ais/N26_SANDBOX_NTSBDEB1.png"
    })
}

pub fn mock_requisition() -> Value {
    json!({
        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "created": "2023-01-31T18:15:50.172Z",
        "redirect": "string", "status": "LN", "institution_id": "string",
        "agreement": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "reference": "string",
        "accounts": ["f0e49aa6-f6db-48fc-94ca-4a62372fadf4"], "user_language": "string",
        "link": "https://ob.nordigen.com/psd2/start/3fa85f64-5717-4562-b3fc-2c963f66afa6/{$INSTITUTION_ID}",
        "ssn": "string", "account_selection": false, "redirect_immediate": false
    })
}

pub fn mock_delete_requisition() -> Value {
    json!({
        "summary": "Requisition deleted",
        "detail": "Requisition '$REQUISITION_ID' deleted with all its End User Agreements"
    })
}

pub fn mock_create_requisition() -> Value {
    let mut requisition = mock_requisition().as_object().unwrap().clone();
    requisition.insert("created".into(), json!("2023-02-01T15:53:29.481Z"));
    requisition.insert("status".into(), json!("CR"));
    requisition.insert("accounts".into(), json!([]));
    Value::Object(requisition)
}

pub fn mock_detailed_account_example_one() -> Value {
    let mut account = mock_detailed_account().as_object().unwrap().clone();
    account.insert("name".into(), json!("account-example-one"));
    Value::Object(account)
}

pub fn mock_detailed_account_example_two() -> Value {
    let mut account = mock_detailed_account().as_object().unwrap().clone();
    account.insert("name".into(), json!("account-example-two"));
    Value::Object(account)
}

pub fn mock_extended_accounts_about_institutions() -> Value {
    let institution = mock_institution();
    let mut first = mock_detailed_account_example_one()
        .as_object()
        .unwrap()
        .clone();
    first.insert("institution".into(), institution.clone());
    let mut second = mock_detailed_account_example_two()
        .as_object()
        .unwrap()
        .clone();
    second.insert("institution".into(), institution);
    json!([first, second])
}

pub fn mock_requisition_with_example_accounts() -> Value {
    let mut requisition = mock_requisition().as_object().unwrap().clone();
    requisition.insert(
        "accounts".into(),
        json!([
            mock_detailed_account_example_one()["id"],
            mock_detailed_account_example_two()["id"]
        ]),
    );
    Value::Object(requisition)
}

pub fn mock_transaction_amount() -> Value {
    json!({ "amount": "100", "currency": "EUR" })
}
