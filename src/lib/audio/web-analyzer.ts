// Browser-side audio analyzer — mirrors src-tauri/src/audio/analyzer.rs so the
// visualizer-test lab page can drive the visualizer with the same feature
// payload the Rust analyzer emits in production. Use cases:
//  • iterate on shader code via `pnpm dev` (Vite HMR) instead of Tauri rebuild
//  • drop any audio file in the lab page to test how the visualizer reacts
//
// Outputs an AudioFeatures object compatible with the visualizer store.

import type { AudioFeatures } from '$lib/state/visualizer.svelte';

const BIN_COUNT = 64;
const FFT_SIZE = 2048;
const EMIT_HZ = 60;
const FLUX_HIST_LEN = 256;

export class WebAnalyzer {
	private ctx: AudioContext;
	private analyser: AnalyserNode;
	private freqBytes: Uint8Array;
	private fluxHist: number[] = [];
	private beatPeriodFrames = 0;
	private beatPhase = 0;
	private bpmCheckCounter = 0;
	private prevEnergy = 0;
	private lastEmit = performance.now();
	private emitIntervalMs: number;

	constructor(ctx: AudioContext, sourceNode: AudioNode) {
		this.ctx = ctx;
		this.analyser = ctx.createAnalyser();
		this.analyser.fftSize = FFT_SIZE;
		this.analyser.smoothingTimeConstant = 0;
		sourceNode.connect(this.analyser);
		this.freqBytes = new Uint8Array(this.analyser.frequencyBinCount);
		this.emitIntervalMs = 1000 / EMIT_HZ;
	}

