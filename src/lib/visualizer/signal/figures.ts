// The hero figure, evaluated on the CPU once per frame and uploaded as a
// polyline. Everything else in the instrument reads this one polyline: the X
// and Y channel traces are its two deflection signals, the beam head is a
// point on it, the horizon rows are its silhouette history and the room is lit
// from its head. One source of truth is what makes the scope read as one
// instrument instead of three layers.
//
// Families (all tied to harmony through an interval/ratio table indexed by
// the conductor's complexity and the key mode):
//   0 Lissajous     3D interval figure, morphed by the conductor's forms
//   1 Harmonograph  two damped pendulums per axis, spiralling inward
//   2 Rose          rhodonea r = cos(k theta), k from the interval
//   3 Spirograph    hypotrochoid, wheel ratios from the interval
//   4 Phase plot    bass partials against mid partials (live audio shape)
//   5 Attractor     a Lorenz trail integrated in real time
//   6 Polar loop    the spectrum wrapped into one closed outline (no bars)
//   7 Torus knot    (p, q) knot projection
//   8 Scope         the real stereo signal as XY (drawn by the beam module
//                   in shaders.ts). Here it is a stand-in: the polyline
//                   keeps the family it is morphing from or to, which the
//                   beam traces while it hands over to the signal.

export const SIGNAL_FIGURE_SEGMENTS = 480;
export const SIGNAL_FIGURE_POINTS = SIGNAL_FIGURE_SEGMENTS + 1;
export const SIGNAL_FIGURE_FLOATS = SIGNAL_FIGURE_POINTS * 4 * 2;

export const SIGNAL_FAMILY_NAMES = [
	'lissajous',
	'harmonograph',
	'rose',
	'spirograph',
	'phase-plot',
	'attractor',
	'polar-loop',
	'torus-knot',
	'scope'
] as const;

/** The family whose hero is the real stereo signal (SIGNAL_FAMILY_NAMES). */
export const SIGNAL_SCOPE_FAMILY = 8;

/**
 * How much of the hero the XY beam owns for a family morph: 1 while the
 * scope family is on, easing in and out with the morph.
 */
export function signalScopeShare(familyFrom: number, familyTo: number, familyMix: number): number {
	const mix = clamp(familyMix, 0, 1);
	const to = familyTo === SIGNAL_SCOPE_FAMILY ? 1 : 0;
	const from = familyFrom === SIGNAL_SCOPE_FAMILY ? 1 : 0;
	return from + (to - from) * mix;
}

const TAU = Math.PI * 2;

/** How far each family may tip in 3D (flat curves read best nearly face-on). */
const FAMILY_TILT = [1, 0.5, 0.32, 0.32, 0.6, 1, 0.28, 1, 1];

export type SignalFigureInput = {
	familyFrom: number;
	familyTo: number;
	familyMix: number;
	phase: number;
	/** 0..1 harmonic complexity from the conductor. */
	complexity: number;
	/** -1 minor .. 1 major. */
	mode: number;
	p1: number;
	p2: number;
	ellipse: number;
	lissajous: number;
	ribbon: number;
	rosette: number;
	tension: number;
	release: number;
	/** Stereo-ghost phase spread. */
	spread: number;
	sub: number;
	kick: number;
	body: number;
	mids: number;
	presence: number;
	air: number;
	spectralMotion: number;
	energy: number;
	detail: Float32Array;
	yaw: number;
	tilt: number;
	/** In-plane roll for flat families. */
	roll: number;
	/** 0 = figure B is the stereo ghost of A, 1 = B is A seen from the side. */
	partner: number;
	dt: number;
	/** Integration speed for the attractor (beats per second-ish). */
	pace: number;
	/** 0..1 jagged beam noise (rough music); 0 when absent. */
	jitter?: number;
	/** 0..1 slow hand-drawn wander (acoustic touch); 0 when absent. */
	wander?: number;
	/** Seconds-like clock the jitter and wander move on. */
	grainTime?: number;
};

