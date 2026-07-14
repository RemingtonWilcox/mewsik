use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::db::models::Station;
use crate::db::{queries, DbPool};
use crate::stations::directory::{
    radio_browser_get, resolve_station_urls_by_uuid, RadioBrowserStation,
};
use crate::stations::health::{
    build_station_health_client, try_heal_station, verify_favorite_stations_inner,
    verify_station_urls_inner, StationHealthResult,
};
use crate::stations::network::{parse_public_http_url, validate_public_http_url};
use crate::stations::probe::{probe_station_stream, url_looks_like_playlist};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

const MAX_DIRECTORY_UUIDS: usize = 100;
const DEFAULT_DIRECTORY_LIMIT: usize = 40;
const MAX_DIRECTORY_LIMIT: usize = 100;
const RAW_DIRECTORY_BATCH_SIZE: usize = 100;
const MAX_DIRECTORY_PAGE_FETCHES: usize = 6;
const MAX_DIRECTORY_OFFSET: usize = 100_000;

#[derive(Debug, Serialize)]
pub struct RadioStationPage {
    pub items: Vec<RadioBrowserStation>,
    pub next_offset: usize,
    pub has_more: bool,
}

fn radio_browser_order(sort: Option<&str>) -> &'static str {
    match sort {
        Some("rising") => "clicktrend",
        Some("loved") => "votes",
        Some("quality") => "bitrate",
        Some("recent") => "lastchecktime",
        Some("popular") | Some("smart") | None => "clickcount",
        // Never interpolate an arbitrary order value into the directory URL.
        Some(_) => "clickcount",
    }
}

fn is_radio_browser_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn normalize_radio_browser_uuid(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if is_radio_browser_uuid(&normalized) {
        Ok(normalized)
    } else {
        Err("Radio Browser station id is invalid".to_string())
    }
}

fn prepare_directory_stations(
    mut stations: Vec<RadioBrowserStation>,
    playable_only: bool,
) -> Vec<RadioBrowserStation> {
    if playable_only {
        // The audio engine cannot play HLS. Do not advertise a stream that can
        // never work in this build, even when it ranks highly in the directory.
        stations.retain(|station| station.hls.unwrap_or(0) == 0);
    }

    for station in &mut stations {
        // Directory metadata is untrusted and must not be loaded directly by
        // the WebView or carried into player state.
        station.favicon = None;
        if playable_only {
            if let Some(resolved) = station.url_resolved.take() {
                let trimmed = resolved.trim();
                if !trimmed.is_empty() {
                    station.url = trimmed.to_string();
                }
            }
        } else {
            // Detail refreshes feed stats/status UI only. Do not swap a known
            // playable URL for an unprobed (and possibly HLS) directory URL.
            station.url_resolved = None;
        }
    }
    stations
}

/// Add one raw Radio Browser batch to a logical page of playable stations.
///
/// `next_offset` is a raw directory cursor, not the number of returned rows.
/// Filtered HLS rows advance it, while the first playable lookahead row does
/// not. That makes the next request resume without repeating or skipping a
/// playable station even when the raw page contains filtered entries.
fn append_directory_page_batch(
    stations: Vec<RadioBrowserStation>,
    items: &mut Vec<RadioBrowserStation>,
    limit: usize,
    raw_offset: &mut usize,
    next_offset: &mut usize,
) -> bool {
    for station in stations {
        let station_offset = *raw_offset;
        *raw_offset = raw_offset.saturating_add(1);
        let Some(station) = prepare_directory_stations(vec![station], true)
            .into_iter()
            .next()
        else {
            *next_offset = *raw_offset;
            continue;
        };

        if items.len() >= limit {
            *next_offset = station_offset;
            return true;
        }

        items.push(station);
        *next_offset = *raw_offset;
    }

    false
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
    search_radio_stations_with_mode(query, None, None).await
}

async fn search_radio_stations_with_mode(
    query: String,
    mode: Option<String>,
    sort: Option<String>,
) -> Result<Vec<RadioBrowserStation>, String> {
    let endpoint = match mode.as_deref() {
        Some("tag") => "bytag",
        _ => "byname",
    };
    // hidebroken: the directory continuously checks its stations — skip
    // ones its own monitoring already knows are dead.
    let path = format!(
        "/json/stations/{}/{}?limit=100&order={}&reverse=true&hidebroken=true",
        endpoint,
        urlencoding::encode(&query),
        radio_browser_order(sort.as_deref())
    );

    let resp = radio_browser_get(&path)
        .await
        .ok_or_else(|| "All radio directory servers are unreachable".to_string())?;

    let stations: Vec<RadioBrowserStation> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse radio stations: {}", e))?;

    Ok(prepare_directory_stations(stations, true))
}

#[tauri::command]
pub async fn search_radio_stations_advanced(
    query: String,
    mode: Option<String>,
    sort: Option<String>,
) -> Result<Vec<RadioBrowserStation>, String> {
    search_radio_stations_with_mode(query, mode, sort).await
}

