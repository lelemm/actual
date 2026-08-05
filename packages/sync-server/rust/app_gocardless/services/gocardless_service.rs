use std::{collections::HashMap, sync::Arc};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::{sync::Mutex, task::JoinHandle};
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
pub struct GoCardlessService(Arc<Mutex<HashMap<(Option<String>, Option<String>), GoCardlessApi>>>);

impl GoCardlessService {
    #[cfg(test)]
    pub(super) fn for_test(api: GoCardlessApi) -> Self {
        Self(Arc::new(Mutex::new(HashMap::from([(
            (Some("secret-id".into()), Some("secret-key".into())),
            api,
        )]))))
    }

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

    pub async fn get_institution(
        &self,
        state: &AppState,
        institution_id: &str,
    ) -> Result<Value, GoCardlessError> {
        self.client(state)
            .await?
            .get_institution_by_id(institution_id)
            .await
            .map_err(Into::into)
    }

    pub async fn get_requisition(
        &self,
        state: &AppState,
        requisition_id: &str,
    ) -> Result<Value, GoCardlessError> {
        self.client(state)
            .await?
            .get_requisition(requisition_id)
            .await
            .map_err(Into::into)
    }

    pub async fn get_detailed_account(
        &self,
        state: &AppState,
        account_id: &str,
    ) -> Result<Value, GoCardlessError> {
        let api = self.client(state).await?;
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
        Ok(Value::Object(account))
    }

    pub async fn get_account_metadata(
        &self,
        state: &AppState,
        account_id: &str,
    ) -> Result<Value, GoCardlessError> {
        self.client(state)
            .await?
            .get_account_metadata(account_id)
            .await
            .map_err(Into::into)
    }

    pub async fn get_balances(
        &self,
        state: &AppState,
        account_id: &str,
    ) -> Result<Value, GoCardlessError> {
        self.client(state)
            .await?
            .get_account_balances(account_id)
            .await
            .map_err(Into::into)
    }

