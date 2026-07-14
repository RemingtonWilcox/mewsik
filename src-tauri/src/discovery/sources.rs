//! Typed, documented-source adapters for Discovery v2.
//!
//! This module intentionally returns raw provider observations. Canonical matching,
//! history, momentum, scoring, and shelf construction belong to the persistence and
//! feed layers. No adapter scrapes a web page or relies on an undocumented endpoint.

use chrono::{DateTime, NaiveDate, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{redirect::Policy, Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::error::Error as StdError;
use std::time::Duration;

pub const APPLE_SOURCE: &str = "apple_music_charts";
pub const LISTENBRAINZ_SOURCE: &str = "listenbrainz_fresh_releases";
pub const BANDCAMP_SOURCE: &str = "bandcamp_daily";
pub const LASTFM_SOURCE: &str = "lastfm_top_tracks";
pub const YOUTUBE_SOURCE: &str = "youtube_most_popular_music";

const APPLE_FAMILY: &str = "apple";
const LISTENBRAINZ_FAMILY: &str = "listenbrainz";
const BANDCAMP_FAMILY: &str = "bandcamp";
const LASTFM_FAMILY: &str = "lastfm";
const YOUTUBE_FAMILY: &str = "youtube";

const APPLE_CADENCE_SECS: u64 = 4 * 60 * 60;
const LISTENBRAINZ_CADENCE_SECS: u64 = 24 * 60 * 60;
const BANDCAMP_CADENCE_SECS: u64 = 6 * 60 * 60;
const LASTFM_CADENCE_SECS: u64 = 4 * 60 * 60;
const YOUTUBE_CADENCE_SECS: u64 = 60 * 60;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_RSS_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceItemKind {
    Track,
    Release,
    Editorial,
}

/// One provider item at one observation time.
///
/// `source_item_id` only promises stability within `source`. `external_ids` is
/// where canonicalization code can find MusicBrainz/provider identifiers without
/// pretending that normalized titles are globally unique.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceItem {
    pub source: String,
    pub source_family: String,
    pub source_item_id: String,
    pub item_kind: SourceItemKind,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub release_date: Option<String>,
    pub rank: Option<u32>,
    /// A convenient provider-specific headline count for compact UI. Persist
    /// `metrics` for calculations so listeners, plays, and views never get conflated.
    pub audience_count: Option<u64>,
    #[serde(default)]
    pub metrics: SourceMetrics,
    pub tags: Vec<String>,
    pub market: Option<String>,
    pub observed_at: i64,
    pub editorial_url: Option<String>,
    #[serde(default)]
    pub external_ids: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceMetrics {
    pub listener_count: Option<u64>,
    pub play_count: Option<u64>,
    pub view_count: Option<u64>,
    pub like_count: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceBatch {
    pub source: String,
    pub label: String,
    pub fetched_at: i64,
    pub cadence_secs: u64,
    pub items: Vec<SourceItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    ChartRank,
    AudienceCount,
    ListenerCount,
    PlayCount,
    ViewCount,
    LikeCount,
    FreshRelease,
    EditorialMention,
}

/// A persistence-friendly numeric observation derived from a `SourceItem`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceObservation {
    pub source: String,
    pub source_family: String,
    pub source_item_id: String,
    pub market: Option<String>,
    pub observed_at: i64,
    pub kind: ObservationKind,
    pub value: u64,
}

pub fn observations_for_batch(batch: &SourceBatch) -> Vec<SourceObservation> {
    let mut observations = Vec::new();
    for item in &batch.items {
        if let Some(rank) = item.rank {
            observations.push(observation(
                item,
                ObservationKind::ChartRank,
                u64::from(rank),
            ));
        }
        if let Some(count) = item.metrics.listener_count {
            observations.push(observation(item, ObservationKind::ListenerCount, count));
        }
        if let Some(count) = item.metrics.play_count {
            observations.push(observation(item, ObservationKind::PlayCount, count));
        }
        if let Some(count) = item.metrics.view_count {
            observations.push(observation(item, ObservationKind::ViewCount, count));
        }
        if let Some(count) = item.metrics.like_count {
            observations.push(observation(item, ObservationKind::LikeCount, count));
        }
        if item.metrics == SourceMetrics::default() {
            if let Some(count) = item.audience_count {
                observations.push(observation(item, ObservationKind::AudienceCount, count));
            }
        }
        match item.item_kind {
            SourceItemKind::Release if item.release_date.is_some() => {
                observations.push(observation(item, ObservationKind::FreshRelease, 1));
            }
            SourceItemKind::Editorial => {
                observations.push(observation(item, ObservationKind::EditorialMention, 1));
            }
            _ => {}
        }
    }
    observations
}

fn observation(item: &SourceItem, kind: ObservationKind, value: u64) -> SourceObservation {
    SourceObservation {
        source: item.source.clone(),
        source_family: item.source_family.clone(),
        source_item_id: item.source_item_id.clone(),
        market: item.market.clone(),
        observed_at: item.observed_at,
        kind,
        value,
    }
}

/// Runtime settings. API secrets are deliberately not serializable or debug-printed.
#[derive(Clone)]
pub struct SourceConfig {
    pub apple_markets: Vec<String>,
    pub apple_limit: u16,
    pub listenbrainz_days: u8,
    pub listenbrainz_limit: usize,
    pub bandcamp_limit: usize,
    pub bandcamp_max_age_days: u64,
    pub lastfm_api_key: Option<String>,
    pub lastfm_limit: u16,
    pub youtube_api_key: Option<String>,
    pub youtube_market: String,
    pub youtube_limit: u16,
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self {
            apple_markets: vec!["US", "GB", "JP", "BR"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            apple_limit: 100,
            listenbrainz_days: 7,
            listenbrainz_limit: 250,
            bandcamp_limit: 50,
            bandcamp_max_age_days: 7,
            lastfm_api_key: None,
            lastfm_limit: 100,
            youtube_api_key: None,
            youtube_market: "US".to_string(),
            youtube_limit: 50,
        }
    }
}

impl SourceConfig {
    /// Reads optional API keys only. Non-secret defaults remain deterministic.
    pub fn from_env() -> Self {
        Self {
            lastfm_api_key: first_nonempty_env(&["MEWSIK_LASTFM_API_KEY", "LASTFM_API_KEY"]),
            youtube_api_key: first_nonempty_env(&["MEWSIK_YOUTUBE_API_KEY", "YOUTUBE_API_KEY"]),
            ..Self::default()
        }
    }
}

fn first_nonempty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceFailure {
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceFetchReport {
    pub batches: Vec<SourceBatch>,
    pub failures: Vec<SourceFailure>,
    /// Optional sources omitted because no key was configured. This is not an error.
    pub skipped: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("invalid source configuration: {0}")]
    InvalidConfig(String),
    #[error("request failed: {0}")]
    Request(String),
    #[error("source returned HTTP {0}")]
    HttpStatus(u16),
    #[error("source response exceeded the {0} byte limit")]
    ResponseTooLarge(usize),
    #[error("invalid source response: {0}")]
    Parse(String),
    #[error("source returned no usable items")]
    Empty,
    #[error("editorial feed is stale; newest item is {age_days} days old (limit {limit_days})")]
    StaleEditorial { age_days: i64, limit_days: u64 },
}

pub fn build_source_client() -> Result<Client, SourceError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::limited(3))
        .user_agent("Mewsik/0.1 (documented music discovery sources)")
        .build()
        .map_err(request_error)
}

