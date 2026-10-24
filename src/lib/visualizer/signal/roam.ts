// Signal's organic motion: where the bench stands, where the camera looks
// from, and how the hero drifts, all travelling on paths that never close.
//
//   compose  a Roamer through each bench's room of arrangements (layouts.ts
//            SignalCompose: hero pan, lift and size, trace spacing and reach,
//            horizon depth). Long holds and slow springs: the bench rearranges
//            itself the way someone would slide instruments along a desk.
//   camera   a Roamer around the camera regime the genome picked (pitch,
//            height, focal length, yaw). Regimes are regions, not paths.
//   noise    lanes of motion.ts noise for the hero's wobble and breath,
//            sampled on the renderer's own music-driven clocks, so they keep
//            their pace from the music but never come back around.
//
// Tempo sets the rate, energy the restlessness, a genre shift sends both
// roamers somewhere new, and a landing (the conductor's ring-out) kicks the
// camera. The state lives in the renderer memory, so a remount resumes the
// same journey.

import { Roamer, noise1 } from '$lib/visualizer/motion';
import { SIGNAL_COMPOSE_DIMS } from './layouts';

/** Camera roam dimensions: pitch, height, focal, yaw. */
export const SIGNAL_CAMERA_ROAM_DIMS = 4;

/** Noise lanes: each wobble reads its own non-repeating path. */
export const SIGNAL_NOISE_LANE = {
	/** Hero yaw wobble, on the figure phase. */
	yaw: 1,
	/** Acoustic hand wander, on the grain clock. */
	organic: 2,
	/** Ambient breath, on the breath clock. */
	breath: 3,
	/** Hero drift across its face, x and y. */
	driftX: 4,
	driftY: 5
} as const;

export type SignalRoamDrive = {
	/** 0..1 tempo (60..180 bpm). */
	tempo: number;
	/** 0..1 energy. */
	energy: number;
	/** 0..1 conductor ring-out (a landing just happened when it jumps to 1). */
	ringOut: number;
};

/**
 * The bench's recent compositions, so each part can follow the roam a little
 * behind the others: a rearrangement travels through the bench piece by
 * piece, the hero first and each trace after its own lag, instead of every
 * part sliding at once. Recorded on music time (nothing is written while the
 * roam holds still in silence).
 */
export class SignalComposeEcho {
	private readonly ring: Float32Array;
	private head = 0;
	private filled = 0;
	private carry = 0;
	private readonly size: number;

	constructor(
		readonly dims = SIGNAL_COMPOSE_DIMS,
		readonly rate = 10,
		seconds = 16
	) {
		this.size = Math.ceil(seconds * rate) + 2;
		this.ring = new Float32Array(this.size * dims);
	}

	push(values: ArrayLike<number>, dt: number): void {
		if (this.filled === 0) this.write(values);
		this.carry += Math.max(0, Number.isFinite(dt) ? dt : 0);
		const step = 1 / this.rate;
		while (this.carry >= step) {
			this.carry -= step;
			this.write(values);
		}
	}

	/** The composition `delay` seconds of music ago (the oldest kept if longer). */
	sample(delay: number, out: number[]): number[] {
		const dims = this.dims;
		if (this.filled === 0) {
			for (let d = 0; d < dims; d += 1) out[d] = 0;
			return out;
		}
		const back = Math.min(Math.max(0, delay * this.rate), this.filled - 1);
		const i0 = Math.floor(back);
		const f = back - i0;
		const i1 = Math.min(i0 + 1, this.filled - 1);
		const slot = (i: number) => (((this.head - 1 - i) % this.size) + this.size) % this.size;
		const a = slot(i0) * dims;
		const b = slot(i1) * dims;
		for (let d = 0; d < dims; d += 1) out[d] = this.ring[a + d] + (this.ring[b + d] - this.ring[a + d]) * f;
		return out;
	}

	private write(values: ArrayLike<number>) {
		const o = this.head * this.dims;
		for (let d = 0; d < this.dims; d += 1) this.ring[o + d] = Number(values[d] ?? 0);
		this.head = (this.head + 1) % this.size;
		this.filled = Math.min(this.filled + 1, this.size);
	}
}

export class SignalRoam {
	readonly compose: Roamer;
	/** Recent compositions, for parts that follow the roam behind the hero. */
	readonly echo = new SignalComposeEcho();
	readonly camera: Roamer;
	/** Seed word for the noise lanes. */
	readonly noiseSeed: number;
	private lastRingOut = 0;
	/** Seconds the hero drift has travelled (music time, not wall time). */
	private driftTime = 0;

	constructor(readonly seed: string) {
		this.compose = new Roamer(SIGNAL_COMPOSE_DIMS, `${seed}:compose`, {
			meanHold: 10,
			minHold: 3.5,
			response: 6.5,
			wander: 0.36,
			wanderPeriod: 22
		});
		this.camera = new Roamer(SIGNAL_CAMERA_ROAM_DIMS, `${seed}:camera`, {
			meanHold: 8,
			minHold: 3,
			response: 5,
			wander: 0.3,
			wanderPeriod: 19
		});
		let h = 0x811c9dc5;
		for (let i = 0; i < seed.length; i += 1) {
			h ^= seed.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		this.noiseSeed = h >>> 0;
	}

	/** Advance both roamers. `dt` is 0 in silence, so the bench holds still. */
	update(dt: number, drive: SignalRoamDrive): void {
		const tempo = clamp01(drive.tempo);
		const energy = clamp01(drive.energy);
		const rate = 0.65 + tempo * 0.8;
		this.compose.update(dt, rate, 0.25 + energy * 0.6);
		this.echo.push(this.compose.value, dt);
		this.camera.update(dt, rate * 1.1, 0.3 + energy * 0.7);
		this.driftTime += Math.max(0, dt) * rate;
		// A landing: the camera drops and tips toward the bench, then the
		// spring carries it back into its roam. Never on the beat clock.
		const ring = clamp01(drive.ringOut);
		if (ring > 0.9 && this.lastRingOut < 0.5 && dt > 0) {
			this.camera.impulse(1, -0.55);
			this.camera.impulse(0, 0.35);
		}
		this.lastRingOut = ring;
	}

	/** The music changed character: both roamers head somewhere new now. */
	redirect(): void {
		this.compose.redirect();
		this.camera.redirect();
	}

	/** Smooth non-repeating -1..1 on any clock (one unit ~ one undulation). */
	noise(lane: number, t: number): number {
		return noise1(this.noiseSeed, lane, t);
	}

	/** The hero's slow drift across its face, -1..1 per axis. */
	drift(out: [number, number]): [number, number] {
		out[0] = noise1(this.noiseSeed, SIGNAL_NOISE_LANE.driftX, this.driftTime / 23);
		out[1] = noise1(this.noiseSeed, SIGNAL_NOISE_LANE.driftY, this.driftTime / 31);
		return out;
	}
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? (value < 0 ? 0 : value > 1 ? 1 : value) : 0;
}
