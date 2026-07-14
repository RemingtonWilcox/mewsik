use crate::db::DbPool;
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

const OBSERVATION_FRAME_RETENTION: i64 = 48;
const EVENT_RETENTION_SECS: i64 = 400 * 24 * 60 * 60;

pub type StoreResult<T> = Result<T, DiscoveryStoreError>;

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryStoreError {
    #[error("discovery database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("discovery JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "external ID {namespace}:{external_id} belongs to {existing_entity_id}, not {attempted_entity_id}"
    )]
    ExternalIdCollision {
        namespace: String,
        external_id: String,
        existing_entity_id: String,
        attempted_entity_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiscoveryEntityInput {
    pub id: String,
    pub entity_type: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub release_date: Option<String>,
    pub artwork_url: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredDiscoveryEntity {
    pub id: String,
    pub entity_type: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub release_date: Option<String>,
    pub artwork_url: Option<String>,
    pub metadata: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExternalIdInput {
    pub entity_id: String,
    pub namespace: String,
    pub external_id: String,
    pub external_url: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredExternalId {
    pub entity_id: String,
    pub namespace: String,
    pub external_id: String,
    pub external_url: Option<String>,
    pub metadata: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One provider's measurements for one canonical entity at one sampling time.
/// `source` is the provider family (for example `apple` or `lastfm`) and
/// `scope` identifies the chart/territory (for example `us:songs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ObservationInput {
    pub entity_id: String,
    pub source: String,
    pub scope: String,
    pub observed_at: i64,
    pub rank_position: Option<i64>,
    pub chart_size: Option<i64>,
    pub listener_count: Option<i64>,
    pub play_count: Option<i64>,
    pub view_count: Option<i64>,
    pub engagement_count: Option<i64>,
    pub source_score: Option<f64>,
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredObservation {
    pub id: i64,
    pub entity_id: String,
    pub source: String,
    pub scope: String,
    pub observed_at: i64,
    pub rank_position: Option<i64>,
    pub chart_size: Option<i64>,
    pub listener_count: Option<i64>,
    pub play_count: Option<i64>,
    pub view_count: Option<i64>,
    pub engagement_count: Option<i64>,
    pub source_score: Option<f64>,
    pub metadata: Option<Value>,
    pub collected_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ObservationPair {
    pub current: Option<StoredObservation>,
    pub previous: Option<StoredObservation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SourceObservationFrame {
    pub observed_at: i64,
    pub observations: Vec<StoredObservation>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceObservationFrames {
    pub current: Option<SourceObservationFrame>,
    pub previous: Option<SourceObservationFrame>,
}

/// A persisted, deterministic feed. The fingerprint describes all inputs used
/// to rank it; callers can reuse the payload while that fingerprint is current.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedSnapshot<T> {
    pub key: String,
    pub algorithm_version: String,
    pub input_fingerprint: String,
    pub generated_at: i64,
    pub expires_at: Option<i64>,
    pub source_status: Option<Value>,
    pub payload: T,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiscoveryEventInput {
    pub entity_id: Option<String>,
    pub source: Option<String>,
    pub source_item_id: Option<String>,
    pub event_type: String,
    pub occurred_at: i64,
    pub context: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredDiscoveryEvent {
    pub id: i64,
    pub entity_id: Option<String>,
    pub source: Option<String>,
    pub source_item_id: Option<String>,
    pub event_type: String,
    pub occurred_at: i64,
    pub context: Option<Value>,
    pub created_at: i64,
}

pub fn upsert_entity(
    db: &DbPool,
    input: &DiscoveryEntityInput,
) -> StoreResult<StoredDiscoveryEntity> {
    let conn = db.lock();
    upsert_entity_inner(&conn, input)?;
    get_entity_inner(&conn, &input.id)?.ok_or_else(|| not_found_error("discovery entity"))
}

pub fn get_entity(db: &DbPool, entity_id: &str) -> StoreResult<Option<StoredDiscoveryEntity>> {
    get_entity_inner(&db.lock(), entity_id)
}

/// Loads canonical metadata in one locked query. Results are sorted by entity
/// ID and missing IDs are omitted, making this suitable for restoring a saved
/// source frame without N individual lookups.
pub fn load_entities(
    db: &DbPool,
    entity_ids: &[String],
) -> StoreResult<Vec<StoredDiscoveryEntity>> {
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", entity_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, entity_type, title, artist_name, release_date, artwork_url,
                metadata_json, created_at, updated_at
         FROM discovery_entities
         WHERE id IN ({placeholders})
         ORDER BY id ASC"
    );
    let conn = db.lock();
    let mut statement = conn.prepare(&sql)?;
    let entities = statement
        .query_map(rusqlite::params_from_iter(entity_ids), entity_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entities)
}

pub fn find_entity_by_external_id(
    db: &DbPool,
    namespace: &str,
    external_id: &str,
) -> StoreResult<Option<StoredDiscoveryEntity>> {
    let conn = db.lock();
    conn.query_row(
        "SELECT e.id, e.entity_type, e.title, e.artist_name, e.release_date,
                e.artwork_url, e.metadata_json, e.created_at, e.updated_at
         FROM discovery_external_ids x
         JOIN discovery_entities e ON e.id = x.entity_id
         WHERE x.namespace = ?1 AND x.external_id = ?2",
        params![namespace, external_id],
        entity_from_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn upsert_external_id(db: &DbPool, input: &ExternalIdInput) -> StoreResult<StoredExternalId> {
    let conn = db.lock();
    upsert_external_id_inner(&conn, input)?;
    get_external_id_inner(&conn, &input.namespace, &input.external_id)?
        .ok_or_else(|| not_found_error("discovery external ID"))
}

pub fn upsert_observation(db: &DbPool, input: &ObservationInput) -> StoreResult<StoredObservation> {
    let conn = db.lock();
    upsert_observation_inner(&conn, input)?;
    get_observation_inner(
        &conn,
        &input.entity_id,
        &input.source,
        &input.scope,
        input.observed_at,
    )?
    .ok_or_else(|| not_found_error("discovery observation"))
}

/// Atomically writes a complete provider sample while acquiring the database
/// lock only once. A failed row rolls the entire sample back.
pub fn upsert_observations(db: &DbPool, observations: &[ObservationInput]) -> StoreResult<()> {
    let mut conn = db.lock();
    let transaction = conn.transaction()?;
    for observation in observations {
        upsert_observation_inner(&transaction, observation)?;
    }
    prune_refresh_history_inner(&transaction, observations)?;
    transaction.commit()?;
    Ok(())
}

/// Atomically ingests identities, provider IDs, and observations in foreign-key
/// order. This is the preferred API for a complete chart/source refresh.
pub fn ingest_discovery_batch(
    db: &DbPool,
    entities: &[DiscoveryEntityInput],
    external_ids: &[ExternalIdInput],
    observations: &[ObservationInput],
) -> StoreResult<()> {
    let mut conn = db.lock();
    let transaction = conn.transaction()?;
    for entity in entities {
        upsert_entity_inner(&transaction, entity)?;
    }
    for external_id in external_ids {
        upsert_external_id_inner(&transaction, external_id)?;
    }
    for observation in observations {
        upsert_observation_inner(&transaction, observation)?;
    }
    prune_refresh_history_inner(&transaction, observations)?;
    transaction.commit()?;
    Ok(())
}

/// Returns the newest and immediately preceding sample for one entity/source.
pub fn load_observation_pair(
    db: &DbPool,
    entity_id: &str,
    source: &str,
    scope: &str,
) -> StoreResult<ObservationPair> {
    let conn = db.lock();
    let mut statement = conn.prepare(
        "SELECT id, entity_id, source, scope, observed_at, rank_position,
                chart_size, listener_count, play_count, view_count, engagement_count,
                source_score, metadata_json, collected_at
         FROM discovery_observations
         WHERE entity_id = ?1 AND source = ?2 AND scope = ?3
         ORDER BY observed_at DESC, id DESC
         LIMIT 2",
    )?;
    let mut rows = statement.query(params![entity_id, source, scope])?;
    let current = rows.next()?.map(observation_from_row).transpose()?;
    let previous = rows.next()?.map(observation_from_row).transpose()?;
    Ok(ObservationPair { current, previous })
}

/// Returns every entity in the latest two coherent samples for a source/scope.
/// Rows inside a frame are ordered by canonical entity ID for deterministic
/// ranking and fingerprint construction.
pub fn load_source_observation_frames(
    db: &DbPool,
    source: &str,
    scope: &str,
) -> StoreResult<SourceObservationFrames> {
    let conn = db.lock();
    let (current_at, previous_at): (Option<i64>, Option<i64>) = conn.query_row(
        "WITH latest(observed_at) AS (
             SELECT MAX(observed_at)
             FROM discovery_observations
             WHERE source = ?1 AND scope = ?2
         )
         SELECT latest.observed_at,
                (SELECT MAX(o.observed_at)
                 FROM discovery_observations o
                 WHERE o.source = ?1 AND o.scope = ?2
                   AND o.observed_at < latest.observed_at)
         FROM latest",
        params![source, scope],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let current = current_at
        .map(|observed_at| load_observation_frame_inner(&conn, source, scope, observed_at))
        .transpose()?;
    let previous = previous_at
        .map(|observed_at| load_observation_frame_inner(&conn, source, scope, observed_at))
        .transpose()?;
    Ok(SourceObservationFrames { current, previous })
}

pub fn persist_feed_snapshot<T: Serialize>(
    db: &DbPool,
    snapshot: &FeedSnapshot<T>,
) -> StoreResult<()> {
    let payload_json = serde_json::to_string(&snapshot.payload)?;
    let source_status_json = serialize_optional_json(snapshot.source_status.as_ref())?;
    let now = unix_now();
    db.lock().execute(
        "INSERT INTO discovery_feed_snapshots (
             snapshot_key, algorithm_version, input_fingerprint, generated_at,
             expires_at, source_status_json, payload_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(snapshot_key) DO UPDATE SET
             algorithm_version = excluded.algorithm_version,
             input_fingerprint = excluded.input_fingerprint,
             generated_at = excluded.generated_at,
             expires_at = excluded.expires_at,
             source_status_json = excluded.source_status_json,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at",
        params![
            snapshot.key,
            snapshot.algorithm_version,
            snapshot.input_fingerprint,
            snapshot.generated_at,
            snapshot.expires_at,
            source_status_json,
            payload_json,
            now,
        ],
    )?;
    Ok(())
}

pub fn load_feed_snapshot<T: DeserializeOwned>(
    db: &DbPool,
    key: &str,
) -> StoreResult<Option<FeedSnapshot<T>>> {
    let conn = db.lock();
    let row = conn
        .query_row(
            "SELECT snapshot_key, algorithm_version, input_fingerprint,
                    generated_at, expires_at, source_status_json, payload_json
             FROM discovery_feed_snapshots
             WHERE snapshot_key = ?1",
            params![key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;

    let Some((
        key,
        algorithm_version,
        input_fingerprint,
        generated_at,
        expires_at,
        source_status_json,
        payload_json,
    )) = row
    else {
        return Ok(None);
    };

    let source_status = match deserialize_optional_json(source_status_json) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("ignoring invalid discovery snapshot source status for {key}: {error}");
            return Ok(None);
        }
    };
    let payload = match serde_json::from_str(&payload_json) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("ignoring incompatible discovery snapshot payload for {key}: {error}");
            return Ok(None);
        }
    };
    Ok(Some(FeedSnapshot {
        key,
        algorithm_version,
        input_fingerprint,
        generated_at,
        expires_at,
        source_status,
        payload,
    }))
}

pub fn record_event(db: &DbPool, input: &DiscoveryEventInput) -> StoreResult<StoredDiscoveryEvent> {
    let context_json = serialize_optional_json(input.context.as_ref())?;
    let created_at = unix_now();
    let conn = db.lock();
    conn.execute(
        "DELETE FROM discovery_events WHERE occurred_at < ?1",
        params![created_at.saturating_sub(EVENT_RETENTION_SECS)],
    )?;
    conn.execute(
        "INSERT INTO discovery_events (
             entity_id, source, source_item_id, event_type, occurred_at,
             context_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            input.entity_id,
            input.source,
            input.source_item_id,
            input.event_type,
            input.occurred_at,
            context_json,
            created_at,
        ],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, entity_id, source, source_item_id, event_type, occurred_at,
                context_json, created_at
         FROM discovery_events WHERE id = ?1",
        params![id],
        event_from_row,
    )
    .map_err(Into::into)
}

fn prune_observation_frames_inner(
    conn: &Connection,
    source: &str,
    scope: &str,
    keep_frames: i64,
) -> StoreResult<()> {
    conn.execute(
        "DELETE FROM discovery_observations
         WHERE source = ?1 AND scope = ?2
           AND observed_at NOT IN (
               SELECT observed_at
               FROM (
                   SELECT DISTINCT observed_at
                   FROM discovery_observations
                   WHERE source = ?1 AND scope = ?2
                   ORDER BY observed_at DESC
                   LIMIT ?3
               )
           )",
        params![source, scope, keep_frames],
    )?;
    Ok(())
}

fn prune_refresh_history_inner(
    conn: &Connection,
    observations: &[ObservationInput],
) -> StoreResult<()> {
    let refreshed_scopes = observations
        .iter()
        .map(|observation| (observation.source.as_str(), observation.scope.as_str()))
        .collect::<BTreeSet<_>>();
    for (source, scope) in refreshed_scopes {
        prune_observation_frames_inner(conn, source, scope, OBSERVATION_FRAME_RETENTION)?;
    }
    conn.execute(
        "DELETE FROM discovery_entities
         WHERE NOT EXISTS (
             SELECT 1 FROM discovery_observations observation
             WHERE observation.entity_id = discovery_entities.id
         )
         AND NOT EXISTS (
             SELECT 1 FROM discovery_events event
             WHERE event.entity_id = discovery_entities.id
         )",
        [],
    )?;
    Ok(())
}

fn upsert_entity_inner(conn: &Connection, input: &DiscoveryEntityInput) -> StoreResult<()> {
    let metadata_json = serialize_optional_json(input.metadata.as_ref())?;
    let now = unix_now();
    conn.execute(
        "INSERT INTO discovery_entities (
             id, entity_type, title, artist_name, release_date, artwork_url,
             metadata_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET
             entity_type = excluded.entity_type,
             title = excluded.title,
             artist_name = COALESCE(excluded.artist_name, discovery_entities.artist_name),
             release_date = COALESCE(excluded.release_date, discovery_entities.release_date),
             artwork_url = COALESCE(excluded.artwork_url, discovery_entities.artwork_url),
             metadata_json = COALESCE(excluded.metadata_json, discovery_entities.metadata_json),
             updated_at = excluded.updated_at",
        params![
            input.id,
            input.entity_type,
            input.title,
            input.artist_name,
            input.release_date,
            input.artwork_url,
            metadata_json,
            now,
        ],
    )?;
    Ok(())
}

fn upsert_external_id_inner(conn: &Connection, input: &ExternalIdInput) -> StoreResult<()> {
    let existing_entity_id: Option<String> = conn
        .query_row(
            "SELECT entity_id FROM discovery_external_ids
             WHERE namespace = ?1 AND external_id = ?2",
            params![input.namespace, input.external_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_entity_id) = existing_entity_id {
        if existing_entity_id != input.entity_id {
            return Err(DiscoveryStoreError::ExternalIdCollision {
                namespace: input.namespace.clone(),
                external_id: input.external_id.clone(),
                existing_entity_id,
                attempted_entity_id: input.entity_id.clone(),
            });
        }
    }

    let metadata_json = serialize_optional_json(input.metadata.as_ref())?;
    let now = unix_now();
    conn.execute(
        "INSERT INTO discovery_external_ids (
             entity_id, namespace, external_id, external_url, metadata_json,
             created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(namespace, external_id) DO UPDATE SET
             external_url = COALESCE(excluded.external_url, discovery_external_ids.external_url),
             metadata_json = COALESCE(excluded.metadata_json, discovery_external_ids.metadata_json),
             updated_at = excluded.updated_at",
        params![
            input.entity_id,
            input.namespace,
            input.external_id,
            input.external_url,
            metadata_json,
            now,
        ],
    )?;
    Ok(())
}

fn upsert_observation_inner(conn: &Connection, input: &ObservationInput) -> StoreResult<()> {
    let metadata_json = serialize_optional_json(input.metadata.as_ref())?;
    let collected_at = unix_now();
    conn.execute(
        "INSERT INTO discovery_observations (
             entity_id, source, scope, observed_at, rank_position, chart_size,
             listener_count, play_count, view_count, engagement_count, source_score,
             metadata_json, collected_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(entity_id, source, scope, observed_at) DO UPDATE SET
             rank_position = excluded.rank_position,
             chart_size = excluded.chart_size,
             listener_count = excluded.listener_count,
             play_count = excluded.play_count,
             view_count = excluded.view_count,
             engagement_count = excluded.engagement_count,
             source_score = excluded.source_score,
             metadata_json = excluded.metadata_json,
             collected_at = excluded.collected_at",
        params![
            input.entity_id,
            input.source,
            input.scope,
            input.observed_at,
            input.rank_position,
            input.chart_size,
            input.listener_count,
            input.play_count,
            input.view_count,
            input.engagement_count,
            input.source_score,
            metadata_json,
            collected_at,
        ],
    )?;
    Ok(())
}

fn get_entity_inner(
    conn: &Connection,
    entity_id: &str,
) -> StoreResult<Option<StoredDiscoveryEntity>> {
    conn.query_row(
        "SELECT id, entity_type, title, artist_name, release_date, artwork_url,
                metadata_json, created_at, updated_at
         FROM discovery_entities WHERE id = ?1",
        params![entity_id],
        entity_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn get_external_id_inner(
    conn: &Connection,
    namespace: &str,
    external_id: &str,
) -> StoreResult<Option<StoredExternalId>> {
    conn.query_row(
        "SELECT entity_id, namespace, external_id, external_url, metadata_json,
                created_at, updated_at
         FROM discovery_external_ids
         WHERE namespace = ?1 AND external_id = ?2",
        params![namespace, external_id],
        external_id_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn get_observation_inner(
    conn: &Connection,
    entity_id: &str,
    source: &str,
    scope: &str,
    observed_at: i64,
) -> StoreResult<Option<StoredObservation>> {
    conn.query_row(
        "SELECT id, entity_id, source, scope, observed_at, rank_position,
                chart_size, listener_count, play_count, view_count, engagement_count,
                source_score, metadata_json, collected_at
         FROM discovery_observations
         WHERE entity_id = ?1 AND source = ?2 AND scope = ?3 AND observed_at = ?4",
        params![entity_id, source, scope, observed_at],
        observation_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn load_observation_frame_inner(
    conn: &Connection,
    source: &str,
    scope: &str,
    observed_at: i64,
) -> StoreResult<SourceObservationFrame> {
    let mut statement = conn.prepare(
        "SELECT id, entity_id, source, scope, observed_at, rank_position,
                chart_size, listener_count, play_count, view_count, engagement_count,
                source_score, metadata_json, collected_at
         FROM discovery_observations
         WHERE source = ?1 AND scope = ?2 AND observed_at = ?3
         ORDER BY entity_id ASC, id ASC",
    )?;
    let observations = statement
        .query_map(params![source, scope, observed_at], observation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SourceObservationFrame {
        observed_at,
        observations,
    })
}

fn entity_from_row(row: &Row<'_>) -> rusqlite::Result<StoredDiscoveryEntity> {
    Ok(StoredDiscoveryEntity {
        id: row.get(0)?,
        entity_type: row.get(1)?,
        title: row.get(2)?,
        artist_name: row.get(3)?,
        release_date: row.get(4)?,
        artwork_url: row.get(5)?,
        metadata: json_from_column(row, 6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn external_id_from_row(row: &Row<'_>) -> rusqlite::Result<StoredExternalId> {
    Ok(StoredExternalId {
        entity_id: row.get(0)?,
        namespace: row.get(1)?,
        external_id: row.get(2)?,
        external_url: row.get(3)?,
        metadata: json_from_column(row, 4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn observation_from_row(row: &Row<'_>) -> rusqlite::Result<StoredObservation> {
    Ok(StoredObservation {
        id: row.get(0)?,
        entity_id: row.get(1)?,
        source: row.get(2)?,
        scope: row.get(3)?,
        observed_at: row.get(4)?,
        rank_position: row.get(5)?,
        chart_size: row.get(6)?,
        listener_count: row.get(7)?,
        play_count: row.get(8)?,
        view_count: row.get(9)?,
        engagement_count: row.get(10)?,
        source_score: row.get(11)?,
        metadata: json_from_column(row, 12)?,
        collected_at: row.get(13)?,
    })
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredDiscoveryEvent> {
    Ok(StoredDiscoveryEvent {
        id: row.get(0)?,
        entity_id: row.get(1)?,
        source: row.get(2)?,
        source_item_id: row.get(3)?,
        event_type: row.get(4)?,
        occurred_at: row.get(5)?,
        context: json_from_column(row, 6)?,
        created_at: row.get(7)?,
    })
}

fn serialize_optional_json(value: Option<&Value>) -> Result<Option<String>, serde_json::Error> {
    value.map(serde_json::to_string).transpose()
}

fn deserialize_optional_json(value: Option<String>) -> Result<Option<Value>, serde_json::Error> {
    value.map(|json| serde_json::from_str(&json)).transpose()
}

fn json_from_column(row: &Row<'_>, column: usize) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = row.get(column)?;
    raw.map(|json| {
        serde_json::from_str(&json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
        })
    })
    .transpose()
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn not_found_error(kind: &str) -> DiscoveryStoreError {
    DiscoveryStoreError::Database(rusqlite::Error::InvalidParameterName(format!(
        "{kind} disappeared after write"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use serde_json::json;

    fn entity(id: &str, title: &str) -> DiscoveryEntityInput {
        DiscoveryEntityInput {
            id: id.to_string(),
            entity_type: "recording".to_string(),
            title: title.to_string(),
            artist_name: Some(format!("Artist {id}")),
            release_date: Some("2026-07-14".to_string()),
            artwork_url: None,
            metadata: Some(json!({ "seed": true })),
        }
    }

    fn observation(entity_id: &str, observed_at: i64, rank: i64) -> ObservationInput {
        ObservationInput {
            entity_id: entity_id.to_string(),
            source: "apple".to_string(),
            scope: "us:songs".to_string(),
            observed_at,
            rank_position: Some(rank),
            chart_size: Some(100),
            listener_count: None,
            play_count: Some(10_000 + rank),
            view_count: None,
            engagement_count: None,
            source_score: Some(1.0 - rank as f64 / 100.0),
            metadata: Some(json!({ "territory": "US" })),
        }
    }

    #[test]
    fn migration_creates_discovery_v2_schema() {
        let db = init_memory_db().expect("database");
        let conn = db.lock();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .expect("migration version");
        assert!(version >= 7);

        for table in [
            "discovery_entities",
            "discovery_external_ids",
            "discovery_observations",
            "discovery_feed_snapshots",
            "discovery_events",
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    params![table],
                    |row| row.get(0),
                )
                .expect("schema query");
            assert!(exists, "missing table {table}");
        }
    }

    #[test]
    fn identities_are_upserted_and_resolved_by_external_id() {
        let db = init_memory_db().expect("database");
        upsert_entity(&db, &entity("recording-1", "First title")).expect("initial entity");

        let mut updated = entity("recording-1", "Updated title");
        updated.artist_name = None;
        updated.release_date = None;
        updated.artwork_url = Some("https://example.test/art.jpg".to_string());
        updated.metadata = None;
        let stored = upsert_entity(&db, &updated).expect("updated entity");
        assert_eq!(stored.title, "Updated title");
        assert_eq!(stored.artist_name.as_deref(), Some("Artist recording-1"));
        assert_eq!(stored.release_date.as_deref(), Some("2026-07-14"));
        assert_eq!(stored.metadata, Some(json!({ "seed": true })));

        let external = ExternalIdInput {
            entity_id: "recording-1".to_string(),
            namespace: "isrc".to_string(),
            external_id: "USABC2600001".to_string(),
            external_url: None,
            metadata: None,
        };
        upsert_external_id(&db, &external).expect("external ID");
        let resolved = find_entity_by_external_id(&db, "isrc", "USABC2600001")
            .expect("lookup")
            .expect("entity");
        assert_eq!(resolved.id, "recording-1");
    }

    #[test]
    fn external_id_collision_never_silently_reassigns_identity() {
        let db = init_memory_db().expect("database");
        upsert_entity(&db, &entity("first", "First")).expect("first entity");
        upsert_entity(&db, &entity("second", "Second")).expect("second entity");
        let mut external = ExternalIdInput {
            entity_id: "first".to_string(),
            namespace: "isrc".to_string(),
            external_id: "USABC2600002".to_string(),
            external_url: None,
            metadata: None,
        };
        upsert_external_id(&db, &external).expect("first mapping");

        external.entity_id = "second".to_string();
        let error = upsert_external_id(&db, &external).expect_err("collision");
        assert!(matches!(
            error,
            DiscoveryStoreError::ExternalIdCollision { .. }
        ));
        let resolved = find_entity_by_external_id(&db, "isrc", "USABC2600002")
            .expect("lookup")
            .expect("entity");
        assert_eq!(resolved.id, "first");
    }

    #[test]
    fn observations_upsert_and_return_current_previous_frames() {
        let db = init_memory_db().expect("database");
        let entities = vec![entity("a", "A"), entity("b", "B")];
        let initial = vec![observation("a", 100, 9), observation("b", 100, 4)];
        ingest_discovery_batch(&db, &entities, &[], &initial).expect("initial refresh");

        let latest = vec![observation("b", 200, 2), observation("a", 200, 7)];
        upsert_observations(&db, &latest).expect("latest refresh");
        let mut corrected = observation("a", 200, 6);
        corrected.play_count = Some(25_000);
        corrected.view_count = Some(1_250_000);
        let corrected = upsert_observation(&db, &corrected).expect("corrected observation");
        assert_eq!(corrected.rank_position, Some(6));
        assert_eq!(corrected.play_count, Some(25_000));
        assert_eq!(corrected.view_count, Some(1_250_000));

        let pair = load_observation_pair(&db, "a", "apple", "us:songs").expect("pair");
        assert_eq!(pair.current.expect("current").rank_position, Some(6));
        assert_eq!(pair.previous.expect("previous").rank_position, Some(9));

        let frames = load_source_observation_frames(&db, "apple", "us:songs").expect("frames");
        let current = frames.current.expect("current frame");
        assert_eq!(current.observed_at, 200);
        assert_eq!(
            current
                .observations
                .iter()
                .map(|item| item.entity_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(frames.previous.expect("previous frame").observed_at, 100);
    }

    #[test]
    fn failed_batch_is_rolled_back() {
        let db = init_memory_db().expect("database");
        let valid = entity("valid", "Valid");
        let invalid_observation = observation("missing", 100, 1);
        assert!(ingest_discovery_batch(&db, &[valid], &[], &[invalid_observation]).is_err());
        assert!(get_entity(&db, "valid").expect("lookup").is_none());
    }

    #[test]
    fn observation_history_is_bounded_to_recent_coherent_frames() {
        let db = init_memory_db().expect("database");
        let source_entity = entity("bounded", "Bounded");
        for observed_at in 1..=50 {
            let sample = observation("bounded", observed_at, 1);
            ingest_discovery_batch(&db, std::slice::from_ref(&source_entity), &[], &[sample])
                .expect("sample ingest");
        }

        let conn = db.lock();
        let (count, oldest, newest): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MIN(observed_at), MAX(observed_at)
                 FROM discovery_observations
                 WHERE source = 'apple' AND scope = 'us:songs'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("retention query");
        assert_eq!((count, oldest, newest), (48, 3, 50));
    }

    #[test]
    fn feed_snapshot_round_trips_and_replaces_atomically() {
        let db = init_memory_db().expect("database");
        let first = FeedSnapshot {
            key: "search-discovery".to_string(),
            algorithm_version: "v2".to_string(),
            input_fingerprint: "apple:100".to_string(),
            generated_at: 100,
            expires_at: Some(200),
            source_status: Some(json!({ "apple": "fresh" })),
            payload: vec!["first".to_string()],
        };
        persist_feed_snapshot(&db, &first).expect("first snapshot");

        let mut second = first.clone();
        second.input_fingerprint = "apple:200".to_string();
        second.generated_at = 200;
        second.payload = vec!["second".to_string()];
        persist_feed_snapshot(&db, &second).expect("replacement snapshot");

        let loaded: FeedSnapshot<Vec<String>> = load_feed_snapshot(&db, "search-discovery")
            .expect("load snapshot")
            .expect("snapshot");
        assert_eq!(loaded, second);
        assert!(load_feed_snapshot::<Vec<String>>(&db, "missing")
            .expect("missing lookup")
            .is_none());
    }

    #[test]
    fn incompatible_snapshot_payload_is_a_cache_miss() {
        let db = init_memory_db().expect("database");
        let snapshot = FeedSnapshot {
            key: "typed-feed".to_string(),
            algorithm_version: "v2".to_string(),
            input_fingerprint: "input".to_string(),
            generated_at: 100,
            expires_at: None,
            source_status: None,
            payload: vec!["item".to_string()],
        };
        persist_feed_snapshot(&db, &snapshot).expect("snapshot");
        assert!(load_feed_snapshot::<Vec<i64>>(&db, "typed-feed")
            .expect("incompatible cache read")
            .is_none());
    }

    #[test]
    fn events_support_canonical_and_source_only_items() {
        let db = init_memory_db().expect("database");
        upsert_entity(&db, &entity("known", "Known")).expect("entity");
        let known = record_event(
            &db,
            &DiscoveryEventInput {
                entity_id: Some("known".to_string()),
                source: Some("apple".to_string()),
                source_item_id: Some("123".to_string()),
                event_type: "click".to_string(),
                occurred_at: 100,
                context: Some(json!({ "shelf": "moving-fast", "position": 2 })),
            },
        )
        .expect("known event");
        assert_eq!(known.entity_id.as_deref(), Some("known"));
        assert_eq!(known.context.expect("context")["position"], 2);

        let source_only = record_event(
            &db,
            &DiscoveryEventInput {
                entity_id: None,
                source: Some("editorial".to_string()),
                source_item_id: Some("article-1".to_string()),
                event_type: "impression".to_string(),
                occurred_at: 101,
                context: None,
            },
        )
        .expect("source-only event");
        assert!(source_only.entity_id.is_none());
    }
}
