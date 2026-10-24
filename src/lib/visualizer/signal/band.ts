// Signal's band: the ensemble (ensemble.ts) as a rack of instruments on the
// bench. A scope bench is literally a set of instruments, so every piece of
// it gets its own part of the music instead of the whole bench following one
// energy envelope:
//
//   voice lanes   six channel traces, one per part of the band, each written
//                 by its own sweep head the way a triggered scope writes:
//                   bass     the bass line as a wave whose density is its
//                            pitch, gliding on steps, jumping on leaps
//                   harmony  the chord as a standing wave of its own tones in
//                            just ratios: a major triad closes into a calm
//                            periodic shape, a diminished one never settles;
//                            tension detunes it into beating
//                   kick, snare, hat, perc
//                            one lane per drum layer: each heard hit rings a
//                            burst of that drum's own shape where it lands in
//                            the bar, so the bar's pattern stands on the lane
//                 Drum lanes sweep once per bar on the ensemble's own grid
//                 (never the director's predicted clock), skewed by the
//                 swing. The phosphor of every written sample has its own
//                 heat that decays by the articulation of the lane's
//                 register: staccato burns briefly, legato lingers.
//   hero          the XY figure's frequency ratio follows the chord quality
//                 (major consonant, sus open, minor and dominant darker,
//                 diminished tense), gliding on each chord change.
//   X and Y       the hero's deflection traces keep a written record too:
//                 the sweep head writes the figure (or, with the XY beam up,
//                 the real triggered left and right waveforms) where it
//                 passes, so a trace changes where it is written, not all at
//                 once (writeDeflection).
//   horizon       each row is stamped by who played while it was written:
//                 kicks under the figure, snares to the sides, hats at the
//                 rims, the chord root and the bass note at their own pitch
//                 places, so the history reads as a piano roll of the band,
//                 and each of those places is lit by its own part (zones).
//                 Fills cascade down the rows; breakdowns withdraw them from
//                 the far end in.
//   rails, feeds, graticule, tube colours, camera restlessness
//                 smaller parts on the modulation matrix (modulation.ts):
//                 each listens to its own drifting blend of the band and
//                 re-routes now and then, so which part answers which
//                 instrument keeps changing without a cut.
//
// Everything is deterministic in its inputs and keeps its state in plain
// fields so the renderer memory can carry it across a remount.

import type { EnsembleFrame, EnsembleLayer } from '$lib/visualizer/ensemble';
import { ModMatrix, type ModPart, type ModSource } from '$lib/visualizer/modulation';

/** Samples per voice lane (one sweep). */
export const SIGNAL_VOICE_SAMPLES = 256;
/** Voice lanes in buffer order; lane i is drawn by channel trace i + 2. */
export const SIGNAL_VOICE_NAMES = ['bass', 'harmony', 'kick', 'snare', 'hat', 'perc'] as const;
export const SIGNAL_VOICE_LANES = SIGNAL_VOICE_NAMES.length;
/**
 * The written record of every channel trace: X and Y (the hero's deflection,
 * written at the sweep head by the renderer) then the six voice lanes.
 */
export const SIGNAL_CHANNEL_RECORDS = SIGNAL_VOICE_LANES + 2;
/** Two floats per sample: deflection and heat. */
export const SIGNAL_VOICE_FLOATS = SIGNAL_CHANNEL_RECORDS * SIGNAL_VOICE_SAMPLES * 2;

const LANE_BASS = 0;
const LANE_HARMONY = 1;
const DRUM_LANES = ['kick', 'snare', 'hat', 'perc'] as const;

/** Just ratios of each interval above the root, folded into one octave. */
const JUST_RATIOS = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];

/**
 * Where each chord quality puts the hero's ratio table (figures.ts) and which
 * table: [index, minor]. Major sits on the fifth (2:3), sus on the fourth,
 * minor on the minor third (5:6), augmented between the thirds, dominant on
 * the harmonic seventh (4:7), diminished on the tense 7:9.
 */
const QUALITY_FIGURE: readonly (readonly [number, number])[] = [
	[2, 0], // major
	[5, 1], // minor
	[7, 1], // diminished
	[4.5, 0], // augmented
	[3, 0], // suspended
	[7, 0] // dominant7
];

/**
 * Colour temperature each quality lends its parts: -1 cool .. 1 warm, and
 * how far it pulls the hue (diminished clusters, augmented floats).
 */
const QUALITY_WARMTH = [0.85, -0.75, -0.2, 0.25, 0.35, 0.5];
const QUALITY_TWIST = [0, 0.08, 0.55, 0.35, 0.05, 0.2];

/** Horizon stamp places (turns round the figure; 0.75 is under it). */
const STAMP_KICK = 0.75;
const STAMP_SNARE = 0.5;
const STAMP_HAT = 0.33;

function clamp01(x: number): number {
	return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}

function clamp(x: number, lo: number, hi: number): number {
	return Number.isFinite(x) ? (x < lo ? lo : x > hi ? hi : x) : lo;
}

function smoothstep(e0: number, e1: number, x: number): number {
	const t = clamp01((x - e0) / (e1 - e0));
	return t * t * (3 - 2 * t);
}

function approach(current: number, target: number, tau: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
}

