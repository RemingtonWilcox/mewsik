use crate::audio::engine::{AudioCommand, AudioEngine};
use crate::audio::queue::{QueueEntry, RepeatMode};
use crate::db::models::{PlaybackState, QueueSnapshot};
use crate::db::{queries, DbPool};
use crate::discovery::recommendations::RecommendationEngine;
use crate::download;
use crate::sources::sidecar_manager::SidecarManager;
use crate::sources::stream_cache::StreamCache;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
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

fn generate_waveform_peaks(path: &Path, bins: usize) -> Result<Vec<f32>, String> {
    const WINDOW_FRAMES: usize = 2048;

    let file = File::open(path).map_err(|e| format!("Failed to open audio file: {}", e))?;
    let media_source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Failed to probe audio file: {}", e))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "No audio track found in file".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let mut window_peaks = Vec::new();
    let mut current_window_peak = 0.0_f32;
    let mut frames_in_window = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("Waveform decoding reset is not supported".to_string());
            }
            Err(err) => return Err(format!("Failed to read audio packet: {}", err)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("Waveform decoding reset is not supported".to_string());
            }
            Err(err) => return Err(format!("Failed to decode audio packet: {}", err)),
        };

        let spec = *decoded.spec();
        let channel_count = spec.channels.count().max(1);
        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        for frame in sample_buf.samples().chunks(channel_count) {
            let amplitude = frame
                .iter()
                .fold(0.0_f32, |max_amp, sample| max_amp.max(sample.abs()));
            current_window_peak = current_window_peak.max(amplitude);
            frames_in_window += 1;

            if frames_in_window >= WINDOW_FRAMES {
                window_peaks.push(current_window_peak);
                current_window_peak = 0.0;
                frames_in_window = 0;
            }
        }
    }

    if frames_in_window > 0 {
        window_peaks.push(current_window_peak);
    }

    Ok(resample_peaks(&window_peaks, bins.clamp(24, 256)))
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

const SINGLE_TRACK_CONTINUATION_LIMIT: usize = 8;
const SINGLE_TRACK_CANDIDATE_SCAN_LIMIT: usize = 24;
const SINGLE_TRACK_READY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);
const SINGLE_TRACK_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Expands a one-song context without delaying its start. Candidate selection
/// is deterministic and database-only. Building a queue entry may refresh an
/// expired provider URL, but this worker never fetches or decodes audio for a
/// future track; actual media work remains demand-driven in the audio engine.
pub(crate) fn spawn_deterministic_continuation(
    db: &DbPool,
    sidecar: &Arc<SidecarManager>,
    engine: &Arc<AudioEngine>,
    cache: &StreamCache,
    session_id: String,
    anchor_recording_id: String,
) {
    let worker_db = db.clone();
    let worker_sidecar = Arc::clone(sidecar);
    let worker_engine = Arc::clone(engine);
    let worker_cache = cache.clone();

    if let Err(error) = std::thread::Builder::new()
        .name("single-track-continuation".to_string())
        .spawn(move || {
            // The app uses one mutex-protected SQLite connection. Let the audio
            // worker finish its start/history transaction before running the
            // larger recommendation query, or a fast helper can make pressing
            // Play feel slower on a large library.
            let readiness_deadline = std::time::Instant::now() + SINGLE_TRACK_READY_TIMEOUT;
            loop {
                if !worker_engine.queue_session_can_still_start_continuation(
                    &session_id,
                    &anchor_recording_id,
                ) || std::time::Instant::now() >= readiness_deadline
                {
                    return;
                }
                if worker_engine
                    .queue_session_is_ready_for_continuation(&session_id, &anchor_recording_id)
                {
                    break;
                }
                std::thread::sleep(SINGLE_TRACK_READY_POLL_INTERVAL);
            }

            let candidate_ids = match RecommendationEngine::new(worker_db.clone())
                .continuation_recording_ids(
                    &anchor_recording_id,
                    SINGLE_TRACK_CANDIDATE_SCAN_LIMIT,
                )
            {
                Ok(ids) => ids,
                Err(error) => {
                    log::debug!(
                        "Could not build continuation for {anchor_recording_id}: {error}"
                    );
                    return;
                }
            };

            let mut prepared = Vec::with_capacity(SINGLE_TRACK_CONTINUATION_LIMIT - 1);
            let mut published = 0usize;
            for candidate_id in candidate_ids {
                if published + prepared.len() >= SINGLE_TRACK_CONTINUATION_LIMIT
                    || !worker_engine.queue_session_is_current(&session_id)
                {
                    break;
                }

                match build_queue_entry(
                    &worker_db,
                    &worker_sidecar,
                    &candidate_id,
                    Some(&worker_cache),
                ) {
                    Ok(entry) if entry.file_path.is_some() || entry.source_url.is_some() => {
                        if published == 0 {
                            // Make the first playable successor visible as soon
                            // as it is ready. A slow provider refresh for a later
                            // suggestion must never leave the active song with
                            // an empty Up Next queue.
                            worker_engine
                                .append_context_if_session(session_id.clone(), vec![entry]);
                            published = 1;
                        } else {
                            prepared.push(entry);
                        }
                    }
                    Ok(_) => {
                        log::debug!(
                            "Skipping continuation candidate without a playable source: {candidate_id}"
                        );
                    }
                    Err(error) => {
                        log::debug!(
                            "Skipping continuation candidate {candidate_id}: {error}"
                        );
                    }
                }
            }

            if !prepared.is_empty() && worker_engine.queue_session_is_current(&session_id) {
                // Append the remaining batch behind anything the listener may
                // have manually queued while provider URLs were resolving.
                // Queue V2 shuffles only this new batch when shuffle is active.
                worker_engine.append_context_if_session(session_id, prepared);
            }
        })
    {
        // Playback already started. Continuation is intentionally best-effort.
        log::warn!("Failed to start single-track continuation worker: {error}");
    }
}