type Vec3 = [number, number, number];

function smooth(t: number) {
	return t * t * (3 - 2 * t);
}

function clamp(value: number, low: number, high: number) {
	return value < low ? low : value > high ? high : value;
}

// Interval ratios (XY frequency) by index; major and minor colour intervals.
const MAJOR_RATIOS: readonly (readonly [number, number])[] = [
	[1, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6], [4, 7]
];
const MINOR_RATIOS: readonly (readonly [number, number])[] = [
	[1, 1], [1, 2], [2, 3], [3, 4], [5, 8], [5, 6], [4, 7], [7, 9]
];
const ROSE_K = [2, 3, 2.5, 4, 7 / 3, 5 / 3, 3.5, 8 / 3];
const ROSE_D = [1, 1, 2, 1, 3, 3, 2, 3];
const SPIRO: readonly (readonly [number, number])[] = [
	[3, 1], [5, 2], [5, 3], [7, 3], [7, 2], [8, 3], [9, 4], [11, 4]
];
const KNOTS: readonly (readonly [number, number])[] = [
	[2, 3], [3, 2], [2, 5], [3, 4], [3, 5], [2, 7], [4, 5], [5, 3]
];

/** Integer hash to 0..1. */
function hash01(n: number) {
	let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
	x ^= x >>> 15;
	x = Math.imul(x, 0x85ebca6b);
	x ^= x >>> 13;
	return (x >>> 0) / 0x1_0000_0000;
}

/** Smooth 1D value noise, -1..1, repeating every `period` units. */
function valueNoise(t: number, salt: number, period: number) {
	const i = Math.floor(t);
	const f = t - i;
	const i0 = ((i % period) + period) % period;
	const i1 = (i0 + 1) % period;
	const a = hash01(i0 * 2 + salt * 7919);
	const b = hash01(i1 * 2 + salt * 7919);
	return (a + (b - a) * smooth(f)) * 2 - 1;
}

function smoothDetail(detail: Float32Array, position: number) {
	const scaled = clamp(position, 0, 0.999) * 63;
	const index = Math.floor(scaled);
	const f = scaled - index;
	const a = detail[Math.max(index - 1, 0)] ?? 0;
	const b = detail[index] ?? 0;
	const c = detail[Math.min(index + 1, 63)] ?? 0;
	const d = detail[Math.min(index + 2, 63)] ?? 0;
	const f2 = f * f;
	const f3 = f2 * f;
	return clamp(
		0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (-a + 3 * b - 3 * c + d) * f3),
		-1,
		1
	);
}

export class SignalFigureEngine {
	/** Two figures (A then B), each SIGNAL_FIGURE_POINTS x (x, y, depth, dwell). */
	readonly points = new Float32Array(SIGNAL_FIGURE_FLOATS);
	private readonly rawA = new Float32Array(SIGNAL_FIGURE_POINTS * 3);
	private readonly rawB = new Float32Array(SIGNAL_FIGURE_POINTS * 3);
	// Lorenz trail ring buffer.
	private readonly trail = new Float32Array(SIGNAL_FIGURE_POINTS * 3);
	private trailHead = 0;
	private lorenz: Vec3 = [0.1, 0, 20];
	private stepCarry = 0;
	/** Mean segment length of figures A and B (local units), for the beam light. */
	readonly meanLength: [number, number] = [0.01, 0.01];

	constructor() {
		this.resetAttractor();
	}

	resetAttractor(): void {
		this.lorenz = [0.1, 0.3, 20];
		this.trailHead = 0;
		// Pre-roll so the trail is a full butterfly from the first frame.
		for (let i = 0; i < SIGNAL_FIGURE_POINTS * 2; i += 1) this.stepLorenz(28, 10, 8 / 3, 0.0095);
	}

