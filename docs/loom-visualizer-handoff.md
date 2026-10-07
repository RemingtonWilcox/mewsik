# Loom and Mewsik Visualizer Engine — Complete Handoff

This document is for an engineer or model entering the project with zero prior context. Read it before changing Loom. It explains the product intent, every important file, the audio-to-GPU data path, the current renderer, its known aesthetic and technical failures, the deterministic visualizer lab, tests, and Windows packaging.

## 1. Current checkpoint

- Repository: `mewsik`
- Current branch when this handoff was written: `codex/visualizer-next-pass`
- Loom checkpoint commit: `4e3cdeb` (`feat: rebuild Loom as a dimensional signal weave`)
- Earlier Loom introduction: `a244088` (`feat: evolve visualizer engines`)
- Product stack: Tauri 2, Rust audio backend, Svelte 5/SvelteKit, TypeScript, WebGPU/WGSL, Playwright.
- Production engine roster, in order: Prism (`mk1`), Soma (`mk2`), Signal (`signal`), Loom (`loom`).
- Installed Windows executable on the development machine: `C:\Users\og10ktech\AppData\Local\mewsik\mewsik.exe`.
- Loom currently renders and compiles, but the owner considers the visuals cheesy and not release-quality. Treat it as an exploratory technical baseline, not approved art direction.

## 2. Product intent and non-negotiable feedback

Loom's intended role is **Harmony / Weave**. It should be the visualizer whose structure is most meaningfully controlled by harmonic relationships, arrangement, phrases, tension, release, and frequency interaction.

The original product direction described Loom as:

> A kinetic 3D ribbon manifold moving between torus, helix, saddle, knot, and woven-cage topology. Bands own strand families, harmony changes crossing order, phrases reweave connectivity, and drops open the structure.

That description is only a starting hypothesis. It is not sacred. The owner has explicitly authorized rebuilding visual engines from the ground up when the core visual language is weak.

### Owner's repeated visual requirements

- The visual must have a life cycle and a sense of progression through a song.
- It must coast through arrangements rather than repeat an obvious short loop.
- Verse, build, drop, chorus, bridge, breakdown, and outro should feel structurally different.
- Audio response must not reduce to “pulse the whole object and twist it slightly on every kick.”
- Camera, topology, material, lighting, palette, density, and motion should evolve at different time scales.
- Local musical events can cause local motion. They should not jolt the entire world or camera.
- Preserve depth, substance, material definition, clean silhouettes, and high fidelity.
- Inspiration from oscilloscopes, Minimeters/Ableton analysis tools, sacred geometry, systems, and signal instruments is welcome, but it must not look like a generic music visualizer preset.

### Explicitly rejected aesthetics

- Translucent 2D texture stacks.
- Random blend modes, low-opacity overlays, and “After Effects layers all turned on.”
- A glowing blob over a gradient background.
- Static or flashing background color as the main source of variety.
- A tangled glowing hairball.
- Equal-weight colored spaghetti lines.
- Arbitrary continuous rotation, breathing, or pulsing unrelated to song structure.
- A full-scene kick zoom or camera twitch.
- Cheap bloom used to hide weak geometry.
- Noisy, jagged, low-resolution edges or tiny detached particle artifacts.
- A visual that technically has many parameters but still reads as one generic loop.

## 3. System overview

The complete data path is:

```text
Rust playback samples
  -> Rust real-time analyzer (60 Hz AudioFeatureFrame)
  -> Tauri event "audio:features"
  -> global VisualizerState
  -> shared SignalSpectrumTracker
  -> shared VisualDirector (clock, structure, score, palette, drops)
  -> shared LoomConductor (persistent CPU choreography)
  -> VisualizerJourneySnapshot
  -> visualizer-loom.svelte render-rate interpolation and GPU packing
  -> 52-float uniform buffer + 64-float detail storage buffer
  -> Loom scene WGSL (depth-tested solid tube geometry)
  -> RGBA16F scene texture + depth texture
  -> Loom composite WGSL (background, small glow, ACES tone map)
  -> WebGPU canvas
```

The important architectural rule is that the **CPU journey persists even when Loom is not mounted**. Switching to Prism, Soma, or Signal does not reset Loom's conductor. GPU resources belong to the mounted component; musical choreography belongs to the shared journey runtime.

## 4. File inventory

### 4.1 Loom core — read these first

| File | Responsibility |
| --- | --- |
| `src/lib/components/visualizer/visualizer-loom.svelte` | WebGPU lifecycle, render scheduler, resolution cap, interpolation, uniform packing, GPU resources, render passes, error UI, diagnostics. |
| `src/lib/visualizer/loom/shaders.ts` | Geometry constants plus complete scene and composite WGSL source. This is where nearly all current visual appearance lives. |
| `src/lib/visualizer/loom/conductor.ts` | Allocation-light, deterministic, CPU-only Loom choreography. Section profiles, phrase variation, harmony, topology targets, band envelopes, impact, and camera rails. |
| `e2e/loom-conductor.spec.ts` | Loom conductor contracts: deterministic phrases, bounded rails, frequency ownership, section behavior, frame-rate stability. |

### 4.2 Shared visualizer runtime

