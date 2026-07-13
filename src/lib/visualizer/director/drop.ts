// Yadati 2014 — Detecting Drops in Electronic Dance Music.
//
// Build-up signature (causal, ~2-second window):
//   rms_slope > 0   ∧  flatness_slope < 0   ∧  sub_bass[<80Hz] drops below baseline
//   ∧  onset density climbs (risers / snare rolls dominate)
//
// On confident BUILD, we project the drop landing to the next downbeat after
// 8/16/32 bars (the dominant EDM build lengths). anticipation ramps 0→1 over
// the projected build window so renderers can pre-charge tension.
//
// Post-drop: a decay envelope so chorus/peak visuals don't immediately reset.

import { clamp01, RingBuffer } from './util.js';
import type { DropState, MusicalClock } from './types.js';

const HIST_LEN = 8 * 60;
const SLOPE_WINDOW = 90; // ~1.5s at 60 Hz
const BUILD_BAR_TARGETS = [8, 16, 32];

type Phase = 'idle' | 'building' | 'dropped' | 'decaying';

export class DropDetector {
	private phase: Phase = 'idle';
	private rmsHist = new RingBuffer(HIST_LEN);
	private flatnessHist = new RingBuffer(HIST_LEN);
	private subBassHist = new RingBuffer(HIST_LEN);
	private onsetDensityHist = new RingBuffer(HIST_LEN);
	private buildStartTime = 0;
	private buildStartBar = 0;
	private projectedDropTime = 0;
	private projectedDropBar = 0;
	private dropTime = 0;
	private postDropDecay = 0;
	private confidence = 0;

	update(opts: {
		time: number;
		rms: number;
		flatness: number;
		subBass: number;
		onsetDensity: number;
		clock: MusicalClock;
	}): DropState {
		const { time, rms, flatness, subBass, onsetDensity, clock } = opts;
		this.rmsHist.push(rms);
		this.flatnessHist.push(flatness);
		this.subBassHist.push(subBass);
		this.onsetDensityHist.push(onsetDensity);

		const rmsSlope = this.rmsHist.slope(0, SLOPE_WINDOW);
		const flatSlope = this.flatnessHist.slope(0, SLOPE_WINDOW);
		const subBassMean = this.subBassHist.mean(0, SLOPE_WINDOW);
		const subBassBaseline = this.subBassHist.mean(SLOPE_WINDOW * 2, SLOPE_WINDOW * 2);
		const onsetTrend = this.onsetDensityHist.slope(0, SLOPE_WINDOW);

		const buildScore =
			(rmsSlope > 0.0008 ? 1 : 0) +
			(flatSlope < -0.0004 ? 1 : 0) +
			(subBassMean < subBassBaseline * 0.7 ? 1 : 0) +
			(onsetTrend > 0.001 ? 1 : 0);

		switch (this.phase) {
			case 'idle': {
				if (buildScore >= 3 && rms > 0.05) {
					this.phase = 'building';
					this.buildStartTime = time;
					this.buildStartBar = clock.barIndex;
					this.confidence = buildScore / 4;
					this.projectBarTarget(clock);
				}
				break;
			}
			case 'building': {
				// Check the landing before cancelling a build. A real drop collapses
				// the riser signature that created buildScore, so testing cancellation
				// first discarded the exact bass/RMS jump we were waiting for.
				if (subBassMean > subBassBaseline * 1.2 && rmsSlope > 0.003) {
					this.phase = 'dropped';
					this.dropTime = time;
					this.postDropDecay = 1;
					break;
				}
				if (buildScore <= 1) {
					this.phase = 'idle';
					this.confidence = 0;
					break;
				}
				this.confidence = Math.max(this.confidence, buildScore / 4);
				break;
			}
			case 'dropped': {
				if (time - this.dropTime > 0.4) {
					this.phase = 'decaying';
				}
				break;
			}
			case 'decaying': {
				this.postDropDecay *= 0.985;
				if (this.postDropDecay < 0.02) {
					this.phase = 'idle';
					this.postDropDecay = 0;
					this.confidence = 0;
				}
				break;
			}
		}

		const buildActive = this.phase === 'building';
		const buildElapsed = buildActive ? time - this.buildStartTime : 0;
		const buildDur = Math.max(0.5, this.projectedDropTime - this.buildStartTime);
		const buildProgress = buildActive ? clamp01(buildElapsed / buildDur) : 0;
		const dropEta = buildActive ? Math.max(0, this.projectedDropTime - time) : 0;
		const anticipation = buildActive ? Math.pow(buildProgress, 1.4) * this.confidence : 0;

		return {
			buildActive,
			buildProgress,
			dropEta,
			anticipation,
			postDropDecay: this.phase === 'dropped' ? 1 : this.postDropDecay
		};
	}

	private projectBarTarget(clock: MusicalClock) {
		// Pick the nearest build target (8/16/32 bars) and project drop time
		// from current bar progress + tempo. Default to 16 bars when tempo is
		// unknown (Yadati's median build length).
		const beatsPerSec = clock.tempoBpm / 60;
		const beatsPerBar = 4;
		const barTime = beatsPerBar / Math.max(0.5, beatsPerSec);
		let pick = 16;
		for (const t of BUILD_BAR_TARGETS) {
			if (t >= 4) {
				pick = t;
				break;
			}
		}
		this.projectedDropBar = clock.barIndex + pick;
		this.projectedDropTime = this.buildStartTime + pick * barTime;
	}
}
