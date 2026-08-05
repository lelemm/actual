use serde_json::Value;

use super::berliner_sparkasse_beladebexxx;

pub const INSTITUTION_IDS: &[&str] = &["SSK_DUSSELDORF_DUSSDEDDXXX"];

pub fn normalize_transaction(transaction: &Value, booked: bool) -> Option<Value> {
    if !booked {
        log::debug!(
            "Skipping unbooked transaction: {}",
            transaction_id_for_log(transaction.get("transactionId"))
        );
        return None;
    }
    berliner_sparkasse_beladebexxx::normalize_transaction(transaction)
}

fn transaction_id_for_log(transaction_id: Option<&Value>) -> String {
    match transaction_id {
        None => "undefined".into(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::transaction_id_for_log;

    #[test]
    fn preserves_javascript_transaction_id_representation_for_debug_logging() {
        assert_eq!(transaction_id_for_log(None), "undefined");
        assert_eq!(
            transaction_id_for_log(Some(&json!("transaction-1"))),
            "transaction-1"
        );
        assert_eq!(transaction_id_for_log(Some(&json!(42))), "42");
        assert_eq!(transaction_id_for_log(Some(&json!(null))), "null");
    }
}