	/** Compute features for the current audio frame. Returns null if not yet
	 *  ready (warming up the flux history). */
	tick(): AudioFeatures | null {
		const now = performance.now();
		if (now - this.lastEmit < this.emitIntervalMs) return null;
		this.lastEmit = now;

		// TS strict-mode wants Uint8Array<ArrayBuffer> exactly; our buffer is fine.
		this.analyser.getByteFrequencyData(this.freqBytes as Uint8Array<ArrayBuffer>);

		// Bytes are dB-normalized (0=-100dB, 255=-30dB by default). Convert to
		// 0..1 linear-ish so downstream math matches Rust's magnitudes/peak
		// scaling closely enough that smoothing and thresholds carry over.
		const mags = new Float32Array(this.freqBytes.length);
		for (let i = 0; i < this.freqBytes.length; i++) {
			mags[i] = this.freqBytes[i] / 255;
		}

		const sampleRate = this.ctx.sampleRate;
		const nyquist = sampleRate / 2;

		// RMS / peak
		let sumSq = 0;
		let peak = 0;
		for (let i = 0; i < mags.length; i++) {
			const m = mags[i];
			sumSq += m * m;
			if (m > peak) peak = m;
		}
		const rms = Math.min(1, Math.sqrt(sumSq / mags.length));

		// Log-spaced bins, 20Hz → Nyquist (matches Rust analyzer)
		const bins: number[] = new Array(BIN_COUNT);
		for (let b = 0; b < BIN_COUNT; b++) {
			const fLo = 20 * Math.pow(nyquist / 20, b / BIN_COUNT);
			const fHi = 20 * Math.pow(nyquist / 20, (b + 1) / BIN_COUNT);
			const iLoF = (fLo / nyquist) * (mags.length - 1);
			const iHiF = (fHi / nyquist) * (mags.length - 1);
			const iLo = Math.floor(iLoF);
			const iHi = Math.max(iLo + 1, Math.min(Math.floor(iHiF), mags.length));
			let m = 0;
			for (let i = iLo; i < iHi; i++) if (mags[i] > m) m = mags[i];
			bins[b] = Math.max(0, Math.min(1, Math.log10(Math.max(m, 1e-7)) * 0.4 + 1));
		}

		// Centroid (normalized to Nyquist)
		let num = 0;
		let den = 0;
		for (let i = 0; i < mags.length; i++) {
			const f = (i / mags.length) * nyquist;
			num += f * mags[i];
			den += mags[i];
		}
		const centroid = Math.max(0, Math.min(1, den > 0 ? num / den / nyquist : 0));

		// Bands (matches Rust analyzer's bass=1/8, mid=middle 3/8, treble=last 1/2)
		const bassN = Math.floor(BIN_COUNT / 8);
		const midN = Math.floor(BIN_COUNT / 2) - bassN;
		const trebleN = BIN_COUNT - bassN - midN;
		let bassSum = 0;
		let midSum = 0;
		let trebSum = 0;
		for (let i = 0; i < bassN; i++) bassSum += bins[i];
		for (let i = bassN; i < bassN + midN; i++) midSum += bins[i];
		for (let i = bassN + midN; i < BIN_COUNT; i++) trebSum += bins[i];
		const bass = Math.max(0, Math.min(1, bassSum / Math.max(1, bassN)));
		const mid = Math.max(0, Math.min(1, midSum / Math.max(1, midN)));
		const treble = Math.max(0, Math.min(1, trebSum / Math.max(1, trebleN)));

		// Spectral flux + onset
		let totalEnergy = 0;
		for (let i = 0; i < mags.length; i++) totalEnergy += mags[i];
		const flux = Math.max(0, totalEnergy - this.prevEnergy);
		const onset = flux > this.prevEnergy * 0.3 && this.prevEnergy > 0.01;
		this.prevEnergy = totalEnergy * 0.7 + this.prevEnergy * 0.3;

		// BPM tracking — autocorrelation on flux history
		this.fluxHist.push(flux);
		if (this.fluxHist.length > FLUX_HIST_LEN) this.fluxHist.shift();
		if (this.beatPeriodFrames > 0) {
			this.beatPhase += 1 / this.beatPeriodFrames;
			if (this.beatPhase >= 1) this.beatPhase -= Math.floor(this.beatPhase);
			if (onset && (this.beatPhase < 0.18 || this.beatPhase > 0.82)) {
				this.beatPhase = 0;
			}
		}
		this.bpmCheckCounter += 1;
		if (this.fluxHist.length >= 128 && this.bpmCheckCounter >= 30) {
			this.bpmCheckCounter = 0;
			const newPeriod = estimateBeatPeriod(this.fluxHist, EMIT_HZ);
			if (newPeriod > 0) {
				this.beatPeriodFrames =
					this.beatPeriodFrames > 0
						? this.beatPeriodFrames * 0.7 + newPeriod * 0.3
						: newPeriod;
			}
		}
		const bpm = this.beatPeriodFrames > 0 ? (EMIT_HZ * 60) / this.beatPeriodFrames : 0;

		// Chroma (12 pitch classes)
		const chroma = new Array(12).fill(0) as number[];
		for (let i = 0; i < mags.length; i++) {
			const f = (i / mags.length) * nyquist;
			if (f < 80 || f > 5000 || mags[i] <= 0) continue;
			const semitone = Math.round(12 * Math.log2(f / 440)) + 9 + 1200;
			chroma[semitone % 12] += mags[i];
		}
		const chromaTotal = chroma.reduce((a, b) => a + b, 0);
		let chromaKey = 0;
		let chromaStrength = 0;
		if (chromaTotal > 1e-6) {
			let maxIdx = 0;
			let maxVal = 0;
			for (let i = 0; i < 12; i++) {
				chroma[i] /= chromaTotal;
				if (chroma[i] > maxVal) {
					maxVal = chroma[i];
					maxIdx = i;
				}
			}
			chromaKey = maxIdx / 12;
			chromaStrength = Math.max(0, Math.min(1, (maxVal - 1 / 12) * 6));
		}

		return {
			bins,
			rms,
			peak: Math.min(1, peak),
			centroid,
			onset,
			bass,
			mid,
			treble,
			sample_rate: sampleRate,
			bpm,
			beat_phase: this.beatPhase,
			chroma_key: chromaKey,
			chroma_strength: chromaStrength
		};
	}
}

function estimateBeatPeriod(flux: number[], emitHz: number): number {
	if (flux.length < 64) return 0;
	const minLag = Math.max(2, Math.floor((60 * emitHz) / 180));
	const maxLag = Math.min(flux.length - 1, Math.ceil((60 * emitHz) / 60));
	let bestLag = 0;
	let bestScore = 0;
	let scoreSum = 0;
	let scoreCount = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		const n = flux.length - lag;
		let s = 0;
		for (let i = 0; i < n; i++) s += flux[i] * flux[i + lag];
		s /= n;
		scoreSum += s;
		scoreCount += 1;
		if (s > bestScore) {
			bestScore = s;
			bestLag = lag;
		}
	}
	const mean = scoreSum / Math.max(1, scoreCount);
	if (bestLag === 0 || bestScore < mean * 1.4 || bestScore < 1e-8) return 0;
	return bestLag;
}
