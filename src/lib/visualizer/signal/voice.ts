// Signal's voice: what kind of instrument the scope is for the music playing
// now. The shared MusicCharacter says what the music is (tempo, weight, punch,
// noise...); the voice turns that into the handful of controls that make one
// genre read as a different instrument from another at a glance:
//
//   ambient   slow, long-persistence Lissajous that breathes
//   cinematic slow, wide, heavy figures with soft cores
//   swing     warm, bouncing, mid persistence
//   acoustic  warm, fine, organic: thin sharp strokes that wander by hand
//   indie     mid tempo, a little grain, open
//   club      locked hypnotic pulses: heavy strokes stepping on the beat
//   noise     fast, jagged, fractured traces with short persistence
//
// Every control glides (about a second, faster right after a shift), so a
// genre change reshapes the instrument within one or two seconds without a
// single frame jumping. The voice is deterministic in its inputs.

import type { CharacterFeature, MusicCharacter } from '$lib/visualizer/character';

function clamp01(value: number): number {
	return Number.isFinite(value) ? (value < 0 ? 0 : value > 1 ? 1 : value) : 0;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

/** The character features Signal steers by, with roughness made robust. */
export type SignalCharacterView = Record<CharacterFeature, number>;

const NEUTRAL: SignalCharacterView = {
	tempo: 0.5,
	energy: 0.4,
	brightness: 0.4,
	bass: 0.5,
	noise: 0.2,
	punch: 0.4,
	motion: 0.5,
	valence: 0.5
};

/**
 * Signal's reading of the character. `noise` here is roughness: the shared
 * noise (spectral motion plus hiss) gated by tempo, so a busy but steady club
 * mix stays clean-edged while a fast wash of noise rock goes jagged, and slow
 * hiss (ambient, cinematic) does not rough anything up.
 */
export function signalCharacterView(
	character: Readonly<MusicCharacter> | null | undefined,
	out: SignalCharacterView = { ...NEUTRAL }
): SignalCharacterView {
	if (!character) {
		Object.assign(out, NEUTRAL);
		return out;
	}
	const tempo = clamp01(character.tempo);
	const punch = clamp01(character.punch);
	const brightness = clamp01(character.brightness);
	out.tempo = tempo;
	out.energy = clamp01(character.energy);
	out.brightness = brightness;
	out.bass = clamp01(character.bass);
	out.punch = punch;
	out.motion = clamp01(character.motion);
	out.valence = clamp01(character.valence);
	out.noise = clamp01(clamp01(character.noise) * 0.6 + smoothstep(0.4, 0.95, tempo) * 0.45 - 0.15);
	return out;
}

export type SignalVoiceFrame = {
	/** Trace speed multiplier from tempo. */
	speed: number;
	/** Added to the per-frame phosphor persistence (long for slow, short for fast). */
	persistence: number;
	/** 0..1 jagged deflection noise on the beam. */
	jitter: number;
	/** 0..1 how much of the beam breaks into fragments. */
	fracture: number;
	/** 0..1 extra tube grain. */
	grain: number;
	/** Stroke width multiplier from bass (and fineness from punch). */
	weight: number;
	/** Low-frequency figure scale multiplier from bass. */
	scale: number;
	/** 0 soft glowing core .. 1 hard etched core: rough and locked music cut hard. */
	sharpness: number;
	/** 0..1 faceplate halation: soft, breathing and hand-played music glows. */
	halation: number;
	/** Emissive gain: rough music burns its fragments hot. */
	gain: number;
	/** -1 cool .. 1 warm phosphor lean, from brightness, valence and touch. */
	temperature: number;
	/** 0..1 club lock: the figure steps on the beat and pulses with the kick. */
	lock: number;
	/** 0..1 ambient breath: slow scale swell and long trails. */
	breathe: number;
	/** 0..1 acoustic hand: slow organic wander of the figure. */
	organic: number;
	/** How many channels the bench lights beyond the conductor's choice. */
	channels: number;
	/** Harmonic complexity lean, -1..1. */
	complexity: number;
};

/** Pure target voice for one character reading (no smoothing). */
export function signalVoiceTarget(view: Readonly<SignalCharacterView>, out: SignalVoiceFrame): SignalVoiceFrame {
	const { tempo, bass, punch, noise: rough, brightness, valence, energy } = view;
	const breathe = (1 - tempo) * (1 - punch) * (1 - rough);
	const lock = smoothstep(0.55, 0.8, bass) * smoothstep(0.35, 0.6, tempo) * (1 - smoothstep(0.5, 0.8, rough));
	const organic = smoothstep(0.5, 0.85, punch) * (1 - rough) * (1 - smoothstep(0.5, 0.75, tempo));
	out.speed = 0.35 + tempo * 1.45 + rough * 0.25;
	out.persistence = (1 - tempo) * (1 - rough) * 0.05 + breathe * 0.02 - rough * 0.05 - lock * 0.01;
	out.jitter = Math.pow(rough, 1.4);
	out.fracture = smoothstep(0.45, 0.9, rough);
	out.grain = rough * 0.7;
	out.weight = (0.72 + bass * 0.62) * (1 - punch * 0.3) * (1 + lock * 0.12);
	out.scale = 0.84 + bass * 0.3 + breathe * 0.06;
	out.sharpness = clamp01(punch * 0.3 + rough * 0.8 + lock * 0.4);
	out.halation = clamp01(0.35 + breathe * 0.5 + organic * 0.45 - rough * 0.35 - lock * 0.1);
	out.gain = 1 + rough * 0.8 + lock * 0.08 - breathe * 0.08;
	out.temperature = Math.max(
		-1,
		Math.min(
			1,
			(valence - 0.5) * 1.4 + punch * 0.7 - bass * 0.25 - (brightness - 0.5) * 0.8 - breathe * 0.75 + energy * 0.1
		)
	);
	out.lock = lock;
	out.breathe = breathe;
	out.organic = organic;
	out.channels = rough * 1.4 + lock * 0.5 - breathe * 0.9;
	out.complexity = rough * 0.6 + lock * 0.2 - breathe * 0.45 + organic * 0.15;
	return out;
}

export function createSignalVoiceFrame(): SignalVoiceFrame {
	return {
		speed: 1,
		persistence: 0,
		jitter: 0,
		fracture: 0,
		grain: 0,
		weight: 1,
		scale: 1,
		sharpness: 0.4,
		halation: 0.4,
		gain: 1,
		temperature: 0,
		lock: 0,
		breathe: 0,
		organic: 0,
		channels: 0,
		complexity: 0
	};
}

const KEYS = Object.keys(createSignalVoiceFrame()) as (keyof SignalVoiceFrame)[];

/** Glides the voice toward the music's current character. */
export class SignalVoice {
	readonly frame = createSignalVoiceFrame();
	private readonly target = createSignalVoiceFrame();
	private readonly view: SignalCharacterView = { ...NEUTRAL };
	private primed = false;

	/** Start from this character with no glide (a fresh session). */
	settle(character: Readonly<MusicCharacter> | null | undefined): void {
		signalVoiceTarget(signalCharacterView(character, this.view), this.frame);
		this.primed = true;
	}

	get primedOnce(): boolean {
		return this.primed;
	}

	/**
	 * `speed` > 1 right after a shift so the voice lands with the genome.
	 * About a second to settle at speed 1, a third of that at speed 3.
	 */
	update(character: Readonly<MusicCharacter> | null | undefined, dt: number, speed = 1): SignalVoiceFrame {
		if (!this.primed) this.settle(character);
		signalVoiceTarget(signalCharacterView(character, this.view), this.target);
		const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
		const k = 1 - Math.exp((-step * Math.max(1, speed)) / 0.5);
		for (const key of KEYS) this.frame[key] += (this.target[key] - this.frame[key]) * k;
		return this.frame;
	}
}

/** Option prototypes: which looks fit which music (see characterWeights). */
type Prototype = Partial<Record<CharacterFeature, number>>;

/**
 * Where each lab genre sits in the features Signal picks looks by (tempo,
 * bass, punch, and roughness as signalCharacterView reads it), from the
 * shared character's measured medians.
 */
export const SIGNAL_GENRE_POINTS = {
	ambient: { tempo: 0.03, bass: 0.32, punch: 0.07, noise: 0 },
	cinematic: { tempo: 0.1, bass: 0.48, punch: 0.43, noise: 0 },
	swing: { tempo: 0.22, bass: 0.88, punch: 0.47, noise: 0 },
	acoustic: { tempo: 0.28, bass: 0.18, punch: 0.88, noise: 0.09 },
	indie: { tempo: 0.48, bass: 0.43, punch: 0.31, noise: 0.17 },
	club: { tempo: 0.57, bass: 0.76, punch: 0.21, noise: 0.3 },
	noise: { tempo: 0.93, bass: 0.12, punch: 0.15, noise: 0.83 },
	/** No genre lives here: options kept for the walk's surprises. */
	rare: { tempo: 0.7, bass: 0.95, punch: 0.9, noise: 0.5 }
} as const satisfies Record<string, Prototype>;

type Genre = keyof typeof SIGNAL_GENRE_POINTS;

function prototypes(genres: readonly Genre[]): readonly Prototype[] {
	return genres.map((genre) => SIGNAL_GENRE_POINTS[genre]);
}

/** Figure families, in SIGNAL_FAMILY_NAMES order. */
export const SIGNAL_FAMILY_PROTOTYPES = prototypes([
	'ambient', // lissajous: the breathing figure
	'cinematic', // harmonograph: slow decaying swings
	'acoustic', // rose: a plucked flower
	'indie', // spirograph
	'club', // phase plot: bass against mids
	'noise', // attractor
	'noise', // polar loop: the spectrum's own outline
	'swing', // torus knot
	'rare' // scope: weighted by the stereo image instead (genome.ts)
]);

/** Layouts, in SIGNAL_LAYOUT_NAMES order. */
export const SIGNAL_LAYOUT_PROTOTYPES = prototypes([
	'ambient', // bench: one big figure over the floor
	'acoustic', // construction: the Lissajous table
	'indie', // dual
	'swing', // monitor
	'noise', // bank: many channels at once
	'club', // tunnel: hypnotic
	'cinematic', // ring
	'ambient' // radar: slow sweep
]);

/** Phosphor families, in SIGNAL_PALETTES order. */
export const SIGNAL_PALETTE_PROTOTYPES = prototypes([
	'indie', // P31 bench
	'club', // P1 green
	'cinematic', // P4 white
	'cinematic', // P7 blue-yellow
	'acoustic', // amber terminal
	'ambient', // scope cyan
	'noise', // vector overlay
	'club', // infrared
	'club', // ultraviolet
	'swing', // sodium
	'indie', // plasma pink
	'rare', // mono white
	'ambient', // radar P7
	'ambient', // arctic
	'acoustic', // copper
	'club', // abyss lime
	'noise', // magenta duotone
	'cinematic', // cobalt ember
	'indie', // P22 triad
	'acoustic', // bone
	'noise', // acid violet
	'swing' // emerald gold
]);

/** Display characters, in SIGNAL_DISPLAY_NAMES order. */
export const SIGNAL_DISPLAY_PROTOTYPES = prototypes([
	'acoustic', // lab scope
	'indie', // raster crt
	'ambient', // long persistence
	'noise', // worn tube
	'club', // vector monitor
	'cinematic' // broadcast
]);

/** Camera regimes, in SIGNAL_CAMERA_NAMES order (weighted gently). */
export const SIGNAL_CAMERA_PROTOTYPES = prototypes([
	'acoustic', // straight
	'indie', // bench
	'club', // low
	'ambient', // overhead
	'noise' // dolly
]);
