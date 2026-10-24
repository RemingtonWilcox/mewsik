// Prism's camera rig: a camera that roams the nave and never walks a loop.
//
// There are no authored paths. The shot is a point in a six-dimensional box
// (swing, height, distance, where the window sits in the frame, roll) that a
// Roamer carries between destinations picked at irregular times, on
// critically damped springs, with non-repeating noise on top. What that point
// means is set by a *region* of viewpoint space: an orbit around the window,
// the arcade seen from one side, a crane from the floor, a close pass over
// the glass, a dolly along the wall of windows, a glide over the flooded
// floor, the far end of the nave, a Dutch-rolled arc. The genome's camera
// choice crossfades between regions, so a region is a bias of the space, not
// a path: the same region visited twice is roamed from wherever the shot is,
// and every region's centre drifts on its own slow noise, so it is never the
// same place twice either.
//
// Tempo sets how fast the shot roams, energy how restless it is (shorter
// holds), a change of music redirects it at once and surges the roam, heard
// kicks push the lens on a damped spring. Everything integrates, and the
// whole rig lives in the look, so a new song or a remount carries the shot on.
//
// Pure, renderer-free state; the renderer reads `update()` and builds the
// basis with prismCameraBasis (composition.ts).

import type { ChoiceState } from '../variation';
import { Roamer, Wander } from '../motion';
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

/** Shot dimensions the rig roams: swing, height, distance, frame x, frame y, roll. */
export const PRISM_SHOT_DIMS = 6;

/** A [centre, reach] pair: the region spans centre ± reach as the shot goes -1..1. */
type Span = readonly [number, number];

/**
 * One region of viewpoint space. Angles in radians, distance as a centre and
 * a log reach (a dolly feels even), the look-at offset in world units.
 * `side*` terms lean the centre toward the section's preferred wall.
 */
export type PrismCameraRegion = {
	yaw: Span;
	sideYaw: number;
	pitch: Span;
	dist: Span;
	tx: Span;
	sideTx: number;
	ty: Span;
	roll: Span;
	/** > 0 shapes the roll toward its extremes (tanh), so a Dutch angle stays off level. */
	rollShape: number;
	bays: number;
	wet: number;
};

/**
 * The eight regions, in PRISM_CAMERAS order. The reaches are wide on purpose:
 * each region holds many framings (square-on or raking, near or far, the
 * window centred, on a third or high or low, level or rolled), and
 * neighbouring regions overlap so a crossfade travels through good shots.
 */
export const PRISM_CAMERA_REGIONS: readonly PrismCameraRegion[] = [
	// Orbit: around the window, swinging through square-on, near and far, the
	// window drifting off centre toward a third or the frame's edge.
	{ yaw: [0, 0.62], sideYaw: 0.08, pitch: [0, 0.13], dist: [1.8, 0.6], tx: [0, 0.5], sideTx: 0, ty: [0, 0.14], roll: [0, 0.06], rollShape: 0, bays: 1.5, wet: 0.1 },
	// Arcade: from one side, the window at an angle and its neighbours receding.
	{ yaw: [0, 0.2], sideYaw: 0.52, pitch: [-0.035, 0.06], dist: [1.7, 0.4], tx: [0, 0.4], sideTx: 0.12, ty: [0.03, 0.1], roll: [0, 0.04], rollShape: 0, bays: 2.5, wet: 0.1 },
	// Crane: from just above the floor looking up into the window to above it
	// looking down.
	{ yaw: [0, 0.22], sideYaw: 0.06, pitch: [0.02, 0.2], dist: [1.42, 0.35], tx: [0, 0.36], sideTx: 0, ty: [PRISM_ROSE_Y * 0.6, 0.12], roll: [0, 0.05], rollShape: 0, bays: 1, wet: 0.15 },
	// Glass: a close pass over the window, facets and tracery filling the frame.
	{ yaw: [0, 0.24], sideYaw: 0, pitch: [0.06, 0.1], dist: [0.47, 0.25], tx: [0, PRISM_ROSE_R * 0.62], sideTx: 0, ty: [PRISM_ROSE_Y, PRISM_ROSE_R * 0.5], roll: [0, 0.16], rollShape: 0, bays: 0, wet: 0 },
	// Gallery: raking along the wall of windows (the anchor travels while this
	// region leads; see PrismCameraRig).
	{ yaw: [0, 0.13], sideYaw: 0.72, pitch: [-0.03, 0.04], dist: [1.9, 0.3], tx: [0, 0.4], sideTx: 0, ty: [0.03, 0.08], roll: [0, 0.02], rollShape: 0, bays: 4.5, wet: 0.2 },
	// Flooded: low over the mirroring floor.
	{ yaw: [0, 0.26], sideYaw: 0.05, pitch: [0.115, 0.035], dist: [2.0, 0.4], tx: [0, 0.4], sideTx: 0, ty: [-0.02, 0.06], roll: [0, 0.03], rollShape: 0, bays: 1.5, wet: 1 },
	// Nave: from the far end, in and out through the arcade.
	{ yaw: [0, 0.1], sideYaw: 0.12, pitch: [-0.035, 0.04], dist: [2.55, 0.4], tx: [0, 0.36], sideTx: 0, ty: [0.03, 0.08], roll: [0, 0.02], rollShape: 0, bays: 3, wet: 0.3 },
	// Dutch: mid-distance, the horizon rolled well off level.
	{ yaw: [0, 0.34], sideYaw: 0, pitch: [0, 0.08], dist: [1.35, 0.4], tx: [0, 0.4], sideTx: 0, ty: [0.05, 0.1], roll: [0, 0.29], rollShape: 2.2, bays: 1, wet: 0.1 }
];

