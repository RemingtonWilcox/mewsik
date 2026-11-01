"""Stem-aware listening: what is playing, when.

Preferred: Demucs v4 (htdemucs), the four-stem separator (drums, bass, other,
vocals). It needs its weights (~80 MB, fetched once from
dl.fbaipublicfiles.com into the torch hub cache). If they are not available
we fall back to a DSP split that is honest about what it can do: HPSS
percussive -> drums, harmonic below ~170 Hz -> bass, harmonic above -> other,
and no vocal stem.

From each stem we derive an activity curve (dB, 2 Hz), presence segments
(with hysteresis so a stem doesn't blink), and from the drum stem the
kick/snare/hat hit times.
"""

from __future__ import annotations

import os

import librosa
import numpy as np
import scipy.ndimage as ndi

from .audio import Audio, SR, SR_LO, HOP, hpss
from .energy import RATE

STEMS = ("drums", "bass", "other", "vocals")


def demucs_available() -> bool:
    if os.environ.get("MEWSIK_NO_DEMUCS"):
        return False
    try:
        import torch  # noqa: F401
        import demucs  # noqa: F401
    except Exception:
        return False
    if os.environ.get("MEWSIK_DEMUCS"):
        return True  # caller allows a download
    import torch

    ck = os.path.join(torch.hub.get_dir(), "checkpoints", "955717e8-8726c21a.th")
    return os.path.exists(ck)


def _demucs(a: Audio) -> dict[str, np.ndarray]:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    wav = torch.from_numpy(a.stereo).float()
    if model.samplerate != SR:
        import torchaudio

        wav = torchaudio.functional.resample(wav, SR, model.samplerate)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        out = apply_model(model, wav[None], split=True, overlap=0.25, progress=False,
                          num_workers=0)[0]
    out = out * (ref.std() + 1e-8) + ref.mean()
    res = {}
    for name, src in zip(model.sources, out):
        mono = src.mean(0).numpy()
        res[name] = librosa.resample(mono, orig_sr=model.samplerate, target_sr=SR_LO)
    return res


def _dsp(a: Audio) -> dict[str, np.ndarray]:
    S = a.cache.get("stft")
    if S is None:
        hpss(a)
        S = a.cache["stft"]
    # stricter split than the analysis HPSS: margin 2 leaves a residual
    H, P = librosa.decompose.hpss(S, margin=2.0)
    freqs = librosa.fft_frequencies(sr=SR_LO, n_fft=2048)
    lp = 1 / (1 + (freqs / 170.0) ** 8)  # smooth 170 Hz low-pass mask
    # kick fundamentals live in the bass band of the percussive part too;
    # leave them with the drums.
    bass = H * lp[:, None]
    other = H * (1 - lp[:, None])
    n = len(a.lo)
    return {
        "drums": librosa.istft(P, hop_length=HOP, length=n),
        "bass": librosa.istft(bass, hop_length=HOP, length=n),
        "other": librosa.istft(other, hop_length=HOP, length=n),
    }


def _activity(y: np.ndarray, duration: float) -> np.ndarray:
    hop = int(SR_LO / RATE)
    n = int(np.ceil(duration * RATE))
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop, center=True)[0]
    db = 20 * np.log10(rms + 1e-7)
    db = np.pad(db, (0, max(0, n - len(db))), constant_values=-140)[:n]
    return db


def _presence(db: np.ndarray, ref_db: float) -> list[list[float]]:
    """Hysteresis gate relative to the loudest stem of the mix."""
    on_th, off_th = ref_db - 26, ref_db - 34
    sm = ndi.uniform_filter1d(db, 3)
    state, segs, start = False, [], 0.0
    for i, v in enumerate(sm):
        t = i / RATE
        if not state and v > on_th:
            state, start = True, t
        elif state and v < off_th:
            state = False
            segs.append([start, t])
    if state:
        segs.append([start, len(sm) / RATE])
    # merge gaps < 2 s, drop blips < 1.5 s
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < 2.0:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [[round(s[0], 2), round(s[1], 2)] for s in merged if s[1] - s[0] >= 1.5]


def _drum_hits(drums: np.ndarray) -> dict[str, list[float]]:
    S = np.abs(librosa.stft(drums, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR_LO, n_fft=2048)
    L = np.log1p(10 * S)
    out = {}
    for name, lo, hi, delta in (("kick", 30, 130, 0.5), ("snare", 1200, 5000, 0.55),
                                ("hat", 7000, 11000, 0.5)):
        sel = (freqs >= lo) & (freqs < hi)
        env = np.maximum(np.diff(L[sel], axis=1, prepend=L[sel][:, :1]), 0).mean(axis=0)
        if env.max() <= 0:
            out[name] = []
            continue
        env = env / env.max()
        pk = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=8, post_avg=8,
                                    delta=delta * env.std() + 0.05, wait=4)
        out[name] = np.round(librosa.frames_to_time(pk, sr=SR_LO, hop_length=HOP), 3).tolist()
    return out


def analyze(a: Audio, use_demucs: bool | None = None) -> dict:
    if use_demucs is None:
        use_demucs = demucs_available()
    method = "dsp-hpss"
    stems = None
    if use_demucs:
        try:
            stems = _demucs(a)
            method = "demucs-htdemucs"
        except Exception as e:  # pragma: no cover - network / weights
            method = f"dsp-hpss (demucs failed: {type(e).__name__})"
    if stems is None:
        stems = _dsp(a)
    a.cache["stems"] = stems

    acts = {k: _activity(v, a.duration) for k, v in stems.items()}
    ref = max(np.percentile(v, 95) for v in acts.values())
    out = {"method": method, "rate_hz": RATE, "stems": {}}
    for k in STEMS:
        if k not in acts:
            out["stems"][k] = None
            continue
        db = acts[k]
        out["stems"][k] = {
            "activity_db": np.round(np.maximum(db, -90), 1).tolist(),
            "present": _presence(db, ref),
        }
    out["drum_hits"] = _drum_hits(stems["drums"])
    return out
