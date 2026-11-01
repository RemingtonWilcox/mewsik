# mewsik listening engine (prototype)

An offline engine that listens to a whole track and writes down what is
happening in it. It finds beats, downbeats, tempo and meter. It reads the key,
the chords and any modulations. It splits the track into sections (intro,
build, drop, breakdown, verse, chorus, bridge, outro) and gives each one a
repeat letter. It tracks energy, tension, loudness (EBU R128) and a heuristic
mood. It also notes which stems are playing and where the kick, snare and hat
hits land. All of that feeds a timed event list and a one-line description of
each section.

It is Python (librosa, essentia, optional Demucs), not yet part of the app. Its
output includes `compat_track_score`, a down-conversion to the app's existing
`TrackScore` (`src-tauri/src/analysis`, `src/lib/visualizer/director/score.ts`),
so the visualizer director can perform against it unchanged.

```bash
pip install -r listening/requirements.txt
cd listening
python -m mewsik_listen analyze song.wav -o song.json --midi song.mid   # prints a summary
python -m mewsik_listen analyze song.wav --compat -o score.json        # app TrackScore only
```

`--midi` writes the chord progression (pad + bass root) at the detected tempo,
with section markers. Drag it into Ableton Live next to the audio at 1.1.1.

## How it listens

| Module | Method |
|---|---|
| `rhythm.py` | essentia multi-feature beat tracker (librosa DP fallback). A backbeat check fixes half/double tempo errors: kick or snare landing *between* tracked beats doubles the tempo, and empty alternate beats halve it. Meter (3 vs 4) comes from bar-level self-similarity. Downbeat phase comes from chord changes, low-end accents, energy steps and backbeat placement. Also produces a local tempo curve. |
| `harmony.py` | CQT chroma of the HPSS-harmonic signal, split into treble and bass, and tuned. 24 triads + N.C., decoded with a beat-level HMM. The key is a vote of Temperley and EDMA profiles plus diatonic chord fit; relative-major/minor and dominant confusions are resolved by "which chord feels like home" (duration, first/last chord, bass). Also gives Camelot notation and a local key track. |
| `energy.py` | EBU R128 momentary/short-term loudness, integrated LUFS and LRA. Energy = loudness + onset density + low end + brightness. Tension = rising energy, brightness and density. Valence/arousal is a heuristic. |
| `stems.py` | Demucs htdemucs when its weights are cached (or `--demucs`), otherwise an HPSS + low-pass DSP split with no vocal stem. Produces per-stem activity, presence segments and kick/snare/hat hit times. |
| `structure.py` | Bar-level features (MFCC, chroma, energy, stem activity). Boundaries come from a two-window contrast plus SSM novelty with a phrase-line bonus (4/8 bars) and a minimum section length of about 7 s. Sections are clustered into repeat letters, and functional labels use an electronic or a song vocabulary. |
| `timeline.py` | Events (sections, drops, stems in/out, key and tempo moves, tension builds, peak) and per-section narration. |

## Accuracy

`eval/evaluate.py` scores the engine with mir_eval. Full tables are in
`eval/results/results.md`.

**Synthetic set**: `eval/synth.py` renders 7 songs with exact truth: EDM with
builds and drops, house, a half-time ballad, a 3/4 waltz, drum & bass at 174,
swung lo-fi with 7th chords, and a 100→120 BPM ramp.

| Metric | Mean |
|---|---|
| Tempo Acc1 / Acc2 (4%) | 0.86 / 1.00 |
| Beat F-measure (70 ms) | 0.92 |
| Downbeat F-measure | 0.91 |
| Meter (3 vs 4) | 7/7 |
| Key (MIREX weighted) | 1.00 |
| Chords, maj/min weighted overlap | 0.86 |
| Section boundaries F @ 3 s | 0.85 |
| Section function label (frame accuracy) | 0.78 |
| Stem presence, drums / bass / other | 0.89 / 0.93 / 0.99 |

**Real recordings** (CC/PD, from librosa's example data and MDN's webaudio
examples), scored only where truth is published:

- **Sugar Plum Fairy:** E minor, correct.
- **Brahms Hungarian Dance 5:** the engine (and essentia) hear G minor. The
  recording is titled F# minor after the piano original, while orchestral
  arrangements are usually played in G minor. Unverified.
- **Sweet Waltz:** meter 3, correct.
- **MDN 5-part multitrack:** stem presence vs the real isolated stems is
  0.95 / 0.97 / 1.00. It is weak evidence, because the parts play almost
  throughout.

**Caveats:**

- Both sets were used while tuning (key disambiguation, octave rule, section
  rules), and there is no held-out set, so read these numbers as optimistic.
- The ballad (76 BPM, half-time) is read at 152.
- Seventh chords and fast harmonic rhythm cost chord accuracy (lofi 0.74,
  waltz 0.77).
- The stems above are the DSP fallback. Demucs weights could not be
  downloaded in the build sandbox.
- Mood is not evaluated.
- Speed is about 0.2× real time on 4 CPU cores, without Demucs.

## Demo

`demo/build_demo.py` bundles analyses and licensed audio into one page with
playback. It shows a whole-song timeline, a 12-second close-up with beats,
chords and drum hits, live readouts and the accuracy tables. On the synthetic
tracks it also shows the ground truth.

```bash
python eval/synth.py --out /tmp/synth && python eval/prepare_real.py /tmp/dl
python eval/evaluate.py --synth /tmp/synth --real /tmp/dl --out eval/results
python demo/build_demo.py --cache eval/results/cache --synth /tmp/synth --real /tmp/dl \
    --results eval/results/results.json
```

## What's next

1. Run with Demucs on a real machine and re-score the stems. Add vocal entries
   and exits to the timeline.
2. A held-out real test set with beat, key and section annotations. Remington's
   own Ableton projects are ideal, because the session itself is the truth
   (tempo, key, clip arrangement, stems).
3. Learned components where DSP is weakest: a beat/downbeat network (Beat This!
   or madmom), a chord model with 7ths and inversions, and a structure model
   (allin1-style).
4. Wire it into the app. Port the winners into `src-tauri/src/analysis` (or
   ship a sidecar), bump `ANALYSIS_VERSION`, and let the director use beats,
   chords and stem events, not just the global grid.
5. Producer views: a reference-track loudness/energy curve and a Camelot-aware
   "what mixes with this" list.
