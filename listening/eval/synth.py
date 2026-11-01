#!/usr/bin/env python3
"""Deterministic synthetic-music generator with exact ground truth.

Produces test songs for evaluating a music-analysis engine (beats, downbeats,
tempo, key, chords, sections, stems).  Every song is rendered from a symbolic
plan, so the truth is exact by construction:

  <out>/<name>.wav               stereo 44.1 kHz float32 mix, peak ~ -1 dBFS
  <out>/<name>.truth.json        ground truth (see schema below)
  <out>/<name>.stems/{drums,bass,other,vocals}.wav   stems; they sum to the mix

Usage:
  python synth.py --out /tmp/synth [--only NAME ...] [--jobs 4] [--check]
  python synth.py --list

Truth schema (times in seconds, 4 dp):
  name, duration, sample_rate, bpm (nominal), meter, key{tonic,mode},
  beats[], downbeats[], chords[{start,end,label,full}] (label = root:maj|min,
  sharps spelling, 'N' = no chord), sections[{start,end,label}],
  stems_present{stem: [[start,end],...]}, events[{t,what}]
  plus extras: offset, swing (if any), bpm_start/bpm_end (tempo ramp).

Beat times are never humanised; only velocities vary (seeded RNG).
Only numpy, scipy and soundfile are used.
"""
import argparse
import json
import math
import os
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from types import SimpleNamespace

import numpy as np
import soundfile as sf
from scipy import signal

SR = 44100
SECTION_TAIL = 4.0      # seconds of ring-out kept past each section's end
SONG_TAIL = 2.5         # seconds after the last beat
STEMS = ("drums", "bass", "other", "vocals")
PCS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
QUAL = {"maj": (0, 4, 7), "min": (0, 3, 7), "maj7": (0, 4, 7, 11),
        "min7": (0, 3, 7, 10), "7": (0, 4, 7, 10)}
TRIAD = {"maj": "maj", "min": "min", "maj7": "maj", "min7": "min", "7": "maj"}
SCALES = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}
VEL = {"X": 1.15, "x": 1.0, "o": 0.6, "g": 0.3}
DRUM_PAN = dict(kick=0.0, snare=0.05, clap=-0.1, chat=0.3, ohat=-0.25, crash=-0.35)
DRUM_GAIN = dict(kick=1.0, snare=0.7, clap=0.55, chat=0.22, ohat=0.2, crash=0.28)


# ----------------------------------------------------------------------------
# DSP helpers
# ----------------------------------------------------------------------------
def _t(n):
    return np.arange(n) / SR


def hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def pan_gains(p):
    a = (p + 1.0) * np.pi / 4.0
    return math.cos(a), math.sin(a)


@lru_cache(maxsize=None)
def _sos(btype, f, order):
    if isinstance(f, tuple):
        wn = [min(max(x, 10.0), SR * 0.45) for x in f]
    else:
        wn = min(max(f, 10.0), SR * 0.45)
    return signal.butter(order, wn, btype=btype, fs=SR, output="sos")


def filt(x, btype, f, order=2):
    f = tuple(round(v, 1) for v in f) if isinstance(f, (tuple, list)) else round(float(f), 1)
    return signal.sosfilt(_sos(btype, f, order), x, axis=-1)


def tv_filter(x, freqs, btype="low", order=2, chunk=512):
    """Time-varying Butterworth: one coefficient set per chunk, state carried."""
    x = np.atleast_2d(x)
    n = x.shape[-1]
    out = np.empty_like(x)
    zi = None
    for i in range(int(math.ceil(n / chunk))):
        a, b = i * chunk, min(n, (i + 1) * chunk)
        f = freqs[min(i, len(freqs) - 1)]
        wn = [min(max(v, 10.0), SR * 0.45) for v in f] if isinstance(f, tuple) \
            else min(max(f, 10.0), SR * 0.45)
        sos = signal.butter(order, wn, btype=btype, fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], x.shape[0], 2))
        out[:, a:b], zi = signal.sosfilt(sos, x[:, a:b], axis=-1, zi=zi)
    return out


def adsr(n, a, d, s, r, gate):
    gate = max(gate, 2e-3)
    a = min(a, gate * 0.9)
    d = max(min(d, gate - a), 1e-4)
    g = max(gate, a + d + 1e-4)
    return np.interp(_t(n), [0, a, a + d, g, g + r], [0, 1, s, s, 0])


def saw(f, n, ph0=0.0):
    ph = ph0 + (f * _t(n) if np.isscalar(f) else np.cumsum(f) / SR)
    return 2.0 * (ph % 1.0) - 1.0


def fade_out(n, sec):
    k = min(n, int(sec * SR))
    e = np.ones(n)
    e[n - k:] = np.linspace(1, 0, k)
    return e


def norm(x):
    return x / (np.max(np.abs(x)) + 1e-12)


