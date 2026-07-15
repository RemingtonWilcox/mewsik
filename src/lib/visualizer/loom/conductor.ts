import type { VisualDirectorFrame, VisualizerSection } from '$lib/visualizer/director/types';
import {
	signalSeedWord,
	type SignalSeed
} from '$lib/visualizer/signal/conductor';
import type {
	SignalBandVector,
	SignalSpectrumProfile
} from '$lib/visualizer/signal/spectrum';

export type LoomSeed = SignalSeed;

export const LOOM_TOPOLOGY_NAMES = ['torus', 'helix', 'saddle', 'knot', 'cage'] as const;
export type LoomTopologyName = (typeof LOOM_TOPOLOGY_NAMES)[number];

/** Five compatible readings of one woven manifold. */
export type LoomTopologyWeights = {
	torus: number;
	helix: number;
	saddle: number;
	knot: number;
	cage: number;
};

export type LoomSectionProfile = {
	topologyWeights: Readonly<LoomTopologyWeights>;
	tension: number;
	release: number;
	openness: number;
	dropOpenness: number;
	motion: number;
	braid: number;
	twist: number;
	depth: number;
	asymmetry: number;
	cameraPitch: number;
	cameraDistance: number;
};

/**
 * Slow, persistent controls for Loom's renderer. Section and phrase changes
 * replace targets; only `impact`, `reweave`, and `sectionPulse` are intended
 * to move quickly. The nested topology and band objects retain their identity
 * across updates so frames can be packed into GPU uniforms without garbage.
 */
export type LoomConductorFrame = {
	section: VisualizerSection;
	topologyWeights: LoomTopologyWeights;
	/** Correct real-frequency bands, each owning a family of woven strands. */
	strandEnergy: SignalBandVector;
	tension: number;
	release: number;
	openness: number;
	/** Dedicated landing/opening rail so drops can unfold without camera jolts. */
	dropOpenness: number;
	braid: number;
	twist: number;
	depth: number;
	/** Kick/body/novelty impulse. It does not select topology or move the camera. */
	impact: number;
	/** Phrase-boundary unlacing envelope, decaying over roughly one bar. */
	reweave: number;
	/** One-shot section boundary envelope, suppressed for live-to-score relabels. */
	sectionPulse: number;
	/** Phrase-polarized, continuously smoothed departure from symmetry. */
	signedAsymmetry: number;
	motion: number;
	macroEnergy: number;
	phrase: number;
	phraseIndex: number;
	phraseVariation: number;
	/** Normalized 60..180 BPM range. */
	tempo: number;
	/** Smoothed circle-of-fifths position, normalized to 0..1. */
	key: number;
	/** -1 is minor, 0 unknown, +1 major, attenuated by key confidence. */
	mode: number;
	/** Signed over/under ordering derived from harmony and phrase identity. */
	crossingOrder: number;
	harmonicSpread: number;
	spectralLean: number;
	/** Unwrapped radians. These remain continuous across renderer remounts. */
	topologyPhase: number;
	weavePhase: number;
	longPhase: number;
	topologyRate: number;
	weaveRate: number;
	longRate: number;
	/** Patient camera rails; angles are radians and distance is scene units. */
	cameraYaw: number;
	cameraPitch: number;
	cameraDistance: number;
	cameraRoll: number;
};

export const LOOM_CONDUCTOR_LIMITS = {
	tension: [0, 1],
	release: [0, 1],
	openness: [0.12, 0.98],
	dropOpenness: [0, 1],
	braid: [0.08, 0.96],
	twist: [0.04, 0.96],
	depth: [0.12, 0.96],
	impact: [0, 1],
	reweave: [0, 1],
	sectionPulse: [0, 1],
	signedAsymmetry: [-1, 1],
	motion: [0.04, 1],
	macroEnergy: [0, 1],
	tempo: [0, 1],
	key: [0, 1],
	mode: [-1, 1],
	crossingOrder: [-1, 1],
	harmonicSpread: [0, 1],
	spectralLean: [-1, 1],
	topologyRate: [0.06, 0.62],
	weaveRate: [0.12, 1.1],
	longRate: [0.012, 0.09],
	cameraYaw: [-0.48, 0.48],
	cameraPitch: [-0.3, 0.3],
	cameraDistance: [2.7, 4.1],
	cameraRoll: [-0.22, 0.22]
} as const;

