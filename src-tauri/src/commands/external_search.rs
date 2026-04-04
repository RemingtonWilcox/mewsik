use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::db::models::*;
use crate::db::{queries, DbPool};
use crate::sources::sidecar_manager::SidecarManager;
use crate::sources::stream_cache::{cache_insert, CachedStream, StreamCache};
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

const SEARCH_RESULTS_CACHE_TTL: Duration = Duration::from_secs(90);
const MAX_SEARCH_CACHE_ENTRIES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalSearchResult {
    pub source: String,
    pub source_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover_art_url: Option<String>,
    pub source_url: Option<String>,
    pub play_count: Option<u64>,
    #[serde(default)]
    pub is_saved: bool,
    #[serde(default)]
    pub is_downloaded: bool,
    pub recording_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalSearchPage {
    pub items: Vec<ExternalSearchResult>,
    pub has_more: bool,
}

#[derive(Debug, Default, Deserialize)]
struct StreamResolution {
    url: Option<String>,
    duration_ms: Option<u64>,
    bitrate: Option<u64>,
    mime_type: Option<String>,
}

#[derive(Debug)]
struct CachedStreamSnapshot {
    url: String,
    duration_ms: Option<i64>,
    bitrate_bps: Option<u64>,
    mime_type: String,
    metadata_json: String,
}

#[derive(Debug, Clone)]
struct CachedExternalSearch {
    results: Vec<ExternalSearchResult>,
    cached_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
struct ExternalSearchPartialEvent {
    query: String,
    source: String,
    results: Vec<ExternalSearchResult>,
}

#[derive(Debug, Clone, Serialize)]
struct ExternalSearchCompleteEvent {
    query: String,
    results: Vec<ExternalSearchResult>,
}

pub struct ExternalSearchRuntime {
    latest_generation: AtomicU64,
    cache: Mutex<HashMap<String, CachedExternalSearch>>,
    inflight_preresolve: Mutex<HashSet<String>>,
}

impl Default for ExternalSearchRuntime {
    fn default() -> Self {
        Self {
            latest_generation: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
            inflight_preresolve: Mutex::new(HashSet::new()),
        }
    }
}

impl ExternalSearchRuntime {
    fn next_generation(&self) -> u64 {
        self.latest_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.latest_generation.load(Ordering::SeqCst) == generation
    }

    fn get_cached_results(&self, query: &str) -> Option<Vec<ExternalSearchResult>> {
        let key = search_cache_key(query)?;
        let map = self.cache.lock();
        let entry = map.get(&key)?;
        if entry.cached_at.elapsed() > SEARCH_RESULTS_CACHE_TTL {
            return None;
        }
        Some(entry.results.clone())
    }

    fn cache_results(&self, query: &str, results: &[ExternalSearchResult]) {
        let Some(key) = search_cache_key(query) else {
            return;
        };

        let mut map = self.cache.lock();
        if map.len() >= MAX_SEARCH_CACHE_ENTRIES && !map.contains_key(&key) {
            if let Some(oldest_key) = map
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(existing_key, _)| existing_key.clone())
            {
                map.remove(&oldest_key);
            }
        }

        map.insert(
            key,
            CachedExternalSearch {
                results: results.to_vec(),
                cached_at: Instant::now(),
            },
        );
    }

    fn begin_preresolve(&self, cache_key: &str) -> bool {
        let mut inflight = self.inflight_preresolve.lock();
        inflight.insert(cache_key.to_string())
    }

    fn finish_preresolve(&self, cache_key: &str) {
        self.inflight_preresolve.lock().remove(cache_key);
    }
}

fn normalize_query(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn search_cache_key(query: &str) -> Option<String> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        None
    } else {
        Some(format!("all:{normalized}"))
    }
}

