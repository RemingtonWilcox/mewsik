"""Beats, tempo (and its curve), meter, and downbeats.

Beats come from essentia's multi-feature beat tracker (Zapata et al. 2014),
which runs five onset detectors and keeps the beat sequence they agree on
most. librosa's dynamic-programming tracker is the fallback.

Downbeats are our own: for each candidate meter (3 or 4) and phase, score
how well the would-be bar lines line up with the things that happen on bar
lines in practice: chord changes, bass/kick accents, energy steps; and how
well the backbeat (snare-band hits) lands between them. The meter itself is
chosen by bar-level self-similarity: music repeats at bar multiples.
"""

from __future__ import annotations

import numpy as np
import librosa
import scipy.ndimage as ndi

from .audio import Audio, SR, SR_LO, HOP, hpss


def _essentia_beats(a: Audio):
    try:
        import essentia

        essentia.log.infoActive = False
        import essentia.standard as es
    except Exception:  # pragma: no cover - optional dep
        return None
    bpm, beats, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(a.mono)
    return float(bpm), np.asarray(beats, dtype=float), float(conf)


def _librosa_beats(a: Audio):
    tempo, frames = librosa.beat.beat_track(y=a.lo, sr=SR_LO, hop_length=HOP)
    return float(np.atleast_1d(tempo)[0]), a.frames_to_time(frames), 1.5


def band_onsets(a: Audio):
    """Onset envelopes for three drum-ish bands of the percussive signal."""
    if "band_onsets" in a.cache:
        return a.cache["band_onsets"]
    S = a.cache.get("stft")
    if S is None:
        hpss(a)
        S = a.cache["stft"]
    _, P = a.cache["hpss"]
    freqs = librosa.fft_frequencies(sr=SR_LO, n_fft=2048)
    mag = np.log1p(10 * np.abs(P))
    full = np.log1p(10 * np.abs(S))

    def flux(m, lo, hi):
        sel = (freqs >= lo) & (freqs < hi)
        d = np.diff(m[sel], axis=1, prepend=m[sel][:, :1])
        return np.maximum(d, 0).mean(axis=0)

    out = {
        "low": flux(full, 30, 150),  # kick + bass attacks
        "mid": flux(mag, 1000, 5000),  # snare / clap body
        "high": flux(mag, 7000, 11000),  # hats / cymbals
        "all": librosa.onset.onset_strength(y=a.lo, sr=SR_LO, hop_length=HOP),
    }
    a.cache["band_onsets"] = out
    return out


def _beat_sync_peak(env: np.ndarray, a: Audio, beats: np.ndarray, win=0.06) -> np.ndarray:
    fr = a.time_to_frames(beats)
    w = max(1, int(round(win * a.fps)))
    out = np.zeros(len(beats))
    for i, f in enumerate(fr):
        lo, hi = max(0, f - w), min(len(env), f + w + 1)
        out[i] = env[lo:hi].max() if hi > lo else 0.0
    return out


def _z(v):
    v = np.asarray(v, float)
    s = v.std()
    return (v - v.mean()) / s if s > 1e-9 else v * 0


def beat_chroma(a: Audio, beats: np.ndarray) -> np.ndarray:
    """Harmonic chroma averaged between consecutive beats: (n_beats, 12)."""
    from .harmony import chroma_frames

    C = chroma_frames(a)
    fr = np.r_[a.time_to_frames(beats), C.shape[1]]
    out = np.zeros((len(beats), 12))
    for i in range(len(beats)):
        lo, hi = fr[i], max(fr[i] + 1, fr[i + 1])
        out[i] = C[:, lo:hi].mean(axis=1)
    return out


def _meter_and_phase(a: Audio, beats: np.ndarray):
    n = len(beats)
    if n < 16:
        return 4, 0, {"meter_margin": 0.0, "phase_margin": 0.0}
    ons = band_onsets(a)
    low = _beat_sync_peak(ons["low"], a, beats)
    mid = _beat_sync_peak(ons["mid"], a, beats)
    rms = librosa.feature.rms(y=a.lo, hop_length=HOP)[0]
    fr = np.r_[a.time_to_frames(beats), len(rms)]
    loud = np.array([rms[fr[i] : max(fr[i] + 1, fr[i + 1])].mean() for i in range(n)])
    loud_step = np.r_[0, np.maximum(np.diff(np.log(loud + 1e-6)), 0)]

    ch = beat_chroma(a, beats)
    chn = ch / (np.linalg.norm(ch, axis=1, keepdims=True) + 1e-9)
    hchange = np.r_[0, 1 - (chn[1:] * chn[:-1]).sum(axis=1)]

    # --- meter: bar-level repetition (beat-sync chroma + onset pattern) ---
    feat = np.c_[chn, _z(low)[:, None] * 0.3, _z(mid)[:, None] * 0.3]
    feat = feat / (np.linalg.norm(feat, axis=1, keepdims=True) + 1e-9)

    def lag_sim(L):
        if L >= n:
            return 0.0
        return float((feat[L:] * feat[:-L]).sum(axis=1).mean())

    c3 = np.mean([lag_sim(L) for L in (3, 6, 9)])
    c4 = np.mean([lag_sim(L) for L in (4, 8, 16)])

    def phase_scores(m):
        scores = []
        for p in range(m):
            on = ((np.arange(n) - p) % m) == 0
            s = 1.2 * (hchange[on].mean() - hchange[~on].mean()) / (hchange.std() + 1e-9)
            s += 0.8 * (low[on].mean() - low[~on].mean()) / (low.std() + 1e-9)
            s += 0.6 * (loud_step[on].mean() - loud_step[~on].mean()) / (loud_step.std() + 1e-9)
            if m == 4:  # backbeat on 2 and 4
                back = ((np.arange(n) - p) % 2) == 1
                s += 0.7 * (mid[back].mean() - mid[~back].mean()) / (mid.std() + 1e-9)
            elif m == 3:
                pass
            scores.append(s)
        return np.array(scores)

    s3, s4 = phase_scores(3), phase_scores(4)
    # 3/4 must clearly win on repetition *and* have a coherent bar phase
    meter_margin = float(c3 - c4)
    meter = 3 if (meter_margin > 0.02 and s3.max() > 0.5) else 4
    s = s3 if meter == 3 else s4
    order = np.argsort(s)[::-1]
    phase = int(order[0])
    return meter, phase, {
        "meter_margin": round(meter_margin, 4),
        "phase_margin": round(float(s[order[0]] - s[order[1]]), 3),
        "rep3": round(float(c3), 4),
        "rep4": round(float(c4), 4),
    }


