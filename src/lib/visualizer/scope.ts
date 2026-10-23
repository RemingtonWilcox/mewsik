// The stereo scope stream: the left/right pairs the audio tap heard, kept in
// one reusable ring for renderers that draw the real signal (Signal's XY
// beam and its channel traces). It is renderer-only: the shared journey never
// sees these samples, so every engine's look stays deterministic in the
// features alone.
//
// Producers:
//   native   each audio:features event carries the pairs since the previous
//            one as base64 little-endian i16 (see src-tauri analyzer.rs)
//   browser  the lab's WebAnalyzer and synthetic profiles push float pairs
//
// Consumers read it with a ScopeReader, which plays the stream back at the
// stream's own rate a little behind the newest pair, so the beam moves
// steadily even though events arrive in uneven bursts.

/** Ring length in pairs: about a third of a second at 48 kHz. */
export const SCOPE_RING_PAIRS = 16384;

export class ScopeStream {
	/** Interleaved L, R floats in -1..1, indexed by pair number modulo the ring. */
	readonly ring = new Float32Array(SCOPE_RING_PAIRS * 2);
	/** Pairs written since the stream began (monotonic). */
	written = 0;
	/** Pair rate of the samples in the ring, Hz. */
	rate = 48_000;
	/** Bumps on a restart (rate change, clear) so readers resync. */
	generation = 0;
	/** Clock time of the newest push that carried samples. */
	lastAt = Number.NEGATIVE_INFINITY;
	private decodeScratch = new Int16Array(2048);

	clear(): void {
		this.written = 0;
		this.generation += 1;
		this.lastAt = Number.NEGATIVE_INFINITY;
	}

	private begin(rate: number) {
		const safe = Number.isFinite(rate) && rate >= 1000 ? rate : this.rate;
		if (safe !== this.rate) {
			this.rate = safe;
			this.written = 0;
			this.generation += 1;
		}
	}

	/** Push interleaved float pairs (count pairs from `pcm`). */
	pushPairs(pcm: ArrayLike<number>, count: number, rate: number, now: number): void {
		const pairs = Math.max(0, Math.min(Math.floor(count), Math.floor(pcm.length / 2)));
		if (pairs === 0) return;
		this.begin(rate);
		const ring = this.ring;
		let slot = this.written % SCOPE_RING_PAIRS;
		for (let index = 0; index < pairs; index += 1) {
			const left = pcm[index * 2];
			const right = pcm[index * 2 + 1];
			ring[slot * 2] = Number.isFinite(left) ? left : 0;
			ring[slot * 2 + 1] = Number.isFinite(right) ? right : 0;
			slot = slot + 1 === SCOPE_RING_PAIRS ? 0 : slot + 1;
		}
		this.written += pairs;
		this.lastAt = now;
	}

	/** Push the native event payload: base64 of interleaved little-endian i16. */
	pushBase64(text: string, rate: number, now: number): void {
		if (!text) return;
		let binary: string;
		try {
			binary = atob(text);
		} catch {
			return;
		}
		const values = binary.length >> 1;
		if (this.decodeScratch.length < values) this.decodeScratch = new Int16Array(values * 2);
		const out = this.decodeScratch;
		for (let index = 0; index < values; index += 1) {
			const lo = binary.charCodeAt(index * 2);
			const hi = binary.charCodeAt(index * 2 + 1);
			out[index] = (hi << 8) | lo;
		}
		const pairs = values >> 1;
		if (pairs === 0) return;
		this.begin(rate);
		const ring = this.ring;
		let slot = this.written % SCOPE_RING_PAIRS;
		const scale = 1 / 32767;
		for (let index = 0; index < pairs; index += 1) {
			ring[slot * 2] = out[index * 2] * scale;
			ring[slot * 2 + 1] = out[index * 2 + 1] * scale;
			slot = slot + 1 === SCOPE_RING_PAIRS ? 0 : slot + 1;
		}
		this.written += pairs;
		this.lastAt = now;
	}

	/** Oldest pair index still held in the ring. */
	get oldest(): number {
		return Math.max(0, this.written - SCOPE_RING_PAIRS);
	}
}

export type ScopeRange = {
	/** First pair index to draw (the last pair drawn by the previous frame). */
	start: number;
	/** Pairs to draw after `start`; 0 when the beam has nothing new. */
	count: number;
	/** The stream's pair rate. */
	rate: number;
	/** True when the reader jumped (first frame, a stall, a restart). */
	resynced: boolean;
};

/**
 * Plays a ScopeStream back for one renderer: each frame takes the pairs whose
 * time has come (frame time x rate), steering its lag toward a small target
 * so bursty delivery reads as a steady beam. Drawing exactly the new pairs
 * each frame is what makes the phosphor's dwell physics right: every pair is
 * drawn once, at the beam's real speed.
 */
export class ScopeReader {
	/** Fractional pair index the beam has drawn up to. */
	private cursor = 0;
	private generation = -1;
	/** Lag the reader steers toward, seconds behind the newest pair. */
	readonly latency: number;
	private readonly out: ScopeRange = { start: 0, count: 0, rate: 48_000, resynced: true };

