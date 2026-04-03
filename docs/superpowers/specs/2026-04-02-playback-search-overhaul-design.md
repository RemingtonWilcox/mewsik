# Playback & Search Overhaul — Design Spec

**Date:** 2026-04-02
**Goal:** Make external music playback fast and reliable, and make search feel like a native music app — not a laggy wrapper around broken tools.
**Scope:** Sidecar (Node.js), Rust backend (sources + commands), Svelte frontend (search page, library page, UI polish). Two sub-projects that can ship independently.

---

## Sub-project A: Fix Playback Speed & Reliability

### A1. Drop yt-dlp, Use youtubei.js for YouTube Stream Resolution

**Problem:** Every YouTube play spawns a yt-dlp binary process with a 45-second timeout. It's slow, unreliable, and often fails entirely.

**Solution:** `youtubei.js` v17 (already installed) can resolve stream URLs directly via YouTube's InnerTube API. The only missing piece is wiring up a JavaScript evaluator for signature deciphering.

**How it works:**
```js
const info = await yt.getBasicInfo(videoId);
const format = info.chooseFormat({ type: 'audio', quality: 'best' });
const url = format.decipher(yt.session.player);
```

The default evaluator in youtubei.js v17 throws an error — it requires providing a custom JS evaluator. In Node.js, this is the `Function` constructor:

```js
import { Platform, Types } from 'youtubei.js';

Platform.shim.eval = async (code: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  // Wire up the evaluator for signature deciphering
  const fn = new Function(code.output + '\nreturn exportedVars;');
  const result = fn();
  const output: Record<string, string> = {};
  if (env.sig) output.sig = result.sigFunction(env.sig as string);
  if (env.n) output.n = result.nFunction(env.n as string);
  return output;
};
```

**Impact:** Stream URL resolution drops from 5-45 seconds to ~200-500ms (single HTTPS call to InnerTube API, no binary spawn).

**Files to modify:**
- `sidecar/src/providers/youtube.ts` — Replace `resolveStream()` to use `yt.getBasicInfo()` + `chooseFormat()` + `decipher()` instead of calling yt-dlp
- `sidecar/src/utils/ytdlp.ts` — Delete (no longer needed)
- `sidecar/src/index.ts` — Add the Platform.shim.eval setup at startup, remove yt-dlp references

**Fallback:** If youtubei.js decipher fails (YouTube changes their player), the error should surface clearly to the user: "YouTube playback temporarily unavailable" rather than hanging for 45 seconds. No yt-dlp fallback — it's worse than failing fast.

**Notes on YouTube arms race:** YouTube periodically changes their player's signature algorithm. youtubei.js tracks these changes actively (v17 uses AST-based JS extraction for resilience). When breaks happen, fixes land within days. This is a fundamentally better position than depending on yt-dlp binary updates.

---

### A2. Replace soundcloud-downloader with soundcloud-fetch

**Problem:** `soundcloud-downloader` (v1.0.0) was last published 5 years ago. It works by scraping a client_id but is fragile and unmaintained.

**Solution:** Switch to `soundcloud-fetch` (v1.2.0, actively maintained, same author as `bandcamp-fetch` which we already use). It has:
- Proper `getStreamingData()` method for resolving stream URLs
- Search across tracks, albums, playlists
- Returns play counts (`playbackCount`) for ranking
- TypeScript-first

**Files to modify:**
- `sidecar/package.json` — Remove `soundcloud-downloader`, add `soundcloud-fetch`
- `sidecar/src/providers/soundcloud.ts` — Rewrite to use `soundcloud-fetch` API
- `sidecar/src/index.ts` — Update SoundCloud proxy if HLS handling changes

**Migration notes:**
- The search API is similar but returns richer data
- Stream resolution uses `track.getStreamingData()` instead of manual transcoding URL fetching
- Prefer `progressive` protocol (direct MP3 URL) over HLS, same as current behavior

---

### A3. Pre-resolve Stream URLs for Top Search Results

**Problem:** User searches, sees results, clicks a song — then waits for stream URL resolution before playback starts.

**Solution:** After search results arrive, immediately start resolving stream URLs for the top 5 results in the background. Cache the resolved URLs. When the user clicks play, the URL is already available — near-instant playback.

**Implementation:**
- After `search_all_sources` returns results to the frontend, the Rust backend kicks off background tasks to resolve streams for the top 5 results
- Resolved URLs are cached in a `HashMap<String, CachedStream>` with expiry tracking
- When `play_external` is called, check the cache first before calling the sidecar
- Cache entries respect existing expiry logic (YouTube ~6h, SoundCloud ~30min)

