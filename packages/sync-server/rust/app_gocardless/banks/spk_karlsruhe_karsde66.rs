use serde_json::Value;

use super::berliner_sparkasse_beladebexxx;

pub const INSTITUTION_IDS: &[&str] = &["SPK_KARLSRUHE_KARSDE66XXX"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    berliner_sparkasse_beladebexxx::normalize_transaction(transaction)
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    berliner_sparkasse_beladebexxx::calculate_starting_balance(transactions, balances)
}