function wrapSigned(x: number): number {
	return x - Math.round(x);
}

/** Integer hash to -1..1 (deterministic sample noise for snares and hats). */
function hashSigned(n: number): number {
	let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
	x ^= x >>> 15;
	x = Math.imul(x, 0x85ebca6b);
	x ^= x >>> 13;
	return ((x >>> 0) / 0x1_0000_0000) * 2 - 1;
}

/** The modulation matrix's sources, read from the ensemble each frame. */
export const SIGNAL_BAND_SOURCES: readonly ModSource[] = [
	{ name: 'kick', impulse: true, family: 'drums' },
	{ name: 'snare', impulse: true, family: 'drums' },
	{ name: 'hat', impulse: true, family: 'drums' },
	{ name: 'perc', impulse: true, family: 'drums' },
	{ name: 'notes', impulse: true, family: 'melody' },
	{ name: 'kickActivity', family: 'groove' },
	{ name: 'hatActivity', family: 'groove' },
	{ name: 'swing', family: 'groove' },
	{ name: 'syncopation', family: 'groove' },
	{ name: 'fill', family: 'groove' },
	{ name: 'breakdown', family: 'groove' },
	{ name: 'chordChange', impulse: true, family: 'harmony' },
	{ name: 'tension', family: 'harmony' },
	{ name: 'major', family: 'harmony' },
	{ name: 'minor', family: 'harmony' },
	{ name: 'bassNote', impulse: true, family: 'bass' },
	{ name: 'bassLevel', family: 'bass' },
	{ name: 'walking', family: 'bass' },
	{ name: 'legato', family: 'articulation' },
	{ name: 'pad', family: 'articulation' },
	{ name: 'density', family: 'texture' },
	{ name: 'build', family: 'texture' },
	{ name: 'width', family: 'texture' },
	{ name: 'register', signed: true, family: 'texture' },
	{ name: 'high', family: 'texture' },
	{ name: 'low', family: 'texture' }
];

const SOURCE_INDEX = Object.fromEntries(SIGNAL_BAND_SOURCES.map((s, i) => [s.name, i])) as Record<string, number>;

const LANE_SOURCES: Record<(typeof SIGNAL_VOICE_NAMES)[number], readonly string[]> = {
	bass: ['bassNote', 'bassLevel', 'walking'],
	harmony: ['chordChange', 'tension', 'notes', 'major', 'minor'],
	kick: ['kick', 'kickActivity', 'fill'],
	snare: ['snare', 'fill'],
	hat: ['hat', 'hatActivity', 'fill'],
	perc: ['perc', 'fill']
};

/** The bench's smaller parts and what each prefers to listen to. */
export const SIGNAL_BAND_PARTS: readonly ModPart[] = [
	...Array.from({ length: 7 }, (_, r) => ({
		name: `rail${r}`,
		params: [{ name: 'light', prefers: r % 2 ? ['drums', 'groove'] : ['groove', 'bass', 'drums'], rest: 0.35, depth: 0.9 }]
	})),
	{
		name: 'graticule',
		// The graticule spans the face, so it only ever follows slow parts.
		params: [{ name: 'light', only: ['pad', 'tension', 'legato', 'major', 'minor'], rest: 0.45, depth: 0.7, smooth: 2.5 }]
	},
	{
		name: 'hero',
		params: [
			{ name: 'ghost', prefers: ['texture', 'harmony'], rest: 0.4, depth: 0.8, smooth: 0.5 },
			{ name: 'ripple', prefers: ['drums', 'melody'], rest: 0.4, depth: 0.8 },
			{ name: 'wobble', prefers: ['groove', 'bass'], rest: 0.4, depth: 0.8, smooth: 0.8 }
		]
	},
	// Each lane's glow answers its own part only: a drum lane its drum (and a
	// fill), the bass lane the bass, the chord lane the harmony and the notes.
	...SIGNAL_VOICE_NAMES.map((name) => ({
		name: `lane-${name}`,
		params: [{ name: 'glow', only: LANE_SOURCES[name], rest: 0.5, depth: 0.7, smooth: 0.15 }]
	})),
	{
		name: 'horizon',
		params: [
			{ name: 'stamp', prefers: ['drums', 'groove'], rest: 0.5, depth: 0.6, smooth: 0.2 }
		]
	},
	{ name: 'feeds', params: [{ name: 'light', prefers: ['melody', 'drums'], rest: 0.45, depth: 0.8 }] },
	{
		name: 'tube',
		params: [
			{ name: 'heroLean', prefers: ['harmony'], rest: 0.5, depth: 0.7, smooth: 1.5 },
			{ name: 'traceLean', prefers: ['texture', 'harmony'], rest: 0.5, depth: 0.7, smooth: 1.5 },
			{ name: 'horizonLean', prefers: ['bass', 'harmony'], rest: 0.5, depth: 0.7, smooth: 2 }
		]
	},
	{ name: 'camera', params: [{ name: 'restless', prefers: ['texture', 'groove'], rest: 0.4, depth: 0.7, smooth: 2.5 }] }
];

type DrumState = {
	serial: number;
	/** Band-clock time of the last answered hit (seconds). */
	at: number;
	velocity: number;
	accent: number;
	/** Visibility, glided from the layer's presence. */
	vis: number;
};

