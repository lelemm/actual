use reqwest::Client;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::app_simplefin::core::{self, TransactionsError};

#[wasm_bindgen]
pub async fn simplefin_status(token: String) -> Result<String, JsValue> {
    serialize(core::status_data(nonempty(&token)))
}

#[wasm_bindgen]
pub async fn simplefin_accounts(token: String, access_key: String) -> Result<String, JsValue> {
    let result = core::accounts(&client()?, nonempty(&token), nonempty(&access_key)).await;
    serialize(json!({
        "data": result.data,
        "accessKey": result.access_key.unwrap_or_default(),
    }))
}

#[wasm_bindgen]
pub async fn simplefin_transactions(
    access_key: String,
    request_json: String,
) -> Result<String, JsValue> {
    let request = serde_json::from_str::<Value>(&request_json).map_err(js_error)?;
    let data = match core::transactions(&client()?, nonempty(&access_key), &request).await {
        Ok(data) => data,
        Err(TransactionsError::InvalidToken) => core::invalid_token_data(),
        Err(TransactionsError::ServerDown) => core::server_down_data(),
        Err(TransactionsError::ProviderInternal(reason)) => {
            core::provider_internal_error_data(&reason)
        }
        Err(TransactionsError::Internal) => {
            return Err(JsValue::from_str(
                "SimpleFIN response could not be normalized",
            ));
        }
    };
    serialize(data)
}

fn client() -> Result<Client, JsValue> {
    Ok(Client::new())
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn serialize(value: Value) -> Result<String, JsValue> {
    serde_json::to_string(&value).map_err(js_error)
}

fn js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}
