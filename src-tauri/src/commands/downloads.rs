use crate::db::queries;
use crate::db::{models::Download, DbPool};
use crate::download::{self, DownloadManager};
use crate::sources::sidecar_manager::SidecarManager;
use crate::sources::stream_cache::StreamCache;
use std::path::PathBuf;
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
