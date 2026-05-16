# mewsik visualizer handoff
*Last updated: 2026-05-15*

## TL;DR

This repo is a Tauri 2 + SvelteKit music app with a WebGPU/WGSL visualizer. The goal is still **label-grade procedural release visualizers**: real 3D space, procedural growth, musical phrasing, drops/builds/hooks/bridges, and visuals that feel authored instead of like a spectrum toy.

Important repo status:
- `origin/main` is still `700f410`, tagged `visualizer-mk1`.
- Local active branch is `visualizer-runtime`.
- `visualizer-lab` is the checkpoint branch at `37b3043`.
- `visualizer-runtime` contains the director v2 + unified runtime work. It is local-only unless explicitly pushed.
- Current work after the 2026-05-15 repair pass fixes mk2/runtime WebGPU blockers and should be committed as the next local checkpoint.

Current direction:
- The visualizer now has `auto`, `mk1`, `mk2`, `mk3`, and `runtime`.
- The product direction remains a **unified visual runtime**: motifs/passes inside one directed WebGPU system, not separate visual states cross-faded on top of each other.
- Director v2 is now modular under `src/lib/visualizer/director/` and emits clock/drop/palette/structure intent.
- Unified runtime lives under `src/lib/visualizer/runtime/` with motif modules for atmosphere, reaction-diffusion, attractor, mandala, physarum, and flowfield.

## User target

Direct target language from the session:
- "official visualizers for top record labels"
- "actual 3D space, cohesive motions and designs and fractals and patterns and storytelling and audio reactive"
- "real life reactive living organism type vibe"
- "continuously grow and expand and evolve ... molecule by molecule frame by frame"
- identify and react to "chorus, bridge, hook, drop, buildup" in real time
- eventually support many visual families, up to mk10-style variety, but as one cohesive procedural system

Explicit anti-targets:
- Centered orb / radial bars / Winamp spectrum.
- Presets that look like unrelated layers stacked with blend modes.
- A single rotating SDF object that never truly changes.
- Motion that continues in silence like an embedded metronome.
- Random fog/glow slapped over the real subject.
- Bright particle spam without composition, intent, phrasing, or depth.

## Session update - 2026-05-15

### Current local branch state

- Active branch: `visualizer-runtime`.
- Recent runtime commits already on branch:
  - director v2: clock, Yadati-style drop anticipation, Tonnetz palette, structure FSM
  - unified runtime skeleton with shared director uniform, feedback bank, bloom/composite
  - runtime motifs: atmosphere, physarum, flowfield, reaction-diffusion, attractor, mandala
  - lab manual motif sliders / solo buttons
- This session continued from a cutoff while fixing black screens and WebGPU validation failures.

### Bugs fixed in this repair pass

- mk2 black screen:
  - Chrome reported WGSL parse error: cannot assign to swizzled lvalue at `q.xz = rot2(...)`.
  - Fixed in `src/lib/components/visualizer/visualizer-mk2.svelte` by rotating through temp vectors and writing components individually.
- runtime black screen:
  - Chrome reported invalid command buffers after shader/pipeline validation failures.
  - Fixed `attractor.ts` and `flowfield.ts` by splitting compute shaders (`var<storage, read_write>`) from render shaders (`var<storage, read>`). WebGPU forbids read/write storage bindings in vertex stages.
- runtime black stair-step artifact:
  - Root cause was undefined WGSL math in `mandala.ts`: `pow(cos(...), 4.0)` can NaN when cosine is negative, plus reversed `smoothstep` edges.
  - Fixed mandala fold/wrapping with `fract`, replaced negative-base `pow`, and corrected radial falloff.
  - Also corrected reversed `smoothstep` calls in atmosphere.
- runtime washed-out stacking:
  - Motif weights were previously only an on/off gate; every nonzero motif rendered full strength.
  - Updated motif pipelines to use WebGPU constant blend factors and `setBlendConstant(weight)` so runtime/manual slider weights actually scale output.
  - Reduced bloom threshold/intensity, lowered flowfield edge sprite size, and tightened auto weights so one or two motifs lead per section instead of all six stacking at once.

### Verification after repair