/** Per-frame outputs the renderer reads. */
export type SignalBandFrame = {
	/** Lane head positions along their traces, 0..1, in SIGNAL_VOICE_NAMES order. */
	readonly head: Float32Array;
	/** Lane visibility 0..1. */
	readonly vis: Float32Array;
	/** Lane light (glow) multiplier around 1. */
	readonly light: Float32Array;
	/** Lane colour temperature -1..1 and hue twist 0..1 (chord-led for harmony and hero). */
	readonly warmth: Float32Array;
	readonly twist: Float32Array;
	/** Hero ratio index (figures.ts table, 0..7), its minor-table weight, and how much harmony leads it. */
	heroIndex: number;
	heroMinor: number;
	heroLead: number;
	/** Hero phosphor temperature and twist from the chord. */
	heroWarmth: number;
	heroTwist: number;
	/** Phosphor persistence lean from legato (-1 staccato .. 1 legato). */
	legato: number;
	/** Fill cascade: position down the rows 0..1 and its strength. */
	fillTravel: number;
	fillAmount: number;
	/** Breakdown withdrawal 0..1 (rows from the far end, rails, lanes). */
	withdraw: number;
	/** Build: parts gather toward the hero, 0..1. */
	gather: number;
	/** Rail lights 0..1 (seven rails). */
	readonly rails: Float32Array;
	graticule: number;
	/** Feed dots: travel 0..1 (>= 1 idle) for X feed (snare), Y feed (kick), drip (bass). */
	readonly feeds: Float32Array;
	feedLight: number;
	ghost: number;
	ripple: number;
	wobble: number;
	stamp: number;
	heroLean: number;
	traceLean: number;
	horizonLean: number;
	restless: number;
	/** Horizon zone lights: kick, snare, hat, perc, chord, bass (0..1). */
	readonly zones: Float32Array;
	/** Where the chord root and the bass note sit round the figure (turns). */
	chordTurn: number;
	bassTurn: number;
	/** Beat phase of the band's own grid (for anything that wants the beat). */
	beatPhase: number;
	/** Ensemble tempo in bpm (falls back to the given tempo). */
	bpm: number;
};

/** Plain-data state: it lives in the renderer memory, so a remount resumes it. */
type BandState = {
	time: number;
	bar: number;
	drums: DrumState[];
	bassSerial: number;
	bassAt: number;
	bassPitch: number;
	bassTarget: number;
	bassPhase: number;
	/** Band-clock time of the last bass sample written. */
	bassClock: number;
	chordSerial: number;
	chordAt: number;
	chordWeights: number[];
	chordRoot: number;
	chordDrift: number[];
	notesSerial: number;
	notesAt: number;
	notesVelocity: number;
	fillSerial: number;
	fillAt: number;
	fillStrength: number;
	heroIndex: number;
	heroMinor: number;
	heroLead: number;
	heroWarmth: number;
	heroTwist: number;
	legato: number;
	withdraw: number;
	gather: number;
	laneVis: number[];
	laneLight: number[];
	heads: number[];
	feedAt: number[];
};

export class SignalBand {
	/** Interleaved (deflection, heat) per sample, lanes in SIGNAL_VOICE_NAMES order. */
	readonly lanes = new Float32Array(SIGNAL_VOICE_FLOATS);
	readonly matrix: ModMatrix;
	readonly frame: SignalBandFrame;
	private readonly channels = new Float32Array(SIGNAL_BAND_SOURCES.length);
	private readonly s: BandState;
	private readonly persist = new Float32Array(SIGNAL_VOICE_LANES);
	private readonly chroma = new Float32Array(12);
	/** Root cycles across the chord lane (the genome's trace-map style). */
	private chordCycles = 3;

	constructor(readonly seed: string) {
		this.matrix = new ModMatrix(SIGNAL_BAND_SOURCES, SIGNAL_BAND_PARTS, `${seed}:band`, { meanHold: 22, crossfade: 3 });
		this.frame = {
			head: new Float32Array(SIGNAL_VOICE_LANES),
			vis: new Float32Array(SIGNAL_VOICE_LANES),
			light: new Float32Array(SIGNAL_VOICE_LANES).fill(1),
			warmth: new Float32Array(SIGNAL_VOICE_LANES),
			twist: new Float32Array(SIGNAL_VOICE_LANES),
			heroIndex: 2,
			heroMinor: 0,
			heroLead: 0,
			heroWarmth: 0,
			heroTwist: 0,
			legato: 0,
			fillTravel: 1,
			fillAmount: 0,
			withdraw: 0,
			gather: 0,
			rails: new Float32Array(7),
			graticule: 0.5,
			feeds: new Float32Array(3).fill(1),
			feedLight: 0.5,
			ghost: 0.4,
			ripple: 0.4,
			wobble: 0.4,
			stamp: 0.5,
			heroLean: 0.5,
			traceLean: 0.5,
			horizonLean: 0.5,
			restless: 0.4,
			zones: new Float32Array(6),
			chordTurn: 0.75,
			bassTurn: 0.75,
			beatPhase: 0,
			bpm: 120
		};
		this.s = {
			time: 0,
			bar: 0,
			drums: DRUM_LANES.map(() => ({ serial: -1, at: -99, velocity: 0, accent: 0, vis: 0 })),
			bassSerial: -1,
			bassAt: -99,
			bassPitch: 0,
			bassTarget: 0,
			bassPhase: 0,
			bassClock: 0,
			chordSerial: -1,
			chordAt: -99,
			chordWeights: new Array(12).fill(0),
			chordRoot: 0,
			chordDrift: new Array(12).fill(0),
			notesSerial: -1,
			notesAt: -99,
			notesVelocity: 0,
			fillSerial: -1,
			fillAt: -99,
			fillStrength: 0,
			heroIndex: 2,
			heroMinor: 0,
			heroLead: 0,
			heroWarmth: 0,
			heroTwist: 0,
			legato: 0,
			withdraw: 0,
			gather: 0,
			laneVis: new Array(SIGNAL_VOICE_LANES).fill(0),
			laneLight: new Array(SIGNAL_VOICE_LANES).fill(0.5),
			heads: new Array(SIGNAL_VOICE_LANES).fill(0),
			feedAt: [-99, -99, -99]
		};
	}

