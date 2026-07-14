# mewsik project handoff

_Last updated: 2026-07-14_

## Product direction

The visualizer now has three named, deliberate roles:

- **Prism** (`mk1`) is rhythmic geometry and the production impact anchor.
- **Soma** (`mk2`) is a living fractal focused on cinematic evolution.
- **Signal** (`signal`) is the audio-first phosphor score built around one crisp trace, controlled persistence, transient echoes, and negative space.

The former Mk3 particle plane and layered Runtime were removed. Git history is the archive for those experiments.

## Active implementation

- Branch: `codex/visualizer-rebuild`
- Approved pre-shell checkpoint: `ac6886d feat: give Mk2 a musical lifecycle`
- Approved instrument-shell checkpoint: `881991c feat: unify visualizer instrument controls`
- Approved project-surface checkpoint: `e6730fa feat: rebuild discovery and product surfaces`
- Engine order: `mk1 -> mk2 -> signal`
- Saved `auto`, `runtime`, or unknown selections migrate to `mk1`.
- Saved `mk3` selections migrate to `signal`.
- The visualizer lab at `/visualizer-test` exposes only Mk1, Mk2, and Signal, with synthetic/real audio input and live analysis diagnostics.

### Production instrument shell

Production now mounts one renderer plus one shared host-owned control layer. The renderers no longer stack their own close targets, names, telemetry, and shortcut text over the artwork.

- A compact top rail names Prism, Soma, and Signal and exposes previous/next arrows, details, hide, and close controls.
- `Left` / `Right` cycle with wrapping, `I` toggles details, `H` hides/reveals controls, and `Escape` closes. The old `V` shortcut is retired.
- Clicking empty artwork toggles the chrome instead of accidentally closing the visualizer.
- Details show the engine's role, live section, tempo, and one engine-specific state without exposing lab diagnostics.
- Shared **Calm**, **Flow**, and **Surge** response profiles scale each engine around its authored identity. Flow is exactly neutral; Soma glides response changes to prevent camera jumps.
- The rail and player bar now share one 2.2-second idle clock and one 250 ms fade, so they disappear and return together instead of behaving like unrelated overlays.
- Pointer activity wakes the chrome only from the Mewsik surface. Hover, focus, dragging, and open details hold both layers visible; leaving the app hides auto chrome.
- Manual **Hide** is a real locked state: ordinary mouse movement and engine switching cannot undo it. `H`, `I`, or an explicit stage click reveals it again.
- The engine rail is capped at 26 rem and 40 px tall so it reads as a compact instrument switcher rather than a second player bar.
- Opening moves focus into the overlay, closing restores the player-bar opener, and covered app content becomes inert while the visualizer is active. The player bar remains available.
- Command search is suppressed while the visualizer owns the screen, avoiding a focused dialog behind the GPU surface.
- Desktop and 390 px mobile layouts were visually inspected in a real Chromium WebGPU session; the browser console reported zero errors.

### Shared musical journey

One CPU-only `VisualizerJourneyRuntime` owns the director, adaptive spectrum, Signal conductor, and Mk2 conductor. It advances once per analyzer or silence tick and remains alive while the visualizer overlay is active, including time spent rendering Mk1. Signal and Mk2 therefore re-enter the current arrangement instead of restarting their intro state when engines are cycled. Their GPU devices, textures, buffers, canvases, and feedback history still mount and tear down independently.

Canonical source identity includes source type, recording, URL, and station, plus a monotonic source epoch so A -> B -> A cannot reuse stale temporal state. Source changes clear the CPU journey and renderer feedback in the same frame. Closing the entire overlay intentionally stops the native analyzer subscription; continuous live-audio journey tracking resumes when the overlay is opened again.

### Mk2

Mk2 keeps its volumetric Mandelbulb identity but now:

