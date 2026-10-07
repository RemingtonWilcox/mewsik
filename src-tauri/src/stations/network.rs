//! Network boundary for radio URLs.
//!
//! Station URLs are untrusted data. Every request resolves its hostname up
//! front, rejects non-public answers, disables proxies and automatic
//! redirects, then pins reqwest to the checked addresses. Redirect and
//! playlist hops must therefore come back through this boundary themselves.

use reqwest::header::{HeaderMap, LOCATION};
use reqwest::{redirect::Policy, Url};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

const STATION_NETWORK_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const MAX_STATION_URL_BYTES: usize = 4 * 1024;
pub(crate) const MAX_PUBLIC_REDIRECTS: usize = 5;

fn ipv4_in_cidr(ip: Ipv4Addr, network: Ipv4Addr, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(network) & mask
}

fn ipv6_in_cidr(ip: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    u128::from(ip) & mask == u128::from(network) & mask
}

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            // IANA special-purpose, private, loopback, link-local,
            // documentation, benchmarking, multicast and reserved ranges.
            const BLOCKED: [(Ipv4Addr, u32); 14] = [
                (Ipv4Addr::new(0, 0, 0, 0), 8),
                (Ipv4Addr::new(10, 0, 0, 0), 8),
                (Ipv4Addr::new(100, 64, 0, 0), 10),
                (Ipv4Addr::new(127, 0, 0, 0), 8),
                (Ipv4Addr::new(169, 254, 0, 0), 16),
                (Ipv4Addr::new(172, 16, 0, 0), 12),
                (Ipv4Addr::new(192, 0, 0, 0), 24),
                (Ipv4Addr::new(192, 0, 2, 0), 24),
                (Ipv4Addr::new(192, 88, 99, 0), 24),
                (Ipv4Addr::new(192, 168, 0, 0), 16),
                (Ipv4Addr::new(198, 18, 0, 0), 15),
                (Ipv4Addr::new(198, 51, 100, 0), 24),
                (Ipv4Addr::new(203, 0, 113, 0), 24),
                (Ipv4Addr::new(224, 0, 0, 0), 3),
            ];

            !BLOCKED
                .iter()
                .any(|(network, prefix)| ipv4_in_cidr(ip, *network, *prefix))
        }
        IpAddr::V6(ip) => {
            // IPv4-compatible/mapped addresses inherit their IPv4 safety.
            let octets = ip.octets();
            if octets[..12] == [0; 12] {
                return is_public_ip(IpAddr::V4(Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                )));
            }
            if octets[..10] == [0; 10] && octets[10..12] == [0xff, 0xff] {
                return is_public_ip(IpAddr::V4(Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                )));
            }

            // Only global-unicast space is eligible. Explicit exclusions
            // cover special ranges within it, including documentation,
            // benchmarking, Teredo/ORCHID and transition mechanisms.
            ipv6_in_cidr(ip, "2000::".parse().expect("valid IPv6 constant"), 3)
                && !ipv6_in_cidr(ip, "2001::".parse().expect("valid IPv6 constant"), 32)
                && !ipv6_in_cidr(ip, "2001:2::".parse().expect("valid IPv6 constant"), 48)
                && !ipv6_in_cidr(ip, "2001:10::".parse().expect("valid IPv6 constant"), 28)
                && !ipv6_in_cidr(ip, "2001:20::".parse().expect("valid IPv6 constant"), 28)
                && !ipv6_in_cidr(ip, "2001:db8::".parse().expect("valid IPv6 constant"), 32)
                && !ipv6_in_cidr(ip, "2002::".parse().expect("valid IPv6 constant"), 16)
                && !ipv6_in_cidr(ip, "3fff::".parse().expect("valid IPv6 constant"), 20)
        }
    }
}

