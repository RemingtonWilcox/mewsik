use crate::db::{models::*, queries, DbPool};
use lofty::prelude::*;
use lofty::probe::Probe;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "alac", "wma", "aiff", "ape",
];

pub struct ScanResult {
    pub total_files: u32,
    pub new_tracks: u32,
    pub updated_tracks: u32,
    pub errors: Vec<String>,
}

pub fn scan_directory(db: &DbPool, dir_path: &str) -> ScanResult {
    let mut result = ScanResult {
        total_files: 0,
        new_tracks: 0,
        updated_tracks: 0,
        errors: Vec::new(),
    };

    for entry in WalkDir::new(dir_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());

        if ext
            .as_deref()
            .map_or(true, |e| !AUDIO_EXTENSIONS.contains(&e))
        {
            continue;
        }

        result.total_files += 1;
        let path_str = path.to_string_lossy().to_string();

        // Check if already scanned by path
        if let Ok(Some(_)) = queries::find_source_by_path(db, &path_str) {
            continue; // Already in library
        }

        // Compute content hash
        let content_hash = match compute_hash(path) {
            Ok(h) => h,
            Err(e) => {
                result
                    .errors
                    .push(format!("{}: hash error: {}", path_str, e));
                continue;
            }
        };

        // Check if known by hash (moved/renamed file)
        if let Ok(Some(existing)) = queries::find_source_by_hash(db, &content_hash) {
            // Update file path for the moved file
            let conn = db.lock();
            let _ = conn.execute(
                "UPDATE track_sources SET file_path = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![path_str, queries::now(), existing.id],
            );
            result.updated_tracks += 1;
            continue;
        }

        // Extract metadata
        match extract_metadata(path) {
            Ok(meta) => {
                let now = queries::now();

                // Find or create artist
                let artist_id = if let Some(ref artist_name) = meta.artist {
                    match queries::find_artist_by_name(db, artist_name) {
                        Ok(Some(a)) => a.id,
                        _ => {
                            let id = queries::new_id();
                            let sort_name = make_sort_name(artist_name);
                            let artist = Artist {
                                id: id.clone(),
                                name: artist_name.clone(),
                                sort_name: Some(sort_name),
                                musicbrainz_id: None,
                                image_path: None,
                                image_url: None,
                                bio: None,
                                metadata_json: None,
                                created_at: now.clone(),
                                updated_at: now.clone(),
                            };
                            let _ = queries::insert_artist(db, &artist);
                            id
                        }
                    }
                } else {
                    // Unknown artist
                    match queries::find_artist_by_name(db, "Unknown Artist") {
                        Ok(Some(a)) => a.id,
                        _ => {
                            let id = queries::new_id();
                            let artist = Artist {
                                id: id.clone(),
                                name: "Unknown Artist".to_string(),
                                sort_name: Some("Unknown Artist".to_string()),
                                musicbrainz_id: None,
                                image_path: None,
                                image_url: None,
                                bio: None,
                                metadata_json: None,
                                created_at: now.clone(),
                                updated_at: now.clone(),
                            };
                            let _ = queries::insert_artist(db, &artist);
                            id
                        }
                    }
                };

                // Find or create album
                let album_id = if let Some(ref album_title) = meta.album {
                    match queries::find_album_by_title_artist(db, album_title, &artist_id) {
                        Ok(Some(a)) => Some(a.id),
                        _ => {
                            let id = queries::new_id();
                            let album = Album {
                                id: id.clone(),
                                title: album_title.clone(),
                                year: meta.year,
                                genre: meta.genre.clone(),
                                track_count: None,
                                cover_art_path: None,
                                cover_art_url: None,
                                musicbrainz_id: None,
                                metadata_json: None,
                                created_at: now.clone(),
                                updated_at: now.clone(),
                            };
                            let _ = queries::insert_album(db, &album);
                            let _ = queries::link_album_artist(db, &id, &artist_id);
                            Some(id)
                        }
                    }
                } else {
                    None
                };

                // Create recording
                let recording_id = queries::new_id();
                let recording = Recording {
                    id: recording_id.clone(),
                    title: meta.title.unwrap_or_else(|| {
                        path.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Unknown")
                            .to_string()
                    }),
                    duration_ms: meta.duration_ms,
                    year: meta.year,
                    genre: meta.genre.clone(),
                    cover_art_path: None,
                    cover_art_url: None,
                    loudness_lufs: None,
                    musicbrainz_id: None,
                    metadata_json: None,
                    is_in_library: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                };
                if let Err(e) = queries::insert_recording(db, &recording) {
                    result
                        .errors
                        .push(format!("{}: insert error: {}", path_str, e));
                    continue;
                }

                // Link artist
                let _ = queries::link_recording_artist(db, &recording_id, &artist_id, "primary", 0);

                // Link album
                if let Some(ref album_id) = album_id {
                    let track_num = meta.track_number.unwrap_or(0);
                    let disc_num = meta.disc_number.unwrap_or(1);
                    let _ =
                        queries::link_album_track(db, album_id, &recording_id, disc_num, track_num);
                }

                // Create track source
                let format = ext.unwrap_or_default();
                let file_size = fs::metadata(path).map(|m| m.len() as i64).ok();
                let quality = match format.as_str() {
                    "flac" | "alac" | "wav" | "aiff" => 100,
                    "opus" | "ogg" => 80,
                    "m4a" | "aac" => 70,
                    "mp3" => 60,
                    _ => 50,
                };

                let source = TrackSource {
                    id: queries::new_id(),
                    recording_id: recording_id.clone(),
                    source: "local".to_string(),
                    source_id: None,
                    source_url: None,
                    file_path: Some(path_str),
                    file_format: Some(format),
                    file_size_bytes: file_size,
                    bitrate: meta.bitrate,
                    sample_rate: meta.sample_rate,
                    quality_score: quality,
                    content_hash: Some(content_hash),
                    is_available: true,
                    metadata_json: None,
                    last_verified: Some(now.clone()),
                    created_at: now.clone(),
                    updated_at: now,
                };
                let _ = queries::insert_track_source(db, &source);

                result.new_tracks += 1;
            }
            Err(e) => {
                result
                    .errors
                    .push(format!("{}: metadata error: {}", path_str, e));
            }
        }
    }

    // Rebuild all search indexes after scan
    let _ = queries::rebuild_all_search_indexes(db);

    result
}

