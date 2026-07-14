use parking_lot::Mutex;
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

const US_CHART_URL: &str =
    "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json";
const GB_CHART_URL: &str =
    "https://rss.marketingtools.apple.com/api/v2/gb/music/most-played/100/songs.json";
const JP_CHART_URL: &str =
    "https://rss.marketingtools.apple.com/api/v2/jp/music/most-played/100/songs.json";
const BR_CHART_URL: &str =
    "https://rss.marketingtools.apple.com/api/v2/br/music/most-played/100/songs.json";
const LIVE_CACHE_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const FAILURE_CACHE_TTL: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const SECTION_SIZE: usize = 8;

#[derive(Clone, Debug, Serialize)]
pub struct SearchDiscoveryFeed {
    pub generated_at: i64,
    pub source: String,
    pub is_stale: bool,
    pub is_fallback: bool,
    pub sections: Vec<SearchDiscoverySection>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchDiscoverySection {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub items: Vec<SearchDiscoveryItem>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchDiscoveryItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub search_query: String,
    pub listen_count: Option<u64>,
    pub rank: Option<u32>,
    pub momentum: Option<i32>,
    pub context: Option<String>,
}

#[derive(Clone)]
struct CachedFeed {
    stored_at: Instant,
    fresh_for: Duration,
    feed: SearchDiscoveryFeed,
}

pub struct DiscoveryFeedRuntime {
    client: Client,
    cache: Mutex<Option<CachedFeed>>,
    refresh_lock: AsyncMutex<()>,
}

impl Default for DiscoveryFeedRuntime {
    fn default() -> Self {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::limited(3))
            .user_agent("Mewsik/0.1 (Apple Marketing Tools chart discovery)")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            client,
            cache: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
        }
    }
}

