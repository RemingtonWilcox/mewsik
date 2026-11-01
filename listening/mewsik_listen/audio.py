"""Decoding and the shared time grid every other module works on."""

from __future__ import annotations

from dataclasses import dataclass, field

import librosa
import numpy as np

SR = 44100  # full-rate analysis (essentia rhythm/key/loudness)
SR_LO = 22050  # librosa feature rate
HOP = 512  # librosa hop at SR_LO (~23.2 ms)


@dataclass
class Audio:
    path: str
    stereo: np.ndarray  # (2, n) float32 at SR
    mono: np.ndarray  # (n,) float32 at SR
    lo: np.ndarray  # (m,) float32 at SR_LO
    duration: float
    cache: dict = field(default_factory=dict)

    @property
    def fps(self) -> float:
        return SR_LO / HOP

    def frames_to_time(self, frames) -> np.ndarray:
        return librosa.frames_to_time(frames, sr=SR_LO, hop_length=HOP)

    def time_to_frames(self, t) -> np.ndarray:
        return librosa.time_to_frames(t, sr=SR_LO, hop_length=HOP)


def load(path: str) -> Audio:
    y, _ = librosa.load(path, sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    y = y[:2].astype(np.float32)
    mono = y.mean(axis=0)
    lo = librosa.resample(mono, orig_sr=SR, target_sr=SR_LO).astype(np.float32)
    return Audio(path=path, stereo=y, mono=mono, lo=lo, duration=len(mono) / SR)


def hpss(a: Audio):
    """Harmonic/percussive split of the low-rate signal, cached."""
    if "hpss" not in a.cache:
        S = librosa.stft(a.lo, n_fft=2048, hop_length=HOP)
        H, P = librosa.decompose.hpss(S, margin=1.0)
        a.cache["stft"] = S
        a.cache["hpss"] = (H, P)
    return a.cache["hpss"]
