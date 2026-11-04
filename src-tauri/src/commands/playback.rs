use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::audio::queue::{QueueEntry, RepeatMode};
use crate::db::models::{PlaybackState, QueueSnapshot};
use crate::db::{queries, DbPool};
use crate::download;
use crate::sources::stream_cache::StreamCache;
use crate::sources::SidecarManager;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::audio::decoder::AudioDecoder;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tauri::State;

#[derive(Debug, Default, Deserialize)]
struct StoredStreamMetadata {
    #[serde(default)]
    headers: HashMap<String, String>,
    expires_at: Option<u64>,
    mime_type: Option<String>,
    #[serde(default)]
    needs_refresh: bool,
    is_seekable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaybackWaveform {
    pub recording_id: String,
    pub peaks: Vec<f32>,
    pub rms: Vec<f32>,
    pub source: String,
}

fn parse_stream_metadata(metadata_json: Option<&str>) -> StoredStreamMetadata {
    metadata_json
        .and_then(|json| serde_json::from_str::<StoredStreamMetadata>(json).ok())
        .unwrap_or_default()
}

fn resample_peaks(window_peaks: &[f32], bins: usize) -> Vec<f32> {
    if bins == 0 {
        return Vec::new();
    }

    if window_peaks.is_empty() {
        return vec![0.0; bins];
    }

    let mut resampled = Vec::with_capacity(bins);
    let input_len = window_peaks.len();

    for bin_idx in 0..bins {
        let start = bin_idx * input_len / bins;
        let mut end = (bin_idx + 1) * input_len / bins;
        if end <= start {
            end = (start + 1).min(input_len);
        }

        let peak = window_peaks[start..end]
            .iter()
            .copied()
            .fold(0.0_f32, f32::max);
        resampled.push(peak);
    }

    let max_peak = resampled.iter().copied().fold(0.0_f32, f32::max);
    if max_peak > 0.0 {
        for peak in &mut resampled {
            *peak = (*peak / max_peak).sqrt().clamp(0.0, 1.0);
        }
    }

    resampled
}

/// Loudness per short window across the whole file: (peak, rms), 0..1.
/// Decodes through the playback decoder so it reads exactly what plays,
/// including MP4s with embedded cover art.
fn waveform_windows(path: &Path) -> Result<Vec<(f32, f32)>, String> {
    const WINDOW_FRAMES: usize = 1024;

    let decoder = AudioDecoder::open_path(path)?;
    let channels = rodio::Source::channels(&decoder).max(1) as usize;
    let mut windows = Vec::new();
    let (mut peak, mut sum_sq, mut count) = (0.0_f32, 0.0_f32, 0usize);
    let (mut frame_amp, mut in_frame) = (0.0_f32, 0usize);

    for sample in decoder {
        frame_amp = frame_amp.max((sample as f32 / 32768.0).abs());
        in_frame += 1;
        if in_frame < channels {
            continue;
        }
        peak = peak.max(frame_amp);
        sum_sq += frame_amp * frame_amp;
        count += 1;
        frame_amp = 0.0;
        in_frame = 0;
        if count >= WINDOW_FRAMES {
            windows.push((peak, (sum_sq / count as f32).sqrt()));
            (peak, sum_sq, count) = (0.0, 0.0, 0);
        }
    }
    if count > 0 {
        windows.push((peak, (sum_sq / count as f32).sqrt()));
    }
    Ok(windows)
}

/// Bins of (peak, rms), both scaled so the loudest bin's peak is 1.
fn bin_waveform(windows: &[(f32, f32)], bins: usize) -> (Vec<f32>, Vec<f32>) {
    let peaks = resample_peaks(&windows.iter().map(|w| w.0).collect::<Vec<_>>(), bins);
    if windows.is_empty() || bins == 0 {
        return (peaks, vec![0.0; bins]);
    }
    let max_peak = windows.iter().map(|w| w.0).fold(0.0_f32, f32::max).max(1e-6);
    let rms = (0..bins)
        .map(|i| {
            let start = i * windows.len() / bins;
            let end = ((i + 1) * windows.len() / bins).max(start + 1).min(windows.len());
            let slice = &windows[start..end];
            let mean = slice.iter().map(|w| w.1 * w.1).sum::<f32>() / slice.len() as f32;
            (mean.sqrt() / max_peak).sqrt().clamp(0.0, 1.0)
        })
        .collect();
    (peaks, rms)
}

type WaveformCache = Mutex<HashMap<(String, usize), Arc<(Vec<f32>, Vec<f32>)>>>;

/// Recently drawn waveforms, so replaying or seeking back never re-decodes.
fn waveform_cache() -> &'static WaveformCache {
    static CACHE: OnceLock<WaveformCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn generate_waveform(path: &Path, bins: usize) -> Result<Arc<(Vec<f32>, Vec<f32>)>, String> {
    let bins = bins.clamp(24, 1024);
    let key = (path.to_string_lossy().to_string(), bins);
    if let Some(hit) = waveform_cache().lock().get(&key) {
        return Ok(Arc::clone(hit));
    }
    let shape = Arc::new(bin_waveform(&waveform_windows(path)?, bins));
    let mut cache = waveform_cache().lock();
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, Arc::clone(&shape));
    Ok(shape)
}

