# mewsik visualizer handoff

_Last updated: 2026-07-13_

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

- Search's live shelves now use Apple's public U.S., U.K., Japan, and Brazil song charts, with a strict one-artist-per-shelf/global cap so one fandom cannot consume the page. The third shelf is clearly labeled Mewsik editorial rather than pretending to be personalized.
- Apple chart requests have a four-hour cache, response limits, stale recovery, HTTPS artwork validation, and bundled editorial fallbacks. Each card states why it is present.
- Healthy chart data stays cached for four hours, while stale or fallback data retries after one minute so a brief network failure cannot pin the offline shelf all afternoon.
- Selecting a discovery card writes `/search?q=...` and runs the normal YouTube, SoundCloud, and Bandcamp search exactly once. The page keeps its loader visible while providers work, preserves partial results, exposes provider failures with Retry, and only says **No results** after a conclusive completed search.
- External search validates queries and provider names, rejects malformed sidecar responses, and no longer converts total provider failure into a fake successful empty result. Incomplete failures are not cached.
- Discover now has three honest states: useful onboarding with no library, qualified-listen profile progress, and a personal rotation once enough listening exists. Thirty-second plays drive affinity, history, rediscovery, and play statistics; short skips do not tune the profile.
- Discover provides a stable local rotation, recent listening, long-unplayed saves, and a permanent **Beyond your library** search-inspiration shelf. Refresh remains deterministic until the listening history actually changes.
- The learning boundary is canonical end to end: five distinct tracks listened to for at least 30 seconds. Repeating one track five times no longer activates a profile that the UI still calls unfinished.
- Stations has dedicated **Discover / Favorites / Directory** views. Discover is curated, Favorites is saved radio, and Directory is the global catalog; clearing directory search no longer throws the user back into another view.
- Curated and favorite cards show only local connection health. Directory cards show one metric matching the active ranking (starts, change, votes, or bitrate) rather than a wall of ambiguous telemetry.
- Directory probes are capped to 12 visible streams, bulk detail lookup is capped to 100 IDs, saved results use a passive **Saved** label, and **Check stations** stays actionable while reporting its latest result separately.
- Directory pagination carries a raw Radio Browser cursor across filtered HLS rows, so an unplayable stream can neither hide **Load more** nor cause overlaps between pages.
- Settings is now a real library and appearance surface: track/artist/album summary, native folder picker, removable saved folders, resilient scan-all behavior, Light/Dark/System controls, and a collapsed provider-repair section for exceptional search failures.
- Newly added library paths must be existing directories; an already-saved disconnected drive can remain visible and removable rather than bricking settings startup.
- Library path identity is case-insensitive on Windows and case-sensitive on Unix targets, preserving valid case-distinct folders without allowing a differently cased nonexistent path to bypass validation.

### Audio-level contract

Native RMS and peak are now calculated from the unwindowed PCM waveform. The old implementation calculated both from FFT magnitudes that had already been divided by the FFT size, making a controlled 0.8-amplitude sine report RMS `0.00765` instead of `0.56569`. That kept Signal's silence gate closed and muted RMS-driven section changes in Mk1 and Mk2.

The browser lab now uses `AnalyserNode.getFloatTimeDomainData()` and the same normalized 0..1 waveform formula. Spectral bins, onset, centroid, and chroma remain separate frequency-domain features.

## Verification status

Completed on the combined branch and packaged native release:

- `pnpm check`: 0 errors, 0 warnings
- `pnpm build`: pass
- `pnpm test:e2e`: 44/44 pass on a clean Vite server
- `cargo test --lib`: 69/69 pass, including the process-wide station probe limit under the normal parallel test runner
- Mk2 conductor: finite/range, refresh-rate invariance, all six lifecycle identities, material-density floor and differentiated material signatures, boundary crossfades, band-specific anatomy, signed spectral travel, palette-wrap continuity, impact release, and deterministic reset coverage
- Shared journey: cached-reader idempotence, Mk1 advancement, Signal/Mk2 remount continuity, A -> B -> A reset, pause decay, 60/144 Hz null-cadence invariance, and zero synthetic startup-impact coverage
- Signal conductor: weak-air selectivity, broadband-detail preservation, phrase-wrap continuity, tempo-relative landing ring-out, drop-to-chorus de-duplication, and live-to-score handoff coverage
- Signal: all three WGSL modules and pipelines validated on a real Chrome WebGPU adapter; exact 208-byte uniforms, 256-byte spectrum buffer, both RGBA16F feedback directions, and both production passes completed with zero GPU errors
- Mk2: all five WGSL modules and pipelines validated in Chromium WebGPU; exact 288-byte lifecycle/shot uniforms, bind groups, targets, and eight-pass render order completed with zero GPU errors; a surfaced NaN tile was fixed and the fresh pipeline was revalidated
- Legacy engine migration and supported engine roster: covered by Playwright
- Named rail navigation, retired `V`, response repair/persistence, Flow-neutral response profiles, synchronized player/engine auto-hide, app-surface-only wake behavior, locked manual Hide, interaction holds, and close/reopen state reset: covered by Playwright
- Stations: dedicated Discover/Favorites/Directory navigation, directory persistence, ranking-specific metrics, saved-state behavior, and compact local health covered by Playwright.
- Search discovery: all fallback shelves, cover-card rendering, query URL handoff, in-progress loading, real-result rendering, and conclusive no-result handling covered by Playwright.
- Discover and Settings: empty-library onboarding, outside-library handoff, library summary, folder-picker entry, all three theme modes, and collapsed search troubleshooting covered by Playwright.
- Desktop and 390 x 844 mobile layouts for Stations and Search, compact visualizer chrome, synchronized idle hiding, and Soma's live WebGPU shader were visually checked in headed Chromium with zero console errors or warnings.
- Native Windows release rebuilt successfully; the exact new workspace EXE was launched for user visual review (the previous checkpoint had live Liquid DnB inspection across Mk1, Mk2, and Signal)
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

- `src-tauri/target/release/mewsik.exe` (20,288,000 bytes): SHA-256 `FA753079F4ED32211B6017F9FED9699D5BD338DF103E3D7B529E02691524D233`
- `src-tauri/target/release/bundle/nsis/mewsik_0.1.0_x64-setup.exe` (50,474,841 bytes): SHA-256 `8E14D87612C55E63BAAC4E0661D8E30CD688B61C14F999D666D4DD0A211D9676`
- `src-tauri/target/release/bundle/msi/mewsik_0.1.0_x64_en-US.msi` (71,860,224 bytes): SHA-256 `B81A3AE14CE8491050F74D5B27373C4D489CC521121A462E3A42C92EB73A815D`

The executable and both installers are currently unsigned. Code signing remains release-distribution work, not a visualizer merge blocker.

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
- `src-tauri/src/discovery/feed.rs`
- `src/routes/+layout.svelte`
- `src/routes/search/+page.svelte`
- `src/routes/stations/+page.svelte`
- `src/routes/visualizer-test/+page.svelte`
- `e2e/visualizer.spec.ts`
- `e2e/journey-runtime.spec.ts`
- `e2e/mk2-conductor.spec.ts`
