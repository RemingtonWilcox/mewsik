# Playback Speed & Reliability Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make external music playback fast and reliable by dropping yt-dlp, using youtubei.js native stream resolution, replacing the abandoned SoundCloud library, pre-resolving streams, and auto-adding downloads to library.

**Architecture:** All stream resolution moves to pure JS libraries (no binary spawning). The sidecar's YouTube provider uses youtubei.js `getBasicInfo()` + `chooseFormat()` + `decipher()` instead of yt-dlp. SoundCloud switches from `soundcloud-downloader` to `soundcloud-fetch`. The Rust backend adds a stream URL cache for pre-resolved results. Downloads auto-add to library via a one-line DB call.

**Tech Stack:** Node.js (youtubei.js v17, soundcloud-fetch v1.2), Rust (Tauri commands, SQLite), Svelte 5 frontend

**Spec:** `docs/superpowers/specs/2026-04-02-playback-search-overhaul-design.md` (Sub-project A sections)

---

## File Map

| File | Role | Tasks |
|------|------|-------|
| `sidecar/package.json` | Dependencies | 1 |
| `sidecar/src/providers/youtube.ts` | YouTube search + stream resolution | 2 |
| `sidecar/src/utils/ytdlp.ts` | **DELETE** — yt-dlp wrapper | 2 |
| `sidecar/src/index.ts` | Sidecar entry, platform shim setup | 2 |
| `sidecar/src/providers/soundcloud.ts` | SoundCloud search + stream resolution | 3 |
| `src-tauri/src/download/mod.rs` | Download completion handler | 4 |
| `src-tauri/src/sources/orchestrator.rs` | Stream URL cache + pre-resolve | 5 |
| `src-tauri/src/commands/external_search.rs` | Trigger pre-resolve after search | 5 |
| `src-tauri/src/commands/playback.rs` | Check cache before resolving | 5 |

---

### Task 1: Update Sidecar Dependencies

**Files:**
- Modify: `sidecar/package.json`

- [ ] **Step 1: Remove soundcloud-downloader, add soundcloud-fetch**

In `sidecar/package.json`, replace the dependencies block:

```json
"dependencies": {
    "bandcamp-fetch": "^3.0.0",
    "play-dl": "^1.9.7",
    "soundcloud-downloader": "^1.0.0",
    "youtubei.js": "^17.0.1"
  }
```

With:

```json
"dependencies": {
    "bandcamp-fetch": "^3.0.0",
    "soundcloud-fetch": "^1.2.0",
    "youtubei.js": "^17.0.1"
  }
```

Changes: Removed `soundcloud-downloader` and `play-dl` (unused — search uses youtubei.js). Added `soundcloud-fetch`.

- [ ] **Step 2: Install dependencies**

Run: `cd sidecar && pnpm install`
Expected: Clean install, no errors. `soundcloud-fetch` and `youtubei.js` in node_modules.

- [ ] **Step 3: Verify**

Run: `ls sidecar/node_modules/soundcloud-fetch && ls sidecar/node_modules/youtubei.js`
Expected: Both directories exist.

---

### Task 2: Replace yt-dlp with youtubei.js Native Stream Resolution

**Files:**
- Modify: `sidecar/src/providers/youtube.ts`
- Modify: `sidecar/src/index.ts`
- Delete: `sidecar/src/utils/ytdlp.ts`

This is the highest-impact change. YouTube stream resolution goes from 5-45 seconds (yt-dlp binary spawn) to ~200-500ms (single InnerTube API call).

- [ ] **Step 1: Add Platform.shim.eval setup to sidecar/src/index.ts**

At the top of `sidecar/src/index.ts`, after the existing imports (line 6), add the youtubei.js platform shim setup:

```typescript
import { Platform } from 'youtubei.js';

// Wire up the JavaScript evaluator for YouTube signature deciphering.
// youtubei.js v17 requires this to decipher stream URLs.
// In Node.js, we use the Function constructor as the evaluator.
Platform.shim.evaluate = (code: string) => {
  return new Function('return ' + code)();
};
```

