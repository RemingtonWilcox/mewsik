//! Strict client for mewsik's credential-free hosted discovery snapshot.
//!
//! Provider credentials stay in the scheduled publisher. The desktop downloads
//! only public, normalized observations and still performs ranking,
//! personalization, history, and fallback locally.

use super::sources::{
    get_limited, SourceBatch, SourceDeliveryState, SourceDeliveryStatus, SourceError,
    SourceFetchReport, SourceItem, SourceItemKind, HOSTED_DISCOVERY_SNAPSHOT_URL,
    LASTFM_CADENCE_SECS, LASTFM_SOURCE, YOUTUBE_CADENCE_SECS, YOUTUBE_SOURCE,
};
use chrono::{DateTime, Utc};
use reqwest::{Client, Url};
use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;

const HOSTED_SCHEMA_VERSION: u8 = 1;
const MAX_HOSTED_BYTES: usize = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_SECS: i64 = 5 * 60;
const MAX_SNAPSHOT_AGE_SECS: i64 = 7 * 24 * 60 * 60;
const MAX_DETAIL_CHARS: usize = 500;
const MAX_LABEL_CHARS: usize = 200;
const MAX_ITEM_TEXT_CHARS: usize = 512;
const MAX_URL_CHARS: usize = 2_048;
const MAX_TAGS_PER_ITEM: usize = 12;
const YOUTUBE_ITEM_LIMIT: usize = 50;
const LASTFM_ITEM_LIMIT: usize = 100;

#[derive(Clone, Debug, Deserialize)]
pub struct HostedDiscoverySnapshot {
    schema_version: u8,
    snapshot_id: String,
    generated_at: i64,
    next_refresh_at: i64,
    sources: Vec<HostedSource>,
}

#[derive(Clone, Debug, Deserialize)]
struct HostedSource {
    id: String,
    state: SourceDeliveryState,
    last_attempt_at: i64,
    detail: Option<String>,
    batch: Option<SourceBatch>,
}

pub async fn fetch_hosted_snapshot(
    client: &Client,
    endpoint: &str,
    now: DateTime<Utc>,
) -> Result<HostedDiscoverySnapshot, SourceError> {
    let url = validate_endpoint(endpoint)?;
    let body = get_limited(
        client
            .get(url)
            .timeout(Duration::from_secs(4))
            .header("Accept", "application/json"),
        MAX_HOSTED_BYTES,
    )
    .await?;
    parse_hosted_snapshot(&body, now.timestamp())
}

pub fn merge_hosted_snapshot(
    report: &mut SourceFetchReport,
    snapshot: HostedDiscoverySnapshot,
    requested_sources: &HashSet<&str>,
) {
    report.hosted_next_refresh_at = Some(snapshot.next_refresh_at);
    let mut delivered = HashSet::new();

    for source in snapshot.sources {
        if !requested_sources.contains(source.id.as_str()) {
            continue;
        }
        delivered.insert(source.id.clone());
        report.delivery_statuses.insert(
            source.id.clone(),
            SourceDeliveryStatus {
                state: source.state.clone(),
                last_attempt_at: Some(source.last_attempt_at),
                detail: source.detail,
            },
        );

        match (source.state, source.batch) {
            (SourceDeliveryState::Unavailable, _) | (_, None) => report.skipped.push(source.id),
            (_, Some(batch)) => report.batches.push(batch),
        }
    }

    for source in requested_sources {
        if delivered.contains(*source) {
            continue;
        }
        report.delivery_statuses.insert(
            (*source).to_string(),
            SourceDeliveryStatus {
                state: SourceDeliveryState::Unavailable,
                last_attempt_at: Some(snapshot.generated_at),
                detail: Some("The shared snapshot does not currently publish this source".into()),
            },
        );
        report.skipped.push((*source).to_string());
    }
}

