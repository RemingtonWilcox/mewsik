use super::models::*;
use super::DbPool;
use rusqlite::params;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_id() -> String {
    ulid::Ulid::new().to_string()
}

// ── Recording CRUD ──

pub fn insert_recording(db: &DbPool, rec: &Recording) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO recordings (id, title, duration_ms, year, genre, cover_art_path, cover_art_url, loudness_lufs, musicbrainz_id, metadata_json, is_in_library, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            rec.id, rec.title, rec.duration_ms, rec.year, rec.genre,
            rec.cover_art_path, rec.cover_art_url, rec.loudness_lufs,
            rec.musicbrainz_id, rec.metadata_json, rec.is_in_library as i32,
            rec.created_at, rec.updated_at
        ],
    )?;
    rebuild_search_index_inner(&conn, &rec.id)?;
    Ok(())
}

pub fn get_recording(db: &DbPool, id: &str) -> Result<Option<Recording>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, duration_ms, year, genre, cover_art_path, cover_art_url, loudness_lufs, musicbrainz_id, metadata_json, is_in_library, created_at, updated_at FROM recordings WHERE id = ?1"
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Recording {
            id: row.get(0)?,
            title: row.get(1)?,
            duration_ms: row.get(2)?,
            year: row.get(3)?,
            genre: row.get(4)?,
            cover_art_path: row.get(5)?,
            cover_art_url: row.get(6)?,
            loudness_lufs: row.get(7)?,
            musicbrainz_id: row.get(8)?,
            metadata_json: row.get(9)?,
            is_in_library: row.get::<_, i32>(10)? != 0,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn set_in_library(
    db: &DbPool,
    recording_id: &str,
    in_library: bool,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE recordings SET is_in_library = ?1, updated_at = ?2 WHERE id = ?3",
        params![in_library as i32, now(), recording_id],
    )?;
    Ok(())
}

pub fn update_recording_external_metadata(
    db: &DbPool,
    recording_id: &str,
    title: Option<&str>,
    duration_ms: Option<i64>,
    year: Option<i32>,
    genre: Option<&str>,
    cover_art_url: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE recordings
         SET title = COALESCE(?1, title),
             duration_ms = COALESCE(?2, duration_ms),
             year = COALESCE(?3, year),
             genre = COALESCE(?4, genre),
             cover_art_url = COALESCE(?5, cover_art_url),
             updated_at = ?6
         WHERE id = ?7",
        params![
            title,
            duration_ms,
            year,
            genre,
            cover_art_url,
            now(),
            recording_id
        ],
    )?;
    rebuild_search_index_inner(&conn, recording_id)?;
    Ok(())
}

pub fn get_library_tracks(db: &DbPool) -> Result<Vec<LibraryTrack>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, a.name, a.id, al.title, al.id, r.duration_ms, r.cover_art_path, r.cover_art_url, r.genre, r.year,
                COALESCE((SELECT ts.source FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1), 'local'),
                EXISTS(SELECT 1 FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL),
                COALESCE(
                    (SELECT ts.file_path FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 AND ts.file_path IS NOT NULL ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1),
                    (SELECT d.file_path FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL ORDER BY d.updated_at DESC LIMIT 1)
                )
         FROM recordings r
         LEFT JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
         LEFT JOIN artists a ON a.id = ra.artist_id
         LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
         LEFT JOIN albums al ON al.id = at2.album_id
         WHERE r.is_in_library = 1
         ORDER BY COALESCE(a.sort_name, a.name), r.title"
    )?;
    let rows = stmt.query_map([], |row| {
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
            local_file_path: row.get(13)?,
            playlist_track_id: None,
            playlist_position: None,
        })
    })?;
    rows.collect()
}

// ── Artist CRUD ──

pub fn insert_artist(db: &DbPool, artist: &Artist) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO artists (id, name, sort_name, musicbrainz_id, image_path, image_url, bio, metadata_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            artist.id, artist.name, artist.sort_name, artist.musicbrainz_id,
            artist.image_path, artist.image_url, artist.bio, artist.metadata_json,
            artist.created_at, artist.updated_at
        ],
    )?;
    // Rebuild artists_fts
    conn.execute(
        "DELETE FROM artists_fts WHERE artist_id = ?1",
        params![artist.id],
    )?;
    conn.execute(
        "INSERT INTO artists_fts (artist_id, name) VALUES (?1, ?2)",
        params![artist.id, artist.name],
    )?;
    Ok(())
}