fn resolve_waveform_source_path(
    db: &DbPool,
    recording_id: &str,
) -> Result<(String, String), String> {
    let _ = download::sync_completed_download_source_for_recording(db, recording_id);

    let source = queries::get_best_source(db, recording_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No source found for this recording".to_string())?;
    let file_path = source
        .file_path
        .ok_or_else(|| "Waveform is only available for local or downloaded audio".to_string())?;

    Ok((file_path, source.source))
}

fn refresh_remote_source_if_needed(
    db: &DbPool,
    sidecar: &SidecarManager,
    source: &mut crate::db::models::TrackSource,
    stream_cache: Option<&StreamCache>,
) -> Result<(), String> {
    if source.file_path.is_some() {
        return Ok(());
    }

    let metadata = parse_stream_metadata(source.metadata_json.as_deref());
    let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let expires_soon = metadata
        .expires_at
        .map(|expires_at| expires_at <= now_ms + 60_000)
        .unwrap_or(false);
    let soundcloud_needs_compat_refresh = source.source == "soundcloud"
        && source.file_path.is_none()
        && source
            .source_url
            .as_deref()
            .map(|url| url.contains("/stream/soundcloud/"))
            .unwrap_or(false)
        && (metadata.mime_type.as_deref() == Some("audio/mp4")
            || (metadata.mime_type.as_deref() == Some("audio/mpeg")
                && metadata.is_seekable == Some(false)));
    let should_refresh = source.source_url.is_none()
        || soundcloud_needs_compat_refresh
        || (metadata.needs_refresh && expires_soon);

    if !should_refresh {
        return Ok(());
    }

    let source_id = source
        .source_id
        .as_deref()
        .ok_or_else(|| "Remote source is missing its provider identifier".to_string())?;

    // Check the pre-resolution cache before hitting the sidecar.
    if let Some(cache) = stream_cache {
        let cache_key = format!("{}:{}", source.source, source_id);
        if let Ok(mut map) = cache.lock() {
            if let Some(cached) = map.get(&cache_key) {
                if !cached.is_expired() {
                    log::debug!("Stream cache hit for {}", cache_key);
                    source.source_url = Some(cached.url.clone());
                    // Synthesise a minimal metadata JSON so the headers and
                    // seekability info are available downstream.
                    let meta = serde_json::json!({
                        "url": cached.url,
                        "headers": cached.headers,
                        "expires_at": cached.expires_at,
                        "mime_type": cached.mime_type,
                        "is_seekable": cached.is_seekable,
                        "needs_refresh": cached.needs_refresh,
                    });
                    source.metadata_json = Some(meta.to_string());
                    return Ok(());
                }
                // Expired — remove so we resolve fresh and potentially re-cache.
                map.remove(&cache_key);
            }
        }
    }

    sidecar.start()?;

    let method = format!("{}.resolve_stream", source.source);
    let result = sidecar.call(&method, json!({ "source_id": source_id }))?;
    let stream_url = result
        .get("url")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Provider {} returned an empty stream URL", source.source))?
        .to_string();
    let metadata_json = result.to_string();

    queries::update_track_source_stream(
        db,
        &source.id,
        Some(stream_url.as_str()),
        Some(metadata_json.as_str()),
    )
    .map_err(|e| e.to_string())?;

    source.source_url = Some(stream_url);
    source.metadata_json = Some(metadata_json);

    Ok(())
}

pub(crate) fn build_queue_entry(
    db: &DbPool,
    sidecar: &SidecarManager,
    recording_id: &str,
    stream_cache: Option<&StreamCache>,
) -> Result<QueueEntry, String> {
    let rec = queries::get_recording(db, recording_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Recording {} not found", recording_id))?;

    let _ = download::sync_completed_download_source_for_recording(db, recording_id);
    let mut source = queries::get_best_source(db, recording_id).map_err(|e| e.to_string())?;
    if let Some(best_source) = source.as_mut() {
        refresh_remote_source_if_needed(db, sidecar, best_source, stream_cache)?;
    }

    let conn = db.lock();
    let artist = conn
        .query_row(
            "SELECT a.name FROM recording_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.recording_id = ?1 AND ra.role = 'primary' LIMIT 1",
            params![recording_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "Unknown Artist".to_string());
    drop(conn);

    let stream_metadata = source
        .as_ref()
        .map(|best_source| parse_stream_metadata(best_source.metadata_json.as_deref()))
        .unwrap_or_default();
    let stream_mime_type = source.as_ref().and_then(|best_source| {
        if best_source.file_path.is_some() {
            best_source
                .file_format
                .clone()
                .or_else(|| stream_metadata.mime_type.clone())
        } else {
            stream_metadata
                .mime_type
                .clone()
                .or_else(|| best_source.file_format.clone())
        }
    });
    let source_name = source
        .as_ref()
        .map(|s| s.source.clone())
        .unwrap_or_else(|| "local".to_string());
    let can_seek = if source.as_ref().and_then(|s| s.file_path.as_ref()).is_some() {
        true
    } else {
        stream_metadata
            .is_seekable
            .unwrap_or_else(|| rec.duration_ms.unwrap_or(0) > 0)
    };

    Ok(QueueEntry {
        recording_id: recording_id.to_string(),
        title: rec.title,
        artist,
        file_path: source.as_ref().and_then(|s| s.file_path.clone()),
        source_url: source.as_ref().and_then(|s| s.source_url.clone()),
        source_headers: stream_metadata.headers,
        stream_mime_type,
        can_seek,
        source: source_name,
        duration_ms: rec.duration_ms,
        cover_art: rec.cover_art_path.or(rec.cover_art_url),
    })
}

/// Builds queue entries for a play context. A track whose source cannot be
/// opened is skipped instead of failing the whole list; `start_index` is
/// remapped onto the entries that survived.
fn build_context(
    db: &DbPool,
    sidecar: &SidecarManager,
    cache: &StreamCache,
    recording_ids: &[String],
    start_index: usize,
) -> Result<(Vec<QueueEntry>, usize), String> {
    let mut entries = Vec::with_capacity(recording_ids.len());
    let mut start = None;
    let mut first_error = None;
    for (index, id) in recording_ids.iter().enumerate() {
        match build_queue_entry(db, sidecar, id, Some(cache)) {
            Ok(entry) if entry.file_path.is_some() || entry.source_url.is_some() => {
                if index >= start_index && start.is_none() {
                    start = Some(entries.len());
                }
                entries.push(entry);
            }
            Ok(_) => {
                first_error.get_or_insert_with(|| "No playable source for this track".to_string());
            }
            Err(error) => {
                log::warn!("skipping {id} in play context: {error}");
                first_error.get_or_insert(error);
            }
        }
    }
    if entries.is_empty() {
        return Err(first_error.unwrap_or_else(|| "Nothing to play".to_string()));
    }
    let start = start.unwrap_or(0);
    Ok((entries, start))
}

#[tauri::command]
pub async fn play_recording(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_id: String,
) -> Result<(), String> {
    let (entries, start) = build_context(&db, &sidecar, &cache, &[recording_id], 0)?;
    engine.start_queue(entries, start);
    Ok(())
}

#[tauri::command]
pub fn pause(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::Pause);
    Ok(())
}

#[tauri::command]
pub fn stop_playback(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::Stop);
    Ok(())
}

#[tauri::command]
pub fn resume(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::Resume);
    Ok(())
}

