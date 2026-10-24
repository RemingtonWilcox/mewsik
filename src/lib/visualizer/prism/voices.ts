// Prism's ensemble: every part of the window answers its own part of the band.
//
// The rose is many small parts (the cubies of the owner's Rubik's cube): three
// rings of glass, the petals around them, the tracery, the neighbouring bays
// on each side, the sun's shafts, the clerestory beams, two layers of haze,
// the light pools on the floor, the candles, the dust and the camera. Each
// carries its own state and listens to its own instrument:
//
// - heard kicks send packets of light through the inner ring (in the look's
//   beat form), snare cracks run through the middle ring, hats glint on single
//   panes of the outer ring, and a fill cascades around the rose petal by
//   petal. Nothing here reads the predicted beat clock;
// - each ring is voiced by a chord: its colour temperature and hue relation
//   follow the chord's quality (major warm and open, minor cool, diminished
//   tense and clustered, augmented split in thirds, suspended pale), and a
//   chord change re-voices one ring at a time, so the glass holds the last
//   three chords like three voices of a progression;
// - each petal glows with the pitch class it stands for (circle of fifths
//   round the rose), so the chord's tones light their own petals;
// - the bass line walks the low light: the pools the sun throws on the floor
//   move with the bass note and swell with its level;
// - legato lengthens every packet's decay and the trails, staccato cuts them
//   short; swing leans the packets off-centre; a breakdown withdraws the
//   rings one by one from the outside in; a build gathers them back.
//
// On top of those authored bindings a modulation matrix (modulation.ts)
// routes the rest: the rings' glow, the bays on each side, the shafts, the
// haze layers, the floor, the dust, the candles, the tracery, the camera's
// restlessness, the rose's turn. Its routes wander and re-route over time, so
// which part answers which instrument keeps changing without cuts.
//
// Pure state, no renderer: deterministic per seed, and it lives in the look
// so a new song carries it on and a remount resumes it.

import type { EnsembleFrame, EnsembleLayer } from '../ensemble';
import { ModMatrix, type ModPart, type ModSource } from '../modulation';
import { noise1 } from '../motion';

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

