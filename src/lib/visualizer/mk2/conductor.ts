import type { VisualDirectorFrame, VisualizerSection } from '$lib/visualizer/director/types';
import {
	signalSeedWord,
	type SignalConductorFrame,
	type SignalSeed
} from '$lib/visualizer/signal/conductor';
import type { SignalSpectrumProfile } from '$lib/visualizer/signal/spectrum';

export type Mk2Seed = SignalSeed;

export type Mk2SectionProfile = {
	growth: number;
	tension: number;
	release: number;
	openness: number;
	macroEnergy: number;
	motion: number;
	cameraSpeed: number;
	cameraDistance: number;
	topologyBias: number;
	fogDensity: number;
	shaftIntensity: number;
	backgroundFlow: number;
};

/**
 * Slow, bounded controls for Mk2. `impact` is the only intentionally fast
 * rail; the component can layer it over these values without moving the
 * camera or changing topology on individual beats.
 */
export type Mk2ConductorFrame = {
	section: VisualizerSection;
	/** Wound-in anticipation. It only grows from positive lookahead/build evidence. */
	suspense: number;
	growth: number;
	tension: number;
	release: number;
	openness: number;
	macroEnergy: number;
	/** Fast transient envelope, 0..0.78, with an approximately 300 ms release. */
	impact: number;
	/** Continuous and deliberately unwrapped so the renderer never snaps at 2 PI. */
	rotationPhase: number;
	/** Signed radians per second. Direction is fixed for the lifetime of a seed. */
	rotationRate: number;
	/** Continuous camera-path phase retained by the shared CPU journey. */
	cameraPhase: number;
	cameraSpeed: number;
	cameraDistance: number;
	topologyBias: number;
	fogDensity: number;
	shaftIntensity: number;
	backgroundFlow: number;
	/** Continuous atmospheric-flow phase retained across renderer remounts. */
	backgroundFlowPhase: number;
	/** Harmony and phrase identity are confined to these slowly moving posture rails. */
	postureYaw: number;
	posturePitch: number;
};

export const MK2_CONDUCTOR_LIMITS = {
	suspense: [0, 1],
	growth: [0.12, 0.78],
	tension: [0.04, 0.88],
	release: [0.04, 0.96],
	openness: [0.18, 0.94],
	macroEnergy: [0.08, 0.94],
	impact: [0, 0.78],
	rotationRateMagnitude: [0.02, 0.12],
	cameraSpeed: [0.01, 0.045],
	cameraDistance: [0.98, 1.1],
	topologyBias: [-0.22, 0.35],
	fogDensity: [0.032, 0.088],
	shaftIntensity: [0.18, 0.8],
	backgroundFlow: [0.005, 0.04],
	postureYaw: [-0.1, 0.1],
	posturePitch: [-0.07, 0.07]
} as const;