pub fn get_artist(db: &DbPool, id: &str) -> Result<Option<Artist>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_name, musicbrainz_id, image_path, image_url, bio, metadata_json, created_at, updated_at FROM artists WHERE id = ?1"
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Artist {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_name: row.get(2)?,
            musicbrainz_id: row.get(3)?,
            image_path: row.get(4)?,
            image_url: row.get(5)?,
            bio: row.get(6)?,
            metadata_json: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn get_all_artists(db: &DbPool) -> Result<Vec<Artist>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT a.id, a.name, a.sort_name, a.musicbrainz_id, a.image_path, a.image_url, a.bio, a.metadata_json, a.created_at, a.updated_at
         FROM artists a
         JOIN recording_artists ra ON ra.artist_id = a.id
         JOIN recordings r ON r.id = ra.recording_id AND r.is_in_library = 1
         ORDER BY COALESCE(a.sort_name, a.name)"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Artist {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_name: row.get(2)?,
            musicbrainz_id: row.get(3)?,
            image_path: row.get(4)?,
            image_url: row.get(5)?,
            bio: row.get(6)?,
            metadata_json: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn find_artist_by_name(db: &DbPool, name: &str) -> Result<Option<Artist>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_name, musicbrainz_id, image_path, image_url, bio, metadata_json, created_at, updated_at FROM artists WHERE LOWER(name) = LOWER(?1) LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![name], |row| {
        Ok(Artist {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_name: row.get(2)?,
            musicbrainz_id: row.get(3)?,
            image_path: row.get(4)?,
            image_url: row.get(5)?,
            bio: row.get(6)?,
            metadata_json: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

// ── Recording-Artist link ──

pub fn link_recording_artist(
    db: &DbPool,
    recording_id: &str,
    artist_id: &str,
    role: &str,
    position: i32,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT OR IGNORE INTO recording_artists (recording_id, artist_id, role, position) VALUES (?1, ?2, ?3, ?4)",
        params![recording_id, artist_id, role, position],
    )?;
    rebuild_search_index_inner(&conn, recording_id)?;
    Ok(())
}

// ── Album CRUD ──

pub fn insert_album(db: &DbPool, album: &Album) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO albums (id, title, year, genre, track_count, cover_art_path, cover_art_url, musicbrainz_id, metadata_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            album.id, album.title, album.year, album.genre, album.track_count,
            album.cover_art_path, album.cover_art_url, album.musicbrainz_id,
            album.metadata_json, album.created_at, album.updated_at
        ],
    )?;
    Ok(())
}

pub fn find_album_by_title_artist(
    db: &DbPool,
    title: &str,
    artist_id: &str,
) -> Result<Option<Album>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT al.id, al.title, al.year, al.genre, al.track_count, al.cover_art_path, al.cover_art_url, al.musicbrainz_id, al.metadata_json, al.created_at, al.updated_at
         FROM albums al
         JOIN album_artists aa ON aa.album_id = al.id AND aa.artist_id = ?2
         WHERE LOWER(al.title) = LOWER(?1) LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![title, artist_id], |row| {
        Ok(Album {
            id: row.get(0)?,
            title: row.get(1)?,
            year: row.get(2)?,
            genre: row.get(3)?,
            track_count: row.get(4)?,
            cover_art_path: row.get(5)?,
            cover_art_url: row.get(6)?,
            musicbrainz_id: row.get(7)?,
            metadata_json: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn get_all_albums(db: &DbPool) -> Result<Vec<Album>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT al.id, al.title, al.year, al.genre, al.track_count, al.cover_art_path, al.cover_art_url, al.musicbrainz_id, al.metadata_json, al.created_at, al.updated_at
         FROM albums al
         JOIN album_tracks at2 ON at2.album_id = al.id
         JOIN recordings r ON r.id = at2.recording_id AND r.is_in_library = 1
         ORDER BY al.title"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Album {
            id: row.get(0)?,
            title: row.get(1)?,
            year: row.get(2)?,
            genre: row.get(3)?,
            track_count: row.get(4)?,
            cover_art_path: row.get(5)?,
            cover_art_url: row.get(6)?,
            musicbrainz_id: row.get(7)?,
            metadata_json: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn link_album_artist(
    db: &DbPool,
    album_id: &str,
    artist_id: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position) VALUES (?1, ?2, 'primary', 0)",
        params![album_id, artist_id],
    )?;
    Ok(())
}

pub fn link_album_track(
    db: &DbPool,
    album_id: &str,
    recording_id: &str,
    disc: i32,
    track: i32,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT OR IGNORE INTO album_tracks (album_id, recording_id, disc_number, track_number) VALUES (?1, ?2, ?3, ?4)",
        params![album_id, recording_id, disc, track],
    )?;
    rebuild_search_index_inner(&conn, recording_id)?;
    Ok(())
}

// ── Track Source CRUD ──

pub fn insert_track_source(db: &DbPool, ts: &TrackSource) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO track_sources (id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            ts.id, ts.recording_id, ts.source, ts.source_id, ts.source_url,
            ts.file_path, ts.file_format, ts.file_size_bytes, ts.bitrate,
            ts.sample_rate, ts.quality_score, ts.content_hash, ts.is_available as i32,
            ts.metadata_json, ts.last_verified, ts.created_at, ts.updated_at
        ],
    )?;
    Ok(())
}

