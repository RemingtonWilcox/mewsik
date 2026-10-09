//! Station discovery: a live, cached, rotating, history-aware feed built from
//! radio-browser.info. A static catalog of *scenes* (genre families and
//! moods) is refreshed into `scene_stations` once a day, ranked with the
//! user's radio history as a demoting signal, and dealt into shelves with a
//! daily deterministic shuffle. See docs/station-discovery-contract-2026-10-07.md.

use crate::db::queries::{self, SceneRefreshRow, SceneStationRow, StationPlayRow};
use crate::db::DbPool;
use crate::stations::directory::{radio_browser_get, RadioBrowserStation};
use crate::stations::health::verify_station_urls_inner;
use crate::stations::network::MAX_STATION_URL_BYTES;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::Instant;
use tokio::sync::Mutex;

const SCENE_STALE_AFTER_SECS: i64 = 24 * 60 * 60;
const STATIONS_PER_TAG_TERM: usize = 60;
const SHELF_CANDIDATES: usize = 24;
const SHELF_SIZE: usize = 8;
const FRESH_CANDIDATES: usize = 120;
const FRESH_SIZE: usize = 12;
const FOR_YOU_SIZE: usize = 12;
const FOR_YOU_TOP_PLAYED: usize = 6;
const FOR_YOU_MIN_PLAYS: usize = 3;
const FOR_YOU_AFFINITY_SCENES: usize = 3;
const HISTORY_WINDOW_DAYS: i64 = 90;
const FRESH_UNPLAYED_DAYS: i64 = 14;
const RECENCY_DAYS: i64 = 3;
const BAIL_THRESHOLD_MS: i64 = 20_000;
const BAIL_END_REASONS: [&str; 4] = [
    "stopped",
    "source_changed",
    "skipped_next",
    "skipped_previous",
];
const DEFAULT_SCENE_PAGE: usize = 40;
const MAX_SCENE_PAGE: usize = 100;
const DAILY_SWEEP_BATCH: usize = 40;
const DAILY_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// Let the launch refresh land before the first sweep probes the cache.
const DAILY_SWEEP_INITIAL_DELAY: std::time::Duration = std::time::Duration::from_secs(90);
const STARTUP_REFRESH_DELAY: std::time::Duration = std::time::Duration::from_secs(8);
const SWEEP_DELETE_AT_FAIL_COUNT: i32 = 3;
const SHELF_EXCLUDE_AT_FAIL_COUNT: i32 = 2;
/// A pick is "verified" when its last probe succeeded within this window.
/// Only verified picks may lead a shelf or become the hero.
const VERIFIED_WITHIN_DAYS: i64 = 7;
/// Shelf candidates whose last check is older than this are re-probed by
/// the verification pass (so verified picks stay verified).
const RECHECK_AFTER_HOURS: i64 = 72;
/// Upper bound on probes per verification pass (refresh or launch).
const MAX_SHELF_PROBES_PER_PASS: usize = 320;
/// How deep into each top-affinity scene the for-you shelf may reach.
const FOR_YOU_CANDIDATES_PER_SCENE: usize = 36;
/// Stations whose tag focus falls below this are dropped from the scene.
pub const FOCUS_EXCLUDE_BELOW: f64 = 0.3;
/// Extra subtractive penalty per unit of missing focus, on top of scaling
/// quality by focus, so an unfocused but popular station sinks.
const FOCUS_PENALTY_WEIGHT: f64 = 2.0;

/// True while a refresh is doing network work (set under `REFRESH_LOCK`).
static REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// True from the moment a background refresh is spawned until it finishes,
/// so repeated feed reads on an empty cache spawn exactly one refresh.
static BACKGROUND_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);
/// Serializes refreshes so the launch refresh and a user-triggered one never
/// upsert and prune the same scene concurrently.
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

// ── Scene catalog ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneFamily {
    Workout,
    Hiphop,
    Rock,
    Electronic,
    Chill,
    Soul,
    World,
    Pop,
    Classic,
}

#[derive(Debug)]
pub struct SceneDef {
    pub id: &'static str,
    pub title: &'static str,
    pub eyebrow: &'static str,
    pub description: &'static str,
    pub family: SceneFamily,
    pub accent: &'static str,
    /// radio-browser tag terms, queried one at a time (exact tag match).
    pub tags: &'static [&'static str],
    pub min_bitrate: i32,
    /// A station carrying any of these tags is dropped from the scene.
    pub exclude_tags: &'static [&'static str],
}

const DEFAULT_MIN_BITRATE: i32 = 64;

