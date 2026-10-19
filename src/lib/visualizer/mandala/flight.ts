// Mandala's flight: the camera's endless journey down the self-similar
// tunnel. Travel is measured in log-depth, so the picture is zoom invariant
// and the walls expand inward and outward forever. Every phase the shader
// needs (cell rows, hyperbolic band phase, phyllotaxis lattice offsets,
// sconce positions, beat rings) is integrated here from increments, never
// derived from an absolute clock, so a new song (whose clocks restart) and a
// renderer remount both carry the flight on without a jump.

import { MANDALA_HYPERBOLIC } from './look';

function wrap(value: number, period: number): number {
	return ((value % period) + period) % period;
}

/** Hyperbolic distance centre -> edge midpoint of the central {p,q} p-gon. */
export function hyperbolicEdge(p: number, q: number): number {
	return Math.acosh(Math.cos(Math.PI / q) / Math.sin(Math.PI / p));
}

/** Band-model translation period of a {p,q} tiling (p even). */
export function hyperbolicPeriod(variant: number): number {
	const [p, q] = MANDALA_HYPERBOLIC[Math.max(0, Math.min(3, Math.round(variant)))];
	return 2 * hyperbolicEdge(p, q);
}

/** One tunnel surface's travel: cell rows, hyperbolic phase, phyllotaxis offsets. */
export class LayerTravel {
	/** Whole cell rows passed, wrapped at 2^16 (exact in an f32). */
	row = 0;
	/** Fractional row, 0..1. */
	frac = 0;
	hyper = 0;
	/** Phyllotaxis offset along the axis (cells, 0..rise) and around (turns, 0..1). */
	phylloY = 0;
	phylloTurn = 0;
	/** Seeds passed (for spectrum hashing), wrapped at 4096. */
	seedRow = 0;

	advance(
		cells: number,
		hyperScale: number,
		hyperPeriods: readonly number[],
		divergence: number,
		rise: number
	): void {
		if (!Number.isFinite(cells) || cells === 0) return;
		this.frac += cells;
		const whole = Math.floor(this.frac);
		if (whole !== 0) {
			this.frac -= whole;
			this.row = wrap(this.row + whole, 65_536);
		}
		this.hyper += cells * hyperScale;
		// Wrap the band phase only by a period every visible hyperbolic slot
		// shares, so no slot ever jumps; mid-fade between two tilings it just
		// accumulates (a few seconds is nowhere near f32 trouble).
		const unique = hyperPeriods.length > 0 && hyperPeriods.every((p) => Math.abs(p - hyperPeriods[0]) < 1e-6);
		if (unique) this.hyper = wrap(this.hyper, hyperPeriods[0]);
		else if (hyperPeriods.length === 0) this.hyper = wrap(this.hyper, 1024);
		const step = Math.max(0.02, rise);
		this.phylloY += cells;
		const seeds = Math.floor(this.phylloY / step);
		if (seeds !== 0) {
			this.phylloY -= seeds * step;
			this.phylloTurn = wrap(this.phylloTurn - seeds * divergence, 1);
			this.seedRow = wrap(this.seedRow + seeds, 4096);
		}
		if (this.phylloY < 0 || this.phylloY >= step) {
			// The rise itself glided: keep the offset inside one step.
			const extra = Math.floor(this.phylloY / step);
			this.phylloY -= extra * step;
			this.phylloTurn = wrap(this.phylloTurn - extra * divergence, 1);
		}
	}
}

export type FlightInput = {
	dt: number;
	/** Travel rate in log-depth units per second (already character-driven). */
	speed: number;
	/** 0..1 kick push envelope for this frame. */
	kick: number;
	/** Cells per log unit for wall and screen this frame. */
	wallCells: number;
	screenCells: number;
	/** The screen sits nearer, so it travels a little faster. */
	screenRate: number;
	wallHyperScale: number;
	screenHyperScale: number;
	wallHyperPeriods: readonly number[];
	screenHyperPeriods: readonly number[];
	divergence: number;
	wallRise: number;
	screenRise: number;
	corkscrew: number;
	wander: number;
	offset: number;
	/** 0..1 how restless the camera is (tempo, motion). */
	restless: number;
	silence: number;
	sconceSpacing: number;
	sconceTurn: number;
};

const RING_COUNT = 6;

export class MandalaFlight {
	readonly wall = new LayerTravel();
	readonly screen = new LayerTravel();
	/** Seconds of flight, for slow phases (wrapped). */
	clock = 0;
	roll = 0;
	yaw = 0;
	pitch = 0;
	offsetX = 0;
	offsetY = 0;
	/** Smoothed speed actually flown (log units / s). */
	velocity = 0.12;
	/** Log-depth travelled this frame (feedback zoom follows it). */
	stepLog = 0;
	stepRoll = 0;
	private wanderPhase: [number, number, number, number];
	private previousYaw = 0;
	sconcePhase = 0;
	sconceAngle = 0;
	rigPhase = 0;
	/** Beat rings: camera depth and strength; z <= 0 is an empty slot. */
	readonly ringZ = new Float32Array(RING_COUNT);
	readonly ringS = new Float32Array(RING_COUNT);
	/** Launch strength and age per ring: rings fade in, never pop. */
	private readonly ringPeak = new Float32Array(RING_COUNT);
	private readonly ringAge = new Float32Array(RING_COUNT);
	private ringNext = 0;