function approach(current: number, target: number, rate: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function smooth01(value: number, low: number, high: number): number {
	const t = clamp((value - low) / (high - low), 0, 1);
	return t * t * (3 - 2 * t);
}

// ── Sources: the ensemble channels the matrix may route ─────────────────────
export const PRISM_MOD_SOURCES: readonly ModSource[] = [
	{ name: 'kick.hit', impulse: true, family: 'drums' },
	{ name: 'snare.hit', impulse: true, family: 'drums' },
	{ name: 'hat.hit', impulse: true, family: 'drums' },
	{ name: 'perc.hit', impulse: true, family: 'drums' },
	{ name: 'notes.hit', impulse: true, family: 'articulation' },
	{ name: 'kick.activity', family: 'drums' },
	{ name: 'snare.activity', family: 'drums' },
	{ name: 'hat.activity', family: 'drums' },
	{ name: 'groove.swing', family: 'groove' },
	{ name: 'groove.syncopation', family: 'groove' },
	{ name: 'groove.fill', impulse: true, family: 'groove' },
	{ name: 'groove.breakdown', family: 'groove' },
	{ name: 'harmony.tension', family: 'harmony' },
	{ name: 'harmony.change', impulse: true, family: 'harmony' },
	{ name: 'harmony.major', family: 'harmony' },
	{ name: 'harmony.minor', family: 'harmony' },
	{ name: 'harmony.confidence', family: 'harmony' },
	{ name: 'bass.level', family: 'bass' },
	{ name: 'bass.note', impulse: true, family: 'bass' },
	{ name: 'bass.walking', family: 'bass' },
	{ name: 'bass.height', family: 'bass' },
	{ name: 'articulation.legato', family: 'articulation' },
	{ name: 'articulation.sustain', family: 'articulation' },
	{ name: 'articulation.pad', family: 'articulation' },
	{ name: 'texture.density', family: 'texture' },
	{ name: 'texture.build', family: 'texture' },
	{ name: 'texture.register', signed: true, family: 'texture' },
	{ name: 'texture.width', family: 'texture' },
	{ name: 'texture.high', family: 'texture' },
	{ name: 'texture.low', family: 'texture' }
];

/** Fill the matrix's channel array from the ensemble (zeros in silence). */
export function prismFillChannels(e: EnsembleFrame, out: Float32Array, live: boolean): Float32Array {
	if (!live) {
		out.fill(0);
		// Signed register rests at its centre, not at its low end.
		out[26] = 0;
		return out;
	}
	const d = e.drums;
	const q = e.harmony.qualities;
	const v = (x: number) => clamp(finite(x), 0, 1);
	out[0] = v(d.kick.hit);
	out[1] = v(d.snare.hit);
	out[2] = v(d.hat.hit);
	out[3] = v(d.perc.hit);
	out[4] = v(e.notes.hit);
	out[5] = v(d.kick.activity);
	out[6] = v(d.snare.activity);
	out[7] = v(d.hat.activity);
	out[8] = v(e.groove.swing);
	out[9] = v(e.groove.syncopation);
	out[10] = v(Math.max(e.groove.fill, e.groove.fillIntensity * 0.8));
	out[11] = v(e.groove.breakdown);
	out[12] = v(e.harmony.tension);
	out[13] = v(e.harmony.change);
	out[14] = v((q[0] ?? 0) + (q[5] ?? 0) * 0.6);
	out[15] = v((q[1] ?? 0) + (q[2] ?? 0) * 0.5);
	out[16] = v(e.harmony.confidence);
	out[17] = v(e.bass.level);
	out[18] = v(e.bass.note);
	out[19] = v(e.bass.walking);
	out[20] = e.bass.pitchClass >= 0 ? v(e.bass.pitchClass / 11) : 0.5;
	out[21] = v(e.articulation.legato);
	out[22] = v(e.articulation.sustain);
	out[23] = v(e.articulation.pad);
	out[24] = v(e.texture.density);
	out[25] = v(e.texture.build);
	out[26] = clamp(finite(e.texture.register), -1, 1);
	out[27] = v(e.texture.width);
	out[28] = v(e.texture.high);
	out[29] = v(e.texture.low);
	return out;
}

// ── Parts: what the matrix drives ───────────────────────────────────────────
/** Hits belong to the local packets; parts that cover a whole ring, the
 * whole window or the whole nave only listen to slower channels, so a hit
 * never pulses the frame as one block. */
const HITS = PRISM_MOD_SOURCES.filter((source) => source.impulse).map((source) => source.name);

export const PRISM_MOD_PARTS: readonly ModPart[] = [
	{ name: 'innerRing', params: [{ name: 'glow', avoid: HITS, prefers: ['bass', 'harmony'], rest: 0.55, depth: 0.7, smooth: 0.6 }] },
	{ name: 'middleRing', params: [{ name: 'glow', avoid: HITS, prefers: ['harmony', 'articulation'], rest: 0.55, depth: 0.7, smooth: 0.6 }] },
	{ name: 'outerRing', params: [{ name: 'glow', avoid: HITS, prefers: ['texture', 'groove'], rest: 0.5, depth: 0.75, smooth: 0.6 }] },
	{ name: 'petals', params: [{ name: 'contrast', avoid: HITS, prefers: ['harmony', 'articulation'], rest: 0.55, depth: 0.6, smooth: 0.4 }] },
	{
		name: 'tracery',
		params: [
			{ name: 'glow', avoid: HITS, prefers: ['articulation', 'drums'], rest: 0.4, depth: 0.8 },
			{ name: 'edge', avoid: HITS, prefers: ['articulation', 'groove'], rest: 0.5, depth: 0.6, smooth: 0.5 }
		]
	},
	{ name: 'bayLeft', params: [{ name: 'lit', avoid: HITS, prefers: ['texture', 'harmony'], rest: 0.5, depth: 0.85, smooth: 0.25 }] },
	{ name: 'bayRight', params: [{ name: 'lit', avoid: HITS, prefers: ['texture', 'groove'], rest: 0.5, depth: 0.85, smooth: 0.25 }] },
	{
		name: 'sun',
		params: [
			{ name: 'power', avoid: HITS, prefers: ['articulation', 'harmony'], rest: 0.5, depth: 0.4, smooth: 4 },
			{ name: 'hotspot', avoid: HITS, prefers: ['bass', 'harmony'], rest: 0.5, depth: 0.4, smooth: 4 }
		]
	},
	{ name: 'clerestory', params: [{ name: 'power', avoid: HITS, prefers: ['groove', 'texture'], rest: 0.45, depth: 0.6, smooth: 3 }] },
	{ name: 'hazeLow', params: [{ name: 'density', avoid: HITS, prefers: ['bass', 'drums'], rest: 0.5, depth: 0.45, smooth: 4 }] },
	{ name: 'hazeHigh', params: [{ name: 'density', avoid: HITS, prefers: ['articulation', 'harmony'], rest: 0.5, depth: 0.45, smooth: 4 }] },
	{
		name: 'floor',
		params: [
			{ name: 'pool', prefers: ['bass', 'drums'], rest: 0.5, depth: 0.8 },
			{ name: 'caustic', prefers: ['drums', 'texture'], rest: 0.45, depth: 0.8 }
		]
	},
	{
		name: 'dust',
		params: [
			{ name: 'density', avoid: HITS, prefers: ['texture', 'groove'], rest: 0.5, depth: 0.7, smooth: 0.6 },
			{ name: 'glint', prefers: ['drums', 'texture'], rest: 0.3, depth: 0.9 }
		]
	},
	{ name: 'candles', params: [{ name: 'flicker', prefers: ['drums', 'articulation'], rest: 0.45, depth: 0.9 }] },
	{ name: 'camera', params: [{ name: 'restless', avoid: HITS, prefers: ['texture', 'groove'], rest: 0.5, depth: 0.7, smooth: 2.5 }] },
	{ name: 'rose', params: [{ name: 'turn', avoid: HITS, prefers: ['articulation', 'groove'], rest: 0.5, depth: 0.7, smooth: 2 }] },
	{ name: 'mosaic', params: [{ name: 'growth', avoid: HITS, prefers: ['texture', 'harmony'], rest: 0.5, depth: 0.7, smooth: 1 }] },
	{ name: 'trails', params: [{ name: 'length', avoid: HITS, prefers: ['articulation', 'texture'], rest: 0.5, depth: 0.7, smooth: 0.8 }] }
];

// ── Heard packets ──────────────────────────────────────────────────────────
/**
 * One instrument's light in the glass: latched when the layer is heard (its
 * serial moves), then aged on the look's own clock over a duration the
 * articulation stretches or cuts. The serial the shader hashes is the look's
 * own, so a new song's counters never jump the shapes.
 */
export class HeardPacket {
	/** The look's own count of answered hits. */
	serial = 0;
	/** Seconds since the last answered hit. */
	age = 10;
	strength = 0;
	/** The layer serial last answered (null: not seen yet). */
	private seen: number | null = null;

	/**
	 * Advance; returns true on the tick a new hit is answered. `minGap` keeps
	 * a roll or a flam one packet.
	 */
	update(serial: number, strength: number, dt: number, live: boolean, minGap = 0.05): boolean {
		this.age += Math.max(0, dt);
		const s = finite(serial, 0);
		if (this.seen === null) {
			this.seen = s;
			return false;
		}
		if (s === this.seen) return false;
		this.seen = s;
		if (!live || this.age < minGap) return false;
		this.serial += 1;
		this.age = 0;
		this.strength = clamp(finite(strength), 0, 1.5);
		return true;
	}

	/** 0..1 progress through a packet that lasts `duration` seconds. */
	progress(duration: number): number {
		return clamp(this.age / Math.max(0.05, duration), 0, 1);
	}
}

// ── Breakdown ──────────────────────────────────────────────────────────────
/**
 * How far one petal of one ring has withdrawn, 0..1, `withdraw` seconds into
 * a breakdown: the petals go out one by one in the look's own order (`rank`
 * 0..1 per petal), the outer ring's first and deepest, the inner ring's last
 * and only part way; when the drums return they relight in reverse. Mirrored
 * by petalWithdraw in the shader.
 */
export function prismPetalWithdraw(withdraw: number, rank: number, ring: number): number {
	const k = clamp(ring, 0, 2);
	const start = 0.4 + (2 - k) * 0.9 + clamp(rank, 0, 1) * 5;
	return smooth01(finite(withdraw), start, start + 1.2) * [0.45, 0.6, 0.75][Math.round(k)];
}

// ── Chord voicing of a ring ──────────────────────────────────────────────────
export type RingVoice = {
	/** Hue rotation inside the palette family, radians. */
	hue: number;
	/** Colour temperature, -1 cold .. 1 warm. */
	warmth: number;
	/** Saturation multiplier. */
	sat: number;
	/** Value multiplier. */
	value: number;
};

/** Order of ENSEMBLE_CHORD_QUALITIES: major, minor, diminished, augmented, suspended, dominant7, none. */
const QUALITY_WARMTH = [0.75, -0.7, -0.35, 0.15, 0.05, 0.5, 0];
/** How far a quality fans the three rings apart in hue (radians per ring step). */
const QUALITY_SPREAD = [0.32, 0.12, 0.03, 0.62, 0.2, 0.26, 0.08];
/** Base hue lean of the quality (minor leans blue-ward, dominant7 toward the accent). */
const QUALITY_LEAN = [0.05, -0.3, 0.12, 0.2, -0.05, 0.22, 0];
const QUALITY_SAT = [1.08, 0.88, 1.18, 1.05, 0.72, 1.1, 0.9];
const QUALITY_VALUE = [1.08, 0.86, 0.8, 1.0, 0.95, 1.04, 0.92];

/**
 * How a chord voices one ring. Major is warm and open (the rings fanned a
 * consonant step apart), minor cool and narrower, diminished tense and
 * clustered (the rings huddle on one hue, saturated and dark), augmented
 * splits the rings in thirds, suspended is pale and open, a dominant seventh
 * warm with a lean. The root turns the ring a little round the circle of
 * fifths, so I-IV-V in one key read as related but distinct.
 */
export function prismChordVoicing(qualities: ArrayLike<number>, root: number, tension: number, ring: number): RingVoice {
	let total = 0;
	let warmth = 0;
	let spread = 0;
	let lean = 0;
	let sat = 0;
	let value = 0;
	for (let i = 0; i < 7; i += 1) {
		const p = Math.max(0, finite(qualities[i] ?? 0));
		total += p;
		warmth += p * QUALITY_WARMTH[i];
		spread += p * QUALITY_SPREAD[i];
		lean += p * QUALITY_LEAN[i];
		sat += p * QUALITY_SAT[i];
		value += p * QUALITY_VALUE[i];
	}
	if (total < 1e-4) return { hue: 0, warmth: 0, sat: 1, value: 1 };
	warmth /= total;
	spread /= total;
	lean /= total;
	sat /= total;
	value /= total;
	const fifths = root >= 0 ? ((Math.round(root) * 7) % 12) / 12 : 0.5;
	const rootTurn = (fifths - 0.5) * 0.36;
	// Rings sit at -1, 0, 1 around the chord's centre hue.
	const step = clamp(ring, 0, 2) - 1;
	const t = clamp(finite(tension), 0, 1);
	return {
		hue: lean + rootTurn + step * spread * (1 - t * 0.5),
		warmth: clamp(warmth + step * 0.12 * (1 - t), -1, 1),
		sat: clamp(sat * (1 + t * 0.12), 0.6, 1.3),
		value: clamp(value * (1 - t * 0.1), 0.7, 1.15)
	};
}

type VoicedRing = {
	/** The chord the ring sings now, and the one it is leaving. */
	voice: RingVoice;
	prev: RingVoice;
	/** Seconds since this ring was last re-voiced. */
	since: number;
	/** 0..1: how far round the ring the new chord has travelled. */
	sweep: number;
	/** Seconds the new chord takes to travel round (legato slow, staccato quick). */
	sweepSecs: number;
	/** Where round the ring it set out, radians. */
	start: number;
};

/** A voice part of the way from a to b. */
function mixVoice(a: RingVoice, b: RingVoice, t: number): RingVoice {
	const s = clamp(t, 0, 1);
	return {
		hue: a.hue + (b.hue - a.hue) * s,
		warmth: a.warmth + (b.warmth - a.warmth) * s,
		sat: a.sat + (b.sat - a.sat) * s,
		value: a.value + (b.value - a.value) * s
	};
}

const neutralVoice = (): RingVoice => ({ hue: 0, warmth: 0, sat: 1, value: 1 });

// ── The voices ──────────────────────────────────────────────────────────────
export type PrismVoiceInput = {
	ensemble: EnsembleFrame;
	dt: number;
	/** Music is playing (not held silence). */
	live: boolean;
	/** 0..1 energy, for restlessness of the routing. */
	energy: number;
	/** A character shift to answer now (0 none). */
	reroute: number;
};

/** Everything the shader and the renderer read from the ensemble, per frame. */
export type PrismVoiceFrame = {
	/**
	 * Each ring's chord, the chord it is leaving, and how far round the ring
	 * the new one has travelled (0..1) from where it set out (radians): a
	 * re-voicing flows round its ring piece by piece instead of recolouring
	 * the whole ring at once.
	 */
	rings: [RingVoice, RingVoice, RingVoice];
	ringsPrev: [RingVoice, RingVoice, RingVoice];
	ringSweep: [number, number, number];
	ringStart: [number, number, number];
	/** Per-ring light: matrix glow and a build gathering. */
	ringLight: [number, number, number];
	/** How strongly the petals follow the chord's pitch classes (0..1). */
	petalContrast: number;
	/** Twelve pitch-class weights 0..1, smoothed. */
	chroma: Float32Array;
	/** Kicks light an arc of the inner ring: its centre angle and half-width (radians). */
	kick: { strength: number; progress: number; serial: number; angle: number; width: number };
	snare: { strength: number; progress: number; serial: number; angle: number };
	/** Hats glint in one arc of the outer ring that wanders round the rose. */
	hat: { strength: number; progress: number; serial: number; density: number; angle: number; width: number };
	fill: { strength: number; progress: number; serial: number; angle: number; direction: number };
	/** A heard note: the petal of its pitch class (position on the circle of fifths, 0..11). */
	note: { strength: number; progress: number; fifths: number };
	/** Seconds the drums have been out in a breakdown (falls fast when they return). */
	withdraw: number;
	/** Swing as a lean of the packets, -1..1 (sign alternates per bar). */
	swingLean: number;
	/** Floor light shift (world x, z) and power; haze near the floor. */
	low: { x: number; z: number; power: number; haze: number };
	bays: { left: number; right: number; spread: number };
	/** Events in the neighbouring bays: a flare in one part of the glass (pulse, angle) per side. */
	bayFlare: { left: number; right: number; leftAngle: number; rightAngle: number };

	sun: { power: number; hotspot: number };
	clerestory: number;
	hazeHigh: number;
	caustic: number;
	dust: { density: number; glint: number };
	candles: number;
	tracery: { glow: number; edge: number };
	cameraRestless: number;
	turn: number;
	growth: number;
	/** Legato: trails and decays lengthen, -1 staccato .. 1 legato. */
	sustain: number;
	trails: number;
};

export class PrismVoices {
	readonly matrix: ModMatrix;
	private readonly channels = new Float32Array(PRISM_MOD_SOURCES.length);
	readonly kick = new HeardPacket();
	readonly snare = new HeardPacket();
	readonly hat = new HeardPacket();
	readonly fill = new HeardPacket();
	/** Tonal onsets: a melody note lights the petal of its pitch class. */
	readonly note = new HeardPacket();
	private notePitch = 0;
	private readonly salt: number;
	private readonly rings: [VoicedRing, VoicedRing, VoicedRing];
	/** Harmony change serial last answered (null: not seen yet). */
	private chordSeen: number | null = null;
	/** Count of re-voicings, for the order rings take their turn. */
	private revoiced = 0;
	private revoicedSeen = 0;
	private readonly chroma = new Float32Array(12);
	/** The bass note as a smoothed position on the circle of fifths (x, z). */
	private bassX = 0;
	private bassZ = 0;
	private bassPower = 0;
	private legato = 0.5;
	/** Breakdown withdrawal clock: seconds the drums have been out. */
	private withdraw = 0;
	private snareAngle = 0;

	/** The neighbouring bays' own events: percussion on one side, chord changes on the other. */
	private percPulse = 0;
	private chordPulse = 0;
	private percSeen: number | null = null;
	private percAngle = 0;
	private chordAngle = 0;
	private kickAngle = 0;
	private fillAngle = 0;
	private fillDirection = 1;
	private swing = 0;
	private clock = 0;
	/** "part.param" to its index in the matrix's values. */
	private readonly index = new Map<string, number>();
	readonly frame: PrismVoiceFrame;

	constructor(seed: number) {
		const s = clamp(finite(seed, 0.5), 0, 1);
		this.salt = Math.floor(s * 0xffff);
		this.matrix = new ModMatrix(PRISM_MOD_SOURCES, PRISM_MOD_PARTS, `prism-voices:${this.salt}`, {
			meanHold: 26,
			crossfade: 3.5
		});
		for (const part of PRISM_MOD_PARTS) {
			part.params.forEach((param, j) => this.index.set(`${part.name}.${param.name}`, this.matrix.offset(part.name) + j));
		}
		const ring = (): VoicedRing => ({ voice: neutralVoice(), prev: neutralVoice(), since: 0, sweep: 1, sweepSecs: 2, start: 0 });
		this.rings = [ring(), ring(), ring()];
		this.frame = {
			rings: [neutralVoice(), neutralVoice(), neutralVoice()],
			ringsPrev: [neutralVoice(), neutralVoice(), neutralVoice()],
			ringSweep: [1, 1, 1],
			ringStart: [0, 0, 0],
			ringLight: [1, 1, 1],
			petalContrast: 0,
			chroma: this.chroma,
			kick: { strength: 0, progress: 1, serial: 0, angle: 0, width: 1.6 },
			snare: { strength: 0, progress: 1, serial: 0, angle: 0 },
			hat: { strength: 0, progress: 1, serial: 0, density: 0.15, angle: 0, width: 0.7 },
			fill: { strength: 0, progress: 1, serial: 0, angle: 0, direction: 1 },
			note: { strength: 0, progress: 1, fifths: 0 },
			withdraw: 0,
			swingLean: 0,
			low: { x: 0, z: 0, power: 1, haze: 1 },
			bays: { left: 1, right: 1, spread: 0 },
			bayFlare: { left: 0, right: 0, leftAngle: 0, rightAngle: 0 },

			sun: { power: 1, hotspot: 1 },
			clerestory: 1,
			hazeHigh: 1,
			caustic: 1,
			dust: { density: 1, glint: 0 },
			candles: 1,
			tracery: { glow: 1, edge: 0.5 },
			cameraRestless: 0.5,
			turn: 1,
			growth: 0,
			sustain: 0,
			trails: 0
		};
	}

	/** Hash a counter into 0..1 with the look's salt (stable per look). */
	private unit(n: number, lane: number): number {
		let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(this.salt + lane * 0x632be5ab, 0xc2b2ae35);
		h ^= h >>> 15;
		h = Math.imul(h, 0x2c1b3c6d);
		h ^= h >>> 12;
		return (h >>> 0) / 0x100000000;
	}

	update(input: PrismVoiceInput): PrismVoiceFrame {
		const dt = clamp(finite(input.dt), 0, 0.25);
		this.clock += dt;
		const e = input.ensemble;
		const live = input.live;
		const f = this.frame;
		const m = this.matrix.update(
			prismFillChannels(e, this.channels, live),
			dt,
			clamp(0.3 + finite(input.energy) * 0.5 + e.texture.density * 0.3, 0, 1),
			clamp(finite(input.reroute), 0, 1)
		);
		const at = (part: string, param: string) => m[this.index.get(`${part}.${param}`) ?? 0];

		// Articulation: legato voices glide and their light lingers.
		this.legato = approach(this.legato, live ? clamp(finite(e.articulation.legato, 0.5), 0, 1) : this.legato, 0.8, dt);
		const legato = this.legato;
		f.sustain = legato * 2 - 1;

		// ── Heard drums. Each layer's own serial, never the beat clock.
		const beat = 60 / clamp(finite(e.grid.bpm, 120), 50, 220);
		const d = e.drums;
		const strength = (layer: EnsembleLayer) => clamp(layer.velocity * (0.7 + layer.accent * 0.5), 0.15, 1.3);
		if (this.kick.update(d.kick.serial, strength(d.kick), dt, live, 0.09)) {
			// The kicks work one side of the inner ring for a while, each a
			// little off the last, and the side they work wanders round the rose
			// on its own slow noise.
			this.kickAngle = noise1(0x6b1, this.salt, this.clock / 110) * Math.PI * 2.6 + (this.unit(this.kick.serial, 2) - 0.5) * 0.9;
		}
		if (this.snare.update(d.snare.serial, strength(d.snare), dt, live, 0.08)) {
			// Each crack lands on its own spoke near the last, in a region of the
			// middle ring that wanders on a noise lane of its own.
			this.snareAngle = noise1(0x5a2, this.salt, this.clock / 125) * Math.PI * 2.6 + Math.PI + (this.unit(this.snare.serial, 3) - 0.5) * 0.8;
		}
		this.hat.update(d.hat.serial, strength(d.hat), dt, live, 0.03);
		if (this.fill.update(e.groove.fillSerial, 0.7 + clamp(e.groove.fillIntensity, 0, 1) * 0.5, dt, live, 0.6)) {
			this.fillAngle = this.unit(this.fill.serial, 5) * Math.PI * 2;
			this.fillDirection = this.unit(this.fill.serial, 6) < 0.5 ? -1 : 1;
		}
		if (this.note.update(e.notes.serial, strength(e.notes), dt, live, 0.06)) {
			// The note's pitch: the strongest pitch class that is not the chord's
			// root when another one is close (the melody over the harmony).
			let best = 0;
			let bestV = -1;
			for (let i = 0; i < 12; i += 1) {
				const c = finite(e.harmony.chroma[i] ?? 0) * (i === e.harmony.root ? 0.8 : 1);
				if (c > bestV) {
					bestV = c;
					best = i;
				}
			}
			this.notePitch = (best * 7) % 12;
		}
		const decay = 0.7 + legato * 0.9;
		f.kick.strength = this.kick.strength;
		f.kick.progress = this.kick.progress(clamp(beat * 0.45, 0.18, 0.38) * decay);
		f.kick.serial = this.kick.serial;
		f.kick.angle = this.kickAngle;
		// Accented kicks open a wider arc.
		f.kick.width = 2.0 + clamp(d.kick.accent, 0, 1) * 1.0;
		f.snare.strength = this.snare.strength;
		f.snare.progress = this.snare.progress(0.26 * decay);
		f.snare.serial = this.snare.serial;
		f.snare.angle = this.snareAngle;

		f.hat.strength = this.hat.strength * (0.6 + at('dust', 'glint') * 0.6);
		f.hat.progress = this.hat.progress(0.12 * decay);
		f.hat.serial = this.hat.serial;
		// Busy hats glint on more panes, sparse ones on a few bright ones.
		f.hat.density = clamp(0.2 + d.hat.activity * 0.4, 0.15, 0.55);
		// The hats' arc wanders round the outer ring on its own slow noise.
		f.hat.angle = noise1(0x4a7, this.salt, this.clock / 140) * Math.PI * 2.6 + this.salt * 0.01;
		f.hat.width = 0.9 + d.hat.activity * 0.6;
		f.fill.strength = this.fill.strength * (0.4 + 0.6 * clamp(Math.max(e.groove.fillIntensity, 1 - this.fill.age / 1.5), 0, 1));
		f.fill.progress = this.fill.progress(clamp(beat * 3, 0.9, 2.2));
		f.fill.serial = this.fill.serial;
		f.fill.angle = this.fillAngle;
		f.fill.direction = this.fillDirection;
		// A legato line lets its petal ring on; a staccato one plucks it.
		f.note.strength = this.note.strength * (0.5 + clamp(e.articulation.pad + e.groove.breakdown, 0, 1) * 0.6);
		f.note.progress = this.note.progress((0.35 + legato * 0.9));
		f.note.fifths = this.notePitch;
		// Swing leans the packets off-centre, the lean flipping bar to bar.
		this.swing = approach(this.swing, live ? clamp(e.groove.swing, 0, 1) * clamp(e.groove.confidence * 1.5, 0, 1) : 0, 0.6, dt);
		f.swingLean = this.swing * (Math.floor(finite(e.grid.bar)) % 2 === 0 ? 1 : -1);

		// ── Harmony: one ring re-voiced per chord change.
		const h = e.harmony;
		if (this.chordSeen === null) {
			this.chordSeen = h.changeSerial;
			for (let k = 0; k < 3; k += 1) {
				const first = prismChordVoicing(h.qualities, h.root, h.tension, k);
				Object.assign(this.rings[k].voice, first);
				Object.assign(this.rings[k].prev, first);
			}
		} else if (h.changeSerial !== this.chordSeen) {
			this.chordSeen = h.changeSerial;
			if (live && h.confidence > 0.1) {
				// The ring that has held its chord longest takes the new one; ties
				// broken by the look's hash so the order never settles into a loop.
				let pick = 0;
				let best = -1;
				for (let k = 0; k < 3; k += 1) {
					const score = this.rings[k].since + this.unit(this.revoiced * 3 + k, 9) * 1.5;
					if (score > best) {
						best = score;
						pick = k;
					}
				}
				this.revoiced += 1;
				const ring = this.rings[pick];
				// What the ring shows now (a sweep cut short is left where it was)
				// is what the new chord flows over.
				Object.assign(ring.prev, mixVoice(ring.prev, ring.voice, ring.sweep));
				Object.assign(ring.voice, prismChordVoicing(h.qualities, h.root, h.tension, pick));
				ring.since = 0;
				ring.sweep = 0;
				ring.start = this.unit(this.revoiced, 10) * Math.PI * 2;
				// A legato line re-voices in a long flow round the ring, a stab in a
				// quick one; about a bar either way.
				ring.sweepSecs = clamp(beat * 3, 1, 3) * (0.6 + legato * 0.8);
			}
		}
		const breakdown = live ? clamp(e.groove.breakdown, 0, 1) : 0;
		this.withdraw = breakdown > 0.5 ? Math.min(30, this.withdraw + dt) : Math.max(0, this.withdraw - dt * 2.5);
		f.withdraw = this.withdraw;
		const build = clamp(e.texture.build, 0, 1);
		for (let k = 0; k < 3; k += 1) {
			const ring = this.rings[k];
			ring.since += dt;
			ring.sweep = Math.min(1, ring.sweep + dt / ring.sweepSecs);
			Object.assign(f.rings[k], ring.voice);
			Object.assign(f.ringsPrev[k], ring.prev);
			f.ringSweep[k] = ring.sweep;
			f.ringStart[k] = ring.start;
			// A build gathers the rings, outermost most. (A breakdown withdraws
			// the glass petal by petal in the shader: see prismPetalWithdraw.)
			const glow = [at('innerRing', 'glow'), at('middleRing', 'glow'), at('outerRing', 'glow')][k];
			f.ringLight[k] = (0.6 + glow * 0.75) * (1 + build * 0.25 * (k / 2));
		}
		// Petals: the chord's tones light their own petals.
		const chromaRate = live ? 2.5 : 0.5;
		for (let i = 0; i < 12; i += 1) this.chroma[i] = approach(this.chroma[i], live ? clamp(finite(h.chroma[i] ?? 0), 0, 1) : 0.5, chromaRate, dt);
		f.petalContrast = clamp(at('petals', 'contrast') * 1.1 * clamp(h.confidence * 2 + 0.2, 0, 1) * clamp(e.texture.tonality * 1.5, 0, 1), 0, 1);

		// ── Bass walks the low light round the floor.
		const pc = e.bass.pitchClass;
		const bassLive = live && pc >= 0 && e.bass.confidence > 0.15;
		if (bassLive) {
			const angle = (((pc * 7) % 12) / 12) * Math.PI * 2 + this.salt * 0.001;
			// A walking line glides from note to note; held notes settle softly.
			const rate = 4 + e.bass.walking * 6;
			this.bassX = approach(this.bassX, Math.cos(angle) * 0.24, rate, dt);
			this.bassZ = approach(this.bassZ, Math.sin(angle) * 0.18, rate, dt);
		} else {
			this.bassX = approach(this.bassX, 0, 0.4, dt);
			this.bassZ = approach(this.bassZ, 0, 0.4, dt);
		}
		this.bassPower = approach(this.bassPower, live ? clamp(e.bass.level, 0, 1) : 0, 6, dt);
		const pool = at('floor', 'pool');
		f.low.x = this.bassX;
		f.low.z = this.bassZ;
		f.low.power = 0.35 + this.bassPower * 0.6 + pool * 0.4 + clamp(e.bass.note, 0, 1) * 1.6;
		f.low.haze = 0.45 + at('hazeLow', 'density') * 1.0;

		// ── The rest of the nave, through the matrix.
		const width = live ? clamp(e.texture.width, 0, 1) : 0.3;
		// The neighbouring bays answer instruments of their own: percussion
		// (toms, rims, shakers) flares the bays on one side, a chord change
		// the other (which side is the look's own).
		if (this.percSeen === null) this.percSeen = d.perc.serial;
		if (d.perc.serial !== this.percSeen) {
			this.percSeen = d.perc.serial;
			if (live) {
				this.percPulse = Math.max(this.percPulse, clamp(d.perc.velocity, 0.3, 1));
				this.percAngle = this.unit(d.perc.serial, 11) * Math.PI * 2;
			}
		}
		if (this.revoicedSeen !== this.revoiced) {
			this.revoicedSeen = this.revoiced;
			this.chordPulse = 1;
			this.chordAngle = this.unit(this.revoiced, 12) * Math.PI * 2;
		}
		this.percPulse *= Math.exp(-dt / (0.18 + legato * 0.25));
		this.chordPulse *= Math.exp(-dt / (0.5 + legato * 0.6));
		const percSide = this.salt % 2 === 0;
		const left = 0.2 + at('bayLeft', 'lit') * 1.1;
		const right = 0.2 + at('bayRight', 'lit') * 1.1;
		f.bays.left = left;
		f.bays.right = right;
		// Each event flares one part of the bay's glass, not the whole window.
		f.bayFlare.left = percSide ? this.percPulse : this.chordPulse;
		f.bayFlare.right = percSide ? this.chordPulse : this.percPulse;
		f.bayFlare.leftAngle = percSide ? this.percAngle : this.chordAngle;
		f.bayFlare.rightAngle = percSide ? this.chordAngle : this.percAngle;
		f.bays.spread = smooth01(width, 0.15, 0.7) * 1.2 + build * 0.6;
		f.sun.power = 0.55 + at('sun', 'power') * 0.9;
		f.sun.hotspot = 0.4 + at('sun', 'hotspot') * 1.3;
		f.clerestory = 0.3 + at('clerestory', 'power') * 1.4;
		f.hazeHigh = 0.45 + at('hazeHigh', 'density') * 1.0;
		f.caustic = 0.3 + at('floor', 'caustic') * 1.4;
		f.dust.density = 0.5 + at('dust', 'density') * 0.9;
		// Hats are the fine sparkle in the beams.
		f.dust.glint = clamp(d.hat.hit * 1.2 + at('dust', 'glint') * 0.5, 0, 1.6);
		f.candles = 0.4 + at('candles', 'flicker') * 1.2 + clamp(d.perc.hit, 0, 1) * 0.4;
		f.tracery.glow = 0.3 + at('tracery', 'glow') * 1.5;
		f.tracery.edge = at('tracery', 'edge');
		f.cameraRestless = at('camera', 'restless');
		f.turn = 0.18 + at('rose', 'turn') * 0.45;
		f.growth = at('mosaic', 'growth') - 0.5 + build * 0.3;
		f.trails = (at('trails', 'length') - 0.5) * 0.5 + (legato - 0.5) * 0.5;
		return f;
	}
}
