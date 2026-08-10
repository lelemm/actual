use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Datelike, Local, NaiveDate, Offset, TimeZone, Utc};
use reqwest::{Client, StatusCode, Url, header};
use serde_json::{Map, Value, json};

#[derive(Debug)]
pub struct AccountsResult {
    pub data: Value,
    pub access_key: Option<String>,
    pub claimed: bool,
}

#[derive(Debug)]
pub enum TransactionsError {
    InvalidToken,
    ServerDown,
    Internal,
    ProviderInternal(String),
}

pub fn status_data(token: Option<&str>) -> Value {
    json!({ "configured": token.is_some_and(|token| !is_forbidden(token)) })
}

pub async fn accounts(
    client: &Client,
    token: Option<&str>,
    access_key: Option<&str>,
) -> AccountsResult {
    let (access_key, claimed) = match ensure_access_key(client, token, access_key).await {
        Ok(result) => result,
        Err(EnsureAccessKeyError::InvalidToken) => {
            return AccountsResult {
                data: invalid_token_data(),
                access_key: None,
                claimed: false,
            };
        }
        Err(EnsureAccessKeyError::ServerDown) => {
            return AccountsResult {
                data: server_down_data(),
                access_key: None,
                claimed: false,
            };
        }
    };
    let data = match get_accounts(client, &access_key, None, None, None, true).await {
        Ok(results) => {
            let mut data = Map::new();
            if let Some(accounts) = results.get("accounts") {
                data.insert("accounts".into(), accounts.clone());
            }
            Value::Object(data)
        }
        Err(_) => server_down_data(),
    };
    AccountsResult {
        data,
        access_key: Some(access_key),
        claimed,
    }
}

pub async fn transactions(
    client: &Client,
    access_key: Option<&str>,
    body: &Value,
) -> Result<Value, TransactionsError> {
    let access_key = access_key
        .filter(|value| !is_invalid_access_key(value))
        .ok_or(TransactionsError::InvalidToken)?;
    let account_id = body.get("accountId").cloned().unwrap_or(Value::Null);
    let start_date = body.get("startDate").cloned().unwrap_or(Value::Null);
    let account_ids = strings(&account_id).ok_or(TransactionsError::Internal)?;
    let start_dates = strings(&start_date).ok_or(TransactionsError::Internal)?;
    let uses_arrays = account_id.is_array();
    if uses_arrays != start_date.is_array() {
        return Err(TransactionsError::ProviderInternal(
            "accountId and startDate must either both be arrays or both be strings".into(),
        ));
    }
    if uses_arrays && account_ids.len() != start_dates.len() {
        return Err(TransactionsError::ProviderInternal(
            "accountId and startDate arrays must be the same length".into(),
        ));
    }
    let parsed_dates = start_dates
        .iter()
        .map(|date| parse_date(date))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| TransactionsError::Internal)?;
    let earliest = parsed_dates
        .iter()
        .min()
        .copied()
        .ok_or(TransactionsError::Internal)?;
    let mut results = get_accounts(
        client,
        access_key,
        Some(&account_ids),
        Some(earliest),
        Some(first_day_of_next_month()),
        false,
    )
    .await
    .map_err(|error| {
        if is_forbidden(&error) {
            TransactionsError::InvalidToken
        } else {
            TransactionsError::ServerDown
        }
    })?;

    if results.get("errors").is_none() {
        return Err(TransactionsError::ProviderInternal(
            "Cannot read properties of undefined (reading 'find')".into(),
        ));
    }
    let sferrors = results
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut errors = Map::new();
    let mut response = Map::new();
    for (id, start) in account_ids.iter().zip(parsed_dates) {
        match get_account_response(&results, id, start, &sferrors, &mut errors)
            .map_err(|_| TransactionsError::Internal)?
        {
            Some(account) => {
                response.insert(id.clone(), account);
            }
            None => {}
        }
    }
    let has_error = !errors.is_empty();
    results["errors"] = Value::Object(errors.clone());
    results["hasError"] = Value::Bool(has_error);

    Ok(if has_error && !uses_arrays {
        errors
            .get(&account_ids[0])
            .and_then(Value::as_array)
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or(Value::Null)
    } else if uses_arrays {
        if has_error {
            response.insert("errors".into(), Value::Object(errors));
        }
        Value::Object(response)
    } else {
        response.remove(&account_ids[0]).unwrap_or(Value::Null)
    })
}