fn literal_host_ip(url: &Url) -> Option<IpAddr> {
    url.host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

/// Parse the parts of an HTTP URL that can be checked without DNS. Literal
/// IPs are classified here so they fail before any client is constructed.
pub(crate) fn parse_public_http_url(value: &str) -> Result<Url, String> {
    if value.len() > MAX_STATION_URL_BYTES {
        return Err(format!(
            "Station URL is too long (maximum {MAX_STATION_URL_BYTES} bytes)"
        ));
    }
    let url = Url::parse(value).map_err(|_| "Station URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Station URL must use http or https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Station URL must not contain credentials".to_string());
    }
    if url.port() == Some(0) {
        return Err("Station URL port must be non-zero".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Station URL must contain a host".to_string())?;
    if let Some(ip) = literal_host_ip(&url) {
        if !is_public_ip(ip) {
            return Err("Station URL points to a non-public address".to_string());
        }
    } else {
        let normalized = host.trim_end_matches('.').to_ascii_lowercase();
        if normalized == "localhost" || normalized.ends_with(".localhost") {
            return Err("Station URL points to localhost".to_string());
        }
    }

    Ok(url)
}

pub(crate) async fn validate_public_http_url(value: &str) -> Result<String, String> {
    let url = parse_public_http_url(value)?;
    resolve_public_addrs(&url).await?;
    Ok(url.to_string())
}

async fn resolve_public_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Station URL must contain a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Station URL must contain a valid port".to_string())?;

    let addrs = match literal_host_ip(url) {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => tokio::time::timeout(
            STATION_NETWORK_TIMEOUT,
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "Station hostname lookup timed out".to_string())?
        .map_err(|_| "Station hostname could not be resolved".to_string())?
        .collect(),
    };

    validate_resolved_addrs(addrs)
}

fn resolve_public_addrs_blocking(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Station URL must contain a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Station URL must contain a valid port".to_string())?;

    let addrs = match literal_host_ip(url) {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => (host, port)
            .to_socket_addrs()
            .map_err(|_| "Station hostname could not be resolved".to_string())?
            .collect(),
    };

    validate_resolved_addrs(addrs)
}

fn validate_resolved_addrs(mut addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    addrs.sort_unstable();
    addrs.dedup();
    if addrs.is_empty() {
        return Err("Station hostname did not resolve to an address".to_string());
    }
    if addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        // Reject mixed public/private answers too. Otherwise reqwest could
        // select the unsafe address after the application approved the host.
        return Err("Station hostname resolved to a non-public address".to_string());
    }
    Ok(addrs)
}

fn pin_async_client(url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Station URL must contain a host".to_string())?;
    reqwest::Client::builder()
        .timeout(STATION_NETWORK_TIMEOUT)
        .connect_timeout(STATION_NETWORK_TIMEOUT)
        .user_agent(concat!("mewsik/", env!("CARGO_PKG_VERSION")))
        .redirect(Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|err| format!("Failed to build station client: {err}"))
}

/// Perform exactly one public GET. Automatic redirect following is disabled;
/// callers must parse and revalidate each redirect target before the next GET.
pub(crate) async fn send_public_get(
    url: &Url,
    headers: HeaderMap,
) -> Result<reqwest::Response, String> {
    let url = parse_public_http_url(url.as_str())?;
    let addrs = resolve_public_addrs(&url).await?;
    pin_async_client(&url, &addrs)?
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|err| format!("Station request failed: {err}"))
}

fn followable_redirect_target(
    base_url: &Url,
    response: &reqwest::Response,
) -> Result<Option<Url>, String> {
    if !is_followable_redirect_status(response.status()) {
        return Ok(None);
    }
    let location = response
        .headers()
        .get(LOCATION)
        .ok_or_else(|| "Station redirect is missing a Location header".to_string())?
        .to_str()
        .map_err(|_| "Station redirect Location is invalid".to_string())?;
    Ok(Some(parse_public_redirect_target(base_url, location)?))
}

fn is_followable_redirect_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn parse_public_redirect_target(base_url: &Url, location: &str) -> Result<Url, String> {
    let target = Url::parse(location)
        .or_else(|_| base_url.join(location))
        .map_err(|_| "Station redirect target is invalid".to_string())?;
    parse_public_http_url(target.as_str())
}

/// Follow a bounded redirect chain. Each hop goes back through
/// `send_public_get`, so its hostname and resolved addresses are rechecked and
/// pinned before any bytes are sent.
pub(crate) async fn send_public_get_following_redirects(
    initial_url: &Url,
    headers: HeaderMap,
    max_redirects: usize,
) -> Result<(reqwest::Response, Url), String> {
    let mut current_url = parse_public_http_url(initial_url.as_str())?;
    let mut redirects = 0usize;
    loop {
        let response = send_public_get(&current_url, headers.clone()).await?;
        let Some(next_url) = followable_redirect_target(&current_url, &response)? else {
            return Ok((response, current_url));
        };
        if redirects >= max_redirects {
            return Err("Station redirect limit exceeded".to_string());
        }
        redirects += 1;
        current_url = next_url;
    }
}

/// Build the client used by the actual radio downloader. DNS is resolved and
/// pinned again here so a hostname cannot change between probe and playback.
fn build_blocking_public_client(url: &Url) -> Result<reqwest::blocking::Client, String> {
    let addrs = resolve_public_addrs_blocking(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "Station URL must contain a host".to_string())?;

    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("mewsik/", env!("CARGO_PKG_VERSION")))
        .redirect(Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|err| format!("Failed to build station streaming client: {err}"))
}

