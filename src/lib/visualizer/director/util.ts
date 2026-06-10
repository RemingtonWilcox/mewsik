// Signal-processing primitives for the director.
// All updaters are causal and allocation-free in steady state.

export function clamp(x: number, lo: number, hi: number) {
	return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number) {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

export function wrap01(x: number) {
	const f = x - Math.floor(x);
	return f < 0 ? f + 1 : f;
}

// alpha for one-pole IIR at frame rate fs with time-constant tau (seconds).
// y[n] = a * x[n] + (1 - a) * y[n-1]
export function alphaForTau(tau: number, fs: number) {
	if (tau <= 0) return 1;
	return 1 - Math.exp(-1 / (tau * fs));
}

// Asymmetric one-pole envelope: fast attack, slow release (or any pair).
export class AsymmetricEnvelope {
	value = 0;
	private aUp: number;
	private aDown: number;
	constructor(tauAttack: number, tauRelease: number, fs = 60, initial = 0) {
		this.aUp = alphaForTau(tauAttack, fs);
		this.aDown = alphaForTau(tauRelease, fs);
		this.value = initial;
	}
	tick(target: number) {
		const a = target > this.value ? this.aUp : this.aDown;
		this.value = a * target + (1 - a) * this.value;
		return this.value;
	}
	reset(v = 0) {
		this.value = v;
	}
}

// Lock-free ring buffer over Float32Array. Push appends, read by lookback.
export class RingBuffer {
	private buf: Float32Array;
	private idx = 0;
	private filled = 0;
	readonly capacity: number;
	constructor(capacity: number) {
		this.capacity = capacity;
		this.buf = new Float32Array(capacity);
	}
	push(v: number) {
		this.buf[this.idx] = v;
		this.idx = (this.idx + 1) % this.capacity;
		if (this.filled < this.capacity) this.filled++;
	}
	// Most recent sample is back=0; older = larger back.
	at(back: number): number {
		if (back < 0 || back >= this.filled) return 0;
		const i = (this.idx - 1 - back + this.capacity * 2) % this.capacity;
		return this.buf[i];
	}
	mean(start: number, len: number): number {
		if (this.filled === 0) return 0;
		const n = Math.min(len, this.filled - start);
		if (n <= 0) return 0;
		let s = 0;
		for (let k = 0; k < n; k++) s += this.at(start + k);
		return s / n;
	}
	// Linear-fit slope over [start, start+len), in units of (value per sample).
	slope(start: number, len: number): number {
		const n = Math.min(len, this.filled - start);
		if (n < 2) return 0;
		const meanX = (n - 1) / 2;
		let meanY = 0;
		for (let k = 0; k < n; k++) meanY += this.at(start + k);
		meanY /= n;
		let num = 0;
		let den = 0;
		for (let k = 0; k < n; k++) {
			const dx = k - meanX;
			const dy = this.at(start + k) - meanY;
			num += dx * dy;
			den += dx * dx;
		}
		return den > 0 ? num / den : 0;
	}
	get count() {
		return this.filled;
	}
}

// HSV → RGB in [0,1]. Used by renderers when consuming PaletteHSV.
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	const idx = ((i % 6) + 6) % 6;
	switch (idx) {
		case 0:
			return [v, t, p];
		case 1:
			return [q, v, p];
		case 2:
			return [p, v, t];
		case 3:
			return [p, q, v];
		case 4:
			return [t, p, v];
		default:
			return [v, p, q];
	}
}

/** Deterministic string → [0,1) hash (FNV-1a). Used to derive per-track
 * visual identity seeds: the same track always grows the same world. */
export function stringHash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967296;
}
