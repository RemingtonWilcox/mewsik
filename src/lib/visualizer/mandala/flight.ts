// Mandala's voyage: every world's own endless motion, integrated from
// increments so a new song (whose clocks restart) and a renderer remount both
// carry it on without a jump. Each world keeps its phase even while it is not
// on screen, so a world that comes back resumes where it was.
//
// Phases are in each world's natural period: one layer of the Kaliset zoom,
// one self-similar step of the Julia dive (a factor lambda), one x3 step into
// the sponge, one cell of the cavern... so only the fractional part reaches
// the shader and nothing ever runs out of float precision.

import { MANDALA_WORLDS } from './look';

const WORLD_COUNT = MANDALA_WORLDS.length;
/** Phases wrap here: a multiple of every period a shader takes them modulo. */
const PHASE_WRAP = 840;

function wrap(value: number, period: number): number {
	return ((value % period) + period) % period;
}

export type VoyageInput = {
	dt: number;
	/** Travel rate in log-zoom units per second (already character-driven). */
	speed: number;
	/** Per world, phase units per log unit of travel. */
	rates: readonly number[];
	/** Per world, roll in radians per second at unit spin. */
	spin: number;
	/** 0..1 transient travel push for this frame. */
	surge: number;
	/** 0..1 how restless the camera's look is (tempo, motion). */
	restless: number;
	/** 0..1 how far the look wanders. */
	drift: number;
	silence: number;
};

export class MandalaVoyage {
	/** Per world: phase in its own period units, wrapped at PHASE_WRAP. */
	readonly phase = new Float64Array(WORLD_COUNT);
	/** Per world: roll / orbit angle, radians. */
	readonly turn = new Float64Array(WORLD_COUNT);
	/** Smoothed travel actually flown, log units per second. */
	velocity = 0.12;
	/** Log travel this frame (the feedback zoom follows it). */
	stepLog = 0;
	stepTurn = 0;
	yaw = 0;
	pitch = 0;
	private wanderPhase: [number, number, number, number];

	constructor(seed: number) {
		const s = Number.isFinite(seed) ? seed : 0.5;
		this.wanderPhase = [s * 17.3, s * 29.1 + 1.3, s * 41.7 + 2.1, s * 53.9 + 0.7];
		for (let i = 0; i < WORLD_COUNT; i += 1) {
			this.phase[i] = (s * 7.31 * (i + 1)) % 1;
			this.turn[i] = (s * 6.283 * (i + 3)) % 6.283;
		}
	}

	/** A new source: keep the whole voyage, only the course of the future moves. */
	continueSource(seed: number): void {
		const s = Number.isFinite(seed) ? seed : 0.5;
		this.wanderPhase[2] += 0.4 + s * 0.6;
	}

	update(input: VoyageInput): void {
		const dt = Math.min(0.25, Math.max(0, input.dt));
		// The surge is a push: the flight leaps forward, then drag eases it back.
		const target = Math.max(0, input.speed) * (1 - input.silence * 0.85) + input.surge;
		const rate = input.surge > this.velocity * 0.5 ? 18 : 3;
		this.velocity += (target - this.velocity) * (1 - Math.exp(-dt * rate));
		const log = this.velocity * dt;
		this.stepLog = log;
		const turnStep = dt * input.spin * (1 - input.silence * 0.7);
		this.stepTurn = turnStep;
		for (let i = 0; i < WORLD_COUNT; i += 1) {
			this.phase[i] = wrap(this.phase[i] + log * (input.rates[i] ?? 1), PHASE_WRAP);
			this.turn[i] = wrap(this.turn[i] + turnStep, Math.PI * 2);
		}
		// The look wanders on incommensurate phases, faster when the music is restless.
		const pace = (0.04 + input.restless * 0.2) * (1 - input.silence * 0.6);
		this.wanderPhase[0] += dt * pace * 1.0;
		this.wanderPhase[1] += dt * pace * 0.618;
		this.wanderPhase[2] += dt * pace * 0.83;
		this.wanderPhase[3] += dt * pace * 0.47;
		for (let i = 0; i < 4; i += 1) this.wanderPhase[i] = wrap(this.wanderPhase[i], Math.PI * 2 * 1000);
		const [a, b, c, d] = this.wanderPhase;
		const yawTarget = input.drift * (Math.sin(a) * 0.65 + Math.sin(b * 2.1 + 0.7) * 0.35);
		const pitchTarget = input.drift * 0.7 * (Math.sin(c * 1.3 + 1.1) * 0.6 + Math.sin(d * 2.7) * 0.4);
		const ease = 1 - Math.exp(-dt * 1.6);
		this.yaw += (yawTarget - this.yaw) * ease;
		this.pitch += (pitchTarget - this.pitch) * ease;
	}
}