- `pnpm check` passes with 0 errors / 0 warnings.
- `pnpm build` passes.
- Playwright + Chrome WebGPU smoke loaded `mk2`, `mk3`, and `runtime` at `/visualizer-test` with no visible error overlays and no WGSL/WebGPU console errors.
- Final smoke screenshots were written to:
  - `tmp/mk2-smoke-postrepair.png`
  - `tmp/mk3-smoke-postrepair.png`
  - `tmp/runtime-smoke-postrepair.png`
  - `tmp/runtime-after-policy-auto.png`

### Remaining critique

- Runtime is stable and visible, but it is still visually early. It now shows a coherent attractor/mandala subject instead of a black screen, but palette/contrast/composition still need art direction.
- mk2 is loading and visually stronger than before, but true Lomas-style organism growth/memory is still future work.
- mk3 is loading and distinct as a particle traversal, but it still needs richer foreground/background composition and stronger musical structural events.

## Session update - 2026-05-13

### Git/GitHub audit

- Verified local `HEAD`, `origin/main`, and `origin/HEAD` all point at `700f410 feat(visualizer): Mark I - 4-preset audio-reactive WebGPU pipeline`.
- This means the GitHub version has not received the mk2/mk3/director/lab work.
- Working tree is dirty and contains the active local visualizer work:
  - Modified: `.gitignore`
  - Modified: `src/lib/components/visualizer/visualizer.svelte`
  - Modified: `src/lib/state/visualizer.svelte.ts`
  - Modified: `src/routes/+layout.svelte`
  - Modified: `src/routes/visualizer-test/+page.svelte`
  - Untracked: `HANDOFF.md`
  - Untracked: `src/lib/components/visualizer/visualizer-host.svelte`
  - Untracked: `src/lib/components/visualizer/visualizer-mk2.svelte`
  - Untracked: `src/lib/components/visualizer/visualizer-mk3.svelte`
  - Untracked: `src/lib/visualizer/`

### App shell / lab isolation

- Updated `src/routes/+layout.svelte` so `/visualizer-test` renders only the lab page and does not mount the full app shell, sidebar, playerbar, command search, or visualizer host.
- This fixes the lab feeling like the whole mewsik player is leaking into the test surface.
- The normal app routes still render the full shell.

### Visualizer state / host

- Updated `src/lib/state/visualizer.svelte.ts`:
  - Engine type now supports `'auto' | 'mk1' | 'mk2' | 'mk3'`.
  - `VISUALIZER_ENGINES` includes `auto`.
  - Engine selection is persisted to `localStorage` under `mewsik.visualizer.engine`.
- Added `src/lib/components/visualizer/visualizer-host.svelte`:
  - Hosts mk1/mk2/mk3.
  - Supports explicit engine locks and `auto`.
  - In `auto`, it uses the visual director to choose the active render engine:
    - silence -> mk1
    - peak/high energy -> mk3
    - rising/motion -> mk2
    - otherwise motif-guided mk1/mk2

### Shared visual director

- Added `src/lib/visualizer/visual-director.ts`.
- It converts raw audio features into higher-level art direction:
  - `section`: calm/rising/peak/releasing
  - `motif`: organism/tunnel/lattice/ribbon
  - `motifIndex`
  - `silence`
  - `energy`
  - `density`
  - `motion`
  - `paletteBase`
  - `paletteAccent`
  - `structure`
  - `phrase`
- This is the important architectural bridge. Future visual systems should consume this shared director rather than each mk inventing its own unrelated state machine.

### Visualizer lab page

- Updated `src/routes/visualizer-test/+page.svelte`.
- Engine buttons now include `auto`, `mk1`, `mk2`, `mk3`.
- Hotkeys:
  - `a` -> auto
  - `q/w/e` -> mk1/mk2/mk3
  - `0` -> auto preset
  - `1-4` -> mk1 preset force
- The lab renders only one visualizer component at a time and passes `showHud={false}` so HUD/chrome is not duplicated.
- Synthetic signal is on by default for lab work.
- Fixed the synthetic signal toggle so it actually changes the feature source:
  - synthetic on -> generated arrangement features
  - synthetic off with no analyzer -> silent features
  - file/URL load -> real analyzer features
- Synthetic signal now simulates a 48-second musical arrangement with evolving BPM, phrase, build, drop, release, RMS, onset, bass/mid/treble, chroma, and 64 bins.

