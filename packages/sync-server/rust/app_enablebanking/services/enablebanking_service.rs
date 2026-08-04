use std::{sync::OnceLock, time::Duration};

use regex::Regex;
use reqwest::{Method, Url};
use serde_json::{Value, json};

use crate::{app::AppState, services::secrets_service};

use super::super::utils::{
    errors::{EnableBankingError, handle_enable_banking_error},
    jwt::get_jwt,
};

const APPLICATION_ID: &str = "enablebanking_applicationId";
const SECRET_KEY: &str = "enablebanking_secretKey";
const BASE_URL: &str = "https://api.enablebanking.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub type PsuHeaders = Vec<(&'static str, String)>;

fn credentials(state: &AppState) -> Result<(String, String), EnableBankingError> {
    let connection = state
        .database
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let application_id =
        secrets_service::get(&connection, APPLICATION_ID, None).map_err(database_error)?;
    let secret_key = secrets_service::get(&connection, SECRET_KEY, None).map_err(database_error)?;
    match (application_id, secret_key) {
        (Some(application_id), Some(secret_key))
            if !application_id.is_empty() && !secret_key.is_empty() =>
        {
            Ok((application_id, secret_key))
        }
        _ => Err(EnableBankingError::new(
            "INVALID_INPUT",
            "NOT_CONFIGURED",
            Some("Enable Banking is not configured".into()),
        )),
    }
}

fn database_error(error: rusqlite::Error) -> EnableBankingError {
    EnableBankingError::new("INTERNAL_ERROR", "INTERNAL_ERROR", Some(error.to_string()))
}

pub fn is_configured(state: &AppState) -> Result<bool, EnableBankingError> {
    let connection = state
        .database
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let application_id =
        secrets_service::get(&connection, APPLICATION_ID, None).map_err(database_error)?;
    let secret_key = secrets_service::get(&connection, SECRET_KEY, None).map_err(database_error)?;
    Ok(application_id.is_some_and(|value| !value.is_empty())
        && secret_key.is_some_and(|value| !value.is_empty()))
}

