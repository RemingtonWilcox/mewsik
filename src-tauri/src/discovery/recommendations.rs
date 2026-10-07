use crate::db::models::LibraryTrack;
use crate::db::DbPool;
use rusqlite::{params, Connection, OpenFlags, Row};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const QUALIFIED_LISTEN_MIN_MS: i64 = 30_000;
const PROFILE_TRACK_GOAL: i64 = 5;

pub struct RecommendationEngine {
    db: DbPool,
}

#[derive(Debug, Clone)]
struct RecommendationCandidate {
    track: LibraryTrack,
    score: f64,
}

impl RecommendationEngine {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    /// Generate a mix that blends affinity, novelty, and similarity signals.
    pub fn generate_daily_mix(&self, limit: usize) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.db.lock();
        if !profile_is_ready(&conn) {
            drop(conn);
            return self.fallback_library_mix(limit, &HashSet::new());
        }

        let mut stmt = conn
            .prepare(
                r#"
                WITH recent_track_stats AS (
                    SELECT
                        recording_id,
                        COUNT(*) AS play_count,
                        MAX(started_at) AS last_played
                    FROM play_history
                    WHERE recording_id IS NOT NULL
                      AND COALESCE(listened_ms, duration_ms, 0) >= 30000
                      AND started_at > datetime('now', '-90 days')
                    GROUP BY recording_id
                ),
                artist_affinity AS (
                    SELECT
                        ra.artist_id,
                        COUNT(*) AS play_count
                    FROM play_history ph
                    JOIN recording_artists ra
                      ON ra.recording_id = ph.recording_id
                     AND ra.role = 'primary'
                    WHERE ph.recording_id IS NOT NULL
                      AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                      AND ph.started_at > datetime('now', '-45 days')
                    GROUP BY ra.artist_id
                ),
                genre_affinity AS (
                    SELECT
                        LOWER(TRIM(r.genre)) AS genre_key,
                        COUNT(*) AS play_count
                    FROM play_history ph
                    JOIN recordings r ON r.id = ph.recording_id
                    WHERE ph.recording_id IS NOT NULL
                      AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                      AND ph.started_at > datetime('now', '-45 days')
                      AND r.genre IS NOT NULL
                      AND TRIM(r.genre) <> ''
                    GROUP BY LOWER(TRIM(r.genre))
                ),
                similarity_affinity AS (
                    SELECT
                        recording_id,
                        MAX(score) AS similarity_score
                    FROM (
                        SELECT
                            rs.recording_id_b AS recording_id,
                            rs.score AS score
                        FROM recording_similarities rs
                        JOIN play_history ph
                          ON ph.recording_id = rs.recording_id_a
                        WHERE ph.started_at > datetime('now', '-30 days')
                          AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000

                        UNION ALL

                        SELECT
                            rs.recording_id_a AS recording_id,
                            rs.score AS score
                        FROM recording_similarities rs
                        JOIN play_history ph
                          ON ph.recording_id = rs.recording_id_b
                        WHERE ph.started_at > datetime('now', '-30 days')
                          AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                    )
                    GROUP BY recording_id
                )
                SELECT
                    r.id,
                    r.title,
                    COALESCE(a.name, 'Unknown Artist'),
                    COALESCE(a.id, ''),
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year,
                    COALESCE(
                        (
                            SELECT ts.source
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                            ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        'local'
                    ),
                    COALESCE(
                        (
                            SELECT ts.file_path
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                              AND ts.file_path IS NOT NULL
                            ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        (
                            SELECT d.file_path
                            FROM downloads d
                            WHERE d.recording_id = r.id
                              AND d.status = 'completed'
                              AND d.file_path IS NOT NULL
                            ORDER BY d.updated_at DESC
                            LIMIT 1
                        )
                    ),
                    (
                        COALESCE(artist_affinity.play_count, 0) * 5.0 +
                        COALESCE(genre_affinity.play_count, 0) * 3.0 +
                        COALESCE(similarity_affinity.similarity_score, 0.0) * 10.0 +
                        CASE WHEN recent_track_stats.recording_id IS NULL THEN 3.0 ELSE 0.0 END +
                        CASE
                            WHEN recent_track_stats.last_played IS NOT NULL
                             AND recent_track_stats.last_played < datetime('now', '-30 days')
                            THEN 2.0
                            ELSE 0.0
                        END -
                        COALESCE(recent_track_stats.play_count, 0) * 0.75
                    ) AS recommendation_score
                FROM recordings r
                LEFT JOIN recording_artists ra
                  ON ra.recording_id = r.id
                 AND ra.role = 'primary'
                 AND ra.position = 0
                LEFT JOIN artists a ON a.id = ra.artist_id
                LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
                LEFT JOIN albums al ON al.id = at2.album_id
                LEFT JOIN recent_track_stats ON recent_track_stats.recording_id = r.id
                LEFT JOIN artist_affinity ON artist_affinity.artist_id = ra.artist_id
                LEFT JOIN genre_affinity
                  ON genre_affinity.genre_key = LOWER(TRIM(COALESCE(r.genre, '')))
                LEFT JOIN similarity_affinity ON similarity_affinity.recording_id = r.id
                WHERE r.is_in_library = 1
                  AND (
                        recent_track_stats.last_played IS NULL
                     OR recent_track_stats.last_played < datetime('now', '-2 days')
                  )
                ORDER BY recommendation_score DESC, r.id ASC
                LIMIT ?1
                "#,
            )
            .map_err(|e| e.to_string())?;

        let candidates = stmt
            .query_map(params![(limit * 4).max(limit) as i64], map_candidate_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        drop(conn);

        let mut selected = diversify_candidates(candidates, limit, 2);
        if selected.len() < limit {
            let existing_ids = selected
                .iter()
                .map(|track| track.id.clone())
                .collect::<HashSet<_>>();
            let mut fallback = self.fallback_library_mix(limit - selected.len(), &existing_ids)?;
            selected.append(&mut fallback);
        }

        Ok(selected)
    }

    /// Get favorite tracks that have gone cold long enough to feel fresh again.
    pub fn get_rediscover(&self, limit: usize) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    r.id,
                    r.title,
                    COALESCE(a.name, 'Unknown Artist'),
                    COALESCE(a.id, ''),
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year,
                    COALESCE(
                        (
                            SELECT ts.source
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                            ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        'local'
                    ),
                    COALESCE(
                        (
                            SELECT ts.file_path
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                              AND ts.file_path IS NOT NULL
                            ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        (
                            SELECT d.file_path
                            FROM downloads d
                            WHERE d.recording_id = r.id
                              AND d.status = 'completed'
                              AND d.file_path IS NOT NULL
                            ORDER BY d.updated_at DESC
                            LIMIT 1
                        )
                    ),
                    (
                        COUNT(ph.id) * 3.5 +
                        MIN(julianday('now') - julianday(MAX(ph.started_at)), 365) / 5.0
                    ) AS rediscover_score
                FROM recordings r
                JOIN play_history ph
                  ON ph.recording_id = r.id
                LEFT JOIN recording_artists ra
                  ON ra.recording_id = r.id
                 AND ra.role = 'primary'
                 AND ra.position = 0
                LEFT JOIN artists a ON a.id = ra.artist_id
                LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
                LEFT JOIN albums al ON al.id = at2.album_id
                WHERE r.is_in_library = 1
                  AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                GROUP BY
                    r.id,
                    r.title,
                    a.name,
                    a.id,
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year
                HAVING MAX(ph.started_at) < datetime('now', '-30 days')
                ORDER BY rediscover_score DESC, r.id ASC
                LIMIT ?1
                "#,
            )
            .map_err(|e| e.to_string())?;

        let candidates = stmt
            .query_map(params![(limit * 3).max(limit) as i64], map_candidate_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(diversify_candidates(candidates, limit, 1))
    }

    /// Deterministic radio-style continuation for a playback context that only
    /// contains one recording. This deliberately ranks already-known catalog
    /// relationships; it does not call a provider, download audio, or decode a
    /// second track while the current one is playing.
    pub fn continuation_recording_ids(
        &self,
        anchor_recording_id: &str,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        // The primary DbPool intentionally wraps one connection for ordered
        // writes. Ranking can be a larger read, so use a separate WAL reader in
        // packaged/on-disk databases; otherwise a continuation query could
        // hold that mutex while the listener tries to start another song.
        let database_path = {
            let conn = self.db.lock();
            conn.path()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
        };
        let independent_reader = database_path
            .map(|path| {
                let connection = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY
                        | OpenFlags::SQLITE_OPEN_NO_MUTEX
                        | OpenFlags::SQLITE_OPEN_URI,
                )
                .map_err(|error| error.to_string())?;
                connection
                    .busy_timeout(Duration::from_secs(2))
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>(connection)
            })
            .transpose()?;
        let shared_reader;
        let conn = if let Some(connection) = independent_reader.as_ref() {
            connection
        } else {
            // In-memory databases used by unit tests have no reopenable path.
            shared_reader = self.db.lock();
            &shared_reader
        };
        let mut stmt = conn
            .prepare(
                r#"
                WITH anchor AS (
                    SELECT NULLIF(LOWER(TRIM(genre)), '') AS genre_key
                    FROM recordings
                    WHERE id = ?1
                ),
                candidates AS (
                    SELECT
                        r.id,
                        r.title,
                        r.is_in_library,
                        EXISTS(
                            SELECT 1
                            FROM album_tracks candidate_album
                            JOIN album_tracks anchor_album
                              ON anchor_album.album_id = candidate_album.album_id
                            WHERE candidate_album.recording_id = r.id
                              AND anchor_album.recording_id = ?1
                        ) AS same_album,
                        COALESCE(
                            (
                                SELECT MIN(
                                    CASE
                                        WHEN (
                                            COALESCE(candidate_album.disc_number, 1) * 100000
                                            + COALESCE(candidate_album.track_number, 0)
                                        ) > (
                                            COALESCE(anchor_album.disc_number, 1) * 100000
                                            + COALESCE(anchor_album.track_number, 0)
                                        ) THEN 0
                                        ELSE 1
                                    END
                                )
                                FROM album_tracks candidate_album
                                JOIN album_tracks anchor_album
                                  ON anchor_album.album_id = candidate_album.album_id
                                WHERE candidate_album.recording_id = r.id
                                  AND anchor_album.recording_id = ?1
                            ),
                            2
                        ) AS album_wrap,
                        COALESCE(
                            (
                                SELECT MIN(
                                    COALESCE(candidate_album.disc_number, 1) * 100000
                                    + COALESCE(candidate_album.track_number, 0)
                                )
                                FROM album_tracks candidate_album
                                JOIN album_tracks anchor_album
                                  ON anchor_album.album_id = candidate_album.album_id
                                WHERE candidate_album.recording_id = r.id
                                  AND anchor_album.recording_id = ?1
                            ),
                            2147483647
                        ) AS album_position,
                        COALESCE(
                            (
                                SELECT MAX(similarity.score)
                                FROM recording_similarities similarity
                                WHERE (
                                    similarity.recording_id_a = ?1
                                    AND similarity.recording_id_b = r.id
                                ) OR (
                                    similarity.recording_id_b = ?1
                                    AND similarity.recording_id_a = r.id
                                )
                            ),
                            0.0
                        ) AS similarity_score,
                        EXISTS(
                            SELECT 1
                            FROM recording_artists candidate_artist
                            JOIN recording_artists anchor_artist
                              ON anchor_artist.artist_id = candidate_artist.artist_id
                            WHERE candidate_artist.recording_id = r.id
                              AND anchor_artist.recording_id = ?1
                              AND candidate_artist.role = 'primary'
                              AND anchor_artist.role = 'primary'
                        ) AS same_artist,
                        CASE
                            WHEN (SELECT genre_key FROM anchor) IS NOT NULL
                             AND LOWER(TRIM(r.genre)) = (SELECT genre_key FROM anchor)
                            THEN 1
                            ELSE 0
                        END AS same_genre,
                        (
                            SELECT MAX(history.started_at)
                            FROM play_history history
                            WHERE history.recording_id = r.id
                        ) AS last_played
                    FROM recordings r
                    WHERE r.id <> ?1
                      AND (
                            EXISTS(
                                SELECT 1
                                FROM track_sources source
                                WHERE source.recording_id = r.id
                                  AND source.is_available = 1
                                  AND (
                                      NULLIF(TRIM(source.file_path), '') IS NOT NULL
                                      OR NULLIF(TRIM(source.source_url), '') IS NOT NULL
                                      OR NULLIF(TRIM(source.source_id), '') IS NOT NULL
                                  )
                            )
                            OR EXISTS(
                                SELECT 1
                                FROM downloads download
                                WHERE download.recording_id = r.id
                                  AND download.status = 'completed'
                                  AND NULLIF(TRIM(download.file_path), '') IS NOT NULL
                            )
                      )
                      AND (
                            r.is_in_library = 1
                            OR EXISTS(
                                SELECT 1
                                FROM album_tracks candidate_album
                                JOIN album_tracks anchor_album
                                  ON anchor_album.album_id = candidate_album.album_id
                                WHERE candidate_album.recording_id = r.id
                                  AND anchor_album.recording_id = ?1
                            )
                            OR EXISTS(
                                SELECT 1
                                FROM recording_artists candidate_artist
                                JOIN recording_artists anchor_artist
                                  ON anchor_artist.artist_id = candidate_artist.artist_id
                                WHERE candidate_artist.recording_id = r.id
                                  AND anchor_artist.recording_id = ?1
                                  AND candidate_artist.role = 'primary'
                                  AND anchor_artist.role = 'primary'
                            )
                            OR EXISTS(
                                SELECT 1
                                FROM recording_similarities similarity
                                WHERE (
                                    similarity.recording_id_a = ?1
                                    AND similarity.recording_id_b = r.id
                                ) OR (
                                    similarity.recording_id_b = ?1
                                    AND similarity.recording_id_a = r.id
                                )
                            )
                      )
                )
                SELECT id
                FROM candidates
                ORDER BY
                    CASE
                        WHEN same_album = 1 THEN 0
                        WHEN similarity_score > 0 THEN 1
                        WHEN same_artist = 1 THEN 2
                        WHEN same_genre = 1 THEN 3
                        ELSE 4
                    END,
                    album_wrap,
                    album_position,
                    similarity_score DESC,
                    CASE WHEN same_artist = 1 THEN 0 ELSE 1 END,
                    CASE WHEN same_genre = 1 THEN 0 ELSE 1 END,
                    CASE WHEN is_in_library = 1 THEN 0 ELSE 1 END,
                    CASE WHEN last_played IS NULL THEN 0 ELSE 1 END,
                    last_played ASC,
                    LOWER(title) ASC,
                    id ASC
                LIMIT ?2
                "#,
            )
            .map_err(|error| error.to_string())?;

        let rows = stmt
            .query_map(params![anchor_recording_id, limit as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    fn fallback_library_mix(
        &self,
        limit: usize,
        excluded_ids: &HashSet<String>,
    ) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    r.id,
                    r.title,
                    COALESCE(a.name, 'Unknown Artist'),
                    COALESCE(a.id, ''),
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year,
                    COALESCE(
                        (
                            SELECT ts.source
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                            ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        'local'
                    ),
                    COALESCE(
                        (
                            SELECT ts.file_path
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                              AND ts.file_path IS NOT NULL
                            ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        (
                            SELECT d.file_path
                            FROM downloads d
                            WHERE d.recording_id = r.id
                              AND d.status = 'completed'
                              AND d.file_path IS NOT NULL
                            ORDER BY d.updated_at DESC
                            LIMIT 1
                        )
                    )
                FROM recordings r
                LEFT JOIN recording_artists ra
                  ON ra.recording_id = r.id
                 AND ra.role = 'primary'
                 AND ra.position = 0
                LEFT JOIN artists a ON a.id = ra.artist_id
                LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
                LEFT JOIN albums al ON al.id = at2.album_id
                WHERE r.is_in_library = 1
                ORDER BY
                    CASE
                        WHEN EXISTS(
                            SELECT 1
                            FROM play_history ph
                            WHERE ph.recording_id = r.id
                              AND COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                        ) THEN 1
                        ELSE 0
                    END,
                    r.created_at DESC,
                    r.id ASC
                LIMIT ?1
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut tracks = Vec::new();
        let rows = stmt
            .query_map(
                params![(limit * 4).max(limit) as i64],
                map_library_track_row,
            )
            .map_err(|e| e.to_string())?;

        for row in rows {
            let track = row.map_err(|e| e.to_string())?;
            if excluded_ids.contains(&track.id) {
                continue;
            }
            tracks.push(track);
            if tracks.len() >= limit {
                break;
            }
        }

        Ok(tracks)
    }

    /// Get play stats
    pub fn get_play_stats(&self) -> Result<PlayStats, String> {
        let conn = self.db.lock();

        let total_plays: i64 = conn
            .query_row("SELECT COUNT(*) FROM play_history", [], |row| row.get(0))
            .unwrap_or(0);

        let total_time_ms: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(COALESCE(listened_ms, duration_ms, 0)), 0) FROM play_history",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let unique_tracks = qualified_recording_count(&conn);

        Ok(PlayStats {
            total_plays,
            total_time_ms,
            unique_tracks,
            profile_track_goal: PROFILE_TRACK_GOAL,
            profile_ready: unique_tracks >= PROFILE_TRACK_GOAL,
        })
    }

    pub fn get_recently_played(&self, limit: usize) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    r.id,
                    r.title,
                    COALESCE(a.name, 'Unknown Artist'),
                    COALESCE(a.id, ''),
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year,
                    COALESCE(
                        (
                            SELECT ts.source
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                            ORDER BY CASE WHEN ts.file_path IS NOT NULL THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        'local'
                    ),
                    COALESCE(
                        (
                            SELECT ts.file_path
                            FROM track_sources ts
                            WHERE ts.recording_id = r.id
                              AND ts.is_available = 1
                              AND ts.file_path IS NOT NULL
                            ORDER BY CASE WHEN ts.source = 'local' THEN 0 ELSE 1 END,
                                     ts.quality_score DESC
                            LIMIT 1
                        ),
                        (
                            SELECT d.file_path
                            FROM downloads d
                            WHERE d.recording_id = r.id
                              AND d.status = 'completed'
                              AND d.file_path IS NOT NULL
                            ORDER BY d.updated_at DESC
                            LIMIT 1
                        )
                    )
                FROM play_history ph
                JOIN recordings r ON r.id = ph.recording_id
                LEFT JOIN recording_artists ra
                  ON ra.recording_id = r.id
                 AND ra.role = 'primary'
                 AND ra.position = 0
                LEFT JOIN artists a ON a.id = ra.artist_id
                LEFT JOIN album_tracks at2 ON at2.recording_id = r.id
                LEFT JOIN albums al ON al.id = at2.album_id
                WHERE ph.recording_id IS NOT NULL
                GROUP BY
                    r.id,
                    r.title,
                    a.name,
                    a.id,
                    al.title,
                    al.id,
                    r.duration_ms,
                    r.cover_art_path,
                    r.cover_art_url,
                    r.genre,
                    r.year
                ORDER BY MAX(ph.started_at) DESC
                LIMIT ?1
                "#,
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![limit as i64], map_library_track_row)
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlayStats {
    pub total_plays: i64,
    pub total_time_ms: i64,
    pub unique_tracks: i64,
    pub profile_track_goal: i64,
    pub profile_ready: bool,
}

fn qualified_recording_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(DISTINCT recording_id) FROM play_history WHERE recording_id IS NOT NULL AND COALESCE(listened_ms, duration_ms, 0) >= ?1",
        params![QUALIFIED_LISTEN_MIN_MS],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn profile_is_ready(conn: &Connection) -> bool {
    qualified_recording_count(conn) >= PROFILE_TRACK_GOAL
}

fn diversify_candidates(
    mut candidates: Vec<RecommendationCandidate>,
    limit: usize,
    max_per_artist: usize,
) -> Vec<LibraryTrack> {
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.track.id.cmp(&b.track.id))
    });

    let mut selected = Vec::new();
    let mut overflow = Vec::new();
    let mut artist_counts: HashMap<String, usize> = HashMap::new();
    let mut seen_ids = HashSet::new();

    for candidate in candidates {
        if !seen_ids.insert(candidate.track.id.clone()) {
            continue;
        }

        let artist_key = artist_bucket(&candidate.track);
        let count = artist_counts.get(&artist_key).copied().unwrap_or(0);
        if count < max_per_artist {
            artist_counts.insert(artist_key, count + 1);
            selected.push(candidate.track);
        } else {
            overflow.push(candidate.track);
        }

        if selected.len() >= limit {
            return selected;
        }
    }

    for track in overflow {
        if selected.len() >= limit {
            break;
        }
        selected.push(track);
    }

    selected
}

fn artist_bucket(track: &LibraryTrack) -> String {
    if !track.artist_id.is_empty() {
        track.artist_id.clone()
    } else {
        track.artist_name.to_lowercase()
    }
}

fn map_candidate_row(row: &Row<'_>) -> rusqlite::Result<RecommendationCandidate> {
    Ok(RecommendationCandidate {
        track: map_library_track_row(row)?,
        score: row.get(13)?,
    })
}

fn map_library_track_row(row: &Row<'_>) -> rusqlite::Result<LibraryTrack> {
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
        local_file_path: row.get(12)?,
        is_downloaded: false,
        playlist_track_id: None,
        playlist_position: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn seed_library_track(db: &DbPool, id: &str, artist_id: &str) {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO recordings (id, title, duration_ms, is_in_library, created_at, updated_at) VALUES (?1, ?2, 180000, 1, datetime('now'), datetime('now'))",
            params![id, format!("Track {id}")],
        )
        .unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO artists (id, name, created_at, updated_at) VALUES (?1, ?2, datetime('now'), datetime('now'))",
            params![artist_id, format!("Artist {artist_id}")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recording_artists (recording_id, artist_id, role, position) VALUES (?1, ?2, 'primary', 0)",
            params![id, artist_id],
        )
        .unwrap();
    }

    fn record_play(db: &DbPool, play_id: &str, recording_id: &str, duration_ms: i64) {
        db.lock()
            .execute(
                "INSERT INTO play_history (id, recording_id, source_used, started_at, ended_at, duration_ms, listened_ms, end_reason, completed) VALUES (?1, ?2, 'local', datetime('now'), datetime('now'), 180000, ?3, 'natural_end', 1)",
                params![play_id, recording_id, duration_ms],
            )
            .unwrap();
    }

    fn make_playable(db: &DbPool, recording_id: &str) {
        db.lock()
            .execute(
                "INSERT INTO track_sources (id, recording_id, source, file_path, quality_score, is_available, created_at, updated_at) VALUES (?1, ?2, 'local', ?3, 100, 1, datetime('now'), datetime('now'))",
                params![
                    format!("source-{recording_id}"),
                    recording_id,
                    format!("/music/{recording_id}.mp3")
                ],
            )
            .unwrap();
    }

    fn put_on_album(db: &DbPool, recording_id: &str, album_id: &str, track_number: i64) {
        let conn = db.lock();
        conn.execute(
            "INSERT OR IGNORE INTO albums (id, title, created_at, updated_at) VALUES (?1, ?2, datetime('now'), datetime('now'))",
            params![album_id, format!("Album {album_id}")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO album_tracks (album_id, recording_id, disc_number, track_number) VALUES (?1, ?2, 1, ?3)",
            params![album_id, recording_id, track_number],
        )
        .unwrap();
    }

    #[test]
    fn qualified_history_mix_is_stable_until_history_changes() {
        let db = init_memory_db().unwrap();
        for index in 0..8 {
            seed_library_track(
                &db,
                &format!("recording-{index}"),
                &format!("artist-{index}"),
            );
        }
        for index in 0..5 {
            record_play(
                &db,
                &format!("play-{index}"),
                &format!("recording-{index}"),
                45_000,
            );
        }

        let engine = RecommendationEngine::new(db);
        let first = engine.generate_daily_mix(3).unwrap();
        let second = engine.generate_daily_mix(3).unwrap();
        let first_ids = first
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>();
        let second_ids = second
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(first_ids, second_ids);
        assert_eq!(first_ids, vec!["recording-5", "recording-6", "recording-7"]);
        let stats = engine.get_play_stats().unwrap();
        assert_eq!(stats.unique_tracks, PROFILE_TRACK_GOAL);
        assert!(stats.profile_ready);
        assert_eq!(stats.profile_track_goal, PROFILE_TRACK_GOAL);
    }

    #[test]
    fn repeated_qualified_plays_of_one_track_do_not_complete_profile() {
        let db = init_memory_db().unwrap();
        for index in 0..8 {
            seed_library_track(
                &db,
                &format!("recording-{index}"),
                &format!("artist-{index}"),
            );
        }
        for index in 0..5 {
            record_play(&db, &format!("repeat-{index}"), "recording-0", 45_000);
        }

        {
            let conn = db.lock();
            assert_eq!(qualified_recording_count(&conn), 1);
            assert!(!profile_is_ready(&conn));
        }
        let engine = RecommendationEngine::new(db.clone());
        let learning_stats = engine.get_play_stats().unwrap();
        assert_eq!(learning_stats.unique_tracks, 1);
        assert!(!learning_stats.profile_ready);

        for index in 1..5 {
            record_play(
                &db,
                &format!("distinct-{index}"),
                &format!("recording-{index}"),
                45_000,
            );
        }
        let ready_stats = engine.get_play_stats().unwrap();
        assert_eq!(ready_stats.unique_tracks, PROFILE_TRACK_GOAL);
        assert!(ready_stats.profile_ready);
    }

    #[test]
    fn short_skips_do_not_count_as_a_learned_profile() {
        let db = init_memory_db().unwrap();
        for index in 0..6 {
            seed_library_track(
                &db,
                &format!("recording-{index}"),
                &format!("artist-{index}"),
            );
        }
        for index in 0..5 {
            record_play(&db, &format!("skip-{index}"), "recording-0", 2_000);
        }

        let engine = RecommendationEngine::new(db);
        let mix = engine.generate_daily_mix(4).unwrap();
        let stats = engine.get_play_stats().unwrap();

        assert_eq!(mix.len(), 4);
        assert_eq!(stats.unique_tracks, 0);
        assert!(!stats.profile_ready);
    }

    #[test]
    fn single_track_continuation_is_related_playable_and_deterministic() {
        let db = init_memory_db().unwrap();
        for (id, artist) in [
            ("anchor", "artist-a"),
            ("album-before", "artist-a"),
            ("album-after", "artist-a"),
            ("similar", "artist-b"),
            ("same-artist", "artist-a"),
            ("same-genre", "artist-c"),
            ("library-fallback", "artist-d"),
            ("unplayable-album", "artist-a"),
        ] {
            seed_library_track(&db, id, artist);
        }

        {
            let conn = db.lock();
            conn.execute(
                "UPDATE recordings SET genre = 'Ambient' WHERE id IN ('anchor', 'same-genre')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO recording_similarities (recording_id_a, recording_id_b, score, source) VALUES ('anchor', 'similar', 0.91, 'test')",
                [],
            )
            .unwrap();
        }

        put_on_album(&db, "album-before", "album-a", 1);
        put_on_album(&db, "anchor", "album-a", 2);
        put_on_album(&db, "album-after", "album-a", 3);
        put_on_album(&db, "unplayable-album", "album-a", 4);
        for id in [
            "album-before",
            "album-after",
            "similar",
            "same-artist",
            "same-genre",
            "library-fallback",
        ] {
            make_playable(&db, id);
        }

        let engine = RecommendationEngine::new(db);
        let first = engine.continuation_recording_ids("anchor", 10).unwrap();
        let second = engine.continuation_recording_ids("anchor", 10).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first,
            vec![
                "album-after",
                "album-before",
                "similar",
                "same-artist",
                "same-genre",
                "library-fallback",
            ]
        );
        assert!(!first.iter().any(|id| id == "anchor"));
        assert!(!first.iter().any(|id| id == "unplayable-album"));
    }

    #[test]
    fn external_anchor_only_falls_back_to_known_relationships() {
        let db = init_memory_db().unwrap();
        seed_library_track(&db, "external-anchor", "artist-a");
        seed_library_track(&db, "same-artist", "artist-a");
        seed_library_track(&db, "unrelated-external", "artist-b");
        db.lock()
            .execute(
                "UPDATE recordings SET is_in_library = 0 WHERE id IN ('external-anchor', 'same-artist', 'unrelated-external')",
                [],
            )
            .unwrap();
        make_playable(&db, "same-artist");
        make_playable(&db, "unrelated-external");

        let ids = RecommendationEngine::new(db)
            .continuation_recording_ids("external-anchor", 10)
            .unwrap();

        assert_eq!(ids, vec!["same-artist"]);
    }
}
