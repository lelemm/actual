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
    ) -> Result<Value, String> {
        self.get(state, "accounts", &[("itemId", item_id)], file_id)
            .await
    }

    pub async fn get_account_by_id(
        &self,
        state: &AppState,
        account_id: &str,
        file_id: Option<&str>,
    ) -> Result<Value, String> {
        self.get(state, &format!("accounts/{account_id}"), &[], file_id)
            .await
    }

    pub async fn get_transactions_by_account_id(
        &self,
        state: &AppState,
        account_id: &str,
        start_date: Option<&str>,
        file_id: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        let account = self.get_account_by_id(state, account_id, file_id).await?;
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
            query.push(("accountId", account_id));
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
    ) -> Result<Value, String> {
        let credential_file_id = self.credential_file_id(state, file_id)?;
        let (client_id, client_secret) = credentials(state, credential_file_id)?;
        let api_key = self.api_key(state, &client_id, &client_secret).await?;
        let mut url = base_url()?
            .join(endpoint)
            .map_err(|error| error.to_string())?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        for attempt in 0..=2 {
            let response = state
                .http
                .get(url.clone())
                .timeout(Duration::from_secs(30))
                .header("X-API-KEY", &api_key)
                .header("Content-Type", "application/json")
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if response.status() == StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
                continue;
            }
            let status = response.status();
            let body = response.text().await.map_err(|error| error.to_string())?;
            if !status.is_success() {
                return Err(provider_error(&body));
            }
            return serde_json::from_str(&body).map_err(|error| error.to_string());
        }
        unreachable!()
    }

    async fn api_key(
        &self,
        state: &AppState,
        client_id: &str,
        client_secret: &str,
    ) -> Result<String, String> {
        let cache_key = format!("{client_id}\0{client_secret}");
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
            let response = state
                .http
                .post(url.clone())
                .timeout(Duration::from_secs(30))
                .json(&json!({
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "nonExpiring": false
                }))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status();
            let body = response.text().await.map_err(|error| error.to_string())?;
            if status != StatusCode::TOO_MANY_REQUESTS || attempt == 2 {
                result = Some((status, body));
                break;
            }
        }
        let (status, body) = result.expect("three attempts always produce a result");
        if !status.is_success() {
            return Err(provider_error(&body));
        }
        let api_key = serde_json::from_str::<Value>(&body)
            .map_err(|error| error.to_string())?
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

fn provider_error(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.to_owned())
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
}
