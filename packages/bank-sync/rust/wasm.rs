use reqwest::Client;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::app_akahu;
use crate::app_pluggyai;
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

#[wasm_bindgen]
pub async fn akahu_status(user_token: String, app_token: String) -> Result<String, JsValue> {
    serialize(app_akahu::core::status_data(
        nonempty(&user_token),
        nonempty(&app_token),
    ))
}

#[wasm_bindgen]
pub async fn akahu_accounts(user_token: String, app_token: String) -> Result<String, JsValue> {
    serialize(
        app_akahu::core::accounts(&client()?, nonempty(&user_token), nonempty(&app_token)).await,
    )
}

#[wasm_bindgen]
pub async fn akahu_transactions(
    user_token: String,
    app_token: String,
    request_json: String,
) -> Result<String, JsValue> {
    let request = serde_json::from_str::<Value>(&request_json).map_err(js_error)?;
    serialize(
        app_akahu::core::transactions(
            &client()?,
            nonempty(&user_token),
            nonempty(&app_token),
            &request,
        )
        .await
        .unwrap_or_else(|error| json!({ "error": error })),
    )
}

#[wasm_bindgen]
pub async fn pluggyai_status(
    client_id: String,
    client_secret: String,
    item_ids: String,
) -> Result<String, JsValue> {
    serialize(app_pluggyai::core::status_data(
        nonempty(&client_id),
        nonempty(&client_secret),
        nonempty(&item_ids),
    ))
}

#[wasm_bindgen]
pub async fn pluggyai_accounts(
    client_id: String,
    client_secret: String,
    item_ids: String,
) -> Result<String, JsValue> {
    serialize(
        app_pluggyai::core::accounts(
            &client()?,
            nonempty(&client_id),
            nonempty(&client_secret),
            nonempty(&item_ids),
        )
        .await,
    )
}

#[wasm_bindgen]
pub async fn pluggyai_transactions(
    client_id: String,
    client_secret: String,
    item_ids: String,
    request_json: String,
) -> Result<String, JsValue> {
    let request = serde_json::from_str::<Value>(&request_json).map_err(js_error)?;
    serialize(
        app_pluggyai::core::transactions(
            &client()?,
            nonempty(&client_id),
            nonempty(&client_secret),
            nonempty(&item_ids),
            &request,
        )
        .await,
    )
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
