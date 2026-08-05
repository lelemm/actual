use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;

pub async fn assert_url_allowed(target: &Url, allow_private_network: bool) -> Result<(), String> {
    if !matches!(target.scheme(), "http" | "https") {
        return Err(format!(
            "Blocked request to disallowed protocol: {}",
            target.scheme()
        ));
    }
    let hostname = target
        .host_str()
        .ok_or("Invalid URL")?
        .trim_start_matches('[')
        .trim_end_matches(']');
    if let Ok(address) = hostname.parse::<IpAddr>() {
        if is_blocked_ip(address, allow_private_network) {
            return Err(format!("Blocked request to private/local IP: {hostname}"));
        }
        return Ok(());
    }
    let port = target.port_or_known_default().ok_or("Invalid URL")?;
    let addresses = tokio::net::lookup_host((hostname, port))
        .await
        .map_err(|_| format!("Unable to resolve host: {hostname}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(format!("Unable to resolve host: {hostname}"));
    }
    if let Some(address) = addresses
        .into_iter()
        .map(|address| address.ip())
        .find(|address| is_blocked_ip(*address, allow_private_network))
    {
        return Err(format!(
            "Blocked request to host resolving to private/local IP: {hostname} ({address})"
        ));
    }
    Ok(())
}

pub(crate) fn is_blocked_ip(address: IpAddr, allow_private_network: bool) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_unspecified()
                || address.is_link_local()
                || address.is_multicast()
                || address == Ipv4Addr::BROADCAST
                || (!allow_private_network && (address.is_private() || address.is_loopback()))
        }
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(address), allow_private_network);
            }
            address.is_unspecified()
                || address.is_multicast()
                || is_ipv6_link_local(address)
                || (!allow_private_network
                    && (address.is_loopback() || is_ipv6_unique_local(address)))
        }
    }
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xffc0 == 0xfe80
}

fn is_ipv6_unique_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xfe00 == 0xfc00
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_network_opt_in_never_allows_metadata_addresses() {
        assert!(!is_blocked_ip("127.0.0.1".parse().unwrap(), true));
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap(), true));
        assert!(is_blocked_ip(
            "::ffff:169.254.169.254".parse().unwrap(),
            true
        ));
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap(), false));
    }

    #[tokio::test]
    async fn blocks_ipv4_mapped_ipv6_metadata_urls_before_dns() {
        let url = Url::parse("http://[::ffff:169.254.169.254]/latest/meta-data/").unwrap();
        assert!(
            assert_url_allowed(&url, true)
                .await
                .unwrap_err()
                .starts_with("Blocked request to private/local IP:")
        );
    }
}
