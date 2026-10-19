# Loom: current state (updated 2026-10-18, visual-variety pass)

Read this before `docs/loom-redesign-2026-07-16.md` (superseded "Instrument"
cloth design). `docs/loom-visualizer-handoff.md` is still accurate for the
conductor's reactive rails, journey, lab, tests and packaging; this file
describes the renderer and the long-listen look layer.

## What changed on 2026-10-18

The owner's verdict (2026-10-18): Loom is very in sync with the music, but it
"overall maintains the same composition, shape and color scheme the whole time
no matter what". The reactivity was kept exactly as it was; a **look layer** on
the shared variation genome (`src/lib/visualizer/variation.ts`) now moves Loom
through about 10^15 reachable combinations of topology, palette, material,
camera, environment and beat form, changing only on musical boundaries and
gliding across them.

## Architecture

```
director + spectrum ──> LoomConductor (conductor.ts)
                          ├─ reactive rails (bands, impact, tension, drops, camera rails)
                          └─ LoomLook (look.ts) ── VariationGenome(LOOM_LOOK_AXES, seed)
                                 └─ frame.look: resolved, crossfaded numbers
visualizer-loom.svelte ── packs rails + look into 36 uniform vec4s ── shaders.ts
```

- `LoomLook` lives inside the conductor, so it lives in the shared journey: it
  survives renderer remounts and resets only on a real source change (new
  seed). Per frame it is fed `{ phraseIndex, sectionKey: section, energy:
  macroEnergy, mode, key, dt }`.
- On the first frame it walks the genome through `1 + ordinal(section)`
  virtual boundaries and settles, so lab stills of verse / build / drop with
  the same seed open on different looks, and the first real frame is not
  itself a boundary.
- Resolved values get a last 0.35 s glide (`smooth()`), so a genome retarget in
  the middle of a crossfade can never jump.
- Palette families are re-mapped once, at the moment an option becomes the
  target: dark families only hold in low-`vivid` eras and bright major high
  energy lifts them to a vivid family; low-vivid minor quiet passages can drop
  into a dark family. The mapping is latched, so a crossfade never flips.
- QA override: `?loomLook=grammar=3,palette=5,camera=2,material=1,environment=4,beatForm=2,thickness=0,roles=1`
  pins choice axes (lab URL). `setLoomLookOverride()` in look.ts.