pub static SCENES: &[SceneDef] = &[
    SceneDef {
        id: "workout",
        title: "Workout",
        eyebrow: "Gym & cardio",
        description: "High-energy streams that keep the pace up from warm-up to cool-down.",
        family: SceneFamily::Workout,
        accent: "from-orange-500/30 to-transparent",
        tags: &["workout", "fitness", "high energy"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "hip-hop",
        title: "Hip-hop",
        eyebrow: "Rap & beats",
        description: "Rap radio from classic heads to the current charts.",
        family: SceneFamily::Hiphop,
        accent: "from-amber-500/30 to-transparent",
        tags: &["hip hop", "hiphop", "hip-hop", "rap"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &["lofi", "lo-fi"],
    },
    SceneDef {
        id: "trap",
        title: "Trap",
        eyebrow: "808s & hi-hats",
        description: "Heavy low end and rolling hi-hats, Atlanta to everywhere.",
        family: SceneFamily::Hiphop,
        accent: "from-fuchsia-500/30 to-transparent",
        tags: &["trap", "phonk"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "boom-bap",
        title: "Boom bap",
        eyebrow: "Golden era",
        description:
            "Dusty drums and sampled loops from the nineties and the heads who kept it alive.",
        family: SceneFamily::Hiphop,
        accent: "from-yellow-600/30 to-transparent",
        // "boom bap", "90s hip hop" and "golden era" each tag one station or
        // none on radio-browser; these are the tags golden-era stations use.
        tags: &[
            "old school hip hop",
            "classic hip hop",
            "gangsta rap",
            "old school",
        ],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "lofi-hip-hop",
        title: "Lo-fi hip-hop",
        eyebrow: "Beats to relax to",
        description: "Mellow instrumental beats for the background.",
        family: SceneFamily::Chill,
        accent: "from-violet-400/30 to-transparent",
        tags: &["lofi", "lo-fi", "lofi hip hop", "chillhop"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "uk-rap-drill",
        title: "UK grime & garage",
        eyebrow: "London and beyond",
        description: "Grime, UK garage and the London sound straight from the source.",
        family: SceneFamily::Hiphop,
        accent: "from-slate-400/30 to-transparent",
        // "drill", "uk rap" and "uk drill" return fewer than five playable
        // stations; grime and UK garage are where those stations live.
        tags: &["grime", "uk garage"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "rnb-soul",
        title: "R&B & soul",
        eyebrow: "Smooth & heartfelt",
        description: "Contemporary R&B, neo-soul and the classics they grew from.",
        family: SceneFamily::Soul,
        accent: "from-rose-400/30 to-transparent",
        tags: &["rnb", "r&b", "soul", "neo soul"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "punk",
        title: "Punk",
        eyebrow: "Three chords",
        description: "Fast, loud and unbothered, from the first wave to post-punk.",
        family: SceneFamily::Rock,
        accent: "from-pink-600/30 to-transparent",
        tags: &["punk", "punk rock", "post-punk"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "metal",
        title: "Metal",
        eyebrow: "Heavy",
        description: "Heavy, death, black and everything downtuned in between.",
        family: SceneFamily::Rock,
        accent: "from-zinc-500/40 to-transparent",
        tags: &["metal", "heavy metal", "death metal", "black metal"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "hardcore",
        title: "Hardcore",
        eyebrow: "Breakdowns",
        description: "Hardcore punk, metalcore and post-hardcore with no filler.",
        family: SceneFamily::Rock,
        accent: "from-red-700/30 to-transparent",
        tags: &["hardcore", "metalcore", "post-hardcore", "deathcore"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &["hardcore techno", "hardstyle", "gabber", "happy hardcore"],
    },
    SceneDef {
        id: "classic-rock",
        title: "Classic rock",
        eyebrow: "Arena anthems",
        description: "The seventies and eighties rock canon, played loud.",
        family: SceneFamily::Rock,
        accent: "from-amber-700/30 to-transparent",
        tags: &["classic rock", "rock classics", "70s rock", "80s rock"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "indie-alt",
        title: "Indie & alternative",
        eyebrow: "Left of the dial",
        description: "Indie rock and alternative from college radio to today.",
        family: SceneFamily::Rock,
        accent: "from-teal-500/30 to-transparent",
        tags: &["indie", "alternative", "indie rock", "alternative rock"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "house",
        title: "House",
        eyebrow: "Four on the floor",
        description: "Deep, tech and soulful house from the club to the kitchen.",
        family: SceneFamily::Electronic,
        accent: "from-sky-500/30 to-transparent",
        tags: &["house", "deep house", "tech house", "soulful house"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "techno",
        title: "Techno",
        eyebrow: "Dark rooms",
        description: "Minimal, hard and warehouse techno, relentless by design.",
        family: SceneFamily::Electronic,
        accent: "from-indigo-600/30 to-transparent",
        tags: &["techno", "minimal techno", "hard techno"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "drum-and-bass",
        title: "Drum & bass",
        eyebrow: "174 BPM",
        description: "Liquid, jungle and rollers at full speed.",
        family: SceneFamily::Electronic,
        accent: "from-lime-500/30 to-transparent",
        tags: &["drum and bass", "dnb", "liquid dnb", "jungle"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "trance",
        title: "Trance",
        eyebrow: "Hands up",
        description: "Uplifting, progressive and psy trance, built for the build-up.",
        family: SceneFamily::Electronic,
        accent: "from-cyan-400/30 to-transparent",
        tags: &[
            "trance",
            "uplifting trance",
            "progressive trance",
            "psytrance",
        ],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "ambient",
        title: "Ambient",
        eyebrow: "Slow air",
        description: "Drones, textures and space music that fill a room without asking for it.",
        family: SceneFamily::Chill,
        accent: "from-slate-500/30 to-transparent",
        tags: &["ambient", "dark ambient", "drone", "space music"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "synthwave",
        title: "Synthwave",
        eyebrow: "Neon nights",
        description: "Retrowave, chillwave and vaporwave: the eighties that never happened.",
        family: SceneFamily::Electronic,
        accent: "from-purple-500/30 to-transparent",
        tags: &["synthwave", "retrowave", "chillwave", "vaporwave"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "jazz",
        title: "Jazz",
        eyebrow: "Late sets",
        description: "Bebop to smooth jazz and fusion, from the standards to the fringe.",
        family: SceneFamily::Classic,
        accent: "from-amber-400/30 to-transparent",
        tags: &["jazz", "smooth jazz", "bebop", "jazz fusion"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "funk",
        title: "Funk",
        eyebrow: "On the one",
        description: "Funk, disco and groove records that move the room.",
        family: SceneFamily::Soul,
        accent: "from-orange-400/30 to-transparent",
        tags: &["funk", "boogie", "disco", "groove"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "reggae-dub",
        title: "Reggae & dub",
        eyebrow: "Roots & bass",
        description: "Roots reggae, dub and dancehall with the bass turned up.",
        family: SceneFamily::World,
        accent: "from-green-500/30 to-transparent",
        tags: &["reggae", "dub", "dancehall", "roots reggae"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "latin",
        title: "Latin",
        eyebrow: "Ritmo",
        description: "Reggaeton, salsa, bachata and Latin pop from across the Americas.",
        family: SceneFamily::World,
        accent: "from-red-500/30 to-transparent",
        tags: &["latin", "reggaeton", "salsa", "bachata"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "afrobeats",
        title: "Afrobeats",
        eyebrow: "Lagos to London",
        description: "Afrobeats, highlife and amapiano, the sound of the moment.",
        family: SceneFamily::World,
        accent: "from-yellow-500/30 to-transparent",
        tags: &["afrobeats", "afrobeat", "highlife", "amapiano"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "country",
        title: "Country",
        eyebrow: "Back roads",
        description: "Country, americana and bluegrass from Nashville outward.",
        family: SceneFamily::Pop,
        accent: "from-amber-600/30 to-transparent",
        tags: &["country", "country music", "bluegrass", "americana"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "classical",
        title: "Classical",
        eyebrow: "Concert hall",
        description: "Orchestral, chamber, baroque and opera in proper fidelity.",
        family: SceneFamily::Classic,
        accent: "from-stone-400/30 to-transparent",
        tags: &["classical", "classical music", "baroque", "opera"],
        min_bitrate: 96,
        exclude_tags: &[],
    },
    SceneDef {
        id: "pop-hits",
        title: "Pop hits",
        eyebrow: "Right now",
        description: "The current charts and the hits that will not leave your head.",
        family: SceneFamily::Pop,
        accent: "from-pink-400/30 to-transparent",
        tags: &["pop", "top 40", "hits", "pop music"],
        min_bitrate: 96,
        exclude_tags: &[],
    },
    SceneDef {
        id: "80s-90s",
        title: "80s & 90s",
        eyebrow: "Throwback",
        description: "Two decades of hits, one-hit wonders and the songs between them.",
        family: SceneFamily::Pop,
        accent: "from-fuchsia-400/30 to-transparent",
        // "80s hits" / "90s hits" are nearly unused; the German decade tags
        // carry most of the catalogue.
        tags: &["80s", "90s", "80er", "90er"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "chill-study",
        title: "Chill & study",
        eyebrow: "Focus",
        description: "Low-key streams that stay out of the way while you work.",
        family: SceneFamily::Chill,
        accent: "from-emerald-400/30 to-transparent",
        tags: &["study", "chillout", "chill", "focus"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
    SceneDef {
        id: "oldies",
        title: "Oldies",
        eyebrow: "Jukebox",
        description: "Fifties and sixties rock and roll, doo-wop and golden oldies.",
        family: SceneFamily::Classic,
        accent: "from-yellow-700/30 to-transparent",
        tags: &["oldies", "50s", "60s", "golden oldies"],
        min_bitrate: DEFAULT_MIN_BITRATE,
        exclude_tags: &[],
    },
];

/// Scenes defined by an activity, mood or era rather than a genre. Their
/// stations legitimately span genres, so genre spread costs them half as
/// much and they have no genre-relevance requirement.
const BROAD_SCENES: [&str; 5] = ["workout", "pop-hits", "80s-90s", "chill-study", "oldies"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneInfo {
    pub id: String,
    pub title: String,
    pub eyebrow: String,
    pub description: String,
    pub family: SceneFamily,
    pub accent: String,
}

impl From<&SceneDef> for SceneInfo {
    fn from(scene: &SceneDef) -> Self {
        SceneInfo {
            id: scene.id.to_string(),
            title: scene.title.to_string(),
            eyebrow: scene.eyebrow.to_string(),
            description: scene.description.to_string(),
            family: scene.family,
            accent: scene.accent.to_string(),
        }
    }
}

pub fn scene_catalog() -> Vec<SceneInfo> {
    SCENES.iter().map(SceneInfo::from).collect()
}

pub fn find_scene(scene_id: &str) -> Option<&'static SceneDef> {
    SCENES.iter().find(|scene| scene.id == scene_id)
}

// ── Feed shapes ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationPick {
    pub station: RadioBrowserStation,
    pub scene_id: Option<String>,
    pub reason: String,
    pub score: f64,
    pub bail_rate: f64,
    pub plays: u32,
    /// Last local probe succeeded within 7 days and the station has no
    /// failures since. Only verified picks lead shelves or become the hero.
    pub verified: bool,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShelfKind {
    ForYou,
    Fresh,
    Scene,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationShelf {
    pub id: String,
    pub kind: ShelfKind,
    pub title: String,
    pub subtitle: String,
    pub scene_id: Option<String>,
    pub items: Vec<StationPick>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedStatus {
    Ready,
    Empty,
    Refreshing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationDiscoveryFeed {
    pub generated_at: String,
    pub status: FeedStatus,
    pub cache_age_seconds: Option<i64>,
    pub shelves: Vec<StationShelf>,
    pub scenes: Vec<SceneInfo>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneRefreshSummary {
    pub scenes: usize,
    pub stations: usize,
    pub pruned: usize,
    pub took_ms: u64,
}

// ── Helpers ──

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn split_tags(tags: Option<&str>) -> Vec<String> {
    tags.unwrap_or_default()
        .split(',')
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn tags_intersect(station_tags: &[String], terms: &[&str]) -> bool {
    station_tags
        .iter()
        .any(|tag| terms.iter().any(|term| term.eq_ignore_ascii_case(tag)))
}

// ── Tag focus ──
//
// radio-browser tags are free text, and some stations list every genre they
// have ever played so they surface for every tag search. Tag focus measures
// how much a station is *about* a scene: how many distinct genre families its
// tags span, how long its tag list is, and whether the scene's own terms lead
// its tag list or appear in its name.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum GenreFamily {
    HipHop,
    Rock,
    Electronic,
    Jazz,
    Classical,
    Country,
    Soul,
    Reggae,
    Latin,
    Pop,
    Chill,
    Blues,
    Folk,
    World,
    Spoken,
}

/// Keywords per family, matched as whole words against normalised tags
/// (lowercase, `&` → "and", punctuation → spaces).
const GENRE_LEXICON: &[(GenreFamily, &[&str])] = &[
    (
        GenreFamily::HipHop,
        &[
            "hip hop",
            "hiphop",
            "rap",
            "trap",
            "drill",
            "grime",
            "boom bap",
            "gangsta",
            "deutschrap",
            "phonk",
        ],
    ),
    (
        GenreFamily::Rock,
        &[
            "rock",
            "metal",
            "punk",
            "indie",
            "alternative",
            "grunge",
            "hardcore",
            "metalcore",
            "deathcore",
            "emo",
            "post hardcore",
        ],
    ),
    (
        GenreFamily::Electronic,
        &[
            "techno",
            "house",
            "trance",
            "psytrance",
            "edm",
            "electronic",
            "electronica",
            "electro",
            "dance",
            "dubstep",
            "drum and bass",
            "drum n bass",
            "dnb",
            "jungle",
            "breakbeat",
            "breaks",
            "hardstyle",
            "garage",
            "synthwave",
            "retrowave",
            "idm",
            "eurodance",
        ],
    ),
    (GenreFamily::Jazz, &["jazz", "bebop", "swing", "big band"]),
    (
        GenreFamily::Classical,
        &[
            "classical",
            "baroque",
            "opera",
            "orchestral",
            "symphony",
            "symphonic",
            "chamber",
        ],
    ),
    (GenreFamily::Country, &["country", "bluegrass", "americana"]),
    (
        GenreFamily::Soul,
        &[
            "soul", "rnb", "r and b", "r n b", "funk", "motown", "disco", "boogie",
        ],
    ),
    (GenreFamily::Reggae, &["reggae", "dub", "dancehall", "ska"]),
    (
        GenreFamily::Latin,
        &[
            "latin",
            "latino",
            "reggaeton",
            "salsa",
            "bachata",
            "cumbia",
            "merengue",
            "tango",
            "bossa nova",
            "samba",
        ],
    ),
    (GenreFamily::Pop, &["pop", "top 40", "hits", "charts"]),
    (
        GenreFamily::Chill,
        &[
            "ambient",
            "chillout",
            "chill",
            "lounge",
            "lofi",
            "lo fi",
            "downtempo",
            "chillhop",
        ],
    ),
    (GenreFamily::Blues, &["blues"]),
    (GenreFamily::Folk, &["folk"]),
    (
        GenreFamily::World,
        &[
            "afrobeat",
            "afrobeats",
            "amapiano",
            "highlife",
            "world music",
        ],
    ),
    (GenreFamily::Spoken, &["news", "talk", "sports", "sport"]),
];

/// Lowercase, `&` → " and ", every non-alphanumeric run → one space, padded
/// with spaces so whole-word phrases can be found with `contains`.
fn normalize_words(value: &str) -> String {
    let lowered = value.to_lowercase().replace('&', " and ");
    let mut out = String::with_capacity(lowered.len() + 2);
    out.push(' ');
    let mut last_space = true;
    for ch in lowered.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    if !last_space {
        out.push(' ');
    }
    out
}

fn contains_phrase(normalized_haystack: &str, phrase: &str) -> bool {
    let needle = normalize_words(phrase);
    !needle.trim().is_empty() && normalized_haystack.contains(needle.as_str())
}

/// `GENRE_LEXICON` with every keyword pre-normalised (ranking runs this over
/// every cached row on each feed build).
static NORMALIZED_LEXICON: LazyLock<Vec<(GenreFamily, Vec<String>)>> = LazyLock::new(|| {
    GENRE_LEXICON
        .iter()
        .map(|(family, keywords)| {
            (
                *family,
                keywords
                    .iter()
                    .map(|keyword| normalize_words(keyword))
                    .collect(),
            )
        })
        .collect()
});

fn families_of(normalized: &str) -> HashSet<GenreFamily> {
    NORMALIZED_LEXICON
        .iter()
        .filter(|(_, keywords)| {
            keywords
                .iter()
                .any(|keyword| normalized.contains(keyword.as_str()))
        })
        .map(|(family, _)| *family)
        .collect()
}

fn is_broad_scene(scene: &SceneDef) -> bool {
    BROAD_SCENES.contains(&scene.id)
}

/// True when any of `terms` names a music genre family (news, talk and
/// sport are not genres). Terms that do not are scored as broad.
pub fn terms_name_a_genre<S: AsRef<str>>(terms: &[S]) -> bool {
    terms.iter().any(|term| {
        families_of(&normalize_words(term.as_ref()))
            .iter()
            .any(|family| *family != GenreFamily::Spoken)
    })
}

/// How focused a station's tags are on one scene, 0..1 (1 = fully focused).
#[derive(Debug, Clone, PartialEq)]
pub struct TagFocus {
    pub tag_count: usize,
    /// Distinct genre families the station's tags span.
    pub families: usize,
    /// A scene term is among the first three tags or in the station name.
    pub prominent: bool,
    /// The station carries at least one tag (or name word) from the scene's
    /// own genre families. Always true for broad scenes.
    pub relevant: bool,
    pub score: f64,
}

/// Penalty for spanning `families` distinct genre families.
fn family_spread_penalty(families: usize) -> f64 {
    match families {
        0..=2 => 0.0,
        3 => 0.15,
        4 => 0.45,
        5 => 0.65,
        _ => 0.85,
    }
}

/// Penalty for a long tag list: nothing up to 8 tags, then 0.025 per tag,
/// capped at 0.4 (24+ tags).
fn tag_length_penalty(tag_count: usize) -> f64 {
    (tag_count.saturating_sub(8) as f64 * 0.025).min(0.4)
}

pub fn tag_focus(scene: &SceneDef, name: &str, tags: Option<&str>) -> TagFocus {
    tag_focus_for_terms(scene.tags, is_broad_scene(scene), name, tags)
}

/// Tag focus against an arbitrary set of genre terms (a scene's tags or a
/// Directory genre chip's tags). `broad` halves the genre-spread penalty and
/// drops the relevance requirement.
pub fn tag_focus_for_terms<S: AsRef<str>>(
    terms: &[S],
    broad: bool,
    name: &str,
    tags: Option<&str>,
) -> TagFocus {
    let station_tags = split_tags(tags);
    let normalized_tags: Vec<String> = station_tags.iter().map(|t| normalize_words(t)).collect();
    let normalized_name = normalize_words(name);

    let mut families: HashSet<GenreFamily> = HashSet::new();
    for tag in &normalized_tags {
        families.extend(families_of(tag));
    }

    let scene_families: HashSet<GenreFamily> = terms
        .iter()
        .flat_map(|term| families_of(&normalize_words(term.as_ref())))
        .collect();

    let is_scene_term = |normalized: &str| {
        terms
            .iter()
            .any(|term| contains_phrase(normalized, term.as_ref()))
    };
    let prominent = normalized_tags.iter().take(3).any(|tag| is_scene_term(tag))
        || is_scene_term(&normalized_name);

    let relevant = broad
        || scene_families.is_empty()
        || families
            .iter()
            .any(|family| scene_families.contains(family))
        || !families_of(&normalized_name).is_disjoint(&scene_families);

    if !relevant {
        return TagFocus {
            tag_count: station_tags.len(),
            families: families.len(),
            prominent,
            relevant,
            score: 0.0,
        };
    }

    let mut spread = family_spread_penalty(families.len());
    if broad {
        spread *= 0.5;
    }
    let length = tag_length_penalty(station_tags.len());
    let prominence = if prominent || station_tags.len() <= 3 {
        1.0
    } else {
        0.8
    };
    TagFocus {
        tag_count: station_tags.len(),
        families: families.len(),
        prominent,
        relevant,
        score: ((1.0 - spread) * (1.0 - length) * prominence).clamp(0.0, 1.0),
    }
}

fn row_focus(row: &SceneStationRow) -> f64 {
    find_scene(&row.scene_id)
        .map(|scene| tag_focus(scene, &row.name, row.tags.as_deref()).score)
        .unwrap_or(1.0)
}

/// The URL a pick should play: the resolved direct stream when the
/// directory knows it, otherwise the station's advertised URL.
fn playable_url(row: &SceneStationRow) -> &str {
    row.url_resolved
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(row.url.as_str())
}

fn row_to_station(row: &SceneStationRow) -> RadioBrowserStation {
    RadioBrowserStation {
        name: row.name.clone(),
        url: playable_url(row).to_string(),
        url_resolved: None,
        hls: Some(0),
        homepage: row.homepage.clone(),
        // Directory favicons are untrusted remote images and are never handed
        // to the WebView, matching the directory search commands.
        favicon: None,
        country: row.country.clone(),
        countrycode: row.countrycode.clone(),
        language: row.language.clone(),
        tags: row.tags.clone(),
        codec: row.codec.clone(),
        bitrate: row.bitrate,
        votes: Some(row.votes),
        clickcount: Some(row.clickcount),
        clicktrend: Some(row.clicktrend),
        lastcheckok: None,
        lastchecktime_iso8601: None,
        lastcheckoktime_iso8601: None,
        ssl_error: None,
        stationuuid: row.station_uuid.clone(),
    }
}

fn saved_station_to_station(
    station: &crate::db::models::Station,
    uuid: &str,
) -> RadioBrowserStation {
    RadioBrowserStation {
        name: station.name.clone(),
        url: station.url.clone(),
        url_resolved: None,
        hls: Some(0),
        homepage: station.homepage.clone(),
        favicon: None,
        country: station.country.clone(),
        countrycode: None,
        language: station.language.clone(),
        tags: station.tags.clone(),
        codec: station.codec.clone(),
        bitrate: station.bitrate,
        votes: None,
        clickcount: None,
        clicktrend: None,
        lastcheckok: None,
        lastchecktime_iso8601: None,
        lastcheckoktime_iso8601: None,
        ssl_error: None,
        stationuuid: uuid.to_string(),
    }
}

// ── Refresh ──

/// Scenes whose cache is missing or older than 24 h, in catalog order.
pub fn stale_scenes(
    refresh_rows: &[SceneRefreshRow],
    now: DateTime<Utc>,
) -> Vec<&'static SceneDef> {
    let refreshed_at: HashMap<&str, Option<DateTime<Utc>>> = refresh_rows
        .iter()
        .map(|row| (row.scene_id.as_str(), parse_timestamp(&row.refreshed_at)))
        .collect();
    SCENES
        .iter()
        .filter(|scene| match refreshed_at.get(scene.id) {
            Some(Some(at)) => {
                now.signed_duration_since(*at).num_seconds() >= SCENE_STALE_AFTER_SECS
            }
            _ => true,
        })
        .collect()
}

/// Turn one scene's raw directory responses into cache rows: drop HLS, drop
/// streams below the scene's bitrate floor, drop excluded tags, dedupe by
/// uuid (first occurrence wins, which is the highest-voted one).
pub fn prepare_scene_rows(
    scene: &SceneDef,
    stations: Vec<RadioBrowserStation>,
    fetched_at: &str,
) -> Vec<SceneStationRow> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for station in stations {
        if station.hls.unwrap_or(0) != 0 {
            continue;
        }
        if station.bitrate.unwrap_or(0) < scene.min_bitrate {
            continue;
        }
        if !scene.exclude_tags.is_empty()
            && tags_intersect(&split_tags(station.tags.as_deref()), scene.exclude_tags)
        {
            continue;
        }
        // "Every genre" tag spam: never cache it for this scene.
        if tag_focus(scene, &station.name, station.tags.as_deref()).score < FOCUS_EXCLUDE_BELOW {
            continue;
        }
        let uuid = station.stationuuid.trim().to_ascii_lowercase();
        let url = station.url.trim().to_string();
        if uuid.is_empty() || url.is_empty() || !seen.insert(uuid.clone()) {
            continue;
        }
        let url_resolved = station
            .url_resolved
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        rows.push(SceneStationRow {
            scene_id: scene.id.to_string(),
            station_uuid: uuid,
            name: station.name.trim().to_string(),
            url,
            url_resolved,
            homepage: station.homepage,
            favicon: station.favicon,
            country: station.country,
            countrycode: station.countrycode,
            language: station.language,
            tags: station.tags,
            codec: station.codec,
            bitrate: station.bitrate,
            votes: station.votes.unwrap_or(0),
            clickcount: station.clickcount.unwrap_or(0),
            clicktrend: station.clicktrend.unwrap_or(0),
            fetched_at: fetched_at.to_string(),
            fail_count: 0,
            last_checked_at: None,
        });
    }
    rows
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        REFRESH_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

pub fn is_refresh_in_flight() -> bool {
    REFRESH_IN_FLIGHT.load(Ordering::SeqCst) || BACKGROUND_REFRESH_PENDING.load(Ordering::SeqCst)
}

async fn fetch_scene_candidates(scene: &SceneDef) -> Option<Vec<RadioBrowserStation>> {
    let mut collected = Vec::new();
    let mut any_response = false;
    for term in scene.tags {
        let path = format!(
            "/json/stations/bytagexact/{}?limit={}&order=votes&reverse=true&hidebroken=true",
            urlencoding::encode(term),
            STATIONS_PER_TAG_TERM
        );
        let Some(response) = radio_browser_get(&path).await else {
            continue;
        };
        match response.json::<Vec<RadioBrowserStation>>().await {
            Ok(stations) => {
                any_response = true;
                collected.extend(stations);
            }
            Err(err) => log::warn!(
                "Scene '{}' tag '{}': bad directory payload: {}",
                scene.id,
                term,
                err
            ),
        }
    }
    any_response.then_some(collected)
}

/// Pull every stale scene (or every scene when `force`) from the directory,
/// upsert the cache, prune rows the directory dropped that already failed
/// three checks, then probe every row that can reach a shelf and is not
/// freshly verified (new rows included).
pub async fn refresh_station_scenes(
    db: &DbPool,
    force: bool,
) -> Result<SceneRefreshSummary, String> {
    let _serialized = REFRESH_LOCK.lock().await;
    REFRESH_IN_FLIGHT.store(true, Ordering::SeqCst);
    let _in_flight = InFlightGuard;
    let started = Instant::now();

    let scenes: Vec<&SceneDef> = if force {
        SCENES.iter().collect()
    } else {
        let rows = queries::get_scene_refresh_rows(db).map_err(|e| e.to_string())?;
        stale_scenes(&rows, Utc::now())
    };
    let mut summary = SceneRefreshSummary::default();
    if scenes.is_empty() {
        summary.took_ms = started.elapsed().as_millis() as u64;
        return Ok(summary);
    }

    let mut unreachable = 0usize;

    for scene in scenes {
        let Some(candidates) = fetch_scene_candidates(scene).await else {
            unreachable += 1;
            continue;
        };
        let fetched_at = queries::now();
        let rows = prepare_scene_rows(scene, candidates, &fetched_at);
        let returned: HashSet<String> = rows.iter().map(|row| row.station_uuid.clone()).collect();
        queries::upsert_scene_stations(db, &rows).map_err(|e| e.to_string())?;
        let pruned =
            queries::prune_scene_stations(db, scene.id, &returned).map_err(|e| e.to_string())?;
        let cached = queries::get_scene_stations_for_scene(db, scene.id)
            .map_err(|e| e.to_string())?
            .len();
        queries::upsert_scene_refresh(db, scene.id, &fetched_at, cached as i64)
            .map_err(|e| e.to_string())?;
        summary.scenes += 1;
        summary.stations += rows.len();
        summary.pruned += pruned;
    }

    if summary.scenes == 0 && unreachable > 0 {
        return Err("All radio directory servers are unreachable".to_string());
    }

    if let Err(err) = verify_shelf_candidates(db).await {
        log::warn!("Shelf candidate verification after refresh failed: {}", err);
    }
    summary.took_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "Station scenes refreshed: {} scenes, {} stations, {} pruned in {} ms",
        summary.scenes,
        summary.stations,
        summary.pruned,
        summary.took_ms
    );
    Ok(summary)
}

/// Spawn one background refresh. Returns false when one is already pending.
pub fn spawn_background_refresh(db: DbPool, force: bool) -> bool {
    if BACKGROUND_REFRESH_PENDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = refresh_station_scenes(&db, force).await {
            log::warn!("Background station scene refresh failed: {}", err);
        }
        BACKGROUND_REFRESH_PENDING.store(false, Ordering::SeqCst);
    });
    true
}

/// Spawn one background verification pass over shelf candidates (no
/// directory traffic). Shares the pending flag with refreshes, so the feed
/// reports `refreshing` while it runs. Returns false when work is pending.
pub fn spawn_background_verify(db: DbPool) -> bool {
    if BACKGROUND_REFRESH_PENDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        {
            let _serialized = REFRESH_LOCK.lock().await;
            if let Err(err) = verify_shelf_candidates(&db).await {
                log::warn!("Background shelf verification failed: {}", err);
            }
        }
        BACKGROUND_REFRESH_PENDING.store(false, Ordering::SeqCst);
    });
    true
}

/// Launch task: a short delay, then refresh when any scene is stale so a
/// fresh install populates itself; otherwise just re-verify the shelf
/// candidates that are due a check.
pub(crate) fn spawn_startup_refresh(db: DbPool) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_REFRESH_DELAY).await;
        let any_stale = match queries::get_scene_refresh_rows(&db) {
            Ok(rows) => !stale_scenes(&rows, Utc::now()).is_empty(),
            Err(err) => {
                log::warn!("Station scene cadence check failed: {}", err);
                return;
            }
        };
        if any_stale {
            spawn_background_refresh(db, false);
        } else {
            spawn_background_verify(db);
        }
    });
}

// ── Daily cache health sweep ──

/// Probe the 40 cached stations with the oldest check, reset or increment
/// their fail counts, and delete any reaching three failures.
pub async fn sweep_cache_health(db: &DbPool) -> Result<usize, String> {
    let rows = queries::get_scene_stations_oldest_checked(db, DAILY_SWEEP_BATCH)
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(0);
    }
    let refs: Vec<&SceneStationRow> = rows.iter().collect();
    probe_scene_rows(db, &refs).await
}

/// Returns true when the station was deleted from the cache.
fn apply_sweep_result(
    db: &DbPool,
    uuid: &str,
    previous_fail_count: i32,
    healthy: bool,
    checked_at: &str,
) -> Result<bool, String> {
    let next = if healthy {
        0
    } else {
        previous_fail_count.saturating_add(1)
    };
    if next >= SWEEP_DELETE_AT_FAIL_COUNT {
        queries::delete_scene_station_by_uuid(db, uuid).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    queries::update_scene_station_health(db, uuid, next, checked_at).map_err(|e| e.to_string())?;
    Ok(false)
}

pub(crate) fn spawn_daily_cache_health_sweep(db: DbPool) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DAILY_SWEEP_INITIAL_DELAY).await;
        loop {
            match sweep_cache_health(&db).await {
                Ok(removed) if removed > 0 => {
                    log::info!("Scene cache sweep removed {} dead stations", removed)
                }
                Ok(_) => {}
                Err(err) => log::warn!("Scene cache health sweep failed: {}", err),
            }
            tokio::time::sleep(DAILY_SWEEP_INTERVAL).await;
        }
    });
}

// ── Signals from history ──

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StationSignal {
    pub plays: u32,
    pub bails: u32,
    /// `bails / plays`, 0 when there are fewer than two plays.
    pub bail_rate: f64,
    pub listened_ms: i64,
    pub last_played_at: Option<DateTime<Utc>>,
}

fn is_bail(listened_ms: i64, end_reason: Option<&str>) -> bool {
    listened_ms < BAIL_THRESHOLD_MS
        && end_reason.is_some_and(|reason| BAIL_END_REASONS.contains(&reason))
}

/// Per-uuid listening signals from radio plays (rows are already limited to
/// the 90-day window by the query). Plays of stations without a
/// radio-browser uuid cannot be matched to the cache and are skipped.
pub fn compute_station_signals(rows: &[StationPlayRow]) -> HashMap<String, StationSignal> {
    let mut signals: HashMap<String, StationSignal> = HashMap::new();
    for row in rows {
        let Some(uuid) = row.station.radio_browser_id.as_deref() else {
            continue;
        };
        let signal = signals.entry(uuid.to_ascii_lowercase()).or_default();
        signal.plays += 1;
        if is_bail(row.listened_ms, row.end_reason.as_deref()) {
            signal.bails += 1;
        }
        signal.listened_ms += row.listened_ms.max(0);
        if let Some(started) = parse_timestamp(&row.started_at) {
            if signal.last_played_at.is_none_or(|last| started > last) {
                signal.last_played_at = Some(started);
            }
        }
    }
    for signal in signals.values_mut() {
        signal.bail_rate = if signal.plays < 2 {
            0.0
        } else {
            f64::from(signal.bails) / f64::from(signal.plays)
        };
    }
    signals
}

/// Listening time per scene whose tag terms intersect the played station's
/// tags, normalised to 0..1 across scenes.
pub fn compute_scene_affinity(rows: &[StationPlayRow]) -> HashMap<&'static str, f64> {
    let mut totals: HashMap<&'static str, f64> = HashMap::new();
    for row in rows {
        let tags = split_tags(row.station.tags.as_deref());
        if tags.is_empty() {
            continue;
        }
        for scene in SCENES {
            if tags_intersect(&tags, scene.tags) {
                *totals.entry(scene.id).or_default() += row.listened_ms.max(0) as f64;
            }
        }
    }
    let max = totals.values().cloned().fold(0.0_f64, f64::max);
    if max > 0.0 {
        for value in totals.values_mut() {
            *value /= max;
        }
    }
    totals
}

// ── Ranking ──

pub fn quality_score(votes: i64, clickcount: i64, clicktrend: i64, bitrate: i32) -> f64 {
    0.5 * (1.0 + votes.max(0) as f64).ln()
        + 0.3 * (1.0 + clickcount.max(0) as f64).ln()
        + 0.2 * (clicktrend as f64 / 20.0).clamp(-1.0, 1.0)
        + 0.15 * ((f64::from(bitrate) - 64.0) / 128.0).clamp(0.0, 1.0)
}

fn played_within(signal: Option<&StationSignal>, now: DateTime<Utc>, days: i64) -> bool {
    signal
        .and_then(|signal| signal.last_played_at)
        .is_some_and(|last| now.signed_duration_since(last) < Duration::days(days))
}

pub fn rank_score(
    row: &SceneStationRow,
    signal: Option<&StationSignal>,
    now: DateTime<Utc>,
) -> f64 {
    let bail_rate = signal.map(|signal| signal.bail_rate).unwrap_or(0.0);
    let recency = if played_within(signal, now, RECENCY_DAYS) {
        1.0
    } else {
        0.0
    };
    let quality = quality_score(
        row.votes,
        row.clickcount,
        row.clicktrend,
        row.bitrate.unwrap_or(0),
    );
    let penalty = 2.0 * bail_rate + 3.0 * f64::from(row.fail_count.max(0)) + recency;
    // Tag focus scales quality and adds its own penalty, so a station that
    // tags every genre ranks far below a focused one even with more votes.
    let focus = row_focus(row);
    quality * focus - FOCUS_PENALTY_WEIGHT * (1.0 - focus) - penalty
}

pub fn is_shelf_eligible(row: &SceneStationRow) -> bool {
    row.fail_count < SHELF_EXCLUDE_AT_FAIL_COUNT && row_focus(row) >= FOCUS_EXCLUDE_BELOW
}

/// Probed OK within the last 7 days with no failure since.
pub fn is_verified(row: &SceneStationRow, now: DateTime<Utc>) -> bool {
    row.fail_count == 0
        && checked_within(
            row.last_checked_at.as_deref(),
            now,
            VERIFIED_WITHIN_DAYS * 24,
        )
}

fn checked_within(last_checked_at: Option<&str>, now: DateTime<Utc>, hours: i64) -> bool {
    last_checked_at
        .and_then(parse_timestamp)
        .is_some_and(|at| now.signed_duration_since(at) < Duration::hours(hours))
}

// ── Daily deterministic shuffle ──

pub fn fnv1a_64(input: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    input.bytes().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(PRIME)
    })
}

pub fn daily_seed(scope: &str, date: &str, install_salt: &str) -> u64 {
    fnv1a_64(&format!("{scope}:{date}:{install_salt}"))
}

/// SplitMix64: tiny, deterministic, good enough for a shelf shuffle.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in the open interval (0, 1).
    fn next_unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 1.0) / ((1u64 << 53) as f64 + 2.0)
    }
}

/// Pick `count` indices from `scores` without replacement, weighted by score
/// (shifted so the lowest candidate still has weight 1), deterministically
/// for a seed. Weighted reservoir keys (Efraimidis–Spirakis): higher weight,
/// higher expected key.
pub fn weighted_daily_pick(scores: &[f64], seed: u64, count: usize) -> Vec<usize> {
    if scores.is_empty() || count == 0 {
        return Vec::new();
    }
    let min = scores.iter().cloned().fold(f64::INFINITY, f64::min);
    let mut rng = SplitMix64(seed);
    let mut keyed: Vec<(f64, usize)> = scores
        .iter()
        .enumerate()
        .map(|(index, score)| {
            let weight = (score - min + 1.0).max(1e-6);
            let key = rng.next_unit().powf(1.0 / weight);
            (key, index)
        })
        .collect();
    keyed.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    keyed
        .into_iter()
        .take(count)
        .map(|(_, index)| index)
        .collect()
}

// ── Feed assembly ──

#[derive(Debug, Clone)]
struct Ranked<'a> {
    row: &'a SceneStationRow,
    score: f64,
    verified: bool,
}

/// Everything the pure feed builder needs, gathered by `build_discovery_feed`.
pub struct FeedInputs<'a> {
    pub rows: &'a [SceneStationRow],
    pub plays: &'a [StationPlayRow],
    pub favorite_uuids: &'a HashSet<String>,
    pub install_salt: &'a str,
    /// `YYYY-MM-DD`, the shuffle day.
    pub date: &'a str,
    pub now: DateTime<Utc>,
}

fn rank_rows<'a>(
    rows: &'a [SceneStationRow],
    signals: &HashMap<String, StationSignal>,
    now: DateTime<Utc>,
) -> HashMap<&'a str, Vec<Ranked<'a>>> {
    let mut by_scene: HashMap<&str, Vec<Ranked>> = HashMap::new();
    for row in rows.iter().filter(|row| is_shelf_eligible(row)) {
        let score = rank_score(row, signals.get(&row.station_uuid), now);
        by_scene
            .entry(row.scene_id.as_str())
            .or_default()
            .push(Ranked {
                row,
                score,
                verified: is_verified(row, now),
            });
    }
    for list in by_scene.values_mut() {
        sort_ranked(list);
    }
    by_scene
}

fn sort_ranked(list: &mut [Ranked<'_>]) {
    list.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.row.station_uuid.cmp(&b.row.station_uuid))
    });
}

/// Best-scoring instance of every station across scenes.
fn best_by_uuid<'r, 'a>(
    ranked: &'r HashMap<&'a str, Vec<Ranked<'a>>>,
) -> HashMap<&'a str, &'r Ranked<'a>> {
    let mut best: HashMap<&str, &Ranked> = HashMap::new();
    for list in ranked.values() {
        for item in list {
            let entry = best.entry(item.row.station_uuid.as_str()).or_insert(item);
            if item.score > entry.score {
                *entry = item;
            }
        }
    }
    best
}

/// Candidates for the fresh shelf: every station not played in 14 days,
/// best instance only, highest score first.
fn fresh_candidates<'r, 'a>(
    best: &HashMap<&'a str, &'r Ranked<'a>>,
    signals: &HashMap<String, StationSignal>,
    now: DateTime<Utc>,
) -> Vec<&'r Ranked<'a>> {
    let mut fresh: Vec<&Ranked> = best
        .values()
        .filter(|ranked| {
            !played_within(
                signals.get(&ranked.row.station_uuid),
                now,
                FRESH_UNPLAYED_DAYS,
            )
        })
        .copied()
        .collect();
    fresh.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.row.station_uuid.cmp(&b.row.station_uuid))
    });
    fresh
}