| File | Responsibility |
| --- | --- |
| `src/lib/state/visualizer.svelte.ts` | Global active engine/response state, localStorage persistence, native analyzer subscription, feature freshness, source reset, shared journey access. |
| `src/lib/visualizer/journey.ts` | Atomically advances spectrum, director, Signal, Soma, and Loom conductors; owns deterministic source seed/epoch/timeline. |
| `src/lib/visualizer/catalog.ts` | Engine roster, names, descriptions, order, response profiles, adjacent engine selection. |
| `src/lib/visualizer/identity.ts` | Canonical playback-source identity used to reset a journey on A -> B -> A changes. |
| `src/lib/components/visualizer/visualizer-host.svelte` | Production overlay, engine mounting, arrow navigation, details panel, response controls, telemetry, keyboard behavior. |
| `src/lib/state/visualizer-chrome.svelte.ts` | Shared 2.2-second auto-hide clock and explicit locked-hidden mode for engine/player controls. |
| `src/lib/state/player.svelte.ts` | Connects playback changes, source identity, score analysis, pause/buffer invalidation, and score position to the visualizer runtime. |
| `src/routes/+layout.svelte` | Mounts `VisualizerHost` globally. |

### 4.3 Audio and musical analysis

| File | Responsibility |
| --- | --- |
| `src-tauri/src/audio/analyzer.rs` | Production 2048-point FFT, 64 logarithmic bins, RMS/peak, centroid, onset, coarse bands, BPM/beat phase, chroma; emits `audio:features` at ~60 Hz. |
| `src/lib/audio/web-analyzer.ts` | Browser-lab equivalent of the Rust analyzer for local files and CORS-enabled audio URLs. |
| `src/lib/visualizer/signal/spectrum.ts` | Shared perceptual spectrum. Decodes analyzer log bins, maps real frequency bands, builds fast/slow/ceiling envelopes, signed spectral detail, novelty, motion, direction, crest, and flatness. Despite the folder name, this feeds all engines. |
| `src/lib/visualizer/director/types.ts` | `AudioFeatureFrame`, section taxonomy, clock, drop, palette, score context, and `VisualDirectorFrame` contracts. |
| `src/lib/visualizer/director/index.ts` | VisualDirector pipeline: silence, clock, drops, structure, palette, raw/slow feature rails, score-backed overrides. |
| `src/lib/visualizer/director/clock.ts` | Live clock and phrase tracking. |
| `src/lib/visualizer/director/drop.ts` | Live build/drop anticipation and ring-out. |
| `src/lib/visualizer/director/structure.ts` | Live section FSM and motif assignment. |
| `src/lib/visualizer/director/palette.ts` | Harmony/palette/tonnetz logic. |
| `src/lib/visualizer/director/score.ts` | Offline score holder, playback extrapolation, scored section/energy/key/drop context. |
| `src-tauri/src/analysis/*` | Offline analysis used for local-track scores: tempo, key, structure, drops, and energy curve. |

### 4.4 Lab, QA, and product context

| File | Responsibility |
| --- | --- |
| `src/routes/visualizer-test/+page.svelte` | Browser visualizer lab, deterministic profiles, stage selector, seeds, local file/URL input, engine/response controls, lab API. |
| `src/lib/visualizer/lab/music-profiles.ts` | Seven deterministic synthetic song/score profiles. |
| `e2e/visualizer-lab-profiles.spec.ts` | Determinism and lab API contracts. |
| `e2e/journey-runtime.spec.ts` | Shared journey continuity, remount/source reset/pause cadence behavior. |
| `e2e/visualizer.spec.ts` | Production engine rail, WebGPU-ready checks, response modes, storage, chrome, and shared musical-analysis contracts. |
| `docs/product-direction-2026-07-14.md` | Broader product and original Loom concept. |
| `playwright.config.ts` | Browser test configuration. |
| `package.json` | Development, checking, testing, Tauri, and packaging scripts. |
| `src-tauri/tauri.conf.json` | Tauri window, CSP, resources, icons, and installer settings. |

The other renderers are useful references, not Loom dependencies:

- `visualizer.svelte`: Prism / Mk1.
- `visualizer-mk2.svelte` and `visualizer/mk2/*`: Soma.
- `visualizer-signal.svelte` and `visualizer/signal/*`: Signal.

## 5. Production audio input

`src-tauri/src/audio/analyzer.rs` taps decoded playback samples without changing the audio stream. It downmixes channels to mono and writes samples to a bounded non-blocking channel so a stalled analyzer cannot stall playback or grow memory forever.

### Analyzer constants and output

- FFT size: 2048.
- Analyzer cadence: about 60 Hz.
- Published spectral bins: 64.
- Spectral bins are logarithmically spaced from 20 Hz to Nyquist.
- FFT window: Hann.
- Published magnitude encoding: `clamp(log10(max(magnitude, 1e-7)) * 0.4 + 1, 0, 1)`.
- RMS and peak come from unwindowed time-domain PCM.
- Spectral centroid is normalized to Nyquist.
- Onset is positive total-energy flux relative to the prior smoothed energy.
- BPM uses autocorrelation of roughly four seconds of flux, scanning 60–180 BPM.
- Beat phase advances between estimates and snaps to nearby onsets.
- Chroma folds 80–5000 Hz energy into 12 pitch classes.
- Event name: `audio:features`.

The frontend contract is `AudioFeatureFrame`:

```ts
{
  bins: number[64],
  rms: number,
  peak: number,
  centroid: number,
  onset: boolean,
  bass: number,
  mid: number,
  treble: number,
  sample_rate: number,
  bpm: number,
  beat_phase: number,
  chroma_key: number,
  chroma_strength: number
}
```