struct TrackMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<i32>,
    genre: Option<String>,
    track_number: Option<i32>,
    disc_number: Option<i32>,
    duration_ms: Option<i64>,
    bitrate: Option<i32>,
    sample_rate: Option<i32>,
}

fn extract_metadata(path: &Path) -> Result<TrackMetadata, String> {
    let tagged_file = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let properties = tagged_file.properties();
    let duration_ms = Some(properties.duration().as_millis() as i64);
    let bitrate = properties.audio_bitrate().map(|b| b as i32);
    let sample_rate = properties.sample_rate().map(|s| s as i32);

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let (title, artist, album, year, genre, track_number, disc_number) = if let Some(tag) = tag {
        (
            tag.title().map(|s| s.to_string()),
            tag.artist().map(|s| s.to_string()),
            tag.album().map(|s| s.to_string()),
            tag.year().map(|y| y as i32),
            tag.genre().map(|g| g.to_string()),
            tag.track().map(|t| t as i32),
            tag.disk().map(|d| d as i32),
        )
    } else {
        (None, None, None, None, None, None, None)
    };

    Ok(TrackMetadata {
        title,
        artist,
        album,
        year,
        genre,
        track_number,
        disc_number,
        duration_ms,
        bitrate,
        sample_rate,
    })
}

fn compute_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    // Hash first 64KB for speed (enough for dedup)
    let mut total_read = 0;
    while total_read < 65536 {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        total_read += n;
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn make_sort_name(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.starts_with("the ") {
        format!("{}, The", &name[4..])
    } else if lower.starts_with("a ") {
        format!("{}, A", &name[2..])
    } else {
        name.to_string()
    }
}
