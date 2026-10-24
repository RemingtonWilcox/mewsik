// Soma's long-listen look and its living animal. One SomaLook lives in the
// shared journey (vis.persistentLook), so leaving and re-entering the
// visualizer resumes the same animal at the same place in the same water, and
// a new song continues it through `reseed` instead of restarting it.
//
// Three layers, each continuous:
//   genome     - species, world, palette, camera... mutate on musical boundaries
//   resolve    - the genome's crossfades become one anatomy vector, one palette,
//                one environment, glided again so a mid-crossfade retarget can
//                never jump
//   life       - the animal swims, contracts on the beat, grows across a
//                phrase; a diver-like camera follows it with lag and sway
//
// Nothing here runs on a closed loop. The species are seeds in one continuous
// anatomy space, not a set of animals: the genome's species is only the
// dominant kin, every other species drifts in and out of the body on its own
// slow noise lane, and independent trait lanes (proportions, splay, curl,
// shells, combs, cerata, frills, photophore patterns...) wander across all of
// them, so the animal keeps becoming one never seen before. The camera roams
// a space of good viewpoints (motion.ts Roamer) instead of orbiting at a fixed
// rate; the authored camera regimes are only biases inside that space.
//
// Across all three runs the mood: what kind of music the animal hears (the
// shared MusicCharacter, read through calm / agitation / pulse / mass /
// warmth). It steers continuous parameters at once (swim and pulse from
// tempo, bristling and darting from agitation, body mass and glow from bass,
// flash sharpness from punch, colour temperature from warmth), and on each
// new character shift it weights the genome toward species, water and light
// that fit the new music before calling genome.shift.
//
// No reads of wall-clock time: every phase is integrated from dt, so the
// renderer is deterministic per seed and input stream.

import { VariationGenome, type ChoiceState } from '../variation';
import { Roamer, Wander, noise1 } from '../motion';
import type { VisualDirectorFrame } from '../director/types';
import type { SignalSpectrumProfile } from '../signal/spectrum';
import type { Mk2ConductorFrame } from './conductor';
import type { MusicCharacter } from '../character';
import type { EnsembleFrame } from '../ensemble';
import { SOMA_PART_SLOTS, SomaParts } from './parts';
import {
	SOMA_ANATOMY_KEYS,
	SOMA_ANATOMY_SIZE,
	SOMA_AXES,
	SOMA_BEAT_FORMS,
	SOMA_BEAT_FORM_MOODS,
	SOMA_CAMERAS,
	SOMA_CAMERA_MOODS,
	SOMA_CAMERA_SPECS,
	SOMA_ENVIRONMENTS,
	SOMA_ENVIRONMENT_MOODS,
	SOMA_ENVIRONMENT_SPECS,
	SOMA_PALETTES,
	SOMA_PALETTE_MOODS,
	SOMA_ROLE_PERMUTATIONS,
	SOMA_SKINS,
	SOMA_SKIN_MOODS,
	SOMA_SPECIES,
	SOMA_SPECIES_MOODS,
	somaSpeciesAnatomy,
	somaSpeciesArms,
	somaSpeciesFold,
	type Rgb,
	type SomaAnatomy,
	type SomaCameraSpec,
	type SomaEnvironmentSpec,
	type SomaMoodKey,
	type SomaMoodPrototype
} from './species';

type Vec3 = [number, number, number];

const A = Object.fromEntries(SOMA_ANATOMY_KEYS.map((key, index) => [key, index])) as Record<
	(typeof SOMA_ANATOMY_KEYS)[number],
	number
>;

export const SOMA_LIFECYCLE = ['seed', 'sprout', 'winding', 'bloom', 'shedding', 'dormancy'] as const;
export type SomaLifecycleForm = (typeof SOMA_LIFECYCLE)[number];

/** Section -> lifecycle stage of the animal. Shared with the conductor's HUD rail. */
export function somaLifecycleTarget(section: string): readonly number[] {
	switch (section) {
		case 'intro':
			return [0.55, 0.45, 0, 0, 0, 0];
		case 'verse':
			return [0, 0.2, 0.8, 0, 0, 0];
		case 'pre_chorus':
		case 'build':
			return [0, 0.75, 0.25, 0, 0, 0];
		case 'drop':
		case 'chorus':
			return [0, 0, 0, 1, 0, 0];
		case 'bridge':
		case 'breakdown':
			return [0, 0, 0.15, 0, 0.85, 0];
		case 'outro':
			return [0, 0, 0, 0, 0.35, 0.65];
		default:
			return [0.15, 0, 0, 0, 0, 0.85];
	}
}

const SECTION_ORDER = ['calm', 'intro', 'verse', 'pre_chorus', 'build', 'drop', 'chorus', 'bridge', 'breakdown', 'outro'];

export type SomaFrame = {
	time: number;
	anatomy: Float32Array;
	lobes: number;
	lobeFade: number;
	arms: number;
	armFade: number;
	species: ChoiceState;
	environment: ChoiceState;
	palette: ChoiceState;
	camera: ChoiceState;
	beatForm: ChoiceState;
	env: {
		fog: number;
		floorY: number;
		surfaceY: number;
		reflect: number;
		snow: number;
		shafts: number;
		/** Per-channel extinction multipliers on the fog (red dies first). */
		absorb: Rgb;
		/** Downwelling light reaching this depth (0 = only living light). */
		down: number;
		keyDir: Vec3;
		keyPower: number;
		ambient: number;
		exposure: number;
		/** Deep scattering layer: world height and glow density. */
		layerY: number;
		layer: number;
	};
	/** The mood the animal is in, 0..1 each. */
	mood: SomaMood;
	/** Integrated phases and the animal's light power, for the water. */
	flow: { snow: number; shiver: number; light: number; current: number; comb: number; film: number; life: number };
	keyColor: Rgb;
	colors: { water: Rgb; haze: Rgb; body: Rgb; glow: Rgb; accent: Rgb; organ: Rgb };
	organism: {
		pos: Vec3;
		axisX: Vec3;
		axisY: Vec3;
		axisZ: Vec3;
		boundCenter: Vec3;
		boundRadius: number;
		extent: number;
	};
	companion: { pos: Vec3; scale: number; boundRadius: number };
	/** Swim velocity in body space, clamped: appendages trail it. */
	drag: Vec3;
	camera3: {
		pos: Vec3;
		right: Vec3;
		up: Vec3;
		fwd: Vec3;
		focal: number;
		focusDist: number;
		aperture: number;
		shiftX: number;
		shiftY: number;
	};
	motion: {
		contraction: number;
		sway: number;
		fin: number;
		growth: number;
		shed: number;
		packet: number;
		packetPhase: number;
		beatCount: number;
		energy: number;
		silence: number;
		kick: number;
		sparkle: number;
		impact: number;
		bass: number;
		mid: number;
		treble: number;
	};
	lifecycle: number[];
	names: { species: string; environment: string; palette: string; camera: string; form: SomaLifecycleForm };
	/** The organs' own lanes (parts.ts SOMA_PART_SLOTS), one vec4 each. */
	parts: Float32Array;
};

export type SomaLookInput = {
	director: VisualDirectorFrame;
	spectrum: Readonly<SignalSpectrumProfile>;
	mk2: Readonly<Mk2ConductorFrame>;
	/** Fresh analyzer features this frame (false = paused / silent source). */
	live: boolean;
	dt: number;
	/** Canvas aspect, for off-centre framing. */
	aspect: number;
	/** Motion multiplier from VISUALIZER_TUNING.mk2. */
	motionScale?: number;
	/** Impact multiplier from VISUALIZER_TUNING.mk2. */
	impactScale?: number;
	/** What kind of music is playing (journey.character); a new shiftSerial means it just changed. */
	character?: Readonly<MusicCharacter> | null;
	/** What each part of the band is doing (journey.ensemble): the organs answer it one by one. */
	ensemble?: Readonly<EnsembleFrame> | null;
};

/** Soma's reading of the music character. */
export type SomaMood = Record<SomaMoodKey, number> & { energy: number; noise: number };

/** What the animal assumes before it has heard anything: a middling, unhurried song. */
const NEUTRAL_MOOD: SomaMood = { tempo: 0.5, calm: 0.3, agitation: 0.05, pulse: 0.3, mass: 0.5, warmth: 0.45, punch: 0.4, energy: 0.5, noise: 0.3 };

/**
 * Character -> mood. Tempo and bass are the most trustworthy features; noise
 * (spectral flatness) only sharpens agitation that tempo already suggests, so
 * a dense but slow track never reads as frantic.
 */
export function somaMoodTarget(c: Readonly<MusicCharacter>, out: SomaMood): SomaMood {
	const tempo = clamp(finite(c.tempo, 0.5), 0, 1);
	const energy = clamp(finite(c.energy, 0.5), 0, 1);
	const noise = clamp(finite(c.noise, 0.3), 0, 1);
	const punch = clamp(finite(c.punch, 0.4), 0, 1);
	const bass = clamp(finite(c.bass, 0.5), 0, 1);
	const agitation = clamp(smoothstep(0.5, 0.92, tempo) * (0.55 + 0.45 * noise) + noise * 0.2 * energy * smoothstep(0.3, 0.6, tempo), 0, 1);
	const calm = (1 - smoothstep(0.12, 0.5, tempo)) * (1 - agitation) * (1 - 0.5 * punch) * (1 - 0.4 * energy);
	const pulse = smoothstep(0.3, 0.62, tempo) * (1 - agitation) * (0.35 + 0.65 * bass);
	// Warmth of the light: happy, punchy, bass-warm music runs warm; agitated
	// or still music runs cold. (Brightness is timbre, not temperature.)
	const warmth = clamp(
		0.5 + (finite(c.valence, 0.5) - 0.6) * 1.2 + (punch - 0.35) * 0.6 + (bass - 0.5) * 0.3 - agitation * 0.35 - calm * 0.2,
		0,
		1
	);
	out.tempo = tempo;
	out.energy = energy;
	out.noise = noise;
	out.punch = punch;
	out.mass = bass;
	out.agitation = agitation;
	out.calm = clamp(calm, 0, 1);
	out.pulse = clamp(pulse, 0, 1);
	out.warmth = warmth;
	return out;
}