## 6. Shared perceptual spectrum

`SignalSpectrumTracker` in `src/lib/visualizer/signal/spectrum.ts` is shared analysis, despite living under `signal/`.

It first reverses the analyzer's logarithmic display transform. Do not use the published log bins directly for physical energy or derivative calculations.

### Real-frequency bands

| Band | Frequency range | Current Loom ownership |
| --- | --- | --- |
| `sub` | 20–60 Hz | Strand family 0 and its secondary duplicate. |
| `kick` | 60–150 Hz | Family 1. |
| `body` | 150–400 Hz | Family 2. |
| `mids` | 400–2000 Hz | Family 3. |
| `presence` | 2000–6000 Hz | Family 4. |
| `air` | 6000 Hz–Nyquist | Family 5. |

For each band it publishes:

- `raw`: decoded magnitude.
- `fast`: band-specific fast attack/release envelope.
- `slow`: contextual envelope.
- `levels`: fast level normalized by a slowly decaying adaptive ceiling.
- `deltas`: `(fast - slow) / ceiling`, signed and clamped.

It also publishes:

- `detailBins`: stable `Float32Array(64)`, signed `-1..1`; positive means newly arrived energy, negative means a receding partial.
- `novelty`: positive short-term spectral change.
- `spectralMotion`: absolute six-band shape movement.
- `spectralDirection`: movement toward high frequencies (+) or low frequencies (-).
- `centroid` and `centroidVelocity`.
- `crestRatio` and compressed `crestFactor`.
- `flatness`.
- corrected `bass`, `mid`, `treble` composites.

Do not replace this with fixed bin slices. The native bins are logarithmic and their frequency edges depend on sample rate.

## 7. Director and offline score

The `VisualDirector` combines fast live analysis with longer musical meaning.

### Director output used by Loom

- Section: `calm`, `intro`, `verse`, `pre_chorus`, `build`, `drop`, `chorus`, `bridge`, `breakdown`, `outro`.
- Clock: BPM, beat phase/pulse, bar, beat, phrase position/index.
- Drop: anticipation, build progress, ETA, post-drop decay.
- Palette: base/accent/rim hue, saturation, warmth.
- Mood/harmony: valence, arousal, six-value tonnetz.
- Energy, density, motion, raw bass/mid/treble/centroid.
- Slow score/live context: section progress/energy, track progress, current energy, energy slope, eight-second lookahead, key pitch class/mode/confidence.

For analyzed local tracks, the Rust backend provides a `TrackScore` containing BPM, beat offset/confidence, key, sections, drops, a 2 Hz energy curve, and duration. `player.svelte.ts` keeps its playback position anchored and requests analysis on track changes. Radio and unanalyzed streams fall back to the live section FSM.

Important: changing from live to score context can relabel a section after analysis arrives. Loom deliberately suppresses `sectionPulse` and `reweave` when the only change is this context handoff.

## 8. Shared journey lifetime

`VisualizerState` owns one `VisualizerJourneyRuntime` for the whole app.

- Native features normally arrive at ~60 Hz.
- A feature is considered fresh for 250 ms.
- Pause, buffering, or known discontinuities call `clearLatest()` immediately.
- During silence/no live frames, the journey advances on a bounded 60 Hz null cadence.
- Source changes call `resetPerformance(canonicalIdentity)`.
- Source identity includes playback source, recording ID, source URL, and station ID.
- `sourceEpoch` increments monotonically, so A -> B -> A produces three separate journeys even if A's deterministic seed is reused.
- The source seed is deterministic from the canonical identity.
- `getJourney()` returns a reused atomic snapshot. Nested objects and typed arrays mutate on the next tick. Copy values if retaining history.
- Do not instantiate another director or conductor inside Loom. Read the shared snapshot.
- Do not call `getJourney()` repeatedly within one render and assume separate historical states.

The update order is:

1. `SignalSpectrumTracker.update(features, dt)`
2. `VisualDirector.update(features, timeline, spectrum)`
3. `SignalConductor.update(...)`
4. `Mk2Conductor.update(...)`
5. `LoomConductor.update(director, spectrum, dt)`

## 9. Loom conductor

`src/lib/visualizer/loom/conductor.ts` is deterministic and allocation-light. Its output object, topology object, and band object keep stable identities across updates.

### Fast and slow intent

Only these rails are intended to be fast:

- `impact`: kick/body/novelty impulse.
- `reweave`: phrase-boundary envelope, decays over roughly one bar.
- `sectionPulse`: section-boundary envelope, ~0.82-second decay.

All other rails should change patiently. A renderer must not convert them into per-frame twitch.

### Conductor output contract

