//! Stream probing: fetch the first bytes of a station URL, sniff what they
//! actually are (audio, playlist, HLS, HTML error page), and unwrap playlist
//! redirects to the direct stream URL the audio engine can decode.

use reqwest::header::{ACCEPT, CONTENT_TYPE};

const STATION_PROBE_BYTES: usize = 8 * 1024;
const STATION_PLAYLIST_DEPTH: usize = 2;

fn normalize_content_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn is_audio_content_type(content_type: &str) -> bool {
    let normalized = normalize_content_type(content_type);
    normalized.starts_with("audio/")
        || matches!(
            normalized.as_str(),
            "application/ogg"
                | "application/octet-stream"
                | "application/aacp"
                | "application/flac"
        )
}

fn is_playlist_content_type(content_type: &str) -> bool {
    matches!(
        normalize_content_type(content_type).as_str(),
        "application/vnd.apple.mpegurl"
            | "application/x-mpegurl"
            | "application/apple.vnd.mpegurl"
            | "audio/x-mpegurl"
            | "audio/mpegurl"
            | "application/pls+xml"
            | "audio/x-scpls"
    )
}

pub(crate) fn url_looks_like_playlist(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    path.ends_with(".m3u") || path.ends_with(".m3u8") || path.ends_with(".pls")
}

fn bytes_to_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn bytes_look_like_html(bytes: &[u8]) -> bool {
    let lowercase = bytes_to_text(bytes).to_ascii_lowercase();
    let trimmed = lowercase.trim_start();

    trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<head")
        || trimmed.starts_with("<body")
        || lowercase.contains("<html")
        || lowercase.contains("<body")
        || lowercase.contains("<script")
}

fn bytes_look_like_hls(bytes: &[u8]) -> bool {
    let text = bytes_to_text(bytes);
    text.contains("#EXT-X-STREAM-INF")
        || text.contains("#EXT-X-TARGETDURATION")
        || text.contains("#EXT-X-MEDIA")
}

fn bytes_look_like_playlist(bytes: &[u8]) -> bool {
    let text = bytes_to_text(bytes);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();

    trimmed.starts_with("#EXTM3U")
        || trimmed.starts_with("[playlist]")
        || trimmed
            .lines()
            .any(|line| line.trim_start().to_ascii_lowercase().starts_with("file1="))
}

fn looks_like_audio_payload(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes_look_like_html(bytes) || bytes_look_like_playlist(bytes) {
        return false;
    }

    if bytes.starts_with(b"ID3")
        || bytes.starts_with(b"OggS")
        || bytes.windows(4).any(|window| window == b"fLaC")
        || bytes.windows(4).any(|window| window == b"ftyp")
        || bytes
            .windows(2)
            .any(|window| matches!(window, [0xFF, second] if second & 0xE0 == 0xE0))
    {
        return true;
    }

    let sample_len = bytes.len().min(512);
    let binaryish = bytes[..sample_len]
        .iter()
        .filter(|byte| !matches!(**byte, b'\n' | b'\r' | b'\t' | b' '..=b'~'))
        .count();

    binaryish * 4 >= sample_len
}

fn resolve_playlist_target(bytes: &[u8], base_url: &reqwest::Url) -> Option<String> {
    let text = bytes_to_text(bytes);

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }

        let candidate = match trimmed.split_once('=') {
            Some((key, value)) => {
                let key = key.trim();
                if key.to_ascii_lowercase().starts_with("file") {
                    value.trim()
                } else if key.chars().all(|c| c.is_ascii_alphanumeric()) {
                    // PLS metadata (Title1=, Length1=, NumberOfEntries=,
                    // Version=) — never a stream URL. Treating it as one
                    // resolves the station to garbage via base_url.join.
                    continue;
                } else {
                    // A bare URL line that happens to contain '=' (query
                    // string) — keep the whole line.
                    trimmed
                }
            }
            None => trimmed,
        };

        if candidate.is_empty() {
            continue;
        }

        if let Ok(url) = reqwest::Url::parse(candidate) {
            return Some(url.to_string());
        }

        if let Ok(url) = base_url.join(candidate) {
            return Some(url.to_string());
        }
    }

    None
}

