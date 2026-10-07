# Loom redesign thesis — "The Instrument" (2026-07-16)

This is the one-page visual identity written before touching shaders, per
`docs/loom-visualizer-handoff.md` §21. It replaces the "dimensional signal
weave" checkpoint, which read as equal-weight colored spaghetti with a hula
hoop.

## What Loom is

**Loom is a harmonic weaving instrument.** Not a field of traces — one physical
machine in a dark chamber, weaving one piece of cloth. The cloth is the song.

- **Warp** = six frequency-owned lane pairs (sub → air ordered across the
  width). Twelve threads with explicit hierarchy: a thick matte primary and a
  thin carrier per lane, not twelve equal noodles. The warp is the instrument's
  skeleton; it is dark, structural, and band-hued.
- **Weft** = luminous transverse picks, inserted **one per beat** by a visible
  shuttle at the fell (the insertion front, stage right). Inserted picks
  conveyor slowly away from the fell with song time, age, and dim. The cloth
  downstream of the fell is literally the song's recorded history.
- **Shed / draft** = at every warp×weft crossing there is real over/under
  geometry with real occlusion. The crossing plan is a true weaving draft —
  tabby/twill/satin-like matrices — derived deterministically from
  (seed, phraseIndex) and styled by harmony: braid + knot weight set float
  length, minor mode lengthens floats, harmonicSpread densifies. **A phrase
  boundary changes the draft**, so new picks weave the new pattern while older
  cloth keeps the old one. Harmony changes structure, not hue.
- **The shed opens** near the fell: warp threads there part over/under by the
  draft of the pick the shuttle is currently carrying, and close behind it.
  The mechanism is legible, not decorative.
- **Tension / release** are physical: tension pulls the warp taut, narrows the
  spacing, flattens sway; release opens spacing and lets the sheet relax.
- **Impact** is a damped transverse wave launched at the fell into the nearest
  warp lanes. It never scales, jolts, or zooms the world or the camera.

## One sheet, one shape grammar

The whole cloth (warp + weft + selvage) is shaped by ONE function
`clothShape(x, u)` driven by continuous rails — no five-way linear blend of
shader-demo forms:

- `curl` (new conductor rail): the sheet rolls its edges under toward a tube —
  builds tighten into a tunnel, drops release open.
- `dropOpenness` / `arch`: the cross-section vaults into a canopy on drop/chorus.
- `sway` (the old `motion` rail, now visible): a slow longitudinal traveling
  wave, pinned at the selvages.
- `spread` (openness): warp spacing.

Section grammars are target sets on this one family: calm/intro = wide flat
panel; verse = gentle sway; pre-chorus = arch begins, spacing narrows; build =
curl rises, taut; drop = curl releases, vault opens; chorus = open shallow
vault, dense weave; bridge = deep sway, sparse picks; breakdown = partly
unwoven — sparse picks expose bare warp; outro = flattening, thinning, dimming.
Transitions are eased moves inside one legible family (a sheet curling into a
tunnel reads; a helix lerp-ing into a saddle never did).

## Hierarchy and dead-rail resurrection

Focus order: (1) the cloth as one surface, (2) the fell + shuttle — the only
fast-moving object, (3) warp lanes as frequency structure, (4) selvage rails
framing the machine, (5) the chamber. Every previously inert uniform now has a
job: tempo → conveyor speed + shuttle pacing; phrase/beats → pick positions and
draft phrases; centroid/spectralLean → where spectral etch concentrates across
the width; braid → float length; twist → lane-pair twist; sectionPulse → a
beater compression ripple at the fell; elapsed → dither; the five topology
weights are consumed as grammar (knot → float density, cage → spread, saddle →
sway asymmetry, helix → curl bias, torus → plainness). The signed `detailBins`
bug is fixed: positive partials raise and brighten fresh cloth near the fell,
receding partials recess and darken it, fading with cloth age.

## Materials and light

Warp = matte anisotropic fiber, dark (v ≈ 0.3–0.55), band-energy sheen.
Weft = phosphor glass, brighter, accent→rim by pick age, slight emissive.
Shuttle = the brightest object, rim hue. Crossings shade: under-passes are
softly occluded. Bloom stays a 4-tap accent in the composite; the background is
a chamber in the same spatial system (depth haze, floor sheen, faint heddle
striations that breathe with tension) — no scope grid.