	/**
	 * Advance one render frame. `fallbackBpm` is used until the ensemble knows
	 * a tempo; `silent` freezes the sweeps (nothing is written in silence) but
	 * lets the phosphor cool. `restless` and `reroute` steer the matrix
	 * (energy, and a character shift's strength on the frame it lands).
	 */
	update(
		e: EnsembleFrame,
		dt: number,
		opts: { fallbackBpm: number; silent: boolean; restless: number; reroute: number; chordCycles?: number }
	): SignalBandFrame {
		const step = clamp(dt, 0, 0.25);
		const s = this.s;
		this.chordCycles = clamp(opts.chordCycles ?? 3, 1.5, 6);
		const f = this.frame;
		const silent = opts.silent;

		// ---- The band's clock: one bar per drum sweep, locked to the grid. ----
		const bpm = clamp(e.grid.known && e.grid.bpm >= 30 ? e.grid.bpm : opts.fallbackBpm || 120, 40, 220);
		f.bpm = bpm;
		const barRate = bpm / 240;
		const confidence = e.grid.known ? clamp01(0.35 + e.groove.confidence) : 0;
		let advance = silent ? 0 : step * barRate;
		if (!silent && confidence > 0) {
			// Pull toward the grid's bar phase, never backwards and never more
			// than half again as fast, so the heads never jump or reverse.
			const error = wrapSigned(e.grid.barPhase - s.bar);
			advance += clamp(error * (1 - Math.exp(-step / 0.5)) * confidence, -advance * 0.5, advance * 0.5);
		}
		const previousBar = s.bar;
		const timeBefore = s.time;
		if (!silent) s.time += step;
		s.bar = (s.bar + advance) % 1;
		f.beatPhase = (s.bar * 4) % 1;

		// ---- Fresh events (each answered once by serial). ---------------------
		DRUM_LANES.forEach((name, i) => this.answerDrum(e.drums[name], s.drums[i], silent));
		if (e.notes.serial !== s.notesSerial) {
			if (s.notesSerial >= 0 && !silent) {
				s.notesAt = s.time;
				s.notesVelocity = e.notes.velocity;
			}
			s.notesSerial = e.notes.serial;
		}
		const bass = e.bass;
		if (bass.noteSerial !== s.bassSerial) {
			if (s.bassSerial >= 0 && !silent && bass.pitchClass >= 0) {
				s.bassAt = s.time;
				s.feedAt[2] = s.time;
				// Unwrap the new note to the nearest octave of the line, so a step
				// glides a step and a leap leaps.
				const pc = bass.pitchClass;
				const current = s.bassTarget;
				const base = current - (((current % 12) + 12) % 12);
				let next = base + pc;
				if (next - current > 6) next -= 12;
				if (current - next > 6) next += 12;
				// Keep the line inside two octaves of its centre.
				if (next > 18) next -= 12;
				if (next < -6) next += 12;
				s.bassTarget = next;
			}
			s.bassSerial = bass.noteSerial;
		}
		const harmony = e.harmony;
		if (harmony.changeSerial !== s.chordSerial) {
			if (s.chordSerial >= 0 && !silent) s.chordAt = s.time;
			s.chordSerial = harmony.changeSerial;
			if (harmony.root >= 0) s.chordRoot = harmony.root;
		}
		if (e.groove.fillSerial !== s.fillSerial) {
			if (s.fillSerial >= 0 && !silent) {
				s.fillAt = s.time;
				s.fillStrength = clamp01(0.55 + e.groove.fillIntensity * 0.6);
			}
			s.fillSerial = e.groove.fillSerial;
		}

		// ---- Articulation: each register's phosphor keeps its own time. -------
		const a = e.articulation;
		s.legato = approach(s.legato, clamp(a.legato * 2 - 1, -1, 1), 1.2, step);
		f.legato = s.legato;
		this.persist[LANE_BASS] = 0.7 + a.low * 2.2;
		this.persist[LANE_HARMONY] = 1.4 + a.sustain * 2.5 + a.pad * 1.5;
		this.persist[2] = 0.75 + a.low * 2; // kick
		this.persist[3] = 0.65 + a.mid * 1.8; // snare
		this.persist[4] = 0.45 + a.high * 1.4; // hat
		this.persist[5] = 0.6 + a.mid * 1.6; // perc

		// ---- Chord: smoothed tone weights for the harmony lane. --------------
		const tonal = clamp01(e.texture.tonality);
		for (let pc = 0; pc < 12; pc += 1) {
			const v = clamp01(harmony.chroma[pc]);
			this.chroma[pc] = v * v * Math.sqrt(v);
			s.chordWeights[pc] = approach(s.chordWeights[pc], this.chroma[pc], 0.18, step);
			// Tension detunes each tone its own way: the chord beats and crawls.
			s.chordDrift[pc] += step * harmony.tension * (0.35 + ((pc * 7) % 12) * 0.06) * (pc % 2 ? 1 : -1);
		}

		// ---- Hero figure: ratio from chord quality. ------------------------------
		const q = harmony.qualities;
		let qTotal = 0;
		let qIndex = 0;
		let qMinor = 0;
		let warm = 0;
		let twist = 0;
		for (let i = 0; i < QUALITY_FIGURE.length; i += 1) {
			const w = clamp01(q[i]);
			qTotal += w;
			qIndex += w * QUALITY_FIGURE[i][0];
			qMinor += w * QUALITY_FIGURE[i][1];
			warm += w * QUALITY_WARMTH[i];
			twist += w * QUALITY_TWIST[i];
		}
		const lead = clamp01(harmony.confidence * 1.4) * tonal * (silent ? 0 : 1);
		if (qTotal > 0.05) {
			// A chord change re-voices the figure in about a second.
			// Rate-limited too, so a leap across the table (major to diminished)
			// re-forms the figure over a beat or two instead of in one stroke.
			const tau = 0.45;
			const glide = (from: number, to: number, cap: number) =>
				from + clamp(approach(from, to, tau, step) - from, -cap * step, cap * step);
			s.heroIndex = glide(s.heroIndex, qIndex / qTotal, 1.6);
			s.heroMinor = glide(s.heroMinor, qMinor / qTotal, 1.2);
			s.heroWarmth = approach(s.heroWarmth, (warm / qTotal) * lead, 0.8, step);
			s.heroTwist = approach(s.heroTwist, (twist / qTotal + harmony.tension * 0.3) * lead, 0.8, step);
		}
		s.heroLead = approach(s.heroLead, lead * 0.85, 1.5, step);
		f.heroIndex = s.heroIndex;
		f.heroMinor = s.heroMinor;
		f.heroLead = s.heroLead;
		f.heroWarmth = s.heroWarmth;
		f.heroTwist = s.heroTwist;

		// ---- Groove envelopes: fills, breakdowns, builds. --------------------------
		const beat = 60 / bpm;
		const fillAge = s.time - s.fillAt;
		// The cascade runs down the rows in about two beats.
		f.fillTravel = clamp(fillAge / (beat * 2.2), 0, 1.2);
		f.fillAmount = s.fillStrength * Math.exp(-fillAge / (beat * 2.5)) * (fillAge >= 0 ? 1 : 0);
		s.withdraw = approach(s.withdraw, clamp01(e.groove.breakdown), e.groove.breakdown > s.withdraw ? 1.6 : 0.8, step);
		f.withdraw = s.withdraw;
		s.gather = approach(s.gather, clamp01(e.texture.build * 1.3), 1.5, step);
		f.gather = s.gather;

		// ---- Lane visibility: present parts are lit, absent ones withdraw. ------
		// In a breakdown the drum lanes leave one by one (hat first, the kick
		// last), each on its own presence and its own place in the order.
		const order = [0, 0, 0.75, 0.45, 0.15, 0.3];
		for (let i = 0; i < SIGNAL_VOICE_LANES; i += 1) {
			let target: number;
			if (i === LANE_BASS) target = smoothstep(0.04, 0.3, bass.level) * (0.4 + 0.6 * clamp01(bass.confidence + 0.3));
			else if (i === LANE_HARMONY) target = smoothstep(0.15, 0.55, tonal) * (0.5 + 0.5 * clamp01(harmony.confidence * 1.5));
			else {
				const layer = e.drums[DRUM_LANES[i - 2]];
				const out = smoothstep(order[i], order[i] + 0.25, s.withdraw);
				target = clamp01(layer.present * 1.2) * (1 - out * 0.85);
			}
			if (silent) target *= 0.25;
			s.laneVis[i] = approach(s.laneVis[i], target, target > s.laneVis[i] ? 0.5 : 0.9, step);
			f.vis[i] = s.laneVis[i];
		}

		// ---- Modulation matrix: the smaller parts. ------------------------------
		this.fillChannels(e);
		const m = this.matrix.update(this.channels, step, opts.restless, opts.reroute);
		let k = 0;
		for (let r = 0; r < 7; r += 1) f.rails[r] = m[k++];
		f.graticule = m[k++];
		f.ghost = m[k++];
		f.ripple = m[k++];
		f.wobble = m[k++];
		// Each lane's light is its own part's: how much that drum plays (or
		// how present the bass and the chord are), with a drifting glow on top.
		const own = [
			clamp01(bass.level * 1.5),
			clamp01(harmony.confidence * 1.2) * tonal,
			e.drums.kick.activity,
			e.drums.snare.activity,
			e.drums.hat.activity,
			e.drums.perc.activity
		];
		for (let i = 0; i < SIGNAL_VOICE_LANES; i += 1) {
			const glow = m[k++];
			s.laneLight[i] = approach(s.laneLight[i], own[i], 0.8 + i * 0.35, step);
			f.light[i] = (0.7 + s.laneLight[i] * 0.8) * (0.6 + glow * 0.8);
		}
		f.stamp = m[k++];
		f.feedLight = m[k++];
		f.heroLean = m[k++];
		f.traceLean = m[k++];
		f.horizonLean = m[k++];
		f.restless = m[k++];

		// Lane tints: the harmony lane takes the chord's temperature; the
		// others lean on their own tube drift.
		f.warmth[LANE_HARMONY] = s.heroWarmth;
		f.twist[LANE_HARMONY] = s.heroTwist;
		f.warmth[LANE_BASS] = (f.horizonLean - 0.5) * 0.8;
		for (let i = 2; i < SIGNAL_VOICE_LANES; i += 1) {
			f.warmth[i] = (f.traceLean - 0.5) * 0.6 + (i - 3.5) * 0.12;
			f.twist[i] = 0;
		}

		// ---- Horizon zones: each part lights its own stretch of the rows. --------
		const zones = f.zones;
		const layers = [e.drums.kick, e.drums.snare, e.drums.hat, e.drums.perc];
		for (let i = 0; i < 4; i += 1) {
			const hit = silent ? 0 : clamp01(layers[i].hit * 1.2);
			zones[i] = Math.max(zones[i] * Math.exp(-step / (0.3 + this.persist[i + 2] * 0.25)), hit);
		}
		const chordAge = s.time - s.chordAt;
		zones[4] = silent ? zones[4] * Math.exp(-step / 0.5) : clamp01(Math.exp(-chordAge / 0.8) * 0.9 + harmony.confidence * tonal * 0.3);
		zones[5] = silent
			? zones[5] * Math.exp(-step / 0.5)
			: clamp01(Math.exp(-(s.time - s.bassAt) / (0.25 + a.low * 0.6)) * 0.8 + bass.level * 0.3);
		if (harmony.root >= 0) f.chordTurn = 0.75 + (harmony.root / 12 - 0.5) * 0.7;
		if (bass.pitchClass >= 0) f.bassTurn = 0.75 - (bass.pitchClass / 12 - 0.5) * 0.7;

		// ---- Feeds: a dot rides each feed after its own instrument plays. ------
		s.feedAt[0] = s.drums[1].at; // X feed: snare
		s.feedAt[1] = s.drums[0].at; // Y feed: kick
		for (let i = 0; i < 3; i += 1) f.feeds[i] = clamp((s.time - s.feedAt[i]) / 0.32, 0, 1);

		// ---- Write the lanes. -------------------------------------------------------
		this.cool(step);
		if (!silent) this.write(previousBar, s.bar, advance, timeBefore, step, e);
		return f;
	}

