use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
    MIGRATION_005,
    MIGRATION_006,
    MIGRATION_007,
];

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

const MIGRATION_005: &str = r#"
-- Discovery v2 keeps canonical identities separate from provider-specific IDs,
-- records time-series observations, and persists generated feeds so the UI is
-- stable between refreshes and application launches.
CREATE TABLE IF NOT EXISTS discovery_entities (
    id              TEXT PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    title           TEXT NOT NULL,
    artist_name     TEXT,
    release_date    TEXT,
    artwork_url     TEXT,
    metadata_json   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_external_ids (
    entity_id       TEXT NOT NULL REFERENCES discovery_entities(id) ON DELETE CASCADE,
    namespace       TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    external_url    TEXT,
    metadata_json   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (namespace, external_id)
);

CREATE TABLE IF NOT EXISTS discovery_observations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id           TEXT NOT NULL REFERENCES discovery_entities(id) ON DELETE CASCADE,
    source              TEXT NOT NULL,
    scope               TEXT NOT NULL DEFAULT 'global',
    observed_at         INTEGER NOT NULL,
    rank_position       INTEGER CHECK (rank_position IS NULL OR rank_position > 0),
    chart_size          INTEGER CHECK (chart_size IS NULL OR chart_size > 0),
    listener_count      INTEGER CHECK (listener_count IS NULL OR listener_count >= 0),
    play_count          INTEGER CHECK (play_count IS NULL OR play_count >= 0),
    engagement_count    INTEGER CHECK (engagement_count IS NULL OR engagement_count >= 0),
    source_score        REAL,
    metadata_json       TEXT,
    collected_at        INTEGER NOT NULL,
    UNIQUE (entity_id, source, scope, observed_at),
    CHECK (rank_position IS NULL OR chart_size IS NULL OR rank_position <= chart_size)
);

CREATE TABLE IF NOT EXISTS discovery_feed_snapshots (
    snapshot_key        TEXT PRIMARY KEY,
    algorithm_version   TEXT NOT NULL,
    input_fingerprint   TEXT NOT NULL,
    generated_at        INTEGER NOT NULL,
    expires_at          INTEGER,
    source_status_json  TEXT,
    payload_json        TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

-- Events are deliberately generic: impressions, clicks, hides, saves, starts,
-- and completions can all be learned from without another schema change.
CREATE TABLE IF NOT EXISTS discovery_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id           TEXT REFERENCES discovery_entities(id) ON DELETE SET NULL,
    source              TEXT,
    source_item_id      TEXT,
    event_type          TEXT NOT NULL,
    occurred_at         INTEGER NOT NULL,
    context_json        TEXT,
    created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_entities_type
    ON discovery_entities(entity_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_external_ids_entity
    ON discovery_external_ids(entity_id, namespace);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_source_time
    ON discovery_observations(source, scope, observed_at DESC, entity_id);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_entity_time
    ON discovery_observations(entity_id, source, scope, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_snapshots_generated
    ON discovery_feed_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_events_type_time
    ON discovery_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_events_entity_time
    ON discovery_events(entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_events_source_item_time
    ON discovery_events(source, source_item_id, occurred_at DESC);
"#;

const MIGRATION_006: &str = r#"
-- A play's media duration is different from the amount actually heard. Older
-- builds stored the current playback position in duration_ms and marked every
-- stop/skip as completed. Preserve that useful listening time, restore the
-- media duration where the recording metadata knows it, and conservatively
-- label old outcomes as unknown rather than claiming a natural completion.
ALTER TABLE play_history ADD COLUMN listened_ms INTEGER;
ALTER TABLE play_history ADD COLUMN end_reason TEXT;

UPDATE play_history
SET listened_ms = CASE
        WHEN duration_ms IS NULL THEN 0
        ELSE MAX(duration_ms, 0)
    END,
    duration_ms = (
        SELECT r.duration_ms
        FROM recordings r
        WHERE r.id = play_history.recording_id
    ),
    end_reason = CASE
        WHEN ended_at IS NOT NULL THEN 'legacy_unknown'
        ELSE 'legacy_abandoned'
    END,
    ended_at = COALESCE(ended_at, datetime('now')),
    completed = 0;

CREATE INDEX IF NOT EXISTS idx_play_history_end_reason
    ON play_history(end_reason, started_at);
"#;

const MIGRATION_007: &str = r#"
-- Views and plays are different provider measurements. Keep them in separate
-- typed columns so YouTube reach never becomes a fake stream/play count.
ALTER TABLE discovery_observations ADD COLUMN view_count INTEGER
    CHECK (view_count IS NULL OR view_count >= 0);
"#;

pub(crate) fn latest_version() -> i64 {
    MIGRATIONS.len() as i64
}

pub(crate) fn current_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    let has_migration_table: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = '_migrations'
         )",
        [],
        |row| row.get(0),
    )?;

    if !has_migration_table {
        return Ok(0);
    }

    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )
}

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")?;

    let current_version = current_version(conn)?;

    for (i, migration) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version > current_version {
            apply_migration(conn, version, migration)?;
        }
    }

    Ok(())
}

