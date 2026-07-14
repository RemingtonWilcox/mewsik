//! Station health checking and self-healing. Saved stream URLs rot (hosts
//! and tokens rotate); favorites are probed concurrently, playlist URLs are
//! unwrapped to direct streams, and dead URLs are re-resolved through the
//! station's permanent radio-browser UUID before being declared unhealthy.

use super::directory::resolve_station_urls_by_uuid;
use super::network::MAX_STATION_URL_BYTES;
use super::probe::probe_station_stream;
use crate::db::models::Station;
use crate::db::{queries, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

const STATION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const STATION_RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_STATION_VERIFY_URLS: usize = 100;
const MAX_CONCURRENT_STATION_PROBES: usize = 8;
static FAVORITE_VERIFY_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationHealthResult {
    pub station_id: Option<String>,
    pub url: String,
    pub status: String,
    pub last_checked_at: Option<String>,
    #[serde(default)]
    pub repaired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StationVerifyTarget {
    pub station_id: Option<String>,
    pub url: String,
}

fn station_health_status(fail_count: i32) -> &'static str {
    match fail_count {
        0 => "ok",
        1..=2 => "stale",
        _ => "dead",
    }
}

pub(crate) fn build_station_health_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(STATION_PROBE_TIMEOUT)
        .connect_timeout(STATION_PROBE_TIMEOUT)
        .user_agent("mewsik/0.1.0")
        // Probe and directory requests handle redirects manually so every
        // hop can be resolved, classified and DNS-pinned before it is sent.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build station health client: {}", e))
}

/// Self-heal a station whose saved URL stopped working: re-resolve current
/// URLs by UUID, probe each (unwrapping playlists), and persist the first
/// one that actually streams audio. Returns the playable URL on success.
pub(crate) async fn try_heal_station(
    db: &DbPool,
    client: &reqwest::Client,
    station: &Station,
) -> Option<String> {
    let uuid = station.radio_browser_id.as_deref()?;
    for candidate in resolve_station_urls_by_uuid(uuid).await {
        let Some(playable_url) = probe_station_stream(client, &candidate).await else {
            continue;
        };
        if playable_url == station.url {
            // The first attempt may have failed transiently. A fresh UUID
            // lookup that proves the same URL works still recovers the
            // station; it simply is not counted as a URL repair.
            let _ = queries::update_station_health(db, &station.id, 0, &queries::now());
            return Some(playable_url);
        }
        queries::update_station_url(db, &station.id, &playable_url).ok()?;
        let _ = queries::update_station_health(db, &station.id, 0, &queries::now());
        log::info!(
            "Healed station '{}': stale URL replaced via radio-browser uuid",
            station.name
        );
        return Some(playable_url);
    }
    None
}

async fn probe_station_targets(
    client: &reqwest::Client,
    targets: Vec<StationVerifyTarget>,
) -> Result<Vec<(StationVerifyTarget, Option<String>)>, String> {
    let mut probes = JoinSet::new();
    let mut remaining = targets.into_iter();
    for target in remaining.by_ref().take(MAX_CONCURRENT_STATION_PROBES) {
        let client = client.clone();
        probes.spawn(async move {
            let playable_url = probe_station_stream(&client, &target.url).await;
            (target, playable_url)
        });
    }

    let mut results = Vec::new();
    while let Some(result) = probes.join_next().await {
        results.push(result.map_err(|err| format!("Station verification task failed: {}", err))?);
        if let Some(target) = remaining.next() {
            let client = client.clone();
            probes.spawn(async move {
                let playable_url = probe_station_stream(&client, &target.url).await;
                (target, playable_url)
            });
        }
    }

    Ok(results)
}

fn prepare_verify_targets(urls: Vec<String>) -> Result<Vec<StationVerifyTarget>, String> {
    if urls.len() > MAX_STATION_VERIFY_URLS {
        return Err(format!(
            "Too many station URLs: the maximum is {MAX_STATION_VERIFY_URLS}"
        ));
    }

    let mut deduped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for url in urls {
        if url.len() > MAX_STATION_URL_BYTES {
            return Err(format!(
                "Station URL is too long (maximum {MAX_STATION_URL_BYTES} bytes)"
            ));
        }
        let trimmed = url.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        deduped.push(StationVerifyTarget {
            station_id: None,
            url: trimmed.to_string(),
        });
    }
    Ok(deduped)
}