	/** Horizon stamps for the row being written: who played, and where. */
	stamps(e: EnsembleFrame, add: (turn: number, width: number, amount: number) => void): void {
		const d = e.drums;
		// Stamps are marks, not flashes: a bright floor would light the whole
		// glass (the room spill), which is exactly a whole-frame pulse.
		const gain = (0.6 + this.frame.stamp * 0.8) * 0.55;
		if (d.kick.hit > 0.05) add(STAMP_KICK, 0.035, d.kick.hit * gain);
		if (d.snare.hit > 0.05) {
			add(STAMP_SNARE, 0.03, d.snare.hit * gain * 0.85);
			add(1 - STAMP_SNARE, 0.03, d.snare.hit * gain * 0.85);
		}
		if (d.hat.hit > 0.05) {
			add(STAMP_HAT, 0.018, d.hat.hit * gain * 0.6);
			add(1.5 - STAMP_HAT, 0.018, d.hat.hit * gain * 0.6);
		}
		if (d.perc.hit > 0.05) add(0.62, 0.025, d.perc.hit * gain * 0.7);
		// The chord root and the bass note mark their pitch places across the
		// row: the horizon becomes a roll of the harmony under the figure.
		const h = e.harmony;
		if (h.root >= 0 && h.confidence > 0.1) {
			add(0.75 + (h.root / 12 - 0.5) * 0.7, 0.02, (0.15 + h.change * 0.6) * clamp01(h.confidence * 1.5) * gain);
		}
		const b = e.bass;
		if (b.pitchClass >= 0 && b.level > 0.05) {
			add(0.75 - (b.pitchClass / 12 - 0.5) * 0.7, 0.018, (0.1 + b.note * 0.5) * clamp01(b.level * 2) * gain);
		}
	}

