// Raw ensemble features: the per-frame measurements the EnsembleTracker
// (src/lib/visualizer/ensemble.ts) hears the band with. This file is the
// browser twin of `EnsembleExtractor` in src-tauri/src/audio/analyzer.rs; the
// constants and the order of operations are kept the same so the lab's file
// and URL playback (WebAnalyzer) and the native event agree.
//
// Per frame (~60 Hz) it takes two magnitude spectra of the mono downmix:
//   • the short 2048-point FFT the rest of the analyzer already computes, for
//     per-layer onsets (kick, snare/clap, hats, other percussion, tonal notes);
//   • a long 8192-point FFT (~186 ms at 44.1 kHz) for pitch: a 12-bin chroma
//     over 100 Hz–5 kHz and a bass-register chroma over 40–250 Hz, from
//     interpolated spectral peaks so a note lands in its own pitch class even
//     where the bins are wider than a semitone;
// plus the stereo sums of the samples heard since the previous frame.
//
// Onsets: each band's spectral flux (half-wave-rectified rise of the
// log-compressed spectrum against a 3-bin max of the previous frame) is
// normalised by a peak follower with an absolute floor, the bands are combined
// into one detection function per layer, and a layer fires on a local peak of
// its function over an adaptive threshold (mean + K * deviation), one frame
// late. The tonal function is the "peaky" part of the rise over semitone bands:
// new notes raise a few semitones, a noise burst raises all of them alike.
//
// Magnitudes are linear |X|/N (the native analyzer's scale; Web Audio's dB
// data converted back with 10^(dB/20) is the same scale).

export const ENSEMBLE_LONG_FFT = 8192;

export type EnsembleRawFeatures = {
	/** 12 pitch classes from C, max-normalised 0..1; all zero when silent. */
	chroma: number[];
	/** The same over the bass register (40–250 Hz). */
	bass_chroma: number[];
	/** Onset strengths heard in this frame, 0..1 (0 = no onset). */
	onset_kick: number;
	onset_snare: number;
	onset_hat: number;
	onset_perc: number;
	onset_tonal: number;
	/** Side / (mid + side) RMS of the frame's stereo samples, 0..1. 0 = mono. */
	stereo_width: number;
	/** Left/right correlation, -1..1. 1 = mono, 0 = unrelated, -1 = out of phase. */
	stereo_corr: number;
};

/** Running stereo sums over the samples since the previous frame. */
export type StereoSums = { ll: number; rr: number; lr: number; count: number };

// ---- Constants mirrored in analyzer.rs ----------------------------------

/** ln(1 + GAMMA * |X|): near-logarithmic for anything audible. */
const GAMMA = 1e4;
/** Short-FFT bands, Hz: low, body, mid, noise, high. */
const BANDS_HZ: readonly (readonly [number, number])[] = [
	[40, 120],
	[150, 500],
	[500, 2_000],
	[2_000, 6_000],
	[7_000, 16_000]
];
/** Half-width of the local spectral mean (the noise-like envelope), bins. */
const LOCAL_RADIUS = 6;
/** Semitone bands for the tonal detector, MIDI notes (D3 .. B7). */
const TONAL_LOW_NOTE = 50;
const TONAL_HIGH_NOTE = 107;
/** A semitone's rise counts as tonal above this multiple of the mean rise. */
const TONAL_EXCESS = 1.5;
/** Band-flux peak followers release over this many seconds. */
const SCALE_RELEASE_S = 3;
/**
 * Absolute floors of the flux scales, in mean nats of rise per bin: low,
 * body, mid, noise, high, tonal, body envelope, mid envelope. Flux under
 * its floor can never normalise above 1, so quiet fluctuations stay small.
 */
const SCALE_FLOOR = [1.2, 0.6, 0.5, 0.5, 0.5, 0.25, 0.5, 0.4];
/**
 * Level gates: a band only counts when its loudest bin is within this many dB
 * of the frame's loudest bin (fully open at the second value). Log
 * compression would otherwise lift window side lobes and the splatter of a
 * note's attack out of near-silence into false drum hits. Low, body, mid,
 * noise, high.
 */
