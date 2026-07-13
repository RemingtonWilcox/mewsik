import type { VisualDirectorFrame, VisualizerSection } from '$lib/visualizer/director/types';
import type { SignalSpectrumProfile } from './spectrum';

export type SignalSeed = number | string;

/** Four compatible readings of one trace, blended continuously by the shader. */
export type SignalShapeWeights = {
	ellipse: number;
	lissajous: number;
	ribbon: number;
	rosette: number;
};

export type SignalSectionProfile = {
	shapes: Readonly<SignalShapeWeights>;
	tension: number;
	release: number;
	openness: number;
	asymmetry: number;
	motion: number;
};

export type SignalConductorFrame = {
	section: VisualizerSection;
	/** Continuous normalized weights; they always sum to one. */
	shapeWeights: SignalShapeWeights;
	/** Build pressure / geometric winding, 0..1. */
	tension: number;
	/** Drop/chorus expansion and ring-out, 0..1. */
	release: number;
	/** Overall spatial expansion, 0..1. */
	openness: number;
	/** Controlled departure from bilateral symmetry, 0..1. */
	asymmetry: number;
	/** Fast beat/kick/crest impulse, 0..1. */
	impact: number;
	/** One-shot envelope when the director enters a different section, 0..1. */
	sectionPulse: number;
	/** Tempo normalized over the analyzer's 60..180 BPM operating range. */
	tempo: number;
	/** Macro traversal speed from section, spectrum, tempo, and drop state. */
	motion: number;
	/** Director phrase position, 0..1 across the current eight-bar phrase. */
	phrase: number;
	/** Deterministic phrase identity derived from seed + phrase index, 0..1. */
	phraseVariation: number;
	/** Smoothed fifth-axis key angle, 0..1 around the circle. */
	key: number;
};

const SECTION_PROFILES: Readonly<Record<VisualizerSection, SignalSectionProfile>> = {
	calm: {
		shapes: { ellipse: 0.64, lissajous: 0.28, ribbon: 0.06, rosette: 0.02 },
		tension: 0.05,
		release: 0.08,
		openness: 0.34,
		asymmetry: 0.05,
		motion: 0.08
	},
	intro: {
		shapes: { ellipse: 0.5, lissajous: 0.38, ribbon: 0.09, rosette: 0.03 },
		tension: 0.1,
		release: 0.16,
		openness: 0.43,
		asymmetry: 0.1,
		motion: 0.17
	},
	verse: {
		shapes: { ellipse: 0.2, lissajous: 0.52, ribbon: 0.22, rosette: 0.06 },
		tension: 0.27,
		release: 0.24,
		openness: 0.54,
		asymmetry: 0.27,
		motion: 0.42
	},
	pre_chorus: {
		shapes: { ellipse: 0.1, lissajous: 0.34, ribbon: 0.24, rosette: 0.32 },
		tension: 0.7,
		release: 0.12,
		openness: 0.38,
		asymmetry: 0.38,
		motion: 0.68
	},
	build: {
		shapes: { ellipse: 0.05, lissajous: 0.22, ribbon: 0.23, rosette: 0.5 },
		tension: 0.88,
		release: 0.06,
		openness: 0.27,
		asymmetry: 0.44,
		motion: 0.82
	},
	drop: {
		shapes: { ellipse: 0.08, lissajous: 0.29, ribbon: 0.13, rosette: 0.5 },
		tension: 0.28,
		release: 1,
		openness: 0.94,
		asymmetry: 0.18,
		motion: 1
	},
	chorus: {
		shapes: { ellipse: 0.12, lissajous: 0.33, ribbon: 0.17, rosette: 0.38 },
		tension: 0.34,
		release: 0.78,
		openness: 0.86,
		asymmetry: 0.23,
		motion: 0.86
	},
	bridge: {
		shapes: { ellipse: 0.27, lissajous: 0.23, ribbon: 0.43, rosette: 0.07 },
		tension: 0.24,
		release: 0.34,
		openness: 0.61,
		asymmetry: 0.76,
		motion: 0.32
	},
	breakdown: {
		shapes: { ellipse: 0.57, lissajous: 0.23, ribbon: 0.17, rosette: 0.03 },
		tension: 0.08,
		release: 0.28,
		openness: 0.48,
		asymmetry: 0.43,
		motion: 0.15
	},
	outro: {
		shapes: { ellipse: 0.63, lissajous: 0.25, ribbon: 0.1, rosette: 0.02 },
		tension: 0.04,
		release: 0.14,
		openness: 0.38,
		asymmetry: 0.18,
		motion: 0.1
	}
};