/** What a region reads besides the shot. */
export type PrismShotContext = {
	/** Section's side preference, -1..1 (soft-signed into a wall). */
	side: number;
	/** Section's focus, 0..1 wrapping: turns where on the glass a close pass looks. */
	focus: number;
	/** Phrase drift, -1..1: a small swing lean. */
	drift: number;
	/** World x of the bay the camera is working on. */
	anchor: number;
};

function shaped(value: number, k: number): number {
	return k > 0 ? Math.tanh(k * value) / Math.tanh(k) : value;
}

/**
 * The camera of one region at a shot (each dimension about -1..1; the rig
 * feeds a roaming point plus the region's slow drift). Every region looks at
 * the working window or a point on its glass, so the composition reads
 * wherever the shot roams. The zero shot of the orbit is the original
 * framing: square-on, the rose centred.
 */
export function prismCameraAt(regime: number, shot: ArrayLike<number>, ctx: PrismShotContext): PrismCameraParams {
	const r = clamp(Math.round(finite(regime)), 0, PRISM_CAMERA_REGIONS.length - 1);
	const R = PRISM_CAMERA_REGIONS[r];
	const s = (i: number) => clamp(finite(shot[i] ?? 0), -1.2, 1.2);
	const sgn = prismSoftSign(clamp(finite(ctx.side), -1, 1));
	const drift = clamp(finite(ctx.drift), -1, 1);
	let nx = s(3);
	let ny = s(4);
	if (r === 3) {
		// The close pass turns its offset by the section's focus, so the part
		// of the glass it lingers over is the section's, not the shot's.
		const a = finite(ctx.focus) * Math.PI * 2;
		const c = Math.cos(a);
		const sn = Math.sin(a);
		[nx, ny] = [nx * c - ny * sn, nx * sn + ny * c];
	}
	// Off-centre framing is a screen offset: a far camera moves its aim
	// further so the window lands on the same third. Shaped so the window
	// spends its time on a third or near one, passing through the centre
	// rather than parking there.
	const glass = r === 3;
	// Distance is shaped toward its ends: the window is often big in the frame
	// or small in the nave, and passes through the middle distance.
	const dist = R.dist[0] * Math.exp(R.dist[1] * (glass ? s(2) : shaped(s(2), 1.3)));
	const reach = glass ? 1 : dist / 1.8;
	const fx = R.tx[1] * (glass ? nx : shaped(nx, 1.5)) * reach;
	const fy = R.ty[1] * (glass ? ny : shaped(ny, 1.2)) * reach;
	return {
		yaw: R.yaw[0] + R.sideYaw * sgn + R.yaw[1] * s(0) + drift * 0.04,
		pitch: R.pitch[0] + R.pitch[1] * s(1),
		roll: R.roll[0] + R.roll[1] * shaped(s(5), R.rollShape),
		dist,
		tx: finite(ctx.anchor) + R.sideTx * sgn + fx,
		ty: R.ty[0] + fy,
		bays: R.bays,
		wet: R.wet
	};
}