pub fn invalid_token_data() -> Value {
    json!({
        "error_type": "INVALID_ACCESS_TOKEN",
        "error_code": "INVALID_ACCESS_TOKEN",
        "status": "rejected",
        "reason": "Invalid SimpleFIN access token.  Reset the token and re-link any broken accounts."
    })
}

pub fn server_down_data() -> Value {
    json!({
        "error_type": "SERVER_DOWN",
        "error_code": "SERVER_DOWN",
        "status": "rejected",
        "reason": "There was an error communicating with SimpleFIN."
    })
}

pub fn provider_internal_error_data(reason: &str) -> Value {
    json!({ "error_code": "INTERNAL_ERROR", "error_type": reason })
}

enum EnsureAccessKeyError {
    InvalidToken,
    ServerDown,
}

async fn ensure_access_key(
    client: &Client,
    token: Option<&str>,
    access_key: Option<&str>,
) -> Result<(String, bool), EnsureAccessKeyError> {
    if let Some(access_key) = access_key.filter(|value| !is_invalid_access_key(value)) {
        return Ok((access_key.to_owned(), false));
    }
    let token = token
        .filter(|value| !is_forbidden(value))
        .ok_or(EnsureAccessKeyError::InvalidToken)?;
    let claim_url = decode_claim_url(token).ok_or(EnsureAccessKeyError::InvalidToken)?;
    let access_key = claim_access_key(client, &claim_url)
        .await
        .map_err(|_| EnsureAccessKeyError::ServerDown)?;
    if is_invalid_access_key(&access_key) {
        return Err(EnsureAccessKeyError::InvalidToken);
    }
    Ok((access_key, true))
}

fn decode_claim_url(token: &str) -> Option<Url> {
    let decoded = String::from_utf8(STANDARD.decode(token).ok()?).ok()?;
    let url = Url::parse(&decoded).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

async fn claim_access_key(client: &Client, url: &Url) -> Result<String, String> {
    assert_url_allowed(url).await?;
    let response = client
        .post(url.clone())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() && response.status() != StatusCode::FORBIDDEN {
        return Err(format!(
            "SimpleFIN claim failed with HTTP {}",
            response.status()
        ));
    }
    response
        .text()
        .await
        .map(|value| value.trim().to_owned())
        .map_err(|error| error.to_string())
}

async fn get_accounts(
    client: &Client,
    access_key: &str,
    accounts: Option<&[String]>,
    start_date: Option<i64>,
    end_date: Option<i64>,
    balances_only: bool,
) -> Result<Value, String> {
    let (mut url, username, password) = parse_access_key(access_key)?;
    url.set_path(&format!("{}/accounts", url.path().trim_end_matches('/')));
    {
        let mut query = url.query_pairs_mut();
        if balances_only {
            query.append_pair("balances-only", "1");
        } else {
            if let Some(start_date) = start_date {
                query.append_pair("start-date", &start_date.to_string());
            }
            if let Some(end_date) = end_date {
                query.append_pair("end-date", &end_date.to_string());
            }
            query.append_pair("pending", "1");
        }
        if let Some(accounts) = accounts {
            for id in accounts {
                query.append_pair("account", id);
            }
        }
    }
    let authorization = format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    );
    let mut include_authorization = true;
    for hop in 0..=5 {
        assert_url_allowed(&url).await?;
        let mut request = client.get(url.clone());
        if include_authorization {
            request = request.header(header::AUTHORIZATION, &authorization);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok());
        if !response.status().is_redirection() || location.is_none() {
            if response.status() == StatusCode::FORBIDDEN {
                return Err("Forbidden".into());
            }
            let text = response.text().await.map_err(|error| error.to_string())?;
            let value = serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())?;
            if !value.is_object() && !value.is_array() {
                return Err("SimpleFIN response does not support properties".into());
            }
            return Ok(value);
        }
        if hop == 5 {
            return Err("Too many redirects".into());
        }
        let next = url
            .join(location.expect("checked location"))
            .map_err(|error| error.to_string())?;
        include_authorization &= next.origin() == url.origin();
        url = next;
    }
    Err("Too many redirects".into())
}

#[cfg(not(target_arch = "wasm32"))]
async fn assert_url_allowed(url: &Url) -> Result<(), String> {
    crate::util::ssrf::assert_url_allowed(url, true).await
}

#[cfg(target_arch = "wasm32")]
async fn assert_url_allowed(url: &Url) -> Result<(), String> {
    matches!(url.scheme(), "http" | "https")
        .then_some(())
        .ok_or_else(|| "URL scheme is not allowed".into())
}

