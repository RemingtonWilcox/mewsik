use crate::db::DbPool;
use crate::discovery::sources::{
    self, SourceBatch, SourceConfig, SourceFetchReport, SourceItem, SourceItemKind, SourceMetrics,
    APPLE_SOURCE, BANDCAMP_SOURCE, LASTFM_SOURCE, LISTENBRAINZ_SOURCE, YOUTUBE_SOURCE,
};
use crate::discovery::store::{
    self, DiscoveryEntityInput, ExternalIdInput, FeedSnapshot, ObservationInput, StoredObservation,
};
use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering as AtomicOrdering};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

const SNAPSHOT_KEY: &str = "search-discovery-v2";
const ALGORITHM_VERSION: &str = "discovery-v2.3";
const SECTION_SIZE: usize = 8;
const FAILURE_RETRY_SECS: i64 = 60;
const HOSTED_RETRY_SECS: i64 = 15 * 60;
const MANUAL_REFRESH_COOLDOWN_SECS: i64 = 60;
const PROFILE_TRACK_GOAL: i64 = 5;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SearchDiscoveryFeed {
    pub snapshot_id: String,
    pub generated_at: i64,
    pub source: String,
    pub is_stale: bool,
    pub is_fallback: bool,
    pub has_history: bool,
    pub next_refresh_at: Option<i64>,
    pub source_statuses: Vec<DiscoverySourceStatus>,
    pub sections: Vec<SearchDiscoverySection>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoverySourceStatus {
    pub id: String,
    pub label: String,
    pub state: String,
    pub updated_at: Option<i64>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SearchDiscoverySection {
    pub id: String,
    pub kind: String,
    pub personalized: bool,
    pub title: String,
    pub subtitle: String,
    pub items: Vec<SearchDiscoveryItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SearchDiscoveryItem {
    pub id: String,
    pub item_kind: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub search_query: String,
    pub listen_count: Option<u64>,
    pub rank: Option<u32>,
    pub momentum: Option<i32>,
    pub context: Option<String>,
    pub reason: Option<String>,
    pub source_labels: Vec<String>,
    pub release_date: Option<String>,
    pub audience_delta: Option<i64>,
    pub audience_label: Option<String>,
}

pub struct DiscoveryFeedRuntime {
    db: DbPool,
    client: Client,
    config: SourceConfig,
    refresh_lock: AsyncMutex<()>,
    hosted_not_before: AtomicI64,
}

impl DiscoveryFeedRuntime {
    pub fn new(db: DbPool, config: SourceConfig) -> Self {
        let client = sources::build_source_client().unwrap_or_else(|error| {
            log::warn!("Discovery HTTP client fell back to defaults: {error}");
            Client::new()
        });
        Self {
            db,
            client,
            config,
            refresh_lock: AsyncMutex::new(()),
            hosted_not_before: AtomicI64::new(0),
        }
    }

    pub async fn get_feed(&self, force: bool) -> SearchDiscoveryFeed {
        let mut now = Utc::now();
        if !force {
            if let Some(feed) = self.valid_snapshot(now.timestamp()) {
                return feed;
            }
        } else if let Some(snapshot) = self.compatible_snapshot() {
            if !snapshot.payload.is_stale
                && !snapshot.payload.is_fallback
                && snapshot.generated_at + MANUAL_REFRESH_COOLDOWN_SECS > now.timestamp()
            {
                return snapshot.payload;
            }
        }

        let _guard = self.refresh_lock.lock().await;
        now = Utc::now();
        if !force {
            if let Some(feed) = self.valid_snapshot(now.timestamp()) {
                return feed;
            }
        } else if let Some(snapshot) = self.compatible_snapshot() {
            if !snapshot.payload.is_stale
                && !snapshot.payload.is_fallback
                && snapshot.generated_at + MANUAL_REFRESH_COOLDOWN_SECS > now.timestamp()
            {
                return snapshot.payload;
            }
        }

        let previous_snapshot = self.compatible_snapshot();
        let specs = source_specs(&self.config);
        let requested_sources = specs
            .iter()
            .filter(|spec| {
                source_should_refresh(
                    &self.db,
                    spec,
                    now.timestamp(),
                    force,
                    self.hosted_not_before.load(AtomicOrdering::Relaxed),
                )
            })
            .map(|spec| spec.id.to_string())
            .collect::<HashSet<_>>();
        let report = sources::fetch_all(&self.client, &self.config, now, &requested_sources).await;
        if specs
            .iter()
            .any(|spec| spec.uses_hosted_snapshot && requested_sources.contains(spec.id))
        {
            let next_attempt = report
                .hosted_next_refresh_at
                .filter(|refresh_at| *refresh_at > now.timestamp())
                .unwrap_or(now.timestamp() + HOSTED_RETRY_SECS);
            self.hosted_not_before
                .store(next_attempt, AtomicOrdering::Relaxed);
        }
        let failed_statuses =
            build_source_statuses(&self.config, &[], &[], &report, now.timestamp());
        match self.refresh_from_report(report, now) {
            Ok(feed) => feed,
            Err(error) => {
                log::warn!("Discovery v2 refresh failed: {error}");
                let feed = if let Some(mut snapshot) = previous_snapshot {
                    snapshot.payload.is_stale = true;
                    snapshot.payload.next_refresh_at = Some(now.timestamp() + FAILURE_RETRY_SECS);
                    snapshot.payload.source_statuses = failed_statuses
                        .into_iter()
                        .map(|mut status| {
                            if status.updated_at.is_none() {
                                status.updated_at = snapshot
                                    .payload
                                    .source_statuses
                                    .iter()
                                    .find(|previous| previous.id == status.id)
                                    .and_then(|previous| previous.updated_at);
                            }
                            status
                        })
                        .collect();
                    snapshot.payload
                } else {
                    bundled_fallback_feed(now.timestamp(), failed_statuses)
                };
                self.persist_failure_backoff(&feed, now.timestamp());
                feed
            }
        }
    }

    fn persist_failure_backoff(&self, feed: &SearchDiscoveryFeed, now: i64) {
        let retry_at = now + FAILURE_RETRY_SECS;
        let snapshot = FeedSnapshot {
            key: SNAPSHOT_KEY.to_string(),
            algorithm_version: ALGORITHM_VERSION.to_string(),
            input_fingerprint: format!("refresh-failed-{now}"),
            generated_at: feed.generated_at,
            expires_at: Some(retry_at),
            source_status: serde_json::to_value(&feed.source_statuses).ok(),
            payload: feed.clone(),
        };
        if let Err(error) = store::persist_feed_snapshot(&self.db, &snapshot) {
            log::warn!("Could not persist discovery retry backoff: {error}");
        }
    }

    fn valid_snapshot(&self, now: i64) -> Option<SearchDiscoveryFeed> {
        self.compatible_snapshot().and_then(|snapshot| {
            snapshot
                .expires_at
                .filter(|expires_at| *expires_at > now)
                .map(|_| snapshot.payload)
        })
    }

    fn compatible_snapshot(&self) -> Option<FeedSnapshot<SearchDiscoveryFeed>> {
        match store::load_feed_snapshot::<SearchDiscoveryFeed>(&self.db, SNAPSHOT_KEY) {
            Ok(Some(snapshot)) if snapshot.algorithm_version == ALGORITHM_VERSION => Some(snapshot),
            Ok(_) => None,
            Err(error) => {
                log::warn!("Ignoring incompatible discovery snapshot: {error}");
                None
            }
        }
    }

    fn refresh_from_report(
        &self,
        mut report: SourceFetchReport,
        now: DateTime<Utc>,
    ) -> Result<SearchDiscoveryFeed, String> {
        let mut live_batches = Vec::new();
        for batch in report.batches.drain(..) {
            match ingest_batch(&self.db, &batch) {
                Ok(()) => live_batches.push(batch),
                Err(error) => report.failures.push(sources::SourceFailure {
                    source: batch.source,
                    message: format!("persistence rejected the source batch: {error}"),
                }),
            }
        }

        let mut live_scopes = HashMap::<String, HashSet<String>>::new();
        for batch in &live_batches {
            for item in &batch.items {
                live_scopes
                    .entry(batch.source.clone())
                    .or_default()
                    .insert(scope_for_item(item));
            }
        }
        let mut cached_batches = Vec::new();
        for spec in source_specs(&self.config) {
            let excluded = live_scopes.get(spec.id).cloned().unwrap_or_default();
            if let Some(batch) = load_cached_batch(&self.db, &spec, now.timestamp(), &excluded) {
                cached_batches.push(batch);
            }
        }

        let statuses = build_source_statuses(
            &self.config,
            &live_batches,
            &cached_batches,
            &report,
            now.timestamp(),
        );
        let mut batches = live_batches;
        batches.extend(cached_batches);
        if batches.is_empty() {
            return Err("no live or recent cached discovery source was usable".to_string());
        }

        let taste = load_taste_profile(&self.db)?;
        let (mut feed, fingerprint) = build_feed(&self.db, &batches, statuses, &taste, now)?;
        let specs = source_specs(&self.config);
        let expires_at = next_source_refresh(&self.db, &specs, &report, now.timestamp());
        feed.next_refresh_at = Some(expires_at);
        let snapshot = FeedSnapshot {
            key: SNAPSHOT_KEY.to_string(),
            algorithm_version: ALGORITHM_VERSION.to_string(),
            input_fingerprint: fingerprint,
            generated_at: feed.generated_at,
            expires_at: Some(expires_at),
            source_status: serde_json::to_value(&feed.source_statuses).ok(),
            payload: feed.clone(),
        };
        store::persist_feed_snapshot(&self.db, &snapshot).map_err(|error| error.to_string())?;
        Ok(feed)
    }
}

pub type SharedDiscoveryFeedRuntime = Arc<DiscoveryFeedRuntime>;

#[derive(Clone)]
struct SourceSpec {
    id: &'static str,
    family: &'static str,
    label: &'static str,
    cadence_secs: i64,
    scopes: Vec<String>,
    optional: bool,
    enabled: bool,
    uses_hosted_snapshot: bool,
}

fn source_specs(config: &SourceConfig) -> Vec<SourceSpec> {
    let hosted_enabled = config.hosted_snapshot_url.is_some();
    let has_lastfm_key = config
        .lastfm_api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty());
    let has_youtube_key = config
        .youtube_api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty());
    let uses_hosted_lastfm = hosted_enabled && !has_lastfm_key;
    let uses_hosted_youtube = hosted_enabled && !has_youtube_key;
    vec![
        SourceSpec {
            id: APPLE_SOURCE,
            family: "apple",
            label: "Apple Music charts",
            cadence_secs: 4 * 60 * 60,
            scopes: config
                .apple_markets
                .iter()
                .map(|market| market.to_uppercase())
                .collect(),
            optional: false,
            enabled: true,
            uses_hosted_snapshot: false,
        },
        SourceSpec {
            id: LISTENBRAINZ_SOURCE,
            family: "listenbrainz",
            label: "ListenBrainz fresh releases",
            cadence_secs: 24 * 60 * 60,
            scopes: vec!["global".to_string()],
            optional: false,
            enabled: true,
            uses_hosted_snapshot: false,
        },
        SourceSpec {
            id: BANDCAMP_SOURCE,
            family: "bandcamp",
            label: "Bandcamp Daily",
            cadence_secs: 6 * 60 * 60,
            scopes: vec!["daily".to_string()],
            optional: false,
            enabled: true,
            uses_hosted_snapshot: false,
        },
        SourceSpec {
            id: LASTFM_SOURCE,
            family: "lastfm",
            label: "Last.fm charts",
            cadence_secs: 4 * 60 * 60,
            scopes: vec!["global".to_string()],
            optional: true,
            enabled: hosted_enabled || has_lastfm_key,
            uses_hosted_snapshot: uses_hosted_lastfm,
        },
        SourceSpec {
            id: YOUTUBE_SOURCE,
            family: "youtube",
            label: "YouTube music heat",
            cadence_secs: 60 * 60,
            // The shared snapshot has one documented US chart. A custom market
            // applies only to the direct developer-key adapter.
            scopes: vec![if uses_hosted_youtube {
                "US".to_string()
            } else {
                config.youtube_market.to_uppercase()
            }],
            optional: true,
            enabled: hosted_enabled || has_youtube_key,
            uses_hosted_snapshot: uses_hosted_youtube,
        },
    ]
}

fn source_is_due(db: &DbPool, spec: &SourceSpec, now: i64) -> bool {
    spec.enabled
        && spec.scopes.iter().any(|scope| {
            store::load_source_observation_frames(db, spec.family, scope)
                .ok()
                .and_then(|frames| frames.current)
                .is_none_or(|frame| frame.observed_at + spec.cadence_secs <= now)
        })
}

fn source_should_refresh(
    db: &DbPool,
    spec: &SourceSpec,
    now: i64,
    force: bool,
    hosted_not_before: i64,
) -> bool {
    spec.enabled
        && (force
            || ((!spec.uses_hosted_snapshot || now >= hosted_not_before)
                && source_is_due(db, spec, now)))
}

fn next_source_refresh(
    db: &DbPool,
    specs: &[SourceSpec],
    report: &SourceFetchReport,
    now: i64,
) -> i64 {
    let mut candidates = specs
        .iter()
        .filter(|spec| spec.enabled && !spec.uses_hosted_snapshot)
        .flat_map(|spec| {
            spec.scopes.iter().map(move |scope| {
                store::load_source_observation_frames(db, spec.family, scope)
                    .ok()
                    .and_then(|frames| frames.current)
                    .map(|frame| frame.observed_at + spec.cadence_secs)
                    .unwrap_or(now + FAILURE_RETRY_SECS)
            })
        })
        .collect::<Vec<_>>();

    if specs
        .iter()
        .any(|spec| spec.enabled && spec.uses_hosted_snapshot)
    {
        candidates.push(
            report
                .hosted_next_refresh_at
                .filter(|refresh_at| *refresh_at > now)
                .unwrap_or(now + HOSTED_RETRY_SECS),
        );
    }

    candidates
        .into_iter()
        .min()
        .unwrap_or(now + FAILURE_RETRY_SECS)
        .max(now + FAILURE_RETRY_SECS)
}

fn load_cached_batch(
    db: &DbPool,
    spec: &SourceSpec,
    now: i64,
    excluded_scopes: &HashSet<String>,
) -> Option<SourceBatch> {
    let mut items = Vec::new();
    let mut fetched_at = 0;
    let mut loaded_scopes = Vec::new();
    let max_age = spec.cadence_secs.saturating_mul(3);
    let mut seen = HashSet::new();
    for scope in &spec.scopes {
        if excluded_scopes.contains(scope) {
            continue;
        }
        let Ok(frames) = store::load_source_observation_frames(db, spec.family, scope) else {
            continue;
        };
        let Some(frame) = frames.current else {
            continue;
        };
        if now.saturating_sub(frame.observed_at) > max_age {
            continue;
        }
        fetched_at = fetched_at.max(frame.observed_at);
        loaded_scopes.push(scope.clone());
        for observation in frame.observations {
            let item = observation
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("item"))
                .and_then(|item| serde_json::from_value::<SourceItem>(item.clone()).ok());
            if let Some(item) = item {
                let key = format!(
                    "{}:{}",
                    item.source_item_id,
                    item.market.as_deref().unwrap_or("")
                );
                if seen.insert(key) {
                    items.push(item);
                }
            }
        }
    }
    if items.is_empty() {
        None
    } else {
        Some(SourceBatch {
            source: spec.id.to_string(),
            label: format!("{} (cached {})", spec.label, loaded_scopes.join(", ")),
            fetched_at,
            cadence_secs: spec.cadence_secs as u64,
            items,
        })
    }
}