pub async fn fetch_all(
    client: &Client,
    config: &SourceConfig,
    now: DateTime<Utc>,
    requested_sources: &HashSet<String>,
) -> SourceFetchReport {
    let lastfm_key = configured_key(config.lastfm_api_key.as_deref());
    let youtube_key = configured_key(config.youtube_api_key.as_deref());
    let wants = |source: &str| requested_sources.contains(source);

    let apple_future = async {
        if wants(APPLE_SOURCE) {
            Some(fetch_apple_charts(client, &config.apple_markets, config.apple_limit, now).await)
        } else {
            None
        }
    };
    let listenbrainz_future = async {
        if wants(LISTENBRAINZ_SOURCE) {
            Some(
                fetch_listenbrainz_fresh_releases(
                    client,
                    now.date_naive(),
                    config.listenbrainz_days,
                    config.listenbrainz_limit,
                    now,
                )
                .await,
            )
        } else {
            None
        }
    };
    let bandcamp_future = async {
        if wants(BANDCAMP_SOURCE) {
            Some(
                fetch_bandcamp_daily(
                    client,
                    config.bandcamp_limit,
                    Duration::from_secs(config.bandcamp_max_age_days.saturating_mul(86_400)),
                    now,
                )
                .await,
            )
        } else {
            None
        }
    };
    let lastfm_future = async {
        match (wants(LASTFM_SOURCE), lastfm_key) {
            (false, _) => None,
            (true, Some(key)) => {
                Some(fetch_lastfm_top_tracks(client, key, config.lastfm_limit, now).await)
            }
            (true, None) => None,
        }
    };
    let youtube_future = async {
        match (wants(YOUTUBE_SOURCE), youtube_key) {
            (false, _) => None,
            (true, Some(key)) => Some(
                fetch_youtube_most_popular_music(
                    client,
                    key,
                    &config.youtube_market,
                    config.youtube_limit,
                    now,
                )
                .await,
            ),
            (true, None) => None,
        }
    };

    let (apple, listenbrainz, bandcamp, lastfm, youtube) = tokio::join!(
        apple_future,
        listenbrainz_future,
        bandcamp_future,
        lastfm_future,
        youtube_future
    );

    let mut report = SourceFetchReport::default();
    if let Some(result) = apple {
        record_result(&mut report, APPLE_SOURCE, result);
    }
    if let Some(result) = listenbrainz {
        record_result(&mut report, LISTENBRAINZ_SOURCE, result);
    }
    if let Some(result) = bandcamp {
        record_result(&mut report, BANDCAMP_SOURCE, result);
    }
    match lastfm {
        Some(result) => record_result(&mut report, LASTFM_SOURCE, result),
        None if wants(LASTFM_SOURCE) => report.skipped.push(LASTFM_SOURCE.to_string()),
        None => {}
    }
    match youtube {
        Some(result) => record_result(&mut report, YOUTUBE_SOURCE, result),
        None if wants(YOUTUBE_SOURCE) => report.skipped.push(YOUTUBE_SOURCE.to_string()),
        None => {}
    }
    report
}