const GATE_DB: readonly (readonly [number, number])[] = [
	[-42, -30],
	[-48, -36],
	[-50, -38],
	[-54, -42],
	[-60, -46]
];
/**
 * A candidate hit whose band level falls by more than this on the very next
 * frame (mean nats per bin) was attack splatter or another instrument's
 * transient, not this layer (fully rejected at the second value). Kick (low
 * band), snare (noise band: a snare's burst keeps building while a beater
 * click is already gone), perc (body/mid).
 */
const PERSIST_KICK: readonly [number, number] = [0.25, 0.75];
const PERSIST_SNARE: readonly [number, number] = [0.05, 0.45];
const PERSIST_PERC: readonly [number, number] = [0.25, 0.75];
/** Onset detectors: kick, snare, hat, perc, tonal. */
const DETECTOR_COUNT = 5;
const ABS_THRESHOLD = [0.3, 0.3, 0.3, 0.4, 0.3];
const REFRACTORY_S = [0.08, 0.07, 0.045, 0.06, 0.09];
/** Adaptive threshold: mean + K * mean absolute deviation. */
const THRESHOLD_K = 1.5;
const THRESHOLD_TAU_S = 1.5;
/** Long-FFT chroma ranges, Hz. */
const CHROMA_HZ: readonly [number, number] = [100, 5_000];
const BASS_HZ: readonly [number, number] = [40, 250];
/** Peaks quieter than this fraction of the range's loudest peak are ignored. */
const PEAK_RELATIVE_FLOOR = 0.03;
/** Absolute peak floor (|X|/N), about -100 dBFS. */
const PEAK_ABSOLUTE_FLOOR = 1e-5;

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

/** Bin range [lo, hi) for a frequency band in an FFT of `fftSize`. */
function binRange(band: readonly [number, number], sampleRate: number, fftSize: number, bins: number): [number, number] {
	const hz = sampleRate / fftSize;
	const nyquistCap = sampleRate * 0.475;
	const lo = Math.max(1, Math.round(band[0] / hz));
	const hi = Math.min(bins - 1, Math.round(Math.min(band[1], nyquistCap) / hz));
	return [lo, Math.max(lo + 1, hi)];
}

/** Stereo width and correlation from running sums. Silence reads as mono. */
export function stereoImage(sums: StereoSums): { width: number; corr: number } {
	const energy = sums.ll + sums.rr;
	if (sums.count === 0 || energy / sums.count < 1e-9) return { width: 0, corr: 1 };
	const mid = Math.max(0, (sums.ll + 2 * sums.lr + sums.rr) / 4);
	const side = Math.max(0, (sums.ll - 2 * sums.lr + sums.rr) / 4);
	const midRms = Math.sqrt(mid);
	const sideRms = Math.sqrt(side);
	const width = midRms + sideRms > 0 ? sideRms / (midRms + sideRms) : 0;
	const denom = Math.sqrt(sums.ll * sums.rr);
	const corr = denom > 0 ? Math.max(-1, Math.min(1, sums.lr / denom)) : 1;
	return { width: clamp01(width), corr };
}

/** Peak-picked, interpolated pitch-class profile of one magnitude range. */
function peakChroma(
	mags: ArrayLike<number>,
	lo: number,
	hi: number,
	binHz: number,
	out: number[]
): void {
	out.fill(0);
	let loudest = 0;
	for (let k = lo; k < hi; k += 1) if (mags[k] > loudest) loudest = mags[k];
	if (loudest < PEAK_ABSOLUTE_FLOOR) return;
	const floor = Math.max(PEAK_ABSOLUTE_FLOOR, loudest * PEAK_RELATIVE_FLOOR);
	for (let k = Math.max(1, lo); k < Math.min(hi, mags.length - 1); k += 1) {
		const m = mags[k];
		if (m < floor || m < mags[k - 1] || m < mags[k + 1]) continue;
		// Quadratic interpolation on log magnitude finds the true peak.
		const a = Math.log(mags[k - 1] + 1e-12);
		const b = Math.log(m + 1e-12);
		const c = Math.log(mags[k + 1] + 1e-12);
		const den = a - 2 * b + c;
		const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
		const frequency = (k + delta) * binHz;
		if (frequency <= 0) continue;
		const pitch = 12 * Math.log2(frequency / 440) + 69;
		const nearest = Math.round(pitch);
		// Out-of-tune energy counts for less, so a partial between two
		// semitones does not light both.
		const weight = 1 - 1.6 * Math.abs(pitch - nearest);
		if (weight <= 0) continue;
		out[((nearest % 12) + 12) % 12] += m * weight;
	}
	let max = 0;
	for (let i = 0; i < 12; i += 1) if (out[i] > max) max = out[i];
	if (max <= 0) return;
	for (let i = 0; i < 12; i += 1) out[i] /= max;
}

