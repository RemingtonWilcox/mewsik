// Prism's continuity rails: everything that decides how one picture becomes
// the next. The genome (composition.ts) decides *what* the window becomes;
// these pure, renderer-free pieces guarantee *how*: every discrete change is a
// crossfade, a morph or a dissolve, never a jump. They live in the journey's
// persistent look, so a new song carries the picture on and re-entering the
// visualizer resumes it exactly.
//
//   ChoiceFollower  a discrete axis as a two-slot crossfade that can never
//                   drop a half-shown option (a retarget mid-fade reverses or
//                   queues instead of snapping)
//   MosaicDraft     the glass re-drafts at some phrase ends (irregular runs,
//                   never every phrase); any phrase-clock jump (new song,
//                   re-sync) glides instead of re-cutting
//   PrismMotion     clock, rose turn and sway owned by the look (the camera
//                   rig lives in camera.ts), so a source reset (timeline,
//                   trace phase, seed) moves nothing
//   StructureMorph  window structure changes ride a cell-level dissolve that
//                   washes outward and finishes with a global fade
//   HeardKick       kicks as the audio actually played them (the kick band's
//                   attack), never the predicted beat clock

import type { ChoiceState } from '../variation';
import { noise1 } from '../motion';
import { PRISM_FAMILY_DRIVE, type PrismFamily, type PrismLive, type PrismStructure, prismStructureKey } from './composition';

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

function smooth01(value: number, low: number, high: number): number {
	const t = clamp((value - low) / (high - low), 0, 1);
	return t * t * (3 - 2 * t);
}

