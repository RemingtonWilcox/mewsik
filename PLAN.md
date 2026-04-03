# Mewsik: Personal Music Streaming & Discovery App

## Context

Build a lightweight, responsive personal music app that aggregates multiple sources (YouTube, SoundCloud, Bandcamp, internet radio, torrents, local files) into a unified player with library management, playlists, stations, and music discovery. The goal is a Spotify-quality experience powered by open/public sources, running as a fast native desktop app.

**Scope decisions:**
- **Target platform:** macOS only for v1. Linux/Windows are future work.
- **Distribution:** Personal use first. If open-sourced later, provider integrations are plugins (not baked in), no hardcoded API keys or tracker URLs. The app is "a music player" — sources are user-configured. This is the Nuclear/Mopidy model.
- **Playback model:** Stream-first. External sources play immediately from streams. Downloading to local library is an explicit user action, not a prerequisite for playback.
- **Gapless/normalization:** Local files get full gapless + EBU R128 normalization. Remote streams get best-effort (gapless where the source supports it, normalization only after download).

---

## Architecture

**Tauri v2** (Rust backend + Svelte 5 frontend) in a three-layer design:

```
[Svelte 5 Frontend (WebView)]
        |  Tauri IPC (commands + channels)
[Rust Core (audio engine, DB, downloads, radio, torrents)]
        |  Unix socket (JSON-RPC)  [macOS-only for v1]
[Node.js Sidecar (YouTube, SoundCloud, Bandcamp)]
```

**Why this split:**
- Audio runs in Rust (Symphonia + Rodio) for gapless playback, all codec support, and low latency — Web Audio API can't do this
- YouTube/SoundCloud/Bandcamp libraries only exist in JS (`youtubei.js`, `soundcloud-downloader`, `bandcamp-fetch`) — rewriting in Rust would take months and fall behind API changes
- Sidecar is lazy-loaded (only starts on first external search)
- SQLite with FTS5 for the library database — proven by Navidrome at scale

**Sidecar transport:** Unix domain socket with JSON-RPC for v1 (macOS-only). If cross-platform is added later, the transport layer is behind a `SidecarTransport` trait so it can be swapped to stdio or named pipes without touching provider logic.