- renders at a true 60 FPS cap and 72% internal scale;
- removes the nested fog shadow raymarch that caused multiplicative shader work;
- uses 48 primary ray steps and 6 fractal iterations for normal shots, rising to 56 steps and 7–8 iterations only during elected macro studies, plus 5 shadow probes and 2 AO probes;
- shares Signal's musical analysis and adds a dedicated slow conductor with six continuous lifecycle forms: seed, sprout, winding, bloom, shedding, and dormancy;
- replaces the hidden hair-thin tendrils with four thick external limbs/buds, a localized bass root, an exterior-intersecting cavity, and coherent shed fragments while retaining one Mandelbulb evaluation;
- routes sub/kick to root mass, body/mids to elongation/lobes/folds, presence/air to ridges/filaments/erosion, and signed spectral travel to anatomical lean and deformation flow;
- crossfades waxy, wet-organic, taut/chitinous, crystalline, porous, and dormant material identities while evolving palette warmth, reflection, roughness, and lighting arrangement with lifecycle, harmony, and spectral character;
- treats density as body pigment/substance rather than opacity, with a tested `0.30` floor so no lifecycle can collapse into a white ghost shell;
- activates the previously dormant density, ridge, and iridescence rails, adds one stable hit-time skin octave, and recovers pale or neutral palette stops into noise-varied lifecycle pigment before lighting;
- keeps geometric lighting normals and confines the extra material octave to pigment and roughness, avoiding both a detached texture overlay and the four-noise finite-difference cost of a bump-normal pass;
- preserves crevice depth while giving diffuse pigment an AO floor, and rebalances crystal/porous stages so reflection, rim, and specular energy cannot erase the organism's body color;
- turns near-surface fog into a density/erosion/cavity exchange: dense tissue clears its silhouette while shedding transfers substance into the atmospheric current;
- lets suspense foreshadow upcoming splits and erosion in the background while accelerating only a forward-integrated flow phase, so the current never rewinds when tension releases;
- expands, contracts, sprouts, winds, blooms, hollows, sheds, turns, and punches with bounded motion instead of reacting independently to every beat;
- uses impact as a restrained lower-anatomy material response instead of camera shake, scale jolts, full-frame flashes, or an emissive surface decal;
- replaces the white-dot particle aura and flickering grain with one world-space atmospheric current, camera parallax, and a dark pocket behind the organism;
- lets that same atmospheric current split during bloom and fray during shedding instead of remaining a static backdrop;
- replaces the stop/start Catmull-Rom waypoint loop with one seeded continuous camera drift, then lets sustained musical detail elect rare smooth close studies with independent zoom, azimuth, elevation, framing, and macro fidelity rails;
- removes the diagonal vein/emission mask, direct FFT-to-albedo bands, procedural SDF corrugation, chromatic aberration, and anamorphic streaks; one geometry-bound pore field and analytic colored reflections now follow the actual surface;
- reduces the render graph from nine passes to eight and removes the particle pipeline, particle textures, upload, and pass completely;
- keeps a stable per-track palette family while continuously moving through its colors and glides through section-aware framing rather than hard-cutting or snapping;
- exaggerates lifecycle anatomy without adding another fractal evaluation: seed compacts, sprout bends and stretches, winding compresses/twists, bloom opens into broader lobes and buds, shedding exposes a larger cavity and fragments, and dormancy settles into a flattened shell;
- gives the atmospheric current lifecycle-specific width, splitting, and breakup so the background and body visibly foreshadow and trade substance with one another;
- recovers pigment more aggressively through pale palette moments and caps diffuse washout, allowing white to remain a highlight instead of becoming the whole low-opacity body;
- performs complete pending-init and GPU-resource cleanup.

### Signal

Signal is a new WebGPU renderer, not a modification of old Mk3. It uses:

