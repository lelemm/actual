use axum::{
    Json, Router,
    extract::State,
    http::HeaderMap,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    app::AppState, app_gocardless::errors::GoCardlessErrorKind, util::middlewares::ValidatedSession,
};

const LINK_PAGE_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Actual</title>
  </head>
  <body>
    <script>
      window.close();
    </script>

    <p>Please wait...</p>
    <p>
      The window should close automatically. If nothing happened you can close
      this window or tab.
    </p>
  </body>
</html>"#;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/link", get(|| async { Html(LINK_PAGE_HTML) }))
        .route("/status", post(status))
        .route("/create-web-token", post(create_web_token))
        .route("/get-accounts", post(get_accounts))
        .route("/get-banks", post(get_banks))
        .route("/remove-account", post(remove_account))
        .route("/transactions", post(transactions))
}

async fn get_accounts(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let requisition_id = match body_id(&body, "requisitionId") {
        Ok(requisition_id) => requisition_id,
        Err(error) => return handled_error(error),
    };
    match state
        .gocardless
        .get_requisition_with_accounts(&state, requisition_id)
        .await
    {
        Ok((mut requisition, mut accounts)) => {
            for account in &mut accounts {
                if let Some(iban) = account.get("iban").and_then(Value::as_str) {
                    account["iban"] =
                        Value::String(STANDARD.encode(Sha256::digest(iban.as_bytes())));
                }
            }
            requisition["accounts"] = Value::Array(accounts);
            Json(json!({ "status": "ok", "data": requisition })).into_response()
        }
        Err(error) if error.kind == GoCardlessErrorKind::RequisitionNotLinked => Json(json!({
            "status": "ok",
            "requisitionStatus": error.details.get("requisitionStatus").cloned()
        }))
        .into_response(),
        Err(error) => handled_error(error.to_string()),
    }
}

async fn create_web_token(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let institution_id = match body_id(&body, "institutionId") {
        Ok(institution_id) => institution_id,
        Err(error) => return handled_error(error),
    };
    let host = match redirect_host(&headers) {
        Ok(host) => host,
        Err(error) => return handled_error(error),
    };
    match state
        .gocardless
        .create_requisition(&state, institution_id, &host)
        .await
    {
        Ok((link, requisition_id)) => Json(json!({
            "status": "ok",
            "data": { "link": link, "requisitionId": requisition_id }
        }))
        .into_response(),
        Err(error) => handled_error(error.to_string()),
    }
}

async fn status(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
) -> Response {
    let configured = state.gocardless.is_configured(&state);
    Json(json!({ "status": "ok", "data": { "configured": configured } })).into_response()
}

async fn get_banks(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let country = match body_id(&body, "country") {
        Ok(country) => country,
        Err(error) => return handled_error(error),
    };
    match state.gocardless.get_institutions(&state, country).await {
        Ok(Value::Array(mut institutions)) => {
            if body
                .get("showDemo")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                institutions.insert(
                    0,
                    json!({
                        "id": "SANDBOXFINANCE_SFIN0000",
                        "name": "DEMO bank (used for testing bank-sync)"
                    }),
                );
            }
            Json(json!({ "status": "ok", "data": institutions })).into_response()
        }
        Ok(_) => handled_error("GoCardless returned error"),
        Err(error) => handled_error(error.to_string()),
    }
}

async fn remove_account(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let requisition_id = match body_id(&body, "requisitionId") {
        Ok(requisition_id) => requisition_id,
        Err(error) => return handled_error(error),
    };
    match state
        .gocardless
        .delete_requisition(&state, requisition_id)
        .await
    {
        Ok(data) if data.get("summary").and_then(Value::as_str) == Some("Requisition deleted") => {
            Json(json!({ "status": "ok", "data": data })).into_response()
        }
        Ok(data) => Json(json!({
            "status": "error",
            "data": { "data": data, "reason": "Can not delete requisition" }
        }))
        .into_response(),
        Err(error) => handled_error(error.to_string()),
    }
}

async fn transactions(
    State(state): State<AppState>,
    ValidatedSession(_session): ValidatedSession,
    Json(body): Json<Value>,
) -> Response {
    let requisition_id = match body_id(&body, "requisitionId") {
        Ok(value) => value,
        Err(error) => return handled_error(error),
    };
    let account_id = match body_id(&body, "accountId") {
        Ok(value) => value,
        Err(error) => return handled_error(error),
    };
    match state
        .gocardless
        .get_transactions(
            &state,
            requisition_id,
            account_id,
            body.get("startDate").and_then(Value::as_str),
            body.get("endDate").and_then(Value::as_str),
            body.get("includeBalance")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        )
        .await
    {
        Ok(data) => Json(json!({ "status": "ok", "data": data })).into_response(),
        Err(error) => transaction_error(error),
    }
}

