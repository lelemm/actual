use chrono::{DateTime, Datelike, Months, NaiveDate, Utc};
use reqwest::{Client, Url};
use serde_json::{Map, Value, json};

const PLUGGY_SDK_VERSION: &str = "0.89.0";
const GOT_VERSION: &str = "11.8.6";

pub fn status_data(
    client_id: Option<&str>,
    client_secret: Option<&str>,
    item_ids: Option<&str>,
) -> Value {
    if credentials(client_id, client_secret, item_ids).is_some() {
        json!({ "configured": true, "source": "global" })
    } else {
        json!({ "configured": false, "source": Value::Null })
    }
}

pub async fn accounts(
    client: &Client,
    client_id: Option<&str>,
    client_secret: Option<&str>,
    item_ids: Option<&str>,
) -> Value {
    let Some((client_id, client_secret, item_ids)) =
        credentials(client_id, client_secret, item_ids)
    else {
        return json!({ "error": "Pluggy credentials are not configured" });
    };
    let api_key = match api_key(client, client_id, client_secret).await {
        Ok(api_key) => api_key,
        Err(error) => return json!({ "error": error }),
    };
    let mut accounts = Vec::new();
    for item_id in item_ids
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        match get(client, &api_key, "accounts", &[("itemId", item_id)]).await {
            Ok(partial) => match partial.get("results") {
                Some(Value::Array(results)) => accounts.extend(results.iter().cloned()),
                Some(result) => accounts.push(result.clone()),
                None => accounts.push(Value::Null),
            },
            Err(error) => return json!({ "error": error }),
        }
    }
    json!({ "accounts": accounts })
}

pub async fn transactions(
    client: &Client,
    client_id: Option<&str>,
    client_secret: Option<&str>,
    item_ids: Option<&str>,
    body: &Value,
) -> Value {
    let Some((client_id, client_secret, _)) = credentials(client_id, client_secret, item_ids)
    else {
        return json!({ "error": "Pluggy credentials are not configured" });
    };
    let account_id = javascript_string(body.get("accountId"));
    let account_query_id = body
        .get("accountId")
        .filter(|value| !value.is_null())
        .map(|_| account_id.as_str());
    let start_date = body.get("startDate").and_then(Value::as_str);
    let api_key = match api_key(client, client_id, client_secret).await {
        Ok(api_key) => api_key,
        Err(error) => return json!({ "error": error }),
    };
    let account = match get(client, &api_key, &format!("accounts/{account_id}"), &[]).await {
        Ok(account) => account,
        Err(error) => return json!({ "error": error }),
    };
    let transactions =
        match get_transactions(client, &api_key, &account, account_query_id, start_date).await {
            Ok(transactions) => transactions,
            Err(error) => return json!({ "error": error }),
        };
    normalize_transactions(&account, transactions).unwrap_or_else(|error| json!({ "error": error }))
}

async fn get_transactions(
    client: &Client,
    api_key: &str,
    account: &Value,
    account_id: Option<&str>,
    start_date: Option<&str>,
) -> Result<Vec<Value>, String> {
    let sandbox = account.get("owner").and_then(Value::as_str) == Some("John Doe");
    let date_from = if sandbox {
        Some("2000-01-01")
    } else {
        start_date
    };
    let mut transactions = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut query = Vec::new();
        if let Some(date_from) = date_from {
            query.push(("dateFrom", date_from));
        }
        if let Some(after) = after.as_deref() {
            query.push(("after", after));
        }
        if let Some(account_id) = account_id {
            query.push(("accountId", account_id));
        }
        let page = get(client, api_key, "v2/transactions", &query).await?;
        transactions.extend(
            page.get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        after = page
            .get("next")
            .and_then(Value::as_str)
            .and_then(next_cursor);
        if after.is_none() {
            break;
        }
    }
    if sandbox {
        for transaction in &mut transactions {
            transaction["sandbox"] = Value::Bool(true);
        }
    }
    Ok(transactions)
}

