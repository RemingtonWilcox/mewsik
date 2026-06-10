// The "visual score" — offline per-track analysis computed by the Rust
// backend (src-tauri/src/analysis/). When a score is active the director
// performs against known song structure instead of guessing live; when it
// is null (radio, streamed-only tracks, analysis pending) everything falls
// back to the real-time FSM.
//
// Module-level holder rather than per-director state: several director
// instances exist (host + each engine component — known debt), and all of
// them should see the same score without threading it through every
// component call site.

import type { VisualizerSection } from './types.js';

export type ScoreSection = {
	start_ms: number;
	end_ms: number;
	label: string;
	energy: number;
};

export type ScoreDrop = {
	at_ms: number;
	strength: number;
};

export type TrackScore = {
	version: number;
	duration_ms: number;
	bpm: number;
	beat_offset_ms: number;
	beat_confidence: number;
	key: { pitch_class: number; mode: string; confidence: number };
	sections: ScoreSection[];
	drops: ScoreDrop[];
	energy_hz: number;
	energy_curve: number[];
};

let activeScore: TrackScore | null = null;
// Playback anchor: last known position + wall clock, extrapolated while
// playing so the 250ms poll cadence doesn't quantize the beat grid.
let anchorPositionMs = 0;
let anchorWallMs = 0;
let anchorPlaying = false;

export function setActiveScore(score: TrackScore | null): void {
	activeScore = score;
}

export function setScorePlayback(positionMs: number, isPlaying: boolean): void {
	anchorPositionMs = positionMs;
	anchorWallMs = performance.now();
	anchorPlaying = isPlaying;
}

export type ScoreContext = {
	score: TrackScore;
	positionMs: number;
};

/** Current score + extrapolated playback position, or null when inactive. */
export function scoreContext(): ScoreContext | null {
	if (!activeScore) return null;
	const elapsed = anchorPlaying ? performance.now() - anchorWallMs : 0;
	// An anchor older than ~4s means the poll stopped feeding us (track
	// ended, app state confused) — don't extrapolate into fiction.
	if (anchorPlaying && elapsed > 4000) return null;
	return { score: activeScore, positionMs: anchorPositionMs + elapsed };
}

const LABEL_TO_SECTION: Record<string, VisualizerSection> = {
	intro: 'intro',
	verse: 'verse',
	build: 'build',
	chorus: 'chorus',
	drop: 'drop',
	breakdown: 'breakdown',
	bridge: 'bridge',
	outro: 'outro'
};

export function sectionAt(score: TrackScore, ms: number): VisualizerSection | null {
	for (const s of score.sections) {
		if (ms >= s.start_ms && ms < s.end_ms) {
			return LABEL_TO_SECTION[s.label] ?? null;
		}
	}
	return null;
}

export function nextDropAfter(score: TrackScore, ms: number): ScoreDrop | null {
	let best: ScoreDrop | null = null;
	for (const d of score.drops) {
		if (d.at_ms > ms && (!best || d.at_ms < best.at_ms)) best = d;
	}
	return best;
}

export function lastDropBefore(score: TrackScore, ms: number): ScoreDrop | null {
	let best: ScoreDrop | null = null;
	for (const d of score.drops) {
		if (d.at_ms <= ms && (!best || d.at_ms > best.at_ms)) best = d;
	}
	return best;
}
