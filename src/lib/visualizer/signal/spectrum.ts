import type { AudioFeatureFrame } from '$lib/visualizer/director/types';

/**
 * Signal's six perceptual bands. The native analyzer publishes 64 logarithmic
 * bins, so fixed bin slices do not correspond to familiar musical ranges.
 */
export const SIGNAL_BAND_NAMES = ['sub', 'kick', 'body', 'mids', 'presence', 'air'] as const;
export type SignalBandName = (typeof SIGNAL_BAND_NAMES)[number];

export const SIGNAL_BAND_COUNT = SIGNAL_BAND_NAMES.length;
export const SIGNAL_SPECTRUM_BIN_COUNT = 64;

export type SignalBandVector = {
	sub: number;
	kick: number;
	body: number;
	mids: number;
	presence: number;
	air: number;
};

export type SignalSpectrumInput = Pick<
	AudioFeatureFrame,
	'bins' | 'sample_rate' | 'rms' | 'peak' | 'centroid'
>;

export type SignalSpectrumProfile = {
	/** Sample rate used to map analyzer bins back to real frequencies. */
	sampleRate: number;
	/** Inverse-log-decoded band magnitudes before temporal processing. */
	raw: SignalBandVector;
	/** Fast asymmetric envelope in analyzer-linear magnitude space. */
	fast: SignalBandVector;
	/** Slow contextual envelope in analyzer-linear magnitude space. */
	slow: SignalBandVector;
	/** Per-band level divided by a slowly decaying adaptive ceiling, 0..1. */
	levels: SignalBandVector;
	/** Fast minus slow energy, normalized by the adaptive ceiling, -1..1. */
	deltas: SignalBandVector;
	/**
	 * Decoded, baseline-relative detail for the 64-bin trace buffer. Values are
	 * signed -1..1: positive is newly-arrived energy, negative is a receding
	 * partial. The array identity is stable for direct GPU uploads.
	 */
	detailBins: Float32Array;
	/** Positive short-term spectral change, 0..1. */
	novelty: number;
	/** Absolute movement of the six-band spectral shape, 0..1. */
	spectralMotion: number;
	/** Signed movement toward high (+) or low (-) frequencies, -1..1. */
	spectralDirection: number;
	/** Smoothed normalized spectral centroid, 0..1. */
	centroid: number;
	/** Signed centroid speed, normalized to -1..1. */
	centroidVelocity: number;
	/** Waveform peak / RMS ratio. Zero while effectively silent. */
	crestRatio: number;
	/** Compressed perceptual crest factor, 0..1. */
	crestFactor: number;
	/** Corrected composites made from real musical frequency ranges. */
	bass: number;
	mid: number;
	treble: number;
};

type SignalBandRange = { low: number; high: number };

const BAND_RANGES: readonly SignalBandRange[] = [
	{ low: 20, high: 60 },
	{ low: 60, high: 150 },
	{ low: 150, high: 400 },
	{ low: 400, high: 2_000 },
	{ low: 2_000, high: 6_000 },
	{ low: 6_000, high: Number.POSITIVE_INFINITY }
];

// Each envelope is deliberately tuned to the musical role of its band. Kick
// and air react quickly; sub/body retain enough release to read as mass.
const FAST_ATTACK = [0.045, 0.012, 0.026, 0.034, 0.02, 0.012];
const FAST_RELEASE = [0.34, 0.14, 0.25, 0.28, 0.17, 0.11];
const SLOW_ATTACK = [0.95, 0.62, 0.78, 0.88, 0.68, 0.52];
const SLOW_RELEASE = [3.0, 2.0, 2.5, 2.8, 2.0, 1.6];
const CEILING_ATTACK = [0.28, 0.16, 0.22, 0.25, 0.18, 0.14];
const CEILING_RELEASE = [16, 12, 14, 14, 11, 9];
const MIN_CEILING = [0.008, 0.009, 0.008, 0.007, 0.006, 0.005];
const SPECTRAL_DIRECTION_WEIGHTS = [-1, -0.68, -0.28, 0.2, 0.62, 1];
// Mildly compensate the natural spectral roll-off without allowing a tiny,
// steady air/noise floor to normalize to the same strength as a kick.
const RELATIVE_BAND_GAIN = [0.9, 1, 0.96, 0.94, 1.08, 1.28];

function makeBandVector(): SignalBandVector {
	return { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 };
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 1e-9));
	return t * t * (3 - 2 * t);
}