fn recording_has_local_file(db: &DbPool, recording_id: &str) -> bool {
    if let Ok(Some(source)) = queries::get_best_source(db, recording_id) {
        if let Some(path) = source.file_path.as_deref() {
            if Path::new(path).exists() {
                return true;
            }
        }
    }

    if let Ok(Some(download)) =
        queries::get_latest_completed_download_for_recording(db, recording_id)
    {
        if let Some(path) = download.file_path.as_deref() {
            return Path::new(path).exists();
        }
    }

    false
}

fn enrich_external_result(db: &DbPool, mut result: ExternalSearchResult) -> ExternalSearchResult {
    let Some(existing) = queries::find_source_by_provider_id(db, &result.source, &result.source_id)
        .ok()
        .flatten()
    else {
        return result;
    };

    result.recording_id = Some(existing.recording_id.clone());
    result.is_saved = queries::get_recording(db, &existing.recording_id)
        .ok()
        .flatten()
        .map(|recording| recording.is_in_library)
        .unwrap_or(false);
    result.is_downloaded = recording_has_local_file(db, &existing.recording_id);
    result
}

fn enrich_external_results(
    db: &DbPool,
    results: Vec<ExternalSearchResult>,
) -> Vec<ExternalSearchResult> {
    results
        .into_iter()
        .map(|result| enrich_external_result(db, result))
        .collect()
}

fn source_priority(source: &str) -> i64 {
    match source {
        "youtube" => 35,
        "soundcloud" => 22,
        "bandcamp" => 8,
        _ => 0,
    }
}

fn score_result(
    matcher: &SkimMatcherV2,
    normalized_query: &str,
    result: &ExternalSearchResult,
) -> i64 {
    let normalized_title = normalize_query(&result.title);
    let normalized_artist = normalize_query(&result.artist);
    let normalized_album = result
        .album
        .as_deref()
        .map(normalize_query)
        .unwrap_or_default();
    let full_text = format!(
        "{} {} {}",
        normalized_title, normalized_artist, normalized_album
    )
    .trim()
    .to_string();

    let mut score = matcher
        .fuzzy_match(&full_text, normalized_query)
        .unwrap_or(0);

    let query_tokens: HashSet<&str> = normalized_query.split_whitespace().collect();
    let title_tokens: HashSet<&str> = normalized_title.split_whitespace().collect();
    let artist_tokens: HashSet<&str> = normalized_artist.split_whitespace().collect();
    let album_tokens: HashSet<&str> = normalized_album.split_whitespace().collect();

    let title_matches = query_tokens
        .iter()
        .filter(|token| title_tokens.contains(**token))
        .count() as i64;
    let artist_matches = query_tokens
        .iter()
        .filter(|token| artist_tokens.contains(**token))
        .count() as i64;
    let album_matches = query_tokens
        .iter()
        .filter(|token| album_tokens.contains(**token))
        .count() as i64;

    score += title_matches * 80;
    score += artist_matches * 50;
    score += album_matches * 20;

    if normalized_title == normalized_query {
        score += 500;
    } else if !normalized_title.is_empty() && normalized_query.contains(&normalized_title) {
        score += 420;
    } else if normalized_title.starts_with(normalized_query) {
        score += 260;
    } else if normalized_title.contains(normalized_query) {
        score += 140;
    }

    if normalized_artist == normalized_query {
        score += 220;
    } else if !normalized_artist.is_empty() && normalized_query.contains(&normalized_artist) {
        score += 160;
    } else if normalized_artist.starts_with(normalized_query) {
        score += 120;
    } else if !normalized_artist.is_empty() {
        score += matcher
            .fuzzy_match(&normalized_artist, normalized_query)
            .unwrap_or(0)
            / 4;
    }

    if !normalized_album.is_empty() {
        score += matcher
            .fuzzy_match(&normalized_album, normalized_query)
            .unwrap_or(0)
            / 6;
    }

    if result.cover_art_url.is_some() {
        score += 18;
    }
    if result.duration_ms.is_some() {
        score += 12;
    }
    if let Some(play_count) = result.play_count {
        score += (((play_count as f64) + 1.0).log10() * 50.0).round() as i64;
    }

    score + source_priority(&result.source)
}