const SECTION_PROFILES: Readonly<Record<VisualizerSection, LoomSectionProfile>> = {
	calm: {
		topologyWeights: { torus: 0.58, helix: 0.1, saddle: 0.12, knot: 0.04, cage: 0.16 },
		tension: 0.05,
		release: 0.08,
		openness: 0.34,
		dropOpenness: 0.04,
		motion: 0.08,
		braid: 0.2,
		twist: 0.12,
		depth: 0.28,
		asymmetry: 0.08,
		cameraPitch: 0.1,
		cameraDistance: 3.86
	},
	intro: {
		topologyWeights: { torus: 0.54, helix: 0.23, saddle: 0.08, knot: 0.04, cage: 0.11 },
		tension: 0.1,
		release: 0.15,
		openness: 0.43,
		dropOpenness: 0.08,
		motion: 0.16,
		braid: 0.3,
		twist: 0.22,
		depth: 0.36,
		asymmetry: 0.12,
		cameraPitch: 0.08,
		cameraDistance: 3.68
	},
	verse: {
		topologyWeights: { torus: 0.21, helix: 0.37, saddle: 0.17, knot: 0.1, cage: 0.15 },
		tension: 0.28,
		release: 0.24,
		openness: 0.54,
		dropOpenness: 0.14,
		motion: 0.42,
		braid: 0.5,
		twist: 0.42,
		depth: 0.5,
		asymmetry: 0.28,
		cameraPitch: 0.02,
		cameraDistance: 3.48
	},
	pre_chorus: {
		topologyWeights: { torus: 0.1, helix: 0.29, saddle: 0.15, knot: 0.3, cage: 0.16 },
		tension: 0.7,
		release: 0.12,
		openness: 0.38,
		dropOpenness: 0.08,
		motion: 0.68,
		braid: 0.69,
		twist: 0.7,
		depth: 0.58,
		asymmetry: 0.34,
		cameraPitch: -0.04,
		cameraDistance: 3.58
	},
	build: {
		topologyWeights: { torus: 0.04, helix: 0.2, saddle: 0.09, knot: 0.39, cage: 0.28 },
		tension: 0.88,
		release: 0.06,
		openness: 0.27,
		dropOpenness: 0.03,
		motion: 0.82,
		braid: 0.84,
		twist: 0.88,
		depth: 0.65,
		asymmetry: 0.4,
		cameraPitch: -0.08,
		cameraDistance: 3.76
	},
	drop: {
		topologyWeights: { torus: 0.07, helix: 0.18, saddle: 0.07, knot: 0.36, cage: 0.32 },
		tension: 0.24,
		release: 0.98,
		openness: 0.96,
		dropOpenness: 1,
		motion: 1,
		braid: 0.76,
		twist: 0.68,
		depth: 0.9,
		asymmetry: 0.2,
		cameraPitch: 0.05,
		cameraDistance: 2.82
	},
	chorus: {
		topologyWeights: { torus: 0.12, helix: 0.18, saddle: 0.12, knot: 0.28, cage: 0.3 },
		tension: 0.34,
		release: 0.8,
		openness: 0.86,
		dropOpenness: 0.78,
		motion: 0.86,
		braid: 0.72,
		twist: 0.62,
		depth: 0.82,
		asymmetry: 0.24,
		cameraPitch: 0.04,
		cameraDistance: 3.02
	},
	bridge: {
		topologyWeights: { torus: 0.12, helix: 0.12, saddle: 0.42, knot: 0.16, cage: 0.18 },
		tension: 0.24,
		release: 0.34,
		openness: 0.61,
		dropOpenness: 0.24,
		motion: 0.32,
		braid: 0.4,
		twist: 0.3,
		depth: 0.72,
		asymmetry: 0.76,
		cameraPitch: 0.15,
		cameraDistance: 3.34
	},
	breakdown: {
		topologyWeights: { torus: 0.36, helix: 0.12, saddle: 0.3, knot: 0.05, cage: 0.17 },
		tension: 0.08,
		release: 0.28,
		openness: 0.48,
		dropOpenness: 0.18,
		motion: 0.15,
		braid: 0.24,
		twist: 0.16,
		depth: 0.62,
		asymmetry: 0.46,
		cameraPitch: 0.19,
		cameraDistance: 3.72
	},
	outro: {
		topologyWeights: { torus: 0.48, helix: 0.11, saddle: 0.2, knot: 0.04, cage: 0.17 },
		tension: 0.04,
		release: 0.14,
		openness: 0.38,
		dropOpenness: 0.06,
		motion: 0.09,
		braid: 0.18,
		twist: 0.1,
		depth: 0.38,
		asymmetry: 0.18,
		cameraPitch: 0.11,
		cameraDistance: 3.92
	}
};