impl DiscoveryFeedRuntime {
    pub async fn get_feed(&self) -> SearchDiscoveryFeed {
        if let Some(feed) = self.fresh_cached_feed() {
            return feed;
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        if let Some(feed) = self.fresh_cached_feed() {
            return feed;
        }

        let stale_feed = self.cache.lock().as_ref().map(|cached| cached.feed.clone());
        let (us_result, gb_result, jp_result, br_result) = tokio::join!(
            fetch_chart(&self.client, US_CHART_URL),
            fetch_chart(&self.client, GB_CHART_URL),
            fetch_chart(&self.client, JP_CHART_URL),
            fetch_chart(&self.client, BR_CHART_URL),
        );

        let feed = match us_result {
            Ok(us) if !us.is_empty() => {
                let mut world = Vec::new();
                collect_world_chart(&mut world, gb_result, "United Kingdom");
                collect_world_chart(&mut world, jp_result, "Japan");
                collect_world_chart(&mut world, br_result, "Brazil");
                build_live_feed(us, world)
            }
            Ok(_) => fallback_or_stale(stale_feed, "Apple U.S. chart was empty"),
            Err(error) => fallback_or_stale(
                stale_feed,
                &format!("Apple U.S. chart refresh failed: {error}"),
            ),
        };

        let fresh_for = cache_ttl(&feed);
        self.cache.lock().replace(CachedFeed {
            stored_at: Instant::now(),
            fresh_for,
            feed: feed.clone(),
        });
        feed
    }

    fn fresh_cached_feed(&self) -> Option<SearchDiscoveryFeed> {
        self.cache
            .lock()
            .as_ref()
            .filter(|cached| cached.stored_at.elapsed() < cached.fresh_for)
            .map(|cached| cached.feed.clone())
    }
}

fn cache_ttl(feed: &SearchDiscoveryFeed) -> Duration {
    if feed.is_stale || feed.is_fallback {
        FAILURE_CACHE_TTL
    } else {
        LIVE_CACHE_TTL
    }
}

fn collect_world_chart(
    charts: &mut Vec<(&'static str, Vec<AppleSong>)>,
    result: Result<Vec<AppleSong>, String>,
    country: &'static str,
) {
    match result {
        Ok(songs) if !songs.is_empty() => charts.push((country, songs)),
        Ok(_) => log::warn!("Apple {country} discovery chart was empty"),
        Err(error) => log::warn!("Apple {country} discovery refresh failed: {error}"),
    }
}

fn fallback_or_stale(
    stale_feed: Option<SearchDiscoveryFeed>,
    warning: &str,
) -> SearchDiscoveryFeed {
    log::warn!("{warning}");
    if let Some(mut stale) = stale_feed {
        stale.is_stale = true;
        return stale;
    }
    bundled_fallback_feed()
}

async fn fetch_chart(client: &Client, url: &'static str) -> Result<Vec<AppleSong>, String> {
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("response exceeded the 1 MiB limit".to_string());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("response exceeded the 1 MiB limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    let response: AppleResponse =
        serde_json::from_slice(&body).map_err(|error| format!("invalid JSON: {error}"))?;
    Ok(response.feed.results)
}

#[derive(Clone, Debug, Deserialize)]
struct AppleResponse {
    feed: AppleFeed,
}

#[derive(Clone, Debug, Deserialize)]
struct AppleFeed {
    #[serde(default)]
    results: Vec<AppleSong>,
}

#[derive(Clone, Debug, Deserialize)]
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
    #[serde(default)]
    artwork_url100: Option<String>,
}

#[derive(Clone, Debug)]
struct Candidate {
    key: String,
    artist_key: String,
    item: SearchDiscoveryItem,
}

fn build_live_feed(
    us_songs: Vec<AppleSong>,
    world_charts: Vec<(&'static str, Vec<AppleSong>)>,
) -> SearchDiscoveryFeed {
    let mut used_tracks = HashSet::new();
    let mut used_artists = HashSet::new();
    let us_candidates = apple_candidates(us_songs, "U.S. chart");
    let us = select_unique_artists(
        us_candidates,
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );

    if us.len() < SECTION_SIZE {
        return bundled_fallback_feed();
    }

    let world_candidates = interleaved_world_candidates(&world_charts);
    let mut world = select_unique_artists(
        world_candidates,
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );

    let mut editorial = rotated_bundled_candidates();
    if world.len() < SECTION_SIZE {
        world.extend(select_unique_artists(
            editorial.clone(),
            SECTION_SIZE - world.len(),
            &mut used_tracks,
            &mut used_artists,
        ));
    }
    let rabbit_holes = select_unique_artists(
        std::mem::take(&mut editorial),
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );

    let country_names = world_charts
        .iter()
        .map(|(country, _)| *country)
        .collect::<Vec<_>>();
    let world_is_live = !country_names.is_empty();
    let world_title = if world_is_live {
        "Around the world"
    } else {
        "More reliable starts"
    };
    let world_subtitle = if world_is_live {
        format!(
            "One artist at a time from Apple Music charts in {}",
            human_join(&country_names)
        )
    } else {
        "Mewsik editorial picks while international charts refresh".to_string()
    };
    let source = if world_is_live {
        format!(
            "Apple Music charts (U.S., {}) + Mewsik editorial",
            country_names.join(", ")
        )
    } else {
        "Apple Music U.S. chart + Mewsik editorial".to_string()
    };

    SearchDiscoveryFeed {
        generated_at: unix_timestamp(),
        source,
        is_stale: false,
        is_fallback: false,
        sections: vec![
            SearchDiscoverySection {
                id: "us-top".to_string(),
                title: "Top songs in the U.S.".to_string(),
                subtitle: "Apple Music's public most-played chart, limited to one song per artist"
                    .to_string(),
                items: us,
            },
            SearchDiscoverySection {
                id: "world".to_string(),
                title: world_title.to_string(),
                subtitle: world_subtitle,
                items: world,
            },
            SearchDiscoverySection {
                id: "editorial".to_string(),
                title: "Reliable rabbit holes".to_string(),
                subtitle: "Handpicked by Mewsik; broad on purpose and not personalized".to_string(),
                items: rabbit_holes,
            },
        ],
    }
}

fn apple_candidates(songs: Vec<AppleSong>, context: &str) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    songs
        .into_iter()
        .enumerate()
        .filter_map(|(index, song)| {
            let artist = song.artist_name.trim();
            let title = song.name.trim();
            if artist.is_empty() || title.is_empty() {
                return None;
            }

            let key = canonical_key(artist, title);
            if key.is_empty() || !seen.insert(key.clone()) {
                return None;
            }
            let artist_key = if song
                .artist_id
                .chars()
                .all(|character| character.is_ascii_digit())
                && !song.artist_id.is_empty()
            {
                format!("apple:{}", song.artist_id)
            } else {
                canonical_text(artist)
            };
            let id = if song.id.chars().all(|character| character.is_ascii_digit())
                && !song.id.is_empty()
            {
                format!("apple-{}", song.id)
            } else {
                key.clone()
            };

            Some(Candidate {
                key,
                artist_key,
                item: SearchDiscoveryItem {
                    id,
                    title: title.to_string(),
                    artist: artist.to_string(),
                    album: None,
                    artwork_url: validated_apple_artwork_url(song.artwork_url100.as_deref()),
                    search_query: format!("{artist} {title}"),
                    listen_count: None,
                    rank: Some((index + 1) as u32),
                    momentum: None,
                    context: Some(context.to_string()),
                },
            })
        })
        .collect()
}

fn interleaved_world_candidates(charts: &[(&'static str, Vec<AppleSong>)]) -> Vec<Candidate> {
    let ranked = charts
        .iter()
        .map(|(country, songs)| apple_candidates(songs.clone(), &format!("{country} chart")))
        .collect::<Vec<_>>();
    let max_len = ranked.iter().map(Vec::len).max().unwrap_or_default();
    let mut combined = Vec::new();
    for index in 0..max_len {
        for chart in &ranked {
            if let Some(candidate) = chart.get(index) {
                combined.push(candidate.clone());
            }
        }
    }
    combined
}

fn select_unique_artists(
    candidates: impl IntoIterator<Item = Candidate>,
    limit: usize,
    used_tracks: &mut HashSet<String>,
    used_artists: &mut HashSet<String>,
) -> Vec<SearchDiscoveryItem> {
    let mut selected = Vec::new();
    for candidate in candidates {
        if selected.len() >= limit {
            break;
        }
        if used_tracks.contains(&candidate.key) || used_artists.contains(&candidate.artist_key) {
            continue;
        }
        used_tracks.insert(candidate.key);
        used_artists.insert(candidate.artist_key);
        selected.push(candidate.item);
    }
    selected
}

fn human_join(values: &[&str]) -> String {
    match values {
        [] => String::new(),
        [only] => (*only).to_string(),
        [first, second] => format!("{first} and {second}"),
        _ => format!(
            "{}, and {}",
            values[..values.len() - 1].join(", "),
            values[values.len() - 1]
        ),
    }
}

fn canonical_key(artist: &str, title: &str) -> String {
    format!("{}::{}", canonical_text(artist), canonical_text(title))
}

fn canonical_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_alphanumeric() {
            normalized.extend(character.to_lowercase());
        } else {
            normalized.push(' ');
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn validated_apple_artwork_url(value: Option<&str>) -> Option<String> {
    let mut url = reqwest::Url::parse(value?).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if url.scheme() != "https"
        || !(host == "mzstatic.com" || host.ends_with(".mzstatic.com"))
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }

    let path = url.path().replace("/100x100bb.", "/300x300bb.");
    url.set_path(&path);
    Some(url.to_string())
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn day_bucket() -> u64 {
    unix_timestamp().max(0) as u64 / 86_400
}

fn bundled_fallback_feed() -> SearchDiscoveryFeed {
    let candidates = rotated_bundled_candidates();
    let mut used_tracks = HashSet::new();
    let mut used_artists = HashSet::new();
    let first = select_unique_artists(
        candidates.clone(),
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );
    let second = select_unique_artists(
        candidates.clone(),
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );
    let third = select_unique_artists(
        candidates,
        SECTION_SIZE,
        &mut used_tracks,
        &mut used_artists,
    );

    SearchDiscoveryFeed {
        generated_at: unix_timestamp(),
        source: "Mewsik editorial".to_string(),
        is_stale: false,
        is_fallback: true,
        sections: vec![
            SearchDiscoverySection {
                id: "editorial-starts".to_string(),
                title: "Reliable starts".to_string(),
                subtitle: "Handpicked by Mewsik while live charts refresh".to_string(),
                items: first,
            },
            SearchDiscoverySection {
                id: "editorial-detours".to_string(),
                title: "Worth the detour".to_string(),
                subtitle: "Strong records from different corners of music".to_string(),
                items: second,
            },
            SearchDiscoverySection {
                id: "editorial-rabbit-holes".to_string(),
                title: "Reliable rabbit holes".to_string(),
                subtitle: "Broad on purpose and not personalized".to_string(),
                items: third,
            },
        ],
    }
}

fn rotated_bundled_candidates() -> Vec<Candidate> {
    let mut candidates = bundled_candidates();
    if !candidates.is_empty() {
        let rotation = (day_bucket() as usize * SECTION_SIZE) % candidates.len();
        candidates.rotate_left(rotation);
    }
    candidates
}

fn bundled_candidates() -> Vec<Candidate> {
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
        (
            "Caroline Polachek",
            "Bunny Is a Rider",
            "Desire, I Want to Turn Into You",
        ),
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
        ("Four Tet", "Two Thousand and Seventeen", "New Energy"),
        ("Erykah Badu", "Didn't Cha Know", "Mama's Gun"),
        (
            "Boards of Canada",
            "Roygbiv",
            "Music Has the Right to Children",
        ),
        ("Little Simz", "Introvert", "Sometimes I Might Be Introvert"),
        ("Ryuichi Sakamoto", "andata", "async"),
        ("Khruangbin", "Friday Morning", "Con Todo el Mundo"),
    ];

    PICKS
        .iter()
        .enumerate()
        .map(|(index, (artist, title, album))| {
            let key = canonical_key(artist, title);
            Candidate {
                key: key.clone(),
                artist_key: canonical_text(artist),
                item: SearchDiscoveryItem {
                    id: format!("bundled-{index}"),
                    title: (*title).to_string(),
                    artist: (*artist).to_string(),
                    album: Some((*album).to_string()),
                    artwork_url: None,
                    search_query: format!("{artist} {title}"),
                    listen_count: None,
                    rank: None,
                    momentum: None,
                    context: Some("Mewsik editorial".to_string()),
                },
            }
        })
        .collect()
}

pub type SharedDiscoveryFeedRuntime = Arc<DiscoveryFeedRuntime>;

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: usize, artist_id: usize, artist: &str, title: &str) -> AppleSong {
        AppleSong {
            id: id.to_string(),
            name: title.to_string(),
            artist_name: artist.to_string(),
            artist_id: artist_id.to_string(),
            artwork_url100: Some(
                "https://is1-ssl.mzstatic.com/image/thumb/Music221/example/100x100bb.jpg"
                    .to_string(),
            ),
        }
    }

    fn chart(prefix: &str, start: usize) -> Vec<AppleSong> {
        (0..30)
            .map(|index| {
                song(
                    start + index,
                    start + index,
                    &format!("{prefix} Artist {index}"),
                    &format!("{prefix} Track {index}"),
                )
            })
            .collect()
    }

    #[test]
    fn parses_apple_payload_and_upgrades_validated_artwork() {
        let response: AppleResponse = serde_json::from_str(
            r#"{
                "feed": {
                    "results": [{
                        "artistName": "Ella Langley",
                        "artistId": "1384373733",
                        "id": "1844932150",
                        "name": "Choosin' Texas",
                        "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music221/example/100x100bb.jpg"
                    }]
                }
            }"#,
        )
        .expect("fixture should parse");

        let candidates = apple_candidates(response.feed.results, "U.S. chart");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].item.artist, "Ella Langley");
        assert_eq!(
            candidates[0].item.artwork_url.as_deref(),
            Some("https://is1-ssl.mzstatic.com/image/thumb/Music221/example/300x300bb.jpg")
        );
    }

    #[test]
    fn rejects_untrusted_artwork_hosts_and_credentials() {
        assert!(
            validated_apple_artwork_url(Some("https://mzstatic.com.evil.test/a.jpg")).is_none()
        );
        assert!(validated_apple_artwork_url(Some("http://is1-ssl.mzstatic.com/a.jpg")).is_none());
        assert!(
            validated_apple_artwork_url(Some("https://user@is1-ssl.mzstatic.com/a.jpg")).is_none()
        );
    }

    #[test]
    fn live_sections_never_repeat_an_artist_or_track() {
        let feed = build_live_feed(
            chart("US", 1),
            vec![
                ("United Kingdom", chart("UK", 100)),
                ("Japan", chart("JP", 200)),
                ("Brazil", chart("BR", 300)),
            ],
        );

        assert_eq!(feed.sections.len(), 3);
        assert!(feed
            .sections
            .iter()
            .all(|section| section.items.len() == SECTION_SIZE));
        let artists = feed
            .sections
            .iter()
            .flat_map(|section| {
                section
                    .items
                    .iter()
                    .map(|item| canonical_text(&item.artist))
            })
            .collect::<Vec<_>>();
        let tracks = feed
            .sections
            .iter()
            .flat_map(|section| {
                section
                    .items
                    .iter()
                    .map(|item| canonical_key(&item.artist, &item.title))
            })
            .collect::<Vec<_>>();
        assert_eq!(artists.len(), artists.iter().collect::<HashSet<_>>().len());
        assert_eq!(tracks.len(), tracks.iter().collect::<HashSet<_>>().len());
        assert!(feed.sections[1]
            .items
            .iter()
            .any(|item| item.context.as_deref() == Some("Japan chart")));
    }

    #[test]
    fn apple_artist_id_collapses_collaboration_variants() {
        let candidates = apple_candidates(
            vec![
                song(1, 50, "Artist", "First"),
                song(2, 50, "Artist & Guest", "Second"),
                song(3, 60, "Someone Else", "Third"),
            ],
            "U.S. chart",
        );
        let mut tracks = HashSet::new();
        let mut artists = HashSet::new();
        let selected = select_unique_artists(candidates, 8, &mut tracks, &mut artists);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].title, "First");
        assert_eq!(selected[1].title, "Third");
    }

    #[test]
    fn bundled_feed_is_honest_and_useful_offline() {
        let feed = bundled_fallback_feed();
        assert!(feed.is_fallback);
        assert_eq!(feed.source, "Mewsik editorial");
        assert_eq!(feed.sections.len(), 3);
        assert!(feed
            .sections
            .iter()
            .all(|section| section.items.len() == SECTION_SIZE));
        assert!(feed
            .sections
            .iter()
            .all(|section| !section.title.to_lowercase().contains("trending")));
    }

    #[test]
    fn fallback_and_stale_feeds_retry_quickly() {
        let fallback = bundled_fallback_feed();
        assert_eq!(cache_ttl(&fallback), FAILURE_CACHE_TTL);

        let mut stale = build_live_feed(chart("US", 1), vec![]);
        stale.is_stale = true;
        assert_eq!(cache_ttl(&stale), FAILURE_CACHE_TTL);
    }

    #[test]
    fn only_live_feeds_receive_the_long_cache_ttl() {
        let live = build_live_feed(chart("US", 1), vec![("United Kingdom", chart("UK", 100))]);
        assert!(!live.is_fallback);
        assert!(!live.is_stale);
        assert_eq!(cache_ttl(&live), LIVE_CACHE_TTL);
    }

    #[test]
    fn expired_failure_cache_does_not_block_a_retry() {
        let runtime = DiscoveryFeedRuntime::default();
        runtime.cache.lock().replace(CachedFeed {
            stored_at: Instant::now()
                .checked_sub(FAILURE_CACHE_TTL + Duration::from_secs(1))
                .expect("test instant should support subtraction"),
            fresh_for: FAILURE_CACHE_TTL,
            feed: bundled_fallback_feed(),
        });

        assert!(runtime.fresh_cached_feed().is_none());
    }
}