# ----------------------------------------------------------------------------
# Instruments
# ----------------------------------------------------------------------------
class Kit:
    def __init__(self, rng):
        self.rng = rng
        self.s = {
            "kick": [self._kick(v) for v in range(2)],
            "snare": [self._snare() for _ in range(3)],
            "clap": [self._clap() for _ in range(2)],
            "chat": [self._hat(0.018, 0.09) for _ in range(4)],
            "ohat": [self._hat(0.13, 0.45) for _ in range(2)],
            "crash": [self._crash()],
        }

    def get(self, name):
        v = self.s[name]
        return v[int(self.rng.integers(len(v)))]

    def _noise(self, n):
        return self.rng.standard_normal(n)

    def _kick(self, var):
        n = int(0.45 * SR)
        t = _t(n)
        f = 46 + (125 + 15 * var) * np.exp(-t / 0.032)
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.30)
        click = filt(self._noise(n), "high", 1500.0) * np.exp(-t / 0.004) * 0.5
        return norm(np.tanh(1.6 * (body + click)) * fade_out(n, 0.02))

    def _snare(self):
        n = int(0.28 * SR)
        t = _t(n)
        tone = 0.55 * np.sin(2 * np.pi * 188 * t) * np.exp(-t / 0.055) \
            + 0.3 * np.sin(2 * np.pi * 332 * t) * np.exp(-t / 0.035)
        nz = filt(self._noise(n), "bandpass", (1500.0, 9000.0), 2) * np.exp(-t / 0.085)
        return norm((tone + 1.3 * nz) * fade_out(n, 0.02))

    def _clap(self):
        n = int(0.3 * SR)
        t = _t(n)
        env = sum(np.where(t >= o, np.exp(-(t - o) / 0.007), 0) for o in (0, 0.011, 0.022))
        env = env + np.where(t >= 0.03, 0.6 * np.exp(-(t - 0.03) / 0.09), 0)
        return norm(filt(self._noise(n), "bandpass", (900.0, 4500.0), 2) * env * fade_out(n, 0.02))

    def _hat(self, decay, dur):
        n = int(dur * SR)
        t = _t(n)
        x = filt(self._noise(n), "high", 7000.0, 4) * np.exp(-t / decay)
        return norm(x * fade_out(n, 0.01))

    def _crash(self):
        n = int(2.6 * SR)
        t = _t(n)
        x = filt(self._noise(n), "bandpass", (3000.0, 14000.0), 2) * np.exp(-t / 0.7)
        return norm(x * fade_out(n, 0.2))


def synth_bass(kind, midi, dur, vel, rng):
    f = hz(midi)
    n = int((dur + 0.12) * SR)
    t = _t(n)
    if kind == "sub":
        ph = 2 * np.pi * f * t
        x = np.sin(ph) + 0.12 * np.sin(2 * ph)
        env = adsr(n, 0.006, 0.05, 0.9, 0.05, dur)
    elif kind == "reese":
        x = saw(f * 2 ** (-14 / 1200), n, rng.random()) + saw(f * 2 ** (14 / 1200), n, rng.random())
        x = 0.5 * filt(x, "low", 450.0, 4) + 0.7 * np.sin(2 * np.pi * f * t)
        env = adsr(n, 0.01, 0.1, 0.85, 0.08, dur)
    elif kind == "upright":
        x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) * np.exp(-t / 0.3) \
            + 0.12 * np.sin(6 * np.pi * f * t) * np.exp(-t / 0.15)
        env = adsr(n, 0.005, 0.5, 0.45, 0.08, dur)
    else:  # 'saw'
        x = filt(saw(f, n, rng.random()), "low", 550.0, 2) + 0.5 * np.sin(2 * np.pi * f * t)
        env = adsr(n, 0.003, 0.15, 0.6, 0.06, dur)
    return x * env * vel


def synth_tone(kind, midi, dur, vel, rng):
    """Mono pitched note: keys (piano-ish), rhodes, pluck."""
    f = hz(midi)
    rel = 0.3 if kind != "pluck" else 0.08
    gate = min(dur, 3.2)
    n = int((gate + rel) * SR)
    t = _t(n)
    if kind == "keys":
        x = np.zeros(n)
        for k in range(1, 9):
            fk = f * k * math.sqrt(1 + 0.0003 * k * k)
            if fk > 15000:
                break
            x += (k ** -1.2) * np.exp(-t * (0.6 + 0.55 * k)) * np.sin(2 * np.pi * fk * t + rng.random() * 6.283)
        env = np.interp(t, [0, 0.003, gate, gate + rel], [0, 1, 1, 0])
    elif kind == "rhodes":
        x = np.sin(2 * np.pi * f * t) * np.exp(-t / 1.8) \
            + 0.2 * np.sin(4 * np.pi * f * t) * np.exp(-t / 0.7) \
            + 0.1 * np.sin(2 * np.pi * 7.1 * f * t) * np.exp(-t / 0.05)
        env = np.interp(t, [0, 0.006, gate, gate + rel], [0, 1, 1, 0])
    else:  # pluck
        x = filt(saw(f, n, rng.random()), "low", 2600.0, 2)
        env = adsr(n, 0.002, 0.18, 0.15, rel, gate)
    return x * env * vel