#[tauri::command]
pub fn seek(engine: State<'_, Arc<AudioEngine>>, position_ms: u64) -> Result<(), String> {
    engine.send(AudioCommand::Seek(position_ms));
    Ok(())
}

#[tauri::command]
pub fn set_volume(engine: State<'_, Arc<AudioEngine>>, volume: f32) -> Result<(), String> {
    engine.send(AudioCommand::SetVolume(volume.clamp(0.0, 1.0)));
    Ok(())
}

#[tauri::command]
pub fn next_track(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::Next);
    Ok(())
}

#[tauri::command]
pub fn prev_track(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::Prev);
    Ok(())
}

#[tauri::command]
pub fn set_shuffle(engine: State<'_, Arc<AudioEngine>>, enabled: bool) -> Result<(), String> {
    engine.send(AudioCommand::SetShuffle(enabled));
    Ok(())
}

#[tauri::command]
pub fn set_repeat(engine: State<'_, Arc<AudioEngine>>, mode: String) -> Result<(), String> {
    let repeat = match mode.as_str() {
        "one" => RepeatMode::One,
        "all" => RepeatMode::All,
        _ => RepeatMode::Off,
    };
    engine.send(AudioCommand::SetRepeat(repeat));
    Ok(())
}

#[tauri::command]
pub fn get_playback_state(engine: State<'_, Arc<AudioEngine>>) -> Result<PlaybackState, String> {
    Ok(engine.get_state())
}

