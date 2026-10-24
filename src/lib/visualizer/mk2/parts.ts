// Soma's ensemble: the animal as a band of organs. Every organ, and every
// part of the water around it, answers its own part of the music, the way
// each cubie of a Rubik's cube turns on its own while the cube stays one
// object:
//
//   arm groups      four sectors of tentacles, each rippling to its own drum
//                   layer (kick, snare, hats, perc), the pairing re-voiced now
//                   and then; a fill cascades down them one after another
//   bell body       its squeeze follows the bass line (each new bass note),
//                   with the kick as a fallback when there is no bass line
//   bell rim        the photophore ring cracks on the snare; its light chases
//                   round with the perc and the notes
//   comb rows       their running light steps with every hat
//   photophores     three clusters on the body, each firing on its own voice
//   organs          throb with the bass level; cerata flicker on the notes;
//                   lures flash on chord changes
//   colony          the light hops from member to member on kicks and bass notes
//   marine snow     the bell's jet lights a wake behind it on each squeeze;
//                   a drifting cloud of flakes glints on the hats; luminous
//                   plankton patches, a few body lengths across, each flash
//                   on their own instrument (never the kick or the bass, which
//                   belong to the body)
//   far animals     four groups, each blinking on its own voice
//   light shafts    open with sustained pads, lean with the swing, re-voice
//                   (slide) on each chord change; the plankton layer flares
//   companion       the juvenile pulses on the snare and perc, not the bass
//   colours         chord quality sets each organ's light relation: major warm
//                   and open, minor cool, diminished clustered and tense; each
//                   chord change re-voices one layer (arms, rim, organs in turn)
//   diver           a build gathers it in, a breakdown lets it drift back, a
//                   fill turns its head, and the matrix leans its distance,
//                   restlessness and roll on what it is listening to
//   articulation    staccato makes short sharp strokes and short trails,
//                   legato long slow strokes and long trails
//   breakdown       the animal draws in organ by organ; the drums' return
//                   brings them back in reverse
//
// On top of those intentional bindings a modulation matrix (modulation.ts)
// drives dozens of secondary parameters (curl, widths, rates, hue leans,
// densities, the camera's restlessness...) through routes that wander and
// re-route, so which part answers which instrument keeps changing.
//
// Inputs are journey.ensemble (heard events, never the director's predicted
// clock) and the look's mood. Deterministic per seed and input stream; all
// state lives in the look, so a remount resumes it.

import {
	ENSEMBLE_CHORD_QUALITIES,
	type EnsembleFrame,
	type EnsembleLayer
} from '../ensemble';
import { ModMatrix, type ModPart, type ModSource } from '../modulation';
import { Wander } from '../motion';

type Rgb = [number, number, number];

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number) => clamp(Number.isFinite(x) ? x : 0, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
	const t = clamp((x - e0) / (e1 - e0), 0, 1);
	return t * t * (3 - 2 * t);
};
const approach = (current: number, target: number, tau: number, dt: number) =>
	current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

function hash01(seed: number, a: number, b: number): number {
	let h = Math.imul((seed * 0xffffffff) | 0, 0x9e3779b1) ^ Math.imul(a + 1, 0x85ebca6b) ^ Math.imul(b + 7, 0xc2b2ae35);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	h = Math.imul(h, 0x297a2d39);
	h ^= h >>> 15;
	return (h >>> 0) / 0x100000000;
}

/** Rotate a colour around the grey axis by `turns` (a hue relation, never a ramp). */
function hueRotate(c: Rgb, turns: number, out: Rgb): Rgb {
	const angle = turns * Math.PI * 2;
	const cosA = Math.cos(angle);
	const sinA = Math.sin(angle);
	const k = (1 - cosA) / 3;
	const s = sinA / Math.sqrt(3);
	const r = c[0] * (cosA + k) + c[1] * (k - s) + c[2] * (k + s);
	const g = c[0] * (k + s) + c[1] * (cosA + k) + c[2] * (k - s);
	const b = c[0] * (k - s) + c[1] * (k + s) + c[2] * (cosA + k);
	out[0] = Math.max(0, r);
	out[1] = Math.max(0, g);
	out[2] = Math.max(0, b);
	return out;
}

// ── Voices: the heard events an organ can be bound to.
/** kick, snare, hat, perc, notes (tonal onsets), bass note, chord change. */
export const SOMA_VOICES = ['kick', 'snare', 'hat', 'perc', 'notes', 'bass', 'chord'] as const;
const V = { kick: 0, snare: 1, hat: 2, perc: 3, notes: 4, bass: 5, chord: 6 } as const;
const VOICE_COUNT = SOMA_VOICES.length;
/** Base decay of each voice's envelope, seconds (articulation stretches it). */
const VOICE_DECAY = [0.16, 0.2, 0.09, 0.14, 0.2, 0.22, 0.5];
/**
 * How hard each voice lights the organ it drives. Hats come many times a beat:
 * at full strength a hat-driven part would simply stay lit, so they shimmer
 * instead of flashing.
 */
const VOICE_GAIN = [1, 1, 0.4, 1, 0.7, 1, 1];

/**
 * Which voice each group of an organ answers, as alternatives the organ
 * re-voices between (crossfaded). Each row is one assignment; rows keep
 * neighbouring groups on different instruments.
 */
