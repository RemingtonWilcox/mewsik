// Mandala's voyage: every world's own endless motion, integrated from
// increments so a new song (whose clocks restart) and a renderer remount both
// carry it on without a jump. Each world keeps its phase even while it is not
// on screen, so a world that comes back resumes where it was.
//
// Phases are in each world's natural period: one layer of the Kaliset zoom,
// one self-similar step of the Julia dive (a factor lambda), one x3 step into
// the sponge, one cell of the cavern... so only the fractional part reaches
// the shader and nothing ever runs out of float precision.
//
// The camera is not an authored path. A Roamer travels a box of good
// viewpoints (look yaw and pitch, roll, where the mandala's eye sits in the
// frame, how close, the lens, the orbit distance), picking new destinations
// at irregular times and gliding there on critically damped springs, with a
// wander on top: tempo sets its pace, energy its restlessness, kicks nudge
// it and a change of music sends it somewhere new. Slow drift lanes move the
// fractal constants, the orbit and the palette mapping along non-repeating
// noise, so a world's seamless loop never shows the same frame twice.

import { MANDALA_WORLDS } from './look';
import { Roamer, Wander } from '../motion';

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
	/** 0..1 the music's tempo: the pace the camera roams at. */
	tempo: number;
	silence: number;
};

/** Roamer axes, each -1..1. */
const ROAM = { yaw: 0, pitch: 1, roll: 2, panX: 3, panY: 4, zoom: 5, focal: 6, dolly: 7, lampX: 8, lampY: 9, reach: 10, extent: 11, swing: 12 } as const;
/** Drift lanes: four structure morphs, the orbit's pace, the palette's pace, the spiral's eye, the tint. */
const LANE = { morph: 0, orbit: 4, paint: 5, eye: 6, tint: 7 } as const;

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
	/** Look offsets (3D worlds), about -1..1 scaled by the drift. */
	yaw = 0;
	pitch = 0;
	/** Extra roll of the whole view, radians. */
	roll = 0;
	/** Where the planes' centre sits in the frame (screen heights from the middle). */
	panX = 0;
	panY = 0;
	/** Log zoom of the planes about their centre (+ is closer). */
	zoom = 0;
	/** Lens multiplier for the raymarched worlds. */
	focal = 1;
	/** Orbit distance / channel offset, -1..1. */
	dolly = 0;
	/** The 3D lamp's offset from the camera, in its reach (-1..1). */
	lampX = 0;
	lampY = 0;
	/** The lamp's reach multiplier. */
	lampReach = 1;
	/** How far the planes' pattern carries from its centre, screen heights. */
	extent = 1.2;
	/** The orbiting worlds' angle, radians: integrated, plus the roamer's swing. */
	orbit = 0;
	private orbitBase = 0;
	/** Palette mapping offset, integrated and wrapped at 2 (the shader folds it). */
	paint = 0;
	/** The spiral's eye offset from its mirror centre, -1..1. */
	eye = 0;
	/** Hue turn of the palette's authored stops, radians: each palette is a continuum. */
	tint = 0;
	/** Four slow structure morphs, -1..1, each world reads them in its own terms. */
	readonly morph = new Float32Array(4);
	private readonly roamer: Roamer;
	private readonly lanes: Wander;

	constructor(seed: number) {
		const s = Number.isFinite(seed) ? seed : 0.5;
		for (let i = 0; i < WORLD_COUNT; i += 1) {
			this.phase[i] = (s * 7.31 * (i + 1)) % 1;
			this.turn[i] = (s * 6.283 * (i + 3)) % 6.283;
		}
		this.roamer = new Roamer(13, s + 0.137, { meanHold: 13, minHold: 4, response: 5, wander: 0.25, wanderPeriod: 23 });
		// Incommensurate periods, long enough that a lane reads as drift, not motion.
		this.lanes = new Wander(8, s + 0.613, [31, 43, 57, 71, 37, 53, 47, 64]);
		this.orbitBase = s * 6.283;
		this.paint = (s * 3.7) % 2;
		this.compose(0.5, 1);
	}

	/** A new source: keep the whole voyage, only the course of the future moves. */
	continueSource(): void {
		this.redirect();
	}

	/** A change of music: the camera heads somewhere new now. */
	redirect(): void {
		this.roamer.redirect();
	}

	/** A heard kick: the view leans in a little and the look flinches. */
	kick(strength: number): void {
		if (!(strength > 0)) return;
		const k = Math.min(1, strength);
		this.roamer.impulse(ROAM.zoom, k * 0.35);
		this.roamer.impulse(ROAM.dolly, -k * 0.25);
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
		// Tempo sets the camera's pace, energy and motion its restlessness;
		// silence slows it to a drift without stopping it.
		const hush = 1 - input.silence * 0.65;
		const tempo = Number.isFinite(input.tempo) ? Math.min(1, Math.max(0, input.tempo)) : 0.5;
		const pace = (0.75 + tempo * 0.75) * hush;
		this.roamer.update(dt, pace, input.restless);
		this.lanes.update(dt, (0.7 + tempo * 0.6) * hush);
		const lane = this.lanes.value;
		// The orbit always moves on, at a pace that wanders (never a loop),
		// and never stands still even when the music barely travels.
		const orbitPace = 0.022 * hush + this.velocity * 0.34 * (0.3 + 0.7 * (lane[LANE.orbit] * 0.5 + 0.5));
		this.orbitBase = wrap(this.orbitBase + orbitPace * dt, Math.PI * 2);
		// The palette mapping drifts: what burns hot and what stays deep moves on.
		this.paint = wrap(this.paint + dt * (0.004 + 0.01 * (lane[LANE.paint] * 0.5 + 0.5)) * hush, 2);
		this.compose(input.drift, dt > 0 ? 1 - Math.exp(-dt * 2.5) : 1);
	}

	private compose(drift: number, ease: number): void {
		const r = this.roamer.value;
		const amp = 0.35 + Math.min(1, Math.max(0, drift)) * 0.65;
		const to = (current: number, goal: number) => current + (goal - current) * ease;
		this.yaw = to(this.yaw, r[ROAM.yaw] * amp);
		this.pitch = to(this.pitch, r[ROAM.pitch] * amp * 0.75);
		this.roll = to(this.roll, r[ROAM.roll] * 0.45 * amp);
		this.panX = to(this.panX, r[ROAM.panX] * 0.34 * amp);
		this.panY = to(this.panY, r[ROAM.panY] * 0.17 * amp);
		this.zoom = to(this.zoom, r[ROAM.zoom] * 0.38);
		this.focal = to(this.focal, Math.exp(r[ROAM.focal] * 0.2));
		this.dolly = to(this.dolly, Math.max(-1, Math.min(1, r[ROAM.dolly])));
		this.orbit = this.orbitBase + r[ROAM.swing] * 0.9;
		this.lampX = to(this.lampX, r[ROAM.lampX]);
		this.lampY = to(this.lampY, r[ROAM.lampY]);
		// The lamp's reach only ever grows a little or eases back a little:
		// never a dim world.
		this.lampReach = to(this.lampReach, Math.exp(0.08 + r[ROAM.reach] * 0.2));
		// From a medallion with black round it to a field past every edge.
		this.extent = to(this.extent, 0.65 * Math.exp((Math.max(-1, Math.min(1, r[ROAM.extent])) + 1) * 0.75));
		const lane = this.lanes.value;
		for (let i = 0; i < 4; i += 1) this.morph[i] = lane[LANE.morph + i];
		this.eye = lane[LANE.eye];
		// Small enough that neighbouring families (emerald, honey) never meet.
		this.tint = lane[LANE.tint] * 0.3;
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
