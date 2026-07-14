use crate::commands::settings::ConfigState;
use crate::config::AppConfig;
use crate::db::queries;
use crate::db::{models::Download, DbPool};
use crate::download::{self, DownloadManager};
use crate::sources::sidecar_manager::SidecarManager;
use crate::sources::stream_cache::StreamCache;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadLocationInfo {
    pub directory: String,
    pub default_directory: String,
    pub is_custom: bool,
    pub exists: bool,
    pub legacy_file_count: usize,
    pub legacy_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStart {
    pub id: String,
    pub directory: Option<String>,
    pub already_active: bool,
}

fn download_location_info(config: &AppConfig, db: &DbPool) -> DownloadLocationInfo {
    let directory = config.download_dir();
    let default_directory = AppConfig::default_download_dir();
    let legacy_root = AppConfig::data_dir().join("downloads");
    let canonical_legacy_root =
        std::fs::canonicalize(&legacy_root).unwrap_or_else(|_| legacy_root.clone());
    let mut legacy_file_count = 0usize;
    let mut legacy_bytes = 0u64;

    if let Ok(downloads) = queries::get_downloads(db) {
        for download in downloads {
            if download.status != "completed" {
                continue;
            }
            let Some(file_path) = download.file_path.as_deref() else {
                continue;
            };
            let path = Path::new(file_path);
            // Avoid touching arbitrary custom/network paths merely to render
            // Settings. Only legacy app-data paths are relevant to this count.
            if !path.starts_with(&legacy_root) {
                continue;
            }
            let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            if !canonical_path.starts_with(&canonical_legacy_root) {
                continue;
            }
            legacy_file_count = legacy_file_count.saturating_add(1);
            if let Ok(metadata) = path.metadata() {
                legacy_bytes = legacy_bytes.saturating_add(metadata.len());
            }
        }
    }

    DownloadLocationInfo {
        directory: directory.to_string_lossy().into_owned(),
        default_directory: default_directory.to_string_lossy().into_owned(),
        is_custom: config
            .download_directory
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty()),
        exists: directory.is_dir(),
        legacy_file_count,
        legacy_bytes,
    }
}

#[tauri::command]
pub fn get_downloads(db: State<'_, DbPool>) -> Result<Vec<Download>, String> {
    download::get_all_downloads(&db)
}

