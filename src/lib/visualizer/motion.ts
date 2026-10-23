// Organic motion: smooth, non-repeating movement for cameras, rigs and any
// parameter that should keep travelling without looping.
//
// Authored paths built from a few sines of one phase are Lissajous figures:
// they come back around, and over minutes the eye learns them. These helpers
// never repeat. `noise1` is gradient noise summed over incommensurate
// octaves. `Wander` drifts N dimensions with it. `Roamer` travels between
// targets chosen at irregular times, on critically damped springs, with a
// wander layered on top and impulses for transients. All of it is
// deterministic for a given seed and sequence of update() calls, so a
// remount or resume continues the same journey.

function hash(a: number, b: number, c: number, d: number): number {
	let h = 0x9e3779b1 ^ Math.imul(a | 0, 0x85ebca6b);
	h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
	h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
	h = Math.imul(h ^ (d | 0), 0x165667b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	h = Math.imul(h, 0x297a2d39);
	h ^= h >>> 15;
	return (h >>> 0) / 0x100000000;
}

function seedWord(seed: number | string): number {
	if (typeof seed === 'number') return Math.floor((seed - Math.floor(seed)) * 0xffffffff) >>> 0;
	let h = 0x811c9dc5;
	for (const char of seed) {
		h ^= char.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

const RATES = [1, 2.137, 4.719];
const GAINS = [0.62, 0.28, 0.13];

/** Smooth gradient noise in -1..1 along t (one unit ~ one undulation). Never repeats. */
export function noise1(seed: number, lane: number, t: number): number {
	let sum = 0;
	for (let octave = 0; octave < 3; octave += 1) {
		const x = t * RATES[octave] + octave * 17.31;
		const i = Math.floor(x);
		const f = x - i;
		const g0 = hash(seed, lane, i, 0x7a11 + octave) * 2 - 1;
		const g1 = hash(seed, lane, i + 1, 0x7a11 + octave) * 2 - 1;
		const fade = f * f * f * (f * (f * 6 - 15) + 10);
		sum += GAINS[octave] * 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * fade);
	}
	return Math.max(-1, Math.min(1, sum));
}

/** N dimensions of smooth non-repeating drift, each in -1..1. */
export class Wander {
	private readonly seed: number;
	private readonly t: Float64Array;
	readonly value: Float32Array;

	constructor(
		readonly dims: number,
		seed: number | string,
		/** Seconds per undulation, per dimension (or one for all). */
		private readonly period: number | readonly number[] = 20
	) {
		this.seed = seedWord(seed);
		this.t = new Float64Array(dims);
		this.value = new Float32Array(dims);
		for (let i = 0; i < dims; i += 1) this.t[i] = hash(this.seed, i, 0, 0x51) * 1000;
		this.sample();
	}

	/** Advance; `rate` scales speed (1 = authored, e.g. tempo or energy driven). */
	update(dt: number, rate = 1): Float32Array {
		const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0)) * Math.max(0, rate);
		for (let i = 0; i < this.dims; i += 1) {
			const period = typeof this.period === 'number' ? this.period : (this.period[i] ?? 20);
			this.t[i] += step / Math.max(0.5, period);
		}
		return this.sample();
	}

	private sample(): Float32Array {
		for (let i = 0; i < this.dims; i += 1) this.value[i] = noise1(this.seed, i, this.t[i]);
		return this.value;
	}
}

export type RoamerOptions = {
	/** Mean seconds between new destinations (exponentially distributed). */
	meanHold?: number;
	/** Shortest hold, seconds. */
	minHold?: number;
	/** Spring response time to a destination, seconds. */
	response?: number;
	/** Wander layered on top, as a fraction of the -1..1 range. */
	wander?: number;
	/** Wander undulation period, seconds. */
	wanderPeriod?: number;
};

/**
 * A point that roams an N-dimensional box (-1..1 per axis): it picks a new
 * destination at irregular intervals, travels there on a critically damped
 * spring (no overshoot, no corners), wanders on top, and can be nudged by
 * impulses. Map its output onto camera yaw, distance, height, focus...
 */
export class Roamer {
	private readonly seed: number;
	private readonly opts: Required<RoamerOptions>;
	private readonly wander: Wander;
	private readonly goal: Float32Array;
	private readonly pos: Float32Array;
	private readonly vel: Float32Array;
	readonly value: Float32Array;
	private hold: number;
	private picks = 0;

	constructor(
		readonly dims: number,
		seed: number | string,
		options: RoamerOptions = {}
	) {
		this.seed = seedWord(seed);
		this.opts = {
			meanHold: options.meanHold ?? 9,
			minHold: options.minHold ?? 2.5,
			response: options.response ?? 4,
			wander: options.wander ?? 0.25,
			wanderPeriod: options.wanderPeriod ?? 17
		};
		this.wander = new Wander(dims, this.seed ^ 0x5a5a, this.opts.wanderPeriod);
		this.goal = new Float32Array(dims);
		this.pos = new Float32Array(dims);
		this.vel = new Float32Array(dims);
		this.value = new Float32Array(dims);
		this.pickGoal();
		this.pos.set(this.goal);
		this.hold = this.nextHold();
		this.compose();
	}

	/**
	 * Advance. `rate` speeds the whole journey (tempo); `restless` 0..1
	 * shortens holds (energy, novelty). Returns values in about -1..1.
	 */
	update(dt: number, rate = 1, restless = 0.5): Float32Array {
		const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0)) * Math.max(0, rate);
		this.hold -= step * (0.6 + Math.max(0, Math.min(1, restless)) * 0.9);
		if (this.hold <= 0) {
			this.pickGoal();
			this.hold = this.nextHold();
		}
		// Critically damped spring: omega from the response time.
		const omega = 4 / Math.max(0.2, this.opts.response);
		for (let i = 0; i < this.dims; i += 1) {
			const accel = omega * omega * (this.goal[i] - this.pos[i]) - 2 * omega * this.vel[i];
			this.vel[i] += accel * step;
			this.pos[i] += this.vel[i] * step;
		}
		this.wander.update(dt, rate);
		return this.compose();
	}

	/** Push the point (a kick, a drop): velocity in units per second per axis. */
	impulse(dim: number, velocity: number): void {
		if (dim >= 0 && dim < this.dims && Number.isFinite(velocity)) this.vel[dim] += velocity;
	}

	/** Head somewhere new now (a genre shift), instead of waiting out the hold. */
	redirect(): void {
		this.pickGoal();
		this.hold = this.nextHold();
	}

	private pickGoal(): void {
		this.picks += 1;
		for (let i = 0; i < this.dims; i += 1) {
			// Bias away from the current spot so consecutive goals differ.
			let g = hash(this.seed, i, this.picks, 0x90a1) * 2 - 1;
			if (Math.abs(g - this.pos[i]) < 0.35) g = g > this.pos[i] ? Math.min(1, g + 0.4) : Math.max(-1, g - 0.4);
			this.goal[i] = g;
		}
	}

	private nextHold(): number {
		const u = Math.max(1e-6, hash(this.seed, 999, this.picks, 0x4e1d));
		return this.opts.minHold + -Math.log(u) * Math.max(0, this.opts.meanHold - this.opts.minHold);
	}

	private compose(): Float32Array {
		const w = this.opts.wander;
		for (let i = 0; i < this.dims; i += 1) this.value[i] = this.pos[i] * (1 - w) + this.wander.value[i] * w;
		return this.value;
	}
}
