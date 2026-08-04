use std::sync::Arc;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    app::AppState,
    app_gocardless::{
        bank_factory,
        errors::{GoCardlessError, GoCardlessErrorKind},
    },
    services::secrets_service,
};

use super::gocardless_api::GoCardlessApi;

#[derive(Clone, Default)]
pub struct GoCardlessService(Arc<Mutex<Option<CachedClient>>>);

struct CachedClient {
    secret_id: Option<String>,
    secret_key: Option<String>,
    api: GoCardlessApi,
}

impl GoCardlessService {
    pub fn is_configured(&self, state: &AppState) -> bool {
        credentials(state).is_some_and(|(id, key)| {
            id.is_some_and(|id| !id.is_empty()) && key.is_some_and(|key| !key.is_empty())
        })
    }

    pub async fn get_institutions(
        &self,
        state: &AppState,
        country: &str,
    ) -> Result<Value, GoCardlessError> {
        self.client(state)
            .await?
            .get_institutions(country)
            .await
            .map_err(Into::into)
    }

    pub async fn create_requisition(
        &self,
        state: &AppState,
        institution_id: &str,
        host: &str,
    ) -> Result<(String, String), GoCardlessError> {
        let api = self.client(state).await?;
        let institution = api
            .get_institution_by_id(institution_id)
            .await
            .map_err(GoCardlessError::from)?;
        let features = institution
            .get("supported_features")
            .and_then(Value::as_array);
        let account_selection = has_feature(features, "account_selection");
        let separate_history = has_feature(features, "separate_continuous_history_consent");
        let access_days = institution
            .get("max_access_valid_for_days")
            .and_then(number)
            .unwrap_or(90);
        let history_days = if separate_history {
            90
        } else {
            institution
                .get("transaction_total_days")
                .and_then(number)
                .unwrap_or(90)
        };
        let redirect_url = format!("{host}/gocardless/link");
        let reference = Uuid::new_v4().to_string();
        let response = match api
            .init_session(
                &redirect_url,
                institution_id,
                history_days,
                access_days,
                Some(&reference),
                account_selection,
            )
            .await
        {
            Ok(response) => response,
            Err(_) => api
                .init_session(
                    &redirect_url,
                    institution_id,
                    89,
                    90,
                    Some(&reference),
                    account_selection,
                )
                .await
                .map_err(GoCardlessError::from)?,
        };
        let link = response
            .get("link")
            .and_then(Value::as_str)
            .ok_or(GoCardlessError {
                kind: GoCardlessErrorKind::Generic,
                message: "GoCardless returned error",
                details: response.clone(),
            })?;
        let requisition_id = response
            .get("id")
            .and_then(Value::as_str)
            .ok_or(GoCardlessError {
                kind: GoCardlessErrorKind::Generic,
                message: "GoCardless returned error",
                details: response.clone(),
            })?;
        Ok((link.into(), requisition_id.into()))
    }

    pub async fn delete_requisition(
        &self,
        state: &AppState,
        requisition_id: &str,
    ) -> Result<Value, GoCardlessError> {
        let api = self.client(state).await?;
        api.get_requisition(requisition_id)
            .await
            .map_err(GoCardlessError::from)?;
        api.delete_requisition(requisition_id)
            .await
            .map_err(Into::into)
    }