pub fn find_source_by_provider_id(
    db: &DbPool,
    source: &str,
    source_id: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources
         WHERE source = ?1 AND source_id = ?2
         LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![source, source_id], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn find_source_by_file_path(
    db: &DbPool,
    file_path: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources
         WHERE file_path = ?1
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![file_path], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn find_managed_download_source_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources
         WHERE recording_id = ?1
           AND source = 'local'
           AND metadata_json LIKE '%\"managed_download\":true%'
         ORDER BY updated_at DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![recording_id], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn set_track_source_file_availability(
    db: &DbPool,
    file_path: &str,
    is_available: bool,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE track_sources
         SET is_available = ?1,
             last_verified = ?2,
             updated_at = ?2
         WHERE file_path = ?3",
        params![is_available as i32, now(), file_path],
    )?;
    Ok(())
}

pub fn update_track_source_stream(
    db: &DbPool,
    track_source_id: &str,
    source_url: Option<&str>,
    metadata_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE track_sources
         SET source_url = COALESCE(?1, source_url),
             metadata_json = COALESCE(?2, metadata_json),
             last_verified = ?3,
             is_available = 1,
             updated_at = ?3
         WHERE id = ?4",
        params![source_url, metadata_json, now(), track_source_id],
    )?;
    Ok(())
}

pub fn update_remote_track_source(
    db: &DbPool,
    track_source_id: &str,
    source_url: Option<&str>,
    file_format: Option<&str>,
    bitrate: Option<i32>,
    quality_score: Option<i32>,
    metadata_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    let timestamp = now();
    conn.execute(
        "UPDATE track_sources
         SET source_url = COALESCE(?1, source_url),
             file_format = COALESCE(?2, file_format),
             bitrate = COALESCE(?3, bitrate),
             quality_score = COALESCE(?4, quality_score),
             metadata_json = COALESCE(?5, metadata_json),
             last_verified = ?6,
             is_available = 1,
             updated_at = ?6
         WHERE id = ?7",
        params![
            source_url,
            file_format,
            bitrate,
            quality_score,
            metadata_json,
            timestamp,
            track_source_id
        ],
    )?;
    Ok(())
}

pub fn update_local_track_source_file(
    db: &DbPool,
    track_source_id: &str,
    file_path: &str,
    file_format: Option<&str>,
    file_size_bytes: Option<i64>,
    metadata_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    let timestamp = now();
    conn.execute(
        "UPDATE track_sources
         SET source = 'local',
             source_id = NULL,
             source_url = NULL,
             file_path = ?1,
             file_format = ?2,
             file_size_bytes = ?3,
             quality_score = 100,
             metadata_json = ?4,
             is_available = 1,
             last_verified = ?5,
             updated_at = ?5
         WHERE id = ?6",
        params![
            file_path,
            file_format,
            file_size_bytes,
            metadata_json,
            timestamp,
            track_source_id
        ],
    )?;
    Ok(())
}

