use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::db::models::Station;
use crate::db::{queries, DbPool};
use crate::stations::directory::{radio_browser_get, RadioBrowserStation};
use crate::stations::health::{
    build_station_health_client, try_heal_station, verify_favorite_stations_inner,
    verify_station_urls_inner, StationHealthResult,
};
use crate::stations::network::{parse_public_http_url, validate_public_http_url};
use crate::stations::probe::{probe_station_stream, url_looks_like_playlist};
use std::sync::Arc;
use tauri::State;

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
    // hidebroken: the directory continuously checks its stations — skip
    // ones its own monitoring already knows are dead.
    let path = format!(
        "/json/stations/{}/{}?limit=100&order=clickcount&reverse=true&hidebroken=true",
        endpoint,
        urlencoding::encode(&query)
    );

    let client = build_station_health_client()?;
    let resp = radio_browser_get(&client, &path)
        .await
        .ok_or_else(|| "All radio directory servers are unreachable".to_string())?;

    let mut stations: Vec<RadioBrowserStation> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse radio stations: {}", e))?;

    // The audio engine cannot play HLS — don't offer stations that can
    // never work.
    stations.retain(|station| station.hls.unwrap_or(0) == 0);

    // Prefer the resolved direct stream URL over playlist redirects —
    // playlist URLs go stale far more often.
    for station in &mut stations {
        // Directory metadata is untrusted and must not be loaded directly by
        // the WebView or carried into player state.
        station.favicon = None;
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
    let _ = favicon_url;
    let url = parse_public_http_url(&url)?.to_string();
    upsert_station(
        &db,
        name,
        url,
        homepage,
        None,
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
    let mut stations = queries::get_favorite_stations(&db).map_err(|e| e.to_string())?;
    for station in &mut stations {
        station.favicon_url = None;
    }
    Ok(stations)
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
    let _ = favicon;
    let play_request = engine.begin_play_request();
    let db = db.inner().clone();
    let mut play_url = url;
    let station = queries::get_station_by_id(&db, &station_id).map_err(|err| err.to_string())?;

    if let Some(station) = station.as_ref() {
        // DB may hold a fresher URL than the frontend's cached copy
        // (e.g. healed by the launch-time health check).
        play_url = station.url.clone();
    }

    let client = build_station_health_client()?;
    // Ordinary direct streams need only DNS validation here: the actual
    // downloader safely follows and revalidates every redirect. Playlist and
    // previously failing URLs still need a bounded content probe/unwrap.
    let should_probe = url_looks_like_playlist(&play_url)
        || station
            .as_ref()
            .map(|station| station.fail_count > 0)
            .unwrap_or(false);
    let playable = if should_probe {
        probe_station_stream(&client, &play_url).await
    } else {
        validate_public_http_url(&play_url).await.ok()
    };
    play_url = match playable {
        Some(playable_url) => playable_url,
        None => {
            if let Some(station) = station.as_ref() {
                try_heal_station(&db, &client, station)
                    .await
                    .ok_or_else(|| {
                        "Station URL is unsafe or not a playable audio stream".to_string()
                    })?
            } else {
                return Err("Station URL is unsafe or not a playable audio stream".to_string());
            }
        }
    };

    if !engine.finish_play_request(
        play_request,
        AudioCommand::PlayUrl(station_id.clone(), play_url.clone(), name),
    ) {
        return Err("Station play request was superseded".to_string());
    }

    if let Some(station) = station.as_ref() {
        if play_url != station.url {
            let _ = queries::update_station_url(&db, &station.id, &play_url);
        }
        // Report only a station that actually won the async play race.
        if let Some(uuid) = station.radio_browser_id.clone() {
            tauri::async_runtime::spawn(async move {
                if let Ok(client) = build_station_health_client() {
                    let path = format!("/json/url/{}", urlencoding::encode(&uuid));
                    let _ = radio_browser_get(&client, &path).await;
                }
            });
        }
    }

    let _ = queries::update_station_last_played(&db, &station_id, &queries::now());
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
) -> Result<String, String> {
    let _ = favicon;
    let play_request = engine.begin_play_request();
    let client = build_station_health_client()?;
    let url = if url_looks_like_playlist(&url) {
        probe_station_stream(&client, &url)
            .await
            .ok_or_else(|| "Station URL is unsafe or not a playable audio stream".to_string())?
    } else {
        validate_public_http_url(&url).await?
    };

    let now = queries::now();
    let station = upsert_station(
        &db,
        name.clone(),
        url.clone(),
        homepage,
        None,
        country,
        language,
        tags,
        codec,
        bitrate,
        Some(stationuuid),
        false,
        Some(now),
    )?;

    if !engine.finish_play_request(
        play_request,
        AudioCommand::PlayUrl(station.id.clone(), url, name),
    ) {
        return Err("Station play request was superseded".to_string());
    }
    Ok(station.id)
}
