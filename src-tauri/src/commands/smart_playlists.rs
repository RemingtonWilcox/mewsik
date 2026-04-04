use crate::db::models::*;
use crate::db::{queries, DbPool};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartRule {
    pub field: String,    // "genre", "artist", "year", "play_count", "added_after"
    pub operator: String, // "equals", "contains", "greater_than", "less_than"
    pub value: String,
}

#[tauri::command]
pub fn create_smart_playlist(
    db: State<'_, DbPool>,
    name: String,
    rules: Vec<SmartRule>,
) -> Result<Playlist, String> {
    let now = queries::now();
    let rules_json = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
    let playlist = Playlist {
        id: queries::new_id(),
        name,
        description: Some("Smart Playlist".to_string()),
        cover_art_path: None,
        is_smart: true,
        smart_rules: Some(rules_json),
        created_at: now.clone(),
        updated_at: now,
    };
    queries::create_playlist(&db, &playlist).map_err(|e| e.to_string())?;
    Ok(playlist)
}

#[tauri::command]
pub fn evaluate_smart_playlist(
    db: State<'_, DbPool>,
    playlist_id: String,
) -> Result<Vec<LibraryTrack>, String> {
    let playlists = queries::get_playlists(&db).map_err(|e| e.to_string())?;
    let playlist = playlists
        .into_iter()
        .find(|p| p.id == playlist_id)
        .ok_or("Playlist not found")?;

    if !playlist.is_smart {
        return queries::get_playlist_tracks(&db, &playlist_id).map_err(|e| e.to_string());
    }

    let rules_json = playlist.smart_rules.unwrap_or_default();
    let rules: Vec<SmartRule> = serde_json::from_str(&rules_json).unwrap_or_default();

    if rules.is_empty() {
        return Ok(Vec::new());
    }

    // Build dynamic WHERE clauses
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    for rule in &rules {
        match (rule.field.as_str(), rule.operator.as_str()) {
            ("genre", "contains") => {
                conditions.push("r.genre LIKE ?");
                params.push(Box::new(format!("%{}%", rule.value)));
            }
            ("year", "equals") => {
                conditions.push("r.year = ?");
                params.push(Box::new(rule.value.parse::<i32>().unwrap_or(0)));
            }
            ("year", "greater_than") => {
                conditions.push("r.year > ?");
                params.push(Box::new(rule.value.parse::<i32>().unwrap_or(0)));
            }
            ("year", "less_than") => {
                conditions.push("r.year < ?");
                params.push(Box::new(rule.value.parse::<i32>().unwrap_or(0)));
            }
            ("artist", "contains") => {
                conditions.push("a.name LIKE ?");
                params.push(Box::new(format!("%{}%", rule.value)));
            }
            _ => {}
        }
    }

    let where_clause = if conditions.is_empty() {
        "1=1".to_string()
    } else {
        conditions.join(" AND ")
    };

    let conn = db.lock();
    let query = format!(
        "SELECT r.id, r.title, COALESCE(a.name, 'Unknown Artist'), COALESCE(a.id, ''), al.title, al.id, r.duration_ms, r.cover_art_path, r.cover_art_url, r.genre, r.year,
                COALESCE((SELECT ts.source FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1), 'local'),
                COALESCE(
                    (SELECT ts.file_path FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 AND ts.file_path IS NOT NULL ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1),
                    (SELECT d.file_path FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL ORDER BY d.updated_at DESC LIMIT 1)
                )
         FROM recordings r
         LEFT JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
         LEFT JOIN artists a ON a.id = ra.artist_id
         LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
         LEFT JOIN albums al ON al.id = at2.album_id
         WHERE r.is_in_library = 1 AND {}
         ORDER BY r.title
         LIMIT 500",
        where_clause
    );

    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
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
                is_downloaded: false,
                local_file_path: row.get(12)?,
                playlist_track_id: None,
                playlist_position: None,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