	private stepLorenz(rho: number, sigma: number, beta: number, h: number) {
		const [x, y, z] = this.lorenz;
		// Midpoint integration: stable enough at these step sizes.
		const dx1 = sigma * (y - x);
		const dy1 = x * (rho - z) - y;
		const dz1 = x * y - beta * z;
		const mx = x + dx1 * h * 0.5;
		const my = y + dy1 * h * 0.5;
		const mz = z + dz1 * h * 0.5;
		this.lorenz = [
			x + sigma * (my - mx) * h,
			y + (mx * (rho - mz) - my) * h,
			z + (mx * my - beta * mz) * h
		];
		const slot = this.trailHead * 3;
		this.trail[slot] = this.lorenz[0];
		this.trail[slot + 1] = this.lorenz[1];
		this.trail[slot + 2] = this.lorenz[2];
		this.trailHead = (this.trailHead + 1) % SIGNAL_FIGURE_POINTS;
	}

	private advanceAttractor(input: SignalFigureInput) {
		const rho = 24 + input.p1 * 9 + input.energy * 3;
		const beta = 8 / 3 + input.p2 * 0.5;
		// About 140 integration steps a second at a moderate pace.
		this.stepCarry += input.dt * (70 + input.pace * 70);
		let steps = Math.floor(this.stepCarry);
		this.stepCarry -= steps;
		steps = Math.min(steps, 24);
		for (let i = 0; i < steps; i += 1) this.stepLorenz(rho, 10, beta, 0.0095);
	}

	/**
	 * Integer XY ratio for one table entry. Major and minor tables are never
	 * mixed numerically (a fractional ratio would tear the closed figure open);
	 * familyPoint blends the two finished curves instead.
	 */
	private ratio(index: number, major: boolean, out: [number, number]) {
		const i = clamp(Math.round(index), 0, 7);
		const table = major ? MAJOR_RATIOS[i] : MINOR_RATIOS[i];
		out[0] = table[0];
		out[1] = table[1];
		return out;
	}

	private readonly ratioScratch: [number, number] = [1, 1];