fn transaction_error(error: crate::app_gocardless::errors::GoCardlessError) -> Response {
    let (error_type, error_code, status, reason) = match error.kind {
        GoCardlessErrorKind::RequisitionNotLinked => (
            "ITEM_ERROR",
            "ITEM_LOGIN_REQUIRED",
            Some("expired"),
            Some("Access to account has expired as set in End User Agreement"),
        ),
        GoCardlessErrorKind::AccountNotLinked => (
            "INVALID_INPUT",
            "INVALID_ACCESS_TOKEN",
            Some("rejected"),
            Some("Account not linked with this requisition"),
        ),
        GoCardlessErrorKind::EndUserAgreementExpired => (
            "ITEM_ERROR",
            "ITEM_LOGIN_REQUIRED",
            Some("expired"),
            Some("Access to account has expired as set in End User Agreement"),
        ),
        GoCardlessErrorKind::RateLimit => (
            "RATE_LIMIT_EXCEEDED",
            "NORDIGEN_ERROR",
            Some("rejected"),
            Some("Rate limit exceeded"),
        ),
        GoCardlessErrorKind::Generic => ("SYNC_ERROR", "NORDIGEN_ERROR", None, None),
        GoCardlessErrorKind::Client => ("UNKNOWN", "UNKNOWN", None, Some("Something went wrong")),
    };
    let response_headers = error
        .details
        .get("response")
        .and_then(|response| response.get("headers"))
        .and_then(Value::as_object);
    let rate_limit_headers = response_headers.map_or_else(serde_json::Map::new, |headers| {
        headers
            .iter()
            .filter(|(key, _)| key.starts_with("x-ratelimit-"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    });
    let mut data = serde_json::Map::from_iter([
        ("error_type".into(), json!(error_type)),
        ("error_code".into(), json!(error_code)),
        ("details".into(), error.details),
        ("rateLimitHeaders".into(), Value::Object(rate_limit_headers)),
    ]);
    if let Some(status) = status {
        data.insert("status".into(), json!(status));
    }
    if let Some(reason) = reason {
        data.insert("reason".into(), json!(reason));
    }
    Json(json!({ "status": "ok", "data": data })).into_response()
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
}

fn body_id<'a>(body: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = body.get(key);
    match value.and_then(Value::as_str) {
        Some(value) if is_safe_id(value) => Ok(value),
        _ => Err(format!(
            "Invalid GoCardless identifier: {}",
            javascript_string(value)
        )),
    }
}

fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                value => javascript_string(Some(value)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn redirect_host(headers: &HeaderMap) -> Result<String, &'static str> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or("Invalid Origin header")?;
    if origin == "app://actual" {
        let host = headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .ok_or("Invalid Origin header")?;
        return Ok(format!("http://{host}"));
    }
    let origin = reqwest::Url::parse(origin).map_err(|_| "Invalid Origin header")?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err("Invalid Origin header");
    }
    Ok(origin.origin().ascii_serialization())
}

fn handled_error(error_type: impl Into<String>) -> Response {
    Json(json!({
        "status": "ok",
        "data": {
            "error_code": "INTERNAL_ERROR",
            "error_type": error_type.into()
        }
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_javascript_safe_identifier_alphabet() {
        assert!(is_safe_id("GB_demo-1"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("GB?redirect=true"));
        assert!(!is_safe_id("é"));
        assert_eq!(
            body_id(&json!({}), "id").unwrap_err(),
            "Invalid GoCardless identifier: undefined"
        );
        assert_eq!(
            body_id(&json!({ "id": "../" }), "id").unwrap_err(),
            "Invalid GoCardless identifier: ../"
        );
    }

    #[test]
    fn accepts_web_origins_and_the_electron_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", "https://actual.example/path".parse().unwrap());
        assert_eq!(redirect_host(&headers).unwrap(), "https://actual.example");
        headers.insert("origin", "app://actual".parse().unwrap());
        headers.insert("host", "127.0.0.1:5007".parse().unwrap());
        assert_eq!(redirect_host(&headers).unwrap(), "http://127.0.0.1:5007");
        headers.insert("origin", "file://local".parse().unwrap());
        assert!(redirect_host(&headers).is_err());
    }
}
