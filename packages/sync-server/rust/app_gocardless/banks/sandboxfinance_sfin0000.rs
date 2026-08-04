use serde_json::Value;

use super::ing_ingddeff;

pub const INSTITUTION_IDS: &[&str] = &["SANDBOXFINANCE_SFIN0000"];

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    ing_ingddeff::reduce_from_balance(transactions, balances, "interimAvailable")
}
