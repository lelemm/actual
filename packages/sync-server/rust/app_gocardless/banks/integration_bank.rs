use serde_json::{Map, Value, json};

use crate::app_gocardless::utils::{
    amount_to_integer, print_iban, sort_by_booking_date_or_value_date,
};
use crate::util::payee_name::format_payee_name;

const SORTED_BALANCE_TYPES: [&str; 7] = [
    "closingBooked",
    "expected",
    "forwardAvailable",
    "interimAvailable",
    "interimBooked",
    "nonInvoiced",
    "openingBooked",
];

pub fn normalize_account(account: &Map<String, Value>) -> Value {
    let iban = string(account, "iban");
    let institution_id = string(account, "institution_id").unwrap_or_default();
    let mut name = Vec::new();
    if let Some(value) = ["name", "displayName", "product"]
        .iter()
        .find_map(|key| string(account, key))
    {
        name.push(value.to_owned());
    }
    let printed_iban = print_iban(account);
    if !printed_iban.is_empty() {
        name.push(printed_iban);
    }
    if let Some(currency) = string(account, "currency") {
        name.push(currency.to_owned());
    }
    json!({
        "account_id": account.get("id").cloned().unwrap_or(Value::Null),
        "institution": account.get("institution").cloned().unwrap_or(Value::Null),
        "mask": tail(iban.unwrap_or("0000"), 4),
        "iban": iban,
        "name": name.join(" "),
        "official_name": string(account, "product")
            .map(str::to_owned)
            .unwrap_or_else(|| format!("integration-{institution_id}")),
        "type": "checking"
    })
}

pub fn normalize_transaction(transaction: &Value) -> Option<Value> {
    normalize_transaction_with(transaction, transaction)
}

pub fn normalize_transaction_with(transaction: &Value, edited: &Value) -> Option<Value> {
    let mut transaction = transaction.as_object()?.clone();
    let edited = edited.as_object()?;
    let date = [
        "date",
        "bookingDate",
        "bookingDateTime",
        "valueDate",
        "valueDateTime",
    ]
    .iter()
    .find_map(|field| edited.get(*field).and_then(Value::as_str))
    .or_else(|| {
        [
            "bookingDate",
            "bookingDateTime",
            "valueDate",
            "valueDateTime",
        ]
        .iter()
        .find_map(|field| transaction.get(*field).and_then(Value::as_str))
    })?;
    let date = date.get(..10).unwrap_or(date).to_owned();
    let notes = edited
        .get("notes")
        .and_then(Value::as_str)
        .or_else(|| {
            edited
                .get("remittanceInformationUnstructured")
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
        .or_else(|| {
            edited
                .get("remittanceInformationUnstructuredArray")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
        })
        .unwrap_or_default();
    for field in [
        "remittanceInformationUnstructuredArray",
        "remittanceInformationStructuredArray",
    ] {
        let output = format!("{field}String");
        if let Some(values) = transaction.get(field).and_then(Value::as_array) {
            transaction.insert(
                output,
                Value::String(
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(","),
                ),
            );
        }
    }
    let payee_name = edited
        .get("payeeName")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format_payee_name(edited));
    transaction.insert("payeeName".into(), Value::String(payee_name));
    transaction.insert("date".into(), Value::String(date));
    transaction.insert("notes".into(), Value::String(notes));
    Some(Value::Object(transaction))
}

pub fn sort_transactions(transactions: &mut [Value]) {
    sort_by_booking_date_or_value_date(transactions);
}

pub fn calculate_starting_balance(transactions: &[Value], balances: &[Value]) -> i64 {
    let current = SORTED_BALANCE_TYPES.iter().find_map(|balance_type| {
        balances.iter().find(|balance| {
            balance.get("balanceType").and_then(Value::as_str) == Some(*balance_type)
        })
    });
    let balance = current
        .and_then(|balance| balance.get("balanceAmount"))
        .and_then(|amount| amount.get("amount"))
        .map(amount_to_integer)
        .unwrap_or(0);
    transactions.iter().fold(balance, |total, transaction| {
        total
            - transaction
                .get("transactionAmount")
                .and_then(|amount| amount.get("amount"))
                .map(amount_to_integer)
                .unwrap_or(0)
    })
}

fn string<'a>(account: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    account.get(key).and_then(Value::as_str)
}

fn tail(value: &str, length: usize) -> &str {
    let start = value
        .char_indices()
        .rev()
        .nth(length.saturating_sub(1))
        .map_or(0, |(index, _)| index);
    &value[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_generic_account_shape() {
        let account = json!({
            "id": "account-id",
            "institution_id": "BANK",
            "iban": "DE001234",
            "name": "Checking",
            "currency": "EUR",
            "institution": { "id": "BANK" }
        });
        assert_eq!(
            normalize_account(account.as_object().unwrap()),
            json!({
                "account_id": "account-id",
                "institution": { "id": "BANK" },
                "mask": "1234",
                "iban": "DE001234",
                "name": "Checking (XXX 1234) EUR",
                "official_name": "integration-BANK",
                "type": "checking"
            })
        );
    }

    #[test]
    fn normalizes_sorts_and_calculates_transactions() {
        let transaction = json!({
            "debtorName": "CONTRACT SHOP",
            "debtorAccount": { "iban": "DE001234" },
            "transactionAmount": { "amount": "100", "currency": "EUR" },
            "bookingDate": "2022-01-01"
        });
        assert_eq!(
            normalize_transaction(&transaction).unwrap()["payeeName"],
            "Contract Shop (DE00 XXX 1234)"
        );
        assert_eq!(
            calculate_starting_balance(
                &[transaction],
                &[json!({
                    "balanceType": "interimBooked",
                    "balanceAmount": { "amount": "1000.00" }
                })]
            ),
            90000
        );
    }
}