const SECTION_PROFILES: Readonly<Record<VisualizerSection, Mk2SectionProfile>> = {
	calm: {
		growth: 0.15,
		tension: 0.08,
		release: 0.1,
		openness: 0.34,
		macroEnergy: 0.14,
		motion: 0.12,
		cameraSpeed: 0.012,
		cameraDistance: 1.09,
		topologyBias: -0.12,
		fogDensity: 0.038,
		shaftIntensity: 0.23,
		backgroundFlow: 0.008
	},
	intro: {
		growth: 0.22,
		tension: 0.12,
		release: 0.17,
		openness: 0.43,
		macroEnergy: 0.22,
		motion: 0.18,
		cameraSpeed: 0.014,
		cameraDistance: 1.07,
		topologyBias: -0.08,
		fogDensity: 0.043,
		shaftIntensity: 0.29,
		backgroundFlow: 0.011
	},
	verse: {
		growth: 0.42,
		tension: 0.28,
		release: 0.24,
		openness: 0.54,
		macroEnergy: 0.46,
		motion: 0.4,
		cameraSpeed: 0.019,
		cameraDistance: 1.05,
		topologyBias: 0,
		fogDensity: 0.052,
		shaftIntensity: 0.4,
		backgroundFlow: 0.017
	},
	pre_chorus: {
		growth: 0.4,
		tension: 0.68,
		release: 0.14,
		openness: 0.38,
		macroEnergy: 0.56,
		motion: 0.62,
		cameraSpeed: 0.026,
		cameraDistance: 1.04,
		topologyBias: 0.12,
		fogDensity: 0.061,
		shaftIntensity: 0.53,
		backgroundFlow: 0.024
	},
	build: {
		growth: 0.38,
		tension: 0.82,
		release: 0.08,
		openness: 0.27,
		macroEnergy: 0.62,
		motion: 0.76,
		cameraSpeed: 0.031,
		cameraDistance: 1.03,
		topologyBias: 0.22,
		fogDensity: 0.068,
		shaftIntensity: 0.62,
		backgroundFlow: 0.029
	},
	drop: {
		growth: 0.72,
		tension: 0.24,
		release: 0.96,
		openness: 0.94,
		macroEnergy: 0.9,
		motion: 0.86,
		cameraSpeed: 0.036,
		cameraDistance: 0.995,
		topologyBias: 0.28,
		fogDensity: 0.079,
		shaftIntensity: 0.76,
		backgroundFlow: 0.035
	},
	chorus: {
		growth: 0.66,
		tension: 0.32,
		release: 0.8,
		openness: 0.86,
		macroEnergy: 0.8,
		motion: 0.74,
		cameraSpeed: 0.032,
		cameraDistance: 1.01,
		topologyBias: 0.22,
		fogDensity: 0.072,
		shaftIntensity: 0.69,
		backgroundFlow: 0.031
	},
	bridge: {
		growth: 0.32,
		tension: 0.24,
		release: 0.35,
		openness: 0.61,
		macroEnergy: 0.4,
		motion: 0.3,
		cameraSpeed: 0.017,
		cameraDistance: 1.055,
		topologyBias: -0.02,
		fogDensity: 0.048,
		shaftIntensity: 0.36,
		backgroundFlow: 0.015
	},
	breakdown: {
		growth: 0.2,
		tension: 0.1,
		release: 0.28,
		openness: 0.48,
		macroEnergy: 0.24,
		motion: 0.15,
		cameraSpeed: 0.013,
		cameraDistance: 1.08,
		topologyBias: -0.1,
		fogDensity: 0.041,
		shaftIntensity: 0.28,
		backgroundFlow: 0.009
	},
	outro: {
		growth: 0.14,
		tension: 0.05,
		release: 0.14,
		openness: 0.38,
		macroEnergy: 0.16,
		motion: 0.1,
		cameraSpeed: 0.011,
		cameraDistance: 1.09,
		topologyBias: -0.14,
		fogDensity: 0.037,
		shaftIntensity: 0.22,
		backgroundFlow: 0.007
	}
};

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

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((finite(value) - edge0) / Math.max(edge1 - edge0, 1e-9));
	return t * t * (3 - 2 * t);
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

