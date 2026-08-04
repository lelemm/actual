use std::{
    net::{IpAddr, SocketAddr},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::HeaderMap;

use crate::{
    account_db::{self, AccountError, Session, TOKEN_EXPIRATION_NEVER},
    db::Database,
};

pub enum SessionError {
    TokenNotFound,
    TokenExpired,
    Database(AccountError),
}

pub fn validate_session(
    database: &Database,
    headers: &HeaderMap,
    body_token: Option<&str>,
) -> Result<Session, SessionError> {
    let token = body_token.or_else(|| {
        headers
            .get("x-actual-token")
            .and_then(|value| value.to_str().ok())
    });
    let Some(token) = token else {
        return Err(SessionError::TokenNotFound);
    };
    let session = account_db::get_session(database, token)
        .map_err(SessionError::Database)?
        .ok_or(SessionError::TokenNotFound)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    if session.expires_at != TOKEN_EXPIRATION_NEVER && session.expires_at <= now {
        return Err(SessionError::TokenExpired);
    }
    Ok(session)
}

pub fn validate_auth_header(peer: SocketAddr, trusted: &[String]) -> Result<bool, String> {
    let peer = normalize_ip(peer.ip());
    trusted
        .iter()
        .map(|range| contains(range, peer))
        .try_fold(false, |matched, contains| {
            contains.map(|contains| matched || contains)
        })
}

pub fn client_ip(
    peer: SocketAddr,
    headers: &HeaderMap,
    trusted: &[String],
) -> Result<IpAddr, String> {
    let mut addresses = vec![normalize_ip(peer.ip())];
    if let Some(forwarded) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
    {
        for address in forwarded.split(',').rev() {
            addresses.push(normalize_ip(
                address
                    .trim()
                    .parse()
                    .map_err(|_| "Invalid X-Forwarded-For address".to_owned())?,
            ));
        }
    }
    for index in 0..addresses.len().saturating_sub(1) {
        if !trusted_address(addresses[index], trusted)? {
            addresses.truncate(index + 1);
            break;
        }
    }
    Ok(*addresses.last().expect("peer address is always present"))
}

fn trusted_address(address: IpAddr, trusted: &[String]) -> Result<bool, String> {
    trusted
        .iter()
        .map(|range| contains(range, address))
        .try_fold(false, |matched, contains| {
            contains.map(|contains| matched || contains)
        })
}

fn contains(range: &str, address: IpAddr) -> Result<bool, String> {
    let (network, prefix) = range
        .split_once('/')
        .ok_or_else(|| format!("Invalid CIDR: {range}"))?;
    let network = normalize_ip(
        network
            .parse()
            .map_err(|_| format!("Invalid CIDR: {range}"))?,
    );
    let prefix: u32 = prefix
        .parse()
        .map_err(|_| format!("Invalid CIDR: {range}"))?;

    match (network, address) {
        (IpAddr::V4(network), IpAddr::V4(address)) if prefix <= 32 => {
            let shift = 32 - prefix;
            Ok((u32::from(network) >> shift) == (u32::from(address) >> shift))
        }
        (IpAddr::V6(network), IpAddr::V6(address)) if prefix <= 128 => {
            let shift = 128 - prefix;
            Ok((u128::from(network) >> shift) == (u128::from(address) >> shift))
        }
        (IpAddr::V4(_), IpAddr::V6(_)) | (IpAddr::V6(_), IpAddr::V4(_)) => Ok(false),
        _ => Err(format!("Invalid CIDR: {range}")),
    }
}

fn normalize_ip(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        address => address,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ipv4_ipv6_and_mapped_peers() {
        let trusted = vec!["127.0.0.0/8".into(), "fc00::/7".into()];
        assert!(validate_auth_header("127.0.0.1:80".parse().unwrap(), &trusted).unwrap());
        assert!(validate_auth_header("[fc00::1]:80".parse().unwrap(), &trusted).unwrap());
        assert!(validate_auth_header("[::ffff:127.0.0.1]:80".parse().unwrap(), &trusted).unwrap());
        assert!(!validate_auth_header("192.0.2.1:80".parse().unwrap(), &trusted).unwrap());
        assert!(validate_auth_header("127.0.0.1:80".parse().unwrap(), &["bad".into()]).is_err());
    }

    #[test]
    fn resolves_the_leftmost_address_reachable_through_trusted_proxies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "198.51.100.10, 192.168.1.2".parse().unwrap(),
        );
        assert_eq!(
            client_ip(
                "10.0.0.2:80".parse().unwrap(),
                &headers,
                &["10.0.0.0/8".into(), "192.168.0.0/16".into()]
            )
            .unwrap(),
            "198.51.100.10".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            client_ip(
                "203.0.113.2:80".parse().unwrap(),
                &headers,
                &["10.0.0.0/8".into()]
            )
            .unwrap(),
            "203.0.113.2".parse::<IpAddr>().unwrap()
        );
    }
}
