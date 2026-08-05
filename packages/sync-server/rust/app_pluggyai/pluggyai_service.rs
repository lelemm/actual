use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{StatusCode, Url};
use serde_json::{Value, json};

use crate::{app::AppState, services::secrets_service};

const CLIENT_ID: &str = "pluggyai_clientId";
const CLIENT_SECRET: &str = "pluggyai_clientSecret";
const ITEM_IDS: &str = "pluggyai_itemIds";
const PLUGGY_SDK_VERSION: &str = "0.89.0";
const GOT_VERSION: &str = "11.8.6";

#[derive(Debug)]
pub struct PluggyError {
    pub message: Option<Value>,
}

impl From<String> for PluggyError {
    fn from(message: String) -> Self {
        Self {
            message: Some(Value::String(message)),
        }
    }
}

impl From<&str> for PluggyError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[derive(Clone, Default)]
pub struct PluggyAiService {
    api_keys: Arc<Mutex<HashMap<String, String>>>,
}

impl PluggyAiService {
    pub fn get_credential_source(
        &self,
        state: &AppState,
        file_id: Option<&str>,
    ) -> Result<Option<&'static str>, String> {
        let connection = state.database.lock().map_err(|error| error.to_string())?;
        if file_id.is_some() && has_credentials(&connection, file_id)? {
            Ok(Some("per-budget-file"))
        } else if has_credentials(&connection, None)? {
            Ok(Some("global"))
        } else {
            Ok(None)
        }
    }

    pub fn get_item_ids(
        &self,
        state: &AppState,
        file_id: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let credential_file_id = self.credential_file_id(state, file_id)?;
        let connection = state.database.lock().map_err(|error| error.to_string())?;
        Ok(
            secrets_service::get(&connection, ITEM_IDS, credential_file_id)
                .map_err(|error| error.to_string())?
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }

    pub async fn get_accounts_by_item_id(
        &self,
        state: &AppState,
        item_id: &str,
        file_id: Option<&str>,
    ) -> Result<Value, PluggyError> {
        self.get(state, "accounts", &[("itemId", item_id)], file_id)
            .await
    }

    pub async fn get_account_by_id(
        &self,
        state: &AppState,
        account_id: &str,
        file_id: Option<&str>,
    ) -> Result<Value, PluggyError> {
        self.get(state, &format!("accounts/{account_id}"), &[], file_id)
            .await
    }

    pub async fn get_transactions_by_account_id(
        &self,
        state: &AppState,
        account_path_id: &str,
        account_query_id: Option<&str>,
        start_date: Option<&str>,
        file_id: Option<&str>,
    ) -> Result<Vec<Value>, PluggyError> {
        let account = self
            .get_account_by_id(state, account_path_id, file_id)
            .await?;
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
            if let Some(account_id) = account_query_id {
                query.push(("accountId", account_id));
            }
            let page = self.get(state, "v2/transactions", &query, file_id).await?;
            transactions.extend(
                page.get("results")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            after = page
                .get("next")
                .and_then(Value::as_str)
                .and_then(|next| next_cursor(&base_url().ok()?, next));
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

    fn credential_file_id<'a>(
        &self,
        state: &AppState,
        file_id: Option<&'a str>,
    ) -> Result<Option<&'a str>, String> {
        match self.get_credential_source(state, file_id)? {
            Some("per-budget-file") => Ok(file_id),
            Some(_) => Ok(None),
            None => Err("Pluggy credentials are not configured".into()),
        }
    }

    async fn get(
        &self,
        state: &AppState,
        endpoint: &str,
        query: &[(&str, &str)],
        file_id: Option<&str>,
    ) -> Result<Value, PluggyError> {
        let credential_file_id = self
            .credential_file_id(state, file_id)
            .map_err(PluggyError::from)?;
        let (client_id, client_secret) =
            credentials(state, credential_file_id).map_err(PluggyError::from)?;
        let api_key = self
            .api_key(state, credential_file_id, &client_id, &client_secret)
            .await?;
        let mut url = base_url()?
            .join(endpoint)
            .map_err(|error| error.to_string())?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        for attempt in 0..=2 {
            let response = match state
                .http
                .get(url.clone())
                .timeout(Duration::from_secs(30))
                .header("X-API-KEY", &api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("Accept-Encoding", "gzip, deflate, br")
                .header("User-Agent", user_agent())
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) if attempt < 2 && is_retryable_request_error(&error) => {
                    tokio::time::sleep(network_retry_delay(attempt)).await;
                    continue;
                }
                Err(error) => return Err(request_error(error).into()),
            };
            if response.status() == StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
                tokio::time::sleep(retry_after(response.headers(), attempt)).await;
                continue;
            }
            let status = response.status();
            let body = match response.text().await {
                Ok(body) => body,
                Err(error) if attempt < 2 && is_retryable_request_error(&error) => {
                    tokio::time::sleep(network_retry_delay(attempt)).await;
                    continue;
                }
                Err(error) => return Err(request_error(error).into()),
            };
            if !status.is_success() {
                return Err(provider_error(&body));
            }
            return serde_json::from_str(&body)
                .map_err(|error| json_error(error, &body, &url).into());
        }
        unreachable!()
    }

    async fn api_key(
        &self,
        state: &AppState,
        credential_file_id: Option<&str>,
        client_id: &str,
        client_secret: &str,
    ) -> Result<String, String> {
        let cache_key = format!(
            "{}\0{client_id}\0{client_secret}",
            credential_file_id.unwrap_or_default()
        );
        if let Some(api_key) = self
            .api_keys
            .lock()
            .map_err(|error| error.to_string())?
            .get(&cache_key)
            .filter(|api_key| !jwt_expired(api_key))
            .cloned()
        {
            return Ok(api_key);
        }
        let url = base_url()?
            .join("auth")
            .map_err(|error| error.to_string())?;
        let mut result = None;
        for attempt in 0..=2 {
            let response = match state
                .http
                .post(url.clone())
                .timeout(Duration::from_secs(30))
                .header("User-Agent", user_agent())
                .header("Accept", "application/json")
                .header("Accept-Encoding", "gzip, deflate, br")
                .json(&json!({
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "nonExpiring": false
                }))
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) if attempt < 2 && is_retryable_request_error(&error) => {
                    tokio::time::sleep(network_retry_delay(attempt)).await;
                    continue;
                }
                Err(error) => return Err(request_error(error)),
            };
            let status = response.status();
            let delay = retry_after(response.headers(), attempt);
            let body = match response.text().await {
                Ok(body) => body,
                Err(error) if attempt < 2 && is_retryable_request_error(&error) => {
                    tokio::time::sleep(network_retry_delay(attempt)).await;
                    continue;
                }
                Err(error) => return Err(request_error(error)),
            };
            if status == StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
                tokio::time::sleep(delay).await;
            } else {
                result = Some((status, body));
                break;
            }
        }
        let (status, body) = result.expect("three attempts always produce a result");
        if !status.is_success() {
            return Err(status_error(status));
        }
        let api_key = serde_json::from_str::<Value>(&body)
            .map_err(|error| json_error(error, &body, &url))?
            .get("apiKey")
            .and_then(Value::as_str)
            .ok_or_else(|| "Pluggy auth response did not contain apiKey".to_owned())?
            .to_owned();
        self.api_keys
            .lock()
            .map_err(|error| error.to_string())?
            .insert(cache_key, api_key.clone());
        Ok(api_key)
    }
}

