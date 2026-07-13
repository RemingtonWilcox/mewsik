// Simple reactive store for visualizer overlay state. Phase A scaffolding —
// will grow into the preset/morph/routing matrix store in later phases.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioFeatureFrame, VisualDirectorFrame } from '$lib/visualizer/director/index.js';
import {
	VisualizerJourneyRuntime,
	type VisualizerJourneySnapshot
} from '$lib/visualizer/journey';

export type { VisualizerJourneySnapshot } from '$lib/visualizer/journey';

export type AudioFeatures = AudioFeatureFrame;

// Native analysis normally arrives at ~60 Hz. Keep the last frame through brief
// scheduling jitter, but stop treating it as live audio quickly when playback
// pauses, buffers, or the analyzer stops emitting.
export const AUDIO_FEATURE_FRESHNESS_MS = 250;
export const JOURNEY_NULL_TICK_MS = 1000 / 60;
const JOURNEY_NULL_CATCHUP_LIMIT_MS = JOURNEY_NULL_TICK_MS * 4;

function featureClockNow(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Available presets — keep in sync with shader pipelines in visualizer.svelte.
export const PRESET_COUNT = 4;
export const PRESET_NAMES = [
	'hyperbolic kaleidoscope',
	'cathedral flythrough',
	'voronoi caustics',
	'nebulae flow'
];

export type VisualizerEngine = 'auto' | 'mk1' | 'mk2' | 'signal';
export type RenderVisualizerEngine = Exclude<VisualizerEngine, 'auto'>;
export const VISUALIZER_ENGINES: VisualizerEngine[] = ['auto', 'mk1', 'mk2', 'signal'];

function migrateSavedEngine(saved: string): VisualizerEngine {
	// Mk3's slot is now the rebuilt signal visualizer. Runtime and any unknown
	// values fall back to the production-safe automatic mode.
	if (saved === 'mk3') return 'signal';
	if (VISUALIZER_ENGINES.includes(saved as VisualizerEngine)) return saved as VisualizerEngine;
	return 'auto';
}

class VisualizerState {
	active = $state(false);
	engine = $state<VisualizerEngine>('auto');
	// `preset` tracks the currently-dominant preset for HUD display; rendering
	// itself blends top-2 presets by softmax weight (continuous mix, not switch).
	preset = $state(0);
	// `forcedPreset` overrides auto-mix when ≥0 (used by the lab page's 1-4 keys
	// to audit a single preset in isolation). -1 = auto-blend.
	forcedPreset = $state(-1);
	private latestFrame = $state<AudioFeatures | null>(null);
	private latestFrameAt: number | null = null;
	private unlisten: UnlistenFn | null = null;
	private listenPromise: Promise<UnlistenFn> | null = null;
	private subs = 0;
	private engineHydrated = false;
	// One CPU-only journey survives renderer switches. GPU resources still live
	// exclusively inside the currently mounted engine component.
	private journeyRuntime = new VisualizerJourneyRuntime(Math.random(), featureClockNow());
	private nextJourneyNullTickAt: number | null = null;

	toggle() {
		this.active = !this.active;
	}

	setEngine(engine: VisualizerEngine) {
		this.engine = engine;
		try {
			localStorage.setItem('mewsik.visualizer.engine', engine);
		} catch {
			// Storage can be unavailable in restricted webviews; keep runtime state.
		}
	}

	/** Restore the saved engine synchronously before an engine component mounts. */
	hydrateEngine() {
		if (this.engineHydrated) return;
		this.engineHydrated = true;
		try {
			const saved = localStorage.getItem('mewsik.visualizer.engine');
			if (saved === null) return;
			const migrated = migrateSavedEngine(saved);
			this.engine = migrated;
			if (migrated !== saved) {
				localStorage.setItem('mewsik.visualizer.engine', migrated);
			}
		} catch {
			// Storage can be unavailable in restricted webviews; retain Auto.
		}
	}

	setPreset(idx: number) {
		this.preset = ((idx % PRESET_COUNT) + PRESET_COUNT) % PRESET_COUNT;
	}

	cyclePreset() {
		this.setPreset(this.preset + 1);
	}

	/** The most recently received frame, retained for lab diagnostics. */
	get latest(): AudioFeatures | null {
		return this.latestFrame;
	}

	/** Monotonic source revision; unlike identity text it distinguishes A -> B -> A. */
	get performanceSourceEpoch(): number {
		return this.journeyRuntime.sourceEpoch;
	}

	/** Publish one analyzer frame and timestamp it on the shared monotonic clock. */
	setLatest(features: AudioFeatures, now = featureClockNow()) {
		this.latestFrame = features;
		this.latestFrameAt = now;
		this.journeyRuntime.advance(features, now);
		this.nextJourneyNullTickAt = null;
	}

	/** Immediately invalidate audio during known playback discontinuities. */
	clearLatest(now = featureClockNow()) {
		this.latestFrame = null;
		this.latestFrameAt = null;
		this.journeyRuntime.advance(null, now);
		this.nextJourneyNullTickAt = now + JOURNEY_NULL_TICK_MS;
	}

	/**
	 * Return one live feature snapshot, or null once analyzer delivery has stalled.
	 * Renderers should call this once per rendered frame and reuse that snapshot.
	 */
	getLatest(now = featureClockNow()): AudioFeatures | null {
		const frame = this.latestFrame;
		if (!frame || this.latestFrameAt === null) return null;
		const age = now - this.latestFrameAt;
		return age >= 0 && age <= AUDIO_FEATURE_FRESHNESS_MS ? frame : null;
	}

	/**
	 * Sample one atomic director/spectrum/Signal/Mk2 live view. Fresh analyzer
	 * events advance it in setLatest; repeated consumers only read the cache.
	 */
	getJourney(now = featureClockNow()): VisualizerJourneySnapshot {
		const live = this.getLatest(now);
		const cached = this.journeyRuntime.cachedSnapshot;
		if (!cached) {
			const initial = this.journeyRuntime.advance(live, now);
			this.nextJourneyNullTickAt = live ? null : now + JOURNEY_NULL_TICK_MS;
			return initial;
		}
		if (live) {
			this.nextJourneyNullTickAt = null;
			return cached;
		}

		const lastUpdate = this.journeyRuntime.lastUpdateAtMs;
		let dueAt =
			this.nextJourneyNullTickAt ??
			(lastUpdate === null ? now : lastUpdate + JOURNEY_NULL_TICK_MS);
		// Do not replay a long closed/backgrounded gap as a burst. Resume from the
		// current time, then retain fractional display timing for a stable 60 Hz
		// null cadence on 60/75/90/120/144 Hz monitors.
		if (now - dueAt > JOURNEY_NULL_CATCHUP_LIMIT_MS) dueAt = now;
		this.nextJourneyNullTickAt = dueAt;
		if (now + 0.25 >= dueAt) {
			const result = this.journeyRuntime.advance(null, dueAt);
			this.nextJourneyNullTickAt = dueAt + JOURNEY_NULL_TICK_MS;
			return result;
		}
		return cached;
	}

	/** Compatibility facade for renderers that only need director intent. */
	getPerformance(now = featureClockNow()): VisualDirectorFrame {
		return this.getJourney(now).director;
	}

	/** Atomically clear raw audio and every CPU rail for a true source change. */
	resetPerformance(identity: string | null, now = featureClockNow()) {
		if (identity === this.journeyRuntime.sourceIdentity) return;
		this.latestFrame = null;
		this.latestFrameAt = null;
		this.nextJourneyNullTickAt = null;
		this.journeyRuntime.resetSource(identity, now);
	}

	async subscribe(): Promise<() => void> {
		this.subs += 1;
		if (!this.unlisten) {
			// All concurrent subscribers await the same initialization. Without this
			// latch, a quick engine switch can create two native listeners and lose
			// the first unlisten handle when the second promise resolves.
			this.listenPromise ??= listen<AudioFeatures>('audio:features', (e) => {
				this.setLatest(e.payload);
			}).catch(() => {
				// Browser lab: feature frames are injected directly by the page.
				return () => {};
			});
			this.unlisten = await this.listenPromise;
		}
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.subs -= 1;
			if (this.subs <= 0 && this.unlisten) {
				const stop = this.unlisten;
				this.unlisten = null;
				this.listenPromise = null;
				this.subs = 0;
				stop();
			}
		};
	}
}

const _state = new VisualizerState();
export function useVisualizer() {
	return _state;
}