**Note:** The exact API may differ slightly depending on the youtubei.js v17 build. The implementer MUST read the actual installed file at `sidecar/node_modules/youtubei.js/dist/src/platform/lib.js` (or similar) to find the correct shim property name. It may be `Platform.shim.evaluate`, `Platform.shim.eval`, or set via `Innertube.create({ evaluate: ... })`. The key concept is: provide a function that can execute JavaScript code strings and return the result. In Node.js, `new Function(code)()` is the standard approach.

If the shim approach doesn't exist in v17, the alternative is to pass an `evaluate` option to `Innertube.create()`:

```typescript
this.yt = await Innertube.create({
  lang: 'en',
  location: 'US',
  retrieve_player: true,
  generate_session_locally: true,
});
```

The implementer should check the youtubei.js docs/source to confirm the correct approach.

- [ ] **Step 2: Rewrite youtube.ts resolveStream to use youtubei.js native resolution**

Replace the entire `sidecar/src/providers/youtube.ts` file with:

```typescript
import { Innertube } from 'youtubei.js';

interface SearchResult {
  source: string;
  source_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  cover_art_url: string | null;
  source_url: string | null;
}

interface StreamInfo {
  url: string;
  headers: Record<string, string>;
  expires_at: number | null;
  mime_type: string;
  codec: string | null;
  bitrate: number | null;
  duration_ms: number | null;
  is_seekable: boolean;
  needs_refresh: boolean;
}

interface TrackMetadata {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  cover_art_url: string | null;
  year: number | null;
  genre: string | null;
}

export class YouTubeProvider {
  private yt: Innertube | null = null;
  private healthy = true;
  private failCount = 0;

  private async getClient(): Promise<Innertube> {
    if (!this.yt) {
      this.yt = await Innertube.create({
        lang: 'en',
        location: 'US',
        retrieve_player: true,
      });
    }
    return this.yt;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async search(query: string, page: number): Promise<{ items: SearchResult[]; has_more: boolean }> {
    try {
      const yt = await this.getClient();
      const results = await yt.music.search(query, { type: 'song' });
      const items: SearchResult[] = [];

      const contents = results.contents;
      if (contents) {
        for (const shelf of contents) {
          if ('contents' in shelf) {
            for (const item of (shelf as any).contents || []) {
              if (item.type === 'MusicResponsiveListItem') {
                const videoId = item.id || item.overlay?.content?.video_id;
                if (!videoId) continue;

                const title = item.title?.toString() || item.flex_columns?.[0]?.title?.toString() || 'Unknown';
                const artist = item.artists?.[0]?.name || item.flex_columns?.[1]?.title?.toString() || 'Unknown';
                const album = item.album?.name || null;
                const durationText = item.duration?.text || item.duration?.seconds;
                const durationMs = typeof durationText === 'number' ? durationText * 1000 : parseDuration(durationText);
                const thumbnail = item.thumbnails?.[0]?.url || item.thumbnail?.contents?.[0]?.url || null;

                items.push({
                  source: 'youtube',
                  source_id: videoId,
                  title,
                  artist,
                  album,
                  duration_ms: durationMs,
                  cover_art_url: thumbnail,
                  source_url: `https://music.youtube.com/watch?v=${videoId}`,
                });
              }
            }
          }
        }
      }

      this.failCount = 0;
      this.healthy = true;

      return { items, has_more: items.length >= 20 };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
    }
  }

  async resolveStream(sourceId: string): Promise<StreamInfo> {
    try {
      const yt = await this.getClient();
      const info = await yt.getBasicInfo(sourceId);

      // Choose best audio format
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });

      // Decipher the stream URL (requires Platform.shim.evaluate to be set up)
      const url = format.decipher(yt.session.player);

      if (!url) {
        throw new Error('Failed to decipher YouTube stream URL');
      }

      // Extract expiry from URL params
      const expiresAt = inferExpiry(url) ?? Date.now() + 6 * 60 * 60 * 1000;

      // Build headers from format
      const headers: Record<string, string> = {};
      if (info.basic_info?.is_live) {
        headers['Accept'] = '*/*';
      }

      const mimeType = inferMimeType(format.mime_type);
      const codec = format.audio_codec || null;
      const bitrate = format.bitrate ? Math.round(format.bitrate) : null;
      const durationMs = info.basic_info?.duration ? info.basic_info.duration * 1000 : null;

      this.failCount = 0;
      this.healthy = true;

      return {
        url,
        headers,
        expires_at: expiresAt,
        mime_type: mimeType,
        codec,
        bitrate,
        duration_ms: durationMs,
        is_seekable: !info.basic_info?.is_live,
        needs_refresh: true,
      };
    } catch (err) {
      this.failCount++;
      if (this.failCount >= 3) this.healthy = false;
      throw err;
    }
  }

  async getMetadata(sourceId: string): Promise<TrackMetadata> {
    const yt = await this.getClient();
    const info = await yt.getBasicInfo(sourceId);
    const basic = info.basic_info;

    return {
      title: basic.title || 'Unknown',
      artist: basic.author || 'Unknown',
      album: null,
      duration_ms: basic.duration ? basic.duration * 1000 : null,
      cover_art_url: basic.thumbnail?.[0]?.url || null,
      year: null,
      genre: null,
    };
  }
}