    pub async fn get_requisition_with_accounts(
        &self,
        state: &AppState,
        requisition_id: &str,
    ) -> Result<(Value, Vec<Value>), GoCardlessError> {
        let api = self.client(state).await?;
        let requisition = api
            .get_requisition(requisition_id)
            .await
            .map_err(GoCardlessError::from)?;
        if requisition.get("status").and_then(Value::as_str) != Some("LN") {
            return Err(GoCardlessError {
                kind: GoCardlessErrorKind::RequisitionNotLinked,
                message: "Requisition not linked yet",
                details: serde_json::json!({
                    "requisitionStatus": requisition.get("status").cloned()
                }),
            });
        }
        let account_ids = requisition
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut accounts = Vec::with_capacity(account_ids.len());
        for account_id in account_ids.iter().filter_map(Value::as_str) {
            let (details, metadata) = tokio::try_join!(
                api.get_account_details(account_id),
                api.get_account_metadata(account_id)
            )
            .map_err(GoCardlessError::from)?;
            let mut account = details
                .get("account")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(metadata) = metadata.as_object() {
                for (key, value) in metadata.iter().filter(|(_, value)| truthy(value)) {
                    account.insert(key.clone(), value.clone());
                }
            }
            let institution_id = account
                .get("institution_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let institution = api
                .get_institution_by_id(&institution_id)
                .await
                .map_err(GoCardlessError::from)?;
            account.insert("institution".into(), institution);
            accounts.push(bank_factory::normalize_account(&institution_id, &account));
        }
        Ok((requisition, accounts))
    }

    pub async fn get_transactions(
        &self,
        state: &AppState,
        requisition_id: &str,
        account_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
        include_balance: bool,
    ) -> Result<Value, GoCardlessError> {
        let api = self.client(state).await?;
        let requisition = api
            .get_requisition(requisition_id)
            .await
            .map_err(GoCardlessError::from)?;
        if requisition.get("status").and_then(Value::as_str) != Some("LN") {
            return Err(GoCardlessError {
                kind: GoCardlessErrorKind::RequisitionNotLinked,
                message: "Requisition not linked yet",
                details: serde_json::json!({
                    "requisitionStatus": requisition.get("status").cloned()
                }),
            });
        }
        let account_is_linked = requisition
            .get("accounts")
            .and_then(Value::as_array)
            .is_some_and(|accounts| {
                accounts
                    .iter()
                    .any(|account| account.as_str() == Some(account_id))
            });
        if !account_is_linked {
            return Err(GoCardlessError {
                kind: GoCardlessErrorKind::AccountNotLinked,
                message: "Provided account id is not linked to given requisition",
                details: serde_json::json!({
                    "accountId": account_id,
                    "requisitionId": requisition_id
                }),
            });
        }
        let institution_id = requisition
            .get("institution_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (transactions, balances) = if include_balance {
            let (transactions, balances) = tokio::try_join!(
                api.get_account_transactions(account_id, start_date, end_date),
                api.get_account_balances(account_id)
            )
            .map_err(GoCardlessError::from)?;
            (transactions, Some(balances))
        } else {
            (
                api.get_account_transactions(account_id, start_date, end_date)
                    .await
                    .map_err(GoCardlessError::from)?,
                None,
            )
        };
        let mut booked = normalized_transactions(&transactions, "booked", institution_id, true);
        let mut pending = normalized_transactions(&transactions, "pending", institution_id, false);
        bank_factory::sort_transactions(institution_id, &mut booked);
        bank_factory::sort_transactions(institution_id, &mut pending);
        let mut all = booked
            .iter()
            .cloned()
            .map(|mut transaction| {
                transaction["booked"] = Value::Bool(true);
                transaction
            })
            .chain(pending.iter().cloned().map(|mut transaction| {
                transaction["booked"] = Value::Bool(false);
                transaction
            }))
            .collect::<Vec<_>>();
        bank_factory::sort_transactions(institution_id, &mut all);
        let transactions = serde_json::json!({
            "booked": booked,
            "pending": pending,
            "all": all
        });
        if let Some(balances) = balances {
            let balances = balances
                .get("balances")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let starting_balance = bank_factory::calculate_starting_balance(
                institution_id,
                transactions["booked"]
                    .as_array()
                    .expect("array created above"),
                &balances,
            );
            Ok(serde_json::json!({
                "balances": balances,
                "institutionId": institution_id,
                "startingBalance": starting_balance,
                "transactions": transactions
            }))
        } else {
            Ok(serde_json::json!({
                "institutionId": institution_id,
                "transactions": transactions
            }))
        }
    }

    async fn client(&self, state: &AppState) -> Result<GoCardlessApi, GoCardlessError> {
        let (secret_id, secret_key) = credentials(state).ok_or(GoCardlessError {
            kind: GoCardlessErrorKind::Generic,
            message: "GoCardless returned error",
            details: Value::Null,
        })?;
        let mut cached = self.0.lock().await;
        if cached
            .as_ref()
            .is_none_or(|cached| cached.secret_id != secret_id || cached.secret_key != secret_key)
        {
            *cached = Some(CachedClient {
                api: GoCardlessApi::new(state.http.clone(), secret_id.clone(), secret_key.clone()),
                secret_id,
                secret_key,
            });
        }
        let cached = cached.as_mut().expect("client initialized above");
        if cached.api.token().is_none_or(is_expired_jwt) {
            cached
                .api
                .generate_token()
                .await
                .map_err(GoCardlessError::from)?;
        }
        Ok(cached.api.clone())
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn normalized_transactions(
    response: &Value,
    kind: &str,
    institution_id: &str,
    booked: bool,
) -> Vec<Value> {
    response
        .get("transactions")
        .and_then(|transactions| transactions.get(kind))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|transaction| {
            bank_factory::normalize_transaction(institution_id, transaction, booked)
        })
        .collect()
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn has_feature(features: Option<&Vec<Value>>, expected: &str) -> bool {
    features.is_some_and(|features| {
        features
            .iter()
            .any(|feature| feature.as_str() == Some(expected))
    })
}

fn credentials(state: &AppState) -> Option<(Option<String>, Option<String>)> {
    let connection = state.database.lock().ok()?;
    Some((
        secrets_service::get(&connection, "gocardless_secretId", None).ok()?,
        secrets_service::get(&connection, "gocardless_secretKey", None).ok()?,
    ))
}

fn is_expired_jwt(token: &str) -> bool {
    let Some(payload) = token.split('.').nth(1) else {
        return true;
    };
    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
        return true;
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&payload) else {
        return true;
    };
    let Some(expires_at) = payload.get("exp").and_then(Value::as_u64) else {
        return true;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now >= expires_at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_malformed_and_expired_tokens_as_expired() {
        assert!(is_expired_jwt("bad"));
        let expired = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#)
        );
        assert!(is_expired_jwt(&expired));
        let future = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(br#"{"exp":4102444800}"#)
        );
        assert!(!is_expired_jwt(&future));
    }
}
