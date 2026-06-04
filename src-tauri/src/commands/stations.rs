use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::db::models::Station;
use crate::db::{queries, DbPool};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::task::JoinSet;

#[derive(Debug, Serialize, Deserialize)]
pub struct RadioBrowserStation {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_resolved: Option<String>,
    pub homepage: Option<String>,
    pub favicon: Option<String>,
    pub country: Option<String>,
    pub language: Option<String>,
    pub tags: Option<String>,
    pub codec: Option<String>,
    pub bitrate: Option<i32>,
    pub stationuuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationHealthResult {
    pub station_id: Option<String>,
    pub url: String,
    pub status: String,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationVerifyTarget {
    pub station_id: Option<String>,
    pub url: String,
}

const STATION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const STATION_PROBE_BYTES: usize = 8 * 1024;
const STATION_PLAYLIST_DEPTH: usize = 2;

fn station_health_status(fail_count: i32) -> &'static str {
    match fail_count {
        0 => "ok",
        1..=2 => "stale",
        _ => "dead",
    }
}

fn normalize_content_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn is_audio_content_type(content_type: &str) -> bool {
    let normalized = normalize_content_type(content_type);
    normalized.starts_with("audio/")
        || matches!(
            normalized.as_str(),
            "application/ogg"
                | "application/octet-stream"
                | "application/aacp"
                | "application/flac"
        )
}

fn is_playlist_content_type(content_type: &str) -> bool {
    matches!(
        normalize_content_type(content_type).as_str(),
        "application/vnd.apple.mpegurl"
            | "application/x-mpegurl"
            | "application/apple.vnd.mpegurl"
            | "audio/x-mpegurl"
            | "audio/mpegurl"
            | "application/pls+xml"
            | "audio/x-scpls"
    )
}

fn url_looks_like_playlist(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    path.ends_with(".m3u") || path.ends_with(".m3u8") || path.ends_with(".pls")
}

fn bytes_to_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn bytes_look_like_html(bytes: &[u8]) -> bool {
    let lowercase = bytes_to_text(bytes).to_ascii_lowercase();
    let trimmed = lowercase.trim_start();

    trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<head")
        || trimmed.starts_with("<body")
        || lowercase.contains("<html")
        || lowercase.contains("<body")
        || lowercase.contains("<script")
}

fn bytes_look_like_playlist(bytes: &[u8]) -> bool {
    let text = bytes_to_text(bytes);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();

    trimmed.starts_with("#EXTM3U")
        || trimmed.starts_with("[playlist]")
        || trimmed
            .lines()
            .any(|line| line.trim_start().to_ascii_lowercase().starts_with("file1="))
}

fn looks_like_audio_payload(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes_look_like_html(bytes) || bytes_look_like_playlist(bytes) {
        return false;
    }

    if bytes.starts_with(b"ID3")
        || bytes.starts_with(b"OggS")
        || bytes.windows(4).any(|window| window == b"fLaC")
        || bytes.windows(4).any(|window| window == b"ftyp")
        || bytes
            .windows(2)
            .any(|window| matches!(window, [0xFF, second] if second & 0xE0 == 0xE0))
    {
        return true;
    }

    let sample_len = bytes.len().min(512);
    let binaryish = bytes[..sample_len]
        .iter()
        .filter(|byte| !matches!(**byte, b'\n' | b'\r' | b'\t' | b' '..=b'~'))
        .count();

    binaryish * 4 >= sample_len
}

fn resolve_playlist_target(bytes: &[u8], base_url: &reqwest::Url) -> Option<String> {
    let text = bytes_to_text(bytes);

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }

        let candidate = trimmed
            .split_once('=')
            .and_then(|(key, value)| {
                if key.trim().to_ascii_lowercase().starts_with("file") {
                    Some(value.trim())
                } else {
                    None
                }
            })
            .unwrap_or(trimmed);

        if candidate.is_empty() {
            continue;
        }

        if let Ok(url) = reqwest::Url::parse(candidate) {
            return Some(url.to_string());
        }

        if let Ok(url) = base_url.join(candidate) {
            return Some(url.to_string());
        }
    }

    None
}