function safeDt(dtSeconds: number): number {
	if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 1 / 60;
	// Large background-tab gaps should settle the envelopes once, not produce
	// derivative spikes or replay seconds of obsolete intermediate motion.
	return clamp(dtSeconds, 1 / 1_000, 0.25);
}

function alphaForTau(dtSeconds: number, tauSeconds: number): number {
	return tauSeconds <= 0 ? 1 : 1 - Math.exp(-dtSeconds / tauSeconds);
}

function approach(current: number, target: number, tauSeconds: number, dtSeconds: number): number {
	return current + (target - current) * alphaForTau(dtSeconds, tauSeconds);
}

function asymmetricApproach(
	current: number,
	target: number,
	attackSeconds: number,
	releaseSeconds: number,
	dtSeconds: number
): number {
	return approach(current, target, target > current ? attackSeconds : releaseSeconds, dtSeconds);
}

function writeBandVector(target: SignalBandVector, source: ArrayLike<number>): void {
	target.sub = source[0] ?? 0;
	target.kick = source[1] ?? 0;
	target.body = source[2] ?? 0;
	target.mids = source[3] ?? 0;
	target.presence = source[4] ?? 0;
	target.air = source[5] ?? 0;
}

/**
 * Undo the analyzer's `log10(magnitude) * 0.4 + 1` display transform. This is
 * essential before measuring motion: taking sqrt in display space compresses
 * musical contrast twice. A published zero remains true silence/floor.
 */
export function decodeSignalAnalyzerBin(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const clamped = clamp01(value);
	return clamp01(Math.pow(10, (clamped - 1) / 0.4));
}

/** Return the real-frequency edges represented by one logarithmic bin. */
export function signalAnalyzerBinRange(
	index: number,
	sampleRate: number,
	binCount = SIGNAL_SPECTRUM_BIN_COUNT
): readonly [number, number] {
	const count = Math.max(1, Math.floor(binCount));
	const nyquist = Math.max(20.001, (Number.isFinite(sampleRate) ? sampleRate : 44_100) / 2);
	const i = clamp(Math.floor(index), 0, count - 1);
	const ratio = nyquist / 20;
	return [20 * Math.pow(ratio, i / count), 20 * Math.pow(ratio, (i + 1) / count)];
}

/**
 * Fill a band-major weight matrix (`band * binCount + bin`). Overlap is
 * measured in log-frequency space, matching the analyzer's bin layout. Every
 * populated band is normalized to unit weight, making its output an average
 * rather than a bandwidth-dependent sum.
 */
export function fillSignalBandWeights(
	out: Float32Array,
	sampleRate: number,
	binCount = SIGNAL_SPECTRUM_BIN_COUNT
): Float32Array {
	const count = Math.max(1, Math.floor(binCount));
	if (out.length < SIGNAL_BAND_COUNT * count) {
		throw new RangeError(`Signal band weight buffer needs ${SIGNAL_BAND_COUNT * count} entries.`);
	}
	out.fill(0);

	const nyquist = Math.max(20.001, (Number.isFinite(sampleRate) ? sampleRate : 44_100) / 2);
	const ratio = nyquist / 20;
	for (let band = 0; band < SIGNAL_BAND_COUNT; band += 1) {
		const range = BAND_RANGES[band];
		const bandLow = Math.max(20, Math.min(nyquist, range.low));
		const bandHigh = Math.max(bandLow, Math.min(nyquist, range.high));
		if (bandHigh <= bandLow) continue;

		let total = 0;
		const offset = band * count;
		for (let bin = 0; bin < count; bin += 1) {
			const binLow = 20 * Math.pow(ratio, bin / count);
			const binHigh = 20 * Math.pow(ratio, (bin + 1) / count);
			const overlapLow = Math.max(binLow, bandLow);
			const overlapHigh = Math.min(binHigh, bandHigh);
			if (overlapHigh <= overlapLow) continue;

			const binLogWidth = Math.log(binHigh / binLow);
			const overlap = Math.log(overlapHigh / overlapLow) / Math.max(binLogWidth, 1e-9);
			out[offset + bin] = overlap;
			total += overlap;
		}
		if (total > 0) {
			for (let bin = 0; bin < count; bin += 1) out[offset + bin] /= total;
		}
	}
	return out;
}