fn build_source_statuses(
    config: &SourceConfig,
    live: &[SourceBatch],
    cached: &[SourceBatch],
    report: &SourceFetchReport,
    now: i64,
) -> Vec<DiscoverySourceStatus> {
    let failures = report
        .failures
        .iter()
        .map(|failure| (failure.source.as_str(), failure.message.as_str()))
        .collect::<HashMap<_, _>>();
    let skipped = report
        .skipped
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    source_specs(config)
        .into_iter()
        .map(|spec| {
            if let Some(batch) = live.iter().find(|batch| batch.source == spec.id) {
                let cached_items = cached
                    .iter()
                    .filter(|cached_batch| cached_batch.source == spec.id)
                    .map(|cached_batch| cached_batch.items.len())
                    .sum::<usize>();
                let delivered = report.delivery_statuses.get(spec.id);
                let default_detail = if cached_items > 0 {
                    format!(
                        "{} delivered items; {} recent saved items filled missing scopes",
                        batch.items.len(),
                        cached_items
                    )
                } else {
                    format!("{} usable items", batch.items.len())
                };
                DiscoverySourceStatus {
                    id: spec.id.to_string(),
                    label: batch.label.clone(),
                    state: delivered
                        .map(|status| status.state.as_str())
                        .unwrap_or("live")
                        .to_string(),
                    updated_at: Some(batch.fetched_at),
                    detail: delivered
                        .and_then(|status| status.detail.clone())
                        .or(Some(default_detail)),
                }
            } else if let Some(batch) = cached.iter().find(|batch| batch.source == spec.id) {
                let oldest_observation = batch
                    .items
                    .iter()
                    .map(|item| item.observed_at)
                    .min()
                    .unwrap_or(batch.fetched_at);
                let within_cadence = now.saturating_sub(oldest_observation) <= spec.cadence_secs;
                DiscoverySourceStatus {
                    id: spec.id.to_string(),
                    label: spec.label.to_string(),
                    state: if within_cadence { "cached" } else { "stale" }.to_string(),
                    updated_at: Some(batch.fetched_at),
                    detail: failures
                        .get(spec.id)
                        .map(|message| format!("Live refresh failed; using saved data: {message}"))
                        .or_else(|| {
                            report
                                .delivery_statuses
                                .get(spec.id)
                                .and_then(|status| status.detail.clone())
                        })
                        .or_else(|| {
                            Some(if within_cadence {
                                "Using a saved observation still inside its source cadence"
                                    .to_string()
                            } else {
                                "Using an older saved observation while this source recovers"
                                    .to_string()
                            })
                        }),
                }
            } else {
                let detail = failures
                    .get(spec.id)
                    .map(|message| (*message).to_string())
                    .or_else(|| {
                        report
                            .delivery_statuses
                            .get(spec.id)
                            .and_then(|status| status.detail.clone())
                    })
                    .or_else(|| {
                        (skipped.contains(spec.id) || spec.optional).then(|| {
                            "Not enabled in this build; no listener setup is required".to_string()
                        })
                    });
                DiscoverySourceStatus {
                    id: spec.id.to_string(),
                    label: spec.label.to_string(),
                    state: "unavailable".to_string(),
                    updated_at: None,
                    detail: detail.or_else(|| Some(format!("Unavailable at {now}"))),
                }
            }
        })
        .collect()
}