/// The top-affinity scenes the for-you shelf draws unplayed stations from.
fn top_affinity_scenes(affinity: &HashMap<&'static str, f64>) -> Vec<&'static str> {
    let mut top: Vec<(&'static str, f64)> = affinity
        .iter()
        .filter(|(_, weight)| **weight > 0.0)
        .map(|(id, weight)| (*id, *weight))
        .collect();
    top.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(b.0))
    });
    top.into_iter()
        .take(FOR_YOU_AFFINITY_SCENES)
        .map(|(id, _)| id)
        .collect()
}

/// Deal `count` picks from a ranked list with the daily shuffle, verified
/// stations first: the shuffle runs over the top `pool` verified rows, and
/// unverified rows only fill whatever is left, after every verified pick.
fn deal_verified_first<'r, 'a>(
    list: &[&'r Ranked<'a>],
    seed: u64,
    pool: usize,
    count: usize,
) -> Vec<&'r Ranked<'a>> {
    let verified: Vec<&Ranked> = list
        .iter()
        .filter(|ranked| ranked.verified)
        .take(pool)
        .copied()
        .collect();
    let scores: Vec<f64> = verified.iter().map(|ranked| ranked.score).collect();
    let mut dealt: Vec<&Ranked> = weighted_daily_pick(&scores, seed, count)
        .into_iter()
        .map(|index| verified[index])
        .collect();
    if dealt.len() < count {
        let unverified: Vec<&Ranked> = list
            .iter()
            .filter(|ranked| !ranked.verified)
            .take(pool)
            .copied()
            .collect();
        let scores: Vec<f64> = unverified.iter().map(|ranked| ranked.score).collect();
        dealt.extend(
            weighted_daily_pick(&scores, seed.rotate_left(17), count - dealt.len())
                .into_iter()
                .map(|index| unverified[index]),
        );
    }
    dealt
}