	/** One family at one table index; writes a roughly unit-sized 3D point. */
	private raw(family: number, u: number, index: number, input: SignalFigureInput, phase: number, out: Vec3, major = true) {
		const t = u * TAU;
		switch (family) {
			case 1: {
				// Harmonograph: two pendulums per axis with damping.
				const [rx, ry] = this.ratio(index, major, this.ratioScratch);
				const turns = (5 + input.p1 * 6) / Math.max(rx, ry);
				const tt = u * turns * TAU;
				const env = Math.exp(-u * (1.1 + input.p2 * 2.2));
				const detune = 1.004 + input.p2 * 0.01;
				out[0] = env * (Math.sin(rx * tt + phase) * 0.72 + Math.sin(rx * detune * 2 * tt + phase * 1.7) * 0.28);
				out[1] = env * (Math.sin(ry * tt) * 0.72 + Math.sin(ry * detune * 1.5 * tt + phase * 0.4 + 1) * 0.28);
				out[2] = env * Math.sin((rx + ry) * 0.5 * tt + phase) * 0.6;
				return;
			}
			case 2: {
				const i = clamp(Math.round(index), 0, 7);
				const k = ROSE_K[i];
				const theta = t * ROSE_D[i];
				const offset = input.p1 * 0.45;
				const r = (Math.cos(k * theta + phase * 0.2) + offset) / (1 + offset);
				const rot = phase * 0.07;
				out[0] = r * Math.cos(theta + rot);
				out[1] = r * Math.sin(theta + rot);
				out[2] = Math.sin(k * theta * 0.5 + phase) * (0.15 + input.p2 * 0.35);
				return;
			}
			case 3: {
				const i = clamp(Math.round(index), 0, 7);
				const [R, r] = SPIRO[i];
				const tt = t * r;
				const d = r * (0.5 + input.p1 * 0.9);
				const k = (R - r) / r;
				const norm = 1 / (R - r + d);
				out[0] = ((R - r) * Math.cos(tt) + d * Math.cos(k * tt + phase * 0.3)) * norm;
				out[1] = ((R - r) * Math.sin(tt) - d * Math.sin(k * tt + phase * 0.3)) * norm;
				out[2] = Math.sin(tt * (R / r) + phase) * (0.12 + input.p2 * 0.3);
				return;
			}
			case 4: {
				// Phase portrait: bass partials on X, mid partials on Y, with a
				// delay-embedded echo so the loop opens and closes with the mix.
				const [rx, ry] = this.ratio(index, major, this.ratioScratch);
				let x = 0;
				let y = 0;
				let z = 0;
				let ax = 0;
				let ay = 0;
				for (let j = 1; j <= 4; j += 1) {
					const low = 0.3 / j + Math.max(0, smoothDetail(input.detail, (j * 4) / 63)) * 1.4 + (j === 1 ? input.sub : input.kick * 0.3) * 0.25;
					const mid = 0.3 / j + Math.max(0, smoothDetail(input.detail, (20 + j * 5) / 63)) * 1.4 + (j === 1 ? input.mids : input.presence * 0.3) * 0.25;
					const phx = phase * (0.5 + 0.21 * j) + j * 1.1;
					const phy = phase * (0.37 + 0.17 * j) + j * 2.3 + input.p1 * 3;
					x += low * Math.sin(rx * j * t + phx);
					y += mid * Math.sin(ry * j * t + phy);
					z += low * Math.cos(rx * j * t + phx + input.p2 * 2);
					ax += low;
					ay += mid;
				}
				x /= Math.max(ax, 1e-3);
				y /= Math.max(ay, 1e-3);
				const echo = 0.25 + input.p2 * 0.3;
				out[0] = x;
				out[1] = y * (1 - echo) + x * echo * Math.cos(phase * 0.1);
				out[2] = (z / Math.max(ax, 1e-3)) * 0.6;
				return;
			}
			case 5: {
				// Lorenz trail: u = 0 oldest .. 1 newest.
				const position = u * (SIGNAL_FIGURE_POINTS - 1);
				const i0 = Math.floor(position);
				const f = position - i0;
				const s0 = ((this.trailHead + i0) % SIGNAL_FIGURE_POINTS) * 3;
				const s1 = ((this.trailHead + Math.min(i0 + 1, SIGNAL_FIGURE_POINTS - 1)) % SIGNAL_FIGURE_POINTS) * 3;
				const x = this.trail[s0] + (this.trail[s1] - this.trail[s0]) * f;
				const y = this.trail[s0 + 1] + (this.trail[s1 + 1] - this.trail[s0 + 1]) * f;
				const z = this.trail[s0 + 2] + (this.trail[s1 + 2] - this.trail[s0 + 2]) * f;
				out[0] = x / 21;
				out[1] = (z - 24) / 22;
				out[2] = y / 26;
				return;
			}
			case 6: {
				// Polar loop: the spectrum mirrored into a closed outline. The lobe
				// count glides: the outlines at the two neighbouring whole counts
				// are blended, so a new lobe grows instead of popping in.
				const lobeCount = 1 + clamp(input.p1, 0, 1) * 2;
				const lobesLo = Math.floor(lobeCount);
				const lobeMix = smooth(lobeCount - lobesLo);
				const theta = t + phase * 0.06;
				const low = input.sub * 0.5 + input.kick * 0.3;
				const mid = input.mids * 0.5 + input.body * 0.2;
				const high = input.presence * 0.4 + input.air * 0.4;
				const levelAt = (lobes: number) => {
					const position = Math.abs(((u * lobes) % 1) * 2 - 1);
					// Band zones crossfade too, so the outline has no seams.
					const lowMid = low + (mid - low) * smooth(clamp((position - 0.24) / 0.12, 0, 1));
					const zone = lowMid + (high - lowMid) * smooth(clamp((position - 0.59) / 0.12, 0, 1));
					return smoothDetail(input.detail, position) * 0.9 + zone;
				};
				let level = levelAt(lobesLo);
				if (lobeMix > 0.001) level += (levelAt(lobesLo + 1) - level) * lobeMix;
				const r = 0.5 + 0.48 * Math.tanh(level * 1.3);
				out[0] = r * Math.cos(theta);
				out[1] = r * Math.sin(theta);
				out[2] = Math.sin(theta * 3 + phase) * (0.1 + input.p2 * 0.25);
				return;
			}
			case 7: {
				const i = clamp(Math.round(index), 0, 7);
				const [p, q] = KNOTS[i];
				const r = 0.32 + input.p1 * 0.28;
				const ring = 1 + r * Math.cos(q * t + phase * 0.2);
				const norm = 1 / (1 + r);
				out[0] = ring * Math.cos(p * t) * norm;
				out[1] = ring * Math.sin(p * t) * norm;
				out[2] = r * Math.sin(q * t + phase * 0.2) * norm * 1.6;
				return;
			}
			default: {
				// Lissajous with the conductor's continuous forms.
				const [rx, ry] = this.ratio(index, major, this.ratioScratch);
				let x = Math.sin(rx * t + phase);
				let y = Math.sin(ry * t);
				let z = Math.sin((rx + ry) * t + phase * 0.61 + 1.3);
				const total = Math.max(input.ellipse + input.lissajous + input.ribbon + input.rosette, 1e-4);
				const ellipse = input.ellipse / total;
				const ribbon = input.ribbon / total;
				const rosette = input.rosette / total;
				const ox = Math.cos(t + phase * 0.3);
				const oy = Math.sin(t) * 0.8;
				const oz = Math.sin(t * 2 + phase) * 0.5;
				x += (ox - x) * ellipse * 0.7;
				y += (oy - y) * ellipse * 0.7;
				z += (oz - z) * ellipse * 0.7;
				x *= 1 + ribbon * 0.42;
				y *= 1 - ribbon * 0.3;
				// Petal count glides between whole counts so the figure stays closed.
				const petals = 3 + clamp(input.complexity, 0, 1) * 4;
				const petalsLo = Math.floor(petals);
				const petalMix = smooth(petals - petalsLo);
				const petalA = Math.cos(petalsLo * t + phase * 1.3);
				const petalB = Math.cos((petalsLo + 1) * t + phase * 1.3);
				const rose = 1 + rosette * (0.12 + input.tension * 0.14) * (petalA + (petalB - petalA) * petalMix);
				out[0] = x * rose;
				out[1] = y * rose;
				out[2] = z;
			}
		}
	}

