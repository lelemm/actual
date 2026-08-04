use serde_json::{Value, json};

pub fn debit_transaction() -> Value {
    json!({
        "entry_reference": "ref-1",
        "transaction_amount": { "currency": "EUR", "amount": "+25.99" },
        "credit_debit_indicator": "DBIT",
        "creditor": { "name": "Store" },
        "status": "BOOK",
        "booking_date": "2026-03-01",
        "remittance_information": ["EREF+invoice-42", "thanks"]
    })
}