/** Blend two region cameras (distance in log space, so a dolly feels even). */
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
	/** Crossfade between the region on screen and the next one. */
	regime: ChoiceState;
	side: number;
	focus: number;
	drift: number;
	/** Bay spacing in world units. */
	spacing: number;
	/** Music character tempo, 0..1 (60..180 bpm). */
	tempo: number;
	energy: number;
	/** 0..1; silence slows the roam to its floor but never stops it. */
	silence: number;
	/** VISUALIZER_TUNING.mk1.motion. */
	motion: number;
};

/** Cruise rate (rateFor) at which the shot roams at its authored pace. */
const ROAM_UNIT = 0.088;

/**
 * The roaming camera. Owned by the look; every field integrates, so there
 * is no state from which the shot could jump.
 */
export class PrismCameraRig {
	/** Roam odometer: authored seconds of roaming travelled (surges count more). */
	travel = 0;
	/** Seconds of rig time. */
	clock = 0;
	/** Cruise rate in use (rateFor units, eased so tempo changes never jerk). */
	rate = ROAM_UNIT;
	/** Working bay, in bay units; the gallery dolly moves it. */
	anchorBay = 0;
	/** Shift surge, 0..1, decaying. */
	surge = 0;
	private surgeEased = 0;
	/** Kick push spring (unitless displacement and velocity). */
	kick = 0;
	private kickVel = 0;
	/** Hashed hit counter: which way a kick swings the shot. */
	private hits = 0x51ed;
	private readonly phase: number;
	/** The shot: where in its region the camera is heading and travelling. */
	private readonly shot: Roamer;
	/** Each dimension's slow drift of the region centres (minutes per undulation). */
	private readonly drift: Wander;
	/**
	 * Intimacy: quiet music draws the camera in toward the glass, loud music
	 * pulls it back so the light can fill the nave. A distance multiplier,
	 * eased over many seconds.
	 */
	reach = 1;
	/** Hand-held breath on top: seconds per undulation, never periodic. */
	private readonly breath: Wander;
	/**
	 * Excursions: on its own irregular schedule the shot strays from the
	 * section's region toward another one (a close pass over the glass, a
	 * pull back down the nave, a dip to the flooded floor) and comes home.
	 * The region it strays toward only changes while the shot is home.
	 */
	private readonly wanderlust: Roamer;
	/** Region the shot strays toward. */
	excursion: number;
	/** How far it has strayed, 0..1 (eased). */
	away = 0;
	private awaySlew = 0;
	private excursions = 0;
	/** The excursion target was picked during this stay at home. */
	private chosen = false;
	private readonly mix = new Float32Array(PRISM_SHOT_DIMS);
	/** The last pose, for velocity-continuous smoothing. */
	private smoothed: PrismCameraParams | null = null;

	constructor(seed: number) {
		const s = clamp(finite(seed, 0.5), 0, 1);
		this.phase = s;
		const word = Math.floor(s * 0xffffff);
		this.shot = new Roamer(PRISM_SHOT_DIMS, `prism-shot:${word}`, {
			meanHold: 13,
			minHold: 4,
			response: 5,
			wander: 0.24,
			wanderPeriod: 21
		});
		this.drift = new Wander(PRISM_SHOT_DIMS, `prism-region:${word}`, [83, 61, 97, 71, 113, 67]);
		this.breath = new Wander(6, `prism-breath:${word}`, [7.3, 9.1, 11.7, 13.3, 8.6, 10.4]);
		this.wanderlust = new Roamer(1, `prism-excursion:${word}`, {
			meanHold: 15,
			minHold: 5,
			response: 7,
			wander: 0.3,
			wanderPeriod: 23
		});
		this.excursion = (word % 7) + 1;
	}