async fn api_key(client: &Client, client_id: &str, client_secret: &str) -> Result<String, String> {
    let url = base_url()?
        .join("auth")
        .map_err(|error| error.to_string())?;
    let response = client
        .post(url)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(
            json!({ "clientId": client_id, "clientSecret": client_secret, "nonExpiring": false })
                .to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(body);
    }
    serde_json::from_str::<Value>(&body)
        .map_err(|error| error.to_string())?
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Pluggy auth response did not contain apiKey".to_owned())
}

async fn get(
    client: &Client,
    api_key: &str,
    endpoint: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let mut url = base_url()?
        .join(endpoint)
        .map_err(|error| error.to_string())?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().copied());
    }
    let response = client
        .get(url)
        .header("X-API-KEY", api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(body);
    }
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

fn normalize_transactions(account: &Value, transactions: Vec<Value>) -> Result<Value, String> {
    let credit = account.get("type").and_then(Value::as_str) == Some("CREDIT");
    let starting_balance = account.get("balance").map_or(Value::Null, |balance| {
        let amount = match balance {
            Value::String(value) if !value.parse::<f64>().is_ok_and(|value| value.is_finite()) => {
                return Value::Null;
            }
            _ => amount_to_integer(balance),
        };
        json!(if credit { -amount } else { amount })
    });
    let reference_date = pluggy_date(account.get("updatedAt"))?;
    let mut balance_amount = Map::from_iter([("amount".into(), starting_balance.clone())]);
    if let Some(currency) = account.get("currencyCode") {
        balance_amount.insert("currency".into(), currency.clone());
    }
    let balances = Value::Array(vec![Value::Object(Map::from_iter([
        ("balanceAmount".into(), Value::Object(balance_amount)),
        ("balanceType".into(), Value::String("expected".into())),
        ("referenceDate".into(), Value::String(reference_date)),
    ]))]);
    let mut all = Vec::new();
    let mut booked = Vec::new();
    let mut pending = Vec::new();
    for transaction in transactions {
        let Some(mut transaction) = transaction.as_object().cloned() else {
            continue;
        };
        if transaction.is_empty() {
            continue;
        }
        let booked_transaction =
            transaction.get("status").and_then(Value::as_str) != Some("PENDING");
        let transaction_date = parse_pluggy_date(transaction.get("date"))?;
        let payee_name = get_payee_name(&transaction);
        let notes = transaction
            .get("descriptionRaw")
            .filter(|value| javascript_truthy(value))
            .or_else(|| transaction.get("description"))
            .cloned();
        if credit {
            if let Some(amount) = transaction
                .get_mut("amountInAccountCurrency")
                .filter(|value| javascript_truthy(value))
            {
                *amount = numeric_value(-number(amount)?);
            }
            if let Some(amount) = transaction.get_mut("amount") {
                *amount = numeric_value(-number(amount)?);
            }
        }
        let amount = transaction
            .get("amountInAccountCurrency")
            .filter(|value| !value.is_null())
            .or_else(|| transaction.get("amount"))
            .map(number)
            .transpose()?
            .unwrap_or(f64::NAN);
        let amount = (amount.mul_add(100.0, 0.5)).floor() / 100.0;
        let transaction_id = transaction.get("id").cloned().unwrap_or(Value::Null);
        let corrected_date = corrected_date(&transaction, transaction_date)?;
        transaction.remove("amount");
        let mut normalized = Map::new();
        flatten_object(&transaction, "", &mut normalized);
        normalized.extend(Map::from_iter([
            ("booked".into(), Value::Bool(booked_transaction)),
            (
                "date".into(),
                Value::String(corrected_date.date_naive().to_string()),
            ),
            ("payeeName".into(), Value::String(payee_name)),
            (
                "sortOrder".into(),
                json!(transaction_date.timestamp_millis()),
            ),
            (
                "originalDate".into(),
                Value::String(transaction_date.date_naive().to_string()),
            ),
        ]));
        if let Some(notes) = notes {
            normalized.insert("notes".into(), notes);
        }
        let mut transaction_amount = Map::from_iter([("amount".into(), finite_number(amount))]);
        if let Some(currency) = transaction.get("currencyCode") {
            transaction_amount.insert("currency".into(), currency.clone());
        }
        normalized.insert(
            "transactionAmount".into(),
            Value::Object(transaction_amount),
        );
        if !transaction_id.is_null() {
            normalized.insert("transactionId".into(), transaction_id);
        }
        let normalized = Value::Object(normalized);
        if booked_transaction {
            booked.push(normalized.clone());
        } else {
            pending.push(normalized.clone());
        }
        all.push(normalized);
    }
    let descending = |left: &Value, right: &Value| {
        right
            .get("sortOrder")
            .and_then(Value::as_i64)
            .cmp(&left.get("sortOrder").and_then(Value::as_i64))
    };
    all.sort_by(descending);
    booked.sort_by(descending);
    pending.sort_by(descending);
    Ok(json!({
        "balances": balances,
        "startingBalance": starting_balance,
        "transactions": { "all": all, "booked": booked, "pending": pending }
    }))
}

