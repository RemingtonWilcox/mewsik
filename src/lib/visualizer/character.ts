// Music character: a slow-moving description of *what kind* of music is
// playing (tempo, energy, brightness, weight, noisiness, punch), shared by
// every engine so a genre or tempo change shows up in the picture within a
// second or two instead of waiting for the next section boundary.
//
// Two envelopes run over the same eight features: a fast one (about a second)
// that hears the new music almost at once, and a slow one (about half a
// minute) that remembers what was playing. When they disagree by enough the
// music has changed character, and a `shift` fires. Engines answer a shift by
// moving their genome immediately (VariationGenome.shift) and by gliding
// their character-driven parameters, so the change is fast but never a cut.
//
// A new source arms a strength-1 shift that fires once real audio has played
// for SOURCE_SHIFT_DELAY_S, so the first frames of a song or station never
// react to the silence or the half-second of junk before the stream settles.

import type { VisualDirectorFrame } from '$lib/visualizer/director/types';
import type { SignalSpectrumProfile } from '$lib/visualizer/signal/spectrum';

export const CHARACTER_FEATURES = [
	'tempo',
	'energy',
	'brightness',
	'bass',
	'noise',
	'punch',
	'motion',
	'valence'
] as const;

export type CharacterFeature = (typeof CHARACTER_FEATURES)[number];

export type MusicCharacter = {
	/** Fast-envelope features in CHARACTER_FEATURES order, 0..1. Stable identity. */
	readonly vector: Float32Array;
	readonly tempo: number;
	readonly energy: number;
	readonly brightness: number;
	readonly bass: number;
	readonly noise: number;
	readonly punch: number;
	readonly motion: number;
	readonly valence: number;
	/** Distance between what is playing and what was playing, 0..1. */
	readonly contrast: number;
	/** Decaying impulse, 1 the frame a shift fires, ~0 after 2 s. */
	readonly shift: number;
	/** Increments once per shift; engines compare it to react exactly once. */
	readonly shiftSerial: number;
	/** Strength of the most recent shift, 0..1 (1 for a new source). */
	readonly shiftStrength: number;
	/** Seconds since the most recent shift (large before the first). */
	readonly sinceShift: number;
};

const FEATURE_COUNT = CHARACTER_FEATURES.length;
const FAST_TAU_S = 1.1;
const SLOW_TAU_S = 25;
const SHIFT_THRESHOLD = 0.16;
const SHIFT_REFRACTORY_S = 8;
const SHIFT_DECAY_TAU_S = 0.7;
const SOURCE_SHIFT_DELAY_S = 0.8;
/** Per-feature weights in the contrast distance: tempo and timbre say "genre". */
const WEIGHTS = new Float32Array([1.3, 1.0, 1.2, 1.0, 1.1, 0.8, 0.7, 0.5]);
const WEIGHT_SUM = WEIGHTS.reduce((sum, w) => sum + w, 0);

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** 60 bpm -> 0, 180 bpm -> 1. Halved/doubled estimates fold into that band. */
export function tempoUnit(bpm: number): number {
	if (!Number.isFinite(bpm) || bpm <= 30) return 0.5;
	let b = bpm;
	while (b > 190) b /= 2;
	while (b < 55) b *= 2;
	return clamp01((b - 60) / 120);
}

export class CharacterTracker {
	private readonly fast = new Float32Array(FEATURE_COUNT);
	private readonly slow = new Float32Array(FEATURE_COUNT);
	private readonly raw = new Float32Array(FEATURE_COUNT);
	private primed = false;
	private audibleSeconds = 0;
	private sourceArmed = false;
	private sinceShiftS = 1e6;
	private shiftValue = 0;
	private serial = 0;
	private strength = 0;
	private contrastValue = 0;
	private readonly frame: { -readonly [K in keyof MusicCharacter]: MusicCharacter[K] };

	constructor() {
		this.frame = {
			vector: this.fast,
			tempo: 0.5,
			energy: 0,
			brightness: 0.4,
			bass: 0,
			noise: 0,
			punch: 0,
			motion: 0,
			valence: 0.5,
			contrast: 0,
			shift: 0,
			shiftSerial: 0,
			shiftStrength: 0,
			sinceShift: this.sinceShiftS
		};
	}

	/**
	 * A new source started. Keeps the remembered character (so the shift can
	 * measure how different the new music is) and arms a full-strength shift
	 * once audio arrives.
	 */
	beginSource(): void {
		this.sourceArmed = true;
		this.audibleSeconds = 0;
	}

