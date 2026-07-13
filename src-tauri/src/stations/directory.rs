//! Client for the radio-browser.info public directory (volunteer-run mirror
//! cluster). Stations are identified by a permanent UUID even as their
//! stream hosts rotate, which is what makes self-healing possible.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
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
    pub language: Option<String>,
    pub tags: Option<String>,
    pub codec: Option<String>,
    pub bitrate: Option<i32>,
    pub stationuuid: String,
}

/// Public radio-browser mirrors, tried in order. The directory is a
/// volunteer-run cluster; any single server can be down.
const RADIO_BROWSER_SERVERS: [&str; 3] = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
];

/// GET from the radio-browser directory with mirror failover.
pub(crate) async fn radio_browser_get(
    client: &reqwest::Client,
    path_and_query: &str,
) -> Option<reqwest::Response> {
    for server in RADIO_BROWSER_SERVERS {
        match client
            .get(format!("{}{}", server, path_and_query))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Some(response),
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
pub(crate) async fn resolve_station_urls_by_uuid(
    client: &reqwest::Client,
    uuid: &str,
) -> Vec<String> {
    let url = format!("/json/stations/byuuid/{}", urlencoding::encode(uuid));
    let Some(response) = radio_browser_get(client, &url).await else {
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
        if let Some(trimmed) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            if !candidates.contains(&trimmed) {
                candidates.push(trimmed);
            }
        }
    }
    candidates
}