- one dominant Lissajous/vector trace;
- decoded spectral residuals for selective bass body, mid deformation, treble detail, and controlled onset echoes;
- continuous tempo-integrated spectral travel, eased phrase asymmetry, and slow one-to-two-bar topology evolution;
- section progress, energy slope, lookahead, track progress, suspense, and release to make arrangements coast through a song instead of repeating a beat loop;
- separate short ring-out and sustained openness controls so impacts decay without flattening the larger musical arc;
- restrained cyan/green color with brief warm transient accents;
- two feedback textures and two render passes;
- a 60 FPS cap, 75% internal scale, and a 1080p internal pixel ceiling;
- no compute simulation, particle field, bloom pyramid, or blended motif stack.

The current analyzer exposes mono spectral features rather than raw stereo samples, so Signal is vectorscope-inspired rather than a literal stereo phase scope.

### Discovery, search, stations, and settings

The product surfaces were rebuilt around explicit jobs instead of overlapping dashboards.

- Discovery v2 combines Apple's public U.S., U.K., Japan, and Brazil charts, ListenBrainz fresh releases, and current Bandcamp Daily editorial. Official Last.fm and YouTube signals activate only when developer/runtime keys are configured; listeners are not expected to provide them, and the UI reports missing signals as unavailable rather than inventing data.
- Cold Search and Discover loads now show an accessible staged status panel with real elapsed time and an indeterminate progress bar. Apple territories refresh concurrently and remain deterministically ordered, reducing their worst-case cold delay from four serial request windows to one.
- Every source has bounded requests, a declared refresh cadence, typed track/release/editorial records, stable provider IDs, and separately stored listeners, plays, views, and likes. A stale Bandcamp feed is rejected instead of presented as current.
- Source cadences are enforced independently: a one-hour YouTube refresh does not re-fetch daily ListenBrainz releases or four-hour Apple charts. Missing Apple territories can be filled from their own recent saved frame without relabeling the partial response as complete.
- Canonical entities, external IDs, source observations, snapshots, and interaction events live in dedicated SQLite tables. External-ID collisions fail atomically instead of silently merging unrelated music.
- Observation history keeps the latest 48 coherent frames per source/scope, interaction events expire after 400 days, and orphaned provider entities are cleaned up so hourly refreshes cannot grow the database forever.
- Shelves have distinct jobs: **Top now**, **Moving fast**, **New and worth a look**, **For you**, **Outside your bubble**, and **Editors found this**. Personal shelves remain absent until the five-qualified-track profile boundary is met.
- **Moving fast** is never fabricated on the first sample. It appears only after a saved prior observation proves rank or audience growth. Apple markets count as one source family, so four regional charts cannot fake independent-source agreement.
- Fresh releases need actual traction, editorial support, or taste affinity; a zero-play release dump cannot fill the page. Entity and lead-artist caps prevent one artist and their collaborations from consuming a shelf, while known group names are preserved.
- Each card exposes one plain-English reason, such as chart rank, release age, measured movement, or editorial origin. Source health is visible as live, cached, or unavailable, with a persistent snapshot and one-minute forced-refresh guard.
- Healthy source data stays cached by source cadence, while failed refreshes fall back to recent observations, then the last saved feed, then explicitly labeled static picks. Stale data is never relabeled as live.
- Selecting a discovery card writes `/search?q=...` and runs the normal YouTube, SoundCloud, and Bandcamp search exactly once. The page keeps its loader visible while providers work, preserves partial results, exposes provider failures with Retry, and only says **No results** after a conclusive completed search.
- Discovery clicks are recorded with item, shelf, and snapshot IDs for future ranking evaluation. A click remains a click; it is not mislabeled as a save, completed listen, or recommendation success.
- External search validates queries and provider names, rejects malformed sidecar responses, and no longer converts total provider failure into a fake successful empty result. Incomplete failures are not cached.
- Packaged Windows search no longer passes Node the verbatim `\\?\` canonical entry-script path that made Node exit with `EISDIR` before any provider could answer. The script remains canonicalized and security-checked first, then receives a normal Windows child-process argument.
- Search-sidecar requests are isolated by process generation, restart once only for real transport failures, and retain successful provider results when another provider is down. Opaque request tokens prevent delayed events from an older search or retry from overwriting the current results.
- Release builds now keep a bounded native log with sidecar spawn, restart, exit, and retirement evidence, so future packaged-only failures can be diagnosed from the real installed process instead of guessed from a browser mock.
- Discover now has three honest states: useful onboarding with no library, qualified-listen profile progress, and a personal rotation once enough listening exists. Thirty seconds of actual audible time drives affinity, history, rediscovery, and play statistics; paused time and short skips do not tune the profile.
- Playback history now separates track length from audible listening time and records why a play ended. Natural end, stop, next/previous, source replacement, errors, and shutdown are finalized distinctly and idempotently; only a natural end is a completion.
- Playback errors carry their originating session ID, so a late failure from an old asynchronous fetch cannot stop or falsely finalize the newer song that replaced it.
- Schema migrations and their version markers now commit in one transaction. A crash between `ALTER TABLE` and the marker rolls the schema back cleanly instead of leaving the next launch stuck on a duplicate column.
- Discover provides a stable local rotation, recent listening, long-unplayed saves, and a permanent **Beyond your library** search-inspiration shelf. Refresh remains deterministic until the listening history actually changes.
- The learning boundary is canonical end to end: five distinct tracks listened to for at least 30 seconds. Repeating one track five times no longer activates a profile that the UI still calls unfinished.
- Stations has dedicated **Discover / Favorites / Directory** views. Discover is curated, Favorites is saved radio, and Directory is the global catalog; clearing directory search no longer throws the user back into another view.
- Curated and favorite cards show only local connection health. Directory cards show one metric matching the active ranking (starts, change, votes, or bitrate) rather than a wall of ambiguous telemetry.
- Directory probes are capped to 12 visible streams, bulk detail lookup is capped to 100 IDs, saved results use a passive **Saved** label, and **Check stations** stays actionable while reporting its latest result separately.
- Directory pagination carries a raw Radio Browser cursor across filtered HLS rows, so an unplayable stream can neither hide **Load more** nor cause overlaps between pages.
- Settings is now a real library and appearance surface: track/artist/album summary, native folder picker, removable saved folders, resilient scan-all behavior, Light/Dark/System controls, and a collapsed provider-repair section for exceptional search failures.
- Newly added library paths must be existing directories; an already-saved disconnected drive can remain visible and removable rather than bricking settings startup.
- Library path identity is case-insensitive on Windows and case-sensitive on Unix targets, preserving valid case-distinct folders without allowing a differently cased nonexistent path to bypass validation.

### Downloads and user-owned storage

- New downloads no longer default to the private `%APPDATA%` tree. The platform Music folder under `Mewsik` is preferred, Downloads is the public fallback, and private app data is used only when neither known folder exists.
- Settings shows the exact destination and provides native **Show folder**, **Change folder**, and **Use default** actions. Changing it affects future jobs only; each active job owns the destination captured when it was queued.
- Existing downloads remain at their absolute paths and are never silently moved or deleted. The Settings card reports legacy AppData files and their size so an explicit migration can be added later without risking current media.
- Missing or disconnected files now retain both their download and managed-source records in a recoverable `missing` state. Reconnecting the drive restores them, while playback performs a recording-scoped check and falls back to a valid remote source instead of selecting a stale local path.
- Downloads-page polling is DB-only. **Check files** performs the explicit full filesystem reconciliation on a blocking worker, and a failed **Show in folder** action triggers the same repair check.
- Download-directory validation creates and verifies a writable destination before inserting a job. Same-title jobs reserve filenames atomically, so concurrent downloads cannot overwrite one another.
- Config persistence uses a same-directory temporary file, flush, and atomic replacement; older config files deserialize with the new field at its safe default.
- The full queue/continuity and visual expansion direction is captured in `docs/product-direction-2026-07-14.md`. The first backend-owned continuity milestone is now implemented; true source prebuffering/gapless handoff remains separate work.

### Deterministic playback continuation

- Playback sessions now own queue/context continuation explicitly. The audio worker acknowledges the exact request only after a local or remote source really starts, preventing an old async start from extending a replacement queue.
- Stop, error, radio takeover, queue replacement, and raw error-stop paths invalidate the corresponding owner. A stale failure or recommendation worker cannot mutate the newer playback session.
- Continuation waits for actual start readiness without the old two-second false timeout, but exits when the queue moves away from its anchor, output disappears, or the bounded failsafe expires.
- The first playable recommendation is appended as soon as it is known; the remaining tail can arrive later without reordering existing user choices.
- External provider context is capped, deduplicated, and falls back deterministically when the provider tail is unusable.
- Recommendation ranking uses an independent read-only SQLite WAL connection for on-disk libraries so it cannot hold the main application database mutex during playback handoff.
- This is deterministic metadata/source continuation, not true decoded-audio prebuffering or sample-accurate gapless playback.

### Windows updates and release safety

- Version `0.2.0` introduces the updater UI and native shutdown gate. Normal source/local builds deliberately do not register the updater plugin and report updates unavailable; only the protected release build supplies a public key, endpoint, and `MEWSIK_UPDATE_CHANNEL=stable`.
- Update install is user-confirmed. The package is downloaded and signature-verified first, then native code atomically blocks new music downloads, refuses to proceed while one is active, and shuts down the sidecar, playback, and tracked FFmpeg children before handing control to NSIS.
- A music download that starts while the application package is downloading postpones installation without throwing away the verified package. Repeated clicks and install/relaunch recovery paths are guarded and covered by browser tests.
- `.github/workflows/draft-windows-release.yml` is manual-only, tied to the exact default-branch ref and protected `release` environment, requires a strictly increasing stable version plus typed confirmation, proves the Tauri updater keypair, runs all gates, requires Azure Artifact Signing, and creates a draft rather than publishing automatically.
- Release configuration is generated into an ignored credential-free merge file. The workflow has no unsigned fallback and no real private key, password, certificate, or Azure secret is stored in this repository.
- Version `0.1.0` cannot update itself; installing the first signed `0.2.0` candidate is a one-time manual bootstrap. macOS still uses the existing native sign/notarize script and does not yet participate in the updater feed.

### Audio-level contract

Native RMS and peak are now calculated from the unwindowed PCM waveform. The old implementation calculated both from FFT magnitudes that had already been divided by the FFT size, making a controlled 0.8-amplitude sine report RMS `0.00765` instead of `0.56569`. That kept Signal's silence gate closed and muted RMS-driven section changes in Mk1 and Mk2.

The browser lab now uses `AnalyserNode.getFloatTimeDomainData()` and the same normalized 0..1 waveform formula. Spectral bins, onset, centroid, and chroma remain separate frequency-domain features.

## Verification status

Completed on the combined branch and packaged native release:

- `pnpm check`: 0 errors, 0 warnings
- `pnpm build`: pass
- `pnpm test:e2e -- --workers=4`: 65/65 pass on a clean Vite server, including 11 updater state/race/recovery scenarios
- `cargo test --all-targets`: 139 pass, 0 fail, 3 intentionally ignored live-provider tests
- Disposable release-contract test: a real generated Tauri keypair passed sign/verify and credential-exclusion checks; wrong refs, prerelease versions, non-increasing versions, and mismatched keys were rejected. The disposable key and generated config were removed afterward.
- Local-build startup smoke: the updater plugin remains unregistered when no signed release configuration exists; the fresh debug app stayed responsive and closed through the normal window path.
- Exact packaged-search regression: the native sidecar manager completed `Ella Langley Choosin' Texas` through YouTube, restarted the child, and completed the same query through SoundCloud; the explicit ignored live smoke passed.
- Discovery live integration: Apple, ListenBrainz, and Bandcamp Daily refreshed successfully, produced real shelves, and persisted a compatible snapshot
- Mk2 conductor: finite/range, refresh-rate invariance, all six lifecycle identities, material-density floor and differentiated material signatures, boundary crossfades, band-specific anatomy, signed spectral travel, palette-wrap continuity, impact release, and deterministic reset coverage
- Shared journey: cached-reader idempotence, Mk1 advancement, Signal/Mk2 remount continuity, A -> B -> A reset, pause decay, 60/144 Hz null-cadence invariance, and zero synthetic startup-impact coverage
- Signal conductor: weak-air selectivity, broadband-detail preservation, phrase-wrap continuity, tempo-relative landing ring-out, drop-to-chorus de-duplication, and live-to-score handoff coverage
- Signal: all three WGSL modules and pipelines validated on a real Chrome WebGPU adapter; exact 208-byte uniforms, 256-byte spectrum buffer, both RGBA16F feedback directions, and both production passes completed with zero GPU errors
- Mk2: all five WGSL modules and pipelines validated in Chromium WebGPU; exact 288-byte lifecycle/shot uniforms, bind groups, targets, and eight-pass render order completed with zero GPU errors; a surfaced NaN tile was fixed and the fresh pipeline was revalidated
- Legacy engine migration and supported engine roster: covered by Playwright
- Named rail navigation, retired `V`, response repair/persistence, Flow-neutral response profiles, synchronized player/engine auto-hide, app-surface-only wake behavior, locked manual Hide, interaction holds, and close/reopen state reset: covered by Playwright
- Stations: dedicated Discover/Favorites/Directory navigation, directory persistence, ranking-specific metrics, saved-state behavior, and compact local health covered by Playwright.
- Search discovery: v2 shelf contracts, source status, one-reason cards, click-event payloads, forced refresh, fallback shelves, exact apostrophe-query URL handoff, in-progress loading, real-result rendering, partial-provider degradation, retry recovery, stale-event rejection, and conclusive no-result handling covered by Playwright.
- Discover and Settings: empty-library onboarding, outside-library handoff, library summary, folder-picker entry, all three theme modes, and collapsed search troubleshooting covered by Playwright.
- Download storage: old-config compatibility, platform default resolution, atomic config replacement, non-destructive disconnect/reconnect recovery, playback-boundary remote fallback, same-name reservation concurrency, per-job destination capture, directory masquerading as an audio file, newest-retry source ownership, cheap polling, manual health scans, and unavailable custom-folder messaging covered by Rust and Playwright.
- Desktop and 390 x 844 mobile layouts for Stations and Search, compact visualizer chrome, synchronized idle hiding, and Soma's live WebGPU shader were visually checked in headed Chromium with zero console errors or warnings.
- Native Windows `0.2.0` rebuilt and installed three times through the current-user NSIS path while the final startup guard was tightened. Before each install, all 12 real user-data files were hashed; afterward the same 12 files and 97,293,289 bytes matched byte-for-byte with zero changed hashes.
- `PRAGMA quick_check` returned `ok`, no download was active during the upgrade gate, and the installed `0.2.0` process remained responsive from `C:\Users\og10ktech\AppData\Local\mewsik\mewsik.exe`.
- Corrected live RMS: Mk2 entered `PEAK`; Signal produced a bright, dynamic scope trace instead of a black frame
- Native pause/resume freshness: Signal faded to silence after paused frames expired, then resumed its live trace when radio playback restarted
- Mk2's 60 FPS accumulator was checked at 60, 75, 90, 120, and 144 Hz without the old high-refresh over-rendering bug