fn validate_endpoint(value: &str) -> Result<Url, SourceError> {
    let url = Url::parse(value)
        .map_err(|_| SourceError::InvalidConfig("invalid hosted snapshot URL".to_string()))?;
    let canonical = Url::parse(HOSTED_DISCOVERY_SNAPSHOT_URL)
        .expect("canonical hosted discovery URL must be valid");
    if url != canonical {
        return Err(SourceError::InvalidConfig(
            "hosted snapshot URL is not the approved mewsik endpoint".to_string(),
        ));
    }
    Ok(url)
}

fn parse_hosted_snapshot(body: &[u8], now: i64) -> Result<HostedDiscoverySnapshot, SourceError> {
    let mut snapshot = serde_json::from_slice::<HostedDiscoverySnapshot>(body)
        .map_err(|error| SourceError::Parse(format!("hosted snapshot JSON: {error}")))?;

    if snapshot.schema_version != HOSTED_SCHEMA_VERSION {
        return Err(SourceError::Parse(format!(
            "unsupported hosted snapshot schema {}",
            snapshot.schema_version
        )));
    }
    validate_text(&snapshot.snapshot_id, "snapshot id", 200)?;
    validate_timestamp(
        snapshot.generated_at,
        now,
        MAX_SNAPSHOT_AGE_SECS,
        "generated_at",
    )?;
    if snapshot.next_refresh_at < snapshot.generated_at
        || snapshot.next_refresh_at > snapshot.generated_at + 24 * 60 * 60
    {
        return Err(SourceError::Parse(
            "hosted next_refresh_at is outside its allowed window".to_string(),
        ));
    }
    if snapshot.sources.len() > 2 {
        return Err(SourceError::Parse(
            "hosted snapshot contains too many sources".to_string(),
        ));
    }

    let mut seen = HashSet::new();
    for source in &mut snapshot.sources {
        validate_text(&source.id, "source id", 100)?;
        let (family, cadence, item_limit) = expected_source(&source.id)?;
        if !seen.insert(source.id.as_str()) {
            return Err(SourceError::Parse(format!(
                "hosted snapshot repeats source {}",
                source.id
            )));
        }
        validate_timestamp(
            source.last_attempt_at,
            now,
            MAX_SNAPSHOT_AGE_SECS,
            "last_attempt_at",
        )?;
        if source.last_attempt_at > snapshot.generated_at + MAX_CLOCK_SKEW_SECS {
            return Err(SourceError::Parse(format!(
                "hosted source {} was attempted after the snapshot was generated",
                source.id
            )));
        }
        if let Some(detail) = source.detail.as_deref() {
            validate_text(detail, "source detail", MAX_DETAIL_CHARS)?;
        }
        let mut aged_outside_cadence = false;
        match (&source.state, &source.batch) {
            (SourceDeliveryState::Unavailable, Some(_)) => {
                return Err(SourceError::Parse(format!(
                    "unavailable hosted source {} must not contain a batch",
                    source.id
                )))
            }
            (SourceDeliveryState::Unavailable, None) => {}
            (_, Some(batch)) => {
                validate_batch(
                    batch,
                    &source.id,
                    family,
                    cadence,
                    item_limit,
                    &source.state,
                    snapshot.generated_at,
                    now,
                )?;
                aged_outside_cadence = now.saturating_sub(batch.fetched_at)
                    > i64::try_from(cadence).unwrap_or(i64::MAX);
            }
            (_, None) => {
                return Err(SourceError::Parse(format!(
                    "hosted source {} is missing its batch",
                    source.id
                )))
            }
        }

        // Delivery state describes the frame when the publisher generated it.
        // A client may receive that otherwise-valid frame after its source
        // cadence has elapsed (for example during a delayed scheduled run).
        // Preserve the bounded last-known-good batch, but never call it live.
        if aged_outside_cadence
            && matches!(
                source.state,
                SourceDeliveryState::Live | SourceDeliveryState::Cached
            )
        {
            source.state = SourceDeliveryState::Stale;
            source.detail = Some(
                "The shared chart is older than its normal refresh window; serving the last known batch."
                    .to_string(),
            );
        }
    }

    Ok(snapshot)
}