	private readonly a: Vec3 = [0, 0, 0];
	private readonly b: Vec3 = [0, 0, 0];
	private readonly e: Vec3 = [0, 0, 0];

	/** Family point with the harmony index blended between neighbours. */
	private indexedPoint(family: number, u: number, input: SignalFigureInput, phase: number, major: boolean, out: Vec3) {
		const majorWeight = clamp(input.mode * 0.5 + 0.5, 0, 1);
		// Lissajous-like families use the conductor complexity directly; table
		// families shift two entries darker in minor keys.
		const index = clamp(input.complexity, 0, 1) * 5 + (family === 0 || family === 1 || family === 4 ? 0 : (1 - majorWeight) * 2);
		const i0 = Math.floor(index);
		const f = smooth(index - i0);
		this.raw(family, u, i0, input, phase, this.a, major);
		if (f > 0.001 && family !== 5 && family !== 6) {
			this.raw(family, u, i0 + 1, input, phase, this.b, major);
			out[0] = this.a[0] + (this.b[0] - this.a[0]) * f;
			out[1] = this.a[1] + (this.b[1] - this.a[1]) * f;
			out[2] = this.a[2] + (this.b[2] - this.a[2]) * f;
		} else {
			out[0] = this.a[0];
			out[1] = this.a[1];
			out[2] = this.a[2];
		}
	}

