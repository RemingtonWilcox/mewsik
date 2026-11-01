"""Energy, loudness and mood curves at a common 2 Hz rate.

Loudness is EBU R128 (essentia): integrated LUFS, loudness range, and the
momentary (400 ms) and short-term (3 s) curves a mastering engineer reads.
"Energy" is the perceptual intensity a dancer feels, which is not just
loudness: it mixes short-term loudness with onset density, low-end weight
and brightness. Mood is a valence/arousal estimate. That is a heuristic on
mode, chord quality, brightness, tempo and energy, not a trained model, and
the output says so.
"""

from __future__ import annotations

import librosa
import numpy as np
import scipy.ndimage as ndi

from .audio import Audio, SR, SR_LO, HOP

RATE = 2.0  # curve samples per second


def _resample_curve(v: np.ndarray, src_rate: float, n: int) -> np.ndarray:
    t_src = np.arange(len(v)) / src_rate
    t = np.arange(n) / RATE
    return np.interp(t, t_src, v) if len(v) else np.zeros(n)


def _norm01(v, lo_pct=5, hi_pct=98):
    lo, hi = np.percentile(v, lo_pct), np.percentile(v, hi_pct)
    return np.clip((v - lo) / (hi - lo + 1e-9), 0, 1)


def loudness(a: Audio) -> dict:
    n = int(np.ceil(a.duration * RATE))
    try:
        import essentia.standard as es

        mom, short, integ, lra = es.LoudnessEBUR128(sampleRate=SR, hopSize=0.1)(a.stereo.T.copy())
        mom = _resample_curve(np.asarray(mom), 10.0, n)
        short = _resample_curve(np.asarray(short), 10.0, n)
        return {"integrated_lufs": round(float(integ), 2), "lra": round(float(lra), 2),
                "momentary": mom, "short_term": short}
    except Exception:  # pragma: no cover - fallback: RMS dBFS
        rms = librosa.feature.rms(y=a.lo, hop_length=HOP)[0]
        db = 20 * np.log10(rms + 1e-6) - 3
        c = _resample_curve(db, a.fps, n)
        return {"integrated_lufs": round(float(np.median(c)), 2), "lra": None,
                "momentary": c, "short_term": ndi.uniform_filter1d(c, 6)}


def curves(a: Audio, rhythm: dict, key: dict, chord_list: list[dict]) -> dict:
    n = int(np.ceil(a.duration * RATE))
    L = loudness(a)
    short = np.maximum(L["short_term"], -70)

    S = a.cache.get("stft")
    if S is None:
        S = librosa.stft(a.lo, n_fft=2048, hop_length=HOP)
    mag = np.abs(S)
    freqs = librosa.fft_frequencies(sr=SR_LO, n_fft=2048)
    cent = librosa.feature.spectral_centroid(S=mag, sr=SR_LO)[0]
    low = (mag[freqs < 150] ** 2).sum(axis=0)
    tot = (mag ** 2).sum(axis=0) + 1e-9
    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(mag), sr=SR_LO)
    peaks = librosa.util.peak_pick(onset, pre_max=3, post_max=3, pre_avg=10, post_avg=10,
                                   delta=0.4 * onset.std(), wait=3)
    density = np.zeros(len(onset))
    density[peaks] = 1
    density = ndi.uniform_filter1d(density, size=int(a.fps * 2)) * a.fps  # onsets / s

    bright = _resample_curve(ndi.uniform_filter1d(cent, int(a.fps)), a.fps, n)
    lowr = _resample_curve(ndi.uniform_filter1d(low / tot, int(a.fps)), a.fps, n)
    dens = _resample_curve(density, a.fps, n)

    loud01 = _norm01(short)
    energy = 0.55 * loud01 + 0.2 * _norm01(dens) + 0.15 * _norm01(lowr) + 0.1 * _norm01(bright)
    energy = ndi.uniform_filter1d(energy, 3)
    energy = energy / (energy.max() + 1e-9)

    # Tension: energy rising + brightness rising (risers, filter sweeps,
    # snare rolls all push both up before a release).
    d_e = np.gradient(ndi.uniform_filter1d(energy, 8))
    d_b = np.gradient(ndi.uniform_filter1d(_norm01(bright), 8))
    d_d = np.gradient(ndi.uniform_filter1d(_norm01(dens), 8))
    tension = np.clip(ndi.uniform_filter1d(2.0 * d_e + 1.5 * d_b + 1.0 * d_d, 6) * 8, 0, 1)

    # Mood. Valence: major-ness of the local chords + brightness; arousal:
    # energy + tempo. Both 0..1.
    major_t = np.zeros(n)
    for c in chord_list:
        if c["label"] == "N":
            continue
        i0, i1 = int(c["start"] * RATE), int(np.ceil(c["end"] * RATE))
        major_t[i0:i1] = 1.0 if c["label"].endswith("maj") else -1.0
    major_t = ndi.uniform_filter1d(major_t, int(RATE * 8))
    mode_bias = 0.15 if key["mode"] == "major" else -0.15
    valence = np.clip(0.5 + 0.3 * major_t + mode_bias + 0.2 * (_norm01(bright) - 0.5), 0, 1)
    tempo_f = np.clip((rhythm["bpm"] - 60) / 120, 0, 1)
    arousal = np.clip(0.65 * energy + 0.2 * tempo_f + 0.15 * _norm01(dens), 0, 1)

    def r(v, d=3):
        return np.round(v, d).tolist()

    return {
        "rate_hz": RATE,
        "integrated_lufs": L["integrated_lufs"],
        "loudness_range_lu": L["lra"],
        "loudness_short_term": r(short, 1),
        "loudness_momentary": r(np.maximum(L["momentary"], -70), 1),
        "energy": r(energy),
        "tension": r(tension),
        "brightness_hz": r(bright, 0),
        "low_end": r(_norm01(lowr)),
        "onset_density": r(dens, 2),
        "valence": r(valence),
        "arousal": r(arousal),
    }


def mood_label(valence: float, arousal: float) -> str:
    if arousal >= 0.55:
        return "euphoric" if valence >= 0.5 else "tense"
    return "warm / relaxed" if valence >= 0.5 else "melancholic"