const TOPOLOGY_COUNT = LOOM_TOPOLOGY_NAMES.length;
const BAND_ATTACK = [0.08, 0.025, 0.05, 0.075, 0.04, 0.025] as const;
const BAND_RELEASE = [0.7, 0.28, 0.5, 0.62, 0.38, 0.25] as const;

function finite(value: number | undefined, fallback = 0): number {
	return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp(value: number, low: number, high: number): number {
	const safe = finite(value, low);
	return safe < low ? low : safe > high ? high : safe;
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function wrap01(value: number): number {
	const safe = finite(value);
	const wrapped = safe - Math.floor(safe);
	return wrapped < 0 ? wrapped + 1 : wrapped;
}

function safeDt(dtSeconds: number): number {
	if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 1 / 60;
	return clamp(dtSeconds, 1 / 1_000, 0.25);
}

function approach(current: number, target: number, tauSeconds: number, dtSeconds: number): number {
	const safeCurrent = finite(current);
	const safeTarget = finite(target, safeCurrent);
	const alpha = tauSeconds <= 0 ? 1 : 1 - Math.exp(-dtSeconds / tauSeconds);
	return safeCurrent + (safeTarget - safeCurrent) * alpha;
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
	const safeCurrent = wrap01(current);
	const safeTarget = wrap01(target);
	const delta = ((((safeTarget - safeCurrent + 0.5) % 1) + 1) % 1) - 0.5;
	return wrap01(safeCurrent + delta * (1 - Math.exp(-dtSeconds / Math.max(tauSeconds, 1e-6))));
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

function unitHash(seedWord: number, phraseIndex: number, channel: number): number {
	const phraseWord = Math.imul((Math.floor(finite(phraseIndex)) + 1) | 0, 0x9e3779b1);
	return mix32(seedWord ^ phraseWord ^ Math.imul(channel + 1, 0x85ebca6b)) / 0x1_0000_0000;
}

function readBand(vector: SignalBandVector, index: number): number {
	switch (index) {
		case 0:
			return finite(vector.sub);
		case 1:
			return finite(vector.kick);
		case 2:
			return finite(vector.body);
		case 3:
			return finite(vector.mids);
		case 4:
			return finite(vector.presence);
		default:
			return finite(vector.air);
	}
}

function writeBands(target: SignalBandVector, source: ArrayLike<number>): void {
	target.sub = source[0] ?? 0;
	target.kick = source[1] ?? 0;
	target.body = source[2] ?? 0;
	target.mids = source[3] ?? 0;
	target.presence = source[4] ?? 0;
	target.air = source[5] ?? 0;
}

function writeTopology(target: LoomTopologyWeights, source: ArrayLike<number>): void {
	target.torus = source[0] ?? 0;
	target.helix = source[1] ?? 0;
	target.saddle = source[2] ?? 0;
	target.knot = source[3] ?? 0;
	target.cage = source[4] ?? 0;
}

function writeProfileTopology(
	target: Float32Array,
	weights: Readonly<LoomTopologyWeights>
): void {
	target[0] = weights.torus;
	target[1] = weights.helix;
	target[2] = weights.saddle;
	target[3] = weights.knot;
	target[4] = weights.cage;
}

/** Pure section baseline for tests, renderer tooling, and diagnostics. */
export function getLoomSectionProfile(section: VisualizerSection): Readonly<LoomSectionProfile> {
	return SECTION_PROFILES[section];
}

/**
 * Normalize five non-negative topology weights in place. Degenerate input
 * becomes a torus instead of allowing a blank or NaN manifold.
 */
export function normalizeLoomTopologyWeightArray(weights: Float32Array): Float32Array {
	if (weights.length < TOPOLOGY_COUNT) {
		throw new RangeError(`Loom topology weight buffer needs ${TOPOLOGY_COUNT} entries.`);
	}
	let sum = 0;
	for (let i = 0; i < TOPOLOGY_COUNT; i += 1) {
		weights[i] = Math.max(0, finite(weights[i]));
		sum += weights[i];
	}
	if (sum <= 1e-8) {
		weights[0] = 1;
		for (let i = 1; i < TOPOLOGY_COUNT; i += 1) weights[i] = 0;
		return weights;
	}
	for (let i = 0; i < TOPOLOGY_COUNT; i += 1) weights[i] /= sum;
	return weights;
}

/**
 * Fill a deterministic, zero-sum phrase bias. It adds vocabulary without a
 * random generator, hard topology switches, or allocations during playback.
 */
export function fillLoomPhraseVariation(
	out: Float32Array,
	seed: LoomSeed,
	phraseIndex: number
): Float32Array {
	if (out.length < TOPOLOGY_COUNT) {
		throw new RangeError(`Loom phrase variation buffer needs ${TOPOLOGY_COUNT} entries.`);
	}
	const seedWord = signalSeedWord(seed);
	let mean = 0;
	for (let i = 0; i < TOPOLOGY_COUNT; i += 1) {
		out[i] = (unitHash(seedWord, phraseIndex, i) - 0.5) * 0.18;
		mean += out[i] / TOPOLOGY_COUNT;
	}
	for (let i = 0; i < TOPOLOGY_COUNT; i += 1) out[i] -= mean;
	return out;
}

/**
 * Harmony-led, phrase-scale arranger for Loom. The class is deliberately CPU
 * only: a shared journey can keep it advancing while Loom's WebGPU component
 * is unmounted, preserving the visual song rather than restarting a loop.
 */
export class LoomConductor {
	private seed: LoomSeed = 0;
	private seedWord = 0;
	private rotationDirection = 1;
	private readonly phraseBias = new Float32Array(TOPOLOGY_COUNT);
	private readonly currentTopology = new Float32Array(TOPOLOGY_COUNT);
	private readonly targetTopology = new Float32Array(TOPOLOGY_COUNT);
	private readonly currentBands = new Float32Array(6);
	private lastSection: VisualizerSection | null = null;
	private lastContextSource: VisualDirectorFrame['context']['source'] | null = null;
	private lastPhraseIndex = Number.MIN_SAFE_INTEGER;
	private phraseVariation = 0.5;
	private tension = SECTION_PROFILES.intro.tension;
	private release = SECTION_PROFILES.intro.release;
	private openness = SECTION_PROFILES.intro.openness;
	private dropOpenness = SECTION_PROFILES.intro.dropOpenness;
	private braid = SECTION_PROFILES.intro.braid;
	private twist = SECTION_PROFILES.intro.twist;
	private depth = SECTION_PROFILES.intro.depth;
	private impact = 0;
	private reweave = 0;
	private sectionPulse = 0;
	private signedAsymmetry = 0;
	private motion = SECTION_PROFILES.intro.motion;
	private macroEnergy = 0.16;
	private tempo = 0.5;
	private key = 0;
	private mode = 0;
	private crossingOrder = 0;
	private harmonicSpread = 0;
	private spectralLean = 0;
	private topologyPhase = 0;
	private weavePhase = 0;
	private longPhase = 0;
	private topologyRate = 0.12;
	private weaveRate = 0.22;
	private longRate = 0.025;
	private cameraYaw = 0;
	private cameraPitch = SECTION_PROFILES.intro.cameraPitch;
	private cameraDistance = SECTION_PROFILES.intro.cameraDistance;
	private cameraRoll = 0;

	private readonly output: LoomConductorFrame = {
		section: 'intro',
		topologyWeights: { torus: 0.54, helix: 0.23, saddle: 0.08, knot: 0.04, cage: 0.11 },
		strandEnergy: { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 },
		tension: SECTION_PROFILES.intro.tension,
		release: SECTION_PROFILES.intro.release,
		openness: SECTION_PROFILES.intro.openness,
		dropOpenness: SECTION_PROFILES.intro.dropOpenness,
		braid: SECTION_PROFILES.intro.braid,
		twist: SECTION_PROFILES.intro.twist,
		depth: SECTION_PROFILES.intro.depth,
		impact: 0,
		reweave: 0,
		sectionPulse: 0,
		signedAsymmetry: 0,
		motion: SECTION_PROFILES.intro.motion,
		macroEnergy: 0.16,
		phrase: 0,
		phraseIndex: 0,
		phraseVariation: 0.5,
		tempo: 0.5,
		key: 0,
		mode: 0,
		crossingOrder: 0,
		harmonicSpread: 0,
		spectralLean: 0,
		topologyPhase: 0,
		weavePhase: 0,
		longPhase: 0,
		topologyRate: 0.12,
		weaveRate: 0.22,
		longRate: 0.025,
		cameraYaw: 0,
		cameraPitch: SECTION_PROFILES.intro.cameraPitch,
		cameraDistance: SECTION_PROFILES.intro.cameraDistance,
		cameraRoll: 0
	};

	constructor(seed: LoomSeed = 0) {
		this.reset(seed);
	}

	reset(seed: LoomSeed = this.seed): void {
		this.seed = seed;
		this.seedWord = signalSeedWord(seed);
		this.rotationDirection = (this.seedWord & 1) === 0 ? 1 : -1;
		const seedUnit = this.seedWord / 0x1_0000_0000;
		const intro = SECTION_PROFILES.intro;

		this.phraseBias.fill(0);
		writeProfileTopology(this.currentTopology, intro.topologyWeights);
		this.targetTopology.set(this.currentTopology);
		this.currentBands.fill(0);
		this.lastSection = null;
		this.lastContextSource = null;
		this.lastPhraseIndex = Number.MIN_SAFE_INTEGER;
		this.phraseVariation = 0.5;
		this.tension = intro.tension;
		this.release = intro.release;
		this.openness = intro.openness;
		this.dropOpenness = intro.dropOpenness;
		this.braid = intro.braid;
		this.twist = intro.twist;
		this.depth = intro.depth;
		this.impact = 0;
		this.reweave = 0;
		this.sectionPulse = 0;
		this.signedAsymmetry = 0;
		this.motion = intro.motion;
		this.macroEnergy = 0.16;
		this.tempo = 0.5;
		this.key = 0;
		this.mode = 0;
		this.crossingOrder = 0;
		this.harmonicSpread = 0;
		this.spectralLean = 0;
		this.topologyPhase = seedUnit * Math.PI * 2;
		this.weavePhase = wrap01(seedUnit * 1.618_033_988_75) * Math.PI * 2;
		this.longPhase = wrap01(seedUnit * 0.381_966_011_25) * Math.PI * 2;
		this.topologyRate = 0.12;
		this.weaveRate = 0.22;
		this.longRate = 0.025;
		this.cameraYaw = 0;
		this.cameraPitch = intro.cameraPitch;
		this.cameraDistance = intro.cameraDistance;
		this.cameraRoll = 0;

		this.output.section = 'intro';
		writeTopology(this.output.topologyWeights, this.currentTopology);
		writeBands(this.output.strandEnergy, this.currentBands);
		this.output.tension = this.tension;
		this.output.release = this.release;
		this.output.openness = this.openness;
		this.output.dropOpenness = this.dropOpenness;
		this.output.braid = this.braid;
		this.output.twist = this.twist;
		this.output.depth = this.depth;
		this.output.impact = 0;
		this.output.reweave = 0;
		this.output.sectionPulse = 0;
		this.output.signedAsymmetry = 0;
		this.output.motion = this.motion;
		this.output.macroEnergy = this.macroEnergy;
		this.output.phrase = 0;
		this.output.phraseIndex = 0;
		this.output.phraseVariation = 0.5;
		this.output.tempo = this.tempo;
		this.output.key = 0;
		this.output.mode = 0;
		this.output.crossingOrder = 0;
		this.output.harmonicSpread = 0;
		this.output.spectralLean = 0;
		this.output.topologyPhase = this.topologyPhase;
		this.output.weavePhase = this.weavePhase;
		this.output.longPhase = this.longPhase;
		this.output.topologyRate = this.topologyRate;
		this.output.weaveRate = this.weaveRate;
		this.output.longRate = this.longRate;
		this.output.cameraYaw = 0;
		this.output.cameraPitch = this.cameraPitch;
		this.output.cameraDistance = this.cameraDistance;
		this.output.cameraRoll = 0;
	}

	update(
		frame: VisualDirectorFrame,
		spectrum: SignalSpectrumProfile,
		dtSeconds: number
	): Readonly<LoomConductorFrame> {
		const dt = safeDt(dtSeconds);
		const profile = SECTION_PROFILES[frame.section] ?? SECTION_PROFILES.intro;
		const contextSource = frame.context.source;
		const contextSourceChanged =
			this.lastContextSource !== null && this.lastContextSource !== contextSource;
		this.lastContextSource = contextSource;

		if (this.lastSection === null) {
			this.lastSection = frame.section;
		} else if (frame.section !== this.lastSection) {
			this.lastSection = frame.section;
			if (!contextSourceChanged) this.sectionPulse = 1;
		}
		this.sectionPulse *= Math.exp(-dt / 0.82);

		const phraseIndex = Number.isFinite(frame.clock.phraseIndex)
			? Math.floor(frame.clock.phraseIndex)
			: 0;
		if (phraseIndex !== this.lastPhraseIndex) {
			const hadPhrase = this.lastPhraseIndex !== Number.MIN_SAFE_INTEGER;
			this.lastPhraseIndex = phraseIndex;
			fillLoomPhraseVariation(this.phraseBias, this.seed, phraseIndex);
			this.phraseVariation = unitHash(this.seedWord, phraseIndex, 11);
			if (hadPhrase && !contextSourceChanged) this.reweave = 1;
		}

		const tempoBpm = clamp(finite(frame.clock.tempoBpm, 120), 60, 180);
		const beatSeconds = 60 / tempoBpm;
		const tempoTarget = (tempoBpm - 60) / 120;
		this.tempo = approach(this.tempo, tempoTarget, 1.4, dt);
		this.reweave *= Math.exp(-dt / clamp(beatSeconds * 4.2, 1.4, 3.5));

		const keyConfidence = clamp01(finite(frame.context.keyConfidence));
		const pitchClass = ((Math.round(wrap01(frame.context.keyPitchClass) * 12) % 12) + 12) % 12;
		const fifthsTarget = wrap01((pitchClass * 7) / 12);
		const tonnetzTarget = wrap01(
			Math.atan2(finite(frame.tonnetz[1]), finite(frame.tonnetz[0], 1)) / (Math.PI * 2)
		);
		this.key = approachCircular(
			this.key,
			keyConfidence >= 0.08 ? fifthsTarget : tonnetzTarget,
			1.6,
			dt
		);
		const modeTarget =
			frame.context.keyMode === 'major'
				? keyConfidence
				: frame.context.keyMode === 'minor'
					? -keyConfidence
					: 0;
		this.mode = approach(this.mode, modeTarget, 2.4, dt);

		let tonnetzMagnitude = 0;
		for (let i = 0; i < 6; i += 1) tonnetzMagnitude += Math.abs(finite(frame.tonnetz[i]));
		const harmonicSpreadTarget = clamp01(
			tonnetzMagnitude / 4.2 + (1 - keyConfidence) * 0.12 + finite(spectrum.spectralMotion) * 0.12
		);
		this.harmonicSpread = approach(this.harmonicSpread, harmonicSpreadTarget, 1.8, dt);
		this.spectralLean = approach(
			this.spectralLean,
			clamp(
				finite(spectrum.spectralDirection) * 0.76 + finite(spectrum.centroidVelocity) * 0.24,
				-1,
				1
			),
			0.68,
			dt
		);

		const sectionEnergy = clamp01(
			finite(frame.context.sectionEnergy, finite(frame.energy, 0.2))
		);
		const currentEnergy = clamp01(finite(frame.context.energyCurrent, sectionEnergy));
		const futureEnergy = clamp01(finite(frame.context.energyLookahead, currentEnergy));
		const positiveFuture = Math.max(0, futureEnergy - currentEnergy);
		const negativeFuture = Math.max(0, currentEnergy - futureEnergy);
		const positiveSlope = Math.max(0, finite(frame.context.energySlope));
		const anticipation = clamp01(finite(frame.drop.anticipation));
		const buildProgress = clamp01(finite(frame.drop.buildProgress));
		const postDrop = clamp01(finite(frame.drop.postDropDecay));

		const tensionTarget = clamp01(
			profile.tension +
				anticipation * 0.48 +
				buildProgress * 0.14 +
				positiveFuture * 0.18 +
				positiveSlope * 0.12 +
				Math.max(0, finite(spectrum.deltas.presence)) * 0.08 -
				postDrop * 0.3
		);
		const releaseTarget = clamp01(
			Math.max(profile.release, postDrop * 0.82, negativeFuture * 0.38)
		);
		this.tension = approachAsymmetric(this.tension, tensionTarget, 0.42, 1.15, dt);
		this.release = approachAsymmetric(this.release, releaseTarget, 0.16, 1.5, dt);

		const opennessTarget = clamp(
			profile.openness +
				this.release * 0.12 +
				Math.max(0, finite(spectrum.spectralDirection)) * 0.06 +
				finite(spectrum.levels.air) * 0.04 -
				this.tension * 0.12 -
				positiveFuture * 0.06,
			...LOOM_CONDUCTOR_LIMITS.openness
		);
		const dropOpennessTarget = clamp01(
			Math.max(
				profile.dropOpenness,
				postDrop * 0.82,
				this.release * (frame.section === 'drop' || frame.section === 'chorus' ? 0.9 : 0.38)
			) -
				anticipation * 0.12
		);
		this.openness = approach(this.openness, opennessTarget, 0.9, dt);
		this.dropOpenness = approachAsymmetric(
			this.dropOpenness,
			dropOpennessTarget,
			0.22,
			1.7,
			dt
		);

		const macroEnergyTarget = clamp01(
			sectionEnergy * 0.64 + currentEnergy * 0.2 + finite(frame.arousal) * 0.16
		);
		const motionTarget = clamp(
			profile.motion * 0.62 +
				clamp01(finite(frame.motion)) * 0.22 +
				clamp01(finite(spectrum.spectralMotion)) * 0.16,
			...LOOM_CONDUCTOR_LIMITS.motion
		);
		this.macroEnergy = approach(this.macroEnergy, macroEnergyTarget, 1.5, dt);
		this.motion = approach(this.motion, motionTarget, 1.1, dt);

		for (let i = 0; i < 6; i += 1) {
			const level = clamp01(readBand(spectrum.levels, i));
			const delta = Math.max(0, readBand(spectrum.deltas, i));
			const target = frame.silence ? 0 : clamp01(level * 0.8 + delta * 0.38);
			this.currentBands[i] = approachAsymmetric(
				this.currentBands[i],
				target,
				BAND_ATTACK[i],
				BAND_RELEASE[i],
				dt
			);
		}

		const impactTarget = frame.silence
			? 0
			: clamp01(
					Math.max(
						Math.max(0, finite(spectrum.deltas.kick)) * 0.86 +
							Math.max(0, finite(spectrum.deltas.body)) * 0.24,
						clamp01(finite(frame.bassPunch)) * 0.56,
						clamp01(finite(spectrum.novelty)) *
							(0.38 + clamp01(finite(spectrum.crestFactor)) * 0.5)
					)
				);
		this.impact = approachAsymmetric(this.impact, impactTarget, 0.014, 0.24, dt);

		const phrasePolarity = this.phraseVariation >= 0.5 ? 1 : -1;
		const signedAsymmetryTarget = clamp(
			profile.asymmetry * phrasePolarity + this.spectralLean * 0.2,
			-1,
			1
		);
		this.signedAsymmetry = approach(this.signedAsymmetry, signedAsymmetryTarget, 1.5, dt);

		const crossingTarget = clamp(
			Math.sin(
				(this.key + this.phraseVariation * 0.28 + this.mode * 0.035) * Math.PI * 2
			) *
				(0.42 + profile.braid * 0.34 + this.harmonicSpread * 0.16) +
				this.spectralLean * 0.08,
			-1,
			1
		);
		this.crossingOrder = approach(
			this.crossingOrder,
			crossingTarget,
			clamp(beatSeconds * 3.6, 1.4, 3.2),
			dt
		);

		writeProfileTopology(this.targetTopology, profile.topologyWeights);
		const variationAmount = 0.38 + profile.braid * 0.42;
		for (let i = 0; i < TOPOLOGY_COUNT; i += 1) {
			this.targetTopology[i] += this.phraseBias[i] * variationAmount;
		}
		this.targetTopology[0] += Math.max(0, this.mode) * 0.025;
		this.targetTopology[2] += Math.max(0, -this.mode) * 0.025;
		this.targetTopology[3] += this.tension * 0.025;
		this.targetTopology[4] += this.dropOpenness * 0.035 + this.harmonicSpread * 0.02;
		normalizeLoomTopologyWeightArray(this.targetTopology);
		const topologyTau = clamp(beatSeconds * 4.6, 1.6, 3.8);
		for (let i = 0; i < TOPOLOGY_COUNT; i += 1) {
			this.currentTopology[i] = approach(
				this.currentTopology[i],
				this.targetTopology[i],
				topologyTau,
				dt
			);
		}

		const braidTarget = clamp(
			profile.braid +
				finite(spectrum.levels.mids) * 0.08 +
				finite(spectrum.levels.presence) * 0.05 +
				this.harmonicSpread * 0.08,
			...LOOM_CONDUCTOR_LIMITS.braid
		);
		const twistTarget = clamp(
			profile.twist + Math.abs(this.crossingOrder) * 0.08 + Math.abs(this.spectralLean) * 0.08,
			...LOOM_CONDUCTOR_LIMITS.twist
		);
		const depthTarget = clamp(
			profile.depth +
				finite(spectrum.levels.sub) * 0.07 +
				finite(spectrum.levels.body) * 0.05 +
				this.dropOpenness * 0.04,
			...LOOM_CONDUCTOR_LIMITS.depth
		);
		this.braid = approach(this.braid, braidTarget, 1.8, dt);
		this.twist = approach(this.twist, twistTarget, 1.7, dt);
		this.depth = approach(this.depth, depthTarget, 2.2, dt);

		const topologyRateTarget = clamp(
			0.075 + this.motion * 0.31 + this.tension * 0.08 + finite(spectrum.spectralMotion) * 0.08,
			...LOOM_CONDUCTOR_LIMITS.topologyRate
		);
		const weaveRateTarget = clamp(
			0.14 +
				this.motion * 0.48 +
				this.tempo * 0.18 +
				finite(spectrum.levels.presence) * 0.12,
			...LOOM_CONDUCTOR_LIMITS.weaveRate
		);
		const longRateTarget = clamp(
			0.014 + this.macroEnergy * 0.042 + this.harmonicSpread * 0.014,
			...LOOM_CONDUCTOR_LIMITS.longRate
		);
		this.topologyRate = approach(this.topologyRate, topologyRateTarget, 1.8, dt);
		this.weaveRate = approach(this.weaveRate, weaveRateTarget, 1.2, dt);
		this.longRate = approach(this.longRate, longRateTarget, 3.5, dt);
		this.topologyPhase += this.topologyRate * dt;
		this.weavePhase += this.weaveRate * dt;
		this.longPhase += this.longRate * dt;

		const cameraYawTarget = clamp(
			this.crossingOrder * 0.18 +
				this.spectralLean * 0.07 +
				Math.sin(this.longPhase) * 0.055,
			...LOOM_CONDUCTOR_LIMITS.cameraYaw
		);
		const cameraPitchTarget = clamp(
			profile.cameraPitch +
				(finite(spectrum.levels.air) - finite(spectrum.levels.sub)) * 0.035,
			...LOOM_CONDUCTOR_LIMITS.cameraPitch
		);
		const cameraDistanceTarget = clamp(
			profile.cameraDistance - this.dropOpenness * 0.08 + this.tension * 0.06,
			...LOOM_CONDUCTOR_LIMITS.cameraDistance
		);
		const cameraRollTarget = clamp(
			this.signedAsymmetry * 0.11 + Math.sin(this.longPhase * 0.73) * 0.025,
			...LOOM_CONDUCTOR_LIMITS.cameraRoll
		);
		this.cameraYaw = approach(this.cameraYaw, cameraYawTarget, 3.2, dt);
		this.cameraPitch = approach(this.cameraPitch, cameraPitchTarget, 3.6, dt);
		this.cameraDistance = approach(this.cameraDistance, cameraDistanceTarget, 3.8, dt);
		this.cameraRoll = approach(this.cameraRoll, cameraRollTarget, 3, dt);

		this.output.section = frame.section;
		writeTopology(this.output.topologyWeights, this.currentTopology);
		writeBands(this.output.strandEnergy, this.currentBands);
		this.output.tension = this.tension;
		this.output.release = this.release;
		this.output.openness = this.openness;
		this.output.dropOpenness = this.dropOpenness;
		this.output.braid = this.braid;
		this.output.twist = this.twist;
		this.output.depth = this.depth;
		this.output.impact = this.impact;
		this.output.reweave = this.reweave;
		this.output.sectionPulse = this.sectionPulse;
		this.output.signedAsymmetry = this.signedAsymmetry;
		this.output.motion = this.motion;
		this.output.macroEnergy = this.macroEnergy;
		this.output.phrase = clamp01(finite(frame.clock.phrasePos, finite(frame.phrase)));
		this.output.phraseIndex = phraseIndex;
		this.output.phraseVariation = this.phraseVariation;
		this.output.tempo = this.tempo;
		this.output.key = this.key;
		this.output.mode = this.mode;
		this.output.crossingOrder = this.crossingOrder;
		this.output.harmonicSpread = this.harmonicSpread;
		this.output.spectralLean = this.spectralLean;
		this.output.topologyPhase = this.topologyPhase;
		this.output.weavePhase = this.weavePhase;
		this.output.longPhase = this.longPhase;
		this.output.topologyRate = this.topologyRate;
		this.output.weaveRate = this.weaveRate;
		this.output.longRate = this.longRate;
		this.output.cameraYaw = this.cameraYaw;
		this.output.cameraPitch = this.cameraPitch;
		this.output.cameraDistance = this.cameraDistance;
		this.output.cameraRoll = this.cameraRoll;

		return this.output;
	}
}