/// Open the actual live-radio response, re-resolving and pinning every
/// redirect hop. This avoids a separate content probe for ordinary direct
/// stream URLs while preserving the same SSRF boundary in playback.
pub(crate) fn open_blocking_public_stream(
    initial_url: &str,
    headers: &HashMap<String, String>,
) -> Result<reqwest::blocking::Response, String> {
    let mut current_url = parse_public_http_url(initial_url)?;
    let mut redirects = 0usize;
    loop {
        let client = build_blocking_public_client(&current_url)?;
        let mut request = client
            .get(current_url.clone())
            .header("User-Agent", concat!("mewsik/", env!("CARGO_PKG_VERSION")))
            .header("Icy-MetaData", "0");
        for (key, value) in headers {
            request = request.header(key, value);
        }
        let response = request
            .send()
            .map_err(|err| format!("Failed to open station stream: {err}"))?;
        let next_url = if is_followable_redirect_status(response.status()) {
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| "Station redirect is missing a Location header".to_string())?
                .to_str()
                .map_err(|_| "Station redirect Location is invalid".to_string())?;
            Some(parse_public_redirect_target(&current_url, location)?)
        } else {
            None
        };

        let Some(next_url) = next_url else {
            return response
                .error_for_status()
                .map_err(|err| format!("Failed to open station stream: {err}"));
        };
        if redirects >= MAX_PUBLIC_REDIRECTS {
            return Err("Station redirect limit exceeded".to_string());
        }
        redirects += 1;
        current_url = next_url;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_public_ipv4_and_blocks_special_ipv4_ranges() {
        for ip in ["1.1.1.1", "8.8.8.8", "93.184.216.34"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} should be public");
        }

        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} should be blocked");
        }
    }

    #[test]
    fn permits_public_ipv6_and_blocks_special_ipv6_ranges() {
        for ip in ["2001:4860:4860::8888", "2606:4700:4700::1111"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} should be public");
        }

        for ip in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:10::1",
            "2001:20::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} should be blocked");
        }
    }

    #[test]
    fn url_shape_allows_radio_ports_but_rejects_unsafe_forms() {
        assert!(parse_public_http_url("http://1.1.1.1:8000/live").is_ok());
        assert!(parse_public_http_url("https://example.com/stream?token=abc").is_ok());

        for url in [
            "file:///etc/passwd",
            "ftp://example.com/stream",
            "http://user:pass@example.com/stream",
            "http://localhost/stream",
            "http://radio.localhost./stream",
            "http://127.0.0.1/stream",
            "http://[::1]/stream",
            "http://1.1.1.1:0/stream",
        ] {
            assert!(
                parse_public_http_url(url).is_err(),
                "{url} should be rejected"
            );
        }

        let oversized = format!("https://example.com/{}", "a".repeat(MAX_STATION_URL_BYTES));
        assert!(parse_public_http_url(&oversized).is_err());
    }

    #[tokio::test]
    async fn literal_resolution_is_checked_without_external_network() {
        let public = parse_public_http_url("http://1.1.1.1:8000/live").unwrap();
        assert_eq!(
            resolve_public_addrs(&public).await.unwrap(),
            vec!["1.1.1.1:8000".parse().unwrap()]
        );

        // Reaching the resolver through an already-parsed URL still enforces
        // the address policy; no socket is opened by this test.
        let private = Url::parse("http://169.254.169.254/latest/meta-data").unwrap();
        assert!(resolve_public_addrs(&private).await.is_err());
    }

    #[test]
    fn mixed_dns_answers_are_rejected() {
        let answers = vec![
            "93.184.216.34:80".parse().unwrap(),
            "127.0.0.1:80".parse().unwrap(),
        ];
        assert!(validate_resolved_addrs(answers).is_err());
    }

    #[test]
    fn redirect_targets_are_parsed_and_private_hops_are_rejected_offline() {
        let base = Url::parse("https://radio.example/api/search").unwrap();
        assert_eq!(
            parse_public_redirect_target(&base, "/v2/search")
                .unwrap()
                .as_str(),
            "https://radio.example/v2/search"
        );
        assert!(parse_public_redirect_target(&base, "http://127.0.0.1/admin").is_err());
        assert!(parse_public_redirect_target(&base, "http://[::1]/admin").is_err());
    }

    #[test]
    fn directory_redirect_statuses_are_explicitly_bounded_to_get_redirects() {
        for status in [301, 302, 303, 307, 308] {
            assert!(is_followable_redirect_status(
                reqwest::StatusCode::from_u16(status).unwrap()
            ));
        }
        for status in [200, 300, 304, 305, 306, 400] {
            assert!(!is_followable_redirect_status(
                reqwest::StatusCode::from_u16(status).unwrap()
            ));
        }
    }
}
