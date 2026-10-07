// Musical clock — turns sidecar bpm + beat_phase into bar/beat/phrase indices
// with downbeat lock and a 32-bar phrase counter. Renderers consume this so
// they can quantize transitions to musical structure instead of wall time.
//
// We treat 4/4 as the default meter (mewsik audience is overwhelmingly 4/4).
// Downbeat lock uses onset alignment: when an onset lands within ±60ms of
// what the clock predicts as beat 1, we trust it as a downbeat and resync.

import { clamp01, wrap01, AsymmetricEnvelope } from './util.js';
import type { MusicalClock } from './types.js';

const BEATS_PER_BAR = 4;
const BARS_PER_PHRASE = 8;
const DOWNBEAT_LOCK_WINDOW_S = 0.06;

export class ClockTracker {
	private lastUpdate = -1;
	private barIndex = 0;
	private beatIndex = 0;
	private phrasePos = 0;
	private phraseIndex = 0;
	private prevBeatPhase = 0;
	private beatPulseEnv = new AsymmetricEnvelope(0.001, 0.12, 60);
	private downbeatFlag = false;
	private downbeatHoldUntil = 0;
	private locked = false;
	private timeAtBeatZero = 0;

	update(opts: {
		time: number;
		tempoBpm: number;
		beatPhase: number;
		onset: boolean;
	}): MusicalClock {
		const { time, beatPhase, onset } = opts;
		const tempoBpm = opts.tempoBpm > 30 ? opts.tempoBpm : 120;
		const phase = clamp01(beatPhase);

		const wrapped = this.prevBeatPhase > 0.7 && phase < 0.3;
		if (wrapped) {
			this.beatIndex = (this.beatIndex + 1) % BEATS_PER_BAR;
			if (this.beatIndex === 0) {
				this.barIndex++;
				this.downbeatFlag = true;
				this.downbeatHoldUntil = time + 0.08;
				this.phraseIndex = Math.floor(this.barIndex / BARS_PER_PHRASE);
			}
		} else if (time > this.downbeatHoldUntil) {
			this.downbeatFlag = false;
		}

		// Downbeat lock: if an onset arrives near beat 1, resync our beat index.
		if (onset && !this.locked) {
			const distToBeatOne = Math.min(phase, 1 - phase);
			if (distToBeatOne < DOWNBEAT_LOCK_WINDOW_S * (tempoBpm / 60)) {
				this.beatIndex = 0;
				this.timeAtBeatZero = time;
				this.locked = true;
			}
		}

		const phrasePos = wrap01(
			(this.barIndex % BARS_PER_PHRASE) / BARS_PER_PHRASE +
				(this.beatIndex + phase) / (BEATS_PER_BAR * BARS_PER_PHRASE)
		);
		this.phrasePos = phrasePos;

		const beatPulseTarget = 1 - phase;
		const beatPulse = this.beatPulseEnv.tick(beatPulseTarget);
		this.prevBeatPhase = phase;
		this.lastUpdate = time;

		return {
			tempoBpm,
			beatPhase: phase,
			beatPulse,
			downbeatFlag: this.downbeatFlag,
			barIndex: this.barIndex,
			beatIndex: this.beatIndex,
			phrasePos,
			phraseIndex: this.phraseIndex
		};
	}

	get currentBar() {
		return this.barIndex;
	}
}
