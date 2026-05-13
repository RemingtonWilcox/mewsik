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

// Available presets — keep in sync with shader pipelines in visualizer.svelte.
export const PRESET_COUNT = 4;
export const PRESET_NAMES = [
	'hyperbolic kaleidoscope',
	'cathedral flythrough',
	'voronoi caustics',
	'nebulae flow'
];

export type VisualizerEngine = 'auto' | 'mk1' | 'mk2' | 'mk3';
export type RenderVisualizerEngine = Exclude<VisualizerEngine, 'auto'>;
export const VISUALIZER_ENGINES: VisualizerEngine[] = ['auto', 'mk1', 'mk2', 'mk3'];

class VisualizerState {
	active = $state(false);
	engine = $state<VisualizerEngine>('auto');
	// `preset` tracks the currently-dominant preset for HUD display; rendering
	// itself blends top-2 presets by softmax weight (continuous mix, not switch).
	preset = $state(0);
	// `forcedPreset` overrides auto-mix when ≥0 (used by the lab page's 1-4 keys
	// to audit a single preset in isolation). -1 = auto-blend.
	forcedPreset = $state(-1);
	latest = $state<AudioFeatures | null>(null);
	private unlisten: UnlistenFn | null = null;
	private subs = 0;

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

	setPreset(idx: number) {
		this.preset = ((idx % PRESET_COUNT) + PRESET_COUNT) % PRESET_COUNT;
	}

	cyclePreset() {
		this.setPreset(this.preset + 1);
	}

	async subscribe(): Promise<() => void> {
		try {
			const saved = localStorage.getItem('mewsik.visualizer.engine') as VisualizerEngine | null;
			if (saved && VISUALIZER_ENGINES.includes(saved)) this.engine = saved;
		} catch {
			// Non-browser contexts or locked-down storage should not block rendering.
		}

		this.subs += 1;
		if (!this.unlisten) {
			try {
				this.unlisten = await listen<AudioFeatures>('audio:features', (e) => {
					this.latest = e.payload;
				});
			} catch (e) {
				// Non-Tauri runtime (e.g. browser-based visualizer-test lab page).
				// Skip silently; the page is expected to drive `latest` directly.
				this.unlisten = () => {};
			}
		}
		return () => {
			this.subs -= 1;
			if (this.subs <= 0 && this.unlisten) {
				this.unlisten();
				this.unlisten = null;
				this.subs = 0;
			}
		};
	}
}

const _state = new VisualizerState();
export function useVisualizer() {
	return _state;
}
