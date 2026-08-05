use serde_json::{Value, json};

use crate::app_gocardless::bank_factory;

use super::super::mbank_retail_brexplpw;

#[test]
fn normalizes_account_for_frontend() {
    let account = json!({
        "iban": "PL00000000000000000987654321", "currency": "PLN", "ownerName": "John Example",
        "displayName": "EKONTO", "product": "RACHUNEK BIEŻĄCY", "usage": "PRIV",
        "ownerAddressUnstructured": ["POL", "UL. EXAMPLE STREET 10 M.1", "00-000 WARSZAWA"],
        "id": "d3eccc94-9536-48d3-98be-813f79199ee3", "created": "2023-01-18T13:24:55.879512Z",
        "last_accessed": null, "institution_id": "MBANK_RETAIL_BREXPLPW", "status": "READY", "owner_name": "",
        "institution": {
            "id": "MBANK_RETAIL_BREXPLPW", "name": "mBank Retail", "bic": "BREXPLPW",
            "transaction_total_days": "90", "max_access_valid_for_days": "90", "countries": ["PL"],
            "logo": "https://cdn.nordigen.com/ais/MBANK_RETAIL_BREXCZPP.png", "supported_payments": {},
            "supported_features": ["access_scopes", "business_accounts", "card_accounts", "corporate_accounts", "pending_transactions", "private_accounts"]
        }
    });
    let normalized =
        bank_factory::normalize_account("MBANK_RETAIL_BREXPLPW", account.as_object().unwrap());
    assert_eq!(
        normalized,
        json!({
            "account_id": "d3eccc94-9536-48d3-98be-813f79199ee3", "iban": "PL00000000000000000987654321",
            "institution": account["institution"].clone(), "mask": "4321", "name": "EKONTO (XXX 4321) PLN",
            "official_name": "RACHUNEK BIEŻĄCY", "type": "checking"
        })
    );
}

#[test]
fn sorts_transactions_newest_first() {
    let mut transactions = ["202212300001", "202212300003", "202212300002", "202212300000", "202112300001"]
        .map(|id| json!({ "transactionId": id, "transactionAmount": { "amount": "100", "currency": "EUR" } }));
    mbank_retail_brexplpw::sort_transactions(&mut transactions);
    let ids =
        transactions.map(|transaction| transaction["transactionId"].as_str().unwrap().to_owned());
    assert_eq!(
        ids,
        [
            "202212300003",
            "202212300002",
            "202212300001",
            "202212300000",
            "202112300001"
        ]
    );
}

#[test]
fn handles_empty_transaction_inputs() {
    let mut empty: Vec<Value> = Vec::new();
    mbank_retail_brexplpw::sort_transactions(&mut empty);
    assert!(empty.is_empty());
}

#[test]
fn calculates_starting_balance() {
    let balances = json!([{ "balanceAmount": { "amount": "1000.00", "currency": "PLN" }, "balanceType": "interimBooked" }]);
    assert_eq!(
        mbank_retail_brexplpw::calculate_starting_balance(&[], balances.as_array().unwrap()),
        100_000
    );
    let transactions = json!([
        { "transactionAmount": { "amount": "200.00", "currency": "PLN" } },
        { "transactionAmount": { "amount": "300.50", "currency": "PLN" } }
    ]);
    assert_eq!(
        mbank_retail_brexplpw::calculate_starting_balance(
            transactions.as_array().unwrap(),
            balances.as_array().unwrap()
        ),
        49_950
    );
}
