use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub items: Vec<SearchResultItem>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub source: String,
    pub source_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover_art_url: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub expires_at: Option<Instant>,
    pub mime_type: String,
    pub codec: Option<String>,
    pub bitrate: Option<u32>,
    pub duration_ms: Option<u64>,
    pub is_seekable: bool,
    pub needs_refresh: bool,
}

#[derive(Debug, Clone)]
pub struct SourceCapabilities {
    pub can_search: bool,
    pub can_stream: bool,
    pub can_download: bool,
    pub can_browse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover_art_url: Option<String>,
    pub year: Option<i32>,
    pub genre: Option<String>,
}

#[async_trait]
pub trait SourceProvider: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self) -> SourceCapabilities;
    fn is_healthy(&self) -> bool;

    async fn search(&self, query: &str, page: u32) -> Result<SearchResults, String>;
    async fn resolve_stream(&self, source_id: &str) -> Result<StreamInfo, String>;
    async fn get_metadata(&self, source_id: &str) -> Result<TrackMetadata, String>;
}