fn configured_key(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn record_result(
    report: &mut SourceFetchReport,
    source: &'static str,
    result: Result<SourceBatch, SourceError>,
) {
    match result {
        Ok(batch) => report.batches.push(batch),
        Err(error) => report.failures.push(SourceFailure {
            source: source.to_string(),
            message: error.to_string(),
        }),
    }
}

pub async fn fetch_apple_charts(
    client: &Client,
    markets: &[String],
    limit: u16,
    now: DateTime<Utc>,
) -> Result<SourceBatch, SourceError> {
    if markets.is_empty() {
        return Err(SourceError::InvalidConfig(
            "at least one Apple market is required".to_string(),
        ));
    }
    if !(1..=200).contains(&limit) {
        return Err(SourceError::InvalidConfig(
            "Apple chart limit must be between 1 and 200".to_string(),
        ));
    }

    // Markets are independent public feeds. Fetch them concurrently so one
    // slow territory cannot turn the first discovery load into four serial
    // request timeouts. Preserve configured market order after the joins so
    // downstream ranking and snapshots remain deterministic.
    let mut requests = tokio::task::JoinSet::new();
    for (index, market) in markets.iter().cloned().enumerate() {
        let client = client.clone();
        let request_now = now;
        requests.spawn(async move {
            let result = fetch_apple_market(&client, &market, limit, request_now).await;
            (index, market, result)
        });
    }

    let mut market_results = Vec::with_capacity(markets.len());
    let mut failures = Vec::new();
    while let Some(result) = requests.join_next().await {
        match result {
            Ok(result) => market_results.push(result),
            Err(error) => failures.push(format!("Apple market worker failed: {error}")),
        }
    }
    market_results.sort_by_key(|(index, _, _)| *index);

    let mut items = Vec::new();
    for (_, market, result) in market_results {
        match result {
            Ok(mut market_items) => items.append(&mut market_items),
            Err(error) => failures.push(format!("{}: {error}", market.to_uppercase())),
        }
    }

    if items.is_empty() {
        return if failures.is_empty() {
            Err(SourceError::Empty)
        } else {
            Err(SourceError::Request(failures.join("; ")))
        };
    }
    if !failures.is_empty() {
        log::warn!(
            "Apple discovery chart partially refreshed: {}",
            failures.join("; ")
        );
    }

    let labels = items
        .iter()
        .filter_map(|item| item.market.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(", ");
    let partial = if failures.is_empty() {
        ""
    } else {
        " · partial"
    };
    Ok(SourceBatch {
        source: APPLE_SOURCE.to_string(),
        label: format!("Apple Music charts ({labels}){partial}"),
        fetched_at: now.timestamp(),
        cadence_secs: APPLE_CADENCE_SECS,
        items,
    })
}

async fn fetch_apple_market(
    client: &Client,
    market: &str,
    limit: u16,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, SourceError> {
    let market = validate_market(market)?;
    let url = format!(
        "https://rss.marketingtools.apple.com/api/v2/{market}/music/most-played/{limit}/songs.json"
    );
    let body = get_limited(
        client.get(url).header("Accept", "application/json"),
        MAX_JSON_BYTES,
    )
    .await?;
    parse_apple_chart(&body, &market, now)
}

#[derive(Deserialize)]
struct AppleResponse {
    feed: AppleFeed,
}

#[derive(Deserialize)]
struct AppleFeed {
    #[serde(default)]
    results: Vec<AppleSong>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleSong {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    artist_id: String,
    artwork_url100: Option<String>,
    release_date: Option<String>,
    #[serde(default)]
    genres: Vec<AppleGenre>,
}

#[derive(Deserialize)]
struct AppleGenre {
    #[serde(default)]
    name: String,
}

fn parse_apple_chart(
    body: &[u8],
    market: &str,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, SourceError> {
    let response: AppleResponse = serde_json::from_slice(body)
        .map_err(|error| SourceError::Parse(format!("Apple JSON: {error}")))?;
    let market = market.to_uppercase();
    let items = response
        .feed
        .results
        .into_iter()
        .enumerate()
        .filter_map(|(index, song)| {
            let id = nonempty(song.id)?;
            let title = nonempty(song.name)?;
            let artist = nonempty(song.artist_name)?;
            let mut external_ids = BTreeMap::new();
            external_ids.insert("apple_music_track_id".to_string(), id.clone());
            if let Some(artist_id) = nonempty(song.artist_id) {
                external_ids.insert("apple_music_artist_id".to_string(), artist_id);
            }
            let tags = song
                .genres
                .into_iter()
                .filter_map(|genre| nonempty(genre.name))
                .filter(|genre| !genre.eq_ignore_ascii_case("music"))
                .collect();
            Some(SourceItem {
                source: APPLE_SOURCE.to_string(),
                source_family: APPLE_FAMILY.to_string(),
                source_item_id: id,
                item_kind: SourceItemKind::Track,
                title,
                artist: Some(artist),
                album: None,
                artwork_url: song.artwork_url100.and_then(nonempty),
                release_date: song.release_date.and_then(valid_iso_date),
                rank: u32::try_from(index + 1).ok(),
                audience_count: None,
                metrics: SourceMetrics::default(),
                tags,
                market: Some(market.clone()),
                observed_at: now.timestamp(),
                editorial_url: None,
                external_ids,
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        Err(SourceError::Empty)
    } else {
        Ok(items)
    }
}

pub async fn fetch_listenbrainz_fresh_releases(
    client: &Client,
    release_date: NaiveDate,
    days: u8,
    limit: usize,
    now: DateTime<Utc>,
) -> Result<SourceBatch, SourceError> {
    if !(1..=90).contains(&days) {
        return Err(SourceError::InvalidConfig(
            "ListenBrainz days must be between 1 and 90".to_string(),
        ));
    }
    if limit == 0 {
        return Err(SourceError::InvalidConfig(
            "ListenBrainz item limit must be greater than zero".to_string(),
        ));
    }
    let request = client
        .get("https://api.listenbrainz.org/1/explore/fresh-releases/")
        .header("Accept", "application/json")
        .query(&[
            ("release_date", release_date.format("%Y-%m-%d").to_string()),
            ("days", days.to_string()),
            ("sort", "release_date".to_string()),
            ("past", "true".to_string()),
            ("future", "false".to_string()),
        ]);
    let body = get_limited(request, MAX_JSON_BYTES).await?;
    let items = parse_listenbrainz_releases(&body, limit, now)?;
    Ok(SourceBatch {
        source: LISTENBRAINZ_SOURCE.to_string(),
        label: format!("ListenBrainz fresh releases ({days} days)"),
        fetched_at: now.timestamp(),
        cadence_secs: LISTENBRAINZ_CADENCE_SECS,
        items,
    })
}

#[derive(Deserialize)]
struct ListenBrainzResponse {
    payload: ListenBrainzPayload,
}

#[derive(Deserialize)]
struct ListenBrainzPayload {
    #[serde(default)]
    releases: Vec<ListenBrainzRelease>,
}

#[derive(Deserialize)]
struct ListenBrainzRelease {
    #[serde(default)]
    artist_credit_name: String,
    #[serde(default)]
    artist_mbids: Vec<String>,
    #[serde(default)]
    release_name: String,
    #[serde(default)]
    release_mbid: String,
    #[serde(default)]
    release_group_mbid: String,
    release_date: Option<String>,
    release_group_primary_type: Option<String>,
    release_group_secondary_type: Option<String>,
    #[serde(default)]
    release_tags: Vec<String>,
    listen_count: Option<u64>,
    caa_release_mbid: Option<String>,
}

fn parse_listenbrainz_releases(
    body: &[u8],
    limit: usize,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, SourceError> {
    let response: ListenBrainzResponse = serde_json::from_slice(body)
        .map_err(|error| SourceError::Parse(format!("ListenBrainz JSON: {error}")))?;
    let mut items = response
        .payload
        .releases
        .into_iter()
        .filter_map(|release| {
            let title = nonempty(release.release_name)?;
            let artist = nonempty(release.artist_credit_name)?;
            let release_id = nonempty(release.release_mbid);
            let release_group_id = nonempty(release.release_group_mbid);
            let source_item_id = release_group_id.clone().or_else(|| release_id.clone())?;
            let mut external_ids = BTreeMap::new();
            if let Some(value) = release_id {
                external_ids.insert("musicbrainz_release_id".to_string(), value);
            }
            if let Some(value) = release_group_id {
                external_ids.insert("musicbrainz_release_group_id".to_string(), value);
            }
            let artist_ids = release
                .artist_mbids
                .into_iter()
                .filter_map(nonempty)
                .collect::<Vec<_>>();
            if !artist_ids.is_empty() {
                external_ids.insert("musicbrainz_artist_ids".to_string(), artist_ids.join(","));
            }
            let mut tags = Vec::new();
            if let Some(value) = release.release_group_primary_type.and_then(nonempty) {
                tags.push(value);
            }
            if let Some(value) = release.release_group_secondary_type.and_then(nonempty) {
                tags.push(value);
            }
            tags.extend(release.release_tags.into_iter().filter_map(nonempty));
            tags.sort_by_key(|tag| tag.to_lowercase());
            tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            let artwork_url = release
                .caa_release_mbid
                .and_then(nonempty)
                .filter(|mbid| looks_like_mbid(mbid))
                .map(|mbid| format!("https://coverartarchive.org/release/{mbid}/front-500"));
            let play_count = release.listen_count;
            Some(SourceItem {
                source: LISTENBRAINZ_SOURCE.to_string(),
                source_family: LISTENBRAINZ_FAMILY.to_string(),
                source_item_id,
                item_kind: SourceItemKind::Release,
                title,
                artist: Some(artist),
                album: None,
                artwork_url,
                release_date: release.release_date.and_then(valid_iso_date),
                rank: None,
                audience_count: None,
                metrics: SourceMetrics {
                    play_count,
                    ..SourceMetrics::default()
                },
                tags,
                market: None,
                observed_at: now.timestamp(),
                editorial_url: None,
                external_ids,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .release_date
            .cmp(&left.release_date)
            .then_with(|| left.artist.cmp(&right.artist))
            .then_with(|| left.title.cmp(&right.title))
    });
    items.truncate(limit);
    if items.is_empty() {
        Err(SourceError::Empty)
    } else {
        Ok(items)
    }
}

pub async fn fetch_bandcamp_daily(
    client: &Client,
    limit: usize,
    max_age: Duration,
    now: DateTime<Utc>,
) -> Result<SourceBatch, SourceError> {
    if limit == 0 {
        return Err(SourceError::InvalidConfig(
            "Bandcamp item limit must be greater than zero".to_string(),
        ));
    }
    if max_age.is_zero() {
        return Err(SourceError::InvalidConfig(
            "Bandcamp freshness limit must be greater than zero".to_string(),
        ));
    }
    let body = get_limited(
        client
            .get("https://daily.bandcamp.com/feed")
            .header("Accept", "application/rss+xml, application/xml;q=0.9"),
        MAX_RSS_BYTES,
    )
    .await?;
    let items = parse_bandcamp_feed(&body, limit, max_age, now)?;
    Ok(SourceBatch {
        source: BANDCAMP_SOURCE.to_string(),
        label: "Bandcamp Daily".to_string(),
        fetched_at: now.timestamp(),
        cadence_secs: BANDCAMP_CADENCE_SECS,
        items,
    })
}

#[derive(Default)]
struct BandcampEntry {
    title: String,
    link: String,
    description: String,
    categories: Vec<String>,
    published: String,
    guid: String,
}

#[derive(Clone, Copy)]
enum BandcampField {
    Title,
    Link,
    Description,
    Category,
    PubDate,
    DcDate,
    Guid,
}

fn parse_bandcamp_feed(
    body: &[u8],
    limit: usize,
    max_age: Duration,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, SourceError> {
    let entries = parse_rss_entries(body)?;
    let latest = entries
        .iter()
        .filter_map(|entry| parse_editorial_date(&entry.published))
        .max()
        .ok_or_else(|| {
            SourceError::Parse("Bandcamp RSS contained no parseable publication date".to_string())
        })?;
    let age_seconds = now.signed_duration_since(latest).num_seconds().max(0);
    if age_seconds > i64::try_from(max_age.as_secs()).unwrap_or(i64::MAX) {
        return Err(SourceError::StaleEditorial {
            age_days: age_seconds / 86_400,
            limit_days: max_age.as_secs() / 86_400,
        });
    }

    let items = entries
        .into_iter()
        .filter_map(|entry| {
            let title = nonempty(entry.title)?;
            let link = nonempty(entry.link)?;
            if !is_bandcamp_daily_url(&link) {
                return None;
            }
            let source_item_id = nonempty(entry.guid).unwrap_or_else(|| link.clone());
            let published = parse_editorial_date(&entry.published);
            let artwork_url = extract_html_attribute(&entry.description, "img", "src")
                .filter(|url| is_allowed_bandcamp_artwork_url(url));
            let mut tags = entry
                .categories
                .into_iter()
                .filter_map(nonempty)
                .collect::<Vec<_>>();
            tags.sort_by_key(|tag| tag.to_lowercase());
            tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            let mut external_ids = BTreeMap::new();
            external_ids.insert("bandcamp_daily_url".to_string(), link.clone());
            Some(SourceItem {
                source: BANDCAMP_SOURCE.to_string(),
                source_family: BANDCAMP_FAMILY.to_string(),
                source_item_id,
                item_kind: SourceItemKind::Editorial,
                title,
                // RSS creator is the article author, not necessarily a music artist.
                artist: None,
                album: None,
                artwork_url,
                release_date: published.map(|date| date.format("%Y-%m-%d").to_string()),
                rank: None,
                audience_count: None,
                metrics: SourceMetrics::default(),
                tags,
                market: None,
                observed_at: now.timestamp(),
                editorial_url: Some(link),
                external_ids,
            })
        })
        .take(limit)
        .collect::<Vec<_>>();
    if items.is_empty() {
        Err(SourceError::Empty)
    } else {
        Ok(items)
    }
}

fn parse_rss_entries(body: &[u8]) -> Result<Vec<BandcampEntry>, SourceError> {
    let mut reader = Reader::from_reader(body);
    reader.config_mut().trim_text(true);
    let mut entries = Vec::new();
    let mut current: Option<BandcampEntry> = None;
    let mut field: Option<BandcampField> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = String::from_utf8_lossy(element.name().as_ref()).to_ascii_lowercase();
                if name == "item" {
                    current = Some(BandcampEntry::default());
                    field = None;
                } else if current.is_some() {
                    field = match name.as_str() {
                        "title" => Some(BandcampField::Title),
                        "link" => Some(BandcampField::Link),
                        "description" => Some(BandcampField::Description),
                        "category" => Some(BandcampField::Category),
                        "pubdate" => Some(BandcampField::PubDate),
                        "dc:date" => Some(BandcampField::DcDate),
                        "guid" => Some(BandcampField::Guid),
                        _ => None,
                    };
                }
            }
            Ok(Event::Text(text)) => {
                let decoded = text
                    .decode()
                    .map_err(|error| SourceError::Parse(format!("Bandcamp RSS text: {error}")))?;
                let decoded = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| SourceError::Parse(format!("Bandcamp RSS entity: {error}")))?;
                append_bandcamp_text(current.as_mut(), field, &decoded);
            }
            Ok(Event::CData(text)) => {
                let decoded = text
                    .decode()
                    .map_err(|error| SourceError::Parse(format!("Bandcamp RSS CDATA: {error}")))?;
                append_bandcamp_text(current.as_mut(), field, &decoded);
            }
            Ok(Event::End(element)) => {
                let name = String::from_utf8_lossy(element.name().as_ref()).to_ascii_lowercase();
                if name == "item" {
                    if let Some(entry) = current.take() {
                        entries.push(entry);
                    }
                    field = None;
                } else if matches!(
                    name.as_str(),
                    "title" | "link" | "description" | "category" | "pubdate" | "dc:date" | "guid"
                ) {
                    field = None;
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(SourceError::Parse(format!("Bandcamp RSS XML: {error}")));
            }
        }
    }
    Ok(entries)
}

fn append_bandcamp_text(
    entry: Option<&mut BandcampEntry>,
    field: Option<BandcampField>,
    value: &str,
) {
    let (Some(entry), Some(field)) = (entry, field) else {
        return;
    };
    match field {
        BandcampField::Title => entry.title.push_str(value),
        BandcampField::Link => entry.link.push_str(value),
        BandcampField::Description => entry.description.push_str(value),
        BandcampField::Category => {
            if let Some(category) = nonempty(value.to_string()) {
                entry.categories.push(category);
            }
        }
        BandcampField::PubDate => entry.published.push_str(value),
        BandcampField::DcDate if entry.published.is_empty() => entry.published.push_str(value),
        BandcampField::DcDate => {}
        BandcampField::Guid => entry.guid.push_str(value),
    }
}

fn parse_editorial_date(value: &str) -> Option<DateTime<Utc>> {
    let normalized = value.trim().replace(" -0000", " +0000");
    DateTime::parse_from_rfc2822(&normalized)
        .or_else(|_| DateTime::parse_from_rfc3339(&normalized))
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

fn is_bandcamp_daily_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("daily.bandcamp.com"))
    })
}

fn is_allowed_bandcamp_artwork_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("bcbits.com")
                    || host.to_ascii_lowercase().ends_with(".bcbits.com")
            })
    })
}

fn extract_html_attribute(html: &str, tag: &str, attribute: &str) -> Option<String> {
    let lowercase = html.to_ascii_lowercase();
    let tag_start = lowercase.find(&format!("<{tag}"))?;
    let tag_end = lowercase[tag_start..].find('>')? + tag_start;
    let fragment = &html[tag_start..tag_end];
    let fragment_lowercase = &lowercase[tag_start..tag_end];
    let attribute_start = fragment_lowercase.find(attribute)? + attribute.len();
    let after_name = &fragment[attribute_start..];
    let equals = after_name.find('=')?;
    let value = after_name[equals + 1..].trim_start();
    let quote = value.chars().next()?;
    if quote == '"' || quote == '\'' {
        let remainder = &value[quote.len_utf8()..];
        let end = remainder.find(quote)?;
        nonempty(remainder[..end].to_string())
    } else {
        let end = value
            .find(|character: char| character.is_ascii_whitespace())
            .unwrap_or(value.len());
        nonempty(value[..end].to_string())
    }
}

/// Official Last.fm top-tracks API. The caller must supply an API key; `fetch_all`
/// skips this adapter when neither supported environment variable is configured.
pub async fn fetch_lastfm_top_tracks(
    client: &Client,
    api_key: &str,
    limit: u16,
    now: DateTime<Utc>,
) -> Result<SourceBatch, SourceError> {
    let api_key = configured_key(Some(api_key)).ok_or_else(|| {
        SourceError::InvalidConfig("a non-empty Last.fm API key is required".to_string())
    })?;
    if !(1..=1000).contains(&limit) {
        return Err(SourceError::InvalidConfig(
            "Last.fm limit must be between 1 and 1000".to_string(),
        ));
    }
    let request = client
        .get("https://ws.audioscrobbler.com/2.0/")
        .header("Accept", "application/json")
        .query(&[
            ("method", "chart.getTopTracks"),
            ("api_key", api_key),
            ("format", "json"),
            ("limit", &limit.to_string()),
            ("page", "1"),
        ]);
    let body = get_limited(request, MAX_JSON_BYTES).await?;
    let items = parse_lastfm_tracks(&body, now)?;
    Ok(SourceBatch {
        source: LASTFM_SOURCE.to_string(),
        label: "Last.fm top tracks".to_string(),
        fetched_at: now.timestamp(),
        cadence_secs: LASTFM_CADENCE_SECS,
        items,
    })
}

#[derive(Deserialize)]
struct LastFmResponse {
    tracks: LastFmTracks,
}

#[derive(Deserialize)]
struct LastFmTracks {
    #[serde(default)]
    track: Vec<LastFmTrack>,
}

#[derive(Deserialize)]
struct LastFmTrack {
    #[serde(default)]
    name: String,
    #[serde(default)]
    mbid: String,
    #[serde(default)]
    url: String,
    listeners: Option<String>,
    playcount: Option<String>,
    artist: LastFmArtist,
    #[serde(default)]
    image: Vec<LastFmImage>,
}

#[derive(Deserialize)]
struct LastFmArtist {
    #[serde(default)]
    name: String,
    #[serde(default)]
    mbid: String,
}

#[derive(Deserialize)]
struct LastFmImage {
    #[serde(rename = "#text", default)]
    url: String,
    #[serde(default)]
    size: String,
}

fn parse_lastfm_tracks(body: &[u8], now: DateTime<Utc>) -> Result<Vec<SourceItem>, SourceError> {
    let response: LastFmResponse = serde_json::from_slice(body)
        .map_err(|error| SourceError::Parse(format!("Last.fm JSON: {error}")))?;
    let items = response
        .tracks
        .track
        .into_iter()
        .enumerate()
        .filter_map(|(index, track)| {
            let title = nonempty(track.name)?;
            let artist = nonempty(track.artist.name)?;
            let recording_mbid = nonempty(track.mbid);
            let artist_mbid = nonempty(track.artist.mbid);
            let source_item_id = recording_mbid
                .clone()
                .unwrap_or_else(|| stable_text_id(&artist, &title));
            let mut external_ids = BTreeMap::new();
            if let Some(value) = recording_mbid {
                external_ids.insert("musicbrainz_recording_id".to_string(), value);
            }
            if let Some(value) = artist_mbid {
                external_ids.insert("musicbrainz_artist_id".to_string(), value);
            }
            if let Some(value) = nonempty(track.url) {
                external_ids.insert("lastfm_track_url".to_string(), value);
            }
            let artwork_url = best_lastfm_image(track.image);
            let listener_count = parse_u64_text(track.listeners);
            let play_count = parse_u64_text(track.playcount);
            Some(SourceItem {
                source: LASTFM_SOURCE.to_string(),
                source_family: LASTFM_FAMILY.to_string(),
                source_item_id,
                item_kind: SourceItemKind::Track,
                title,
                artist: Some(artist),
                album: None,
                artwork_url,
                release_date: None,
                rank: u32::try_from(index + 1).ok(),
                audience_count: listener_count,
                metrics: SourceMetrics {
                    listener_count,
                    play_count,
                    ..SourceMetrics::default()
                },
                tags: Vec::new(),
                market: None,
                observed_at: now.timestamp(),
                editorial_url: None,
                external_ids,
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        Err(SourceError::Empty)
    } else {
        Ok(items)
    }
}

fn best_lastfm_image(images: Vec<LastFmImage>) -> Option<String> {
    const ORDER: [&str; 6] = ["mega", "extralarge", "large", "medium", "small", ""];
    ORDER.into_iter().find_map(|wanted| {
        images
            .iter()
            .find(|image| image.size.eq_ignore_ascii_case(wanted))
            .and_then(|image| nonempty(image.url.clone()))
            .filter(|url| is_https_url(url))
    })
}

/// Official YouTube Data API `videos.list?chart=mostPopular` call, narrowed to
/// category 10 (Music). This is a video-level signal, not a YouTube Music song chart.
pub async fn fetch_youtube_most_popular_music(
    client: &Client,
    api_key: &str,
    market: &str,
    limit: u16,
    now: DateTime<Utc>,
) -> Result<SourceBatch, SourceError> {
    let api_key = configured_key(Some(api_key)).ok_or_else(|| {
        SourceError::InvalidConfig("a non-empty YouTube API key is required".to_string())
    })?;
    if !(1..=50).contains(&limit) {
        return Err(SourceError::InvalidConfig(
            "YouTube limit must be between 1 and 50".to_string(),
        ));
    }
    let market = validate_market(market)?;
    let request = client
        .get("https://www.googleapis.com/youtube/v3/videos")
        .header("Accept", "application/json")
        .query(&[
            ("part", "snippet,statistics"),
            ("chart", "mostPopular"),
            ("regionCode", market.as_str()),
            ("videoCategoryId", "10"),
            ("maxResults", &limit.to_string()),
            ("key", api_key),
        ]);
    let body = get_limited(request, MAX_JSON_BYTES).await?;
    let items = parse_youtube_videos(&body, &market, now)?;
    Ok(SourceBatch {
        source: YOUTUBE_SOURCE.to_string(),
        label: format!("YouTube popular music videos ({})", market.to_uppercase()),
        fetched_at: now.timestamp(),
        cadence_secs: YOUTUBE_CADENCE_SECS,
        items,
    })
}

#[derive(Deserialize)]
struct YouTubeResponse {
    #[serde(default)]
    items: Vec<YouTubeVideo>,
}

#[derive(Deserialize)]
struct YouTubeVideo {
    #[serde(default)]
    id: String,
    snippet: YouTubeSnippet,
    #[serde(default)]
    statistics: YouTubeStatistics,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeSnippet {
    #[serde(default)]
    title: String,
    #[serde(default)]
    channel_title: String,
    published_at: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    thumbnails: BTreeMap<String, YouTubeThumbnail>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct YouTubeStatistics {
    view_count: Option<String>,
    like_count: Option<String>,
}

#[derive(Deserialize)]
struct YouTubeThumbnail {
    #[serde(default)]
    url: String,
}

fn parse_youtube_videos(
    body: &[u8],
    market: &str,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, SourceError> {
    let response: YouTubeResponse = serde_json::from_slice(body)
        .map_err(|error| SourceError::Parse(format!("YouTube JSON: {error}")))?;
    let market = market.to_uppercase();
    let items = response
        .items
        .into_iter()
        .enumerate()
        .filter_map(|(index, video)| {
            let id = nonempty(video.id)?;
            let title = nonempty(video.snippet.title)?;
            let channel = nonempty(video.snippet.channel_title)?;
            let artwork_url = best_youtube_thumbnail(&video.snippet.thumbnails);
            let mut tags = video
                .snippet
                .tags
                .into_iter()
                .filter_map(nonempty)
                .take(12)
                .collect::<Vec<_>>();
            tags.sort_by_key(|tag| tag.to_lowercase());
            tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            let mut external_ids = BTreeMap::new();
            external_ids.insert("youtube_video_id".to_string(), id.clone());
            Some(SourceItem {
                source: YOUTUBE_SOURCE.to_string(),
                source_family: YOUTUBE_FAMILY.to_string(),
                source_item_id: id,
                item_kind: SourceItemKind::Track,
                title,
                // The public API gives a channel, not a canonical recording artist.
                artist: Some(channel),
                album: None,
                artwork_url,
                release_date: video
                    .snippet
                    .published_at
                    .as_deref()
                    .and_then(|value| value.get(..10))
                    .map(str::to_string)
                    .and_then(valid_iso_date),
                rank: u32::try_from(index + 1).ok(),
                audience_count: parse_u64_text(video.statistics.view_count.clone()),
                metrics: SourceMetrics {
                    view_count: parse_u64_text(video.statistics.view_count),
                    like_count: parse_u64_text(video.statistics.like_count),
                    ..SourceMetrics::default()
                },
                tags,
                market: Some(market.clone()),
                observed_at: now.timestamp(),
                editorial_url: None,
                external_ids,
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        Err(SourceError::Empty)
    } else {
        Ok(items)
    }
}

fn best_youtube_thumbnail(thumbnails: &BTreeMap<String, YouTubeThumbnail>) -> Option<String> {
    ["maxres", "standard", "high", "medium", "default"]
        .into_iter()
        .find_map(|key| thumbnails.get(key))
        .and_then(|thumbnail| nonempty(thumbnail.url.clone()))
        .filter(|url| {
            reqwest::Url::parse(url).is_ok_and(|parsed| {
                parsed.scheme() == "https"
                    && parsed.host_str().is_some_and(|host| {
                        host.eq_ignore_ascii_case("ytimg.com")
                            || host.to_ascii_lowercase().ends_with(".ytimg.com")
                    })
            })
        })
}

async fn get_limited(request: RequestBuilder, max_bytes: usize) -> Result<Vec<u8>, SourceError> {
    let mut response = request.send().await.map_err(request_error)?;
    if !response.status().is_success() {
        return Err(SourceError::HttpStatus(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(SourceError::ResponseTooLarge(max_bytes));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(SourceError::ResponseTooLarge(max_bytes));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn request_error(error: reqwest::Error) -> SourceError {
    let timeout = error.is_timeout();
    let error = error.without_url();
    let mut message = if timeout {
        "request timed out".to_string()
    } else {
        error.to_string()
    };
    let mut cause = StdError::source(&error);
    while let Some(current) = cause {
        let detail = current.to_string();
        if !detail.is_empty() && !message.contains(&detail) {
            message.push_str(": ");
            message.push_str(&detail);
        }
        cause = current.source();
    }
    SourceError::Request(message)
}

fn validate_market(value: &str) -> Result<String, SourceError> {
    let value = value.trim();
    if value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(SourceError::InvalidConfig(format!(
            "market must be a two-letter ISO code, got {value:?}"
        )))
    }
}

fn nonempty(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn valid_iso_date(value: String) -> Option<String> {
    let value = value.trim();
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn looks_like_mbid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn parse_u64_text(value: Option<String>) -> Option<u64> {
    value.and_then(|value| value.trim().parse().ok())
}

fn stable_text_id(artist: &str, title: &str) -> String {
    format!(
        "{}::{}",
        normalize_id_component(artist),
        normalize_id_component(title)
    )
}

fn normalize_id_component(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_https_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 14, 16, 0, 0)
            .single()
            .unwrap()
    }

    #[tokio::test]
    async fn aggregate_fetch_skips_sources_that_are_not_due() {
        let client = build_source_client().expect("client");
        let report = fetch_all(&client, &SourceConfig::default(), now(), &HashSet::new()).await;
        assert!(report.batches.is_empty());
        assert!(report.failures.is_empty());
        assert!(report.skipped.is_empty());
    }

    #[test]
    fn apple_parser_preserves_market_rank_and_provider_ids() {
        let json = br#"{
          "feed": {"results": [
            {
              "id": "1844932150",
              "name": "Choosin' Texas",
              "artistName": "Ella Langley",
              "artistId": "1384373733",
              "releaseDate": "2025-10-17",
              "artworkUrl100": "https://is1-ssl.mzstatic.com/art/100x100.jpg",
              "genres": [{"name": "Country"}, {"name": "Music"}]
            },
            {"id":"2", "name":"Second", "artistName":"Artist Two"}
          ]}
        }"#;

        let items = parse_apple_chart(json, "us", now()).unwrap();

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_kind, SourceItemKind::Track);
        assert_eq!(items[0].market.as_deref(), Some("US"));
        assert_eq!(items[0].rank, Some(1));
        assert_eq!(items[1].rank, Some(2));
        assert_eq!(items[0].tags, vec!["Country"]);
        assert_eq!(
            items[0]
                .external_ids
                .get("apple_music_track_id")
                .map(String::as_str),
            Some("1844932150")
        );
    }

    #[test]
    fn listenbrainz_parser_keeps_release_kind_counts_and_mbids() {
        let json = br#"{
          "payload": {"releases": [
            {
              "artist_credit_name": "R\u00f6yksopp",
              "artist_mbids": ["1c70a3fc-fa3c-4be1-8b55-c3192db8a884"],
              "release_date": "2026-07-12",
              "release_group_mbid": "4f1c579a-8a9c-4f96-92ae-befcdf3e0d32",
              "release_mbid": "1f1db316-8361-4a40-9633-550b259642f5",
              "release_name": "Profound Mysteries",
              "release_group_primary_type": "Album",
              "release_tags": ["Electronic", "electronic"],
              "listen_count": 42,
              "caa_release_mbid": "1f1db316-8361-4a40-9633-550b259642f5"
            }
          ]}
        }"#;

        let items = parse_listenbrainz_releases(json, 10, now()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_kind, SourceItemKind::Release);
        assert_eq!(items[0].audience_count, None);
        assert_eq!(items[0].metrics.play_count, Some(42));
        assert_eq!(items[0].tags, vec!["Album", "Electronic"]);
        assert_eq!(
            items[0]
                .external_ids
                .get("musicbrainz_release_group_id")
                .map(String::as_str),
            Some("4f1c579a-8a9c-4f96-92ae-befcdf3e0d32")
        );
        assert!(items[0]
            .artwork_url
            .as_deref()
            .unwrap()
            .starts_with("https://coverartarchive.org/release/"));
    }

    fn bandcamp_rss(date: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
              <channel>
                <item>
                  <title>Violet Cowboy, &quot;Ramraid at the Wiggly Worm&quot;</title>
                  <link>https://daily.bandcamp.com/album-of-the-day/violet-cowboy-review</link>
                  <description><![CDATA[<p><img src="https://f4.bcbits.com/img/test.jpg"></p>]]></description>
                  <category>Album of the Day</category>
                  <pubDate>{date}</pubDate>
                  <guid isPermaLink="false">194242</guid>
                </item>
              </channel>
            </rss>"#
        )
    }

    #[test]
    fn bandcamp_parser_extracts_current_editorial_and_safe_artwork() {
        let rss = bandcamp_rss("Tue, 14 Jul 2026 14:16:26 +0000");

        let items = parse_bandcamp_feed(rss.as_bytes(), 10, Duration::from_secs(7 * 86_400), now())
            .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_kind, SourceItemKind::Editorial);
        assert_eq!(items[0].source_item_id, "194242");
        assert_eq!(items[0].artist, None);
        assert_eq!(items[0].release_date.as_deref(), Some("2026-07-14"));
        assert_eq!(
            items[0].artwork_url.as_deref(),
            Some("https://f4.bcbits.com/img/test.jpg")
        );
    }

    #[test]
    fn bandcamp_parser_suppresses_stale_feed() {
        let rss = bandcamp_rss("Mon, 14 Jul 2025 14:16:26 +0000");

        let error = parse_bandcamp_feed(rss.as_bytes(), 10, Duration::from_secs(7 * 86_400), now())
            .unwrap_err();

        assert!(matches!(error, SourceError::StaleEditorial { .. }));
    }

    #[test]
    fn lastfm_parser_uses_listener_count_not_playcount_as_audience() {
        let json = br##"{
          "tracks": {"track": [{
            "name": "Dark Fantasy",
            "mbid": "11111111-1111-1111-1111-111111111111",
            "url": "https://www.last.fm/music/Kanye+West/_/Dark+Fantasy",
            "listeners": "1234",
            "playcount": "9876",
            "artist": {"name": "Kanye West", "mbid": "22222222-2222-2222-2222-222222222222"},
            "image": [{"#text":"https://lastfm.freetls.fastly.net/i/u/300x300/test.jpg", "size":"extralarge"}]
          }]}
        }"##;

        let items = parse_lastfm_tracks(json, now()).unwrap();

        assert_eq!(items[0].audience_count, Some(1234));
        assert_eq!(items[0].rank, Some(1));
        assert_eq!(items[0].metrics.listener_count, Some(1234));
        assert_eq!(items[0].metrics.play_count, Some(9876));
        assert!(items[0].tags.is_empty());
        assert_eq!(
            items[0]
                .external_ids
                .get("musicbrainz_recording_id")
                .map(String::as_str),
            Some("11111111-1111-1111-1111-111111111111")
        );
        assert_eq!(
            items[0]
                .external_ids
                .get("lastfm_track_url")
                .map(String::as_str),
            Some("https://www.last.fm/music/Kanye+West/_/Dark+Fantasy")
        );
    }

    #[test]
    fn youtube_parser_marks_video_signal_and_preserves_view_count() {
        let json = br#"{
          "items": [{
            "id": "video123",
            "snippet": {
              "title": "Artist - Song (Official Video)",
              "channelTitle": "ArtistVEVO",
              "publishedAt": "2026-07-10T10:00:00Z",
              "tags": ["music", "official"],
              "thumbnails": {"high": {"url": "https://i.ytimg.com/vi/video123/hqdefault.jpg"}}
            },
            "statistics": {"viewCount": "450000", "likeCount": "12000"}
          }]
        }"#;

        let items = parse_youtube_videos(json, "us", now()).unwrap();

        assert_eq!(items[0].item_kind, SourceItemKind::Track);
        assert_eq!(items[0].artist.as_deref(), Some("ArtistVEVO"));
        assert_eq!(items[0].release_date.as_deref(), Some("2026-07-10"));
        assert_eq!(items[0].audience_count, Some(450_000));
        assert_eq!(items[0].metrics.view_count, Some(450_000));
        assert_eq!(items[0].metrics.like_count, Some(12_000));
        assert_eq!(items[0].market.as_deref(), Some("US"));
    }

    #[test]
    fn observations_are_typed_and_do_not_invent_missing_metrics() {
        let json = br#"{"feed":{"results":[{"id":"1","name":"Song","artistName":"Artist"}]}}"#;
        let items = parse_apple_chart(json, "us", now()).unwrap();
        let batch = SourceBatch {
            source: APPLE_SOURCE.to_string(),
            label: "test".to_string(),
            fetched_at: now().timestamp(),
            cadence_secs: APPLE_CADENCE_SECS,
            items,
        };

        let observations = observations_for_batch(&batch);

        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].kind, ObservationKind::ChartRank);
        assert_eq!(observations[0].value, 1);
    }

    #[test]
    fn market_validation_rejects_path_and_query_injection() {
        assert_eq!(validate_market("US").unwrap(), "us");
        assert!(validate_market("us/../../").is_err());
        assert!(validate_market("us?key=oops").is_err());
        assert!(validate_market("").is_err());
    }

    #[test]
    fn html_attribute_parser_handles_single_and_double_quotes() {
        assert_eq!(
            extract_html_attribute("<img src='https://example.test/a.jpg'>", "img", "src")
                .as_deref(),
            Some("https://example.test/a.jpg")
        );
        assert_eq!(
            extract_html_attribute(
                "<img alt=cover src=\"https://example.test/b.jpg\">",
                "img",
                "src"
            )
            .as_deref(),
            Some("https://example.test/b.jpg")
        );
    }

    #[tokio::test]
    #[ignore = "explicit live-provider smoke test"]
    async fn live_no_key_sources_return_current_items() {
        let client = build_source_client().unwrap();
        let observed_at = Utc::now();
        let apple_markets = ["US".to_string()];
        let (apple, listenbrainz, bandcamp) = tokio::join!(
            fetch_apple_charts(&client, &apple_markets, 5, observed_at),
            fetch_listenbrainz_fresh_releases(
                &client,
                observed_at.date_naive(),
                2,
                25,
                observed_at,
            ),
            fetch_bandcamp_daily(&client, 10, Duration::from_secs(7 * 86_400), observed_at,),
        );
        assert!(!apple.unwrap().items.is_empty());
        assert!(!listenbrainz.unwrap().items.is_empty());
        assert!(!bandcamp.unwrap().items.is_empty());
    }
}