function approach(current: number, target: number, rate: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function mix32(value: number): number {
	let mixed = value >>> 0;
	mixed ^= mixed >>> 16;
	mixed = Math.imul(mixed, 0x7feb352d);
	mixed ^= mixed >>> 15;
	mixed = Math.imul(mixed, 0x846ca68b);
	mixed ^= mixed >>> 16;
	return mixed >>> 0;
}

/** A 16-bit salt (exact in an f32 uniform) for composition `serial`. */
export function prismSalt(base: number, serial: number): number {
	return mix32((Math.floor(finite(base)) >>> 0) ^ Math.imul((Math.floor(finite(serial)) | 0) + 1, 0x9e3779b1)) & 0xffff;
}

// ── Discrete axes ─────────────────────────────────────────────────────────
/**
 * Follows a discrete target as a crossfade the renderer can always show.
 * The genome may retarget a choice while its own crossfade is still running,
 * which would make a half-visible option vanish in one frame. The follower
 * owns the blend instead: a new target waits for the current fade (which
 * hurries), and a return to the option being faded out reverses the fade in
 * place. Output mix is smoothstepped, like the genome's.
 */
export class ChoiceFollower {
	from: number;
	to: number;
	/** Linear progress 0..1 of from -> to. */
	mix = 1;
	/** Counts every fade that starts (or reverses), so a caller can tell fades apart. */
	starts = 0;

	constructor(option: number) {
		this.from = option;
		this.to = option;
	}

	update(target: number, tau: number, dt: number): ChoiceState {
		const goal = Math.round(finite(target, this.to));
		const step = Math.max(0, finite(dt)) / Math.max(0.05, tau);
		if (goal === this.to) {
			if (this.mix < 1) this.mix = Math.min(1, this.mix + step);
		} else if (this.mix < 1 && goal === this.from) {
			// Back to the option being faded out: reverse in place (exact,
			// since smoothstep(1 - m) = 1 - smoothstep(m)).
			this.from = this.to;
			this.to = goal;
			this.mix = Math.min(1, 1 - this.mix + step);
			this.starts += 1;
		} else if (this.mix >= 1) {
			this.from = this.to;
			this.to = goal;
			this.mix = Math.min(1, step);
			this.starts += 1;
		} else {
			// A third option is waiting: finish this fade first, a little faster.
			this.mix = Math.min(1, this.mix + step * 1.8);
		}
		return this.state();
	}

	/** Jump to an option with no fade (first frame of a journey, lab force). */
	snap(option: number): void {
		this.from = option;
		this.to = option;
		this.mix = 1;
	}

	state(): ChoiceState {
		const m = this.mix;
		return { from: this.from, to: this.to, mix: m * m * (3 - 2 * m) };
	}

	/**
	 * The same fade eased out instead of smoothstepped: it shows from its first
	 * frame and lands softly. For a fade answering a change of music; use it
	 * for a whole fade (from its start), never switch to it mid-fade.
	 */
	stateEagerly(): ChoiceState {
		const m = this.mix;
		return { from: this.from, to: this.to, mix: 1 - (1 - m) * (1 - m) * (1 - m) };
	}
}

// ── Mosaic re-draft ───────────────────────────────────────────────────────
/**
 * Glass seeds drift from draft `phrase` toward `phrase + 1` by `mix`. The
 * glass re-drafts at the end of *some* phrases, not every one: whether a
 * phrase ends in a re-draft follows smooth noise across phrases plus a roll,
 * so re-drafts come in irregular runs and lulls instead of on the phrase
 * clock. Any phrase-clock jump (new song, re-sync) glides.
 */
export class MosaicDraft {
	phrase = 0;
	mix = 0;
	private pending = false;
	private lastIndex: number | null = null;
	/** Phrase turns seen, and whether the phrase now playing ends in a re-draft. */
	private turns = 0;
	private planned = true;
	/** Fastest re-draft, in mix per second, for a phrase-clock jump. */
	static readonly RATE = 1 / 1.4;

	/** Whether phrase turn `turn` re-drafts: clustered (noise) and rolled (hash). */
	static plan(turn: number): boolean {
		const mood = noise1(0x6d7a, 0, turn * 0.37);
		const roll = mix32(Math.imul(turn + 1, 0x9e3779b1) ^ 0x51ed) / 0x100000000;
		return mood * 0.55 + (roll - 0.5) * 0.9 > -0.12;
	}

	update(phraseIndex: number, phrasePos: number, dt: number): void {
		const index = Math.floor(finite(phraseIndex));
		const step = Math.max(0, finite(dt)) * MosaicDraft.RATE;
		if (this.lastIndex !== null && index !== this.lastIndex) {
			// A re-draft already under way always completes; an unplanned turn
			// with still glass passes without one.
			if (this.planned || this.mix > 0.02) this.pending = true;
			this.turns += 1;
			this.planned = MosaicDraft.plan(this.turns);
		}
		this.lastIndex = index;
		if (this.pending) {
			// The phrase turned (naturally, or because the clock jumped): finish
			// gliding into the next draft, then roll the counter seamlessly.
			this.mix = Math.min(1, this.mix + step);
			if (this.mix >= 1 - 1e-6) {
				this.phrase += 1;
				this.mix = 0;
				this.pending = false;
			}
			return;
		}
		const target = this.planned ? smooth01(clamp(finite(phrasePos), 0, 1), 0.82, 1) : 0;
		// Rate-limited both ways: a phrase-position jump glides, never re-cuts.
		this.mix = clamp(this.mix + clamp(target - this.mix, -step, step * 2), 0, 1);
	}

	/** A new source: its phrase clock restarts, the draft must not. */
	continueSource(): void {
		this.lastIndex = null;
	}
}

// ── Motion ────────────────────────────────────────────────────────────────
export type PrismMotionInput = {
	/** The shared (unwrapped) trace phase; resets to 0 on a new source. */
	tracePhase: number;
	dt: number;
	/** VISUALIZER_TUNING.mk1.motion. */
	motion: number;
	energy: number;
	/** 0..1. */
	silence: number;
};

/**
 * Clock and motion owned by the look rather than by the source: the journey's
 * timeline and trace phase restart with every song, and anything absolute in
 * them would jump. Rotation integrates the trace phase's increments instead.
 */
export class PrismMotion {
	/** Seconds since the look began; drives every shader animation. */
	clock = 0;
	rotation = 0;
	previousRotation = 0;
	/** Turn direction, easing toward the current song's preference. */
	turn: number;
	turnTarget: number;
	readonly phase: number;
	private lastTrace: number | null = null;

	constructor(seed: number) {
		const s = clamp(finite(seed, 0.5), 0, 1);
		this.phase = s;
		this.turn = s > 0.5 ? 1 : -1;
		this.turnTarget = this.turn;
	}

	/** A new source: a new turn preference, eased in; nothing else moves. */
	continueSource(seed: number): void {
		this.turnTarget = finite(seed, 0.5) > 0.5 ? 1 : -1;
		this.lastTrace = null;
	}

	/** A slow sway of the turn on smooth noise (minutes per undulation, never periodic). */
	private sway(t: number): number {
		const lane = Math.floor(this.phase * 0xffff);
		return noise1(0x5a7e, lane, t / 150) * 0.09;
	}

	update(input: PrismMotionInput): void {
		const dt = Math.max(0, finite(input.dt));
		const before = this.clock;
		this.clock += dt;
		const trace = finite(input.tracePhase);
		let dTrace = this.lastTrace === null ? 0 : trace - this.lastTrace;
		// A reset or a wild jump of the shared phase is a new source, not motion.
		if (!(dTrace >= 0 && dTrace < 0.5)) dTrace = 0;
		this.lastTrace = trace;
		// Reversing direction passes smoothly through a standstill.
		this.turn = approach(this.turn, this.turnTarget, 0.18, dt);
		this.previousRotation = this.rotation;
		this.rotation += (dTrace * 0.22 * this.turn + (this.sway(this.clock) - this.sway(before))) * input.motion;
	}
}

// ── Structure ─────────────────────────────────────────────────────────────
/** A composition the dissolve carries: structure, proportions and its salt. */
export type PrismComp = PrismStructure & { petalWidth: number; petalReach: number; outerLit: number; salt: number };

/** Rose radii per second that the dissolve front travels. */
export const PRISM_MORPH_SPEED = 0.78;
/** The front runs past the rose so the wall re-cuts too, then a global fade finishes. */
export const PRISM_MORPH_END = 2.8;
/** Width of the band (radii) over which one pixel crosses from A to B. */
export const PRISM_MORPH_BAND = 0.5;
/** How far (in bands) one cell's own reveal threshold is staggered. */
export const PRISM_MORPH_SPREAD = 1.2;
/** Front position where the global fade of everything still outside begins. */
export const PRISM_MORPH_FADE_FROM = 1.7;

export function prismMakeComp(structure: PrismStructure, family: PrismFamily, live: PrismLive, salt: number): PrismComp {
	return {
		...structure,
		petalWidth: live.petalWidth,
		petalReach: live.petalReach,
		outerLit: PRISM_FAMILY_DRIVE[family].outerLit,
		salt
	};
}

/**
 * Weight of composition B at distance `rn` (rose radii) for a cell with key
 * 0..1, mirroring the rose shader. 0 everywhere when a morph starts, 1
 * everywhere when it ends.
 */
export function prismMorphWeight(front: number, rn: number, key: number, globalMix: number): number {
	const spatial = smooth01((front - rn) / PRISM_MORPH_BAND - PRISM_MORPH_SPREAD * 0.5 + (key - 0.5) * PRISM_MORPH_SPREAD, 0, 1);
	return Math.max(spatial, clamp(globalMix, 0, 1));
}

export function prismMorphGlobal(front: number): number {
	return smooth01(front, PRISM_MORPH_FADE_FROM, PRISM_MORPH_END);
}

/**
 * The window's structural composition. A new structure or section family
 * starts a morph from the composition on screen to the new one; one morph at
 * a time, and a change that lands mid-morph waits for it. B keeps breathing
 * with the genome's live proportions while it is revealed.
 */
export class StructureMorph {
	a: PrismComp;
	b: PrismComp;
	key: string;
	family: PrismFamily;
	front = PRISM_MORPH_END;
	glow = 0;
	serial = 0;

	constructor(
		structure: PrismStructure,
		family: PrismFamily,
		live: PrismLive,
		readonly baseSalt: number
	) {
		this.a = prismMakeComp(structure, family, live, prismSalt(baseSalt, 0));
		this.b = { ...this.a };
		this.key = prismStructureKey(structure);
		this.family = family;
	}

	get morphing(): boolean {
		return this.front < PRISM_MORPH_END;
	}

	update(structure: PrismStructure, family: PrismFamily, live: PrismLive, dt: number): void {
		const step = Math.max(0, finite(dt));
		if (this.front < PRISM_MORPH_END) {
			this.front = Math.min(PRISM_MORPH_END, this.front + step * PRISM_MORPH_SPEED);
			if (this.front >= PRISM_MORPH_END) {
				this.a = { ...this.b };
				this.glow = 0;
			}
		}
		const key = prismStructureKey(structure);
		if (this.front >= PRISM_MORPH_END && (key !== this.key || family !== this.family)) {
			this.serial += 1;
			this.a = { ...this.b };
			const next = prismMakeComp(structure, family, live, prismSalt(this.baseSalt, this.serial));
			// The incoming window starts from the proportions and lit tier on
			// screen and eases to its own, so only the structure dissolves.
			next.petalWidth = this.b.petalWidth;
			next.petalReach = this.b.petalReach;
			next.outerLit = this.b.outerLit;
			this.b = next;
			this.key = key;
			this.family = family;
			this.front = 0;
			this.glow = 1;
		}
		this.b.petalWidth = approach(this.b.petalWidth, live.petalWidth, 2, step);
		this.b.petalReach = approach(this.b.petalReach, live.petalReach, 2, step);
		this.b.outerLit = approach(this.b.outerLit, PRISM_FAMILY_DRIVE[family].outerLit, 1.2, step);
	}

	/** Uniform values: front, light at the front, and the global finishing fade. */
	uniforms(): { front: number; glow: number; globalMix: number } {
		const glow = this.glow * Math.min(1, (PRISM_MORPH_END - this.front) * 2);
		return { front: this.front, glow, globalMix: prismMorphGlobal(this.front) };
	}
}

// ── Axes and sources ──────────────────────────────────────────────────────
/** Discrete axes the renderer shows through a ChoiceFollower crossfade. */
export const PRISM_FOLLOWED_CHOICES = ['palette', 'roles', 'guest', 'camera', 'beatForm', 'environment'] as const;
export type PrismFollowedChoice = (typeof PRISM_FOLLOWED_CHOICES)[number];
/** Discrete axes that change the window's structure and ride the StructureMorph. */
export const PRISM_MORPHED_CHOICES = ['grammar', 'fold', 'mosaic'] as const;

/** What a renderer run must expose so a new source can continue it. */
export type PrismContinuable = {
	motion: PrismMotion;
	draft: MosaicDraft;
	resyncBeat: boolean;
};

export type PrismLookState<R> = {
	genome: { reset(seed: number): void; reseed(seed: number): void };
	epoch: number;
	run: R | null;
};

/**
 * Enter a journey source. The journey's first source seeds the look and builds
 * its first picture ('reset'); a new source (next song, new station) only
 * reseeds future mutations and tells the rails their clocks restarted
 * ('continue'); the same source again is a renderer remount and resumes the
 * run untouched ('resume').
 */
export function prismEnterSource<R extends PrismContinuable>(
	state: PrismLookState<R>,
	sourceEpoch: number,
	seed: number,
	create: () => R
): 'reset' | 'continue' | 'resume' {
	if (state.epoch === -1 || !state.run) {
		state.genome.reset(seed);
		state.run = create();
		state.epoch = sourceEpoch;
		return 'reset';
	}
	if (state.epoch !== sourceEpoch) {
		state.genome.reseed(seed);
		state.run.motion.continueSource(seed);
		state.run.draft.continueSource();
		state.run.resyncBeat = true;
		state.epoch = sourceEpoch;
		return 'continue';
	}
	return 'resume';
}

// ── Heard kicks ───────────────────────────────────────────────────────────
/**
 * A kick is a sharp rise of the kick band's level within a frame or two,
 * confirmed by the band rising over its own slow context. The attack, not
 * the level, so a sustained bass line never holds the trigger; an adaptive
 * peak, so quiet and loud mixes both trigger; a refractory gap, so a flam
 * is one hit. Nothing here reads the predicted beat clock.
 */
export class HeardKick {
	/** Seconds since the last hit. */
	since = 10;
	hits = 0;
	private previous = 0;
	private armed = true;
	private peak = 0.2;

	/** Returns the hit strength (0..1) on the frame a kick is heard, else 0. */
	update(dt: number, level: number, delta: number, loudness: number): number {
		const step = Math.max(0, Math.min(0.25, finite(dt)));
		this.since += step;
		const now = clamp(finite(level), 0, 1);
		const scale = step > 0 ? clamp(1 / 60 / step, 0.5, 2) : 1;
		const attack = (now - this.previous) * scale;
		this.previous = now;
		this.peak = Math.max(this.peak * Math.exp(-step / 6), attack, 0.06);
		const threshold = Math.max(0.035, this.peak * 0.3);
		if (!this.armed && attack < threshold * 0.3) this.armed = true;
		if (!this.armed || attack < threshold || finite(delta) <= 0.02 || this.since < 0.14) return 0;
		this.armed = false;
		this.since = 0;
		this.hits += 1;
		return clamp(attack / this.peak, 0.3, 1) * clamp(finite(loudness), 0, 1);
	}
}