pub fn get_best_source(
    db: &DbPool,
    recording_id: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources
         WHERE recording_id = ?1 AND is_available = 1
         ORDER BY CASE WHEN file_path IS NOT NULL THEN 0 ELSE 1 END, quality_score DESC
         LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![recording_id], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn get_latest_completed_download_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<Option<Download>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_url, status, progress, file_path, error_message, created_at, updated_at
         FROM downloads
         WHERE recording_id = ?1
           AND status = 'completed'
           AND file_path IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![recording_id], |row| {
        Ok(Download {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_url: row.get(3)?,
            status: row.get(4)?,
            progress: row.get(5)?,
            file_path: row.get(6)?,
            error_message: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn get_download_files_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<Vec<Download>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_url, status, progress, file_path, error_message, created_at, updated_at
         FROM downloads
         WHERE recording_id = ?1
           AND status IN ('completed', 'missing')
           AND file_path IS NOT NULL
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![recording_id], |row| {
        Ok(Download {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_url: row.get(3)?,
            status: row.get(4)?,
            progress: row.get(5)?,
            file_path: row.get(6)?,
            error_message: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn find_source_by_path(
    db: &DbPool,
    path: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources WHERE file_path = ?1 LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![path], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn find_source_by_hash(
    db: &DbPool,
    hash: &str,
) -> Result<Option<TrackSource>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_id, source_url, file_path, file_format, file_size_bytes, bitrate, sample_rate, quality_score, content_hash, is_available, metadata_json, last_verified, created_at, updated_at
         FROM track_sources WHERE content_hash = ?1 LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![hash], |row| {
        Ok(TrackSource {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_id: row.get(3)?,
            source_url: row.get(4)?,
            file_path: row.get(5)?,
            file_format: row.get(6)?,
            file_size_bytes: row.get(7)?,
            bitrate: row.get(8)?,
            sample_rate: row.get(9)?,
            quality_score: row.get(10)?,
            content_hash: row.get(11)?,
            is_available: row.get::<_, i32>(12)? != 0,
            metadata_json: row.get(13)?,
            last_verified: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

// ── Playlist CRUD ──

pub fn create_playlist(db: &DbPool, playlist: &Playlist) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO playlists (id, name, description, cover_art_path, is_smart, smart_rules, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            playlist.id, playlist.name, playlist.description, playlist.cover_art_path,
            playlist.is_smart as i32, playlist.smart_rules, playlist.created_at, playlist.updated_at
        ],
    )?;
    Ok(())
}

pub fn get_playlists(db: &DbPool) -> Result<Vec<Playlist>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, description, cover_art_path, is_smart, smart_rules, created_at, updated_at FROM playlists ORDER BY name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Playlist {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            cover_art_path: row.get(3)?,
            is_smart: row.get::<_, i32>(4)? != 0,
            smart_rules: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn add_to_playlist(
    db: &DbPool,
    playlist_id: &str,
    recording_id: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    let max_pos: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), 0.0) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    let id = new_id();
    conn.execute(
        "INSERT INTO playlist_tracks (id, playlist_id, recording_id, position, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, playlist_id, recording_id, max_pos + 1.0, now()],
    )?;
    Ok(())
}

pub fn get_playlist_tracks(
    db: &DbPool,
    playlist_id: &str,
) -> Result<Vec<LibraryTrack>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, COALESCE(a.name, 'Unknown Artist'), COALESCE(a.id, ''), al.title, al.id, r.duration_ms, r.cover_art_path, r.cover_art_url, r.genre, r.year,
                pt.id, pt.position,
                COALESCE((SELECT ts.source FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1), 'local'),
                EXISTS(SELECT 1 FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL),
                COALESCE(
                    (SELECT ts.file_path FROM track_sources ts WHERE ts.recording_id = r.id AND ts.is_available = 1 AND ts.file_path IS NOT NULL ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END, ts.quality_score DESC LIMIT 1),
                    (SELECT d.file_path FROM downloads d WHERE d.recording_id = r.id AND d.status = 'completed' AND d.file_path IS NOT NULL ORDER BY d.updated_at DESC LIMIT 1)
                )
         FROM playlist_tracks pt
         JOIN recordings r ON r.id = pt.recording_id
         LEFT JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
         LEFT JOIN artists a ON a.id = ra.artist_id
         LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
         LEFT JOIN albums al ON al.id = at2.album_id
         WHERE pt.playlist_id = ?1
         ORDER BY pt.position"
    )?;
    let rows = stmt.query_map(params![playlist_id], |row| {
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
            source: row.get(13)?,
            is_downloaded: row.get::<_, bool>(14)?,
            local_file_path: row.get(15)?,
            playlist_track_id: row.get(11)?,
            playlist_position: row.get(12)?,
        })
    })?;
    rows.collect()
}

pub fn reorder_playlist_track(
    db: &DbPool,
    playlist_id: &str,
    track_id: &str,
    new_position: f64,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2 AND playlist_id = ?3",
        params![new_position, track_id, playlist_id],
    )?;
    // Compaction check: if min gap < 1e-6, renormalize
    let needs_compact: bool = conn.query_row(
        "SELECT MIN(p2.position - p1.position) < 1e-6
         FROM playlist_tracks p1
         JOIN playlist_tracks p2 ON p2.playlist_id = p1.playlist_id AND p2.position > p1.position
         WHERE p1.playlist_id = ?1
         AND NOT EXISTS (
             SELECT 1 FROM playlist_tracks p3
             WHERE p3.playlist_id = p1.playlist_id AND p3.position > p1.position AND p3.position < p2.position
         )",
        params![playlist_id],
        |row| row.get(0),
    ).unwrap_or(false);

    if needs_compact {
        conn.execute(
            "UPDATE playlist_tracks SET position = (
                SELECT COUNT(*) FROM playlist_tracks p2
                WHERE p2.playlist_id = playlist_tracks.playlist_id AND p2.position <= playlist_tracks.position
            ) WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
    }
    Ok(())
}

pub fn delete_playlist(db: &DbPool, playlist_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
    Ok(())
}

pub fn remove_from_playlist(db: &DbPool, playlist_track_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM playlist_tracks WHERE id = ?1",
        params![playlist_track_id],
    )?;
    Ok(())
}

// ── Play History ──

pub fn record_play(
    db: &DbPool,
    recording_id: Option<&str>,
    source_used: Option<&str>,
    station_id: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<String, rusqlite::Error> {
    let id = new_id();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO play_history
         (id, recording_id, source_used, station_id, started_at, duration_ms, listened_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            id,
            recording_id,
            source_used,
            station_id,
            now(),
            duration_ms.map(|value| value.max(0))
        ],
    )?;
    Ok(id)
}

/// Finalize one play exactly once.
///
/// Returning `false` means another playback path already finalized the row.
/// This makes late source/error events harmless instead of letting them rewrite
/// the original, user-visible reason that playback ended.
pub fn finalize_play(
    db: &DbPool,
    play_id: &str,
    listened_ms: i64,
    duration_ms: Option<i64>,
    end_reason: &str,
) -> Result<bool, rusqlite::Error> {
    let naturally_completed = end_reason == "natural_end";
    let conn = db.lock();
    let updated = conn.execute(
        "UPDATE play_history
         SET ended_at = ?1,
             listened_ms = ?2,
             duration_ms = COALESCE(?3, duration_ms),
             end_reason = ?4,
             completed = ?5
         WHERE id = ?6
           AND ended_at IS NULL",
        params![
            now(),
            listened_ms.max(0),
            duration_ms.map(|value| value.max(0)),
            end_reason,
            naturally_completed as i32,
            play_id
        ],
    )?;
    Ok(updated == 1)
}

// ── FTS Search ──

pub fn search_recordings(
    db: &DbPool,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResultItem>, rusqlite::Error> {
    let conn = db.lock();
    // Add * for prefix matching
    let fts_query = query
        .split_whitespace()
        .map(|w| format!("{}*", w))
        .collect::<Vec<_>>()
        .join(" ");

    let mut stmt = conn.prepare(
        "SELECT
                r.id,
                r.title,
                COALESCE((
                    SELECT a.name
                    FROM recording_artists ra
                    JOIN artists a ON a.id = ra.artist_id
                    WHERE ra.recording_id = r.id AND ra.role = 'primary'
                    ORDER BY ra.position
                    LIMIT 1
                ), 'Unknown Artist'),
                (
                    SELECT a.id
                    FROM recording_artists ra
                    JOIN artists a ON a.id = ra.artist_id
                    WHERE ra.recording_id = r.id AND ra.role = 'primary'
                    ORDER BY ra.position
                    LIMIT 1
                ),
                (
                    SELECT al.title
                    FROM album_tracks at2
                    JOIN albums al ON al.id = at2.album_id
                    WHERE at2.recording_id = r.id
                    ORDER BY at2.disc_number, at2.track_number
                    LIMIT 1
                ),
                (
                    SELECT al.id
                    FROM album_tracks at2
                    JOIN albums al ON al.id = at2.album_id
                    WHERE at2.recording_id = r.id
                    ORDER BY at2.disc_number, at2.track_number
                    LIMIT 1
                ),
                COALESCE((
                    SELECT ts.source
                    FROM track_sources ts
                    WHERE ts.recording_id = r.id AND ts.is_available = 1
                    ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC
                    LIMIT 1
                ), 'local'),
                (
                    SELECT ts.source_id
                    FROM track_sources ts
                    WHERE ts.recording_id = r.id AND ts.is_available = 1
                    ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END, ts.quality_score DESC
                    LIMIT 1
                ),
                r.cover_art_url,
                r.duration_ms
         FROM search_fts fts
         JOIN recordings r ON r.id = fts.recording_id
         WHERE search_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2"
    )?;
    let rows = stmt.query_map(params![fts_query, limit], |row| {
        Ok(SearchResultItem {
            recording_id: row.get(0)?,
            title: row.get(1)?,
            artist_name: row.get(2)?,
            artist_id: row.get(3)?,
            album_title: row.get(4)?,
            album_id: row.get(5)?,
            source: row.get(6)?,
            source_id: row.get(7)?,
            cover_art_url: row.get(8)?,
            duration_ms: row.get(9)?,
        })
    })?;
    rows.collect()
}

// ── FTS Rebuild ──

fn rebuild_search_index_inner(
    conn: &rusqlite::Connection,
    recording_id: &str,
) -> Result<(), rusqlite::Error> {
    // Delete existing FTS entry
    conn.execute(
        "DELETE FROM search_fts WHERE recording_id = ?1",
        params![recording_id],
    )?;

    // Build denormalized entry
    let result: Result<(String, String, String, String), rusqlite::Error> = conn.query_row(
        "SELECT
            r.title,
            COALESCE(GROUP_CONCAT(DISTINCT a.name, ' '), ''),
            COALESCE(GROUP_CONCAT(DISTINCT al.title, ' '), ''),
            COALESCE(r.genre, '')
         FROM recordings r
         LEFT JOIN recording_artists ra ON ra.recording_id = r.id
         LEFT JOIN artists a ON a.id = ra.artist_id
         LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
         LEFT JOIN albums al ON al.id = at2.album_id
         WHERE r.id = ?1
         GROUP BY r.id",
        params![recording_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );

    if let Ok((title, artist_names, album_titles, genre)) = result {
        conn.execute(
            "INSERT INTO search_fts (recording_id, title, artist_names, album_titles, genre) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![recording_id, title, artist_names, album_titles, genre],
        )?;
    }
    Ok(())
}

pub fn rebuild_search_index(db: &DbPool, recording_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    rebuild_search_index_inner(&conn, recording_id)
}

pub fn rebuild_all_search_indexes(db: &DbPool) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute("DELETE FROM search_fts", [])?;
    let mut stmt = conn.prepare("SELECT id FROM recordings")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    for id in &ids {
        rebuild_search_index_inner(&conn, id)?;
    }
    // Rebuild artists_fts
    conn.execute("DELETE FROM artists_fts", [])?;
    let mut stmt = conn.prepare("SELECT id, name FROM artists")?;
    let artists: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    for (id, name) in &artists {
        conn.execute(
            "INSERT INTO artists_fts (artist_id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
    }
    Ok(())
}

// ── Station CRUD ──

fn station_from_row(row: &rusqlite::Row<'_>) -> Result<Station, rusqlite::Error> {
    Ok(Station {
        id: row.get(0)?,
        name: row.get(1)?,
        url: row.get(2)?,
        homepage: row.get(3)?,
        favicon_url: row.get(4)?,
        favicon_path: row.get(5)?,
        country: row.get(6)?,
        language: row.get(7)?,
        tags: row.get(8)?,
        codec: row.get(9)?,
        bitrate: row.get(10)?,
        radio_browser_id: row.get(11)?,
        is_favorite: row.get::<_, i32>(12)? != 0,
        fail_count: row.get(13)?,
        last_played_at: row.get(14)?,
        last_checked_at: row.get(15)?,
        created_at: row.get(16)?,
    })
}

pub fn insert_station(db: &DbPool, station: &Station) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO stations (id, name, url, homepage, favicon_url, favicon_path, country, language, tags, codec, bitrate, radio_browser_id, is_favorite, fail_count, last_played_at, last_checked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            station.id, station.name, station.url, station.homepage,
            station.favicon_url, station.favicon_path, station.country,
            station.language, station.tags, station.codec, station.bitrate,
            station.radio_browser_id, station.is_favorite as i32,
            station.fail_count, station.last_played_at, station.last_checked_at,
            station.created_at
        ],
    )?;
    Ok(())
}

pub fn get_favorite_stations(db: &DbPool) -> Result<Vec<Station>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, url, homepage, favicon_url, favicon_path, country, language, tags, codec, bitrate, radio_browser_id, is_favorite, fail_count, last_played_at, last_checked_at, created_at
         FROM stations WHERE is_favorite = 1 ORDER BY name"
    )?;
    let rows = stmt.query_map([], station_from_row)?;
    rows.collect()
}

