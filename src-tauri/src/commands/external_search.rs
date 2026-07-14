use crate::audio::engine::AudioEngine;
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
const EXTERNAL_SEARCH_SOURCES: [&str; 3] = ["youtube", "soundcloud", "bandcamp"];

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalSearchResponse {
    pub items: Vec<ExternalSearchResult>,
    pub failed_sources: Vec<String>,
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
    request_id: String,
    query: String,
    source: String,
    results: Vec<ExternalSearchResult>,
}

#[derive(Debug, Clone, Serialize)]
struct ExternalSearchCompleteEvent {
    request_id: String,
    query: String,
    results: Vec<ExternalSearchResult>,
}

#[derive(Debug)]
struct ExternalSearchBatch {
    results: Vec<ExternalSearchResult>,
    failures: Vec<(String, String)>,
}

impl ExternalSearchBatch {
    fn failed_sources(&self) -> Vec<String> {
        self.failures
            .iter()
            .map(|(source, _)| source.clone())
            .collect()
    }

    fn should_restart_sidecar(&self) -> bool {
        self.results.is_empty()
            && self
                .failures
                .iter()
                .any(|(_, error)| is_sidecar_process_failure(error))
    }
}

fn is_sidecar_process_failure(error: &str) -> bool {
    [
        "Sidecar not running",
        "Sidecar stdin missing",
        "Sidecar exited before responding",
        "Failed to write to sidecar",
        "Failed to flush sidecar stdin",
        "No result from sidecar",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
}

pub struct ExternalSearchRuntime {
    latest_generation: AtomicU64,
    cache: Mutex<HashMap<String, CachedExternalSearch>>,
    inflight_preresolve: Mutex<HashSet<String>>,
    sidecar_recovery: Mutex<()>,
}

impl Default for ExternalSearchRuntime {
    fn default() -> Self {
        Self {
            latest_generation: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
            inflight_preresolve: Mutex::new(HashSet::new()),
            sidecar_recovery: Mutex::new(()),
        }
    }
}

impl ExternalSearchRuntime {
    fn next_generation(&self) -> u64 {
        // Serialize generation changes with process recovery so an older
        // search can never restart the sidecar underneath a newer request.
        let _recovery_guard = self.sidecar_recovery.lock();
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

    fn restart_sidecar_if_current(
        &self,
        generation: u64,
        sidecar: &SidecarManager,
    ) -> Result<bool, String> {
        let _recovery_guard = self.sidecar_recovery.lock();
        if !self.is_current(generation) {
            return Ok(false);
        }
        sidecar.restart()?;
        Ok(true)
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

fn validated_search_query(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Search query contains unsupported control characters".to_string());
    }
    let query = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = query.chars().count();
    if length < 2 {
        return Err("Search query must contain at least 2 characters".to_string());
    }
    if length > 200 {
        return Err("Search query must be 200 characters or fewer".to_string());
    }
    Ok(query)
}

fn validated_search_request_id(value: &str) -> Result<String, String> {
    let request_id = value.trim();
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid search request id".to_string());
    }
    Ok(request_id.to_string())
}

fn validated_search_source(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "youtube" => Ok("youtube"),
        "soundcloud" => Ok("soundcloud"),
        "bandcamp" => Ok("bandcamp"),
        _ => Err("Unsupported search source".to_string()),
    }
}

fn provider_label(source: &str) -> &str {
    match source {
        "youtube" => "YouTube",
        "soundcloud" => "SoundCloud",
        "bandcamp" => "Bandcamp",
        _ => "a music provider",
    }
}

fn provider_failure_message(sources: &[String]) -> String {
    let mut labels = sources
        .iter()
        .map(|source| provider_label(source).to_string())
        .collect::<Vec<_>>();
    labels.sort();
    labels.dedup();
    let joined = match labels.as_slice() {
        [] => "music providers".to_string(),
        [only] => only.clone(),
        [first, second] => format!("{first} and {second}"),
        _ => format!(
            "{}, and {}",
            labels[..labels.len() - 1].join(", "),
            labels[labels.len() - 1]
        ),
    };
    let verb = if labels.len() == 1 { "is" } else { "are" };
    format!("Search could not finish because {joined} {verb} temporarily unavailable. Try again.")
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

pub(crate) fn ensure_external_recording_inner(
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

fn run_external_search_batch(
    app: &tauri::AppHandle,
    db: &DbPool,
    sidecar: &Arc<SidecarManager>,
    cache: &StreamCache,
    search_runtime: &Arc<ExternalSearchRuntime>,
    query: &str,
    request_id: &str,
    generation: u64,
    attempt: usize,
) -> ExternalSearchBatch {
    let (tx, rx) = mpsc::channel();

    for source in EXTERNAL_SEARCH_SOURCES {
        let source_name = source.to_string();
        let query_value = query.to_string();
        let manager = Arc::clone(sidecar);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let method = format!("{}.search", source_name);
            let payload = manager
                .call(&method, json!({ "query": query_value, "page": 0 }))
                .and_then(|result| {
                    let items = result.get("items").cloned().ok_or_else(|| {
                        format!(
                            "{} returned a search response without items",
                            provider_label(&source_name)
                        )
                    })?;
                    serde_json::from_value::<Vec<ExternalSearchResult>>(items).map_err(|error| {
                        format!(
                            "{} returned an invalid search response: {error}",
                            provider_label(&source_name)
                        )
                    })
                });

            let _ = tx.send((source_name, payload));
        });
    }
    drop(tx);

    let mut all_results = Vec::new();
    let mut completed_sources = HashSet::new();
    let mut failures = Vec::new();
    for (source, payload) in rx {
        completed_sources.insert(source.clone());
        match payload {
            Ok(items) => {
                let items = enrich_external_results(db, items);
                if search_runtime.is_current(generation) {
                    let _ = app.emit(
                        "external-search-partial",
                        ExternalSearchPartialEvent {
                            request_id: request_id.to_string(),
                            query: query.to_string(),
                            source,
                            results: items.clone(),
                        },
                    );
                }
                let warm_candidates = rank_external_results(query, items.clone());
                spawn_preresolve_for_results(
                    Arc::clone(sidecar),
                    Arc::clone(cache),
                    Arc::clone(search_runtime),
                    generation,
                    &warm_candidates,
                    2,
                );
                all_results.extend(items);
            }
            Err(error) => {
                log::warn!(
                    target: "mewsik::search",
                    "provider search failed on attempt {} for {}: {}",
                    attempt,
                    source,
                    error
                );
                failures.push((source, error));
            }
        }
    }

    for source in EXTERNAL_SEARCH_SOURCES {
        if completed_sources.contains(source) {
            continue;
        }
        let error = "search worker exited without a response".to_string();
        log::warn!(
            target: "mewsik::search",
            "provider search failed on attempt {} for {}: {}",
            attempt,
            source,
            error
        );
        failures.push((source.to_string(), error));
    }

    ExternalSearchBatch {
        results: all_results,
        failures,
    }
}

#[tauri::command]
pub fn search_external(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    query: String,
    source: String,
    page: Option<usize>,
) -> Result<ExternalSearchPage, String> {
    let query = validated_search_query(&query)?;
    let source = validated_search_source(&source)?;
    sidecar.start()?;
    let method = format!("{}.search", source);
    let result = sidecar.call(
        &method,
        json!({ "query": query, "page": page.unwrap_or(0) }),
    )?;

    let items: Vec<ExternalSearchResult> =
        serde_json::from_value(result.get("items").cloned().ok_or_else(|| {
            format!(
                "{} returned an invalid search response",
                provider_label(source)
            )
        })?)
        .map_err(|error| {
            format!(
                "{} returned an invalid search response: {error}",
                provider_label(source)
            )
        })?;
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
    request_id: String,
) -> Result<ExternalSearchResponse, String> {
    let query = validated_search_query(&query)?;
    let request_id = validated_search_request_id(&request_id)?;
    let generation = search_runtime.next_generation();
    if let Some(cached_results) = search_runtime.get_cached_results(&query) {
        let cached_results = enrich_external_results(&db, cached_results);
        let _ = app.emit(
            "external-search-complete",
            ExternalSearchCompleteEvent {
                request_id: request_id.clone(),
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
        return Ok(ExternalSearchResponse {
            items: cached_results,
            failed_sources: Vec::new(),
        });
    }

    sidecar.start()?;
    let mut batch = run_external_search_batch(
        &app,
        db.inner(),
        sidecar.inner(),
        cache.inner(),
        search_runtime.inner(),
        &query,
        &request_id,
        generation,
        1,
    );

    // A provider child can be terminated by the OS, security software, or an
    // upstream dependency crash. One bounded restart makes a transient child
    // failure invisible to the user while still returning promptly when the
    // providers are genuinely unavailable. Never restart for an obsolete
    // search because that could interrupt the newer generation.
    if batch.should_restart_sidecar() {
        log::warn!(
            target: "mewsik::search",
            "search returned no results with {} provider failure(s); restarting the sidecar once",
            batch.failures.len()
        );
        match search_runtime.restart_sidecar_if_current(generation, sidecar.inner()) {
            Ok(true) if search_runtime.is_current(generation) => {
                batch = run_external_search_batch(
                    &app,
                    db.inner(),
                    sidecar.inner(),
                    cache.inner(),
                    search_runtime.inner(),
                    &query,
                    &request_id,
                    generation,
                    2,
                );
            }
            Ok(_) => {
                log::info!(
                    target: "mewsik::search",
                    "skipping sidecar retry because a newer search generation started"
                );
            }
            Err(error) => {
                log::error!(
                    target: "mewsik::search",
                    "failed to restart the provider sidecar: {}",
                    error
                );
            }
        }
    }

    let failed_sources = batch.failed_sources();
    let ranked = rank_external_results(&query, batch.results);
    if ranked.is_empty() && !failed_sources.is_empty() {
        return Err(provider_failure_message(&failed_sources));
    }
    if failed_sources.is_empty() {
        search_runtime.cache_results(&query, &ranked);
    }
    if search_runtime.is_current(generation) {
        let _ = app.emit(
            "external-search-complete",
            ExternalSearchCompleteEvent {
                request_id,
                query: query.clone(),
                results: ranked.clone(),
            },
        );
    }
    spawn_preresolve_for_results(
        Arc::clone(sidecar.inner()),
        Arc::clone(&*cache),
        Arc::clone(search_runtime.inner()),
        generation,
        &ranked,
        5,
    );

    Ok(ExternalSearchResponse {
        items: ranked,
        failed_sources,
    })
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
    let session_id = engine.start_queue(vec![entry], 0);
    crate::commands::playback::spawn_deterministic_continuation(
        db.inner(),
        sidecar.inner(),
        engine.inner(),
        cache.inner(),
        session_id,
        recording_id.clone(),
    );
    Ok(recording_id)
}

const EXTERNAL_CONTEXT_UP_NEXT_LIMIT: usize = 10;

fn external_context_tail(
    items: &[ExternalSearchResult],
    start_index: usize,
    limit: usize,
) -> Vec<ExternalSearchResult> {
    if items.len() <= 1 || start_index >= items.len() || limit == 0 {
        return Vec::new();
    }

    let selected = &items[start_index];
    let mut seen = HashSet::from([(selected.source.clone(), selected.source_id.clone())]);
    let mut tail = Vec::with_capacity(limit.min(items.len() - 1));

    // Follow the visible ranking from the clicked row and wrap once so a pick
    // near the end of a page still has a useful continuation. Provider IDs are
    // the stable identity here; duplicate search rows are never queued twice.
    for offset in 1..items.len() {
        let item = &items[(start_index + offset) % items.len()];
        if !seen.insert((item.source.clone(), item.source_id.clone())) {
            continue;
        }
        tail.push(item.clone());
        if tail.len() >= limit {
            break;
        }
    }

    tail
}

/// Starts the selected external result immediately, then lets a native worker
/// build the rest of Up Next. Queue ownership no longer belongs to the Search
/// page, so navigating elsewhere cannot cancel continuation. The queue session
/// guard rejects late work after the user starts a different context.
#[tauri::command]
pub fn play_external_context(
    sidecar: State<'_, Arc<SidecarManager>>,
    db: State<'_, DbPool>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    items: Vec<ExternalSearchResult>,
    start_index: usize,
) -> Result<String, String> {
    let selected = items
        .get(start_index)
        .cloned()
        .ok_or_else(|| "The selected search result is no longer available".to_string())?;
    let tail = external_context_tail(&items, start_index, EXTERNAL_CONTEXT_UP_NEXT_LIMIT);

    let recording_id = ensure_external_recording_inner(
        &db,
        Some(&cache),
        selected.source,
        selected.source_id,
        selected.title,
        selected.artist,
        selected.duration_ms,
        selected.cover_art_url,
    )?;
    let entry =
        crate::commands::playback::build_queue_entry(&db, &sidecar, &recording_id, Some(&cache))?;
    if entry.file_path.is_none() && entry.source_url.is_none() {
        return Err("No playable source for this search result".to_string());
    }

    let session_id = engine.start_queue(vec![entry], 0);
    if tail.is_empty() {
        crate::commands::playback::spawn_deterministic_continuation(
            db.inner(),
            sidecar.inner(),
            engine.inner(),
            cache.inner(),
            session_id,
            recording_id.clone(),
        );
        return Ok(recording_id);
    }

    let worker_db = db.inner().clone();
    let worker_sidecar = sidecar.inner().clone();
    let worker_engine = engine.inner().clone();
    let worker_cache = cache.inner().clone();
    let worker_session_id = session_id.clone();
    let worker_anchor_recording_id = recording_id.clone();

    if let Err(error) = std::thread::Builder::new()
        .name("external-up-next".to_string())
        .spawn(move || {
            let mut appended = 0usize;
            for candidate in tail {
                if !worker_engine.queue_session_is_current(&worker_session_id) {
                    return;
                }
                let candidate_title = candidate.title.clone();
                let queued = ensure_external_recording_inner(
                    &worker_db,
                    Some(&worker_cache),
                    candidate.source,
                    candidate.source_id,
                    candidate.title,
                    candidate.artist,
                    candidate.duration_ms,
                    candidate.cover_art_url,
                )
                .and_then(|candidate_id| {
                    crate::commands::playback::build_queue_entry(
                        &worker_db,
                        &worker_sidecar,
                        &candidate_id,
                        Some(&worker_cache),
                    )
                });

                match queued {
                    Ok(entry) if entry.file_path.is_some() || entry.source_url.is_some() => {
                        if !worker_engine.queue_session_is_current(&worker_session_id) {
                            return;
                        }
                        worker_engine
                            .append_context_if_session(worker_session_id.clone(), vec![entry]);
                        appended += 1;
                    }
                    Ok(_) => {
                        log::debug!("Skipping unplayable Up Next result: {candidate_title}");
                    }
                    Err(error) => {
                        log::debug!("Skipping failed Up Next result {candidate_title}: {error}");
                    }
                }
            }

            if appended == 0 && worker_engine.queue_session_is_current(&worker_session_id) {
                crate::commands::playback::spawn_deterministic_continuation(
                    &worker_db,
                    &worker_sidecar,
                    &worker_engine,
                    &worker_cache,
                    worker_session_id,
                    worker_anchor_recording_id,
                );
            }
        })
    {
        // The selected track is already queued and playable. A worker-launch
        // failure should degrade continuation, not make the UI claim playback
        // failed after audio has started.
        log::warn!("Failed to start external Up Next worker: {error}");
        crate::commands::playback::spawn_deterministic_continuation(
            db.inner(),
            sidecar.inner(),
            engine.inner(),
            cache.inner(),
            session_id,
            recording_id.clone(),
        );
    }

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
    use super::{
        external_context_tail, provider_failure_message, rank_external_results,
        validated_search_query, validated_search_request_id, validated_search_source,
        ExternalSearchBatch, ExternalSearchResult, ExternalSearchRuntime,
    };
    use crate::sources::sidecar_manager::SidecarManager;

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
    fn external_context_wraps_caps_and_deduplicates_provider_rows() {
        let items = vec![
            result("youtube", "One", "Artist", None),
            result("youtube", "Two", "Artist", None),
            result("youtube", "Three", "Artist", None),
            result("youtube", "Two", "Duplicate Artist", None),
            result("soundcloud", "Four", "Artist", None),
        ];

        let tail = external_context_tail(&items, 2, 3);
        let identities: Vec<_> = tail
            .iter()
            .map(|item| (item.source.as_str(), item.source_id.as_str()))
            .collect();

        assert_eq!(
            identities,
            vec![
                ("youtube", "youtube-Two"),
                ("soundcloud", "soundcloud-Four"),
                ("youtube", "youtube-One")
            ]
        );
    }

    #[test]
    fn one_unique_external_result_has_no_visible_context_tail() {
        let selected = result("youtube", "Only Song", "Artist", None);
        let mut duplicate = result("youtube", "Duplicate Label", "Artist", None);
        duplicate.source_id = selected.source_id.clone();

        assert!(external_context_tail(&[selected.clone()], 0, 10).is_empty());
        assert!(external_context_tail(&[selected, duplicate], 0, 10).is_empty());
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

    #[test]
    fn search_query_validation_trims_unicode_and_rejects_unsafe_input() {
        assert_eq!(
            validated_search_query("  Ryuichi   Sakamoto  ").as_deref(),
            Ok("Ryuichi Sakamoto")
        );
        assert_eq!(
            validated_search_query("宇多田ヒカル").as_deref(),
            Ok("宇多田ヒカル")
        );
        assert_eq!(
            validated_search_query("Ella Langley Choosin' Texas").as_deref(),
            Ok("Ella Langley Choosin' Texas")
        );
        assert!(validated_search_query("x").is_err());
        assert!(validated_search_query("hello\nworld").is_err());
        assert!(validated_search_query(&"x".repeat(201)).is_err());
    }

    #[test]
    fn search_source_is_an_allowlist() {
        assert_eq!(validated_search_source(" YouTube "), Ok("youtube"));
        assert!(validated_search_source("youtube.resolve_stream").is_err());
        assert!(validated_search_source("spotify").is_err());
    }

    #[test]
    fn search_request_ids_are_small_opaque_tokens() {
        assert_eq!(validated_search_request_id("42").as_deref(), Ok("42"));
        assert_eq!(
            validated_search_request_id("search_retry-2").as_deref(),
            Ok("search_retry-2")
        );
        assert!(validated_search_request_id("").is_err());
        assert!(validated_search_request_id("same query").is_err());
        assert!(validated_search_request_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn provider_failure_is_actionable_without_leaking_internal_errors() {
        let message = provider_failure_message(&["youtube".to_string(), "soundcloud".to_string()]);
        assert!(message.contains("SoundCloud and YouTube"));
        assert!(message.contains("Try again"));
    }

    #[test]
    fn empty_failed_batch_gets_one_sidecar_recovery_attempt() {
        let batch = ExternalSearchBatch {
            results: Vec::new(),
            failures: vec![(
                "youtube".to_string(),
                "Sidecar exited before responding".to_string(),
            )],
        };
        assert!(batch.should_restart_sidecar());

        let empty_success = ExternalSearchBatch {
            results: Vec::new(),
            failures: Vec::new(),
        };
        assert!(!empty_success.should_restart_sidecar());

        let partial_success = ExternalSearchBatch {
            results: vec![result("soundcloud", "Choosin' Texas", "Ella Langley", None)],
            failures: vec![("youtube".to_string(), "upstream timeout".to_string())],
        };
        assert!(!partial_success.should_restart_sidecar());

        let healthy_process_with_provider_errors = ExternalSearchBatch {
            results: Vec::new(),
            failures: vec![
                (
                    "youtube".to_string(),
                    "Sidecar error: upstream rejected the request".to_string(),
                ),
                (
                    "soundcloud".to_string(),
                    "Sidecar request 'soundcloud.search' in generation 1 timed out after 30s"
                        .to_string(),
                ),
            ],
        };
        assert!(!healthy_process_with_provider_errors.should_restart_sidecar());
    }

    #[test]
    fn stale_search_generation_cannot_restart_the_sidecar() {
        let runtime = ExternalSearchRuntime::default();
        let stale_generation = runtime.next_generation();
        let current_generation = runtime.next_generation();
        let sidecar = SidecarManager::new();

        assert_ne!(stale_generation, current_generation);
        assert_eq!(
            runtime.restart_sidecar_if_current(stale_generation, &sidecar),
            Ok(false)
        );
        assert!(!sidecar.is_running());
    }
}