	/**
	 * Write the hero's X and Y deflection where the sweep head passed this
	 * frame (channel traces 0 and 1), the way a sweeping scope writes: only
	 * at the head, the rest of the trace is what was written before.
	 */
	writeDeflection(from: number, to: number, sample: (u: number, out: [number, number]) => void): void {
		const n = SIGNAL_VOICE_SAMPLES;
		let span = to - from;
		if (span < 0) span += 1;
		// A lock correction that steps back a hair writes nothing.
		if (!(span > 0) || span > 0.5) return;
		const first = Math.floor(from * n) + 1;
		const last = Math.floor((from + span) * n);
		const count = Math.min(last - first + 1, n);
		const xy = this.deflection;
		for (let j = 0; j < count; j += 1) {
			const index = (((first + j) % n) + n) % n;
			sample(index / n, xy);
			this.lanes[index * 2] = xy[0];
			this.lanes[index * 2 + 1] = 1;
			this.lanes[(n + index) * 2] = xy[1];
			this.lanes[(n + index) * 2 + 1] = 1;
		}
	}

	private readonly deflection: [number, number] = [0, 0];

	private answerDrum(layer: EnsembleLayer, state: DrumState, silent: boolean) {
		if (layer.serial === state.serial) return;
		if (state.serial >= 0 && !silent) {
			state.at = this.s.time;
			state.velocity = clamp01(layer.velocity);
			state.accent = clamp01(layer.accent);
		}
		state.serial = layer.serial;
	}