| Rail | Range | Meaning |
| --- | ---: | --- |
| `topologyWeights` | normalized sum 1 | Torus/helix/saddle/knot/cage target mix. |
| `strandEnergy` | each 0..1 | Six real-frequency band envelopes. |
| `tension` | 0..1 | Build/anticipation/future-energy compression. |
| `release` | 0..1 | Drop/post-drop/negative-future-energy release. |
| `openness` | 0.12..0.98 | General structural separation. |
| `dropOpenness` | 0..1 | Dedicated drop/chorus opening rail. |
| `braid` | 0.08..0.96 | Intended crossing/interlacing complexity. |
| `twist` | 0.04..0.96 | Intended torsion. |
| `depth` | 0.12..0.96 | Intended Z extent/environment depth. |
| `impact` | 0..1 | Local transient strength. |
| `reweave` | 0..1 | Phrase transition envelope. |
| `sectionPulse` | 0..1 | Section transition envelope. |
| `signedAsymmetry` | -1..1 | Phrase-polarized asymmetry plus spectral lean. |
| `motion` | 0.04..1 | Section/audio movement intent. |
| `macroEnergy` | 0..1 | Long-form energy. |
| `phrase` | 0..1 | Position within phrase. |
| `phraseIndex` | integer | Current phrase identity. |
| `phraseVariation` | 0..1 | Deterministic phrase seed. |
| `tempo` | 0..1 | 60–180 BPM normalized. |
| `key` | 0..1 circular | Circle-of-fifths key position. |
| `mode` | -1..1 | Minor to major, confidence-weighted. |
| `crossingOrder` | -1..1 | Harmony-led intended over/under ordering. |
| `harmonicSpread` | 0..1 | Tonnetz magnitude + uncertainty + motion. |
| `spectralLean` | -1..1 | High/low directional movement. |
| `topologyPhase` | unwrapped radians | Persistent topology phase. |
| `weavePhase` | unwrapped radians | Persistent weave phase. |
| `longPhase` | unwrapped radians | Slow persistent phase. |
| `topologyRate` | 0.06..0.62 | Topology phase speed. |
| `weaveRate` | 0.12..1.1 | Weave phase speed. |
| `longRate` | 0.012..0.09 | Long phase speed. |
| `cameraYaw` | -0.48..0.48 rad | Patient camera/scene yaw. |
| `cameraPitch` | -0.3..0.3 rad | Patient pitch. |
| `cameraDistance` | 2.7..4.1 | Perspective distance. |
| `cameraRoll` | -0.22..0.22 rad | Patient roll. |

### Section topology grammar

| Section | Torus | Helix | Saddle | Knot | Cage |
| --- | ---: | ---: | ---: | ---: | ---: |
| Calm | .58 | .10 | .12 | .04 | .16 |
| Intro | .54 | .23 | .08 | .04 | .11 |
| Verse | .21 | .37 | .17 | .10 | .15 |
| Pre-chorus | .10 | .29 | .15 | .30 | .16 |
| Build | .04 | .20 | .09 | .39 | .28 |
| Drop | .07 | .18 | .07 | .36 | .32 |
| Chorus | .12 | .18 | .12 | .28 | .30 |
| Bridge | .12 | .12 | .42 | .16 | .18 |
| Breakdown | .36 | .12 | .30 | .05 | .17 |
| Outro | .48 | .11 | .20 | .04 | .17 |

| Section | Tension | Release | Open | Drop open | Motion | Braid | Twist | Depth | Asymmetry | Pitch | Distance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Calm | .05 | .08 | .34 | .04 | .08 | .20 | .12 | .28 | .08 | .10 | 3.86 |
| Intro | .10 | .15 | .43 | .08 | .16 | .30 | .22 | .36 | .12 | .08 | 3.68 |
| Verse | .28 | .24 | .54 | .14 | .42 | .50 | .42 | .50 | .28 | .02 | 3.48 |
| Pre-chorus | .70 | .12 | .38 | .08 | .68 | .69 | .70 | .58 | .34 | -.04 | 3.58 |
| Build | .88 | .06 | .27 | .03 | .82 | .84 | .88 | .65 | .40 | -.08 | 3.76 |
| Drop | .24 | .98 | .96 | 1.00 | 1.00 | .76 | .68 | .90 | .20 | .05 | 2.82 |
| Chorus | .34 | .80 | .86 | .78 | .86 | .72 | .62 | .82 | .24 | .04 | 3.02 |
| Bridge | .24 | .34 | .61 | .24 | .32 | .40 | .30 | .72 | .76 | .15 | 3.34 |
| Breakdown | .08 | .28 | .48 | .18 | .15 | .24 | .16 | .62 | .46 | .19 | 3.72 |
| Outro | .04 | .14 | .38 | .06 | .09 | .18 | .10 | .38 | .18 | .11 | 3.92 |

### Conductor techniques

- Phrase variation is deterministic from source seed + phrase index.
- The five phrase topology biases are zero-sum and small.
- Topology weights are always normalized; invalid input falls back to torus.
- Key is smoothed circularly in circle-of-fifths order.
- When key confidence is weak, tonnetz angle provides a fallback.
- Major mode slightly favors torus; minor slightly favors saddle.
- Tension slightly favors knot.
- Drop openness and harmonic spread slightly favor cage.
- Topology changes settle over about 1.6–3.8 seconds, tempo-relative.
- Each band's attack/release is independently tuned. Kick and air react fastest; sub/body retain mass.
- Impact target is the max of kick/body deltas, bass punch, and novelty/crest contribution.
- Camera targets are derived from crossing order, spectral lean, section pitch/distance, and long phase. Impact does not directly move the camera.

## 10. Current Loom WebGPU renderer

`visualizer-loom.svelte` is a two-pass WebGPU renderer.

### GPU resources

- One 208-byte uniform buffer (`52 * f32`).
- One 256-byte storage buffer (`64 * f32`) for detail bins.
- One RGBA16Float scene texture.
- One depth24plus depth texture.
- One scene pipeline.
- One fullscreen composite pipeline.
- One linear sampler.
- One scene bind group and one composite bind group.

The canvas context is opaque. The scene pipeline uses solid output, no alpha blending, depth writes enabled, `depthCompare: less`, triangle list, and no culling.

