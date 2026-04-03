use crate::db::models::LibraryTrack;
use crate::db::DbPool;
use rusqlite::{params, Row};
use std::collections::{HashMap, HashSet};

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
        let history_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM play_history WHERE recording_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if history_count < 5 {
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

                        UNION ALL

                        SELECT
                            rs.recording_id_a AS recording_id,
                            rs.score AS score
                        FROM recording_similarities rs
                        JOIN play_history ph
                          ON ph.recording_id = rs.recording_id_b
                        WHERE ph.started_at > datetime('now', '-30 days')
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
                        COALESCE(recent_track_stats.play_count, 0) * 0.75 +
                        ((ABS(RANDOM()) % 1000) / 1000.0)
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
                ORDER BY recommendation_score DESC
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
                    (
                        COUNT(ph.id) * 3.5 +
                        MIN(julianday('now') - julianday(MAX(ph.started_at)), 365) / 5.0 +
                        SUM(CASE WHEN ph.completed = 1 THEN 1 ELSE 0 END) * 0.5 +
                        ((ABS(RANDOM()) % 1000) / 1000.0)
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
                ORDER BY rediscover_score DESC
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
                        ) THEN 1
                        ELSE 0
                    END,
                    r.created_at DESC,
                    RANDOM()
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
                "SELECT COALESCE(SUM(duration_ms), 0) FROM play_history WHERE duration_ms IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let unique_tracks: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT recording_id) FROM play_history WHERE recording_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(PlayStats {
            total_plays,
            total_time_ms,
            unique_tracks,
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
        score: row.get(12)?,
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
        is_downloaded: false,
        playlist_track_id: None,
        playlist_position: None,
    })
}