fn expected_source(source: &str) -> Result<(&'static str, u64, usize), SourceError> {
    match source {
        LASTFM_SOURCE => Ok(("lastfm", LASTFM_CADENCE_SECS, LASTFM_ITEM_LIMIT)),
        YOUTUBE_SOURCE => Ok(("youtube", YOUTUBE_CADENCE_SECS, YOUTUBE_ITEM_LIMIT)),
        _ => Err(SourceError::Parse(format!(
            "hosted snapshot contains unknown source {source}"
        ))),
    }
}

fn validate_batch(
    batch: &SourceBatch,
    source: &str,
    family: &str,
    cadence: u64,
    item_limit: usize,
    state: &SourceDeliveryState,
    generated_at: i64,
    now: i64,
) -> Result<(), SourceError> {
    if batch.source != source || batch.cadence_secs != cadence {
        return Err(SourceError::Parse(format!(
            "hosted batch contract mismatch for {source}"
        )));
    }
    validate_text(&batch.label, "batch label", MAX_LABEL_CHARS)?;
    let max_age = i64::try_from(cadence).unwrap_or(i64::MAX).saturating_mul(3);
    validate_timestamp(batch.fetched_at, now, max_age, "batch fetched_at")?;
    if batch.fetched_at > generated_at + MAX_CLOCK_SKEW_SECS {
        return Err(SourceError::Parse(format!(
            "hosted batch for {source} was fetched after the snapshot was generated"
        )));
    }
    if matches!(
        state,
        SourceDeliveryState::Live | SourceDeliveryState::Cached
    ) && generated_at.saturating_sub(batch.fetched_at)
        > i64::try_from(cadence).unwrap_or(i64::MAX)
    {
        return Err(SourceError::Parse(format!(
            "hosted fresh batch for {source} was already older than its cadence when published"
        )));
    }
    if batch.items.is_empty() || batch.items.len() > item_limit {
        return Err(SourceError::Parse(format!(
            "hosted batch for {source} has an invalid item count"
        )));
    }
    for item in &batch.items {
        validate_item(item, batch, family, item_limit, now)?;
    }
    Ok(())
}

fn validate_item(
    item: &SourceItem,
    batch: &SourceBatch,
    family: &str,
    item_limit: usize,
    now: i64,
) -> Result<(), SourceError> {
    if item.source != batch.source
        || item.source_family != family
        || item.item_kind != SourceItemKind::Track
    {
        return Err(SourceError::Parse(format!(
            "hosted item source contract mismatch for {}",
            batch.source
        )));
    }
    validate_text(&item.source_item_id, "source item id", MAX_ITEM_TEXT_CHARS)?;
    validate_text(&item.title, "item title", MAX_ITEM_TEXT_CHARS)?;
    validate_optional_text(item.artist.as_deref(), "item artist")?;
    validate_optional_text(item.album.as_deref(), "item album")?;
    validate_optional_text(item.release_date.as_deref(), "release date")?;
    if item.rank.is_some_and(|rank| {
        rank == 0 || usize::try_from(rank).map_or(true, |rank| rank > item_limit)
    }) {
        return Err(SourceError::Parse(
            "hosted item has invalid rank".to_string(),
        ));
    }
    validate_timestamp(item.observed_at, now, MAX_SNAPSHOT_AGE_SECS, "observed_at")?;
    if item.observed_at > batch.fetched_at + MAX_CLOCK_SKEW_SECS {
        return Err(SourceError::Parse(
            "hosted item observation is newer than its batch".to_string(),
        ));
    }
    if item.tags.len() > MAX_TAGS_PER_ITEM
        || item
            .tags
            .iter()
            .any(|tag| tag.chars().count() > 100 || tag.trim().is_empty())
        || item.external_ids.len() > 4
        || item.external_ids.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().count() > 100
                || value.is_empty()
                || value.chars().count() > MAX_URL_CHARS
        })
    {
        return Err(SourceError::Parse(
            "hosted item metadata exceeds its limits".to_string(),
        ));
    }

    match batch.source.as_str() {
        YOUTUBE_SOURCE => {
            if item.market.as_deref() != Some("US") {
                return Err(SourceError::Parse(
                    "hosted YouTube item has an unsupported market".to_string(),
                ));
            }
            if item.rank.is_some() || item.audience_count.is_some() {
                return Err(SourceError::Parse(
                    "hosted YouTube item contains a derived rank or headline metric".to_string(),
                ));
            }
            if item
                .artwork_url
                .as_deref()
                .is_some_and(|url| !allowed_https_subdomain_url(url, "ytimg.com"))
                || item.editorial_url.as_deref().is_some_and(|url| {
                    !allowed_https_url(url, &["youtube.com", "www.youtube.com", "youtu.be"])
                })
            {
                return Err(SourceError::Parse(
                    "hosted YouTube item contains an unapproved URL".to_string(),
                ));
            }
            if item.external_ids.len() != 1
                || item
                    .external_ids
                    .get("youtube_video_id")
                    .is_none_or(|video_id| video_id != &item.source_item_id)
            {
                return Err(SourceError::Parse(
                    "hosted YouTube item contains invalid external identifiers".to_string(),
                ));
            }
        }
        LASTFM_SOURCE => {
            if item.market.is_some() || item.artwork_url.is_some() {
                return Err(SourceError::Parse(
                    "hosted Last.fm item contains unsupported media or scope".to_string(),
                ));
            }
            if item
                .editorial_url
                .as_deref()
                .is_none_or(|url| !allowed_https_subdomain_url(url, "last.fm"))
            {
                return Err(SourceError::Parse(
                    "hosted Last.fm item is missing its approved provider linkback".to_string(),
                ));
            }
            validate_lastfm_external_ids(item)?;
        }
        _ => unreachable!("batch source was allowlisted earlier"),
    }
    Ok(())
}