fn ingest_batch(db: &DbPool, batch: &SourceBatch) -> Result<(), String> {
    let mut entities = BTreeMap::<String, DiscoveryEntityInput>::new();
    let mut external_ids = BTreeMap::<(String, String), ExternalIdInput>::new();
    let mut observations = Vec::new();
    let mut chart_sizes = HashMap::<String, i64>::new();
    for item in &batch.items {
        if let Some(rank) = item.rank {
            chart_sizes
                .entry(scope_for_item(item))
                .and_modify(|size| *size = (*size).max(i64::from(rank)))
                .or_insert_with(|| i64::from(rank));
        }
    }

    for item in &batch.items {
        let Some(artist) = display_artist(item) else {
            continue;
        };
        if item.title.trim().is_empty() {
            continue;
        }
        let entity_id = entity_id_for_item(item);
        let entity_type = item_kind_name(&item.item_kind).to_string();
        entities.insert(
            entity_id.clone(),
            DiscoveryEntityInput {
                id: entity_id.clone(),
                entity_type,
                title: item.title.trim().to_string(),
                artist_name: Some(artist),
                release_date: item.release_date.clone(),
                artwork_url: validated_artwork_url(item.artwork_url.as_deref()),
                metadata: Some(json!({ "item": item, "source_label": batch.label })),
            },
        );

        let provider_namespace = format!("provider:{}", item.source);
        external_ids.insert(
            (provider_namespace.clone(), item.source_item_id.clone()),
            ExternalIdInput {
                entity_id: entity_id.clone(),
                namespace: provider_namespace,
                external_id: item.source_item_id.clone(),
                external_url: item.editorial_url.clone(),
                metadata: None,
            },
        );
        for (namespace, external_id) in &item.external_ids {
            if !is_entity_external_id(namespace) || external_id.trim().is_empty() {
                continue;
            }
            external_ids.insert(
                (namespace.clone(), external_id.clone()),
                ExternalIdInput {
                    entity_id: entity_id.clone(),
                    namespace: namespace.clone(),
                    external_id: external_id.clone(),
                    external_url: item.editorial_url.clone(),
                    metadata: None,
                },
            );
        }

        let scope = scope_for_item(item);
        let chart_size = item.rank.and_then(|_| chart_sizes.get(&scope).copied());
        let listener_count = item
            .metrics
            .listener_count
            .or_else(|| {
                (item.metrics == SourceMetrics::default())
                    .then_some(item.audience_count)
                    .flatten()
            })
            .and_then(|count| i64::try_from(count).ok());
        let play_count = item
            .metrics
            .play_count
            .and_then(|count| i64::try_from(count).ok());
        let view_count = item
            .metrics
            .view_count
            .and_then(|count| i64::try_from(count).ok());
        let engagement_count = item
            .metrics
            .like_count
            .and_then(|count| i64::try_from(count).ok());
        let source_score = item
            .rank
            .and_then(|rank| chart_size.map(|size| normalized_rank(rank as i64, size)))
            .or_else(|| matches!(item.item_kind, SourceItemKind::Editorial).then_some(1.0));
        observations.push(ObservationInput {
            entity_id,
            source: item.source_family.clone(),
            scope,
            observed_at: item.observed_at,
            rank_position: item.rank.map(i64::from),
            chart_size,
            listener_count,
            play_count,
            view_count,
            engagement_count,
            source_score,
            metadata: Some(json!({ "item": item, "source_label": batch.label })),
        });
    }

    store::ingest_discovery_batch(
        db,
        &entities.into_values().collect::<Vec<_>>(),
        &external_ids.into_values().collect::<Vec<_>>(),
        &observations,
    )
    .map_err(|error| error.to_string())
}

fn is_entity_external_id(namespace: &str) -> bool {
    !namespace.contains("artist")
        && matches!(
            namespace,
            "isrc"
                | "musicbrainz_recording_id"
                | "musicbrainz_release_id"
                | "musicbrainz_release_group_id"
                | "apple_music_track_id"
                | "youtube_video_id"
                | "lastfm_track_url"
        )
}

fn entity_id_for_item(item: &SourceItem) -> String {
    for namespace in [
        "isrc",
        "musicbrainz_recording_id",
        "musicbrainz_release_group_id",
        "musicbrainz_release_id",
    ] {
        if let Some(value) = item
            .external_ids
            .get(namespace)
            .filter(|value| !value.trim().is_empty())
        {
            return format!(
                "{}:{}",
                item_kind_name(&item.item_kind),
                digest(&format!("{namespace}:{value}"))
            );
        }
    }
    format!(
        "{}:{}",
        item_kind_name(&item.item_kind),
        digest(&format!("{}:{}", item.source, item.source_item_id))
    )
}

fn scope_for_item(item: &SourceItem) -> String {
    item.market
        .as_deref()
        .map(str::to_uppercase)
        .unwrap_or_else(|| match item.item_kind {
            SourceItemKind::Editorial => "daily".to_string(),
            _ => "global".to_string(),
        })
}

#[derive(Clone, Debug, Default)]
struct TasteProfile {
    ready: bool,
    artists: HashMap<String, f64>,
    genres: HashMap<String, f64>,
    recent_tracks: HashSet<String>,
}

fn load_taste_profile(db: &DbPool) -> Result<TasteProfile, String> {
    let conn = db.lock();
    let unique_tracks: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT recording_id) FROM play_history
             WHERE recording_id IS NOT NULL
               AND COALESCE(listened_ms, duration_ms, 0) >= 30000",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let mut artist_weights = HashMap::<String, f64>::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT a.name,
                        SUM(CASE
                            WHEN julianday(ph.started_at) >= julianday('now', '-30 days') THEN 3.0
                            WHEN julianday(ph.started_at) >= julianday('now', '-90 days') THEN 2.0
                            ELSE 1.0 END) AS weight
                 FROM play_history ph
                 JOIN recording_artists ra ON ra.recording_id = ph.recording_id
                 JOIN artists a ON a.id = ra.artist_id
                 WHERE COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                   AND ra.role = 'primary'
                 GROUP BY a.id, a.name",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (artist, weight) = row.map_err(|error| error.to_string())?;
            artist_weights.insert(canonical_text(&artist), weight);
        }
    }

    let mut genre_weights = HashMap::<String, f64>::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT r.genre,
                        SUM(CASE
                            WHEN julianday(ph.started_at) >= julianday('now', '-30 days') THEN 3.0
                            WHEN julianday(ph.started_at) >= julianday('now', '-90 days') THEN 2.0
                            ELSE 1.0 END) AS weight
                 FROM play_history ph
                 JOIN recordings r ON r.id = ph.recording_id
                 WHERE COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                   AND r.genre IS NOT NULL AND TRIM(r.genre) <> ''
                 GROUP BY r.genre",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (genres, weight) = row.map_err(|error| error.to_string())?;
            for genre in genres.split([',', ';', '/']) {
                let key = canonical_text(genre);
                if !key.is_empty() {
                    *genre_weights.entry(key).or_default() += weight;
                }
            }
        }
    }

    let mut recent_tracks = HashSet::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT r.title, COALESCE(a.name, '')
                 FROM play_history ph
                 JOIN recordings r ON r.id = ph.recording_id
                 LEFT JOIN recording_artists ra ON ra.recording_id = r.id
                    AND ra.role = 'primary' AND ra.position = 0
                 LEFT JOIN artists a ON a.id = ra.artist_id
                 WHERE COALESCE(ph.listened_ms, ph.duration_ms, 0) >= 30000
                   AND julianday(ph.started_at) >= julianday('now', '-14 days')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (title, artist) = row.map_err(|error| error.to_string())?;
            recent_tracks.insert(track_match_key(&artist, &title));
        }
    }
    drop(conn);

    normalize_weights(&mut artist_weights);
    normalize_weights(&mut genre_weights);
    Ok(TasteProfile {
        ready: unique_tracks >= PROFILE_TRACK_GOAL,
        artists: artist_weights,
        genres: genre_weights,
        recent_tracks,
    })
}

fn normalize_weights(weights: &mut HashMap<String, f64>) {
    let max = weights.values().copied().fold(0.0_f64, f64::max);
    if max > 0.0 {
        for value in weights.values_mut() {
            *value = (*value / max).clamp(0.0, 1.0);
        }
    }
}