pub fn find_station_by_identity(
    db: &DbPool,
    radio_browser_id: Option<&str>,
    url: &str,
) -> Result<Option<Station>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, url, homepage, favicon_url, favicon_path, country, language, tags, codec, bitrate, radio_browser_id, is_favorite, fail_count, last_played_at, last_checked_at, created_at
         FROM stations
         WHERE (?1 IS NOT NULL AND radio_browser_id = ?1) OR url = ?2
         ORDER BY CASE WHEN (?1 IS NOT NULL AND radio_browser_id = ?1) THEN 0 ELSE 1 END
         LIMIT 1"
    )?;
    let mut rows = stmt.query_map(params![radio_browser_id, url], station_from_row)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn update_station_last_played(
    db: &DbPool,
    station_id: &str,
    played_at: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE stations SET last_played_at = ?1 WHERE id = ?2",
        params![played_at, station_id],
    )?;
    Ok(())
}

pub fn get_station_by_id(
    db: &DbPool,
    station_id: &str,
) -> Result<Option<Station>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, url, homepage, favicon_url, favicon_path, country, language, tags, codec, bitrate, radio_browser_id, is_favorite, fail_count, last_played_at, last_checked_at, created_at
         FROM stations WHERE id = ?1"
    )?;
    let mut rows = stmt.query_map(params![station_id], station_from_row)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn update_station_url(db: &DbPool, station_id: &str, url: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE stations SET url = ?1 WHERE id = ?2",
        params![url, station_id],
    )?;
    Ok(())
}