fn base_url() -> Result<Url, EnableBankingError> {
    let value = std::env::var("ENABLEBANKING_API_URL").unwrap_or_else(|_| BASE_URL.into());
    let mut url = Url::parse(&value).map_err(|error| {
        EnableBankingError::new("INVALID_INPUT", "INVALID_INPUT", Some(error.to_string()))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(EnableBankingError::new(
            "INVALID_INPUT",
            "INVALID_INPUT",
            Some("ENABLEBANKING_API_URL must use http or https".into()),
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn endpoint(path: &str) -> Result<Url, EnableBankingError> {
    base_url()?
        .join(path.trim_start_matches('/'))
        .map_err(|error| {
            EnableBankingError::new("INVALID_INPUT", "INVALID_INPUT", Some(error.to_string()))
        })
}

async fn request(
    state: &AppState,
    method: Method,
    url: Url,
    body: Option<Value>,
    authorization_override: Option<String>,
    psu_headers: &PsuHeaders,
) -> Result<Value, EnableBankingError> {
    let authorization = match authorization_override {
        Some(value) => value,
        None => {
            let (application_id, secret_key) = credentials(state)?;
            format!(
                "Bearer {}",
                get_jwt(&application_id, &secret_key, 3600).map_err(|error| {
                    EnableBankingError::new("INTERNAL_ERROR", "INTERNAL_ERROR", Some(error))
                })?
            )
        }
    };
    let mut outgoing = state
        .http
        .request(method, url.clone())
        .timeout(REQUEST_TIMEOUT)
        .header("Authorization", authorization)
        .header("Content-Type", "application/json");
    for (name, value) in psu_headers {
        outgoing = outgoing.header(*name, value);
    }
    if let Some(body) = body {
        outgoing = outgoing.json(&body);
    }
    let response = outgoing.send().await.map_err(|error| {
        if error.is_timeout() {
            EnableBankingError::new("TIMED_OUT", "TIMED_OUT", Some("Request timed out".into()))
        } else {
            EnableBankingError::new("INTERNAL_ERROR", "INTERNAL_ERROR", Some(error.to_string()))
        }
    })?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| {
        EnableBankingError::new("INTERNAL_ERROR", "INTERNAL_ERROR", Some(error.to_string()))
    })?;
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    if !status.is_success() {
        return Err(handle_enable_banking_error(status.as_u16(), &parsed));
    }
    Ok(parsed)
}

pub async fn validate_credentials(
    state: &AppState,
    application_id: &str,
    secret_key: &str,
) -> Result<Value, EnableBankingError> {
    let token = get_jwt(application_id, secret_key, 3600).map_err(|error| {
        EnableBankingError::new("INTERNAL_ERROR", "INTERNAL_ERROR", Some(error))
    })?;
    request(
        state,
        Method::GET,
        endpoint("application")?,
        None,
        Some(format!("Bearer {token}")),
        &Vec::new(),
    )
    .await
}

pub async fn get_aspsps(
    state: &AppState,
    country: Option<&str>,
) -> Result<Value, EnableBankingError> {
    let mut url = endpoint("aspsps")?;
    if let Some(country) = country {
        url.query_pairs_mut().append_pair("country", country);
    }
    request(state, Method::GET, url, None, None, &Vec::new()).await
}

pub async fn start_auth(
    state: &AppState,
    aspsp: &Value,
    redirect_url: &str,
    auth_state: &str,
    max_consent_validity: Option<f64>,
    psu_type: &str,
) -> Result<Value, EnableBankingError> {
    let default_seconds = 90.0 * 24.0 * 60.0 * 60.0;
    let consent_seconds = max_consent_validity
        .filter(|value| *value > 0.0)
        .map_or(default_seconds, |value| value.min(default_seconds));
    let valid_until =
        chrono::Utc::now() + chrono::Duration::milliseconds((consent_seconds * 1000.0) as i64);
    request(
        state,
        Method::POST,
        endpoint("auth")?,
        Some(json!({
            "aspsp": {
                "name": aspsp.get("name").cloned().unwrap_or(Value::Null),
                "country": aspsp.get("country").cloned().unwrap_or(Value::Null)
            },
            "redirect_url": redirect_url,
            "state": auth_state,
            "access": { "valid_until": valid_until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) },
            "psu_type": psu_type
        })),
        None,
        &Vec::new(),
    )
    .await
}

pub async fn create_session(state: &AppState, code: &str) -> Result<Value, EnableBankingError> {
    request(
        state,
        Method::POST,
        endpoint("sessions")?,
        Some(json!({ "code": code })),
        None,
        &Vec::new(),
    )
    .await
}

pub async fn get_balances(
    state: &AppState,
    account_uid: &str,
    psu_headers: &PsuHeaders,
) -> Result<Value, EnableBankingError> {
    let mut url = base_url()?;
    url.path_segments_mut()
        .map_err(|_| {
            EnableBankingError::new(
                "INVALID_INPUT",
                "INVALID_INPUT",
                Some("Invalid API URL".into()),
            )
        })?
        .extend(["accounts", account_uid, "balances"]);
    request(state, Method::GET, url, None, None, psu_headers).await
}

async fn get_transactions(
    state: &AppState,
    account_uid: &str,
    date_from: &str,
    date_to: &str,
    continuation_key: Option<&str>,
    psu_headers: &PsuHeaders,
) -> Result<Value, EnableBankingError> {
    let mut url = base_url()?;
    url.path_segments_mut()
        .map_err(|_| {
            EnableBankingError::new(
                "INVALID_INPUT",
                "INVALID_INPUT",
                Some("Invalid API URL".into()),
            )
        })?
        .extend(["accounts", account_uid, "transactions"]);
    url.query_pairs_mut()
        .append_pair("date_from", date_from)
        .append_pair("date_to", date_to);
    if let Some(continuation_key) = continuation_key {
        url.query_pairs_mut()
            .append_pair("continuation_key", continuation_key);
    }
    request(state, Method::GET, url, None, None, psu_headers).await
}

pub async fn get_all_transactions(
    state: &AppState,
    account_uid: &str,
    date_from: &str,
    date_to: &str,
    psu_headers: &PsuHeaders,
) -> Result<Vec<Value>, EnableBankingError> {
    let mut all = Vec::new();
    let mut continuation_key: Option<String> = None;
    for _ in 0..100 {
        let page = get_transactions(
            state,
            account_uid,
            date_from,
            date_to,
            continuation_key.as_deref(),
            psu_headers,
        )
        .await?;
        all.extend(
            page.get("transactions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        let next = page
            .get("continuation_key")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if next.is_none() || next == continuation_key {
            break;
        }
        continuation_key = next;
    }
    Ok(all)
}

pub fn normalize_transaction(transaction: &Value) -> Value {
    let mut output = transaction.as_object().cloned().unwrap_or_default();
    let transaction_id = string(transaction, "entry_reference")
        .filter(|value| !value.is_empty())
        .or_else(|| string(transaction, "transaction_id"))
        .unwrap_or_default();
    let booking_date = ["booking_date", "value_date", "transaction_date"]
        .into_iter()
        .find_map(|key| string(transaction, key).filter(|value| !value.is_empty()))
        .unwrap_or_default();
    let cleaned = transaction
        .get("remittance_information")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(strip_sepa_prefix)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let indicator = string(transaction, "credit_debit_indicator");
    let payee = match indicator.as_deref() {
        Some("CRDT") => nested_string(transaction, "debtor", "name"),
        Some("DBIT") => nested_string(transaction, "creditor", "name"),
        _ => None,
    }
    .or_else(|| nested_string(transaction, "creditor", "name"))
    .or_else(|| nested_string(transaction, "debtor", "name"))
    .or_else(|| cleaned.first().cloned())
    .unwrap_or_default();
    let raw_amount = nested_string(transaction, "transaction_amount", "amount")
        .unwrap_or_default()
        .trim()
        .to_owned();
    let unsigned = raw_amount.trim_start_matches(['+', '-']);
    let amount = match indicator.as_deref() {
        Some("DBIT") => format!("-{unsigned}"),
        Some("CRDT") => unsigned.to_owned(),
        _ => raw_amount,
    };
    let currency = transaction
        .get("transaction_amount")
        .and_then(|value| value.get("currency"))
        .cloned()
        .unwrap_or(Value::Null);
    let remittance = (!cleaned.is_empty()).then(|| cleaned.join(" "));
    output.insert("transactionId".into(), Value::String(transaction_id));
    output.insert("date".into(), Value::String(booking_date.clone()));
    output.insert("bookingDate".into(), Value::String(booking_date));
    if let Some(value_date) = transaction
        .get("value_date")
        .filter(|value| !value.is_null())
    {
        output.insert("valueDate".into(), value_date.clone());
    }
    output.insert(
        "transactionAmount".into(),
        json!({ "amount": amount, "currency": currency }),
    );
    output.insert("payeeName".into(), Value::String(payee));
    if let Some(remittance) = remittance {
        output.insert("notes".into(), Value::String(remittance.clone()));
        output.insert(
            "remittanceInformationUnstructured".into(),
            Value::String(remittance),
        );
    }
    output.insert(
        "booked".into(),
        Value::Bool(string(transaction, "status").as_deref() != Some("PDNG")),
    );
    Value::Object(output)
}

pub fn is_importable_transaction(transaction: &Value) -> bool {
    static DATE: OnceLock<Regex> = OnceLock::new();
    let date = transaction
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let amount = transaction
        .pointer("/transactionAmount/amount")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    DATE.get_or_init(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap())
        .is_match(date)
        && !amount.is_empty()
        && amount.parse::<f64>().is_ok_and(f64::is_finite)
}

pub fn normalize_balance(balance: &Value) -> Value {
    let amount = nested_string(balance, "balance_amount", "amount")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(f64::NAN);
    let cents = amount.mul_add(100.0, 0.5).floor();
    let mut normalized = serde_json::Map::from_iter([
        (
            "balanceAmount".into(),
            json!({
                "amount": if cents.is_finite() { Value::from(cents as i64) } else { Value::Null },
                "currency": balance.pointer("/balance_amount/currency").cloned().unwrap_or(Value::Null)
            }),
        ),
        (
            "balanceType".into(),
            balance.get("balance_type").cloned().unwrap_or(Value::Null),
        ),
    ]);
    if let Some(reference_date) = balance.get("reference_date") {
        normalized.insert("referenceDate".into(), reference_date.clone());
    }
    Value::Object(normalized)
}

pub fn normalize_account(account: &Value, aspsp: Option<&Value>) -> Value {
    let uid = string(account, "uid").unwrap_or_default();
    let name = string(account, "name")
        .filter(|value| !value.is_empty())
        .or_else(|| nested_string(account, "account_id", "iban"))
        .unwrap_or_else(|| uid.clone());
    let institution = aspsp
        .and_then(|value| string(value, "name"))
        .filter(|value| !value.is_empty())
        .or_else(|| nested_string(account, "account_servicer", "name"))
        .unwrap_or_else(|| "Unknown".into());
    let mut normalized = serde_json::Map::from_iter([
        ("account_id".into(), Value::String(uid)),
        ("name".into(), Value::String(name)),
        ("institution".into(), Value::String(institution)),
    ]);
    if let Some(currency) = account.get("currency") {
        normalized.insert("currency".into(), currency.clone());
    }
    if let Some(iban) = account.pointer("/account_id/iban") {
        normalized.insert("iban".into(), iban.clone());
    }
    Value::Object(normalized)
}

fn strip_sepa_prefix(value: &str) -> String {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    PREFIX
        .get_or_init(|| Regex::new(r"^(?:EREF|KREF|MREF|CRED|DBTR|CDTR|SVWZ|SVCL|PURP|RTRN|REJT|REFE|SDVA|INDA|NTAV|ULTC|ULTD|ULTB|ABWA|ABWE|IBAN|BIC|COAM|OAMT|REMI|SQTP|ROC)\+").unwrap())
        .replace(value, "")
        .trim()
        .to_owned()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn nested_string(value: &Value, key: &str, nested: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.get(nested))
        .and_then(Value::as_str)
        .map(str::to_owned)
}
