// Prism's camera rig: a camera that never holds a pose. Each regime is a
// continuous path through the nave (an orbit around the window, a sweep along
// the arcade, a crane rise, a close pass over the glass, a dolly along the
// wall of windows, a glide over the flooded floor, a push through the nave, a
// Dutch-rolled arc), parameterised by one shared travel phase. The phase
// integrates a tempo-driven rate with a floor, so even the calmest passage
// drifts with parallax; regime changes are long crossfades between two moving
// paths; kicks and downbeats push the lens on a damped spring; a change of
// music surges the travel so the camera visibly reframes within a second or
// two, then settles back to cruising speed. Everything here is continuous in
// time, and the whole rig lives in the look so a new song or a remount carries
// the shot on.
//
// Pure, renderer-free state; the renderer reads `pose()` and builds the basis
// with prismCameraBasis (composition.ts).

import type { ChoiceState } from '../variation';
import {
	PRISM_CAMERAS,
	PRISM_FLOOR_Y,
	PRISM_ROSE_R,
	PRISM_ROSE_Y,
	prismSoftSign,
	type PrismCameraParams
} from './composition';

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function approach(current: number, target: number, rate: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** What a regime path reads besides the travel phase. */
export type PrismPathInput = {
	/** Shared travel phase (radians of path); grows forever. */
	travel: number;
	/** Section's side preference, -1..1 (soft-signed into a wall). */
	side: number;
	/** Section's focus, 0..1 wrapping: where on the glass a close pass looks. */
	focus: number;
	/** Phrase drift, -1..1. */
	drift: number;
	/** World x of the bay the camera is working on. */
	anchor: number;
};

/**
 * How fast each regime's path is walked, relative to the shared travel rate,
 * so a close pass across the glass and a wide orbit move the picture by a
 * similar amount on screen.
 */
export const PRISM_PATH_RATE: readonly number[] = [1, 0.9, 0.85, 0.32, 0.8, 0.9, 0.85, 0.8];

/**
 * One regime's camera at a point on its path. Every regime looks at the
 * working window (or a point on its glass), so the composition keeps reading
 * while the camera travels.
 */
export function prismCameraPath(regime: number, i: PrismPathInput): PrismCameraParams {
	const r = Math.round(finite(regime));
	const phi = finite(i.travel) * (PRISM_PATH_RATE[r] ?? 1);
	const side = clamp(finite(i.side), -1, 1);
	const sgn = prismSoftSign(side);
	const focus = finite(i.focus);
	const drift = clamp(finite(i.drift), -1, 1);
	const x0 = finite(i.anchor);
	switch (r) {
		case 1:
			// Arcade: from one side of the nave, the window at an angle and its
			// neighbours receding, the camera sweeping along the arcade.
			return {
				yaw: sgn * (0.5 + 0.16 * Math.sin(phi * 0.5)) + drift * 0.05,
				pitch: -0.035 + 0.05 * Math.sin(phi * 0.37 + 1.1),
				roll: 0.03 * Math.sin(phi * 0.29),
				dist: 1.7 + 0.22 * Math.sin(phi * 0.41 + 0.6),
				tx: x0 + sgn * 0.12 + 0.24 * Math.sin(phi * 0.33),
				ty: 0.03,
				bays: 2.5,
				wet: 0.1
			};
		case 2: {
			// Crane: from just above the floor looking up into the window to above
			// it looking down, and back.
			const pitch = 0.02 + 0.19 * Math.sin(phi * 0.45 + side * 1.4);
			return {
				yaw: 0.16 * Math.sin(phi * 0.31 + side) + drift * 0.04,
				pitch,
				roll: 0.04 * Math.sin(phi * 0.23 + 2),
				dist: 1.42 + 0.12 * Math.sin(phi * 0.6),
				tx: x0 + 0.05 * Math.sin(phi * 0.27),
				ty: PRISM_ROSE_Y * 0.6,
				bays: 1,
				wet: 0.15
			};
		}
		case 3: {
			// Glass: a close pass over the window, the facets and tracery sliding
			// past on a Lissajous path, the lens rolling a little.
			const a = focus * Math.PI * 2;
			return {
				yaw: 0.2 * Math.sin(phi * 0.5 + a),
				pitch: 0.06 + 0.1 * Math.sin(phi * 0.41),
				roll: 0.14 * Math.sin(phi * 0.27 + side * 2) + drift * 0.05,
				dist: 0.46 + 0.07 * Math.sin(phi * 0.8),
				tx: x0 + PRISM_ROSE_R * 0.62 * Math.sin(phi * 0.9 + a),
				ty: PRISM_ROSE_Y + PRISM_ROSE_R * 0.5 * Math.sin(phi * 0.63 + a * 0.5),
				bays: 0,
				wet: 0
			};
		}
		case 4:
			// Gallery: a lateral dolly along the wall of windows (the anchor itself
			// travels while this regime leads; see PrismCameraRig).
			return {
				yaw: sgn * (0.72 + 0.1 * Math.sin(phi * 0.4)) + drift * 0.04,
				pitch: -0.03 + 0.03 * Math.sin(phi * 0.33),
				roll: 0,
				dist: 1.9 + 0.15 * Math.sin(phi * 0.5),
				tx: x0,
				ty: 0.03,
				bays: 4.5,
				wet: 0.2
			};
		case 5:
			// Flooded: low over the mirroring floor, gliding in and out.
			return {
				yaw: 0.22 * Math.sin(phi * 0.3 + side * 1.3) + drift * 0.05,
				pitch: 0.115 + 0.025 * Math.sin(phi * 0.5),
				roll: 0.02 * Math.sin(phi * 0.21),
				dist: 2.0 + 0.32 * Math.sin(phi * 0.38),
				tx: x0 + 0.08 * Math.sin(phi * 0.24),
				ty: -0.02,
				bays: 1.5,
				wet: 1
			};
		case 6:
			// Nave: from the far end, pushing in through the arcade and drawing back.
			return {
				yaw: side * 0.12 + 0.07 * Math.sin(phi * 0.4),
				pitch: -0.035 + 0.035 * Math.sin(phi * 0.29 + 0.4),
				roll: 0.015 * Math.sin(phi * 0.31),
				dist: 2.55 + 0.62 * Math.sin(phi * 0.3),
				tx: x0 + 0.1 * Math.sin(phi * 0.25),
				ty: 0.03,
				bays: 3,
				wet: 0.3
			};
		case 7:
			// Dutch: a mid-distance arc with the horizon rolling well off level.
			return {
				yaw: 0.3 * Math.sin(phi * 0.45),
				pitch: 0.07 * Math.sin(phi * 0.5 + 1),
				roll: 0.27 * Math.sin(phi * 0.35 + side * 2),
				dist: 1.35 + 0.18 * Math.sin(phi * 0.6),
				tx: x0 + 0.1 * Math.sin(phi * 0.5),
				ty: 0.05,
				bays: 1,
				wet: 0.1
			};
		default:
			// Orbit: a slow orbit around the window, breathing in and out; square-on
			// at the start of its path, the original framing.
			// The yaw swings through square-on rather than resting there, and the
			// height and lateral offset ride other periods, so the camera is
			// almost never frontal, level and centred all at once.
			return {
				yaw: 0.62 * Math.sin(phi * 0.7 + side * 0.3) + drift * 0.04,
				pitch: 0.13 * Math.sin(phi * 0.45 + focus * 6.28) * Math.min(1, Math.abs(phi) * 4),
				roll: 0.05 * Math.sin(phi * 0.5),
				dist: 1.8 + 0.32 * Math.sin(phi * 0.33),
				tx: x0 + 0.12 * Math.sin(phi * 0.6 + 1.3) * Math.min(1, Math.abs(phi) * 4),
				ty: 0,
				bays: 1.5,
				wet: 0.1
			};
	}
}

/** Blend two regime cameras (distance in log space, so a dolly feels even). */
export function prismBlendCameras(a: PrismCameraParams, b: PrismCameraParams, t: number): PrismCameraParams {
	return {
		yaw: lerp(a.yaw, b.yaw, t),
		pitch: lerp(a.pitch, b.pitch, t),
		roll: lerp(a.roll, b.roll, t),
		dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), t)),
		tx: lerp(a.tx, b.tx, t),
		ty: lerp(a.ty, b.ty, t),
		bays: lerp(a.bays, b.bays, t),
		wet: lerp(a.wet, b.wet, t)
	};
}

