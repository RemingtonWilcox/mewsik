use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub duration_ms: Option<i64>,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub cover_art_path: Option<String>,
    pub cover_art_url: Option<String>,
    pub loudness_lufs: Option<f64>,
    pub musicbrainz_id: Option<String>,
    pub metadata_json: Option<String>,
    pub is_in_library: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub sort_name: Option<String>,
    pub musicbrainz_id: Option<String>,
    pub image_path: Option<String>,
    pub image_url: Option<String>,
    pub bio: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: String,
    pub title: String,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub track_count: Option<i32>,
    pub cover_art_path: Option<String>,
    pub cover_art_url: Option<String>,
    pub musicbrainz_id: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackSource {
    pub id: String,
    pub recording_id: String,
    pub source: String,
    pub source_id: Option<String>,
    pub source_url: Option<String>,
    pub file_path: Option<String>,
    pub file_format: Option<String>,
    pub file_size_bytes: Option<i64>,
    pub bitrate: Option<i32>,
    pub sample_rate: Option<i32>,
    pub quality_score: i32,
    pub content_hash: Option<String>,
    pub is_available: bool,
    pub metadata_json: Option<String>,
    pub last_verified: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub cover_art_path: Option<String>,
    pub is_smart: bool,
    pub smart_rules: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistTrack {
    pub id: String,
    pub playlist_id: String,
    pub recording_id: String,
    pub position: f64,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub url: String,
    pub homepage: Option<String>,
    pub favicon_url: Option<String>,
    pub favicon_path: Option<String>,
    pub country: Option<String>,
    pub language: Option<String>,
    pub tags: Option<String>,
    pub codec: Option<String>,
    pub bitrate: Option<i32>,
    pub radio_browser_id: Option<String>,
    pub is_favorite: bool,
    pub fail_count: i32,
    pub last_played_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayHistory {
    pub id: String,
    pub recording_id: Option<String>,
    pub source_used: Option<String>,
    pub station_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Length of the media item, when known.
    pub duration_ms: Option<i64>,
    /// Time that audio was actually playing for this history entry.
    pub listened_ms: Option<i64>,
    /// Why playback ended. `None` means the play is still active.
    pub end_reason: Option<String>,
    /// True only when the source reached its natural end.
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub id: String,
    pub recording_id: Option<String>,
    pub source: String,
    pub source_url: String,
    pub status: String,
    pub progress: f64,
    pub file_path: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// View models for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryTrack {
    pub id: String,
    pub title: String,
    pub artist_name: String,
    pub artist_id: String,
    pub album_title: Option<String>,
    pub album_id: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover_art_path: Option<String>,
    pub cover_art_url: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub source: String,
    pub is_downloaded: bool,
    pub local_file_path: Option<String>,
    pub playlist_track_id: Option<String>,
    pub playlist_position: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub recording_id: String,
    pub title: String,
    pub artist_name: String,
    pub artist_id: Option<String>,
    pub album_title: Option<String>,
    pub album_id: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub cover_art_url: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub is_playing: bool,
    pub is_buffering: bool,
    pub can_seek: bool,
    pub current_recording_id: Option<String>,
    pub current_station_id: Option<String>,
    pub current_title: Option<String>,
    pub current_artist: Option<String>,
    pub current_album_art: Option<String>,
    pub current_source_url: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub volume: f32,
    pub is_shuffle: bool,
    pub repeat_mode: String,
    pub source: Option<String>,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            is_playing: false,
            is_buffering: false,
            can_seek: false,
            current_recording_id: None,
            current_station_id: None,
            current_title: None,
            current_artist: None,
            current_album_art: None,
            current_source_url: None,
            position_ms: 0,
            duration_ms: 0,
            volume: 1.0,
            is_shuffle: false,
            repeat_mode: "off".to_string(),
            source: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItem {
    /// Stable identity for this occurrence. Two queue rows that reference the
    /// same recording deliberately have different entry IDs.
    pub entry_id: String,
    /// Legacy upcoming index. New callers should mutate by session + entry ID.
    pub index: usize,
    pub recording_id: String,
    pub title: String,
    pub artist_name: String,
    pub duration_ms: Option<i64>,
    pub cover_art_url: Option<String>,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueueSnapshot {
    /// Changes whenever a new playback context replaces the queue.
    pub session_id: String,
    /// Monotonically increases for observable mutations within the session.
    pub revision: u64,
    pub now_playing: Option<QueueItem>,
    /// Literal future playback order. History is never included.
    pub upcoming: Vec<QueueItem>,
}
