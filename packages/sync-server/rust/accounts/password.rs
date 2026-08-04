use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
    password_hash::{SaltString, rand_core::OsRng},
};

const MEMORY_COST: u32 = 47_104;
const TIME_COST: u32 = 1;
const PARALLELISM: u32 = 1;

fn argon2() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(MEMORY_COST, TIME_COST, PARALLELISM, None).unwrap(),
    )
}

pub fn is_valid_password(password: Option<&str>) -> bool {
    password.is_some_and(|password| !password.is_empty())
}

pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    argon2()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    if hash.starts_with("$argon2") {
        return PasswordHash::new(hash)
            .and_then(|hash| argon2().verify_password(password.as_bytes(), &hash))
            .is_ok();
    }
    bcrypt::verify(password, hash).unwrap_or(false)
}

pub fn is_legacy_hash(hash: &str) -> bool {
    !hash.starts_with("$argon2")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_with_the_existing_argon2id_parameters() {
        let hash = hash_password("contract-password").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=47104,t=1,p=1$"));
        assert!(verify_password("contract-password", &hash));
        assert!(!verify_password("wrong-password", &hash));
    }
}