### mk1 cleanup

- Updated `src/lib/components/visualizer/visualizer.svelte`:
  - Added optional `showHud` prop.
  - HUD only renders when requested.
  - Overlay element now has button semantics and an aria label to satisfy Svelte accessibility checks.
- mk1 remains useful for A/B and fallback, but it is not the desired final aesthetic.

### mk2 redesign pass

File: `src/lib/components/visualizer/visualizer-mk2.svelte`

Current intent:
- A procedural 3D organism / Mandelbulb hybrid with volumetric depth.
- It should feel like something living, growing, accumulating tension, and changing shape through a song.

Work completed:
- Added shared director consumption.
- Added director-driven `growth` and `tension` uniforms.
- Added safer Mandelbulb math:
  - guarded radius in the distance estimator
  - guarded derivative denominator
  - `safeNormalize` in WGSL normals/lights to prevent NaN artifacts
- Added organism-specific SDF shaping:
  - `organismWarp`
  - smooth unions
  - tendril lanes
  - cavities
  - surface ripple
  - section/emission behavior tied to growth/tension
- Reduced the detached spectrum glow/particle overlay so it does not dominate the organism.
- Pulled camera/framing back so the subject reads better.
- Reduced some fog/shaft dominance.

Current mk2 critique:
- It has strong potential, but the glow/organism relationship still feels too detached.
- The organism needs deeper procedural "biology": growth, memory, mutation, branching, tension release, chorus/drop behavior, and track-specific variation.
- The remaining work is not polish only. mk2 should be redesigned around organism behavior and composition, with the Mandelbulb acting as one material/structure source rather than the whole visual idea.

### mk3 redesign pass

File: `src/lib/components/visualizer/visualizer-mk3.svelte`

Current intent:
- GPU compute particle traversal through authored 3D fields.
- It should feel like moving through a living generated world, not particle spam.

Work completed:
- Added shared director consumption.
- Recentered and restrained the camera:
  - reduced lateral wobble
  - reduced look drift
  - reduced roll
- Reduced full-screen fog/sky overlay so particles and structure read better.
- Brightened particle rendering after a too-dim pass.
- Added director-driven motif/topology behavior:
  - organism
  - tunnel
  - lattice
  - ribbon
- Added director-driven flow strength, point size, spawn spread, radial pull, palette offset, and phrase shaping.
- Kept particle count around 70k for the current test surface.

Current mk3 critique:
- It is less busted than before, but still needs real art direction.
- It needs stronger composition, more meaningful topology differences, better foreground/background layers, and audio-triggered structural changes.
- The traversal idea is good; the content being traversed needs to become more authored and musically legible.

### Windows / universal direction

- This local Windows workspace has the app running and building with the visualizer lab.
- The goal is to turn this into a universal code path that works on Windows and macOS, then push it back to GitHub.
- Need to preserve macOS behavior while adding/validating Windows support. Do not let the visualizer branch become a Windows-only fork.

### Verification completed

Commands passed after the visualizer changes:

```pwsh
pnpm check
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Known existing Rust warnings during `cargo check`:
- `src/keychain.rs:51` unused imports: `delete_credential`, `get_credential`, `store_credential`
- `src/audio/analyzer.rs:158` assigned value `sr` is never read

Browser smoke status:
- Dev server was run at `http://127.0.0.1:5174/visualizer-test`.
- Playwright/Chrome smoke tests loaded mk2/mk3/auto with WebGPU flags.
- No page errors, WebGPU errors, WGSL errors, or console errors were seen in the smoke passes.
- Screenshots were written under `tmp/`, including mk2/mk3/auto smoke captures.

## Architecture history

### Pre-session state

- Tauri 2 app, Rust backend, SvelteKit frontend.
- WebGPU/WGSL visualizer already shipped.
- Rust audio analyzer with FFT bins, RMS, peak, centroid, onset, bass/mid/treble.
- Tagged `visualizer-mk1` at commit `700f410`.

### Mark I - post-stack pipeline

File: `src/lib/components/visualizer/visualizer.svelte`

Built the existing visualizer into four presets:
- Hyperbolic kaleidoscope / Truchet variants.
- Cathedral flythrough volumetric lattice.
- Voronoi caustics.
- Nebula flow.

