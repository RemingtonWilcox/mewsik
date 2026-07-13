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
	/** Sustained drop/chorus expansion, 0..1. */
	release: number;
	/** Overall spatial expansion, 0..1. */
	openness: number;
	/** Controlled departure from bilateral symmetry, 0..1. */
	asymmetry: number;
	/** Phrase-polarized asymmetry eased through zero, -1..1. */
	signedAsymmetry: number;
	/** Fast kick/novelty/crest impulse, independent of the beat clock, 0..1. */
	impact: number;
	/** Temporary post-drop echo/ring envelope; never a sustained section state. */
	ringOut: number;
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
	/** Continuous contour offset; wraps without a visible phrase-boundary jump. */
	spectrumTravel: number;
	/** Shared renderer phase in radians; survives Signal component remounts. */
	tracePhase: number;
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
	private lastContextSource: VisualDirectorFrame['context']['source'] | null = null;
	private lastPhraseIndex = Number.MIN_SAFE_INTEGER;
	private tension = 0;
	private release = 0;
	private openness = 0.4;
	private asymmetry = 0;
	private signedAsymmetry = 0;
	private impact = 0;
	private ringOut = 0;
	private postDropArmed = true;
	private landingCooldown = 0;
	private sectionPulse = 0;
	private tempo = 0.5;
	private motion = 0;
	private key = 0;
	private spectrumTravel = 0;
	private tracePhase = 0;

	private readonly output: SignalConductorFrame = {
		section: 'intro',
		shapeWeights: { ellipse: 0.5, lissajous: 0.38, ribbon: 0.09, rosette: 0.03 },
		tension: 0,
		release: 0,
		openness: 0.4,
		asymmetry: 0,
		signedAsymmetry: 0,
		impact: 0,
		ringOut: 0,
		sectionPulse: 0,
		tempo: 0.5,
		motion: 0,
		phrase: 0,
		phraseVariation: 0.5,
		spectrumTravel: 0,
		tracePhase: 0,
		key: 0
	};

	constructor(seed: SignalSeed = 0) {
		this.reset(seed);
	}

	reset(seed: SignalSeed): void {
		this.seed = seed;
		this.lastSection = null;
		this.lastContextSource = null;
		this.lastPhraseIndex = Number.MIN_SAFE_INTEGER;
		this.phraseBias.fill(0);
		writeProfileWeights(this.currentShapes, SECTION_PROFILES.intro.shapes);
		this.targetShapes.set(this.currentShapes);
		this.tension = SECTION_PROFILES.intro.tension;
		this.release = SECTION_PROFILES.intro.release;
		this.openness = SECTION_PROFILES.intro.openness;
		this.asymmetry = SECTION_PROFILES.intro.asymmetry;
		this.signedAsymmetry = 0;
		this.impact = 0;
		this.ringOut = 0;
		this.postDropArmed = true;
		this.landingCooldown = 0;
		this.sectionPulse = 0;
		this.tempo = 0.5;
		this.motion = SECTION_PROFILES.intro.motion;
		this.key = 0;
		this.spectrumTravel = 0;
		this.tracePhase = 0;
		this.output.section = 'intro';
		writeShapeWeights(this.output.shapeWeights, this.currentShapes);
		this.output.tension = this.tension;
		this.output.release = this.release;
		this.output.openness = this.openness;
		this.output.asymmetry = this.asymmetry;
		this.output.signedAsymmetry = 0;
		this.output.impact = 0;
		this.output.ringOut = 0;
		this.output.sectionPulse = 0;
		this.output.tempo = this.tempo;
		this.output.motion = this.motion;
		this.output.phrase = 0;
		this.output.phraseVariation = 0.5;
		this.output.spectrumTravel = 0;
		this.output.tracePhase = 0;
		this.output.key = 0;
	}

	update(
		frame: VisualDirectorFrame,
		spectrum: SignalSpectrumProfile,
		dtSeconds: number
	): Readonly<SignalConductorFrame> {
		const dt = safeDt(dtSeconds);
		const section = getSignalSectionProfile(frame.section);
		const previousSection = this.lastSection;
		const contextSource = frame.context.source;
		const contextSourceChanged =
			this.lastContextSource !== null && contextSource !== this.lastContextSource;
		this.lastContextSource = contextSource;
		let sectionChanged = false;
		if (this.lastSection === null) {
			this.lastSection = frame.section;
		} else if (frame.section !== this.lastSection) {
			this.lastSection = frame.section;
			if (contextSourceChanged) {
				// Offline analysis may arrive during playback and relabel the current
				// section. Morph toward that better context without pretending a real
				// musical boundary or drop just occurred.
				this.sectionPulse *= Math.exp(-dt / 0.72);
			} else {
				this.sectionPulse = 1;
				sectionChanged = true;
			}
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

		const tempoBpm = clamp(
			Number.isFinite(frame.clock.tempoBpm) ? frame.clock.tempoBpm : 120,
			60,
			180
		);
		const beatSeconds = 60 / tempoBpm;
		const tempoTarget = clamp01((tempoBpm - 60) / 120);
		this.tempo = approach(this.tempo, tempoTarget, 1.4, dt);
		// One eighth of a contour revolution per eight-bar phrase. Integrating
		// tempo makes the offset continuous even when phrasePos wraps or a live
		// clock corrects its phrase index.
		this.spectrumTravel = wrap01(this.spectrumTravel + (dt * tempoBpm) / 60 / 256);

		const keyTarget = wrap01(Math.atan2(frame.tonnetz[1], frame.tonnetz[0]) / (Math.PI * 2));
		this.key = approachCircular(this.key, keyTarget, 0.9, dt);

		const positiveKick = Math.max(0, spectrum.deltas.kick);
		const positiveBody = Math.max(0, spectrum.deltas.body);
		const positivePresence = Math.max(0, spectrum.deltas.presence);
		const impactTarget = clamp01(
			Math.max(
				positiveKick * 0.82 + positiveBody * 0.24,
				frame.bassPunch * 0.58,
				spectrum.novelty * (0.34 + spectrum.crestFactor * 0.52)
			)
		);
		this.impact = approachAsymmetric(this.impact, impactTarget, 0.012, 0.17, dt);

		// Expansion is a section state; ring-out is one landing event. The
		// director's postDropDecay is itself a multi-second envelope, so treating
		// its value as a continuous drive would pin this rail and erase its BPM
		// timing. Hysteresis turns only a fresh low->high post-drop transition into
		// an impulse. Entering the peak family can supply the impulse when no drop
		// detector is available; drop->chorus stays inside that family and cannot
		// retrigger the same landing.
		const postDropDecay = clamp01(frame.drop.postDropDecay);
		const peakSection = frame.section === 'drop' || frame.section === 'chorus';
		const previousPeakSection =
			previousSection === 'drop' || previousSection === 'chorus';
		const enteredPeakFamily = sectionChanged && peakSection && !previousPeakSection;
		this.landingCooldown = Math.max(0, this.landingCooldown - dt);
		if (previousSection === null || contextSourceChanged) {
			// Opening Signal in the middle of an existing decay is not a new landing.
			// The same rule applies when live analysis hands off to a cached score.
			this.postDropArmed = postDropDecay <= 0.04;
		} else {
			if (postDropDecay <= 0.04) this.postDropArmed = true;
			const freshPostDrop = this.postDropArmed && postDropDecay >= 0.12;
			if (freshPostDrop || enteredPeakFamily) {
				// Consume both cues even during the short de-duplication window. This
				// handles section/post-drop signals arriving one analyzer frame apart.
				this.postDropArmed = false;
				if (this.landingCooldown <= 0) {
					this.ringOut = 1;
					this.landingCooldown = clamp(beatSeconds, 0.35, 1);
				}
			}
		}
		this.ringOut *= Math.exp(-dt / clamp(beatSeconds * 2, 0.7, 2));

		const sectionProgress = clamp01(frame.context.sectionProgress);
		const sectionArc = Math.sin(sectionProgress * Math.PI);
		const lookaheadDelta = clamp(
			frame.context.energyLookahead - frame.context.energyCurrent,
			-1,
			1
		);
		const positiveFuture = Math.max(0, lookaheadDelta);
		const negativeFuture = Math.max(0, -lookaheadDelta);
		const positiveSlope = Math.max(0, frame.context.energySlope);

		const tensionTarget = clamp01(
			section.tension +
				frame.drop.anticipation * 0.56 +
				frame.drop.buildProgress * 0.16 +
				positiveFuture * 0.18 +
				positiveSlope * 0.1 +
				positivePresence * 0.1 +
				Math.max(0, spectrum.centroidVelocity) * 0.08 -
				frame.drop.postDropDecay * 0.34
		);
		const releaseTarget = clamp01(
			Math.max(
				section.release,
				frame.drop.postDropDecay * 0.76,
				negativeFuture * 0.34
			)
		);
		this.tension = approachAsymmetric(this.tension, tensionTarget, 0.34, 0.86, dt);
		this.release = approachAsymmetric(this.release, releaseTarget, 0.09, 1.35, dt);

		const opennessTarget = clamp01(
			section.openness +
				this.release * 0.2 +
				sectionArc * (section.tension > 0.6 ? -0.055 : 0.035) -
				positiveFuture * 0.08 +
				negativeFuture * 0.07 +
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
		const asymmetryPolarity = this.phraseBias[3] >= 0 ? 1 : -1;
		const signedAsymmetryTarget = clamp(
			asymmetryTarget * asymmetryPolarity + spectrum.spectralDirection * 0.16,
			-1,
			1
		);
		this.signedAsymmetry = approach(
			this.signedAsymmetry,
			signedAsymmetryTarget,
			clamp(beatSeconds * 1.6, 0.65, 2.4),
			dt
		);

		const motionTarget = clamp01(
			section.motion * 0.34 +
				frame.motion * 0.38 +
				spectrum.spectralMotion * 0.3 +
				this.tempo * 0.14 +
				frame.drop.anticipation * 0.12 +
				Math.abs(frame.context.energySlope) * 0.09
		);
		this.motion = approachAsymmetric(this.motion, motionTarget, 0.28, 0.92, dt);
		const traceActivity = frame.silence
			? 0
			: clamp01(
					frame.energy * 3.2 +
						spectrum.levels.kick * 0.7 +
						spectrum.levels.body * 0.45 +
						spectrum.levels.mids * 0.25
				);
		const traceSpeed =
			0.012 + this.tempo * 0.052 + this.motion * 0.118 + spectrum.mid * 0.038;
		this.tracePhase =
			(this.tracePhase + dt * traceSpeed * traceActivity) % (Math.PI * 2);

		writeProfileWeights(this.targetShapes, section.shapes);
		// Phrase identity is bounded and zero-sum. Tonnetz and bands then make the
		// same section respond differently to harmony/timbre without replacing it.
		this.targetShapes[0] +=
			this.phraseBias[0] +
			frame.tonnetz[0] * 0.025 +
			spectrum.levels.sub * 0.035 +
			sectionArc * (1 - tensionTarget) * 0.025;
		this.targetShapes[1] +=
			this.phraseBias[1] + frame.tonnetz[2] * 0.035 + spectrum.levels.mids * 0.035;
		this.targetShapes[2] +=
			this.phraseBias[2] + frame.tonnetz[4] * 0.04 + this.asymmetry * 0.055;
		this.targetShapes[3] +=
			this.phraseBias[3] +
				this.tension * 0.065 +
				sectionArc * tensionTarget * 0.035 +
				spectrum.levels.presence * 0.035 +
				spectrum.levels.air * 0.025;
		normalizeSignalShapeWeightArray(this.targetShapes);

		// Macro topology takes roughly one to two bars to settle. Landings are
		// carried by impact/openness/ringOut; they no longer accelerate a form swap.
		const shapeTau = clamp(
			beatSeconds * (tensionTarget > 0.7 ? 2.2 : releaseTarget > 0.72 ? 2.5 : 3),
			0.72,
			3.2
		);
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
		this.output.signedAsymmetry = this.signedAsymmetry;
		this.output.impact = this.impact;
		this.output.ringOut = this.ringOut;
		this.output.sectionPulse = this.sectionPulse;
		this.output.tempo = this.tempo;
		this.output.motion = this.motion;
		this.output.phrase = clamp01(frame.clock.phrasePos);
		this.output.phraseVariation = clamp01(0.5 + this.phraseBias[3] * 3.2);
		this.output.spectrumTravel = this.spectrumTravel;
		this.output.tracePhase = this.tracePhase;
		this.output.key = this.key;
		return this.output;
	}
}