/**
 * The fold spring: a heard transient kicks it and it rings out in a few
 * hundred milliseconds. The shader adds it to fold angles and constants, so
 * the geometry itself flinches on the beat instead of the frame flashing.
 */
export class FoldSpring {
	value = 0;
	velocity = 0;
	private sign = 1;

	kick(strength: number): void {
		if (!(strength > 0)) return;
		this.velocity += strength * this.sign * 9;
		this.sign = -this.sign;
	}

	update(dt: number, hz = 3.2, damping = 0.5): void {
		const step = Math.min(0.05, Math.max(0, dt));
		const omega = Math.PI * 2 * hz;
		// Two half steps keep the integration stable at low frame rates.
		for (let i = 0; i < 2; i += 1) {
			const h = step / 2;
			const accel = -omega * omega * this.value - 2 * damping * omega * this.velocity;
			this.velocity += accel * h;
			this.value += this.velocity * h;
		}
		if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
			this.value = 0;
			this.velocity = 0;
		}
	}
}

type Complex = [number, number];

function cmul(a: Complex, b: Complex): Complex {
	return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

function cpow(z: Complex, n: number): Complex {
	let out: Complex = [1, 0];
	for (let i = 0; i < n; i += 1) out = cmul(out, z);
	return out;
}

/**
 * One Julia dive: f(z) = z^n + c, zoomed into forever about a repelling
 * fixed point z* of f. Near z* the Julia set is self-similar with the
 * multiplier lambda = f'(z*): the window z* + lambda^-t * u shows the same
 * picture at t and t + 1, so the dive is infinite with a bounded zoom.
 *
 * The dive is chosen by its multiplier, not by c: lambda = r e^(i theta)
 * with r a little over 1 makes z* the eye of a spiral of rosettes (theta
 * near p/q gives q arms), then z* = (lambda / n)^(1/(n-1)) and
 * c = z* - z*^n. Steering theta and r is continuous, so the set morphs
 * without a jump.
 */
export class JuliaTrack {
	c: Complex = [-0.75, 0.1];
	z: Complex = [1.2, 0];
	lambda: Complex = [1.3, 0];
	private theta = 0;
	private radius = 1.3;
	private tracking = false;

	constructor(readonly power: number) {}

	/** Steer the multiplier toward r e^(i theta); `rate` is the glide speed. */
	steer(theta: number, radius: number, dt: number, rate: number): void {
		const k = this.tracking ? 1 - Math.exp(-dt * rate) : 1;
		// Unwrapped angle: the fixed point never jumps branch.
		let delta = theta - this.theta;
		delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
		this.theta += delta * k;
		this.radius += (radius - this.radius) * k;
		this.tracking = true;
		const n = this.power;
		const logMag = (Math.log(Math.max(1.02, this.radius)) - Math.log(n)) / (n - 1);
		const arg = this.theta / (n - 1);
		const z: Complex = [Math.exp(logMag) * Math.cos(arg), Math.exp(logMag) * Math.sin(arg)];
		const zn = cpow(z, n);
		this.z = z;
		this.c = [z[0] - zn[0], z[1] - zn[1]];
		this.lambda = [this.radius * Math.cos(this.theta), this.radius * Math.sin(this.theta)];
	}

	/**
	 * The dive's window at fractional phase f, started `lead` iterations
	 * early: W * lambda^-(f + lead). The escape iteration carries every
	 * pixel forward through those steps, which is the Poincare function
	 * (the exact inverse of the linearisation at z*): the picture at f = 1
	 * is then exactly the picture at f = 0, one iteration deeper, with no
	 * cross-fade. `lead` is chosen so the start sits ~3 % of W from z*.
	 */
	window(f: number, size: number): { scale: Complex; lead: number } {
		const mag = Math.max(1.02, Math.hypot(...this.lambda));
		const arg = Math.atan2(this.lambda[1], this.lambda[0]);
		const lead = Math.min(56, Math.max(4, Math.ceil(Math.log(33) / Math.log(mag))));
		const t = f + lead;
		const m = size * Math.hypot(...this.z) * Math.exp(-t * Math.log(mag));
		return { scale: [m * Math.cos(-t * arg), m * Math.sin(-t * arg)], lead };
	}

	/** Radians the picture turns per period (the spiral's pitch). */
	get periodTurn(): number {
		return Math.abs(Math.atan2(this.lambda[1], this.lambda[0]));
	}

	/** Natural-log zoom per period (how far one self-similar step dives). */
	get periodLog(): number {
		return Math.log(Math.max(1.02, Math.hypot(...this.lambda)));
	}
}