const ARM_VOICINGS: readonly (readonly number[])[] = [
	[V.kick, V.snare, V.hat, V.perc],
	[V.snare, V.hat, V.perc, V.kick],
	[V.hat, V.kick, V.notes, V.snare],
	[V.perc, V.notes, V.kick, V.hat],
	[V.kick, V.hat, V.snare, V.notes]
];
const CLUSTER_VOICINGS: readonly (readonly number[])[] = [
	[V.kick, V.snare, V.notes],
	[V.snare, V.perc, V.kick],
	[V.notes, V.kick, V.perc],
	[V.perc, V.notes, V.snare]
];
// The water's plankton leaves the kick and the bass to the body (its packet and
// its squeeze), so the quarters of the frame answer other instruments.
const ZONE_VOICINGS: readonly (readonly number[])[] = [
	[V.hat, V.perc, V.notes, V.snare],
	[V.snare, V.notes, V.hat, V.perc],
	[V.perc, V.hat, V.snare, V.notes],
	[V.notes, V.snare, V.perc, V.hat]
];
const FAR_VOICINGS: readonly (readonly number[])[] = [
	[V.kick, V.snare, V.chord, V.bass],
	[V.chord, V.hat, V.bass, V.perc],
	[V.bass, V.notes, V.snare, V.chord],
	[V.snare, V.chord, V.perc, V.notes]
];

// ── The modulation matrix: sources filled from the ensemble every tick.
const SOURCES: readonly ModSource[] = [
	{ name: 'kick.hit', impulse: true, family: 'kick' },
	{ name: 'snare.hit', impulse: true, family: 'snare' },
	{ name: 'hat.hit', impulse: true, family: 'hat' },
	{ name: 'perc.hit', impulse: true, family: 'perc' },
	{ name: 'notes.hit', impulse: true, family: 'notes' },
	{ name: 'kick.activity', family: 'kick' },
	{ name: 'hat.activity', family: 'hat' },
	{ name: 'snare.activity', family: 'snare' },
	{ name: 'bass.note', impulse: true, family: 'bass' },
	{ name: 'bass.level', family: 'bass' },
	{ name: 'bass.walking', family: 'bass' },
	{ name: 'harmony.change', impulse: true, family: 'harmony' },
	{ name: 'harmony.tension', family: 'harmony' },
	{ name: 'harmony.minor', family: 'harmony' },
	{ name: 'harmony.confidence', family: 'harmony' },
	{ name: 'groove.swing', family: 'groove' },
	{ name: 'groove.syncopation', family: 'groove' },
	{ name: 'groove.fill', impulse: true, family: 'groove' },
	{ name: 'groove.fillIntensity', family: 'groove' },
	{ name: 'groove.breakdown', family: 'groove' },
	{ name: 'articulation.legato', family: 'articulation' },
	{ name: 'articulation.pad', family: 'articulation' },
	{ name: 'articulation.sustain', family: 'articulation' },
	{ name: 'texture.density', family: 'texture' },
	{ name: 'texture.build', family: 'texture' },
	{ name: 'texture.width', family: 'texture' },
	{ name: 'texture.register', signed: true, family: 'texture' },
	{ name: 'texture.high', family: 'texture' },
	{ name: 'texture.low', family: 'texture' }
];

// Secondary parameters. Where an organ has an intent (comb rows answer the
// hats, the rim the snare and the groove, the companion the snare and perc,
// the shafts the pads) it may only listen to those sources ('only'); the rest
// prefer families and wander among them.
const PARTS: readonly ModPart[] = [
	{
		name: 'arms',
		params: [
			{ name: 'curl', prefers: ['harmony', 'articulation'], rest: 0.5, depth: 0.7, smooth: 0.8 },
			{ name: 'waveLength', prefers: ['articulation', 'groove'], rest: 0.5, depth: 0.7, smooth: 0.5 },
			{ name: 'rippleGain', prefers: ['texture', 'groove'], rest: 0.55, depth: 0.6, smooth: 0.3 },
			{ name: 'beadGain', prefers: ['notes', 'texture'], rest: 0.5, depth: 0.7 }
		]
	},
	{
		name: 'rim',
		params: [
			{ name: 'width', only: ['snare', 'harmony'], rest: 0.5, depth: 0.7, smooth: 0.2 },
			{ name: 'chaseRate', only: ['perc', 'notes', 'groove'], rest: 0.5, depth: 0.7 },
			{ name: 'base', prefers: ['articulation', 'bass'], rest: 0.45, depth: 0.7, smooth: 0.4 }
		]
	},
	{
		name: 'combs',
		params: [
			{ name: 'step', only: ['hat'], rest: 0.5, depth: 0.7 },
			{ name: 'gain', only: ['hat', 'texture.high'], rest: 0.5, depth: 0.7 }
		]
	},
	{
		name: 'photophores',
		params: [
			{ name: 'size', prefers: ['texture', 'kick'], rest: 0.5, depth: 0.6, smooth: 0.4 },
			{ name: 'base', prefers: ['articulation', 'harmony'], rest: 0.4, depth: 0.7, smooth: 0.3 }
		]
	},
	{
		name: 'organs',
		params: [
			{ name: 'hueLean', only: ['bass', 'texture'], rest: 0.5, depth: 0.8, smooth: 1.5 },
			{ name: 'glow', only: ['bass', 'articulation'], rest: 0.5, depth: 0.7, smooth: 0.2 }
		]
	},
	{
		name: 'frills',
		params: [
			{ name: 'wave', only: ['articulation', 'notes'], rest: 0.5, depth: 0.7, smooth: 0.3 },
			{ name: 'cerata', only: ['notes'], rest: 0.5, depth: 0.7 }
		]
	},
	{
		name: 'lures',
		params: [{ name: 'glow', only: ['harmony', 'bass'], rest: 0.5, depth: 0.7 }]
	},
	{
		name: 'colony',
		params: [{ name: 'contrast', prefers: ['groove', 'kick'], rest: 0.5, depth: 0.6, smooth: 0.3 }]
	},
	{
		name: 'snow',
		params: [
			{ name: 'drift', prefers: ['groove', 'texture'], rest: 0.5, depth: 0.6, smooth: 1.2 },
			{ name: 'cloudSize', prefers: ['texture', 'hat'], rest: 0.5, depth: 0.6, smooth: 0.8 },
			{ name: 'wake', only: ['bass', 'kick'], rest: 0.5, depth: 0.6 }
		]
	},
	{
		name: 'far',
		params: [
			{ name: 'size', prefers: ['bass', 'texture'], rest: 0.5, depth: 0.6, smooth: 0.6 },
			{ name: 'count', prefers: ['texture', 'harmony'], rest: 0.5, depth: 0.6, smooth: 2 }
		]
	},
	{
		name: 'shafts',
		params: [
			{ name: 'gain', only: ['articulation'], rest: 0.5, depth: 0.6, smooth: 1 },
			{ name: 'plankton', only: ['harmony'], rest: 0.5, depth: 0.6, smooth: 0.8 }
		]
	},
	{
		name: 'camera',
		params: [
			{ name: 'restless', only: ['texture', 'groove'], rest: 0.5, depth: 0.6, smooth: 2 },
			{ name: 'distance', only: ['texture', 'articulation'], rest: 0.5, depth: 0.5, smooth: 3 },
			{ name: 'roll', only: ['groove', 'harmony'], rest: 0.5, depth: 0.5, smooth: 2.5 }
		]
	},
	{
		name: 'companion',
		params: [
			{ name: 'distance', prefers: ['texture', 'groove'], rest: 0.5, depth: 0.6, smooth: 2 },
			{ name: 'glow', only: ['snare', 'perc'], rest: 0.5, depth: 0.7 }
		]
	}
];