**Files to modify:**
- `src-tauri/src/commands/external_search.rs` — Add pre-resolve after search completes
- `src-tauri/src/sources/orchestrator.rs` — Add stream cache and background resolution
- `src-tauri/src/commands/playback.rs` — Check cache before resolving

---

### A4. Downloads Auto-Add to Library

**Problem:** Downloading a song doesn't add it to your library. You have to also click the heart button separately, which makes no sense.

**Solution:** After a successful download completes, automatically call `set_in_library(recording_id, true)`.

**Files to modify:**
- `src-tauri/src/download/mod.rs` — After `upsert_download_source()` succeeds, call `set_in_library(recording_id, true)` on the database

**This is a one-line fix** in the download completion handler.

---

### A5. Keep Bandcamp (No Changes)

Bandcamp stays as-is. It's the fastest/most reliable provider, costs nothing to keep, and surfaces indie music the others don't have. No code changes needed.

---

## Sub-project B: Search & UI Improvements

### B1. Search Page Becomes External-Only

**Problem:** Search defaults to a "Library" tab, which is confusing. Users expect Search to mean "find new music online."

**Solution:** Remove the Library/External tabs entirely. The Search page (`/search`) is always external search. The input, results display, and all behavior stay the same — just remove the tab switcher and the local search code path.

**Files to modify:**
- `src/routes/search/+page.svelte` — Remove `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` components. Remove `activeTab` state, local search logic, `searchLocal()`, `toLibraryTracks()`. Keep the external search input, results table, and all external action buttons (play, heart, download).
- Remove the `TrackTable` import (no longer used on this page)

---

### B2. Library Page Gets a Filter Bar

**Problem:** No way to search/filter within your own library from the Library page.

**Solution:** Add a search/filter input at the top of the Library page. It filters the already-loaded tracks, albums, and artists in real-time — no network calls, just client-side filtering on the existing data.

