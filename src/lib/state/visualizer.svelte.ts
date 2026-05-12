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
};

class VisualizerState {
	active = $state(false);
	latest = $state<AudioFeatures | null>(null);
	private unlisten: UnlistenFn | null = null;
	private subs = 0;

	toggle() {
		this.active = !this.active;
	}

	async subscribe(): Promise<() => void> {
		this.subs += 1;
		if (!this.unlisten) {
			this.unlisten = await listen<AudioFeatures>('audio:features', (e) => {
				this.latest = e.payload;
			});
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
