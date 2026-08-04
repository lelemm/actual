use jsonwebtoken::Algorithm;

use super::super::jwt::jwt_parts;

#[test]
fn builds_the_existing_enable_banking_header_and_claims() {
    let (header, claims) = jwt_parts("application-id", 100, 7200);
    assert_eq!(header.alg, Algorithm::RS256);
    assert_eq!(header.typ.as_deref(), Some("JWT"));
    assert_eq!(header.kid.as_deref(), Some("application-id"));
    assert_eq!(claims.iss, "enablebanking.com");
    assert_eq!(claims.aud, "api.enablebanking.com");
    assert_eq!(claims.iat, 100);
    assert_eq!(claims.exp, 7300);
}