fn scene_reason(
    row: &SceneStationRow,
    signal: Option<&StationSignal>,
    scene_title: &str,
) -> String {
    if row.clicktrend >= 20 {
        "Rising this week".to_string()
    } else if signal.is_some_and(|signal| signal.plays > 0) {
        "You have played this before".to_string()
    } else if row.votes >= 500 {
        "Listener favourite".to_string()
    } else {
        format!("Popular in {scene_title}")
    }
}

fn make_pick(
    ranked: &Ranked<'_>,
    signal: Option<&StationSignal>,
    scene_id: Option<&str>,
    reason: String,
) -> StationPick {
    StationPick {
        station: row_to_station(ranked.row),
        scene_id: scene_id.map(str::to_string),
        reason,
        score: ranked.score,
        bail_rate: signal.map(|signal| signal.bail_rate).unwrap_or(0.0),
        plays: signal.map(|signal| signal.plays).unwrap_or(0),
        verified: ranked.verified,
        last_checked_at: ranked.row.last_checked_at.clone(),
    }
}

/// Verified picks always come before unverified ones (stable within each
/// group). Returns whether the shelf can lead with a verified pick; a shelf
/// that cannot is omitted.
fn order_verified_first(items: &mut [StationPick]) -> bool {
    items.sort_by_key(|pick| !pick.verified);
    items.first().is_some_and(|pick| pick.verified)
}