fn validate_timestamp(value: i64, now: i64, max_age: i64, field: &str) -> Result<(), SourceError> {
    if value <= 0 || value > now + MAX_CLOCK_SKEW_SECS || now.saturating_sub(value) > max_age {
        return Err(SourceError::Parse(format!(
            "hosted {field} is outside its allowed time window"
        )));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, field: &str) -> Result<(), SourceError> {
    if let Some(value) = value {
        validate_text(value, field, MAX_ITEM_TEXT_CHARS)?;
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, max_chars: usize) -> Result<(), SourceError> {
    if value.trim().is_empty() || value.chars().count() > max_chars {
        return Err(SourceError::Parse(format!(
            "hosted {field} is empty or too long"
        )));
    }
    Ok(())
}

fn allowed_https_url(value: &str, allowed_hosts: &[&str]) -> bool {
    if value.chars().count() > MAX_URL_CHARS {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                allowed_hosts
                    .iter()
                    .any(|allowed| host.eq_ignore_ascii_case(allowed))
            })
    })
}

fn allowed_https_subdomain_url(value: &str, domain: &str) -> bool {
    if value.chars().count() > MAX_URL_CHARS {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case(domain)
                    || host.to_ascii_lowercase().ends_with(&format!(".{domain}"))
            })
    })
}