fn rank_external_results(
    query: &str,
    mut results: Vec<ExternalSearchResult>,
) -> Vec<ExternalSearchResult> {
    let normalized_query = normalize_query(query);
    if normalized_query.is_empty() {
        return results;
    }

    let matcher = SkimMatcherV2::default().smart_case();
    results.sort_by(|a, b| {
        score_result(&matcher, &normalized_query, b)
            .cmp(&score_result(&matcher, &normalized_query, a))
            .then_with(|| source_priority(&b.source).cmp(&source_priority(&a.source)))
            .then_with(|| a.title.cmp(&b.title))
    });
    results.truncate(60);
    results
}

fn estimate_quality_score(source: &str, bitrate_bps: Option<u64>) -> i32 {
    let base = match source {
        "bandcamp" => 62,
        "youtube" => 56,
        "soundcloud" => 48,
        _ => 40,
    };
    let bitrate_bonus = bitrate_bps
        .map(|value| ((value / 1000).min(320) / 16) as i32)
        .unwrap_or(0);
    (base + bitrate_bonus).min(100)
}

fn cached_stream_snapshot(
    cache: Option<&StreamCache>,
    source: &str,
    source_id: &str,
) -> Option<CachedStreamSnapshot> {
    let cache = cache?;
    let cache_key = format!("{}:{}", source, source_id);
    let map = cache.lock().ok()?;
    let entry = map.get(&cache_key)?;
    if entry.is_expired() {
        return None;
    }

    Some(CachedStreamSnapshot {
        url: entry.url.clone(),
        duration_ms: entry.duration_ms,
        bitrate_bps: entry.bitrate.and_then(|value| u64::try_from(value).ok()),
        mime_type: entry.mime_type.clone(),
        metadata_json: json!({
            "url": entry.url,
            "headers": entry.headers,
            "expires_at": entry.expires_at,
            "mime_type": entry.mime_type,
            "codec": entry.codec,
            "bitrate": entry.bitrate,
            "duration_ms": entry.duration_ms,
            "is_seekable": entry.is_seekable,
            "needs_refresh": entry.needs_refresh,
        })
        .to_string(),
    })
}

fn spawn_preresolve_for_results(
    sidecar: Arc<SidecarManager>,
    stream_cache: StreamCache,
    search_runtime: Arc<ExternalSearchRuntime>,
    generation: u64,
    results: &[ExternalSearchResult],
    limit: usize,
) {
    let targets: Vec<(String, String)> = results
        .iter()
        .take(limit)
        .map(|result| (result.source.clone(), result.source_id.clone()))
        .collect();

    std::thread::spawn(move || {
        for (source, source_id) in targets {
            if !search_runtime.is_current(generation) {
                break;
            }

            let cache_key = format!("{}:{}", source, source_id);

            {
                if let Ok(map) = stream_cache.lock() {
                    if let Some(entry) = map.get(&cache_key) {
                        if !entry.is_expired() {
                            continue;
                        }
                    }
                }
            }

            if !search_runtime.begin_preresolve(&cache_key) {
                continue;
            }

            let method = format!("{}.resolve_stream", source);
            match sidecar.call(&method, json!({ "source_id": source_id })) {
                Ok(result) => {
                    if !search_runtime.is_current(generation) {
                        search_runtime.finish_preresolve(&cache_key);
                        break;
                    }

                    let url = result
                        .get("url")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_string());

                    if let Some(url) = url {
                        let headers: HashMap<String, String> = result
                            .get("headers")
                            .and_then(|value| serde_json::from_value(value.clone()).ok())
                            .unwrap_or_default();
                        let expires_at = result.get("expires_at").and_then(|value| value.as_i64());
                        let mime_type = result
                            .get("mime_type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("audio/mpeg")
                            .to_string();
                        let codec = result
                            .get("codec")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        let bitrate = result.get("bitrate").and_then(|value| value.as_i64());
                        let duration_ms =
                            result.get("duration_ms").and_then(|value| value.as_i64());
                        let is_seekable = result
                            .get("is_seekable")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false);
                        let needs_refresh = result
                            .get("needs_refresh")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false);

                        let entry = CachedStream {
                            url,
                            headers,
                            expires_at,
                            mime_type,
                            codec,
                            bitrate,
                            duration_ms,
                            is_seekable,
                            needs_refresh,
                            cached_at: Instant::now(),
                        };
                        cache_insert(&stream_cache, cache_key.clone(), entry);
                    }
                }
                Err(err) => {
                    log::debug!(
                        "Pre-resolve failed for {}:{} (will resolve on demand): {}",
                        source,
                        source_id,
                        err
                    );
                }
            }

            search_runtime.finish_preresolve(&cache_key);
        }
    });
}