**Key reference projects:**
- [Nuclear](https://github.com/nukeop/nuclear) — migrated Electron to Tauri, multi-source aggregator, plugin architecture
- [Musicat](https://github.com/basharovV/musicat) — Tauri + Svelte music player
- [Spotube](https://github.com/KRTirtho/spotube) — Spotify catalog + YouTube audio pattern
- [Navidrome](https://github.com/navidrome/navidrome) — excellent DB schema, WASM plugin system

---

## Frontend Styling & UI

**Tailwind CSS v4** + **shadcn-svelte** (v1.2.4) + **@lucide/svelte** icons

### Setup
- `shadcn-svelte` — the community-maintained shadcn port for Svelte 5 (8.5k stars, huntabyte)
- Tailwind v4 via `@tailwindcss/vite` plugin (no PostCSS, no `tailwind.config.ts`)
- OKLCH color system with CSS custom properties for theming
- `tw-animate-css` for animations
- `mode-watcher` for light/dark mode toggle
- `@lucide/svelte` for 1500+ tree-shakable icons (Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume2, Heart, ListMusic, Disc, etc.)

### Key shadcn Components Used

| Component | Use Case |
|-----------|----------|
| **Sidebar** | Main navigation (Library, Search, Playlists, Stations, Discover, Downloads, Settings) |
| **Button** | Transport controls, actions |
| **Slider** | Volume control, track seek bar |
| **Toggle / Toggle Group** | Shuffle on/off, repeat mode |
| **Sheet** | Queue panel (slide-out from right) |
| **Drawer** | Mobile/compact now-playing panel |
| **Context Menu** | Right-click on tracks (Add to playlist, Play next, Download, etc.) |
| **Dropdown Menu** | More options menus |
| **Command** | Cmd+K search palette for finding anything |
| **Dialog** | Create playlist, edit details, confirmations |
| **Scroll Area** | Scrollable track lists, playlists |
| **Tabs** | Library sub-views (Songs / Albums / Artists) |
| **Card** | Album/playlist grid cards |
| **Table** | Detailed track listing with sortable columns |
| **Badge** | Source indicators (YouTube/SoundCloud/Bandcamp), genre tags |
| **Skeleton** | Loading states |
| **Sonner** | Toast notifications (track added, download complete, errors) |
| **Resizable** | Resizable sidebar + main content panels |
| **Tooltip** | Hover hints on controls |
| **Avatar** | Album art thumbnails in lists |
| **Progress** | Download progress bars |
| **Popover** | Quick actions, mini info panels |

### Branding & Logo
- SVG logo: minimal music note or waveform glyph in brand accent color
- App name "mewsik" in a clean sans-serif (Inter or Geist)
- Brand colors defined as CSS custom properties in `app.css` `@theme` block
- Consistent dark theme as default (music apps look better dark), with light mode option

### Design Principles
- **Persistent player bar** at bottom (album art, track info, progress, controls) — always visible
- **Sidebar navigation** on the left (collapsible)
- **Main content area** fills remaining space with virtual scrolling for large lists
- Responsive from 800px to ultrawide — sidebar collapses to icons on narrow widths
- Micro-interactions: hover states, smooth transitions, subtle feedback on clicks
- Keyboard-first: space (play/pause), arrows (seek/volume), Cmd+K (search)

---

## Source Integrations

| Source | Library | Approach |
|--------|---------|----------|
| **YouTube** | `youtubei.js` (InnerTube API) | Sidecar; search + audio stream extraction; yt-dlp as fallback |
| **SoundCloud** | `soundcloud-downloader` | Sidecar; auto-extract client_id with rotation/caching; stream + download |
| **Bandcamp** | `bandcamp-fetch` | Sidecar; free stream URLs; HQ with cookie auth for purchased |
| **Internet Radio** | `reqwest` + Radio-Browser.info API | Rust-native; 30k+ stations; no auth needed |
| **Torrents** | `librqbit` (Rust crate) | Rust-native; search via user's Prowlarr/Jackett instance |
| **Local Files** | `lofty` + `symphonia` | Rust-native; directory scanning + metadata extraction |

**Provider health:** Each provider has an `is_healthy()` check and a circuit breaker. If a provider fails 3 consecutive requests, it's temporarily disabled with a backoff. The UI shows provider status in Settings. Providers that are broken can be disabled without affecting the rest of the app.

**Metadata enrichment:** MusicBrainz API, Cover Art Archive, Last.fm API
**Discovery:** Last.fm similar artists/tracks, ListenBrainz recommendations, local co-occurrence model from listening history

**Credential storage:** Bandcamp cookies, Last.fm API key, Prowlarr/Jackett URL+API key, and SoundCloud client_id are stored in macOS Keychain via the `security-framework` crate. Never stored in SQLite or plaintext config files. The settings UI provides fields to enter/update these, and they're written directly to Keychain.

---

## Database Schema (SQLite + FTS5)

### Data Model: Canonical Recordings + Source Links

The core insight (from CodeX review): a "song" and a "source-specific playable item" are different things. The same recording of "Bohemian Rhapsody" might exist as a local FLAC, a YouTube video, and a SoundCloud upload. The data model separates these concerns:

- **`recordings`** — canonical entries for every song the app knows about. One row per song, regardless of how many sources exist. `is_in_library = 1` means the user explicitly saved it; `is_in_library = 0` means it was created automatically during search/play and hasn't been promoted yet. **Every play — even from a fresh search result — creates a recording first**, so play_history always has a recording_id.
- **`track_sources`** — one row per source-specific instance of a recording. Holds source_id, stream URLs, file paths, format-specific metadata. A recording can have 1-N sources.
- **`artists`** / **`albums`** — normalized entities with M:N support via join tables.

**Lifecycle of a recording:**
1. User searches YouTube for "Bohemian Rhapsody" → orchestrator finds/creates a recording (`is_in_library = 0`) + a YouTube track_source
2. User hits play → `play_recording(recording_id)` resolves the YouTube source, streams it. Play history logs the recording_id.
3. User clicks "Save to Library" → `is_in_library` flips to 1. That's it — the recording and source already exist.
4. Later, user finds same song on SoundCloud → orchestrator dedupes against existing recording, adds a second track_source. Now playback has fallback.

This enables:
- **Source fallback:** If YouTube is down, play the SoundCloud version of the same recording
- **Clean dedup:** Federated search results link to existing recordings if matched
- **Stable playlists:** Playlists reference recordings, not sources. Sources can come and go.
- **Accurate history:** Play history always references a recording, even for unsaved songs. Recommendation engine gets full signal.
- **Lazy library:** Unsaved recordings can be garbage-collected periodically (no sources left, not in any playlist, no recent history)

```sql
-- Canonical library entries (one per song you know about)
CREATE TABLE recordings (
    id              TEXT PRIMARY KEY,        -- ULID
    title           TEXT NOT NULL,
    duration_ms     INTEGER,
    year            INTEGER,
    genre           TEXT,                    -- JSON array: ["rock", "indie"]
    cover_art_path  TEXT,
    cover_art_url   TEXT,
    loudness_lufs   REAL,                    -- EBU R128 (from best local source)
    musicbrainz_id  TEXT,
    metadata_json   TEXT,                    -- Flexible extra metadata
    is_in_library   INTEGER DEFAULT 0,       -- Explicitly saved by user
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- M:N recording <-> artist
CREATE TABLE recording_artists (
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'primary',  -- 'primary', 'featured', 'remixer', 'composer'
    position        INTEGER NOT NULL DEFAULT 0,       -- Display order
    PRIMARY KEY (recording_id, artist_id, role)
);

-- Source-specific instances of a recording
CREATE TABLE track_sources (
    id              TEXT PRIMARY KEY,        -- ULID
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,           -- 'local', 'youtube', 'soundcloud', 'bandcamp', 'torrent'
    source_id       TEXT,                    -- External ID from provider
    source_url      TEXT,                    -- Page/stream URL
    file_path       TEXT,                    -- Non-NULL if downloaded/local
    file_format     TEXT,                    -- mp3, flac, ogg, etc.
    file_size_bytes INTEGER,
    bitrate         INTEGER,
    sample_rate     INTEGER,
    quality_score   INTEGER DEFAULT 0,       -- Provider-set quality ranking for fallback ordering
    content_hash    TEXT,                    -- SHA-256 of file content (local files only). Survives renames/moves.
    is_available    INTEGER DEFAULT 1,       -- Can be marked unavailable without deleting
    metadata_json   TEXT,                    -- Source-specific extra metadata
    last_verified   TEXT,                    -- When we last confirmed this source works
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(source, source_id)                -- Prevent duplicate external source entries (NULL source_id is excluded by SQL spec)
);

CREATE TABLE artists (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sort_name       TEXT,
    musicbrainz_id  TEXT,
    image_path      TEXT,
    image_url       TEXT,
    bio             TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE albums (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    year            INTEGER,
    genre           TEXT,
    track_count     INTEGER,
    cover_art_path  TEXT,
    cover_art_url   TEXT,
    musicbrainz_id  TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- M:N album <-> artist (supports compilations, splits, various artists)
CREATE TABLE album_artists (
    album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'primary',
    position        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, artist_id, role)
);

-- M:N recording <-> album (a recording can appear on multiple albums: original + compilation)
CREATE TABLE album_tracks (
    album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    disc_number     INTEGER DEFAULT 1,
    track_number    INTEGER,
    PRIMARY KEY (album_id, recording_id)
);

-- Playlists
CREATE TABLE playlists (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    cover_art_path  TEXT,
    is_smart        INTEGER DEFAULT 0,
    smart_rules     TEXT,                    -- JSON rules for smart playlists
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE playlist_tracks (
    id              TEXT PRIMARY KEY,
    playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    position        REAL NOT NULL,           -- REAL for fractional reordering (avoids renumbering)
    added_at        TEXT NOT NULL,
    UNIQUE(playlist_id, position)            -- Enforce unique positions
);

-- Radio stations
CREATE TABLE stations (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    homepage        TEXT,
    favicon_url     TEXT,
    favicon_path    TEXT,
    country         TEXT,
    language        TEXT,
    tags            TEXT,                    -- JSON array
    codec           TEXT,
    bitrate         INTEGER,
    radio_browser_id TEXT,
    is_favorite     INTEGER DEFAULT 0,
    last_played_at  TEXT,
    created_at      TEXT NOT NULL
);

-- Listening history (append-only, feeds recommendation engine)
CREATE TABLE play_history (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT REFERENCES recordings(id) ON DELETE SET NULL,
    source_used     TEXT,                    -- Which source was actually played
    station_id      TEXT REFERENCES stations(id) ON DELETE SET NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    duration_ms     INTEGER,
    completed       INTEGER DEFAULT 0        -- Played > 80%
);

-- Downloads
CREATE TABLE downloads (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT REFERENCES recordings(id),
    source          TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    progress        REAL DEFAULT 0.0,
    file_path       TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Full-text search: denormalized table (NOT a content= sync table)
-- We manage this manually because the indexed data spans multiple tables
-- (recordings + recording_artists + artists + albums)
CREATE VIRTUAL TABLE search_fts USING fts5(
    recording_id UNINDEXED,          -- For joining back to recordings
    title,                            -- Recording title
    artist_names,                     -- Space-separated primary + featured artist names
    album_titles,                     -- Space-separated album titles
    genre,
    tokenize='unicode61 remove_diacritics 2'
);

-- Separate FTS for browsing artists directly
CREATE VIRTUAL TABLE artists_fts USING fts5(
    artist_id UNINDEXED,
    name,
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS is rebuilt by the Rust layer via `rebuild_search_index(recording_id)`:
-- 1. Deletes existing row from search_fts WHERE recording_id = ?
-- 2. Joins recordings + recording_artists + artists + album_tracks + albums
-- 3. Inserts denormalized row with all artist names and album titles
--
-- This must be called on ANY mutation that affects the indexed data:
-- - Recording insert/update/delete (title, genre change)
-- - recording_artists insert/delete (artist added/removed from recording)
-- - artists update (name change) → fan out: rebuild all recording_ids linked via recording_artists
-- - album_tracks insert/delete (recording added/removed from album)
-- - albums update (title change) → fan out: rebuild all recording_ids linked via album_tracks
--
-- artists_fts must also be rebuilt on artist name changes.
--
-- All rebuilds run inside the same transaction as the originating mutation.
-- The Rust DB layer enforces this: artist/album mutations go through functions
-- that automatically fan out search_fts rebuilds for affected recordings.
-- Full rebuild (`rebuild_all_search_indexes()`) runs on first launch and on demand.

-- Recommendation data
CREATE TABLE recording_similarities (
    recording_id_a  TEXT NOT NULL,
    recording_id_b  TEXT NOT NULL,
    score           REAL NOT NULL,
    source          TEXT NOT NULL,           -- 'lastfm', 'local', 'content'
    PRIMARY KEY (recording_id_a, recording_id_b, source)
);

-- Indexes
CREATE INDEX idx_track_sources_recording ON track_sources(recording_id);
CREATE INDEX idx_track_sources_source ON track_sources(source, source_id);
CREATE UNIQUE INDEX idx_track_sources_local_path ON track_sources(file_path) WHERE file_path IS NOT NULL;
CREATE UNIQUE INDEX idx_track_sources_local_hash ON track_sources(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_recording_artists_artist ON recording_artists(artist_id);
CREATE INDEX idx_recording_artists_recording ON recording_artists(recording_id);
CREATE INDEX idx_album_artists_artist ON album_artists(artist_id);
CREATE INDEX idx_album_tracks_recording ON album_tracks(recording_id);
CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
CREATE INDEX idx_play_history_recording ON play_history(recording_id, started_at);
CREATE INDEX idx_play_history_time ON play_history(started_at);
CREATE INDEX idx_downloads_status ON downloads(status);
CREATE INDEX idx_recordings_library ON recordings(is_in_library) WHERE is_in_library = 1;
```

**Key design decisions:**
- **Canonical vs source split:** `recordings` holds what the song *is*; `track_sources` holds where it *lives*. Playlists, history, and recommendations all reference `recordings`.
- **M:N artists:** `recording_artists` and `album_artists` with `role` column handles featured artists, compilations, splits, and classical metadata (composer vs performer).
- **Fractional positions with compaction:** `playlist_tracks.position` is REAL, so inserting between position 1.0 and 2.0 gives 1.5 — no need to renumber the whole playlist on reorder. `UNIQUE(playlist_id, position)` prevents races. **Compaction rule:** When the gap between two adjacent positions falls below 1e-6 (after ~50 midpoint inserts in the same spot), the entire playlist's positions are renormalized to integers (1.0, 2.0, 3.0, ...) in a single transaction. This is checked on every insert/reorder and is cheap (one UPDATE with ROW_NUMBER).
- **Source uniqueness:** `UNIQUE(source, source_id)` on `track_sources` prevents duplicate external imports. For local files (where `source_id` is NULL), `UNIQUE(file_path)` and `UNIQUE(content_hash)` partial indexes prevent duplicates on rescan. Content hash (SHA-256) also detects moved/renamed files.
- **FTS search:** `search_fts` is a denormalized FTS5 table spanning recordings + artists + albums, managed by Rust (not triggers) because it joins multiple tables. Separate `artists_fts` for artist browsing. Full rebuild on first launch; incremental updates in the same transaction as recording mutations.
- **Source availability:** `is_available` flag lets us mark a source as broken without deleting it (preserving the link for when the provider recovers).
- **Quality score:** `quality_score` on `track_sources` determines fallback order. Local FLAC > local MP3 > YouTube > SoundCloud.

### Common Query Patterns

```sql
-- List library recordings with primary artist (the hot path)
SELECT r.*, a.name AS artist_name
FROM recordings r
JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
JOIN artists a ON a.id = ra.artist_id
WHERE r.is_in_library = 1
ORDER BY a.sort_name, r.title;

-- Get best available source for a recording
SELECT * FROM track_sources
WHERE recording_id = ? AND is_available = 1
ORDER BY
    CASE WHEN file_path IS NOT NULL THEN 0 ELSE 1 END,  -- Local first
    quality_score DESC
LIMIT 1;

-- Federated search (denormalized FTS covers title + artist + album + genre)
SELECT r.*, a.name AS artist_name
FROM search_fts fts
JOIN recordings r ON r.id = fts.recording_id
JOIN recording_artists ra ON ra.recording_id = r.id AND ra.role = 'primary' AND ra.position = 0
JOIN artists a ON a.id = ra.artist_id
WHERE search_fts MATCH ?
ORDER BY rank
LIMIT 50;
```

---

## Audio Engine (Rust, dedicated thread)

```
Commands (mpsc) -> AudioEngine Thread
                     |
                SourceResolver (picks best track_source for a recording)
                     |
                SourceManager (File / HTTP / Stream)
                     |
                Symphonia Decoder -> PCM Samples
                     |
                Normalizer (EBU R128, local files only) -> Volume Gain -> Rodio Sink -> cpal -> Hardware
```

- Position updates sent to frontend via Tauri Channel at 250ms intervals, frontend interpolates with rAF
- **Source resolution:** When playing a recording, the engine queries `track_sources` for the best available source (local > highest quality_score > most recently verified). If the chosen source fails, it falls back to the next one.
- Gapless: Symphonia strips encoder padding; engine pre-decodes next track's first frames. **Local files only for v1** — remote streams get crossfade instead.
- HTTP streaming: ring buffer backed MediaSource for remote audio streams
- Normalization: EBU R128 for local files. Remote streams play at native loudness (normalized only after download-to-library).
- Supports: MP3, FLAC, AAC, OGG, Opus, WAV, ALAC

### AudioController (Tauri command interface)
- `play_recording(recording_id)` — resolve best source, open stream/file, start decoding. This is the only play command — even fresh search results create a recording first (with `is_in_library = 0`).
- `pause()` / `resume()` — toggle playback
- `seek(position_ms)` — seek within current track
- `set_volume(0.0..1.0)` — adjust output gain
- `next()` / `prev()` — advance/rewind queue
- `set_shuffle(bool)` / `set_repeat(off|one|all)` — queue behavior
- `subscribe_playback(channel)` — open event stream for UI updates

---

## Plugin Architecture

### Provider Trait

```rust
#[async_trait]
pub trait SourceProvider: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self) -> SourceCapabilities;
    fn is_healthy(&self) -> bool;

    async fn search(&self, query: &str, page: u32) -> Result<SearchResults>;
    async fn resolve_stream(&self, source_id: &str) -> Result<StreamInfo>;
    async fn get_metadata(&self, source_id: &str) -> Result<TrackMetadata>;
}
```

### StreamInfo (rich, not just a URL)

```rust
pub struct StreamInfo {
    pub url: String,
    pub headers: HashMap<String, String>,    // Auth headers, cookies, referer
    pub expires_at: Option<Instant>,         // When this URL stops working
    pub mime_type: String,                   // audio/mp4, audio/webm, audio/mpeg
    pub codec: Option<String>,              // opus, aac, mp3
    pub bitrate: Option<u32>,
    pub duration_ms: Option<u64>,
    pub is_seekable: bool,                   // Can we send Range requests?
    pub needs_refresh: bool,                 // Should we call resolve_stream() again before expiry?
}
```

This means the Rust audio pipeline never needs to know provider-specific auth logic. The sidecar returns a fully-resolved `StreamInfo` with everything needed to fetch the audio. If `expires_at` is set and `needs_refresh` is true, the engine calls `resolve_stream()` again before the URL expires (relevant for YouTube's ~6-hour expiry).

### Source Orchestrator

`SourceOrchestrator` dispatches queries to all enabled, healthy providers **in parallel**, merges and deduplicates results. Deduplication matches against existing `recordings` by (title + primary artist fuzzy match) OR `musicbrainz_id`.

### Circuit Breaker

Each provider has a circuit breaker: 3 consecutive failures -> provider disabled for 30s -> 60s -> 120s (exponential backoff). Resets on first success. UI shows provider health status in Settings.

### Sidecar Communication

JS-backed providers (YouTube, SoundCloud, Bandcamp) communicate via JSON-RPC over Unix socket to the sidecar. The Rust side has a `SidecarTransport` trait:

```rust
#[async_trait]
trait SidecarTransport: Send + Sync {
    async fn call(&self, method: &str, params: Value) -> Result<Value>;
}

struct UnixSocketTransport { /* v1: macOS */ }
// Future: struct StdioTransport { /* cross-platform */ }
```

---

## Project Structure

```
mewsik/
├── src/                          # Svelte 5 frontend
│   ├── app.html                  # HTML shell
│   ├── app.css                   # Tailwind v4 + shadcn theme (OKLCH colors, @theme block)
│   ├── routes/                   # SvelteKit file-based routing
│   │   ├── +layout.svelte        # Root layout: shadcn Sidebar + persistent PlayerBar
│   │   ├── +layout.ts            # ssr = false
│   │   ├── +page.svelte          # Home / dashboard
│   │   ├── library/              # Library views (songs, albums, artists) using Tabs
│   │   ├── search/               # Federated search + Command palette
│   │   ├── playlists/            # Playlist CRUD with [id] dynamic routes
│   │   ├── stations/             # Radio stations browser
│   │   ├── discover/             # Recommendations
│   │   ├── downloads/            # Download queue with Progress bars
│   │   └── settings/             # App config + provider health status
│   └── lib/
│       ├── components/
│       │   ├── ui/               # shadcn-svelte components (auto-generated by CLI)
│       │   ├── player/           # PlayerBar, Controls, ProgressSlider, VolumeSlider
│       │   ├── library/          # TrackTable, AlbumGrid, ArtistCard
│       │   ├── search/           # SearchResults, SourceBadge
│       │   ├── playlist/         # PlaylistEditor, TrackReorder
│       │   ├── queue/            # QueueSheet, QueueItem
│       │   └── logo.svelte       # SVG mewsik logo
│       ├── state/                # Svelte 5 runes ($state) for player, library, queue, etc.
│       ├── api/                  # Tauri invoke() wrappers
│       ├── hooks/                # Svelte 5 reactive hooks (.svelte.ts)
│       ├── types/                # TypeScript types
│       └── utils.ts              # cn() helper (clsx + tailwind-merge)
├── src-tauri/src/                # Rust backend
│   ├── audio/                    # AudioEngine, queue, normalizer, stream adapter
│   ├── db/                       # SQLite connection, migrations, model CRUD
│   ├── commands/                 # Tauri IPC command handlers
│   ├── sources/                  # SourceProvider trait, orchestrator, sidecar transport, circuit breaker
│   ├── download/                 # DownloadManager, post-processing pipeline
│   ├── metadata/                 # Scanner, MusicBrainz, Cover Art, fingerprint
│   ├── discovery/                # Recommendation engine, Last.fm, local model
│   ├── keychain.rs               # macOS Keychain wrapper (security-framework)
│   └── config.rs                 # App configuration
├── sidecar/                      # Node.js sidecar
│   └── src/
│       ├── index.ts              # Unix socket JSON-RPC server
│       └── providers/            # youtube.ts, soundcloud.ts, bandcamp.ts
└── tests/                        # Integration tests
    ├── db/                       # Migration tests, FTS sync tests, constraint tests
    ├── audio/                    # Playback state machine tests
    ├── sources/                  # Provider contract tests (mock sidecar)
    └── e2e/                      # End-to-end smoke tests
```

---

## Phased Implementation

### Phase 1: Foundation + Local Playback MVP

**Exit criteria:** Can scan a folder, browse library, play local files with transport controls, and pass migration + playback tests.

**1a — Scaffolding:**
- Init SvelteKit project via `pnpm dlx sv create mewsik --add tailwindcss`
- Init Tauri v2 via `pnpm tauri init` inside the project
- Init shadcn-svelte via `pnpm dlx shadcn-svelte@latest init` (slate base color, dark default)
- Add core shadcn components: button, slider, sidebar, sheet, tabs, card, table, scroll-area, context-menu, dropdown-menu, dialog, command, badge, skeleton, sonner, toggle, toggle-group, tooltip, avatar, progress, popover, resizable, drawer, separator
- Install `@lucide/svelte`, `mode-watcher`
- Create SVG logo component (`src/lib/components/logo.svelte`)
- Set up `app.css` with brand colors in `@theme` block, dark mode as default
- Set up Rust deps: rusqlite (bundled, fts5), symphonia, rodio, cpal, lofty, tokio, serde, ulid, security-framework
- SQLite module with migrations: recordings, track_sources, artists, albums, join tables, search_fts + artists_fts
- Rust-side FTS rebuild functions: `rebuild_search_index(recording_id)`, `rebuild_all_search_indexes()`
- **Test gate:** Migration tests (up/down), FTS rebuild tests (search by artist name, album title, genre; fan-out on artist rename; fan-out on album title change), unique constraint tests (duplicate file_path, duplicate content_hash, duplicate source+source_id), playlist position compaction test

**1b — Audio Engine:**
- AudioEngine on dedicated thread with mpsc command channel
- File-based MediaSource for Symphonia
- Tauri commands: play_recording, pause, resume, seek, set_volume
- Playback state channel (position, track changes, errors)
- Queue management (add, remove, reorder, next, prev, shuffle, repeat)
- **Test gate:** Playback state machine tests (play->pause->resume->seek->next->prev, shuffle/repeat modes)

**1c — Frontend:**
- Root layout: shadcn `Sidebar` (nav) + shadcn `Resizable` panels + persistent `PlayerBar` at bottom
- PlayerBar: `Avatar` (album art), track info, shadcn `Slider` (progress + volume), `Button`/`Toggle` (transport controls), `@lucide/svelte` icons
- TrackList using shadcn `Table` with virtual scrolling (via `@tanstack/svelte-virtual`)
- Library scanner: walk directories, extract metadata with `lofty`, upsert recordings + track_sources + artists (via recording_artists)
- Library views: shadcn `Tabs` (Songs / Albums / Artists), `Card` grid for albums, `ScrollArea` for lists
- Queue panel: shadcn `Sheet` (slides from right)
- Cmd+K search: shadcn `Command` palette (local FTS5)
- Keyboard shortcuts: space (play/pause), arrows (seek/volume), Cmd+K (search)
- `Sonner` toasts for notifications
- `ContextMenu` on track rows (Play, Play Next, Add to Playlist)
- **Smoke test:** Scan folder with 100+ tracks, browse, search, play 5 tracks in sequence, verify gapless on local files

### Phase 2: Playlists & Polish

**Exit criteria:** Can create/edit/reorder playlists, search-as-you-type works, settings page functional.

- Playlist CRUD with drag-and-drop reorder (fractional position updates)
- Smart playlists (rule-based auto-population from recordings table)
- Context menus (right-click: "Add to playlist", "Play next", etc.)
- FTS5 search-as-you-type with 150ms debounce
- Album/artist detail views (using M:N join tables)
- Settings page: library paths, audio device selection, normalization on/off
- Light/dark theme toggle via `mode-watcher`
- **Test gate:** Playlist reorder doesn't produce position collisions, smart playlist evaluation, FTS ranking

### Phase 3: YouTube Streaming

**Exit criteria:** Can search YouTube, stream a result immediately, and optionally download to library. Provider contract tests pass.

- Node.js sidecar with Unix socket JSON-RPC server
- `SidecarManager` in Rust: spawn, lifecycle, health check, reconnect on crash
- YouTube provider via `youtubei.js`: search, `resolve_stream()` returning full `StreamInfo` (URL + headers + expiry + codec + seekability)
- HTTP streaming `MediaSource` in Rust: ring buffer backed, handles `StreamInfo.headers` and expiry/refresh
- Stream-first playback: clicking a search result creates a recording (`is_in_library = 0`) + track_source, then calls `play_recording()`. Plays immediately without downloading.
- "Save to Library" action: flips `is_in_library = 1` on the existing recording. Optionally triggers download to get a local copy.
- Download pipeline: HTTP fetch -> metadata enrichment (MusicBrainz) -> tag writing (lofty) -> loudness scan (ebur128) -> move to library dir -> update DB
- Downloads page in frontend: progress bars, cancel, retry
- Circuit breaker on YouTube provider
- Keychain storage for any credentials needed
- **Test gate:** Provider contract tests (search returns valid results, resolve_stream returns valid StreamInfo, StreamInfo fields are populated correctly). Mock sidecar for Rust-side tests. Manual smoke: search -> stream -> download -> verify in library.

### Phase 4: More Sources

**Exit criteria:** Federated search across all sources works. Each provider passes contract tests. Radio stations play.

- SoundCloud provider (sidecar): search, resolve_stream with client_id rotation
- Bandcamp provider (sidecar): search, resolve_stream (free + purchased via Keychain cookie)
- Federated search: SourceOrchestrator queries all healthy providers in parallel, merges, dedupes against existing recordings
- Source badges on search results (YouTube/SoundCloud/Bandcamp icons via `Badge` component)
- Source preference settings (enable/disable providers, priority ordering)
- RadioProvider via Radio-Browser.info API (Rust-native, reqwest)
- Station browsing: by country, genre, language, popularity
- Station favorites (save to `stations` table)
- Radio playback: continuous HTTP stream through audio engine
- "Now playing" metadata from ICY headers
- TorrentProvider via `librqbit` + Prowlarr/Jackett search API (user-provided instance URL from Keychain)
- Torrent result display, file selection, download-to-library via standard pipeline
- **Test gate:** Provider contract tests for each source. Federated search dedup test. Circuit breaker test (disable after 3 failures, re-enable on success).

### Phase 5: Discovery & Recommendations

**Exit criteria:** Daily Mix generates from listening history. Similar artists/tracks populated.

- Play history recording in `play_history` table (recording_id + source_used + timestamps)
- Last.fm API: `artist.getSimilar`, `track.getSimilar`, populate `recording_similarities`
- Optional Last.fm scrobbling (user provides API key via Settings, stored in Keychain)
- Local recommendation engine: playlist co-occurrence, time-weighted listening frequency, genre affinity
- "Daily Mix" auto-playlist: generated from top genres + discovery injection
- "Rediscover" feature: surface recordings not played in 30+ days from liked artists
- Discover page UI
- Radio mode from any seed (artist/recording/genre): continuous playback from similar recordings
- ListenBrainz integration (optional)
- **Test gate:** Recommendation engine unit tests (co-occurrence scoring, genre affinity). Manual smoke: play 20+ tracks, verify Daily Mix reflects patterns.

### Phase 6: Polish & Release (macOS)

- Performance profiling: SQLite EXPLAIN QUERY PLAN audit, frontend bundle analysis, memory profiling
- Error handling audit: replace all Rust `unwrap()` with proper error propagation
- Crash recovery: audio engine restarts on panic, sidecar auto-restarts
- First-run experience: library setup wizard
- App icon and branding
- Tauri bundler: DMG for macOS
- Auto-update mechanism (Tauri updater plugin)
- **Size budget:** App bundle (without sidecar) under 15MB. Sidecar compiled separately, lazy-loaded, target under 25MB. Total installed under 40MB.

---

## Key Dependencies

**Rust:** tauri 2, symphonia, rodio, cpal, rusqlite (fts5), lofty, reqwest, librqbit, ebur128, tokio, serde, security-framework, thiserror, tracing
**Sidecar (Node.js):** youtubei.js, soundcloud-downloader, bandcamp-fetch
**Frontend:** @sveltejs/kit, @sveltejs/adapter-static, @tauri-apps/api, svelte 5, @tailwindcss/vite, shadcn-svelte (bits-ui, vaul-svelte, paneforge, mode-watcher, svelte-sonner), @lucide/svelte, tailwind-variants, clsx, tailwind-merge, tw-animate-css

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| YouTube API changes | youtubei.js has active maintainers; yt-dlp fallback; Piped API as third option. Circuit breaker auto-disables on failure. |
| SoundCloud client_id breaks | Auto-rotation + caching; web scraping fallback; circuit breaker |
| Bandcamp auth changes | Cookie stored in Keychain; graceful degradation to free-quality streams |
| Provider goes down | Circuit breaker (3 failures -> backoff). Source fallback: recording plays from next-best source. UI shows provider status. |
| Sidecar crashes | SidecarManager auto-restarts with backoff. Pending requests get timeout errors. |
| Audio engine panics | `catch_unwind` + auto-restart + error event to frontend |
| SQLite write contention | WAL mode, single writer + read pool, batched transactions |
| Memory creep | Stream audio (no full-file buffering), LRU cover art cache, virtual scrolling |
| Credential leakage | All secrets in macOS Keychain via security-framework. Never in SQLite or config files. |
| Legal/DMCA (if open-sourced) | Provider integrations are plugins, not core. No hardcoded API keys or tracker URLs. App is "a music player" — sources are user-configured. Disclaimer in settings. |

---

## Verification

Each phase has explicit exit criteria and test gates (see above). Summary:

1. **Phase 1:** Migration tests, FTS trigger tests, playback state machine tests, scan+browse+play smoke test
2. **Phase 2:** Playlist integrity tests, FTS ranking test
3. **Phase 3:** Provider contract tests (mock sidecar), StreamInfo validation, search->stream->download e2e
4. **Phase 4:** Contract tests per provider, federated dedup test, circuit breaker test, radio playback
5. **Phase 5:** Recommendation engine unit tests, Daily Mix generation test
6. **Phase 6:** Performance benchmarks (memory < 50MB idle, startup < 2s), bundle size check