/** Index of each part.param in the matrix's values. */
const PARAM_INDEX: Record<string, number> = {};
{
	let k = 0;
	for (const part of PARTS) for (const param of part.params) PARAM_INDEX[`${part.name}.${param.name}`] = k++;
}

/**
 * Per-organ hue relation for each chord quality (turns), in
 * ENSEMBLE_CHORD_QUALITIES order: [arms, rim, organs]. A relation between the
 * organs, not a tint of the whole animal: each row is balanced around zero,
 * so the animal's overall colour stays the palette's while the chord sets how
 * its lights stand to one another. Major opens them apart, minor draws them
 * close and cool, diminished clusters them onto one tense light (see
 * `cluster`), augmented throws them wide, suspended leaves them open and pale,
 * dominant7 sets the organs against the rest.
 */
const RELATION: readonly (readonly [number, number, number])[] = [
	[0.07, -0.07, 0], // major
	[-0.025, 0.025, 0], // minor
	[0.01, -0.01, 0], // diminished (clustered: see `cluster`)
	[0.15, -0.15, 0], // augmented
	[0.035, -0.035, 0], // suspended
	[-0.06, -0.06, 0.12], // dominant7
	[0, 0, 0] // none
];
/** White balance per quality: + warm, - cool. */
const WARMTH = [0.3, -0.3, -0.1, 0.1, 0.05, 0.15, 0];

/** Uniform lanes this module fills (each a vec4 slot of the scene shader). */
export const SOMA_PART_SLOTS = [
	'armHit', // ripple envelope per arm group 0..3
	'armPhase', // travelling-wave phase per arm group (integrated, radians)
	'armLight', // bead light per arm group
	'armReach', // reach per arm group (draw in / gather)
	'armMod', // curl add, wave length factor, swing lean, frill wave
	'rimM', // ring light, chase phase, margin flare, ring width
	'photoM', // photophore clusters A, B, C, comb-row light
	'organM', // organ throb, cerata flicker, lure flash, inner presence
	'colonyM', // light per colony member (index mod 4)
	'snowM', // wake radius, wake strength, cloud glint, cloud radius
	'snowCloud', // glinting cloud centre xyz, snow drift factor
	'farM', // far-animal groups 0..3
	'shaftM', // shaft gain, shaft lean, shaft voicing offset, plankton flare
	'colArm', // arm light colour, comb-row phase
	'colRim', // rim / photophore colour, far-animal size
	'colOrgan', // organ / lure colour, far-animal count
	'compM', // companion pulse, companion glow, packet strength, packet phase
	'zoneM' // plankton patches in the snow, four groups each on its own voice
] as const;
export type SomaPartSlot = (typeof SOMA_PART_SLOTS)[number];
const SLOT = Object.fromEntries(SOMA_PART_SLOTS.map((name, i) => [name, i * 4])) as Record<SomaPartSlot, number>;

/** Organs in the order a breakdown draws them in (reverse on the drums' return). */
const DRAW_ORDER = ['combs', 'clusterC', 'arm3', 'clusterB', 'arm2', 'arm1', 'rim', 'arm0', 'clusterA', 'far'] as const;
type DrawOrgan = (typeof DRAW_ORDER)[number];

export type SomaPartsInput = {
	ensemble: Readonly<EnsembleFrame> | null | undefined;
	dt: number;
	/** 0..1, gates everything. */
	silence: number;
	/** Palette lights the organ colours relate to. */
	glow: Rgb;
	accent: Rgb;
	organ: Rgb;
	/** Character shift strength on the tick a new shift is answered, else 0. */
	reroute: number;
	/** 0..1 how restless the mood is (energy, agitation). */
	restless: number;
	/** Animal centre (world) and size, for the snow cloud. */
	center: readonly number[];
	radius: number;
};

/** Plain-data state for the fingerprint and resume. */
type Voicing = { from: number; to: number; mix: number };