### Resolution and frame pacing

- Internal scale before the pixel cap: 0.78.
- Device pixel ratio cap: 1.5.
- HDR pixel cap: `1600 * 900` total pixels while preserving aspect ratio.
- Target render rate: 60 fps.
- The RAF scheduler estimates display refresh and chooses a whole-number vsync stride.
- Examples: 60 Hz -> stride 1; 120 Hz -> stride 2; 144 Hz -> stride 2 (about 72 rendered fps); 90 Hz -> stride 2 (45 fps).
- This avoids uneven fractional 60-on-144 cadence, but it does not guarantee an exact 60 fps ceiling on every refresh rate.

### Render-rate smoothing

The shared journey normally updates near 60 Hz. The renderer interpolates it at actual render cadence:

- Camera rails: 0.24-second time constant.
- Impact/reweave/section pulse: 0.045 seconds.
- Other scalar pose rails: 0.13 seconds.
- Topology weights: 0.18 seconds.
- Band energies: 0.055 seconds.
- Palette: about 0.22 seconds.
- Spectrum detail: 0.05 seconds.
- RMS attack/release use rates 17/6 per second.
- Long, weave, topology, and signal-travel phases are advanced continuously by the renderer instead of holding between analyzer ticks.

On `sourceEpoch` changes, all interpolation state synchronizes immediately to avoid inheriting the prior song.

### Exact uniform contract

The WGSL uniform is 13 `vec4<f32>` values. Any layout change must preserve 16-byte alignment and update both TypeScript packing and WGSL together.

| Float slots | WGSL field | Packed values | Current shader status |
| --- | --- | --- | --- |
| 0–3 | `resolutionTimeDt` | width, height, elapsed seconds, frame dt | Width/height used. Elapsed time and dt are currently dead. |
| 4–7 | `clock` | impact, continuous signal travel, phrase, normalized tempo | Only signal travel (`y`) is used. Impact is duplicated elsewhere; phrase/tempo are dead. |
| 8–11 | `audio` | RMS, sub, kick, body | All used. |
| 12–15 | `bands` | mids, presence, air, centroid | Band energy used. Centroid is dead. |
| 16–19 | `motion` | macro energy, spectral motion, impact, openness | All used. |
| 20–23 | `weave` | tension, release, crossing order, topology phase | Only crossing order (`z`) is used. Direct tension/release/topology phase are dead. |
| 24–27 | `formsA` | torus/plane, helix, saddle/fold, knot/braid weights | All used. |
| 28–31 | `formsB` | cage/chamber weight, braid, twist, signed asymmetry | Cage, twist, asymmetry used. Direct braid is dead. |
| 32–35 | `palette` | base hue, accent hue, rim hue, saturation | All used. |
| 36–39 | `context` | reweave, section pulse, depth, section energy | Reweave, depth, section energy used. Section pulse is dead. |
| 40–43 | `camera` | yaw, pitch, distance, roll | All used. |
| 44–47 | `style` | tube radius, glow, silence, response motion | All used. |
| 48–51 | `flow` | long phase, weave phase, phrase variation, key | All used. |

### Critical current renderer debt

The conductor looks richer on paper than the screen because several packed rails are renderer-inert:

- Elapsed time and frame dt.
- Direct impact in `clock.x`.
- Phrase position.
- Tempo.
- Centroid.
- Direct tension and release.
- Topology phase and topology rate.
- Direct braid.
- Section pulse.

Some of these still affect other conductor outputs indirectly, but changing their packed slot alone does nothing visually. Do not claim a rail is represented merely because it is present in the uniform buffer.

## 11. Current WGSL visual construction

### Geometry workload

- 192 segments per curve.
- 12 audio strands.
- 1 shuttle/guide loop.
- 6 tube sides.
- 6 vertices per tube face.
- 6912 vertices per instance.
- 13 instances, about 89,856 scene vertices per rendered frame.

The vertex shader builds tube geometry procedurally. It samples a center curve, approximates its tangent from neighboring samples, builds an orthonormal frame, and emits a hexagonal tube. This provides true depth-tested solid geometry, not alpha-blended ribbon cards.

### Five current path forms

The conductor's historical topology names now map to open, X-directed trace forms:

- Torus weight -> `planeForm`: a horizontally flowing lane sheet.
- Helix -> `helixForm`: each lane winds around the X axis.
- Saddle -> `foldForm`: lane-dependent folded sheet.
- Knot -> `braidForm`: central figure-eight-like bundle plus lane rotation.
- Cage -> `chamberForm`: cylindrical chamber/waveguide layout.

All five forms share the same X parameter and are linearly blended by normalized weights. This made transitions technically continuous, but intermediate mixtures frequently read as arbitrary spaghetti rather than a legible topology.

### Audio displacement

- A strand's band is `instanceIndex % 6`, so the six bands are duplicated across 12 traces.
- The first six traces are primary; the second six are 68% radius/value secondary traces.
- `smoothDetail()` Catmull-Rom interpolates the 64 detail bins spatially.
- Each band drives a family-specific sine carrier and overtone.
- Band energy controls displacement amplitude and tube radius.
- RMS contributes modestly to displacement.
- Spectral motion increases detail displacement.
- Impact creates a localized traveling packet along a strand instead of scaling the whole scene.
- The guide is an ellipse moving along the X axis according to the continuous signal phase.

### Important signed-detail bug

