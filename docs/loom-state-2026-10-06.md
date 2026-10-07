# Loom — current state (2026-10-06)

Read this before `docs/loom-redesign-2026-07-16.md`. That document describes
the "Instrument" cloth design (12 warp, 14 weft picks, shuttle, selvage). It was
superseded the same week by the "signal architecture" iteration that is what
`src/lib/visualizer/loom/shaders.ts` actually contains, and this pass builds on
that. `docs/loom-visualizer-handoff.md` is still accurate for everything outside
the renderer (conductor, journey, lab, tests, packaging).

## Scene

- 3 **primary rails** (instances 0–2), instance 1 is the **hero**: thicker,
  brighter, base hue. The outer two are supporting rails in the accent hue.
- 8 **weft filaments** (instances 3–10) in the rim hue. Each threads over and
  under between two neighbouring rails; `weftDraft(phrase, index)` hashes the
  crossing count and phase per phrase (`cloth.x / 32`), blended across the
  phrase boundary so the re-draft never hard-cuts. Knot weight and energy
  densify the crossings.
- Rails carry an HDR **emissive core** (`dataB.y`) that bloom and the feedback
  trail pick up. Each beat launches a **light packet** along the rail
  (`packet * impact`) that also shifts the hue toward rim.
- Fragment: palette-tinted key/fill lights, brushed **anisotropic** highlight
  along the tangent, tempo **striations** crawling a quarter period per beat
  on the hero, signed spectral detail etching value and emission.

## Post stack (8 passes)

1. scene → `rgba16float` + depth
2. **feedback**: previous frame warped (zoom `post.y`, small rotation from
   sway, drift along the signal axis), decayed by `post.x`, max-blended with
   the scene. Ping-pong textures; `feedbackResetFrames` zeroes the fade for
   two frames on source reset and resize.
3. **bloom prefilter** at half res with soft knee at `post.z`
4–7. two rounds of separable 9-tap blur (H, V, H, V)
8. **composite**: barrel + chromatic aberration (`post.w` scales with impact),
   chamber background, bloom add, vignette, ACES, contrast lift, IGN dither.

## Chamber (composite)

`p.y` is flipped so up is positive. Cool depth haze, a warm pool above
`floorLine = -0.17` that flashes on impact, a soft horizon, and a polished
floor that mirrors the feedback and bloom textures around the floor line.

## Uniforms

14 vec4 groups (56 floats), declared once in `uniform-layout.ts` and mirrored
by the WGSL `Params` struct; `e2e/loom-uniform-contract.spec.ts` fails if they
drift. The `post` group is new: `feedbackFade, feedbackZoom, bloomThreshold,
aberration`, computed in `visualizer-loom.svelte` from energy, impact, silence
and the Calm/Flow/Surge offsets in `catalog.ts`.

## Knobs that matter

- Trail length: `feedbackFade` base `0.88` in the component.
- Bloom amount: `bloomThreshold` base `0.75 - energy * 0.2`; composite weight
  `1.0 + glow * 0.3`.
- Framing: `viewPoint()` scale `1.32 / 1.12` and offsets.
- Hero weight: `hero` terms in radius, emission and value in `vs_main`.
- Weft presence: secondary radius `0.55 * style.x`, value `0.9`.

## Lab

`.claude/launch.json` starts `vite` on 5173 for the desktop app's browser
pane. Pin the seed when comparing: `?engine=loom&profile=club128&stage=drop&seed=soma-qa&chrome=0`.
Without `seed=` the director picks a different palette per load.

## Still open (judged against docs/loom-visualizer-handoff.md §20)

- Sections differ in colour and energy more than in composition; verse, build
  and drop with the same seed are near-identical silhouettes.
- Harmony/key only leans hue; it does not yet change crossing structure.
- Camera is static apart from a slow yaw drift.
- Motion feel (trail silk vs smear, packet legibility at tempo) has only been
  judged from stills.
