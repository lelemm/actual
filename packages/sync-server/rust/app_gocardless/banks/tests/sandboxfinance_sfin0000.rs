use serde_json::{Value, json};

use crate::app_gocardless::bank_factory;

use super::super::sandboxfinance_sfin0000;

#[test]
fn normalizes_account_for_frontend() {
    let account = json!({
        "resourceId": "01F3NS5ASCNMVCTEJDT0G215YE", "iban": "GL0865354374424724", "currency": "EUR",
        "ownerName": "Jane Doe", "name": "Main Account", "product": "Checkings", "cashAccountType": "CACC",
        "id": "99a0bfe2-0bef-46df-bff2-e9ae0c6c5838", "created": "2022-02-21T13:43:55.608911Z",
        "last_accessed": "2023-01-25T16:50:15.078264Z", "institution_id": "SANDBOXFINANCE_SFIN0000",
        "status": "READY", "owner_name": "Jane Doe",
        "institution": {
            "id": "SANDBOXFINANCE_SFIN0000", "name": "Sandbox Finance", "bic": "SFIN0000",
            "transaction_total_days": "90", "max_access_valid_for_days": "90", "countries": ["XX"],
            "logo": "https://cdn.nordigen.com/ais/SANDBOXFINANCE_SFIN0000.png", "supported_payments": {}, "supported_features": []
        }
    });
    let normalized =
        bank_factory::normalize_account("SANDBOXFINANCE_SFIN0000", account.as_object().unwrap());
    assert_eq!(
        normalized,
        json!({
            "account_id": "99a0bfe2-0bef-46df-bff2-e9ae0c6c5838", "iban": "GL0865354374424724",
            "institution": account["institution"].clone(), "mask": "4724", "name": "Main Account (XXX 4724) EUR",
            "official_name": "Checkings", "type": "checking"
        })
    );
}

#[test]
fn generic_sort_handles_empty_inputs() {
    let mut empty: Vec<Value> = Vec::new();
    bank_factory::sort_transactions("SANDBOXFINANCE_SFIN0000", &mut empty);
    assert!(empty.is_empty());
}

#[test]
fn calculates_starting_balance() {
    let balances = json!([{ "balanceAmount": { "amount": "1000.00", "currency": "PLN" }, "balanceType": "interimAvailable" }]);
    let transactions = json!([
        { "transactionId": "2022-01-01-1", "transactionAmount": { "amount": "-100.00", "currency": "USD" } },
        { "transactionId": "2022-01-01-2", "transactionAmount": { "amount": "50.00", "currency": "USD" } },
        { "transactionId": "2022-01-01-3", "transactionAmount": { "amount": "-25.00", "currency": "USD" } }
    ]);
    assert_eq!(
        sandboxfinance_sfin0000::calculate_starting_balance(
            transactions.as_array().unwrap(),
            balances.as_array().unwrap()
        ),
        107_500
    );
    assert_eq!(
        sandboxfinance_sfin0000::calculate_starting_balance(&[], balances.as_array().unwrap()),
        100_000
    );
    let positive = json!([
        { "transactionAmount": { "amount": "200.00", "currency": "PLN" } },
        { "transactionAmount": { "amount": "300.50", "currency": "PLN" } }
    ]);
    assert_eq!(
        sandboxfinance_sfin0000::calculate_starting_balance(
            positive.as_array().unwrap(),
            balances.as_array().unwrap()
        ),
        49_950
    );
}
