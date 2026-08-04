use serde_json::{Value, json};

use super::services::gocardless_api::GoCardlessApiError;

#[derive(Debug)]
pub struct GoCardlessError {
    pub kind: GoCardlessErrorKind,
    pub message: &'static str,
    pub details: Value,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GoCardlessErrorKind {
    Generic,
    Client,
    EndUserAgreementExpired,
    RateLimit,
    RequisitionNotLinked,
    AccountNotLinked,
}

impl From<GoCardlessApiError> for GoCardlessError {
    fn from(error: GoCardlessApiError) -> Self {
        let is_eua_expired = error.status == 401 && is_eua_expired(&error);
        let message = match error.status {
            400 => "Invalid provided parameters",
            401 if is_eua_expired => "End User Agreement (EUA) has expired",
            401 => "Token is invalid or expired",
            403 => "IP address access denied",
            404 => "Resource not found",
            409 => "Resource was suspended due to numerous errors that occurred while accessing it",
            429 => "Daily request limit set by the Institution has been exceeded",
            500 => "Request to Institution returned an error",
            503 => "Institution service unavailable",
            _ => "GoCardless returned error",
        };
        let kind = match error.status {
            401 if is_eua_expired => GoCardlessErrorKind::EndUserAgreementExpired,
            429 => GoCardlessErrorKind::RateLimit,
            400 | 401 | 403 | 404 | 409 | 500 | 503 => GoCardlessErrorKind::Client,
            _ => GoCardlessErrorKind::Generic,
        };
        Self {
            kind,
            message,
            details: json!({
                "response": {
                    "status": error.status,
                    "headers": error.headers,
                    "data": error.data,
                }
            }),
        }
    }
}

impl std::fmt::Display for GoCardlessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for GoCardlessError {}

fn is_eua_expired(error: &GoCardlessApiError) -> bool {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("summary"))
        .and_then(Value::as_str)
        .is_some_and(|summary| {
            let summary = summary.to_ascii_lowercase();
            summary.contains("end user agreement") && summary.contains("expired")
        })
}
