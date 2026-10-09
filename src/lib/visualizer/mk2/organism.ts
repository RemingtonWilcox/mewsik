/**
 * Soma's abyssal organism: CPU-side swimming and palette roles.
 *
 * The organism is never parked in the middle of the frame. Every half phrase
 * (16 beats) a seeded waypoint is chosen on alternating sides of the shot,
 * and the bell glides toward it on a damped spring that is pushed by its own
 * swim strokes. Nothing here runs on wall-clock time: the waypoint index is
 * song position, stroke and tendril phases advance with smoothed energy, and
 * percussion never moves the body (beats only launch light packets in WGSL).
 */

export type SomaVec3 = [number, number, number];

/** Bioluminescent hue anchors: ember, acid green, cyan, violet, magenta. */
export const SOMA_BIO_ANCHORS = [0.08, 0.31, 0.5, 0.74, 0.9] as const;

/** Deep indigo water. Palette roles only lean it a few degrees. */
export const SOMA_INK_HUE = 0.665;

/** Beats per waypoint: a half phrase of the director's 32-beat phrase. */
export const SOMA_BEATS_PER_WAYPOINT = 16;

/** Waypoint envelope relative to the scene centre, in camera-horizontal axes. */
export const SOMA_SWIM_BOUNDS = {
	across: 1.5,
	up: 0.58,
	down: -0.78,
	depth: 0.7
} as const;

const SOMA_MAX_SPEED = 0.32;

function clamp(value: number, low: number, high: number) {
	return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
	const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

function wrap01(value: number) {
	return ((value % 1) + 1) % 1;
}

/** Signed shortest hue distance from a to b, in turns (-0.5..0.5). */
export function somaHueDelta(a: number, b: number) {
	return ((((b - a + 0.5) % 1) + 1) % 1) - 0.5;
}

/** Integer hash to the unit interval; deterministic per (a, b, c). */
export function somaHashUnit(a: number, b: number, c: number) {
	let h = Math.imul((a | 0) ^ 0x9e3779b1, 0x85ebca6b);
	h = Math.imul(h ^ ((b | 0) + 0x632be5ab), 0xc2b2ae35);
	h = Math.imul(h ^ ((c | 0) + 0x7f4a7c15), 0x27d4eb2f);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return (h >>> 0) / 4294967296;
}

/** Pull a hue part of the way toward its nearest bioluminescent anchor. */
export function somaBioluminescentHue(hue: number, amount = 0.5) {
	const safe = wrap01(Number.isFinite(hue) ? hue : 0.5);
	let best: number = SOMA_BIO_ANCHORS[0];
	let bestDistance = Infinity;
	for (const anchor of SOMA_BIO_ANCHORS) {
		const distance = Math.abs(somaHueDelta(safe, anchor));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = anchor;
		}
	}
	return wrap01(safe + somaHueDelta(safe, best) * clamp(amount, 0, 1));
}

export type SomaPaletteRoles = {
	/** Membrane and its fresnel edge. */
	base: number;
	/** Canals, organs and travelling light packets. */
	accent: number;
	/** Trailing tendrils and the ring canal. */
	rim: number;
	/** The water itself. */
	ink: number;
	saturation: number;
};

/**
 * Palette roles, not a hue sweep. The director's harmonic palette chooses
 * which bioluminescent family each role lands in; minor keys lean the accent
 * toward magenta/violet and major keys toward cyan/green. The water stays a
 * deep indigo so the frame is always dark with luminous accents.
 */