	private fillChannels(e: EnsembleFrame) {
		const c = this.channels;
		const set = (name: string, v: number) => {
			c[SOURCE_INDEX[name]] = Number.isFinite(v) ? v : 0;
		};
		set('kick', e.drums.kick.hit);
		set('snare', e.drums.snare.hit);
		set('hat', e.drums.hat.hit);
		set('perc', e.drums.perc.hit);
		set('notes', e.notes.hit);
		set('kickActivity', e.drums.kick.activity);
		set('hatActivity', e.drums.hat.activity);
		set('swing', e.groove.swing);
		set('syncopation', e.groove.syncopation);
		set('fill', Math.max(e.groove.fill, e.groove.fillIntensity));
		set('breakdown', e.groove.breakdown);
		set('chordChange', e.harmony.change);
		set('tension', e.harmony.tension);
		set('major', e.harmony.qualities[0] ?? 0);
		set('minor', (e.harmony.qualities[1] ?? 0) + (e.harmony.qualities[2] ?? 0));
		set('bassNote', e.bass.note);
		set('bassLevel', e.bass.level);
		set('walking', e.bass.walking);
		set('legato', e.articulation.legato);
		set('pad', e.articulation.pad);
		set('density', e.texture.density);
		set('build', e.texture.build);
		set('width', e.texture.width);
		set('register', e.texture.register);
		set('high', e.texture.high);
		set('low', e.texture.low);
	}

	/** Phosphor cooling: every written sample's heat decays by its lane's articulation. */
	private cool(dt: number) {
		const n = SIGNAL_VOICE_SAMPLES;
		for (let lane = 0; lane < SIGNAL_VOICE_LANES; lane += 1) {
			const keep = Math.exp(-dt / this.persist[lane]);
			const base = (lane + 2) * n * 2;
			for (let i = 0; i < n; i += 1) this.lanes[base + i * 2 + 1] *= keep;
		}
	}

	/**
	 * Swing skews the sweep: the long eighth of each beat is drawn wider than
	 * the short one (exaggerated, so the lean reads), so a swung groove leans
	 * across the lane and a straight one sits even.
	 */
	private swingWarp(bar: number, ratio: number): number {
		const beats = bar * 4;
		const beat = Math.floor(beats);
		const b = beats - beat;
		const r = clamp(ratio, 1, 2.4);
		const long = r / (1 + r);
		// Where the offbeat lands on screen: straight 0.5, swung pushed later.
		const land = clamp(0.5 + (long - 0.5) * 1.8, 0.5, 0.86);
		const x = b < long ? (b / long) * land : land + ((b - long) / (1 - long)) * (1 - land);
		return (beat + x) / 4;
	}

	private write(fromBar: number, toBar: number, advance: number, timeBefore: number, dt: number, e: EnsembleFrame) {
		const s = this.s;
		const n = SIGNAL_VOICE_SAMPLES;
		const swing = e.groove.confidence > 0.25 ? e.groove.swingRatio : 1;
		const startX = this.swingWarp(fromBar, swing);
		const endX = this.swingWarp(toBar, swing);
		// Bass and harmony sweep straight (their lines are not on the drum grid).
		for (let lane = 0; lane < SIGNAL_VOICE_LANES; lane += 1) {
			const drum = lane >= 2;
			const x0 = drum ? startX : fromBar;
			const x1 = drum ? endX : toBar;
			this.frame.head[lane] = x1;
			s.heads[lane] = x1;
			let span = x1 - x0;
			if (span < 0) span += 1;
			if (advance <= 0 || span <= 0) continue;
			// Samples whose position the head crossed this frame.
			const first = Math.floor(x0 * n) + 1;
			const last = Math.floor((x0 + span) * n);
			const count = Math.min(last - first + 1, n);
			for (let j = 0; j < count; j += 1) {
				const position = first + j;
				const index = ((position % n) + n) % n;
				// Time at this sample, interpolated through the frame.
				const along = clamp((position / n - x0) / span, 0, 1);
				const t = timeBefore + dt * along;
				this.writeSample(lane, index, t, position, e);
			}
		}
		// Bass phase runs on time, not on samples.
		const pitch = s.bassPitch;
		s.bassPitch = approach(s.bassPitch, s.bassTarget, e.bass.walking > 0.5 || Math.abs(s.bassTarget - pitch) <= 2 ? 0.07 : 0.015, dt);
	}