#[tauri::command]
pub async fn refresh_download_files(db: State<'_, DbPool>) -> Result<Vec<Download>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        download::reconcile_download_files(&db)?;
        download::sync_completed_download_sources(&db)?;
        download::get_all_downloads(&db)
    })
    .await
    .map_err(|error| format!("Download file check stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub fn get_download_location(
    config: State<'_, ConfigState>,
    db: State<'_, DbPool>,
) -> Result<DownloadLocationInfo, String> {
    let config = config.lock().clone();
    Ok(download_location_info(&config, &db))
}

#[tauri::command]
pub fn set_download_location(
    config: State<'_, ConfigState>,
    directory: String,
) -> Result<(), String> {
    if directory.trim().is_empty() {
        return Err("Choose a download folder".to_string());
    }
    let path = PathBuf::from(&directory);
    if !path.is_absolute() {
        return Err("Download folder must be an absolute path".to_string());
    }
    download::prepare_download_directory(&path)?;

    let mut config = config.lock();
    let previous = config.download_directory.clone();
    config.download_directory = Some(directory);
    if let Err(error) = config.save() {
        config.download_directory = previous;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn reset_download_location(config: State<'_, ConfigState>) -> Result<(), String> {
    download::prepare_download_directory(&AppConfig::default_download_dir())?;
    let mut config = config.lock();
    let previous = config.download_directory.take();
    if let Err(error) = config.save() {
        config.download_directory = previous;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_download_location(config: State<'_, ConfigState>) -> Result<(), String> {
    let directory = config.lock().download_dir();
    download::prepare_download_directory(&directory)?;
    open_folder(&directory)
}

#[tauri::command]
pub fn download_recording(
    db: State<'_, DbPool>,
    downloads: State<'_, Arc<DownloadManager>>,
    sidecar: State<'_, Arc<SidecarManager>>,
    cache: State<'_, StreamCache>,
    config: State<'_, ConfigState>,
    recording_id: String,
) -> Result<DownloadStart, String> {
    let directory = config.lock().download_dir();
    if let Some(existing) = queries::find_active_download_for_recording(&db, &recording_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(DownloadStart {
            id: existing,
            // The in-flight worker already captured its destination, which may
            // predate a Settings change. Do not falsely report the new setting.
            directory: None,
            already_active: true,
        });
    }

    let entry =
        crate::commands::playback::build_queue_entry(&db, &sidecar, &recording_id, Some(&cache))?;
    let id = download::queue_download_for_entry(
        &db,
        &downloads,
        Some(&recording_id),
        entry,
        directory.clone(),
    )?;
    Ok(DownloadStart {
        id,
        directory: Some(directory.to_string_lossy().into_owned()),
        already_active: false,
    })
}

#[tauri::command]
pub fn cancel_download(
    db: State<'_, DbPool>,
    downloads: State<'_, Arc<DownloadManager>>,
    download_id: String,
) -> Result<(), String> {
    downloads.cancel(&download_id);
    let was_cancelled = queries::cancel_download(&db, &download_id).map_err(|e| e.to_string())?;
    if was_cancelled {
        Ok(())
    } else {
        Err("Download is no longer active".to_string())
    }
}

#[tauri::command]
pub fn delete_download(
    db: State<'_, DbPool>,
    downloads: State<'_, Arc<DownloadManager>>,
    download_id: String,
) -> Result<(), String> {
    downloads.cancel(&download_id);
    download::delete_download_entry(&db, &download_id)
}

#[tauri::command]
pub fn reveal_download_path(db: State<'_, DbPool>, download_id: String) -> Result<(), String> {
    let file_path = resolve_completed_download_path(&db, &download_id)?;
    let containing_folder = file_path
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "Downloaded file has no accessible containing folder".to_string())?;

    reveal_file(&file_path, containing_folder)
}

fn resolve_completed_download_path(db: &DbPool, download_id: &str) -> Result<PathBuf, String> {
    let download = queries::get_download_by_id(db, download_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Download no longer exists".to_string())?;

    if download.status != "completed" {
        return Err("Download is not complete".to_string());
    }

    let file_path = download
        .file_path
        .map(PathBuf::from)
        .ok_or_else(|| "Completed download has no file path".to_string())?;

    if !file_path.is_file() {
        return Err("Downloaded file no longer exists".to_string());
    }

    Ok(file_path)
}

fn reveal_file(
    file_path: &std::path::Path,
    _containing_folder: &std::path::Path,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(file_path)
            .status()
            .map_err(|e| format!("Failed to reveal file in Finder: {}", e))?;

        if status.success() {
            return Ok(());
        }

        return Err("Finder failed to open the downloaded file".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // explorer.exe needs the path quoted *inside* the /select, prefix — Rust's
        // normal arg quoting would wrap the whole "/select,..." string and break parsing.
        // Also: explorer returns a non-zero exit code even on success — fire and forget.
        let raw = format!("/select,\"{}\"", file_path.display());
        std::process::Command::new("explorer.exe")
            .raw_arg(raw)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        Ok(())
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(_containing_folder)
            .status()
            .map_err(|e| format!("Failed to open download folder: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err("Failed to open download folder".to_string())
        }
    }
}

fn open_folder(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(folder)
            .status()
            .map_err(|e| format!("Failed to open download folder: {e}"))?;
        return status
            .success()
            .then_some(())
            .ok_or_else(|| "Finder failed to open the download folder".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer.exe")
            .arg(folder)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open download folder: {e}"))?;
        Ok(())
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(folder)
            .status()
            .map_err(|e| format!("Failed to open download folder: {e}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Failed to open download folder".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_completed_download_path;
    use crate::db::{
        init_memory_db,
        models::Download,
        queries::{self, insert_download},
    };
    use std::fs;

    fn insert_test_download(
        status: &str,
        file_path: Option<String>,
    ) -> (crate::db::DbPool, String) {
        let db = init_memory_db().expect("db");
        let id = queries::new_id();
        let now = queries::now();
        insert_download(
            &db,
            &Download {
                id: id.clone(),
                recording_id: None,
                source: "youtube".to_string(),
                source_url: "https://example.com/audio".to_string(),
                status: status.to_string(),
                progress: if status == "completed" { 100.0 } else { 0.0 },
                file_path,
                error_message: None,
                created_at: now.clone(),
                updated_at: now,
            },
        )
        .expect("insert download");
        (db, id)
    }

    #[test]
    fn reveal_resolves_only_a_completed_download_file() {
        let path = std::env::temp_dir().join(format!("mewsik-reveal-{}.mp3", queries::new_id()));
        fs::write(&path, b"audio").expect("write test file");
        let (db, id) = insert_test_download("completed", Some(path.to_string_lossy().into_owned()));

        assert_eq!(resolve_completed_download_path(&db, &id).unwrap(), path);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reveal_rejects_an_incomplete_download() {
        let (db, id) = insert_test_download("downloading", None);
        assert_eq!(
            resolve_completed_download_path(&db, &id).unwrap_err(),
            "Download is not complete"
        );
    }
}
