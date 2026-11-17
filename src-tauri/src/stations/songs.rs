//! Songs heard on stations. Each new in-band stream title becomes the
//! station's "now playing" and a row in `station_songs`, so a song heard on
//! the radio can be found again. Tempo and key come from the station when it
//! publishes them (BadRadio does) and otherwise from the analyzer.

use crate::audio::{icy, song_sense};
use crate::db::{models::PlaybackState, models::StreamNowPlaying, queries, DbPool};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// A title heard again within this long after its row ended (a reconnect,
/// a pause) continues that row instead of logging the song twice.
const REOPEN_WITHIN_SECS: i64 = 10 * 60;

struct Current {
    log_id: String,
    station_id: String,
}

fn current() -> &'static Mutex<Option<Current>> {
    static CURRENT: OnceLock<Mutex<Option<Current>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

/// The callback the live download worker calls with each new title.
pub fn title_callback(
    db: DbPool,
    state: Arc<Mutex<PlaybackState>>,
    playback_session: Arc<AtomicU64>,
    session_id: u64,
    station_id: String,
    station_name: String,
    url: String,
) -> crate::audio::http_stream::TitleCallback {
    Box::new(move |title: String| {
        if playback_session.load(Ordering::SeqCst) != session_id {
            return;
        }
        on_title(&db, &state, &station_id, &station_name, &url, title);
        let provider = extras_provider(&url);
        if let Some(provider) = provider {
            let (db, state, playback_session) = (
                db.clone(),
                Arc::clone(&state),
                Arc::clone(&playback_session),
            );
            let _ = std::thread::Builder::new()
                .name("station-extras".to_string())
                .spawn(move || fetch_extras(provider, &db, &state, &playback_session, session_id));
        }
    })
}

fn on_title(
    db: &DbPool,
    state: &Arc<Mutex<PlaybackState>>,
    station_id: &str,
    station_name: &str,
    _url: &str,
    title: String,
) {
    finish_current(db);
    song_sense::reset();
    let (artist, track) = icy::split_title(&title);
    let log_id = queries::reopen_station_song(db, station_id, &title, REOPEN_WITHIN_SECS)
        .ok()
        .flatten()
        .or_else(|| {
            queries::start_station_song(
                db,
                Some(station_id),
                station_name,
                &title,
                artist.as_deref(),
                track.as_deref(),
            )
            .map_err(|err| log::warn!("station songs: could not log {title:?}: {err}"))
            .ok()
        });
    log::info!("station {station_id}: now playing {title:?}");
    {
        let mut s = state.lock();
        if s.current_station_id.as_deref() != Some(station_id) {
            return;
        }
        s.stream = Some(StreamNowPlaying {
            title,
            artist,
            track,
            started_at: queries::now(),
            log_id: log_id.clone(),
            ..Default::default()
        });
        // The lock screen only hears about state changes the engine emits.
        #[cfg(target_os = "ios")]
        crate::audio::now_playing::update(&s);
    }
    if let Some(log_id) = log_id {
        *current().lock() = Some(Current {
            log_id,
            station_id: station_id.to_string(),
        });
    }
}

/// Ends the open row, keeping the measured tempo and key with it.
pub fn finish_current(db: &DbPool) {
    let Some(done) = current().lock().take() else {
        return;
    };
    let (bpm, key) = song_sense::snapshot();
    if bpm.is_some() || key.is_some() {
        let _ = queries::update_station_song_details(
            db,
            &done.log_id,
            bpm.map(f64::from),
            key.as_deref(),
            Some("measured"),
            None,
        );
    }
    let _ = queries::end_station_song(db, &done.log_id);
}

/// Brings a polled state up to date: closes the row once the station is no
/// longer playing, and fills in measured tempo and key while it is.
pub fn sync_state(db: &DbPool, state: &mut PlaybackState) {
    let playing_radio =
        state.source.as_deref() == Some("radio") && (state.is_playing || state.is_buffering);
    let open_station = current().lock().as_ref().map(|c| c.station_id.clone());
    if let Some(open_station) = open_station {
        if !playing_radio || state.current_station_id.as_deref() != Some(&open_station) {
            finish_current(db);
        }
    }
    if state.source.as_deref() != Some("radio") {
        state.stream = None;
        return;
    }
    if let Some(stream) = state.stream.as_mut() {
        if stream.tempo_source.as_deref() != Some("station") {
            let (bpm, key) = song_sense::snapshot();
            if bpm.is_some() || key.is_some() {
                stream.bpm = bpm.map(f64::from);
                stream.musical_key = key;
                stream.tempo_source = Some("measured".to_string());
            }
        }
    }
}

// ── Stations that publish more than a title ──

#[derive(Clone, Copy)]
enum ExtrasProvider {
    BadRadio,
}

fn extras_provider(url: &str) -> Option<ExtrasProvider> {
    let lower = url.to_ascii_lowercase();
    (lower.contains("radio.co/s2b2b68744") || lower.contains("badradio"))
        .then_some(ExtrasProvider::BadRadio)
}

