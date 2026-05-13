import type { AudioFeatures } from '$lib/state/visualizer.svelte';

export type VisualizerSection = 'calm' | 'rising' | 'peak' | 'releasing';
export type VisualizerMotif = 'organism' | 'tunnel' | 'lattice' | 'ribbon';

export type VisualDirectorFrame = {
	section: VisualizerSection;
	motif: VisualizerMotif;
	motifIndex: number;
	silence: boolean;
	energy: number;
	density: number;
	motion: number;
	paletteBase: number;
	paletteAccent: number;
	structure: number;
	phrase: number;
};

const MOTIFS: VisualizerMotif[] = ['organism', 'tunnel', 'lattice', 'ribbon'];
const HIST_LEN = 8 * 60;

function clamp01(value: number) {
	return Math.max(0, Math.min(1, value));
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number) {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

export class VisualDirector {
	private section: VisualizerSection = 'calm';
	private sectionEnterTime = 0;
	private silenceStart = 0;
	private energySlow = 0;
	private densitySlow = 0.25;
	private motionSlow = 0.2;
	private structureSlow = 0.5;
	private paletteSlow = 0.05;
	private rmsHist = new Float32Array(HIST_LEN);
	private onsetHist = new Float32Array(HIST_LEN);
	private histIdx = 0;
	private histFilled = 0;

	update(features: AudioFeatures | null | undefined, time: number): VisualDirectorFrame {
		const rms = features?.rms ?? 0;
		const bass = features?.bass ?? 0;
		const mid = features?.mid ?? 0;
		const treble = features?.treble ?? 0;
		const centroid = features?.centroid ?? 0.5;
		const chromaKey = features?.chroma_key ?? 0;
		const chromaStrength = features?.chroma_strength ?? 0;
		const beatPhase = features?.beat_phase ?? (time * 0.5) % 1;
		const onset = features?.onset ? 1 : 0;

		if (rms < 0.02) {
			if (this.silenceStart === 0) this.silenceStart = time;
		} else {
			this.silenceStart = 0;
		}
		const silence = this.silenceStart > 0 && time - this.silenceStart > 0.45;

		this.push(rms, onset);
		this.updateSection(time);

		const rawEnergy = clamp01(rms * 1.15 + bass * 0.28 + onset * 0.18);
		const rawDensity = clamp01(rms * 0.65 + mid * 0.22 + treble * 0.16);
		const rawMotion = clamp01(bass * 0.42 + mid * 0.28 + rms * 0.4);
		const rawStructure = clamp01(0.7 - treble * 0.25 + chromaStrength * 0.35);
		const paletteTarget = (chromaKey / 12 + centroid * 0.18 + this.sectionBias()) % 1;

		this.energySlow = lerp(this.energySlow, silence ? 0 : rawEnergy, 0.08);
		this.densitySlow = lerp(this.densitySlow, silence ? 0.05 : rawDensity, 0.04);
		this.motionSlow = lerp(this.motionSlow, silence ? 0 : rawMotion, 0.05);
		this.structureSlow = lerp(this.structureSlow, silence ? 0.85 : rawStructure, 0.03);
		this.paletteSlow = lerp(this.paletteSlow, paletteTarget, 0.015);

		const phrase = (beatPhase + time / 32) % 1;
		const motifIndex = silence
			? 0
			: Math.floor((chromaKey / 3 + Math.floor(time / 32) + smoothstep(0.2, 0.8, phrase)) % 4);

		return {
			section: silence ? 'calm' : this.section,
			motif: MOTIFS[motifIndex] ?? 'organism',
			motifIndex,
			silence,
			energy: this.energySlow,
			density: this.densitySlow,
			motion: this.motionSlow,
			paletteBase: this.paletteSlow,
			paletteAccent: (this.paletteSlow + 0.18 + chromaStrength * 0.08) % 1,
			structure: this.structureSlow,
			phrase
		};
	}

	private push(rms: number, onset: number) {
		this.rmsHist[this.histIdx] = rms;
		this.onsetHist[this.histIdx] = onset;
		this.histIdx = (this.histIdx + 1) % HIST_LEN;
		this.histFilled = Math.min(HIST_LEN, this.histFilled + 1);
	}

	private avg(buf: Float32Array, startBack: number, len: number): number {
		let sum = 0;
		let n = 0;
		for (let i = 0; i < len; i++) {
			const idx = (this.histIdx - startBack - i - 1 + HIST_LEN * 2) % HIST_LEN;
			if (i < this.histFilled) {
				sum += buf[idx];
				n++;
			}
		}
		return n > 0 ? sum / n : 0;
	}

	private updateSection(time: number) {
		const ws = 120;
		const rmsNow = this.avg(this.rmsHist, 0, ws);
		const rmsAgo = this.avg(this.rmsHist, ws * 2, ws);
		const onsetNow = this.avg(this.onsetHist, 0, ws) * ws;
		const onsetAgo = this.avg(this.onsetHist, ws * 2, ws) * ws;
		const rmsDelta = rmsNow - rmsAgo;
		const onsetRatio = onsetNow / Math.max(1, onsetAgo);
		const timeInSection = time - this.sectionEnterTime;
		const transitionTo = (next: VisualizerSection) => {
			if (next !== this.section) {
				this.section = next;
				this.sectionEnterTime = time;
			}
		};

		if (rmsNow < 0.05 && timeInSection > 3) {
			transitionTo('calm');
			return;
		}

		switch (this.section) {
			case 'calm':
				if (timeInSection > 2.5 && rmsDelta > 0.03 && onsetRatio > 1.25) transitionTo('rising');
				break;
			case 'rising':
				if (rmsNow > 0.32 || (rmsDelta > 0.08 && onsetRatio > 1.8)) transitionTo('peak');
				else if (timeInSection > 12 && rmsDelta < 0) transitionTo('releasing');
				break;
			case 'peak':
				if (timeInSection > 3 && rmsDelta < -0.04) transitionTo('releasing');
				break;
			case 'releasing':
				if (rmsNow < 0.1 && timeInSection > 2) transitionTo('calm');
				else if (rmsDelta > 0.05 && timeInSection > 3) transitionTo('rising');
				break;
		}
	}

	private sectionBias() {
		if (this.section === 'rising') return 0.1;
		if (this.section === 'peak') return 0.2;
		if (this.section === 'releasing') return 0.32;
		return 0;
	}
}

export function createVisualDirector() {
	return new VisualDirector();
}