pub fn increment_station_fail_count(db: &DbPool, station_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE stations SET fail_count = fail_count + 1 WHERE id = ?1",
        params![station_id],
    )?;
    Ok(())
}

pub fn update_station_health(
    db: &DbPool,
    station_id: &str,
    fail_count: i32,
    checked_at: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE stations SET fail_count = ?1, last_checked_at = ?2 WHERE id = ?3",
        params![fail_count, checked_at, station_id],
    )?;
    Ok(())
}

pub fn toggle_station_favorite(db: &DbPool, station_id: &str) -> Result<bool, rusqlite::Error> {
    let conn = db.lock();
    let current: bool = conn.query_row(
        "SELECT is_favorite FROM stations WHERE id = ?1",
        params![station_id],
        |row| Ok(row.get::<_, i32>(0)? != 0),
    )?;
    let new_val = !current;
    conn.execute(
        "UPDATE stations SET is_favorite = ?1 WHERE id = ?2",
        params![new_val as i32, station_id],
    )?;
    Ok(new_val)
}

// ── Downloads ──

pub fn insert_download(db: &DbPool, dl: &Download) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO downloads (id, recording_id, source, source_url, status, progress, file_path, error_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            dl.id, dl.recording_id, dl.source, dl.source_url, dl.status,
            dl.progress, dl.file_path, dl.error_message, dl.created_at, dl.updated_at
        ],
    )?;
    Ok(())
}

