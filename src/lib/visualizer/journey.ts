import {
	createVisualDirector,
	type AudioFeatureFrame,
	type VisualDirectorFrame
} from '$lib/visualizer/director/index.js';
import { stringHash01 } from '$lib/visualizer/director/util';
import {
	SignalSpectrumTracker,
	type SignalSpectrumProfile
} from '$lib/visualizer/signal/spectrum';
import {
	SignalConductor,
	type SignalConductorFrame
} from '$lib/visualizer/signal/conductor';
import { Mk2Conductor, type Mk2ConductorFrame } from '$lib/visualizer/mk2/conductor';
import { LoomConductor, type LoomConductorFrame } from '$lib/visualizer/loom/conductor';
import { LoomLook } from '$lib/visualizer/loom/look';
import { CharacterTracker, type MusicCharacter } from '$lib/visualizer/character';

/**
 * Atomic live view of one journey tick. Nested controller outputs and typed
 * arrays are deliberately reused to keep the 60 Hz path allocation-light; a
 * consumer that needs historical comparison must copy the values it retains.
 */
export type VisualizerJourneySnapshot = {
	readonly director: VisualDirectorFrame;
	readonly spectrum: Readonly<SignalSpectrumProfile>;
	readonly signal: Readonly<SignalConductorFrame>;
	readonly mk2: Readonly<Mk2ConductorFrame>;
	readonly loom: Readonly<LoomConductorFrame>;
	/**
	 * What kind of music is playing, and when it changes. Outlives sources:
	 * a new song is measured against the previous one.
	 */
	readonly character: MusicCharacter;
	/** Deterministic per-source visual identity in the 0..1 range. */
	readonly seed: number;
	/** Monotonic source generation, so A -> B -> A is three distinct journeys. */
	readonly sourceEpoch: number;
	/** Monotonic seconds since this source epoch began; renderer-remount safe. */
	readonly timelineSeconds: number;
};

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function safeNow(nowMs: number): number {
	return Number.isFinite(nowMs) ? Math.max(0, nowMs) : 0;
}

function normalizeSeed(seed: number): number {
	if (!Number.isFinite(seed)) return 0.5;
	const wrapped = seed - Math.floor(seed);
	return wrapped < 0 ? wrapped + 1 : wrapped;
}

/**
 * One small CPU-only musical timeline shared by every render engine. It owns no
 * canvas, GPU device, texture, buffer, or bind group; renderer components remain
 * free to mount and tear down without resetting the song's choreography.
 */
export class VisualizerJourneyRuntime {
	private readonly sessionSeed: number;
	private identity: string | null = null;
	private epoch = 0;
	private seed: number;
	private epochAtMs: number;
	private updatedAtMs: number | null = null;
	private director = createVisualDirector();
	// Looks outlive sources: a new song continues the picture instead of
	// restarting it, and renderer remounts resume where they left off.
	private readonly looks = new Map<string, unknown>();
	private readonly loomLook = new LoomLook(0);
	private loomLookSeeded = false;
	private spectrumTracker = new SignalSpectrumTracker();
	private readonly characterTracker = new CharacterTracker();
	private signalConductor: SignalConductor;
	private mk2Conductor: Mk2Conductor;
	private loomConductor: LoomConductor;
	private snapshot: VisualizerJourneySnapshot | null = null;

	constructor(sessionSeed = Math.random(), nowMs = 0) {
		this.sessionSeed = normalizeSeed(sessionSeed);
		this.seed = this.sessionSeed;
		this.epochAtMs = safeNow(nowMs);
		this.signalConductor = new SignalConductor(this.seed);
		this.mk2Conductor = new Mk2Conductor(this.seed);
		this.loomConductor = new LoomConductor(this.seed, this.continueLoomLook());
	}

	/** Per-engine look state created once per session; see VisualizerState.persistentLook. */
	persistentLook<T>(key: string, create: () => T): T {
		if (!this.looks.has(key)) this.looks.set(key, create());
		return this.looks.get(key) as T;
	}

	/** The shared Loom look: hard-seeded for the first source, reseeded after. */
	private continueLoomLook(): LoomLook {
		if (this.loomLookSeeded) this.loomLook.continueWith(this.seed);
		else {
			this.loomLook.reset(this.seed);
			this.loomLookSeeded = true;
		}
		return this.loomLook;
	}

	get sourceIdentity(): string | null {
		return this.identity;
	}

	get sourceEpoch(): number {
		return this.epoch;
	}

	get cachedSnapshot(): VisualizerJourneySnapshot | null {
		return this.snapshot;
	}

	get lastUpdateAtMs(): number | null {
		return this.updatedAtMs;
	}

	/** Reset every temporal rail once, and only once, for a real source change. */
	resetSource(identity: string | null, nowMs: number): boolean {
		if (identity === this.identity) return false;
		const now = safeNow(nowMs);
		this.identity = identity;
		this.epoch += 1;
		this.seed = identity === null ? this.sessionSeed : stringHash01(identity);
		this.epochAtMs = now;
		this.updatedAtMs = null;
		this.director = createVisualDirector();
		this.spectrumTracker = new SignalSpectrumTracker();
		this.signalConductor = new SignalConductor(this.seed);
		this.mk2Conductor = new Mk2Conductor(this.seed);
		this.loomConductor = new LoomConductor(this.seed, this.continueLoomLook());
		this.characterTracker.beginSource();
		this.snapshot = null;
		return true;
	}

	/**
	 * Advance all dependent controllers as one transaction. Callers own tick
	 * deduplication; every invocation here represents one analyzer or silence
	 * tick. Returned nested values remain valid as the current live view and are
	 * mutated in place by the next advance.
	 */
	advance(features: AudioFeatureFrame | null, nowMs: number): VisualizerJourneySnapshot {
		const now = safeNow(nowMs);
		const elapsedMs = this.updatedAtMs === null ? 1000 / 60 : now - this.updatedAtMs;
		const dt = clamp(
			Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / 1000 : 1 / 1000,
			1 / 1000,
			0.25
		);
		const timelineSeconds = Math.max(0, (now - this.epochAtMs) / 1000);
		const spectrum = this.spectrumTracker.update(features, dt);
		// Perceptual spectrum is shared analysis, not a Signal-only post-process.
		// Advance it first so the director and every engine hear the same real-Hz
		// bands, flatness, novelty, and centroid in this transaction.
		const director = this.director.update(features, timelineSeconds, spectrum);
		// Character before the conductors, so any of them can answer a shift
		// in the same tick it fires.
		const character = this.characterTracker.update(director, spectrum, dt);
		const signal = this.signalConductor.update(director, spectrum, dt);
		const mk2 = this.mk2Conductor.update(director, spectrum, dt, signal);
		const loom = this.loomConductor.update(director, spectrum, dt);
		this.updatedAtMs = now;
		this.snapshot = {
			director,
			spectrum,
			signal,
			mk2,
			loom,
			character,
			seed: this.seed,
			sourceEpoch: this.epoch,
			timelineSeconds
		};
		return this.snapshot;
	}
}