	/**
	 * Families built on the interval table (Lissajous, harmonograph, phase
	 * plot) cross from the minor to the major table by blending the two
	 * finished curves through a soft band around a neutral key, never by
	 * switching table at a threshold.
	 */
	private familyPoint(family: number, u: number, input: SignalFigureInput, phase: number, out: Vec3) {
		const usesTable = family === 0 || family === 1 || family === 4;
		const majorWeight = clamp(input.mode * 0.5 + 0.5, 0, 1);
		const toMajor = usesTable ? smooth(clamp((majorWeight - 0.3) / 0.4, 0, 1)) : 1;
		this.indexedPoint(family, u, input, phase, toMajor > 0.001, out);
		if (toMajor <= 0.001 || toMajor >= 0.999) return;
		const majorX = out[0];
		const majorY = out[1];
		const majorZ = out[2];
		this.indexedPoint(family, u, input, phase, false, this.e);
		out[0] = this.e[0] + (majorX - this.e[0]) * toMajor;
		out[1] = this.e[1] + (majorY - this.e[1]) * toMajor;
		out[2] = this.e[2] + (majorZ - this.e[2]) * toMajor;
	}

	private readonly c: Vec3 = [0, 0, 0];
	private readonly d: Vec3 = [0, 0, 0];

	/**
	 * Family morph: both families are sampled at the same curve parameter and
	 * blended point for point, so the old figure flows into the new one. The
	 * caller's mix is already eased (see SignalChoiceMorph).
	 */
	private evaluateRaw(input: SignalFigureInput, phase: number, out: Float32Array) {
		const mix = clamp(input.familyMix, 0, 1);
		const blend = input.familyFrom !== input.familyTo && mix < 1;
		for (let i = 0; i < SIGNAL_FIGURE_POINTS; i += 1) {
			const u = i / SIGNAL_FIGURE_SEGMENTS;
			this.familyPoint(input.familyTo, u, input, phase, this.c);
			if (blend) {
				this.familyPoint(input.familyFrom, u, input, phase, this.d);
				this.c[0] = this.d[0] + (this.c[0] - this.d[0]) * mix;
				this.c[1] = this.d[1] + (this.c[1] - this.d[1]) * mix;
				this.c[2] = this.d[2] + (this.c[2] - this.d[2]) * mix;
			}
			out[i * 3] = this.c[0];
			out[i * 3 + 1] = this.c[1];
			out[i * 3 + 2] = this.c[2];
		}
	}

	private tiltFor(input: SignalFigureInput) {
		const mix = clamp(input.familyMix, 0, 1);
		return FAMILY_TILT[input.familyFrom] + (FAMILY_TILT[input.familyTo] - FAMILY_TILT[input.familyFrom]) * mix;
	}

