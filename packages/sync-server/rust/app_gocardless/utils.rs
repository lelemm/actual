use std::cmp::Ordering;

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::Value;

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

pub fn amount_to_integer(value: &Value) -> i64 {
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .unwrap_or(0.0);
    (number.mul_add(100.0, 0.5)).floor() as i64
}

fn compare_dates(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    match (left.and_then(date), right.and_then(date)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => left.cmp(&right),
    }
}

fn date(value: &Value) -> Option<i64> {
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn sorts_newest_first_and_uses_javascript_rounding() {
        let mut transactions = vec![
            json!({ "bookingDate": "2022-01-01" }),
            json!({ "bookingDate": "2022-01-03" }),
            json!({ "bookingDate": "2022-01-02" }),
        ];
        sort_by_booking_date_or_value_date(&mut transactions);
        assert_eq!(transactions[0]["bookingDate"], "2022-01-03");
        assert_eq!(amount_to_integer(&json!("100.005")), 10001);
        assert_eq!(amount_to_integer(&json!("-1.005")), -100);
    }
}