fn has_credentials(
    connection: &rusqlite::Connection,
    file_id: Option<&str>,
) -> Result<bool, String> {
    Ok([CLIENT_ID, CLIENT_SECRET, ITEM_IDS]
        .into_iter()
        .map(|name| secrets_service::get(connection, name, file_id))
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .all(|value| value.is_some_and(|value| !value.is_empty())))
}

fn credentials(state: &AppState, file_id: Option<&str>) -> Result<(String, String), String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let client_id = secrets_service::get(&connection, CLIENT_ID, file_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Missing authorization for API communication".to_owned())?;
    let client_secret = secrets_service::get(&connection, CLIENT_SECRET, file_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Missing authorization for API communication".to_owned())?;
    Ok((client_id, client_secret))
}

fn base_url() -> Result<Url, String> {
    let mut url = Url::parse(
        &std::env::var("PLUGGY_API_URL").unwrap_or_else(|_| "https://api.pluggy.ai".into()),
    )
    .map_err(|error| error.to_string())?;
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn jwt_expired(token: &str) -> bool {
    let Some(payload) = token.split('.').nth(1) else {
        return true;
    };
    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
        return true;
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&payload) else {
        return true;
    };
    payload.get("exp").and_then(Value::as_i64).unwrap_or(0) <= chrono::Utc::now().timestamp()
}

fn next_cursor(base: &Url, next: &str) -> Option<String> {
    base.join(next)
        .ok()?
        .query_pairs()
        .find_map(|(key, value)| (key == "after").then(|| value.into_owned()))
}

fn provider_error(body: &str) -> PluggyError {
    match serde_json::from_str::<Value>(body) {
        Ok(body) => PluggyError {
            message: body.get("message").cloned(),
        },
        Err(_) => body.to_owned().into(),
    }
}

fn status_error(status: StatusCode) -> String {
    format!(
        "Response code {} ({})",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Unknown")
    )
}

fn json_error(error: serde_json::Error, body: &str, url: &Url) -> String {
    format!("{} in \"{url}\"", v8_json_error(&error, body))
}

fn v8_json_error(error: &serde_json::Error, body: &str) -> String {
    let byte_position = body
        .split_inclusive('\n')
        .take(error.line().saturating_sub(1))
        .map(str::len)
        .sum::<usize>()
        .saturating_add(error.column().saturating_sub(1))
        .min(body.len());
    if error.is_eof() {
        return v8_eof_error(body);
    }
    let (position, line, column) = v8_location(body, byte_position);
    let diagnostic = error.to_string();
    if diagnostic.starts_with("key must be a string") {
        return format!(
            "Expected property name or '}}' in JSON at position {position} (line {} column {})",
            line, column
        );
    }
    for (serde, v8) in [
        ("expected `:`", "Expected ':' after property name"),
        (
            "expected `,` or `}`",
            "Expected ',' or '}' after property value",
        ),
        (
            "expected `,` or `]`",
            "Expected ',' or ']' after array element",
        ),
    ] {
        if diagnostic.starts_with(serde) {
            return format!(
                "{v8} in JSON at position {position} (line {} column {})",
                line, column
            );
        }
    }
    if diagnostic.starts_with("trailing characters") {
        if body
            .get(byte_position..)
            .and_then(|value| value.chars().next())
            .is_some_and(|value| value.is_ascii_digit())
        {
            return format!(
                "Unexpected number in JSON at position {position} (line {} column {})",
                line, column
            );
        }
        return format!(
            "Unexpected non-whitespace character after JSON at position {position} (line {} column {})",
            line, column
        );
    }
    if diagnostic.starts_with("invalid number") {
        return format!(
            "Unexpected number in JSON at position {position} (line {} column {})",
            line, column
        );
    }
    let token = body
        .get(byte_position..)
        .and_then(|rest| rest.chars().next())
        .unwrap_or('?');
    format!("Unexpected token '{token}', \"{body}\" is not valid JSON")
}

#[derive(Clone, Copy)]
enum JsonContainer {
    Object(ObjectExpectation),
    Array(ArrayExpectation),
}

#[derive(Clone, Copy)]
enum ObjectExpectation {
    KeyOrEnd,
    Colon,
    Value,
    CommaOrEnd,
}

#[derive(Clone, Copy)]
enum ArrayExpectation {
    ValueOrEnd,
    CommaOrEnd,
}

fn v8_eof_error(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut stack = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            byte if byte.is_ascii_whitespace() => index += 1,
            b'"' => {
                index += 1;
                let mut is_closed = false;
                while index < bytes.len() {
                    match bytes[index] {
                        b'"' => {
                            index += 1;
                            is_closed = true;
                            break;
                        }
                        b'\\' => {
                            index += 1;
                            if index == bytes.len() {
                                return "Unexpected end of JSON input".into();
                            }
                            if bytes[index] == b'u' {
                                let digits_end = index.saturating_add(5);
                                if digits_end > bytes.len() {
                                    return eof_message("Bad Unicode escape", body);
                                }
                                index = digits_end;
                            } else {
                                index += 1;
                            }
                        }
                        _ => index += 1,
                    }
                }
                if !is_closed {
                    return eof_message("Unterminated string", body);
                }
                match stack.last_mut() {
                    Some(JsonContainer::Object(expectation))
                        if matches!(expectation, ObjectExpectation::KeyOrEnd) =>
                    {
                        *expectation = ObjectExpectation::Colon;
                    }
                    _ => value_complete(&mut stack),
                }
            }
            b'{' => {
                value_complete(&mut stack);
                stack.push(JsonContainer::Object(ObjectExpectation::KeyOrEnd));
                index += 1;
            }
            b'[' => {
                value_complete(&mut stack);
                stack.push(JsonContainer::Array(ArrayExpectation::ValueOrEnd));
                index += 1;
            }
            b'}' | b']' => {
                stack.pop();
                index += 1;
            }
            b':' => {
                if let Some(JsonContainer::Object(expectation)) = stack.last_mut() {
                    *expectation = ObjectExpectation::Value;
                }
                index += 1;
            }
            b',' => {
                match stack.last_mut() {
                    Some(JsonContainer::Object(expectation)) => {
                        *expectation = ObjectExpectation::KeyOrEnd;
                    }
                    Some(JsonContainer::Array(expectation)) => {
                        *expectation = ArrayExpectation::ValueOrEnd;
                    }
                    None => {}
                }
                index += 1;
            }
            _ => {
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !matches!(bytes[index], b',' | b']' | b'}')
                {
                    index += 1;
                }
                if is_incomplete_literal(&body[start..index]) {
                    return "Unexpected end of JSON input".into();
                }
                value_complete(&mut stack);
            }
        }
    }

    let expected = match stack.last() {
        Some(JsonContainer::Object(ObjectExpectation::KeyOrEnd)) => "Expected property name or '}'",
        Some(JsonContainer::Object(ObjectExpectation::Colon)) => "Expected ':' after property name",
        Some(JsonContainer::Object(ObjectExpectation::CommaOrEnd)) => {
            "Expected ',' or '}' after property value"
        }
        Some(JsonContainer::Array(ArrayExpectation::CommaOrEnd)) => {
            "Expected ',' or ']' after array element"
        }
        _ => return "Unexpected end of JSON input".into(),
    };
    eof_message(expected, body)
}