#[derive(Clone, Debug)]
struct Signal {
    source_family: String,
    source_label: String,
    market: Option<String>,
    within_cadence: bool,
    rank: Option<u32>,
    chart_size: Option<u32>,
    audience_count: Option<u64>,
    audience_label: Option<String>,
    previous_rank: Option<u32>,
    previous_audience: Option<u64>,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    item_kind: SourceItemKind,
    title: String,
    artist: String,
    album: Option<String>,
    artwork_url: Option<String>,
    search_query: String,
    release_date: Option<String>,
    tags: BTreeSet<String>,
    source_labels: BTreeSet<String>,
    signals: Vec<Signal>,
    editorial: bool,
    match_key: String,
    affinity: f64,
    recent: bool,
    rank_strength: f64,
    agreement: f64,
    momentum: f64,
    audience_growth: f64,
    audience_strength: f64,
    freshness: f64,
    external_quality: f64,
}

impl Candidate {
    fn from_item(item: &SourceItem, entity_id: String) -> Option<Self> {
        let artist = display_artist(item)?;
        let title = item.title.trim();
        if artist.is_empty() || title.is_empty() {
            return None;
        }
        let match_key = candidate_match_key(item);
        let search_query = if matches!(item.item_kind, SourceItemKind::Editorial) {
            editorial_search_query(title)?
        } else {
            format!("{artist} {title}")
        };
        Some(Self {
            id: entity_id,
            item_kind: item.item_kind.clone(),
            title: title.to_string(),
            artist,
            album: item.album.clone(),
            artwork_url: validated_artwork_url(item.artwork_url.as_deref()),
            search_query,
            release_date: item.release_date.clone(),
            tags: item
                .tags
                .iter()
                .map(|tag| canonical_text(tag))
                .filter(|tag| !tag.is_empty())
                .collect(),
            source_labels: BTreeSet::new(),
            signals: Vec::new(),
            editorial: matches!(item.item_kind, SourceItemKind::Editorial),
            match_key,
            affinity: 0.0,
            recent: false,
            rank_strength: 0.0,
            agreement: 0.0,
            momentum: 0.0,
            audience_growth: 0.0,
            audience_strength: 0.0,
            freshness: 0.0,
            external_quality: 0.0,
        })
    }

    fn merge_item(&mut self, item: &SourceItem, entity_id: &str) {
        if entity_id < self.id.as_str() {
            self.id = entity_id.to_string();
        }
        if self.artwork_url.is_none() {
            self.artwork_url = validated_artwork_url(item.artwork_url.as_deref());
        }
        if self.album.is_none() {
            self.album = item.album.clone();
        }
        if self.release_date.is_none() {
            self.release_date = item.release_date.clone();
        }
        self.tags.extend(
            item.tags
                .iter()
                .map(|tag| canonical_text(tag))
                .filter(|tag| !tag.is_empty()),
        );
        self.editorial |= matches!(item.item_kind, SourceItemKind::Editorial);
    }
}

#[derive(Clone, Copy)]
struct PreviousMetric {
    rank: Option<u32>,
    audience: Option<u64>,
}

fn build_feed(
    db: &DbPool,
    batches: &[SourceBatch],
    statuses: Vec<DiscoverySourceStatus>,
    taste: &TasteProfile,
    now: DateTime<Utc>,
) -> Result<(SearchDiscoveryFeed, String), String> {
    let previous = previous_metrics(db, batches);
    let mut candidates = BTreeMap::<String, Candidate>::new();
    for batch in batches {
        let chart_sizes = batch
            .items
            .iter()
            .filter_map(|item| Some((item, item.rank?)))
            .fold(HashMap::<String, u32>::new(), |mut sizes, (item, rank)| {
                sizes
                    .entry(scope_for_item(item))
                    .and_modify(|size| *size = (*size).max(rank))
                    .or_insert(rank);
                sizes
            });
        for item in &batch.items {
            let entity_id = entity_id_for_item(item);
            let match_key = candidate_match_key(item);
            let Some(new_candidate) = Candidate::from_item(item, entity_id.clone()) else {
                continue;
            };
            let candidate = candidates.entry(match_key).or_insert_with(|| new_candidate);
            candidate.merge_item(item, &entity_id);
            candidate.source_labels.insert(batch.label.clone());
            let scope = scope_for_item(item);
            let prior = previous.get(&(item.source_family.clone(), scope.clone(), entity_id));
            candidate.signals.push(Signal {
                source_family: item.source_family.clone(),
                source_label: batch.label.clone(),
                market: item.market.clone(),
                within_cadence: now.timestamp().saturating_sub(item.observed_at)
                    <= i64::try_from(batch.cadence_secs).unwrap_or(i64::MAX),
                rank: item.rank,
                chart_size: chart_sizes.get(&scope).copied(),
                audience_count: headline_audience(item),
                audience_label: audience_label(item),
                previous_rank: prior.and_then(|metric| metric.rank),
                previous_audience: prior.and_then(|metric| metric.audience),
            });
        }
    }

    let max_audience_log = candidates
        .values()
        .flat_map(|candidate| {
            candidate
                .signals
                .iter()
                .filter_map(|signal| signal.audience_count)
        })
        .map(|count| (count as f64).ln_1p())
        .fold(0.0_f64, f64::max);
    for candidate in candidates.values_mut() {
        score_candidate(candidate, taste, now.date_naive(), max_audience_log);
    }

    let mut used_entities = HashSet::new();
    let mut artist_appearances = HashMap::<String, usize>::new();
    let mut sections = Vec::new();

    let top_scores = rank_candidates(&candidates, |candidate| {
        if matches!(candidate.item_kind, SourceItemKind::Track)
            && (candidate.rank_strength > 0.0 || candidate.audience_strength > 0.0)
        {
            Some(
                0.55 * candidate.rank_strength
                    + 0.25 * candidate.agreement
                    + 0.20 * candidate.momentum,
            )
        } else {
            None
        }
    });
    push_section(
        &mut sections,
        "top-now",
        "top_now",
        false,
        "Top now",
        "Strong current chart positions, with independent sources counted once",
        top_scores,
        &candidates,
        &mut used_entities,
        &mut artist_appearances,
        now,
    );

    let moving_scores = rank_candidates(&candidates, |candidate| {
        let movement = 0.55 * candidate.momentum
            + 0.25 * candidate.audience_growth
            + 0.20 * candidate.rank_strength;
        (candidate.momentum > 0.0 || candidate.audience_growth > 0.0).then_some(movement)
    });
    push_section(
        &mut sections,
        "moving-fast",
        "moving_fast",
        false,
        "Moving fast",
        "Only real changes measured against an earlier saved observation",
        moving_scores,
        &candidates,
        &mut used_entities,
        &mut artist_appearances,
        now,
    );

    let new_scores = rank_candidates(&candidates, |candidate| {
        (candidate.freshness >= 0.5
            && candidate.signals.iter().any(|signal| signal.within_cadence)
            && !matches!(candidate.item_kind, SourceItemKind::Editorial)
            && (candidate.external_quality >= 0.10
                || candidate.audience_strength > 0.05
                || candidate.affinity > 0.10))
            .then_some(
                0.45 * candidate.freshness
                    + 0.25 * candidate.external_quality
                    + 0.20 * if candidate.editorial { 1.0 } else { 0.0 }
                    + 0.10 * candidate.affinity,
            )
    });
    push_section(
        &mut sections,
        "new-and-rising",
        "new_and_rising",
        taste.ready,
        "New and worth a look",
        "Fresh releases filtered by early traction, editorial support, and your rotation",
        new_scores,
        &candidates,
        &mut used_entities,
        &mut artist_appearances,
        now,
    );

    if taste.ready {
        let for_you_scores = rank_candidates(&candidates, |candidate| {
            (!matches!(candidate.item_kind, SourceItemKind::Editorial)
                && candidate.signals.iter().any(|signal| signal.within_cadence)
                && !candidate.recent
                && candidate.affinity > 0.0)
                .then_some(
                    0.45 * candidate.affinity
                        + 0.20 * candidate.external_quality
                        + 0.15 * candidate.affinity
                        + 0.10 * candidate.freshness
                        + 0.10,
                )
        });
        push_section(
            &mut sections,
            "for-you",
            "for_you",
            true,
            "For you",
            "Outside music connected to artists and genres you actually finish",
            for_you_scores,
            &candidates,
            &mut used_entities,
            &mut artist_appearances,
            now,
        );

        let outside_scores = rank_candidates(&candidates, |candidate| {
            (!matches!(candidate.item_kind, SourceItemKind::Editorial)
                && candidate.signals.iter().any(|signal| signal.within_cadence)
                && !candidate.recent
                && candidate.affinity < 0.45
                && candidate.external_quality > 0.05)
                .then_some(
                    0.40 * candidate.external_quality
                        + 0.30 * (1.0 - candidate.affinity)
                        + 0.20 * if candidate.editorial { 1.0 } else { 0.0 }
                        + 0.10 * candidate.freshness,
                )
        });
        push_section(
            &mut sections,
            "outside-your-bubble",
            "outside_your_bubble",
            true,
            "Outside your bubble",
            "Strong signals deliberately separated from your usual artists",
            outside_scores,
            &candidates,
            &mut used_entities,
            &mut artist_appearances,
            now,
        );
    }

    let editorial_scores = rank_candidates(&candidates, |candidate| {
        (candidate.editorial && candidate.signals.iter().any(|signal| signal.within_cadence))
            .then_some(
                0.50 * candidate.freshness
                    + 0.25 * candidate.external_quality
                    + 0.15 * candidate.freshness
                    + 0.10 * candidate.affinity,
            )
    });
    push_section(
        &mut sections,
        "editors-found",
        "editors_found",
        taste.ready,
        "Editors found this",
        "Current human picks from active publications, disabled automatically when stale",
        editorial_scores,
        &candidates,
        &mut used_entities,
        &mut artist_appearances,
        now,
    );

    if sections.is_empty() {
        return Err("source data produced no useful discovery shelves".to_string());
    }
    let has_history = sections.iter().any(|section| section.kind == "moving_fast");
    let fingerprint = input_fingerprint(batches, taste);
    let snapshot_id = format!("{}-{}", now.timestamp(), &fingerprint[..12]);
    let source_labels = statuses
        .iter()
        .filter(|status| status.state == "live" || status.state == "cached")
        .map(|status| status.label.clone())
        .collect::<Vec<_>>();
    let feed = SearchDiscoveryFeed {
        snapshot_id,
        generated_at: now.timestamp(),
        source: if source_labels.is_empty() {
            "Mewsik discovery".to_string()
        } else {
            source_labels.join(" · ")
        },
        is_stale: statuses
            .iter()
            .all(|status| status.state != "live" && status.state != "cached"),
        is_fallback: false,
        has_history,
        next_refresh_at: None,
        source_statuses: statuses,
        sections,
    };
    Ok((feed, fingerprint))
}