#[tauri::command]
pub fn play_recording(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_id: String,
) -> Result<(), String> {
    let entry = build_queue_entry(&db, &sidecar, &recording_id, Some(&cache))?;
    if entry.file_path.is_none() && entry.source_url.is_none() {
        return Err("No playable source for this recording".to_string());
    }

    let session_id = engine.start_queue(vec![entry], 0);
    spawn_deterministic_continuation(
        db.inner(),
        sidecar.inner(),
        engine.inner(),
        cache.inner(),
        session_id,
        recording_id,
    );
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
pub fn play_tracks_from(
    db: State<'_, DbPool>,
    sidecar: State<'_, Arc<SidecarManager>>,
    engine: State<'_, Arc<AudioEngine>>,
    cache: State<'_, StreamCache>,
    recording_ids: Vec<String>,
    start_index: usize,
) -> Result<(), String> {
    if recording_ids.is_empty() {
        return Err("Playback context is empty".to_string());
    }
    if start_index >= recording_ids.len() {
        return Err(format!(
            "Playback start index {start_index} is outside a {}-track context",
            recording_ids.len()
        ));
    }

    let mut queue_entries = Vec::new();
    for id in &recording_ids {
        queue_entries.push(build_queue_entry(&db, &sidecar, id, Some(&cache))?);
    }

    let single_anchor = (recording_ids.len() == 1).then(|| recording_ids[start_index].clone());
    let session_id = engine.start_queue(queue_entries, start_index);
    if let Some(anchor_recording_id) = single_anchor {
        spawn_deterministic_continuation(
            db.inner(),
            sidecar.inner(),
            engine.inner(),
            cache.inner(),
            session_id,
            anchor_recording_id,
        );
    }
    Ok(())
}

#[tauri::command]
pub fn add_to_queue(
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
pub fn play_next(
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
pub fn get_playback_waveform(
    db: State<'_, DbPool>,
    recording_id: String,
    bins: Option<usize>,
) -> Result<PlaybackWaveform, String> {
    let (file_path, source) = resolve_waveform_source_path(&db, &recording_id)?;
    let peaks = generate_waveform_peaks(Path::new(&file_path), bins.unwrap_or(144))?;

    Ok(PlaybackWaveform {
        recording_id,
        peaks,
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
}
