# mewsik visualizer handoff

_Last updated: 2026-07-13_

## Product direction

The visualizer now has three deliberate roles:

- **Mk1** is the production anchor and current quality bar.
- **Mk2** is the experimental volumetric/fractal engine. It remains manually selectable while it is measured and tuned.
- **Signal** is the audio-first oscilloscope/vectorscope engine built around one crisp trace, phosphor persistence, controlled transient echoes, and negative space.

The former Mk3 particle plane and layered Runtime were removed. Git history is the archive for those experiments.

## Active implementation

- Branch: `codex/visualizer-rebuild`
- Engine order: `mk1 -> mk2 -> signal`
- Saved `auto`, `runtime`, or unknown selections migrate to `mk1`.
- Saved `mk3` selections migrate to `signal`.
- The visualizer lab at `/visualizer-test` exposes only Mk1, Mk2, and Signal, with synthetic/real audio input and live analysis diagnostics.

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
- expands, contracts, sprouts, winds, blooms, hollows, sheds, turns, and punches with bounded motion instead of reacting independently to every beat;
- uses impact as a restrained lower-anatomy material response instead of camera shake, scale jolts, full-frame flashes, or an emissive surface decal;
- replaces the white-dot particle aura and flickering grain with one world-space atmospheric current, camera parallax, and a dark pocket behind the organism;
- lets that same atmospheric current split during bloom and fray during shedding instead of remaining a static backdrop;
- replaces the stop/start Catmull-Rom waypoint loop with one seeded continuous camera drift, then lets sustained musical detail elect rare smooth close studies with independent zoom, azimuth, elevation, framing, and macro fidelity rails;
- removes the diagonal vein/emission mask, direct FFT-to-albedo bands, procedural SDF corrugation, chromatic aberration, and anamorphic streaks; one geometry-bound pore field and analytic colored reflections now follow the actual surface;
- reduces the render graph from nine passes to eight and removes the particle pipeline, particle textures, upload, and pass completely;
- keeps a stable per-track palette family while continuously moving through its colors and glides through section-aware framing rather than hard-cutting or snapping;
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

### Audio-level contract

Native RMS and peak are now calculated from the unwindowed PCM waveform. The old implementation calculated both from FFT magnitudes that had already been divided by the FFT size, making a controlled 0.8-amplitude sine report RMS `0.00765` instead of `0.56569`. That kept Signal's silence gate closed and muted RMS-driven section changes in Mk1 and Mk2.

The browser lab now uses `AnalyserNode.getFloatTimeDomainData()` and the same normalized 0..1 waveform formula. Spectral bins, onset, centroid, and chroma remain separate frequency-domain features.

## Verification status

Completed on the combined branch and packaged native release:

- `pnpm check`: 0 errors, 0 warnings
- `pnpm build`: pass
- `pnpm test:e2e`: 31/31 pass
- `cargo test`: 46/46 pass
- Mk2 conductor: finite/range, refresh-rate invariance, all six lifecycle identities, boundary crossfades, band-specific anatomy, signed spectral travel, palette-wrap continuity, impact release, and deterministic reset coverage
- Shared journey: cached-reader idempotence, Mk1 advancement, Signal/Mk2 remount continuity, A -> B -> A reset, pause decay, 60/144 Hz null-cadence invariance, and zero synthetic startup-impact coverage
- Signal conductor: weak-air selectivity, broadband-detail preservation, phrase-wrap continuity, tempo-relative landing ring-out, drop-to-chorus de-duplication, and live-to-score handoff coverage
- Signal: all three WGSL modules and pipelines validated on a real Chrome WebGPU adapter; exact 208-byte uniforms, 256-byte spectrum buffer, both RGBA16F feedback directions, and both production passes completed with zero GPU errors
- Mk2: all five WGSL modules and pipelines validated in Chromium WebGPU; exact 288-byte lifecycle/shot uniforms, bind groups, targets, and eight-pass render order completed with zero GPU errors; a surfaced NaN tile was fixed and the fresh pipeline was revalidated
- Legacy engine migration and supported engine roster: covered by Playwright
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

- `src-tauri/target/release/mewsik.exe` (19,944,960 bytes): SHA-256 `FF2708C6F565906B41F8995A9AB6DF1CBE3D7426470ECD00A8C4027827B8C92F`
- `src-tauri/target/release/bundle/nsis/mewsik_0.1.0_x64-setup.exe` (50,356,553 bytes): SHA-256 `88EAEF26ADB578AD122A8A6A4B42C497488F9A919A1FEDFA280294F38B1C735C`
- `src-tauri/target/release/bundle/msi/mewsik_0.1.0_x64_en-US.msi` (71,733,248 bytes): SHA-256 `819545849CF423E4BFF51B56858BAE7B06F775CEF270D5CF6740A9BD8D9C6302`

The executable and both installers are currently unsigned. Code signing remains release-distribution work, not a visualizer merge blocker.

## Key files

- `src/lib/components/visualizer/visualizer-host.svelte`
- `src/lib/components/visualizer/visualizer.svelte`
- `src/lib/components/visualizer/visualizer-mk2.svelte`
- `src/lib/components/visualizer/visualizer-signal.svelte`
- `src/lib/visualizer/mk2/conductor.ts`
- `src/lib/visualizer/journey.ts`
- `src/lib/visualizer/identity.ts`
- `src/lib/visualizer/signal/conductor.ts`
- `src/lib/visualizer/signal/spectrum.ts`
- `src/lib/visualizer/signal/shaders.ts`
- `src/lib/state/visualizer.svelte.ts`
- `src/routes/visualizer-test/+page.svelte`
- `e2e/visualizer.spec.ts`
- `e2e/journey-runtime.spec.ts`
- `e2e/mk2-conductor.spec.ts`