def synth_chord(kind, midis, dur, vel, rng, fc=None):
    """Stereo chord (2, n)."""
    if kind in ("keys", "rhodes", "pluck"):
        sigs = [synth_tone(kind, m, dur, vel, rng) for m in midis]
        n = max(len(s) for s in sigs)
        out = np.zeros((2, n))
        for i, s in enumerate(sigs):
            l, r = pan_gains(0.5 * (i / max(len(sigs) - 1, 1) - 0.5))
            out[0, :len(s)] += l * s
            out[1, :len(s)] += r * s
        return out / math.sqrt(len(midis))
    if kind == "pad":
        det, pans, fc0, env = (-9, 0, 9), (-0.6, 0, 0.6), 1800.0, (0.35, 0.5, 0.8, 0.8)
    elif kind == "supersaw":
        det, pans, fc0, env = (-18, -8, 0, 8, 18), (-0.8, -0.4, 0, 0.4, 0.8), 6000.0, (0.01, 0.2, 0.85, 0.25)
    else:  # stab
        det, pans, fc0, env = (-12, 0, 12), (-0.5, 0, 0.5), 3200.0, (0.003, 0.12, 0.35, 0.1)
    fc = fc or fc0
    n = int((dur + env[3] + 0.05) * SR)
    out = np.zeros((2, n))
    for m in midis:
        f = hz(m)
        for dc, p in zip(det, pans):
            v = saw(f * 2 ** (dc / 1200), n, rng.random())
            l, r = pan_gains(p)
            out[0] += l * v
            out[1] += r * v
    out = filt(out, "low", fc, 2)
    return out * adsr(n, env[0], env[1], env[2], env[3], dur) * vel / math.sqrt(len(midis) * len(det))


FORMANTS = ((730.0, 90.0, 1.0), (1090.0, 110.0, 0.5), (2440.0, 160.0, 0.25))


def synth_lead(midi, dur, vel, rng):
    """Vowel-ish lead ('ah' formants, delayed vibrato) for the vocals stem."""
    n = int((dur + 0.15) * SR)
    t = _t(n)
    depth = 25.0 * np.clip((t - 0.15) / 0.2, 0, 1)
    f = hz(midi) * 2 ** (depth * np.sin(2 * np.pi * 5.3 * t) / 1200)
    src = saw(f, n, rng.random())
    x = 0.3 * filt(src, "low", 1000.0, 2)
    for fc, bw, g in FORMANTS:
        x += g * filt(src, "bandpass", (fc - bw, fc + bw), 1)
    return x * adsr(n, 0.04, 0.1, 0.85, 0.12, dur) * vel


# ----------------------------------------------------------------------------
# Song context
# ----------------------------------------------------------------------------
def parse_chord(s):
    root, q = s.split(":")
    root = FLATS.get(root, root)
    return PCS.index(root), q, f"{root}:{TRIAD[q]}", f"{root}:{q}"


def chord_notes(pc, q, low):
    root = low + (pc - low) % 12
    return [root + i for i in QUAL[q]]


def iter_notes(seq, chars):
    """Yield (s0, s1, ch) for note-start chars, '-' holds, anything else ends."""
    cur = None
    for s, ch in enumerate(seq):
        if ch in chars:
            if cur:
                yield cur[0], s, cur[1]
            cur = (s, ch)
        elif ch != "-":
            if cur:
                yield cur[0], s, cur[1]
            cur = None
    if cur:
        yield cur[0], len(seq), cur[1]


