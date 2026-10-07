// Extended structure FSM — replaces the 4-state calm/rising/peak/releasing
// model. Drives section labels off the drop detector + RMS history + clock,
// with hysteresis (require new label to dominate for ≥1.5s before switching)
// so visuals don't flicker.

import { RingBuffer, clamp01 } from './util.js';
import type { DropState, MusicalClock, VisualizerSection } from './types.js';

const RMS_WIN_SHORT = 60;
const RMS_WIN_LONG = 300;
const MIN_DWELL_S = 1.5;

export class StructureTracker {
	private section: VisualizerSection = 'intro';
	private sectionEnterTime = 0;
	private rmsHist = new RingBuffer(8 * 60);
	private candidateSection: VisualizerSection | null = null;
	private candidateSince = 0;

	update(opts: {
		time: number;
		rms: number;
		drop: DropState;
		clock: MusicalClock;
		silence: boolean;
	}): { section: VisualizerSection; sectionAge: number } {
		const { time, rms, drop, clock, silence } = opts;
		this.rmsHist.push(rms);

		const rmsShort = this.rmsHist.mean(0, RMS_WIN_SHORT);
		const rmsLong = this.rmsHist.mean(0, RMS_WIN_LONG);
		const ratio = rmsShort / Math.max(0.001, rmsLong);

		let target: VisualizerSection = this.section;

		if (silence) {
			target = 'calm';
		} else if (drop.buildActive) {
			target = 'build';
		} else if (drop.postDropDecay > 0.5) {
			target = 'drop';
		} else if (drop.postDropDecay > 0.05) {
			target = 'chorus';
		} else if (rmsShort < 0.05) {
			target = 'breakdown';
		} else if (ratio > 1.25 && clock.phrasePos < 0.5) {
			target = 'pre_chorus';
		} else if (ratio > 1.05) {
			target = 'verse';
		} else if (ratio < 0.7) {
			target = 'bridge';
		} else {
			target = this.section;
		}

		// Hysteresis: target must persist for MIN_DWELL_S before we switch.
		if (target !== this.section) {
			if (this.candidateSection !== target) {
				this.candidateSection = target;
				this.candidateSince = time;
			} else if (time - this.candidateSince >= MIN_DWELL_S) {
				this.section = target;
				this.sectionEnterTime = time;
				this.candidateSection = null;
			}
		} else {
			this.candidateSection = null;
		}

		// Drops and downbeat-aligned transitions get an override fast-path.
		if (drop.postDropDecay > 0.5 && this.section !== 'drop' && this.section !== 'chorus') {
			this.section = 'drop';
			this.sectionEnterTime = time;
			this.candidateSection = null;
		}

		return {
			section: this.section,
			sectionAge: time - this.sectionEnterTime
		};
	}
}

export function motifForSection(
	section: VisualizerSection,
	chromaKey: number,
	phraseIndex: number
): { motif: 'organism' | 'tunnel' | 'lattice' | 'ribbon'; motifIndex: number } {
	switch (section) {
		case 'drop':
		case 'chorus':
			return { motif: 'tunnel', motifIndex: 1 };
		case 'build':
		case 'pre_chorus':
			return { motif: 'lattice', motifIndex: 2 };
		case 'bridge':
		case 'breakdown':
			return { motif: 'ribbon', motifIndex: 3 };
		case 'verse':
		case 'intro':
		case 'outro':
		case 'calm':
		default: {
			// Rotate organism through harmonic variations on phrase boundaries.
			const pitchClass = Math.floor(clamp01(chromaKey) * 12) % 12;
			const idx = (Math.floor(pitchClass / 3) + phraseIndex) % 4;
			const motifs: ('organism' | 'tunnel' | 'lattice' | 'ribbon')[] = [
				'organism',
				'tunnel',
				'lattice',
				'ribbon'
			];
			return { motif: motifs[idx], motifIndex: idx };
		}
	}
}