/** Mean half-wave-rectified rise against a 3-bin max of the previous frame. */
function bandFlux(current: Float32Array, previous: Float32Array, lo: number, hi: number): number {
	let sum = 0;
	for (let k = lo; k < hi; k += 1) {
		const before = Math.max(previous[k - 1] ?? 0, previous[k], previous[k + 1] ?? 0);
		const rise = current[k] - before;
		if (rise > 0) sum += rise;
	}
	return sum / Math.max(1, hi - lo);
}

type Detector = {
	prev: number;
	prev2: number;
	mean: number;
	dev: number;
	lastFire: number;
};

/**
 * Stateful per-frame extractor. One instance per stream; call `process` once
 * per analyzer frame with the frame's spectra, in order.
 */
export class EnsembleFeatureExtractor {
	private prevLog = new Float32Array(0);
	private prevSmooth = new Float32Array(0);
	private curLog = new Float32Array(0);
	private curSmooth = new Float32Array(0);
	private prefix = new Float64Array(0);
	/** Semitone band [lo, hi) bins of the short FFT, interleaved. */
	private tonalBins = new Int32Array(0);
	private prevTonal = new Float32Array(0);
	private curTonal = new Float32Array(0);
	private primed = false;
	private sampleRate = 0;
	private shortSize = 0;
	private ranges: [number, number][] = [];
	/** Band-flux peak followers: low, body, mid, noise, high, tonal, bodyS, midS. */
	private readonly scales = Float64Array.from(SCALE_FLOOR);
	private readonly flux = new Float64Array(8);
	private readonly norm = new Float64Array(8);
	private readonly gates = new Float64Array(5);
	/** Mean compressed level per band, this frame and the previous one. */
	private bandLevel = new Float64Array(5);
	private bandLevelPrev = new Float64Array(5);
	private prevNoise = 0;
	private prevNoise2 = 0;
	private prevHighRatio = 0;
	private readonly confirm = new Float64Array(DETECTOR_COUNT);
	private prevTonalValue = 0;
	private readonly detection = new Float64Array(DETECTOR_COUNT);
	private readonly detectors: Detector[] = Array.from({ length: DETECTOR_COUNT }, () => ({
		prev: 0,
		prev2: 0,
		mean: 0,
		dev: 0,
		lastFire: -1e9
	}));
	private time = 0;
	private readonly onsets = new Float64Array(DETECTOR_COUNT);
	private readonly chroma = new Array<number>(12).fill(0);
	private readonly bassChroma = new Array<number>(12).fill(0);

	/** Last frame's band fluxes and detector values, for diagnostics. */
	get debug(): { flux: number[]; detection: number[]; scales: number[]; levels: number[]; confirm: number[] } {
		return {
			flux: [...this.flux],
			detection: [...this.detection],
			scales: [...this.scales],
			levels: [...this.bandLevel],
			confirm: [...this.confirm]
		};
	}

	reset(): void {
		this.primed = false;
		this.prevTonalValue = 0;
		this.prevNoise = 0;
		this.prevNoise2 = 0;
		this.prevHighRatio = 0;
		this.bandLevel.fill(0);
		this.bandLevelPrev.fill(0);
		this.scales.set(SCALE_FLOOR);
		for (const d of this.detectors) {
			d.prev = 0;
			d.prev2 = 0;
			d.mean = 0;
			d.dev = 0;
			d.lastFire = -1e9;
		}
		this.time = 0;
	}

