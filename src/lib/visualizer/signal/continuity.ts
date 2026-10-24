// Signal's continuity layer: everything that stands between the genome's
// decisions and the picture so that no decision ever reads as a jump cut.
//
//   SignalChoiceMorph  turns a choice axis (layout, figure family, palette,
//                      camera, display, band map) into one finished, eased
//                      morph at a time. A new target that arrives while a morph
//                      is still running waits for it instead of re-pointing the
//                      blend mid-flight (which would snap whatever share of the
//                      old target was already on screen). Going back to the
//                      option being left reverses the morph in place.
//                      Per-axis delays stagger a scene change so the palette
//                      turns first, then the camera and bench move, then the
//                      figure re-forms: one evolving gesture, not a swap.
//   SignalCarry        bridges conductor rails across a new source. The shared
//                      journey rebuilds its conductor for every song; the
//                      renderer keeps showing where the old rails were and
//                      eases into the new ones, so a song change is a glide.
//   signalRendererMemory
//                      renderer state that outlives a component remount, so
//                      leaving the visualizer and coming back resumes the
//                      picture instead of restarting it.

import { SignalFigureEngine } from './figures';
import { SignalVoice } from './voice';
import type { SignalRoam } from './roam';
import type { SignalBand } from './band';
import { SIGNAL_TERRAIN_BINS, SIGNAL_TERRAIN_FLOATS } from './shaders';

/** Quintic ease: zero velocity and acceleration at both ends. */
export function smootherstep(t: number): number {
	const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
	return x * x * x * (x * (x * 6 - 15) + 10);
}

export type SignalMorph = {
	from: number;
	to: number;
	/** Eased share of the target, 0..1. */
	mix: number;
	/** Linear progress of the morph, 0..1 (1 settled), for per-part staggers. */
	progress: number;
};

/**
 * One part's share of a staggered morph: each part of the bench takes its
 * own window of the morph's progress (its delay is a fraction of the run,
 * `span` how much of the run it moves through), so a scene change turns the
 * cubies one after another instead of a whole face at once. Ends exactly at
 * 0 and 1 with the morph, so nothing is left halfway.
 */
export function signalPartMix(progress: number, delay: number, span = 0.55): number {
	const d = Math.max(0, Math.min(1 - span, delay));
	return smootherstep((progress - d) / Math.max(1e-3, span));
}

/** A deterministic 0..1 per (morph, part), for the stagger order. */
export function signalPartDelay(from: number, to: number, part: number, span = 0.55): number {
	let h = Math.imul((from + 1) | 0, 0x9e3779b1) ^ Math.imul((to + 7) | 0, 0x85ebca6b) ^ Math.imul((part + 13) | 0, 0xc2b2ae35);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return ((h >>> 0) / 0x1_0000_0000) * (1 - span);
}

export class SignalChoiceMorph {
	private fromOption = 0;
	private toOption = 0;
	/** Linear progress of the running morph, 0..1 (1 = settled). */
	private progress = 1;
	private pending: number | null = null;
	private wait = 0;
	private settled = false;
	private readonly out: SignalMorph = { from: 0, to: 0, mix: 1, progress: 1 };

	constructor(
		/** Seconds for one morph. */
		readonly seconds: number,
		/** Seconds a new target waits before its morph may start. */
		readonly delay = 0
	) {}

	/** Show `option` immediately with no morph (first frame of a session). */
	settle(option: number): void {
		this.fromOption = option;
		this.toOption = option;
		this.progress = 1;
		this.pending = null;
		this.wait = 0;
		this.settled = true;
	}

	get initialized(): boolean {
		return this.settled;
	}

	/** The option this axis is heading to (queued target first). */
	get target(): number {
		return this.pending ?? this.toOption;
	}

	/**
	 * Follow the genome's current target. `speed` scales how fast the running
	 * morph advances (1 = `seconds` per morph) and how fast a queued target's
	 * delay runs out; right after the music changes character Signal runs its
	 * morphs several times faster so the new look lands in a second or two.
	 */
	update(target: number, dt: number, speed = 1): SignalMorph {
		if (!this.settled) this.settle(target);
		const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
		if (this.progress < 1) {
			this.progress = Math.min(1, this.progress + (step * Math.max(0, speed)) / Math.max(0.05, this.seconds));
		}
		if (target === this.toOption) {
			this.pending = null;
		} else if (target === this.fromOption && this.progress < 1) {
			// Turning back: run the same morph the other way from where it is.
			// smootherstep(1 - p) = 1 - smootherstep(p), so nothing moves.
			this.fromOption = this.toOption;
			this.toOption = target;
			this.progress = 1 - this.progress;
			this.pending = null;
		} else if (target !== this.pending) {
			this.pending = target;
			this.wait = this.delay;
		}
		if (this.pending !== null) {
			this.wait -= step * Math.max(0, speed);
			if (this.wait <= 0 && this.progress >= 1) {
				this.fromOption = this.toOption;
				this.toOption = this.pending;
				this.progress = 0;
				this.pending = null;
			}
		}
		return this.state();
	}

	state(): SignalMorph {
		this.out.from = this.fromOption;
		this.out.to = this.toOption;
		this.out.mix = this.fromOption === this.toOption ? 1 : smootherstep(this.progress);
		this.out.progress = this.fromOption === this.toOption ? 1 : this.progress;
		return this.out;
	}
}

