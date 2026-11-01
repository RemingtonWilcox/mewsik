"""Bundle analyses + audio into one self-contained demo page.

    python demo/build_demo.py --cache eval/results/cache --synth /tmp/synth \
        --real /tmp/dl --results eval/results/results.json --out demo/dist/index.html

Audio is re-encoded to 80 kbps MP3 and inlined as data URIs, so the page has no
external dependencies except Google Fonts. Only recordings whose licence
allows redistribution with attribution are bundled (see TRACKS).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# (cache name, title, credit html, synthetic?)
TRACKS = [
    ("edm_drop", "EDM drop (synthetic)", "Rendered by <code>eval/synth.py</code>; ground truth shown under each row.", True),
    ("outfoxing_the_fox", "Outfoxing the Fox",
     '"Outfoxing the Fox" by Kevin MacLeod (incompetech.com), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>', False),
    ("vibe_ace", "Vibe Ace",
     '"Vibe Ace" by Kevin MacLeod (incompetech.com), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>', False),
    ("sugar_plum_fairy", "Sugar Plum Fairy",
     '"Dance of the Sugar Plum Fairy", Tchaikovsky arr. Kevin MacLeod, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>', False),
    ("brahms_hungarian5", "Hungarian Dance No. 5",
     'Brahms, Hungarian Dance No. 5, US Army Strings via Musopen, <a href="https://creativecommons.org/publicdomain/mark/1.0/">Public Domain</a>', False),
    ("choice_drum_bass", "Choice (drums + bass)",
     '"Choice" by Admiral Bob ft. Snowflake (ccMixter), drum and bass excerpt by Brian McFee, <a href="https://creativecommons.org/licenses/by-nc/4.0/">CC BY-NC 4.0</a>', False),
    ("dnb", "Drum & bass 174 (synthetic)", "Rendered by <code>eval/synth.py</code>. The tracker first locks at 87 BPM; the backbeat check doubles it.", True),
    ("house_groove", "House groove (synthetic)", "Rendered by <code>eval/synth.py</code>.", True),
]


def encode(path: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "2", "-b:a", "80k", f.name], check=True)
        return "data:audio/mpeg;base64," + base64.b64encode(open(f.name, "rb").read()).decode()


def r(v, d=3):
    return [round(float(x), d) for x in v]


def pack(res: dict, audio_path: str, title: str, credit: str, truth: dict | None) -> dict:
    rh, hm, en, st, sx, tl = (res[k] for k in ("rhythm", "harmony", "energy", "stems", "structure", "timeline"))
    k = hm["key"]
    acts = {n: np.asarray(v["activity_db"]) for n, v in st["stems"].items() if v}
    ref = max(np.percentile(v, 95) for v in acts.values())
    stems = {n: (r(np.clip((acts[n] - (ref - 40)) / 40, 0, 1), 2) if n in acts else None)
             for n in ("drums", "bass", "other", "vocals")}
    out = {
        "title": title, "credit": credit, "synthetic": truth is not None, "duration": res["duration"],
        "audio": encode(audio_path),
        "summary": {"bpm": rh["bpm"], "meter": rh["meter"], "conf": rh["confidence"], "octave": rh["octave_note"],
                    "key": k["name"], "camelot": k["camelot"], "keyconf": k["confidence"],
                    "lufs": en["integrated_lufs"], "lra": en["loudness_range_lu"], "style": sx["style"],
                    "stems_method": st["method"]},
        "beats": r(rh["beats"]), "pos": rh["beat_positions"], "down": r(rh["downbeats"]),
        "sections": [{"s": s["start"], "e": s["end"], "l": s["label"], "L": s["letter"], "bars": s["bars"]}
                     for s in sx["sections"]],
        "chords": [{"s": c["start"], "e": c["end"], "n": c["name"]} for c in hm["chords"]],
        "energy": en["energy"], "tension": en["tension"], "valence": en["valence"], "arousal": en["arousal"],
        "loud": en["loudness_short_term"], "stems": stems,
        "hits": st["drum_hits"],
        "events": [{"t": e["t"], "k": e["kind"], "x": e["text"]} for e in tl["events"]],
        "narration": [{"s": n["start"], "e": n["end"], "l": n["label"], "x": n["text"]} for n in tl["narration"]],
    }
    if truth:
        from mewsik_listen.harmony import pretty_chord

        out["truth"] = {
            "bpm": truth["bpm"], "key": f"{truth['key']['tonic']} {truth['key']['mode']}",
            "sections": [{"s": s["start"], "e": s["end"], "l": s["label"]} for s in truth["sections"]],
            "chords": [{"s": c["start"], "e": c["end"], "n": pretty_chord(c["label"])} for c in truth["chords"]],
            "down": truth["downbeats"],
        }
    return out


def main():
    import sys

    sys.path.insert(0, os.path.dirname(HERE))
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--synth", required=True)
    ap.add_argument("--real", required=True)
    ap.add_argument("--results", required=True)
    ap.add_argument("--notes", default=os.path.join(HERE, "accuracy_notes.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "dist", "index.html"))
    args = ap.parse_args()

    refs = {t["name"]: t for t in json.load(open(os.path.join(HERE, "..", "eval", "references.json")))["tracks"]}
    tracks = []
    for name, title, credit, synthetic in TRACKS:
        res = json.load(open(os.path.join(args.cache, name + ".json")))
        if synthetic:
            ap_ = os.path.join(args.synth, name + ".wav")
            truth = json.load(open(os.path.join(args.synth, name + ".truth.json")))
        else:
            ap_ = os.path.join(args.real, refs[name]["path"])
            truth = None
        tracks.append(pack(res, ap_, title, credit, truth))
        print("packed", name)
    results = json.load(open(args.results))
    notes = json.load(open(args.notes))
    data = {"rate": 2.0, "tracks": tracks,
            "accuracy": {"intro": notes["intro"], "notes": notes["notes"],
                         "synthetic": results.get("synthetic", []), "real": results.get("real", [])}}
    html = open(os.path.join(HERE, "template.html")).read().replace("/*__DATA__*/null", json.dumps(data, separators=(",", ":")))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    open(args.out, "w").write(html)
    print(f"wrote {args.out} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
