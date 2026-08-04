use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct Claims {
    pub(super) iss: &'static str,
    pub(super) aud: &'static str,
    pub(super) iat: u64,
    pub(super) exp: u64,
}

pub(super) fn jwt_parts(application_id: &str, issued_at: u64, expires_in: u64) -> (Header, Claims) {
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".into());
    header.kid = Some(application_id.into());
    let claims = Claims {
        iss: "enablebanking.com",
        aud: "api.enablebanking.com",
        iat: issued_at,
        exp: issued_at + expires_in,
    };
    (header, claims)
}

pub fn get_jwt(application_id: &str, secret_key: &str, expires_in: u64) -> Result<String, String> {
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let (header, claims) = jwt_parts(application_id, issued_at, expires_in);
    encode(
        &header,
        &claims,
        &EncodingKey::from_rsa_pem(secret_key.as_bytes()).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