function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

function inferExpiry(url: string): number | null {
  try {
    const parsed = new URL(url);
    const expireParam = parsed.searchParams.get('expire');
    if (!expireParam) return null;
    const seconds = Number(expireParam);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function inferMimeType(mime: string | undefined): string {
  if (!mime) return 'audio/webm';
  // YouTube format mime_type looks like "audio/webm; codecs=\"opus\""
  const base = mime.split(';')[0].trim();
  return base || 'audio/webm';
}
```

Key changes from original:
- `resolveStream()` uses `yt.getBasicInfo(sourceId)` + `info.chooseFormat()` + `format.decipher()` instead of calling yt-dlp
- `inferExpiry()` and `inferMimeType()` moved inline (no longer imported from ytdlp.ts)
- No import of anything from `../utils/ytdlp.js`

**IMPORTANT for implementer:** The exact API for `chooseFormat()` and `decipher()` must be verified against the installed youtubei.js v17. Read the types at `sidecar/node_modules/youtubei.js/dist/src/` to confirm:
- `info.chooseFormat({ type: 'audio', quality: 'best' })` — may need different params
- `format.decipher(yt.session.player)` — the player reference may be accessed differently
- `format.mime_type`, `format.audio_codec`, `format.bitrate` — field names may differ

If the API differs, adapt the code to match the actual types. The concept is the same: get video info, pick best audio format, decipher the URL.

- [ ] **Step 3: Remove ytdlp.ts import from index.ts**

In `sidecar/src/index.ts`, the file currently has no direct import of ytdlp.ts (it's imported by youtube.ts). But verify no references remain. The `play-dl` dependency was also removed in Task 1 — ensure nothing imports it.

- [ ] **Step 4: Delete sidecar/src/utils/ytdlp.ts**

Delete the file entirely:

Run: `rm sidecar/src/utils/ytdlp.ts`

- [ ] **Step 5: Build and verify sidecar compiles**

Run: `cd /Users/remington/Documents/VIBECODE/mewsik && pnpm sidecar:build`
Expected: Build succeeds with no errors. The output at `sidecar/dist/index.cjs` should not contain any references to `yt-dlp` or `ytdlp`.

Run: `grep -c "yt-dlp\|ytdlp\|extractBestAudio" sidecar/dist/index.cjs`
Expected: 0 (no references)

---

### Task 3: Replace soundcloud-downloader with soundcloud-fetch

**Files:**
- Modify: `sidecar/src/providers/soundcloud.ts`
- Modify: `sidecar/src/index.ts` (proxy handler may need updating)

- [ ] **Step 1: Rewrite soundcloud.ts to use soundcloud-fetch**

Replace the entire `sidecar/src/providers/soundcloud.ts` with a new implementation using `soundcloud-fetch`. The implementer must:

1. Read the `soundcloud-fetch` API at `sidecar/node_modules/soundcloud-fetch/dist/` to understand the actual types and methods
2. The key classes are likely: `SoundCloud` (client), `Track` (track object), and methods like `search()`, `getTrackById()`, `track.getStreamingData()`

The new provider must:
- Initialize `soundcloud-fetch` client (lazy, same pattern as current)
- `search(query, page)`: Search tracks, filter out preview-only tracks, return `SearchResult[]` with play counts for ranking
- `resolveStream(sourceId)`: Get track by ID, call `getStreamingData()` or equivalent, prefer progressive protocol, return `StreamInfo`
- `streamToResponse(sourceId, req, res)`: HLS proxy fallback (same concept as current, adapted to new library)
- `getMetadata(sourceId)`: Return track metadata
- Keep the same `isHealthy()` / `markHealthy()` / `markFailure()` pattern
- Keep `setProxyBaseUrl()` for HLS proxy

The interfaces (`SearchResult`, `StreamInfo`, `TrackMetadata`) are identical to the current ones — don't change them.

The `selectBestTranscoding()`, `inferCodec()`, `normalizeMimeType()`, `parseBitrate()` helpers can likely be simplified since `soundcloud-fetch` may handle transcoding selection differently. Adapt as needed.

- [ ] **Step 2: Update index.ts proxy handler if needed**

The SoundCloud HLS proxy in `sidecar/src/index.ts` (line 33-34) calls `providers.soundcloud.streamToResponse()`. This should still work if the new provider implements the same method signature. Verify after rewriting.

- [ ] **Step 3: Build and verify**

Run: `pnpm sidecar:build`
Expected: Build succeeds. No references to `soundcloud-downloader` in output.

Run: `grep -c "soundcloud-downloader" sidecar/dist/index.cjs`
Expected: 0

---

### Task 4: Downloads Auto-Add to Library

**Files:**
- Modify: `src-tauri/src/download/mod.rs:442-444`

- [ ] **Step 1: Add set_in_library call after successful download**

In `src-tauri/src/download/mod.rs`, find the download completion handler around line 442-444:

```rust
} else if let Some(recording_id) = recording_id.as_deref() {
    let _ = upsert_download_source(&db, recording_id, &entry.source, &destination);
}
```

Replace with:

```rust
} else if let Some(recording_id) = recording_id.as_deref() {
    let _ = upsert_download_source(&db, recording_id, &entry.source, &destination);
    let _ = crate::db::queries::set_in_library(&db, recording_id, true);
}
```

This adds the recording to the user's library immediately after the download source is created.

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/remington/Documents/VIBECODE/mewsik && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles with no errors.

---

### Task 5: Pre-resolve Stream URLs for Top Search Results

**Files:**
- Modify: `src-tauri/src/sources/orchestrator.rs`
- Modify: `src-tauri/src/commands/external_search.rs`
- Modify: `src-tauri/src/commands/playback.rs`

This task adds a stream URL cache. After search results arrive, the backend resolves stream URLs for the top 5 results in background threads. When the user clicks play, the URL is already cached.

- [ ] **Step 1: Read the current orchestrator.rs to understand the structure**

The implementer must read `src-tauri/src/sources/orchestrator.rs` to understand:
- How `search_all()` works
- How providers are called
- The `SourceOrchestrator` struct

- [ ] **Step 2: Add a stream cache to the orchestrator**

Add a `StreamCache` to `src-tauri/src/sources/orchestrator.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct CachedStream {
    url: String,
    headers: HashMap<String, String>,
    expires_at: Option<i64>,
    mime_type: String,
    codec: Option<String>,
    bitrate: Option<i64>,
    duration_ms: Option<i64>,
    is_seekable: bool,
    cached_at: Instant,
}