### Native performance

The table below is the last 10-second measurement checkpoint, taken before the latest Mk2 particle-pass removal and journey-conductor pass. Measurements include `mewsik.exe` plus all descendant WebView2 processes on the same Ryzen 9 5950X / RTX 3090 system. GPU is the busiest physical engine, matching Task Manager semantics. The latest Mk2 should be remeasured while real audio is playing before publishing a new comparison number.

| Mode | CPU | GPU avg / peak | Working set | Private | Dedicated VRAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visualizer off | 1.884% | 0.194% / 0.261% | 489.8 MiB | 246.5 MiB | 34.1 MiB |
| Mk1 | 3.141% | 7.061% / 8.003% | 625.7 MiB | 446.9 MiB | 104.7 MiB |
| Mk2 | 2.571% | 12.425% / 13.045% | 609.5 MiB | 389.0 MiB | 79.5 MiB |
| Signal | 2.476% | 3.966% / 5.899% | 603.5 MiB | 402.7 MiB | 73.3 MiB |

Old Mk2 measured 73.677% average / 75.163% peak GPU on the same machine. Rebuilt Mk2 averages 12.425%, an approximately 83% reduction while remaining fully audio-reactive.

### Release artifacts

- `src-tauri/target/release/mewsik.exe` (21,786,112 bytes): SHA-256 `E415D7A35AED2D882A6C49AA1BB1C8A186ABE3791997953D79D3145A5F71C011`
- `src-tauri/target/release/bundle/nsis/mewsik_0.2.0_x64-setup.exe` (51,018,638 bytes): SHA-256 `2883622EFB10914216DC0C3E43E23C507DEBAC3E4CB1043E34AB141E8948350B`
- Installed NSIS payload at `C:\Users\og10ktech\AppData\Local\mewsik\mewsik.exe` (21,786,112 bytes): SHA-256 `C886685A53A89CA3C4988B218D72D9E80DC37CC842E7ECC61F524E1EFE63925E`