	private writeSample(lane: number, index: number, t: number, position: number, e: EnsembleFrame) {
		const s = this.s;
		const o = ((lane + 2) * SIGNAL_VOICE_SAMPLES + index) * 2;
		const beat = 60 / this.frame.bpm;
		let value = 0;
		let heat = 0.1;
		switch (lane) {
			case LANE_BASS: {
				// The bass line: a wave whose density is the note, swelling on each
				// note and holding by the low register's articulation.
				const level = clamp01(e.bass.level * 1.4);
				const age = Math.max(0, t - s.bassAt);
				const hold = 0.12 + e.articulation.low * 0.9;
				const note = Math.exp(-age / hold);
				const cyclesPerSecond = (2.4 + e.bass.walking * 0.4) * Math.pow(2, s.bassPitch / 12) / beat;
				s.bassPhase = (s.bassPhase + cyclesPerSecond * clamp(t - s.bassClock, 0, 0.25)) % 1;
				s.bassClock = t;
				const phase = s.bassPhase;
				const amp = level * (0.35 + 0.65 * note);
				const w = Math.sin(phase * Math.PI * 2);
				value = (w * 0.82 + Math.sin(phase * Math.PI * 4 + 0.6) * 0.18 * note) * amp;
				heat = 0.08 + amp * 0.75 + note * 0.35 * level;
				break;
			}
			case LANE_HARMONY: {
				// The chord as a standing wave across the lane, written where the
				// head passes: a change re-voices it from the head onward.
				const x = index / SIGNAL_VOICE_SAMPLES;
				const root = s.chordRoot;
				let sum = 0;
				let total = 0;
				for (let pc = 0; pc < 12; pc += 1) {
					const w = s.chordWeights[pc];
					if (w < 0.02) continue;
					const interval = (pc - root + 12) % 12;
					const cycles = this.chordCycles * JUST_RATIOS[interval];
					sum += w * Math.sin(Math.PI * 2 * (cycles * x) + s.chordDrift[pc] + pc * 0.7);
					total += w;
				}
				const tonal = clamp01(e.texture.tonality);
				value = total > 0 ? (sum / Math.max(total, 0.8)) * (0.45 + tonal * 0.6) : 0;
				const changeAge = Math.max(0, t - s.chordAt);
				const notesAge = Math.max(0, t - s.notesAt);
				heat = 0.18 + tonal * 0.35 + Math.exp(-changeAge / 0.6) * 0.9 + Math.exp(-notesAge / 0.15) * s.notesVelocity * 0.45;
				break;
			}
			default: {
				const drum = s.drums[lane - 2];
				const age = t - drum.at;
				if (age < 0 || age > 1.2) {
					value = 0;
					heat = 0.06;
					break;
				}
				const v = drum.velocity * (0.8 + drum.accent * 0.4);
				switch (lane) {
					case 2: {
						// Kick: a chirp that drops as it rings, the classic swoop.
						const tau = 0.06 + e.articulation.low * 0.14;
						const env = Math.exp(-age / tau);
						const bar = beat * 4;
						const phase = (24 * age + 40 * 0.035 * (1 - Math.exp(-age / 0.035))) / bar;
						value = env * Math.sin(Math.PI * 2 * phase) * v;
						heat = 0.06 + env * v * 1.2;
						break;
					}
					case 3: {
						// Snare: a noise burst over a short tone.
						const tau = 0.05 + e.articulation.mid * 0.1;
						const env = Math.exp(-age / tau);
						value = env * (hashSigned(position * 31 + 7) * 0.75 + Math.sin((Math.PI * 2 * 40 * age) / (beat * 4)) * 0.35) * v;
						heat = 0.06 + env * v * 1.1;
						break;
					}
					case 4: {
						// Hat: a fine bright buzz, open hats ring longer.
						const tau = 0.018 + e.articulation.high * 0.07;
						const env = Math.exp(-age / tau);
						value = env * (hashSigned(position * 17 + 5) * 0.6 + Math.sin((Math.PI * 2 * 70 * age) / (beat * 4)) * 0.4) * v * 0.8;
						heat = 0.05 + env * v * 1.0;
						break;
					}
					default: {
						// Perc: a pitched knock that bends down a little.
						const tau = 0.05 + e.articulation.mid * 0.08;
						const env = Math.exp(-age / tau);
						value = env * Math.sin((Math.PI * 2 * (34 * age + 0.6 * (1 - Math.exp(-age / 0.04)))) / (beat * 4)) * v;
						heat = 0.05 + env * v * 1.0;
					}
				}
			}
		}
		this.lanes[o] = clamp(value, -1.2, 1.2);
		// Fresh light adds to what the phosphor still holds there.
		// Rewriting a sample replaces its deflection; what the phosphor held
		// there mostly belongs to the old stroke.
		this.lanes[o + 1] = Math.max(clamp(heat, 0, 1.6), this.lanes[o + 1] * 0.35);
	}
}