impl CachedStream {
    fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            let now_ms = chrono::Utc::now().timestamp_millis();
            expires_at <= now_ms + 60_000 // Expired or expiring within 60s
        } else {
            // No expiry info — assume valid for 10 minutes from cache time
            self.cached_at.elapsed().as_secs() > 600
        }
    }
}
```

Add a `pub stream_cache: Arc<Mutex<HashMap<String, CachedStream>>>` field to the orchestrator (or as a standalone shared state in the Tauri app).

- [ ] **Step 3: Add pre-resolve trigger in external_search.rs**

After `search_all_sources` returns results, spawn background tasks to resolve streams for the top 5 results. The implementer must read `src-tauri/src/commands/external_search.rs` to find where results are returned, then add:

```rust
// After results are sorted and ready to return:
let top_results: Vec<(String, String)> = results.iter()
    .take(5)
    .map(|r| (r.source.clone(), r.source_id.clone()))
    .collect();

// Spawn background pre-resolution (fire and forget)
let sidecar = sidecar_manager.clone();
let cache = stream_cache.clone();
std::thread::spawn(move || {
    for (source, source_id) in top_results {
        let key = format!("{}:{}", source, source_id);
        // Skip if already cached and not expired
        if let Ok(guard) = cache.lock() {
            if let Some(cached) = guard.get(&key) {
                if !cached.is_expired() {
                    continue;
                }
            }
        }
        // Resolve stream URL via sidecar
        match sidecar.resolve_stream(&source, &source_id) {
            Ok(stream_info) => {
                if let Ok(mut guard) = cache.lock() {
                    guard.insert(key, CachedStream {
                        url: stream_info.url,
                        headers: stream_info.headers,
                        expires_at: stream_info.expires_at,
                        mime_type: stream_info.mime_type,
                        codec: stream_info.codec,
                        bitrate: stream_info.bitrate,
                        duration_ms: stream_info.duration_ms,
                        is_seekable: stream_info.is_seekable,
                        cached_at: Instant::now(),
                    });
                }
            }
            Err(_) => {} // Silently ignore pre-resolve failures
        }
    }
});
```

The exact integration depends on how the sidecar manager is accessed from the command. The implementer must read the existing code to wire this in correctly.

- [ ] **Step 4: Check cache in playback.rs before resolving**

In `src-tauri/src/commands/playback.rs`, find where `resolve_stream` is called during `play_external` or `build_queue_entry`. Before calling the sidecar, check the cache:

```rust
let cache_key = format!("{}:{}", source, source_id);
let cached = stream_cache.lock().ok()
    .and_then(|guard| guard.get(&cache_key).cloned())
    .filter(|c| !c.is_expired());

