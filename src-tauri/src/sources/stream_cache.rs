use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct CachedStream {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub expires_at: Option<i64>,
    pub mime_type: String,
    pub codec: Option<String>,
    pub bitrate: Option<i64>,
    pub duration_ms: Option<i64>,
    pub is_seekable: bool,
    pub needs_refresh: bool,
    pub cached_at: std::time::Instant,
}

impl CachedStream {
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            let now_ms = chrono::Utc::now().timestamp_millis();
            expires_at <= now_ms + 60_000
        } else {
            self.cached_at.elapsed().as_secs() > 600
        }
    }
}

/// Hard cap on the number of entries kept in the stream cache.
const MAX_CACHE_ENTRIES: usize = 50;

pub type StreamCache = Arc<Mutex<HashMap<String, CachedStream>>>;

/// Inserts a new entry, evicting the oldest one when the cache is full.
pub fn cache_insert(cache: &StreamCache, key: String, entry: CachedStream) {
    if let Ok(mut map) = cache.lock() {
        // Evict the entry with the oldest `cached_at` if we're at capacity.
        if map.len() >= MAX_CACHE_ENTRIES && !map.contains_key(&key) {
            if let Some(oldest_key) = map
                .iter()
                .min_by_key(|(_, v)| v.cached_at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest_key);
            }
        }
        map.insert(key, entry);
    }
}