fn previous_metrics(
    db: &DbPool,
    batches: &[SourceBatch],
) -> HashMap<(String, String, String), PreviousMetric> {
    let mut pairs = BTreeSet::new();
    for batch in batches {
        for item in &batch.items {
            pairs.insert((item.source_family.clone(), scope_for_item(item)));
        }
    }
    let mut previous = HashMap::new();
    for (source, scope) in pairs {
        let Ok(frames) = store::load_source_observation_frames(db, &source, &scope) else {
            continue;
        };
        let Some(frame) = frames.previous else {
            continue;
        };
        for observation in frame.observations {
            previous.insert(
                (source.clone(), scope.clone(), observation.entity_id.clone()),
                metric_from_observation(&observation),
            );
        }
    }
    previous
}

fn metric_from_observation(observation: &StoredObservation) -> PreviousMetric {
    PreviousMetric {
        rank: observation
            .rank_position
            .and_then(|rank| u32::try_from(rank).ok()),
        audience: observation
            .listener_count
            .or(observation.view_count)
            .or(observation.play_count)
            .and_then(|count| u64::try_from(count).ok()),
    }
}

fn score_candidate(
    candidate: &mut Candidate,
    taste: &TasteProfile,
    today: NaiveDate,
    max_audience_log: f64,
) {
    candidate.rank_strength = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| {
            Some(normalized_rank(
                signal.rank? as i64,
                signal.chart_size? as i64,
            ))
        })
        .fold(0.0_f64, f64::max);
    let families = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .map(|signal| signal.source_family.as_str())
        .collect::<HashSet<_>>();
    candidate.agreement = (families.len() as f64 / 3.0).clamp(0.0, 1.0);
    candidate.momentum = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| {
            let current = signal.rank? as f64;
            let previous = signal.previous_rank? as f64;
            let scale = signal.chart_size.unwrap_or(100).max(10) as f64 * 0.20;
            Some(((previous - current) / scale).clamp(0.0, 1.0))
        })
        .fold(0.0_f64, f64::max);
    candidate.audience_growth = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| {
            let current = signal.audience_count? as f64;
            let previous = signal.previous_audience? as f64;
            (current > previous && previous > 0.0)
                .then_some(((current - previous) / previous / 2.0).clamp(0.0, 1.0))
        })
        .fold(0.0_f64, f64::max);
    candidate.audience_strength = if max_audience_log > 0.0 {
        candidate
            .signals
            .iter()
            .filter(|signal| signal.within_cadence)
            .filter_map(|signal| signal.audience_count)
            .map(|count| (count as f64).ln_1p() / max_audience_log)
            .fold(0.0_f64, f64::max)
    } else {
        0.0
    };
    candidate.freshness = candidate
        .release_date
        .as_deref()
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .map(|date| {
            let age = today.signed_duration_since(date).num_days().max(0) as f64;
            2_f64.powf(-age / 14.0)
        })
        .unwrap_or(0.0);
    let artist_key = artist_cap_key(&candidate.artist);
    let artist_affinity = taste.artists.get(&artist_key).copied().unwrap_or(0.0);
    let tag_affinity = candidate
        .tags
        .iter()
        .filter_map(|tag| taste.genres.get(tag).copied())
        .fold(0.0_f64, f64::max);
    candidate.affinity = artist_affinity.max(tag_affinity).clamp(0.0, 1.0);
    candidate.recent = taste
        .recent_tracks
        .contains(&track_match_key(&candidate.artist, &candidate.title));
    candidate.external_quality = (0.65 * candidate.rank_strength
        + 0.20 * candidate.agreement
        + 0.15 * candidate.audience_strength)
        .clamp(0.0, 1.0);
}

fn normalized_rank(rank: i64, chart_size: i64) -> f64 {
    if chart_size <= 1 {
        return 1.0;
    }
    (1.0 - (rank.saturating_sub(1) as f64 / (chart_size - 1) as f64)).clamp(0.0, 1.0)
}

fn rank_candidates(
    candidates: &BTreeMap<String, Candidate>,
    score: impl Fn(&Candidate) -> Option<f64>,
) -> Vec<(String, f64)> {
    let mut ranked = candidates
        .iter()
        .filter_map(|(key, candidate)| score(candidate).map(|score| (key.clone(), score)))
        .collect::<Vec<_>>();
    ranked.sort_by(|(left_key, left_score), (right_key, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left_key.cmp(right_key))
    });
    ranked
}

#[allow(clippy::too_many_arguments)]
fn push_section(
    sections: &mut Vec<SearchDiscoverySection>,
    id: &str,
    kind: &str,
    personalized: bool,
    title: &str,
    subtitle: &str,
    ranked: Vec<(String, f64)>,
    candidates: &BTreeMap<String, Candidate>,
    used_entities: &mut HashSet<String>,
    artist_appearances: &mut HashMap<String, usize>,
    now: DateTime<Utc>,
) {
    let mut items = Vec::new();
    let mut shelf_artists = HashSet::new();
    let known_artists = candidates
        .values()
        .filter(|candidate| !matches!(candidate.item_kind, SourceItemKind::Editorial))
        .map(|candidate| canonical_text(&candidate.artist))
        .collect::<HashSet<_>>();
    for (key, _) in ranked {
        if items.len() >= SECTION_SIZE {
            break;
        }
        let Some(candidate) = candidates.get(&key) else {
            continue;
        };
        let artist_key = if matches!(candidate.item_kind, SourceItemKind::Editorial) {
            candidate.match_key.clone()
        } else {
            artist_shelf_key(&candidate.artist, &known_artists)
        };
        if used_entities.contains(&candidate.id)
            || shelf_artists.contains(&artist_key)
            || artist_appearances.get(&artist_key).copied().unwrap_or(0) >= 2
        {
            continue;
        }
        used_entities.insert(candidate.id.clone());
        shelf_artists.insert(artist_key.clone());
        *artist_appearances.entry(artist_key).or_default() += 1;
        items.push(item_for_shelf(candidate, kind, now));
    }
    if !items.is_empty() {
        sections.push(SearchDiscoverySection {
            id: id.to_string(),
            kind: kind.to_string(),
            personalized,
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            items,
        });
    }
}

