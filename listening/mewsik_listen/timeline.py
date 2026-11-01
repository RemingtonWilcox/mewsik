"""The narrative layer: "what's happening in this song", as timed events
and one plain-language line per section."""

from __future__ import annotations

import numpy as np

from .energy import RATE, mood_label


def fmt_t(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:04.1f}"


_STEM_NAMES = {"drums": "drums", "bass": "bass", "other": "instruments", "vocals": "vocals"}


def _stems_in(st: dict, t0: float, t1: float) -> list[str]:
    out = []
    for k, v in st["stems"].items():
        if not v:
            continue
        cover = sum(max(0, min(e, t1) - max(s, t0)) for s, e in v["present"])
        if cover / max(t1 - t0, 1e-6) > 0.5:
            out.append(_STEM_NAMES[k])
    return out


def build(duration: float, rhythm: dict, harmony: dict, en: dict, st: dict, sx: dict) -> dict:
    ev = []

    def add(t, kind, text, strength=0.5):
        ev.append({"t": round(float(t), 2), "kind": kind, "text": text,
                   "strength": round(float(strength), 2)})

    secs = sx["sections"]
    E = np.asarray(en["energy"])
    for i, s in enumerate(secs):
        if i == 0:
            continue
        prev = secs[i - 1]
        d = s["energy"] - prev["energy"]
        verb = "lifts" if d > 0.1 else ("drops back" if d < -0.1 else "moves on")
        add(s["start"], "section", f"{s['label'].title()} ({s['letter']}) — energy {verb}",
            min(1, 0.4 + abs(d)))
    for d in sx.get("drops", []):
        add(d["t"], "drop", "The drop hits", d["strength"])

    # stems entering / leaving
    for k, v in st["stems"].items():
        if not v:
            continue
        name = _STEM_NAMES[k]
        for s, e in v["present"]:
            if s > 1.0:
                add(s, "stem", f"{name.capitalize()} come in" if name.endswith("s") else
                    f"{name.capitalize()} comes in", 0.5)
            if e < duration - 2.0:
                add(e, "stem", f"{name.capitalize()} drop out", 0.5)

    # key changes
    for m in harmony.get("modulations", [])[1:]:
        add(m["start"], "key", f"Key moves to {m['key']} ({m['camelot']})", 0.7)

    # tempo moves
    tc = rhythm["tempo_curve"]
    if len(tc) > 8:
        bpms = np.array([p["bpm"] for p in tc])
        base = rhythm["bpm"]
        far = np.abs(bpms - base) / base > 0.04
        prev = False
        for p, f in zip(tc, far):
            if f and not prev:
                add(p["t"], "tempo", f"Tempo drifts to {p['bpm']:.0f} BPM", 0.4)
            prev = f

    # builds: sustained tension peaks
    T = np.asarray(en["tension"])
    if len(T) > 8:
        hot = T > max(0.35, np.percentile(T, 92))
        i = 0
        while i < len(hot):
            if hot[i]:
                j = i
                while j < len(hot) and hot[j]:
                    j += 1
                if (j - i) / RATE >= 2.0:
                    add(i / RATE, "tension", "Tension builds (rising energy and brightness)",
                        float(T[i:j].max()))
                i = j
            else:
                i += 1

    if len(E):
        pk = int(np.argmax(E))
        add(pk / RATE, "peak", "Peak energy", 1.0)

    ev.sort(key=lambda e: e["t"])
    # collapse duplicate kinds within 1.5 s
    out = []
    for e in ev:
        if out and e["kind"] == out[-1]["kind"] and e["t"] - out[-1]["t"] < 1.5:
            continue
        out.append(e)

    # per-section narration
    chords = harmony["chords"]
    V, A = np.asarray(en["valence"]), np.asarray(en["arousal"])
    L = np.asarray(en["loudness_short_term"])
    lines = []
    for s in secs:
        i0, i1 = int(s["start"] * RATE), max(int(s["start"] * RATE) + 1, int(s["end"] * RATE))
        cs = [c for c in chords if c["end"] > s["start"] and c["start"] < s["end"] and c["label"] != "N"]
        seq = []
        for c in cs:
            if not seq or seq[-1] != c["name"]:
                seq.append(c["name"])
        prog = " – ".join(seq[:6]) + (" …" if len(seq) > 6 else "")
        playing = _stems_in(st, s["start"], s["end"])
        mood = mood_label(float(V[i0:i1].mean()), float(A[i0:i1].mean())) if i1 <= len(V) else ""
        lufs = float(np.median(L[i0:i1])) if i1 <= len(L) else float("nan")
        lines.append({
            "start": s["start"], "end": s["end"], "label": s["label"], "letter": s["letter"],
            "text": (f"{fmt_t(s['start'])}–{fmt_t(s['end'])} {s['label'].title()} ({s['letter']}, "
                     f"{s['bars']} bars): " + (", ".join(playing) if playing else "sparse")
                     + (f"; chords {prog}" if prog else "")
                     + f"; {mood}; {lufs:.0f} LUFS"),
        })
    return {"events": out, "narration": lines}
