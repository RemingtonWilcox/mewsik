use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004];

const MIGRATION_001: &str = r#"
-- Canonical library entries (one per song)
CREATE TABLE IF NOT EXISTS recordings (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    duration_ms     INTEGER,
    year            INTEGER,
    genre           TEXT,
    cover_art_path  TEXT,
    cover_art_url   TEXT,
    loudness_lufs   REAL,
    musicbrainz_id  TEXT,
    metadata_json   TEXT,
    is_in_library   INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sort_name       TEXT,
    musicbrainz_id  TEXT,
    image_path      TEXT,
    image_url       TEXT,
    bio             TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    year            INTEGER,
    genre           TEXT,
    track_count     INTEGER,
    cover_art_path  TEXT,
    cover_art_url   TEXT,
    musicbrainz_id  TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- M:N recording <-> artist
CREATE TABLE IF NOT EXISTS recording_artists (
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'primary',
    position        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (recording_id, artist_id, role)
);

-- M:N album <-> artist
CREATE TABLE IF NOT EXISTS album_artists (
    album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'primary',
    position        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, artist_id, role)
);

-- M:N recording <-> album
CREATE TABLE IF NOT EXISTS album_tracks (
    album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    disc_number     INTEGER DEFAULT 1,
    track_number    INTEGER,
    PRIMARY KEY (album_id, recording_id)
);

-- Source-specific instances of a recording
CREATE TABLE IF NOT EXISTS track_sources (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    source_id       TEXT,
    source_url      TEXT,
    file_path       TEXT,
    file_format     TEXT,
    file_size_bytes INTEGER,
    bitrate         INTEGER,
    sample_rate     INTEGER,
    quality_score   INTEGER DEFAULT 0,
    content_hash    TEXT,
    is_available    INTEGER DEFAULT 1,
    metadata_json   TEXT,
    last_verified   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(source, source_id)
);

-- Playlists
CREATE TABLE IF NOT EXISTS playlists (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    cover_art_path  TEXT,
    is_smart        INTEGER DEFAULT 0,
    smart_rules     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    id              TEXT PRIMARY KEY,
    playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position        REAL NOT NULL,
    added_at        TEXT NOT NULL,
    UNIQUE(playlist_id, position)
);

-- Radio stations
CREATE TABLE IF NOT EXISTS stations (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    homepage        TEXT,
    favicon_url     TEXT,
    favicon_path    TEXT,
    country         TEXT,
    language        TEXT,
    tags            TEXT,
    codec           TEXT,
    bitrate         INTEGER,
    radio_browser_id TEXT,
    is_favorite     INTEGER DEFAULT 0,
    last_played_at  TEXT,
    created_at      TEXT NOT NULL
);

-- Listening history
CREATE TABLE IF NOT EXISTS play_history (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    source_used     TEXT,
    station_id      TEXT REFERENCES stations(id) ON DELETE SET NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    duration_ms     INTEGER,
    completed       INTEGER DEFAULT 0
);

-- Downloads
CREATE TABLE IF NOT EXISTS downloads (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT REFERENCES recordings(id),
    source          TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    progress        REAL DEFAULT 0.0,
    file_path       TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- FTS5 search
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    recording_id UNINDEXED,
    title,
    artist_names,
    album_titles,
    genre,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS artists_fts USING fts5(
    artist_id UNINDEXED,
    name,
    tokenize='unicode61 remove_diacritics 2'
);

-- Recommendation data
CREATE TABLE IF NOT EXISTS recording_similarities (
    recording_id_a  TEXT NOT NULL,
    recording_id_b  TEXT NOT NULL,
    score           REAL NOT NULL,
    source          TEXT NOT NULL,
    PRIMARY KEY (recording_id_a, recording_id_b, source)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_track_sources_recording ON track_sources(recording_id);
CREATE INDEX IF NOT EXISTS idx_track_sources_source ON track_sources(source, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_sources_local_path ON track_sources(file_path) WHERE file_path IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_sources_local_hash ON track_sources(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recording_artists_artist ON recording_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_recording_artists_recording ON recording_artists(recording_id);
CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON album_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_album_tracks_recording ON album_tracks(recording_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_play_history_recording ON play_history(recording_id, started_at);
CREATE INDEX IF NOT EXISTS idx_play_history_time ON play_history(started_at);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_recordings_library ON recordings(is_in_library) WHERE is_in_library = 1;
"#;

const MIGRATION_002: &str = r#"
CREATE INDEX IF NOT EXISTS idx_downloads_recording_status ON downloads(recording_id, status);
"#;

const MIGRATION_003: &str = r#"
ALTER TABLE stations ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stations ADD COLUMN last_checked_at TEXT;
CREATE INDEX IF NOT EXISTS idx_stations_favorite_health ON stations(is_favorite, fail_count);
"#;

const MIGRATION_004: &str = r#"
-- Per-track visual score cache (offline analysis: beat grid, sections,
-- key, energy arc). version invalidates rows when algorithms change.
CREATE TABLE IF NOT EXISTS track_analysis (
    recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    score_json   TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
"#;

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")?;

    let current_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for (i, migration) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version > current_version {
            conn.execute_batch(migration)?;
            conn.execute(
                "INSERT INTO _migrations (version, applied_at) VALUES (?1, datetime('now'))",
                rusqlite::params![version],
            )?;
        }
    }

    Ok(())
}