class Ctx:
    def __init__(self, spec):
        self.spec = spec
        self.name = spec["name"]
        self.rng = np.random.default_rng(zlib.crc32(self.name.encode()))
        self.meter = spec["meter"]
        self.swing = spec.get("swing", 0.5)
        self.offset = spec["offset"]
        tonic = FLATS.get(spec["key"][0], spec["key"][0])
        self.key = (tonic, spec["key"][1])
        self.scale = {(PCS.index(tonic) + i) % 12 for i in SCALES[spec["key"][1]]}
        self.total_beats = sum(s["bars"] for s in spec["sections"]) * self.meter
        nb = self.total_beats
        if "bpm_ramp" in spec:
            b0, b1 = spec["bpm_ramp"]
            bpms = b0 + (b1 - b0) * np.arange(nb) / (nb - 1)
        else:
            bpms = np.full(nb, float(spec["bpm"]))
        self.ibi = 60.0 / bpms
        self.beat_times = self.offset + np.concatenate([[0.0], np.cumsum(self.ibi)])
        self.end_time = float(self.beat_times[-1])
        self.duration = self.end_time + SONG_TAIL
        self.n = int(math.ceil(self.duration * SR))
        self.out = {k: np.zeros((2, self.n)) for k in STEMS}
        self.kit = Kit(self.rng)
        self.chords = []  # (pos0, pos1, pc, q, label, full)

    # time mapping -----------------------------------------------------------
    def t(self, pos):
        if pos <= self.total_beats:
            return float(np.interp(pos, np.arange(self.total_beats + 1), self.beat_times))
        return self.end_time + (pos - self.total_beats) * float(self.ibi[-1])

    def step_pos(self, sec, s):
        sw = self.swing
        offs = (0.0, sw * 0.5, 0.5, 0.5 + sw * 0.5)
        return sec.b0 + s // 4 + offs[s % 4]

    def seq(self, sec, pat):
        spb = self.meter * 4
        assert len(pat) % spb == 0, (self.name, pat)
        total = sec.bars * spb
        return (pat * (total // len(pat) + 1))[:total]

    def chord_at(self, pos):
        for c in self.chords:
            if c[0] <= pos + 1e-9 < c[1]:
                return c
        return self.chords[-1]

    # buffers ----------------------------------------------------------------
    def begin(self, sec):
        self.buf_t0 = self.t(sec.b0)
        m = int(math.ceil((self.t(sec.b0 + sec.nb) - self.buf_t0 + SECTION_TAIL) * SR))
        self.buf = {k: np.zeros((2, m)) for k in STEMS}

    def end(self):
        i0 = int(round(self.buf_t0 * SR))
        for k in STEMS:
            b = self.buf[k]
            i1 = min(self.n, i0 + b.shape[1])
            self.out[k][:, i0:i1] += b[:, :i1 - i0]

    def add(self, stem, t, sig, pan=0.0, gain=1.0):
        buf = self.buf[stem]
        if sig.ndim == 1:
            l, r = pan_gains(pan)
            sig = np.vstack([sig * l, sig * r])
        i0 = int(round((t - self.buf_t0) * SR))
        if i0 < 0:
            sig, i0 = sig[:, -i0:], 0
        i1 = min(buf.shape[1], i0 + sig.shape[1])
        if i1 > i0:
            buf[:, i0:i1] += gain * sig[:, :i1 - i0]

    def hit(self, stem, inst, pos, vel):
        v = vel * DRUM_GAIN[inst] * self.rng.uniform(0.9, 1.05)
        self.add(stem, self.t(pos), self.kit.get(inst), DRUM_PAN[inst], v)


# ----------------------------------------------------------------------------
# Parts (pattern renderers).  Patterns: one char per 16th step, cycled per
# bar-multiple.  Drums: X x o g = velocities.  Notes: r root, f fifth,
# o octave, 3 third, x chord; '-' holds, '.' rests.
# ----------------------------------------------------------------------------
def p_drums(ctx, sec, stem, pats, gain=1.0, crash=False, fill=False):
    for inst, pat in pats.items():
        for s, ch in enumerate(ctx.seq(sec, pat)):
            if ch in VEL:
                ctx.hit(stem, inst, ctx.step_pos(sec, s), VEL[ch] * gain)
    if crash:
        ctx.hit(stem, "crash", sec.b0, gain)
    if fill:
        for j in range(4):
            ctx.hit(stem, "snare", sec.b0 + sec.nb - 1 + 0.25 * j, (0.45 + 0.18 * j) * gain)


def p_roll(ctx, sec, stem, gain=1.0, gap_last_beat=True):
    """Accelerating snare roll: quarters -> 8ths -> 16ths -> 32nds."""
    end = sec.nb - (1 if gap_last_beat else 0)
    for bar in range(sec.bars):
        frac = bar / sec.bars
        div = 1 if frac < 0.25 else 2 if frac < 0.5 else 4 if frac < 0.75 else 8
        for k in range(ctx.meter * div):
            rel = bar * ctx.meter + k / div
            if rel >= end - 1e-9:
                break
            ctx.hit(stem, "snare", sec.b0 + rel, (0.25 + 0.8 * rel / sec.nb) * gain)


def p_bass(ctx, sec, stem, pat, kind="saw", gain=0.6, low=28):
    for s0, s1, ch in iter_notes(ctx.seq(sec, pat), "rfo3"):
        p0, p1 = ctx.step_pos(sec, s0), ctx.step_pos(sec, s1)
        t0, t1 = ctx.t(p0), ctx.t(p1)
        _, _, pc, q, _, _ = ctx.chord_at(p0)
        base = low + (pc - low) % 12
        m = base + {"r": 0, "f": 7, "o": 12, "3": QUAL[q][1]}[ch]
        sig = synth_bass(kind, m, t1 - t0 - 0.012, ctx.rng.uniform(0.9, 1.0), ctx.rng)
        ctx.add(stem, t0, sig, 0.0, gain)


def p_chords(ctx, sec, stem, kind, pat=None, gain=0.3, low=53, fc=None, top=False):
    if pat is None:
        spans = [(max(c[0], sec.b0), min(c[1], sec.b0 + sec.nb)) for c in ctx.chords
                 if c[1] > sec.b0 and c[0] < sec.b0 + sec.nb]
    else:
        spans = [(ctx.step_pos(sec, a), ctx.step_pos(sec, b))
                 for a, b, _ in iter_notes(ctx.seq(sec, pat), "x")]
    for p0, p1 in spans:
        _, _, pc, q, _, _ = ctx.chord_at(p0)
        notes = chord_notes(pc, q, low)
        if top:
            notes.append(notes[0] + 12)
        t0 = ctx.t(p0)
        sig = synth_chord(kind, notes, ctx.t(p1) - t0 - 0.01, ctx.rng.uniform(0.85, 1.0), ctx.rng, fc)
        ctx.add(stem, t0, sig, 0.0, gain)


def p_arp(ctx, sec, stem, kind="pluck", rate=0.5, gain=0.2, low=60):
    pos, i = float(sec.b0), 0
    while pos < sec.b0 + sec.nb - 1e-9:
        _, _, pc, q, _, _ = ctx.chord_at(pos)
        tones = chord_notes(pc, q, low)
        tones = tones + [tones[0] + 12]
        cyc = tones + tones[-2:0:-1]
        m = cyc[i % len(cyc)]
        t0 = ctx.t(pos)
        sig = synth_tone(kind, m, (ctx.t(pos + rate) - t0) * 0.9, ctx.rng.uniform(0.75, 1.0), ctx.rng)
        ctx.add(stem, t0, sig, 0.3 if i % 2 else -0.3, gain)
        pos += rate
        i += 1


def p_lead(ctx, sec, stem, rhythms, gain=0.3, low=64, high=79):
    seq = "".join(rhythms[b % len(rhythms)] for b in range(sec.bars))
    prev = (low + high) // 2
    for s0, s1, _ in iter_notes(seq, "x"):
        p0, p1 = ctx.step_pos(sec, s0), ctx.step_pos(sec, s1)
        _, _, pc, q, _, _ = ctx.chord_at(p0)
        pcs = {(pc + i) % 12 for i in QUAL[q]}
        allowed = pcs if s0 % 4 == 0 else ctx.scale
        cands = np.array([m for m in range(low, high + 1) if m % 12 in allowed])
        w = np.exp(-np.abs(cands - prev) / 2.5)
        w[cands == prev] *= 0.5
        m = int(ctx.rng.choice(cands, p=w / w.sum()))
        prev = m
        t0 = ctx.t(p0)
        sig = synth_lead(m, ctx.t(p1) - t0 - 0.03, ctx.rng.uniform(0.8, 1.0), ctx.rng)
        ctx.add(stem, t0, sig, 0.0, gain)


def p_riser(ctx, sec, stem, gain=0.25, f0=300.0, f1=8000.0):
    t0, t1 = ctx.t(sec.b0), ctx.t(sec.b0 + sec.nb)
    n = int((t1 - t0) * SR)
    x = ctx.rng.standard_normal((2, n))
    nch = int(math.ceil(n / 512))
    fr = f0 * (f1 / f0) ** (np.arange(nch) / max(nch - 1, 1))
    y = tv_filter(x, [(f / 1.4, f * 1.4) for f in fr], "bandpass", 1)
    amp = (np.arange(n) / n) ** 2 * fade_out(n, 0.01)
    ctx.add(stem, t0, y * amp, 0.0, gain)


def fx_sweep(ctx, sec, stems, f0, f1):
    """Low-pass filter opening over the section (tail stays at f1)."""
    n_main = int((ctx.t(sec.b0 + sec.nb) - ctx.buf_t0) * SR)
    for k in stems:
        b = ctx.buf[k]
        nch = int(math.ceil(b.shape[1] / 512))
        frac = np.clip(np.arange(nch) * 512 / n_main, 0, 1)
        ctx.buf[k] = tv_filter(b, list(f0 * (f1 / f0) ** frac), "low", 2)


def fx_sidechain(ctx, sec, stems, depth=0.6):
    kt = np.array([ctx.t(sec.b0 + i) for i in range(sec.nb)])
    m = ctx.buf[stems[0]].shape[1]
    tt = ctx.buf_t0 + np.arange(m) / SR
    idx = np.searchsorted(kt, tt, side="right") - 1
    dt = np.where(idx >= 0, tt - kt[np.maximum(idx, 0)], 1e3)
    g = 1 - depth * np.exp(-dt / 0.11) * np.clip(dt / 0.004, 0, 1)
    for k in stems:
        ctx.buf[k] *= g


# ----------------------------------------------------------------------------
# Song specifications
# ----------------------------------------------------------------------------
def S(label, bars, prog, *parts, fx=(), events=()):
    return dict(label=label, bars=bars, prog=prog, parts=parts, fx=fx, events=events)


def D(**kw): return ("drums", p_drums, kw)
def Roll(**kw): return ("drums", p_roll, kw)
def B(**kw): return ("bass", p_bass, kw)
def C(**kw): return ("other", p_chords, kw)
def A(**kw): return ("other", p_arp, kw)
def Rs(**kw): return ("other", p_riser, kw)
def V(**kw): return ("vocals", p_lead, kw)


def song_edm_drop():
    prog = [("F:min", 4), ("Db:maj", 4), ("Ab:maj", 4), ("Eb:maj", 4)]
    hats = dict(chat="g.x.g.x.g.x.g.x.")
    four = dict(kick="x...x...x...x...", clap="....x.......x...",
                ohat="..x...x...x...x.", chat="gogogogogogogogo")
    lead = ["x-x-x-..x---x-x-", "x---x-x-x-----..", "x-x-x-..x---x-x-", "x-------x-x-x---"]
    sweep = [(fx_sweep, dict(stems=["other"], f0=400.0, f1=16000.0))]
    side = [(fx_sidechain, dict(stems=["bass", "other"], depth=0.65))]
    pad = C(kind="pad", gain=0.3, fc=1500.0)
    drop = (D(pats=four, crash=True), B(pat="r---------------", kind="sub", gain=0.55, low=29),
            C(kind="supersaw", gain=0.24, top=True))
    return dict(name="edm_drop", bpm=128, meter=4, key=("F", "minor"), offset=0.35, sections=[
        S("intro", 8, prog, D(pats=hats), pad),
        S("build", 8, prog, Roll(), D(pats=dict(chat="gogogogogogogogo")), C(kind="pad", gain=0.3),
          Rs(gain=0.22), fx=sweep, events=[(0, "build starts"), (31, "pre-drop gap")]),
        S("drop", 16, prog, *drop, fx=side, events=[(0, "kick enters")]),
        S("breakdown", 8, prog, C(kind="pad", gain=0.3, fc=2000.0), V(rhythms=lead, gain=0.3, low=65, high=80)),
        S("build", 4, prog, Roll(), D(pats=dict(chat="gogogogogogogogo")), C(kind="pad", gain=0.3),
          Rs(gain=0.22), fx=sweep, events=[(0, "build starts"), (15, "pre-drop gap")]),
        S("drop", 16, prog, *drop, A(kind="pluck", rate=0.25, gain=0.1, low=65),
          V(rhythms=lead, gain=0.3, low=65, high=80), fx=side),
        S("outro", 8, prog, D(pats=dict(kick="x...x...x...x...", chat="g.x.g.x.g.x.g.x.")), pad),
    ])


def song_house_groove():
    prog = [("A:min", 4), ("F:maj", 4), ("C:maj", 4), ("G:maj", 4)]
    hh = dict(chat="xgogxgogxgogxgog", ohat="..x...x...x...x.")
    full = dict(kick="x...x...x...x...", clap="....x.......x...", **hh)
    boff = B(pat="..r...r...r...r.", kind="saw", gain=0.5, low=33)
    bch = B(pat="..r...r.o.r...rf", kind="saw", gain=0.5, low=33)
    stab = C(kind="stab", pat="x..x..x...x..x..", gain=0.3, low=57)
    pad = C(kind="pad", gain=0.2, fc=2200.0)
    lead = ["x-x-x---x-x-....", "x---x---x-x-x---", "..x-x-x-x---x---", "x-----------...."]
    voc = V(rhythms=lead, gain=0.28, low=64, high=79)
    return dict(name="house_groove", bpm=122, meter=4, key=("A", "minor"), offset=0.42, sections=[
        S("intro", 8, prog, D(pats=hh), boff, pad),
        S("verse", 16, prog, D(pats=full), boff, stab, events=[(0, "kick enters")]),
        S("chorus", 16, prog, D(pats=full, crash=True), bch, pad, stab, voc),
        S("breakdown", 8, prog, D(pats=hh, gain=0.7), pad, events=[(0, "kick out")]),
        S("chorus", 16, prog, D(pats=full, crash=True), bch, pad, stab, voc, events=[(0, "kick enters")]),
        S("outro", 4, prog, D(pats=full), pad),
    ])


def song_pop_ballad():
    prog = [("Eb:maj", 4), ("Bb:maj", 4), ("C:min", 4), ("Ab:maj", 4)]
    bridge = [("C:min", 4), ("Ab:maj", 4), ("Eb:maj", 4), ("Bb:maj", 4)]
    dv = dict(kick="x.........x.....", snare="........o.......", chat="o...o...o...o...")
    dc = dict(kick="x......x..x.....", snare="........x.......", chat="x.o.x.o.x.o.x.o.")
    db = dict(kick="x...............", chat="o...o...o...o...")
    lv = ["x-.x-.x-x---....", "..x-x-x-x-----..", "x-.x-.x-x-x-x---", "....x-x-x-------"]
    lc = ["x---x---x-x-x---", "x-x-x---x-------", "x---x---x-x-x-x-", "x-----x-x-------"]
    arp = A(kind="keys", rate=0.5, gain=0.32, low=55)
    bw = B(pat="r---------------", kind="upright", gain=0.55, low=27)
    chorus = (C(kind="keys", pat="x-------x-------", gain=0.4, low=55), C(kind="pad", gain=0.13, fc=2500.0),
              B(pat="r-------r---f---", kind="upright", gain=0.55, low=27), D(pats=dc, crash=True),
              V(rhythms=lc, gain=0.3, low=65, high=80))
    verse = (arp, bw, V(rhythms=lv, gain=0.27, low=63, high=77))
    return dict(name="pop_ballad", bpm=76, meter=4, key=("Eb", "major"), offset=0.27, sections=[
        S("intro", 2, prog, arp),
        S("verse", 8, prog, *verse, D(pats=dv, gain=0.8, fill=True)),
        S("chorus", 8, prog, *chorus),
        S("verse", 8, prog, *verse, D(pats=dv, gain=0.8, fill=True)),
        S("chorus", 8, prog, *chorus),
        S("bridge", 4, bridge, C(kind="pad", gain=0.18), arp, bw, D(pats=db, gain=0.8, fill=True),
          V(rhythms=lv, gain=0.27, low=63, high=77)),
        S("chorus", 8, prog, *chorus),
    ])


def song_waltz():
    prog = [("G:maj", 6), ("E:min", 6), ("C:maj", 6), ("D:maj", 6)]
    dv = dict(kick="x...........", snare="....g...g...", chat="x.g.o.g.o.g.")
    dc = dict(kick="x...........", snare="....o...o...", chat="x.g.o.g.o.g.", ohat="x.......................")
    bass = B(pat="r---........f---........", kind="upright", gain=0.55, low=31)
    pah = C(kind="keys", pat="....x-..x-..", gain=0.4, low=55)
    lead = ["x-----x---x-", "x-----------", "x---x---x---", "x-------x---"]
    chorus = (D(pats=dc, crash=True), bass, pah, C(kind="pad", gain=0.13, fc=2200.0),
              V(rhythms=lead, gain=0.28, low=67, high=81))
    return dict(name="waltz", bpm=150, meter=3, key=("G", "major"), offset=0.31, sections=[
        S("intro", 4, prog, bass, pah),
        S("verse", 16, prog, D(pats=dv), bass, pah),
        S("chorus", 16, prog, *chorus),
        S("verse", 16, prog, D(pats=dv), bass, pah),
        S("chorus", 16, prog, *chorus),
        S("outro", 4, [("C:maj", 3), ("D:maj", 3), ("G:maj", 6)], bass, C(kind="pad", gain=0.2)),
    ])


def song_dnb():
    prog = [("D:min", 8), ("Bb:maj", 8), ("G:min", 8), ("A:maj", 8)]
    main = dict(kick="x.........x....." * 3 + "x.x.......x.....",
                snare="....x.......x..." * 3 + "....x..g.g..x..o",
                chat="xgogxgogxgogxgog")
    hats = dict(chat="x.o.x.o.x.o.x.o.")
    lead = ["x-------x-------", "x---x---x-------", "x-------x---x---", "x---------------"]
    pad = C(kind="pad", gain=0.22, fc=1800.0)
    drop = (D(pats=main, crash=True), B(pat="r-------..r-----", kind="reese", gain=0.5, low=26), pad,
            C(kind="stab", pat="x.....x.........", gain=0.2, low=62))
    return dict(name="dnb", bpm=174, meter=4, key=("D", "minor"), offset=0.46, sections=[
        S("intro", 8, prog, D(pats=hats, gain=0.8), pad),
        S("drop", 32, prog, *drop),
        S("breakdown", 8, prog, pad, V(rhythms=lead, gain=0.3, low=62, high=77)),
        S("drop", 32, prog, *drop, V(rhythms=lead, gain=0.3, low=62, high=77)),
        S("outro", 8, prog, D(pats=hats, gain=0.8), pad),
    ])


def song_lofi_swing():
    prog = [("Bb:maj7", 4), ("G:min7", 4), ("C:min7", 4), ("F:7", 4)]
    dv = dict(kick="x......x..x.....", snare="....x.......x...", chat="xgogxgogxgogxgog")
    dc = dict(dv, ohat="......x.......x.")
    rh = C(kind="rhodes", pat="x-----.x--------", gain=0.45, low=53)
    bass = B(pat="r-----..f---..o.", kind="upright", gain=0.55, low=34)
    lead = ["x--x--x-x-------", "..x-x-.x--------", "x--x--x-x--x-x--", "x-----------...."]
    chorus = (D(pats=dc, crash=True), bass, rh, C(kind="pad", gain=0.1, fc=1500.0),
              V(rhythms=lead, gain=0.27, low=65, high=79))
    return dict(name="lofi_swing", bpm=88, meter=4, key=("Bb", "major"), offset=0.38, swing=0.62, sections=[
        S("intro", 4, prog, rh),
        S("verse", 8, prog, D(pats=dv, gain=0.85), bass, rh),
        S("chorus", 8, prog, *chorus),
        S("verse", 8, prog, D(pats=dv, gain=0.85), bass, rh),
        S("chorus", 8, prog, *chorus),
        S("outro", 4, prog, rh, bass),
    ])


def song_tempo_ramp():
    prog = [("C:maj", 4), ("A:min", 4), ("F:maj", 4), ("G:maj", 4)]
    pop = dict(kick="x.......x.x.....", snare="....x.......x...", chat="x.x.x.x.x.x.x.x.")
    keys = C(kind="keys", pat="x---x---x---x---", gain=0.4, low=55)
    bv = B(pat="r---r---f---r---", kind="saw", gain=0.5, low=36)
    lead = ["x-x-x---x-x-x---", "x---x---x-------", "x-x-x-x-x---x---", "x-----------...."]
    return dict(name="tempo_ramp", bpm=110, bpm_ramp=(100.0, 120.0), meter=4, key=("C", "major"),
                offset=0.25, sections=[
        S("intro", 4, prog, keys),
        S("verse", 16, prog, D(pats=pop), bv, keys),
        S("chorus", 16, prog, D(pats=pop, crash=True), B(pat="r.r.r.r.f.f.o.r.", kind="saw", gain=0.5, low=36),
          C(kind="pad", gain=0.15), keys, V(rhythms=lead, gain=0.28, low=64, high=79)),
        S("verse", 8, prog, D(pats=pop), bv, keys),
        S("outro", 4, prog, keys, bv),
    ])


SONGS = {f.__name__[5:]: f for f in (song_edm_drop, song_house_groove, song_pop_ballad, song_waltz,
                                     song_dnb, song_lofi_swing, song_tempo_ramp)}


# ----------------------------------------------------------------------------
# Rendering + truth
# ----------------------------------------------------------------------------
def r4(x):
    return round(float(x), 4)


def merge_intervals(iv):
    out = []
    for a, b in iv:
        if out and abs(out[-1][1] - a) < 1e-6:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [[r4(a), r4(b)] for a, b in out]


def render(spec):
    ctx = Ctx(spec)
    secs, b = [], 0
    for s in spec["sections"]:
        nb = s["bars"] * ctx.meter
        sec = SimpleNamespace(b0=b, nb=nb, **s)
        pos, i = b, 0
        while pos < b + nb:
            ch, d = s["prog"][i % len(s["prog"])]
            d = min(d, b + nb - pos)
            ctx.chords.append((pos, pos + d) + parse_chord(ch))
            pos, i = pos + d, i + 1
        secs.append(sec)
        b += nb

    for sec in secs:
        ctx.begin(sec)
        for stem, fn, kw in sec.parts:
            fn(ctx, sec, stem, **kw)
        for fn, kw in sec.fx:
            fn(ctx, sec, **kw)
        ctx.end()

    # final fade + normalisation (same linear gain on every stem)
    fade = fade_out(ctx.n, 0.4)
    mix = sum(ctx.out[k] for k in STEMS) * fade
    g = 10 ** (-1 / 20) / (np.max(np.abs(mix)) + 1e-12)
    stems = {k: (ctx.out[k] * fade * g).astype(np.float32) for k in STEMS}
    mix = sum(stems[k].astype(np.float64) for k in STEMS).astype(np.float32)

    # truth
    T = ctx.t
    beats = [r4(x) for x in ctx.beat_times[:-1]]
    chords = [dict(start=0.0, end=r4(ctx.offset), label="N", full="N")]
    for p0, p1, _, _, lab, full in ctx.chords:
        if chords[-1]["full"] == full:
            chords[-1]["end"] = r4(T(p1))
        else:
            chords.append(dict(start=r4(T(p0)), end=r4(T(p1)), label=lab, full=full))
    chords.append(dict(start=r4(ctx.end_time), end=r4(ctx.duration), label="N", full="N"))

    present = {k: [] for k in STEMS}
    events, prev = [], set()
    for sec in secs:
        cur = {stem for stem, _, _ in sec.parts}
        t0, t1 = T(sec.b0), T(sec.b0 + sec.nb)
        for k in STEMS:
            if k in cur:
                present[k].append((t0, t1))
                if k not in prev:
                    events.append(dict(t=r4(t0), what=f"{k} in"))
            elif k in prev:
                events.append(dict(t=r4(t0), what=f"{k} out"))
        if sec.label == "drop":
            events.append(dict(t=r4(t0), what="drop"))
        for off, what in sec.events:
            events.append(dict(t=r4(T(sec.b0 + off)), what=what))
        prev = cur
    events.append(dict(t=r4(ctx.end_time), what="music ends"))
    events.sort(key=lambda e: e["t"])

    truth = dict(
        name=ctx.name, duration=r4(ctx.n / SR), sample_rate=SR, bpm=spec["bpm"], meter=ctx.meter,
        key=dict(tonic=ctx.key[0], mode=ctx.key[1]),
        beats=beats, downbeats=beats[::ctx.meter],
        chords=chords,
        sections=[dict(start=r4(T(s.b0)), end=r4(T(s.b0 + s.nb)), label=s.label) for s in secs],
        stems_present={k: merge_intervals(v) for k, v in present.items()},
        events=events,
        offset=ctx.offset,
    )
    if "swing" in spec:
        truth["swing"] = spec["swing"]
    if "bpm_ramp" in spec:
        truth["bpm_start"], truth["bpm_end"] = spec["bpm_ramp"]
    return mix, stems, truth


def write_song(args):
    name, out = args
    t0 = time.time()
    mix, stems, truth = render(SONGS[name]())
    sf.write(os.path.join(out, f"{name}.wav"), mix.T, SR, subtype="FLOAT")
    sd = os.path.join(out, f"{name}.stems")
    os.makedirs(sd, exist_ok=True)
    for k, v in stems.items():
        sf.write(os.path.join(sd, f"{k}.wav"), v.T, SR, subtype="FLOAT")
    with open(os.path.join(out, f"{name}.truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    return name, time.time() - t0, truth["duration"]


def check(out, names):
    """Reload outputs and print sanity metrics."""
    for name in names:
        mix, sr = sf.read(os.path.join(out, f"{name}.wav"), dtype="float64")
        tot = sum(sf.read(os.path.join(out, f"{name}.stems", f"{k}.wav"), dtype="float64")[0] for k in STEMS)
        with open(os.path.join(out, f"{name}.truth.json")) as f:
            tr = json.load(f)
        peak = 20 * np.log10(np.max(np.abs(mix)))
        print(f"{name}: {len(mix) / sr:.2f}s (truth {tr['duration']}), bpm {tr['bpm']}, meter {tr['meter']}, "
              f"key {tr['key']['tonic']} {tr['key']['mode']}, peak {peak:.2f} dBFS, "
              f"max|sum(stems)-mix| {np.max(np.abs(tot - mix)):.2e}, beats {len(tr['beats'])}")
        lead = np.max(np.abs(mix[:int(tr['beats'][0] * sr) - 10]))
        print(f"   pre-roll peak {lead:.1e}")
        for s in tr["sections"]:
            seg = mix[int(s["start"] * sr):int(s["end"] * sr)]
            rms = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12)
            print(f"   {s['label']:<10} {s['start']:8.2f}-{s['end']:8.2f}  rms {rms:6.1f} dB")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="/tmp/synth")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", nargs="+", metavar="NAME")
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument("--check", action="store_true", help="print sanity metrics after rendering")
    a = ap.parse_args(argv)
    if a.list:
        print("\n".join(SONGS))
        return 0
    names = a.only or list(SONGS)
    bad = [n for n in names if n not in SONGS]
    if bad:
        ap.error(f"unknown song(s): {bad}; choose from {list(SONGS)}")
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    jobs = [(n, a.out) for n in names]
    if a.jobs > 1 and len(jobs) > 1:
        with ProcessPoolExecutor(max_workers=a.jobs) as ex:
            results = list(ex.map(write_song, jobs))
    else:
        results = [write_song(j) for j in jobs]
    for name, dt, dur in results:
        print(f"{name:<14} {dur:7.2f}s  rendered in {dt:5.1f}s")
    print(f"total {time.time() - t0:.1f}s -> {a.out}")
    if a.check:
        check(a.out, names)
    return 0


if __name__ == "__main__":
    sys.exit(main())