def _fold_octave(bpm: float, beats: np.ndarray, conf: float, a: Audio):
    """Fix the classic half/double tempo error by where the drums land.

    Doubling: if the kick band or the snare band hits mostly *between* the
    tracked beats, the tracker has locked onto every other beat (typical for
    drum & bass at 174 read as 87, with the grid sitting on the snares).
    Halving: if every other tracked beat is nearly empty in every band, the
    grid is counting a slow groove twice too fast (a ballad at 76 read as 152).
    """
    if len(beats) < 16:
        return bpm, beats, None
    ons = band_onsets(a)
    mids = (beats[1:] + beats[:-1]) / 2
    ratios = {}
    for band in ("low", "mid"):
        on_b = _beat_sync_peak(ons[band], a, beats[:-1]).mean()
        on_m = _beat_sync_peak(ons[band], a, mids).mean()
        ratios[band] = float(on_m / (on_b + 1e-9))
    band = max(ratios, key=ratios.get)
    if ratios[band] > 1.4 and bpm * 2 <= 200:
        return bpm * 2, np.sort(np.r_[beats, mids]), (
            f"doubled from {bpm:.1f}: {band} band lands between tracked beats ({ratios[band]:.2f}x)")
    allb = _beat_sync_peak(ons["all"], a, beats)
    n2 = (len(allb) // 2) * 2
    even, odd = allb[:n2:2].mean(), allb[1:n2:2].mean()
    if bpm > 110 and min(even, odd) < 0.45 * max(even, odd):
        keep = beats[0::2] if even >= odd else beats[1::2]
        return bpm / 2, keep, (
            f"halved from {bpm:.1f}: alternate beats are empty ({min(even, odd) / max(even, odd):.2f})")
    return bpm, beats, None


def analyze(a: Audio) -> dict:
    res = _essentia_beats(a)
    source = "essentia-multifeature"
    if res is None or len(res[1]) < 4:
        res = _librosa_beats(a)
        source = "librosa-dp"
    bpm, beats, conf = res
    bpm, beats, octave_note = _fold_octave(bpm, beats, conf, a)

    ibi = np.diff(beats)
    if len(ibi) >= 3:
        local = 60.0 / np.clip(ibi, 0.2, 2.0)
        local = ndi.median_filter(local, size=9, mode="nearest")
        bpm_med = float(np.median(local))
        stability = float(1 - np.clip(np.std(local) / bpm_med / 0.05, 0, 1))
    else:
        local, bpm_med, stability = np.array([bpm]), bpm, 0.0
    tempo_curve = [
        {"t": round(float(beats[i]), 3), "bpm": round(float(local[i]), 2)}
        for i in range(0, len(local), max(1, len(local) // 200))
    ]

    meter, phase, diag = _meter_and_phase(a, beats)
    idx = np.arange(len(beats))
    is_down = ((idx - phase) % meter) == 0
    downbeats = beats[is_down]
    beat_pos = ((idx - phase) % meter) + 1  # 1..meter

    # Essentia's confidence lives in 0..5.32; >3.5 is "excellent".
    conf01 = float(np.clip(conf / 5.32, 0, 1)) if source.startswith("essentia") else 0.3

    return {
        "source": source,
        "bpm": round(bpm_med, 2),
        "bpm_reported": round(bpm, 2),
        "bpm_alternatives": [round(bpm_med / 2, 2), round(bpm_med * 2, 2)],
        "octave_note": octave_note,
        "confidence": round(conf01, 3),
        "stability": round(stability, 3),
        "meter": int(meter),
        "beats": np.round(beats, 4).tolist(),
        "beat_positions": beat_pos.astype(int).tolist(),
        "downbeats": np.round(downbeats, 4).tolist(),
        "tempo_curve": tempo_curve,
        "diagnostics": diag,
    }