	/** How much of the shot is the close pass over the glass. */
	private glassWeight(regime: ChoiceState): number {
		const home = (regime.from === 3 ? 1 - regime.mix : 0) + (regime.to === 3 ? regime.mix : 0);
		return home + ((this.excursion === 3 ? 1 : 0) - home) * this.away;
	}

	/**
	 * Next region to stray toward: hashed, never the one at home or the last
	 * one, and likelier the more its distance differs from home's, so an
	 * excursion from the far nave goes in to the glass and a close pass pulls
	 * back down the nave.
	 */
	private nextExcursion(home: number): number {
		const count = PRISM_CAMERA_REGIONS.length;
		const homeDist = Math.log(PRISM_CAMERA_REGIONS[home].dist[0]);
		const weights = PRISM_CAMERA_REGIONS.map((region, index) =>
			index === home || index === this.excursion ? 0 : 0.25 + Math.abs(Math.log(region.dist[0]) - homeDist)
		);
		const total = weights.reduce((sum, w) => sum + w, 0);
		this.excursions += 1;
		let h = Math.imul(this.excursions ^ 0x5bd1e995, 0x9e3779b1) ^ Math.floor(this.phase * 0xffff);
		h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
		let pick = (h / 0x100000000) * total;
		for (let index = 0; index < count; index += 1) {
			pick -= weights[index];
			if (pick < 0 && weights[index] > 0) return index;
		}
		return (home + 3) % count;
	}

	/** The music changed: head somewhere new now, and roam faster for a while. */
	shift(strength: number): void {
		const s = clamp(finite(strength), 0, 1);
		this.surge = Math.max(this.surge, s);
		// Excursions keep their own schedule: a reframing answers the music,
		// a long dolly to the glass would only blur the answer.
		if (s >= 0.3) this.shot.redirect();
	}

