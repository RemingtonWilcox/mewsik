//! Station logo cache.
//!
//! Directory favicons are untrusted remote images, so the WebView never
//! loads them itself. The frontend names a station (its radio-browser UUID
//! or saved station id); the backend resolves the favicon URL it already
//! knows, fetches it through the public-network boundary in `network.rs`,
//! accepts only small raster images identified by their magic bytes, caches
//! them on disk and hands the WebView a `data:` URL. Misses are remembered
//! for a day so dead favicon hosts are not hit on every launch.

use super::directory::{lookup_station_favicon_by_uuid, normalize_station_uuid};
use super::network::{
    parse_public_http_url, send_public_get_following_redirects, MAX_PUBLIC_REDIRECTS,
};
use crate::db::{queries, DbPool};
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Folder under `AppConfig::data_dir()`.
pub const LOGO_CACHE_DIR: &str = "station-logos";
pub(crate) const MAX_LOGO_BYTES: usize = 512 * 1024;
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Whole-fetch ceiling across redirect hops; each hop also has the
/// boundary's own 5 s client timeout.
const LOGO_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MISS_EXTENSION: &str = "miss";
const MAX_STATION_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Ico,
}

impl LogoFormat {
    const ALL: [LogoFormat; 5] = [
        LogoFormat::Png,
        LogoFormat::Jpeg,
        LogoFormat::Gif,
        LogoFormat::Webp,
        LogoFormat::Ico,
    ];

    fn extension(self) -> &'static str {
        match self {
            LogoFormat::Png => "png",
            LogoFormat::Jpeg => "jpg",
            LogoFormat::Gif => "gif",
            LogoFormat::Webp => "webp",
            LogoFormat::Ico => "ico",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            LogoFormat::Png => "image/png",
            LogoFormat::Jpeg => "image/jpeg",
            LogoFormat::Gif => "image/gif",
            LogoFormat::Webp => "image/webp",
            LogoFormat::Ico => "image/x-icon",
        }
    }
}

/// Identify a supported raster image by its leading bytes. The declared
/// Content-Type is never trusted; SVG, HTML and anything else is `None`.
pub fn sniff_logo_format(bytes: &[u8]) -> Option<LogoFormat> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(LogoFormat::Png);
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(LogoFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(LogoFormat::Gif);
    }
    if bytes.len() >= 16 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(LogoFormat::Webp);
    }
    // ICONDIR: reserved 0, type 1 (icon, not cursor), at least one image,
    // followed by at least one 16-byte directory entry.
    if bytes.len() >= 22 && bytes.starts_with(&[0, 0, 1, 0]) {
        let count = u16::from_le_bytes([bytes[4], bytes[5]]);
        if count > 0 {
            return Some(LogoFormat::Ico);
        }
    }
    None
}