- Canvas attributes for QA: `data-loom-grammar`, `-palette`, `-camera`,
  `-material`, `-environment`, `-beat-form` (plus the old `-topology`, which
  still reports the conductor's torus/helix/saddle/knot/cage weights).

## Genome (LOOM_LOOK_AXES)

| axis | kind | scale | options / step | chance | memory | tau |
|---|---|---|---|---|---|---|
| grammar | choice | section | 13 | 0.85 | 6 | 3.2 s |
| palette | choice | section | 36 | 0.8 | 12 | 4.5 s |
| roles | choice | phrase | 6 (hero/support/weft permutations) | 0.2 | 2 | 3.5 s |
| camera | choice | phrase | 7 | 0.42 | 3 | 4.5 s |
| material | choice | section | 7 | 0.45 | 3 | 3.5 s |
| environment | choice | era | 6 | 1 | 3 | 6 s |
| beatForm | choice | section | 5 | 0.55 | 2 | 2 s |
| thickness | choice | phrase | 4 | 0.25 | 2 | 3 s |
| twist, crossings, spread, curvature, framing, hueDrift | continuous | phrase | step 0.12 to 0.3 | 0.4 to 0.7 | | 3 to 6 s |
| strands, symmetry, scale, lightAzimuth, bloom, drift | continuous | section | step 0.25 to 0.4 | | | 4 to 5 s |
| lightWarmth, trail, vivid | continuous | era | step 0.35 to 0.4 | | | 6 to 7 s |

`variationSpaceSize(LOOM_LOOK_AXES)` = 1.1e15 (choices alone: 13 x 36 x 6 x 7
x 7 x 6 x 5 x 4 = 1.65e7).

## Topology grammars (shaders.ts `grammarPoint`)

Every grammar is a parametric surface `P(s, lane)`; the 3 rails sit at lanes
-2/3, 0, 2/3, the 8 weft filaments interpolate lanes between neighbouring rails
(threading over/under along the surface normal hint), and 16 chorus strands sit
on bit-reversed lanes so any visible prefix is evenly spread. A grammar change
morphs the same threads (with a small mid-morph lift) instead of cutting.

0. **ribbon**: the original architecture function, untouched, still shaped by
   the conductor's knot/cage/saddle/helix weights and tension/release.
1. **canopy**: vaulted nave of threads, billowing.
2. **tunnel**: breathing, bending tube; the axial camera looks down it.
3. **helix-tower**: tapering column of helices; symmetry counter-winds half
   of them into a lattice tower.
4. **mobius**: band of parallel threads, each looping twice to close.
5. **peacock**: threads spring from a low root and arc toward the viewer.
6. **braid**: three-strand plait on an S curve, chorus strands as a sheath.
7. **string-hyperboloid**: straight chords between two rings; kicks tighten
   the waist.
8. **saddle-lattice**: two thread families crossing on a hyperbolic paraboloid.
9. **thread-galaxy**: log-spiral arms on a horizontal warped disc with a
   hollow centre. It must stay horizontal: the slow-orbit regime yaws all the
   way round, so any tilt about the object x axis eventually adds to the
   camera pitch and shows a face-on vortex. Only top-down sees the spiral.
10. **trefoil**: (2,3) knot that ties under tension and relaxes on release.
11. **orrery-rings**: tilted closed rings strung along x; symmetry gathers
    them, but never fully concentric (that would read as a centred orb).
12. **aurora-curtain**: hanging folded drape whose fold travels.

Per-grammar `strands` ranges and framing `scale` live in `LOOM_GRAMMARS`.
Shape axes (twist, crossings, spread, symmetry, curvature) are read by every
grammar; section dynamics (tension, openness, drop openness) still bend each
one. Thickness profiles: tapered, even, beaded (beads crawl with the beat
conveyor), swelling.

## Palettes, materials, cameras, environments, beat forms (look.ts)

- **36 palette families** (28 vivid home families: sunrise, tropical, aurora,
  candy-neon, citrus, festival, oil-slick, pastel-dusk, electric-lagoon...;
  8 darker eras: midnight-cobalt, ember, deep-sea, noir-rose...). Each has
  hero / support / weft plus deep / haze / glow environment tints, hand-picked
  sRGB converted to linear. Six role permutations, a key lean and a
  phrase-scale hue drift (grey-axis rotation, at most about 0.05 turn). No
  cosine palette anywhere.
- **7 materials** (coefficient sets on one fragment path): glass-fibre (the
  old look), liquid-chrome (environment reflection, low emission), silk
  (matte, broad sheen, strong striations), neon-tube (thin, white-hot core),
  molten-glass (flowing heat bands, translucency), pearl (pale body,
  iridescent rim toward the weft colour), phosphor (thin, scanline striations,
  longer trails).
- **7 camera regimes**: three-quarter (old), low-hero, top-down, axial
  (inside/along the structure), macro (close, off-centre), slow-orbit (held
  orbit that accumulates and stays put when the regime ends), wide. Offsets
  ride on the conductor's camera rails; drops still pull in.
- **6 environments** (composite coefficients): chamber with floor reflection
  (old), open sky (gradient and an off-centre low glow), water (rippled
  reflection), mirror box (angled side mirrors holding a compressed receding
  copy of the scene), fog bank, starfield. The camera regime scales how much
  floor/horizon shows (top-down hides it).
- **5 beat forms**: packets (old; always kept at a floor of 45% so beat sync
  never weakens), plucked strings (standing wave on each kick), crossing
  pulses, shuttle (a bright throw across every thread, one step per beat),
  sparks. Plus genome-driven trail length, bloom bias and trail drift/spin.

## Renderer

- Scene draws in two calls on one pipeline: rails + weft (11 instances, 208
  segments x 10 sides) and chorus strands (16 instances via `firstInstance`,
  128 segments x 6 sides, collapsed to zero radius when the grammar does not
  show them). About 211k vertices; per vertex three loomPoint evaluations,
  two grammars only during a morph.
- Proper perspective clip (w = depth, near 0.1, far 14), so regimes can fly
  inside the weave; threads near the lens thin out.
- Post stack unchanged in shape (8 passes): scene, feedback (max-blend, now
  with genome drift/spin), bloom prefilter, 2 x separable blur, composite
  (barrel + CA, environment, bloom, vignette, ACES, IGN dither).

## Uniforms

36 vec4 groups (144 floats): the original 14 reactive groups plus 22 look
groups (`topo`, `form`, `formB`, `frame`, `lens`, six colour tints, four
material groups, three environment groups, `light`, `beat`, `beatB`,
`postB`). Declared once in `uniform-layout.ts`, mirrored by the WGSL `Params`
comments; `e2e/loom-uniform-contract.spec.ts` checks both and the float count.

## Knobs that matter

- How often things change: `chance` per axis in `LOOM_LOOK_AXES`.
- Trail length: `feedbackFade` base `0.86 + trail * 0.05 + material.trail`.
- Bloom: `bloomThreshold` `0.75 - energy * 0.2 + (0.5 - bloom) * 0.14`.
- Framing: `LOOM_GRAMMARS[].scale`, camera `distance` / `focal`, and
  `viewPoint()` scale `1.32 / 1.12 / 1.16`.
- Room brightness: haze lift in the composite (`haze` mix toward its own
  peak colour).

## Tests

- `e2e/loom-conductor.spec.ts`, "the long-listen look genome...": space size >
  1e6, deterministic per seed, 300 simulated phrases reach >= 40 distinct
  (palette, grammar, camera) triples for a scored song and for a live stream
  with no section labels, every grammar / camera / material / environment /
  beat form is visited, colours glide, beats alone never move the look, no
  scene holds longer than eight phrases.
- `e2e/loom-uniform-contract.spec.ts`: 144 floats.

## Lab

`.claude/launch.json` starts `vite` on 5173. Pin the seed when comparing:
`?engine=loom&profile=club128&stage=drop&seed=soma-qa&chrome=0`, add
`&song=1` for whole tracks back to back, `&loomLook=...` to pin a look.
Time-lapse: `VIS_ENGINE=loom VIS_MINUTES=8 VIS_EVERY=10 node scripts/visual-timelapse.mjs <label>`.

## Still open

- The genome's choice gates are honest coin flips, so a seed can hold a
  palette for 4 to 5 sections by chance (about 1% of runs at chance 0.8).
- Section-ordinal warm-up is a heuristic; it does not reproduce what a long
  listen would have reached by that point in a song.
- Materials read clearly at rest; at drops bloom and trails still dominate
  surface shading.
