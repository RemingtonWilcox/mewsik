"""One call: audio file in, listening score out."""

from __future__ import annotations

import os
import time

from . import audio, energy, harmony, rhythm, stems, structure, timeline

SCHEMA_VERSION = 2


def analyze_file(path: str, use_demucs: bool | None = None, log=None) -> dict:
    t_all = time.time()
    timings = {}

    def step(name, fn):
        t = time.time()
        r = fn()
        timings[name] = round(time.time() - t, 2)
        if log:
            log(f"  {name:<10} {timings[name]:6.2f}s")
        return r

    a = step("decode", lambda: audio.load(path))
    rh = step("rhythm", lambda: rhythm.analyze(a))
    import numpy as np

    beats = np.asarray(rh["beats"])
    ch = step("chords", lambda: harmony.chords(a, beats))
    k = step("key", lambda: harmony.key(a, ch))
    mods = step("modulation", lambda: harmony.modulations(a, ch, k))
    en = step("energy", lambda: energy.curves(a, rh, k, ch))
    st = step("stems", lambda: stems.analyze(a, use_demucs))
    sx = step("structure", lambda: structure.analyze(a, rh, en, st))
    hm = {"key": k, "chords": ch, "modulations": mods}
    tl = step("timeline", lambda: timeline.build(a.duration, rh, hm, en, st, sx))

    return {
        "schema": "mewsik.listening",
        "version": SCHEMA_VERSION,
        "file": os.path.basename(path),
        "duration": round(a.duration, 3),
        "rhythm": rh,
        "harmony": hm,
        "energy": en,
        "stems": st,
        "structure": sx,
        "timeline": tl,
        "compat_track_score": to_track_score(a.duration, rh, k, sx, en),
        "timings_s": {**timings, "total": round(time.time() - t_all, 2)},
    }


def to_track_score(duration, rh, k, sx, en) -> dict:
    """Down-convert to the app's existing `TrackScore` (src-tauri/src/analysis,
    src/lib/visualizer/director/score.ts) so the director can perform against
    this engine's output unchanged."""
    beats = rh["beats"]
    offset = (rh["downbeats"] or beats or [0.0])[0]
    return {
        "version": 100 + SCHEMA_VERSION,
        "duration_ms": int(duration * 1000),
        "bpm": rh["bpm"],
        "beat_offset_ms": round(offset * 1000, 1),
        "beat_confidence": rh["confidence"],
        "key": {"pitch_class": k["pitch_class"], "mode": k["mode"], "confidence": k["confidence"]},
        "sections": [{"start_ms": int(s["start"] * 1000), "end_ms": int(s["end"] * 1000),
                      "label": s["label"], "energy": s["energy"]} for s in sx["sections"]],
        "drops": [{"at_ms": int(d["t"] * 1000), "strength": d["strength"]} for d in sx.get("drops", [])],
        "energy_hz": en["rate_hz"],
        "energy_curve": en["energy"],
    }
