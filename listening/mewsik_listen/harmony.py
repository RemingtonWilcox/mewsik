"""Chroma, chords, key and modulations.

Chroma is a constant-Q transform of the harmonic (HPSS) signal, split into a
treble chroma (above ~130 Hz) and a bass chroma (below), tuned to the track's
own reference pitch. Chords are 24 major/minor triads plus "no chord",
decoded at the beat level with an HMM (Viterbi) so they don't flicker. The
key is a vote between pitch-class profile correlation (Temperley and EDMA
profiles: the latter fits electronic music) and how well the decoded chords
fit each key's diatonic set, which is what a musician actually listens for.
"""

from __future__ import annotations

import librosa
import numpy as np

from .audio import Audio, SR_LO, HOP, hpss

PCS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = {"C#": "Db", "D#": "Eb", "F#": "F#", "G#": "Ab", "A#": "Bb"}

# Temperley (2007) and Faraldo's EDMA profiles (Faraldo et al. 2016).
TEMPERLEY = {
    "major": [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    "minor": [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
}
EDMA = {
    "major": [0.16519551, 0.04749026, 0.08293076, 0.06687112, 0.09994645, 0.09274123,
              0.05294487, 0.13159476, 0.05218986, 0.07443653, 0.06940723, 0.06425141],
    "minor": [0.17235348, 0.04, 0.0761009, 0.12001437, 0.05392973, 0.09199386,
              0.05743086, 0.13841352, 0.07740229, 0.05341535, 0.08782333, 0.05393474],
}

# Camelot wheel (DJ notation) keyed by (pitch class, mode).
_CAMELOT_MAJ = {11: "1B", 6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B",
                5: "7B", 0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B"}
_CAMELOT_MIN = {8: "1A", 3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A",
                2: "7A", 9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A"}


def camelot(pc: int, mode: str) -> str:
    return (_CAMELOT_MAJ if mode == "major" else _CAMELOT_MIN)[pc]


def key_name(pc: int, mode: str) -> str:
    n = PCS[pc]
    if mode == "major" and n in FLATS:
        n = FLATS[n]
    if mode == "minor" and n in ("D#", "A#"):
        n = FLATS[n]
    return f"{n} {mode}"


def _harmonic_signal(a: Audio) -> np.ndarray:
    if "y_harm" not in a.cache:
        H, _ = hpss(a)
        a.cache["y_harm"] = librosa.istft(H, hop_length=HOP, length=len(a.lo))
    return a.cache["y_harm"]


def _cqt(a: Audio):
    if "cqt" not in a.cache:
        y = _harmonic_signal(a)
        tuning = float(librosa.estimate_tuning(y=y, sr=SR_LO))
        C = np.abs(
            librosa.cqt(y, sr=SR_LO, hop_length=HOP, fmin=librosa.note_to_hz("C1"),
                        n_bins=36 * 7, bins_per_octave=36, tuning=tuning)
        )
        a.cache["cqt"] = (C, tuning)
    return a.cache["cqt"]


def _fold(C: np.ndarray) -> np.ndarray:
    """Fold 36-bins-per-octave CQT (starting at C) into 12 pitch classes."""
    L = np.log1p(100 * C)
    n_oct = L.shape[0] // 36
    L = L[: n_oct * 36].reshape(n_oct, 12, 3, -1)
    # centre bin weighted double: robust to slight mistuning
    return (L[:, :, 0] + 2 * L[:, :, 1] + L[:, :, 2]).sum(axis=0)


def chroma_frames(a: Audio) -> np.ndarray:
    """Treble chroma (12, frames), per-frame max-normalised."""
    if "chroma" not in a.cache:
        C, _ = _cqt(a)
        tre = _fold(C[36 * 2 :])  # C3 and up (~130 Hz)
        bass = _fold(C[: 36 * 2 + 18])  # C1..F#3
        a.cache["chroma"] = tre / (tre.max(axis=0, keepdims=True) + 1e-9)
        a.cache["bass_chroma"] = bass / (bass.max(axis=0, keepdims=True) + 1e-9)
        a.cache["chroma_energy"] = tre.sum(axis=0)
    return a.cache["chroma"]


def _sync(M: np.ndarray, a: Audio, beats: np.ndarray, agg=np.mean) -> np.ndarray:
    fr = np.r_[0, a.time_to_frames(beats), M.shape[-1]]
    fr = np.unique(np.clip(fr, 0, M.shape[-1]))
    return librosa.util.sync(M, fr, aggregate=agg), fr


def _templates():
    T, labels = [], []
    for q, iv in (("maj", (0, 4, 7)), ("min", (0, 3, 7))):
        for r in range(12):
            t = np.zeros(12)
            for k, w in zip(iv, (1.0, 0.85, 0.8)):
                t[(r + k) % 12] = w
            T.append(t)
            labels.append(f"{PCS[r]}:{q}")
    return np.array(T), labels


def chords(a: Audio, beats: np.ndarray) -> list[dict]:
    chroma = chroma_frames(a)
    bass = a.cache["bass_chroma"]
    energy = a.cache["chroma_energy"]
    # half-beat frames: chords can change on the "and" in some styles
    if len(beats) >= 2:
        mids = (beats[1:] + beats[:-1]) / 2
        grid = np.sort(np.r_[beats, mids])
    else:
        grid = beats
    Cs, fr = _sync(chroma, a, grid)
    Bs, _ = _sync(bass, a, grid)
    Es, _ = _sync(energy[None], a, grid)
    times = a.frames_to_time(fr)

    T, labels = _templates()
    Cn = Cs - Cs.mean(axis=0, keepdims=True)
    Cn /= np.linalg.norm(Cn, axis=0, keepdims=True) + 1e-9
    Tn = T - T.mean(axis=1, keepdims=True)
    Tn /= np.linalg.norm(Tn, axis=1, keepdims=True)
    sim = Tn @ Cn  # (24, n) correlation in -1..1
    # bass: reward the root being the loudest bass pitch class
    root_idx = np.r_[np.arange(12), np.arange(12)]
    sim += 0.25 * Bs[root_idx] ** 2

    e = Es[0] / (np.percentile(Es[0], 95) + 1e-9)
    no_chord = 0.15 + 0.6 * (e < 0.08)  # silence / near-silence
    flat = 1 - (Cs.max(axis=0) - Cs.mean(axis=0))  # spectrally flat -> no chord
    no_chord = no_chord + 0.4 * (flat > 0.75)
    S = np.vstack([sim, no_chord[None]])
    P = np.exp(S * 8.0)
    P /= P.sum(axis=0, keepdims=True)

    n_states = 25
    trans = librosa.sequence.transition_loop(n_states, 0.88)
    path = librosa.sequence.viterbi(P, trans)

    out = []
    names = labels + ["N"]
    for i, s in enumerate(path):
        start, end = float(times[i]), float(times[i + 1]) if i + 1 < len(times) else a.duration
        conf = float(P[s, i])
        if out and out[-1]["label"] == names[s]:
            out[-1]["end"] = end
            out[-1]["_c"].append(conf)
        else:
            out.append({"start": start, "end": end, "label": names[s], "_c": [conf]})
    for c in out:
        c["confidence"] = round(float(np.mean(c.pop("_c"))), 3)
        c["start"], c["end"] = round(c["start"], 3), round(c["end"], 3)
        c["name"] = pretty_chord(c["label"])
    return out


def pretty_chord(label: str) -> str:
    if label == "N":
        return "N.C."
    r, q = label.split(":")
    r = FLATS.get(r, r) if r != "F#" else r
    return r + ("m" if q == "min" else "")


def _profile_scores(chroma12: np.ndarray, profiles: dict) -> np.ndarray:
    """Pearson correlation of a 12-d chroma with 24 rotated profiles."""
    out = np.zeros(24)
    x = chroma12 - chroma12.mean()
    for mi, mode in enumerate(("major", "minor")):
        p = np.asarray(profiles[mode], float)
        for r in range(12):
            y = np.roll(p, r) - p.mean()
            out[mi * 12 + r] = float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-9))
    return out


def _chord_fit(chord_list: list[dict], t0=0.0, t1=np.inf) -> np.ndarray:
    """How well chord durations fit each of the 24 keys (0..1)."""
    out = np.zeros(24)
    total = 0.0
    for c in chord_list:
        if c["label"] == "N":
            continue
        d = min(c["end"], t1) - max(c["start"], t0)
        if d <= 0:
            continue
        total += d
        r, q = c["label"].split(":")
        r = PCS.index(r)
        for mi, mode in enumerate(("major", "minor")):
            for t in range(12):
                deg = (r - t) % 12
                if mode == "major":
                    w = {0: (1.6, "maj"), 5: (1.0, "maj"), 7: (1.3, "maj"),
                         2: (0.8, "min"), 4: (0.6, "min"), 9: (1.0, "min")}.get(deg)
                else:
                    w = {0: (1.6, "min"), 5: (1.0, "min"), 7: (1.1, None),
                         3: (1.0, "maj"), 8: (1.0, "maj"), 10: (0.9, "maj")}.get(deg)
                if w and (w[1] is None or w[1] == q):
                    out[mi * 12 + t] += w[0] * d
    return out / (total * 1.6 + 1e-9)


def _relative(i: int) -> int:
    return (i % 12 + 9) % 12 + 12 if i < 12 else (i % 12 + 3) % 12


def _dominant_of(i: int) -> int:
    """The key a fifth below: if i is really V of something, that something."""
    return ((i % 12) + 5) % 12 + (12 if i >= 12 else 0)


def _tonic_evidence(chord_list: list[dict], bass: np.ndarray, w: np.ndarray) -> np.ndarray:
    """0..1 per key: how much its tonic triad behaves like home."""
    dur = np.zeros(24)
    first = np.zeros(24)
    real = [c for c in chord_list if c["label"] != "N"]
    for c in real:
        r, q = c["label"].split(":")
        dur[PCS.index(r) + (12 if q == "min" else 0)] += c["end"] - c["start"]
    if real:
        for c in (real[0], real[-1]):
            r, q = c["label"].split(":")
            first[PCS.index(r) + (12 if q == "min" else 0)] += 0.5
    dur /= dur.max() + 1e-9
    bh = (bass * w).sum(axis=1)
    bh /= bh.max() + 1e-9
    bh24 = np.r_[bh, bh]
    return 0.5 * dur + 0.3 * first + 0.2 * bh24


def key(a: Audio, chord_list: list[dict]) -> dict:
    chroma = chroma_frames(a)
    bass = a.cache["bass_chroma"]
    e = a.cache["chroma_energy"]
    w = e / (e.max() + 1e-9)
    glob = (chroma * w).sum(axis=1) + 0.5 * (bass * w).sum(axis=1)
    glob /= glob.max() + 1e-9
    prof = 0.5 * _profile_scores(glob, TEMPERLEY) + 0.5 * _profile_scores(glob, EDMA)
    fit = _chord_fit(chord_list)
    score = 0.55 * prof + 0.45 * fit
    order = np.argsort(score)[::-1]
    best = int(order[0])
    # Profiles and diatonic fit can't tell relative keys apart (F minor and
    # Ab major share every note), and often confuse a key with its dominant.
    # A listener resolves that by asking which chord feels like home: the one
    # that lasts longest, starts phrases, and ends the piece. Among the close
    # candidates, pick the key whose tonic triad has the most of that.
    home = _tonic_evidence(chord_list, bass, w)
    fam = [best, _relative(best), _dominant_of(best)]
    if best < 12:  # V of a minor key is major (harmonic minor)
        fam.append((best + 5) % 12 + 12)
    cands = [i for i in fam if score[best] - score[i] < 0.25]
    final = score + 1.2 * home
    best = max(cands, key=lambda i: final[i])
    second = max((i for i in range(24) if i != best), key=lambda i: final[i])

    def desc(i):
        mode = "major" if i < 12 else "minor"
        pc = i % 12
        return {"tonic": PCS[pc], "pitch_class": pc, "mode": mode, "name": key_name(pc, mode),
                "camelot": camelot(pc, mode), "score": round(float(score[i]), 3)}

    k = desc(best)
    k["confidence"] = round(float(np.clip((final[best] - final[second]) * 2, 0, 1)), 3)
    k["runner_up"] = desc(second)
    k["essentia"] = _essentia_key(a)
    return k


def _essentia_key(a: Audio):
    try:
        import essentia.standard as es

        k, s, strength = es.KeyExtractor(profileType="edma")(a.mono)[:3]
        return {"tonic": k, "mode": s, "strength": round(float(strength), 3)}
    except Exception:  # pragma: no cover
        return None


def modulations(a: Audio, chord_list: list[dict], global_key: dict, window=24.0, hop=4.0):
    """Local key track; returns segments where the local key holds."""
    chroma = chroma_frames(a)
    bass = a.cache["bass_chroma"]
    t = a.frames_to_time(np.arange(chroma.shape[1]))
    starts = np.arange(0, max(a.duration - window / 2, 1), hop)
    S = []
    for s in starts:
        m = (t >= s - window / 2) & (t < s + window / 2)
        if m.sum() < 5:
            S.append(np.zeros(24))
            continue
        g = chroma[:, m].sum(axis=1) + 0.5 * bass[:, m].sum(axis=1)
        g /= g.max() + 1e-9
        prof = 0.5 * _profile_scores(g, TEMPERLEY) + 0.5 * _profile_scores(g, EDMA)
        S.append(0.55 * prof + 0.45 * _chord_fit(chord_list, s - window / 2, s + window / 2))
    S = np.array(S).T  # (24, n)
    P = np.exp(S * 12)
    P /= P.sum(axis=0, keepdims=True)
    gk = global_key["pitch_class"] + (12 if global_key["mode"] == "minor" else 0)
    prior = np.full(24, 0.5 / 23)
    prior[gk] = 0.5
    path = librosa.sequence.viterbi(P, librosa.sequence.transition_loop(24, 0.97), p_init=prior)
    segs = []
    for i, k in enumerate(path):
        t0 = 0.0 if i == 0 else float(starts[i])
        if segs and segs[-1]["_k"] == k:
            continue
        if segs:
            segs[-1]["end"] = t0
        mode = "major" if k < 12 else "minor"
        segs.append({"_k": int(k), "start": round(t0, 2), "end": a.duration,
                     "key": key_name(int(k) % 12, mode), "camelot": camelot(int(k) % 12, mode)})
    # drop flickers shorter than 12 s
    segs = [s for s in segs if s["end"] - s["start"] >= 12] or segs[:1]
    merged = []
    for s in segs:
        s.pop("_k", None)
        if merged and merged[-1]["key"] == s["key"]:
            continue
        merged.append(s)
    for i, s in enumerate(merged):
        s["end"] = round(float(merged[i + 1]["start"]) if i + 1 < len(merged) else a.duration, 2)
    if merged:
        merged[0]["start"] = 0.0
    return merged