export type PrismRigInput = {
	dt: number;
	/** Crossfade between the regime on screen and the next one. */
	regime: ChoiceState;
	side: number;
	focus: number;
	drift: number;
	/** Bay spacing in world units. */
	spacing: number;
	/** Music character tempo, 0..1 (60..180 bpm). */
	tempo: number;
	energy: number;
	/** 0..1; silence slows the travel to its floor but never stops it. */
	silence: number;
	/** VISUALIZER_TUNING.mk1.motion. */
	motion: number;
};

/**
 * The travelling camera. Owned by the look; every field integrates, so there
 * is no state from which the shot could jump.
 */
export class PrismCameraRig {
	/** Shared path phase. */
	travel: number;
	/** Seconds of rig time, for the breathing layer. */
	clock = 0;
	/** Travel rate actually in use (eased, so tempo changes never jerk). */
	rate = 0.1;
	/** Working bay, in bay units; the gallery dolly moves it. */
	anchorBay = 0;
	/** Shift surge, 0..1, decaying. */
	surge = 0;
	private surgeEased = 0;
	/** Beat push spring (unitless displacement and velocity). */
	kick = 0;
	private kickVel = 0;
	private readonly phase: number;
	/** The last pose, for velocity-continuous smoothing. */
	private smoothed: PrismCameraParams | null = null;