fn validate_lastfm_external_ids(item: &SourceItem) -> Result<(), SourceError> {
    if item.external_ids.keys().any(|key| {
        !matches!(
            key.as_str(),
            "musicbrainz_recording_id" | "musicbrainz_artist_id" | "lastfm_track_url"
        )
    }) {
        return Err(SourceError::Parse(
            "hosted Last.fm item contains an unknown external identifier".to_string(),
        ));
    }

    let recording_mbid = item.external_ids.get("musicbrainz_recording_id");
    if recording_mbid.is_some_and(|value| !is_mbid(value))
        || item
            .external_ids
            .get("musicbrainz_artist_id")
            .is_some_and(|value| !is_mbid(value))
        || item
            .external_ids
            .get("lastfm_track_url")
            .is_some_and(|value| !allowed_https_subdomain_url(value, "last.fm"))
    {
        return Err(SourceError::Parse(
            "hosted Last.fm item contains an invalid external identifier".to_string(),
        ));
    }

    let valid_source_id = recording_mbid.is_some_and(|value| value == &item.source_item_id)
        || (recording_mbid.is_none()
            && item.source_item_id.len() == "lastfm-text-".len() + 32
            && item.source_item_id.starts_with("lastfm-text-")
            && item.source_item_id["lastfm-text-".len()..]
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
    if !valid_source_id {
        return Err(SourceError::Parse(
            "hosted Last.fm source identifier does not match its canonical identifier".to_string(),
        ));
    }
    Ok(())
}

fn is_mbid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::sources::SourceMetrics;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn youtube_item(now: i64) -> SourceItem {
        SourceItem {
            source: YOUTUBE_SOURCE.to_string(),
            source_family: "youtube".to_string(),
            source_item_id: "video-1".to_string(),
            item_kind: SourceItemKind::Track,
            title: "A real song".to_string(),
            artist: Some("Artist".to_string()),
            album: None,
            artwork_url: Some("https://i.ytimg.com/vi/video-1/hqdefault.jpg".to_string()),
            release_date: Some("2026-07-14".to_string()),
            rank: None,
            audience_count: None,
            metrics: SourceMetrics {
                view_count: Some(100),
                like_count: Some(10),
                ..SourceMetrics::default()
            },
            tags: vec!["youtube chart".to_string()],
            market: Some("US".to_string()),
            observed_at: now,
            editorial_url: Some("https://www.youtube.com/watch?v=video-1".to_string()),
            external_ids: BTreeMap::from([("youtube_video_id".to_string(), "video-1".to_string())]),
        }
    }

    fn youtube_batch(now: i64) -> SourceBatch {
        SourceBatch {
            source: YOUTUBE_SOURCE.to_string(),
            label: "YouTube music heat · shared snapshot".to_string(),
            fetched_at: now,
            cadence_secs: YOUTUBE_CADENCE_SECS,
            items: vec![youtube_item(now)],
        }
    }

    fn lastfm_item(now: i64) -> SourceItem {
        let recording_id = "11111111-2222-3333-4444-555555555555";
        SourceItem {
            source: LASTFM_SOURCE.to_string(),
            source_family: "lastfm".to_string(),
            source_item_id: recording_id.to_string(),
            item_kind: SourceItemKind::Track,
            title: "A chart track".to_string(),
            artist: Some("Artist".to_string()),
            album: None,
            artwork_url: None,
            release_date: None,
            rank: Some(1),
            audience_count: Some(100),
            metrics: SourceMetrics {
                listener_count: Some(100),
                ..SourceMetrics::default()
            },
            tags: Vec::new(),
            market: None,
            observed_at: now,
            editorial_url: Some("https://www.last.fm/music/Artist/_/A+chart+track".to_string()),
            external_ids: BTreeMap::from([
                (
                    "musicbrainz_recording_id".to_string(),
                    recording_id.to_string(),
                ),
                (
                    "lastfm_track_url".to_string(),
                    "https://www.last.fm/music/Artist/_/A+chart+track".to_string(),
                ),
            ]),
        }
    }

    fn snapshot_json(now: i64, state: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "snapshot_id": "hosted-test",
            "generated_at": now,
            "next_refresh_at": now + 900,
            "sources": [{
                "id": YOUTUBE_SOURCE,
                "state": state,
                "last_attempt_at": now,
                "detail": "Shared chart snapshot",
                "batch": youtube_batch(now)
            }]
        }))
        .unwrap()
    }

    #[test]
    fn valid_snapshot_round_trips_into_a_delivery_aware_report() {
        let now = 1_800_000_000;
        let snapshot = parse_hosted_snapshot(&snapshot_json(now, "cached"), now).unwrap();
        let mut report = SourceFetchReport::default();
        merge_hosted_snapshot(&mut report, snapshot, &HashSet::from([YOUTUBE_SOURCE]));

        assert_eq!(report.batches.len(), 1);
        assert_eq!(report.hosted_next_refresh_at, Some(now + 900));
        assert_eq!(
            report.delivery_statuses[YOUTUBE_SOURCE].state,
            SourceDeliveryState::Cached
        );
    }

    #[test]
    fn snapshot_rejects_unknown_duplicate_and_future_data() {
        let now = 1_800_000_000;
        let unknown = json!({
            "schema_version": 1,
            "snapshot_id": "bad-source",
            "generated_at": now,
            "next_refresh_at": now + 60,
            "sources": [{
                "id": "made_up",
                "state": "unavailable",
                "last_attempt_at": now,
                "detail": null,
                "batch": null
            }]
        });
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&unknown).unwrap(), now).is_err());

        let mut duplicate =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        let repeated = duplicate["sources"][0].clone();
        duplicate["sources"] = json!([repeated, duplicate["sources"][0].clone()]);
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&duplicate).unwrap(), now).is_err());

        let mut future =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        future["generated_at"] = json!(now + MAX_CLOCK_SKEW_SECS + 1);
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&future).unwrap(), now).is_err());
    }

    #[test]
    fn snapshot_rejects_unapproved_artwork_and_stale_live_batches() {
        let now = 1_800_000_000;
        let mut bad_art =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        bad_art["sources"][0]["batch"]["items"][0]["artwork_url"] =
            json!("https://attacker.example/cover.jpg");
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&bad_art).unwrap(), now).is_err());

        let stale_at = now - i64::try_from(YOUTUBE_CADENCE_SECS).unwrap() - 1;
        let mut stale_live =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        stale_live["sources"][0]["batch"]["fetched_at"] = json!(stale_at);
        stale_live["sources"][0]["batch"]["items"][0]["observed_at"] = json!(stale_at);
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&stale_live).unwrap(), now).is_err());
    }

    #[test]
    fn delayed_delivery_downgrades_a_previously_fresh_batch_to_stale() {
        let published_at = 1_800_000_000;
        let received_at = published_at + i64::try_from(YOUTUBE_CADENCE_SECS).unwrap() + 1;
        let snapshot =
            parse_hosted_snapshot(&snapshot_json(published_at, "live"), received_at).unwrap();
        let youtube = &snapshot.sources[0];

        assert_eq!(youtube.state, SourceDeliveryState::Stale);
        assert!(youtube.batch.is_some());
        assert!(youtube
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("older than its normal refresh window")));
    }

    #[test]
    fn source_contract_rejects_wrong_external_ids_and_accepts_ytimg_subdomains() {
        let now = 1_800_000_000;
        let mut wrong_id =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        wrong_id["sources"][0]["batch"]["items"][0]["external_ids"] =
            json!({"youtube_video": "video-1"});
        assert!(parse_hosted_snapshot(&serde_json::to_vec(&wrong_id).unwrap(), now).is_err());

        let mut alternate_thumbnail =
            serde_json::from_slice::<serde_json::Value>(&snapshot_json(now, "live")).unwrap();
        alternate_thumbnail["sources"][0]["batch"]["items"][0]["artwork_url"] =
            json!("https://i3.ytimg.com/vi/video-1/hqdefault.jpg");
        assert!(
            parse_hosted_snapshot(&serde_json::to_vec(&alternate_thumbnail).unwrap(), now).is_ok()
        );
    }

    #[test]
    fn lastfm_contract_requires_a_valid_provider_linkback() {
        let now = 1_800_000_000;
        let mut item = lastfm_item(now);
        let batch = SourceBatch {
            source: LASTFM_SOURCE.to_string(),
            label: "Last.fm top tracks".to_string(),
            fetched_at: now,
            cadence_secs: LASTFM_CADENCE_SECS,
            items: vec![item.clone()],
        };

        assert!(validate_item(&item, &batch, "lastfm", 100, now).is_ok());
        item.editorial_url = None;
        assert!(validate_item(&item, &batch, "lastfm", 100, now).is_err());
    }

    #[test]
    fn endpoint_is_pinned_to_the_public_mewsik_snapshot() {
        assert!(validate_endpoint(HOSTED_DISCOVERY_SNAPSHOT_URL).is_ok());
        assert!(validate_endpoint("https://attacker.example/snapshot.json").is_err());
    }
}
