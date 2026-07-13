// Director v2 — composes the three-tier pipeline into one update(features, time)
// call returning a VisualDirectorFrame consumed by every renderer.

import type {
	AudioFeatureFrame,
	VisualDirectorFrame,
	MusicalClock,
	DropState,
	VisualizerSection,
	MusicalPerformanceContext,
	PerformanceKeyMode
} from './types.js';
import { clamp01, AsymmetricEnvelope } from './util.js';
import { ClockTracker } from './clock.js';
import { DropDetector } from './drop.js';
import { PaletteEngine } from './palette.js';
import { StructureTracker, motifForSection } from './structure.js';
import {
	scoreContext,
	scorePerformanceAt,
	sectionAt,
	nextDropAfter,
	lastDropBefore
} from './score.js';

export * from './types.js';
export { hsvToRgb } from './util.js';
export {
	setActiveScore,
	setScorePlayback,
	type TrackScore
} from './score.js';

const SILENCE_THRESHOLD = 0.02;
const SILENCE_HOLD_S = 0.45;
const SCORE_KEY_CONFIDENCE_MIN = 0.1;

export class VisualDirector {
	private clock = new ClockTracker();
	private drop = new DropDetector();
	private palette = new PaletteEngine();
	private structure = new StructureTracker();

	private energyEnv = new AsymmetricEnvelope(0.03, 0.25, 60);
	private densityEnv = new AsymmetricEnvelope(0.08, 0.3, 60);
	private motionEnv = new AsymmetricEnvelope(0.06, 0.2, 60);
	private bassPunchEnv = new AsymmetricEnvelope(0.005, 0.12, 60);
	private trebleSparkEnv = new AsymmetricEnvelope(0.003, 0.08, 60);
	private valenceEnv = new AsymmetricEnvelope(2, 4, 60, 0.5);
	private arousalEnv = new AsymmetricEnvelope(0.5, 1.5, 60, 0.4);

	private silenceStart = 0;
	private subBassEnv = new AsymmetricEnvelope(0.05, 0.5, 60);
	private onsetDensityEnv = new AsymmetricEnvelope(0.1, 0.5, 60);
	// Fast rail one-frame denoise — symmetric ~30ms half-life. Just enough to
	// kill single-sample spikes from the FFT, not enough to lose transient feel.
	private rawBass = 0;
	private rawMid = 0;
	private rawTreble = 0;
	private rawCentroid = 0.5;