fn strings(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::String(value) => Some(vec![value.clone()]),
        Value::Array(values) => values
            .iter()
            .map(|value| value.as_str().map(str::to_owned))
            .collect(),
        _ => None,
    }
}

fn parse_date(value: &str) -> Result<i64, ()> {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        let utc = date.with_timezone(&Utc);
        let offset = Local.offset_from_utc_datetime(&utc.naive_utc()).fix();
        return Ok(utc.timestamp() + i64::from(offset.local_minus_utc()));
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| ())?;
    let utc = date.and_hms_opt(0, 0, 0).ok_or(())?;
    let offset = Local.offset_from_utc_datetime(&utc).fix();
    Ok(utc.and_utc().timestamp() + i64::from(offset.local_minus_utc()))
}

fn first_day_of_next_month() -> i64 {
    let now = Local::now().date_naive();
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    NaiveDate::from_ymd_opt(year, month, 1)
        .expect("valid first day")
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight")
        .and_utc()
        .timestamp()
}

fn get_account_response(
    results: &Value,
    account_id: &str,
    start_date: i64,
    sferrors: &[Value],
    errors: &mut Map<String, Value>,
) -> Result<Option<Value>, String> {
    let account = results
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|accounts| {
            accounts
                .iter()
                .find(|account| account.get("id").and_then(Value::as_str) == Some(account_id))
        });
    let Some(account) = account else {
        log_account_error(
            errors,
            account_id,
            json!({
                "error_type": "ACCOUNT_MISSING",
                "error_code": "ACCOUNT_MISSING",
                "reason": format!("The account \"{account_id}\" was not found. Try unlinking and relinking the account.")
            }),
        );
        return Ok(None);
    };
    let organization = account
        .pointer("/org/name")
        .and_then(Value::as_str)
        .ok_or("missing SimpleFIN organization")?;
    if sferrors
        .iter()
        .filter_map(Value::as_str)
        .any(|error| error.starts_with(&format!("Connection to {organization} may need attention")))
    {
        log_account_error(
            errors,
            account_id,
            json!({
                "error_type": "ACCOUNT_NEEDS_ATTENTION",
                "error_code": "ACCOUNT_NEEDS_ATTENTION",
                "reason": "The account needs your attention at <a href=\"https://bridge.simplefin.org/auth/login\">SimpleFIN</a>."
            }),
        );
    }

    let balance = account
        .get("balance")
        .and_then(Value::as_str)
        .ok_or("missing SimpleFIN balance")?;
    let currency = account.get("currency").cloned().unwrap_or(Value::Null);
    let balance_date = account
        .get("balance-date")
        .and_then(Value::as_i64)
        .ok_or("missing SimpleFIN balance date")?;
    let reference_date = date_from_timestamp(balance_date)?;
    let balance_amount = json!({ "amount": balance, "currency": currency });
    let balances = json!([
        {
            "balanceAmount": balance_amount,
            "balanceType": "expected",
            "referenceDate": reference_date,
        },
        {
            "balanceAmount": balance_amount,
            "balanceType": "interimAvailable",
            "referenceDate": reference_date,
        }
    ]);

    let mut all = Vec::new();
    let mut booked = Vec::new();
    let mut pending = Vec::new();
    for transaction in account
        .get("transactions")
        .and_then(Value::as_array)
        .ok_or("missing SimpleFIN transactions")?
    {
        let posted = transaction
            .get("posted")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let is_pending = transaction
            .get("pending")
            .filter(|value| !value.is_null())
            .is_some_and(js_truthy)
            || (transaction.get("pending").is_none_or(Value::is_null) && posted == 0);
        let date_to_use = if is_pending {
            transaction
                .get("transacted_at")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        } else {
            posted
        };
        if date_to_use < start_date {
            continue;
        }
        let mut converted = Map::new();
        converted.insert("booked".into(), Value::Bool(!is_pending));
        converted.insert("sortOrder".into(), Value::Number(date_to_use.into()));
        converted.insert(
            "date".into(),
            Value::String(date_from_timestamp(date_to_use)?),
        );
        copy_as(&mut converted, "payeeName", transaction, "payee");
        copy_as(&mut converted, "notes", transaction, "description");
        let mut amount = Map::new();
        if let Some(value) = transaction.get("amount") {
            amount.insert("amount".into(), value.clone());
        }
        amount.insert("currency".into(), Value::String("USD".into()));
        converted.insert("transactionAmount".into(), Value::Object(amount));
        copy_as(&mut converted, "transactionId", transaction, "id");
        if let Some(timestamp) = transaction.get("transacted_at").and_then(Value::as_i64)
            && timestamp != 0
        {
            converted.insert(
                "transactedDate".into(),
                Value::String(date_from_timestamp(timestamp)?),
            );
        }
        if posted != 0 {
            converted.insert(
                "postedDate".into(),
                Value::String(date_from_timestamp(posted)?),
            );
        }
        let converted = Value::Object(converted);
        if is_pending {
            pending.push(converted.clone());
        } else {
            booked.push(converted.clone());
        }
        all.push(converted);
    }
    let by_newest =
        |left: &Value, right: &Value| right["sortOrder"].as_i64().cmp(&left["sortOrder"].as_i64());
    all.sort_by(by_newest);
    booked.sort_by(by_newest);
    pending.sort_by(by_newest);
    Ok(Some(json!({
        "balances": balances,
        "startingBalance": parse_js_integer(&balance.replace('.', ""))?,
        "transactions": { "all": all, "booked": booked, "pending": pending }
    })))
}