**Implementation:**
- Add an `Input` with a search icon at the top of `/library`
- Filter `tracks`, `albums`, `artists` arrays by matching query against title, artist name, album title (case-insensitive includes)
- Filtering is instant (no debounce needed since it's local data)
- Clear button to reset filter
- Show count of filtered results vs total

**Files to modify:**
- `src/routes/library/+page.svelte` — Add filter input and filtering logic

---

### B3. Progressive Search Results (Stream as Each Source Responds)

**Problem:** Search waits for all 3 sources to respond before showing anything. If YouTube is slow, the whole search feels slow.

**Solution:** Fire provider searches in parallel from Rust. As each provider's results arrive, emit them to the frontend via Tauri events. The frontend renders results incrementally.

**Implementation:**
- Rust side: Spawn 3 parallel tasks for youtube.search, soundcloud.search, bandcamp.search
- As each completes, emit a Tauri event: `external-search-partial` with `{ source, results }` 
- Frontend listens for these events and appends results to the list, re-sorting by score
- Show a per-source loading indicator (e.g., "YouTube..." spinner until those results arrive)
- Final `external-search-complete` event signals all sources are done

**Files to modify:**
- `src-tauri/src/commands/external_search.rs` — Refactor `search_all_sources` to emit partial results
- `src/routes/search/+page.svelte` — Listen for Tauri events, append results progressively
- `src/lib/api/tauri.ts` — Add event listener helpers

---

### B4. Source Badges Use Icons Instead of Text

**Problem:** Every search result has a text badge like "youtube", "soundcloud", "bandcamp" which takes too much space and looks clunky.

**Solution:** Replace text badges with small recognizable icons/logos for each source.

**Options for icons:**
- Use inline SVG logos (YouTube play button, SoundCloud cloud, Bandcamp diamond)
- Keep them small (16x16) and use the source's brand color as the icon fill
- Tooltip on hover shows the full source name

**Files to modify:**
- `src/routes/search/+page.svelte` — Replace `<Badge>` with source icon components
- Create `src/lib/components/source-icon.svelte` — Simple component that maps source name to SVG icon

---

### B5. Heart/Favorite Button — Immediate Green Highlight + Feedback

**Problem:** When you click the heart on a search result, nothing visually changes (or it's so laggy you can't tell). No feedback that the action worked.

**Solution:**
- **Optimistic UI:** Immediately highlight the heart green on click, before the API call completes
- **Animation:** Brief scale pulse on the heart icon (scale up to 1.2x, back to 1x over 200ms)
- **Toast:** Keep the existing `toast.success()` for confirmation
- **Error rollback:** If the save fails, revert the heart color and show an error toast

**Implementation:**
- Track a local `Set<string>` of saved source IDs (optimistic state)
- On click: add to set immediately (heart turns green), fire API call
- On success: keep green
- On failure: remove from set (heart reverts), show error toast

**Files to modify:**
- `src/routes/search/+page.svelte` — Add `savedIds` state set, optimistic toggle logic, heart color binding, CSS animation

---

### B6. Better Ranking Using Play Counts

**Problem:** Search results have a scoring system but it's mostly based on fuzzy text matching + source priority. No popularity signal.

**Solution:** Use play counts from the source APIs to weight ranking:
- YouTube Music: results are already ranked by YouTube's algorithm (popularity-weighted)
- SoundCloud: `playbackCount` and `likesCount` are already returned — weight these more heavily in scoring
- Bandcamp: No play counts available, keep current scoring

**Implementation:**
- In the sidecar, return `play_count` as a field on search results where available
- In the Rust ranking function, add a popularity component: `log10(play_count + 1) * 50` to the score
- This naturally boosts well-known tracks without completely burying obscure ones

**Files to modify:**
- `sidecar/src/providers/youtube.ts` — Extract view/play count from youtubei.js response
- `sidecar/src/providers/soundcloud.ts` — Already has playback_count, expose in result
- `src-tauri/src/commands/external_search.rs` — Add popularity component to scoring

---

### B7. Add Jamendo as a 4th Source

**Problem:** Only 3 sources, and they're all commercial platforms with various restrictions.

**Solution:** Add Jamendo — 600K+ CC-licensed tracks, excellent REST API (v3), returns direct MP3/OGG stream URLs. No signature deciphering, no client_id scraping.

**API overview:**
- Search: `GET /tracks/?search={query}&limit=20&order=popularity_total`
- Stream: `GET /tracks/file/?id={trackId}&audioformat=mp3` (direct stream URL)
- Returns: name, artist_name, duration, image (cover art), playcount
- Rate limit: Requires free API key (register at devportal.jamendo.com)
- Speed: Fast — direct REST, no intermediaries

**Implementation:**
- Add `JamendoProvider` in the sidecar following the same pattern as BandcampProvider
- No special stream resolution needed — Jamendo returns direct URLs
- Register for a free API key and store in app config/env
- Source icon: Jamendo's orange record icon

**Files to create/modify:**
- `sidecar/src/providers/jamendo.ts` — New provider
- `sidecar/src/index.ts` — Register Jamendo provider
- `src-tauri/src/sources/jamendo.rs` — Rust side provider wrapper (follows same pattern as bandcamp.rs)
- `src-tauri/src/sources/orchestrator.rs` — Add Jamendo to search_all
- `src/lib/components/source-icon.svelte` — Add Jamendo icon

---

## Dependency Changes

### Sidecar (`sidecar/package.json`):
- **Remove:** `soundcloud-downloader`
- **Add:** `soundcloud-fetch` ^1.2.0

### No Rust dependency changes needed.

### Delete:
- `sidecar/src/utils/ytdlp.ts` (yt-dlp wrapper, no longer needed)

---

## Implementation Order

Sub-project A should ship first (fixes the broken/slow playback):
1. A1 — YouTube fix (highest impact, fixes broken playback)
2. A2 — SoundCloud upgrade (replaces abandoned dependency)
3. A4 — Downloads auto-add to library (one-line fix)
4. A3 — Pre-resolve URLs (speed optimization)

Sub-project B ships second (improves search & UI):
1. B1 — Search becomes external-only (simple removal)
2. B2 — Library filter bar (simple addition)
3. B5 — Heart button feedback (UI polish)
4. B4 — Source icons (UI polish)
5. B3 — Progressive results (architecture change)
6. B6 — Better ranking (scoring tweak)
7. B7 — Jamendo source (new feature)

---

## What Stays the Same

- Audio engine (rodio + symphonia) — no changes to actual playback/decoding
- Database schema — no migrations needed (downloads already create TrackSource entries)
- Sidecar IPC protocol — JSON-RPC over Unix socket stays the same
- Bandcamp provider — untouched
- Queue system, shuffle, repeat — untouched
- Player bar, waveform scrubber — untouched (just got polished)
