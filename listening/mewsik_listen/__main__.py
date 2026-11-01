"""CLI: python -m mewsik_listen analyze <audio> [-o out.json] [--summary]"""

import argparse
import json
import sys

from .engine import analyze_file
from .timeline import fmt_t


def main(argv=None):
    p = argparse.ArgumentParser(prog="mewsik_listen")
    sub = p.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="analyze one audio file")
    an.add_argument("audio")
    an.add_argument("-o", "--out", help="write JSON here (default: stdout summary only)")
    an.add_argument("--demucs", action="store_true", help="force Demucs stems (downloads weights)")
    an.add_argument("--no-demucs", action="store_true", help="DSP stems only")
    an.add_argument("--compat", action="store_true", help="emit only the app's TrackScore JSON")
    an.add_argument("--midi", help="also write chords + section markers as a MIDI file")
    args = p.parse_args(argv)

    use = True if args.demucs else (False if args.no_demucs else None)
    log = lambda m: print(m, file=sys.stderr)  # noqa: E731
    log(f"listening to {args.audio}")
    res = analyze_file(args.audio, use_demucs=use, log=log)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(res["compat_track_score"] if args.compat else res, f, separators=(",", ":"))
    if args.midi:
        from .export import write_midi

        write_midi(res, args.midi)
    summary(res)


def summary(res):
    rh, k = res["rhythm"], res["harmony"]["key"]
    print(f"{res['file']}  {fmt_t(res['duration'])}")
    print(f"  tempo  {rh['bpm']:.1f} BPM ({rh['meter']}/4-ish meter, conf {rh['confidence']:.2f}, "
          f"stability {rh['stability']:.2f})")
    print(f"  key    {k['name']} [{k['camelot']}]  conf {k['confidence']:.2f}  (runner-up {k['runner_up']['name']})")
    print(f"  loud   {res['energy']['integrated_lufs']} LUFS integrated, LRA {res['energy']['loudness_range_lu']} LU")
    print(f"  style  {res['structure']['style']}, stems via {res['stems']['method']}")
    for line in res["timeline"]["narration"]:
        print("   ", line["text"])


if __name__ == "__main__":
    main()
