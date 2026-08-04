use std::{collections::HashMap, time::Duration};

use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const BASE_URL: &str = "https://bankaccountdata.gocardless.com/api/v2";

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access: String,
    pub refresh: String,
    pub access_expires: u64,
    pub refresh_expires: u64,
}

#[derive(Debug)]
pub struct GoCardlessApiError {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub data: Option<Value>,
}

impl std::fmt::Display for GoCardlessApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "GoCardless API error: {}", self.status)
    }
}

impl std::error::Error for GoCardlessApiError {}

#[derive(Clone)]
pub struct GoCardlessApi {
    http: reqwest::Client,
    base_url: Url,
    secret_id: Option<String>,
    secret_key: Option<String>,
    token: Option<String>,
}

impl GoCardlessApi {
    pub fn new(
        http: reqwest::Client,
        secret_id: Option<String>,
        secret_key: Option<String>,
    ) -> Self {
        Self {
            http,
            base_url: Url::parse(
                &std::env::var("GOCARDLESS_API_URL").unwrap_or_else(|_| BASE_URL.into()),
            )
            .expect("valid GoCardless base URL"),
            secret_id,
            secret_key,
            token: None,
        }
    }

    pub fn secret_id(&self) -> Option<&str> {
        self.secret_id.as_deref()
    }

