use axum::{
    Json,
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::{
    account_db::Session,
    app::AppState,
    util::validate_user::{SessionError, validate_session},
};

pub struct ValidatedSession(pub Session);

impl FromRequestParts<AppState> for ValidatedSession {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match validate_session(&state.database, &parts.headers, None) {
            Ok(session) => Ok(Self(session)),
            Err(SessionError::TokenNotFound) => Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "status": "error",
                    "reason": "unauthorized",
                    "details": "token-not-found"
                })),
            )
                .into_response()),
            Err(SessionError::TokenExpired) => Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "status": "error", "reason": "token-expired" })),
            )
                .into_response()),
            Err(SessionError::Database(_)) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "reason": "internal-error" })),
            )
                .into_response()),
        }
    }
}