struct Extras {
    title: String,
    bpm: Option<f64>,
    key: Option<String>,
    artwork: Option<String>,
}

fn fetch_extras(
    provider: ExtrasProvider,
    db: &DbPool,
    state: &Arc<Mutex<PlaybackState>>,
    playback_session: &Arc<AtomicU64>,
    session_id: u64,
) {
    // The site's status can trail the stream by a few seconds.
    for attempt in 0..4 {
        std::thread::sleep(Duration::from_secs(if attempt == 0 { 2 } else { 6 }));
        if playback_session.load(Ordering::SeqCst) != session_id {
            return;
        }
        let extras = match provider {
            ExtrasProvider::BadRadio => fetch_badradio(),
        };
        let Some(extras) = extras else { continue };
        let mut s = state.lock();
        let Some(stream) = s.stream.as_mut() else {
            return;
        };
        if !same_song(&stream.title, &extras.title) {
            continue;
        }
        if extras.bpm.is_some() || extras.key.is_some() {
            stream.bpm = extras.bpm;
            stream.musical_key = extras.key.clone();
            stream.tempo_source = Some("station".to_string());
        }
        if extras.artwork.is_some() {
            stream.artwork_url = extras.artwork.clone();
        }
        let log_id = stream.log_id.clone();
        #[cfg(target_os = "ios")]
        crate::audio::now_playing::update(&s);
        drop(s);
        if let Some(log_id) = log_id {
            let source = (extras.bpm.is_some() || extras.key.is_some()).then_some("station");
            let _ = queries::update_station_song_details(
                db,
                &log_id,
                extras.bpm,
                extras.key.as_deref(),
                source,
                extras.artwork.as_deref(),
            );
        }
        return;
    }
}

fn fetch_badradio() -> Option<Extras> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("mewsik/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let body: serde_json::Value = client
        .get("https://www.badradio.nz/api/radio/status")
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()?;
    parse_badradio(&body)
}

fn parse_badradio(body: &serde_json::Value) -> Option<Extras> {
    let title = body.pointer("/current_track/title")?.as_str()?.to_string();
    let meta = body.get("current_meta");
    let text = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(Extras {
        bpm: meta
            .and_then(|m| m.get("bpm"))
            .and_then(|v| v.as_f64())
            .filter(|bpm| (30.0..=300.0).contains(bpm)),
        key: text(meta.and_then(|m| m.get("key"))),
        artwork: text(meta.and_then(|m| m.get("artwork")))
            .or_else(|| text(body.pointer("/current_track/artwork_url_large"))),
        title,
    })
}

fn same_song(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_badradio_status() {
        let body = serde_json::json!({
            "current_track": {"title": "ROLAND JONES - DEMONZ (feat. TRIPLE TIX)",
                              "artwork_url_large": "https://example.com/600.jpg"},
            "current_meta": {"track": "DEMONZ (feat. TRIPLE TIX)", "bpm": 130, "key": "Cm",
                             "artwork": "https://example.com/meta.jpg"}
        });
        let extras = parse_badradio(&body).unwrap();
        assert_eq!(extras.bpm, Some(130.0));
        assert_eq!(extras.key.as_deref(), Some("Cm"));
        assert_eq!(
            extras.artwork.as_deref(),
            Some("https://example.com/meta.jpg")
        );
        assert!(same_song(
            &extras.title,
            "Roland Jones - DEMONZ (feat. Triple Tix)"
        ));
        assert!(!same_song(&extras.title, "Goupil. - MAKE 'EM BACKUP"));
    }

    #[test]
    fn logs_each_song_once_and_keeps_station_tempo() {
        let db = crate::db::init_memory_db().unwrap();
        let first = queries::start_station_song(
            &db,
            Some("s1"),
            "BadRadio",
            "A - One",
            Some("A"),
            Some("One"),
        )
        .unwrap();
        queries::update_station_song_details(
            &db,
            &first,
            Some(130.0),
            Some("Cm"),
            Some("station"),
            None,
        )
        .unwrap();
        // A measured value never replaces what the station published.
        queries::update_station_song_details(
            &db,
            &first,
            Some(65.0),
            Some("G"),
            Some("measured"),
            None,
        )
        .unwrap();
        queries::end_station_song(&db, &first).unwrap();
        // The same title right after a reconnect continues the row.
        assert_eq!(
            queries::reopen_station_song(&db, "s1", "A - One", 600).unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            queries::reopen_station_song(&db, "s1", "B - Two", 600).unwrap(),
            None
        );
        let rows = queries::list_station_songs(&db, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].bpm, Some(130.0));
        assert_eq!(rows[0].musical_key.as_deref(), Some("Cm"));
        assert!(rows[0].ended_at.is_none());
    }

    #[test]
    fn knows_which_stations_publish_extras() {
        assert!(extras_provider("https://s2.radio.co/s2b2b68744/listen").is_some());
        assert!(extras_provider("http://stream.bassdrive.uk:8200/").is_none());
    }
}