	private configure(sampleRate: number, bins: number, fftSize: number): void {
		this.sampleRate = sampleRate;
		this.shortSize = bins;
		this.prevLog = new Float32Array(bins);
		this.prevSmooth = new Float32Array(bins);
		this.curLog = new Float32Array(bins);
		this.curSmooth = new Float32Array(bins);
		this.prefix = new Float64Array(bins + 1);
		this.ranges = BANDS_HZ.map((band) => binRange(band, sampleRate, fftSize, bins));
		const notes = TONAL_HIGH_NOTE - TONAL_LOW_NOTE + 1;
		this.tonalBins = new Int32Array(notes * 2);
		const hz = sampleRate / fftSize;
		for (let j = 0; j < notes; j += 1) {
			const centre = 440 * Math.pow(2, (TONAL_LOW_NOTE + j - 69) / 12);
			const lo = Math.max(1, Math.floor((centre * Math.pow(2, -1 / 24)) / hz + 0.5));
			const hi = Math.min(bins - 1, Math.max(lo + 1, Math.floor((centre * Math.pow(2, 1 / 24)) / hz + 0.5)));
			this.tonalBins[j * 2] = lo;
			this.tonalBins[j * 2 + 1] = hi;
		}
		this.prevTonal = new Float32Array(notes);
		this.curTonal = new Float32Array(notes);
		this.primed = false;
	}