async fn read_probe_bytes(response: &mut reqwest::Response) -> Result<Vec<u8>, reqwest::Error> {
    let mut bytes = Vec::with_capacity(STATION_PROBE_BYTES);

    while bytes.len() < STATION_PROBE_BYTES {
        match response.chunk().await? {
            Some(chunk) => {
                if chunk.is_empty() {
                    continue;
                }

                let remaining = STATION_PROBE_BYTES.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            None => break,
        }
    }

    Ok(bytes)
}

/// Probe a station URL, following playlist redirects (.m3u/.pls). Returns
/// the *direct stream URL* that actually serves audio — the audio engine
/// cannot decode playlist text, so callers should play/persist this URL,
/// not the original.
pub(crate) async fn probe_station_stream(
    client: &reqwest::Client,
    initial_url: &str,
) -> Option<String> {
    let mut current_url = initial_url.to_string();

    for _ in 0..=STATION_PLAYLIST_DEPTH {
        let mut response = match client
            .get(&current_url)
            .header(
                ACCEPT,
                "audio/*,application/ogg;q=0.9,application/octet-stream;q=0.8,*/*;q=0.1",
            )
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return None,
        };

        if !response.status().is_success() {
            return None;
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let final_url = response.url().clone();
        let bytes = match read_probe_bytes(&mut response).await {
            Ok(bytes) => bytes,
            Err(_) => return None,
        };

        if bytes.is_empty() {
            return None;
        }

        if is_playlist_content_type(&content_type) || bytes_look_like_playlist(&bytes) {
            // HLS segment playlists are not decodable by the engine — a
            // station that resolves into HLS must never be marked healthy.
            if bytes_look_like_hls(&bytes) {
                return None;
            }
            if let Some(next_url) = resolve_playlist_target(&bytes, &final_url) {
                current_url = next_url;
                continue;
            }
            return None;
        }

        if bytes_look_like_html(&bytes) {
            return None;
        }

        if is_audio_content_type(&content_type) {
            return looks_like_audio_payload(&bytes).then_some(current_url);
        }

        if normalize_content_type(&content_type).starts_with("text/") {
            return None;
        }

        return looks_like_audio_payload(&bytes).then_some(current_url);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_payload_detects_mp3_sync_and_id3() {
        assert!(looks_like_audio_payload(&[0xFF, 0xFB, 0x90, 0x00]));
        assert!(looks_like_audio_payload(b"ID3\x04\x00binary tag data"));
        assert!(looks_like_audio_payload(b"OggS\x00\x02 vorbis stream"));
    }

    #[test]
    fn audio_payload_rejects_html_playlists_and_empty() {
        assert!(!looks_like_audio_payload(b""));
        assert!(!looks_like_audio_payload(
            b"<!DOCTYPE html><html><body>404</body></html>"
        ));
        assert!(!looks_like_audio_payload(
            b"#EXTM3U\nhttp://example.com/stream"
        ));
        assert!(!looks_like_audio_payload(
            b"[playlist]\nFile1=http://example.com/stream"
        ));
        // Plain prose should not be mistaken for an audio stream.
        assert!(!looks_like_audio_payload(
            b"This is just a text response from a misconfigured server."
        ));
    }

    #[test]
    fn playlist_target_resolves_m3u_and_pls() {
        let base = reqwest::Url::parse("http://radio.example/dir/list.m3u").unwrap();

        let m3u = b"#EXTM3U\n# comment\nhttp://stream.example/live\n";
        assert_eq!(
            resolve_playlist_target(m3u, &base).as_deref(),
            Some("http://stream.example/live")
        );

        let pls = b"[playlist]\nNumberOfEntries=1\nFile1=http://stream.example/pls-live\n";
        assert_eq!(
            resolve_playlist_target(pls, &base).as_deref(),
            Some("http://stream.example/pls-live")
        );
    }

    #[test]
    fn playlist_target_joins_relative_entries_against_base() {
        let base = reqwest::Url::parse("http://radio.example/dir/list.m3u").unwrap();
        let m3u = b"#EXTM3U\nstream/live.mp3\n";
        assert_eq!(
            resolve_playlist_target(m3u, &base).as_deref(),
            Some("http://radio.example/dir/stream/live.mp3")
        );
    }

    #[test]
    fn playlist_target_keeps_url_lines_containing_equals() {
        let base = reqwest::Url::parse("http://radio.example/list.m3u").unwrap();
        let m3u = b"#EXTM3U\nhttp://stream.example/live?token=abc\n";
        assert_eq!(
            resolve_playlist_target(m3u, &base).as_deref(),
            Some("http://stream.example/live?token=abc")
        );
    }

    #[test]
    fn playlist_target_ignores_comments_and_sections() {
        let base = reqwest::Url::parse("http://radio.example/list.pls").unwrap();
        let only_noise = b"[playlist]\n# nothing playable here\n";
        assert_eq!(resolve_playlist_target(only_noise, &base), None);
    }

    #[test]
    fn hls_markers_detected() {
        assert!(bytes_look_like_hls(
            b"#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg0.ts"
        ));
        assert!(!bytes_look_like_hls(
            b"#EXTM3U\nhttp://stream.example/live\n"
        ));
    }

    #[test]
    fn playlist_url_detection_handles_query_and_fragment() {
        assert!(url_looks_like_playlist("http://x.example/a.m3u"));
        assert!(url_looks_like_playlist("http://x.example/a.M3U8?sid=1"));
        assert!(url_looks_like_playlist("http://x.example/a.pls#top"));
        assert!(!url_looks_like_playlist("http://x.example/listen?fmt=.m3u"));
        assert!(!url_looks_like_playlist("http://x.example/stream.mp3"));
    }

    #[test]
    fn content_type_classification() {
        assert!(is_audio_content_type("audio/mpeg; charset=utf-8"));
        assert!(is_audio_content_type("application/ogg"));
        assert!(!is_audio_content_type("text/html"));

        assert!(is_playlist_content_type("audio/x-mpegurl"));
        assert!(is_playlist_content_type("application/pls+xml; v=2"));
        assert!(!is_playlist_content_type("audio/mpeg"));
    }
}
