use serde_json::Value;

use super::spk_marburg_biedenkopf_heladef1mar;

pub const INSTITUTION_IDS: &[&str] = &["SPK_WORMS_ALZEY_RIED_MALADE51WOR"];

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    spk_marburg_biedenkopf_heladef1mar::normalize_transaction(transaction)
}