Added:
- Scene -> feedback -> bloom -> composite pipeline.
- Browser analyzer features: BPM, chroma, beat phase.
- Per-song seed reset.
- Onset-triggered variety.
- Preset blending experiments.

Verdict:
- Useful technically, but too centered/radial/kaleidoscopic for the target.
- Kept as mk1 fallback and A/B reference.

### Mark II - SDF / organism / volume

File: `src/lib/components/visualizer/visualizer-mk2.svelte`

Built around:
- Mandelbulb distance estimator.
- Volumetric raymarch.
- Camera waypoints.
- Bloom, temporal blur, ACES, grain, iridescence.
- Section state machine.
- Later redesigned toward an organism SDF with director-driven growth/tension.

Verdict:
- Highest immediate visual potential.
- Needs a ground-up behavior model so it grows, mutates, breathes, and reacts to musical form.

### Mark III - GPU compute particle traversal

File: `src/lib/components/visualizer/visualizer-mk3.svelte`

Built around:
- GPU storage-buffer particles.
- Init/sim compute passes.
- Curl-noise flow.
- Species variation.
- Silence gating.
- Camera traversal through a tube/field.
- Particle recycling ahead of camera.
- Director-driven topology/motif selection.

Verdict:
- Good traversal foundation.
- Needs more thoughtful scene grammar, layering, topology, and musical event behavior.

## Next major direction

### 1. Build the unified visual runtime

The next architecture should stop treating `mk1`, `mk2`, and `mk3` as separate modes. Build a unified runtime where the director drives one coherent scene:

- One host/runtime surface, likely `visualizer-unified.svelte` or a set of shared runtime modules.
- One shared `VisualDirectorFrame` per animation frame.
- Render passes as cooperating systems:
  - atmosphere/background
  - organism/SDF/mesh structure
  - particles/agents/trails
  - post stack/bloom/composite
  - camera choreography
- Motifs are parameterized systems, not full component swaps.
- Transitions happen by morphing parameters and weights inside the scene, not by overlaying unrelated renders.
- The goal is eventually mk10-style variety, but internally that should mean 10 motif families in one language, not 10 stacked visualizers.

### 2. Expand the director into music intelligence

The director should become the canonical place for musical interpretation:

- Better section detection: intro, verse, pre-chorus/build, hook/chorus, bridge, drop, release/outro.
- Drop anticipation, not just drop reaction.
- Phrase memory over 4/8/16 bars.
- Chroma self-similarity for repeated sections.
- Onset density and RMS deltas for build/release curves.
- Timbre/centroid/spectral flatness for texture changes.
- Optional vocal/formant hints later.
- Track seed and per-section seed so visuals have identity without feeling random.

### 3. Redesign mk2 as the organism system

Keep the successful direction but make it more intentional:

- Replace detached glow with integrated internal light, veins, membranes, and cavities.
- Add multiple organism families:
  - coral growth
  - tendon/strand bundles
  - chrysalis shell
  - lattice bone
  - cellular membrane
  - crystalline fracture
- Give the organism memory:
  - peaks leave scars/ridges
  - builds inflate or branch
  - drops split, bloom, or expose interior structure
  - quiet sections contract and reveal detail
- Use audio bands as behavior inputs:
  - bass -> mass, pressure, camera push
  - mids -> growth direction and articulation
  - treble -> surface detail, sparks, filaments
  - chroma/key -> structural symmetry/palette pressure
- Keep SDF safety checks. Watch for NaN/black-square tile artifacts.

### 4. Redesign mk3 as the traversal/particle system

Make mk3 less like particles in fog and more like traveling through authored procedural space:

- Add true foreground/background particle layers.
- Make topologies visually distinct:
  - tunnel should read as tunnel
  - lattice should read as lattice
  - ribbon should read as ribbon
  - organism should interlock with mk2 structure
- Drive spawn zones from FFT bins rather than one global density value.
- Add visual memory/trails from past peaks.
- Add camera events:
  - build -> forward acceleration
  - drop -> banking turn or snap-through
  - bridge -> slow drift / negative space
  - chorus/hook -> recurring motif return
