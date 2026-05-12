use crate::db::queries;
use crate::db::{models::Download, DbPool};
use crate::download::{self, DownloadManager};
use crate::sources::sidecar_manager::SidecarManager;
use crate::sources::stream_cache::StreamCache;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_downloads(db: State<'_, DbPool>) -> Result<Vec<Download>, String> {
    let _ = download::prune_missing_downloads(&db);
    let _ = download::sync_completed_download_sources(&db);
    download::get_all_downloads(&db)
}

#[tauri::command]
pub fn download_recording(
    db: State<'_, DbPool>,
    downloads: State<'_, Arc<DownloadManager>>,
    sidecar: State<'_, Arc<SidecarManager>>,
    cache: State<'_, StreamCache>,
    recording_id: String,
) -> Result<String, String> {
    if let Some(existing) = queries::find_active_download_for_recording(&db, &recording_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(existing);
    }

    let entry =
        crate::commands::playback::build_queue_entry(&db, &sidecar, &recording_id, Some(&cache))?;
    download::queue_download_for_entry(&db, &downloads, Some(&recording_id), entry)
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
pub fn reveal_download_path(path: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);
    if !file_path.exists() {
        return Err("Downloaded file no longer exists".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = if file_path.is_dir() {
            std::process::Command::new("open")
                .arg(&path)
                .status()
                .map_err(|e| format!("Failed to open Finder: {}", e))?
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .status()
                .map_err(|e| format!("Failed to reveal file in Finder: {}", e))?
        };

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
        let raw = if file_path.is_dir() {
            format!("\"{}\"", path)
        } else {
            format!("/select,\"{}\"", path)
        };
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
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to open path: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err("Failed to open downloaded file".to_string())
        }
    }
}
