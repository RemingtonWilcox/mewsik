"""Fast checks on tiny synthesized signals. Full accuracy lives in eval/."""

import os
import sys

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mewsik_listen import analyze_file, harmony  # noqa: E402

SR = 44100


def tone(freqs, dur, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    y = sum(np.sin(2 * np.pi * f * t) * 0.2 / (1 + i * 0.3) for i, f in enumerate(freqs))
    env = np.minimum(1, np.minimum(t / 0.01, (dur - t) / 0.05))
    return y * env


def midi(n):
    return 440 * 2 ** ((n - 69) / 12)


def kick(sr=SR):
    t = np.arange(int(0.15 * sr)) / sr
    f = 50 + 100 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 25)


@pytest.fixture(scope="module")
def song(tmp_path_factory):
    """16 bars at 120 BPM: C – G – Am – F triads + bass + four-on-floor kick."""
    bpm, beat = 120, 0.5
    prog = [(60, "maj"), (67, "maj"), (69, "min"), (65, "maj")]
    y = np.zeros(int((16 * 4 * beat + 1) * SR))
    for bar in range(16):
        root, q = prog[bar % 4]
        third = 4 if q == "maj" else 3
        chord = tone([midi(root), midi(root + third), midi(root + 7), midi(root - 24)], 4 * beat)
        i = int((0.25 + bar * 4 * beat) * SR)
        y[i : i + len(chord)] += chord
        for b in range(4):
            j = int((0.25 + (bar * 4 + b) * beat) * SR)
            k = kick()
            y[j : j + len(k)] += 0.8 * k
    y /= np.abs(y).max() * 1.1
    p = tmp_path_factory.mktemp("s") / "song.wav"
    sf.write(p, np.stack([y, y], 1), SR)
    return analyze_file(str(p), use_demucs=False)


def test_tempo(song):
    assert abs(song["rhythm"]["bpm"] - 120) / 120 < 0.04


def test_key_is_c_major(song):
    k = song["harmony"]["key"]
    assert (k["tonic"], k["mode"]) == ("C", "major")
    assert k["camelot"] == "8B"


def test_chords_follow_progression(song):
    names = [c["label"] for c in song["harmony"]["chords"] if 2 < c["start"] < 30]
    for want in ("C:maj", "G:maj", "A:min", "F:maj"):
        assert want in names


def test_compat_track_score_shape(song):
    ts = song["compat_track_score"]
    for k in ("version", "duration_ms", "bpm", "beat_offset_ms", "beat_confidence", "key",
              "sections", "drops", "energy_hz", "energy_curve"):
        assert k in ts
    assert ts["sections"][0]["start_ms"] == 0
    assert set(ts["key"]) == {"pitch_class", "mode", "confidence"}


def test_profile_scores_prefer_c_major():
    v = np.zeros(12)
    v[[0, 4, 7]] = [1, 0.8, 0.9]
    s = harmony._profile_scores(v, harmony.TEMPERLEY)
    assert int(np.argmax(s)) == 0


def test_camelot_relatives_share_number():
    assert harmony.camelot(9, "minor")[:-1] == harmony.camelot(0, "major")[:-1]
    assert harmony.key_name(10, "major") == "Bb major"