These local artifacts are intentionally unsigned and are for this machine/private testing only. The protected workflow must produce and verify a new Authenticode-signed candidate before anything is distributed as the public `0.2.0` bootstrap release.

## Key files

- `src/lib/components/visualizer/visualizer-host.svelte`
- `src/lib/components/visualizer/visualizer.svelte`
- `src/lib/components/visualizer/visualizer-mk2.svelte`
- `src/lib/components/visualizer/visualizer-signal.svelte`
- `src/lib/visualizer/mk2/conductor.ts`
- `src/lib/visualizer/catalog.ts`
- `src/lib/visualizer/journey.ts`
- `src/lib/visualizer/identity.ts`
- `src/lib/visualizer/signal/conductor.ts`
- `src/lib/visualizer/signal/spectrum.ts`
- `src/lib/visualizer/signal/shaders.ts`
- `src/lib/state/visualizer.svelte.ts`
- `src/lib/state/visualizer-chrome.svelte.ts`
- `src/lib/radio/curated.ts`
- `src/lib/radio/signals.ts`
- `src/lib/components/stations/station-metrics.svelte`
- `src/lib/components/search/search-discovery-feed.svelte`
- `src-tauri/src/commands/stations.rs`
- `src-tauri/src/stations/directory.rs`
- `src-tauri/src/stations/health.rs`
- `src-tauri/src/discovery/v2.rs`
- `src-tauri/src/discovery/sources.rs`
- `src-tauri/src/discovery/store.rs`
- `src-tauri/src/commands/discovery.rs`
- `src-tauri/src/db/migrations.rs`
- `src-tauri/src/config.rs`
- `src-tauri/src/commands/downloads.rs`
- `src-tauri/src/download/mod.rs`
- `src/routes/+layout.svelte`
- `src/routes/downloads/+page.svelte`
- `src/routes/settings/+page.svelte`
- `src/routes/search/+page.svelte`
- `src/routes/stations/+page.svelte`
- `src/routes/visualizer-test/+page.svelte`
- `e2e/visualizer.spec.ts`
- `e2e/journey-runtime.spec.ts`
- `e2e/mk2-conductor.spec.ts`
- `docs/product-direction-2026-07-14.md`
