use crate::audio::queue::QueueEntry;
use crate::db::{
    models::{Download, TrackSource},
    queries, DbPool,
};
use crate::external_tools::{find_binary, format_ffmpeg_headers};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
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
    if !destination.is_file() {
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

pub fn prepare_download_directory(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create download folder {}: {e}", dir.display()))?;
    if !dir.is_dir() {
        return Err(format!(
            "Download location is not a folder: {}",
            dir.display()
        ));
    }

    let probe = dir.join(format!(".mewsik-write-test-{}", ulid::Ulid::new()));
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|e| format!("Download folder is not writable ({}): {e}", dir.display()))?;
    std::fs::remove_file(&probe).map_err(|e| {
        format!(
            "Could not finish checking download folder {}: {e}",
            dir.display()
        )
    })?;
    Ok(())
}

fn reserve_unique_output_path(
    dir: &Path,
    base_name: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let mut attempt = 0usize;
    loop {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!(" ({attempt})")
        };
        let filename = format!("{base_name}{suffix}.{extension}");
        let candidate = dir.join(filename);
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt = attempt.saturating_add(1);
            }
            Err(error) => {
                return Err(format!(
                    "Could not reserve download file {}: {error}",
                    candidate.display()
                ));
            }
        }
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
    let downloads =
        queries::get_download_files_for_recording(db, recording_id).map_err(|e| e.to_string())?;
    let mut newest_available = None;

    // Playback calls this immediately before choosing a source. Reconcile only
    // this recording so a drive unplugged after startup cannot leave a stale
    // local file preferred over an available remote stream, while a reconnected
    // drive becomes usable again without a global scan.
    for download in downloads {
        let Some(file_path) = download.file_path.as_deref() else {
            continue;
        };
        let path = Path::new(file_path);
        if path.is_file() {
            if download.status == "missing" {
                queries::complete_download(db, &download.id, file_path)
                    .map_err(|e| e.to_string())?;
            }
            if newest_available.is_none() {
                newest_available = Some((download.source, path.to_path_buf()));
            }
            continue;
        }

        if let Some(source) =
            queries::find_source_by_file_path(db, file_path).map_err(|e| e.to_string())?
        {
            if source_is_managed_download(&source) {
                queries::set_track_source_file_availability(db, file_path, false)
                    .map_err(|e| e.to_string())?;
            }
        }
        if download.status == "completed" {
            queries::mark_download_missing(
                db,
                &download.id,
                &format!("File is unavailable at {file_path}"),
            )
            .map_err(|e| e.to_string())?;
        }
    }

    if let Some((source, path)) = newest_available {
        upsert_download_source(db, recording_id, &source, &path)?;
    }
    Ok(())
}

pub fn sync_completed_download_sources(db: &DbPool) -> Result<(), String> {
    let downloads = queries::get_downloads(db).map_err(|e| e.to_string())?;
    let mut synchronized_recordings = std::collections::HashSet::new();
    for download in downloads {
        if download.status != "completed" {
            continue;
        }
        let Some(recording_id) = download.recording_id.as_deref() else {
            continue;
        };
        // get_downloads is newest-first. A recording can have older completed
        // retries at different locations; the newest available file owns the
        // single managed local source instead of being overwritten by history.
        if synchronized_recordings.contains(recording_id) {
            continue;
        }
        let Some(file_path) = download.file_path.as_deref() else {
            continue;
        };
        if Path::new(file_path).is_file() {
            upsert_download_source(db, recording_id, &download.source, Path::new(file_path))?;
            synchronized_recordings.insert(recording_id.to_string());
        }
    }
    Ok(())
}