pub fn update_download_progress(
    db: &DbPool,
    download_id: &str,
    progress: f64,
    status: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE downloads SET progress = ?1, status = ?2, updated_at = ?3 WHERE id = ?4",
        params![progress, status, now(), download_id],
    )?;
    Ok(())
}

pub fn complete_download(
    db: &DbPool,
    download_id: &str,
    file_path: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE downloads
         SET progress = 100.0,
             status = 'completed',
             file_path = ?1,
             error_message = NULL,
             updated_at = ?2
         WHERE id = ?3",
        params![file_path, now(), download_id],
    )?;
    Ok(())
}

pub fn fail_download(
    db: &DbPool,
    download_id: &str,
    error_message: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE downloads
         SET status = 'failed',
             error_message = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![error_message, now(), download_id],
    )?;
    Ok(())
}

pub fn mark_download_missing(
    db: &DbPool,
    download_id: &str,
    error_message: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "UPDATE downloads
         SET status = 'missing',
             error_message = ?1,
             updated_at = ?2
         WHERE id = ?3
           AND status = 'completed'",
        params![error_message, now(), download_id],
    )?;
    Ok(())
}

pub fn cancel_download(db: &DbPool, download_id: &str) -> Result<bool, rusqlite::Error> {
    let conn = db.lock();
    let updated = conn.execute(
        "UPDATE downloads
         SET status = 'cancelled',
             error_message = 'Cancelled',
             updated_at = ?1
         WHERE id = ?2
           AND status IN ('pending', 'downloading', 'processing')",
        params![now(), download_id],
    )?;
    Ok(updated > 0)
}