export class SomaParts {
	/** Uniform lanes, SOMA_PART_SLOTS order. */
	readonly lanes = new Float32Array(SOMA_PART_SLOTS.length * 4);
	readonly matrix: ModMatrix;
	private readonly channels = new Float32Array(SOURCES.length);
	private readonly seed: number;
	/** Envelope per voice (heard events only). */
	private readonly env = new Float32Array(VOICE_COUNT);
	private readonly serials = new Float64Array(VOICE_COUNT).fill(-1);
	/** Per-voice count of events (for chases that step on each one). */
	private readonly count = new Float64Array(VOICE_COUNT);
	private fillSerial = -1;
	private fillClock = 1e3;
	private fillStrength = 0;
	private readonly armEnv = new Float32Array(4);
	private readonly armPhase = new Float64Array(4);
	private readonly armPhaseTarget = new Float64Array(4);
	private readonly memberEnv = new Float32Array(4);
	private memberAt = 0;
	private readonly arms: Voicing = { from: 0, to: 0, mix: 1 };
	private readonly clusters: Voicing = { from: 0, to: 0, mix: 1 };
	private readonly far: Voicing = { from: 0, to: 0, mix: 1 };
	private readonly zones: Voicing = { from: 0, to: 0, mix: 1 };
	private revoicings = 0;
	private sinceRevoice = 0;
	private nextRevoice = 30;
	private chordsSinceRevoice = 0;
	private rimPhase = 0;
	private rimTarget = 0;
	private combPhase = 0;
	private combTarget = 0;
	private wakeRadius = 9;
	private wakeStrength = 0;
	private squeeze = 0;
	private shaftVoice = 0;
	private shaftTarget = 0;
	private packet = 0;
	private sincePacket = 10;
	private drawIn = 0;
	private legato = 0.5;
	private swing = 0;
	private width = 0.3;
	private pad = 0;
	private buildLevel = 0;
	private readonly qualities = new Float32Array(ENSEMBLE_CHORD_QUALITIES.length);
	/** The chord each colour layer last heard (arms, rim, organs). */
	private readonly heldQualities = [0, 1, 2].map(() => new Float32Array(ENSEMBLE_CHORD_QUALITIES.length));
	private readonly heldRoot = [0, 0, 0];
	/** Seconds left in which every colour layer follows the harmony (after new music). */
	private relateAll = 0;
	private readonly relationWander: Wander;
	private root = 0;
	private readonly colArm: Rgb = [0.1, 0.8, 1];
	private readonly colRim: Rgb = [0.1, 0.8, 1];
	private readonly colOrgan: Rgb = [1, 0.5, 0.2];
	private readonly scratch: Rgb = [0, 0, 0];
	private readonly cloudWander: Wander;
	private readonly cloud = [0, 0, 0];
	private chordSerial = -1;
	private bassSerial = -1;

	constructor(seed: number | string) {
		const word = `${seed}`;
		this.seed = hash01(0.37, word.length, word.charCodeAt(0) || 0);
		this.matrix = new ModMatrix(SOURCES, PARTS, `soma-parts:${word}`, { meanHold: 26, crossfade: 3.5 });
		this.cloudWander = new Wander(3, `soma-cloud:${word}`, [19, 27, 23]);
		this.relationWander = new Wander(3, `soma-relation:${word}`, [83, 109, 97]);
		this.arms.from = this.arms.to = Math.floor(this.seed * ARM_VOICINGS.length);
		this.clusters.from = this.clusters.to = Math.floor(hash01(this.seed, 1, 2) * CLUSTER_VOICINGS.length);
		this.far.from = this.far.to = Math.floor(hash01(this.seed, 3, 4) * FAR_VOICINGS.length);
		this.zones.from = this.zones.to = Math.floor(hash01(this.seed, 5, 6) * ZONE_VOICINGS.length);
		for (let g = 0; g < 4; g += 1) this.armPhase[g] = this.armPhaseTarget[g] = hash01(this.seed, g, 9) * 6;
		this.write();
	}

	/** A short string of the live state, for continuity fingerprints and QA logs. */
	fingerprint(): string {
		const r = (v: number) => v.toFixed(4);
		return [
			Array.from(this.lanes, r).join(','),
			`${this.arms.from}>${this.arms.to}@${r(this.arms.mix)}`,
			JSON.stringify(this.matrix.snapshot())
		].join('|');
	}

	/** Which organ answers which instrument right now (QA). */
	voicing(): Record<string, string> {
		const name = (table: readonly (readonly number[])[], v: Voicing) =>
			table[v.mix >= 0.5 ? v.to : v.from].map((i) => SOMA_VOICES[i]).join(' ');
		return {
			arms: name(ARM_VOICINGS, this.arms),
			clusters: name(CLUSTER_VOICINGS, this.clusters),
			far: name(FAR_VOICINGS, this.far),
			zones: name(ZONE_VOICINGS, this.zones),
			matrix: this.matrix
				.routing()
				.map((r) => `${r.part}.${r.param}<${r.source}`)
				.join(' ')
		};
	}

	/** Advance one frame. Reads only heard events and slow ensemble envelopes. */
	update(input: SomaPartsInput): Float32Array {
		const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, 0.1);
		const e = input.ensemble;
		const awake = 1 - clamp01(input.silence);
		this.fillChannels(e, awake);
		// New music (a character shift): every organ re-voices at once, and every
		// colour layer listens to the new harmony for a while, so the whole
		// ensemble visibly regroups within a second or two, still as crossfades.
		if (input.reroute > 0.2) {
			for (let k = 0; k < 4; k += 1) this.revoice(k);
			this.relateAll = 2.5;
		}
		this.relateAll = Math.max(0, this.relateAll - (Number.isFinite(input.dt) ? input.dt : 0));
		const m = this.matrix.update(this.channels, dt, input.restless, input.reroute);
		const mv = (part: string, param: string) => m[PARAM_INDEX[`${part}.${param}`]];