fn credentials<'a>(
    client_id: Option<&'a str>,
    client_secret: Option<&'a str>,
    item_ids: Option<&'a str>,
) -> Option<(&'a str, &'a str, &'a str)> {
    Some((
        client_id.filter(|value| !value.is_empty())?,
        client_secret.filter(|value| !value.is_empty())?,
        item_ids.filter(|value| !value.is_empty())?,
    ))
}

fn base_url() -> Result<Url, String> {
    Url::parse("https://api.pluggy.ai/").map_err(|error| error.to_string())
}

fn user_agent() -> String {
    format!(
        "pluggy-node/v{PLUGGY_SDK_VERSION} (https://github.com/pluggyai/pluggy-node) got (https://github.com/sindresorhus/got) got/{GOT_VERSION}"
    )
}

fn next_cursor(next: &str) -> Option<String> {
    base_url()
        .ok()?
        .join(next)
        .ok()?
        .query_pairs()
        .find_map(|(key, value)| (key == "after").then(|| value.into_owned()))
}

fn get_payee_name(transaction: &Map<String, Value>) -> String {
    if let Some(merchant) = transaction.get("merchant").and_then(Value::as_object)
        && let Some(name) = merchant
            .get("name")
            .filter(|value| javascript_truthy(value))
            .or_else(|| {
                merchant
                    .get("businessName")
                    .filter(|value| javascript_truthy(value))
            })
            .and_then(Value::as_str)
    {
        return name.into();
    }
    let Some(payment) = transaction.get("paymentData").and_then(Value::as_object) else {
        return String::new();
    };
    let party = match transaction.get("type").and_then(Value::as_str) {
        Some("DEBIT") => payment.get("receiver"),
        Some("CREDIT") => payment.get("payer"),
        _ => None,
    }
    .and_then(Value::as_object);
    party
        .and_then(|party| {
            party
                .get("name")
                .filter(|value| javascript_truthy(value))
                .or_else(|| {
                    party
                        .get("documentNumber")
                        .and_then(|value| value.get("value"))
                })
        })
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}

fn flatten_object(object: &Map<String, Value>, prefix: &str, output: &mut Map<String, Value>) {
    for (key, value) in object {
        if value.is_null() {
            continue;
        }
        let key = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if let Some(object) = value.as_object() {
            flatten_object(object, &key, output);
        } else if !is_sdk_date(value) {
            output.insert(key, value.clone());
        }
    }
}

