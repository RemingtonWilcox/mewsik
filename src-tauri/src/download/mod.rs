use crate::audio::queue::QueueEntry;
use crate::config::AppConfig;
use crate::db::{
    models::{Download, TrackSource},
    queries, DbPool,
};
use crate::external_tools::{find_binary, format_ffmpeg_headers};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct DownloadManager {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadManager {
    pub fn register(&self, download_id: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        self.cancellations
            .lock()
            .insert(download_id.to_string(), token.clone());
        token
    }

    pub fn cancel(&self, download_id: &str) -> bool {
        if let Some(token) = self.cancellations.lock().get(download_id).cloned() {
            token.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub fn unregister(&self, download_id: &str) {
        self.cancellations.lock().remove(download_id);
    }
}

enum DownloadError {
    Failed(String),
    Cancelled,
}

impl From<String> for DownloadError {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

fn cancelled(token: &AtomicBool) -> bool {
    token.load(Ordering::Relaxed)
}

fn sanitize_filename(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

fn should_transcode_remote_to_mp3(entry: &QueueEntry) -> bool {
    entry.file_path.is_none() && entry.source == "youtube" && entry.source_url.is_some()
}

fn infer_extension(entry: &QueueEntry) -> String {
    if should_transcode_remote_to_mp3(entry) {
        return "mp3".to_string();
    }

    if let Some(path) = entry.file_path.as_deref() {
        if let Some(ext) = Path::new(path).extension().and_then(|ext| ext.to_str()) {
            return ext.to_string();
        }
    }

    if let Some(url) = entry.source_url.as_deref() {
        let path = url.split('?').next().unwrap_or(url);
        if let Some(ext) = Path::new(path).extension().and_then(|ext| ext.to_str()) {
            if !ext.is_empty() && ext.len() <= 5 {
                return ext.to_string();
            }
        }
    }

    match entry.source.as_str() {
        "youtube" => "mp3".to_string(),
        "soundcloud" | "bandcamp" => "mp3".to_string(),
        _ => "audio".to_string(),
    }
}

fn infer_file_format_from_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_ascii_lowercase())
}

fn managed_download_metadata(original_source: &str) -> String {
    json!({
        "managed_download": true,
        "original_source": original_source
    })
    .to_string()
}

fn source_is_managed_download(source: &TrackSource) -> bool {
    source
        .metadata_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| {
            value
                .get("managed_download")
                .and_then(|flag| flag.as_bool())
        })
        .unwrap_or(false)
}

fn remove_managed_download_source_for_path(db: &DbPool, file_path: &str) -> Result<(), String> {
    let Some(source) =
        queries::find_source_by_file_path(db, file_path).map_err(|e| e.to_string())?
    else {
        return Ok(());
    };

    if source_is_managed_download(&source) {
        queries::delete_track_source(db, &source.id).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn upsert_download_source(
    db: &DbPool,
    recording_id: &str,
    original_source: &str,
    destination: &Path,
) -> Result<(), String> {
    if !destination.exists() {
        return Err(format!(
            "Downloaded file is missing: {}",
            destination.to_string_lossy()
        ));
    }

    let file_path = destination.to_string_lossy().to_string();
    let file_metadata = destination
        .metadata()
        .map_err(|e| format!("Failed to inspect downloaded file: {}", e))?;
    let file_size_bytes = i64::try_from(file_metadata.len()).ok();
    let file_format = infer_file_format_from_path(destination);
    let metadata_json = managed_download_metadata(original_source);

    if let Some(existing) =
        queries::find_source_by_file_path(db, &file_path).map_err(|e| e.to_string())?
    {
        if existing.recording_id != recording_id {
            return Err("Downloaded file is already linked to another recording".to_string());
        }

        queries::update_local_track_source_file(
            db,
            &existing.id,
            &file_path,
            file_format.as_deref(),
            file_size_bytes,
            Some(metadata_json.as_str()),
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if let Some(existing) = queries::find_managed_download_source_for_recording(db, recording_id)
        .map_err(|e| e.to_string())?
    {
        queries::update_local_track_source_file(
            db,
            &existing.id,
            &file_path,
            file_format.as_deref(),
            file_size_bytes,
            Some(metadata_json.as_str()),
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let now = queries::now();
    let source = TrackSource {
        id: queries::new_id(),
        recording_id: recording_id.to_string(),
        source: "local".to_string(),
        source_id: None,
        source_url: None,
        file_path: Some(file_path),
        file_format,
        file_size_bytes,
        bitrate: None,
        sample_rate: None,
        quality_score: 100,
        content_hash: None,
        is_available: true,
        metadata_json: Some(metadata_json),
        last_verified: Some(now.clone()),
        created_at: now.clone(),
        updated_at: now,
    };
    queries::insert_track_source(db, &source).map_err(|e| e.to_string())?;
    Ok(())
}

fn unique_output_path(dir: &Path, base_name: &str, extension: &str) -> PathBuf {
    let mut attempt = 0usize;
    loop {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!(" ({attempt})")
        };
        let filename = format!("{base_name}{suffix}.{extension}");
        let candidate = dir.join(filename);
        if !candidate.exists() {
            return candidate;
        }
        attempt += 1;
    }
}

fn copy_local_file(
    db: &DbPool,
    download_id: &str,
    source_path: &str,
    destination: &Path,
    cancel_token: &AtomicBool,
) -> Result<(), DownloadError> {
    queries::update_download_progress(db, download_id, 15.0, "processing")
        .map_err(|e| e.to_string())?;
    let mut source = File::open(source_path).map_err(|e| e.to_string())?;
    let mut destination_file = File::create(destination).map_err(|e| e.to_string())?;
    let total = source.metadata().map(|meta| meta.len()).ok();
    let mut buffer = [0u8; 64 * 1024];
    let mut written: u64 = 0;

    loop {
        if cancelled(cancel_token) {
            return Err(DownloadError::Cancelled);
        }

        let bytes_read = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }

        destination_file
            .write_all(&buffer[..bytes_read])
            .map_err(|e| e.to_string())?;
        written += bytes_read as u64;

        if let Some(total) = total {
            let progress = ((written as f64 / total as f64) * 100.0).clamp(15.0, 99.0);
            let _ = queries::update_download_progress(db, download_id, progress, "processing");
        }
    }

    if cancelled(cancel_token) {
        return Err(DownloadError::Cancelled);
    }

    queries::complete_download(db, download_id, &destination.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn fetch_remote_file(
    db: &DbPool,
    download_id: &str,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    destination: &Path,
    cancel_token: &AtomicBool,
) -> Result<(), DownloadError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut request = client.get(url).header("User-Agent", "mewsik/0.1");
    for (key, value) in headers {
        request = request.header(key, value);
    }

    let mut response = request
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch remote audio: {}", e))?;

    let total = response.content_length();
    let mut file = File::create(destination).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last_reported = 0.0;

    loop {
        if cancelled(cancel_token) {
            return Err(DownloadError::Cancelled);
        }

        let bytes_read = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }

        file.write_all(&buffer[..bytes_read])
            .map_err(|e| e.to_string())?;
        written += bytes_read as u64;

        let progress = if let Some(total) = total {
            if total == 0 {
                50.0
            } else {
                ((written as f64 / total as f64) * 100.0).clamp(1.0, 99.0)
            }
        } else {
            (last_reported + 5.0_f64).clamp(5.0_f64, 95.0_f64)
        };

        if (progress - last_reported).abs() >= 1.0 {
            last_reported = progress;
            let _ = queries::update_download_progress(db, download_id, progress, "downloading");
        }
    }

    if cancelled(cancel_token) {
        return Err(DownloadError::Cancelled);
    }

    queries::complete_download(db, download_id, &destination.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn transcode_remote_file_to_mp3(
    db: &DbPool,
    download_id: &str,
    entry: &QueueEntry,
    url: &str,
    destination: &Path,
    cancel_token: &AtomicBool,
) -> Result<(), DownloadError> {
    let ffmpeg = find_binary("ffmpeg").ok_or_else(|| {
        "ffmpeg is required for YouTube MP3 downloads but was not found".to_string()
    })?;

    let mut command = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin");

    if let Some(headers) = format_ffmpeg_headers(&entry.source_headers) {
        command.arg("-headers").arg(headers);
    }

    command
        .arg("-y")
        .arg("-i")
        .arg(url)
        .arg("-vn")
        .arg("-codec:a")
        .arg("libmp3lame")
        .arg("-q:a")
        .arg("2")
        .arg("-id3v2_version")
        .arg("3")
        .arg("-metadata")
        .arg(format!("title={}", entry.title))
        .arg("-metadata")
        .arg(format!("artist={}", entry.artist))
        .arg("-progress")
        .arg("pipe:1")
        .arg(destination)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg progress output".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg error output".to_string())?;

    let mut reader = BufReader::new(stdout);
    let total_duration_us = entry
        .duration_ms
        .and_then(|value| u64::try_from(value).ok())
        .map(|value| value.saturating_mul(1000));
    let mut last_reported = 1.0_f64;
    let mut line = String::new();

    loop {
        if cancelled(cancel_token) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DownloadError::Cancelled);
        }

        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if let Some(value) = trimmed
            .strip_prefix("out_time_us=")
            .or_else(|| trimmed.strip_prefix("out_time_ms="))
        {
            if let (Ok(processed_us), Some(total_duration_us)) =
                (value.parse::<u64>(), total_duration_us)
            {
                if total_duration_us > 0 {
                    let progress =
                        ((processed_us as f64 / total_duration_us as f64) * 100.0).clamp(1.0, 99.0);
                    if (progress - last_reported).abs() >= 1.0 {
                        last_reported = progress;
                        let _ = queries::update_download_progress(
                            db,
                            download_id,
                            progress,
                            "processing",
                        );
                    }
                }
            }
        } else if trimmed == "progress=continue" && total_duration_us.is_none() {
            let progress = (last_reported + 5.0).clamp(5.0, 95.0);
            if (progress - last_reported).abs() >= 1.0 {
                last_reported = progress;
                let _ = queries::update_download_progress(db, download_id, progress, "processing");
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let mut stderr_output = String::new();
    let _ = stderr.read_to_string(&mut stderr_output);

    if cancelled(cancel_token) {
        return Err(DownloadError::Cancelled);
    }

    if !status.success() {
        let message = stderr_output.trim();
        if message.is_empty() {
            return Err(DownloadError::Failed(
                "ffmpeg failed to transcode the YouTube download".to_string(),
            ));
        }
        return Err(DownloadError::Failed(format!(
            "ffmpeg failed to transcode the YouTube download: {}",
            message
        )));
    }

    queries::complete_download(db, download_id, &destination.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn sync_completed_download_source_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<(), String> {
    let Some(download) = queries::get_latest_completed_download_for_recording(db, recording_id)
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };

    let Some(path) = download.file_path.as_deref() else {
        return Ok(());
    };

    upsert_download_source(db, recording_id, &download.source, Path::new(path))
}

pub fn sync_completed_download_sources(db: &DbPool) -> Result<(), String> {
    let downloads = queries::get_downloads(db).map_err(|e| e.to_string())?;
    for download in downloads {
        if download.status != "completed" {
            continue;
        }
        let Some(recording_id) = download.recording_id.as_deref() else {
            continue;
        };
        let Some(file_path) = download.file_path.as_deref() else {
            continue;
        };
        if Path::new(file_path).exists() {
            let _ =
                upsert_download_source(db, recording_id, &download.source, Path::new(file_path));
        }
    }
    Ok(())
}

pub fn prune_missing_downloads(db: &DbPool) -> Result<(), String> {
    let downloads = queries::get_downloads(db).map_err(|e| e.to_string())?;
    for download in downloads {
        if download.status != "completed" {
            continue;
        }

        let Some(file_path) = download.file_path.as_deref() else {
            continue;
        };

        if Path::new(file_path).exists() {
            continue;
        }

        let _ = remove_managed_download_source_for_path(db, file_path);
        queries::delete_download(db, &download.id).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn delete_download_entry(db: &DbPool, download_id: &str) -> Result<(), String> {
    let Some(download) = queries::get_download_by_id(db, download_id).map_err(|e| e.to_string())?
    else {
        return Err("Download no longer exists".to_string());
    };

    if matches!(
        download.status.as_str(),
        "pending" | "downloading" | "processing"
    ) {
        return Err("Active downloads must be cancelled first".to_string());
    }

    if let Some(file_path) = download.file_path.as_deref() {
        let path = Path::new(file_path);
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to delete downloaded file: {}", e))?;
        }
        let _ = remove_managed_download_source_for_path(db, file_path);
    }

    queries::delete_download(db, download_id).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn queue_download_for_entry(
    db: &DbPool,
    manager: &Arc<DownloadManager>,
    recording_id: Option<&str>,
    entry: QueueEntry,
) -> Result<String, String> {
    let now = queries::now();
    let source_url = entry
        .file_path
        .clone()
        .or(entry.source_url.clone())
        .ok_or_else(|| "No downloadable source for this recording".to_string())?;

    let download = Download {
        id: queries::new_id(),
        recording_id: recording_id.map(|value| value.to_string()),
        source: entry.source.clone(),
        source_url,
        status: "pending".to_string(),
        progress: 0.0,
        file_path: None,
        error_message: None,
        created_at: now.clone(),
        updated_at: now,
    };
    queries::insert_download(db, &download).map_err(|e| e.to_string())?;

    let db = db.clone();
    let manager = manager.clone();
    let recording_id = recording_id.map(str::to_string);
    let download_id = download.id.clone();
    let cancel_token = manager.register(&download_id);
    let worker_manager = manager.clone();
    let worker_download_id = download_id.clone();
    std::thread::Builder::new()
        .name(format!("download-{}", download.id))
        .spawn(move || {
            if let Err(err) =
                queries::update_download_progress(&db, &worker_download_id, 1.0, "downloading")
                    .map_err(|e| e.to_string())
            {
                let _ = queries::fail_download(&db, &worker_download_id, &err);
                return;
            }

            let downloads_dir = AppConfig::data_dir().join("downloads");
            if let Err(err) = std::fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string()) {
                let _ = queries::fail_download(&db, &worker_download_id, &err);
                return;
            }

            let base_name = sanitize_filename(&format!("{} - {}", entry.artist, entry.title));
            let extension = infer_extension(&entry);
            let destination = unique_output_path(&downloads_dir, &base_name, &extension);

            let result = if let Some(path) = entry.file_path.as_deref() {
                copy_local_file(&db, &worker_download_id, path, &destination, &cancel_token)
            } else if should_transcode_remote_to_mp3(&entry) {
                transcode_remote_file_to_mp3(
                    &db,
                    &worker_download_id,
                    &entry,
                    entry.source_url.as_deref().unwrap_or_default(),
                    &destination,
                    &cancel_token,
                )
            } else if let Some(url) = entry.source_url.as_deref() {
                fetch_remote_file(
                    &db,
                    &worker_download_id,
                    url,
                    &entry.source_headers,
                    &destination,
                    &cancel_token,
                )
            } else {
                Err(DownloadError::Failed(
                    "No downloadable source for this recording".to_string(),
                ))
            };

            if let Err(err) = result {
                let _ = std::fs::remove_file(&destination);
                match err {
                    DownloadError::Cancelled => {
                        let _ = queries::cancel_download(&db, &worker_download_id);
                    }
                    DownloadError::Failed(message) => {
                        let _ = queries::fail_download(&db, &worker_download_id, &message);
                    }
                }
            } else if let Some(recording_id) = recording_id.as_deref() {
                let _ = upsert_download_source(&db, recording_id, &entry.source, &destination);
                let _ = crate::db::queries::set_in_library(&db, recording_id, true);
            }

            worker_manager.unregister(&worker_download_id);
        })
        .map_err(|e| {
            manager.unregister(&download_id);
            format!("Failed to spawn download worker: {}", e)
        })?;

    Ok(download.id)
}

pub fn get_all_downloads(db: &DbPool) -> Result<Vec<Download>, String> {
    queries::get_downloads(db).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{infer_extension, sync_completed_download_source_for_recording};
    use crate::audio::queue::QueueEntry;
    use crate::db::{
        init_memory_db,
        models::{Download, Recording},
        queries,
    };
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn completed_download_is_promoted_to_local_track_source() {
        let db = init_memory_db().expect("db");
        let now = queries::now();
        let recording_id = queries::new_id();
        let recording = Recording {
            id: recording_id.clone(),
            title: "Downloaded Track".to_string(),
            duration_ms: Some(180_000),
            year: None,
            genre: None,
            cover_art_path: None,
            cover_art_url: None,
            loudness_lufs: None,
            musicbrainz_id: None,
            metadata_json: None,
            is_in_library: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        queries::insert_recording(&db, &recording).expect("insert recording");

        let temp_path = std::env::temp_dir().join(format!("mewsik-test-{}.mp3", queries::new_id()));
        fs::write(&temp_path, b"fake audio").expect("write temp file");

        let download = Download {
            id: queries::new_id(),
            recording_id: Some(recording_id.clone()),
            source: "soundcloud".to_string(),
            source_url: "https://example.com/file.mp3".to_string(),
            status: "completed".to_string(),
            progress: 100.0,
            file_path: Some(temp_path.to_string_lossy().to_string()),
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
        };
        queries::insert_download(&db, &download).expect("insert download");

        sync_completed_download_source_for_recording(&db, &recording_id).expect("sync");

        let best_source = queries::get_best_source(&db, &recording_id)
            .expect("get best source")
            .expect("source exists");
        assert_eq!(best_source.source, "local");
        assert_eq!(
            best_source.file_path.as_deref(),
            download.file_path.as_deref()
        );

        let _ = fs::remove_file(temp_path);
    }

    #[test]
    fn youtube_remote_downloads_target_mp3_extension() {
        let entry = QueueEntry {
            recording_id: queries::new_id(),
            title: "Track".to_string(),
            artist: "Artist".to_string(),
            file_path: None,
            source_url: Some("https://example.com/stream".to_string()),
            source_headers: HashMap::new(),
            stream_mime_type: Some("audio/mp4".to_string()),
            can_seek: false,
            source: "youtube".to_string(),
            duration_ms: Some(180_000),
            cover_art: None,
        };

        assert_eq!(infer_extension(&entry), "mp3");
    }
}