	update(features: AudioFeatureFrame | null | undefined, time: number): VisualDirectorFrame {
		const rms = features?.rms ?? 0;
		const bass = features?.bass ?? 0;
		const mid = features?.mid ?? 0;
		const treble = features?.treble ?? 0;
		const centroid = features?.centroid ?? 0.5;
		const onset = features?.onset === true;
		const chromaKey = features?.chroma_key ?? 0;
		const chromaStrength = features?.chroma_strength ?? 0;
		const beatPhase = features?.beat_phase ?? 0;
		const tempoBpm = features?.bpm ?? 120;

		// Silence gate.
		if (rms < SILENCE_THRESHOLD) {
			if (this.silenceStart === 0) this.silenceStart = time;
		} else {
			this.silenceStart = 0;
		}
		const silence = this.silenceStart > 0 && time - this.silenceStart > SILENCE_HOLD_S;

		// Tier 0/1 — clock + mid-level features.
		let clock = this.clock.update({ time, tempoBpm, beatPhase, onset });

		// Visual score: when offline analysis exists for the playing track,
		// the beat grid is ground truth — replace the live clock estimate.
		// The live trackers keep ticking underneath so fallback is seamless.
		const scored = scoreContext();
		if (scored && scored.score.beat_confidence >= 0.15 && !silence) {
			clock = scoreClock(scored.score, scored.positionMs, clock);
		}

		// Approximate spectral flatness from FFT bins when available; otherwise
		// fall back to a coarse estimate from (treble / (bass + mid + treble)).
		const flatness = approxFlatness(features?.bins, bass, mid, treble);
		const subBass = this.subBassEnv.tick(bass);
		const onsetDensity = this.onsetDensityEnv.tick(onset ? 1 : 0);
		let dropState = this.drop.update({
			time,
			rms,
			flatness,
			subBass,
			onsetDensity,
			clock
		});

		// Scheduled drops beat predicted drops: with a score we KNOW where the
		// next drop lands, so anticipation ramps over the 8s before it and the
		// post-drop watershed decays over 2.5s after — fused with the live
		// detector via max so genuinely surprising moments still register.
		if (scored && !silence) {
			dropState = scoreDropState(scored.score, scored.positionMs, dropState);
		}

		// Valence (mood polarity) and arousal (energy intensity) from coarse
		// proxies — full MLP belongs in the sidecar later.
		const valence = this.valenceEnv.tick(clamp01(0.4 + mid * 0.5 - treble * 0.2));
		const arousal = this.arousalEnv.tick(clamp01(rms * 1.2 + onsetDensity * 0.5));

		// Tier 2 — high-level intent.
		const struct = this.structure.update({ time, rms, drop: dropState, clock, silence });
		// Score section boundaries are ground truth where they exist; the FSM
		// keeps running underneath as the fallback (radio, unanalyzed tracks).
		let section: VisualizerSection = struct.section;
		let sectionAge = struct.sectionAge;
		const scorePerformance = scored
			? scorePerformanceAt(scored.score, scored.positionMs)
			: null;
		if (scored && !silence) {
			const fromScore = sectionAt(scored.score, scored.positionMs);
			if (fromScore) {
				section = fromScore;
				// The old frame returned the live FSM age even while a scored section
				// label was active. Use the actual offline boundary for coherent
				// section-scale choreography.
				sectionAge = Math.max(
					0,
					(scored.positionMs - (scorePerformance?.section?.start_ms ?? scored.positionMs)) /
						1000
				);
			}
		}

		// A confident full-track key is much more stable than the dominant note
		// in each live FFT frame. Keep live chroma as the radio/stream fallback.
		const offlineKey = scored?.score.key;
		const useOfflineKey =
			offlineKey !== undefined && offlineKey.confidence >= SCORE_KEY_CONFIDENCE_MIN;
		const paletteChromaKey = useOfflineKey
			? normalizePitchClass(offlineKey.pitch_class)
			: chromaKey;
		const paletteChromaStrength = useOfflineKey
			? clamp01(0.4 + offlineKey.confidence * 0.6)
			: chromaStrength;
		const palette = this.palette.update({
			chromaKey: paletteChromaKey,
			chromaStrength: paletteChromaStrength,
			valence,
			arousal,
			energy: rms
		});

		const { motif, motifIndex } = motifForSection(section, chromaKey, clock.phraseIndex);

		// Smoothed scalars for the renderer uniform. Drop anticipation + post-drop
		// decay add tension on top of raw energy so visuals pre-charge and ride out.
		const rawEnergy = clamp01(
			rms * 1.05 + bass * 0.25 + dropState.anticipation * 0.4 + dropState.postDropDecay * 0.6
		);
		const rawDensity = clamp01(rms * 0.55 + mid * 0.22 + treble * 0.18 + onsetDensity * 0.4);
		const rawMotion = clamp01(bass * 0.4 + mid * 0.3 + rms * 0.4 + dropState.anticipation * 0.3);

		const energy = this.energyEnv.tick(silence ? 0 : rawEnergy);
		const density = this.densityEnv.tick(silence ? 0.05 : rawDensity);
		const motion = this.motionEnv.tick(silence ? 0 : rawMotion);
		const bassPunch = this.bassPunchEnv.tick(bass);
		const trebleSparkle = this.trebleSparkEnv.tick(treble);

		// Fast rail — light denoise only, no envelope. Silence collapses to 0
		// so motifs that read raw bands don't keep pulsing when audio dies.
		const denoise = 0.4;
		this.rawBass = silence ? this.rawBass * 0.6 : this.rawBass + (bass - this.rawBass) * denoise;
		this.rawMid = silence ? this.rawMid * 0.6 : this.rawMid + (mid - this.rawMid) * denoise;
		this.rawTreble = silence ? this.rawTreble * 0.6 : this.rawTreble + (treble - this.rawTreble) * denoise;
		this.rawCentroid = this.rawCentroid + (centroid - this.rawCentroid) * denoise;

		const phrase = clock.phrasePos;
		const structureScalar = clamp01(0.7 - treble * 0.25 + chromaStrength * 0.35);
		const context: MusicalPerformanceContext = scored && scorePerformance
			? {
					source: 'score',
					sectionProgress: scorePerformance.sectionProgress,
					sectionEnergy: scorePerformance.sectionEnergy,
					trackProgress: scorePerformance.trackProgress,
					energyCurrent: scorePerformance.energyCurrent,
					energySlope: scorePerformance.energySlope,
					energyLookahead: scorePerformance.energyLookahead,
					keyPitchClass: normalizePitchClass(scored.score.key.pitch_class),
					keyMode: normalizeKeyMode(scored.score.key.mode),
					keyConfidence: clamp01(scored.score.key.confidence)
				}
			: {
					source: 'live',
					// Live sections have no known end; phrase position is the most useful
					// bounded progress rail until an offline score is available.
					sectionProgress: clock.phrasePos,
					sectionEnergy: energy,
					trackProgress: 0,
					energyCurrent: energy,
					energySlope: 0,
					energyLookahead: energy,
					keyPitchClass: normalizeLiveChroma(chromaKey),
					keyMode: 'unknown',
					keyConfidence: clamp01(chromaStrength)
				};

		return {
			section,
			sectionAge,
			motif,
			motifIndex,
			silence,
			energy,
			density,
			motion,
			structure: structureScalar,
			phrase,
			palette: palette.palette,
			paletteBase: palette.palette.baseHue,
			paletteAccent: palette.palette.accentHue,
			clock,
			drop: dropState,
			valence,
			arousal,
			bassPunch,
			trebleSparkle,
			tonnetz: palette.tonnetz,
			bassRaw: this.rawBass,
			midRaw: this.rawMid,
			trebleRaw: this.rawTreble,
			centroidRaw: this.rawCentroid,
			context
		};
	}
}