fn item_for_shelf(candidate: &Candidate, shelf: &str, now: DateTime<Utc>) -> SearchDiscoveryItem {
    let best_rank = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| signal.rank.map(|rank| (rank, signal)))
        .min_by_key(|(rank, _)| *rank);
    let best_audience = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| signal.audience_count.map(|count| (count, signal)))
        .max_by_key(|(count, _)| *count);
    let best_movement = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| {
            let rank = signal.rank?;
            let previous = signal.previous_rank?;
            let delta = i32::try_from(previous).ok()? - i32::try_from(rank).ok()?;
            (delta > 0).then_some((delta, signal))
        })
        .max_by_key(|(delta, _)| *delta);
    let best_audience_delta = candidate
        .signals
        .iter()
        .filter(|signal| signal.within_cadence)
        .filter_map(|signal| {
            let current = i64::try_from(signal.audience_count?).ok()?;
            let previous = i64::try_from(signal.previous_audience?).ok()?;
            (current > previous).then_some((current - previous, signal))
        })
        .max_by_key(|(delta, _)| *delta);

    let reason = match shelf {
        "moving_fast" => best_movement
            .map(|(delta, _)| format!("↑{delta} positions since the last check"))
            .or_else(|| {
                best_audience_delta.map(|(delta, signal)| {
                    format!(
                        "+{} {} since the last check",
                        compact_count(delta as u64),
                        signal.audience_label.as_deref().unwrap_or("audience")
                    )
                })
            }),
        "new_and_rising" => candidate.release_date.as_deref().and_then(|date| {
            NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .map(|date| {
                    let age = now
                        .date_naive()
                        .signed_duration_since(date)
                        .num_days()
                        .max(0);
                    if age == 0 {
                        "Released today".to_string()
                    } else if age == 1 {
                        "Released yesterday".to_string()
                    } else {
                        format!("Released {age} days ago")
                    }
                })
        }),
        "for_you" => {
            let artist_key = canonical_text(&candidate.artist);
            if candidate.affinity > 0.0 && !artist_key.is_empty() {
                Some(format!("Connected to your {} rotation", candidate.artist))
            } else {
                Some("Matched to your listening history".to_string())
            }
        }
        "outside_your_bubble" => Some("Strong signal outside your usual rotation".to_string()),
        "editors_found" => Some("Picked by Bandcamp Daily".to_string()),
        _ => best_rank.map(|(rank, signal)| {
            let source = short_source_label(&signal.source_family);
            match signal.market.as_deref() {
                Some(market) => format!("#{rank} {source} {market}"),
                None => format!("#{rank} {source}"),
            }
        }),
    }
    .or_else(|| {
        best_audience.map(|(count, signal)| {
            format!(
                "{} {} on {}",
                compact_count(count),
                signal.audience_label.as_deref().unwrap_or("audience"),
                short_source_label(&signal.source_family)
            )
        })
    })
    .or_else(|| Some("Independent discovery signal".to_string()));

    let source_context = best_rank
        .map(|(_, signal)| signal.source_label.clone())
        .or_else(|| candidate.source_labels.iter().next().cloned());
    SearchDiscoveryItem {
        id: candidate.id.clone(),
        item_kind: item_kind_name(&candidate.item_kind).to_string(),
        title: candidate.title.clone(),
        artist: candidate.artist.clone(),
        album: candidate.album.clone(),
        artwork_url: candidate.artwork_url.clone(),
        search_query: candidate.search_query.clone(),
        listen_count: best_audience.map(|(count, _)| count),
        rank: best_rank.map(|(rank, _)| rank),
        momentum: best_movement.map(|(delta, _)| delta),
        context: source_context,
        reason,
        source_labels: candidate.source_labels.iter().cloned().collect(),
        release_date: candidate.release_date.clone(),
        audience_delta: best_audience_delta.map(|(delta, _)| delta),
        audience_label: best_audience.and_then(|(_, signal)| signal.audience_label.clone()),
    }
}

fn short_source_label(family: &str) -> &str {
    match family {
        "apple" => "Apple",
        "lastfm" => "Last.fm",
        "youtube" => "YouTube",
        "listenbrainz" => "ListenBrainz",
        "bandcamp" => "Bandcamp Daily",
        _ => "source",
    }
}

fn audience_label(item: &SourceItem) -> Option<String> {
    if item.metrics.view_count.is_some() {
        Some("views".to_string())
    } else if item.metrics.listener_count.is_some() {
        Some("listeners".to_string())
    } else if item.metrics.play_count.is_some() {
        Some("plays".to_string())
    } else {
        item.audience_count.map(|_| "audience".to_string())
    }
}

fn headline_audience(item: &SourceItem) -> Option<u64> {
    item.metrics
        .listener_count
        .or(item.metrics.view_count)
        .or(item.metrics.play_count)
        .or(item.audience_count)
}

fn item_kind_name(kind: &SourceItemKind) -> &'static str {
    match kind {
        SourceItemKind::Track => "track",
        SourceItemKind::Release => "release",
        SourceItemKind::Editorial => "editorial",
    }
}

fn display_artist(item: &SourceItem) -> Option<String> {
    item.artist
        .as_deref()
        .map(str::trim)
        .filter(|artist| !artist.is_empty())
        .map(str::to_string)
        .or_else(|| {
            matches!(item.item_kind, SourceItemKind::Editorial)
                .then(|| "Bandcamp Daily".to_string())
        })
}

fn editorial_search_query(title: &str) -> Option<String> {
    let title = title.trim();
    let lower = title.to_ascii_lowercase();
    if title.is_empty()
        || lower.starts_with("essential releases")
        || lower.starts_with("the best ")
        || lower.starts_with("a guide to ")
    {
        return None;
    }

    for (open, close) in [('“', '”'), ('"', '"')] {
        let Some(start) = title.find(open) else {
            continue;
        };
        let content_start = start + open.len_utf8();
        let Some(relative_end) = title[content_start..].find(close) else {
            continue;
        };
        let work = title[content_start..content_start + relative_end].trim();
        let prefix = title[..start].trim().trim_end_matches(|character: char| {
            character == ',' || character == ':' || character.is_whitespace()
        });
        let artist = prefix.rsplit(':').next().unwrap_or(prefix).trim();
        if !artist.is_empty() && !work.is_empty() && artist.split_whitespace().count() <= 8 {
            return Some(format!("{artist} {work}"));
        }
    }

    for marker in [
        " Built ",
        " Invites ",
        " Pairs ",
        " Returns ",
        " Shares ",
        " Makes ",
        " Brings ",
    ] {
        if let Some(index) = title.find(marker) {
            let artist = title[..index].trim();
            if (1..=7).contains(&artist.split_whitespace().count()) {
                return Some(artist.to_string());
            }
        }
    }

    let candidate = title
        .rsplit_once(':')
        .map(|(_, value)| value.trim())
        .unwrap_or(title);
    (candidate.split_whitespace().count() <= 10).then(|| candidate.to_string())
}

fn candidate_match_key(item: &SourceItem) -> String {
    let artist = item.artist.as_deref().unwrap_or_default();
    format!(
        "{}:{}",
        item_kind_name(&item.item_kind),
        track_match_key(artist, &item.title)
    )
}

fn track_match_key(artist: &str, title: &str) -> String {
    format!("{}|{}", canonical_text(artist), canonical_title(title))
}

fn canonical_title(value: &str) -> String {
    let mut words = value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    while words.last().is_some_and(|word| {
        matches!(
            word.as_str(),
            "official" | "video" | "audio" | "lyrics" | "visualizer"
        )
    }) {
        words.pop();
    }
    words.join(" ")
}

fn canonical_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn artist_cap_key(value: &str) -> String {
    let bytes = value.as_bytes();
    let cut = [" feat. ", " feat ", " featuring "]
        .iter()
        .filter_map(|separator| {
            bytes
                .windows(separator.len())
                .position(|window| window.eq_ignore_ascii_case(separator.as_bytes()))
        })
        .min()
        .unwrap_or(value.len());
    canonical_text(&value[..cut])
}

fn artist_shelf_key(value: &str, known_artists: &HashSet<String>) -> String {
    let featured_key = artist_cap_key(value);
    let exact_key = canonical_text(value);
    if featured_key != exact_key {
        return featured_key;
    }

    let bytes = value.as_bytes();
    let Some(cut) = bytes
        .windows(3)
        .position(|window| window.eq_ignore_ascii_case(b" & "))
    else {
        return exact_key;
    };
    let lead = canonical_text(&value[..cut]);
    if known_artists.contains(&lead) {
        lead
    } else {
        exact_key
    }
}

fn validated_artwork_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let allowed = host == "coverartarchive.org"
        || host == "mzstatic.com"
        || host.ends_with(".mzstatic.com")
        || host == "i.ytimg.com"
        || host == "i1.ytimg.com"
        || host == "lastfm.freetls.fastly.net"
        || (host.starts_with('f') && host.ends_with(".bcbits.com"));
    allowed.then(|| url.to_string())
}

fn input_fingerprint(batches: &[SourceBatch], taste: &TasteProfile) -> String {
    let mut parts = Vec::new();
    for batch in batches {
        for item in &batch.items {
            parts.push(format!(
                "{}|{}|{}|{}|{:?}|{:?}",
                batch.source,
                batch.fetched_at,
                item.source_item_id,
                scope_for_item(item),
                item.rank,
                headline_audience(item)
            ));
        }
    }
    for (artist, weight) in &taste.artists {
        parts.push(format!("taste:artist:{artist}:{weight:.6}"));
    }
    for (genre, weight) in &taste.genres {
        parts.push(format!("taste:genre:{genre}:{weight:.6}"));
    }
    parts.sort();
    digest(&parts.join("\n"))
}

