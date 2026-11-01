"""Score the listening engine against ground truth.

Two test sets:

* synthetic (eval/synth.py): songs rendered with exact truth for beats,
  downbeats, tempo, key, chords, sections and per-stem presence;
* real (eval/references.json): CC / public-domain recordings with whatever
  truth is actually published (a key in the title, real multitrack stems).

    python eval/evaluate.py --synth /tmp/synth --real /tmp/dl --out eval/results

Metrics are the standard MIR ones (mir_eval): tempo Acc1/Acc2 (4%), beat and
downbeat F-measure (70 ms), MIREX weighted key score, chord majmin weighted
overlap, section boundary hit-rate F@3 s and frame accuracy of the
functional label, and frame accuracy of each stem's presence.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import mir_eval
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from mewsik_listen import analyze_file  # noqa: E402
from mewsik_listen.harmony import PCS  # noqa: E402

FUNC_GROUPS = {  # labels a listener would accept as the same function
    "intro": "intro", "outro": "outro", "build": "build", "drop": "high", "chorus": "high",
    "breakdown": "low", "verse": "mid", "bridge": "mid",
}


def tempo_scores(est: float, ref: float) -> tuple[float, float]:
    acc1 = abs(est - ref) / ref <= 0.04
    acc2 = any(abs(est * m - ref) / ref <= 0.04 for m in (1, 2, 0.5, 3, 1 / 3))
    return float(acc1), float(acc2)


def key_score(est: dict, ref: dict) -> float:
    e = f"{est['tonic']} {est['mode']}"
    r = f"{ref['tonic']} {ref['mode']}"
    return float(mir_eval.key.weighted_score(r, e))


def chord_scores(est: list[dict], ref: list[dict]) -> dict:
    ri = np.array([[c["start"], c["end"]] for c in ref])
    rl = [c["label"] for c in ref]
    ei = np.array([[c["start"], c["end"]] for c in est])
    el = [c["label"] for c in est]
    ei, el = mir_eval.util.adjust_intervals(ei, el, ri.min(), ri.max(), mir_eval.chord.NO_CHORD,
                                            mir_eval.chord.NO_CHORD)
    iv, r, e = mir_eval.util.merge_labeled_intervals(ri, rl, ei, el)
    d = mir_eval.util.intervals_to_durations(iv)
    return {"majmin": float(mir_eval.chord.weighted_accuracy(mir_eval.chord.majmin(r, e), d)),
            "root": float(mir_eval.chord.weighted_accuracy(mir_eval.chord.root(r, e), d))}


def _frame_labels(segs, t, key="label", mapper=None):
    out = np.array([""] * len(t), dtype=object)
    for s in segs:
        m = (t >= s["start"]) & (t < s["end"])
        out[m] = mapper(s[key]) if mapper else s[key]
    return out


def section_scores(est: list[dict], ref: list[dict], dur: float) -> dict:
    rb = np.array([[s["start"], s["end"]] for s in ref])
    eb = np.array([[s["start"], s["end"]] for s in est])
    eb[-1, 1] = rb[-1, 1] = max(eb[-1, 1], rb[-1, 1])
    p, r, f = mir_eval.segment.detection(rb, eb, window=3.0, trim=True)
    t = np.arange(0, dur, 0.25)
    fe = _frame_labels(est, t, mapper=lambda l: FUNC_GROUPS.get(l, l))
    fr = _frame_labels(ref, t, mapper=lambda l: FUNC_GROUPS.get(l, l))
    exact_e, exact_r = _frame_labels(est, t), _frame_labels(ref, t)
    m = fr != ""
    return {"boundary_f3": float(f), "boundary_p3": float(p), "boundary_r3": float(r),
            "label_exact": float((exact_e[m] == exact_r[m]).mean()),
            "label_function": float((fe[m] == fr[m]).mean())}


def stem_scores(est: dict, ref: dict, dur: float) -> dict:
    t = np.arange(0, dur, 0.5)
    out = {}
    for k, segs in ref.items():
        v = est["stems"].get(k)
        if v is None:
            continue
        on_r = np.zeros(len(t), bool)
        for s, e in segs:
            on_r |= (t >= s) & (t < e)
        if not on_r.any() and k == "vocals":
            continue
        on_e = np.zeros(len(t), bool)
        for s, e in v["present"]:
            on_e |= (t >= s) & (t < e)
        out[k] = float((on_r == on_e).mean())
    return out


def eval_one(res: dict, truth: dict) -> dict:
    rh, hm = res["rhythm"], res["harmony"]
    row = {"name": truth["name"], "bpm_est": rh["bpm"]}
    if "bpm" in truth:
        row["bpm_ref"] = truth["bpm"]
        row["tempo_acc1"], row["tempo_acc2"] = tempo_scores(rh["bpm"], truth["bpm"])
    if "beats" in truth:
        ref_b = mir_eval.beat.trim_beats(np.array(truth["beats"]))
        est_b = mir_eval.beat.trim_beats(np.array(rh["beats"]))
        row["beat_f"] = float(mir_eval.beat.f_measure(ref_b, est_b))
    if "downbeats" in truth:
        row["downbeat_f"] = float(mir_eval.beat.f_measure(
            mir_eval.beat.trim_beats(np.array(truth["downbeats"])),
            mir_eval.beat.trim_beats(np.array(rh["downbeats"]))))
    if "meter" in truth:
        row["meter_ok"] = float(rh["meter"] == truth["meter"])
    if "key" in truth:
        row["key_ref"] = f"{truth['key']['tonic']} {truth['key']['mode']}"
        row["key_est"] = f"{hm['key']['tonic']} {hm['key']['mode']}"
        row["key_score"] = key_score(hm["key"], truth["key"])
        if truth["key"].get("alt"):
            alt = truth["key"]["alt"]
            row["key_score_alt"] = key_score(hm["key"], alt)
    if "chords" in truth:
        row.update({f"chord_{k}": v for k, v in chord_scores(hm["chords"], truth["chords"]).items()})
    if "sections" in truth:
        row.update(section_scores(res["structure"]["sections"], truth["sections"], res["duration"]))
    if "stems_present" in truth:
        row.update({f"stem_{k}": v for k, v in
                    stem_scores(res["stems"], truth["stems_present"], res["duration"]).items()})
    row["seconds"] = res["timings_s"]["total"]
    return row


def run(pairs, cache_dir, force=False):
    rows = []
    os.makedirs(cache_dir, exist_ok=True)
    for audio, truth in pairs:
        cp = os.path.join(cache_dir, truth["name"] + ".json")
        if os.path.exists(cp) and not force:
            res = json.load(open(cp))
        else:
            print(f"analyzing {truth['name']}", file=sys.stderr)
            res = analyze_file(audio)
            json.dump(res, open(cp, "w"), separators=(",", ":"))
        rows.append(eval_one(res, truth))
    return rows


def table(rows, cols):
    cols = [c for c in cols if any(c in r for r in rows)]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        cells = []
        for c in cols:
            v = r.get(c, "")
            cells.append(f"{v:.2f}" if isinstance(v, float) else str(v))
        lines.append("| " + " | ".join(cells) + " |")
    means = []
    for c in cols:
        vals = [r[c] for r in rows if isinstance(r.get(c), float)]
        means.append(f"**{np.mean(vals):.2f}**" if vals and c not in ("bpm_ref", "bpm_est", "seconds")
                     else ("**mean**" if c == "name" else ""))
    lines.append("| " + " | ".join(means) + " |")
    return "\n".join(lines)


COLS_RHYTHM = ["name", "bpm_ref", "bpm_est", "tempo_acc1", "tempo_acc2", "beat_f", "downbeat_f", "meter_ok"]
COLS_HARM = ["name", "key_ref", "key_est", "key_score", "key_score_alt", "chord_majmin", "chord_root"]
COLS_STRUCT = ["name", "boundary_f3", "boundary_p3", "boundary_r3", "label_function", "label_exact",
               "stem_drums", "stem_bass", "stem_other", "seconds"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", help="dir of synth.py output")
    ap.add_argument("--real", help="root dir that references.json paths are relative to")
    ap.add_argument("--out", default=os.path.join(HERE, "results"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    md = []
    all_rows = {}
    if args.synth:
        pairs = []
        for tp in sorted(glob.glob(os.path.join(args.synth, "*.truth.json"))):
            truth = json.load(open(tp))
            pairs.append((tp.replace(".truth.json", ".wav"), truth))
        rows = run(pairs, os.path.join(args.out, "cache"), args.force)
        all_rows["synthetic"] = rows
        md += ["## Synthetic set (exact ground truth)", "", "### Rhythm", table(rows, COLS_RHYTHM), "",
               "### Harmony", table(rows, COLS_HARM), "", "### Structure and stems", table(rows, COLS_STRUCT), ""]
    if args.real:
        refs = json.load(open(os.path.join(HERE, "references.json")))
        pairs = []
        for r in refs["tracks"]:
            if not os.path.exists(os.path.join(args.real, r["path"])):
                continue
            truth = dict(r["truth"])
            if r.get("truth_file"):
                truth |= json.load(open(os.path.join(args.real, r["truth_file"])))
            pairs.append((os.path.join(args.real, r["path"]), truth | {"name": r["name"]}))
        rows = run(pairs, os.path.join(args.out, "cache"), args.force)
        all_rows["real"] = rows
        md += ["## Real recordings (published truth only)", "", table(rows, COLS_RHYTHM + COLS_HARM[1:] + COLS_STRUCT[1:]), ""]
    json.dump(all_rows, open(os.path.join(args.out, "results.json"), "w"), indent=1)
    open(os.path.join(args.out, "results.md"), "w").write("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()