The spectrum contract defines `detailBins` as signed `-1..1`: negative values represent receding partials. `smoothDetail()` currently clamps every sample to `0..1`. Loom therefore discards all negative spectral detail. Fixing or deliberately remapping this should be one of the first technical changes.

### Color and material

- Hue travels through base -> accent -> rim palette anchors by frequency family.
- Key and phrase variation add small hue offsets.
- Tube lighting uses two diffuse directions, rim light, a small specular term, and a longitudinal fiber variation.
- There is only one fundamental tube material. Primary/secondary differences are mostly thickness and value.
- The shuttle uses the rim hue and reduced brightness.

### Composite pass

- Samples the scene plus four immediate neighbors for a deliberately small glow.
- Builds a dark HSV-tinted chamber background.
- Adds a procedural flat scope grid and circular contours.
- Adds a central horizon glow.
- Applies vignette, exposure, and an ACES approximation.

There is no temporal feedback texture and no multi-level bloom pyramid. This keeps the renderer comparatively cheap, but also limits material and spatial richness.

## 12. Honest diagnosis of the current visuals

The current direction is more coherent and technically solid than the original alpha-blended closed-loop hairball, but it remains visually weak.

### Why it still looks cheesy

1. **It reads as colored spaghetti.** Twelve similarly styled sine-like tubes cross the screen without enough hierarchy, grouping, negative space, or structural purpose.
2. **The path vocabulary is procedural-demo vocabulary.** Plane, helix, fold, braid, and chamber are familiar shader-demo shapes. Linear interpolation between them does not create a believable loom or instrument.
3. **There is no real weave connectivity.** `crossingOrder` only rotates lane phase. Strands do not actually pass over/under one another according to an explicit crossing graph, and phrases do not reconnect topology.
4. **The shuttle is a gimmick.** The moving elliptical ring adds depth but can read as a hula hoop or laser scanner rather than an essential musical mechanism.
5. **All strands share one tube material.** Palette changes do not substitute for material hierarchy, surface behavior, light transport, or distinct roles.
6. **The background is still basically a flat grid.** It is restrained, but not meaningfully integrated with the weave or music.
7. **Too many rails are dead.** Tempo, topology phase, phrase position, centroid, braid, and section pulse do not currently create visible distinctions.
8. **Sections mostly alter parameter amounts, not compositional grammar.** A build and a drop can still look like louder/wider versions of the same trace field.
9. **The detail contract is mishandled.** Negative spectral movement is discarded.
10. **The renderer lacks a focal subject.** Every strand competes equally, so the eye has no clear primary event, stable anchor, or reveal.
11. **There is little true material depth.** Hexagonal tubes and basic rim/specular lighting are better than 2D ribbons, but still look like simple neon geometry.
12. **The result resembles a screensaver/TouchDesigner patch.** It is “audio visualization” in a generic sense, not yet a unique piece of Mewsik visual language.

## 13. Recommended next-model approach

Do not begin by adding more noise, more glow, more strands, or more background layers. First decide what Loom physically and compositionally is.

### Recommended identity: a harmonic weaving instrument

One promising direction is a coherent 3D instrument with explicit structure:

- Six frequency rails provide stable longitudinal warp threads.
- Harmonic/key relationships create transverse weft connections.
- Phrase boundaries alter a real crossing/connectivity graph, not just offsets.
- Crossing order changes actual depth/occlusion at intersections.
- Tension pulls the structure taut and narrows gaps.
- Release creates spatial openings and lets selected regions unfold.
- Impact sends a local deformation or light packet through connected threads.
- Section changes select different composition grammars: loom plane, tunnel, vaulted fan, suspended membrane, folded lattice—not arbitrary blends of every form.
- A small number of dominant threads or surfaces provides focus; secondary data becomes structure, shadow, or detail rather than twelve equal lines.

This can still reference oscilloscopes and Minimeters, but it should feel like a physical signal instrument in space, not a chart with glow.

### Technical work that should happen early

1. Fix signed spectrum detail or intentionally encode positive/negative detail separately.
2. Move the uniform layout into a typed shared contract or packing helper so renderer and WGSL cannot silently diverge.
3. Delete dead uniform slots or make them visually meaningful.
4. Add a shader compilation/packing contract test, not only a browser-ready smoke test.
5. Replace linear blending of all topology formulas with held section/phrase compositions and authored transitions.
6. Implement explicit crossing semantics if “weave” remains the identity.
7. Build visual hierarchy: primary structure, secondary traces, accents, environment.
8. Make tempo alter a meaningful travel scale or spacing—not global animation speed.
9. Make centroid and spectral direction affect spatial focus or material distribution in a controlled way.
10. Keep impacts local and camera rails slow.
11. Consider a small material state system (conductive metal, glass fiber, woven light, matte cable, phosphor) chosen at phrase/section scale, but do not stack translucent layers.
12. Profile before increasing passes, resolution, or instance count.

### Safe refactor boundary

The next model can completely replace:

- `src/lib/visualizer/loom/shaders.ts`
- Most of `visualizer-loom.svelte` after the shared-journey read

It should preserve or deliberately migrate:

- Engine ID `loom`.
- Production host/catalog integration.
- Shared source epoch and journey lifetime.
- Conductor determinism and tests unless a better contract is introduced with updated tests.
- Feature freshness, pause, and source-reset behavior.
- WebGPU unavailability/device-loss error UI.
- Frame pacing and resolution safeguards.
- The lab route and deterministic profiles.