fn log_account_error(errors: &mut Map<String, Value>, account_id: &str, error: Value) {
    errors
        .entry(account_id.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .expect("error list")
        .push(error);
}

fn copy_as(target: &mut Map<String, Value>, target_name: &str, source: &Value, source_name: &str) {
    if let Some(value) = source.get(source_name) {
        target.insert(target_name.into(), value.clone());
    }
}

fn date_from_timestamp(timestamp: i64) -> Result<String, String> {
    chrono::DateTime::from_timestamp(timestamp, 0)
        .map(|date| date.format("%Y-%m-%d").to_string())
        .ok_or_else(|| "invalid SimpleFIN timestamp".into())
}

fn parse_js_integer(value: &str) -> Result<i64, String> {
    let value = value.trim_start();
    let digits = value
        .char_indices()
        .take_while(|(index, character)| {
            character.is_ascii_digit() || (*index == 0 && matches!(character, '+' | '-'))
        })
        .last()
        .map_or("", |(index, character)| {
            &value[..index + character.len_utf8()]
        });
    digits
        .parse()
        .map_err(|_| "invalid SimpleFIN balance".into())
}

fn js_truthy(value: &Value) -> bool {
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

fn parse_access_key(access_key: &str) -> Result<(Url, String, String), String> {
    let mut url = Url::parse(access_key).map_err(|_| "Invalid access key".to_owned())?;
    let username = url.username().to_owned();
    let password = url.password().unwrap_or_default().to_owned();
    if username.is_empty() || password.is_empty() || url.host_str().is_none() {
        return Err("Invalid access key".into());
    }
    url.set_username("").map_err(|_| "Invalid access key")?;
    url.set_password(None).map_err(|_| "Invalid access key")?;
    Ok((url, username, password))
}

fn is_invalid_access_key(value: &str) -> bool {
    is_forbidden(value) || parse_access_key(value).is_err()
}

fn is_forbidden(value: &str) -> bool {
    value.starts_with("Forbidden")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_status_and_error_shapes_match_the_http_contract() {
        assert_eq!(status_data(None), json!({ "configured": false }));
        assert_eq!(
            status_data(Some("Forbidden once")),
            json!({ "configured": false })
        );
        assert_eq!(status_data(Some("token")), json!({ "configured": true }));
        assert_eq!(invalid_token_data()["error_code"], "INVALID_ACCESS_TOKEN");
        assert_eq!(server_down_data()["error_code"], "SERVER_DOWN");
    }

    #[test]
    fn pure_normalization_preserves_pending_and_booked_transactions() {
        let results = json!({
            "accounts": [{
                "id": "account-1",
                "org": { "name": "Bank" },
                "balance": "12.34",
                "currency": "USD",
                "balance-date": 1_704_067_200,
                "transactions": [
                    { "id": "booked", "posted": 1_704_067_200, "amount": "1.00" },
                    { "id": "pending", "posted": 0, "transacted_at": 1_704_153_600, "amount": "2.00" }
                ]
            }]
        });
        let mut errors = Map::new();
        let account = get_account_response(&results, "account-1", 0, &[], &mut errors)
            .unwrap()
            .unwrap();

        assert_eq!(account["startingBalance"], 1234);
        assert_eq!(
            account["transactions"]["booked"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            account["transactions"]["pending"].as_array().unwrap().len(),
            1
        );
    }
}
