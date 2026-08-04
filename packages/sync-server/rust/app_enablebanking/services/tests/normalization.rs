use serde_json::json;

use super::{
    super::enablebanking_service::{
        is_importable_transaction, normalize_account, normalize_balance, normalize_transaction,
    },
    fixtures,
};

#[test]
fn normalizes_transactions_balances_and_accounts() {
    let transaction = normalize_transaction(&fixtures::debit_transaction());
    assert_eq!(transaction["transactionAmount"]["amount"], "-25.99");
    assert_eq!(transaction["payeeName"], "Store");
    assert_eq!(transaction["notes"], "invoice-42 thanks");
    assert!(is_importable_transaction(&transaction));
    assert!(!is_importable_transaction(&normalize_transaction(&json!({
        "transaction_id": "pending-without-date",
        "transaction_amount": { "currency": "EUR", "amount": "5.00" },
        "status": "PDNG"
    }))));
    assert_eq!(
        normalize_balance(&json!({
            "balance_amount": { "currency": "EUR", "amount": "-50.75" },
            "balance_type": "CLAV"
        }))["balanceAmount"]["amount"],
        -5075
    );
    assert_eq!(
        normalize_account(
            &json!({ "uid": "account", "account_id": { "iban": "FI1" } }),
            None
        )["name"],
        "FI1"
    );
}