fn is_incomplete_literal(value: &str) -> bool {
    ["true", "false", "null"]
        .into_iter()
        .any(|literal| literal.starts_with(value) && literal != value)
}

fn value_complete(stack: &mut [JsonContainer]) {
    match stack.last_mut() {
        Some(JsonContainer::Object(expectation))
            if matches!(expectation, ObjectExpectation::Value) =>
        {
            *expectation = ObjectExpectation::CommaOrEnd;
        }
        Some(JsonContainer::Array(expectation))
            if matches!(expectation, ArrayExpectation::ValueOrEnd) =>
        {
            *expectation = ArrayExpectation::CommaOrEnd;
        }
        _ => {}
    }
}

fn eof_message(expected: &str, body: &str) -> String {
    let (position, line, column) = v8_location(body, body.len());
    format!("{expected} in JSON at position {position} (line {line} column {column})")
}

fn v8_location(body: &str, byte_position: usize) -> (usize, usize, usize) {
    let mut position = 0;
    let mut line = 1;
    let mut column = 1;
    let mut previous_was_carriage_return = false;
    for character in body[..byte_position].chars() {
        let width = character.len_utf16();
        position += width;
        match character {
            '\r' => {
                line += 1;
                column = 1;
                previous_was_carriage_return = true;
            }
            '\n' => {
                if !previous_was_carriage_return {
                    line += 1;
                }
                column = 1;
                previous_was_carriage_return = false;
            }
            _ => {
                column += width;
                previous_was_carriage_return = false;
            }
        }
    }
    (position, line, column)
}

