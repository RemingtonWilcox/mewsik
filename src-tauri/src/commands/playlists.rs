use crate::db::models::*;
use crate::db::queries;
use crate::db::DbPool;
use tauri::State;

#[tauri::command]
pub async fn get_playlists(db: State<'_, DbPool>) -> Result<Vec<Playlist>, String> {
    queries::get_playlists(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_playlist(
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
pub async fn delete_playlist(db: State<'_, DbPool>, playlist_id: String) -> Result<(), String> {
    queries::delete_playlist(&db, &playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_to_playlist(
    db: State<'_, DbPool>,
    playlist_id: String,
    recording_id: String,
) -> Result<(), String> {
    queries::add_to_playlist(&db, &playlist_id, &recording_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_from_playlist(
    db: State<'_, DbPool>,
    playlist_track_id: String,
) -> Result<(), String> {
    queries::remove_from_playlist(&db, &playlist_track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_playlist_tracks(
    db: State<'_, DbPool>,
    playlist_id: String,
) -> Result<Vec<LibraryTrack>, String> {
    queries::get_playlist_tracks(&db, &playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_playlist_track(
    db: State<'_, DbPool>,
    playlist_id: String,
    track_id: String,
    new_position: f64,
) -> Result<(), String> {
    queries::reorder_playlist_track(&db, &playlist_id, &track_id, new_position)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_playlist(
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

/// Most songs one link carries; links stay short enough for chat apps.
pub const MAX_SHARED_TRACKS: usize = 200;

#[tauri::command]
pub async fn get_playlist_share_items(
    db: State<'_, DbPool>,
    playlist_id: String,
) -> Result<Vec<SharedTrack>, String> {
    let mut items =
        queries::get_playlist_share_items(&db, &playlist_id).map_err(|e| e.to_string())?;
    items.truncate(MAX_SHARED_TRACKS);
    Ok(items)
}

/// For each shared song, the recording this device can play without a
/// search: a library match by title and artist, else the sender's stream.
/// `None` means the frontend still has to search for it.
#[tauri::command]
pub async fn match_shared_tracks(
    db: State<'_, DbPool>,
    tracks: Vec<SharedTrack>,
) -> Result<Vec<Option<String>>, String> {
    let mut matches = Vec::with_capacity(tracks.len().min(MAX_SHARED_TRACKS));
    for track in tracks.into_iter().take(MAX_SHARED_TRACKS) {
        let local = queries::find_recording_by_title_artist(&db, &track.title, &track.artist)
            .map_err(|e| e.to_string())?;
        let found = local.or_else(|| match (&track.source, &track.source_id) {
            (Some(source), Some(source_id))
                if matches!(source.as_str(), "youtube" | "soundcloud" | "bandcamp") =>
            {
                crate::commands::external_search::ensure_external_recording_inner(
                    &db,
                    None,
                    source.clone(),
                    source_id.clone(),
                    track.title.clone(),
                    track.artist.clone(),
                    track.duration_ms.and_then(|d| u64::try_from(d).ok()),
                    None,
                )
                .ok()
            }
            _ => None,
        });
        matches.push(found);
    }
    Ok(matches)
}

/// Creates a playlist holding these recordings in this order.
#[tauri::command]
pub async fn create_playlist_from_recordings(
    db: State<'_, DbPool>,
    name: String,
    description: Option<String>,
    recording_ids: Vec<String>,
) -> Result<Playlist, String> {
    let now = queries::now();
    let name: String = name.trim().chars().take(200).collect();
    let playlist = Playlist {
        id: queries::new_id(),
        name: if name.is_empty() {
            "Shared playlist".to_string()
        } else {
            name
        },
        description,
        cover_art_path: None,
        is_smart: false,
        smart_rules: None,
        created_at: now.clone(),
        updated_at: now,
    };
    queries::create_playlist(&db, &playlist).map_err(|e| e.to_string())?;
    for recording_id in recording_ids.iter().take(MAX_SHARED_TRACKS) {
        queries::add_to_playlist(&db, &playlist.id, recording_id).map_err(|e| e.to_string())?;
    }
    Ok(playlist)
}