fn data_url(format: LogoFormat, bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        format.mime(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Append one body chunk, refusing to grow past `cap`.
fn push_capped(body: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > cap {
        return Err(format!("Station logo is larger than {cap} bytes"));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// The only URLs a logo may come from: public http(s) hosts. Everything
/// else (data:, file:, javascript:, private addresses...) is refused before
/// any request is made. Redirect hops are rechecked by the network boundary.
fn parse_logo_url(value: &str) -> Result<reqwest::Url, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Station has no logo".to_string());
    }
    parse_public_http_url(trimmed)
}

async fn fetch_logo(value: &str) -> Result<(LogoFormat, Vec<u8>), String> {
    let url = parse_logo_url(value)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("image/png,image/webp,image/jpeg,image/gif,image/x-icon;q=0.9"),
    );
    let fetch = async move {
        let (mut response, _) =
            send_public_get_following_redirects(&url, headers, MAX_PUBLIC_REDIRECTS).await?;
        if !response.status().is_success() {
            return Err(format!(
                "Station logo request failed: {}",
                response.status()
            ));
        }
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("svg"))
        {
            return Err("Station logo is SVG".to_string());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_LOGO_BYTES as u64)
        {
            return Err(format!(
                "Station logo is larger than {MAX_LOGO_BYTES} bytes"
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| format!("Station logo download failed: {err}"))?
        {
            push_capped(&mut body, &chunk, MAX_LOGO_BYTES)?;
        }
        let format = sniff_logo_format(&body)
            .ok_or_else(|| "Station logo is not a supported raster image".to_string())?;
        Ok((format, body))
    };
    tokio::time::timeout(LOGO_FETCH_TIMEOUT, fetch)
        .await
        .map_err(|_| "Station logo request timed out".to_string())?
}

// ── Disk cache ──

/// File stem for a station's cache entries. Radio-browser UUIDs are used
/// as-is (already validated hex); saved stations without one are hashed so
/// no caller-supplied text reaches the file system.
pub fn logo_cache_key(station_uuid: Option<&str>, station_id: Option<&str>) -> Option<String> {
    if let Some(uuid) = station_uuid.and_then(normalize_station_uuid) {
        return Some(format!("rb-{uuid}"));
    }
    let id = station_id.map(str::trim).filter(|id| !id.is_empty())?;
    let digest = Sha256::digest(format!("station:{id}").as_bytes());
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(format!("st-{hex}"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum CachedLogo {
    /// A cached image, as a `data:` URL.
    Hit(String),
    /// A remembered miss that has not expired.
    Miss,
    /// Nothing usable on disk.
    Absent,
}

fn logo_path(dir: &Path, key: &str, format: LogoFormat) -> PathBuf {
    dir.join(format!("{key}.{}", format.extension()))
}

fn miss_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.{MISS_EXTENSION}"))
}

pub fn read_cached_logo(dir: &Path, key: &str, now: SystemTime) -> CachedLogo {
    for format in LogoFormat::ALL {
        let path = logo_path(dir, key, format);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        // Re-sniff: a truncated or foreign file is dropped, not served.
        match sniff_logo_format(&bytes) {
            Some(actual) if bytes.len() <= MAX_LOGO_BYTES => {
                return CachedLogo::Hit(data_url(actual, &bytes))
            }
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let miss = miss_path(dir, key);
    if let Ok(modified) = std::fs::metadata(&miss).and_then(|meta| meta.modified()) {
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age < NEGATIVE_CACHE_TTL {
            return CachedLogo::Miss;
        }
        let _ = std::fs::remove_file(&miss);
    }
    CachedLogo::Absent
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension(format!("tmp-{}", ulid::Ulid::new()));
    let result = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub fn store_logo(dir: &Path, key: &str, format: LogoFormat, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for other in LogoFormat::ALL {
        if other != format {
            let _ = std::fs::remove_file(logo_path(dir, key, other));
        }
    }
    write_atomically(&logo_path(dir, key, format), bytes)?;
    let _ = std::fs::remove_file(miss_path(dir, key));
    Ok(())
}

pub fn store_miss(dir: &Path, key: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_atomically(&miss_path(dir, key), b"")
}

// ── Resolution ──

/// Where a station's favicon URL comes from. `Unknown` means the directory
/// could not be reached, so nothing is remembered.
#[derive(Debug, PartialEq, Eq)]
enum FaviconSource {
    Url(String),
    None,
    Unknown,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Resolve a station to its cache key and the favicon URL the backend
/// already holds (saved row, then scene cache). Only the directory lookup
/// is left to the caller, as it needs the network.
fn resolve_local(
    db: &DbPool,
    station_uuid: Option<String>,
    station_id: Option<String>,
) -> Result<Option<(String, Option<String>, Option<FaviconSource>)>, String> {
    let saved = match station_id.as_deref() {
        Some(id) => queries::get_station_by_id(db, id).map_err(|err| err.to_string())?,
        None => None,
    };
    if station_id.is_some() && saved.is_none() && station_uuid.is_none() {
        return Ok(None);
    }

    let uuid = station_uuid.or_else(|| {
        saved
            .as_ref()
            .and_then(|station| station.radio_browser_id.as_deref())
            .and_then(normalize_station_uuid)
    });
    let Some(key) = logo_cache_key(uuid.as_deref(), station_id.as_deref()) else {
        return Ok(None);
    };

    if let Some(url) = saved.and_then(|station| non_empty(station.favicon_url)) {
        return Ok(Some((key, uuid, Some(FaviconSource::Url(url)))));
    }
    if let Some(uuid) = uuid.as_deref() {
        if let Some(favicon) =
            queries::get_scene_station_favicon(db, uuid).map_err(|err| err.to_string())?
        {
            let source = match favicon {
                Some(url) => FaviconSource::Url(url),
                None => FaviconSource::None,
            };
            return Ok(Some((key, Some(uuid.to_string()), Some(source))));
        }
    }
    let source = if uuid.is_some() {
        None
    } else {
        Some(FaviconSource::None)
    };
    Ok(Some((key, uuid, source)))
}

/// The station's logo as a `data:` URL, or `None` when it has none (or it
/// could not be fetched). Never returns the remote URL.
pub async fn get_station_logo(
    db: &DbPool,
    cache_dir: &Path,
    station_uuid: Option<String>,
    station_id: Option<String>,
) -> Result<Option<String>, String> {
    let station_uuid = match station_uuid.map(|uuid| uuid.trim().to_string()) {
        Some(uuid) if !uuid.is_empty() => Some(
            normalize_station_uuid(&uuid)
                .ok_or_else(|| "Radio Browser station id is invalid".to_string())?,
        ),
        _ => None,
    };
    let station_id = non_empty(station_id);
    if station_id
        .as_ref()
        .is_some_and(|id| id.len() > MAX_STATION_ID_BYTES)
    {
        return Err("Station id is invalid".to_string());
    }

    let Some((key, uuid, source)) = resolve_local(db, station_uuid, station_id)? else {
        return Ok(None);
    };

    match read_cached_logo(cache_dir, &key, SystemTime::now()) {
        CachedLogo::Hit(url) => return Ok(Some(url)),
        CachedLogo::Miss => return Ok(None),
        CachedLogo::Absent => {}
    }

    let source = match (source, uuid) {
        (Some(source), _) => source,
        (None, Some(uuid)) => match lookup_station_favicon_by_uuid(&uuid).await {
            Ok(Some(url)) => FaviconSource::Url(url),
            Ok(None) => FaviconSource::None,
            Err(()) => FaviconSource::Unknown,
        },
        (None, None) => FaviconSource::None,
    };

    let url = match source {
        FaviconSource::Url(url) => url,
        FaviconSource::None => {
            let _ = store_miss(cache_dir, &key);
            return Ok(None);
        }
        FaviconSource::Unknown => return Ok(None),
    };

    match fetch_logo(&url).await {
        Ok((format, bytes)) => {
            if let Err(err) = store_logo(cache_dir, &key, format, &bytes) {
                log::warn!("Could not cache station logo: {}", err);
            }
            Ok(Some(data_url(format, &bytes)))
        }
        Err(err) => {
            log::debug!("Station logo unavailable for {}: {}", key, err);
            let _ = store_miss(cache_dir, &key);
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::db::models::Station;
    use crate::db::queries::SceneStationRow;

    const UUID: &str = "9617a958-0601-11e8-ae97-52543be04c81";

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mewsik-logos-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0; 24]);
        bytes
    }

    fn ico() -> Vec<u8> {
        let mut bytes = vec![0, 0, 1, 0, 1, 0];
        bytes.extend_from_slice(&[0; 16]);
        bytes
    }

    #[test]
    fn magic_bytes_identify_supported_raster_formats() {
        assert_eq!(sniff_logo_format(&png()), Some(LogoFormat::Png));
        assert_eq!(
            sniff_logo_format(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]),
            Some(LogoFormat::Jpeg)
        );
        assert_eq!(sniff_logo_format(b"GIF89a\x01\x00"), Some(LogoFormat::Gif));
        assert_eq!(sniff_logo_format(b"GIF87a\x01\x00"), Some(LogoFormat::Gif));
        assert_eq!(
            sniff_logo_format(b"RIFF\x24\x00\x00\x00WEBPVP8 "),
            Some(LogoFormat::Webp)
        );
        assert_eq!(sniff_logo_format(&ico()), Some(LogoFormat::Ico));
    }

    #[test]
    fn svg_html_and_lookalikes_are_rejected() {
        for bytes in [
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".as_slice(),
            b"<?xml version=\"1.0\"?><svg/>".as_slice(),
            b"\xEF\xBB\xBF<svg></svg>".as_slice(),
            b"<!DOCTYPE html><html></html>".as_slice(),
            b"".as_slice(),
            b"\x89PNG".as_slice(),
            b"RIFF\x24\x00\x00\x00WAVEfmt ".as_slice(),
            // A cursor (type 2) and an icon directory with no images.
            &[
                0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
            &[
                0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
        ] {
            assert_eq!(
                sniff_logo_format(bytes),
                None,
                "{bytes:?} should be rejected"
            );
        }
    }

    #[test]
    fn body_growth_stops_at_the_size_cap() {
        let mut body = Vec::new();
        assert!(push_capped(&mut body, &[0; 300], 512).is_ok());
        assert!(push_capped(&mut body, &[0; 212], 512).is_ok());
        assert_eq!(body.len(), 512);
        assert!(push_capped(&mut body, &[0; 1], 512).is_err());
        assert_eq!(body.len(), 512, "a rejected chunk is not appended");

        let mut fresh = Vec::new();
        assert!(push_capped(&mut fresh, &vec![0; MAX_LOGO_BYTES + 1], MAX_LOGO_BYTES).is_err());
    }

    #[test]
    fn only_public_http_urls_may_be_fetched() {
        assert!(parse_logo_url("https://radio.example/favicon.png").is_ok());
        assert!(parse_logo_url("http://radio.example/logo.ico").is_ok());
        for url in [
            "",
            "   ",
            "data:image/png;base64,AAAA",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "ftp://radio.example/logo.png",
            "asset://localhost/logo.png",
            "http://localhost/logo.png",
            "http://127.0.0.1/logo.png",
            "http://192.168.1.10/logo.png",
            "http://[::1]/logo.png",
            "/favicon.ico",
        ] {
            assert!(parse_logo_url(url).is_err(), "{url} should be rejected");
        }
    }

    #[test]
    fn cache_keys_never_carry_caller_text_into_paths() {
        assert_eq!(
            logo_cache_key(Some(&UUID.to_ascii_uppercase()), None),
            Some(format!("rb-{UUID}"))
        );
        let hashed = logo_cache_key(Some("../../evil"), Some("../../evil")).unwrap();
        assert!(hashed.starts_with("st-"));
        assert!(hashed[3..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(logo_cache_key(None, Some("  ")), None);
        assert_eq!(logo_cache_key(None, None), None);
    }

    #[test]
    fn cached_logo_is_served_as_a_data_url() {
        let dir = temp_dir("hit");
        let key = logo_cache_key(Some(UUID), None).unwrap();
        assert_eq!(
            read_cached_logo(&dir, &key, SystemTime::now()),
            CachedLogo::Absent
        );

        store_miss(&dir, &key).unwrap();
        store_logo(&dir, &key, LogoFormat::Png, &png()).unwrap();
        assert!(
            !miss_path(&dir, &key).exists(),
            "a stored logo clears the miss"
        );
        match read_cached_logo(&dir, &key, SystemTime::now()) {
            CachedLogo::Hit(url) => assert!(url.starts_with("data:image/png;base64,")),
            other => panic!("expected a hit, got {other:?}"),
        }

        // A file that no longer sniffs as an image is dropped, not served.
        std::fs::write(logo_path(&dir, &key, LogoFormat::Png), b"<svg/>").unwrap();
        assert_eq!(
            read_cached_logo(&dir, &key, SystemTime::now()),
            CachedLogo::Absent
        );
        assert!(!logo_path(&dir, &key, LogoFormat::Png).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn misses_are_remembered_for_a_day() {
        let dir = temp_dir("miss");
        let key = logo_cache_key(None, Some("station-1")).unwrap();
        store_miss(&dir, &key).unwrap();
        let now = SystemTime::now();
        assert_eq!(read_cached_logo(&dir, &key, now), CachedLogo::Miss);
        assert_eq!(
            read_cached_logo(&dir, &key, now + Duration::from_secs(23 * 60 * 60)),
            CachedLogo::Miss
        );
        assert_eq!(
            read_cached_logo(&dir, &key, now + Duration::from_secs(25 * 60 * 60)),
            CachedLogo::Absent
        );
        assert!(
            !miss_path(&dir, &key).exists(),
            "an expired miss is removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn saved_station(id: &str, uuid: Option<&str>, favicon: Option<&str>) -> Station {
        Station {
            id: id.to_string(),
            name: "Test FM".to_string(),
            url: format!("https://radio.example/{id}"),
            homepage: None,
            favicon_url: favicon.map(str::to_string),
            favicon_path: None,
            country: None,
            language: None,
            tags: None,
            codec: None,
            bitrate: None,
            radio_browser_id: uuid.map(str::to_string),
            is_favorite: true,
            fail_count: 0,
            last_played_at: None,
            last_checked_at: None,
            created_at: queries::now(),
        }
    }

    fn scene_row(uuid: &str, favicon: Option<&str>) -> SceneStationRow {
        SceneStationRow {
            scene_id: "late-night".to_string(),
            station_uuid: uuid.to_string(),
            name: "Test FM".to_string(),
            url: "https://radio.example/live".to_string(),
            url_resolved: None,
            homepage: None,
            favicon: favicon.map(str::to_string),
            country: None,
            countrycode: None,
            language: None,
            tags: None,
            codec: None,
            bitrate: None,
            votes: 0,
            clickcount: 0,
            clicktrend: 0,
            fetched_at: queries::now(),
            fail_count: 0,
            last_checked_at: None,
        }
    }

    #[test]
    fn favicon_urls_resolve_from_saved_rows_and_the_scene_cache() {
        let db = init_memory_db().unwrap();
        queries::insert_station(
            &db,
            &saved_station("saved-1", Some(UUID), Some("https://radio.example/a.png")),
        )
        .unwrap();
        queries::insert_station(&db, &saved_station("saved-2", Some(UUID), None)).unwrap();
        queries::insert_station(&db, &saved_station("saved-3", None, None)).unwrap();
        queries::upsert_scene_stations(
            &db,
            &[scene_row(UUID, Some("https://radio.example/b.png"))],
        )
        .unwrap();

        let key = format!("rb-{UUID}");
        // A saved favicon wins and shares the UUID's cache entry.
        assert_eq!(
            resolve_local(&db, None, Some("saved-1".into())).unwrap(),
            Some((
                key.clone(),
                Some(UUID.to_string()),
                Some(FaviconSource::Url("https://radio.example/a.png".into()))
            ))
        );
        // Otherwise the scene cache, via the saved row's UUID.
        assert_eq!(
            resolve_local(&db, None, Some("saved-2".into())).unwrap(),
            Some((
                key.clone(),
                Some(UUID.to_string()),
                Some(FaviconSource::Url("https://radio.example/b.png".into()))
            ))
        );
        assert_eq!(
            resolve_local(&db, Some(UUID.into()), None)
                .unwrap()
                .unwrap()
                .2,
            Some(FaviconSource::Url("https://radio.example/b.png".into()))
        );
        // A saved station with no UUID and no favicon has nothing to fetch.
        let (_, uuid, source) = resolve_local(&db, None, Some("saved-3".into()))
            .unwrap()
            .unwrap();
        assert_eq!((uuid, source), (None, Some(FaviconSource::None)));
        // An unknown UUID is left to the directory lookup.
        let other = "00000000-0000-0000-0000-000000000001";
        assert_eq!(
            resolve_local(&db, Some(other.into()), None)
                .unwrap()
                .unwrap()
                .2,
            None
        );
        // An unknown saved id resolves to nothing.
        assert_eq!(
            resolve_local(&db, None, Some("missing".into())).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn command_serves_cache_hits_and_misses_without_network() {
        let db = init_memory_db().unwrap();
        let dir = temp_dir("command");
        queries::insert_station(&db, &saved_station("saved-1", None, None)).unwrap();

        // No favicon anywhere: a miss is remembered.
        assert_eq!(
            get_station_logo(&db, &dir, None, Some("saved-1".into()))
                .await
                .unwrap(),
            None
        );
        let saved_key = logo_cache_key(None, Some("saved-1")).unwrap();
        assert!(miss_path(&dir, &saved_key).exists());

        // A cached logo is returned without resolving or fetching anything.
        let key = logo_cache_key(Some(UUID), None).unwrap();
        store_logo(&dir, &key, LogoFormat::Ico, &ico()).unwrap();
        let url = get_station_logo(&db, &dir, Some(UUID.to_ascii_uppercase()), None)
            .await
            .unwrap()
            .unwrap();
        assert!(url.starts_with("data:image/x-icon;base64,"));

        // A remembered miss short-circuits too.
        let other = "00000000-0000-0000-0000-000000000002";
        store_miss(&dir, &logo_cache_key(Some(other), None).unwrap()).unwrap();
        assert_eq!(
            get_station_logo(&db, &dir, Some(other.into()), None)
                .await
                .unwrap(),
            None
        );

        assert!(get_station_logo(&db, &dir, Some("not-a-uuid".into()), None)
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