		// ── Slow musical state: articulation, swing, width, pads, chord quality.
		this.legato = approach(this.legato, e ? clamp01(e.articulation.legato) : 0.5, 1.2, dt);
		this.swing = approach(this.swing, e ? clamp01(e.groove.swing) * clamp01(e.groove.confidence * 1.5) : 0, 1.5, dt);
		this.width = approach(this.width, e ? clamp01(e.texture.width) : 0.3, 1, dt);
		this.pad = approach(this.pad, e ? clamp01(Math.max(e.articulation.pad, e.articulation.sustain * 0.7)) : 0, 1.4, dt);
		if (e) {
			// Faster right after a chord change, so the re-voicing lands with the chord.
			const tau = e.harmony.sinceChange < 0.8 ? 0.4 : 0.8;
			for (let i = 0; i < this.qualities.length; i += 1) this.qualities[i] = approach(this.qualities[i], clamp01(e.harmony.qualities[i]), tau, dt);
		}

		// ── Heard events, one per serial; envelopes decay with the articulation.
		const stretch = lerp(0.6, 1.5, this.legato);
		for (let v = 0; v < VOICE_COUNT; v += 1) this.env[v] *= Math.exp(-dt / (VOICE_DECAY[v] * stretch));
		if (e) {
			this.hear(V.kick, e.drums.kick, awake);
			this.hear(V.snare, e.drums.snare, awake);
			this.hear(V.hat, e.drums.hat, awake);
			this.hear(V.perc, e.drums.perc, awake);
			this.hear(V.notes, e.notes, awake);
			if (e.bass.noteSerial !== this.bassSerial) {
				const first = this.bassSerial < 0;
				this.bassSerial = e.bass.noteSerial;
				if (!first) this.fire(V.bass, (0.55 + 0.45 * clamp01(e.bass.level)) * awake);
			}
			if (e.harmony.changeSerial !== this.chordSerial) {
				const first = this.chordSerial < 0;
				this.chordSerial = e.harmony.changeSerial;
				if (!first) {
					this.fire(V.chord, clamp01(e.harmony.change > 0 ? e.harmony.change + 0.3 : 0.8) * awake);
					this.root = e.harmony.root >= 0 ? e.harmony.root : this.root;
					// The shafts slide to a new voicing of their light.
					this.shaftTarget += 0.6 + hash01(this.seed, this.count[V.chord], 31) * 0.9;
					this.chordsSinceRevoice += 1;
				}
			}
			this.events(e, awake);
		}

		// ── Re-voicing: now and then an organ's groups trade instruments
		// (crossfaded), on a fill, after enough chord changes, or after a while.
		this.sinceRevoice += dt;
		if (this.sinceRevoice > this.nextRevoice || this.chordsSinceRevoice >= 12) this.revoice();
		for (const v of [this.arms, this.clusters, this.far, this.zones]) if (v.mix < 1) v.mix = Math.min(1, v.mix + dt / 1.6);

		// ── Arm groups: each ripples to its own voice; a fill cascades down them.
		const fillGap = 0.11;
		const before = this.fillClock;
		this.fillClock += dt;
		const lanes = this.lanes;
		const rippleGain = lerp(0.6, 1.4, mv('arms', 'rippleGain'));
		for (let g = 0; g < 4; g += 1) {
			const drive = this.voiced(ARM_VOICINGS, this.arms, g);
			// Fill cascade: group g fires fillGap * g seconds after the fill.
			if (before < g * fillGap && this.fillClock >= g * fillGap) {
				this.armEnv[g] = Math.max(this.armEnv[g], 0.8 * this.fillStrength + 0.2);
				this.armPhaseTarget[g] += 2.6;
			}
			const target = drive * awake;
			if (target > this.armEnv[g]) {
				// A stroke: the wave travels a fixed distance down the arm per hit.
				this.armPhaseTarget[g] += (target - this.armEnv[g]) * lerp(2.2, 1.2, this.legato) * (1 + this.swing * 0.5 * (g % 2));
				this.armEnv[g] = target;
			} else this.armEnv[g] = approach(this.armEnv[g], target, 0.05, dt);
			// A slow drift of its own too: legato arms never quite stop.
			this.armPhaseTarget[g] += dt * (0.25 + 0.5 * this.legato) * awake;
			this.armPhase[g] = approach(this.armPhase[g], this.armPhaseTarget[g], lerp(0.12, 0.35, this.legato), dt);
			lanes[SLOT.armHit + g] = this.armEnv[g] * rippleGain;
			lanes[SLOT.armPhase + g] = this.armPhase[g] % 6283.1853;
			lanes[SLOT.armLight + g] = (0.15 + 2.6 * this.armEnv[g]) * lerp(0.6, 1.5, mv('arms', 'beadGain')) * this.presence(`arm${g}` as DrawOrgan);
			lanes[SLOT.armReach + g] = 0.6 + 0.4 * this.presence(`arm${g}` as DrawOrgan);
		}
		this.buildLevel = approach(this.buildLevel, e ? clamp01(e.texture.build) : 0, 1.5, dt);
		const build = this.buildLevel;
		lanes[SLOT.armMod] = (mv('arms', 'curl') - 0.5) * 1.4 + build * 0.35;
		lanes[SLOT.armMod + 1] = lerp(0.7, 1.4, mv('arms', 'waveLength')) * lerp(0.8, 1.25, this.legato);
		lanes[SLOT.armMod + 2] = this.swing;
		lanes[SLOT.armMod + 3] = lerp(0.4, 1.6, mv('frills', 'wave')) * lerp(0.5, 1.4, this.legato);