pub fn reconcile_download_files(db: &DbPool) -> Result<(), String> {
    let downloads = queries::get_downloads(db).map_err(|e| e.to_string())?;
    for download in downloads {
        if !matches!(download.status.as_str(), "completed" | "missing") {
            continue;
        }

        let Some(file_path) = download.file_path.as_deref() else {
            continue;
        };

        if Path::new(file_path).is_file() {
            if download.status == "missing" {
                queries::complete_download(db, &download.id, file_path)
                    .map_err(|e| e.to_string())?;
                if let Some(recording_id) = download.recording_id.as_deref() {
                    let _ = upsert_download_source(
                        db,
                        recording_id,
                        &download.source,
                        Path::new(file_path),
                    );
                }
            }
            continue;
        }

        if download.status == "completed" {
            if let Some(source) =
                queries::find_source_by_file_path(db, file_path).map_err(|e| e.to_string())?
            {
                if source_is_managed_download(&source) {
                    queries::set_track_source_file_availability(db, file_path, false)
                        .map_err(|e| e.to_string())?;
                }
            }
            queries::mark_download_missing(
                db,
                &download.id,
                &format!("File is unavailable at {file_path}"),
            )
            .map_err(|e| e.to_string())?;
        }
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
    downloads_dir: PathBuf,
) -> Result<String, String> {
    // Resolve and validate before inserting a job. An unavailable custom drive
    // should not leave behind a permanently failed phantom download.
    prepare_download_directory(&downloads_dir)?;

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

            let base_name = sanitize_filename(&format!("{} - {}", entry.artist, entry.title));
            let extension = infer_extension(&entry);
            let destination =
                match reserve_unique_output_path(&downloads_dir, &base_name, &extension) {
                    Ok(destination) => destination,
                    Err(error) => {
                        let _ = queries::fail_download(&db, &worker_download_id, &error);
                        worker_manager.unregister(&worker_download_id);
                        return;
                    }
                };

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
    use super::{
        infer_extension, prepare_download_directory, queue_download_for_entry,
        reconcile_download_files, reserve_unique_output_path,
        sync_completed_download_source_for_recording, sync_completed_download_sources,
        DownloadManager,
    };
    use crate::audio::queue::QueueEntry;
    use crate::db::{
        init_memory_db,
        models::{Download, Recording, TrackSource},
        queries,
    };
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;

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

    #[test]
    fn missing_download_records_are_preserved_and_restore_when_the_file_returns() {
        let db = init_memory_db().expect("db");
        let now = queries::now();
        let recording_id = queries::new_id();
        queries::insert_recording(
            &db,
            &Recording {
                id: recording_id.clone(),
                title: "Portable Track".to_string(),
                duration_ms: Some(90_000),
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
            },
        )
        .expect("insert recording");

        queries::insert_track_source(
            &db,
            &TrackSource {
                id: queries::new_id(),
                recording_id: recording_id.clone(),
                source: "youtube".to_string(),
                source_id: Some("portable-remote".to_string()),
                source_url: Some("https://example.com/audio".to_string()),
                file_path: None,
                file_format: Some("audio/mp4".to_string()),
                file_size_bytes: None,
                bitrate: None,
                sample_rate: None,
                quality_score: 80,
                content_hash: None,
                is_available: true,
                metadata_json: None,
                last_verified: Some(now.clone()),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
        )
        .expect("insert remote fallback");

        let path = std::env::temp_dir().join(format!("mewsik-missing-{}.mp3", queries::new_id()));
        fs::write(&path, b"audio").expect("write managed download");
        let download = Download {
            id: queries::new_id(),
            recording_id: Some(recording_id.clone()),
            source: "youtube".to_string(),
            source_url: "https://example.com/audio".to_string(),
            status: "completed".to_string(),
            progress: 100.0,
            file_path: Some(path.to_string_lossy().into_owned()),
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
        };
        queries::insert_download(&db, &download).expect("insert download");
        sync_completed_download_source_for_recording(&db, &recording_id)
            .expect("create managed source");

        fs::remove_file(&path).expect("disconnect file");
        sync_completed_download_source_for_recording(&db, &recording_id)
            .expect("playback-boundary reconciliation marks file unavailable");

        let missing = queries::get_download_by_id(&db, &download.id)
            .expect("read download")
            .expect("download row must be preserved");
        assert_eq!(missing.status, "missing");
        let unavailable_source = queries::find_source_by_file_path(
            &db,
            download.file_path.as_deref().expect("file path"),
        )
        .expect("read managed source")
        .expect("managed source row must be preserved");
        assert!(!unavailable_source.is_available);
        let fallback = queries::get_best_source(&db, &recording_id)
            .expect("read fallback")
            .expect("remote source remains available");
        assert_eq!(fallback.source, "youtube");
        assert!(fallback.file_path.is_none());

        fs::write(&path, b"audio restored").expect("restore file");
        sync_completed_download_source_for_recording(&db, &recording_id)
            .expect("playback-boundary reconciliation restores file availability");
        let restored = queries::get_download_by_id(&db, &download.id)
            .expect("read restored download")
            .expect("download still exists");
        assert_eq!(restored.status, "completed");
        let restored_source = queries::find_source_by_file_path(
            &db,
            download.file_path.as_deref().expect("file path"),
        )
        .expect("read restored source")
        .expect("managed source still exists");
        assert!(restored_source.is_available);
        let restored_best = queries::get_best_source(&db, &recording_id)
            .expect("read restored best source")
            .expect("restored local source wins");
        assert_eq!(restored_best.source, "local");
        assert_eq!(
            restored_best.file_path.as_deref(),
            download.file_path.as_deref()
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn directory_at_saved_audio_path_is_treated_as_missing() {
        let db = init_memory_db().expect("db");
        let path =
            std::env::temp_dir().join(format!("mewsik-directory-audio-{}.mp3", queries::new_id()));
        fs::create_dir_all(&path).expect("create directory at audio path");
        let download = Download {
            id: queries::new_id(),
            recording_id: None,
            source: "soundcloud".to_string(),
            source_url: "https://example.com/not-a-directory".to_string(),
            status: "completed".to_string(),
            progress: 100.0,
            file_path: Some(path.to_string_lossy().into_owned()),
            error_message: None,
            created_at: "2026-07-14T10:00:00Z".to_string(),
            updated_at: "2026-07-14T10:00:00Z".to_string(),
        };
        queries::insert_download(&db, &download).expect("insert download");

        reconcile_download_files(&db).expect("reconcile directory path");

        let reconciled = queries::get_download_by_id(&db, &download.id)
            .expect("read download")
            .expect("download is preserved");
        assert_eq!(reconciled.status, "missing");
        fs::remove_dir_all(path).expect("remove test directory");
    }

    #[test]
    fn newest_available_retry_owns_the_managed_local_source() {
        let db = init_memory_db().expect("db");
        let recording_id = queries::new_id();
        queries::insert_recording(
            &db,
            &Recording {
                id: recording_id.clone(),
                title: "Retried Track".to_string(),
                duration_ms: Some(120_000),
                year: None,
                genre: None,
                cover_art_path: None,
                cover_art_url: None,
                loudness_lufs: None,
                musicbrainz_id: None,
                metadata_json: None,
                is_in_library: true,
                created_at: "2026-07-14T09:00:00Z".to_string(),
                updated_at: "2026-07-14T09:00:00Z".to_string(),
            },
        )
        .expect("insert recording");

        let root = std::env::temp_dir().join(format!("mewsik-retries-{}", queries::new_id()));
        fs::create_dir_all(&root).expect("create retry root");
        let old_path = root.join("old.mp3");
        let new_path = root.join("new.mp3");
        fs::write(&old_path, b"old audio").expect("write old retry");
        fs::write(&new_path, b"new audio").expect("write new retry");

        for (id, path, created_at) in [
            ("old", &old_path, "2026-07-14T10:00:00Z"),
            ("new", &new_path, "2026-07-14T11:00:00Z"),
        ] {
            queries::insert_download(
                &db,
                &Download {
                    id: format!("{id}-{}", queries::new_id()),
                    recording_id: Some(recording_id.clone()),
                    source: "youtube".to_string(),
                    source_url: format!("https://example.com/{id}"),
                    status: "completed".to_string(),
                    progress: 100.0,
                    file_path: Some(path.to_string_lossy().into_owned()),
                    error_message: None,
                    created_at: created_at.to_string(),
                    updated_at: created_at.to_string(),
                },
            )
            .expect("insert retry");
        }

        sync_completed_download_sources(&db).expect("synchronize retries");

        let source = queries::get_best_source(&db, &recording_id)
            .expect("read source")
            .expect("managed local source exists");
        assert_eq!(
            source.file_path.as_deref(),
            Some(new_path.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(root).expect("remove retry root");
    }

    #[test]
    fn concurrent_same_name_reservations_never_share_a_file() {
        let root = std::env::temp_dir().join(format!("mewsik-reserve-{}", queries::new_id()));
        prepare_download_directory(&root).expect("prepare destination");

        let handles = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    reserve_unique_output_path(&root, "Artist - Track", "mp3")
                        .expect("reserve unique file")
                })
            })
            .collect::<Vec<_>>();
        let paths = handles
            .into_iter()
            .map(|handle| handle.join().expect("reservation thread"))
            .collect::<HashSet<_>>();

        assert_eq!(paths.len(), 8);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queued_job_keeps_the_destination_captured_at_queue_time() {
        let db = init_memory_db().expect("db");
        let manager = std::sync::Arc::new(DownloadManager::default());
        let root = std::env::temp_dir().join(format!("mewsik-captured-{}", queries::new_id()));
        let first_destination = root.join("first");
        let later_setting = root.join("later");
        let source = root.join("source.mp3");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, b"captured destination audio").expect("write source");

        let entry = QueueEntry {
            recording_id: queries::new_id(),
            title: "Captured Track".to_string(),
            artist: "Artist".to_string(),
            file_path: Some(source.to_string_lossy().into_owned()),
            source_url: None,
            source_headers: HashMap::new(),
            stream_mime_type: Some("audio/mpeg".to_string()),
            can_seek: true,
            source: "local".to_string(),
            duration_ms: Some(5_000),
            cover_art: None,
        };
        let download_id =
            queue_download_for_entry(&db, &manager, None, entry, first_destination.clone())
                .expect("queue download");

        // A later Settings change creates a different folder, but the worker
        // owns the path supplied above and must not re-read mutable config.
        prepare_download_directory(&later_setting).expect("prepare later setting");

        let completed = (0..200).find_map(|_| {
            let download = queries::get_download_by_id(&db, &download_id)
                .expect("read queued download")
                .expect("download exists");
            if download.status == "completed" {
                Some(download)
            } else {
                std::thread::sleep(std::time::Duration::from_millis(10));
                None
            }
        });
        let completed = completed.expect("download should complete");
        let output = PathBuf::from(completed.file_path.expect("completed path"));

        assert!(output.starts_with(&first_destination));
        assert!(!output.starts_with(&later_setting));
        let _ = fs::remove_dir_all(root);
    }
}
