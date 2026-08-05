use std::cmp::Ordering;

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::{Map, Value};

const DATE_FIELDS: [&str; 4] = [
    "bookingDate",
    "bookingDateTime",
    "valueDate",
    "valueDateTime",
];

pub fn sort_by_booking_date_or_value_date(transactions: &mut [Value]) {
    transactions.sort_by(|left, right| {
        for field in DATE_FIELDS {
            let ordering = compare_dates(right.get(field), left.get(field));
            if ordering != Ordering::Equal {
                return ordering;
            }
        }
        Ordering::Equal
    });
}

pub fn print_iban(account: &Map<String, Value>) -> String {
    account
        .get("iban")
        .and_then(Value::as_str)
        .filter(|iban| !iban.is_empty())
        .map_or_else(String::new, |iban| format!("(XXX {})", tail(iban, 4)))
}

pub fn amount_to_integer(value: &Value) -> i64 {
    let number = js_number(value).unwrap_or(f64::NAN);
    (number.mul_add(100.0, 0.5)).floor() as i64
}

fn compare_dates(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    let left = left.filter(|value| !value.is_null());
    let right = right.filter(|value| !value.is_null());
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => match (date(left), date(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            _ => Ordering::Equal,
        },
    }
}

fn date(value: &Value) -> Option<i64> {
    if let Some(value) = value.as_f64() {
        return (value.is_finite() && value.abs() <= 8_640_000_000_000_000.0)
            .then_some(value.trunc() as i64);
    }
    let value = value.as_str()?;
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|value| value.and_utc().timestamp_millis())
        })
        .or_else(|_| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").map(|value| {
                value
                    .and_hms_opt(0, 0, 0)
                    .expect("midnight is valid")
                    .and_utc()
                    .timestamp_millis()
            })
        })
        .ok()
}

fn js_number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    let value = value.as_str()?.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return num_bigint::BigUint::parse_bytes(digits.as_bytes(), radix)
                .and_then(|number| number.to_str_radix(10).parse().ok());
        }
    }
    value.parse().ok()
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

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../contract/fixtures/gocardless-utils-golden.json"
        ))
        .unwrap()
    }

    #[test]
    fn matches_the_shared_typescript_utility_fixture() {
        let fixture = fixture();
        assert_eq!(fixture["version"], 1);

        let sort_cases = fixture["sortCases"].as_array().unwrap();
        assert_eq!(sort_cases.len(), 7);
        for test_case in sort_cases {
            let mut transactions = test_case["transactions"].as_array().unwrap().clone();
            sort_by_booking_date_or_value_date(&mut transactions);
            let actual: Vec<_> = transactions
                .iter()
                .map(|transaction| transaction["id"].clone())
                .collect();
            assert_eq!(
                &actual,
                test_case["expectedIds"].as_array().unwrap(),
                "{}",
                test_case["id"]
            );
        }

        let iban_cases = fixture["ibanCases"].as_array().unwrap();
        assert_eq!(iban_cases.len(), 5);
        for test_case in iban_cases {
            assert_eq!(
                print_iban(test_case["account"].as_object().unwrap()),
                test_case["expected"].as_str().unwrap(),
                "{}",
                test_case["id"]
            );
        }

        let amount_cases = fixture["amountCases"].as_array().unwrap();
        assert_eq!(amount_cases.len(), 11);
        for test_case in amount_cases {
            assert_eq!(
                amount_to_integer(&test_case["input"]),
                test_case["expected"].as_i64().unwrap(),
                "{}",
                test_case["id"]
            );
        }
    }
}