- Keep camera readable. Avoid off-center fog overlays and random brightness spam.

### 5. Productize for GitHub and both platforms

Before pushing:

- Create a feature branch from this local working tree.
- Stage the untracked visualizer files intentionally.
- Commit the current visualizer lab/director/host changes.
- Decide whether `HANDOFF.md` should be committed or kept local. If committed, make it a useful project doc, not just session notes.
- Run:
  - `pnpm check`
  - `pnpm build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - Windows Tauri build
  - macOS Tauri build on a Mac
- Update docs for Windows development/building if needed.
- Push branch and open a PR against GitHub `main`.

## Current repo layout

Important files:

- `src/routes/+layout.svelte` - app shell, with `/visualizer-test` lab isolation.
- `src/routes/visualizer-test/+page.svelte` - visualizer lab, engine buttons, audio file/URL input, synthetic signal.
- `src/lib/state/visualizer.svelte.ts` - visualizer singleton store and persisted engine state.
- `src/lib/visualizer/visual-director.ts` - shared music-to-visual-intent director.
- `src/lib/components/visualizer/visualizer-host.svelte` - app host for mk1/mk2/mk3/auto.
- `src/lib/components/visualizer/visualizer.svelte` - mk1 post-stack visualizer.
- `src/lib/components/visualizer/visualizer-mk2.svelte` - mk2 organism/SDF/volume visualizer.
- `src/lib/components/visualizer/visualizer-mk3.svelte` - mk3 GPU compute particle traversal visualizer.
- `src/lib/audio/web-analyzer.ts` - browser-side analyzer for lab mode.
- `src-tauri/src/audio/analyzer.rs` - Rust FFT analyzer.

## Useful commands

```pwsh
# Check current repo relationship to GitHub
git status --short
git log --oneline --decorate --max-count=8 --all

# Lab dev server
pnpm dev -- --host 127.0.0.1 --port 5174
# Open http://127.0.0.1:5174/visualizer-test

# Frontend checks
pnpm check
pnpm build

# Rust/Tauri check
cargo check --manifest-path src-tauri/Cargo.toml

# Full Windows Tauri build
pnpm tauri:build --bundles nsis
```

Known Windows install gotcha:

```pwsh
# NSIS silent install /S has skipped overwriting mewsik.exe before.
# If needed, kill the app and direct-copy the built exe.
Copy-Item src-tauri/target/release/mewsik.exe C:/Users/og10ktech/AppData/Local/mewsik/mewsik.exe -Force
```

## Known issues / gotchas

- `origin/main` does not include the current visualizer lab work yet.
- `HANDOFF.md`, mk2, mk3, host, and `src/lib/visualizer/` are currently untracked unless staged later.
- WGSL `layout: 'auto'` can prune unused bindings. Every declared binding must be reachable from the entry point.
- WebGPU shader NaNs can show up as black/tiled artifacts. Guard normalizations, logs, divisions, and distance-estimator edge cases.
- mk2 still has an art-direction problem: detached glow vs organism. The next pass should integrate light/material/growth, not just tweak bloom.
- mk3 still has an art-direction problem: centered traversal is better, but the particle field needs stronger structure, layers, and music-driven scene grammar.
- Synthetic signal now works, but it is still only a test arrangement. Real audio files remain the important validation path.
- The current auto mode switches components. The final auto mode should drive one unified runtime.

## Architectural axioms

1. Single SDF equals one manifold; the eye reads one object no matter how polished it is.
2. Cross-fading unrelated generators reads as visual slop. Morph parameters inside a shared language instead.
3. Audio should drive many small behaviors across many systems, not one giant brightness knob.
4. Fast audio features should trigger events; slow features should steer mood, palette, and structure.
5. Silence must be visually quiet.
6. Good visualizers need composition and negative space, not just more particles or more glow.
7. The director should own musical interpretation. Renderers should consume intent.

## Resume one-liner

Read `HANDOFF.md`, run `git status --short` and `git log --oneline --decorate --max-count=8 --all`, then open `http://127.0.0.1:5174/visualizer-test`. Continue by turning mk1/mk2/mk3 into a unified director-driven runtime, starting with mk2 organism behavior and mk3 traversal structure, then prepare the local Windows-tested branch for GitHub.