    pub fn secret_key(&self) -> Option<&str> {
        self.secret_key.as_deref()
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    async fn request(
        &self,
        endpoint: &str,
        method: Method,
        body: Option<Map<String, Value>>,
    ) -> Result<Value, GoCardlessApiError> {
        let url = self
            .endpoint(endpoint)
            .map_err(|message| GoCardlessApiError {
                status: 0,
                headers: HashMap::new(),
                data: Some(Value::String(message)),
            })?;
        let mut request = self
            .http
            .request(method, url)
            .timeout(Duration::from_secs(20))
            .header("accept", "application/json")
            .header("content-type", "application/json");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(mut body) = body {
            body.retain(|_, value| !value.is_null());
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| GoCardlessApiError {
            status: 0,
            headers: HashMap::new(),
            data: Some(Value::String(error.to_string())),
        })?;
        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_owned()))
            })
            .collect();
        if !status.is_success() {
            let data = response.json().await.ok();
            return Err(GoCardlessApiError {
                status: status.as_u16(),
                headers,
                data,
            });
        }
        response.json().await.map_err(|error| GoCardlessApiError {
            status: status.as_u16(),
            headers,
            data: Some(Value::String(error.to_string())),
        })
    }

    fn endpoint(&self, endpoint: &str) -> Result<Url, String> {
        let url = Url::parse(&format!("{}{endpoint}", self.base_url))
            .map_err(|_| format!("Invalid GoCardless API endpoint: {endpoint}"))?;
        let allowed_path = format!("{}/", self.base_url.path().trim_end_matches('/'));
        if url.origin() != self.base_url.origin() || !url.path().starts_with(&allowed_path) {
            return Err(format!("Invalid GoCardless API endpoint: {endpoint}"));
        }
        Ok(url)
    }

    pub async fn generate_token(&mut self) -> Result<TokenResponse, GoCardlessApiError> {
        let value = self
            .request(
                "/token/new/",
                Method::POST,
                Some(object([
                    ("secret_id", option(self.secret_id.clone())),
                    ("secret_key", option(self.secret_key.clone())),
                ])),
            )
            .await?;
        let response = serde_json::from_value::<TokenResponse>(value).map_err(json_error)?;
        self.token = Some(response.access.clone());
        Ok(response)
    }

    pub async fn exchange_token(
        &mut self,
        refresh_token: &str,
    ) -> Result<TokenResponse, GoCardlessApiError> {
        let value = self
            .request(
                "/token/refresh/",
                Method::POST,
                Some(object([("refresh", json!(refresh_token))])),
            )
            .await?;
        let response = serde_json::from_value::<TokenResponse>(value).map_err(json_error)?;
        self.token = Some(response.access.clone());
        Ok(response)
    }

    pub async fn get_institutions(&self, country: &str) -> Result<Value, GoCardlessApiError> {
        self.request(
            &format!("/institutions/?country={country}"),
            Method::GET,
            None,
        )
        .await
    }

    pub async fn get_institution_by_id(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/institutions/{id}/"), Method::GET, None)
            .await
    }

    pub async fn create_agreement(
        &self,
        institution_id: &str,
        max_historical_days: u64,
        access_valid_for_days: u64,
    ) -> Result<Value, GoCardlessApiError> {
        self.request(
            "/agreements/enduser/",
            Method::POST,
            Some(object([
                ("institution_id", json!(institution_id)),
                ("max_historical_days", json!(max_historical_days)),
                ("access_valid_for_days", json!(access_valid_for_days)),
                (
                    "access_scope",
                    json!(["balances", "details", "transactions"]),
                ),
            ])),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_requisition(
        &self,
        redirect_url: &str,
        institution_id: &str,
        agreement: &str,
        user_language: &str,
        reference: Option<&str>,
        ssn: Option<&str>,
        redirect_immediate: bool,
        account_selection: bool,
    ) -> Result<Value, GoCardlessApiError> {
        self.request(
            "/requisitions/",
            Method::POST,
            Some(object([
                ("redirect", json!(redirect_url)),
                ("institution_id", json!(institution_id)),
                ("agreement", json!(agreement)),
                ("user_language", json!(user_language)),
                ("reference", option(reference)),
                ("ssn", option(ssn)),
                ("redirect_immediate", json!(redirect_immediate)),
                ("account_selection", json!(account_selection)),
            ])),
        )
        .await
    }

    pub async fn init_session(
        &self,
        redirect_url: &str,
        institution_id: &str,
        max_historical_days: u64,
        access_valid_for_days: u64,
        reference_id: Option<&str>,
        account_selection: bool,
    ) -> Result<Value, GoCardlessApiError> {
        let agreement = self
            .create_agreement(institution_id, max_historical_days, access_valid_for_days)
            .await?;
        let agreement = agreement
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| json_error_message("GoCardless agreement id missing"))?;
        self.create_requisition(
            redirect_url,
            institution_id,
            agreement,
            "en",
            reference_id,
            None,
            false,
            account_selection,
        )
        .await
    }

    pub async fn get_requisition(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/requisitions/{id}/"), Method::GET, None)
            .await
    }

    pub async fn delete_requisition(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/requisitions/{id}/"), Method::DELETE, None)
            .await
    }

    pub async fn get_account_metadata(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/accounts/{id}/"), Method::GET, None)
            .await
    }

    pub async fn get_account_details(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/accounts/{id}/details/"), Method::GET, None)
            .await
    }

    pub async fn get_account_balances(&self, id: &str) -> Result<Value, GoCardlessApiError> {
        self.request(&format!("/accounts/{id}/balances/"), Method::GET, None)
            .await
    }

    pub async fn get_account_transactions(
        &self,
        id: &str,
        date_from: Option<&str>,
        date_to: Option<&str>,
    ) -> Result<Value, GoCardlessApiError> {
        let mut url = self
            .endpoint(&format!("/accounts/{id}/transactions/"))
            .map_err(api_url_error)?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(date_from) = date_from {
                query.append_pair("date_from", date_from);
            }
            if let Some(date_to) = date_to {
                query.append_pair("date_to", date_to);
            }
        }
        let endpoint = &url.as_str()[self.base_url.as_str().len()..];
        self.request(endpoint, Method::GET, None).await
    }
}

fn object<const N: usize>(values: [(&str, Value); N]) -> Map<String, Value> {
    values
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

fn option<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |value| json!(value))
}

fn json_error(error: serde_json::Error) -> GoCardlessApiError {
    GoCardlessApiError {
        status: 0,
        headers: HashMap::new(),
        data: Some(Value::String(error.to_string())),
    }
}

fn api_url_error(message: String) -> GoCardlessApiError {
    GoCardlessApiError {
        status: 0,
        headers: HashMap::new(),
        data: Some(Value::String(message)),
    }
}

fn json_error_message(message: &str) -> GoCardlessApiError {
    GoCardlessApiError {
        status: 0,
        headers: HashMap::new(),
        data: Some(Value::String(message.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_requests_to_the_gocardless_v2_origin() {
        let api = GoCardlessApi::new(reqwest::Client::new(), None, None);
        assert_eq!(
            api.endpoint("/accounts/id/transactions/?date_from=2024-01-01")
                .unwrap()
                .as_str(),
            "https://bankaccountdata.gocardless.com/api/v2/accounts/id/transactions/?date_from=2024-01-01"
        );
        assert!(api.endpoint("/../admin").is_err());
    }
}
