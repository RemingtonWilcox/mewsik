"""Build the real-recording test material that needs preparing.

The MDN web-audio multitrack (five isolated parts by Mark Boas, from the
jPlayer demo) is mixed here, and the presence of each part is measured from
the isolated stem itself, giving true stem-activity ground truth for a real
recording. Its licence is unstated, so it is used for evaluation only and
never bundled.

    python eval/prepare_real.py /tmp/dl
"""

import json
import os
import sys

import librosa
import numpy as np
import soundfile as sf

GROUPS = {"drums": ["drums"], "bass": ["bassguitar"], "other": ["leadguitar", "horns", "clav"]}


def presence(y, sr, ref_db):
    hop = sr // 2
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
    db = 20 * np.log10(rms + 1e-7)
    on = db > ref_db - 30
    segs, start = [], None
    for i, v in enumerate(on):
        t = i * 0.5
        if v and start is None:
            start = t
        if not v and start is not None:
            if t - start >= 1.5:
                segs.append([start, t])
            start = None
    if start is not None:
        segs.append([start, len(on) * 0.5])
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] <= 2.0:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return merged


def main(root):
    d = os.path.join(root, "mdn")
    sr = 44100
    parts = {}
    for g, names in GROUPS.items():
        ys = [librosa.load(os.path.join(d, f"multi-track_{n}.mp3"), sr=sr, mono=True)[0] for n in names]
        n = max(len(y) for y in ys)
        parts[g] = sum(np.pad(y, (0, n - len(y))) for y in ys)
    n = max(len(y) for y in parts.values())
    parts = {k: np.pad(v, (0, n - len(v))) for k, v in parts.items()}
    mix = sum(parts.values())
    peak = np.abs(mix).max()
    sf.write(os.path.join(d, "multitrack_mix.wav"), (mix / peak * 0.9).astype(np.float32), sr)
    ref = max(20 * np.log10(np.percentile(librosa.feature.rms(y=v)[0], 95) + 1e-7) for v in parts.values())
    truth = {"name": "mdn_multitrack", "stems_present": {k: presence(v, sr, ref) for k, v in parts.items()}}
    json.dump(truth, open(os.path.join(d, "multitrack_mix.truth.json"), "w"), indent=1)
    print(json.dumps(truth, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
