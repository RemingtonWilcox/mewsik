//! Client for the radio-browser.info public directory (volunteer-run mirror
//! cluster). Stations are identified by a permanent UUID even as their
//! stream hosts rotate, which is what makes self-healing possible.

use serde::{Deserialize, Serialize};

use super::network::{
    parse_public_http_url, send_public_get_following_redirects, MAX_PUBLIC_REDIRECTS,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RadioBrowserStation {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_resolved: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hls: Option<i32>,
    pub homepage: Option<String>,
    pub favicon: Option<String>,
    pub country: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub countrycode: Option<String>,
    pub language: Option<String>,
    pub tags: Option<String>,
    pub codec: Option<String>,
    pub bitrate: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub votes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clickcount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clicktrend: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lastcheckok: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lastchecktime_iso8601: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lastcheckoktime_iso8601: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_error: Option<i32>,
    pub stationuuid: String,
}

/// Public radio-browser mirrors, tried in order. The directory is a
/// volunteer-run cluster; any single server can be down.
const RADIO_BROWSER_SERVERS: [&str; 3] = [
    // The official aggregate hostname follows the currently advertised mirror
    // set. Keep named fallbacks because the service is volunteer-run and DNS or
    // one edge can disappear independently.
    "https://all.api.radio-browser.info",
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
];

/// GET from the radio-browser directory with mirror failover.
pub(crate) async fn radio_browser_get(path_and_query: &str) -> Option<reqwest::Response> {
    for server in RADIO_BROWSER_SERVERS {
        let url = parse_public_http_url(&format!("{}{}", server, path_and_query)).ok()?;
        match send_public_get_following_redirects(
            &url,
            reqwest::header::HeaderMap::new(),
            MAX_PUBLIC_REDIRECTS,
        )
        .await
        {
            Ok((response, _)) if response.status().is_success() => return Some(response),
            _ => continue,
        }
    }
    None
}

#[derive(Debug, Deserialize)]
struct RadioBrowserUuidStation {
    url: Option<String>,
    url_resolved: Option<String>,
}

/// Look up a station's *current* stream URLs from radio-browser by its
/// permanent UUID. Stream hosts rotate; the UUID is stable. Returns
/// candidates in preference order: url_resolved (direct stream) first,
/// then url (may be a playlist — the probe unwraps it).
pub(crate) async fn resolve_station_urls_by_uuid(uuid: &str) -> Vec<String> {
    let url = format!("/json/stations/byuuid/{}", urlencoding::encode(uuid));
    let Some(response) = radio_browser_get(&url).await else {
        return Vec::new();
    };
    let Ok(stations) = response.json::<Vec<RadioBrowserUuidStation>>().await else {
        return Vec::new();
    };
    let Some(station) = stations.into_iter().next() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    for value in [station.url_resolved, station.url] {
        if let Some(trimmed) = value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            if !candidates.contains(&trimmed) {
                candidates.push(trimmed);
            }
        }
    }
    candidates
}
