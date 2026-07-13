# mewsik visualizer handoff

_Last updated: 2026-07-13_

## Product direction

The visualizer now has three deliberate roles:

- **Mk1** is the production anchor and current quality bar.
- **Mk2** is the experimental volumetric/fractal engine. It remains manually selectable while it is measured and tuned.
- **Signal** is the audio-first oscilloscope/vectorscope engine built around one crisp trace, phosphor persistence, controlled transient echoes, and negative space.

`Auto` is intentionally locked to Mk1. Experimental engines do not enter automatic playback until they independently meet Mk1's visual, reactive, and performance bar.

The former Mk3 particle plane and layered Runtime were removed. Git history is the archive for those experiments.

## Active implementation

- Branch: `codex/visualizer-rebuild`
- Engine order: `auto -> mk1 -> mk2 -> signal`
- Saved `mk3` selections migrate to `signal`.
- Saved `runtime` or unknown selections migrate to `auto`.
- The visualizer lab at `/visualizer-test` exposes only Mk1, Mk2, and Signal, with synthetic/real audio input and live analysis diagnostics.

### Mk2

Mk2 keeps its volumetric Mandelbulb identity but now:

- renders at a true 60 FPS cap and 72% internal scale;
- removes the nested fog shadow raymarch that caused multiplicative shader work;
- uses 48 primary ray steps, 5-7 fractal iterations, 7 shadow probes, 3 AO probes, and fewer tendrils;
- uses a five-pass bloom chain, cheaper particle aura, and fewer lens streak samples;
- keeps a stable per-track palette and three curated cameras;
- glides between phrase/section framings instead of hard-cutting or snapping;
- performs complete pending-init and GPU-resource cleanup.

### Signal

Signal is a new WebGPU renderer, not a modification of old Mk3. It uses:

- one dominant Lissajous/vector trace;
- bass-driven body, mid-driven deformation, treble detail, and onset echoes;
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
- `pnpm test:e2e`: 8/8 pass
- `cargo test`: 46/46 pass
- Signal: real Chrome WebGPU adapter/device creation, WGSL compilation, live render, and zero console/overlay errors
- Legacy engine migration and supported engine roster: covered by Playwright
- Native Windows release: live Liquid DnB playback, Auto/Mk1, Mk2, and Signal visually inspected
- Corrected live RMS: Mk2 entered `PEAK`; Signal produced a bright, dynamic scope trace instead of a black frame
- Native pause/resume freshness: Signal faded to silence after paused frames expired, then resumed its live trace when radio playback restarted
- Mk2's 60 FPS accumulator was checked at 60, 75, 90, 120, and 144 Hz without the old high-refresh over-rendering bug

### Native performance

Measurements are 10-second samples of `mewsik.exe` plus all descendant WebView2 processes on the same Ryzen 9 5950X / RTX 3090 system. GPU is the busiest physical engine, matching Task Manager semantics.

| Mode | CPU | GPU avg / peak | Working set | Private | Dedicated VRAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visualizer off | 1.884% | 0.194% / 0.261% | 489.8 MiB | 246.5 MiB | 34.1 MiB |
| Auto -> Mk1 | 3.141% | 7.061% / 8.003% | 625.7 MiB | 446.9 MiB | 104.7 MiB |
| Mk2 | 2.571% | 12.425% / 13.045% | 609.5 MiB | 389.0 MiB | 79.5 MiB |
| Signal | 2.476% | 3.966% / 5.899% | 603.5 MiB | 402.7 MiB | 73.3 MiB |

Old Mk2 measured 73.677% average / 75.163% peak GPU on the same machine. Rebuilt Mk2 averages 12.425%, an approximately 83% reduction while remaining fully audio-reactive.

The final native app is running from the exact workspace release path with live radio and Auto selected.

### Release artifacts

- `src-tauri/target/release/mewsik.exe` (19,932,672 bytes): SHA-256 `77435D794DE62A7F5A68B6C8BEE8696D41F6C8AFA00438FC80A3B3DC15CEDE5B`
- `src-tauri/target/release/bundle/nsis/mewsik_0.1.0_x64-setup.exe` (50,340,052 bytes): SHA-256 `5F5AE14039F638FF733814B2BF3B474C44D3E6E948DC9FF2A6C8DD151EE8B73C`
- `src-tauri/target/release/bundle/msi/mewsik_0.1.0_x64_en-US.msi` (71,720,960 bytes): SHA-256 `7FE3623D327695F737C66204F7B175D14EDFAA7B170EDE9B97A7D7DD800DAE1B`

The executable and both installers are currently unsigned. Code signing remains release-distribution work, not a visualizer merge blocker.

## Key files

- `src/lib/components/visualizer/visualizer-host.svelte`
- `src/lib/components/visualizer/visualizer.svelte`
- `src/lib/components/visualizer/visualizer-mk2.svelte`
- `src/lib/components/visualizer/visualizer-signal.svelte`
- `src/lib/visualizer/signal/shaders.ts`
- `src/lib/state/visualizer.svelte.ts`
- `src/routes/visualizer-test/+page.svelte`
- `e2e/visualizer.spec.ts`