fn ensure_external_recording_inner(
    db: &DbPool,
    cache: Option<&StreamCache>,
    source: String,
    source_id: String,
    title: String,
    artist: String,
    duration_ms: Option<u64>,
    cover_art_url: Option<String>,
) -> Result<String, String> {
    let now = queries::now();
    let cached_stream = cached_stream_snapshot(cache, &source, &source_id);
    let stream_url = cached_stream.as_ref().map(|stream| stream.url.clone());
    let resolved_duration_ms = cached_stream.as_ref().and_then(|stream| stream.duration_ms);
    let bitrate = cached_stream
        .as_ref()
        .and_then(|stream| stream.bitrate_bps)
        .map(|value| (value / 1000) as i32);
    let file_format = cached_stream
        .as_ref()
        .map(|stream| stream.mime_type.clone());
    let stream_metadata = cached_stream
        .as_ref()
        .map(|stream| stream.metadata_json.clone());
    let final_duration_ms = duration_ms
        .map(|value| value as i64)
        .or(resolved_duration_ms);
    let quality_score = estimate_quality_score(
        &source,
        cached_stream.as_ref().and_then(|stream| stream.bitrate_bps),
    );

    if let Some(existing) =
        queries::find_source_by_provider_id(db, &source, &source_id).map_err(|e| e.to_string())?
    {
        if stream_url.is_some()
            || file_format.is_some()
            || bitrate.is_some()
            || stream_metadata.is_some()
        {
            queries::update_remote_track_source(
                db,
                &existing.id,
                stream_url.as_deref(),
                file_format.as_deref(),
                bitrate,
                Some(quality_score),
                stream_metadata.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        }
        queries::update_recording_external_metadata(
            db,
            &existing.recording_id,
            Some(title.as_str()),
            final_duration_ms,
            None,
            None,
            cover_art_url.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        return Ok(existing.recording_id);
    }

    let recording_id = queries::new_id();
    let recording = Recording {
        id: recording_id.clone(),
        title: title.clone(),
        duration_ms: final_duration_ms,
        year: None,
        genre: None,
        cover_art_path: None,
        cover_art_url: cover_art_url.clone(),
        loudness_lufs: None,
        musicbrainz_id: None,
        metadata_json: None,
        is_in_library: false,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    queries::insert_recording(db, &recording).map_err(|e| e.to_string())?;

    let artist_id = match queries::find_artist_by_name(db, &artist) {
        Ok(Some(a)) => a.id,
        _ => {
            let id = queries::new_id();
            let a = Artist {
                id: id.clone(),
                name: artist.clone(),
                sort_name: None,
                musicbrainz_id: None,
                image_path: None,
                image_url: None,
                bio: None,
                metadata_json: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let _ = queries::insert_artist(db, &a);
            id
        }
    };
    let _ = queries::link_recording_artist(db, &recording_id, &artist_id, "primary", 0);

    let ts = TrackSource {
        id: queries::new_id(),
        recording_id: recording_id.clone(),
        source: source.clone(),
        source_id: Some(source_id),
        source_url: stream_url,
        file_path: None,
        file_format,
        file_size_bytes: None,
        bitrate,
        sample_rate: None,
        quality_score,
        content_hash: None,
        is_available: true,
        metadata_json: stream_metadata,
        last_verified: cached_stream.as_ref().map(|_| now.clone()),
        created_at: now.clone(),
        updated_at: now,
    };
    queries::insert_track_source(db, &ts).map_err(|e| e.to_string())?;

    Ok(recording_id)
}

#[tauri::command]
pub fn search_external(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    query: String,
    source: String,
    page: Option<usize>,
) -> Result<ExternalSearchPage, String> {
    sidecar.start()?;
    let method = format!("{}.search", source);
    let result = sidecar.call(
        &method,
        json!({ "query": query, "page": page.unwrap_or(0) }),
    )?;

    let items: Vec<ExternalSearchResult> =
        serde_json::from_value(result.get("items").cloned().unwrap_or_default())
            .unwrap_or_default();
    let has_more = result
        .get("has_more")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let items = enrich_external_results(&db, items);

    Ok(ExternalSearchPage {
        items: rank_external_results(&query, items),
        has_more,
    })
}

#[tauri::command]
pub fn search_all_sources(
    app: tauri::AppHandle,
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    cache: State<'_, StreamCache>,
    search_runtime: State<'_, Arc<ExternalSearchRuntime>>,
    query: String,
) -> Result<Vec<ExternalSearchResult>, String> {
    let generation = search_runtime.next_generation();
    if let Some(cached_results) = search_runtime.get_cached_results(&query) {
        let cached_results = enrich_external_results(&db, cached_results);
        let _ = app.emit(
            "external-search-complete",
            ExternalSearchCompleteEvent {
                query: query.clone(),
                results: cached_results.clone(),
            },
        );
        spawn_preresolve_for_results(
            Arc::clone(sidecar.inner()),
            Arc::clone(&*cache),
            Arc::clone(search_runtime.inner()),
            generation,
            &cached_results,
            5,
        );
        return Ok(cached_results);
    }

    sidecar.start()?;
    let (tx, rx) = mpsc::channel();

    for source in ["youtube", "soundcloud", "bandcamp"] {
        let source_name = source.to_string();
        let query_value = query.clone();
        let manager = Arc::clone(sidecar.inner());
        let tx = tx.clone();
        std::thread::spawn(move || {
            let method = format!("{}.search", source_name);
            let payload = manager
                .call(&method, json!({ "query": query_value, "page": 0 }))
                .map(|result| {
                    serde_json::from_value::<Vec<ExternalSearchResult>>(
                        result.get("items").cloned().unwrap_or_default(),
                    )
                    .unwrap_or_default()
                });

            let _ = tx.send((source_name, payload));
        });
    }
    drop(tx);

    let mut all_results = Vec::new();
    for (source, payload) in rx {
        match payload {
            Ok(items) => {
                let items = enrich_external_results(&db, items);
                let _ = app.emit(
                    "external-search-partial",
                    ExternalSearchPartialEvent {
                        query: query.clone(),
                        source,
                        results: items.clone(),
                    },
                );
                let warm_candidates = rank_external_results(&query, items.clone());
                spawn_preresolve_for_results(
                    Arc::clone(sidecar.inner()),
                    Arc::clone(&*cache),
                    Arc::clone(search_runtime.inner()),
                    generation,
                    &warm_candidates,
                    2,
                );
                all_results.extend(items);
            }
            Err(err) => log::warn!("Failed to search {}: {}", source, err),
        }
    }

    let ranked = rank_external_results(&query, all_results);
    search_runtime.cache_results(&query, &ranked);
    let _ = app.emit(
        "external-search-complete",
        ExternalSearchCompleteEvent {
            query: query.clone(),
            results: ranked.clone(),
        },
    );
    spawn_preresolve_for_results(
        Arc::clone(sidecar.inner()),
        Arc::clone(&*cache),
        Arc::clone(search_runtime.inner()),
        generation,
        &ranked,
        5,
    );

    Ok(ranked)
}

#[tauri::command]
pub fn ensure_external_recording(
    db: State<'_, DbPool>,
    cache: State<'_, StreamCache>,
    source: String,
    source_id: String,
    title: String,
    artist: String,
    duration_ms: Option<u64>,
    cover_art_url: Option<String>,
) -> Result<String, String> {
    ensure_external_recording_inner(
        &db,
        Some(&cache),
        source,
        source_id,
        title,
        artist,
        duration_ms,
        cover_art_url,
    )
}

#[tauri::command]
pub fn play_external(
    sidecar: State<'_, Arc<SidecarManager>>,
    db: State<'_, DbPool>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    source: String,
    source_id: String,
    title: String,
    artist: String,
    duration_ms: Option<u64>,
    cover_art_url: Option<String>,
) -> Result<String, String> {
    let recording_id = ensure_external_recording_inner(
        &db,
        Some(&cache),
        source,
        source_id,
        title,
        artist,
        duration_ms,
        cover_art_url,
    )?;
    let entry =
        crate::commands::playback::build_queue_entry(&db, &sidecar, &recording_id, Some(&cache))?;
    engine.send(AudioCommand::SetQueue(vec![entry], 0));
    Ok(recording_id)
}

#[tauri::command]
pub fn start_sidecar(sidecar: State<'_, Arc<SidecarManager>>) -> Result<(), String> {
    sidecar.start()
}

#[tauri::command]
pub fn stop_sidecar(sidecar: State<'_, Arc<SidecarManager>>) -> Result<(), String> {
    sidecar.stop();
    Ok(())
}

#[tauri::command]
pub fn sidecar_status(sidecar: State<'_, Arc<SidecarManager>>) -> Result<bool, String> {
    Ok(sidecar.is_running())
}

#[cfg(test)]
mod tests {
    use super::{rank_external_results, ExternalSearchResult};

    fn result(
        source: &str,
        title: &str,
        artist: &str,
        album: Option<&str>,
    ) -> ExternalSearchResult {
        ExternalSearchResult {
            source: source.to_string(),
            source_id: format!("{source}-{title}"),
            title: title.to_string(),
            artist: artist.to_string(),
            album: album.map(str::to_string),
            duration_ms: Some(180_000),
            cover_art_url: Some("https://example.com/cover.jpg".to_string()),
            source_url: None,
            play_count: None,
            is_saved: false,
            is_downloaded: false,
            recording_id: None,
        }
    }

    #[test]
    fn ranks_exact_title_matches_ahead_of_loose_matches() {
        let ranked = rank_external_results(
            "daft punk harder better faster stronger",
            vec![
                result("youtube", "Around the World", "Daft Punk", None),
                result(
                    "soundcloud",
                    "Harder Better Faster Stronger",
                    "Daft Punk",
                    None,
                ),
            ],
        );

        assert_eq!(
            ranked.first().map(|item| item.title.as_str()),
            Some("Harder Better Faster Stronger")
        );
    }

    #[test]
    fn applies_source_priority_when_matches_are_equivalent() {
        let ranked = rank_external_results(
            "night drive",
            vec![
                result("youtube", "Night Drive", "Chromatics", None),
                result("bandcamp", "Night Drive", "Chromatics", None),
            ],
        );

        assert_eq!(
            ranked.first().map(|item| item.source.as_str()),
            Some("youtube")
        );
    }

    #[test]
    fn boosts_more_popular_results_when_text_match_is_similar() {
        let mut low = result("youtube", "Money Trees", "Kendrick Lamar", None);
        let mut high = result("youtube", "Money Trees", "Kendrick Lamar", None);
        low.source_id = "youtube-low".to_string();
        high.source_id = "youtube-high".to_string();
        low.play_count = Some(1_000);
        high.play_count = Some(50_000_000);

        let ranked = rank_external_results("money trees", vec![low, high]);

        assert_eq!(
            ranked.first().map(|item| item.source_id.as_str()),
            Some("youtube-high")
        );
    }
}
