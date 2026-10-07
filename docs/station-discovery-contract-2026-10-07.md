# Station discovery contract (2026-10-07)

Why: the Stations page's "discover" view is 22 hand-picked stations in 7
fixed collections, identical for everyone, no listening signal, no genre reach
(nothing for hip-hop subgenres, punk, metal, workout). This replaces it with a
live, cached, rotating, history-aware feed built from radio-browser.info.

Both halves are built against this document. Names, shapes and semantics
below are the contract; do not rename without updating the other side.

## Scenes (static catalog, Rust owns it)

A **scene** is a genre family or mood with one or more radio-browser tag
queries. `SceneInfo` is what the frontend sees:

```ts
type SceneInfo = {
  id: string;            // kebab-case, stable, e.g. "hip-hop", "workout"
  title: string;         // "Hip-hop"
  eyebrow: string;       // short label above the title, e.g. "Rap & beats"
  description: string;   // one sentence
  family: 'workout' | 'hiphop' | 'rock' | 'electronic' | 'chill' | 'soul' | 'world' | 'pop' | 'classic';
  accent: string;        // tailwind gradient classes for the card, e.g. "from-rose-500/30 to-transparent"
};
```

Required scenes (ids fixed): `workout`, `hip-hop`, `trap`, `boom-bap`,
`lofi-hip-hop`, `uk-rap-drill`, `rnb-soul`, `punk`, `metal`, `hardcore`,
`classic-rock`, `indie-alt`, `house`, `techno`, `drum-and-bass`, `trance`,
`ambient`, `synthwave`, `jazz`, `funk`, `reggae-dub`, `latin`, `afrobeats`,
`country`, `classical`, `pop-hits`, `80s-90s`, `chill-study`, `oldies`.
Each carries 1–4 radio-browser tag terms (e.g. workout → `workout`, `gym`,
`fitness`, `high energy`), a minimum bitrate (default 64 kbps) and an optional
`exclude_tags` list.

## Cache (SQLite, migration 8)

```sql
CREATE TABLE IF NOT EXISTS scene_stations (
    scene_id        TEXT NOT NULL,
    station_uuid    TEXT NOT NULL,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    url_resolved    TEXT,
    homepage        TEXT,
    favicon         TEXT,
    country         TEXT,
    countrycode     TEXT,
    language        TEXT,
    tags            TEXT,
    codec           TEXT,
    bitrate         INTEGER,
    votes           INTEGER NOT NULL DEFAULT 0,
    clickcount      INTEGER NOT NULL DEFAULT 0,
    clicktrend      INTEGER NOT NULL DEFAULT 0,
    fetched_at      TEXT NOT NULL,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    PRIMARY KEY (scene_id, station_uuid)
);
CREATE INDEX IF NOT EXISTS idx_scene_stations_uuid ON scene_stations(station_uuid);
CREATE TABLE IF NOT EXISTS scene_refresh (
    scene_id     TEXT PRIMARY KEY,
    refreshed_at TEXT NOT NULL,
    station_count INTEGER NOT NULL
);
```

Refresh cadence: a scene is stale after 24 h. `refresh_station_scenes` pulls
up to 60 stations per tag term (`order=votes&reverse=true&hidebroken=true`),
drops HLS (`hls = 1`), drops bitrate below the scene minimum, dedupes by
uuid, upserts rows, and deletes rows that were not returned this time and have
`fail_count >= 3`. New rows get a probe (reuse the health module's URL
verifier, batches of 8, 5 s timeout, at most 100 per refresh); failures set
`fail_count = 1`. Rows with `fail_count >= 2` are excluded from every shelf.
Stations the user has favorited are never pruned from `stations`; this table
only holds the directory cache.

A daily health sweep (reuse the 6 h favorites health loop's scheduling style,
but at 24 h) probes 40 cached stations with the oldest `last_checked_at`,
increments or resets `fail_count`, and deletes rows reaching 3.

## Signals from history

Radio plays exist in `play_history` with `station_id` (local `stations.id`),
`listened_ms` and `end_reason`. Join through `stations.radio_browser_id` to the
uuid. Per uuid compute:

- `plays`: rows in the last 90 days
- `bails`: rows with `listened_ms < 20000` and `end_reason` in
  (`stopped`, `source_changed`, `skipped_next`, `skipped_previous`)
- `bail_rate = bails / plays` (0 when plays < 2)
- `listened_ms` total, `last_played_at`

A high bail rate is the proxy for "forces an ad on join" or "not what the
tag promised". It demotes, never removes.

Scene affinity: for each scene, sum `listened_ms` of the user's plays whose
station tags intersect the scene's tag terms (case-insensitive, comma split);
normalise to 0–1 across scenes.

## Ranking

For a candidate row in a scene:

