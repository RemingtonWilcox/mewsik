# Ensemble channels

The visualizer now hears the band, not just the mix. Every journey snapshot
carries `snapshot.ensemble`: many independent musical channels (each drum,
the groove, chords and key, the bass line, articulation, texture), so each
small part of a picture can answer to its own part of the music. This is the
input for the next round, where every engine gets rebuilt into many
independently driven parts. Today nothing reads it. It is additive, and
every engine renders exactly as before.

Code:

| What | Where |
| --- | --- |
| Tracker, channel reference in the header | `src/lib/visualizer/ensemble.ts` (`EnsembleTracker`, `EnsembleFrame`) |
| Raw features, native | `src-tauri/src/audio/ensemble.rs` (`EnsembleExtractor`, `EnsembleAnalyzer`), wired into `analyzer.rs` (`FrameAnalyzer`) |
| Raw features, browser twin | `src/lib/audio/ensemble-features.ts`, used by `WebAnalyzer` (lab file/URL playback) |
| Lab synthetic ensemble | `src/lib/visualizer/lab/ensemble-score.ts` (chords, bass, drum patterns, fills, breakdowns per profile) |
| Test music + ground truth | `src/lib/visualizer/lab/ensemble-signals.ts`, `scripts/ensemble-wavs.mjs` |
| Scoring helper | `src/lib/visualizer/lab/ensemble-eval.ts`, offline renderer `src/lib/audio/offline-analysis.ts` |
| Lab debug overlay | `src/lib/components/visualizer/ensemble-overlay.svelte` |
| Specs | `e2e/ensemble-tracker.spec.ts`, `e2e/ensemble-audio.spec.ts`, Rust tests in `ensemble.rs` |

## How to use it from an engine

```ts
const e = journey.ensemble;           // same object every tick; read in place
uniforms.kickFlash = e.drums.kick.hit; // impulses already decay
uniforms.swing = e.groove.swing;
if (e.harmony.changeSerial !== look.lastChord) {   // answer each event once
	look.lastChord = e.harmony.changeSerial;
	look.paletteRoot = e.harmony.root;
}
```

- Every event has an impulse (1 or its strength on the tick it fires, then an
  exponential decay) and a `...Serial` that counts up once per event and
  never resets, not even on a new source. Store the last serial you answered
  with the look (like `character.shiftSerial`) so a remount does not re-fire.
- Arrays (`pattern`, `chroma`, `qualities`) are `Float32Array`s with stable
  identity. Copy what you want to remember.
- Gate grid-based channels by `groove.confidence`, and gate everything by
  `director.silence`.
- Prefer driving *parts* with *different* channels: kick and bass move the
  floor, hats the fine grain, chords the palette, tension the geometry,
  articulation the edges, fills the transitions. That is the point of the
  ensemble.

## Raw features (the native event, `audio:features`)

Added to every event, rounded to three decimals. They're optional in
`AudioFeatureFrame`, so older frames still work and the tracker falls back to
the spectrum.

| Field | Range | Meaning |
| --- | --- | --- |
| `chroma` | 12 x 0..1 | Pitch classes from C, 100 Hz–5 kHz, max = 1. Interpolated peaks of an 8192-point Blackman FFT (~186 ms). |
| `bass_chroma` | 12 x 0..1 | The same over 40–250 Hz |
| `onset_kick` | 0..1 | Low-band (40–120 Hz) onset that persists and outweighs the body rise |
| `onset_snare` | 0..1 | A flat noise burst (2–6 kHz) with mid body, persisting, not a note |
| `onset_hat` | 0..1 | High-band (7–16 kHz) onset that isn't part of a broadband burst; a snare takes priority |
| `onset_perc` | 0..1 | Body/mid transient without noise, kick or new pitches (toms, rims, slaps); weakest layer |
| `onset_tonal` | 0..1 | New pitches: the peaky part of the rise over semitone bands |
| `stereo_width` | 0..1 | Side / (mid + side) RMS of the samples since the previous event; 0 = mono |
| `stereo_corr` | -1..1 | Left/right correlation |

Onset strength is relative to the layer's recent loudest hits. Ghost notes
read about 0.3; ordinary hits read 0.8–1.

Payload: a busy 48 kHz event is 5,433 bytes, of which 4,268 are scope and 309
are the ensemble fields (`scope_event_payload_stays_compact`). At 44.1 kHz it
is about 5.1 KB.

## Channels

Latency is measured from the sound to the channel, on the native path. The
lab's file path is the same. "Real radio" rates how noisy I expect the channel
to be on dense, mastered, real music. That is a judgement, not a measurement:
everything here was validated on synthesised test music and the lab
profiles, never on real recordings.