#[tauri::command]
pub async fn play_tracks_from(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_ids: Vec<String>,
    start_index: usize,
) -> Result<(), String> {
    if recording_ids.is_empty() {
        return Err("Nothing to play".to_string());
    }
    let start_index = start_index.min(recording_ids.len() - 1);
    let (entries, start) = build_context(&db, &sidecar, &cache, &recording_ids, start_index)?;
    engine.start_queue(entries, start);
    Ok(())
}

#[tauri::command]
pub async fn add_to_queue(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_id: String,
) -> Result<(), String> {
    engine.send(AudioCommand::AddToQueue(build_queue_entry(
        &db,
        &sidecar,
        &recording_id,
        Some(&cache),
    )?));
    Ok(())
}

#[tauri::command]
pub async fn play_next(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_id: String,
) -> Result<(), String> {
    engine.send(AudioCommand::InsertNext(build_queue_entry(
        &db,
        &sidecar,
        &recording_id,
        Some(&cache),
    )?));
    Ok(())
}

#[tauri::command]
pub fn play_queue_index(engine: State<'_, Arc<AudioEngine>>, index: usize) -> Result<(), String> {
    let snapshot = engine.get_queue();
    if index >= snapshot.upcoming.len() {
        return Err("That Up Next item is no longer available".to_string());
    }
    engine.send(AudioCommand::PlayQueueIndex(index));
    Ok(())
}

