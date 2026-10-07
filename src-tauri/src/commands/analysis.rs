//! Visual-score commands: fetch the cached per-track analysis, or kick off
//! a background analysis pass. Analysis is CPU-bound (full decode + STFT),
//! so it runs on a dedicated std thread, never on the async runtime.

use crate::analysis::{analyze_file, ANALYSIS_VERSION};
use crate::db::{queries, DbPool};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};

fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

#[tauri::command]
pub fn get_track_analysis(
    db: State<'_, DbPool>,
    recording_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let json = queries::get_track_analysis(&db, &recording_id, ANALYSIS_VERSION)
        .map_err(|e| e.to_string())?;
    match json {
        Some(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("corrupt cached score: {}", e)),
        None => Ok(None),
    }
}

/// Returns "cached" | "started" | "unavailable" so the frontend knows
/// whether to wait for an `analysis:complete` event.
#[tauri::command]
pub fn request_track_analysis(
    app: AppHandle,
    db: State<'_, DbPool>,
    recording_id: String,
) -> Result<String, String> {
    if queries::get_track_analysis(&db, &recording_id, ANALYSIS_VERSION)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok("cached".to_string());
    }

    let Some(file_path) =
        queries::get_local_file_for_recording(&db, &recording_id).map_err(|e| e.to_string())?
    else {
        // No local bytes — streamed-only track. The director falls back to
        // the live FSM. (Analyzing fetched remote bytes is Phase 2b.)
        return Ok("unavailable".to_string());
    };

    {
        let mut set = in_flight().lock();
        if !set.insert(recording_id.clone()) {
            return Ok("started".to_string()); // already analyzing
        }
    }

    let db = db.inner().clone();
    std::thread::Builder::new()
        .name("track-analysis".to_string())
        .spawn(move || {
            let started = std::time::Instant::now();
            let result = analyze_file(&PathBuf::from(&file_path));
            in_flight().lock().remove(&recording_id);
            match result {
                Ok(score) => match serde_json::to_string(&score) {
                    Ok(json) => {
                        if let Err(e) = queries::upsert_track_analysis(
                            &db,
                            &recording_id,
                            ANALYSIS_VERSION,
                            &json,
                        ) {
                            log::warn!("analysis cache write failed: {}", e);
                            return;
                        }
                        log::info!(
                            "analyzed {} in {:.1}s — {} sections, {} drops, {:.0} bpm (conf {:.2})",
                            recording_id,
                            started.elapsed().as_secs_f32(),
                            score.sections.len(),
                            score.drops.len(),
                            score.bpm,
                            score.beat_confidence
                        );
                        let _ = app.emit(
                            "analysis:complete",
                            serde_json::json!({ "recording_id": recording_id }),
                        );
                    }
                    Err(e) => log::warn!("score serialization failed: {}", e),
                },
                Err(e) => log::warn!("track analysis failed for {}: {}", recording_id, e),
            }
        })
        .map_err(|e| format!("spawn analysis thread: {}", e))?;

    Ok("started".to_string())
}