export function somaPaletteRoles(
	palette: { baseHue: number; accentHue: number; rimHue: number; saturation: number },
	keyMode: 'major' | 'minor' | 'unknown',
	out: SomaPaletteRoles
): SomaPaletteRoles {
	const base = somaBioluminescentHue(palette.baseHue, 0.55);
	let accent = somaBioluminescentHue(palette.accentHue, 0.5);
	if (keyMode !== 'unknown') {
		const modeTarget = keyMode === 'minor' ? 0.86 : 0.42;
		accent = wrap01(accent + somaHueDelta(accent, modeTarget) * 0.22);
	}
	const separation = somaHueDelta(base, accent);
	if (Math.abs(separation) < 0.14) accent = wrap01(base + (separation < 0 ? -0.14 : 0.14));
	let rim = somaBioluminescentHue(palette.rimHue, 0.5);
	if (Math.abs(somaHueDelta(rim, base)) < 0.07 && Math.abs(somaHueDelta(rim, accent)) < 0.2) {
		rim = somaBioluminescentHue(base + 0.36, 0.6);
	}
	out.base = base;
	out.accent = accent;
	out.rim = rim;
	out.ink = wrap01(SOMA_INK_HUE + clamp(somaHueDelta(SOMA_INK_HUE, base), -0.25, 0.25) * 0.22);
	out.saturation = clamp(Number.isFinite(palette.saturation) ? palette.saturation : 0.8, 0.74, 0.95);
	return out;
}

export type SomaSwimInput = {
	dt: number;
	/** Continuous song beats (renderer conveyor). */
	beats: number;
	energy: number;
	/** Response-profile motion multiplier. */
	motion: number;
	reach: number;
	stillness: number;
	bloom: number;
	dormancy: number;
	openness: number;
	silence: number;
	/** Horizontal camera right and forward unit vectors (y = 0). */
	right: Readonly<SomaVec3>;
	forward: Readonly<SomaVec3>;
};

/**
 * Damped-spring swimmer. Position, velocity and the bell's travel axis are
 * continuous; a waypoint change only changes the spring target, so the body
 * can never jump. The axis tilts the bell apex-first into its direction of
 * travel and the trailing tendrils read the local velocity.
 */
export class SomaSwimmer {
	readonly position: SomaVec3 = [0, 0, 0];
	readonly velocity: SomaVec3 = [0, 0, 0];
	readonly target: SomaVec3 = [0, 0, 0];
	readonly axis: SomaVec3 = [0, 1, 0];
	/** Unbounded stroke cycle; one cycle is one contraction. */
	strokePhase = 0;
	/** 0..1 bell contraction for this frame. */
	stroke = 0;
	/** Unbounded tendril-undulation phase. */
	wavePhase = 0;
	private seedWord = 0;
	private initialized = false;
	private readonly scratch: SomaVec3 = [0, 0, 0];

	reset(seed: number) {
		this.seedWord = Math.floor(clamp(Number.isFinite(seed) ? seed : 0.5, 0, 1) * 0xffffff);
		this.initialized = false;
		this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
		this.axis[0] = 0;
		this.axis[1] = 1;
		this.axis[2] = 0;
		this.strokePhase = somaHashUnit(this.seedWord, 3, 1);
		this.stroke = 0;
		this.wavePhase = somaHashUnit(this.seedWord, 5, 2) * 40;
	}

	/** Waypoint for a half-phrase index, written into `out` (world space). */
	waypoint(index: number, input: SomaSwimInput, out: SomaVec3): SomaVec3 {
		const i = Math.floor(index);
		const side = (i % 2 === 0 ? -1 : 1) * (somaHashUnit(this.seedWord, i, 7) < 0.22 ? -1 : 1);
		const spread = clamp(1 + input.reach * 0.2 - input.stillness * 0.35, 0.55, 1.2);
		const across =
			side * (0.72 + somaHashUnit(this.seedWord, i, 11) * 0.7) * spread;
		const up =
			-0.12 +
			somaHashUnit(this.seedWord, i, 13) * 0.42 +
			input.bloom * 0.16 +
			input.openness * 0.04 -
			input.dormancy * 0.5;
		const depth = (somaHashUnit(this.seedWord, i, 17) - 0.5) * 1.2;
		const x = clamp(across, -SOMA_SWIM_BOUNDS.across, SOMA_SWIM_BOUNDS.across);
		const y = clamp(up, SOMA_SWIM_BOUNDS.down, SOMA_SWIM_BOUNDS.up);
		const z = clamp(depth, -SOMA_SWIM_BOUNDS.depth, SOMA_SWIM_BOUNDS.depth);
		out[0] = input.right[0] * x + input.forward[0] * z;
		out[1] = y - 0.04;
		out[2] = input.right[2] * x + input.forward[2] * z;
		return out;
	}