```
quality  = 0.5*ln(1+votes) + 0.3*ln(1+clickcount) + 0.2*clamp(clicktrend/20, -1, 1)
         + 0.15*clamp((bitrate-64)/128, 0, 1)
penalty  = 2.0*bail_rate + 3.0*fail_count + recency
recency  = 1.0 if last_played_at within 3 days else 0 (variety, not exclusion)
score    = quality - penalty
```

Shelf selection takes the top 24 by score, then picks 8 with a **daily
deterministic shuffle** weighted by score: seed = FNV-1a of
`"{scene_id}:{YYYY-MM-DD}:{install_salt}"`, where `install_salt` is a random
string created once and stored in the `settings`/config store (reuse whatever
key-value mechanism exists; if none, `scene_refresh` may hold a row with
`scene_id = '_salt'`). Same day → same shelf; next day → different mix.

## Feed shape (what the frontend renders)

```ts
type StationPick = {
  station: RadioBrowserStation;   // the existing frontend type; url must be playable (prefer url_resolved)
  sceneId: string | null;
  reason: string;                 // short human line: "Because you listened to Liquid DnB", "Rising this week", "Fresh today"
  score: number;
  bailRate: number;               // 0..1
  plays: number;                  // user's plays of this station
};

type StationShelf = {
  id: string;                     // "for-you" | "fresh" | `scene:${sceneId}`
  kind: 'for_you' | 'fresh' | 'scene';
  title: string;
  subtitle: string;
  sceneId: string | null;
  items: StationPick[];           // 8 for scenes, up to 12 for for-you/fresh
};

type StationDiscoveryFeed = {
  generatedAt: string;            // ISO
  status: 'ready' | 'empty' | 'refreshing';
  cacheAgeSeconds: number | null;
  shelves: StationShelf[];        // order: for-you (if any history), fresh, then scenes by affinity desc then catalog order
  scenes: SceneInfo[];            // full catalog, catalog order
};
```

`for_you` rules: needs at least 3 radio plays; items = (a) the user's top
stations by listened time that are not favorites, (b) unplayed stations from
the user's top 3 affinity scenes. With fewer than 3 plays the shelf is
omitted and `fresh` goes first.

`fresh` rules: 12 stations across all scenes not played in the last 14 days,
chosen by the daily seeded shuffle over the top-scored 120.

Serde: Rust structs use `#[serde(rename_all = "camelCase")]` so the TS shapes
above are exact.

## Tauri commands (Rust names, invoked by the frontend)

| command | args | returns |
|---|---|---|
| `get_station_discovery` | – | `StationDiscoveryFeed` (never blocks on the network; `status: 'empty'` when nothing cached, and it spawns a background refresh in that case) |
| `refresh_station_scenes` | `{ force: boolean }` | `{ scenes: number; stations: number; pruned: number; tookMs: number }` (async, does the network work; `force` ignores the 24 h cadence) |
| `get_station_scenes` | – | `SceneInfo[]` |
| `get_scene_stations` | `{ sceneId: string; limit?: number; offset?: number }` | `StationPick[]` ranked, no daily shuffle, for "See all" |

Startup: `lib.rs` spawns a refresh 8 s after launch when any scene is stale
(so a fresh install populates itself) and the daily health sweep.

Frontend API (`src/lib/api/tauri.ts`): `getStationDiscovery()`,
`refreshStationScenes(force)`, `getStationScenes()`,
`getSceneStations(sceneId, limit?, offset?)`, all via `safeInvoke` with the
usual empty fallbacks. Playing a pick uses the existing
`playStationSearchResult(pick.station)`.

## Page behaviour (frontend owns)

Discover view of `/stations`:

1. Hero: first item of the first shelf, with the shelf's reason line and a
   Play button named `Play {station name}` (the e2e relies on this pattern).
2. Shelves in feed order, each a horizontal snap rail of cards (works at
   390 px), card = favicon or initial, name, country · codec/bitrate,
   reason, health dot (probe at most 12 visible picks with
   `verifyStationUrls`, same "Checking stream" affordance as today).
3. Scene chips row (all scenes) above the shelves; tapping a chip scrolls to
   that shelf or, if it is not in the feed, opens "See all" for it.
4. "See all" per scene: in-page expansion using `getSceneStations`.
5. Refresh button + "updated N min ago" from `cacheAgeSeconds`; while
   `status === 'refreshing'` show skeleton rails and re-query every 2 s until
   `ready` (cap 60 s).
6. Keep the Editor picks: the existing curated collections become one
   collapsed "Editor picks" shelf at the bottom (the e2e that checks curated
   ids keeps passing).
7. Favorites and Directory views unchanged.

Update `e2e/stations-discovery.spec.ts` to the new discover view (the test
that expects "Mewsik Picks · 22 researched streams" and clicks "Deep focus"
must be rewritten against the shelf UI; in the browser lab the backend is
absent, so `safeInvoke` falls back to an empty feed: the page must render an
honest empty state with the scene chips still visible, and the Editor picks
shelf still present).
