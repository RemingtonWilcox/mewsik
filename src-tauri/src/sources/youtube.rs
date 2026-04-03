use super::provider::*;
use super::sidecar_manager::SidecarManager;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

pub struct YouTubeProvider {
    sidecar: Arc<SidecarManager>,
}

impl YouTubeProvider {
    pub fn new(sidecar: Arc<SidecarManager>) -> Self {
        Self { sidecar }
    }
}

#[async_trait]
impl SourceProvider for YouTubeProvider {
    fn name(&self) -> &str {
        "youtube"
    }

    fn capabilities(&self) -> SourceCapabilities {
        SourceCapabilities {
            can_search: true,
            can_stream: true,
            can_download: true,
            can_browse: false,
        }
    }

    fn is_healthy(&self) -> bool {
        self.sidecar.is_running()
    }

    async fn search(&self, query: &str, page: u32) -> Result<SearchResults, String> {
        let result = self
            .sidecar
            .call("youtube.search", json!({ "query": query, "page": page }))?;

        let items: Vec<SearchResultItem> =
            serde_json::from_value(result.get("items").cloned().unwrap_or_default())
                .unwrap_or_default();

        let has_more = result
            .get("has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Ok(SearchResults { items, has_more })
    }

    async fn resolve_stream(&self, source_id: &str) -> Result<StreamInfo, String> {
        let result = self
            .sidecar
            .call("youtube.resolve_stream", json!({ "source_id": source_id }))?;

        Ok(StreamInfo {
            url: result
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            headers: serde_json::from_value(result.get("headers").cloned().unwrap_or_default())
                .unwrap_or_default(),
            expires_at: result.get("expires_at").and_then(|v| v.as_u64()).map(|ms| {
                Instant::now()
                    + std::time::Duration::from_millis(
                        ms - (chrono::Utc::now().timestamp_millis() as u64),
                    )
            }),
            mime_type: result
                .get("mime_type")
                .and_then(|v| v.as_str())
                .unwrap_or("audio/webm")
                .to_string(),
            codec: result
                .get("codec")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            bitrate: result
                .get("bitrate")
                .and_then(|v| v.as_u64())
                .map(|b| b as u32),
            duration_ms: result.get("duration_ms").and_then(|v| v.as_u64()),
            is_seekable: result
                .get("is_seekable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            needs_refresh: result
                .get("needs_refresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        })
    }

    async fn get_metadata(&self, source_id: &str) -> Result<TrackMetadata, String> {
        let result = self
            .sidecar
            .call("youtube.get_metadata", json!({ "source_id": source_id }))?;

        Ok(TrackMetadata {
            title: result
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string(),
            artist: result
                .get("artist")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string(),
            album: result
                .get("album")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            duration_ms: result.get("duration_ms").and_then(|v| v.as_u64()),
            cover_art_url: result
                .get("cover_art_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            year: result
                .get("year")
                .and_then(|v| v.as_i64())
                .map(|y| y as i32),
            genre: result
                .get("genre")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        })
    }
}
