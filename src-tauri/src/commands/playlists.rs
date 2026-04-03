use crate::db::models::*;
use crate::db::queries;
use crate::db::DbPool;
use tauri::State;

#[tauri::command]
pub fn get_playlists(db: State<'_, DbPool>) -> Result<Vec<Playlist>, String> {
    queries::get_playlists(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(
    db: State<'_, DbPool>,
    name: String,
    description: Option<String>,
) -> Result<Playlist, String> {
    let now = queries::now();
    let playlist = Playlist {
        id: queries::new_id(),
        name,
        description,
        cover_art_path: None,
        is_smart: false,
        smart_rules: None,
        created_at: now.clone(),
        updated_at: now,
    };
    queries::create_playlist(&db, &playlist).map_err(|e| e.to_string())?;
    Ok(playlist)
}

#[tauri::command]
pub fn delete_playlist(db: State<'_, DbPool>, playlist_id: String) -> Result<(), String> {
    queries::delete_playlist(&db, &playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_to_playlist(
    db: State<'_, DbPool>,
    playlist_id: String,
    recording_id: String,
) -> Result<(), String> {
    queries::add_to_playlist(&db, &playlist_id, &recording_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_from_playlist(
    db: State<'_, DbPool>,
    playlist_track_id: String,
) -> Result<(), String> {
    queries::remove_from_playlist(&db, &playlist_track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_playlist_tracks(
    db: State<'_, DbPool>,
    playlist_id: String,
) -> Result<Vec<LibraryTrack>, String> {
    queries::get_playlist_tracks(&db, &playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlist_track(
    db: State<'_, DbPool>,
    playlist_id: String,
    track_id: String,
    new_position: f64,
) -> Result<(), String> {
    queries::reorder_playlist_track(&db, &playlist_id, &track_id, new_position)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_playlist(
    db: State<'_, DbPool>,
    playlist_id: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let conn = db.lock();
    if let Some(name) = name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Playlist name cannot be empty".to_string());
        }
        conn.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![trimmed, queries::now(), playlist_id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(desc) = description {
        let trimmed = desc.trim();
        let normalized_desc = if trimmed.is_empty() {
            None::<String>
        } else {
            Some(trimmed.to_string())
        };
        conn.execute(
            "UPDATE playlists SET description = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![normalized_desc, queries::now(), playlist_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