/// Build every shelf from cache rows and history. Pure: the same inputs,
/// salt and date always yield the same feed. Every shelf leads with
/// verified-playable picks; shelves with none are omitted.
pub fn assemble_shelves(inputs: &FeedInputs<'_>) -> Vec<StationShelf> {
    let signals = compute_station_signals(inputs.plays);
    let affinity = compute_scene_affinity(inputs.plays);
    let ranked = rank_rows(inputs.rows, &signals, inputs.now);

    // Scene shelves: 8 dealt by the daily shuffle, verified picks first.
    let mut scene_shelves: Vec<(f64, usize, StationShelf)> = Vec::new();
    for (position, scene) in SCENES.iter().enumerate() {
        let Some(list) = ranked.get(scene.id) else {
            continue;
        };
        let refs: Vec<&Ranked> = list.iter().collect();
        let seed = daily_seed(scene.id, inputs.date, inputs.install_salt);
        let mut items: Vec<StationPick> =
            deal_verified_first(&refs, seed, SHELF_CANDIDATES, SHELF_SIZE)
                .into_iter()
                .map(|ranked| {
                    let signal = signals.get(&ranked.row.station_uuid);
                    make_pick(
                        ranked,
                        signal,
                        Some(scene.id),
                        scene_reason(ranked.row, signal, scene.title),
                    )
                })
                .collect();
        if !order_verified_first(&mut items) {
            continue;
        }
        scene_shelves.push((
            affinity.get(scene.id).cloned().unwrap_or(0.0),
            position,
            StationShelf {
                id: format!("scene:{}", scene.id),
                kind: ShelfKind::Scene,
                title: scene.title.to_string(),
                subtitle: scene.description.to_string(),
                scene_id: Some(scene.id.to_string()),
                items,
            },
        ));
    }
    scene_shelves.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });

    // Best instance of every station across scenes, for cross-scene shelves.
    let best = best_by_uuid(&ranked);

    let mut shelves = Vec::new();

    // For you: needs at least three radio plays.
    if inputs.plays.len() >= FOR_YOU_MIN_PLAYS {
        let mut items: Vec<StationPick> = Vec::new();
        let mut used: HashSet<String> = HashSet::new();

        // (a) the user's top stations by listened time that are not favorites.
        let mut top_played: Vec<(&String, &StationSignal)> = signals
            .iter()
            .filter(|(uuid, signal)| {
                signal.listened_ms > 0 && !inputs.favorite_uuids.contains(*uuid)
            })
            .collect();
        top_played.sort_by(|a, b| b.1.listened_ms.cmp(&a.1.listened_ms).then(a.0.cmp(b.0)));
        for (uuid, signal) in top_played.into_iter().take(FOR_YOU_TOP_PLAYED) {
            let reason = if signal.plays == 1 {
                "You played this once, worth another go".to_string()
            } else {
                format!("You have played this {} times", signal.plays)
            };
            let pick = if let Some(ranked) = best.get(uuid.as_str()) {
                make_pick(
                    ranked,
                    Some(signal),
                    Some(ranked.row.scene_id.as_str()),
                    reason,
                )
            } else if let Some(play) = inputs.plays.iter().find(|play| {
                play.station
                    .radio_browser_id
                    .as_deref()
                    .is_some_and(|id| id.eq_ignore_ascii_case(uuid))
            }) {
                let verified = play.station.fail_count == 0
                    && checked_within(
                        play.station.last_checked_at.as_deref(),
                        inputs.now,
                        VERIFIED_WITHIN_DAYS * 24,
                    );
                StationPick {
                    station: saved_station_to_station(&play.station, uuid),
                    scene_id: None,
                    reason,
                    score: 0.0,
                    bail_rate: signal.bail_rate,
                    plays: signal.plays,
                    verified,
                    last_checked_at: play.station.last_checked_at.clone(),
                }
            } else {
                continue;
            };
            used.insert(uuid.clone());
            items.push(pick);
        }

        // (b) unplayed stations from the top three affinity scenes, round-robin.
        let mut cursors: Vec<(&SceneDef, std::slice::Iter<Ranked>)> =
            top_affinity_scenes(&affinity)
                .into_iter()
                .filter_map(|id| Some((find_scene(id)?, ranked.get(id)?.iter())))
                .collect();
        let mut progressed = true;
        while items.len() < FOR_YOU_SIZE && progressed {
            progressed = false;
            for (scene, cursor) in cursors.iter_mut() {
                if items.len() >= FOR_YOU_SIZE {
                    break;
                }
                for candidate in cursor.by_ref() {
                    let uuid = candidate.row.station_uuid.as_str();
                    if used.contains(uuid) || signals.contains_key(uuid) {
                        continue;
                    }
                    used.insert(uuid.to_string());
                    items.push(make_pick(
                        candidate,
                        None,
                        Some(scene.id),
                        format!("Because you listen to {}", scene.title),
                    ));
                    progressed = true;
                    break;
                }
            }
        }

        if order_verified_first(&mut items) {
            shelves.push(StationShelf {
                id: "for-you".to_string(),
                kind: ShelfKind::ForYou,
                title: "For you".to_string(),
                subtitle: "Built from what you actually listen to".to_string(),
                scene_id: None,
                items,
            });
        }
    }

    // Fresh: not played in 14 days, daily shuffle over the top 120.
    let fresh = fresh_candidates(&best, &signals, inputs.now);
    let fresh_seed = daily_seed("fresh", inputs.date, inputs.install_salt);
    let mut fresh_items: Vec<StationPick> =
        deal_verified_first(&fresh, fresh_seed, FRESH_CANDIDATES, FRESH_SIZE)
            .into_iter()
            .map(|ranked| {
                make_pick(
                    ranked,
                    signals.get(&ranked.row.station_uuid),
                    Some(ranked.row.scene_id.as_str()),
                    "Fresh today".to_string(),
                )
            })
            .collect();
    if order_verified_first(&mut fresh_items) {
        shelves.push(StationShelf {
            id: "fresh".to_string(),
            kind: ShelfKind::Fresh,
            title: "Fresh today".to_string(),
            subtitle: "A new deal across every scene, rotating daily".to_string(),
            scene_id: None,
            items: fresh_items,
        });
    }

    shelves.extend(scene_shelves.into_iter().map(|(_, _, shelf)| shelf));
    shelves
}

// ── Verification ──

fn needs_check(row: &SceneStationRow, now: DateTime<Utc>) -> bool {
    // A station that just failed once gets another chance sooner than a
    // healthy one needs re-confirming.
    let hours = if row.fail_count > 0 {
        12
    } else {
        RECHECK_AFTER_HOURS
    };
    !checked_within(row.last_checked_at.as_deref(), now, hours)
}

/// Every cache row that can appear on a shelf: the top 24 of each scene, the
/// top 120 fresh candidates and the for-you reach into the top-affinity
/// scenes. One row per station.
pub fn shelf_candidate_rows<'a>(
    rows: &'a [SceneStationRow],
    plays: &[StationPlayRow],
    now: DateTime<Utc>,
) -> Vec<&'a SceneStationRow> {
    let signals = compute_station_signals(plays);
    let affinity = compute_scene_affinity(plays);
    let ranked = rank_rows(rows, &signals, now);
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<&SceneStationRow> = Vec::new();
    let mut push = |row: &'a SceneStationRow| {
        if seen.insert(row.station_uuid.as_str()) {
            out.push(row);
        }
    };
    for scene in SCENES {
        for item in ranked
            .get(scene.id)
            .into_iter()
            .flatten()
            .take(SHELF_CANDIDATES)
        {
            push(item.row);
        }
    }
    let best = best_by_uuid(&ranked);
    for item in fresh_candidates(&best, &signals, now)
        .into_iter()
        .take(FRESH_CANDIDATES)
    {
        push(item.row);
    }
    if plays.len() >= FOR_YOU_MIN_PLAYS {
        for id in top_affinity_scenes(&affinity) {
            for item in ranked
                .get(id)
                .into_iter()
                .flatten()
                .take(FOR_YOU_CANDIDATES_PER_SCENE)
            {
                push(item.row);
            }
        }
    }
    out
}

/// Shelf candidates that are unchecked or due a re-check, never-checked
/// first then oldest check first, at most `limit`.
pub fn select_probe_targets<'a>(
    rows: &'a [SceneStationRow],
    plays: &[StationPlayRow],
    now: DateTime<Utc>,
    limit: usize,
) -> Vec<&'a SceneStationRow> {
    let mut targets: Vec<&SceneStationRow> = shelf_candidate_rows(rows, plays, now)
        .into_iter()
        .filter(|row| needs_check(row, now))
        .collect();
    targets.sort_by(|a, b| {
        a.last_checked_at
            .is_some()
            .cmp(&b.last_checked_at.is_some())
            .then_with(|| a.last_checked_at.cmp(&b.last_checked_at))
            .then_with(|| a.station_uuid.cmp(&b.station_uuid))
    });
    targets.truncate(limit);
    targets
}