	/**
	 * @param short    linear magnitudes of the 2048-point FFT (N/2 or N/2+1 bins)
	 * @param shortFft the short FFT size
	 * @param long     linear magnitudes of the 8192-point FFT, or null when absent
	 * @param longFft  the long FFT size
	 * @param stereo   sums of the stereo samples since the previous frame
	 * @param dt       seconds since the previous frame
	 */
	process(
		short: ArrayLike<number>,
		shortFft: number,
		long: ArrayLike<number> | null,
		longFft: number,
		sampleRate: number,
		stereo: StereoSums | null,
		dt: number
	): EnsembleRawFeatures {
		const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 1 / 60;
		this.time += step;
		const bins = short.length;
		if (bins !== this.shortSize || sampleRate !== this.sampleRate) this.configure(sampleRate, bins, shortFft);

		// Compressed spectrum and its smooth (noise-like) envelope.
		const prefix = this.prefix;
		prefix[0] = 0;
		for (let k = 0; k < bins; k += 1) prefix[k + 1] = prefix[k] + short[k];
		for (let k = 0; k < bins; k += 1) {
			const lo = Math.max(0, k - LOCAL_RADIUS);
			const hi = Math.min(bins, k + LOCAL_RADIUS + 1);
			this.curLog[k] = Math.log1p(GAMMA * short[k]);
			this.curSmooth[k] = Math.log1p((GAMMA * (prefix[hi] - prefix[lo])) / (hi - lo));
		}
		let loudest = 1e-12;
		for (let k = 1; k < bins; k += 1) if (short[k] > loudest) loudest = short[k];
		const swap = this.bandLevelPrev;
		this.bandLevelPrev = this.bandLevel;
		this.bandLevel = swap;
		for (let b = 0; b < 5; b += 1) {
			let peak = 1e-12;
			let level = 0;
			const [lo, hi] = this.ranges[b];
			for (let k = lo; k < hi; k += 1) {
				if (short[k] > peak) peak = short[k];
				level += this.curLog[k];
			}
			this.bandLevel[b] = level / Math.max(1, hi - lo);
			const db = 20 * Math.log10(peak / loudest);
			this.gates[b] = smoothstep(GATE_DB[b][0], GATE_DB[b][1], db);
		}
		const notes = this.curTonal.length;
		for (let j = 0; j < notes; j += 1) {
			let peak = 0;
			for (let k = this.tonalBins[j * 2]; k < this.tonalBins[j * 2 + 1]; k += 1) {
				if (short[k] > peak) peak = short[k];
			}
			this.curTonal[j] = Math.log1p(GAMMA * peak);
		}

		this.onsets.fill(0);
		if (this.primed) {
			const n = this.flux;
			for (let b = 0; b < 5; b += 1) {
				n[b] = bandFlux(this.curLog, this.prevLog, this.ranges[b][0], this.ranges[b][1]);
			}
			// Tonal: the part of each semitone's rise above the mean rise.
			let meanRise = 0;
			for (let j = 0; j < notes; j += 1) meanRise += Math.max(0, this.curTonal[j] - this.prevTonal[j]);
			meanRise /= Math.max(1, notes);
			let excess = 0;
			for (let j = 0; j < notes; j += 1) {
				const rise = this.curTonal[j] - this.prevTonal[j] - TONAL_EXCESS * meanRise;
				if (rise > 0) excess += rise;
			}
			n[5] = excess / Math.max(1, notes);
			n[6] = bandFlux(this.curSmooth, this.prevSmooth, this.ranges[1][0], this.ranges[1][1]);
			n[7] = bandFlux(this.curSmooth, this.prevSmooth, this.ranges[2][0], this.ranges[2][1]);
			const release = Math.exp(-step / SCALE_RELEASE_S);
			const norm = this.norm;
			const gates = this.gates;
			for (let b = 0; b < 8; b += 1) {
				// Gate before the peak follower so leakage never raises a scale.
				const gate = b < 5 ? gates[b] : b === 6 ? gates[1] : b === 7 ? gates[2] : 1;
				const gated = n[b] * gate;
				this.scales[b] = Math.max(gated, this.scales[b] * release, SCALE_FLOOR[b]);
				norm[b] = gated / this.scales[b];
			}
			const nLow = norm[0];
			const nMid = norm[2];
			const nNoise = norm[3];
			const nHigh = norm[4];
			const nTonal = norm[5];
			const nBodyS = norm[6];
			const nMidS = norm[7];
			const highRatio = n[4] / (n[3] + 0.05);
			const detection = this.detection;
			// Kick: low-band flux. Snare/clap: a noise burst with mid body.
			// Hats: high flux that is not part of a broadband burst. Perc:
			// body/mid transients without noise or kick. Tonal: new notes (a
			// tuned snare body is pitched too, but its noise marks it a drum).
			detection[0] = nLow;
			detection[1] = Math.sqrt(Math.max(nMidS, nMid * 0.8) * nNoise) * (1 - 0.5 * smoothstep(1.2, 2.2, highRatio));
			detection[2] = nHigh * smoothstep(0.8, 1.6, highRatio);
			detection[3] = Math.max(nBodyS, nMidS) * (1 - smoothstep(0.3, 0.8, nNoise)) * (1 - smoothstep(0.5, 1, nLow));
			detection[4] = nTonal;
			// Classify the candidate (the previous frame) with this frame too:
			// the sharp attack of any note splatters broadband for one frame
			// and only then resolves into pitched peaks, while a drum's energy
			// persists in its band. So tonal evidence from either frame
			// discounts snare/perc, and a band that collapses right after its
			// rise was splatter, not a hit. Flat noise in 2-6 kHz is a drum's;
			// peaky content there is the upper partials of a note, which
			// decides whether new semitone peaks belong to a pitched drum or
			// to an instrument.
			const [nLo, nHi] = this.ranges[3];
			let logSum = 0;
			let linSum = 0;
			for (let k = nLo; k < nHi; k += 1) {
				logSum += Math.log(short[k] + 1e-12);
				linSum += short[k];
			}
			const count = Math.max(1, nHi - nLo);
			const noiseFlat = linSum > 1e-9 ? Math.exp(logSum / count) / (linSum / count) : 0;
			let loudestBand = 1e-6;
			for (let b = 0; b < 5; b += 1) loudestBand = Math.max(loudestBand, this.bandLevel[b]);
			// A near-empty band is flat too (window leakage): it must carry a
			// real share of the frame to count as noise.
			const noiseShare = smoothstep(0.18, 0.35, this.bandLevel[3] / loudestBand);
			const noisy = smoothstep(0.15, 0.35, noiseFlat) * noiseShare;
			const tonalRaw = smoothstep(0.35, 0.8, Math.max(this.prevTonalValue, nTonal));
			const tonalLike = tonalRaw * (1 - noisy);
			this.prevTonalValue = nTonal;
			const noiseNear = Math.max(nNoise, this.prevNoise, this.prevNoise2);
			this.prevNoise2 = this.prevNoise;
			this.prevNoise = nNoise;
			const level = this.bandLevel;
			const before = this.bandLevelPrev;
			const confirm = this.confirm;
			// A kick's low rise outweighs its body rise; a note's attack
			// splatters into the low band at a fraction of its body rise.
			confirm[0] =
				(1 - smoothstep(PERSIST_KICK[0], PERSIST_KICK[1], before[0] - level[0])) *
				smoothstep(0.55, 0.9, n[0] / (n[1] + 0.05));
			// A snare's noise is a real share of the frame, not leakage.
			confirm[1] =
				(1 - 0.85 * tonalLike) *
				(1 - smoothstep(PERSIST_SNARE[0], PERSIST_SNARE[1], before[3] - level[3])) *
				noisy;
			confirm[2] = 1;
			confirm[3] =
				(1 - tonalRaw) *
				(1 -
					smoothstep(
						PERSIST_PERC[0],
						PERSIST_PERC[1],
						Math.min(before[1] - level[1], before[2] - level[2])
					));
			// A tuned snare body is pitched too; the noise around it marks a drum.
			confirm[4] = 1 - 0.75 * smoothstep(0.35, 0.8, noiseNear) * noisy;
			const alpha = 1 - Math.exp(-step / THRESHOLD_TAU_S);
			for (let d = 0; d < DETECTOR_COUNT; d += 1) {
				// A snare's bright noise reaches the hat band too: once the
				// snare fires, a hat needs clearly hat-heavy (high) content.
				const snareMask = d === 2 && this.onsets[1] > 0 ? smoothstep(1.5, 2.3, this.prevHighRatio) : 1;
				const det = this.detectors[d];
				const value = detection[d];
				// The previous frame is an onset when it was a local peak over
				// the adaptive threshold (one frame of look-ahead).
				const threshold = Math.max(ABS_THRESHOLD[d], det.mean + THRESHOLD_K * det.dev);
				const strength = det.prev * confirm[d] * snareMask;
				if (
					det.prev > threshold &&
					strength > ABS_THRESHOLD[d] &&
					det.prev > det.prev2 &&
					det.prev >= value &&
					this.time - det.lastFire >= REFRACTORY_S[d]
				) {
					this.onsets[d] = clamp01(strength);
					det.lastFire = this.time;
				}
				det.mean += (value - det.mean) * alpha;
				det.dev += (Math.abs(value - det.mean) - det.dev) * alpha;
				det.prev2 = det.prev;
				det.prev = value;
			}
			this.prevHighRatio = highRatio;
		}
		this.prevLog.set(this.curLog);
		this.prevSmooth.set(this.curSmooth);
		this.prevTonal.set(this.curTonal);
		this.primed = true;

		if (long && long.length > 8) {
			const hz = sampleRate / longFft;
			const [cLo, cHi] = binRange(CHROMA_HZ, sampleRate, longFft, long.length);
			const [bLo, bHi] = binRange(BASS_HZ, sampleRate, longFft, long.length);
			peakChroma(long, cLo, cHi, hz, this.chroma);
			peakChroma(long, bLo, bHi, hz, this.bassChroma);
		} else {
			this.chroma.fill(0);
			this.bassChroma.fill(0);
		}
		const image = stereo ? stereoImage(stereo) : { width: 0, corr: 1 };
		return {
			chroma: this.chroma.slice(),
			bass_chroma: this.bassChroma.slice(),
			onset_kick: this.onsets[0],
			onset_snare: this.onsets[1],
			onset_hat: this.onsets[2],
			onset_perc: this.onsets[3],
			onset_tonal: this.onsets[4],
			stereo_width: image.width,
			stereo_corr: image.corr
		};
	}
}