export function createVisualDirector() {
	return new VisualDirector();
}

/// Deterministic clock from the offline beat grid: bpm and phase come from
/// arithmetic on the playback position, not live estimation.
function scoreClock(
	score: import('./score.js').TrackScore,
	positionMs: number,
	live: MusicalClock
): MusicalClock {
	const beatMs = 60_000 / score.bpm;
	const beatsIn = (positionMs - score.beat_offset_ms) / beatMs;
	if (!Number.isFinite(beatsIn) || beatsIn < 0) return live;
	const beatPhase = beatsIn - Math.floor(beatsIn);
	const beatIndexAbs = Math.floor(beatsIn);
	const beatIndex = beatIndexAbs % 4;
	const barIndex = Math.floor(beatIndexAbs / 4);
	const phraseBars = 8;
	return {
		tempoBpm: score.bpm,
		beatPhase,
		// Sharp attack at the beat, cubic falloff — same shape the live
		// tracker produces, so renderers can't tell which rail fed them.
		beatPulse: Math.pow(1 - beatPhase, 3),
		downbeatFlag: beatIndex === 0 && beatPhase < 0.12,
		barIndex,
		beatIndex,
		phrasePos: (barIndex % phraseBars) / phraseBars + beatPhase / (4 * phraseBars),
		phraseIndex: Math.floor(barIndex / phraseBars)
	};
}

/// Fuse scheduled drops with the live detector (max of both rails).
function scoreDropState(
	score: import('./score.js').TrackScore,
	positionMs: number,
	live: DropState
): DropState {
	const ANTICIPATION_MS = 8000;
	const POST_DROP_MS = 2500;
	let anticipation = live.anticipation;
	let postDropDecay = live.postDropDecay;
	let dropEta = live.dropEta;
	let buildActive = live.buildActive;
	let buildProgress = live.buildProgress;

	const next = nextDropAfter(score, positionMs);
	if (next) {
		const untilMs = next.at_ms - positionMs;
		if (untilMs <= ANTICIPATION_MS) {
			const ramp = clamp01(1 - untilMs / ANTICIPATION_MS) * next.strength;
			if (ramp > anticipation) {
				anticipation = ramp;
				dropEta = untilMs / 1000;
				buildActive = true;
				buildProgress = clamp01(1 - untilMs / ANTICIPATION_MS);
			}
		}
	}
	const last = lastDropBefore(score, positionMs);
	if (last) {
		const sinceMs = positionMs - last.at_ms;
		if (sinceMs <= POST_DROP_MS) {
			postDropDecay = Math.max(postDropDecay, clamp01(1 - sinceMs / POST_DROP_MS) * last.strength);
		}
	}

	return { buildActive, buildProgress, dropEta, anticipation, postDropDecay };
}

function approxFlatness(
	bins: number[] | undefined,
	bass: number,
	mid: number,
	treble: number
): number {
	if (bins && bins.length >= 8) {
		// Wiener entropy: geomean / arithmean over magnitude bins.
		let logSum = 0;
		let sum = 0;
		let n = 0;
		for (let i = 0; i < bins.length; i++) {
			const v = bins[i] + 1e-6;
			logSum += Math.log(v);
			sum += v;
			n++;
		}
		if (n === 0 || sum < 1e-5) return 0.5;
		const geo = Math.exp(logSum / n);
		const arith = sum / n;
		return clamp01(geo / arith);
	}
	const total = bass + mid + treble + 1e-5;
	const dominance = Math.max(bass, mid, treble) / total;
	return clamp01(1 - dominance);
}

function normalizePitchClass(pitchClass: number): number {
	if (!Number.isFinite(pitchClass)) return 0;
	return (((pitchClass % 12) + 12) % 12) / 12;
}

function normalizeLiveChroma(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value > 1 ? normalizePitchClass(value) : clamp01(value);
}

function normalizeKeyMode(mode: string): PerformanceKeyMode {
	return mode === 'major' || mode === 'minor' ? mode : 'unknown';
}