## Camera

Patient three-quarter dolly, section-held targets with 3–4 s taus, slow lateral
drift on `longPhase`, never a continuous orbit, never kick-moved.

## Acceptance

The handoff §20 checklist applies, specifically: verse/build/drop/bridge/outro
differ in composition not amplitude; a still frame has one subject; phrase
boundaries visibly re-draft new picks; harmony changes crossing structure;
nothing reads as spaghetti, screensaver, hairball, or AE stack.

---

## Implementation result (shipped 2026-07-16)

The thesis above is implemented. What changed, by file:

- `src/lib/visualizer/loom/shaders.ts` — full rewrite. Instanced procedural
  tube geometry: 12 warp threads (6 band lanes x primary/carrier), 14 weft
  picks, 1 shuttle, 2 selvage rails = 29 instances, ~200k verts/frame, 2
  passes (scene + composite). `clothShape(x, u)` is the single sheet family
  (flat panel <-> vault <-> tunnel). `draftOver(lane, pick)` is a real
  weaving draft hashed from (seed, pick's phrase) with float length from
  braid/knot/mode; it drives weft dips, warp dents, and the shed opening at
  the fell. Signed `detailBins` bug fixed (`smoothDetail` clamps -1..1 and
  etch brightens/recesses both ways). `getCompilationInfo` errors now surface
  in the error UI.
- `src/lib/visualizer/loom/uniform-layout.ts` — new typed 52-float contract
  (`LOOM_UNIFORM_GROUPS` + `packLoomUniforms`). The WGSL `Params` struct
  mirrors it with machine-checkable comments. Every slot is live; each has a
  documented job. `macro` is a WGSL reserved word — the group is `macroRails`.
- `e2e/loom-uniform-contract.spec.ts` — new. Fails the build if WGSL fields
  and the TS layout ever drift apart, and verifies pack order.
- `src/lib/visualizer/loom/conductor.ts` — additive only (all prior contracts
  and tests hold). New rails: `curl` (section target + tension - release,
  slow attack / fast release so drops open) and `weftSparse` (section target,
  +0.22 in silence) with per-section targets in `SECTION_PROFILES`.
- `src/lib/components/visualizer/visualizer-loom.svelte` — render path
  rewritten around the layout contract. Beat conveyor: one pick per beat,
  advanced from the shared clock and pulled to the phrase anchor
  (`phraseIndex*32 + phrasePos*32`, snap beyond 24 beats) so seeks and
  score/live handoffs stay aligned; holds during silence. Pose keys add
  `curl`/`weftSparse`. Shader compile errors are extracted with line numbers.
- `scripts/loom-visual-matrix.mjs` — standalone capture tool
  (`node scripts/loom-visual-matrix.mjs <label>` writes
  `output/loom-<label>/`). Needs headed Chromium: headless Chromium on the
  dev machine has no usable WebGPU adapter.

Before/after reference shots live in `output/loom-before/` and
`output/loom-after/` (uncommitted audit artifacts; add `output/` to
.gitignore or delete when no longer needed).

Verified: `svelte-check` clean; 33 e2e tests pass (loom-conductor,
loom-uniform-contract, visualizer, visualizer-lab-profiles, journey-runtime).
The five legacy topology weights remain for telemetry and are consumed as
grammar (knot -> float density, cage -> spread, saddle -> sway asymmetry,
helix -> curl bias, torus -> plainness).

## Remaining debt / honest limitations

- The draft pattern is deterministic per pick's phrase, so seeking backward
  re-weaves "history" consistently, but the draft's harmony term (float
  length) uses the CURRENT smoothed rails — old picks do not remember past
  key/mode. Passing per-phrase harmony history to the shader would need a
  small ring buffer texture; not judged worth it yet.
- The shed opening is visible at the fell but subtle at 1080p; SHED_AMP
  (0.085) is the knob.
- Floor sheen and heddle hairlines in the composite are intentionally near
  the visibility floor; they are structure, not features.
- No production Tauri build was run in this pass (frontend-only changes;
  `pnpm build`/NSIS packaging unchanged). Run the Windows packaging steps in
  handoff section 17 before shipping an installer.
- The capture matrix covers 8 profile/stage cells, not the full handoff
  section 14 matrix (response modes, silence, high-refresh cadence were
  verified through e2e suites, not screenshots).
