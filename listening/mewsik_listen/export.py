"""Export for the DAW: a MIDI file with the chord progression (pad voicing
on channel 1, bass roots on channel 2), the engine's tempo, and section
names as marker meta events.

Drag it into Ableton Live with the audio at 1.1.1 and set the project tempo
to the reported BPM (or warp the audio to the beat grid first): the chord
clip lines up with the track. Live ignores MIDI markers on import; DAWs
such as Reaper, Logic and Bitwig show them.
"""

from __future__ import annotations

import mido

from .harmony import PCS

PPQ = 480


def write_midi(res: dict, path: str) -> None:
    bpm = res["rhythm"]["bpm"]
    sec_to_tick = lambda s: int(round(s * bpm / 60 * PPQ))  # noqa: E731
    mid = mido.MidiFile(ticks_per_beat=PPQ)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=res["rhythm"]["meter"], denominator=4, time=0))
    meta.append(mido.MetaMessage("track_name", name=f"mewsik: {res['file']}", time=0))
    now = 0
    for s in res["structure"]["sections"]:
        t = sec_to_tick(s["start"])
        meta.append(mido.MetaMessage("marker", text=f"{s['label']} {s['letter']}", time=t - now))
        now = t
    mid.tracks.append(meta)

    events = []  # (tick, order, msg)
    for c in res["harmony"]["chords"]:
        if c["label"] == "N" or c["end"] - c["start"] < 0.15:
            continue
        root, q = c["label"].split(":")
        r = PCS.index(root)
        notes = [48 + r, 48 + r + (4 if q == "maj" else 3), 48 + r + 7]
        notes = [n if n < 60 else n - 12 for n in notes] + [36 + r]
        a, b = sec_to_tick(c["start"]), sec_to_tick(c["end"])
        for i, n in enumerate(notes):
            ch = 1 if i == len(notes) - 1 else 0
            events.append((a, 1, mido.Message("note_on", note=n, velocity=80, channel=ch)))
            events.append((b, 0, mido.Message("note_off", note=n, velocity=0, channel=ch)))
    events.sort(key=lambda e: (e[0], e[1]))
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage("track_name", name="chords", time=0))
    now = 0
    for tick, _, msg in events:
        tr.append(msg.copy(time=tick - now))
        now = tick
    mid.tracks.append(tr)
    mid.save(path)