/// Probe rows concurrently (the health module's bounded verifier, in
/// batches it accepts) and apply each result: OK resets `fail_count`, a
/// failure increments it and three failures delete the station from the
/// cache. Returns the number of deleted stations.
async fn probe_scene_rows(db: &DbPool, rows: &[&SceneStationRow]) -> Result<usize, String> {
    const VERIFY_BATCH: usize = 100;
    let checked_at = queries::now();
    let mut removed = 0;
    let mut by_url: HashMap<String, Vec<(String, i32)>> = HashMap::new();
    let mut seen_uuids: HashSet<&str> = HashSet::new();
    for row in rows {
        if !seen_uuids.insert(row.station_uuid.as_str()) {
            continue;
        }
        let url = playable_url(row).trim().to_string();
        if url.is_empty() || url.len() > MAX_STATION_URL_BYTES {
            if apply_sweep_result(db, &row.station_uuid, row.fail_count, false, &checked_at)? {
                removed += 1;
            }
            continue;
        }
        by_url
            .entry(url)
            .or_default()
            .push((row.station_uuid.clone(), row.fail_count));
    }
    let urls: Vec<String> = by_url.keys().cloned().collect();
    for batch in urls.chunks(VERIFY_BATCH) {
        let results = verify_station_urls_inner(batch.to_vec()).await?;
        for result in results {
            let healthy = result.status == "ok";
            for (uuid, fail_count) in by_url.get(&result.url).into_iter().flatten() {
                if apply_sweep_result(db, uuid, *fail_count, healthy, &checked_at)? {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

/// Probe every shelf candidate that is unchecked or due a re-check, so the
/// hero and the front of every shelf are stations that played recently.
/// Returns the number of stations probed.
pub async fn verify_shelf_candidates(db: &DbPool) -> Result<usize, String> {
    let now = Utc::now();
    let rows = queries::get_all_scene_stations(db).map_err(|e| e.to_string())?;
    let plays = queries::get_station_play_rows_since(db, &history_window_start(now))
        .map_err(|e| e.to_string())?;
    let targets = select_probe_targets(&rows, &plays, now, MAX_SHELF_PROBES_PER_PASS);
    if targets.is_empty() {
        return Ok(0);
    }
    let started = Instant::now();
    let count = targets.len();
    let removed = probe_scene_rows(db, &targets).await?;
    log::info!(
        "Verified {} shelf candidates in {} ms ({} removed)",
        count,
        started.elapsed().as_millis(),
        removed
    );
    Ok(count)
}

/// A pick failed in the play path (probe and self-heal both failed): take
/// it off every shelf right away. `fail_count >= 2` excludes it.
pub fn mark_station_unplayable(db: &DbPool, station_uuid: &str) -> Result<(), String> {
    queries::mark_scene_station_failed(db, &station_uuid.to_ascii_lowercase(), &queries::now())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A pick just proved playable in the play path: that is a fresh probe.
pub fn mark_station_playable(db: &DbPool, station_uuid: &str) -> Result<(), String> {
    queries::update_scene_station_health(db, &station_uuid.to_ascii_lowercase(), 0, &queries::now())
        .map_err(|e| e.to_string())
}

fn history_window_start(now: DateTime<Utc>) -> String {
    (now - Duration::days(HISTORY_WINDOW_DAYS)).to_rfc3339()
}

fn favorite_uuids(db: &DbPool) -> Result<HashSet<String>, String> {
    Ok(queries::get_favorite_stations(db)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|station| station.radio_browser_id)
        .map(|uuid| uuid.to_ascii_lowercase())
        .collect())
}

fn cache_age_seconds(refresh_rows: &[SceneRefreshRow], now: DateTime<Utc>) -> Option<i64> {
    refresh_rows
        .iter()
        .filter_map(|row| parse_timestamp(&row.refreshed_at))
        .max()
        .map(|latest| now.signed_duration_since(latest).num_seconds().max(0))
}

/// The feed from the cache alone. Never touches the network: an empty cache
/// returns `status: empty` (with the scene catalog) and kicks off one
/// background refresh. While a refresh or verification pass runs the status
/// is `refreshing` (so the page keeps polling as picks get verified), and a
/// cache with nothing verified yet starts a verification pass.
pub fn build_discovery_feed(db: &DbPool) -> Result<StationDiscoveryFeed, String> {
    let now = Utc::now();
    let rows = queries::get_all_scene_stations(db).map_err(|e| e.to_string())?;
    let refresh_rows = queries::get_scene_refresh_rows(db).map_err(|e| e.to_string())?;
    let scenes = scene_catalog();

    if rows.is_empty() {
        let status = if is_refresh_in_flight() {
            FeedStatus::Refreshing
        } else {
            spawn_background_refresh(db.clone(), false);
            FeedStatus::Empty
        };
        return Ok(StationDiscoveryFeed {
            generated_at: now.to_rfc3339(),
            status,
            cache_age_seconds: cache_age_seconds(&refresh_rows, now),
            shelves: Vec::new(),
            scenes,
        });
    }

    let plays = queries::get_station_play_rows_since(db, &history_window_start(now))
        .map_err(|e| e.to_string())?;
    let favorites = favorite_uuids(db)?;
    let install_salt = queries::get_or_create_install_salt(db).map_err(|e| e.to_string())?;
    let date = now.format("%Y-%m-%d").to_string();
    let shelves = assemble_shelves(&FeedInputs {
        rows: &rows,
        plays: &plays,
        favorite_uuids: &favorites,
        install_salt: &install_salt,
        date: &date,
        now,
    });

    let status = if is_refresh_in_flight() {
        FeedStatus::Refreshing
    } else if shelves.is_empty()
        && !select_probe_targets(&rows, &plays, now, 1).is_empty()
        && spawn_background_verify(db.clone())
    {
        FeedStatus::Refreshing
    } else {
        FeedStatus::Ready
    };

    Ok(StationDiscoveryFeed {
        generated_at: now.to_rfc3339(),
        status,
        cache_age_seconds: cache_age_seconds(&refresh_rows, now),
        shelves,
        scenes,
    })
}

/// Ranked rows of one scene without the daily shuffle, for "See all":
/// verified stations first, then the unverified ones, each by score.
pub fn scene_stations_page(
    db: &DbPool,
    scene_id: &str,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<StationPick>, String> {
    let scene = find_scene(scene_id).ok_or_else(|| format!("Unknown scene '{scene_id}'"))?;
    let limit = limit.unwrap_or(DEFAULT_SCENE_PAGE).clamp(1, MAX_SCENE_PAGE);
    let offset = offset.unwrap_or(0);
    let now = Utc::now();
    let rows = queries::get_scene_stations_for_scene(db, scene.id).map_err(|e| e.to_string())?;
    let plays = queries::get_station_play_rows_since(db, &history_window_start(now))
        .map_err(|e| e.to_string())?;
    let signals = compute_station_signals(&plays);
    Ok(rank_scene_page(&rows, &signals, scene, now)
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect())
}

fn rank_scene_page(
    rows: &[SceneStationRow],
    signals: &HashMap<String, StationSignal>,
    scene: &SceneDef,
    now: DateTime<Utc>,
) -> Vec<StationPick> {
    let mut ranked: Vec<Ranked> = rows
        .iter()
        .filter(|row| is_shelf_eligible(row))
        .map(|row| Ranked {
            row,
            score: rank_score(row, signals.get(&row.station_uuid), now),
            verified: is_verified(row, now),
        })
        .collect();
    sort_ranked(&mut ranked);
    ranked.sort_by_key(|item| !item.verified);
    ranked
        .iter()
        .map(|item| {
            let signal = signals.get(&item.row.station_uuid);
            make_pick(
                item,
                signal,
                Some(scene.id),
                scene_reason(item.row, signal, scene.title),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Station;

    const REQUIRED_SCENES: [&str; 29] = [
        "workout",
        "hip-hop",
        "trap",
        "boom-bap",
        "lofi-hip-hop",
        "uk-rap-drill",
        "rnb-soul",
        "punk",
        "metal",
        "hardcore",
        "classic-rock",
        "indie-alt",
        "house",
        "techno",
        "drum-and-bass",
        "trance",
        "ambient",
        "synthwave",
        "jazz",
        "funk",
        "reggae-dub",
        "latin",
        "afrobeats",
        "country",
        "classical",
        "pop-hits",
        "80s-90s",
        "chill-study",
        "oldies",
    ];

    fn row(scene_id: &str, uuid: &str, votes: i64) -> SceneStationRow {
        SceneStationRow {
            scene_id: scene_id.to_string(),
            station_uuid: uuid.to_string(),
            name: format!("Station {uuid}"),
            url: format!("https://radio.example/{uuid}"),
            url_resolved: Some(format!("https://radio.example/{uuid}/live")),
            homepage: None,
            favicon: Some("https://radio.example/icon.png".to_string()),
            country: Some("US".to_string()),
            countrycode: Some("US".to_string()),
            language: None,
            tags: Some(format!("{scene_id},radio")),
            codec: Some("MP3".to_string()),
            bitrate: Some(128),
            votes,
            clickcount: votes * 3,
            clicktrend: 0,
            fetched_at: "2026-10-07T00:00:00+00:00".to_string(),
            fail_count: 0,
            // Verified a day before `now()`.
            last_checked_at: Some("2026-10-06T12:00:00+00:00".to_string()),
        }
    }

    fn directory_station(uuid: &str, hls: i32, bitrate: i32, tags: &str) -> RadioBrowserStation {
        serde_json::from_value(serde_json::json!({
            "name": format!("Station {uuid}"),
            "url": format!("https://radio.example/{uuid}"),
            "url_resolved": format!("https://radio.example/{uuid}/live"),
            "hls": hls,
            "homepage": null,
            "favicon": null,
            "country": "US",
            "language": "English",
            "tags": tags,
            "codec": "MP3",
            "bitrate": bitrate,
            "votes": 10,
            "clickcount": 30,
            "clicktrend": 1,
            "stationuuid": uuid
        }))
        .unwrap()
    }

    fn play(
        uuid: &str,
        tags: &str,
        listened_ms: i64,
        end_reason: &str,
        started_at: &str,
    ) -> StationPlayRow {
        StationPlayRow {
            station: Station {
                id: format!("local-{uuid}"),
                name: format!("Station {uuid}"),
                url: format!("https://radio.example/{uuid}/live"),
                homepage: None,
                favicon_url: None,
                favicon_path: None,
                country: None,
                language: None,
                tags: Some(tags.to_string()),
                codec: None,
                bitrate: None,
                radio_browser_id: Some(uuid.to_string()),
                is_favorite: false,
                fail_count: 0,
                last_played_at: None,
                last_checked_at: None,
                created_at: started_at.to_string(),
            },
            listened_ms,
            end_reason: Some(end_reason.to_string()),
            started_at: started_at.to_string(),
        }
    }

    fn now() -> DateTime<Utc> {
        parse_timestamp("2026-10-07T12:00:00+00:00").unwrap()
    }

    #[test]
    fn catalog_has_every_required_scene_exactly_once() {
        let ids: Vec<&str> = SCENES.iter().map(|scene| scene.id).collect();
        for required in REQUIRED_SCENES {
            assert_eq!(
                ids.iter().filter(|id| **id == required).count(),
                1,
                "scene '{required}' must appear exactly once"
            );
        }
        assert_eq!(ids.len(), REQUIRED_SCENES.len());
        for scene in SCENES {
            assert!(
                !scene.tags.is_empty() && scene.tags.len() <= 4,
                "{}",
                scene.id
            );
            assert!(scene.min_bitrate >= DEFAULT_MIN_BITRATE, "{}", scene.id);
        }
        let catalog = scene_catalog();
        assert_eq!(catalog[1].id, "hip-hop");
        assert_eq!(
            serde_json::to_value(&catalog[1]).unwrap()["family"],
            serde_json::json!("hiphop")
        );
    }

    #[test]
    fn fnv1a_matches_reference_vectors() {
        assert_eq!(fnv1a_64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64("a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(
            daily_seed("house", "2026-10-07", "salt"),
            daily_seed("house", "2026-10-08", "salt")
        );
        assert_ne!(
            daily_seed("house", "2026-10-07", "salt"),
            daily_seed("house", "2026-10-07", "other")
        );
    }

    #[test]
    fn daily_shuffle_is_stable_within_a_day_and_rotates_across_days() {
        let scores: Vec<f64> = (0..24).map(|index| 6.0 - index as f64 * 0.2).collect();
        let today = weighted_daily_pick(&scores, daily_seed("house", "2026-10-07", "salt"), 8);
        let again = weighted_daily_pick(&scores, daily_seed("house", "2026-10-07", "salt"), 8);
        assert_eq!(today.len(), 8);
        assert_eq!(today, again);
        let unique: HashSet<usize> = today.iter().cloned().collect();
        assert_eq!(unique.len(), 8, "no station may be dealt twice");

        let rotated = [
            "2026-10-08",
            "2026-10-09",
            "2026-10-10",
            "2026-10-11",
            "2026-10-12",
        ]
        .iter()
        .map(|date| weighted_daily_pick(&scores, daily_seed("house", date, "salt"), 8))
        .any(|picks| picks != today);
        assert!(rotated, "a different day must deal a different shelf");
    }

    #[test]
    fn shuffle_favours_higher_scores() {
        // Over many seeds the top candidate should be dealt far more often
        // than the bottom one: the pick is weighted, not uniform.
        let scores: Vec<f64> = (0..24).map(|index| 8.0 - index as f64 * 0.5).collect();
        let mut top_hits = 0;
        let mut bottom_hits = 0;
        for day in 0..200 {
            let picks = weighted_daily_pick(&scores, daily_seed("x", &day.to_string(), "s"), 8);
            top_hits += usize::from(picks.contains(&0));
            bottom_hits += usize::from(picks.contains(&23));
        }
        assert!(
            top_hits > bottom_hits * 2,
            "top {top_hits} vs bottom {bottom_hits}"
        );
    }

    #[test]
    fn bail_rate_and_fail_count_demote() {
        let clean = row("house", "a", 100);
        let base = rank_score(&clean, None, now());

        let bailed = StationSignal {
            plays: 4,
            bails: 3,
            bail_rate: 0.75,
            listened_ms: 30_000,
            last_played_at: None,
        };
        let demoted = rank_score(&clean, Some(&bailed), now());
        assert!((base - demoted - 1.5).abs() < 1e-9, "2.0 * bail_rate");

        let mut failing = row("house", "a", 100);
        failing.fail_count = 1;
        assert!((base - rank_score(&failing, None, now()) - 3.0).abs() < 1e-9);

        let recent = StationSignal {
            plays: 1,
            bails: 0,
            bail_rate: 0.0,
            listened_ms: 600_000,
            last_played_at: parse_timestamp("2026-10-06T12:00:00+00:00"),
        };
        assert!((base - rank_score(&clean, Some(&recent), now()) - 1.0).abs() < 1e-9);

        failing.fail_count = 2;
        assert!(!is_shelf_eligible(&failing));
        assert!(is_shelf_eligible(&clean));
    }

    #[test]
    fn quality_rewards_votes_clicks_trend_and_bitrate_with_clamps() {
        assert!(quality_score(100, 100, 0, 64) > quality_score(10, 10, 0, 64));
        assert!(
            (quality_score(0, 0, 100, 64) - 0.2).abs() < 1e-9,
            "trend clamps at +1"
        );
        assert!(
            (quality_score(0, 0, -100, 64) + 0.2).abs() < 1e-9,
            "trend clamps at -1"
        );
        assert!(
            (quality_score(0, 0, 0, 320) - 0.15).abs() < 1e-9,
            "bitrate clamps at 1"
        );
        assert!(
            (quality_score(0, 0, 0, 32)).abs() < 1e-9,
            "no negative bitrate credit"
        );
    }

    #[test]
    fn hls_low_bitrate_excluded_and_duplicate_rows_are_filtered() {
        let scene = find_scene("hardcore").unwrap();
        let rows = prepare_scene_rows(
            scene,
            vec![
                directory_station("keep", 0, 128, "hardcore,punk"),
                directory_station("hls", 1, 128, "hardcore"),
                directory_station("thin", 0, 48, "hardcore"),
                directory_station("rave", 0, 192, "hardcore,Hardstyle"),
                directory_station("KEEP", 0, 128, "hardcore"),
                directory_station("", 0, 128, "hardcore"),
            ],
            "2026-10-07T00:00:00+00:00",
        );
        let uuids: Vec<&str> = rows.iter().map(|row| row.station_uuid.as_str()).collect();
        assert_eq!(uuids, vec!["keep"]);
        assert_eq!(
            rows[0].url_resolved.as_deref(),
            Some("https://radio.example/keep/live")
        );
        assert_eq!(playable_url(&rows[0]), "https://radio.example/keep/live");
    }

    #[test]
    fn history_signals_count_bails_and_scene_affinity() {
        let plays = vec![
            play(
                "a",
                "house,deep house",
                5_000,
                "stopped",
                "2026-10-05T10:00:00+00:00",
            ),
            play(
                "a",
                "house,deep house",
                900_000,
                "natural_end",
                "2026-10-06T10:00:00+00:00",
            ),
            play(
                "a",
                "house,deep house",
                1_000,
                "skipped_next",
                "2026-10-07T10:00:00+00:00",
            ),
            play("b", "Techno", 2_000, "stopped", "2026-10-01T10:00:00+00:00"),
            play("c", "jazz", 120_000, "error", "2026-10-01T10:00:00+00:00"),
        ];
        let signals = compute_station_signals(&plays);
        let a = &signals["a"];
        assert_eq!((a.plays, a.bails), (3, 2));
        assert!((a.bail_rate - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(a.listened_ms, 906_000);
        assert_eq!(
            a.last_played_at,
            parse_timestamp("2026-10-07T10:00:00+00:00")
        );
        // A single bail is not a rate yet.
        assert_eq!(signals["b"].bail_rate, 0.0);
        assert_eq!(signals["c"].bails, 0, "errors are not bails");

        let affinity = compute_scene_affinity(&plays);
        assert_eq!(affinity["house"], 1.0);
        assert!(affinity["techno"] > 0.0 && affinity["techno"] < 0.01);
        assert!(affinity["jazz"] > 0.1 && affinity["jazz"] < 0.2);
        assert!(!affinity.contains_key("metal"));
    }

    fn fixture_rows() -> Vec<SceneStationRow> {
        let mut rows = Vec::new();
        for scene in ["house", "techno", "jazz"] {
            for index in 0..30 {
                rows.push(row(
                    scene,
                    &format!("{scene}-{index:02}"),
                    1_000 - index * 20,
                ));
            }
        }
        rows
    }

    fn shelves_for(plays: &[StationPlayRow], date: &str) -> Vec<StationShelf> {
        let rows = fixture_rows();
        let favorites = HashSet::new();
        assemble_shelves(&FeedInputs {
            rows: &rows,
            plays,
            favorite_uuids: &favorites,
            install_salt: "install-salt",
            date,
            now: now(),
        })
    }

    #[test]
    fn for_you_is_omitted_below_three_plays_and_fresh_leads() {
        let two_plays = vec![
            play(
                "house-00",
                "house",
                600_000,
                "stopped",
                "2026-10-06T10:00:00+00:00",
            ),
            play(
                "house-01",
                "house",
                600_000,
                "stopped",
                "2026-10-06T11:00:00+00:00",
            ),
        ];
        let shelves = shelves_for(&two_plays, "2026-10-07");
        assert_eq!(shelves[0].id, "fresh");
        assert_eq!(shelves[0].kind, ShelfKind::Fresh);
        assert!(shelves.iter().all(|shelf| shelf.kind != ShelfKind::ForYou));
        assert_eq!(shelves[0].items.len(), 12);
        assert!(
            shelves[0].items.iter().all(|pick| {
                pick.station.stationuuid != "house-00" && pick.station.stationuuid != "house-01"
            }),
            "stations played in the last 14 days are not fresh"
        );
        for shelf in shelves
            .iter()
            .filter(|shelf| shelf.kind == ShelfKind::Scene)
        {
            assert_eq!(shelf.items.len(), 8);
            assert!(shelf
                .items
                .iter()
                .all(|pick| pick.station.favicon.is_none()));
            assert!(shelf
                .items
                .iter()
                .all(|pick| pick.station.url.ends_with("/live")));
        }
        // House has the only affinity, so it leads the scene shelves.
        let scene_ids: Vec<&str> = shelves
            .iter()
            .filter_map(|shelf| shelf.scene_id.as_deref())
            .collect();
        assert_eq!(scene_ids, vec!["house", "techno", "jazz"]);
    }

    #[test]
    fn for_you_appears_with_three_plays_and_mixes_played_and_unplayed() {
        let plays = vec![
            play(
                "house-00",
                "house",
                600_000,
                "stopped",
                "2026-10-06T10:00:00+00:00",
            ),
            play(
                "house-01",
                "house",
                300_000,
                "stopped",
                "2026-10-06T11:00:00+00:00",
            ),
            play(
                "jazz-05",
                "jazz",
                100_000,
                "stopped",
                "2026-10-06T12:00:00+00:00",
            ),
        ];
        let shelves = shelves_for(&plays, "2026-10-07");
        let for_you = &shelves[0];
        assert_eq!(for_you.id, "for-you");
        assert_eq!(for_you.kind, ShelfKind::ForYou);
        assert_eq!(for_you.items.len(), 12);
        assert_eq!(for_you.items[0].station.stationuuid, "house-00");
        assert_eq!(for_you.items[0].plays, 1);
        assert_eq!(for_you.items[2].station.stationuuid, "jazz-05");
        let unplayed: Vec<&StationPick> = for_you.items.iter().skip(3).collect();
        assert_eq!(unplayed.len(), 9);
        assert!(unplayed.iter().all(|pick| pick.plays == 0));
        assert!(unplayed
            .iter()
            .all(|pick| pick.reason.starts_with("Because you listen to ")));
        let uuids: HashSet<&str> = for_you
            .items
            .iter()
            .map(|pick| pick.station.stationuuid.as_str())
            .collect();
        assert_eq!(uuids.len(), 12, "no duplicates inside the shelf");
        assert_eq!(shelves[1].id, "fresh");
    }

    #[test]
    fn feed_is_deterministic_per_day_and_rotates() {
        let today = shelves_for(&[], "2026-10-07");
        let again = shelves_for(&[], "2026-10-07");
        let ids = |shelves: &[StationShelf]| -> Vec<Vec<String>> {
            shelves
                .iter()
                .map(|shelf| {
                    shelf
                        .items
                        .iter()
                        .map(|pick| pick.station.stationuuid.clone())
                        .collect()
                })
                .collect()
        };
        assert_eq!(ids(&today), ids(&again));
        let tomorrow = shelves_for(&[], "2026-10-08");
        assert_ne!(ids(&today), ids(&tomorrow));
        let serialized = serde_json::to_value(&today[0]).unwrap();
        assert_eq!(serialized["kind"], serde_json::json!("fresh"));
        assert!(serialized["items"][0]["bailRate"].is_number());
        assert!(serialized["sceneId"].is_null());
    }

    #[test]
    fn stale_scenes_follow_the_24_hour_cadence() {
        let rows = vec![
            SceneRefreshRow {
                scene_id: "house".to_string(),
                refreshed_at: "2026-10-07T00:00:00+00:00".to_string(),
                station_count: 40,
            },
            SceneRefreshRow {
                scene_id: "techno".to_string(),
                refreshed_at: "2026-10-05T00:00:00+00:00".to_string(),
                station_count: 40,
            },
        ];
        let stale: Vec<&str> = stale_scenes(&rows, now())
            .iter()
            .map(|scene| scene.id)
            .collect();
        assert!(!stale.contains(&"house"));
        assert!(stale.contains(&"techno"));
        assert!(stale.contains(&"jazz"), "never-refreshed scenes are stale");
        assert_eq!(stale.len(), SCENES.len() - 1);
        assert_eq!(cache_age_seconds(&rows, now()), Some(12 * 60 * 60));
        assert_eq!(cache_age_seconds(&[], now()), None);
    }

    #[test]
    fn scene_page_is_ranked_without_shuffle_and_skips_excluded_rows() {
        let mut rows: Vec<SceneStationRow> = fixture_rows()
            .into_iter()
            .filter(|row| row.scene_id == "house")
            .collect();
        rows[0].fail_count = 2;
        let signals = HashMap::new();
        let scene = find_scene("house").unwrap();
        let page = rank_scene_page(&rows, &signals, scene, now());
        assert_eq!(page.len(), 29);
        assert_eq!(page[0].station.stationuuid, "house-01");
        assert!(page.windows(2).all(|pair| pair[0].score >= pair[1].score));
        assert_eq!(page[0].scene_id.as_deref(), Some("house"));
    }

    #[test]
    fn cache_queries_round_trip_and_keep_health_through_refresh() {
        let db = crate::db::init_memory_db().unwrap();
        let mut rows = vec![row("house", "a", 10), row("house", "b", 5)];
        queries::upsert_scene_stations(&db, &rows).unwrap();
        queries::update_scene_station_health(&db, "a", 1, "2026-10-07T01:00:00+00:00").unwrap();
        rows[0].votes = 99;
        queries::upsert_scene_stations(&db, &rows).unwrap();
        let cached = queries::get_scene_stations_for_scene(&db, "house").unwrap();
        let a = cached.iter().find(|row| row.station_uuid == "a").unwrap();
        assert_eq!((a.votes, a.fail_count), (99, 1));
        assert_eq!(
            a.last_checked_at.as_deref(),
            Some("2026-10-07T01:00:00+00:00")
        );

        let oldest = queries::get_scene_stations_oldest_checked(&db, 10).unwrap();
        assert_eq!(oldest[0].station_uuid, "b", "never-checked rows come first");

        // Only rows missing from the directory *and* failed three times prune.
        queries::update_scene_station_health(&db, "b", 3, "2026-10-07T01:00:00+00:00").unwrap();
        let keep: HashSet<String> = ["a".to_string()].into_iter().collect();
        assert_eq!(
            queries::prune_scene_stations(&db, "house", &keep).unwrap(),
            1
        );
        assert_eq!(queries::count_scene_stations(&db).unwrap(), 1);

        let salt = queries::get_or_create_install_salt(&db).unwrap();
        assert_eq!(queries::get_or_create_install_salt(&db).unwrap(), salt);
        queries::upsert_scene_refresh(&db, "house", "2026-10-07T00:00:00+00:00", 1).unwrap();
        let refresh = queries::get_scene_refresh_rows(&db).unwrap();
        assert_eq!(refresh.len(), 1, "the salt row is not a scene");
        assert_eq!(refresh[0].scene_id, "house");
    }

    // ── Tag focus ──

    /// A real-world shape of a dedicated hip-hop station: a handful of
    /// tags, all from the hip-hop/R&B side, the genre leading the list.
    const GENUINE_HIPHOP_NAME: &str = "HOT 108 JAMZ - #1 for Hip Hop";
    const GENUINE_HIPHOP_TAGS: &str = "hip hop,hiphop,rap,r&b,urban";
    /// The "every genre" shape: dozens of tags across every family so the
    /// station surfaces for any tag search. It also has far more votes.
    const SPAM_NAME: &str = "RADIO MEGAMIX 24/7 :: Hip Hop Rap Techno House Jazz Country Rock Pop";
    const SPAM_TAGS: &str = "00s,70s,80s,90s,ambient,blues,chillout,classical,country,dance,edm,hip hop,house,jazz,latin,metal,news,oldies,pop,r&b,rap,reggae,rock,soul,techno,top 40,trance";
    /// A quieter variant: only five tags, but rap + techno + jazz + country.
    const SCATTERED_TAGS: &str = "rap,techno,jazz,country,hits";

    fn tagged_row(
        scene_id: &str,
        uuid: &str,
        name: &str,
        tags: &str,
        votes: i64,
    ) -> SceneStationRow {
        let mut row = row(scene_id, uuid, votes);
        row.name = name.to_string();
        row.tags = Some(tags.to_string());
        row
    }

    #[test]
    fn tag_focus_separates_a_genuine_hiphop_station_from_genre_spam() {
        let scene = find_scene("hip-hop").unwrap();

        let genuine = tag_focus(scene, GENUINE_HIPHOP_NAME, Some(GENUINE_HIPHOP_TAGS));
        assert_eq!(genuine.tag_count, 5);
        assert_eq!(genuine.families, 2, "hip-hop + soul (r&b)");
        assert!(genuine.prominent && genuine.relevant);
        assert!((genuine.score - 1.0).abs() < 1e-9, "{genuine:?}");

        let spam = tag_focus(scene, SPAM_NAME, Some(SPAM_TAGS));
        assert_eq!(spam.tag_count, 27);
        assert!(spam.families >= 10, "{spam:?}");
        assert!(
            spam.score < FOCUS_EXCLUDE_BELOW,
            "every-genre stations are excluded from the scene: {spam:?}"
        );

        let scattered = tag_focus(scene, "Mixed Signals FM", Some(SCATTERED_TAGS));
        assert_eq!(scattered.families, 5, "{scattered:?}");
        assert!(
            scattered.score >= FOCUS_EXCLUDE_BELOW && scattered.score < 0.5,
            "{scattered:?}"
        );

        // A techno station tagged with a stray "rap" is not a hip-hop station.
        let techno = tag_focus(
            scene,
            "Berlin Warehouse",
            Some("techno,minimal techno,electronic"),
        );
        assert!(!techno.relevant);
        assert_eq!(techno.score, 0.0);

        // Electronic sub-genres are one family: a focused techno station is
        // fully focused for the techno scene.
        let techno_scene = find_scene("techno").unwrap();
        let focused = tag_focus(
            techno_scene,
            "Berlin Warehouse",
            Some("techno,minimal techno,electronic,house,dance"),
        );
        assert!((focused.score - 1.0).abs() < 1e-9, "{focused:?}");
    }

    #[test]
    fn broad_scenes_tolerate_genre_spread_but_not_tag_spam() {
        let workout = find_scene("workout").unwrap();
        let gym = tag_focus(
            workout,
            "__WORKOUT__ by rautemusik",
            Some("dance,hip hop,hits,non-stop music,training,workout"),
        );
        assert!(gym.prominent, "the name carries the scene term");
        assert!(gym.score > 0.9, "{gym:?}");
        let spam = tag_focus(workout, SPAM_NAME, Some(&format!("{SPAM_TAGS},workout")));
        assert!(spam.score < FOCUS_EXCLUDE_BELOW, "{spam:?}");
    }

    #[test]
    fn genuine_hiphop_station_outranks_spam_with_ten_times_the_votes() {
        let now = now();
        let genuine = tagged_row(
            "hip-hop",
            "genuine",
            GENUINE_HIPHOP_NAME,
            GENUINE_HIPHOP_TAGS,
            300,
        );
        let scattered = tagged_row(
            "hip-hop",
            "scattered",
            "Mixed Signals FM",
            SCATTERED_TAGS,
            3_000,
        );
        let spam = tagged_row("hip-hop", "spam", SPAM_NAME, SPAM_TAGS, 9_000);

        let genuine_score = rank_score(&genuine, None, now);
        let scattered_score = rank_score(&scattered, None, now);
        assert!(
            genuine_score > scattered_score + 1.0,
            "genuine {genuine_score} vs scattered {scattered_score}"
        );
        assert!(!is_shelf_eligible(&spam), "spam is excluded outright");
        assert!(is_shelf_eligible(&scattered));

        // The ranked "See all" page and the shelf both lead with it.
        let rows = vec![spam.clone(), scattered.clone(), genuine.clone()];
        let scene = find_scene("hip-hop").unwrap();
        let page = rank_scene_page(&rows, &HashMap::new(), scene, now);
        let uuids: Vec<&str> = page
            .iter()
            .map(|p| p.station.stationuuid.as_str())
            .collect();
        assert_eq!(uuids, vec!["genuine", "scattered"]);

        // And the refresh never caches the every-genre station for the scene.
        let directory = vec![
            serde_json::from_value::<RadioBrowserStation>(serde_json::json!({
                "name": SPAM_NAME, "url": "https://radio.example/spam", "hls": 0,
                "homepage": null, "favicon": null, "country": "US", "language": null,
                "tags": SPAM_TAGS, "codec": "MP3", "bitrate": 128, "votes": 9000,
                "stationuuid": "spam"
            }))
            .unwrap(),
            serde_json::from_value::<RadioBrowserStation>(serde_json::json!({
                "name": GENUINE_HIPHOP_NAME, "url": "https://radio.example/genuine", "hls": 0,
                "homepage": null, "favicon": null, "country": "US", "language": null,
                "tags": GENUINE_HIPHOP_TAGS, "codec": "MP3", "bitrate": 128, "votes": 300,
                "stationuuid": "genuine"
            }))
            .unwrap(),
        ];
        let prepared = prepare_scene_rows(scene, directory, "2026-10-07T00:00:00+00:00");
        let kept: Vec<&str> = prepared.iter().map(|r| r.station_uuid.as_str()).collect();
        assert_eq!(kept, vec!["genuine"]);
    }

    // ── Verified-only surfacing ──

    #[test]
    fn verification_needs_a_recent_ok_probe() {
        let now = now();
        let mut station = row("house", "a", 10);
        assert!(is_verified(&station, now));
        station.last_checked_at = Some("2026-09-29T12:00:00+00:00".to_string());
        assert!(!is_verified(&station, now), "8 days old is not recent");
        station.last_checked_at = None;
        assert!(!is_verified(&station, now), "never probed");
        station.last_checked_at = Some("2026-10-07T11:00:00+00:00".to_string());
        station.fail_count = 1;
        assert!(!is_verified(&station, now), "a recent failure is not OK");
    }

    #[test]
    fn shelves_lead_with_verified_picks_and_skip_scenes_with_none() {
        let mut rows = fixture_rows();
        // House: only three stations verified, and they are low-voted.
        for row in rows.iter_mut().filter(|row| row.scene_id == "house") {
            let index: usize = row.station_uuid[6..].parse().unwrap();
            if index < 27 {
                row.last_checked_at = None;
            }
        }
        // Jazz: nothing verified at all.
        for row in rows.iter_mut().filter(|row| row.scene_id == "jazz") {
            row.last_checked_at = None;
        }
        let favorites = HashSet::new();
        let shelves = assemble_shelves(&FeedInputs {
            rows: &rows,
            plays: &[],
            favorite_uuids: &favorites,
            install_salt: "install-salt",
            date: "2026-10-07",
            now: now(),
        });
        for shelf in &shelves {
            assert!(
                shelf.items[0].verified,
                "shelf {} leads unverified",
                shelf.id
            );
            let first_unverified = shelf.items.iter().position(|pick| !pick.verified);
            if let Some(position) = first_unverified {
                assert!(
                    shelf.items[position..].iter().all(|pick| !pick.verified),
                    "shelf {}: verified after unverified",
                    shelf.id
                );
            }
        }
        let house = shelves
            .iter()
            .find(|shelf| shelf.id == "scene:house")
            .unwrap();
        assert_eq!(house.items.len(), 8);
        assert_eq!(house.items.iter().filter(|pick| pick.verified).count(), 3);
        let verified: HashSet<&str> = house.items[..3]
            .iter()
            .map(|pick| pick.station.stationuuid.as_str())
            .collect();
        assert_eq!(
            verified,
            ["house-27", "house-28", "house-29"].into_iter().collect()
        );
        assert!(
            shelves.iter().all(|shelf| shelf.id != "scene:jazz"),
            "a scene with no verified station has no shelf"
        );
        let serialized = serde_json::to_value(&house.items[0]).unwrap();
        assert_eq!(serialized["verified"], serde_json::json!(true));
        assert!(serialized["lastCheckedAt"].is_string());
    }

    #[test]
    fn probe_targets_cover_shelf_candidates_due_a_check() {
        let now = now();
        let mut rows = fixture_rows();
        for row in rows.iter_mut() {
            let index: usize = row
                .station_uuid
                .rsplit('-')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            row.last_checked_at = match index % 3 {
                0 => None,
                1 => Some("2026-10-07T06:00:00+00:00".to_string()), // fresh
                _ => Some("2026-10-02T00:00:00+00:00".to_string()), // due
            };
        }
        let candidates = shelf_candidate_rows(&rows, &[], now);
        // 3 scenes x top 24, plus fresh candidates from the same pool.
        assert_eq!(candidates.len(), 90);
        let targets = select_probe_targets(&rows, &[], now, 500);
        assert!(targets.iter().all(|row| needs_check(row, now)));
        assert!(targets
            .iter()
            .all(|row| row.last_checked_at.as_deref() != Some("2026-10-07T06:00:00+00:00")));
        let first_checked = targets
            .iter()
            .position(|row| row.last_checked_at.is_some())
            .unwrap();
        assert!(targets[..first_checked]
            .iter()
            .all(|row| row.last_checked_at.is_none()));
        assert!(targets[first_checked..]
            .iter()
            .all(|row| row.last_checked_at.is_some()));
        assert_eq!(select_probe_targets(&rows, &[], now, 5).len(), 5);

        // A row that failed once is re-checked after 12 h, not 72 h.
        let mut failed = row("house", "x", 10);
        failed.fail_count = 1;
        failed.last_checked_at = Some("2026-10-06T23:00:00+00:00".to_string());
        assert!(needs_check(&failed, now));
        failed.last_checked_at = Some("2026-10-07T06:00:00+00:00".to_string());
        assert!(!needs_check(&failed, now));
    }

    #[test]
    fn a_failed_play_takes_the_station_off_every_shelf() {
        let db = crate::db::init_memory_db().unwrap();
        let mut rows = vec![row("house", "a", 10), row("techno", "a", 10)];
        rows.push(row("house", "b", 5));
        queries::upsert_scene_stations(&db, &rows).unwrap();
        queries::update_scene_station_health(&db, "a", 0, "2026-10-07T01:00:00+00:00").unwrap();
        mark_station_unplayable(&db, "A").unwrap();
        let cached = queries::get_all_scene_stations(&db).unwrap();
        for row in cached.iter().filter(|row| row.station_uuid == "a") {
            assert_eq!(row.fail_count, 2);
            assert!(!is_shelf_eligible(row));
        }
        let b = cached.iter().find(|row| row.station_uuid == "b").unwrap();
        assert_eq!(b.fail_count, 0);

        // A later successful play restores it.
        mark_station_playable(&db, "a").unwrap();
        let cached = queries::get_all_scene_stations(&db).unwrap();
        assert!(cached
            .iter()
            .filter(|row| row.station_uuid == "a")
            .all(|row| row.fail_count == 0 && row.last_checked_at.is_some()));
    }

    #[test]
    fn every_scene_term_maps_to_its_own_family_or_is_broad() {
        // Guards the relevance rule: a genre scene whose terms map to no
        // genre family would accept any station.
        for scene in SCENES {
            let families: HashSet<GenreFamily> = scene
                .tags
                .iter()
                .flat_map(|term| families_of(&normalize_words(term)))
                .collect();
            assert!(
                is_broad_scene(scene) || !families.is_empty(),
                "scene {} has no genre family",
                scene.id
            );
        }
    }
}
