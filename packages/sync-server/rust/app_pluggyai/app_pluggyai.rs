use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::{DateTime, Datelike, Months, NaiveDate, Utc};
use serde_json::{Map, Value, json};

use crate::{
    app::AppState,
    app_gocardless::utils::amount_to_integer,
    services::user_service,
    util::{middlewares::ValidatedSession, paths::is_valid_file_id},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", post(status))
        .route("/accounts", post(accounts))
        .route("/transactions", post(transactions))
}

async fn status(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
) -> Response {
    let file_id = header_file_id(&headers);
    if let Err(response) = authorize_file(&state, file_id, &session.user_id) {
        return response;
    }
    match state.pluggyai.get_credential_source(&state, file_id) {
        Ok(source) => Json(json!({
            "status": "ok",
            "data": { "configured": source.is_some(), "source": source }
        }))
        .into_response(),
        Err(_) => internal_error(),
    }
}

async fn accounts(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
) -> Response {
    let file_id = header_file_id(&headers);
    if let Err(response) = authorize_file(&state, file_id, &session.user_id) {
        return response;
    }
    let source = match state.pluggyai.get_credential_source(&state, file_id) {
        Ok(source) => source,
        Err(_) => return internal_error(),
    };
    if source.is_none() {
        return not_configured();
    }
    let item_ids = match state.pluggyai.get_item_ids(&state, file_id) {
        Ok(item_ids) => item_ids,
        Err(_) => return internal_error(),
    };
    let mut accounts = Vec::new();
    for item_id in item_ids {
        let partial = match state
            .pluggyai
            .get_accounts_by_item_id(&state, &item_id, file_id)
            .await
        {
            Ok(partial) => partial,
            Err(error) => return provider_error(error),
        };
        accounts.extend(
            partial
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
    }
    Json(json!({ "status": "ok", "data": { "accounts": accounts } })).into_response()
}

async fn transactions(
    State(state): State<AppState>,
    ValidatedSession(session): ValidatedSession,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let file_id = header_file_id(&headers);
    if let Err(response) = authorize_file(&state, file_id, &session.user_id) {
        return response;
    }
    match state.pluggyai.get_credential_source(&state, file_id) {
        Ok(Some(_)) => {}
        Ok(None) => return not_configured(),
        Err(_) => return internal_error(),
    }
    let account_id = javascript_string(body.get("accountId"));
    let start_date = body.get("startDate").and_then(Value::as_str);
    let transactions = match state
        .pluggyai
        .get_transactions_by_account_id(&state, &account_id, start_date, file_id)
        .await
    {
        Ok(transactions) => transactions,
        Err(error) => return provider_error(error),
    };
    let account = match state
        .pluggyai
        .get_account_by_id(&state, &account_id, file_id)
        .await
    {
        Ok(account) => account,
        Err(error) => return provider_error(error),
    };
    match normalize_transactions(&account, transactions) {
        Ok(data) => Json(json!({ "status": "ok", "data": data })).into_response(),
        Err(error) => provider_error(error),
    }
}

fn normalize_transactions(account: &Value, transactions: Vec<Value>) -> Result<Value, String> {
    let credit = account.get("type").and_then(Value::as_str) == Some("CREDIT");
    let mut starting_balance = amount_to_integer(account.get("balance").unwrap_or(&Value::Null));
    if credit {
        starting_balance = -starting_balance;
    }
    let reference_date = pluggy_date(account.get("updatedAt"))?;
    let mut balance_amount = Map::from_iter([("amount".into(), json!(starting_balance))]);
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
    let value = value
        .and_then(Value::as_str)
        .filter(|value| is_iso_date(value))
        .ok_or_else(|| "Pluggy response contained an invalid date".to_owned())?;
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|error| error.to_string())
}

fn pluggy_date(value: Option<&Value>) -> Result<String, String> {
    Ok(parse_pluggy_date(value)?.date_naive().to_string())
}

fn is_sdk_date(value: &Value) -> bool {
    value.as_str().is_some_and(is_iso_date)
}

fn is_iso_date(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(23) == Some(&b'Z')
        && DateTime::parse_from_rfc3339(value).is_ok()
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

fn authorize_file(state: &AppState, file_id: Option<&str>, user_id: &str) -> Result<(), Response> {
    let Some(file_id) = file_id else {
        return Ok(());
    };
    if !is_valid_file_id(file_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "reason": "invalid-file-id", "details": "invalid fileId" })),
        )
            .into_response());
    }
    let connection = state.database.lock().map_err(|_| internal_error())?;
    let allowed = user_service::is_admin(&connection, user_id).unwrap_or(false)
        || user_service::count_user_access(&connection, file_id, user_id).unwrap_or(0) > 0;
    if allowed {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "status": "error",
                "reason": "file-access-denied",
                "details": "You don't have permissions over this file"
            })),
        )
            .into_response())
    }
}

fn header_file_id(headers: &HeaderMap) -> Option<&str> {
    headers.get("x-actual-file-id")?.to_str().ok()
}

fn not_configured() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "status": "error",
            "reason": "not-configured",
            "details": "Pluggy credentials are not configured"
        })),
    )
        .into_response()
}

fn provider_error(error: String) -> Response {
    Json(json!({ "status": "ok", "data": { "error": error } })).into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "status": "error", "reason": "internal-error" })),
    )
        .into_response()
}

fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_objects_and_clamps_installment_dates() {
        let mut output = Map::new();
        flatten_object(
            json!({ "merchant": { "name": "Shop", "empty": null }, "tags": ["one"] })
                .as_object()
                .unwrap(),
            "",
            &mut output,
        );
        assert_eq!(output["merchant.name"], "Shop");
        assert_eq!(output["tags"], json!(["one"]));

        let date = DateTime::parse_from_rfc3339("2024-01-31T10:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            add_months_clamped(date, 1)
                .unwrap()
                .date_naive()
                .to_string(),
            "2024-02-29"
        );
    }

    #[test]
    fn selects_merchant_and_payment_payees() {
        assert_eq!(
            get_payee_name(
                json!({ "merchant": { "businessName": "Shop" } })
                    .as_object()
                    .unwrap()
            ),
            "Shop"
        );
        assert_eq!(
            get_payee_name(
                json!({ "type": "DEBIT", "paymentData": { "receiver": { "documentNumber": { "value": "123" } } } })
                    .as_object()
                    .unwrap()
            ),
            "123"
        );
    }
}