	get current(): MusicCharacter {
		return this.frame;
	}

	update(director: VisualDirectorFrame, spectrum: Readonly<SignalSpectrumProfile>, dt: number): MusicCharacter {
		const step = Math.min(0.25, Math.max(0, Number.isFinite(dt) ? dt : 0));
		const audible = !director.silence && director.energy > 0.04;
		this.raw[0] = tempoUnit(director.clock.tempoBpm);
		this.raw[1] = clamp01(director.energy);
		this.raw[2] = clamp01((spectrum.centroid - 0.15) / 0.6);
		this.raw[3] = clamp01((spectrum.levels.sub + spectrum.levels.kick) * 0.6);
		this.raw[4] = clamp01(spectrum.flatness * 1.6);
		this.raw[5] = clamp01(spectrum.crestFactor);
		this.raw[6] = clamp01(director.motion);
		this.raw[7] = clamp01(director.valence);

		this.sinceShiftS += step;
		this.shiftValue *= Math.exp(-step / SHIFT_DECAY_TAU_S);

		if (audible) {
			this.audibleSeconds += step;
			if (!this.primed) {
				this.fast.set(this.raw);
				this.slow.set(this.raw);
				this.primed = true;
			}
			// The fast envelope is quicker still right after a source change, so
			// the new music is heard before the armed shift fires.
			const fastTau = this.sourceArmed ? FAST_TAU_S * 0.4 : FAST_TAU_S;
			const kf = 1 - Math.exp(-step / fastTau);
			const ks = 1 - Math.exp(-step / SLOW_TAU_S);
			for (let i = 0; i < FEATURE_COUNT; i += 1) {
				this.fast[i] += (this.raw[i] - this.fast[i]) * kf;
				this.slow[i] += (this.raw[i] - this.slow[i]) * ks;
			}
		}

		let distance = 0;
		for (let i = 0; i < FEATURE_COUNT; i += 1) distance += Math.abs(this.fast[i] - this.slow[i]) * WEIGHTS[i];
		this.contrastValue = distance / WEIGHT_SUM;

		if (this.sourceArmed && this.audibleSeconds >= SOURCE_SHIFT_DELAY_S) {
			this.sourceArmed = false;
			this.fire(1);
		} else if (
			!this.sourceArmed &&
			audible &&
			this.sinceShiftS > SHIFT_REFRACTORY_S &&
			this.contrastValue > SHIFT_THRESHOLD
		) {
			this.fire(clamp01(0.45 + (this.contrastValue - SHIFT_THRESHOLD) * 3));
		}

		const f = this.frame;
		f.tempo = this.fast[0];
		f.energy = this.fast[1];
		f.brightness = this.fast[2];
		f.bass = this.fast[3];
		f.noise = this.fast[4];
		f.punch = this.fast[5];
		f.motion = this.fast[6];
		f.valence = this.fast[7];
		f.contrast = this.contrastValue;
		f.shift = this.shiftValue;
		f.shiftSerial = this.serial;
		f.shiftStrength = this.strength;
		f.sinceShift = this.sinceShiftS;
		return f;
	}

	private fire(strength: number): void {
		this.serial += 1;
		this.strength = strength;
		this.shiftValue = 1;
		this.sinceShiftS = 0;
		// The new music becomes the reference, so one change fires once.
		this.slow.set(this.fast);
	}
}

/**
 * Character-conditioned pick weights for a choice axis. Each option has a
 * prototype: a partial character (e.g. `{ tempo: 0.9, noise: 0.8 }` for a
 * harsh fast look). Options whose prototype is close to the playing music get
 * high weight; `sharpness` 0 is uniform, ~6 strongly prefers the best fits.
 * Every option keeps a floor so variety never collapses to one look.
 */
export function characterWeights(
	prototypes: readonly Partial<Record<CharacterFeature, number>>[],
	character: MusicCharacter,
	sharpness = 4,
	floor = 0.08,
	out: number[] = []
): number[] {
	out.length = prototypes.length;
	for (let option = 0; option < prototypes.length; option += 1) {
		const prototype = prototypes[option];
		let distance = 0;
		let count = 0;
		for (const key in prototype) {
			const target = prototype[key as CharacterFeature] ?? 0;
			distance += Math.abs(target - character[key as CharacterFeature]);
			count += 1;
		}
		const mean = count ? distance / count : 0.5;
		out[option] = floor + Math.exp(-mean * sharpness);
	}
	return out;
}