pub fn get_downloads(db: &DbPool) -> Result<Vec<Download>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_url, status, progress, file_path, error_message, created_at, updated_at
         FROM downloads ORDER BY created_at DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Download {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_url: row.get(3)?,
            status: row.get(4)?,
            progress: row.get(5)?,
            file_path: row.get(6)?,
            error_message: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn count_active_downloads(db: &DbPool) -> Result<usize, rusqlite::Error> {
    let conn = db.lock();
    conn.query_row(
        "SELECT COUNT(*) FROM downloads WHERE status IN ('pending', 'downloading', 'processing')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
}

pub fn get_download_by_id(
    db: &DbPool,
    download_id: &str,
) -> Result<Option<Download>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, recording_id, source, source_url, status, progress, file_path, error_message, created_at, updated_at
         FROM downloads
         WHERE id = ?1
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![download_id], |row| {
        Ok(Download {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            source: row.get(2)?,
            source_url: row.get(3)?,
            status: row.get(4)?,
            progress: row.get(5)?,
            file_path: row.get(6)?,
            error_message: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn delete_download(db: &DbPool, download_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute("DELETE FROM downloads WHERE id = ?1", params![download_id])?;
    Ok(())
}

pub fn delete_track_source(db: &DbPool, track_source_id: &str) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM track_sources WHERE id = ?1",
        params![track_source_id],
    )?;
    Ok(())
}

pub fn find_active_download_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id
         FROM downloads
         WHERE recording_id = ?1
           AND status IN ('pending', 'downloading', 'processing')
         ORDER BY created_at DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![recording_id], |row| row.get(0))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

// ---- Track analysis (visual score) cache ----

pub fn get_track_analysis(
    db: &DbPool,
    recording_id: &str,
    min_version: i64,
) -> Result<Option<String>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT score_json FROM track_analysis WHERE recording_id = ?1 AND version >= ?2",
    )?;
    let mut rows = stmt.query(rusqlite::params![recording_id, min_version])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn upsert_track_analysis(
    db: &DbPool,
    recording_id: &str,
    version: i64,
    score_json: &str,
) -> Result<(), rusqlite::Error> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO track_analysis (recording_id, version, score_json, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(recording_id) DO UPDATE SET
           version = excluded.version,
           score_json = excluded.score_json,
           created_at = excluded.created_at",
        rusqlite::params![recording_id, version, score_json, now()],
    )?;
    Ok(())
}

/// First playable local file for a recording, if any.
pub fn get_local_file_for_recording(
    db: &DbPool,
    recording_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT file_path FROM track_sources
         WHERE recording_id = ?1 AND file_path IS NOT NULL AND is_available = 1
         ORDER BY quality_score DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![recording_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod play_history_tests {
    use super::{finalize_play, record_play};
    use crate::db::init_memory_db;
    use rusqlite::params;

    fn seed_recording(db: &crate::db::DbPool, recording_id: &str, duration_ms: i64) {
        db.lock()
            .execute(
                "INSERT INTO recordings
                 (id, title, duration_ms, created_at, updated_at)
                 VALUES (?1, 'Test track', ?2, datetime('now'), datetime('now'))",
                params![recording_id, duration_ms],
            )
            .unwrap();
    }

    #[test]
    fn interrupted_play_is_finalized_once_without_becoming_a_completion() {
        let db = init_memory_db().unwrap();
        seed_recording(&db, "recording-1", 180_000);
        let play_id =
            record_play(&db, Some("recording-1"), Some("local"), None, Some(180_000)).unwrap();

        let started: (i64, i64, i64) = db
            .lock()
            .query_row(
                "SELECT listened_ms, duration_ms, ended_at IS NULL
                 FROM play_history WHERE id = ?1",
                params![&play_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(started, (0, 180_000, 1));

        assert!(finalize_play(&db, &play_id, 12_345, Some(180_000), "skipped_next").unwrap());
        assert!(!finalize_play(&db, &play_id, 99_999, Some(180_000), "playback_error",).unwrap());

        let persisted = db
            .lock()
            .query_row(
                "SELECT listened_ms, duration_ms, end_reason, completed,
                        ended_at IS NOT NULL
                 FROM play_history WHERE id = ?1",
                params![play_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(
            persisted,
            (12_345, 180_000, "skipped_next".to_string(), 0, 1)
        );
    }

    #[test]
    fn natural_end_is_the_only_completed_outcome() {
        let db = init_memory_db().unwrap();
        seed_recording(&db, "recording-2", 90_000);
        let play_id = record_play(
            &db,
            Some("recording-2"),
            Some("youtube"),
            None,
            Some(90_000),
        )
        .unwrap();

        assert!(finalize_play(&db, &play_id, 84_000, Some(90_000), "natural_end").unwrap());

        let completed: i64 = db
            .lock()
            .query_row(
                "SELECT completed FROM play_history WHERE id = ?1",
                params![play_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(completed, 1);
    }
}