		// ── Rim: snare cracks the ring; perc and notes chase light round it.
		const snare = this.env[V.snare];
		this.rimPhase = approach(this.rimPhase, this.rimTarget, lerp(0.08, 0.25, this.legato), dt);
		const rimPresence = this.presence('rim');
		lanes[SLOT.rimM] = (lerp(0.12, 0.5, mv('rim', 'base')) + 2.6 * snare) * rimPresence;
		lanes[SLOT.rimM + 1] = this.rimPhase % 1000;
		lanes[SLOT.rimM + 2] = snare * (0.5 + 0.5 * (e ? clamp01(e.drums.snare.accent + 0.4) : 0.5)) * rimPresence;
		lanes[SLOT.rimM + 3] = lerp(0.6, 1.6, mv('rim', 'width'));

		// ── Photophore clusters and comb rows.
		const base = lerp(0.04, 0.3, mv('photophores', 'base'));
		const pres = ['clusterA', 'clusterB', 'clusterC'] as const;
		for (let c = 0; c < 3; c += 1) lanes[SLOT.photoM + c] = (base + 3.2 * this.voiced(CLUSTER_VOICINGS, this.clusters, c)) * this.presence(pres[c]);
		this.combPhase = approach(this.combPhase, this.combTarget, 0.06, dt);
		lanes[SLOT.photoM + 3] = (0.15 + 2 * this.env[V.hat]) * lerp(0.6, 1.5, mv('combs', 'gain')) * this.presence('combs');

		// ── Organs: throb with the bass, cerata on the notes, lures on the chord.
		const bassLevel = e ? clamp01(e.bass.level) : 0;
		const inner = 1 + 0.6 * this.drawIn01();
		lanes[SLOT.organM] = (0.45 + 0.5 * bassLevel + 0.8 * this.env[V.bass] + 0.35 * build) * lerp(0.7, 1.35, mv('organs', 'glow')) * inner * awake;
		lanes[SLOT.organM + 1] = (0.15 + 1.8 * this.env[V.notes]) * lerp(0.5, 1.5, mv('frills', 'cerata'));
		lanes[SLOT.organM + 2] = (lerp(0.4, 1, mv('lures', 'glow')) + 1.1 * this.env[V.chord]) * awake;
		lanes[SLOT.organM + 3] = inner;

		// ── Colony: the light hops from member to member.
		const contrast = lerp(0.4, 1, mv('colony', 'contrast'));
		for (let i = 0; i < 4; i += 1) {
			this.memberEnv[i] *= Math.exp(-dt / (0.25 * stretch));
			lanes[SLOT.colonyM + i] = 1 - contrast + contrast * (0.25 + 1.5 * this.memberEnv[i]);
		}

		// ── Snow: the bell's jet lights a wake; a cloud glints on the hats.
		this.wakeRadius = Math.min(12, this.wakeRadius + dt * lerp(4.5, 2.4, this.legato));
		this.wakeStrength *= Math.exp(-dt / lerp(0.45, 1.1, this.legato));
		lanes[SLOT.snowM] = this.wakeRadius;
		lanes[SLOT.snowM + 1] = this.wakeStrength * lerp(0.5, 1.5, mv('snow', 'wake')) * awake;
		lanes[SLOT.snowM + 2] = (2.5 * this.env[V.hat] + 0.15) * awake;
		const cloudR = (1.2 + 1.1 * mv('snow', 'cloudSize')) * (0.8 + 0.6 * this.width);
		lanes[SLOT.snowM + 3] = cloudR;
		const w = this.cloudWander.update(dt, 0.6 + 0.8 * this.width);
		// Beside the animal, off to one side; a wide stereo image spreads it out.
		const reach = input.radius * 1.3 + 1.2 + 2.2 * this.width;
		const az = w[0] * 3.2;
		this.cloud[0] = input.center[0] + Math.cos(az) * reach;
		this.cloud[1] = input.center[1] + w[1] * 1.6;
		this.cloud[2] = input.center[2] + Math.sin(az) * reach;
		for (let i = 0; i < 3; i += 1) lanes[SLOT.snowCloud + i] = this.cloud[i];
		lanes[SLOT.snowCloud + 3] = lerp(0.6, 1.5, mv('snow', 'drift'));

		// ── Far animals: four groups, each its own voice.
		const farPresence = this.presence('far');
		for (let g = 0; g < 4; g += 1) lanes[SLOT.farM + g] = (0.2 + 2.4 * this.voiced(FAR_VOICINGS, this.far, g)) * farPresence * awake;
		// Plankton patches: drawn in last of all, so a breakdown's water goes still.
		for (let g = 0; g < 4; g += 1) lanes[SLOT.zoneM + g] = 1.8 * this.voiced(ZONE_VOICINGS, this.zones, g) * farPresence * awake;

		// ── Shafts: pads open them, swing leans them, chords slide their voicing.
		this.shaftVoice = approach(this.shaftVoice, this.shaftTarget, 2.6, dt);
		const tension = e ? clamp01(e.harmony.tension) : 0;
		lanes[SLOT.shaftM] = (0.55 + 0.9 * this.pad) * lerp(0.6, 1.4, mv('shafts', 'gain'));
		lanes[SLOT.shaftM + 1] = (this.swing - 0.15) * 0.9;
		lanes[SLOT.shaftM + 2] = this.shaftVoice % 1000;
		lanes[SLOT.shaftM + 3] = (lerp(0, 0.4, mv('shafts', 'plankton')) + 2.4 * this.env[V.chord] * (0.5 + tension)) * awake;

		// ── Colours: the chord quality sets each organ's light relation.
		this.relate(input, mv('organs', 'hueLean'));
		lanes.set(this.colArm, SLOT.colArm);
		lanes[SLOT.colArm + 3] = this.combPhase % 1000;
		lanes.set(this.colRim, SLOT.colRim);
		lanes[SLOT.colRim + 3] = lerp(0.7, 1.5, mv('far', 'size'));
		lanes.set(this.colOrgan, SLOT.colOrgan);
		lanes[SLOT.colOrgan + 3] = mv('far', 'count');

