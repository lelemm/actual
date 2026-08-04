use serde_json::{Map, Value};

use super::title::title;

pub fn format_payee_name(transaction: &Map<String, Value>) -> String {
    let amount = transaction
        .get("transactionAmount")
        .and_then(|amount| amount.get("amount"))
        .and_then(|amount| {
            amount
                .as_f64()
                .or_else(|| amount.as_str().and_then(|amount| amount.parse().ok()))
        })
        .unwrap_or(0.0);
    let (primary_name, primary_account) = if amount >= 0.0 {
        ("debtorName", "debtorAccount")
    } else {
        ("creditorName", "creditorAccount")
    };
    let primary_name = transaction.get(primary_name).and_then(nonempty_string);
    let name = primary_name
        .or_else(|| transaction.get("debtorName").and_then(nonempty_string))
        .or_else(|| transaction.get("creditorName").and_then(nonempty_string))
        .or_else(|| {
            transaction
                .get("remittanceInformationUnstructured")
                .and_then(nonempty_string)
        })
        .map(str::to_owned)
        .or_else(|| {
            transaction
                .get("remittanceInformationUnstructuredArray")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            transaction
                .get("additionalInformation")
                .and_then(nonempty_string)
                .map(str::to_owned)
        });
    let account = if primary_name.is_some() {
        transaction.get(primary_account)
    } else {
        transaction
            .get("debtorAccount")
            .or_else(|| transaction.get("creditorAccount"))
    };
    let mut parts = Vec::new();
    if let Some(name) = name {
        parts.push(title(&name));
    }
    if let Some(iban) = account
        .and_then(Value::as_object)
        .and_then(|account| account.get("iban"))
        .and_then(Value::as_str)
    {
        parts.push(format!(
            "({} XXX {})",
            &iban[..iban.len().min(4)],
            tail(iban, 4)
        ));
    }
    parts.join(" ")
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.is_empty())
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
    use serde_json::json;

    use super::*;

    #[test]
    fn uses_the_remittance_array_before_additional_information() {
        let transaction = json!({
            "transactionAmount": { "amount": "1" },
            "remittanceInformationUnstructuredArray": ["FIRST", "SECOND"],
            "additionalInformation": "LAST"
        });
        assert_eq!(
            format_payee_name(transaction.as_object().unwrap()),
            "First, Second"
        );
    }

    #[test]
    fn treats_an_empty_primary_name_like_javascript_falsy_data() {
        let transaction = json!({
            "transactionAmount": { "amount": "1" },
            "debtorName": "",
            "creditorName": "CREDITOR",
            "debtorAccount": { "iban": "DEBT0001" },
            "creditorAccount": { "iban": "CRED0002" }
        });
        assert_eq!(
            format_payee_name(transaction.as_object().unwrap()),
            "Creditor (DEBT XXX 0001)"
        );
    }
}