pub(crate) async fn verify_station_urls_inner(
    urls: Vec<String>,
) -> Result<Vec<StationHealthResult>, String> {
    let deduped = prepare_verify_targets(urls)?;

    if deduped.is_empty() {
        return Ok(Vec::new());
    }

    let client = build_station_health_client()?;
    let verified = probe_station_targets(&client, deduped).await?;
    let checked_at = queries::now();

    Ok(verified
        .into_iter()
        .map(|(target, playable_url)| StationHealthResult {
            station_id: target.station_id,
            url: target.url,
            status: if playable_url.is_some() { "ok" } else { "dead" }.to_string(),
            last_checked_at: Some(checked_at.clone()),
            repaired: false,
        })
        .collect())
}

pub(crate) async fn verify_favorite_stations_inner(
    db: &DbPool,
) -> Result<Vec<StationHealthResult>, String> {
    // The launch/6-hour checker and a user-triggered Smart rescan can overlap.
    // Serialize whole favorite scans so URL repairs and fail counters cannot
    // race and overwrite one another.
    let _scan_guard = FAVORITE_VERIFY_LOCK.lock().await;
    let stations = queries::get_favorite_stations(db).map_err(|e| e.to_string())?;
    if stations.is_empty() {
        return Ok(Vec::new());
    }

    let client = build_station_health_client()?;
    let verified = probe_station_targets(
        &client,
        stations
            .iter()
            .map(|station| StationVerifyTarget {
                station_id: Some(station.id.clone()),
                url: station.url.clone(),
            })
            .collect(),
    )
    .await?;

    let mut health_by_station_id = std::collections::HashMap::new();
    for (target, playable_url) in verified {
        if let Some(station_id) = target.station_id {
            health_by_station_id.insert(station_id, playable_url);
        }
    }

    let mut results = Vec::with_capacity(stations.len());
    for station in stations {
        let original_url = station.url.clone();
        let checked_at = queries::now();
        let playable = health_by_station_id.remove(&station.id).flatten();
        let mut is_healthy = playable.is_some();
        let mut url = playable.unwrap_or_else(|| station.url.clone());

        // The probe unwraps playlist URLs (.m3u/.pls) to the direct stream.
        // Persist that — the audio engine cannot decode playlist text.
        if is_healthy && url != station.url {
            let _ = queries::update_station_url(db, &station.id, &url);
            log::info!(
                "Station '{}': unwrapped playlist URL to direct stream",
                station.name
            );
        }

        // Saved stream URLs go stale (hosts/tokens rotate). Before declaring
        // a station unhealthy, try re-resolving its current URL by UUID.
        if !is_healthy {
            if let Some(fresh_url) = try_heal_station(db, &client, &station).await {
                url = fresh_url;
                is_healthy = true;
            }
        }

        let next_fail_count = if is_healthy {
            0
        } else {
            station.fail_count.saturating_add(1)
        };

        queries::update_station_health(db, &station.id, next_fail_count, &checked_at)
            .map_err(|e| e.to_string())?;

        let repaired = is_healthy && url != original_url;
        results.push(StationHealthResult {
            station_id: Some(station.id),
            url,
            status: station_health_status(next_fail_count).to_string(),
            last_checked_at: Some(checked_at),
            repaired,
        });
    }

    Ok(results)
}

pub(crate) fn spawn_favorite_station_health_check(db: DbPool) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = verify_favorite_stations_inner(&db).await {
                log::warn!("Favorite station health check failed: {}", err);
            }
            tokio::time::sleep(STATION_RECHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_targets_are_trimmed_deduplicated_and_bounded() {
        let targets = prepare_verify_targets(vec![
            " https://example.com/one ".to_string(),
            "".to_string(),
            "https://example.com/one".to_string(),
            "https://example.com/two".to_string(),
        ])
        .unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].url, "https://example.com/one");
        assert_eq!(targets[1].url, "https://example.com/two");

        let oversized = vec!["https://example.com".to_string(); MAX_STATION_VERIFY_URLS + 1];
        assert!(prepare_verify_targets(oversized).is_err());

        let oversized_url = vec![format!(
            "https://example.com/{}",
            "a".repeat(MAX_STATION_URL_BYTES)
        )];
        assert!(prepare_verify_targets(oversized_url).is_err());
    }

    #[tokio::test]
    async fn private_targets_fail_without_opening_network_connections() {
        let client = build_station_health_client().unwrap();
        let targets = (0..(MAX_CONCURRENT_STATION_PROBES * 3))
            .map(|index| StationVerifyTarget {
                station_id: Some(index.to_string()),
                url: format!("http://127.0.0.1:{}/stream", 8000 + index),
            })
            .collect();

        let results = probe_station_targets(&client, targets).await.unwrap();
        assert_eq!(results.len(), MAX_CONCURRENT_STATION_PROBES * 3);
        assert!(results.iter().all(|(_, playable)| playable.is_none()));
    }
}