const SHAPE_COUNT = 4;

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function wrap01(value: number): number {
	const wrapped = value - Math.floor(value);
	return wrapped < 0 ? wrapped + 1 : wrapped;
}

function safeDt(dtSeconds: number): number {
	if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 1 / 60;
	return clamp(dtSeconds, 1 / 1_000, 0.25);
}

function approach(current: number, target: number, tauSeconds: number, dtSeconds: number): number {
	const alpha = tauSeconds <= 0 ? 1 : 1 - Math.exp(-dtSeconds / tauSeconds);
	return current + (target - current) * alpha;
}

function approachAsymmetric(
	current: number,
	target: number,
	attackSeconds: number,
	releaseSeconds: number,
	dtSeconds: number
): number {
	return approach(current, target, target > current ? attackSeconds : releaseSeconds, dtSeconds);
}

function approachCircular(
	current: number,
	target: number,
	tauSeconds: number,
	dtSeconds: number
): number {
	const delta = ((((target - current + 0.5) % 1) + 1) % 1) - 0.5;
	return wrap01(current + delta * (1 - Math.exp(-dtSeconds / Math.max(tauSeconds, 1e-6))));
}

function mix32(value: number): number {
	let x = value >>> 0;
	x ^= x >>> 16;
	x = Math.imul(x, 0x7feb352d);
	x ^= x >>> 15;
	x = Math.imul(x, 0x846ca68b);
	x ^= x >>> 16;
	return x >>> 0;
}