	constructor(seed: number) {
		const s = clamp(finite(seed, 0.5), 0, 1);
		this.phase = s;
		this.travel = s * 40;
	}

	/** The music changed: surge along the path so the shot reframes now. */
	shift(strength: number): void {
		this.surge = Math.max(this.surge, clamp(finite(strength), 0, 1));
	}

	/** A kick or downbeat: push the lens in on the spring. */
	punch(amount: number): void {
		this.kickVel += clamp(finite(amount), 0, 1.5) * 1.4;
	}

	/** Base travel rate (path radians per second) for the playing music. */
	static rateFor(tempo: number, energy: number, silence: number, motion: number): number {
		const t = clamp(finite(tempo, 0.5), 0, 1);
		const e = clamp(finite(energy), 0, 1);
		const quiet = clamp(finite(silence), 0, 1);
		const cruise = 0.088 * (0.65 + t * 0.7) * (0.8 + e * 0.45);
		// The floor: silence slows the camera, it never parks it.
		return Math.max(0.035, cruise * (1 - quiet * 0.55)) * Math.max(0.2, finite(motion, 1));
	}

	update(input: PrismRigInput): PrismCameraParams {
		const dt = Math.max(0, Math.min(0.25, finite(input.dt)));
		this.clock += dt;
		const regime = input.regime;
		const wFrom = 1 - regime.mix;

		// Travel: tempo sets the cruise, a shift surges it, both eased.
		this.surge *= Math.exp(-dt / 1.5);
		this.surgeEased = approach(this.surgeEased, this.surge, 3.2, dt);
		const target = PrismCameraRig.rateFor(input.tempo, input.energy, input.silence, input.motion);
		this.rate = approach(this.rate, target, 0.9, dt);
		this.travel += dt * this.rate * (1 + this.surgeEased * 4.5);

		// Anchor: the gallery dolly walks along the wall of windows; every other
		// regime settles on the nearest bay. Bay units, so a glide of the bay
		// spacing never slides the camera.
		const gallery = (regime.from === 4 ? wFrom : 0) + (regime.to === 4 ? regime.mix : 0);
		const dir = prismSoftSign(input.side) >= 0 ? 1 : -1;
		const spacing = Math.max(0.5, finite(input.spacing, 1.3));
		const dolly = (this.rate * 0.3 * (1 + this.surgeEased * 2)) / spacing;
		this.anchorBay += dt * gallery * dolly * dir;
		this.anchorBay = approach(this.anchorBay, Math.round(this.anchorBay), 0.35 * (1 - gallery), dt);

		const path: PrismPathInput = {
			travel: this.travel,
			side: input.side,
			focus: input.focus,
			drift: input.drift,
			anchor: this.anchorBay * spacing
		};
		const a = prismCameraPath(regime.from, path);
		const b = prismCameraPath(regime.to, path);
		const blended = prismBlendCameras(a, b, regime.mix);

		// Breath: a slow multi-sine layer on the rig's own clock, so the camera
		// drifts with parallax even when the travel is at its floor.
		const t = this.clock;
		const p = this.phase * 6.28;
		const m = clamp(finite(input.motion, 1), 0.2, 2);
		blended.yaw += (0.03 * Math.sin(t * 0.13 + p) + 0.017 * Math.sin(t * 0.29 + p * 2)) * m;
		blended.pitch += (0.016 * Math.sin(t * 0.17 + p * 3) + 0.008 * Math.sin(t * 0.37)) * m;
		blended.roll += 0.012 * Math.sin(t * 0.11 + p * 5) * m;
		blended.tx += 0.025 * Math.sin(t * 0.09 + p * 7) * m;
		blended.ty += 0.012 * Math.sin(t * 0.15 + p * 1.7) * m;
		blended.dist *= 1 + 0.035 * Math.sin(t * 0.19 + p * 4) * m;

		// Second-order smoothing removes any corner a crossfade or a rate change
		// could leave in the motion.
		if (!this.smoothed) this.smoothed = { ...blended };
		const s = this.smoothed;
		const k = 4.5;
		s.yaw = approach(s.yaw, blended.yaw, k, dt);
		s.pitch = approach(s.pitch, blended.pitch, k, dt);
		s.roll = approach(s.roll, blended.roll, k, dt);
		s.dist = Math.exp(approach(Math.log(s.dist), Math.log(blended.dist), k, dt));
		s.tx = approach(s.tx, blended.tx, k, dt);
		s.ty = approach(s.ty, blended.ty, k, dt);
		s.bays = approach(s.bays, blended.bays, k, dt);
		s.wet = approach(s.wet, blended.wet, k, dt);

		// Beat push: a damped spring, a few per cent in and a hair of nod.
		const omega = 9;
		const zeta = 0.62;
		this.kickVel += (-omega * omega * this.kick - 2 * zeta * omega * this.kickVel) * dt;
		this.kick += this.kickVel * dt;
		this.kick = clamp(this.kick, -0.6, 1.2);
		const out = { ...s };
		out.dist *= 1 - 0.03 * this.kick;
		out.pitch += 0.004 * this.kick;
		out.roll += 0.003 * this.kick * (this.phase > 0.5 ? 1 : -1);
		return out;
	}

	/** Pose without advancing (for a lab still); null before the first update. */
	pose(): PrismCameraParams | null {
		return this.smoothed ? { ...this.smoothed } : null;
	}
}

/** Lowest camera height any path asks for (the basis clamps to the floor too). */
export const PRISM_CAMERA_FLOOR = PRISM_FLOOR_Y + 0.05;
export const PRISM_CAMERA_REGIMES = PRISM_CAMERAS;
