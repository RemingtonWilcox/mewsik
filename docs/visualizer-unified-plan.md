# Unified Visualizer — Direction & Plan
*Decided 2026-06-09, based on deep research (102-agent verified sweep). Supersedes the
"next major direction" section of HANDOFF.md; aesthetic axioms and anti-targets in
HANDOFF.md remain canonical.*

## Verdict

**Keep the WebGPU/WGSL unified runtime. Do not pivot** to three.js, Babylon, an embedded
native engine, or pre-rendered compositions.

- The milkdrop/projectM lineage — the most-deployed visualizer architecture — is a
  verified preset-interpreter: FFT bands + beat detection only, no key/structure/journey
  awareness. It is the canonical producer of our anti-targets. Our director layer is the
  thing that lineage never built; deepen it, don't discard it.
- mewsik plays arbitrary tracks (YouTube/SoundCloud/Bandcamp/radio). Pre-rendered
  Blender/AE comps cannot cover unknown music; embedding Unreal/Godot into a Tauri
  webview is a second engine + cross-platform shared-texture pain with no verified payoff.
- Caveat honestly: no verified comparative perf data for raw WebGPU vs three.js TSL
  emerged from research. "Keep the stack" = reasoning + working sunk architecture.

## The differentiator: the Visual Score (offline pre-analysis)

Every pro real-time tool (TouchDesigner/Resolume/milkdrop) must guess what the music will
do. **mewsik owns the full audio file before playback** — we can know. A background
analysis pass produces a per-track *visual score*, cached in SQLite keyed by recording:

| Source | Output | Notes |
|---|---|---|
| allin1 (WASPAA 2023) | beats, downbeats, labeled structure segments | label vocabulary + runtime UNVERIFIED — validate empirically before depending on it |
| Demucs v4 | drums/bass/vocals/other stems → per-stem energy curves | offline only (~1.5x duration CPU); repo archived but functional; ONNX port exists (Mixxx GSoC 2025) |
| Essentia models | valence/arousal (continuous) | valence weaker than arousal (r≈0.74 vs ≈0.85) — coarse palette-family decisions only |
| existing Rust analyzer | real-time transients, onsets, chroma | stays; drives moment-to-moment reactivity and is the only source for radio/unanalyzed streams |

Score = section map + drop schedule + energy arc + key/palette plan + camera plan + track seed.
Director consumes the score when present, falls back to the live FSM when not (radio).

**Pragmatic sequencing:** allin1/Demucs are Python/PyTorch — shipping them in Tauri is a
real lift (ONNX via `ort` crate is the plausible path). Phase 2a therefore starts with
classical full-track DSP in Rust (precise beat grid, novelty-curve segmentation, key
detection, loudness arc — no ML deps), which already beats real-time guessing. Phase 2b
upgrades to the NN stack once validated.

## One identity per track (Lomas template)

Andy Lomas's Cellular Forms (verified): one fixed growth rule set + ~12-parameter vector
→ wide emergent diversity from subtle variation, targeting *generic natural similarity*.
Apply directly: per-track parameter vector derived from key/tempo/valence/structure seeds
ONE focal organism that develops across the song — grows in builds, scars at drops,
contracts and reveals detail in bridges. Motif modules demote from co-equal mixed layers
to a supporting field behind the focal subject. This replaces weighted-motif-mixing as
the identity mechanism and is the answer to "no coherent journey."

## The HDR energy budget fix (verified against our own code)

Verifiers read `runtime/post/bloom.ts` and `runtime/post/feedback.ts`: six motifs blend
one/one additive into the HDR target, feedback re-injects the warped previous frame
additively, bloom uses thresholded downsample + one/one additive upsample. Unbudgeted
energy accumulation = blown white cores + fog wash. Production fix (Jimenez SIGGRAPH 2014):

1. Keep rgba16float HDR targets everywhere (already true) — no implicit clamping upstream.
2. Replace thresholded additive bloom with threshold-free mip-chain (progressive
   downsample, tent-filter upsample) composited via `mix(hdr, bloom, ~0.04)` — lerp, not
   add. (0.04 is an artistic default, tune it.)
3. AgX remains the single deliberate range-compression stage.
4. Budget pre-bloom energy: per-motif luminance caps / exposure control so additive sums
   stay inside tonemap headroom.

## Taste calibration (2026-06-10, after live A/B in the app)

Remington's verdict cycling all engines on real use: **mk1 is the only good one** —
mk2/mk3 "right idea, horribly executed", runtime "especially weird, needs full
redesign". Read carefully: mk1 is nominally the anti-target shape (centered, radial),
yet it wins because each preset is a *finished authored composition* — coherent motion
language, confident post-stack, legible beat response. The emergent systems lose not on
concept but on craft.

Consequences for Phase 3:
- Do NOT iterate the current runtime toward the goal. Design the unified scene from a
  blank slate at mk1's finish level; motif systems are ingredients inside authored
  compositions, not co-equal additive layers.
- mk1's post-stack and reactivity language is the proven foundation — carry it over.
- The acceptance bar for any unified-scene milestone is "as finished as mk1", judged in
  the app on real music, not "better than the previous runtime".

## Phases

1. **Energy budget** — items above. Small diff, fixes both stated output defects. Do first.
2. **Visual score** — (a) Rust classical full-track analysis + score schema + SQLite cache
   + director integration with live-FSM fallback; (b) evaluate allin1/Demucs/Essentia via
   ONNX, empirically verify label vocabulary and wall-clock on real hardware.
3. **Seeded identity** — Lomas-style growth subject as focal element, parameter vector
   from score, structure-driven development (scars/growth/contraction), motifs as field.
4. **Choreography** — camera moves and palette arcs planned from the score (anticipate
   the drop, don't react to it); section-aware composition (negative space in bridges).

## Open questions carried forward

- allin1 exact label vocabulary + real wall-clock on consumer hardware (claims refuted as
  originally stated; must measure).
- How official label visualizers are actually produced (the AE-prerender claim was
  refuted; question remains open — doesn't block the plan).
- raw WebGPU vs three.js TSL comparative cost (unverified; revisit only if WGSL velocity
  becomes the bottleneck).
- Feature→parameter mapping conventions from pro practice (TouchDesigner-craft claims
  failed verification; we develop our own mapping language via the lab).