/** Stable 32-bit seed conversion. Strings use FNV-1a for track-id convenience. */
export function signalSeedWord(seed: SignalSeed): number {
	if (typeof seed === 'string') {
		let hash = 2166136261;
		for (let i = 0; i < seed.length; i += 1) {
			hash ^= seed.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return mix32(hash);
	}
	if (!Number.isFinite(seed)) return 0;
	// Common callers pass a [0,1) hash. Retain precision for that case while
	// still accepting arbitrary numeric identities from tests/tools.
	const scaled = Math.abs(seed) < 1 ? Math.floor(Math.abs(seed) * 0x1_0000_0000) : Math.floor(seed);
	return mix32(scaled);
}

/** Pure lookup used by the conductor and deterministic profile tests. */
export function getSignalSectionProfile(section: VisualizerSection): SignalSectionProfile {
	return SECTION_PROFILES[section];
}

/**
 * Normalize four non-negative values in place. Degenerate input becomes a
 * pure Lissajous trace instead of producing NaNs or a blank frame.
 */
export function normalizeSignalShapeWeightArray(weights: Float32Array): Float32Array {
	if (weights.length < SHAPE_COUNT) {
		throw new RangeError(`Signal shape weight buffer needs ${SHAPE_COUNT} entries.`);
	}
	let sum = 0;
	for (let i = 0; i < SHAPE_COUNT; i += 1) {
		weights[i] = Math.max(0, Number.isFinite(weights[i]) ? weights[i] : 0);
		sum += weights[i];
	}
	if (sum <= 1e-8) {
		weights[0] = 0;
		weights[1] = 1;
		weights[2] = 0;
		weights[3] = 0;
		return weights;
	}
	for (let i = 0; i < SHAPE_COUNT; i += 1) weights[i] /= sum;
	return weights;
}

/**
 * Fill zero-sum phrase biases. The same track and phrase always produce the
 * same variation, and no random generator is consulted after reset.
 */
export function fillSignalPhraseVariation(
	out: Float32Array,
	seed: SignalSeed,
	phraseIndex: number
): Float32Array {
	if (out.length < SHAPE_COUNT) {
		throw new RangeError(`Signal phrase variation buffer needs ${SHAPE_COUNT} entries.`);
	}
	const seedWord = signalSeedWord(seed);
	const phraseWord = Math.imul((Math.floor(phraseIndex) + 1) | 0, 0x9e3779b1);
	let mean = 0;
	for (let i = 0; i < SHAPE_COUNT; i += 1) {
		const hash = mix32(seedWord ^ phraseWord ^ Math.imul(i + 1, 0x85ebca6b));
		const unit = hash / 0x1_0000_0000;
		out[i] = (unit - 0.5) * 0.14;
		mean += out[i] / SHAPE_COUNT;
	}
	for (let i = 0; i < SHAPE_COUNT; i += 1) out[i] -= mean;
	return out;
}

function writeShapeWeights(target: SignalShapeWeights, values: ArrayLike<number>): void {
	target.ellipse = values[0] ?? 0;
	target.lissajous = values[1] ?? 0;
	target.ribbon = values[2] ?? 0;
	target.rosette = values[3] ?? 0;
}

function writeProfileWeights(target: Float32Array, profile: Readonly<SignalShapeWeights>): void {
	target[0] = profile.ellipse;
	target[1] = profile.lissajous;
	target[2] = profile.ribbon;
	target[3] = profile.rosette;
}

/**
 * Stateful macro arranger. It translates shared director intent into one
 * continuously morphing Signal subject; section and phrase events alter
 * targets, never hard-switch shader motifs.
 */
export class SignalConductor {
	private seed: SignalSeed = 0;
	private readonly phraseBias = new Float32Array(SHAPE_COUNT);
	private readonly currentShapes = new Float32Array(SHAPE_COUNT);
	private readonly targetShapes = new Float32Array(SHAPE_COUNT);
	private lastSection: VisualizerSection | null = null;
	private lastPhraseIndex = Number.MIN_SAFE_INTEGER;
	private tension = 0;
	private release = 0;
	private openness = 0.4;
	private asymmetry = 0;
	private impact = 0;
	private sectionPulse = 0;
	private tempo = 0.5;
	private motion = 0;
	private key = 0;

	private readonly output: SignalConductorFrame = {
		section: 'intro',
		shapeWeights: { ellipse: 0.5, lissajous: 0.38, ribbon: 0.09, rosette: 0.03 },
		tension: 0,
		release: 0,
		openness: 0.4,
		asymmetry: 0,
		impact: 0,
		sectionPulse: 0,
		tempo: 0.5,
		motion: 0,
		phrase: 0,
		phraseVariation: 0.5,
		key: 0
	};

	constructor(seed: SignalSeed = 0) {
		this.reset(seed);
	}

	reset(seed: SignalSeed): void {
		this.seed = seed;
		this.lastSection = null;
		this.lastPhraseIndex = Number.MIN_SAFE_INTEGER;
		this.phraseBias.fill(0);
		writeProfileWeights(this.currentShapes, SECTION_PROFILES.intro.shapes);
		this.targetShapes.set(this.currentShapes);
		this.tension = SECTION_PROFILES.intro.tension;
		this.release = SECTION_PROFILES.intro.release;
		this.openness = SECTION_PROFILES.intro.openness;
		this.asymmetry = SECTION_PROFILES.intro.asymmetry;
		this.impact = 0;
		this.sectionPulse = 0;
		this.tempo = 0.5;
		this.motion = SECTION_PROFILES.intro.motion;
		this.key = 0;
		this.output.section = 'intro';
		writeShapeWeights(this.output.shapeWeights, this.currentShapes);
		this.output.tension = this.tension;
		this.output.release = this.release;
		this.output.openness = this.openness;
		this.output.asymmetry = this.asymmetry;
		this.output.impact = 0;
		this.output.sectionPulse = 0;
		this.output.tempo = this.tempo;
		this.output.motion = this.motion;
		this.output.phrase = 0;
		this.output.phraseVariation = 0.5;
		this.output.key = 0;
	}

	update(
		frame: VisualDirectorFrame,
		spectrum: SignalSpectrumProfile,
		dtSeconds: number
	): Readonly<SignalConductorFrame> {
		const dt = safeDt(dtSeconds);
		const section = getSignalSectionProfile(frame.section);
		if (this.lastSection === null) {
			this.lastSection = frame.section;
		} else if (frame.section !== this.lastSection) {
			this.lastSection = frame.section;
			this.sectionPulse = 1;
		} else {
			this.sectionPulse *= Math.exp(-dt / 0.72);
		}

		const phraseIndex = Number.isFinite(frame.clock.phraseIndex)
			? Math.floor(frame.clock.phraseIndex)
			: 0;
		if (phraseIndex !== this.lastPhraseIndex) {
			this.lastPhraseIndex = phraseIndex;
			fillSignalPhraseVariation(this.phraseBias, this.seed, phraseIndex);
		}

		const tempoTarget = clamp01((frame.clock.tempoBpm - 60) / 120);
		this.tempo = approach(this.tempo, tempoTarget, 1.4, dt);

		const keyTarget = wrap01(Math.atan2(frame.tonnetz[1], frame.tonnetz[0]) / (Math.PI * 2));
		this.key = approachCircular(this.key, keyTarget, 0.9, dt);

		const positiveKick = Math.max(0, spectrum.deltas.kick);
		const positiveBody = Math.max(0, spectrum.deltas.body);
		const positivePresence = Math.max(0, spectrum.deltas.presence);
		const impactTarget = clamp01(
			Math.max(
				frame.clock.beatPulse * (0.48 + spectrum.crestFactor * 0.24),
				positiveKick * 0.82 + positiveBody * 0.24,
				frame.bassPunch * 0.58,
				spectrum.novelty * (0.34 + spectrum.crestFactor * 0.52)
			)
		);
		this.impact = approachAsymmetric(this.impact, impactTarget, 0.012, 0.17, dt);

		const tensionTarget = clamp01(
			section.tension +
				frame.drop.anticipation * 0.56 +
				frame.drop.buildProgress * 0.16 +
				positivePresence * 0.1 +
				Math.max(0, spectrum.centroidVelocity) * 0.08 -
				frame.drop.postDropDecay * 0.34
		);
		const releaseTarget = clamp01(
			Math.max(
				section.release,
				frame.drop.postDropDecay * 0.94,
				(frame.section === 'drop' || frame.section === 'chorus') ? this.impact * 0.74 : 0
			)
		);
		this.tension = approachAsymmetric(this.tension, tensionTarget, 0.34, 0.86, dt);
		this.release = approachAsymmetric(this.release, releaseTarget, 0.09, 1.35, dt);

		const opennessTarget = clamp01(
			section.openness +
				this.release * 0.2 +
				spectrum.centroid * 0.11 +
				Math.max(0, spectrum.spectralDirection) * 0.08 -
				this.tension * 0.18
		);
		const keyAsymmetry = Math.abs(frame.tonnetz[3] - frame.tonnetz[5]) * 0.055;
		const asymmetryTarget = clamp01(
			section.asymmetry +
				keyAsymmetry +
				Math.abs(spectrum.spectralDirection) * 0.11 +
				spectrum.levels.mids * 0.04
		);
		this.openness = approach(this.openness, opennessTarget, 0.72, dt);
		this.asymmetry = approach(this.asymmetry, asymmetryTarget, 0.95, dt);

		const motionTarget = clamp01(
			section.motion * 0.34 +
				frame.motion * 0.38 +
				spectrum.spectralMotion * 0.3 +
				this.tempo * 0.14 +
				frame.drop.anticipation * 0.12
		);
		this.motion = approachAsymmetric(this.motion, motionTarget, 0.28, 0.92, dt);

		writeProfileWeights(this.targetShapes, section.shapes);
		// Phrase identity is bounded and zero-sum. Tonnetz and bands then make the
		// same section respond differently to harmony/timbre without replacing it.
		this.targetShapes[0] +=
			this.phraseBias[0] + frame.tonnetz[0] * 0.025 + spectrum.levels.sub * 0.035;
		this.targetShapes[1] +=
			this.phraseBias[1] + frame.tonnetz[2] * 0.035 + spectrum.levels.mids * 0.035;
		this.targetShapes[2] +=
			this.phraseBias[2] + frame.tonnetz[4] * 0.04 + this.asymmetry * 0.055;
		this.targetShapes[3] +=
			this.phraseBias[3] +
				this.tension * 0.065 +
				spectrum.levels.presence * 0.035 +
				spectrum.levels.air * 0.025;
		normalizeSignalShapeWeightArray(this.targetShapes);

		const shapeTau = releaseTarget > 0.72 ? 0.52 : tensionTarget > 0.7 ? 0.74 : 1.08;
		for (let i = 0; i < SHAPE_COUNT; i += 1) {
			this.currentShapes[i] = approach(this.currentShapes[i], this.targetShapes[i], shapeTau, dt);
		}
		normalizeSignalShapeWeightArray(this.currentShapes);

		this.output.section = frame.section;
		writeShapeWeights(this.output.shapeWeights, this.currentShapes);
		this.output.tension = this.tension;
		this.output.release = this.release;
		this.output.openness = this.openness;
		this.output.asymmetry = this.asymmetry;
		this.output.impact = this.impact;
		this.output.sectionPulse = this.sectionPulse;
		this.output.tempo = this.tempo;
		this.output.motion = this.motion;
		this.output.phrase = clamp01(frame.clock.phrasePos);
		this.output.phraseVariation = clamp01(0.5 + this.phraseBias[3] * 3.2);
		this.output.key = this.key;
		return this.output;
	}
}
