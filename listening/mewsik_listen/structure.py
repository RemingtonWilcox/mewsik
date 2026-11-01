"""Section segmentation and labeling, at the bar level.

1. Every bar (downbeat to downbeat) gets a feature vector: timbre (MFCC),
   harmony (chroma), energy, low end, onset density and per-stem activity.
2. Boundaries are bars where the music on either side differs most: a
   two-window contrast plus a Foote checkerboard on the bar self-similarity
   matrix, with a bonus on 4- and 8-bar phrase lines (producers arrange in
   phrases; so should the listener).
3. Segments are clustered into repeat letters (A, B, A', ...) by their mean
   features, so "the same part again" is recognised.
4. Functional labels come from energy, stem presence, repetition and
   position, using two vocabularies: electronic (intro, build, drop,
   breakdown, outro) and song (intro, verse, chorus, bridge, outro). They
   match the visualizer director's section vocabulary.
"""

from __future__ import annotations

import librosa
import numpy as np
import scipy.ndimage as ndi
from scipy.cluster.hierarchy import fcluster, linkage

from .audio import Audio, SR_LO, HOP
from .energy import RATE
from .harmony import chroma_frames


def _bar_features(a: Audio, bars: np.ndarray, en: dict, st: dict) -> tuple[np.ndarray, dict]:
    mf = a.cache.get("mfcc")
    if mf is None:
        mf = librosa.feature.mfcc(y=a.lo, sr=SR_LO, hop_length=HOP, n_mfcc=14)[1:]
        a.cache["mfcc"] = mf
    ch = chroma_frames(a)
    fr = np.r_[a.time_to_frames(bars), ch.shape[1]]
    n = len(bars)

    def agg(M, i):
        lo, hi = fr[i], max(fr[i] + 1, fr[i + 1])
        return M[:, lo:hi].mean(axis=1)

    MF = np.array([agg(mf, i) for i in range(n)])
    CH = np.array([agg(ch, i) for i in range(n)])
    ends = np.r_[bars[1:], a.duration]

    def curve_mean(c, rate=RATE):
        c = np.asarray(c, float)
        return np.array([c[int(s * rate) : max(int(s * rate) + 1, int(e * rate))].mean()
                         for s, e in zip(bars, ends)])

    scal = {
        "energy": curve_mean(en["energy"]),
        "low": curve_mean(en["low_end"]),
        "density": curve_mean(en["onset_density"]),
        "bright": curve_mean(en["brightness_hz"]),
        "tension": curve_mean(en["tension"]),
    }
    for k, v in st["stems"].items():
        if v is not None:
            scal[f"stem_{k}"] = curve_mean(v["activity_db"])

    def z(M):
        M = np.atleast_2d(M)
        return (M - M.mean(0)) / (M.std(0) + 1e-6)

    S = np.c_[
        z(MF) * 1.0,
        z(CH) * 0.7,
        z(np.c_[scal["energy"], scal["low"], scal["density"]]) * 1.6,
        z(np.array([scal[k] for k in scal if k.startswith("stem_")]).T) * 1.2,
    ]
    return S, scal


def _novelty(F: np.ndarray, k: int) -> np.ndarray:
    n = len(F)
    nov = np.zeros(n)
    Fn = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)
    SSM = Fn @ Fn.T
    for b in range(1, n):
        lo, hi = max(0, b - k), min(n, b + k)
        L, R = F[lo:b], F[b:hi]
        if len(L) == 0 or len(R) == 0:
            continue
        contrast = np.linalg.norm(L.mean(0) - R.mean(0)) / np.sqrt(F.shape[1])
        cross = SSM[lo:b, b:hi].mean()
        within = 0.5 * (SSM[lo:b, lo:b].mean() + SSM[b:hi, b:hi].mean())
        nov[b] = contrast + 0.8 * max(0.0, within - cross)
    return nov