export function buildSignalBandWeights(
	sampleRate: number,
	binCount = SIGNAL_SPECTRUM_BIN_COUNT
): Float32Array {
	return fillSignalBandWeights(
		new Float32Array(SIGNAL_BAND_COUNT * Math.max(1, Math.floor(binCount))),
		sampleRate,
		binCount
	);
}

/**
 * Pure six-band reduction helper. Supplying `weights` and `out` makes it
 * allocation-free; omitting them is convenient for focused unit tests.
 */
export function deriveSignalBandEnergies(
	bins: ArrayLike<number>,
	sampleRate: number,
	out = new Float32Array(SIGNAL_BAND_COUNT),
	weights = buildSignalBandWeights(sampleRate, SIGNAL_SPECTRUM_BIN_COUNT)
): Float32Array {
	if (out.length < SIGNAL_BAND_COUNT) {
		throw new RangeError(`Signal band output needs ${SIGNAL_BAND_COUNT} entries.`);
	}
	if (weights.length < SIGNAL_BAND_COUNT * SIGNAL_SPECTRUM_BIN_COUNT) {
		throw new RangeError('Signal band weight matrix is incomplete.');
	}
	out.fill(0);
	const limit = Math.min(SIGNAL_SPECTRUM_BIN_COUNT, bins.length);
	for (let bin = 0; bin < limit; bin += 1) {
		const magnitude = decodeSignalAnalyzerBin(bins[bin] ?? 0);
		if (magnitude <= 0) continue;
		for (let band = 0; band < SIGNAL_BAND_COUNT; band += 1) {
			out[band] += magnitude * weights[band * SIGNAL_SPECTRUM_BIN_COUNT + bin];
		}
	}
	return out;
}

function decodeSignalBins(bins: ArrayLike<number>, out: Float32Array): number {
	const limit = Math.min(SIGNAL_SPECTRUM_BIN_COUNT, bins.length);
	let peak = 0;
	for (let bin = 0; bin < limit; bin += 1) {
		const decoded = decodeSignalAnalyzerBin(bins[bin] ?? 0);
		out[bin] = decoded;
		peak = Math.max(peak, decoded);
	}
	for (let bin = limit; bin < SIGNAL_SPECTRUM_BIN_COUNT; bin += 1) out[bin] = 0;
	return peak;
}

function reduceDecodedSignalBands(
	decodedBins: Float32Array,
	weights: Float32Array,
	out: Float32Array
): void {
	out.fill(0);
	for (let bin = 0; bin < SIGNAL_SPECTRUM_BIN_COUNT; bin += 1) {
		const magnitude = decodedBins[bin];
		if (magnitude <= 0) continue;
		for (let band = 0; band < SIGNAL_BAND_COUNT; band += 1) {
			out[band] += magnitude * weights[band * SIGNAL_SPECTRUM_BIN_COUNT + bin];
		}
	}
}

/**
 * Stateful, steady-state allocation-free spectral profiler for Signal. It
 * supplies both instantaneous detail and slow musical context without binding
 * either one to a particular render frame rate.
 */
export class SignalSpectrumTracker {
	private sampleRate = 44_100;
	private readonly weights = new Float32Array(SIGNAL_BAND_COUNT * SIGNAL_SPECTRUM_BIN_COUNT);
	private readonly raw = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly fast = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly slow = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly ceiling = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly levels = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly deltas = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly previousLevels = new Float32Array(SIGNAL_BAND_COUNT);
	private readonly decodedBins = new Float32Array(SIGNAL_SPECTRUM_BIN_COUNT);
	private readonly detailFast = new Float32Array(SIGNAL_SPECTRUM_BIN_COUNT);
	private readonly detailSlow = new Float32Array(SIGNAL_SPECTRUM_BIN_COUNT);
	private readonly detailBins = new Float32Array(SIGNAL_SPECTRUM_BIN_COUNT);
	private globalCeiling = 0.008;
	private detailCeiling = 0.008;
	private centroid = 0.42;
	private previousCentroid = 0.42;
	private centroidVelocity = 0;
	private novelty = 0;
	private spectralMotion = 0;
	private spectralDirection = 0;
	private crestFactor = 0;
	private primed = false;

	private readonly profile: SignalSpectrumProfile = {
		sampleRate: this.sampleRate,
		raw: makeBandVector(),
		fast: makeBandVector(),
		slow: makeBandVector(),
		levels: makeBandVector(),
		deltas: makeBandVector(),
		detailBins: this.detailBins,
		novelty: 0,
		spectralMotion: 0,
		spectralDirection: 0,
		centroid: this.centroid,
		centroidVelocity: 0,
		crestRatio: 0,
		crestFactor: 0,
		bass: 0,
		mid: 0,
		treble: 0
	};