	update(input: SomaSwimInput) {
		const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, 0.1);
		const beats = Number.isFinite(input.beats) ? input.beats : 0;
		const energy = clamp(input.energy, 0, 1);
		const motion = clamp(input.motion, 0, 2);
		const awake = 1 - clamp(input.silence, 0, 1) * 0.85;
		const slot = beats / SOMA_BEATS_PER_WAYPOINT;
		const index = Math.floor(slot);
		const turn = smoothstep(0.62, 1, slot - index);

		this.waypoint(index, input, this.target);
		this.waypoint(index + 1, input, this.scratch);
		for (let axis = 0; axis < 3; axis += 1) {
			this.target[axis] += (this.scratch[axis] - this.target[axis]) * turn;
		}

		if (!this.initialized) {
			// Enter mid-glide toward the current waypoint instead of parked on it.
			this.waypoint(index - 1, input, this.scratch);
			for (let axis = 0; axis < 3; axis += 1) {
				this.position[axis] = this.scratch[axis] + (this.target[axis] - this.scratch[axis]) * 0.82;
				this.velocity[axis] = (this.target[axis] - this.position[axis]) * 0.35;
			}
			this.initialized = true;
		}

		// Swim strokes: a quick contraction and slow relaxation. Their rate
		// follows smoothed energy, and each stroke gets its own seeded length, so
		// the pulse breathes with the music instead of ticking like a metronome.
		const strokeIndex = Math.floor(this.strokePhase);
		const strokeRate =
			(0.12 + energy * 0.26) *
			(0.78 + somaHashUnit(this.seedWord, strokeIndex, 23) * 0.44) *
			(1 - clamp(input.stillness, 0, 1) * 0.6) *
			motion *
			awake;
		this.strokePhase += dt * strokeRate;
		const f = this.strokePhase - Math.floor(this.strokePhase);
		const pulse = f < 0.2 ? smoothstep(0, 0.2, f) : Math.exp(-(f - 0.2) * 5.2);
		const amplitude =
			(0.35 + energy * 0.65) *
			(1 - clamp(input.stillness, 0, 1) * 0.75) *
			(1 - clamp(input.dormancy, 0, 1) * 0.6);
		this.stroke = clamp(pulse * amplitude * awake, 0, 1);

		// Near-critically damped: arrives within a few seconds, never overshoots
		// into a bounce, and each stroke adds a visible surge of thrust.
		const stiffness = (0.12 + energy * 0.16) * motion * (0.65 + this.stroke * 1.0) * awake;
		const damping = 1.8 * Math.sqrt(Math.max(stiffness, 1e-4));
		let speed2 = 0;
		for (let axis = 0; axis < 3; axis += 1) {
			const accel =
				(this.target[axis] - this.position[axis]) * stiffness - this.velocity[axis] * damping;
			this.velocity[axis] += accel * dt;
			speed2 += this.velocity[axis] * this.velocity[axis];
		}
		const speedLimit = SOMA_MAX_SPEED * Math.max(0.2, motion);
		if (speed2 > speedLimit * speedLimit) {
			const scale = speedLimit / Math.sqrt(speed2);
			for (let axis = 0; axis < 3; axis += 1) this.velocity[axis] *= scale;
		}
		for (let axis = 0; axis < 3; axis += 1) this.position[axis] += this.velocity[axis] * dt;

		this.wavePhase += dt * (0.5 + energy * 1.1 + this.stroke * 1.8) * motion * awake;

		// The bell leans apex-first into horizontal travel.
		const tiltX = this.velocity[0] * 1.9;
		const tiltZ = this.velocity[2] * 1.9;
		const length = Math.hypot(tiltX, 1, tiltZ);
		const follow = 1 - Math.exp(-dt * 1.6);
		this.axis[0] += (tiltX / length - this.axis[0]) * follow;
		this.axis[1] += (1 / length - this.axis[1]) * follow;
		this.axis[2] += (tiltZ / length - this.axis[2]) * follow;
		const axisLength = Math.hypot(this.axis[0], this.axis[1], this.axis[2]) || 1;
		this.axis[0] /= axisLength;
		this.axis[1] /= axisLength;
		this.axis[2] /= axisLength;
	}
}
