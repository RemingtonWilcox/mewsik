//! Station health checking and self-healing. Saved stream URLs rot (hosts
//! and tokens rotate); favorites are probed concurrently, playlist URLs are
//! unwrapped to direct streams, and dead URLs are re-resolved through the
//! station's permanent radio-browser UUID before being declared unhealthy.

use super::directory::resolve_station_urls_by_uuid;
use super::probe::probe_station_stream;
use crate::db::models::Station;
use crate::db::{queries, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::task::JoinSet;

const STATION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const STATION_RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationHealthResult {
    pub station_id: Option<String>,
    pub url: String,
    pub status: String,
    pub last_checked_at: Option<String>,
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
        .redirect(reqwest::redirect::Policy::limited(5))
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
    for candidate in resolve_station_urls_by_uuid(client, uuid).await {
        let Some(playable_url) = probe_station_stream(client, &candidate).await else {
            continue;
        };
        if playable_url == station.url {
            // Same URL we already have — nothing to heal with.
            return None;
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
    for target in targets {
        let client = client.clone();
        probes.spawn(async move {
            let playable_url = probe_station_stream(&client, &target.url).await;
            (target, playable_url)
        });
    }

    let mut results = Vec::new();
    while let Some(result) = probes.join_next().await {
        results.push(result.map_err(|err| format!("Station verification task failed: {}", err))?);
    }

    Ok(results)
}

pub(crate) async fn verify_station_urls_inner(
    urls: Vec<String>,
) -> Result<Vec<StationHealthResult>, String> {
    let mut deduped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for url in urls {
        let trimmed = url.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        deduped.push(StationVerifyTarget {
            station_id: None,
            url: trimmed.to_string(),
        });
    }

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
        })
        .collect())
}

pub(crate) async fn verify_favorite_stations_inner(
    db: &DbPool,
) -> Result<Vec<StationHealthResult>, String> {
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

        results.push(StationHealthResult {
            station_id: Some(station.id),
            url,
            status: station_health_status(next_fail_count).to_string(),
            last_checked_at: Some(checked_at),
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