function circularMix(from: number, to: number, amount: number): number {
	const start = wrap01(from);
	const end = wrap01(to);
	const delta = ((((end - start + 0.5) % 1) + 1) % 1) - 0.5;
	return wrap01(start + delta * clamp01(amount));
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

function signedHash(seedWord: number, channel: number): number {
	return (mix32(seedWord ^ Math.imul(channel, 0x9e3779b1)) / 0x1_0000_0000 - 0.5) * 2;
}

/** Pure section baseline for tests, tooling, and renderer diagnostics. */
export function getMk2SectionProfile(section: VisualizerSection): Readonly<Mk2SectionProfile> {
	return SECTION_PROFILES[section];
}

/**
 * Phrase-scale palette motion driven by Signal's continuous travel phase.
 * The sine is periodic at the 0/1 wrap, unlike raw phrase progress.
 */
export function mk2ContinuousPaletteBlend(spectrumTravel: number): number {
	return 0.22 + Math.sin(wrap01(spectrumTravel) * Math.PI * 2) * 0.06;
}

/**
 * Mk2's macro arranger. It borrows Signal's journey semantics, then narrows
 * them into conservative rails appropriate for Mk2's heavier scene. Section
 * changes replace targets only: no event adds an offset that can accumulate.
 */
export class Mk2Conductor {
	private seed: Mk2Seed = 0;
	private seedWord = 0;
	private rotationDirection = 1;
	private seedGrowth = 0;
	private seedDistance = 0;
	private seedTopology = 0;
	private seedRotation = 0;

	private suspense = 0;
	private growth = SECTION_PROFILES.intro.growth;
	private tension = SECTION_PROFILES.intro.tension;
	private release = SECTION_PROFILES.intro.release;
	private openness = SECTION_PROFILES.intro.openness;
	private macroEnergy = SECTION_PROFILES.intro.macroEnergy;
	private impact = 0;
	private rotationPhase = 0;
	private rotationRate = 0.03;
	private cameraPhase = 0;
	private cameraSpeed = SECTION_PROFILES.intro.cameraSpeed;
	private cameraDistance = SECTION_PROFILES.intro.cameraDistance;
	private topologyBias = SECTION_PROFILES.intro.topologyBias;
	private fogDensity = SECTION_PROFILES.intro.fogDensity;
	private shaftIntensity = SECTION_PROFILES.intro.shaftIntensity;
	private backgroundFlow = SECTION_PROFILES.intro.backgroundFlow;
	private backgroundFlowPhase = 0;
	private keyPosition = 0;
	private postureYaw = 0;
	private posturePitch = 0;

	private readonly output: Mk2ConductorFrame = {
		section: 'intro',
		suspense: 0,
		growth: SECTION_PROFILES.intro.growth,
		tension: SECTION_PROFILES.intro.tension,
		release: SECTION_PROFILES.intro.release,
		openness: SECTION_PROFILES.intro.openness,
		macroEnergy: SECTION_PROFILES.intro.macroEnergy,
		impact: 0,
		rotationPhase: 0,
		rotationRate: 0.03,
		cameraPhase: 0,
		cameraSpeed: SECTION_PROFILES.intro.cameraSpeed,
		cameraDistance: SECTION_PROFILES.intro.cameraDistance,
		topologyBias: SECTION_PROFILES.intro.topologyBias,
		fogDensity: SECTION_PROFILES.intro.fogDensity,
		shaftIntensity: SECTION_PROFILES.intro.shaftIntensity,
		backgroundFlow: SECTION_PROFILES.intro.backgroundFlow,
		backgroundFlowPhase: 0,
		postureYaw: 0,
		posturePitch: 0
	};

	constructor(seed: Mk2Seed = 0) {
		this.reset(seed);
	}

	reset(seed: Mk2Seed = this.seed): void {
		this.seed = seed;
		this.seedWord = signalSeedWord(seed);
		this.rotationDirection = (this.seedWord & 1) === 0 ? 1 : -1;
		this.seedGrowth = signedHash(this.seedWord, 1) * 0.01;
		this.seedDistance = signedHash(this.seedWord, 2) * 0.0025;
		this.seedTopology = signedHash(this.seedWord, 3) * 0.008;
		this.seedRotation = signedHash(this.seedWord, 4) * 0.004;
		const seedPhase =
			typeof seed === 'number' && Number.isFinite(seed)
				? wrap01(seed)
				: this.seedWord / 0x1_0000_0000;

		const intro = SECTION_PROFILES.intro;
		this.suspense = 0;
		this.growth = clamp(
			intro.growth + this.seedGrowth,
			...MK2_CONDUCTOR_LIMITS.growth
		);
		this.tension = intro.tension;
		this.release = intro.release;
		this.openness = intro.openness;
		this.macroEnergy = intro.macroEnergy;
		this.impact = 0;
		this.rotationPhase = 0;
		this.rotationRate =
			this.rotationDirection *
			clamp(0.03 + this.seedRotation, ...MK2_CONDUCTOR_LIMITS.rotationRateMagnitude);
		this.cameraPhase = seedPhase * 6;
		this.cameraSpeed = intro.cameraSpeed;
		this.cameraDistance = clamp(
			intro.cameraDistance + this.seedDistance,
			...MK2_CONDUCTOR_LIMITS.cameraDistance
		);
		this.topologyBias = clamp(
			intro.topologyBias + this.seedTopology,
			...MK2_CONDUCTOR_LIMITS.topologyBias
		);
		this.fogDensity = intro.fogDensity;
		this.shaftIntensity = intro.shaftIntensity;
		this.backgroundFlow = intro.backgroundFlow;
		this.backgroundFlowPhase = seedPhase * Math.PI * 2;
		this.keyPosition = 0;
		this.postureYaw = 0;
		this.posturePitch = 0;

		this.output.section = 'intro';
		this.writeOutput();
	}

	update(
		frame: VisualDirectorFrame,
		signal: Readonly<SignalConductorFrame>,
		spectrum: Readonly<SignalSpectrumProfile>,
		dtSeconds: number
	): Readonly<Mk2ConductorFrame> {
		const dt = safeDt(dtSeconds);
		const sectionName = frame.section;
		const profile = SECTION_PROFILES[sectionName] ?? SECTION_PROFILES.intro;
		const context = frame.context;

		const sectionProgress = clamp01(finite(context?.sectionProgress));
		const energyCurrent = clamp01(finite(context?.energyCurrent, finite(frame.energy)));
		const energyLookahead = clamp01(finite(context?.energyLookahead, energyCurrent));
		const risingForecast = clamp01((energyLookahead - energyCurrent) * 2.2);
		const risingSlope = clamp01(Math.max(0, finite(context?.energySlope)) * 1.6);
		const suspenseArc = smoothstep(0.08, 0.94, sectionProgress);
		const buildSection = sectionName === 'build' || sectionName === 'pre_chorus';
		const buildEvidence = Math.max(
			clamp01(finite(frame.drop?.anticipation)),
			clamp01(finite(frame.drop?.buildProgress)) * 0.88,
			risingForecast * 0.8 + risingSlope * 0.2
		);
		// Positive future energy winds the scene in one direction. Falling
		// lookahead never becomes "negative suspense" or reverses an arc.
		const suspenseTarget = clamp01(
			buildEvidence *
				(buildSection || frame.drop?.buildActive
					? 0.28 + suspenseArc * 0.72
					: 0.18 + suspenseArc * 0.17)
		);
		this.suspense = approachAsymmetric(this.suspense, suspenseTarget, 0.85, 1.3, dt);

		const signalTension = clamp01(finite(signal.tension, profile.tension));
		const signalRelease = clamp01(finite(signal.release, profile.release));
		const signalOpenness = clamp01(finite(signal.openness, profile.openness));
		const signalMotion = clamp01(finite(signal.motion, profile.motion));
		const energy = clamp01(finite(frame.energy));
		const sectionEnergy = clamp01(finite(context?.sectionEnergy, energy));
		const centroid = clamp01(finite(spectrum.centroid, 0.42));
		const body = clamp01(finite(spectrum.levels?.body));
		const mids = clamp01(finite(spectrum.levels?.mids));
		const bass = clamp01(finite(spectrum.bass));
		const treble = clamp01(finite(spectrum.treble));
		const spectralMotion = clamp01(finite(spectrum.spectralMotion));
		const spectralDirection = clamp(finite(spectrum.spectralDirection), -1, 1);

		const releaseTarget = clamp(
			profile.release * 0.58 +
				signalRelease * 0.42 +
				clamp01(finite(frame.drop?.postDropDecay)) * 0.06,
			...MK2_CONDUCTOR_LIMITS.release
		);
		const tensionTarget = clamp(
			profile.tension * 0.62 +
				signalTension * 0.38 +
				this.suspense * 0.12 +
				Math.max(0, finite(spectrum.deltas?.presence)) * 0.025 -
				releaseTarget * 0.05,
			...MK2_CONDUCTOR_LIMITS.tension
		);
		const growthTarget = clamp(
			profile.growth +
				(signalOpenness - 0.5) * 0.035 +
				(signalRelease - 0.4) * 0.035 +
				(body - 0.4) * 0.018 -
				this.suspense * 0.06 +
				this.seedGrowth,
			...MK2_CONDUCTOR_LIMITS.growth
		);
		const opennessTarget = clamp(
			profile.openness * 0.65 +
				signalOpenness * 0.35 +
				releaseTarget * 0.035 +
				(centroid - 0.5) * 0.02 -
				this.suspense * 0.08,
			...MK2_CONDUCTOR_LIMITS.openness
		);
		const macroEnergyTarget = clamp(
			profile.macroEnergy * 0.72 +
				energy * 0.11 +
				sectionEnergy * 0.07 +
				signalMotion * 0.07 +
				releaseTarget * 0.06 +
				body * 0.03 -
				this.suspense * 0.025,
			...MK2_CONDUCTOR_LIMITS.macroEnergy
		);

		this.growth = approachAsymmetric(this.growth, growthTarget, 0.95, 1.7, dt);
		this.tension = approachAsymmetric(this.tension, tensionTarget, 0.82, 1.3, dt);
		this.release = approachAsymmetric(this.release, releaseTarget, 0.8, 1.5, dt);
		this.openness = approachAsymmetric(this.openness, opennessTarget, 0.95, 1.45, dt);
		this.macroEnergy = approachAsymmetric(
			this.macroEnergy,
			macroEnergyTarget,
			0.85,
			1.65,
			dt
		);

		const positiveKick = Math.max(0, finite(spectrum.deltas?.kick));
		const positiveBody = Math.max(0, finite(spectrum.deltas?.body));
		const beatImpact =
			clamp01(finite(frame.clock?.beatPulse)) *
			(clamp01(finite(spectrum.levels?.kick)) * 0.28 +
				clamp01(finite(spectrum.crestFactor)) * 0.08);
		const impactTarget = clamp(
			Math.max(
				clamp01(finite(signal.impact)) * 0.72,
				positiveKick * 0.62 +
					positiveBody * 0.16 +
					clamp01(finite(spectrum.novelty)) * 0.14,
				clamp01(finite(frame.bassPunch)) * 0.42,
				beatImpact
			),
			...MK2_CONDUCTOR_LIMITS.impact
		);
		this.impact = approachAsymmetric(this.impact, impactTarget, 0.018, 0.3, dt);

		const tempo = clamp01((finite(frame.clock?.tempoBpm, 120) - 60) / 120);
		const signalTempo = clamp01(finite(signal.tempo, tempo));
		const directorMotion = clamp01(finite(frame.motion));
		const motionBlend = clamp01(
			profile.motion * 0.42 + signalMotion * 0.34 + directorMotion * 0.16 + spectralMotion * 0.08
		);
		const rotationMagnitudeTarget = clamp(
			0.022 + motionBlend * 0.046 + tempo * 0.014 + mids * 0.01 + this.seedRotation,
			...MK2_CONDUCTOR_LIMITS.rotationRateMagnitude
		);
		const rotationRateTarget = this.rotationDirection * rotationMagnitudeTarget;
		this.rotationRate = approach(this.rotationRate, rotationRateTarget, 2.8, dt);
		this.rotationRate =
			this.rotationDirection *
			clamp(Math.abs(this.rotationRate), ...MK2_CONDUCTOR_LIMITS.rotationRateMagnitude);
		this.rotationPhase = finite(this.rotationPhase) + this.rotationRate * dt;
		if (!Number.isFinite(this.rotationPhase)) this.rotationPhase = 0;

		const cameraSpeedTarget = clamp(
			profile.cameraSpeed +
				(signalMotion - 0.5) * 0.0045 +
				(signalTempo - 0.5) * 0.003 +
				this.suspense * 0.004 +
				spectralMotion * 0.002,
			...MK2_CONDUCTOR_LIMITS.cameraSpeed
		);
		const cameraDistanceTarget = clamp(
			profile.cameraDistance +
				this.seedDistance -
				this.suspense * 0.008 -
				(releaseTarget - 0.3) * 0.004,
			...MK2_CONDUCTOR_LIMITS.cameraDistance
		);
		this.cameraSpeed = approach(this.cameraSpeed, cameraSpeedTarget, 2.2, dt);
		this.cameraDistance = approach(this.cameraDistance, cameraDistanceTarget, 2.7, dt);
		this.cameraPhase = finite(this.cameraPhase) + this.cameraSpeed * dt;

		const topologyTarget = clamp(
			profile.topologyBias +
				(tensionTarget - profile.tension) * 0.08 +
				(releaseTarget - 0.4) * 0.025 +
				spectralDirection * 0.018 +
				this.suspense * 0.03 +
				this.seedTopology,
			...MK2_CONDUCTOR_LIMITS.topologyBias
		);
		const fogTarget = clamp(
			profile.fogDensity + (macroEnergyTarget - 0.5) * 0.005 + bass * 0.003,
			...MK2_CONDUCTOR_LIMITS.fogDensity
		);
		const shaftTarget = clamp(
			profile.shaftIntensity + releaseTarget * 0.025 + treble * 0.035,
			...MK2_CONDUCTOR_LIMITS.shaftIntensity
		);
		const backgroundTarget = clamp(
			profile.backgroundFlow +
				(signalMotion - 0.5) * 0.002 +
				spectralMotion * 0.003 +
				this.suspense * 0.003,
			...MK2_CONDUCTOR_LIMITS.backgroundFlow
		);
		this.topologyBias = approachAsymmetric(this.topologyBias, topologyTarget, 1.35, 2, dt);
		this.fogDensity = approachAsymmetric(this.fogDensity, fogTarget, 1.2, 2, dt);
		this.shaftIntensity = approachAsymmetric(this.shaftIntensity, shaftTarget, 0.9, 1.5, dt);
		this.backgroundFlow = approachAsymmetric(this.backgroundFlow, backgroundTarget, 1.4, 2.2, dt);
		this.backgroundFlowPhase =
			finite(this.backgroundFlowPhase) + this.backgroundFlow * dt;

		const keyConfidence = clamp01(finite(context?.keyConfidence));
		const signalKey = wrap01(finite(signal.key));
		const contextKey = wrap01(finite(context?.keyPitchClass, signalKey));
		const keyTarget = circularMix(signalKey, contextKey, keyConfidence);
		this.keyPosition = approachCircular(this.keyPosition, keyTarget, 2.6, dt);

		const phraseIndex = Math.floor(finite(frame.clock?.phraseIndex));
		const phraseWord = mix32(
			this.seedWord ^ Math.imul((phraseIndex + 1) | 0, 0x85ebca6b)
		);
		const phraseYaw = signedHash(phraseWord, 11);
		const phrasePitch = signedHash(phraseWord, 17);
		const phraseSignal = (clamp01(finite(signal.phraseVariation, 0.5)) - 0.5) * 2;
		const keyAngle = this.keyPosition * Math.PI * 2;
		const modeBias = context?.keyMode === 'major' ? 1 : context?.keyMode === 'minor' ? -1 : 0;
		const postureYawTarget = clamp(
			Math.sin(keyAngle) * (0.032 + keyConfidence * 0.018) +
				phraseYaw * 0.024 +
				phraseSignal * 0.008,
			...MK2_CONDUCTOR_LIMITS.postureYaw
		);
		const posturePitchTarget = clamp(
			Math.cos(keyAngle) * 0.025 + phrasePitch * 0.018 + modeBias * keyConfidence * 0.012,
			...MK2_CONDUCTOR_LIMITS.posturePitch
		);
		this.postureYaw = approach(this.postureYaw, postureYawTarget, 2.8, dt);
		this.posturePitch = approach(this.posturePitch, posturePitchTarget, 3.1, dt);

		this.output.section = sectionName;
		this.writeOutput();
		return this.output;
	}

	private writeOutput(): void {
		this.output.suspense = clamp(this.suspense, ...MK2_CONDUCTOR_LIMITS.suspense);
		this.output.growth = clamp(this.growth, ...MK2_CONDUCTOR_LIMITS.growth);
		this.output.tension = clamp(this.tension, ...MK2_CONDUCTOR_LIMITS.tension);
		this.output.release = clamp(this.release, ...MK2_CONDUCTOR_LIMITS.release);
		this.output.openness = clamp(this.openness, ...MK2_CONDUCTOR_LIMITS.openness);
		this.output.macroEnergy = clamp(this.macroEnergy, ...MK2_CONDUCTOR_LIMITS.macroEnergy);
		this.output.impact = clamp(this.impact, ...MK2_CONDUCTOR_LIMITS.impact);
		this.output.rotationPhase = finite(this.rotationPhase);
		this.output.rotationRate =
			this.rotationDirection *
			clamp(Math.abs(this.rotationRate), ...MK2_CONDUCTOR_LIMITS.rotationRateMagnitude);
		this.output.cameraPhase = finite(this.cameraPhase);
		this.output.cameraSpeed = clamp(this.cameraSpeed, ...MK2_CONDUCTOR_LIMITS.cameraSpeed);
		this.output.cameraDistance = clamp(
			this.cameraDistance,
			...MK2_CONDUCTOR_LIMITS.cameraDistance
		);
		this.output.topologyBias = clamp(this.topologyBias, ...MK2_CONDUCTOR_LIMITS.topologyBias);
		this.output.fogDensity = clamp(this.fogDensity, ...MK2_CONDUCTOR_LIMITS.fogDensity);
		this.output.shaftIntensity = clamp(
			this.shaftIntensity,
			...MK2_CONDUCTOR_LIMITS.shaftIntensity
		);
		this.output.backgroundFlow = clamp(
			this.backgroundFlow,
			...MK2_CONDUCTOR_LIMITS.backgroundFlow
		);
		this.output.backgroundFlowPhase = finite(this.backgroundFlowPhase);
		this.output.postureYaw = clamp(this.postureYaw, ...MK2_CONDUCTOR_LIMITS.postureYaw);
		this.output.posturePitch = clamp(this.posturePitch, ...MK2_CONDUCTOR_LIMITS.posturePitch);
	}
}