	constructor(seed: number) {
		const s = Number.isFinite(seed) ? seed : 0.5;
		this.wanderPhase = [s * 17.3, s * 29.1 + 1.3, s * 41.7 + 2.1, s * 53.9 + 0.7];
		this.roll = (s * 6.283) % 6.283;
	}

	/** A new source: keep the whole flight, only the hashes of the future move. */
	continueSource(seed: number): void {
		const s = Number.isFinite(seed) ? seed : 0.5;
		// Nudge the wander toward a new course, smoothly: phases only advance.
		this.wanderPhase[2] += 0.4 + s * 0.6;
	}

	/** A beat ring rises out of the depths; strength 0..~1.6. */
	launchRing(strength: number): void {
		if (!(strength > 0.02)) return;
		this.ringZ[this.ringNext] = 42;
		this.ringS[this.ringNext] = 0;
		this.ringPeak[this.ringNext] = strength;
		this.ringAge[this.ringNext] = 0;
		this.ringNext = (this.ringNext + 1) % RING_COUNT;
	}

	update(input: FlightInput): void {
		const dt = Math.min(0.25, Math.max(0, input.dt));
		this.clock = wrap(this.clock + dt, 86_400);
		// The kick is a push: the camera surges, then the tunnel's drag eases it back.
		const target = Math.max(0, input.speed) * (1 - input.silence * 0.85) + input.kick * 0.55;
		this.velocity += (target - this.velocity) * (1 - Math.exp(-dt * (input.kick > 0.2 ? 14 : 3)));
		const log = this.velocity * dt;
		this.stepLog = log;
		this.wall.advance(
			log * input.wallCells,
			input.wallHyperScale,
			input.wallHyperPeriods,
			input.divergence,
			input.wallRise
		);
		this.screen.advance(
			log * input.screenCells * input.screenRate,
			input.screenHyperScale,
			input.screenHyperPeriods,
			input.divergence,
			input.screenRise
		);

		// Sconces are fixed in log-depth: one passes every `sconceSpacing` of
		// travel, each turned a little further round the spiral.
		const spacing = Math.max(0.2, input.sconceSpacing);
		this.sconcePhase += log;
		while (this.sconcePhase >= spacing) {
			this.sconcePhase -= spacing;
			this.sconceAngle = wrap(this.sconceAngle + input.sconceTurn, Math.PI * 2);
		}
		if (this.sconcePhase < 0) this.sconcePhase = wrap(this.sconcePhase, spacing);

		// Wander: the course drifts on incommensurate phases, faster when the
		// music is restless; yaw/pitch and lateral offset never sit still.
		const pace = (0.05 + input.restless * 0.22) * (1 - input.silence * 0.6);
		this.wanderPhase[0] += dt * pace * 1.0;
		this.wanderPhase[1] += dt * pace * 0.618;
		this.wanderPhase[2] += dt * pace * 0.83;
		this.wanderPhase[3] += dt * pace * 0.47;
		for (let i = 0; i < 4; i += 1) this.wanderPhase[i] = wrap(this.wanderPhase[i], Math.PI * 2 * 1000);
		const [a, b, c, d] = this.wanderPhase;
		const yawTarget = input.wander * (Math.sin(a) * 0.65 + Math.sin(b * 2.1 + 0.7) * 0.35);
		const pitchTarget = input.wander * 0.7 * (Math.sin(c * 1.3 + 1.1) * 0.6 + Math.sin(d * 2.7) * 0.4);
		const ease = 1 - Math.exp(-dt * 2.2);
		this.yaw += (yawTarget - this.yaw) * ease;
		this.pitch += (pitchTarget - this.pitch) * ease;
		this.offsetX += (input.offset * Math.cos(c + a * 0.5) - this.offsetX) * ease;
		this.offsetY += (input.offset * Math.sin(d * 1.4 + b) - this.offsetY) * ease;

		// Roll: a slow base turn, a corkscrew tied to the distance flown, and a
		// bank into every turn of the course.
		const yawRate = dt > 0 ? (this.yaw - this.previousYaw) / dt : 0;
		this.previousYaw = this.yaw;
		const rollStep =
			dt * 0.025 * (1 - input.silence * 0.7) + log * input.corkscrew * 2.4 - yawRate * dt * 0.9;
		this.stepRoll = rollStep;
		this.roll = wrap(this.roll + rollStep, Math.PI * 2);
		this.rigPhase = wrap(this.rigPhase + dt * (0.04 + input.restless * 0.08), Math.PI * 2);

		// Rings rush toward the camera, faster with the travel.
		const ringRate = 2.6 + this.velocity * 2.5;
		for (let i = 0; i < RING_COUNT; i += 1) {
			if (this.ringZ[i] <= 0) continue;
			this.ringZ[i] *= Math.exp(-dt * ringRate);
			this.ringAge[i] += dt;
			const rise = Math.min(1, this.ringAge[i] / 0.18);
			this.ringS[i] = this.ringPeak[i] * rise * rise * (3 - 2 * rise);
			if (this.ringZ[i] < 0.12) {
				this.ringZ[i] = 0;
				this.ringS[i] = 0;
			}
		}
	}
}