		// ── Companion: its own pulse, on the snare and the perc.
		const compPulse = Math.max(this.env[V.snare], this.env[V.perc] * 0.8);
		lanes[SLOT.compM] = compPulse * awake;
		lanes[SLOT.compM + 1] = (0.4 + 1.4 * compPulse) * lerp(0.6, 1.4, mv('companion', 'glow'));
		// The packet of light through the body: set off by a heard kick, it runs
		// at the ensemble's own tempo, never on the predicted beat clock.
		this.sincePacket += dt;
		const bpm = e && e.grid.known ? clamp(e.grid.bpm, 50, 200) : 110;
		lanes[SLOT.compM + 2] = this.packet * awake;
		lanes[SLOT.compM + 3] = clamp01((this.sincePacket * bpm) / 60);

		// ── Breakdown: draw in organ by organ, come back in reverse.
		const breakdown = e ? clamp01(e.groove.breakdown) : 0;
		if (breakdown > 0.5) this.drawIn = Math.min(DRAW_ORDER.length * 0.9 + 1, this.drawIn + dt * 1.1);
		else this.drawIn = Math.max(0, this.drawIn - dt * 2.2);
		return lanes;
	}

	/** Contraction drive for the bell: the bass line's squeeze, 0..1. */
	get bellSqueeze(): number {
		return this.squeeze;
	}

	/** Advance the bell's squeeze envelope (called by the look each frame). */
	squeezeUpdate(dt: number, kickFallback: number): number {
		// Attack fast, release with the articulation: staccato a short sharp
		// stroke, legato a long slow one.
		const target = Math.max(this.env[V.bass], kickFallback * 0.7);
		const tau = target > this.squeeze ? 0.045 : lerp(0.18, 0.7, this.legato);
		this.squeeze = approach(this.squeeze, target, tau, dt);
		return this.squeeze;
	}

	/** A voice's current envelope (heard events only), 0..~1.3. */
	voice(name: (typeof SOMA_VOICES)[number]): number {
		return this.env[V[name]];
	}

	/** 0..1 the music is building (texture.build), glided. */
	get build(): number {
		return this.buildLevel;
	}

	get articulation(): number {
		return this.legato;
	}

	get spread(): number {
		return this.width;
	}

	/** Matrix value for a part's parameter (0..1). */
	mod(part: string, param: string): number {
		return this.matrix.get(part, param);
	}

	/** 0..1 how far the breakdown has drawn the animal in. */
	drawIn01(): number {
		return clamp01(this.drawIn / (DRAW_ORDER.length * 0.9));
	}

	private presence(organ: DrawOrgan): number {
		const at = DRAW_ORDER.indexOf(organ) * 0.9;
		return 1 - 0.85 * smoothstep(at, at + 1.6, this.drawIn);
	}

	private voiced(table: readonly (readonly number[])[], v: Voicing, group: number): number {
		const a = this.env[table[v.from][group]] * VOICE_GAIN[table[v.from][group]];
		const b = this.env[table[v.to][group]] * VOICE_GAIN[table[v.to][group]];
		const m = v.mix * v.mix * (3 - 2 * v.mix);
		return a * (1 - m) + b * m;
	}

	private fire(voice: number, strength: number): void {
		this.env[voice] = Math.max(this.env[voice], strength);
		this.count[voice] += 1;
		switch (voice) {
			case V.kick:
				// The packet of light sets off; the colony light hops on.
				this.packet = Math.max(0.35, strength);
				this.sincePacket = 0;
				this.hop(strength);
				break;
			case V.bass:
				// The bell squeezes and its jet lights a wake.
				this.wakeRadius = 0;
				this.wakeStrength = Math.max(this.wakeStrength, strength);
				this.hop(strength * 0.8);
				break;
			case V.hat:
				this.combTarget += 0.16 * lerp(0.6, 1.5, this.matrix.get('combs', 'step'));
				break;
			case V.perc:
			case V.notes:
				this.rimTarget += 0.07 * lerp(0.5, 1.6, this.matrix.get('rim', 'chaseRate')) * (voice === V.perc ? 1 : 0.6);
				break;
		}
	}

	private hop(strength: number): void {
		this.memberAt = (this.memberAt + 1) % 4;
		this.memberEnv[this.memberAt] = Math.max(this.memberEnv[this.memberAt], strength);
	}

	private hear(voice: number, layer: Readonly<EnsembleLayer>, awake: number): void {
		if (layer.serial === this.serials[voice]) return;
		const first = this.serials[voice] < 0;
		this.serials[voice] = layer.serial;
		if (first) return;
		const v = clamp01(layer.velocity);
		this.fire(voice, (0.35 + 0.65 * v) * (1 + 0.3 * clamp01(layer.accent)) * awake);
	}

	private events(e: Readonly<EnsembleFrame>, awake: number): void {
		const g = e.groove;
		if (g.fillSerial !== this.fillSerial) {
			const first = this.fillSerial < 0;
			this.fillSerial = g.fillSerial;
			if (!first) {
				this.fillClock = 0;
				this.fillStrength = clamp01(Math.max(g.fill, g.fillIntensity, 0.6)) * awake;
				// The colony lights one member after another, like the arms.
				for (let i = 0; i < 4; i += 1) this.memberEnv[i] = Math.max(this.memberEnv[i], 0.5 + 0.1 * i);
				// Every other fill re-voices the arms.
				if (hash01(this.seed, g.fillSerial, 17) < 0.5) this.revoice();
			}
		}
	}

	private revoice(only?: number): void {
		this.revoicings += 1;
		this.sinceRevoice = 0;
		this.chordsSinceRevoice = 0;
		this.nextRevoice = 22 + hash01(this.seed, this.revoicings, 5) * 50;
		// One organ at a time, so the whole animal never re-voices at once
		// (except on new music, when the caller names each in turn).
		const which = only ?? Math.floor(hash01(this.seed, this.revoicings, 6) * 4);
		const v = [this.arms, this.clusters, this.far, this.zones][which];
		const table = [ARM_VOICINGS, CLUSTER_VOICINGS, FAR_VOICINGS, ZONE_VOICINGS][which];
		if (v.mix < 1) return;
		const step = 1 + Math.floor(hash01(this.seed, this.revoicings, 7) * (table.length - 1));
		v.from = v.to;
		v.to = (v.to + step) % table.length;
		v.mix = 0;
	}

	/** Organ colours from the palette lights through the chord's relation. */
	/**
	 * Organ colours from the palette lights through the chord's relation. Each
	 * chord change re-voices one layer only (arms, rim, organs in turn), so a
	 * change of chord recolours one part of the animal, never all of it at once;
	 * over three chords every layer has heard the harmony.
	 */
	private relate(input: SomaPartsInput, lean: number): void {
		const dt = clamp(input.dt, 0, 0.1);
		const active = this.count[V.chord] % 3;
		for (let k = 0; k < 3; k += 1) {
			if (k !== active && this.relateAll <= 0) continue;
			const held = this.heldQualities[k];
			for (let i = 0; i < held.length; i += 1) held[i] = approach(held[i], this.qualities[i], 0.5, dt);
			this.heldRoot[k] = this.root;
		}
		// How strongly each layer leans into the chord wanders on its own slow
		// lane, so a progression that loops never paints the same colours twice.
		const lean3 = this.relationWander.update(dt, 1);
		const write = (src: Rgb, k: number, out: Rgb) => {
			const q = this.heldQualities[k];
			const depth = 0.6 * (0.55 + 0.45 * (0.5 + 0.5 * Math.max(-1, Math.min(1, lean3[k] * 2.2))));
			let warm = 0;
			let turn = 0;
			for (let i = 0; i < q.length; i += 1) {
				warm += q[i] * WARMTH[i] * depth;
				turn += q[i] * RELATION[i][k] * depth;
			}
			// The chord's root re-voices the rim: each chord a slightly different light.
			if (k === 1) turn += ((this.heldRoot[1] % 12) / 12 - 0.5) * 0.08 * depth;
			if (k === 2) turn += (lean - 0.5) * 0.16;
			const cluster = q[2] * depth;
			const pale = q[4] * 0.3 * depth;
			const c = this.scratch;
			c[0] = src[0];
			c[1] = src[1];
			c[2] = src[2];
			// Diminished: the organ pulled onto the rim's light, tense.
			if (cluster > 0.01) for (let i = 0; i < 3; i += 1) c[i] = lerp(c[i], input.glow[i], cluster * 0.7);
			hueRotate(c, turn, c);
			const wb: Rgb = warm >= 0 ? [1 + 0.35 * warm, 1, 1 - 0.4 * warm] : [1 + 0.3 * warm, 1 + 0.02 * warm, 1 - 0.25 * warm];
			const grey = (c[0] + c[1] + c[2]) / 3;
			for (let i = 0; i < 3; i += 1) out[i] = approach(out[i], lerp(c[i], grey, pale) * wb[i], 0.9, dt);
		};
		write(input.glow, 0, this.colArm);
		write(input.accent, 1, this.colRim);
		write(input.organ, 2, this.colOrgan);
	}

	private fillChannels(e: Readonly<EnsembleFrame> | null | undefined, awake: number): void {
		const c = this.channels;
		if (!e) {
			c.fill(0);
			return;
		}
		const d = e.drums;
		const q = e.harmony.qualities;
		const vals = [
			d.kick.hit,
			d.snare.hit,
			d.hat.hit,
			d.perc.hit,
			e.notes.hit,
			d.kick.activity,
			d.hat.activity,
			d.snare.activity,
			e.bass.note,
			e.bass.level,
			e.bass.walking,
			e.harmony.change,
			e.harmony.tension,
			clamp01(q[1] + q[2] * 0.8),
			e.harmony.confidence,
			e.groove.swing,
			e.groove.syncopation,
			e.groove.fill,
			e.groove.fillIntensity,
			e.groove.breakdown,
			e.articulation.legato,
			e.articulation.pad,
			e.articulation.sustain,
			e.texture.density,
			e.texture.build,
			e.texture.width,
			e.texture.register,
			e.texture.high,
			e.texture.low
		];
		for (let i = 0; i < c.length; i += 1) {
			const v = Number(vals[i] ?? 0);
			c[i] = (Number.isFinite(v) ? v : 0) * (SOURCES[i].impulse ? awake : 1);
		}
	}

	private write(): void {
		this.lanes.fill(0);
		for (let g = 0; g < 4; g += 1) {
			this.lanes[SLOT.armReach + g] = 1;
			this.lanes[SLOT.armLight + g] = 0.25;
			this.lanes[SLOT.colonyM + g] = 1;
		}
		this.lanes[SLOT.armMod + 1] = 1;
		this.lanes[SLOT.organM] = 0.5;
		this.lanes[SLOT.organM + 3] = 1;
		this.lanes[SLOT.snowM] = 9;
		this.lanes[SLOT.snowM + 3] = 1.5;
		this.lanes[SLOT.snowCloud + 3] = 1;
		this.lanes[SLOT.shaftM] = 1;
		this.lanes.set(this.colArm, SLOT.colArm);
		this.lanes.set(this.colRim, SLOT.colRim);
		this.lanes.set(this.colOrgan, SLOT.colOrgan);
		this.lanes[SLOT.colRim + 3] = 1;
		this.lanes[SLOT.colOrgan + 3] = 0.5;
	}
}