### grid

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `known` | bool | A tempo is known (heard, reported, or a score) | 2–3 s | good |
| `bpm` | 30–260 | Score tempo, else the tracker's own (autocorrelation of its hits, prefers ~115 bpm octaves) | 2–4 s | good with drums; may pick the half or double octave |
| `beatPhase`, `barPhase` | 0..1 | Position in the beat / bar, anchored where kicks and snares land | ~4 s to lock | ok; the downbeat can sit half a bar out |
| `bar` | int | Bar counter within the source | – | – |

### drums.kick / snare / hat / perc, and notes (`EnsembleLayer`)

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `hit` | impulse | Velocity of the hit. Tau: kick .12, snare .14, hat .06, perc .10, notes .12 s | ~35 ms | kick/snare/hat good, perc noisy, notes ok |
| `serial` | int | One per hit | ~35 ms | |
| `velocity` | 0..1 | Strength of the last hit | ~35 ms | |
| `accent` | 0..1 | How far the last hit stood above the layer's typical hit | ~35 ms | noisy |
| `sinceHit` | s | Since the last hit | – | |
| `perBeat` | 0..8 | Hits per beat, ~2.5 s | ~1 bar | good |
| `activity` | 0..1 | perBeat / (perBeat + 1) | ~1 bar | good |
| `present` | 0..1 | The layer is playing (fast in, ~2 bars out) | 0.2 s / 2 bars | good |
| `barPos`, `step` | 0..1, 0..15 | Where in the bar the last hit fell (swing-corrected sixteenth) | ~35 ms | ok once the grid locks |
| `pattern` | 16 x 0..1 | Learned hit strength per sixteenth (fill beats kept out) | 2–4 bars | ok |

A low onset counts as a drum (presence, drop-outs) only once its level has
fallen back by 0.2 s. One that holds is a bass note: it still fires `hit`,
but it feeds `bass.activity`.

