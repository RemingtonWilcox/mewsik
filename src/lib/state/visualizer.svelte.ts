// Simple reactive store for visualizer overlay state. Phase A scaffolding —
// will grow into the preset/morph/routing matrix store in later phases.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AudioFeatures = {
	bins: number[];
	rms: number;
	peak: number;
	centroid: number;
	onset: boolean;
	bass: number;
	mid: number;
	treble: number;
	sample_rate: number;
	bpm: number;
	beat_phase: number;
	chroma_key: number;
	chroma_strength: number;
};

// Native analysis normally arrives at ~60 Hz. Keep the last frame through brief
// scheduling jitter, but stop treating it as live audio quickly when playback
// pauses, buffers, or the analyzer stops emitting.
export const AUDIO_FEATURE_FRESHNESS_MS = 250;

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

	/** Publish one analyzer frame and timestamp it on the shared monotonic clock. */
	setLatest(features: AudioFeatures) {
		this.latestFrame = features;
		this.latestFrameAt = featureClockNow();
	}

	/** Immediately invalidate audio during known playback discontinuities. */
	clearLatest() {
		this.latestFrame = null;
		this.latestFrameAt = null;
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
