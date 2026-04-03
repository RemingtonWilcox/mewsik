# Codex Handoff: Station Health Checks + Remaining Backend Work

## 1. Station Health Validation

### Problem
Favorite radio stations go stale — their stream URLs stop working but they stay in the favorites list looking normal. Users click play, nothing happens or they get an error.

### Requirements

**On app launch (background task):**
- Iterate all favorite stations from the DB
- For each, send a HEAD request to `station.url` with a 5-second timeout
- If non-200 response or timeout, increment a `fail_count` column on the station record
- If 200, reset `fail_count` to 0 and update `last_checked_at` timestamp
- Run this as a background Tokio task, not blocking the UI

**On manual re-scan:**
- The command `verify_favorite_stations` already exists but only does a HEAD request, which is insufficient — many broken stations return 200 from the HTTP endpoint but have no actual audio stream.
- **Fix:** Instead of HEAD request, open the stream URL, try to read 4-8KB of data with a 5-second timeout. Only mark as "ok" if actual data comes back. Some stations return HTML error pages with 200 status — check that the Content-Type header contains "audio" or "application/ogg" etc.
- Returns `{ station_id, status: "ok" | "stale" | "dead", last_checked_at }`
- "stale" = 1-2 consecutive failures, "dead" = 3+ failures

**DB changes:**
- Add columns to the stations table: `fail_count INTEGER DEFAULT 0`, `last_checked_at TEXT`
- Migration needed

**Frontend integration (already partially built):**
- Add a "Verify Stations" button on the stations page (next to the search bar or in the favorites header)
- Stale stations (fail_count 1-2): show a yellow/orange warning dot
- Dead stations (fail_count 3+): gray out the card, show "Station may be offline"
- Option to remove dead stations

### Key files
- `src-tauri/src/commands/stations.rs` — add `verify_favorite_stations` command
- `src-tauri/src/db/` — migration for new columns, queries for updating health status
- `src-tauri/src/lib.rs` — register new command, add startup background task
- `src/routes/stations/+page.svelte` — UI for verify button + health indicators (frontend can be done by Claude)

---

## 2. YouTube Audio Playback (Still Broken)

### Problem
YouTube stream URLs resolve successfully via youtubei.js (IOS/ANDROID_VR client), but the Rust audio engine fails to decode and play the audio. The player UI briefly shows track info then disappears.

### Root cause (likely)
The IOS client returns `audio/mp4` (AAC) format. MP4 containers require the `moov` atom (metadata at end of file) for decoding. The HTTP streaming approach feeds partial data to rodio::Decoder before the full file arrives — symphonia can't parse a partial MP4.

### Suggested fixes (in order of preference)
1. **Try ANDROID client** — may return `audio/webm` (opus) which streams fine without full file
2. **Use the full-fetch fallback** — download the entire file first, then decode. This is slower but reliable.
3. **Increase initial buffer threshold** for MP4 mime types — wait for more data before attempting decode
4. **Use ffmpeg for streaming** — pipe the URL through ffmpeg to transcode to a streamable format (the download system already uses ffmpeg for YouTube MP3 conversion)

### Detailed handoff
See `docs/codex-handoff-youtube-playback.md` for full file paths, line numbers, and debugging steps.

---

## 3. Progressive Search Results (Backend)

### Problem  
External search waits for ALL 3 sources (YouTube, SoundCloud, Bandcamp) before returning results. If one source is slow, the whole search feels slow.

### Solution
In `src-tauri/src/commands/external_search.rs`, refactor `search_all_sources` to:
1. Spawn 3 parallel tasks (one per provider)
2. As each completes, emit a Tauri event: `external-search-partial` with `{ source, results }`
3. Frontend listens for these events and appends results incrementally
4. Final `external-search-complete` event when all done

### Key files
- `src-tauri/src/commands/external_search.rs` — emit partial results via `app_handle.emit()`
- `src/routes/search/+page.svelte` — listen for Tauri events, append results (frontend can be done by Claude)
- `src/lib/api/tauri.ts` — add event listener helpers

---

## 4. Better Ranking with Play Counts (Backend)

### Problem
Search results are ranked by fuzzy text matching + source priority. No popularity signal.

### Solution
- In the sidecar providers, return `play_count` as a field on search results
- YouTube: youtubei.js music search results may include play/view counts in the item data — inspect the raw response
- SoundCloud: already has `playback_count` in search results — just expose it in the JSON-RPC response
- In `src-tauri/src/commands/external_search.rs`, add a popularity component to the scoring: `log10(play_count + 1) * 50`

### Key files
- `sidecar/src/providers/youtube.ts` — add play_count to search result items
- `sidecar/src/providers/soundcloud.ts` — expose playback_count in results
- `src-tauri/src/commands/external_search.rs` — add popularity to ranking score

---

## 5. Add Jamendo as 4th Source (Backend)

### Problem
Only 3 sources. Jamendo has 600K+ CC-licensed tracks with an excellent REST API.

### Solution
- Register at devportal.jamendo.com for free API key
- Search: `GET https://api.jamendo.com/v3.0/tracks/?client_id={KEY}&search={query}&limit=20&order=popularity_total`
- Stream: `GET https://api.jamendo.com/v3.0/tracks/file/?client_id={KEY}&id={trackId}&audioformat=mp3`
- Returns: name, artist_name, duration, image, playcount
- Direct MP3 stream URLs — no deciphering needed

### Key files to create/modify
- `sidecar/src/providers/jamendo.ts` — new provider (follow bandcamp.ts pattern)
- `sidecar/src/index.ts` — register provider
- `src-tauri/src/sources/jamendo.rs` — Rust wrapper
- `src-tauri/src/sources/mod.rs` — add module
- `src-tauri/src/sources/orchestrator.rs` — add to search_all

---

## Priority Order

1. **YouTube playback fix** — highest user impact, currently broken
2. **Station health checks** — prevents frustrating stale station experience  
3. **Progressive search** — makes search feel faster
4. **Play count ranking** — better search results quality
5. **Jamendo** — new content source, nice to have