    pub async fn get_account_transactions(
        &self,
        state: &AppState,
        institution_id: &str,
        account_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> Result<Value, GoCardlessError> {
        let response = self
            .client(state)
            .await?
            .get_account_transactions(account_id, start_date, end_date)
            .await
            .map_err(GoCardlessError::from)?;
        let mut response = response;
        response["transactions"]["booked"] = Value::Array(normalized_transactions(
            &response,
            "booked",
            institution_id,
            true,
        ));
        response["transactions"]["pending"] = Value::Array(normalized_transactions(
            &response,
            "pending",
            institution_id,
            false,
        ));
        Ok(response)
    }

    pub fn extend_accounts_about_institutions(
        accounts: &[Value],
        institutions: &[Value],
    ) -> Vec<Value> {
        accounts
            .iter()
            .map(|account| {
                let mut account = account.as_object().cloned().unwrap_or_default();
                let institution_id = account.get("institution_id").and_then(Value::as_str);
                let institution = institutions
                    .iter()
                    .find(|institution| {
                        institution.get("id").and_then(Value::as_str) == institution_id
                    })
                    .cloned()
                    .unwrap_or(Value::Null);
                account.insert("institution".into(), institution);
                Value::Object(account)
            })
            .collect()
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
            .map(js_number)
            .unwrap_or_else(|| json!(90));
        let history_days = if separate_history {
            json!(90)
        } else {
            institution
                .get("transaction_total_days")
                .map(js_number)
                .unwrap_or_else(|| json!(90))
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
                    json!(89),
                    json!(90),
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
        let requisition = self.get_linked_requisition(&api, requisition_id).await?;
        let account_ids = requisition
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut accounts = Vec::with_capacity(account_ids.len());
        let mut institution_ids: Vec<String> = Vec::new();
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
            if !institution_ids.contains(&institution_id) {
                institution_ids.push(institution_id.clone());
            }
            accounts.push((account, institution_id));
        }
        let mut institutions = Vec::with_capacity(institution_ids.len());
        let institution_requests = institution_ids
            .iter()
            .map(|institution_id| {
                let api = api.clone();
                let institution_id = institution_id.clone();
                tokio::spawn(async move {
                    api.get_institution_by_id(&institution_id)
                        .await
                        .map_err(GoCardlessError::from)
                })
            })
            .collect::<Vec<_>>();
        for request in institution_requests {
            institutions.push(service_task(request).await?);
        }
        let accounts = accounts
            .into_iter()
            .map(|(mut account, institution_id)| {
                let institution = institutions
                    .iter()
                    .find(|institution| {
                        institution.get("id").and_then(Value::as_str) == Some(&institution_id)
                    })
                    .cloned()
                    .unwrap_or(Value::Null);
                account.insert("institution".into(), institution);
                bank_factory::normalize_account(&institution_id, &account)
            })
            .collect();
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
        if include_balance {
            let api = self.client(state).await?;
            let requisition = self.get_linked_requisition(&api, requisition_id).await?;
            ensure_account_linked(&requisition, account_id, requisition_id)?;
            let institution_id = requisition
                .get("institution_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let transaction_request = {
                let service = self.clone();
                let state = state.clone();
                let requisition_id = requisition_id.to_owned();
                let account_id = account_id.to_owned();
                let start_date = start_date.map(str::to_owned);
                let end_date = end_date.map(str::to_owned);
                tokio::spawn(async move {
                    service
                        .get_normalized_transactions(
                            &state,
                            &requisition_id,
                            &account_id,
                            start_date.as_deref(),
                            end_date.as_deref(),
                        )
                        .await
                })
            };
            let balance_request = {
                let api = api.clone();
                let account_id = account_id.to_owned();
                tokio::spawn(async move {
                    api.get_account_balances(&account_id)
                        .await
                        .map_err(GoCardlessError::from)
                })
            };
            let ((_, transactions), balances) = tokio::try_join!(
                service_task(transaction_request),
                service_task(balance_request)
            )?;
            let balances = balances
                .get("balances")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let starting_balance = bank_factory::calculate_starting_balance(
                &institution_id,
                transactions["booked"]
                    .as_array()
                    .expect("array created in get_normalized_transactions"),
                &balances,
            );
            Ok(serde_json::json!({
                "balances": balances,
                "institutionId": institution_id,
                "startingBalance": starting_balance,
                "transactions": transactions
            }))
        } else {
            let (institution_id, transactions) = self
                .get_normalized_transactions(
                    state,
                    requisition_id,
                    account_id,
                    start_date,
                    end_date,
                )
                .await?;
            Ok(serde_json::json!({
                "institutionId": institution_id,
                "transactions": transactions
            }))
        }
    }

    async fn get_linked_requisition(
        &self,
        api: &GoCardlessApi,
        requisition_id: &str,
    ) -> Result<Value, GoCardlessError> {
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
        Ok(requisition)
    }

    async fn get_normalized_transactions(
        &self,
        state: &AppState,
        requisition_id: &str,
        account_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> Result<(String, Value), GoCardlessError> {
        let api = self.client(state).await?;
        let requisition = self.get_linked_requisition(&api, requisition_id).await?;
        ensure_account_linked(&requisition, account_id, requisition_id)?;
        let institution_id = requisition
            .get("institution_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let transactions = api
            .get_account_transactions(account_id, start_date, end_date)
            .await
            .map_err(GoCardlessError::from)?;
        let mut booked = normalized_transactions(&transactions, "booked", &institution_id, true);
        let mut pending = normalized_transactions(&transactions, "pending", &institution_id, false);
        bank_factory::sort_transactions(&institution_id, &mut booked);
        bank_factory::sort_transactions(&institution_id, &mut pending);
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
        bank_factory::sort_transactions(&institution_id, &mut all);
        Ok((
            institution_id,
            serde_json::json!({
                "booked": booked,
                "pending": pending,
                "all": all
            }),
        ))
    }

    async fn client(&self, state: &AppState) -> Result<GoCardlessApi, GoCardlessError> {
        let credentials = credentials(state).ok_or(GoCardlessError {
            kind: GoCardlessErrorKind::Generic,
            message: "GoCardless returned error",
            details: Value::Null,
        })?;
        let mut clients = self.0.lock().await;
        #[cfg(test)]
        let test_template = clients.values().next().cloned();
        let api = clients.entry(credentials.clone()).or_insert_with(|| {
            #[cfg(test)]
            if let Some(template) = test_template {
                return template.for_test_credentials(credentials.0.clone(), credentials.1.clone());
            }
            GoCardlessApi::new(
                state.http.clone(),
                credentials.0.clone(),
                credentials.1.clone(),
            )
        });
        if api.token().is_none_or(is_expired_jwt) {
            api.generate_token().await.map_err(GoCardlessError::from)?;
        }
        Ok(api.clone())
    }
}

async fn service_task<T>(
    task: JoinHandle<Result<T, GoCardlessError>>,
) -> Result<T, GoCardlessError> {
    task.await.map_err(|error| GoCardlessError {
        kind: GoCardlessErrorKind::Generic,
        message: "GoCardless returned error",
        details: Value::String(error.to_string()),
    })?
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

fn ensure_account_linked(
    requisition: &Value,
    account_id: &str,
    requisition_id: &str,
) -> Result<(), GoCardlessError> {
    if requisition
        .get("accounts")
        .and_then(Value::as_array)
        .is_some_and(|accounts| {
            accounts
                .iter()
                .any(|account| account.as_str() == Some(account_id))
        })
    {
        return Ok(());
    }
    Err(GoCardlessError {
        kind: GoCardlessErrorKind::AccountNotLinked,
        message: "Provided account id is not linked to given requisition",
        details: serde_json::json!({
            "accountId": account_id,
            "requisitionId": requisition_id
        }),
    })
}

fn js_number(value: &Value) -> Value {
    let parsed = match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                Some(0.0)
            } else if let Some((digits, radix)) = [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ]
            .into_iter()
            .find_map(|(prefix, radix)| value.strip_prefix(prefix).map(|digits| (digits, radix)))
            {
                if digits.is_empty() {
                    None
                } else {
                    num_bigint::BigUint::parse_bytes(digits.as_bytes(), radix)
                        .and_then(|number| number.to_str_radix(10).parse::<f64>().ok())
                }
            } else {
                value.parse::<f64>().ok()
            }
        }
        Value::Array(values) => return js_number(&Value::String(js_array_string(values))),
        _ => None,
    };
    parsed
        .filter(|value| value.is_finite())
        .map_or(Value::Null, |value| {
            if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
                json!(value as i64)
            } else {
                serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
            }
        })
}

fn js_array_string(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| match value {
            Value::Null => String::new(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            Value::String(value) => value.clone(),
            Value::Array(values) => js_array_string(values),
            Value::Object(_) => "[object Object]".to_owned(),
        })
        .collect::<Vec<_>>()
        .join(",")
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

    #[test]
    fn coerces_agreement_limits_like_javascript_number() {
        for (input, expected) in [
            (json!("  "), json!(0)),
            (json!("1.5"), json!(1.5)),
            (json!("1e2"), json!(100)),
            (json!("0x10"), json!(16)),
            (json!("0x24ded6a2c8489d3"), json!(166_049_801_551_776_220.0)),
            (
                json!("0x10000000000000000"),
                json!(18_446_744_073_709_552_000.0),
            ),
            (json!(""), json!(0)),
            (json!([]), json!(0)),
            (json!(["90"]), json!(90)),
            (json!([null]), json!(0)),
        ] {
            assert_eq!(js_number(&input), expected);
        }
        assert_eq!(js_number(&json!("not-a-number")), Value::Null);
        assert_eq!(js_number(&json!(["1", "2"])), Value::Null);
    }
}