fn corrected_date(
    transaction: &Map<String, Value>,
    transaction_date: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let Some(installment) = transaction
        .get("creditCardMetadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("installmentNumber"))
        .filter(|value| !value.is_null())
        .and_then(Value::as_i64)
    else {
        return Ok(transaction_date);
    };
    let purchase_date = transaction
        .get("creditCardMetadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("purchaseDate"))
        .filter(|value| javascript_truthy(value))
        .map(|value| parse_pluggy_date(Some(value)))
        .transpose()?
        .unwrap_or(transaction_date);
    add_months_clamped(purchase_date, installment - 1)
}

fn add_months_clamped(date: DateTime<Utc>, months: i64) -> Result<DateTime<Utc>, String> {
    let first = NaiveDate::from_ymd_opt(date.year(), date.month(), 1)
        .ok_or_else(|| "Invalid Pluggy transaction date".to_owned())?;
    let shifted = if months >= 0 {
        first.checked_add_months(Months::new(months as u32))
    } else {
        first.checked_sub_months(Months::new((-months) as u32))
    }
    .ok_or_else(|| "Invalid Pluggy installment month".to_owned())?;
    let next = shifted
        .checked_add_months(Months::new(1))
        .ok_or_else(|| "Invalid Pluggy installment month".to_owned())?;
    let last_day = next
        .pred_opt()
        .ok_or_else(|| "Invalid Pluggy installment date".to_owned())?
        .day();
    let shifted = shifted
        .with_day(date.day().min(last_day))
        .ok_or_else(|| "Invalid Pluggy installment date".to_owned())?;
    Ok(DateTime::from_naive_utc_and_offset(
        shifted.and_time(date.time()),
        Utc,
    ))
}

fn parse_pluggy_date(value: Option<&Value>) -> Result<DateTime<Utc>, String> {
    let value = match value {
        None => return Err("Cannot read properties of undefined (reading 'toISOString')".into()),
        Some(Value::Null) => {
            return Err("Cannot read properties of null (reading 'toISOString')".into());
        }
        Some(value) => value
            .as_str()
            .filter(|value| is_iso_date_shape(value))
            .ok_or_else(|| "date.toISOString is not a function".to_owned())?,
    };
    parse_sdk_date(value).ok_or_else(|| "Invalid time value".to_owned())
}

fn parse_sdk_date(value: &str) -> Option<DateTime<Utc>> {
    let year: i32 = date_component(value, 0..4)?;
    let month: u32 = date_component(value, 5..7)?;
    let day: i64 = date_component::<u32>(value, 8..10)?.into();
    let hour: i64 = date_component::<u32>(value, 11..13)?.into();
    let minute: i64 = date_component::<u32>(value, 14..16)?.into();
    let second: i64 = date_component::<u32>(value, 17..19)?.into();
    let millis: u32 = date_component(value, 20..23)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, 1)?
        .and_hms_milli_opt(0, 0, 0, millis)?
        .checked_add_signed(chrono::Duration::days(day - 1))?
        .checked_add_signed(chrono::Duration::hours(hour))?
        .checked_add_signed(chrono::Duration::minutes(minute))?
        .checked_add_signed(chrono::Duration::seconds(second))?;
    Some(DateTime::from_naive_utc_and_offset(date, Utc))
}

fn date_component<T: std::str::FromStr>(value: &str, range: std::ops::Range<usize>) -> Option<T> {
    value.get(range)?.parse().ok()
}

fn pluggy_date(value: Option<&Value>) -> Result<String, String> {
    Ok(parse_pluggy_date(value)?.date_naive().to_string())
}

fn is_sdk_date(value: &Value) -> bool {
    value.as_str().is_some_and(is_iso_date_shape)
}

fn is_iso_date_shape(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes()[5..7].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes()[8..10].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes()[11..13].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes()[14..16].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(16) == Some(&b':')
        && value.as_bytes()[17..19].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(19) == Some(&b'.')
        && value.as_bytes()[20..23].iter().all(u8::is_ascii_digit)
        && value.as_bytes().get(23) == Some(&b'Z')
}

fn number(value: &Value) -> Result<f64, String> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .ok_or_else(|| "Pluggy response contained an invalid amount".to_owned())
}

fn numeric_value(number: f64) -> Value {
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

fn finite_number(number: f64) -> Value {
    numeric_value(number)
}

fn amount_to_integer(value: &Value) -> i64 {
    (number(value).unwrap_or(0.0) * 100.0).round() as i64
}

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}