fn apply_migration(
    conn: &Connection,
    version: i64,
    migration: &str,
) -> Result<(), rusqlite::Error> {
    // `unchecked_transaction` accepts `&Connection`, while still giving us
    // rollback-on-drop if any statement or the version marker fails.
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(migration)?;
    transaction.execute(
        "INSERT INTO _migrations (version, applied_at) VALUES (?1, datetime('now'))",
        rusqlite::params![version],
    )?;
    transaction.commit()
}

#[cfg(test)]
mod tests {
    use super::{apply_migration, run_migrations, MIGRATIONS};
    use rusqlite::{params, Connection};

    #[test]
    fn play_history_upgrade_preserves_legacy_listening_time_honestly() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE _migrations (
                 version INTEGER PRIMARY KEY,
                 applied_at TEXT NOT NULL
             );",
        )
        .unwrap();

        for (index, migration) in MIGRATIONS.iter().take(5).enumerate() {
            conn.execute_batch(migration).unwrap();
            conn.execute(
                "INSERT INTO _migrations (version, applied_at)
                 VALUES (?1, datetime('now'))",
                params![(index + 1) as i64],
            )
            .unwrap();
        }

        conn.execute(
            "INSERT INTO recordings
             (id, title, duration_ms, created_at, updated_at)
             VALUES ('recording-1', 'Legacy track', 180000, datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO play_history
             (id, recording_id, source_used, started_at, ended_at, duration_ms, completed)
             VALUES ('play-1', 'recording-1', 'local', datetime('now'), datetime('now'), 42000, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO play_history
             (id, recording_id, source_used, started_at, duration_ms, completed)
             VALUES ('play-2', 'recording-1', 'local', datetime('now'), NULL, 0)",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();
        // Running again must be harmless after the version marker is written.
        run_migrations(&conn).unwrap();

        let upgraded = conn
            .query_row(
                "SELECT listened_ms, duration_ms, end_reason, completed
                 FROM play_history WHERE id = 'play-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(upgraded, (42_000, 180_000, "legacy_unknown".into(), 0));
        let abandoned = conn
            .query_row(
                "SELECT listened_ms, duration_ms, end_reason, completed,
                        ended_at IS NOT NULL
                 FROM play_history WHERE id = 'play-2'",
                [],
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
        assert_eq!(abandoned, (0, 180_000, "legacy_abandoned".into(), 0, 1));
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_version_together() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE _migrations (
                 version INTEGER PRIMARY KEY,
                 applied_at TEXT NOT NULL
             );
             CREATE TABLE example (id INTEGER PRIMARY KEY);",
        )
        .unwrap();

        let result = apply_migration(
            &conn,
            99,
            "ALTER TABLE example ADD COLUMN transient_value TEXT;
             INSERT INTO table_that_does_not_exist DEFAULT VALUES;",
        );
        assert!(result.is_err());

        let transient_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('example')
                 WHERE name = 'transient_value'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _migrations WHERE version = 99",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(transient_columns, 0);
        assert_eq!(version_rows, 0);
    }
}