if let Some(cached) = cached {
    // Use cached stream URL — skip sidecar call entirely
    // Build the StreamInfo / QueueEntry from cached data
} else {
    // Fall through to normal sidecar resolution
}
```

The implementer must adapt this to fit the existing code structure. The cache should be passed as Tauri managed state (`State<'_, StreamCache>`).

- [ ] **Step 5: Verify full build**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles with no errors.

---

### Task 6: Full Build and Integration Test

- [ ] **Step 1: Build the sidecar**

Run: `pnpm sidecar:build`
Expected: Clean build, no errors.

- [ ] **Step 2: Build the full app**

Run: `pnpm tauri:build`
Expected: Clean build, bundles created.

- [ ] **Step 3: Manual integration test checklist**

Install and launch the app. Verify:

1. **YouTube search** works — type a query, results appear
2. **YouTube playback** works — click a YouTube result, audio starts within 1-2 seconds (not 30+)
3. **SoundCloud search** works — results appear with play counts
4. **SoundCloud playback** works — click a SoundCloud result, audio starts
5. **Bandcamp** still works — unchanged
6. **Download a song** — after download completes, check Library tab — the song should appear
7. **Pre-resolve** — after searching, click the 2nd or 3rd result — it should play faster than a cold resolve
8. **Error handling** — if YouTube is temporarily blocked, a clear error appears (not a 45-second hang)