fn user_agent() -> String {
    let node_version = std::env::var("ACTUAL_NODE_VERSION")
        .unwrap_or_else(|_| env!("ACTUAL_ORACLE_NODE_VERSION").into());
    format!("PluggyNode/{PLUGGY_SDK_VERSION} node.js/{node_version} Got/{GOT_VERSION}")
}

fn is_retryable_request_error(error: &reqwest::Error) -> bool {
    error.is_connect()
        || error.is_body()
        || error.is_request()
        || error.is_timeout()
        || (error.is_decode() && is_connection_reset(error))
}

fn is_connection_reset(error: &reqwest::Error) -> bool {
    let mut source = std::error::Error::source(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
        {
            return true;
        }
        let message = error.to_string().to_ascii_lowercase();
        if message.contains("connection reset")
            || message.contains("connection closed before message completed")
            || message.contains("end of file before message length reached")
        {
            return true;
        }
        source = error.source();
    }
    false
}

fn network_retry_delay(attempt: usize) -> Duration {
    Duration::from_secs(1 << attempt)
}

fn retry_after(headers: &reqwest::header::HeaderMap, attempt: usize) -> Duration {
    let Some(value) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
    else {
        return network_retry_delay(attempt);
    };
    if let Ok(seconds) = value.parse::<f64>()
        && seconds > 0.0
    {
        return Duration::from_secs_f64(seconds);
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .and_then(|date| {
            (date.with_timezone(&chrono::Utc) - chrono::Utc::now())
                .to_std()
                .ok()
        })
        .unwrap_or_else(|| network_retry_delay(attempt))
}

fn request_error(error: reqwest::Error) -> String {
    if is_connection_reset(&error) {
        "socket hang up".into()
    } else if error.is_timeout() {
        "Timeout awaiting 'request' for 30000ms".into()
    } else if error.is_decode() {
        let message = deepest_error_message(&error);
        if message.contains("BufError") || message.to_ascii_lowercase().contains("unexpected eof") {
            "unexpected end of file".into()
        } else {
            message
        }
    } else if is_dns_error(&error) {
        got_dns_error(error.url()).unwrap_or_else(|| deepest_error_message(&error))
    } else if let Some(kind) = io_error_kind(&error) {
        got_io_error(kind, error.url()).unwrap_or_else(|| deepest_error_message(&error))
    } else {
        deepest_error_message(&error)
    }
}

fn is_dns_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        let message = error.to_string().to_ascii_lowercase();
        if [
            "dns error",
            "failed to lookup address information",
            "name or service not known",
            "temporary failure in name resolution",
        ]
        .iter()
        .any(|needle| message.contains(needle))
        {
            return true;
        }
        current = error.source();
    }
    false
}