def _pick(nov: np.ndarray, n: int, min_gap: int, phase0: int) -> list[int]:
    bonus = np.ones(n)
    idx = np.arange(n) - phase0
    bonus[idx % 4 == 0] = 1.15
    bonus[idx % 8 == 0] = 1.3
    score = nov * bonus
    thr = np.median(score[1:]) + 0.3 * score[1:].std() if n > 2 else np.inf
    chosen = []
    for b in np.argsort(score)[::-1]:
        if b == 0 or score[b] < thr:
            continue
        if all(abs(b - c) >= min_gap for c in chosen) and b >= min_gap // 2 and n - b >= min_gap // 2:
            chosen.append(int(b))
    return sorted(chosen)


def _letters(F: np.ndarray, segs: list[tuple[int, int]]) -> list[str]:
    if len(segs) == 1:
        return ["A"]
    M = np.array([F[s:e].mean(0) for s, e in segs])
    Z = linkage(M, method="average", metric="cosine")
    lab = fcluster(Z, t=0.55, criterion="distance")
    out, seen = [], {}
    for l in lab:
        if l not in seen:
            seen[l] = chr(ord("A") + len(seen))
        out.append(seen[l])
    return out


def analyze(a: Audio, rhythm: dict, en: dict, st: dict) -> dict:
    downs = np.asarray(rhythm["downbeats"], float)
    if len(downs) < 4:
        return {"style": "unknown", "sections": [{"start": 0.0, "end": a.duration, "label": "verse",
                                                  "letter": "A", "energy": 1.0, "bars": 0}]}
    # bar 0 starts at the first downbeat; anything before it is pickup
    bars = downs
    F, scal = _bar_features(a, bars, en, st)
    n = len(bars)
    k = 4 if n >= 24 else 2
    min_gap = 4 if n >= 40 else 2
    bar_dur = float(np.median(np.diff(bars)))
    min_gap = max(min_gap, int(np.ceil(7.0 / max(bar_dur, 0.5))))  # sections last >= ~7 s
    nov = _novelty(F, k)
    cuts = _pick(nov, n, min_gap, 0)
    starts = [0] + cuts
    segs = list(zip(starts, starts[1:] + [n]))
    letters = _letters(F, segs)
    # the same material either side of a cut is one section, not two
    merged_segs, merged_letters = [], []
    for sg, L in zip(segs, letters):
        if merged_letters and merged_letters[-1] == L:
            merged_segs[-1] = (merged_segs[-1][0], sg[1])
        else:
            merged_segs.append(sg)
            merged_letters.append(L)
    segs = merged_segs
    letters = _letters(F, segs) if len(segs) > 1 else ["A"]

    # ---- functional labels ----
    E = scal["energy"]
    drums = scal.get("stem_drums")
    bass = scal.get("stem_bass")
    seg_e = np.array([E[s:e].mean() for s, e in segs])
    seg_t = np.array([scal["tension"][s:e].mean() for s, e in segs])
    seg_slope = np.array([np.polyfit(np.arange(e - s), E[s:e], 1)[0] if e - s > 1 else 0 for s, e in segs])
    d_ref = np.percentile(drums, 90) if drums is not None else 0
    seg_d = np.array([(drums[s:e] > d_ref - 15).mean() if drums is not None else 1 for s, e in segs])
    seg_b = np.array([(bass[s:e] > np.percentile(bass, 90) - 15).mean() if bass is not None else 1
                      for s, e in segs])
    emax = seg_e.max() + 1e-9
    rel = seg_e / emax

    kicks = np.asarray(st.get("drum_hits", {}).get("kick", []))
    beats = np.asarray(rhythm["beats"])
    four_floor = 0.0
    if len(kicks) and len(beats) > 8:
        near = np.min(np.abs(beats[:, None] - kicks[None, :]), axis=1) < 0.05
        four_floor = float(near.mean())
    contrast = float(rel.max() - rel.min()) if len(rel) > 1 else 0.0
    # Electronic arrangement = the drums leave mid-track and come back (a
    # breakdown) in a 4/4 groove at dance tempo. Detected kick patterns are
    # too unreliable on DSP stems to lean on alone.
    inner = range(1, len(segs) - 1)
    has_breakdown = any(seg_d[i] < 0.35 and seg_d[:i].max() > 0.6 and seg_d[i + 1:].max() > 0.6
                        for i in inner)
    electronic = (rhythm["meter"] == 4 and 110 <= rhythm["bpm"] <= 185 and has_breakdown
                  and contrast > 0.3)
    style = "electronic" if electronic else "song"

    labels = [""] * len(segs)
    last = len(segs) - 1
    if electronic:
        for i in range(len(segs)):
            if rel[i] >= 0.8 and seg_d[i] > 0.5 and seg_b[i] > 0.3:
                labels[i] = "drop"
        for i in range(len(segs)):
            if labels[i]:
                continue
            nxt = labels[i + 1] if i < last else ""
            if i == 0:
                labels[i] = "intro"
            elif nxt == "drop" and segs[i][1] - segs[i][0] <= 8 and (
                    seg_slope[i] > 0 or seg_t[i] > np.median(seg_t)) and (
                    seg_d[i] >= 0.3 or seg_t[i] > np.percentile(seg_t, 75)):
                labels[i] = "build"
            elif i == last and rel[i] < 0.8:
                labels[i] = "outro"
            elif rel[i] < 0.6 or seg_d[i] < 0.3:
                labels[i] = "breakdown"
            else:
                labels[i] = "verse"
        if "drop" not in labels:  # no clear drop: louder parts are the hooks
            for i in range(len(segs)):
                if rel[i] >= 0.9 and labels[i] in ("verse", "breakdown"):
                    labels[i] = "drop"
    else:
        # the loudest repeated letter is the chorus; other repeats are verses
        from collections import Counter

        cnt = Counter(letters)
        let_e = {L: np.mean([seg_e[i] for i in range(len(segs)) if letters[i] == L]) for L in cnt}
        repeated = [L for L in cnt if cnt[L] > 1]
        chorus = max(repeated, key=lambda L: let_e[L]) if repeated else max(let_e, key=let_e.get)
        for i in range(len(segs)):
            if i == 0 and (rel[i] < 0.75 or len(segs) > 2) and letters[i] != chorus:
                labels[i] = "intro"
            elif i == last and len(segs) > 2 and rel[i] < 0.85 and letters[i] != chorus:
                labels[i] = "outro"
            elif letters[i] == chorus and rel[i] >= 0.75:
                labels[i] = "chorus"
            elif 0 < i < last and rel[i] < 0.55 and seg_d[i] < 0.4:
                labels[i] = "breakdown"
            elif cnt[letters[i]] == 1 and 0 < i < last and len(segs) > 4:
                labels[i] = "bridge"
            else:
                labels[i] = "verse"
        for i in range(len(segs) - 1):
            if labels[i + 1] == "chorus" and labels[i] == "verse" and seg_slope[i] > 0.01 \
                    and segs[i][1] - segs[i][0] <= 4:
                labels[i] = "build"

    sections = []
    for i, (s, e) in enumerate(segs):
        t0 = 0.0 if i == 0 else float(bars[s])
        t1 = float(bars[e]) if e < n else a.duration
        sections.append({
            "start": round(t0, 3), "end": round(t1, 3), "label": labels[i], "letter": letters[i],
            "bars": int(e - s), "energy": round(float(rel[i]), 3),
            "drums": round(float(seg_d[i]), 2), "bass": round(float(seg_b[i]), 2),
        })

    drops = []
    for i in range(1, len(sections)):
        jump = sections[i]["energy"] - sections[i - 1]["energy"]
        if sections[i]["label"] in ("drop", "chorus") and jump > 0.12:
            drops.append({"t": sections[i]["start"], "strength": round(float(min(1, jump * 2)), 3)})

    return {"style": style, "four_on_floor": round(four_floor, 2), "sections": sections,
            "drops": drops, "novelty": np.round(nov, 3).tolist(),
            "bar_times": np.round(bars, 3).tolist()}
