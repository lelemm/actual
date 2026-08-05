use std::fmt::{Display, Formatter};

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct EnableBankingError {
    pub error_type: String,
    pub error_code: String,
    pub message: String,
}

impl EnableBankingError {
    pub fn new(
        error_type: impl Into<String>,
        error_code: impl Into<String>,
        message: Option<String>,
    ) -> Self {
        let error_type = error_type.into();
        let error_code = error_code.into();
        let message =
            message.unwrap_or_else(|| format!("Enable Banking error: {error_type} - {error_code}"));
        Self {
            error_type,
            error_code,
            message,
        }
    }
}

impl Display for EnableBankingError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for EnableBankingError {}

pub fn handle_enable_banking_error(status_code: u16, body: &Value) -> EnableBankingError {
    let body_string = if body.is_null() {
        "\"unknown\"".into()
    } else {
        body.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| body.to_string())
    };
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(&body_string)
        .to_owned();
    let error_type = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");

    let error_code = match status_code {
        401 | 403 => "INVALID_ACCESS_TOKEN",
        429 => "RATE_LIMIT_EXCEEDED",
        404 => "NOT_FOUND",
        400..=499
            if matches!(
                error_type.to_lowercase().as_str(),
                "closed_session" | "expired_session"
            ) || message.to_lowercase().contains("session")
                || message.to_lowercase().contains("expired") =>
        {
            "INVALID_ACCESS_TOKEN"
        }
        400..=499 => "INVALID_INPUT",
        _ => "INTERNAL_ERROR",
    };
    EnableBankingError::new(message.clone(), error_code, Some(message))
}