	constructor(sampleRate = 44_100) {
		this.reset(sampleRate);
	}

	reset(sampleRate = this.sampleRate): void {
		this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 40 ? sampleRate : 44_100;
		fillSignalBandWeights(this.weights, this.sampleRate);
		this.raw.fill(0);
		this.fast.fill(0);
		this.slow.fill(0);
		this.levels.fill(0);
		this.deltas.fill(0);
		this.previousLevels.fill(0);
		this.decodedBins.fill(0);
		this.detailFast.fill(0);
		this.detailSlow.fill(0);
		this.detailBins.fill(0);
		this.globalCeiling = 0.008;
		this.detailCeiling = 0.008;
		for (let i = 0; i < SIGNAL_BAND_COUNT; i += 1) this.ceiling[i] = MIN_CEILING[i];
		this.centroid = 0.42;
		this.previousCentroid = 0.42;
		this.centroidVelocity = 0;
		this.novelty = 0;
		this.spectralMotion = 0;
		this.spectralDirection = 0;
		this.crestFactor = 0;
		this.primed = false;
		this.syncProfile(0);
	}

	update(features: SignalSpectrumInput | null | undefined, dtSeconds: number): Readonly<SignalSpectrumProfile> {
		const dt = safeDt(dtSeconds);
		const nextSampleRate = features?.sample_rate ?? this.sampleRate;
		if (Number.isFinite(nextSampleRate) && nextSampleRate > 40 && nextSampleRate !== this.sampleRate) {
			this.sampleRate = nextSampleRate;
			fillSignalBandWeights(this.weights, this.sampleRate);
		}

		const decodedPeak = decodeSignalBins(features?.bins ?? EMPTY_BINS, this.decodedBins);
		reduceDecodedSignalBands(this.decodedBins, this.weights, this.raw);
		let motionInstant = 0;
		let noveltyInstant = 0;
		let directionInstant = 0;
		let globalMagnitude = 0;
		for (let band = 0; band < SIGNAL_BAND_COUNT; band += 1) {
			const raw = this.raw[band];
			this.fast[band] = asymmetricApproach(
				this.fast[band],
				raw,
				FAST_ATTACK[band],
				FAST_RELEASE[band],
				dt
			);
			this.slow[band] = asymmetricApproach(
				this.slow[band],
				raw,
				SLOW_ATTACK[band],
				SLOW_RELEASE[band],
				dt
			);

			const ceilingTarget = Math.max(this.fast[band], this.slow[band] * 1.18, MIN_CEILING[band]);
			this.ceiling[band] = asymmetricApproach(
				this.ceiling[band],
				ceilingTarget,
				CEILING_ATTACK[band],
				CEILING_RELEASE[band],
				dt
			);
			globalMagnitude = Math.max(globalMagnitude, this.fast[band] * RELATIVE_BAND_GAIN[band]);
		}

		this.globalCeiling = asymmetricApproach(
			this.globalCeiling,
			Math.max(globalMagnitude, 0.004),
			0.2,
			12,
			dt
		);
		const rms = clamp01(features?.rms ?? 0);
		const activityGate = smoothstep(0.0025, 0.025, rms);
		// The current maximum preserves within-frame spectral balance. A fraction
		// of the slow global ceiling prevents a lone residual/noise band from
		// becoming the new reference immediately after a loud passage.
		const globalReference = Math.max(globalMagnitude, this.globalCeiling * 0.35, 0.004);

		for (let band = 0; band < SIGNAL_BAND_COUNT; band += 1) {
			const scale = Math.max(this.ceiling[band], MIN_CEILING[band]);
			const adaptiveLevel = clamp01(this.fast[band] / scale);
			const relativeLevel = clamp01(
				(this.fast[band] * RELATIVE_BAND_GAIN[band]) / globalReference
			);
			const relativeGate = smoothstep(0.025, 0.16, relativeLevel);
			const relativeShape = 0.18 + Math.sqrt(relativeLevel) * 0.82;
			const level = clamp01(adaptiveLevel * relativeGate * relativeShape * activityGate);
			this.levels[band] = level;
			this.deltas[band] = clamp(
				((this.fast[band] - this.slow[band]) / scale) * relativeGate * activityGate,
				-1,
				1
			);

			if (this.primed) {
				const velocity = (level - this.previousLevels[band]) / dt;
				const compressedVelocity = velocity / (Math.abs(velocity) + 5);
				motionInstant += Math.abs(compressedVelocity) / SIGNAL_BAND_COUNT;
				noveltyInstant += Math.max(0, compressedVelocity) / SIGNAL_BAND_COUNT;
				directionInstant +=
					compressedVelocity * SPECTRAL_DIRECTION_WEIGHTS[band] / SIGNAL_BAND_COUNT;
			}
			this.previousLevels[band] = level;
		}

		// Preserve local spectral motion without sending the analyzer's compressed
		// display bins back to the GPU. Per-bin residuals can be much larger than a
		// normalized six-band average, so they use a dedicated peak ceiling. The
		// current peak protects broadband onsets from hard clipping; the slower
		// release retains magnitude context for receding partials.
		this.detailCeiling = asymmetricApproach(
			this.detailCeiling,
			Math.max(decodedPeak, 0.004),
			0.04,
			2.4,
			dt
		);
		const detailScale = Math.max(decodedPeak, this.detailCeiling * 0.85, 0.004);
		for (let bin = 0; bin < SIGNAL_SPECTRUM_BIN_COUNT; bin += 1) {
			const decoded = this.decodedBins[bin];
			this.detailFast[bin] = asymmetricApproach(
				this.detailFast[bin],
				decoded,
				0.016,
				0.13,
				dt
			);
			this.detailSlow[bin] = asymmetricApproach(
				this.detailSlow[bin],
				decoded,
				0.48,
				1.35,
				dt
			);
			this.detailBins[bin] = clamp(
				((this.detailFast[bin] - this.detailSlow[bin]) / detailScale) * activityGate,
				-1,
				1
			);
		}

		const centroidTarget = clamp01(features?.centroid ?? 0.42);
		this.centroid = approach(this.centroid, centroidTarget, 0.075, dt);
		const centroidSpeed = this.primed ? (this.centroid - this.previousCentroid) / dt : 0;
		const centroidVelocityTarget = clamp(centroidSpeed / 0.35, -1, 1);
		this.centroidVelocity = approach(this.centroidVelocity, centroidVelocityTarget, 0.11, dt);
		this.previousCentroid = this.centroid;

		this.novelty = asymmetricApproach(this.novelty, clamp01(noveltyInstant * 2.8), 0.02, 0.24, dt);
		this.spectralMotion = asymmetricApproach(
			this.spectralMotion,
			clamp01(motionInstant * 2.2),
			0.035,
			0.3,
			dt
		);
		this.spectralDirection = approach(
			this.spectralDirection,
			clamp(directionInstant * 3.2, -1, 1),
			0.12,
			dt
		);

		const peak = clamp01(features?.peak ?? 0);
		const crestRatio = rms > 0.002 ? clamp(peak / Math.max(rms, 1e-4), 0, 12) : 0;
		const crestTarget = crestRatio > 0 ? clamp01((crestRatio - 1) / 4) : 0;
		this.crestFactor = asymmetricApproach(this.crestFactor, crestTarget, 0.018, 0.28, dt);
		this.primed = this.primed || features != null;
		this.syncProfile(crestRatio);
		return this.profile;
	}

	private syncProfile(crestRatio: number): void {
		writeBandVector(this.profile.raw, this.raw);
		writeBandVector(this.profile.fast, this.fast);
		writeBandVector(this.profile.slow, this.slow);
		writeBandVector(this.profile.levels, this.levels);
		writeBandVector(this.profile.deltas, this.deltas);
		this.profile.sampleRate = this.sampleRate;
		this.profile.novelty = this.novelty;
		this.profile.spectralMotion = this.spectralMotion;
		this.profile.spectralDirection = this.spectralDirection;
		this.profile.centroid = this.centroid;
		this.profile.centroidVelocity = this.centroidVelocity;
		this.profile.crestRatio = crestRatio;
		this.profile.crestFactor = this.crestFactor;
		this.profile.bass = clamp01(
			this.levels[0] * 0.32 + this.levels[1] * 0.48 + this.levels[2] * 0.2
		);
		this.profile.mid = clamp01(
			this.levels[2] * 0.2 + this.levels[3] * 0.58 + this.levels[4] * 0.22
		);
		this.profile.treble = clamp01(this.levels[4] * 0.58 + this.levels[5] * 0.42);
	}
}

const EMPTY_BINS: readonly number[] = [];