/**
 * Morph lengths and stagger for each choice axis, in seconds. A scene change
 * lands on the genome all at once; these spread it over fifteen seconds or so:
 * the phosphor turns first, the camera and bench rearrange, the figure
 * re-forms last, and the tube character drifts on its own slow clock. When the
 * music changes character the renderer runs the same staggered move several
 * times faster (see SignalChoiceMorph.update), so it lands in two or three.
 */
export const SIGNAL_MORPH_TIMING = {
	// Slow on purpose: the scene is the container, not the way the music
	// shows (the band's parts do that), so an ordinary section change glides
	// over ten seconds or more, each part in its own window of it. A change
	// of character still lands in a few seconds (the renderer speeds these up).
	palette: { seconds: 11, delay: 0 },
	camera: { seconds: 12, delay: 1.2 },
	layout: { seconds: 13, delay: 0.6 },
	family: { seconds: 9, delay: 2.8 },
	display: { seconds: 14, delay: 0 },
	traceMap: { seconds: 4.5, delay: 0.4 },
	// The bench turning round is the biggest rearrangement: it takes longest.
	mirror: { seconds: 16, delay: 2 }
} as const;

export type SignalMorphAxis = keyof typeof SIGNAL_MORPH_TIMING;

export function createSignalMorphs(): Record<SignalMorphAxis, SignalChoiceMorph> {
	const out = {} as Record<SignalMorphAxis, SignalChoiceMorph>;
	for (const [name, timing] of Object.entries(SIGNAL_MORPH_TIMING) as [
		SignalMorphAxis,
		{ seconds: number; delay: number }
	][]) {
		out[name] = new SignalChoiceMorph(timing.seconds, timing.delay);
	}
	return out;
}

/**
 * Carries named rails across a discontinuity in their source. After
 * `rebase()`, the first value seen for each rail is offset to where that rail
 * was last shown, and the offset melts away over `seconds` on a quintic ease,
 * so neither the value nor its rate of change jumps. Outside a rebase window
 * values pass straight through: reactivity is untouched.
 */
export class SignalCarry {
	private readonly last = new Map<string, number>();
	private readonly offset = new Map<string, number>();
	private age = Number.POSITIVE_INFINITY;
	private rebasing = false;

	constructor(readonly seconds = 5) {}

	/** The source restarted: hold every rail where it was and ease it over. */
	rebase(): void {
		this.rebasing = true;
		this.offset.clear();
		this.age = 0;
	}

	/** Call once per frame before `apply`. */
	advance(dt: number): void {
		if (!Number.isFinite(this.age)) return;
		this.age += Math.max(0, Number.isFinite(dt) ? dt : 0);
		if (this.age >= this.seconds) {
			this.rebasing = false;
			this.offset.clear();
			this.age = Number.POSITIVE_INFINITY;
		}
	}

	get active(): boolean {
		return this.rebasing;
	}

	apply(name: string, raw: number): number {
		const value = Number.isFinite(raw) ? raw : 0;
		let out = value;
		if (this.rebasing) {
			let offset = this.offset.get(name);
			if (offset === undefined) {
				const previous = this.last.get(name);
				offset = previous === undefined ? 0 : previous - value;
				this.offset.set(name, offset);
			}
			out = value + offset * (1 - smootherstep(this.age / this.seconds));
		}
		this.last.set(name, out);
		return out;
	}
}

/** Renderer scalars that must survive a remount. */
export type SignalRendererScalars = {
	figurePhase: number;
	lastTracePhase: number;
	spinAngle: number;
	sweepPhase: number;
	tickPhase: number;
	terrainHead: number;
	mode: number;
	asymmetry: number;
	renderBpm: number;
	/** Ambient breath, grain and fracture clocks. */
	breathPhase: number;
	grainClock: number;
	fracturePhase: number;
	/** Morph speed multiplier after a shift, easing back to 1. */
	reactBoost: number;
};

export type SignalRendererMemory = {
	/** Source epoch the renderer last drew; -1 before the first frame ever. */
	epoch: number;
	scalars: SignalRendererScalars | null;
	readonly morphs: Record<SignalMorphAxis, SignalChoiceMorph>;
	/**
	 * Bench, camera and hero roam (see roam.ts). Created on the first frame,
	 * seeded by that journey, and then carried through every source after.
	 */
	roam: SignalRoam | null;
	/**
	 * The band on the bench (see band.ts): voice lanes, their written
	 * phosphor and the modulation matrix. Created with the roam, carried
	 * through every source after, so a remount resumes every part.
	 */
	band: SignalBand | null;
	readonly carry: SignalCarry;
	readonly figure: SignalFigureEngine;
	/** The music's character as an instrument, glided (see voice.ts). */
	readonly voice: SignalVoice;
	/** Horizon history: interleaved height, heat per bin, one row per tick. */
	readonly terrainRows: Float32Array;
	readonly pendingRow: Float32Array;
};

let memory: SignalRendererMemory | null = null;

/** One renderer memory per app session, shared by every Signal mount. */
export function signalRendererMemory(): SignalRendererMemory {
	memory ??= {
		epoch: -1,
		scalars: null,
		morphs: createSignalMorphs(),
		roam: null,
		band: null,
		// Three seconds: long enough that a new song's rails glide in, short
		// enough that the new music's own rails show by the time it is heard.
		carry: new SignalCarry(3),
		figure: new SignalFigureEngine(),
		voice: new SignalVoice(),
		terrainRows: new Float32Array(SIGNAL_TERRAIN_FLOATS),
		pendingRow: new Float32Array(SIGNAL_TERRAIN_BINS * 2)
	};
	return memory;
}