### groove

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `confidence` | 0..1 | How far to trust the grid channels | – | – |
| `swing` | 0..1 | 0 straight eighths … 1 triplet (2:1) swing | 2–4 bars | ok with hats; holds through hat-less bars |
| `swingRatio` | 1–3 | Long:short eighth ratio | 2–4 bars | same |
| `syncopation` | 0..1 | Share of accented hits on weak sixteenths, ~3 s | ~2 bars | noisy (it depends on the grid) |
| `regularity` | 0..1 | How well recent bars match the learned 1–2 bar pattern | per bar | ok |
| `fill` | impulse | A fill started (tau .6 s); `fillSerial` | 0.2–0.4 s into the fill (one beat window) | moderate: false alarms at groove changes, misses fills right after another |
| `fillIntensity` | 0..1 | Envelope while a fill plays | ~0.1 s | moderate |
| `sinceFill` | s | | | |
| `drums` | 0..1 | Overall drum presence | ~0.3 s | good |
| `breakdown` | 0..1 | Drums were established and are gone while music plays on | with `dropout` | good |
| `dropout` | impulse | Drums vanished (tau .8 s); `dropoutSerial` | 0.5–0.8 s (about the groove's longest gap + 1 beat) | good, but a very sparse groove can flap in and out |
| `drumReturn` | impulse | Drums came back (tau .8 s); `drumReturnSerial` | ~0.25 s | good |

### harmony

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `chroma` | 12 x 0..1 | Smoothed pitch-class profile (tau .12 s), max = 1 | ~0.2 s | good |
| `root` | -1..11 | Chord root (-1 none) | 250–400 ms | ok on clear harmony; vocals and distortion confuse it |
| `quality`, `qualityIndex` | enum | major, minor, diminished, augmented, suspended, dominant7, none | 250–400 ms | major/minor ok; dim/aug/sus/7 noisy |
| `qualities` | 7 x 0..1 | Probabilities in `ENSEMBLE_CHORD_QUALITIES` order; `none` = 1 - tonality | ~0.2 s | ok |
| `confidence` | 0..1 | Template fit × tonality | | |
| `change` | impulse | Chord changed (1 root, .6 quality only; tau .35 s); `changeSerial` | 250–400 ms (median ~280) | ok; expect extra changes on busy melodies |
| `sinceChange` | s | | | |
| `changesPerBar` | 0–4 | Harmonic rhythm, ~8 s | ~8 s | ok |
| `tension` | 0..1 | Chord quality, clashing pitch classes, notes outside the chord and the key | ~0.3 s | ok as a trend |
| `degree` | -1..11 | Chord root relative to the key's tonic | | follows key |
| `key.tonic`, `key.mode` | 0..11, major/minor | Krumhansl key over ~10 s | 5–20 s | relative major/minor are often swapped |
| `key.major`, `key.minor` | 0..1 | Mode probabilities | | soft |
| `key.confidence`, `key.stability`, `key.changeSerial` | | How settled the key is | | |

### bass

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `pitchClass` | -1..11 | Bass note (-1 none) | ~0.15–0.25 s | ok; kick sweeps and sub-40 Hz notes blur it |
| `confidence` | 0..1 | | | |
| `note` | impulse | New bass note (tau .15 s); `noteSerial` | ~0.2 s | ok |
| `interval` | -6..6 | Last move in semitones | | ok |
| `stepwise` | 0..1 | Share of recent moves of at most 2 semitones | ~4 notes | ok |
| `walking` | 0..1 | Stepwise and about one note per beat | ~2 bars | ok |
| `perBeat`, `activity` | | Bass notes per beat (pitch changes and held low onsets) | ~1 bar | ok |
| `level` | 0..1 | Low-register level | ~0.1 s | good |

### articulation

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `legato` | 0..1 | 0 staccato … 1 legato. From each note's level ~85 ms after its onset, relative to its peak and to the level before it; mid register weighted | ~4 notes | noisy on dense mixes (other parts fill the gaps) |
| `staccato` | 0..1 | 1 - legato | | |
| `low`, `mid`, `high` | 0..1 | The same per register (low follows kicks too) | | |
| `sustain` | 0..1 | Sustained floor over peaks in the mid register, 1.5 s windows | 1.5–3 s | ok |
| `pad` | 0..1 | Sustained-pad presence: tonal, sustained, few onsets | ~2 s | ok |
| `noteRate` | /s | Tonal onsets per second | ~2.5 s | ok |

### texture

| Channel | Range | Meaning | Latency | Real radio |
| --- | --- | --- | --- | --- |
| `eventsPerSecond`, `density` | /s, 0..1 | All hits and notes, ~2.5 s; density = e/(e+5) | ~2 s | good |
| `trend` | -1..1 | Energy, density and brightness slope over ~8 s | 2–8 s | ok |
| `build` | 0..1 | Rising part of the trend | 2–8 s | ok |
| `low`, `mid`, `high` | 0..1 | Register levels (adaptive) | ~0.15 s | good |
| `register` | -1..1 | High minus low balance | ~0.15 s | good |
| `width`, `correlation` | 0..1, -1..1 | Stereo image, ~0.3 s. Neutral 0.3 / 0.7 when `stereoKnown` is false | ~0.3 s | good |
| `tonality`, `noisiness` | 0..1 | Pitched vs noisy (chroma peakiness, flatness) | ~0.3 s | ok |

## Reset

`resetSource` (a new song or station) calls `EnsembleTracker.beginSource()`,
which forgets the song: patterns, swing, chord, key, bass line, articulation,
trends and drum presence. Serials keep counting. The last tempo stays as a
prior until the new one is heard (2–3 s). Silence (`director.silence`) decays
impulses and presence but forgets nothing.

## Lab

- `/visualizer-test?...&ensemble=1` (or press `n`) shows the live panel:
  - tempo and bar;
  - the chord in large type, the key, degree, harmonic rhythm and bass note;
  - each drum layer and notes, with a hit flash, an activity meter, a
    presence tick and the learned 16-step pattern (the current step is
    marked, the last hit boxed);
  - groove meters with fill, out and in flashes;
  - the 12-bin chroma (chord root orange, bass note cyan) and the quality
    probabilities;
  - bass, articulation and texture meters.
- Every lab profile now carries an ensemble. It has chord progressions with
  major, minor, diminished, augmented, suspended and dominant chords, and
  bass lines (club offbeat octaves, swing86 walking, acoustic root-fifth,
  ambient and cinematic pedal). It has drum patterns: four-on-the-floor,
  backbeat, swung hats in swing86 and 16ths in club, with phrase-end fills
  and breakdowns with the drums out. Its tonal rhythm differs too: pads,
  strums, stabs and comping.
- `node scripts/ensemble-wavs.mjs` writes the test music to
  `output/ensemble/wavs/`, with `*.truth.json`. Drop a WAV on the lab's file
  picker with `&ensemble=1` to watch it heard live.
- Native check:
  `ENSEMBLE_WAV_DIR=output/ensemble/wavs cargo test --manifest-path src-tauri/Cargo.toml --release dump_native_features -- --ignored`
  writes `*.native.json` (the frames the app would emit).
  `evaluateEnsemble(ensembleSignal(id), frames)` scores them.

## Measured on the test music (2026-10-23)

Both paths use the same signals: the lab's file path (WebAnalyzer, offline)
and the native analyzer (Rust `FrameAnalyzer`, dumped).

| Test | Lab path | Native path |
| --- | --- | --- |
| C–Am–F–G–Bdim ×2, chord changes found | 9/9 | 9/9 |
| change latency (min–max, median) | 268–352 ms, 269 | 250–400 ms, 283 |
| root / quality correct (mid-chord) | 100% / 100% | 100% / 100% |
| spurious extra changes | 3 per 10 chords | 2 per 10 chords |
| breakdown song chords (23 changes) | 23/23, 100% / 100% | 23/23, 100% / 100% |
| key of C–Am–F–G–Bdim | A minor (relative of C major) | A minor |
| drum loop 100 bpm: tempo | 99.9 | 100.0 |
| kick / snare found (false) | 32/32 (0) / 32/32 (0) | 32/32 (0) / 32/32 (0) |
| hats found (false) | 95/128 (0); the 32 under snares are left to the snare | 95/128 (0) |
| hit latency (median) | 35 ms | 33 ms |
| swing ratio, straight / swung 2:1 | 1.00 / 1.86 | 1.00 / 1.94 |
| fills every 4th bar | 3/4, 0 false, 234–250 ms | 4/4, 0 false, 217–367 ms |
| false fills on the steady loops | 0 | 0 |
| staccato / legato line, `legato` | 0.01 / 0.77 | 0.01 / 0.71 |
| breakdown: drop-out latency, return latency | 784 ms, 234 ms | 550 ms, 250 ms |
| breakdown envelope mid-breakdown | 1.00 | 1.00 |

The first fill in `drums-fills` comes at bar 4, before two bars of groove
have been learned, so 4/4 is the ceiling there. Toms in fills read as kicks
(10–15 extra kicks); the perc layer catches almost none of them.

Lab profiles (synthetic path, whole songs):

- Chords: root and quality correct 100% of mid-chord time on club, swing86,
  indie, acoustic and cinematic, and 92% on ambient (its long pads change
  late). Noise172 is correctly heard as atonal.
- Keys: right on all six tonal profiles, with the right mode on swing86 (F
  minor), cinematic (Eb minor) and indie (G major).
- Swing: swing86 reads 1.9–2.0 in its verse and chorus. Club, indie and
  noise read 1.0.
- Walking bass: about 0.9 in swing86, under 0.35 elsewhere.
- Fills caught:
  - club 5/5, plus one false fill where the intro's groove changes to the
    verse's;
  - swing86 5/6, no false fills;
  - indie 13/15, no false fills;
  - noise 10/14, no false fills;
  - cinematic 2/3, plus two false fills at groove changes.
  - The misses are section-end fills that come one bar after another fill,
    inside the 1.5-bar refractory period.
- Drop-outs: one drop-out and one return in the club breakdown (drop-out
  ~1.2 s after the drums stop, return ~2 s into the outro) and in the noise
  breakdown. None in ambient.

Cost: `EnsembleTracker.update` takes about 8–12 µs per tick once warm. That
was measured over 3,600 ticks of noise172, the busiest profile. During the
eval runs above, warm-up included, it took 10–45 µs. The tempo
autocorrelation runs every 0.5 s and adds about 18 µs on its tick. The spec
asserts under 0.3 ms. The native extractor adds one 2048-point and one
8192-point real FFT per frame.

## Known limits

- Everything was tuned and validated on synthesised music. Real radio will be
  noisier, especially:
  - perc (toms read as kicks; slaps and rims are often missed);
  - accent;
  - syncopation (grid-dependent);
  - legato in dense mixes;
  - dim/aug/sus/dom7 qualities;
  - key mode (relative major and minor).
- The live clock (`director.clock`, from the analyzer's `bpm`/`beat_phase`) is
  unchanged and often wrong. On the test loops it sat at 60 bpm for a
  120 bpm groove and wandered from 60 to 130 in a breakdown. The ensemble
  ignores its phase and octave and keeps its own tempo. Engines that need
  musical time should use `ensemble.grid` rather than `director.clock` on
  live audio.
- The downbeat can be half a bar out (kicks on 1 and 3 look alike), so
  `barPos` and pattern step indices may be rotated by 8.
- Hats under a snare are mostly not reported (the snare takes priority).
- A groove change at a section boundary can fire one fill.
- Swing is measured at the eighth level only (no sixteenth swing), and it
  needs offbeat hits.
- Tempo can land on the other octave for half-time or double-time feels
  (DnB at 172 may read as 86).
