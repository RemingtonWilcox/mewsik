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

export type ScorePerformanceSample = {
	section: ScoreSection | null;
	sectionProgress: number;
	sectionEnergy: number;
	trackProgress: number;
	energyCurrent: number;
	energySlope: number;
	energyLookahead: number;
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

/** Raw scored section at a playback position, retained for timing/energy data. */
export function scoreSectionAt(score: TrackScore, ms: number): ScoreSection | null {
	for (const s of score.sections) {
		if (ms >= s.start_ms && ms < s.end_ms) {
			return s;
		}
	}
	// The analyzer works in whole-second structural buckets, so the final
	// section can end fractionally before decoded duration. Treat that tail as
	// part of the final section instead of dropping context for the last <1s.
	const last = score.sections.at(-1) ?? null;
	if (last && ms >= last.end_ms && ms <= score.duration_ms) return last;
	return null;
}

export function sectionAt(score: TrackScore, ms: number): VisualizerSection | null {
	const section = scoreSectionAt(score, ms);
	return section ? (LABEL_TO_SECTION[section.label] ?? null) : null;
}

/**
 * Deterministic slow context sampled from the offline visual score.
 * `energySlope` spans a four-second centered window; `energyLookahead` is
 * eight seconds ahead so renderers can pre-charge without knowing the curve
 * storage format.
 */
export function scorePerformanceAt(score: TrackScore, ms: number): ScorePerformanceSample {
	const durationMs = Math.max(0, score.duration_ms);
	const boundedMs = clamp(ms, 0, durationMs);
	const section = scoreSectionAt(score, boundedMs);
	const effectiveSectionEnd = section === score.sections.at(-1)
		? Math.max(section?.end_ms ?? 0, durationMs)
		: (section?.end_ms ?? 0);
	const sectionDuration = Math.max(1, effectiveSectionEnd - (section?.start_ms ?? 0));
	const sectionProgress = section
		? clamp01((boundedMs - section.start_ms) / sectionDuration)
		: 0;
	const sectionEnergy = clamp01(section?.energy ?? 0);
	const energyCurrent = scoreEnergyAt(score, boundedMs, sectionEnergy);
	const energyPast = scoreEnergyAt(score, boundedMs - 2000, energyCurrent);
	const energyFuture = scoreEnergyAt(score, boundedMs + 2000, energyCurrent);

	return {
		section,
		sectionProgress,
		sectionEnergy,
		trackProgress: durationMs > 0 ? clamp01(boundedMs / durationMs) : 0,
		energyCurrent,
		energySlope: clamp(energyFuture - energyPast, -1, 1),
		energyLookahead: scoreEnergyAt(score, boundedMs + 8000, energyCurrent)
	};
}

function scoreEnergyAt(score: TrackScore, ms: number, fallback: number): number {
	const curve = score.energy_curve;
	const hz = score.energy_hz;
	if (curve.length === 0 || !Number.isFinite(hz) || hz <= 0) return clamp01(fallback);
	const samplePosition = clamp((Math.max(0, ms) / 1000) * hz, 0, curve.length - 1);
	const lo = Math.floor(samplePosition);
	const hi = Math.min(curve.length - 1, lo + 1);
	const fraction = samplePosition - lo;
	return clamp01(curve[lo] + (curve[hi] - curve[lo]) * fraction);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
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
