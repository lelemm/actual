use serde_json::Value;

use super::berliner_sparkasse_beladebexxx;

pub const INSTITUTION_IDS: &[&str] = &["SSK_DUSSELDORF_DUSSDEDDXXX"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    booked.then(|| berliner_sparkasse_beladebexxx::normalize_transaction(transaction))?
}
