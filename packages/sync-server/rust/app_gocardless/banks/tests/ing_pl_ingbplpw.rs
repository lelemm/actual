use serde_json::{Value, json};

use crate::app_gocardless::bank_factory;

use super::super::ing_pl_ingbplpw;

#[test]
fn normalizes_account_for_frontend() {
    let account = json!({
        "resourceId": "PL00000000000000000987654321",
        "iban": "PL00000000000000000987654321",
        "currency": "PLN",
        "ownerName": "John Example",
        "product": "Current Account for Individuals (Retail)",
        "bic": "INGBPLPW",
        "ownerAddressUnstructured": ["UL. EXAMPLE STREET 10 M.1", "00-000 WARSZAWA"],
        "id": "d3eccc94-9536-48d3-98be-813f79199ee3",
        "created": "2022-07-24T20:45:47.929582Z",
        "last_accessed": "2023-01-24T22:12:00.193558Z",
        "institution_id": "ING_PL_INGBPLPW",
        "status": "READY",
        "owner_name": "",
        "institution": {
            "id": "ING_PL_INGBPLPW", "name": "ING", "bic": "INGBPLPW",
            "transaction_total_days": "365", "max_access_valid_for_days": "90",
            "countries": ["PL"],
            "logo": "https://cdn.nordigen.com/ais/ING_PL_INGBPLPW.png",
            "supported_payments": {},
            "supported_features": ["access_scopes", "business_accounts", "card_accounts", "corporate_accounts", "pending_transactions", "private_accounts"]
        }
    });
    let normalized =
        bank_factory::normalize_account("ING_PL_INGBPLPW", account.as_object().unwrap());

    assert_eq!(
        normalized,
        json!({
            "account_id": "d3eccc94-9536-48d3-98be-813f79199ee3",
            "iban": "PL00000000000000000987654321",
            "institution": account["institution"].clone(),
            "mask": "4321",
            "name": "Current Account for Individuals (Retail) (XXX 4321) PLN",
            "official_name": "Current Account for Individuals (Retail)",
            "type": "checking"
        })
    );
}

#[test]
fn sorts_transactions_by_time_and_sequence_newest_first() {
    let mut transactions = [3, 4, 1, 2, 1]
        .into_iter()
        .zip(["20230118", "20230118", "20230123", "20230118", "20230120"])
        .map(|(sequence, date)| {
            json!({
                "transactionId": format!("D{date}{sequence:07}"),
                "transactionAmount": { "amount": "100", "currency": "EUR" }
            })
        })
        .collect::<Vec<_>>();

    ing_pl_ingbplpw::sort_transactions(&mut transactions);
    let ids = transactions
        .iter()
        .map(|transaction| transaction["transactionId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "D202301230000001",
            "D202301200000001",
            "D202301180000004",
            "D202301180000003",
            "D202301180000002"
        ]
    );
}

#[test]
fn handles_empty_transaction_inputs() {
    let mut empty: Vec<Value> = Vec::new();
    ing_pl_ingbplpw::sort_transactions(&mut empty);
    assert!(empty.is_empty());
}

#[test]
fn calculates_starting_balance_from_oldest_transaction() {
    let transactions = json!([
        { "transactionAmount": { "amount": "-100.00", "currency": "USD" }, "balanceAfterTransaction": { "balanceAmount": { "amount": "400.00", "currency": "USD" }, "balanceType": "interimBooked" } },
        { "transactionAmount": { "amount": "50.00", "currency": "USD" }, "balanceAfterTransaction": { "balanceAmount": { "amount": "450.00", "currency": "USD" }, "balanceType": "interimBooked" } },
        { "transactionAmount": { "amount": "-25.00", "currency": "USD" }, "balanceAfterTransaction": { "balanceAmount": { "amount": "475.00", "currency": "USD" }, "balanceType": "interimBooked" } }
    ]);
    let balances = json!([
        { "balanceType": "interimBooked", "balanceAmount": { "amount": "500.00", "currency": "USD" } },
        { "balanceType": "closingBooked", "balanceAmount": { "amount": "600.00", "currency": "USD" } }
    ]);
    assert_eq!(
        ing_pl_ingbplpw::calculate_starting_balance(
            transactions.as_array().unwrap(),
            balances.as_array().unwrap()
        ),
        50_000
    );
}

#[test]
fn uses_interim_booked_balance_when_there_are_no_transactions() {
    let balances = json!([{ "balanceType": "interimBooked", "balanceAmount": { "amount": "500.00", "currency": "USD" } }]);
    assert_eq!(
        ing_pl_ingbplpw::calculate_starting_balance(&[], balances.as_array().unwrap()),
        50_000
    );
}