## 14. Visualizer lab workflow

Start the browser lab:

```powershell
pnpm dev --host 127.0.0.1
```

Open Loom directly:

```text
http://127.0.0.1:5173/visualizer-test?engine=loom&profile=club128&stage=drop&seed=loom-audit&chrome=1
```

Query parameters:

- `engine=loom`
- `profile=club128|swing86|indie118|ambient64|acoustic94|noise172|cinematic72`
- `stage=` one of the selected profile's section IDs.
- `seed=` arbitrary deterministic identity.
- `chrome=1|0`

Lab keyboard shortcuts:

- `q`: Prism
- `w`: Soma
- `e`: Signal
- `r`: Loom
- `c`: show/hide lab chrome

The lab also accepts a local audio file or CORS-enabled URL and runs `WebAnalyzer`.

The page exposes:

```ts
window.__MEWSIK_LAB__.select(profile, stage?, seed?)
window.__MEWSIK_LAB__.settle(frameCount?)
window.__MEWSIK_LAB__.snapshot()
```

Use the deterministic profiles for repeatable screenshots and conductor inspection. Use real songs before judging final musicality; synthetic profiles expose contrasts but do not reproduce all dynamics of actual mixes.

### Minimum visual matrix

At minimum inspect:

- Club 128: verse, build, drop, breakdown.
- Swing 86: verse and chorus.
- Ambient 64: intro, verse, bridge, outro.
- Acoustic 94: verse and chorus.
- Noise 172: build and drop.
- Cinematic 72: intro, build, chorus, bridge.
- Calm, Flow, and Surge response modes.
- Silence/no feature input.
- A source switch and engine switch away/back.
- A 60 Hz display cadence and a high-refresh display cadence.

## 15. Production controls

The production `VisualizerHost` mounts exactly one engine GPU component at a time.

- Left/right arrows cycle engine order.
- `Escape` closes the overlay.
- `H` explicitly hides/reveals controls.
- `I` opens/closes details.
- The details panel shows section, BPM, Loom's dominant topology, and response mode.
- Response modes are Calm (`still`), Flow (`flow`), and Surge (`surge`).
- Engine and response persist in localStorage as `mewsik.visualizer.engine` and `mewsik.visualizer.response`.
- Legacy `mk3` migrates to Signal; removed/unknown engines fall back to Prism.
- Controls auto-hide after 2200 ms unless held. Explicit Hide enters `locked-hidden`; mouse movement alone cannot undo it.

Current Loom response multipliers:

| Mode | Motion | Impact | Width | Glow |
| --- | ---: | ---: | ---: | ---: |
| Calm | .68 | .62 | .88 | .76 |
| Flow | 1 | 1 | 1 | 1 |
| Surge | 1.16 | 1.2 | 1.08 | 1.14 |

Flow is the authored baseline. Do not make response modes three separate art styles.

## 16. Tests and checks

Type/Svelte check:

```powershell
pnpm check
```

Loom and visualizer tests:

```powershell
pnpm exec playwright test e2e/loom-conductor.spec.ts e2e/visualizer.spec.ts e2e/visualizer-lab-profiles.spec.ts --project=chromium
```

Shared journey tests:

```powershell
pnpm exec playwright test e2e/journey-runtime.spec.ts --project=chromium
```

Full browser suite:

```powershell
pnpm test:e2e
```

Current Loom conductor tests require:

- Normalized section profiles.
- Deterministic phrase variation.
- Stable allocation-light output object identities.
- Finite bounded rails even after NaN input.
- Beat-only changes cannot reshuffle topology.
- Phrase boundaries create reweave behavior.
- Each real-frequency band owns its output rail.
- Drops open the weave more than builds.
- Seed reset is exact.
- Results remain close across 30, 60, and 144 Hz update rates.

Production visualizer tests check that Loom mounts, reports two passes and a valid dominant topology, and reaches `data-loom-ready=true` when WebGPU is available.

Useful Loom canvas diagnostics:

- `data-loom-section`
- `data-loom-topology`
- `data-loom-render-passes`
- `data-loom-strands`
- `data-loom-frame-stride`
- `data-loom-refresh-rate`
- `data-loom-internal-pixels`
- `data-loom-ready`

## 17. Build and Windows packaging

Frontend production build:

```powershell
pnpm build
```

Normal NSIS command:

```powershell
pnpm tauri build --bundles nsis
```

On the current development machine, a Visual Studio 2026 shell may select an incomplete C++ include environment and fail to find `excpt.h`. The successful build uses the installed Visual Studio 2022 Build Tools developer environment:

```powershell
cmd.exe /d /s /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64 && pnpm tauri build --bundles nsis'
```

Installer output:

```text
src-tauri/target/release/bundle/nsis/mewsik_0.2.0_x64-setup.exe
```

Installed location:

```text
%LOCALAPPDATA%\mewsik\mewsik.exe
```

The NSIS installer is current-user mode. User music/downloads and private library data must not be silently deleted during app reinstall/uninstall; see `docs/releasing.md`.

## 18. Performance cautions