/** Pick weights for one choice axis from per-option mood prototypes (cf. characterWeights). */
function moodWeights(prototypes: readonly SomaMoodPrototype[], mood: SomaMood, sharpness: number, floor = 0.08): number[] {
	return prototypes.map((prototype) => {
		let distance = 0;
		let count = 0;
		for (const key in prototype) {
			distance += Math.abs((prototype[key as SomaMoodKey] ?? 0) - mood[key as SomaMoodKey]);
			count += 1;
		}
		return floor + Math.exp(-(count ? distance / count : 0.5) * sharpness);
	});
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

function approach(current: number, target: number, tau: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
}

function approachAngle(current: number, target: number, tau: number, dt: number): number {
	let delta = (target - current) % (Math.PI * 2);
	if (delta > Math.PI) delta -= Math.PI * 2;
	if (delta < -Math.PI) delta += Math.PI * 2;
	return current + delta * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function hash01(seed: number, index: number, channel: number): number {
	let h = Math.imul((seed * 0xffffffff) | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ Math.imul(channel + 7, 0xc2b2ae35);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	h = Math.imul(h, 0x297a2d39);
	h ^= h >>> 15;
	return (h >>> 0) / 0x100000000;
}

function normalize(v: Vec3): Vec3 {
	const length = Math.hypot(v[0], v[1], v[2]) || 1;
	v[0] /= length;
	v[1] /= length;
	v[2] /= length;
	return v;
}

function cross(a: Vec3, b: Vec3, out: Vec3): Vec3 {
	const x = a[1] * b[2] - a[2] * b[1];
	const y = a[2] * b[0] - a[0] * b[2];
	const z = a[0] * b[1] - a[1] * b[0];
	out[0] = x;
	out[1] = y;
	out[2] = z;
	return out;
}

/** Rotate a colour around the grey axis by `turns` (a hue lean, never a ramp). */
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

const CAMERA_WEIGHTS: Record<(typeof SOMA_CAMERAS)[number], number> = {
	companion: 1.3,
	below: 1,
	macro: 0.85,
	orbit: 1,
	profile: 1,
	wide: 0.65,
	descent: 0.6
};

const SKIN_MODS: readonly Partial<Record<'opacity' | 'rimGlow' | 'iridescence' | 'organGlow' | 'vacuole', [number, number]>>[] = [
	{},
	{ opacity: [0.55, 0], rimGlow: [1.25, 0], iridescence: [1, 0.1] },
	{ opacity: [0.5, 0.45], rimGlow: [0.7, 0], iridescence: [0.8, 0] },
	{ iridescence: [0.4, 0.6], rimGlow: [1.05, 0] },
	{ organGlow: [1.35, 0.15], vacuole: [1, 0.25], opacity: [0.9, 0.05] }
];

/**
 * Trait lanes of the anatomy continuum: each drifts on its own period, so the
 * combination of body parts never comes round again. Periods are seconds per
 * undulation, deliberately incommensurate.
 */
const TRAIT = {
	aspect: 0,
	reach: 1,
	splay: 2,
	curl: 3,
	sinuous: 4,
	spacing: 5,
	scallop: 6,
	skirt: 7,
	spines: 8,
	shell: 9,
	combs: 10,
	pigment: 11,
	cerata: 12,
	lures: 13,
	frills: 14,
	spots: 15,
	squash: 16,
	neck: 17,
	organs: 18,
	sheen: 19,
	ring: 20,
	hybrid: 21
} as const;
const TRAIT_PERIODS = [41, 37, 53, 29, 67, 47, 31, 59, 83, 97, 71, 61, 89, 43, 79, 33, 73, 101, 57, 39, 49, 113];

/** Rig dimensions the camera roams (each -1..1). */
const RIG = { azimuth: 0, elevation: 1, distance: 2, focus: 3, frameX: 4, frameY: 5, focal: 6, roll: 7, follow: 8 } as const;
const RIG_DIMS = 9;

/** Slow free drifts: orbit rate, heading, breath rate, companion, diver sway (3), diver roll, hue lean, light lean. */
const DRIFT = { orbit: 0, heading: 1, breath: 2, companion: 3, swayX: 4, swayY: 5, swayZ: 6, roll: 7, hue: 8, light: 9, current: 10, depth: 11, murk: 12, layer: 13, layerY: 14, life: 15 } as const;
const DRIFT_PERIODS = [43, 61, 23, 37, 17, 23, 19, 29, 71, 53, 31, 59, 41, 47, 67, 53];

/** How much deep-scattering plankton glows in each world (in SOMA_ENVIRONMENTS order): most where nothing else lights the water. */
const PLANKTON = [1, 0.45, 0.25, 0.3, 0.3, 1];

/**
 * Wander lanes are gradient noise, which spends most of its time near zero
 * (90% within +-0.25). Stretch them so -1..1 is really visited: after this,
 * half the time a lane is beyond +-0.34 and a tenth of the time beyond 0.7.
 */
function stretch(src: Float32Array, out: Float32Array): Float32Array {
	for (let i = 0; i < out.length; i += 1) out[i] = clamp(src[i] * 2.8, -1, 1);
	return out;
}

/** smoothstep on a stretched lane: an occasional feature, absent much of the time. */
function sometimes(x: number, from = 0.25, to = 0.8): number {
	return smoothstep(from, to, x);
}

export class SomaLook {
	readonly genome: VariationGenome;
	private seed = 0.5;
	private started = false;
	private clock = 0;
	private readonly anatomy = new Float32Array(SOMA_ANATOMY_SIZE);
	private readonly target = new Float32Array(SOMA_ANATOMY_SIZE);
	private readonly scratchA = new Float32Array(SOMA_ANATOMY_SIZE);
	private readonly scratchB = new Float32Array(SOMA_ANATOMY_SIZE);
	private lobes = 8;
	private lobeFade = 1;
	private arms = 16;
	private armFade = 1;
	/** 0..1 glide of 'has appendages at all', so the bounds never step when the count reaches or leaves zero. */
	private armPresence = 1;
	private readonly lifecycle = [0, 0, 0, 0, 0, 1];
	// Life state
	private readonly pos: Vec3 = [0, 0, 0];
	private readonly vel: Vec3 = [0, 0, 0];
	private heading = 0;
	private pitch = 0;
	private roll = 0;
	private waypoint = 0;
	private waypointAge = 0;
	private readonly goal: Vec3 = [0, 0, 0];
	private contraction = 0;
	private sway = 0;
	private fin = 0;
	private breathe = 0;
	private growth = 0.2;
	private energy = 0;
	private silence = 1;
	private quietFor = 1;
	private bass = 0;
	private mid = 0;
	private treble = 0;
	private kick = 0;
	private sparkle = 0;
	private impact = 0;
	private packet = 0;
	private packetPhase = 0;
	private lastBeat = -1;
	private orbit = 0;
	private companionPhase = 0;
	// Camera rig (smoothed)
	private readonly camTarget: Vec3 = [0, 0, 0];
	/** The diver's own position lags the look target: the camera trails the animal. */
	private readonly camBase: Vec3 = [0, 0, 0];
	private readonly camEye: Vec3 = [0, 0, 4];
	private camAzimuth = 0;
	private followBranch = 0;
	private camElevation = 0.15;
	private camDistance = 4;
	private camAperture = 0.03;
	private camFocal = 1.55;
	private shiftX = 0;
	private shiftY = 0;
	private envFloor = -7;
	// Mood: glided reading of the music character, and the last shift answered.
	private readonly mood: SomaMood = { ...NEUTRAL_MOOD };
	private readonly moodTarget: SomaMood = { ...NEUTRAL_MOOD };
	/** shiftSerial last answered with genome.shift; lives with the look so a remount never re-fires. */
	private answeredShift = -1;
	private weightsAge = 0;
	private snowPhase = 0;
	private shiverPhase = 0;
	/**
	 * The mood's own light: a palette chosen for what is playing, blended over
	 * the genome's (which keeps walking underneath for variety). Re-chosen on a
	 * shift, or when the mood has settled somewhere clearly new, and crossfaded.
	 */
	private readonly moodPalette: ChoiceState = { from: 0, to: 0, mix: 1 };
	private moodPaletteWeight = 0;
	private moodPalettePicks = 0;
	private readonly moodAtPick: SomaMood = { ...NEUTRAL_MOOD };
	/** Where the mood is heading: target plus its recent velocity, so a change is read early. */
	private readonly moodAhead: SomaMood = { ...NEUTRAL_MOOD };
	private readonly moodVelocity: SomaMood = { ...NEUTRAL_MOOD };
	private readonly moodPrevious: SomaMood = { ...NEUTRAL_MOOD };
	private moodPickAge = 1e6;
	// Organic motion: every lane below is deterministic per seed and lives with
	// the look, so a remount resumes it and a new song carries it on.
	/** One slow lane per species: how much of each kin is in the body now. */
	private kin = new Wander(SOMA_SPECIES.length, 'soma-kin', 60);
	/** Anatomy trait lanes (TRAIT). */
	private traits = new Wander(TRAIT_PERIODS.length, 'soma-traits', TRAIT_PERIODS);
	/** The camera's roaming point in the space of good viewpoints (RIG). */
	private rig = new Roamer(RIG_DIMS, 'soma-rig', { meanHold: 12, minHold: 3.5, response: 5, wander: 0.3, wanderPeriod: 27 });
	/** Free drifts (DRIFT). */
	private drift = new Wander(DRIFT_PERIODS.length, 'soma-drift', DRIFT_PERIODS);
	private noiseSeed = 0;
	/** Water current, comb-row and iridescent film phases: integrated, at wandering rates. */
	private currentPhase = 0;
	private combPhase = 0;
	private filmPhase = 0;
	private lastImpact = 0;
	private sinceNudge = 0;
	private readonly kinWeights = new Float32Array(SOMA_SPECIES.length);
	/** Stretched copies of the lanes above (see stretch), refreshed every frame. */
	private readonly kn = new Float32Array(SOMA_SPECIES.length);
	private readonly tr = new Float32Array(TRAIT_PERIODS.length);
	private readonly dr = new Float32Array(DRIFT_PERIODS.length);
	private readonly frame: SomaFrame;
	private readonly colorScratch: Rgb = [0, 0, 0];
	/** The organs as an ensemble: each answers its own part of the music (parts.ts). */
	private parts = new SomaParts('soma');
	/** Character shift strength answered this tick (re-routes the modulation matrix). */
	private rerouteNow = 0;
	/** Seconds since the last heard bass note: the bell falls back to the kick without a bass line. */
	private sinceBassNote = 1e3;
	private lastBassSerial = -1;
	private sinceFillNudge = 1e3;
	private sectionGlow = 0.5;
	private lastFillSerial = -1;

	constructor(seed: number | string = 0.5) {
		this.genome = new VariationGenome(SOMA_AXES, seed);
		this.frame = {
			time: 0,
			anatomy: this.anatomy,
			lobes: 8,
			lobeFade: 1,
			arms: 16,
			armFade: 1,
			species: { from: 0, to: 0, mix: 1 },
			environment: { from: 0, to: 0, mix: 1 },
			palette: { from: 0, to: 0, mix: 1 },
			camera: { from: 0, to: 0, mix: 1 },
			beatForm: { from: 0, to: 0, mix: 1 },
			env: { fog: 0.08, floorY: -7, surfaceY: 30, reflect: 0.1, snow: 1, shafts: 0.3, absorb: [1.8, 1, 0.8], down: 0.05, keyDir: [0, 1, 0], keyPower: 0.5, ambient: 0.05, exposure: 1, layerY: 0, layer: 0 },
			mood: { ...NEUTRAL_MOOD },
			flow: { snow: 0, shiver: 0, light: 1, current: 0, comb: 0, film: 0, life: 0.3 },
			keyColor: [0.5, 0.7, 1],
			colors: {
				water: [0.002, 0.008, 0.02],
				haze: [0.01, 0.05, 0.09],
				body: [0.2, 0.42, 0.55],
				glow: [0.1, 0.85, 1],
				accent: [0.6, 0.2, 1],
				organ: [1, 0.45, 0.2]
			},
			organism: { pos: [0, 0, 0], axisX: [1, 0, 0], axisY: [0, 1, 0], axisZ: [0, 0, 1], boundCenter: [0, 0, 0], boundRadius: 3, extent: 2 },
			companion: { pos: [3, 0, 0], scale: 0, boundRadius: 0 },
			drag: [0, 0, 0],
			camera3: { pos: [0, 0, 4], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], focal: 1.55, focusDist: 4, aperture: 0.03, shiftX: 0, shiftY: 0 },
			motion: { contraction: 0, sway: 0, fin: 0, growth: 0, shed: 0, packet: 0, packetPhase: 0, beatCount: 0, energy: 0, silence: 1, kick: 0, sparkle: 0, impact: 0, bass: 0, mid: 0, treble: 0 },
			lifecycle: [0, 0, 0, 0, 0, 1],
			names: { species: 'medusa', environment: 'abyss', palette: 'abyssal-cyan', camera: 'companion', form: 'dormancy' },
			parts: this.parts.lanes
		};
		this.reset(seed);
	}

	private force: Partial<Record<string, number>> | null = null;
	private layout = 0.5;

	/** Dev/QA: pin choice axes (species, environment, palette, camera, ...). */
	setForce(force: Partial<Record<string, number>> | null): void {
		this.force = force;
	}

	/** A choice axis' crossfade, honouring a QA pin. */
	private pick(name: string): ChoiceState {
		const pinned = this.force?.[name];
		return pinned === undefined ? this.genome.choice(name) : { from: pinned, to: pinned, mix: 1 };
	}

	/** Seed of the world's layout (chimneys, kelp): fixed for the session, never per song. */
	get layoutSeed(): number {
		return this.layout;
	}

	/** First source of the session: a fresh animal. */
	reset(seed: number | string): void {
		this.genome.reset(seed);
		this.seed = typeof seed === 'number' ? seed - Math.floor(seed) : hash01(0.5, seed.length, 3);
		this.started = false;
		this.clock = 0;
		this.layout = this.seed;
		this.waypoint = 0;
		this.waypointAge = 0;
		this.orbit = this.seed * Math.PI * 2;
		this.companionPhase = this.seed * 5;
		this.lastBeat = -1;
		Object.assign(this.mood, NEUTRAL_MOOD);
		this.moodPaletteWeight = 0;
		this.moodPalettePicks = 0;
		this.answeredShift = -1;
		this.weightsAge = 0;
		// The organic lanes start from this session's seed; reseed (a new song)
		// never touches them, so the walk carries on across songs.
		const word = `${seed}`;
		this.kin = new Wander(SOMA_SPECIES.length, `soma-kin:${word}`, SOMA_SPECIES.map((_, i) => 48 + ((i * 37) % 53)));
		this.traits = new Wander(TRAIT_PERIODS.length, `soma-traits:${word}`, TRAIT_PERIODS);
		this.rig = new Roamer(RIG_DIMS, `soma-rig:${word}`, { meanHold: 12, minHold: 3.5, response: 5, wander: 0.3, wanderPeriod: 27 });
		this.drift = new Wander(DRIFT_PERIODS.length, `soma-drift:${word}`, DRIFT_PERIODS);
		this.noiseSeed = Math.floor(this.seed * 0xffffffff) >>> 0;
		this.currentPhase = this.seed * 40;
		this.combPhase = 0;
		this.filmPhase = this.seed * 7;
		this.lastImpact = 0;
		this.parts = new SomaParts(word);
		this.sinceBassNote = 1e3;
		this.lastBassSerial = -1;
		this.lastFillSerial = -1;
		this.applyWeights();
	}

	/** A new song: keep the animal, the water and the camera; change future mutations. */
	reseed(seed: number | string): void {
		this.genome.reseed(seed);
		this.seed = typeof seed === 'number' ? seed - Math.floor(seed) : hash01(0.5, seed.length, 3);
		this.lastBeat = -1;
	}

	/** Deterministic fingerprint of the live state, for continuity tests. */
	fingerprint(): string {
		const r = (value: number) => value.toFixed(5);
		return [
			JSON.stringify(this.genome.snapshot()),
			Array.from(this.anatomy, r).join(','),
			this.pos.map(r).join(','),
			this.camEye.map(r).join(','),
			r(this.clock),
			r(this.orbit),
			Array.from(this.rig.value, r).join(','),
			Array.from(this.kin.value, r).join(','),
			String(this.answeredShift),
			Object.values(this.mood).map(r).join(','),
			this.parts.fingerprint()
		].join('|');
	}

	get time(): number {
		return this.clock;
	}

	/** 0 staccato .. 1 legato, glided: the trails' length. */
	get partsArticulation(): number {
		return this.parts.articulation;
	}

	/** Compact live state for QA logs. */
	debugState(): Record<string, string> {
		const c = (name: string) => {
			const x = this.pick(name);
			return `${x.from}>${x.to}@${x.mix.toFixed(2)}`;
		};
		const mp = this.moodPalette;
		const m = this.mood;
		return {
			species: c('species'),
			environment: c('environment'),
			palette: c('palette'),
			camera: c('camera'),
			moodPalette: `${mp.from}>${mp.to}@${mp.mix.toFixed(2)} w${this.moodPaletteWeight.toFixed(2)}`,
			glide: this.genome.glideSpeed.toFixed(2),
			anatomy: SOMA_ANATOMY_KEYS.map((key, i) => `${key}=${this.anatomy[i].toFixed(2)}`).join(' '),
			uniforms: `fold ${this.lobes}/${this.lobeFade.toFixed(2)} arms ${this.arms}/${this.armFade.toFixed(2)} pos ${this.pos.map((v) => v.toFixed(2)).join(',')} pitch ${this.pitch.toFixed(2)} eye ${this.camEye.map((v) => v.toFixed(2)).join(',')}`,
			body: `arms ${this.arms}@${this.armFade.toFixed(2)} lobes ${this.lobes}@${this.lobeFade.toFixed(2)} bulb ${this.anatomy[A.tipBulb].toFixed(2)} len ${this.anatomy[A.tentLen].toFixed(2)} e ${this.energy.toFixed(2)} grow ${this.growth.toFixed(2)} y ${this.pos[1].toFixed(2)} floor ${this.envFloor.toFixed(2)} life ${this.lifecycle.map((v) => v.toFixed(1)).join('/')} pk ${this.packet.toFixed(2)} kick ${this.kick.toFixed(2)} imp ${this.impact.toFixed(2)} spk ${this.sparkle.toFixed(2)} con ${this.contraction.toFixed(2)} beat ${this.lastBeat} reach ${this.genome.value('reach').toFixed(2)} cam ${this.camDistance.toFixed(2)} el ${this.camElevation.toFixed(2)} eyeY ${this.camEye[1].toFixed(2)} az ${this.camAzimuth.toFixed(2)} hd ${this.heading.toFixed(2)}`,
			mood: `calm ${m.calm.toFixed(2)} ag ${m.agitation.toFixed(2)} pulse ${m.pulse.toFixed(2)} warm ${m.warmth.toFixed(2)} mass ${m.mass.toFixed(2)}`,
			...this.parts.voicing()
		};
	}

	private applyWeights(): void {
		const species = this.pick('species').to;
		const dwell = somaSpeciesAnatomy(species).dwell;
		const mood = this.started ? moodWeights(SOMA_CAMERA_MOODS, this.moodTarget, 3) : null;
		this.genome.setWeights(
			'camera',
			SOMA_CAMERAS.map((name, index) => {
				let weight = CAMERA_WEIGHTS[name];
				if (name === 'descent') weight *= 1 + dwell * 1.6;
				if (name === 'below') weight *= 1 - dwell * 0.7;
				return weight * (mood ? mood[index] : 1);
			})
		);
	}

	/**
	 * Bias every big choice toward options that fit what is playing now. A
	 * deterministic function of the mood, refreshed every few seconds and right
	 * before a shift, so natural mutations fit the music too.
	 */
	private applyMoodWeights(sharpness: number): void {
		const m = this.moodTarget;
		this.genome.setWeights('species', moodWeights(SOMA_SPECIES_MOODS, m, sharpness));
		this.genome.setWeights('environment', moodWeights(SOMA_ENVIRONMENT_MOODS, m, sharpness));
		this.genome.setWeights('palette', moodWeights(SOMA_PALETTE_MOODS, m, sharpness * 1.4));
		this.genome.setWeights('skin', moodWeights(SOMA_SKIN_MOODS, m, sharpness * 0.7));
		this.genome.setWeights('beatForm', moodWeights(SOMA_BEAT_FORM_MOODS, m, sharpness * 0.7));
		this.applyWeights();
		this.weightsAge = 0;
	}

	/** Glide the mood toward the music character (faster right after a shift). */
	private feel(dt: number, character: Readonly<MusicCharacter> | null | undefined): void {
		if (character) somaMoodTarget(character, this.moodTarget);
		const tau = 0.55 / Math.max(1, this.genome.glideSpeed * 0.8);
		for (const key of Object.keys(this.mood) as (keyof SomaMood)[]) {
			this.mood[key] = approach(this.mood[key], this.moodTarget[key], tau, dt);
			// The character's fast envelope lags the music by about a second, so
			// extrapolate its current velocity most of that way to hear a change early.
			const velocity = dt > 0 ? (this.moodTarget[key] - this.moodPrevious[key]) / dt : 0;
			this.moodVelocity[key] = approach(this.moodVelocity[key], clamp(velocity, -3, 3), 0.12, dt);
			this.moodPrevious[key] = this.moodTarget[key];
			this.moodAhead[key] = clamp(this.moodTarget[key] + this.moodVelocity[key] * 0.8, 0, 1);
		}
	}

	/** How far two moods are apart on the dimensions that change the picture. */
	private static moodDistance(a: SomaMood, b: SomaMood): number {
		return Math.max(
			Math.abs(a.calm - b.calm),
			Math.abs(a.agitation - b.agitation),
			Math.abs(a.pulse - b.pulse),
			Math.abs(a.warmth - b.warmth),
			Math.abs(a.tempo - b.tempo),
			Math.abs(a.mass - b.mass) * 0.6
		);
	}

	/** Choose the mood palette among the best fits for the music, never the genome's own. */
	private pickMoodPalette(): void {
		const weights = moodWeights(SOMA_PALETTE_MOODS, this.moodAhead, 8, 0);
		const exclude = [this.pick('palette').to, this.moodPalette.to];
		const ranked = weights
			.map((weight, index) => ({ weight, index }))
			.filter((entry) => !exclude.includes(entry.index))
			.sort((x, y) => y.weight - x.weight || x.index - y.index)
			.slice(0, 4);
		this.moodPalettePicks += 1;
		// Of the fitting palettes, favour the one whose light differs most from
		// what is lit now (a hash adds variety), so the change is always seen.
		const glow = this.frame.colors.glow;
		const accent = this.frame.colors.accent;
		const chroma = (c: readonly number[]) => {
			const sum = c[0] + c[1] + c[2] + 1e-4;
			return [c[0] / sum, c[1] / sum, c[2] / sum];
		};
		const now = [chroma(glow), chroma(accent)];
		let choice = ranked[0].index;
		let bestScore = -1;
		for (const entry of ranked) {
			const p = SOMA_PALETTES[entry.index];
			const cand = [chroma(p.glow), chroma(p.accent)];
			let difference = 0;
			for (let k = 0; k < 2; k += 1) for (let i = 0; i < 3; i += 1) difference += Math.abs(cand[k][i] - now[k][i]) * (k === 0 ? 1 : 0.5);
			const score = difference + hash01(this.seed, this.moodPalettePicks * 31 + entry.index, 21) * 0.35;
			if (score > bestScore) {
				bestScore = score;
				choice = entry.index;
			}
		}
		const mp = this.moodPalette;
		if (this.moodPaletteWeight <= 0.001) {
			mp.from = mp.to = choice;
			mp.mix = 1;
		} else {
			mp.from = mp.mix >= 0.5 ? mp.to : mp.from;
			mp.to = choice;
			mp.mix = 0;
		}
		Object.assign(this.moodAtPick, this.moodAhead);
		this.moodPickAge = 0;
	}

	/** Advance the mood palette: re-pick when the music settled somewhere new. */
	private moodLight(dt: number, character: Readonly<MusicCharacter> | null | undefined, shifted: boolean): void {
		if (!character) return;
		this.moodPickAge += dt;
		// Re-pick on a shift, or when the mood is heading somewhere clearly new;
		// right after a pick only a much bigger move counts, so one change of
		// music never reads as two steps.
		const moved = SomaLook.moodDistance(this.moodAhead, this.moodAtPick);
		const needed = this.moodPickAge < 5 ? 0.45 : 0.3;
		const fresh = this.moodPaletteWeight <= 0.001;
		if (fresh || (this.moodPickAge > 0.8 && ((shifted && this.moodPickAge > 1.5) || moved > needed))) {
			// Only a different light family is worth a new pick; within the family
			// the current one already fits.
			const weights = moodWeights(SOMA_PALETTE_MOODS, this.moodAhead, 8, 0);
			let best = 0;
			for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[best]) best = i;
			if (fresh || SOMA_PALETTE_MOODS[best] !== SOMA_PALETTE_MOODS[this.moodPalette.to]) this.pickMoodPalette();
			else Object.assign(this.moodAtPick, this.moodAhead);
		}
		this.moodPaletteWeight = Math.min(1, this.moodPaletteWeight + dt / 2);
		const mp = this.moodPalette;
		if (mp.mix < 1) mp.mix = Math.min(1, mp.mix + dt / 1.1);
	}

	/**
	 * Answer each new character shift exactly once: weight the picks toward the
	 * new music, steer the continuous axes the music should own, then let the
	 * genome mutate now with glides sped up. Nothing jumps; it lands in ~2-3 s.
	 */
	private answerShift(character: Readonly<MusicCharacter> | null | undefined): boolean {
		if (!character) return false;
		const serial = character.shiftSerial;
		if (serial === this.answeredShift) return false;
		this.answeredShift = serial;
		// A look first seen long after the shift (opening the visualizer mid-song)
		// adopts it without moving: that music is simply what is playing.
		if (!this.started || finite(character.sinceShift, 1e6) > 3) return false;
		const strength = clamp(finite(character.shiftStrength, 0.6), 0, 1);
		const m = this.moodTarget;
		this.applyMoodWeights(7);
		const g = this.genome;
		const amount = 0.45 + 0.4 * strength;
		g.pull('murk', clamp(0.25 + m.agitation * 0.5 + m.calm * 0.25, 0, 1), amount);
		g.pull('snow', clamp(0.3 + m.agitation * 0.6 + m.calm * 0.2, 0, 1), amount);
		g.pull('reach', clamp(0.75 - m.agitation * 0.5 + m.calm * 0.25, 0, 1), amount);
		g.pull('sway', clamp(0.25 + m.tempo * 0.6 + m.calm * 0.15, 0, 1), amount);
		g.pull('innerLight', clamp(0.3 + m.mass * 0.6, 0, 1), amount);
		g.pull('photophores', clamp(0.2 + m.punch * 0.5 + m.pulse * 0.3, 0, 1), amount);
		g.pull('bodySize', clamp(0.2 + m.mass * 0.7, 0, 1), amount);
		g.pull('clarity', clamp(0.8 - m.mass * 0.5, 0, 1), amount);
		g.shift(strength, Math.max(this.energy, m.energy));
		// The diver heads for a new viewpoint now, not when its hold runs out.
		this.rig.redirect();
		// New music: the organs re-route which instruments they answer.
		this.rerouteNow = strength;
		return true;
	}

	/**
	 * The body as a blend of kin. The genome's species (mid-crossfade or not)
	 * is the dominant kin; every other species drifts in and out on its own
	 * slow lane, leaning toward kin that fit the music, and a 'hybrid' lane
	 * sets how far from a pure species the animal strays at all. Weights are
	 * continuous in time, so the body never steps.
	 */
	private speciesBlend(out: Float32Array, choice: ChoiceState): void {
		const n = SOMA_SPECIES.length;
		const kin = this.kn;
		const fit = moodWeights(SOMA_SPECIES_MOODS, this.mood, 3, 0.25);
		const hybrid = 0.2 + 0.8 * smoothstep(-0.6, 0.6, this.tr[TRAIT.hybrid]);
		const w = this.kinWeights;
		let total = 0;
		for (let i = 0; i < n; i += 1) {
			const dominant = (i === choice.from ? 1 - choice.mix : 0) + (i === choice.to ? choice.mix : 0);
			const guest = sometimes(kin[i], 0.3, 0.9) * 0.45 * hybrid * fit[i];
			w[i] = dominant + guest;
			total += w[i];
		}
		out.fill(0);
		for (let i = 0; i < n; i += 1) {
			if (w[i] <= 1e-4) continue;
			const share = w[i] / total;
			const a = somaSpeciesAnatomy(i);
			for (let k = 0; k < SOMA_ANATOMY_SIZE; k += 1) out[k] += a[SOMA_ANATOMY_KEYS[k]] * share;
		}
	}

	/**
	 * Parts and proportions that wander across every kin: the same body plan
	 * grows a lattice shell, comb rows, cerata, lures or frills for a while and
	 * loses them again, each on its own clock.
	 */
	private applyTraits(t: Float32Array): void {
		const tr = this.tr;
		t[A.bellH] *= 1 + 0.24 * tr[TRAIT.aspect];
		t[A.bellR] *= 1 - 0.1 * tr[TRAIT.aspect];
		t[A.tentLen] *= 1 + 0.3 * tr[TRAIT.reach];
		t[A.tentDir] = clamp(t[A.tentDir] + 0.32 * tr[TRAIT.splay], 0.25, Math.PI);
		t[A.tentCurl] += 0.55 * tr[TRAIT.curl];
		t[A.chainCurve] = Math.max(0, t[A.chainCurve] + 0.35 * tr[TRAIT.sinuous]);
		t[A.chainSpacing] *= 1 + 0.18 * tr[TRAIT.spacing];
		t[A.lobeAmp] = Math.max(0, t[A.lobeAmp] + 0.06 * tr[TRAIT.scallop]);
		t[A.fin] += 0.45 * sometimes(tr[TRAIT.skirt]);
		t[A.spines] += 0.45 * sometimes(tr[TRAIT.spines], 0.35, 0.9);
		t[A.lattice] += 0.65 * sometimes(tr[TRAIT.shell], 0.35, 0.9);
		t[A.combs] += 0.75 * sometimes(tr[TRAIT.combs]);
		t[A.chromato] += 0.55 * sometimes(tr[TRAIT.pigment]);
		t[A.cerata] += 0.6 * sometimes(tr[TRAIT.cerata], 0.35, 0.9);
		t[A.tipBulb] += 0.7 * sometimes(tr[TRAIT.lures]);
		t[A.oral] += 0.7 * sometimes(tr[TRAIT.frills]);
		t[A.photoDensity] *= 0.6 + 0.8 * smoothstep(-0.7, 0.7, tr[TRAIT.spots]);
		t[A.photoRim] *= 0.6 + 0.8 * smoothstep(-0.7, 0.7, tr[TRAIT.ring]);
		t[A.photoTentacle] *= 0.6 + 0.8 * smoothstep(-0.7, 0.7, -tr[TRAIT.ring]);
		t[A.squash] = clamp(t[A.squash] * (1 + 0.22 * tr[TRAIT.squash]), 0.15, 1.3);
		t[A.bellNeck] += 0.45 * sometimes(tr[TRAIT.neck], 0.3, 0.85);
		const organs = tr[TRAIT.organs];
		t[A.gonad] += 0.6 * sometimes(organs);
		t[A.nucleus] += 0.6 * sometimes(-organs);
		t[A.vacuole] += 0.4 * sometimes(organs * 0.6 + tr[TRAIT.sheen] * 0.6);
		t[A.canal] += 0.5 * sometimes(tr[TRAIT.neck] * 0.5 - organs * 0.5);
		t[A.iridescence] += 0.45 * sometimes(tr[TRAIT.sheen]);
	}

	private applySkin(values: Float32Array, skin: number, weight: number): void {
		const mods = SKIN_MODS[skin] ?? {};
		for (const [key, mod] of Object.entries(mods) as [keyof SomaAnatomy, [number, number]][]) {
			const index = A[key];
			const modded = values[index] * mod[0] + mod[1];
			values[index] = lerp(values[index], modded, weight);
		}
	}

	private resolveAnatomy(): void {
		const g = this.genome;
		this.speciesBlend(this.target, this.pick('species'));
		const t = this.target;
		this.applyTraits(t);
		const bellShape = g.value('bellShape');
		t[A.bellH] *= 1 + 0.22 * bellShape;
		t[A.bellR] *= 1 - 0.08 * bellShape;
		t[A.lobeAmp] *= 0.5 + g.value('lobeDepth');
		t[A.tentLen] *= 0.72 + 0.52 * g.value('reach');
		t[A.tentCurl] += 0.35 * g.value('curl');
		t[A.tentWave] *= 0.6 + 0.8 * g.value('sway');
		const colony = g.value('colony');
		if (t[A.chainCount] > 1) t[A.chainCount] = 1 + (t[A.chainCount] - 1) * (0.55 + 0.7 * colony);
		t[A.opacity] = clamp(t[A.opacity] * (0.7 + 0.6 * (1 - g.value('clarity'))), 0.04, 0.97);
		const inner = g.value('innerLight');
		t[A.organGlow] *= 0.55 + 0.9 * inner;
		const photo = g.value('photophores');
		t[A.photoDensity] *= 0.45 + 1.1 * photo;
		t[A.photoRim] *= 0.6 + 0.8 * photo;
		t[A.photoTentacle] *= 0.6 + 0.8 * photo;
		t[A.size] *= 0.86 + 0.28 * g.value('bodySize');
		const frill = g.value('frill');
		t[A.oral] *= 0.6 + 0.8 * frill;
		t[A.fin] *= 0.7 + 0.6 * frill;

		// Mood, continuously: heavy music builds a heavier, denser, brighter-cored
		// body; agitation bristles it (spines out, tentacles kinked and drawn in,
		// a ragged margin, sparks of photophores); calm lets it trail long and
		// slow; a pulsing groove strengthens the jet and the rim.
		const md = this.mood;
		const mass = md.mass;
		const ag = md.agitation;
		t[A.size] *= 0.86 + 0.3 * mass;
		t[A.bellR] *= 0.92 + 0.16 * mass;
		t[A.organGlow] *= 0.55 + 0.9 * mass;
		t[A.opacity] = clamp(t[A.opacity] + (mass - 0.5) * 0.14, 0.04, 0.97);
		// Calm music trades flashes for a steady inner glow.
		t[A.rimGlow] *= 0.8 + 0.25 * mass + 0.35 * md.pulse + 0.45 * md.calm;
		t[A.organGlow] *= 1 + 0.5 * md.calm;
		t[A.spines] += ag * 0.8;
		t[A.tentCurl] += ag * 1.1;
		t[A.tentWave] *= 1 + ag * 0.9 + md.calm * 0.25;
		t[A.tentLen] *= 1 - ag * 0.32 + md.calm * 0.2;
		t[A.lobeAmp] += ag * 0.12;
		t[A.photoDensity] += ag * 0.5 + md.pulse * 0.2;
		t[A.photoTentacle] *= 1 + md.pulse * 0.6;
		t[A.jet] *= 1 + md.pulse * 0.6;
		// Calm music breathes its light; it does not sparkle on every note.
		t[A.notesGain] *= (0.7 + 0.6 * md.punch) * (1 - 0.45 * md.calm);

		// Skin: a material crossfade on top of the species' own membrane.
		const skin = this.pick('skin');
		this.scratchA.set(t);
		this.scratchB.set(t);
		this.applySkin(this.scratchA, skin.from, 1);
		this.applySkin(this.scratchB, skin.to, 1);
		for (let i = 0; i < SOMA_ANATOMY_SIZE; i += 1) t[i] = lerp(this.scratchA[i], this.scratchB[i], skin.mix);

		// Life stage: growth buds the colony and lengthens the reach; dormancy
		// draws the animal in, bloom opens it.
		const [, sprout, , bloom, shedding, dormancy] = this.lifecycle;
		const growth = this.growth;
		// Weighted by how colonial the blend already is, so a solitary animal
		// morphing into a colony buds smoothly from one member (no jump at 1).
		const excess = Math.max(0, t[A.chainCount] - 1);
		t[A.chainCount] = 1 + Math.max(0, excess + (growth * 1.6 + sprout * 0.4 - 1.1) * smoothstep(0, 1, excess));
		t[A.chainSpacing] *= 0.86 + 0.24 * growth;
		t[A.tentLen] *= 0.82 + 0.3 * growth + bloom * 0.08 - dormancy * 0.12;
		t[A.rimGlow] *= 0.75 + 0.35 * bloom + 0.2 * this.energy - 0.25 * dormancy;
		t[A.organGlow] *= 0.8 + 0.3 * bloom + 0.15 * shedding;
		t[A.bellOpen] = clamp(t[A.bellOpen] * (1 - dormancy * 0.15), 0, 1);
		// The fin skirt is a blade along a long, slender body; wrapped round a
		// wide bell it nearly coincides with the bell's own surface and the
		// march shows banded moire. Only a slender body keeps its skirt.
		t[A.fin] *= 1 - smoothstep(0.4, 0.62, t[A.bellR] / Math.max(0.1, t[A.bellH]));
	}

	/** hurry: how much faster than a living pace the genome wants the counts to change (after a shift). */
	private resolveCounts(dt: number, hurry: number): void {
		const species = this.pick('species');
		const dominant = species.mix >= 0.5 ? species.to : species.from;
		const lobesTarget = somaSpeciesFold(dominant, this.pick('fold').to);
		let armsTarget = somaSpeciesArms(dominant, this.pick('arms').to);
		// A hybrid that has inherited real tentacles from its kin wears them,
		// even when its dominant kin has none: count them from the strongest
		// armed kin in the blend. (A body with tentacle length but no tentacles
		// also renders badly: the bare membrane loses its shading.)
		if (armsTarget === 0 && this.target[A.tentLen] > 0.25) {
			let best = -1;
			for (let i = 0; i < SOMA_SPECIES.length; i += 1) {
				if (i === dominant || somaSpeciesArms(i, 0) === 0) continue;
				if (best < 0 || this.kinWeights[i] > this.kinWeights[best]) best = i;
			}
			if (best >= 0 && this.kinWeights[best] > 0.02) armsTarget = somaSpeciesArms(best, this.pick('arms').to);
		}
		// A count cannot glide, so the feature folds away and regrows at the new
		// count: scallops relax smooth, tentacles retract into the body.
		if (lobesTarget !== this.lobes) {
			this.lobeFade = Math.max(0, this.lobeFade - (dt * hurry) / 0.9);
			if (this.lobeFade <= 0 || this.lobes === 0) {
				this.lobes = lobesTarget;
				this.lobeFade = this.lobes === 0 ? 1 : 0;
			}
		} else this.lobeFade = Math.min(1, this.lobeFade + (dt * hurry) / 1.4);
		// The appendages are most of the animal's silhouette, so they have a speed
		// limit like the rest of the body: however much the genome hurries after
		// a shift, the tips travel at most ~0.75 body units a second, and long
		// tentacles take proportionally longer to draw in or grow out.
		const reach = Math.max(0.6, this.anatomy[A.tentLen]);
		const tipLimit = (dt * 0.75) / reach;
		if (armsTarget !== this.arms) {
			this.armFade = Math.max(0, this.armFade - Math.min((dt * hurry) / 1.1, tipLimit));
			if (this.armFade <= 0 || this.arms === 0) {
				this.arms = armsTarget;
				this.armFade = 0;
			}
		} else this.armFade = Math.min(1, this.armFade + Math.min((dt * hurry) / 2.2, tipLimit));
		// Slow on purpose: the bounding radius follows it, and the animal's light
		// in the water is softened by that radius, so a fast change reads as a
		// whole-body flash or blackout when tentacles first appear or vanish.
		this.armPresence = approach(this.armPresence, this.arms > 0 ? 1 : 0, 2.5, dt);
	}

	private resolvePalette(dt: number, director: VisualDirectorFrame, rate: number): void {
		const g = this.genome;
		const palette = this.pick('palette');
		const roles = this.pick('roles');
		const from = SOMA_PALETTES[palette.from];
		const to = SOMA_PALETTES[palette.to];
		const context = director.context;
		// A hue lean that never parks: the genome's drift, the key, and a slow
		// free lane wide enough to carry a palette into a neighbouring colour.
		const lean =
			g.value('hueDrift') * 0.035 +
			this.dr[DRIFT.hue] * 0.075 +
			(finite(context.keyPitchClass, 0.5) - 0.5) * 0.04 * clamp(finite(context.keyConfidence), 0, 1);
		const colors = this.frame.colors;
		// Colour temperature of the living light from the music's warmth: a white
		// balance on the emitters (and a little on the tissue), never a wash.
		const w = (this.mood.warmth - 0.5) * 2;
		const wb: Rgb = w >= 0 ? [1 + 0.3 * w, 1 - 0.03 * w, 1 - 0.45 * w] : [1 + 0.3 * w, 1 + 0.03 * w, 1 - 0.3 * w];
		const mp = this.moodPalette;
		const moodFrom = SOMA_PALETTES[mp.from];
		const moodTo = SOMA_PALETTES[mp.to];
		const moodMix = smoothstep(0, 1, mp.mix);
		const moodWeight = this.moodPaletteWeight;
		const moodColor = (key: 'water' | 'haze' | 'body' | 'glow' | 'accent' | 'organ', i: number) => lerp(moodFrom[key][i], moodTo[key][i], moodMix);
		const permute = (p: typeof from, r: number): [Rgb, Rgb, Rgb] => {
			const perm = SOMA_ROLE_PERMUTATIONS[r];
			const lights = [p.glow, p.accent, p.organ];
			return [lights[perm[0]], lights[perm[1]], lights[perm[2]]];
		};
		const lightsFromA = permute(from, roles.from);
		const lightsFromB = permute(from, roles.to);
		const lightsToA = permute(to, roles.from);
		const lightsToB = permute(to, roles.to);
		const target = this.colorScratch;
		const blend = (key: 'water' | 'haze' | 'body', out: Rgb) => {
			const share = moodWeight * (key === 'body' ? 0.5 : 0.6);
			for (let i = 0; i < 3; i += 1) target[i] = lerp(lerp(from[key][i], to[key][i], palette.mix), moodColor(key, i), share);
			hueRotate(target, lean, target);
			if (key === 'body') for (let i = 0; i < 3; i += 1) target[i] *= lerp(1, wb[i], 0.5);
			for (let i = 0; i < 3; i += 1) out[i] = approach(out[i], target[i], rate, dt);
		};
		blend('water', colors.water);
		blend('haze', colors.haze);
		blend('body', colors.body);
		const lights: Rgb[] = [colors.glow, colors.accent, colors.organ];
		const lightKeys = ['glow', 'accent', 'organ'] as const;
		for (let role = 0; role < 3; role += 1) {
			for (let i = 0; i < 3; i += 1) {
				const a = lerp(lightsFromA[role][i], lightsFromB[role][i], roles.mix);
				const b = lerp(lightsToA[role][i], lightsToB[role][i], roles.mix);
				target[i] = lerp(lerp(a, b, palette.mix), moodColor(lightKeys[role], i), moodWeight * 0.7) * wb[i];
			}
			hueRotate(target, lean, target);
			for (let i = 0; i < 3; i += 1) lights[role][i] = approach(lights[role][i], target[i], rate, dt);
		}
	}

	private resolveEnvironment(dt: number, rate: number): void {
		const g = this.genome;
		const environment = this.pick('environment');
		const a = SOMA_ENVIRONMENT_SPECS[SOMA_ENVIRONMENTS[environment.from]];
		const b = SOMA_ENVIRONMENT_SPECS[SOMA_ENVIRONMENTS[environment.to]];
		const m = environment.mix;
		const env = this.frame.env;
		const murk = g.value('murk');
		const dwell = this.anatomy[A.dwell];
		const md = this.mood;
		// The animal drifts up toward the light and sinks into the dark on its
		// own slow lane: deeper water gets less daylight, fainter shafts and
		// loses its reds; the water's clarity wanders too.
		const deep = 0.5 + 0.5 * this.dr[DRIFT.depth];
		const clarity = 1 + 0.35 * this.dr[DRIFT.murk];
		env.fog = approach(env.fog, lerp(a.fog, b.fog, m) * (0.75 + 0.55 * murk) * (1 + md.calm * 0.2 + md.agitation * 0.15) * clarity, rate, dt);
		for (let i = 0; i < 3; i += 1) {
			const absorb = lerp(a.absorb[i], b.absorb[i], m) * (i === 0 ? lerp(0.9, 1.25, deep) : i === 2 ? lerp(1.05, 0.92, deep) : 1);
			env.absorb[i] = approach(env.absorb[i], absorb, rate, dt);
		}
		env.down = approach(env.down, lerp(a.down, b.down, m) * lerp(1, 0.1, deep), rate, dt);
		// The seabed rises to meet a floor-dwelling animal.
		// Deep water is near the bottom: as the animal sinks the seabed rises
		// into view, lit only by the animal's own light pooling on it.
		const seabed = lerp(lerp(a.floorY, b.floorY, m), Math.max(lerp(a.floorY, b.floorY, m), -3.4), smoothstep(0.45, 0.95, deep));
		this.envFloor = approach(this.envFloor, lerp(seabed, -2.7, dwell), rate * 0.8, dt);
		env.floorY = this.envFloor;
		env.surfaceY = approach(env.surfaceY, lerp(a.surfaceY, b.surfaceY, m), rate, dt);
		env.reflect = approach(env.reflect, lerp(a.reflect, b.reflect, m), rate, dt);
		env.snow = approach(env.snow, lerp(a.snow, b.snow, m) * (0.5 + g.value('snow')) * (0.75 + md.agitation * 0.8 + md.calm * 0.2), rate, dt);
		env.shafts = approach(env.shafts, lerp(a.shafts, b.shafts, m) * (1 + md.calm * 0.3 - md.agitation * 0.4) * lerp(1.2, 0.35, deep), rate, dt);
		env.keyPower = approach(env.keyPower, lerp(a.keyPower, b.keyPower, m) * lerp(1.1, 0.7, deep), rate, dt);
		env.ambient = approach(env.ambient, lerp(a.ambient, b.ambient, m) * lerp(1.1, 0.6, deep), rate, dt);
		env.exposure = approach(env.exposure, lerp(a.exposure, b.exposure, m) * (1 + md.calm * 0.1), rate, dt);
		// The plankton layer drifts up and down past the animal and thickens and
		// thins on its own lanes; deeper water holds more of it.
		const layer = lerp(PLANKTON[environment.from] ?? 0.5, PLANKTON[environment.to] ?? 0.5, m);
		env.layer = approach(env.layer, layer * (0.25 + 0.75 * (0.5 + 0.5 * this.dr[DRIFT.layer])) * lerp(0.7, 1.2, deep), rate, dt);
		env.layerY = approach(env.layerY, 0.6 + 3.4 * this.dr[DRIFT.layerY], rate, dt);
		const azimuth = (g.value('lightAzimuth') - 0.5) * 1.4 + this.dr[DRIFT.light] * 0.6;
		const ca = Math.cos(azimuth);
		const sa = Math.sin(azimuth);
		const kx = lerp(a.keyDir[0], b.keyDir[0], m);
		const ky = lerp(a.keyDir[1], b.keyDir[1], m);
		const kz = lerp(a.keyDir[2], b.keyDir[2], m);
		const key: Vec3 = [kx * ca - kz * sa, ky, kx * sa + kz * ca];
		normalize(key);
		for (let i = 0; i < 3; i += 1) env.keyDir[i] = approach(env.keyDir[i], key[i], rate, dt);
		normalize(env.keyDir);
		// Key colour: the environment's light leaning into the palette's lit water.
		const haze = this.frame.colors.haze;
		const peak = Math.max(1e-4, haze[0], haze[1], haze[2]);
		const tintMix = lerp(a.keyTintMix, b.keyTintMix, m);
		for (let i = 0; i < 3; i += 1) {
			const tint = lerp(a.keyTint[i], b.keyTint[i], m);
			this.frame.keyColor[i] = approach(this.frame.keyColor[i], lerp(haze[i] / peak, tint, tintMix), rate, dt);
		}
	}

	/** The animal's extent and bounding sphere in its own body frame. */
	private bounds(
		t: Float32Array = this.anatomy,
		armFade = this.armFade
	): { centerY: number; centerChain: number; radius: number; extent: number; core: number } {
		const R = Math.max(t[A.bellR] * (1 + 0.45 * t[A.fin]), t[A.bellH]);
		const len = t[A.tentLen] * (0.3 * this.armPresence + 0.7 * armFade * (this.arms > 0 ? 1 : 0));
		const rootR = t[A.tentRoot] * t[A.bellR];
		const rootY = t[A.tentRootY] * t[A.bellH];
		const dir = t[A.tentDir];
		const tipR = rootR + Math.abs(Math.sin(dir)) * len + Math.abs(t[A.tentCurl]) * 0.35 * len + t[A.tentWave] * 0.15 * len;
		const tipY = rootY + Math.cos(dir) * len;
		const oralY = -t[A.bellH] * 0.2 - t[A.tentLen] * 0.5 * t[A.oral];
		const top = Math.max(R, t[A.bellH] + t[A.stalk], tipY);
		const bottom = Math.min(-R, tipY, oralY);
		const radial = Math.max(R, tipR) + t[A.spines] * 0.35 + t[A.cerata] * 0.3;
		const half = (top - bottom) / 2;
		const chain = Math.max(0, Math.ceil(t[A.chainCount]) - 1) * t[A.chainSpacing];
		const radius = (Math.hypot(half, radial) + chain * 0.5 + t[A.chainCurve] * 0.6 + 0.15) * 1.08;
		const extent = Math.max(half, radial) + chain * 0.5;
		// The body without its trailing appendages: what framing must keep in shot.
		const core = Math.max(t[A.bellR], t[A.bellH]) + t[A.spines] * 0.2 + Math.max(0, t[A.chainCount] - 1) * t[A.chainSpacing] * 0.5;
		return { centerY: (top + bottom) / 2, centerChain: chain * 0.5, radius, extent, core };
	}

	update(input: SomaLookInput): SomaFrame {
		const dt = clamp(finite(input.dt, 1 / 60), 0, 0.1);
		const director = input.director;
		const spectrum = input.spectrum;
		const clock = director.clock;
		const live = input.live && !director.silence;
		const motionScale = input.motionScale ?? 1;
		const impactScale = input.impactScale ?? 1;
		this.clock += dt;
		this.feel(dt, input.character);
		// The anatomy continuum drifts faster in loud, busy music and nearly
		// holds in silence; never on a loop, never parked.
		const drifting = (0.75 + this.energy * 0.5 + this.mood.agitation * 0.35) * (1 - this.silence * 0.7);
		stretch(this.kin.update(dt, drifting), this.kn);
		stretch(this.traits.update(dt, drifting), this.tr);
		stretch(this.drift.update(dt, 0.8 + this.energy * 0.4), this.dr);

		// ── Envelopes, owned here so a new source never dips them.
		const rms = live ? clamp(finite(spectrum.bass * 0.4 + spectrum.mid * 0.4 + spectrum.treble * 0.2), 0, 1) : 0;
		if (!live || rms < 0.01) this.quietFor += dt;
		else this.quietFor = 0;
		const quiet = this.quietFor > 0.5;
		this.silence = approach(this.silence, quiet ? 1 : 0, quiet ? 0.6 : 0.15, dt);
		const sectionEnergy = clamp(finite(director.context.sectionEnergy), 0, 1);
		// The section's weight, glided over seconds: a drop lights the water more
		// than a verse, but as a slow swell between sections, never a pulse.
		this.sectionGlow = approach(this.sectionGlow, live ? sectionEnergy : 0, 3, dt);
		const energyTarget = live ? clamp(director.energy * 0.6 + sectionEnergy * 0.25 + rms * 0.25, 0, 1) : 0;
		this.energy = approach(this.energy, energyTarget, 0.35, dt);
		this.bass = approach(this.bass, live ? spectrum.bass : 0, 0.09, dt);
		this.mid = approach(this.mid, live ? spectrum.mid : 0, 0.12, dt);
		this.treble = approach(this.treble, live ? spectrum.treble : 0, 0.07, dt);
		// Punchy music flashes sharp (fast release), soft music glows out slowly.
		const release = lerp(1.35, 0.6, this.mood.punch);
		const kickTarget = clamp(finite(input.mk2.kick) * impactScale, 0, 1);
		this.kick = approach(this.kick, kickTarget, kickTarget > this.kick ? 0.015 : 0.16 * release, dt);
		const sparkleTarget = clamp(finite(input.mk2.sparkle), 0, 1);
		this.sparkle = approach(this.sparkle, sparkleTarget, sparkleTarget > this.sparkle ? 0.02 : 0.2 * release, dt);
		// Calm music glows; it does not flash.
		const impactTarget = clamp(finite(input.mk2.impact) * impactScale * (1 - 0.45 * this.mood.calm), 0, 1);
		this.impact = approach(this.impact, impactTarget, impactTarget > this.impact ? 0.015 : 0.2 * release, dt);

		const lifeTarget = somaLifecycleTarget(director.section);
		for (let i = 0; i < 6; i += 1) this.lifecycle[i] = approach(this.lifecycle[i], lifeTarget[i], 3, dt);
		const phrasePos = clamp(finite(clock.phrasePos), 0, 1);
		const growthTarget = clamp(
			// A smooth swell across the phrase (no drop at the phrase boundary).
			0.1 + sectionEnergy * 0.32 + (0.5 - 0.5 * Math.cos(phrasePos * Math.PI * 2)) * 0.3 + director.drop.buildProgress * 0.2 + this.lifecycle[3] * 0.2 - this.lifecycle[5] * 0.3,
			0,
			1
		);
		this.growth = approach(this.growth, growthTarget * (1 - this.silence * 0.4), 2.4, dt);

		// ── Genome: mutations only on boundaries; silence holds the look.
		const phraseIndex = Math.max(0, Math.floor(finite(clock.phraseIndex)));
		if (!this.started) {
			// Lab stills of different sections open on different animals, and the
			// first real frame is not itself a boundary.
			const ordinal = Math.max(0, SECTION_ORDER.indexOf(director.section));
			for (let i = 0; i <= ordinal; i += 1) {
				this.genome.advance({ phraseIndex: i, sectionKey: `warm-${i}`, energy: 0.5, dt: 0 });
			}
			this.genome.advance({ phraseIndex, sectionKey: director.section, energy: this.energy, dt: 0 });
			this.genome.settle();
			// The first frame already wears the mood of what is playing.
			if (input.character) Object.assign(this.mood, this.moodTarget);
			this.started = true;
			this.resolveAnatomy();
			this.anatomy.set(this.target);
			const species = this.pick('species');
			const dominant = species.mix >= 0.5 ? species.to : species.from;
			this.lobes = somaSpeciesFold(dominant, this.pick('fold').to);
			this.arms = somaSpeciesArms(dominant, this.pick('arms').to);
			this.lobeFade = 1;
			this.armFade = 1;
			this.armPresence = this.arms > 0 ? 1 : 0;
			this.resolvePalette(10, director, 0.01);
			this.resolveEnvironment(10, 0.01);
			const env = this.frame.env;
			this.envFloor = env.floorY;
			this.placeAnimal();
			// Whatever shift is current when the look first appears is adopted, not answered.
			if (input.character) this.answeredShift = input.character.shiftSerial;
		} else if (input.live) {
			const speciesBefore = this.pick('species').to;
			const shifted = this.answerShift(input.character);
			this.moodLight(dt, input.character, shifted);
			this.weightsAge += dt;
			if (input.character && this.weightsAge > 2) this.applyMoodWeights(3);
			this.genome.advance({ phraseIndex, sectionKey: director.section, energy: this.energy, dt });
			if (this.pick('species').to !== speciesBefore) this.applyWeights();
		}

		// ── Resolve: genome -> anatomy, palette, world; then glide again. The
		// second glide speeds up with the genome's after a shift.
		const quick = Math.max(1, this.genome.glideSpeed);
		this.resolveAnatomy();
		// Retracting and regrowing appendages keep pace with the genome after a shift.
		this.resolveCounts(dt, 1 + (quick - 1) * 0.6);
		const bodyTau = 0.7 / (1 + (quick - 1) * 0.5);
		// A body changes shape at a living pace even when the genome hurries: each
		// value moves at most ~80% of its own scale per second, a colony buds at
		// most about one member a second, and tentacle tips travel at most ~0.75
		// body units a second (a relative limit would let long tentacles collapse
		// in under a second, which reads as a cut).
		for (let i = 0; i < SOMA_ANATOMY_SIZE; i += 1) {
			const next = approach(this.anatomy[i], this.target[i], bodyTau, dt);
			const scale = Math.max(0.5, Math.abs(this.anatomy[i]), Math.abs(this.target[i]) * 0.5);
			const limit = dt * (i === A.chainCount ? 0.9 : i === A.tentLen ? Math.min(0.75, 0.8 * scale) : 0.8 * scale);
			this.anatomy[i] += clamp(next - this.anatomy[i], -limit, limit);
		}
		this.resolvePalette(dt, director, 0.7 / quick);
		this.resolveEnvironment(dt, 1.4 / quick);

		// The organs: each answers its own part of the ensemble.
		const colors = this.frame.colors;
		const organism = this.frame.organism;
		this.parts.update({
			ensemble: input.ensemble,
			dt,
			silence: this.silence,
			glow: colors.glow,
			accent: colors.accent,
			organ: colors.organ,
			reroute: this.rerouteNow,
			restless: clamp(0.25 + this.energy * 0.5 + this.mood.agitation * 0.4, 0, 1),
			center: organism.boundCenter,
			radius: organism.boundRadius
		});
		this.rerouteNow = 0;

		this.live(dt, input, live, motionScale);
		return this.publish(input.aspect);
	}

	private placeAnimal(): void {
		const b = this.bounds();
		const floor = this.envFloor;
		this.pos[0] = (hash01(this.seed, 3, 1) - 0.5) * 1.6;
		this.pos[1] = clamp(0.2, floor + b.extent * 0.6 + 0.8, 1.6);
		this.pos[2] = (hash01(this.seed, 3, 2) - 0.5) * 1.2;
		this.vel[0] = this.vel[1] = this.vel[2] = 0;
		for (let i = 0; i < 3; i += 1) {
			this.camTarget[i] = this.pos[i];
			this.camBase[i] = this.pos[i];
		}
		const pose = this.cameraPose(b.extent * this.anatomy[A.size], b.core * this.anatomy[A.size]);
		this.camAzimuth = pose.azimuth;
		this.camElevation = pose.elevation;
		this.camDistance = pose.distance;
		this.camAperture = pose.aperture;
		this.camFocal = pose.focal;
		this.placeEye();
	}

	/** Eye from the smoothed spherical rig, kept inside the water column. */
	private placeEye(): void {
		const ce = Math.cos(this.camElevation);
		this.camEye[0] = this.camBase[0] + this.camDistance * ce * Math.cos(this.camAzimuth);
		this.camEye[1] = this.camBase[1] + this.camDistance * Math.sin(this.camElevation);
		this.camEye[2] = this.camBase[2] + this.camDistance * ce * Math.sin(this.camAzimuth);
		this.camEye[1] = clamp(this.camEye[1], this.envFloor + 0.45, this.frame.env.surfaceY - 0.5);
	}

	private cameraSpec(): SomaCameraSpec {
		const camera = this.pick('camera');
		const a = SOMA_CAMERA_SPECS[SOMA_CAMERAS[camera.from]];
		const b = SOMA_CAMERA_SPECS[SOMA_CAMERAS[camera.to]];
		const m = camera.mix;
		return {
			elevation: lerp(a.elevation, b.elevation, m),
			distance: lerp(a.distance, b.distance, m),
			azimuth: lerp(a.azimuth, b.azimuth, m),
			orbit: lerp(a.orbit, b.orbit, m),
			aperture: lerp(a.aperture, b.aperture, m),
			focal: lerp(a.focal, b.focal, m),
			focusAlong: lerp(a.focusAlong, b.focusAlong, m),
			follow: lerp(a.follow, b.follow, m)
		};
	}

	/**
	 * Where the diver wants to be. The genome's camera regime is only a bias
	 * (below, alongside, close, far back...); the rig roams freely around it,
	 * so the same regime never films the same shot twice.
	 */
	private cameraPose(extent: number, core: number): { azimuth: number; elevation: number; distance: number; aperture: number; focal: number } {
		const spec = this.cameraSpec();
		const g = this.genome;
		const r = this.rig.value;
		// A floor dweller is filmed from a little above, as a diver would, so the
		// seabed never pushes the eye up underneath it.
		const elevation = clamp(
			spec.elevation * 0.55 + r[RIG.elevation] * 0.6 + g.value('camHeight') * 0.12 + this.target[A.dwell] * 0.3,
			-0.75,
			0.95
		);
		// Heading-relative regimes (profile) track the animal's side; the rest
		// orbit in world space so the animal turns within the shot.
		// Both angles are unwrapped; the 2-pi branch only re-anchors while the
		// regime ignores the heading, so the result is continuous.
		const follow = clamp(spec.follow + r[RIG.follow] * 0.4, 0, 1);
		const relative = this.heading + Math.PI * 0.5 - this.orbit;
		if (follow < 0.02) this.followBranch = Math.round(relative / (Math.PI * 2)) * Math.PI * 2;
		const toHeading = relative - this.followBranch;
		const azimuth = this.orbit + spec.azimuth + follow * toHeading + g.value('camSide') * 0.45 + r[RIG.azimuth] * 1.1;
		// Never inside the animal: at least its bounding radius plus a margin.
		// Calm music steps back to show the animal in its water; frantic music
		// moves in close and hand-held; a groove sits a little closer.
		const md = this.mood;
		const moodDistance = lerp(1, 1.2, md.calm) * lerp(1, 0.78, md.agitation) * lerp(1, 0.92, md.pulse);
		// The roamed distance spans intimate to far; calm music roams the far
		// half (the animal small in its water), agitation the near half.
		const near = 0.72 + 0.2 * md.calm - 0.08 * md.agitation;
		const far = 1.9 + 0.2 * md.calm - 0.65 * md.agitation;
		const roam = lerp(near, far, 0.5 + 0.5 * r[RIG.distance]);
		// The ensemble moves the diver too, slowly: a build gathers it in, a
		// breakdown (the animal drawing in) lets it drift back, and the matrix
		// leans the distance on whatever it is listening to.
		const parts = this.parts;
		const gather = (1 - 0.12 * parts.build) * (1 + 0.16 * parts.drawIn01()) * lerp(0.92, 1.1, parts.mod('camera', 'distance'));
		// Far, but never so far the body shrinks to a speck: the core's
		// projected radius stays at least a third of the frame height (the
		// core estimate is generous, so the visible body reads smaller). A
		// small animal alone in black water reads as the same picture whatever
		// the animal is.
		const furthest = Math.max(3, (core * spec.focal) / 0.34);
		const distance = Math.max(
			Math.min(spec.distance * roam * moodDistance * gather * (0.9 + extent * 0.85), furthest),
			this.frame.organism.boundRadius * 1.2 + 0.4
		);
		// Calm music holds a deeper focus, so the long slow animal stays readable.
		return {
			azimuth,
			elevation,
			distance,
			aperture: spec.aperture * 0.85 * (1 - 0.5 * md.calm) * (1 - 0.25 * r[RIG.distance]),
			focal: spec.focal * (1 + 0.1 * r[RIG.focal])
		};
	}

	private live(dt: number, input: SomaLookInput, live: boolean, motionScale: number): void {
		const director = input.director;
		const clock = director.clock;
		const t = this.anatomy;
		const b = this.bounds();
		// Musical time from the ensemble's own grid (heard), not the director's
		// clock, which often locks to half time.
		const ens = input.ensemble;
		const tempo = clamp(ens && ens.grid.known ? finite(ens.grid.bpm, 110) : finite(clock.tempoBpm, 110), 50, 190);
		const awake = 1 - this.silence * 0.85;
		const md = this.mood;
		const ag = md.agitation;
		const calm = md.calm;
		const pulse = md.pulse;
		this.snowPhase += dt * (0.6 + md.tempo * 0.9 + ag * 2.4) * motionScale;
		this.shiverPhase = (this.shiverPhase + dt * Math.PI * 2 * 7.5) % (Math.PI * 2);
		// Shader phases, integrated at rates that wander (never time * k): the
		// water current, the comb rows' running light (treble drives it) and the
		// iridescent film's slide.
		const d = this.dr;
		this.currentPhase += dt * 0.35 * (0.55 + 0.45 * (1 + d[DRIFT.current])) * (0.7 + md.tempo * 0.6) * motionScale;
		this.combPhase = (this.combPhase + dt * 9 * (0.4 + this.treble)) % 6283.1853;
		this.filmPhase += dt * 0.35 * (0.5 + 0.5 * (1 + d[DRIFT.hue])) * motionScale;

		// Muscle: the bell squeezes on each heard bass note (a fast squeeze, then
		// a refill as long as the articulation: staccato short and sharp, legato
		// long and slow). Without a bass line it follows the kick instead. It
		// never runs on the predicted beat clock.
		if (ens) {
			if (ens.bass.noteSerial !== this.lastBassSerial) {
				if (this.lastBassSerial >= 0) this.sinceBassNote = 0;
				this.lastBassSerial = ens.bass.noteSerial;
			}
			this.sinceBassNote += dt;
		}
		const kickFallback = ens ? smoothstep(1.5, 3, this.sinceBassNote) * this.parts.voice('kick') : this.kick;
		const squeeze = this.parts.squeezeUpdate(dt, kickFallback);
		// A groove squeezes hard; calm music barely flexes; agitation adds a fine
		// tremor on top, the bell shivering.
		const strength = (0.55 + 0.5 * this.energy) * (0.75 + pulse * 0.7 - calm * 0.2);
		this.breathe += dt * (0.28 + this.energy * 0.1) * (1 - calm * 0.35) * (0.75 + 0.3 * (1 + d[DRIFT.breath]));
		const idle = (0.5 + 0.5 * Math.sin(this.breathe * Math.PI * 2)) * 0.22;
		const tremor = ag * 0.07 * (0.5 + 0.5 * Math.sin(this.shiverPhase)) * awake;
		const contractionTarget = (live ? Math.max(squeeze * strength * awake, idle * 0.6) : idle) + (live ? tremor : 0);
		const previous = this.contraction;
		this.contraction = approach(this.contraction, contractionTarget, 0.035, dt);
		const squeezing = Math.max(0, this.contraction - previous) / Math.max(dt, 1e-3);

		// Beat light: a packet set off by each heard kick (parts.ts), running at
		// the ensemble's tempo through the body.
		const lanes = this.parts.lanes;
		const packetAt = SOMA_PART_SLOTS.indexOf('compM') * 4;
		this.packet = live ? clamp(lanes[packetAt + 2] * (0.5 + this.energy * 0.6) * (1 - 0.5 * this.mood.calm), 0, 1.4) : 0;
		this.packetPhase = lanes[packetAt + 3];
		if (ens) this.lastBeat = ens.drums.kick.serial;

		const energyRate = 0.55 + this.energy * 0.9;
		// Legato music undulates the tentacles continuously; staccato music holds
		// them nearly still between the strokes each hit sends down an arm group.
		const flowing = ens ? lerp(0.35, 1.15, this.parts.articulation) : 1;
		this.sway += dt * energyRate * (0.55 + md.tempo * 0.9) * motionScale * flowing;
		this.fin += dt * Math.PI * 2 * (tempo / 60) * 0.5 * (0.4 + this.energy * 0.7) * motionScale * awake + dt * 0.6;

		// ── Locomotion: waypoint steering inside the shot's volume, jet thrust
		// along the body axis on each contraction.
		const floor = this.envFloor;
		const surface = this.frame.env.surfaceY;
		const yLow = floor + b.extent * 0.55 + 0.5;
		const yHigh = Math.max(yLow + 0.2, Math.min(1.9, surface - b.extent - 0.8));
		const dwell = t[A.dwell];
		this.waypointAge += dt;
		const dx = this.goal[0] - this.pos[0];
		const dy = this.goal[1] - this.pos[1];
		const dz = this.goal[2] - this.pos[2];
		const dist = Math.hypot(dx, dy, dz);
		// Calm music drifts to far, rare goals; agitated music darts between them.
		const hold = lerp(9 + hash01(this.seed, this.waypoint, 9) * 7, 0.8 + hash01(this.seed, this.waypoint, 9) * 0.9, ag) * (1 + calm * 0.6);
		if (this.waypointAge > hold || dist < 0.3) {
			this.waypoint += 1;
			this.waypointAge = 0;
		}
		this.goal[0] = (hash01(this.seed, this.waypoint, 1) - 0.5) * 4.4;
		// A dweller rests its lowest point (stalk foot, belly) on the seabed.
		const ay = this.frame.organism.axisY[1];
		const ax = this.frame.organism.axisX[1];
		const below =
			Math.max((t[A.bellH] + t[A.stalk]) * Math.max(0, -ay), t[A.bellH] * Math.max(0, ay) * 0.9, t[A.bellR] * t[A.squash] * Math.abs(ax)) *
			t[A.size];
		const yDwell = floor + below + 0.03;
		this.goal[1] = lerp(lerp(yLow, yHigh, hash01(this.seed, this.waypoint, 2)), yDwell, dwell);
		this.goal[2] = (hash01(this.seed, this.waypoint, 3) - 0.5) * 3.6;
		const speed =
			(0.08 + this.energy * 0.2) * lerp(1, 0.5, calm) * (1 + ag * 2.8) * (1 + pulse * 0.3) * (1 - dwell * 0.7) * awake * motionScale;
		const gx = this.goal[0] - this.pos[0];
		const gy = this.goal[1] - this.pos[1];
		const gz = this.goal[2] - this.pos[2];
		const gl = Math.hypot(gx, gy, gz) || 1;
		const arrive = Math.min(1, gl / 0.8);
		const axisY = this.frame.organism.axisY;
		const thrust = t[A.jet] * squeezing * 0.025 * (1 + pulse * 1.5) * motionScale;
		const steer = lerp(1.6, 0.25, ag) * (1 + calm * 0.6);
		const desired: Vec3 = [(gx / gl) * speed * arrive, (gy / gl) * speed * arrive, (gz / gl) * speed * arrive];
		// A dweller settles onto the seabed promptly rather than crawling down to it.
		desired[1] += clamp(gy * 1.2, -1, 1) * dwell * awake;
		for (let i = 0; i < 3; i += 1) {
			this.vel[i] = approach(this.vel[i], desired[i], i === 1 ? lerp(steer, 0.5, dwell) : steer, dt) + axisY[i] * thrust * dt;
			this.pos[i] += this.vel[i] * dt;
		}
		this.pos[1] = clamp(this.pos[1], Math.min(yLow, yDwell) - 0.3, yHigh + 0.3);
		this.pos[0] = clamp(this.pos[0], -3, 3);
		this.pos[2] = clamp(this.pos[2], -2.6, 2.6);

		// ── Orientation: heading follows the horizontal velocity; pitch is the
		// species' posture plus a lean into the swim.
		const vh = Math.hypot(this.vel[0], this.vel[2]);
		if (vh > 0.01) this.heading = approachAngle(this.heading, Math.atan2(this.vel[2], this.vel[0]), lerp(2.2, 0.45, ag), dt);
		// A slow turn of its own that wanders, and sometimes reverses.
		this.heading += dt * 0.05 * d[DRIFT.heading] * motionScale;
		const posture = t[A.pitch];
		const horizontal = Math.sin(Math.min(Math.PI, posture));
		const lean = clamp(vh * 2.2, 0, 0.5) * (1 - horizontal) * (posture < 1.6 ? 1 : -1);
		const climb = Math.atan2(this.vel[1], Math.max(vh, 0.05)) * 0.5 * horizontal;
		const pitchTarget = posture + lean - climb + this.genome.value('tilt') * 0.22;
		this.pitch = approach(this.pitch, pitchTarget, 1.2, dt);
		this.roll = t[A.undulate] * 0.1 * Math.sin(this.fin * 0.5) + this.genome.value('tilt') * 0.08;

		// ── Companion: a juvenile of the same species keeping station nearby.
		this.companionPhase += dt * (0.04 + this.energy * 0.05) * 1.6 * d[DRIFT.companion] * motionScale;
		// ── Camera: the diver follows with lag and roams a space of viewpoints.
		// Tempo sets the pace, energy and agitation the restlessness; a heard
		// hit (a big rise of the transient rail) pushes the diver in a little.
		const spec = this.cameraSpec();
		const impact = live ? clamp(finite(input.mk2.impact), 0, 1) : 0;
		// Only a real hit counts (a drop, a slam), not every kick: a refractory
		// keeps the diver from pumping on the beat.
		this.sinceNudge += dt;
		if (impact > 0.7 && impact - this.lastImpact > 0.4 && this.sinceNudge > 6) {
			this.rig.impulse(RIG.distance, -0.45 * impact);
			this.rig.impulse(RIG.azimuth, (hash01(this.seed, this.lastBeat, 13) - 0.5) * 0.5 * impact);
			this.sinceNudge = 0;
		}
		this.lastImpact = impact;
		// A fill turns the diver's head a little, once in a while.
		this.sinceFillNudge += dt;
		if (ens && ens.groove.fillSerial !== this.lastFillSerial) {
			const first = this.lastFillSerial < 0;
			this.lastFillSerial = ens.groove.fillSerial;
			if (!first && this.sinceFillNudge > 8 && live) {
				this.rig.impulse(RIG.azimuth, (hash01(this.seed, ens.groove.fillSerial, 14) - 0.5) * 0.35);
				this.sinceFillNudge = 0;
			}
		}
		const restless = lerp(0.8, 1.2, this.parts.mod('camera', 'restless'));
		this.rig.update(dt, (0.75 + md.tempo * 0.45 + ag * 0.3) * motionScale * awake, clamp((0.25 + this.energy * 0.5 + ag * 0.4) * restless, 0, 1));
		// The orbit is no longer a constant spin: its rate wanders through zero,
		// so the diver drifts round one way, slows, and comes back.
		this.orbit +=
			dt * spec.orbit * 1.6 * d[DRIFT.orbit] * (0.35 + this.energy) * (0.5 + md.tempo * 1.2 + pulse * 0.4) * motionScale * awake;
		// The aim leans along the body (bell or trailing tentacles) by a body's
		// width at most, so the animal never slides out of shot.
		const focusAlong = spec.focusAlong * b.extent + 0.12 * this.rig.value[RIG.focus] * b.core;
		// Look at the whole animal (colony included), leaning towards the regime's part.
		const centre = this.frame.organism.boundCenter;
		const target: Vec3 = [
			centre[0] + (this.pos[0] - this.frame.organism.pos[0]) + axisY[0] * focusAlong,
			centre[1] + (this.pos[1] - this.frame.organism.pos[1]) + axisY[1] * focusAlong,
			centre[2] + (this.pos[2] - this.frame.organism.pos[2]) + axisY[2] * focusAlong
		];
		// Lean the aim from the bounds' centre toward the body, and never further
		// from the body than a fraction of its own size, so long trailing
		// tentacles cannot push the body itself out of the shot.
		const reachAim = b.core * t[A.size] * 0.45;
		const ox = lerp(target[0], this.pos[0], 0.35) - this.pos[0];
		const oy = lerp(target[1], this.pos[1], 0.35) - this.pos[1];
		const oz = lerp(target[2], this.pos[2], 0.35) - this.pos[2];
		const aimOff = Math.hypot(ox, oy, oz);
		const keep = aimOff > reachAim ? reachAim / aimOff : 1;
		target[0] = this.pos[0] + ox * keep;
		target[1] = this.pos[1] + oy * keep;
		target[2] = this.pos[2] + oz * keep;
		for (let i = 0; i < 3; i += 1) {
			// A darting animal is followed tightly, so it stays in the shot.
			this.camTarget[i] = approach(this.camTarget[i], target[i], lerp(1.1, 0.35, ag), dt);
			this.camBase[i] = approach(this.camBase[i], target[i], lerp(2.2, 0.7, ag), dt);
		}
		// Frame the body the animal is becoming, not the one it is leaving, so
		// the shot lands together with the metamorphosis instead of trailing it.
		const becoming = this.bounds(this.target, 1);
		const pose = this.cameraPose(becoming.extent * this.target[A.size], becoming.core * this.target[A.size]);
		// A diver cannot whip round the animal: cap the rig's angular speed.
		const limit = (current: number, next: number, rate: number) => current + clamp(next - current, -rate * dt, rate * dt);
		// After a shift the diver moves to the new shot faster, still as one glide.
		const quick = 1 + (Math.max(1, this.genome.glideSpeed) - 1) * 0.4;
		this.camAzimuth = limit(this.camAzimuth, approach(this.camAzimuth, pose.azimuth, 2.4 / quick, dt), 0.2 * quick);
		this.camElevation = limit(this.camElevation, approach(this.camElevation, pose.elevation, 2.4 / quick, dt), 0.12 * quick);
		// A dolly, not a zoom cut: the distance changes by at most ~30% a second.
		const dolly = approach(this.camDistance, pose.distance, 2.0 / quick, dt);
		this.camDistance = clamp(dolly, this.camDistance * (1 - 0.3 * dt), this.camDistance * (1 + 0.3 * dt));
		this.placeEye();
		this.camAperture = approach(this.camAperture, pose.aperture, 1.5, dt);
		this.camFocal = approach(this.camFocal, pose.focal, 1.5, dt);
		// Framing roams too: the animal sits on a third, high, low, centred...
		const framing = this.genome.value('framing');
		// ...but never so far that a big animal leaves the frame: the room to
		// move is what the screen has left around the animal's apparent size
		// (screen half-height is 0.5, half-width aspect / 2).
		const r = this.rig.value;
		// Trailing appendages may leave the frame; the body itself may not.
		const apparent = (b.core * t[A.size] * this.camFocal) / Math.max(0.5, this.camDistance);
		const roomX = clamp(Math.min(1.8, input.aspect) * 0.5 - apparent * 1.1, 0.05, 0.5);
		const roomY = clamp(0.5 - apparent * 0.95, 0.03, 0.24);
		// Thirds more often than dead centre: the roam eases out of the middle.
		const side = clamp(framing * 0.4 + r[RIG.frameX] * 0.9, -1, 1);
		const thirds = Math.sign(side) * smoothstep(0, 0.5, Math.abs(side));
		this.shiftX = approach(this.shiftX, thirds * roomX, 2, dt);
		// Vertically it may sit low in the frame, or a little high.
		const lift = clamp(Math.abs(framing) * 0.3 + r[RIG.frameY] * 0.9, -1, 1);
		this.shiftY = approach(this.shiftY, -0.03 + (lift < 0 ? lift : lift * 0.5) * roomY, 2, dt);
	}

	private publish(aspect: number): SomaFrame {
		const f = this.frame;
		const g = this.genome;
		const t = this.anatomy;
		const b = this.bounds();
		f.time = this.clock;
		f.lobes = this.lobes;
		f.lobeFade = this.lobeFade;
		f.arms = this.arms;
		f.armFade = this.armFade;
		f.species = this.pick('species');
		f.environment = this.pick('environment');
		f.palette = this.pick('palette');
		f.camera = this.pick('camera');
		f.beatForm = this.pick('beatForm');

		// Body basis from heading, pitch and roll.
		const o = f.organism;
		const fx = Math.cos(this.heading);
		const fz = Math.sin(this.heading);
		const sp = Math.sin(this.pitch);
		const cp = Math.cos(this.pitch);
		const axisY: Vec3 = [sp * fx, cp, sp * fz];
		const axisX: Vec3 = [-cp * fx, sp, -cp * fz];
		const axisZ = cross(axisX, axisY, [0, 0, 0]);
		const cr = Math.cos(this.roll);
		const sr = Math.sin(this.roll);
		for (let i = 0; i < 3; i += 1) {
			o.axisX[i] = axisX[i] * cr + axisZ[i] * sr;
			o.axisZ[i] = axisZ[i] * cr - axisX[i] * sr;
			o.axisY[i] = axisY[i];
			o.pos[i] = this.pos[i];
		}
		const size = t[A.size];
		const dir: Vec3 = normalize([t[A.chainDirX], t[A.chainDirY], t[A.chainDirZ]]);
		const chainLocal: Vec3 = [dir[0] * b.centerChain, dir[1] * b.centerChain + b.centerY, dir[2] * b.centerChain];
		for (let i = 0; i < 3; i += 1) {
			o.boundCenter[i] = o.pos[i] + (o.axisX[i] * chainLocal[0] + o.axisY[i] * chainLocal[1] + o.axisZ[i] * chainLocal[2]) * size;
		}
		o.boundRadius = b.radius * size;
		o.extent = b.extent * size;

		// Drag in body units: a 0.3 u/s swim bends the tentacles by about a fifth of their length.
		for (let i = 0; i < 3; i += 1) {
			const axis = i === 0 ? o.axisX : i === 1 ? o.axisY : o.axisZ;
			const local = (this.vel[0] * axis[0] + this.vel[1] * axis[1] + this.vel[2] * axis[2]) / Math.max(0.3, size);
			f.drag[i] = clamp(local * 0.5, -0.25, 0.25);
		}
		// A juvenile keeps station some of the time, at a distance that wanders.
		const companionAmount = smoothstep(0.4, 0.7, g.value('companion') * 0.7 + (0.5 + 0.5 * this.dr[DRIFT.companion]) * 0.45);
		const cAngle = this.companionPhase;
		// A wide stereo image spreads the pair apart.
		const cDist =
			(o.extent * 2.1 + 1) *
			(0.75 + 0.5 * (0.5 + 0.5 * this.tr[TRAIT.spacing])) *
			(0.85 + 0.45 * this.parts.spread) *
			lerp(0.9, 1.15, this.parts.mod('companion', 'distance'));
		f.companion.pos[0] = o.pos[0] + Math.cos(cAngle) * cDist;
		f.companion.pos[1] = o.pos[1] + 0.6 + noise1(this.noiseSeed, 31, this.clock / 23) * 0.8;
		f.companion.pos[2] = o.pos[2] + Math.sin(cAngle) * cDist - 1.2;
		f.companion.scale = companionAmount * 0.42;
		f.companion.boundRadius = b.radius * size * 0.42;

		// Camera basis, with a diver's slow sway and roll: free noise lanes, no sines.
		const c = f.camera3;
		const d = this.dr;
		const jitter = (lane: number, rate: number) => noise1(this.noiseSeed, lane, this.clock * rate);
		// Agitated music films hand-held: a faster, smaller shake on top of the drift.
		const shake = this.mood.agitation * (0.4 + 0.6 * this.energy) * 0.025;
		const eye: Vec3 = [
			this.camEye[0] + d[DRIFT.swayX] * 0.08 + jitter(40, 0.5) * shake,
			this.camEye[1] + d[DRIFT.swayY] * 0.05 + jitter(41, 0.6) * shake,
			this.camEye[2] + d[DRIFT.swayZ] * 0.07 + jitter(42, 0.45) * shake
		];
		const fwd = normalize([this.camTarget[0] - eye[0], this.camTarget[1] - eye[1], this.camTarget[2] - eye[2]]);
		const right = normalize(cross(fwd, [0, 1, 0], [0, 0, 0]));
		const up = cross(right, fwd, [0, 0, 0]);
		// The matrix rolls the diver's horizon a touch, on its own listening.
		const rollAngle = d[DRIFT.roll] * 0.03 + this.rig.value[RIG.roll] * 0.06 + (this.parts.mod('camera', 'roll') - 0.5) * 0.06;
		const crl = Math.cos(rollAngle);
		const srl = Math.sin(rollAngle);
		for (let i = 0; i < 3; i += 1) {
			c.pos[i] = eye[i];
			c.fwd[i] = fwd[i];
			c.right[i] = right[i] * crl + up[i] * srl;
			c.up[i] = up[i] * crl - right[i] * srl;
		}
		c.focal = this.camFocal;
		c.focusDist = Math.hypot(this.camTarget[0] - eye[0], this.camTarget[1] - eye[1], this.camTarget[2] - eye[2]);
		c.aperture = this.camAperture;
		c.shiftX = this.shiftX;
		c.shiftY = this.shiftY;
		void aspect;

		const m = f.motion;
		m.contraction = this.contraction;
		m.sway = this.sway;
		m.fin = this.fin;
		m.growth = this.growth;
		m.shed = this.lifecycle[4];
		m.packet = this.packet;
		m.packetPhase = this.packetPhase;
		m.beatCount = this.lastBeat;
		m.energy = this.energy;
		m.silence = this.silence;
		m.kick = this.kick;
		m.sparkle = this.sparkle;
		m.impact = this.impact;
		m.bass = this.bass;
		m.mid = this.mid;
		m.treble = this.treble;
		for (let i = 0; i < 6; i += 1) f.lifecycle[i] = this.lifecycle[i];
		// Agitation sheds fragments: spores torn off into the water.
		m.shed = Math.max(m.shed, this.mood.agitation * 0.8);
		Object.assign(f.mood, this.mood);
		f.flow.snow = this.snowPhase;
		f.flow.shiver = this.shiverPhase;
		f.flow.current = this.currentPhase;
		f.flow.comb = this.combPhase;
		f.flow.film = this.filmPhase;
		// Far life: how many distant animals glow in the water, on its own lane.
		f.flow.life = smoothstep(-0.8, 0.8, this.dr[DRIFT.life]);
		// The animal's light power in the water: from the kind of music, never its
		// loudness from moment to moment (that would brighten all the water at once).
		f.flow.light = 0.8 + this.mood.mass * 0.3 + this.mood.pulse * 0.3 + this.sectionGlow * 0.35;
		let form = 0;
		for (let i = 1; i < 6; i += 1) if (this.lifecycle[i] > this.lifecycle[form]) form = i;
		f.names.species = SOMA_SPECIES[f.species.mix >= 0.5 ? f.species.to : f.species.from].name;
		f.names.environment = SOMA_ENVIRONMENTS[f.environment.mix >= 0.5 ? f.environment.to : f.environment.from];
		f.names.palette = SOMA_PALETTES[f.palette.mix >= 0.5 ? f.palette.to : f.palette.from].name;
		f.names.camera = SOMA_CAMERAS[f.camera.mix >= 0.5 ? f.camera.to : f.camera.from];
		f.names.form = SOMA_LIFECYCLE[form];
		f.parts = this.parts.lanes;
		return f;
	}
}

/** The look as it lives in the journey: the look plus the source epoch it last saw. */
export type SomaLookState = { look: SomaLook; epoch: number };

export function createSomaLookState(): SomaLookState {
	return { look: new SomaLook(0.5), epoch: -1 };
}

/**
 * Bind the persistent look to the journey's source epoch, the Prism way:
 * first source of the session resets, a different epoch reseeds (a new song
 * continues the picture), the same epoch resumes exactly (a remount).
 */
export function somaSyncLook(state: SomaLookState, sourceEpoch: number, seed: number): 'reset' | 'reseed' | 'resume' {
	if (state.epoch === sourceEpoch) return 'resume';
	const first = state.epoch === -1;
	if (first) state.look.reset(seed);
	else state.look.reseed(seed);
	state.epoch = sourceEpoch;
	return first ? 'reset' : 'reseed';
}

export const SOMA_LOOK_NAMES = {
	species: SOMA_SPECIES.map((s) => s.name),
	environments: SOMA_ENVIRONMENTS,
	cameras: SOMA_CAMERAS,
	palettes: SOMA_PALETTES.map((p) => p.name),
	beatForms: SOMA_BEAT_FORMS,
	skins: SOMA_SKINS
};