fn digest(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn compact_count(value: u64) -> String {
    if value >= 1_000_000_000 {
        format!("{:.1}B", value as f64 / 1_000_000_000.0)
    } else if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn bundled_fallback_feed(
    now: i64,
    source_statuses: Vec<DiscoverySourceStatus>,
) -> SearchDiscoveryFeed {
    const PICKS: &[(&str, &str, &str)] = &[
        ("Daft Punk", "One More Time", "Discovery"),
        ("Radiohead", "Weird Fishes / Arpeggi", "In Rainbows"),
        ("Kendrick Lamar", "Money Trees", "good kid, m.A.A.d city"),
        ("Björk", "Jóga", "Homogenic"),
        ("Aphex Twin", "Xtal", "Selected Ambient Works 85-92"),
        ("FKA twigs", "cellophane", "MAGDALENE"),
        ("Burial", "Archangel", "Untrue"),
        ("Fleetwood Mac", "Dreams", "Rumours"),
        ("Nujabes", "Feather", "Modal Soul"),
        (
            "SOPHIE",
            "Is It Cold in the Water?",
            "OIL OF EVERY PEARL'S UN-INSIDES",
        ),
        (
            "Talking Heads",
            "This Must Be the Place",
            "Speaking in Tongues",
        ),
        (
            "A Tribe Called Quest",
            "Electric Relaxation",
            "Midnight Marauders",
        ),
        ("Massive Attack", "Teardrop", "Mezzanine"),
        ("Caroline Polachek", "Bunny Is a Rider", "Desire"),
        ("MF DOOM", "Doomsday", "Operation: Doomsday"),
        ("Beach House", "Myth", "Bloom"),
        ("Jamie xx", "Loud Places", "In Colour"),
        ("Portishead", "Roads", "Dummy"),
        ("Charli xcx", "360", "BRAT"),
        ("The Avalanches", "Since I Left You", "Since I Left You"),
        ("Floating Points", "Silhouettes (I, II & III)", "Elaenia"),
        ("J Dilla", "Time: The Donut of the Heart", "Donuts"),
        (
            "Cocteau Twins",
            "Heaven or Las Vegas",
            "Heaven or Las Vegas",
        ),
        ("Solange", "Cranes in the Sky", "A Seat at the Table"),
    ];
    let items = PICKS
        .iter()
        .map(|(artist, title, album)| SearchDiscoveryItem {
            id: format!("fallback-{}", digest(&format!("{artist}:{title}"))),
            item_kind: "track".to_string(),
            title: (*title).to_string(),
            artist: (*artist).to_string(),
            album: Some((*album).to_string()),
            artwork_url: None,
            search_query: format!("{artist} {title}"),
            listen_count: None,
            rank: None,
            momentum: None,
            context: Some("Mewsik editorial fallback".to_string()),
            reason: Some("Reliable fallback while live signals recover".to_string()),
            source_labels: vec!["Mewsik".to_string()],
            release_date: None,
            audience_delta: None,
            audience_label: None,
        })
        .collect::<Vec<_>>();
    let section = |id: &str, title: &str, subtitle: &str, range: std::ops::Range<usize>| {
        SearchDiscoverySection {
            id: id.to_string(),
            kind: "fallback".to_string(),
            personalized: false,
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            items: items[range].to_vec(),
        }
    };
    SearchDiscoveryFeed {
        snapshot_id: format!("fallback-{now}"),
        generated_at: now,
        source: "Mewsik editorial fallback".to_string(),
        is_stale: false,
        is_fallback: true,
        has_history: false,
        next_refresh_at: Some(now + FAILURE_RETRY_SECS),
        source_statuses,
        sections: vec![
            section(
                "fallback-starts",
                "Reliable starts",
                "Useful search starts while live sources recover",
                0..8,
            ),
            section(
                "fallback-detours",
                "Worth the detour",
                "Different corners of music, deliberately broad",
                8..16,
            ),
            section(
                "fallback-rabbit-holes",
                "Reliable rabbit holes",
                "Static fallback—not mislabeled as trending",
                16..24,
            ),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn apple_item(
        id: &str,
        artist: &str,
        title: &str,
        market: &str,
        rank: u32,
        at: i64,
    ) -> SourceItem {
        SourceItem {
            source: APPLE_SOURCE.to_string(),
            source_family: "apple".to_string(),
            source_item_id: id.to_string(),
            item_kind: SourceItemKind::Track,
            title: title.to_string(),
            artist: Some(artist.to_string()),
            album: None,
            artwork_url: None,
            release_date: None,
            rank: Some(rank),
            audience_count: None,
            metrics: SourceMetrics::default(),
            tags: vec!["Electronic".to_string()],
            market: Some(market.to_string()),
            observed_at: at,
            editorial_url: None,
            external_ids: BTreeMap::from([("apple_music_track_id".to_string(), id.to_string())]),
        }
    }

    fn batch(items: Vec<SourceItem>, at: i64) -> SourceBatch {
        SourceBatch {
            source: APPLE_SOURCE.to_string(),
            label: "Apple Music charts".to_string(),
            fetched_at: at,
            cadence_secs: 14_400,
            items,
        }
    }

    #[test]
    fn canonical_matching_preserves_meaningful_versions() {
        assert_ne!(
            track_match_key("Artist", "Song"),
            track_match_key("Artist", "Song (Live)")
        );
        assert_ne!(
            track_match_key("Artist", "Song"),
            track_match_key("Artist", "Song - Remix")
        );
        assert_eq!(
            track_match_key("Artist", "Song (Official Video)"),
            track_match_key("Artist", "Song")
        );
    }

    #[test]
    fn artist_caps_group_collaborations_under_the_lead_artist() {
        assert_eq!(
            artist_cap_key("Beyoncé FEAT. Kendrick Lamar"),
            artist_cap_key("Beyoncé")
        );
        assert_ne!(artist_cap_key("Hall & Oates"), artist_cap_key("Hall"));

        let known = HashSet::from([canonical_text("Madonna"), canonical_text("Hall & Oates")]);
        assert_eq!(
            artist_shelf_key("Madonna & Feid", &known),
            artist_shelf_key("Madonna", &known)
        );
        assert_ne!(
            artist_shelf_key("Hall & Oates", &known),
            artist_shelf_key("Hall", &known)
        );
    }

    #[test]
    fn editorial_queries_reject_roundups_and_extract_specific_subjects() {
        assert_eq!(
            editorial_search_query("Essential Releases: July 2026"),
            None
        );
        assert_eq!(
            editorial_search_query("Arc Iris Built a New World"),
            Some("Arc Iris".to_string())
        );
        assert_eq!(
            editorial_search_query("Violet Cowboy, “Ramraid at the Wiggly Worm”"),
            Some("Violet Cowboy Ramraid at the Wiggly Worm".to_string())
        );
    }

    #[test]
    fn first_frame_does_not_invent_movement_and_second_frame_does() {
        let db = init_memory_db().expect("database");
        let first = batch(
            (0..24)
                .map(|index| {
                    apple_item(
                        &format!("id-{index}"),
                        &format!("Artist {index}"),
                        &format!("Song {index}"),
                        "US",
                        index + 1,
                        100,
                    )
                })
                .collect(),
            100,
        );
        ingest_batch(&db, &first).expect("first ingest");
        let taste = TasteProfile::default();
        let statuses = vec![DiscoverySourceStatus {
            id: APPLE_SOURCE.to_string(),
            label: "Apple Music charts".to_string(),
            state: "live".to_string(),
            updated_at: Some(100),
            detail: None,
        }];
        let (feed, _) = build_feed(
            &db,
            std::slice::from_ref(&first),
            statuses.clone(),
            &taste,
            DateTime::from_timestamp(100, 0).expect("time"),
        )
        .expect("first feed");
        assert!(!feed.has_history);
        assert!(!feed
            .sections
            .iter()
            .any(|section| section.kind == "moving_fast"));

        let second = batch(
            (0..24)
                .map(|index| {
                    let rank = if index >= 8 { index - 3 } else { index + 1 };
                    apple_item(
                        &format!("id-{index}"),
                        &format!("Artist {index}"),
                        &format!("Song {index}"),
                        "US",
                        rank,
                        200,
                    )
                })
                .collect(),
            200,
        );
        ingest_batch(&db, &second).expect("second ingest");
        let (feed, _) = build_feed(
            &db,
            &[second],
            statuses,
            &taste,
            DateTime::from_timestamp(200, 0).expect("time"),
        )
        .expect("second feed");
        assert!(feed.has_history);
        assert!(feed
            .sections
            .iter()
            .any(|section| section.kind == "moving_fast"));
    }

    #[test]
    fn apple_markets_count_as_one_source_family() {
        let mut candidate = Candidate::from_item(
            &apple_item("one", "Artist", "Song", "US", 1, 100),
            "entity".to_string(),
        )
        .expect("candidate");
        for market in ["US", "GB", "JP", "BR"] {
            candidate.signals.push(Signal {
                source_family: "apple".to_string(),
                source_label: "Apple".to_string(),
                market: Some(market.to_string()),
                within_cadence: true,
                rank: Some(1),
                chart_size: Some(100),
                audience_count: None,
                audience_label: None,
                previous_rank: None,
                previous_audience: None,
            });
        }
        score_candidate(
            &mut candidate,
            &TasteProfile::default(),
            NaiveDate::from_ymd_opt(2026, 7, 14).expect("date"),
            0.0,
        );
        assert!((candidate.agreement - (1.0 / 3.0)).abs() < 0.0001);
    }

    #[test]
    fn stale_observations_cannot_claim_current_rank_or_movement() {
        let mut candidate = Candidate::from_item(
            &apple_item("one", "Artist", "Song", "US", 1, 100),
            "entity".to_string(),
        )
        .expect("candidate");
        candidate.signals.push(Signal {
            source_family: "apple".to_string(),
            source_label: "Apple".to_string(),
            market: Some("US".to_string()),
            within_cadence: false,
            rank: Some(1),
            chart_size: Some(100),
            audience_count: Some(1_000_000),
            audience_label: Some("listeners".to_string()),
            previous_rank: Some(20),
            previous_audience: Some(100_000),
        });
        score_candidate(
            &mut candidate,
            &TasteProfile::default(),
            NaiveDate::from_ymd_opt(2026, 7, 14).expect("date"),
            20.0,
        );

        assert_eq!(candidate.rank_strength, 0.0);
        assert_eq!(candidate.momentum, 0.0);
        assert_eq!(candidate.audience_growth, 0.0);
        assert_eq!(candidate.audience_strength, 0.0);
    }

    #[test]
    fn input_fingerprint_ignores_batch_item_order() {
        let left = apple_item("left", "Left", "A", "US", 1, 100);
        let right = apple_item("right", "Right", "B", "US", 2, 100);
        let first = batch(vec![left.clone(), right.clone()], 100);
        let second = batch(vec![right, left], 100);
        assert_eq!(
            input_fingerprint(&[first], &TasteProfile::default()),
            input_fingerprint(&[second], &TasteProfile::default())
        );
    }

    #[test]
    fn source_cadence_reuses_fresh_frames_and_refreshes_when_due() {
        let db = init_memory_db().expect("database");
        ingest_batch(
            &db,
            &batch(vec![apple_item("one", "Artist", "Song", "US", 1, 100)], 100),
        )
        .expect("ingest");
        let config = SourceConfig {
            apple_markets: vec!["US".to_string()],
            ..SourceConfig::default()
        };
        let spec = source_specs(&config)
            .into_iter()
            .find(|spec| spec.id == APPLE_SOURCE)
            .expect("Apple source spec");

        assert!(!source_is_due(&db, &spec, 100));
        assert!(!source_is_due(&db, &spec, 100 + spec.cadence_secs - 1));
        assert!(source_is_due(&db, &spec, 100 + spec.cadence_secs));
    }

    #[test]
    fn live_scope_can_be_supplemented_by_a_missing_cached_market() {
        let db = init_memory_db().expect("database");
        ingest_batch(
            &db,
            &batch(
                vec![apple_item("us", "US Artist", "US Song", "US", 1, 100)],
                100,
            ),
        )
        .expect("US ingest");
        ingest_batch(
            &db,
            &batch(
                vec![apple_item("gb", "GB Artist", "GB Song", "GB", 1, 90)],
                90,
            ),
        )
        .expect("GB ingest");
        let config = SourceConfig {
            apple_markets: vec!["US".to_string(), "GB".to_string()],
            ..SourceConfig::default()
        };
        let spec = source_specs(&config)
            .into_iter()
            .find(|spec| spec.id == APPLE_SOURCE)
            .expect("Apple source spec");
        let cached = load_cached_batch(&db, &spec, 100, &HashSet::from(["US".to_string()]))
            .expect("cached GB supplement");

        assert_eq!(cached.items.len(), 1);
        assert_eq!(cached.items[0].market.as_deref(), Some("GB"));
        assert!(cached.label.contains("cached GB"));
    }

    #[test]
    fn failed_refresh_persists_a_short_retry_backoff() {
        let db = init_memory_db().expect("database");
        let runtime = DiscoveryFeedRuntime::new(db.clone(), SourceConfig::default());
        let mut feed = bundled_fallback_feed(100, Vec::new());
        feed.next_refresh_at = Some(160);
        runtime.persist_failure_backoff(&feed, 100);

        let snapshot = store::load_feed_snapshot::<SearchDiscoveryFeed>(&db, SNAPSHOT_KEY)
            .expect("snapshot query")
            .expect("backoff snapshot");
        assert_eq!(snapshot.expires_at, Some(160));
        assert_eq!(runtime.valid_snapshot(159), Some(feed));
        assert!(runtime.valid_snapshot(160).is_none());
    }

    #[test]
    fn filtered_chart_gaps_keep_provider_rank_inside_chart_size() {
        let db = init_memory_db().expect("database");
        let source = batch(
            vec![
                apple_item("first", "First", "A", "US", 1, 100),
                apple_item("fifth", "Fifth", "B", "US", 5, 100),
            ],
            100,
        );
        ingest_batch(&db, &source).expect("gapped provider ranks remain valid");

        let frames =
            store::load_source_observation_frames(&db, "apple", "US").expect("observation query");
        let current = frames.current.expect("current frame");
        assert_eq!(current.observations.len(), 2);
        assert!(current.observations.iter().all(|observation| {
            observation.chart_size == Some(5)
                && observation.rank_position.is_some_and(|rank| rank <= 5)
        }));
    }

    #[test]
    fn hosted_sources_are_enabled_without_desktop_provider_keys() {
        let config = SourceConfig {
            hosted_snapshot_url: Some(sources::HOSTED_DISCOVERY_SNAPSHOT_URL.to_string()),
            youtube_market: "GB".to_string(),
            ..SourceConfig::default()
        };
        let hosted_specs = source_specs(&config)
            .into_iter()
            .filter(|spec| spec.uses_hosted_snapshot)
            .collect::<Vec<_>>();
        let hosted = hosted_specs
            .iter()
            .map(|spec| spec.id)
            .collect::<HashSet<_>>();
        assert_eq!(hosted, HashSet::from([LASTFM_SOURCE, YOUTUBE_SOURCE]));
        let youtube = hosted_specs
            .iter()
            .find(|spec| spec.id == YOUTUBE_SOURCE)
            .expect("hosted YouTube spec");
        assert_eq!(youtube.scopes, vec!["US"]);
    }

    #[test]
    fn retained_hosted_batch_is_not_mislabeled_live() {
        let now = 1_800_000_000;
        let config = SourceConfig {
            hosted_snapshot_url: Some(sources::HOSTED_DISCOVERY_SNAPSHOT_URL.to_string()),
            ..SourceConfig::default()
        };
        let mut item = apple_item("video-1", "Channel", "Song", "US", 1, now);
        item.source = YOUTUBE_SOURCE.to_string();
        item.source_family = "youtube".to_string();
        item.external_ids =
            BTreeMap::from([("youtube_video_id".to_string(), "video-1".to_string())]);
        let batch = SourceBatch {
            source: YOUTUBE_SOURCE.to_string(),
            label: "YouTube popular music videos (US)".to_string(),
            fetched_at: now - 300,
            cadence_secs: 3_600,
            items: vec![item],
        };
        let mut report = SourceFetchReport::default();
        report.delivery_statuses.insert(
            YOUTUBE_SOURCE.to_string(),
            sources::SourceDeliveryStatus {
                state: sources::SourceDeliveryState::Cached,
                last_attempt_at: Some(now),
                detail: Some("Recent shared snapshot".to_string()),
            },
        );
        let statuses = build_source_statuses(&config, &[batch], &[], &report, now);
        let youtube = statuses
            .iter()
            .find(|status| status.id == YOUTUBE_SOURCE)
            .expect("YouTube status");
        assert_eq!(youtube.state, "cached");
        assert_eq!(youtube.detail.as_deref(), Some("Recent shared snapshot"));
    }

    #[test]
    fn unchanged_hosted_snapshot_uses_publisher_backoff() {
        let db = init_memory_db().expect("database");
        let now = 1_800_000_000;
        let config = SourceConfig {
            hosted_snapshot_url: Some(sources::HOSTED_DISCOVERY_SNAPSHOT_URL.to_string()),
            ..SourceConfig::default()
        };
        let hosted_specs = source_specs(&config)
            .into_iter()
            .filter(|spec| spec.uses_hosted_snapshot)
            .collect::<Vec<_>>();
        let report = SourceFetchReport {
            hosted_next_refresh_at: Some(now + 1_800),
            ..SourceFetchReport::default()
        };
        assert_eq!(
            next_source_refresh(&db, &hosted_specs, &report, now),
            now + 1_800
        );
    }

    #[test]
    fn hosted_not_before_gate_survives_other_sources_refreshing_sooner() {
        let db = init_memory_db().expect("database");
        let now = 1_800_000_000;
        let config = SourceConfig {
            hosted_snapshot_url: Some(sources::HOSTED_DISCOVERY_SNAPSHOT_URL.to_string()),
            ..SourceConfig::default()
        };
        let youtube = source_specs(&config)
            .into_iter()
            .find(|spec| spec.id == YOUTUBE_SOURCE)
            .expect("hosted YouTube spec");

        assert!(source_is_due(&db, &youtube, now));
        assert!(!source_should_refresh(&db, &youtube, now, false, now + 900));
        assert!(source_should_refresh(
            &db,
            &youtube,
            now + 900,
            false,
            now + 900
        ));
        assert!(source_should_refresh(&db, &youtube, now, true, now + 900));
    }

    #[tokio::test]
    #[ignore = "requires live discovery services"]
    async fn live_refresh_builds_real_shelves_and_persists_snapshot() {
        let db = init_memory_db().expect("database");
        let runtime = DiscoveryFeedRuntime::new(db.clone(), SourceConfig::default());
        let feed = runtime.get_feed(true).await;
        assert!(!feed.sections.is_empty());
        assert!(
            !feed.is_fallback,
            "live adapters fell back: {}",
            feed.source
        );
        assert!(feed
            .source_statuses
            .iter()
            .any(|status| status.state == "live"));
        assert!(
            store::load_feed_snapshot::<SearchDiscoveryFeed>(&db, SNAPSHOT_KEY)
                .expect("snapshot query")
                .is_some()
        );
    }
}