	/** Project raw points to local figure space, applying audio deflection. */
	private project(raw: Float32Array, input: SignalFigureInput, yaw: number, scale: number, figure: number, partnerMix: number, ghostRaw: Float32Array | null, ghostYaw: number) {
		const tiltFactor = this.tiltFor(input);
		const base = figure * SIGNAL_FIGURE_POINTS * 4;
		const sx = 0.8 + input.body * 0.16 + input.sub * 0.12;
		const sy = (0.76 + input.mids * 0.16 + input.presence * 0.12) * (1 - input.tension * 0.12);
		const ripplePhase = input.phase * 0.021;
		const rippleGain = 0.03 + input.spectralMotion * 0.05;
		// Rough music shakes the beam: a fine jag that crawls along the curve,
		// strongest where the high bands are; acoustic touch wanders slowly.
		const jitter = clamp(input.jitter ?? 0, 0, 1) * (0.04 + input.presence * 0.03 + input.air * 0.03 + input.energy * 0.02);
		const wander = clamp(input.wander ?? 0, 0, 1) * 0.035;
		const grainTime = input.grainTime ?? 0;
		const jagTime = Math.floor(grainTime * 24);
		const pitch = input.tilt * tiltFactor;
		const cp = Math.cos(pitch);
		const sp = Math.sin(pitch);
		const cr = Math.cos(input.roll * (1 - tiltFactor));
		const sr = Math.sin(input.roll * (1 - tiltFactor));
		const project = (x0: number, y0: number, z0: number, u: number, yawAngle: number, out: Vec3) => {
			// In-plane roll for flat families.
			let x = x0 * cr - y0 * sr;
			let y = x0 * sr + y0 * cr;
			let z = z0;
			x *= sx;
			y *= sy;
			const detail = smoothDetail(input.detail, (u * 2 + ripplePhase) % 1);
			const length = Math.hypot(x, y) + 1e-4;
			// Radial ripple, faded out at the centre: a curve passing through the
			// origin would otherwise flip its push direction in one step.
			const centreFade = smooth(clamp(length / 0.12, 0, 1));
			const ripple = (detail * rippleGain + Math.sin(u * TAU * 41 + input.phase * 3) * input.air * 0.006) * centreFade;
			x += (x / length) * ripple;
			y += (y / length) * ripple;
			if (jitter > 1e-5) {
				const along = u * 140 + grainTime * 9;
				// Both noises repeat once per curve, so closed figures stay closed.
				const point = Math.round(u * 480) % 480;
				x += jitter * (valueNoise(along, 1, 140) * 0.75 + (hash01(point + jagTime * 977) - 0.5) * 0.5);
				y += jitter * (valueNoise(along, 2, 140) * 0.75 + (hash01(point * 3 + jagTime * 613) - 0.5) * 0.5);
			}
			if (wander > 1e-5) {
				x += wander * (Math.sin(TAU * u * 2 + grainTime * 0.4 + 1) * 0.6 + Math.sin(TAU * u * 3 - grainTime * 0.27) * 0.4);
				y += wander * (Math.sin(TAU * u * 2 - grainTime * 0.33 + 2) * 0.6 + Math.sin(TAU * u * 5 + grainTime * 0.21) * 0.4);
			}
			const cy = Math.cos(yawAngle * tiltFactor);
			const sy2 = Math.sin(yawAngle * tiltFactor);
			const rx = x * cy + z * sy2;
			const rz = -x * sy2 + z * cy;
			const ry = y * cp - rz * sp;
			const rz2 = y * sp + rz * cp;
			const perspective = 1 / (1 + rz2 * 0.3);
			out[0] = rx * perspective * scale;
			out[1] = ry * perspective * scale;
			out[2] = clamp(0.5 - rz2 * 0.5, 0, 1);
		};
		const p = this.a;
		const g = this.b;
		for (let i = 0; i < SIGNAL_FIGURE_POINTS; i += 1) {
			const u = i / SIGNAL_FIGURE_SEGMENTS;
			project(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2], u, yaw, p);
			if (ghostRaw && partnerMix < 0.999) {
				project(ghostRaw[i * 3], ghostRaw[i * 3 + 1], ghostRaw[i * 3 + 2], u, ghostYaw, g);
				const ghostScale = 1.035;
				p[0] = g[0] * ghostScale + (p[0] - g[0] * ghostScale) * partnerMix;
				p[1] = g[1] * ghostScale + (p[1] - g[1] * ghostScale) * partnerMix;
				p[2] = g[2] + (p[2] - g[2]) * partnerMix;
			}
			this.points[base + i * 4] = p[0];
			this.points[base + i * 4 + 1] = p[1];
			this.points[base + i * 4 + 2] = p[2];
		}
		// Beam dwell: a real XY beam burns brighter where it slows down.
		let total = 0;
		for (let i = 0; i < SIGNAL_FIGURE_SEGMENTS; i += 1) {
			const o = base + i * 4;
			total += Math.hypot(this.points[o + 4] - this.points[o], this.points[o + 5] - this.points[o + 1]);
		}
		// Beam dwell is physical now (the shader integrates the spot along each
		// segment), so the fourth float is unused; the mean segment is the
		// figure's reference speed.
		this.meanLength[figure] = Math.max(total / SIGNAL_FIGURE_SEGMENTS, 1e-4);
		for (let i = 0; i < SIGNAL_FIGURE_POINTS; i += 1) this.points[base + i * 4 + 3] = 1;
	}

	evaluate(source: SignalFigureInput): Float32Array {
		// The scope family draws no polyline of its own: hold the family it is
		// leaving or arriving from (a Lissajous when there is none).
		let input = source;
		const scope = SIGNAL_SCOPE_FAMILY;
		if (source.familyFrom === scope || source.familyTo === scope) {
			const other =
				source.familyFrom !== scope ? source.familyFrom : source.familyTo !== scope ? source.familyTo : 0;
			input = { ...source, familyFrom: other, familyTo: other, familyMix: 1 };
		}
		this.advanceAttractor(input);
		this.evaluateRaw(input, input.phase, this.rawA);
		this.project(this.rawA, input, input.yaw, 1, 0, 1, null, input.yaw);
		const partner = clamp(input.partner, 0, 1);
		let ghost: Float32Array | null = null;
		if (partner < 0.999) {
			this.evaluateRaw(input, input.phase + input.spread, this.rawB);
			ghost = this.rawB;
		}
		// Partner view: the same object a quarter turn round, the second screen
		// of a dual bench showing the figure's side elevation.
		this.project(this.rawA, input, input.yaw + Math.PI * 0.5, 1, 1, partner, ghost, input.yaw);
		return this.points;
	}

	/** Interpolated local xy of figure 0 or 1 at u in 0..1. */
	sample(figure: number, u: number, out: [number, number]): [number, number] {
		const wrapped = ((u % 1) + 1) % 1;
		const position = wrapped * SIGNAL_FIGURE_SEGMENTS;
		const i0 = Math.min(Math.floor(position), SIGNAL_FIGURE_SEGMENTS - 1);
		const f = position - i0;
		const o = figure * SIGNAL_FIGURE_POINTS * 4 + i0 * 4;
		out[0] = this.points[o] + (this.points[o + 4] - this.points[o]) * f;
		out[1] = this.points[o + 1] + (this.points[o + 5] - this.points[o + 1]) * f;
		return out;
	}

	/**
	 * Polar silhouette of figure A: the farthest reach of the beam in each of
	 * `bins` angular sectors, gaps filled and lightly smoothed. This is what the
	 * horizon remembers, so a new figure ripples down the terrain.
	 */
	silhouette(out: Float32Array): Float32Array {
		const bins = out.length;
		out.fill(-1);
		for (let i = 0; i < SIGNAL_FIGURE_POINTS; i += 1) {
			const x = this.points[i * 4];
			const y = this.points[i * 4 + 1];
			const angle = Math.atan2(y, x);
			const bin = Math.floor(((angle / TAU + 1) % 1) * bins) % bins;
			const r = Math.hypot(x, y);
			if (r > out[bin]) out[bin] = r;
		}
		// Fill empty sectors from their nearest filled neighbours.
		for (let pass = 0; pass < bins; pass += 1) {
			let missing = 0;
			for (let b = 0; b < bins; b += 1) {
				if (out[b] >= 0) continue;
				const left = out[(b + bins - 1) % bins];
				const right = out[(b + 1) % bins];
				if (left >= 0 || right >= 0) out[b] = Math.max(left, right) * 0.9;
				else missing += 1;
			}
			if (missing === 0) break;
		}
		const copy = Float32Array.from(out);
		for (let b = 0; b < bins; b += 1) {
			out[b] = Math.max(0, copy[(b + bins - 1) % bins] * 0.25 + copy[b] * 0.5 + copy[(b + 1) % bins] * 0.25);
		}
		return out;
	}
}