	constructor(latency = 0.04) {
		this.latency = latency;
	}

	/** Pairs past the cursor the interpolator may peek at (upsampling margin). */
	static readonly MARGIN = 3;

	take(stream: ScopeStream, dt: number, maxPairs: number): ScopeRange {
		const rate = stream.rate;
		const out = this.out;
		out.rate = rate;
		out.resynced = false;
		const newest = stream.written - ScopeReader.MARGIN;
		const target = this.latency * rate;
		const lag = newest - this.cursor;
		const previous = this.cursor;
		if (this.generation !== stream.generation || lag > rate * 0.25 || lag < -rate * 0.05) {
			// Start (or restart) a little behind the newest pair.
			this.generation = stream.generation;
			this.cursor = Math.max(stream.oldest, newest - target);
			out.start = Math.floor(this.cursor);
			out.count = 0;
			out.resynced = true;
			return out;
		}
		// Proportional speed trim: half a second to absorb a lag error.
		const trim = Math.max(-0.3, Math.min(0.3, ((lag - target) / rate) * 2.2));
		const step = Math.max(0, Number.isFinite(dt) ? dt : 0) * rate * (1 + trim);
		this.cursor = Math.min(newest, this.cursor + step);
		this.cursor = Math.max(this.cursor, previous);
		let start = Math.floor(previous);
		let count = Math.floor(this.cursor) - start;
		if (count > maxPairs) {
			start += count - maxPairs;
			count = maxPairs;
		}
		out.start = Math.max(start, stream.oldest);
		out.count = Math.max(0, count - (out.start - start));
		return out;
	}
}

/** Running stereo statistics of the pairs one frame drew. */
export type ScopeStats = {
	/** RMS of left and right together, 0..1. */
	rms: number;
	/** Absolute peak of either channel, 0..1. */
	peak: number;
	/** Side energy share: 0 mono .. 0.5 fully decorrelated .. 1 anti-phase. */
	width: number;
	/** Pearson correlation of left and right, -1..1 (1 = mono). */
	correlation: number;
	/**
	 * How much of the beam's travel is smooth curve rather than scribble:
	 * 1 for tonal figures and drawings, toward 0 for noise. Second differences
	 * against first differences of the XY path.
	 */
	smoothness: number;
	/** Raw XY path length of the drawn pairs (unit square, -1..1 axes). */
	path: number;
	/**
	 * How fast the beam turns, Hz: path speed over the circumference of a
	 * circle with the signal's RMS radius. A low tonal figure reads tens to a
	 * few hundred; a scribble of high partials or noise reads thousands.
	 */
	frequency: number;
};

export function createScopeStats(): ScopeStats {
	return { rms: 0, peak: 0, width: 0, correlation: 1, smoothness: 1, path: 0, frequency: 0 };
}

/** Measure `count` pairs from `start` (stream pair indices). */
export function measureScope(stream: ScopeStream, start: number, count: number, out: ScopeStats): ScopeStats {
	const ring = stream.ring;
	let ll = 0;
	let rr = 0;
	let lr = 0;
	let peak = 0;
	let path = 0;
	let first = 0;
	let second = 0;
	let px = 0;
	let py = 0;
	let dx = 0;
	let dy = 0;
	for (let index = 0; index <= count; index += 1) {
		const slot = ((start + index) % SCOPE_RING_PAIRS) * 2;
		const left = ring[slot];
		const right = ring[slot + 1];
		if (index > 0) {
			ll += left * left;
			rr += right * right;
			lr += left * right;
			const ax = Math.abs(left);
			const ay = Math.abs(right);
			if (ax > peak) peak = ax;
			if (ay > peak) peak = ay;
			const nx = left - px;
			const ny = right - py;
			const step = Math.hypot(nx, ny);
			path += step;
			first += step;
			if (index > 1) second += Math.hypot(nx - dx, ny - dy);
			dx = nx;
			dy = ny;
		}
		px = left;
		py = right;
	}
	const n = Math.max(1, count);
	out.rms = Math.sqrt((ll + rr) / (2 * n));
	out.peak = peak;
	const mid = ll + rr + 2 * lr;
	const side = ll + rr - 2 * lr;
	out.width = mid + side > 1e-9 ? side / (mid + side) : 0;
	out.correlation = ll > 1e-12 && rr > 1e-12 ? lr / Math.sqrt(ll * rr) : 1;
	// A sine sampled many times per cycle has second/first differences near
	// 2 pi f / rate; noise has them near 1 or more.
	const roughness = first > 1e-9 ? second / first : 0;
	out.smoothness = Math.max(0, Math.min(1, 1 - (roughness - 0.08) / 0.6));
	out.path = path;
	out.frequency = (path * stream.rate) / (n * Math.PI * 2 * Math.max(out.rms * Math.SQRT2, 1e-4));
	return out;
}
