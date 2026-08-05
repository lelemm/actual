use serde_json::json;

use super::super::nationwide_naiagb21;

fn normalize(transaction_id: Option<&str>, booked: bool) -> serde_json::Value {
    let mut transaction = json!({
        "bookingDate": "2024-01-01",
        "transactionAmount": { "amount": "100", "currency": "EUR" }
    });
    if let Some(transaction_id) = transaction_id {
        transaction["transactionId"] = json!(transaction_id);
    }
    nationwide_naiagb21::normalize_transaction(&transaction, booked).unwrap()
}

#[test]
fn retains_booked_date() {
    assert_eq!(normalize(None, true)["date"], "2024-01-01");
}

#[test]
fn caps_pending_date_at_today() {
    assert!(normalize(None, false)["date"].as_str().is_some());
    assert!(
        normalize(None, false)["date"].as_str().unwrap()
            <= chrono::Utc::now().format("%Y-%m-%d").to_string().as_str()
    );
}

#[test]
fn keeps_valid_transaction_id() {
    let id = "a896729bb8b30b5ca862fe70bd5967185e2b5d3a";
    assert_eq!(normalize(Some(id), false)["transactionId"], id);
}

#[test]
fn removes_short_transaction_id() {
    assert!(
        normalize(Some("0123456789"), false)
            .get("transactionId")
            .is_none()
    );
}

#[test]
fn removes_debit_placeholder_id() {
    assert!(
        normalize(Some("00DEBIT202401010000000000-1000SUPERMARKET"), false)
            .get("transactionId")
            .is_none()
    );
}

#[test]
fn removes_credit_placeholder_id() {
    assert!(
        normalize(Some("00CREDIT202401010000000000-1000SUPERMARKET"), false)
            .get("transactionId")
            .is_none()
    );
}