- WebGPU may not exist in a browser/WebView. Keep a clear error state.
- Handle `device.lost` and destroy textures, buffers, context, and device on unmount.
- Do not create one GPU device per shared journey; only the mounted engine owns GPU state.
- Keep detail buffer identity stable and avoid per-frame allocations.
- Do not remove the absolute HDR pixel cap when adding visual quality.
- Measure changes at the actual 3840x1600 high-refresh development display as well as normal 1080p.
- A heavier blur/bloom chain can rapidly dominate Loom's cost because the scene target is RGBA16Float.
- Adding tube sides, segments, or instances multiplies vertex work directly.
- If adding temporal textures, reset them on source epoch, resize, device recreation, and discontinuity.
- Do not drive visible motion directly from analyzer-event cadence without render-rate interpolation.
- Do not schedule “60 fps” with a fractional millisecond accumulator on 143/144 Hz displays; that creates uneven 2/3-vsync presentation.

## 19. Common footguns

1. `VisualizerJourneySnapshot` nested data is reused and mutated. Copy retained history.
2. Score context can appear after playback begins. Do not treat live -> score relabeling as a musical section hit.
3. `detailBins` are signed. The current shader incorrectly ignores the negative half.
4. WGSL uniform alignment is 16-byte based. Keep the 13-vec4 contract synchronized.
5. A field in the conductor or uniform buffer is not proof it affects the image. Search actual WGSL use.
6. Per-frame elapsed time is currently packed but intentionally not used. Adding `sin(time)` everywhere will reintroduce arbitrary loops.
7. Impact is currently packed twice. Only `motion.z` is used.
8. The historical topology names do not match the current open-path formulas exactly.
9. Linear topology blending is mathematically smooth but visually incoherent in many mixtures.
10. The lab's deterministic profiles are score-backed and excellent for repeatability, but real radio has only live context.
11. The production host controls sit above the renderer. Do not add a second Loom-specific HUD unless explicitly requested.
12. The visualizer overlay includes a transparent full-stage button used to hide/reveal controls. Respect its z-index and interaction behavior.
13. Source reset and pause are different: source reset creates a new epoch; pause decays the existing journey.
14. HMR can preserve stale browser console history. Confirm current `data-loom-ready` and visible output after shader edits.

## 20. Definition of a successful next Loom pass

A pass should not be accepted merely because the shader compiles or has more motion. It should satisfy all of the following:

- A still image has a clear subject, hierarchy, depth, and intentional composition.
- A ten-second clip does not reveal an obvious short global loop.
- Club, ambient, acoustic, noise, and cinematic profiles are visibly different without becoming different random presets.
- Verse/build/drop/bridge/outro change composition or structural behavior, not only amplitude and color.
- Kick response is local and style-appropriate.
- Harmony/key changes affect real crossing, relation, grouping, material, or structure—not only hue.
- Phrase changes visibly reconfigure or reveal structure without a hard random cut.
- Negative/receding spectrum detail has a meaningful visual role.
- Camera motion is slow, purposeful, and not constantly orbiting.
- Bloom is an accent, not the design.
- Background and subject belong to the same spatial system.
- Calm/Flow/Surge scale one identity honestly.
- WebGPU errors are clear, tests pass, and frame pacing remains even.
- The owner no longer describes it as colored spaghetti, a screensaver, a hairball, an After Effects stack, or cheesy.

## 21. Recommended first actions for the next model

1. Read this document and the four Loom core files.
2. Run the current lab across the minimum visual matrix and capture reference images.
3. Confirm the signed-detail bug and dead uniform list directly in code.
4. Write a one-page replacement visual identity before editing shaders.
5. Prototype one strong composition grammar, not five simultaneous forms.
6. Use explicit crossings/connectivity if retaining the “weave” concept.
7. Validate with real music as well as deterministic profiles.
8. Keep the conductor/shared journey unless there is a concrete reason to evolve its contract.
9. Run `pnpm check` and the Loom/visualizer/journey tests.
10. Build, install, and inspect the actual Tauri app before declaring the work done.

## 22. Ready-to-paste task for the next model

Use this prompt when handing the repository to another model:

> You are inheriting the Mewsik music visualizer, specifically the engine named Loom. Read `docs/loom-visualizer-handoff.md` completely before changing code. Assume the current Loom is only a technical checkpoint: its dimensional signal-weave direction is interesting, but the result still looks cheesy, generic, and too much like colored procedural spaghetti. You are authorized to redesign or rebuild Loom's renderer and shaders from the ground up while preserving the shared visualizer runtime contracts, journey lifetime, controls, and engine-selection behavior.
>
> First, inspect the current Loom component, conductor, WGSL shaders, audio-analysis pipeline, visualizer lab, and tests listed in the handoff. Then write a short visual thesis explaining Loom's unique identity, hierarchy, musical mapping, section grammar, material language, camera behavior, and how it avoids repetitive global pulsing. Implement against that thesis. Prioritize a coherent harmonic weaving instrument with legible warp/weft relationships, explicit crossings or connectivity, localized musical motion, true phrase-scale evolution, material depth, and distinct behavior across genres. Do not preserve an existing technique merely because it is already implemented.
>
> Correct the signed-spectrum handling and either connect or remove inert uniform/conductor rails. Use deterministic music-profile fixtures in `/visualizer-test` to compare quiet, club, swing, indie, ambient, acoustic, noise, and cinematic behavior. Verify reduced motion, resize/recovery, engine switching, long-run finite state, type checking, Playwright tests, and a production Windows build. Document material decisions and any remaining performance debt when finished.

The key owner feedback to keep visible while working is:

> Loom can be strange, dimensional, and experimental, but it cannot look like a generic screensaver, a random stack of low-opacity layers, a set of neon noodles, or one looping pulse with different colors. It needs a recognizable identity and a musical lifecycle.