fn io_error_kind(error: &reqwest::Error) -> Option<std::io::ErrorKind> {
    let mut source = std::error::Error::source(error);
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            return Some(error.kind());
        }
        source = error.source();
    }
    None
}

fn got_io_error(kind: std::io::ErrorKind, url: Option<&Url>) -> Option<String> {
    if kind != std::io::ErrorKind::ConnectionRefused {
        return None;
    }
    let url = url?;
    Some(format!(
        "connect ECONNREFUSED {}:{}",
        url.host_str()?,
        url.port_or_known_default()?
    ))
}

fn got_dns_error(url: Option<&Url>) -> Option<String> {
    Some(format!("getaddrinfo ENOTFOUND {}", url?.host_str()?))
}

fn deepest_error_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(error) = source {
        message = error.to_string();
        source = error.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pagination_cursor_and_jwt_expiration() {
        assert_eq!(
            next_cursor(
                &Url::parse("https://api.pluggy.ai/").unwrap(),
                "/v2/transactions?after=next-token"
            ),
            Some("next-token".into())
        );
        assert!(jwt_expired("not-a-token"));
    }

    #[test]
    fn maps_json_errors_and_retry_fallbacks_like_the_sdk() {
        for (body, expected) in [
            (
                "{",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            ("[", "Unexpected end of JSON input"),
            (
                "\"foo{",
                "Unterminated string in JSON at position 5 (line 1 column 6)",
            ),
            (
                "{\"x\":\"{",
                "Unterminated string in JSON at position 7 (line 1 column 8)",
            ),
            ("{\"x\":\"foo\\", "Unexpected end of JSON input"),
            (
                "{\"x\":\"\\u",
                "Bad Unicode escape in JSON at position 8 (line 1 column 9)",
            ),
            (
                "{\"x\":\"\\u12",
                "Bad Unicode escape in JSON at position 10 (line 1 column 11)",
            ),
            ("{\"x\":tru", "Unexpected end of JSON input"),
            ("{\"x\":fals", "Unexpected end of JSON input"),
            ("{\"x\":nul", "Unexpected end of JSON input"),
            (
                "{\n",
                "Expected property name or '}' in JSON at position 2 (line 2 column 1)",
            ),
            (
                "{\"😀\":1",
                "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
            ),
            (
                "{\n\"😀\":1",
                "Expected ',' or '}' after property value in JSON at position 8 (line 2 column 7)",
            ),
            (
                "[{",
                "Expected property name or '}' in JSON at position 2 (line 1 column 3)",
            ),
            (
                "{\"x\": {",
                "Expected property name or '}' in JSON at position 7 (line 1 column 8)",
            ),
            (
                "{\"x\":{\"y\":1",
                "Expected ',' or '}' after property value in JSON at position 11 (line 1 column 12)",
            ),
            (
                "{\"x\":}",
                "Unexpected token '}', \"{\"x\":}\" is not valid JSON",
            ),
            (
                "nullx",
                "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)",
            ),
            (
                "{x:1}",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"x\" 1}",
                "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
            ),
            (
                "{\"x\":1 \"y\":2}",
                "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
            ),
            (
                "[1 2]",
                "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
            ),
            (
                "01",
                "Unexpected number in JSON at position 1 (line 1 column 2)",
            ),
        ] {
            let error = serde_json::from_str::<Value>(body).unwrap_err();
            assert_eq!(v8_json_error(&error, body), expected);
        }
        assert_eq!(
            retry_after(&reqwest::header::HeaderMap::new(), 0),
            Duration::from_secs(1)
        );
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "invalid".parse().unwrap());
        assert_eq!(retry_after(&headers, 1), Duration::from_secs(2));
        headers.insert(reqwest::header::RETRY_AFTER, "0".parse().unwrap());
        assert_eq!(retry_after(&headers, 0), Duration::from_secs(1));
        let refused = Url::parse("http://127.0.0.1:12345/accounts").unwrap();
        assert_eq!(
            got_io_error(std::io::ErrorKind::ConnectionRefused, Some(&refused)),
            Some("connect ECONNREFUSED 127.0.0.1:12345".into())
        );
        let dns = std::io::Error::other("dns error: failed to lookup address information");
        assert!(is_dns_error(&dns));
        let unresolved = Url::parse("https://missing.invalid/accounts").unwrap();
        assert_eq!(
            got_dns_error(Some(&unresolved)),
            Some("getaddrinfo ENOTFOUND missing.invalid".into())
        );
    }
}