#[tauri::command]
pub fn play_queue_entry(
    engine: State<'_, Arc<AudioEngine>>,
    session_id: String,
    entry_id: String,
) -> Result<(), String> {
    let snapshot = engine.get_queue();
    if snapshot.session_id != session_id {
        return Err("The queue changed; refresh Up Next and try again".to_string());
    }
    let exists = snapshot
        .now_playing
        .as_ref()
        .is_some_and(|item| item.entry_id == entry_id)
        || snapshot
            .upcoming
            .iter()
            .any(|item| item.entry_id == entry_id);
    if !exists {
        return Err("That Up Next item is no longer available".to_string());
    }
    engine.select_queue_entry(session_id, entry_id);
    Ok(())
}

#[tauri::command]
pub fn get_queue(engine: State<'_, Arc<AudioEngine>>) -> Result<QueueSnapshot, String> {
    Ok(engine.get_queue())
}

#[tauri::command]
pub fn remove_from_queue(engine: State<'_, Arc<AudioEngine>>, index: usize) -> Result<(), String> {
    if index >= engine.get_queue().upcoming.len() {
        return Err("That Up Next item is no longer available".to_string());
    }
    engine.send(AudioCommand::RemoveFromQueue(index));
    Ok(())
}

#[tauri::command]
pub fn remove_queue_entry(
    engine: State<'_, Arc<AudioEngine>>,
    session_id: String,
    entry_id: String,
) -> Result<(), String> {
    let snapshot = engine.get_queue();
    if snapshot.session_id != session_id {
        return Err("The queue changed; refresh Up Next and try again".to_string());
    }
    if !snapshot
        .upcoming
        .iter()
        .any(|item| item.entry_id == entry_id)
    {
        return Err("That Up Next item is no longer available".to_string());
    }
    engine.remove_queue_entry(session_id, entry_id);
    Ok(())
}

#[tauri::command]
pub fn clear_queue(engine: State<'_, Arc<AudioEngine>>) -> Result<(), String> {
    engine.send(AudioCommand::ClearQueue);
    Ok(())
}