	/** A heard kick: push the lens in on the spring, and nudge the shot. */
	punch(amount: number): void {
		const a = clamp(finite(amount), 0, 1.5);
		this.kickVel += a * 1.4;
		// The shot leans into the hit: a little closer, a little swing, the side
		// chosen by the hit itself so kicks never push the same way twice.
		this.hits = (Math.imul(this.hits ^ (this.hits >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
		this.shot.impulse(2, -a * 0.05);
		this.shot.impulse(0, (this.hits & 0x100 ? 1 : -1) * a * 0.025);
	}

	/** Base cruise rate for the playing music (silence slows it to a floor). */
	static rateFor(tempo: number, energy: number, silence: number, motion: number): number {
		const t = clamp(finite(tempo, 0.5), 0, 1);
		const e = clamp(finite(energy), 0, 1);
		const quiet = clamp(finite(silence), 0, 1);
		const cruise = ROAM_UNIT * (0.65 + t * 0.7) * (0.8 + e * 0.45);
		// The floor: silence slows the camera, it never parks it.
		return Math.max(0.035, cruise * (1 - quiet * 0.55)) * Math.max(0.2, finite(motion, 1));
	}

	update(input: PrismRigInput): PrismCameraParams {
		const dt = Math.max(0, Math.min(0.25, finite(input.dt)));
		this.clock += dt;
		const regime = input.regime;
		const wFrom = 1 - regime.mix;
		const energy = clamp(finite(input.energy), 0, 1);
		const m = clamp(finite(input.motion, 1), 0.2, 2);

		// Roam rate: tempo sets the cruise, a shift surges it, both eased. The
		// surged rate is capped so a reframing is fast but never a whip.
		this.surge *= Math.exp(-dt / 2.4);
		this.surgeEased = approach(this.surgeEased, this.surge, 3.2, dt);
		const target = PrismCameraRig.rateFor(input.tempo, energy, input.silence, input.motion);
		this.rate = approach(this.rate, target, 0.9, dt);
		const roam = Math.min(2.8, (this.rate / ROAM_UNIT) * (1 + this.surgeEased * 1.8));
		this.travel += dt * roam;
		const restless = clamp(energy * 0.8 + this.surgeEased * 0.6, 0, 1);
		const shot = this.shot.update(dt, roam, restless);
		// The regions' own drift: slower than the shot, never still.
		const drift = this.drift.update(dt, 0.6 + roam * 0.4);
		for (let i = 0; i < PRISM_SHOT_DIMS; i += 1) this.mix[i] = shot[i] * 0.8 + drift[i] * 0.38;

		// Anchor: the gallery dolly walks along the wall of windows; every other
		// region settles on the nearest bay. Bay units, so a glide of the bay
		// spacing never slides the camera.
		const gallery = (regime.from === 4 ? wFrom : 0) + (regime.to === 4 ? regime.mix : 0);
		const dir = prismSoftSign(input.side) >= 0 ? 1 : -1;
		const spacing = Math.max(0.5, finite(input.spacing, 1.3));
		const dolly = (this.rate * 0.3 * (1 + this.surgeEased * 2)) / spacing;
		this.anchorBay += dt * gallery * dolly * dir;
		this.anchorBay = approach(this.anchorBay, Math.round(this.anchorBay), 0.35 * (1 - gallery), dt);

		const ctx: PrismShotContext = {
			side: input.side,
			focus: input.focus,
			drift: input.drift,
			anchor: this.anchorBay * spacing
		};
		const a = prismCameraAt(regime.from, this.mix, ctx);
		const b = prismCameraAt(regime.to, this.mix, ctx);
		const home = prismBlendCameras(a, b, regime.mix);
		// Excursion: stray toward another region and back. Some of the time
		// the shot is home; the target region only changes while it is.
		// Excursions keep their own unhurried pace, even through a surge.
		const lust = this.wanderlust.update(dt, Math.min(roam, 1.4), restless)[0];
		const t = clamp((lust + 0.1) / 0.75, 0, 1);
		// Slew-limited, then eased: an excursion from the far nave to the glass
		// is a long dolly, and it must read as one (12 s or more), never a lunge:
		// a dolly moves the whole frame at once, so it stays unhurried and the
		// music shows in the window's parts instead.
		const goal = t * t * (3 - 2 * t) * 0.95;
		this.awaySlew += clamp(goal - this.awaySlew, -0.08 * dt, 0.08 * dt);
		this.away = approach(this.away, this.awaySlew, 2.2, dt);
		if (this.away > 0.05) this.chosen = false;
		else if (this.away < 0.003 && (!this.chosen || this.excursion === regime.to)) {
			this.excursion = this.nextExcursion(regime.to);
			this.chosen = true;
		}
		const blended =
			this.away > 0 ? prismBlendCameras(home, prismCameraAt(this.excursion, this.mix, ctx), this.away) : home;
		// Quiet passages come closer, loud ones stand back (never the close pass
		// itself, which is already at the glass).
		const quiet = clamp(finite(input.silence), 0, 1);
		this.reach = approach(this.reach, Math.exp(0.5 * (energy * (1 - quiet) - 0.55)), 0.25, dt);
		const closeness = 1 - this.glassWeight(regime);
		blended.dist *= 1 + (this.reach - 1) * closeness;
		blended.tx = ctx.anchor + (blended.tx - ctx.anchor) * (1 + (this.reach - 1) * closeness);

		// Breath: a hand-held drift on smooth noise, so the camera keeps its
		// parallax alive between destinations without any loop the eye learns.
		// It stays small and slow: the whole frame moving at once is the one
		// motion that hides the window's parts answering the band.
		const br = this.breath.update(dt, 0.6 + energy * 0.3);
		blended.yaw += 0.025 * br[0] * m;
		blended.pitch += 0.012 * br[1] * m;
		blended.roll += 0.009 * br[2] * m;
		blended.tx += 0.018 * br[3] * m;
		blended.ty += 0.009 * br[4] * m;
		blended.dist *= 1 + 0.025 * br[5] * m;

		// Second-order smoothing removes any corner a crossfade, an impulse or a
		// rate change could leave in the motion.
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

		// Kick push: a damped spring, a few per cent in and a hair of nod.
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

/** Lowest camera height any region asks for (the basis clamps to the floor too). */
export const PRISM_CAMERA_FLOOR = PRISM_FLOOR_Y + 0.05;
export const PRISM_CAMERA_REGIMES = PRISM_CAMERAS;