async fn read_probe_bytes(response: &mut reqwest::Response) -> Result<Vec<u8>, reqwest::Error> {
    let mut bytes = Vec::with_capacity(STATION_PROBE_BYTES);

    while bytes.len() < STATION_PROBE_BYTES {
        match response.chunk().await? {
            Some(chunk) => {
                if chunk.is_empty() {
                    continue;
                }

                let remaining = STATION_PROBE_BYTES.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            None => break,
        }
    }

    Ok(bytes)
}

/// Probe a station URL, following playlist redirects (.m3u/.pls). Returns
/// the *direct stream URL* that actually serves audio — the audio engine
/// cannot decode playlist text, so callers should play/persist this URL,
/// not the original.
async fn probe_station_stream(client: &reqwest::Client, initial_url: &str) -> Option<String> {
    let mut current_url = initial_url.to_string();

    for _ in 0..=STATION_PLAYLIST_DEPTH {
        let mut response = match client
            .get(&current_url)
            .header(
                ACCEPT,
                "audio/*,application/ogg;q=0.9,application/octet-stream;q=0.8,*/*;q=0.1",
            )
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return None,
        };

        if !response.status().is_success() {
            return None;
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let final_url = response.url().clone();
        let bytes = match read_probe_bytes(&mut response).await {
            Ok(bytes) => bytes,
            Err(_) => return None,
        };

        if bytes.is_empty() {
            return None;
        }

        if is_playlist_content_type(&content_type) || bytes_look_like_playlist(&bytes) {
            if let Some(next_url) = resolve_playlist_target(&bytes, &final_url) {
                current_url = next_url;
                continue;
            }
            return None;
        }

        if bytes_look_like_html(&bytes) {
            return None;
        }

        if is_audio_content_type(&content_type) {
            return looks_like_audio_payload(&bytes).then_some(current_url);
        }

        if normalize_content_type(&content_type).starts_with("text/") {
            return None;
        }

        return looks_like_audio_payload(&bytes).then_some(current_url);
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
async fn resolve_station_urls_by_uuid(client: &reqwest::Client, uuid: &str) -> Vec<String> {
    let url = format!(
        "https://de1.api.radio-browser.info/json/stations/byuuid/{}",
        urlencoding::encode(uuid)
    );
    let Ok(response) = client.get(&url).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
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

/// Self-heal a station whose saved URL stopped working: re-resolve current
/// URLs by UUID, probe each (unwrapping playlists), and persist the first
/// one that actually streams audio. Returns the playable URL on success.
async fn try_heal_station(
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

fn build_station_health_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(STATION_PROBE_TIMEOUT)
        .connect_timeout(STATION_PROBE_TIMEOUT)
        .user_agent("mewsik/0.1.0")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to build station health client: {}", e))
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

async fn verify_station_urls_inner(urls: Vec<String>) -> Result<Vec<StationHealthResult>, String> {
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

async fn verify_favorite_stations_inner(db: &DbPool) -> Result<Vec<StationHealthResult>, String> {
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
        if let Err(err) = verify_favorite_stations_inner(&db).await {
            log::warn!("Favorite station health check failed: {}", err);
        }
    });
}

fn upsert_station(
    db: &DbPool,
    name: String,
    url: String,
    homepage: Option<String>,
    favicon_url: Option<String>,
    country: Option<String>,
    language: Option<String>,
    tags: Option<String>,
    codec: Option<String>,
    bitrate: Option<i32>,
    radio_browser_id: Option<String>,
    is_favorite: bool,
    last_played_at: Option<String>,
) -> Result<Station, String> {
    if let Some(existing) = queries::find_station_by_identity(db, radio_browser_id.as_deref(), &url)
        .map_err(|e| e.to_string())?
    {
        let station = Station {
            id: existing.id,
            name,
            url,
            homepage,
            favicon_url,
            favicon_path: existing.favicon_path,
            country,
            language,
            tags,
            codec,
            bitrate,
            radio_browser_id: radio_browser_id.or(existing.radio_browser_id),
            is_favorite: existing.is_favorite || is_favorite,
            fail_count: existing.fail_count,
            last_played_at: last_played_at.or(existing.last_played_at),
            last_checked_at: existing.last_checked_at,
            created_at: existing.created_at,
        };
        queries::insert_station(db, &station).map_err(|e| e.to_string())?;
        return Ok(station);
    }

    let station = Station {
        id: queries::new_id(),
        name,
        url,
        homepage,
        favicon_url,
        favicon_path: None,
        country,
        language,
        tags,
        codec,
        bitrate,
        radio_browser_id,
        is_favorite,
        fail_count: 0,
        last_played_at,
        last_checked_at: None,
        created_at: queries::now(),
    };
    queries::insert_station(db, &station).map_err(|e| e.to_string())?;
    Ok(station)
}

#[tauri::command]
pub async fn search_radio_stations(query: String) -> Result<Vec<RadioBrowserStation>, String> {
    search_radio_stations_with_mode(query, None).await
}

async fn search_radio_stations_with_mode(
    query: String,
    mode: Option<String>,
) -> Result<Vec<RadioBrowserStation>, String> {
    let endpoint = match mode.as_deref() {
        Some("tag") => "bytag",
        _ => "byname",
    };
    let url = format!(
        "https://de1.api.radio-browser.info/json/stations/{}/{}?limit=50&order=clickcount&reverse=true",
        endpoint,
        urlencoding::encode(&query)
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Radio browser request failed: {}", e))?;

    let mut stations: Vec<RadioBrowserStation> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse radio stations: {}", e))?;

    // Prefer the resolved direct stream URL over playlist redirects —
    // playlist URLs go stale far more often.
    for station in &mut stations {
        if let Some(resolved) = station.url_resolved.take() {
            let trimmed = resolved.trim();
            if !trimmed.is_empty() {
                station.url = trimmed.to_string();
            }
        }
    }

    Ok(stations)
}

#[tauri::command]
pub async fn search_radio_stations_advanced(
    query: String,
    mode: Option<String>,
) -> Result<Vec<RadioBrowserStation>, String> {
    search_radio_stations_with_mode(query, mode).await
}

#[tauri::command]
pub fn save_station(
    db: State<'_, DbPool>,
    name: String,
    url: String,
    homepage: Option<String>,
    favicon_url: Option<String>,
    country: Option<String>,
    language: Option<String>,
    tags: Option<String>,
    codec: Option<String>,
    bitrate: Option<i32>,
    radio_browser_id: Option<String>,
) -> Result<Station, String> {
    upsert_station(
        &db,
        name,
        url,
        homepage,
        favicon_url,
        country,
        language,
        tags,
        codec,
        bitrate,
        radio_browser_id,
        true,
        None,
    )
}

#[tauri::command]
pub fn get_favorite_stations(db: State<'_, DbPool>) -> Result<Vec<Station>, String> {
    queries::get_favorite_stations(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn verify_favorite_stations(
    db: State<'_, DbPool>,
) -> Result<Vec<StationHealthResult>, String> {
    let db = db.inner().clone();
    verify_favorite_stations_inner(&db).await
}

#[tauri::command]
pub async fn verify_station_urls(urls: Vec<String>) -> Result<Vec<StationHealthResult>, String> {
    verify_station_urls_inner(urls).await
}

#[tauri::command]
pub fn toggle_station_favorite(db: State<'_, DbPool>, station_id: String) -> Result<bool, String> {
    queries::toggle_station_favorite(&db, &station_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn play_station(
    db: State<'_, DbPool>,
    engine: State<'_, Arc<AudioEngine>>,
    station_id: String,
    url: String,
    name: String,
    favicon: Option<String>,
) -> Result<(), String> {
    let db = db.inner().clone();
    let mut play_url = url;

    if let Ok(Some(station)) = queries::get_station_by_id(&db, &station_id) {
        // DB may hold a fresher URL than the frontend's cached copy
        // (e.g. healed by the launch-time health check).
        play_url = station.url.clone();

        // The engine can only decode raw audio: unwrap playlist URLs to the
        // direct stream first. Also re-resolve known-failing stations.
        if url_looks_like_playlist(&play_url) || station.fail_count > 0 {
            if let Ok(client) = build_station_health_client() {
                if let Some(playable_url) = probe_station_stream(&client, &play_url).await {
                    if playable_url != station.url {
                        let _ = queries::update_station_url(&db, &station.id, &playable_url);
                    }
                    play_url = playable_url;
                } else if let Some(fresh_url) = try_heal_station(&db, &client, &station).await {
                    play_url = fresh_url;
                }
            }
        }
    }

    let _ = queries::update_station_last_played(&db, &station_id, &queries::now());
    engine.send(AudioCommand::PlayUrl(station_id, play_url, name, favicon));
    Ok(())
}

#[tauri::command]
pub async fn play_station_search_result(
    db: State<'_, DbPool>,
    engine: State<'_, Arc<AudioEngine>>,
    name: String,
    url: String,
    homepage: Option<String>,
    favicon: Option<String>,
    country: Option<String>,
    language: Option<String>,
    tags: Option<String>,
    codec: Option<String>,
    bitrate: Option<i32>,
    stationuuid: String,
) -> Result<(), String> {
    // Unwrap playlist URLs before saving/playing — the engine decodes raw
    // audio only.
    let mut url = url;
    if url_looks_like_playlist(&url) {
        if let Ok(client) = build_station_health_client() {
            if let Some(playable_url) = probe_station_stream(&client, &url).await {
                url = playable_url;
            }
        }
    }

    let now = queries::now();
    let station = upsert_station(
        &db,
        name.clone(),
        url.clone(),
        homepage,
        favicon.clone(),
        country,
        language,
        tags,
        codec,
        bitrate,
        Some(stationuuid),
        false,
        Some(now),
    )?;

    engine.send(AudioCommand::PlayUrl(station.id, url, name, favicon));
    Ok(())
}