#[tauri::command]
pub async fn get_playback_waveform(
    db: State<'_, DbPool>,
    recording_id: String,
    bins: Option<usize>,
) -> Result<PlaybackWaveform, String> {
    let (file_path, source) = resolve_waveform_source_path(&db, &recording_id)?;
    let bins = bins.unwrap_or(600);
    let shape = tauri::async_runtime::spawn_blocking(move || {
        generate_waveform(Path::new(&file_path), bins)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(PlaybackWaveform {
        recording_id,
        peaks: shape.0.clone(),
        rms: shape.1.clone(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::resample_peaks;

    #[test]
    fn resample_peaks_returns_requested_number_of_bins() {
        let input = vec![0.1, 0.5, 0.2, 0.8, 0.4, 0.6];
        let output = resample_peaks(&input, 4);

        assert_eq!(output.len(), 4);
        assert!(output.iter().all(|peak| (0.0..=1.0).contains(peak)));
        assert!(output.iter().copied().fold(0.0_f32, f32::max) > 0.9);
    }

    #[test]
    fn resample_peaks_handles_empty_input() {
        let output = resample_peaks(&[], 5);
        assert_eq!(output, vec![0.0; 5]);
    }

    /// Times opening and drawing real files, as play and the seek bar do.
    /// `MEWSIK_PROBE_FILES="a.m4a;b.mp3" cargo test waveform_timing_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn waveform_timing_probe() {
        use super::*;
        let Ok(files) = std::env::var("MEWSIK_PROBE_FILES") else { return };
        for p in files.split(';') {
            let started = std::time::Instant::now();
            let mut decoder = AudioDecoder::open_path(Path::new(p)).expect("open");
            let opened = started.elapsed();
            rodio::Source::try_seek(&mut decoder, std::time::Duration::from_secs(60)).expect("seek");
            let seeked = started.elapsed() - opened;
            let started = std::time::Instant::now();
            let (peaks, rms) = &*generate_waveform(Path::new(p), 600).expect("waveform");
            println!(
                "open {opened:?} seek {seeked:?} waveform {:?} bins {} max rms {:.2}  {p}",
                started.elapsed(),
                peaks.len(),
                rms.iter().copied().fold(0.0, f32::max)
            );
        }
    }

    /// Opens every library file the way the engine does and reports failures.
    #[test]
    #[ignore]
    fn real_library_decode_probe() {
        use super::*;
        let Ok(path) = std::env::var("MEWSIK_PROBE_DB") else { return };
        let db = crate::db::init_db(Path::new(&path)).expect("open db");
        let tracks = queries::get_library_tracks(&db).expect("tracks");
        let mut failures = std::collections::BTreeMap::<String, usize>::new();
        let mut first = std::collections::BTreeMap::<String, String>::new();
        std::panic::set_hook(Box::new(|_| {}));
        for t in &tracks {
            let Some(p) = t.local_file_path.clone() else { continue };
            let result = std::panic::catch_unwind(|| {
                let mut d = crate::audio::decoder::AudioDecoder::open_path(Path::new(&p))?;
                // pull a second of audio and seek, like playback does
                for _ in 0..88_200 { if d.next().is_none() { break; } }
                rodio::Source::try_seek(&mut d, std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;
                d.next().map(|_| ()).ok_or_else(|| "no audio after seek".to_string())
            });
            let err = match result {
                Ok(Ok(())) => continue,
                Ok(Err(e)) => e,
                Err(_) => "panic".to_string(),
            };
            let dir = Path::new(&p).components().rev().nth(2)
                .map(|c| c.as_os_str().to_string_lossy().to_string()).unwrap_or_default();
            let key = format!("{dir} | {err}");
            *failures.entry(key.clone()).or_default() += 1;
            first.entry(key).or_insert(p);
        }
        let _ = std::panic::take_hook();
        println!("checked {} tracks", tracks.len());
        for (k, n) in &failures {
            println!("{n:5}  {k}  e.g. {}", first[k]);
        }
    }

    /// Plays from a copy of a real library through the real engine and output.
    /// `MEWSIK_PROBE_DB=<copy of library.db> cargo test real_library_play_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_library_play_probe() {
        use super::*;
        let Ok(path) = std::env::var("MEWSIK_PROBE_DB") else { return };
        let db = crate::db::init_db(Path::new(&path)).expect("open db");
        let tracks = queries::get_library_tracks(&db).expect("tracks");
        let ids: Vec<String> = tracks.iter().map(|t| t.id.clone()).collect();
        println!("library tracks: {}", ids.len());
        let sidecar = SidecarManager::new();
        let cache: StreamCache = Default::default();

        let started = std::time::Instant::now();
        let mut entries = Vec::new();
        for id in &ids {
            match build_queue_entry(&db, &sidecar, id, Some(&cache)) {
                Ok(entry) => entries.push(entry),
                Err(error) => println!("build_queue_entry({id}) failed: {error}"),
            }
        }
        println!("built {} entries in {:?}", entries.len(), started.elapsed());

        let engine = AudioEngine::new(db.clone());
        let start = 5.min(entries.len().saturating_sub(1));
        println!("starting at {:?}", entries.get(start).map(|e| (&e.title, &e.file_path)));
        engine.start_queue(entries, start);
        for step in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let s = engine.get_state();
            if step % 5 == 0 || s.is_playing {
                println!(
                    "t={}ms playing={} buffering={} pos={} title={:?} stage={:?}",
                    (step + 1) * 100, s.is_playing, s.is_buffering, s.position_ms, s.current_title, s.connection_stage
                );
            }
        }
        while let Some(event) = engine.try_recv_event() {
            println!("event: {event:?}");
        }
        engine.shutdown();
    }
}
