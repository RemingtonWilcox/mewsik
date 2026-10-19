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
import { SIGNAL_TERRAIN_BINS, SIGNAL_TERRAIN_FLOATS } from './shaders';

/** Quintic ease: zero velocity and acceleration at both ends. */
export function smootherstep(t: number): number {
	const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
	return x * x * x * (x * (x * 6 - 15) + 10);
}

export type SignalMorph = { from: number; to: number; mix: number };

export class SignalChoiceMorph {
	private fromOption = 0;
	private toOption = 0;
	/** Linear progress of the running morph, 0..1 (1 = settled). */
	private progress = 1;
	private pending: number | null = null;
	private wait = 0;
	private settled = false;
	private readonly out: SignalMorph = { from: 0, to: 0, mix: 1 };

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
	 * morph advances (1 = `seconds` per morph).
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
			this.wait -= step;
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
		return this.out;
	}
}

/**
 * Morph lengths and stagger for each choice axis, in seconds. A scene change
 * lands on the genome all at once; these spread it over roughly ten seconds:
 * the phosphor turns first, the camera and bench rearrange, the figure
 * re-forms last, and the tube character drifts on its own slow clock.
 */
export const SIGNAL_MORPH_TIMING = {
	palette: { seconds: 6, delay: 0 },
	camera: { seconds: 8, delay: 1.2 },
	layout: { seconds: 7.5, delay: 0.6 },
	family: { seconds: 6.5, delay: 2.8 },
	display: { seconds: 11, delay: 0 },
	traceMap: { seconds: 4.5, delay: 0.4 }
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
	dollyTime: number;
	sweepPhase: number;
	tickPhase: number;
	terrainHead: number;
	mode: number;
	asymmetry: number;
	renderBpm: number;
};

export type SignalRendererMemory = {
	/** Source epoch the renderer last drew; -1 before the first frame ever. */
	epoch: number;
	scalars: SignalRendererScalars | null;
	readonly morphs: Record<SignalMorphAxis, SignalChoiceMorph>;
	readonly carry: SignalCarry;
	readonly figure: SignalFigureEngine;
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
		carry: new SignalCarry(5),
		figure: new SignalFigureEngine(),
		terrainRows: new Float32Array(SIGNAL_TERRAIN_FLOATS),
		pendingRow: new Float32Array(SIGNAL_TERRAIN_BINS * 2)
	};
	return memory;
}