#[tauri::command]
pub async fn browse_radio_stations(
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<RadioStationPage, String> {
    let offset = offset.unwrap_or(0).min(MAX_DIRECTORY_OFFSET);
    let limit = limit
        .unwrap_or(DEFAULT_DIRECTORY_LIMIT)
        .clamp(1, MAX_DIRECTORY_LIMIT);
    let order = radio_browser_order(sort.as_deref());
    let mut items = Vec::with_capacity(limit);
    let mut raw_offset = offset;
    let mut next_offset = offset;
    let mut exhausted = raw_offset >= MAX_DIRECTORY_OFFSET;

    for _ in 0..MAX_DIRECTORY_PAGE_FETCHES {
        if raw_offset >= MAX_DIRECTORY_OFFSET {
            exhausted = true;
            break;
        }

        let raw_limit = RAW_DIRECTORY_BATCH_SIZE.min(MAX_DIRECTORY_OFFSET - raw_offset);
        let path = format!(
            "/json/stations?limit={raw_limit}&offset={raw_offset}&order={order}&reverse=true&hidebroken=true"
        );
        let resp = radio_browser_get(&path)
            .await
            .ok_or_else(|| "All radio directory servers are unreachable".to_string())?;
        let stations = resp
            .json::<Vec<RadioBrowserStation>>()
            .await
            .map_err(|e| format!("Failed to parse radio stations: {e}"))?;
        let raw_count = stations.len();

        if append_directory_page_batch(
            stations,
            &mut items,
            limit,
            &mut raw_offset,
            &mut next_offset,
        ) {
            return Ok(RadioStationPage {
                items,
                next_offset,
                has_more: true,
            });
        }

        if raw_count < raw_limit {
            exhausted = true;
            break;
        }
    }

    Ok(RadioStationPage {
        items,
        next_offset,
        // A full raw batch at the scan cap means there may still be directory
        // rows. The cursor has advanced past every filtered row we consumed, so
        // a subsequent page can safely continue the scan.
        has_more: !exhausted && next_offset < MAX_DIRECTORY_OFFSET,
    })
}

#[tauri::command]
pub async fn get_radio_station_details(
    station_uuids: Vec<String>,
) -> Result<Vec<RadioBrowserStation>, String> {
    if station_uuids.len() > MAX_DIRECTORY_UUIDS {
        return Err(format!(
            "Too many station ids: the maximum is {MAX_DIRECTORY_UUIDS}"
        ));
    }

    let normalized = station_uuids
        .into_iter()
        .filter(|uuid| !uuid.trim().is_empty())
        .map(|uuid| normalize_radio_browser_uuid(&uuid))
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = std::collections::HashSet::new();
    let mut station_uuids = normalized
        .into_iter()
        .filter(|uuid| seen.insert(uuid.clone()))
        .collect::<Vec<_>>();
    if station_uuids.is_empty() {
        return Ok(Vec::new());
    }
    station_uuids.sort_unstable();

    let joined = station_uuids
        .iter()
        .map(|uuid| urlencoding::encode(uuid).into_owned())
        .collect::<Vec<_>>()
        .join(",");
    let path = format!("/json/stations/byuuid?uuids={joined}");
    let resp = radio_browser_get(&path)
        .await
        .ok_or_else(|| "All radio directory servers are unreachable".to_string())?;
    let stations = resp
        .json::<Vec<RadioBrowserStation>>()
        .await
        .map_err(|e| format!("Failed to parse station details: {e}"))?;
    Ok(prepare_directory_stations(stations, false))
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
    let radio_browser_id = radio_browser_id
        .map(|uuid| normalize_radio_browser_uuid(&uuid))
        .transpose()?;
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
                let path = format!("/json/url/{}", urlencoding::encode(&uuid));
                let _ = radio_browser_get(&path).await;
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
    let stationuuid = normalize_radio_browser_uuid(&stationuuid)?;
    let play_request = engine.begin_play_request();
    let client = build_station_health_client()?;
    let mut candidates = vec![url];
    for candidate in resolve_station_urls_by_uuid(&stationuuid).await {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    let mut playable_url = None;
    for candidate in candidates {
        if let Some(resolved) = probe_station_stream(&client, &candidate).await {
            playable_url = Some(resolved);
            break;
        }
    }
    let url = playable_url.ok_or_else(|| {
        "Station is unavailable and no working replacement stream was found".to_string()
    })?;

    let click_uuid = stationuuid.clone();
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
        None,
    )?;

    if !engine.finish_play_request(
        play_request,
        AudioCommand::PlayUrl(station.id.clone(), url, name),
    ) {
        return Err("Station play request was superseded".to_string());
    }

    let _ = queries::update_station_last_played(&db, &station.id, &queries::now());

    // A directory-result play is just as real as a saved-station play. Report
    // it only after this request wins the playback race so the 24-hour start
    // metric remains honest.
    tauri::async_runtime::spawn(async move {
        let path = format!("/json/url/{}", urlencoding::encode(&click_uuid));
        let _ = radio_browser_get(&path).await;
    });
    Ok(station.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_station(name: &str, hls: i32) -> RadioBrowserStation {
        serde_json::from_value(serde_json::json!({
            "name": name,
            "url": "https://example.com/original",
            "url_resolved": "https://example.com/resolved",
            "hls": hls,
            "homepage": null,
            "favicon": "https://example.com/untrusted.png",
            "country": "US",
            "language": "English",
            "tags": "jazz",
            "codec": "MP3",
            "bitrate": 192,
            "votes": 42,
            "clickcount": 314,
            "clicktrend": -7,
            "lastcheckok": 1,
            "lastchecktime_iso8601": "2026-07-13T12:00:00Z",
            "stationuuid": "960cf833-0601-11e8-ae97-52543be04c81"
        }))
        .unwrap()
    }

    #[test]
    fn directory_sort_is_allowlisted() {
        assert_eq!(radio_browser_order(Some("smart")), "clickcount");
        assert_eq!(radio_browser_order(Some("popular")), "clickcount");
        assert_eq!(radio_browser_order(Some("rising")), "clicktrend");
        assert_eq!(radio_browser_order(Some("loved")), "votes");
        assert_eq!(radio_browser_order(Some("quality")), "bitrate");
        assert_eq!(radio_browser_order(Some("recent")), "lastchecktime");
        assert_eq!(
            radio_browser_order(Some("votes&hidebroken=false")),
            "clickcount"
        );
    }

    #[test]
    fn radio_browser_ids_are_strictly_validated() {
        assert!(is_radio_browser_uuid(
            "960cf833-0601-11e8-ae97-52543be04c81"
        ));
        assert!(is_radio_browser_uuid(
            "B8148B29-09D0-4AA1-8BFE-43D236260170"
        ));
        assert!(!is_radio_browser_uuid("not-a-station"));
        assert!(!is_radio_browser_uuid(
            "960cf833-0601-11e8-ae97-52543be04c8/"
        ));
        assert_eq!(
            normalize_radio_browser_uuid(" B8148B29-09D0-4AA1-8BFE-43D236260170 ").unwrap(),
            "b8148b29-09d0-4aa1-8bfe-43d236260170"
        );
    }

    #[test]
    fn directory_results_are_sanitized_without_mixing_stats_and_playability() {
        let playable = prepare_directory_stations(
            vec![directory_station("direct", 0), directory_station("hls", 1)],
            true,
        );
        assert_eq!(playable.len(), 1);
        assert_eq!(playable[0].url, "https://example.com/resolved");
        assert_eq!(playable[0].favicon, None);
        assert_eq!(playable[0].clickcount, Some(314));

        let details = prepare_directory_stations(vec![directory_station("details", 1)], false);
        assert_eq!(details[0].url, "https://example.com/original");
        assert_eq!(details[0].url_resolved, None);
        assert_eq!(details[0].favicon, None);
        assert_eq!(details[0].hls, Some(1));
    }

    #[test]
    fn directory_page_cursor_skips_filtered_rows_without_skipping_lookahead() {
        let mut items = Vec::new();
        let mut raw_offset = 0;
        let mut next_offset = 0;
        let has_more = append_directory_page_batch(
            vec![
                directory_station("first", 0),
                directory_station("filtered-one", 1),
                directory_station("filtered-two", 1),
                directory_station("second", 0),
                directory_station("third", 0),
            ],
            &mut items,
            2,
            &mut raw_offset,
            &mut next_offset,
        );

        assert!(has_more);
        assert_eq!(
            items
                .iter()
                .map(|station| station.name.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        // Raw rows 0..4 were consumed; row 4 is the playable lookahead and
        // must be returned again at the start of the next page.
        assert_eq!(next_offset, 4);

        let mut next_items = Vec::new();
        let mut next_raw_offset = next_offset;
        let mut following_offset = next_offset;
        let has_third_page = append_directory_page_batch(
            vec![
                directory_station("third", 0),
                directory_station("filtered-three", 1),
                directory_station("fourth", 0),
            ],
            &mut next_items,
            2,
            &mut next_raw_offset,
            &mut following_offset,
        );

        assert!(!has_third_page);
        assert_eq!(
            next_items
                .iter()
                .map(|station| station.name.as_str())
                .collect::<Vec<_>>(),
            vec!["third", "fourth"]
        );
        assert_eq!(following_offset, 7);
    }

    #[test]
    fn directory_page_cursor_advances_across_an_all_filtered_batch() {
        let mut items = Vec::new();
        let mut raw_offset = 80;
        let mut next_offset = 80;
        let has_more = append_directory_page_batch(
            vec![
                directory_station("hls-one", 1),
                directory_station("hls-two", 1),
                directory_station("hls-three", 1),
            ],
            &mut items,
            2,
            &mut raw_offset,
            &mut next_offset,
        );

        assert!(!has_more);
        assert!(items.is_empty());
        assert_eq!(raw_offset, 83);
        assert_eq!(next_offset, 83);
    }
}
