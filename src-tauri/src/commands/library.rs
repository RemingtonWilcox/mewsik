use crate::db::models::*;
use crate::db::queries;
use crate::db::DbPool;
use crate::metadata::scanner;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub total_files: u32,
    pub new_tracks: u32,
    pub updated_tracks: u32,
    pub errors: Vec<String>,
}

#[tauri::command]
pub fn scan_library(db: State<'_, DbPool>, path: String) -> Result<ScanResult, String> {
    let result = scanner::scan_directory(&db, &path);
    Ok(ScanResult {
        total_files: result.total_files,
        new_tracks: result.new_tracks,
        updated_tracks: result.updated_tracks,
        errors: result.errors,
    })
}

#[tauri::command]
pub fn get_library_tracks(db: State<'_, DbPool>) -> Result<Vec<LibraryTrack>, String> {
    queries::get_library_tracks(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_artists(db: State<'_, DbPool>) -> Result<Vec<Artist>, String> {
    queries::get_all_artists(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_albums(db: State<'_, DbPool>) -> Result<Vec<Album>, String> {
    queries::get_all_albums(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist(db: State<'_, DbPool>, artist_id: String) -> Result<Option<Artist>, String> {
    queries::get_artist(&db, &artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist_tracks(
    db: State<'_, DbPool>,
    artist_id: String,
) -> Result<Vec<LibraryTrack>, String> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, a.name, a.id, al.title, al.id, r.duration_ms, r.cover_art_path, r.cover_art_url, r.genre, r.year,
                COALESCE((SELECT ts.source FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1), 'local'),
                EXISTS(SELECT 1 FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL)
         FROM recordings r
         JOIN recording_artists ra ON ra.recording_id = r.id AND ra.artist_id = ?1
         LEFT JOIN artists a ON a.id = ra.artist_id
         LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
         LEFT JOIN albums al ON al.id = at2.album_id
         WHERE r.is_in_library = 1
         ORDER BY r.title"
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![artist_id], |row| {
            Ok(LibraryTrack {
                id: row.get(0)?,
                title: row.get(1)?,
                artist_name: row
                    .get::<_, Option<String>>(2)?
                    .unwrap_or_else(|| "Unknown Artist".to_string()),
                artist_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                album_title: row.get(4)?,
                album_id: row.get(5)?,
                duration_ms: row.get(6)?,
                cover_art_path: row.get(7)?,
                cover_art_url: row.get(8)?,
                genre: row.get(9)?,
                year: row.get(10)?,
                source: row.get(11)?,
                is_downloaded: row.get::<_, bool>(12)?,
                playlist_track_id: None,
                playlist_position: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_album_tracks(
    db: State<'_, DbPool>,
    album_id: String,
) -> Result<Vec<LibraryTrack>, String> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, COALESCE(a.name, 'Unknown Artist'), COALESCE(a.id, ''), al.title, al.id, r.duration_ms, r.cover_art_path, r.cover_art_url, r.genre, r.year,
                COALESCE((SELECT ts.source FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1), 'local'),
                EXISTS(SELECT 1 FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL)
         FROM album_tracks at2
         JOIN recordings r ON r.id = at2.recording_id
         JOIN albums al ON al.id = at2.album_id
         LEFT JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
         LEFT JOIN artists a ON a.id = ra.artist_id
         WHERE at2.album_id = ?1
         ORDER BY at2.disc_number, at2.track_number"
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![album_id], |row| {
            Ok(LibraryTrack {
                id: row.get(0)?,
                title: row.get(1)?,
                artist_name: row.get(2)?,
                artist_id: row.get(3)?,
                album_title: row.get(4)?,
                album_id: row.get(5)?,
                duration_ms: row.get(6)?,
                cover_art_path: row.get(7)?,
                cover_art_url: row.get(8)?,
                genre: row.get(9)?,
                year: row.get(10)?,
                source: row.get(11)?,
                is_downloaded: row.get::<_, bool>(12)?,
                playlist_track_id: None,
                playlist_position: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_to_library(db: State<'_, DbPool>, recording_id: String) -> Result<(), String> {
    queries::set_in_library(&db, &recording_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_from_library(db: State<'_, DbPool>, recording_id: String) -> Result<(), String> {
    queries::set_in_library(&db, &recording_id, false).map_err(|e| e.to_string())
}
