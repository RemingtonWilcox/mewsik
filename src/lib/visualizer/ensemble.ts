// Ensemble listening: what each part of the band is doing, as many
// independent musical channels, so every small part of a picture can answer
// to its own part of the music instead of the whole frame following one
// energy envelope.
//
// The tracker runs once per journey tick, after the director and the music
// character, from the raw ensemble features in the analyzer frame (chroma,
// bass chroma, per-layer onset strengths, stereo image; see
// src/lib/audio/ensemble-features.ts and src-tauri/src/audio/analyzer.rs), the
// director's beat clock and the shared perceptual spectrum. It is
// deterministic (same frames and dt in, same channels out), allocation-free in
// steady state, and its output object and typed arrays keep their identity:
// consumers read them in place and copy what they want to remember.
//
// Channel reference. Ranges are 0..1 unless noted. "Impulse" means 1 (or the
// event strength) on the tick an event fires, then an exponential decay with
// the given time constant; every event also has a `...Serial` that counts up
// once per event and never resets (not even on a new source), so an engine
// can answer each event exactly once. Latency is from the sound to the
// channel on the native path; the lab's file path is the same.
//
// grid — the metrical frame the other channels are measured on
//   known            boolean  a tempo is known (heard, reported, or a score)
//   bpm              30..260  ensemble tempo: a score's when one plays, else
//                             this tracker's own (autocorrelation of the hits
//                             it hears, preferring ~115 bpm octaves; the live
//                             beat tracker's phase and octave are not trusted)
//   beatPhase, barPhase       position in the beat / 4-beat bar, anchored on
//                             where kicks and snares land (live: ~4 s to lock)
//   bar              int      bar counter (monotonic within a source)
//
// drums.{kick, snare, hat, perc} and notes (tonal onsets), each an EnsembleLayer:
//   hit              impulse  velocity of the hit; tau kick .12 snare .14 hat .06
//                             perc .10 notes .12 s. Latency ~35 ms (one 2048 FFT
//                             window plus one frame of peak picking)
//   serial           int      one per hit
//   velocity                  strength of the last hit (relative to the layer's
//                             recent loudest hits, so ghost notes read ~0.3)
//   accent                    how much the last hit stood out over the layer's
//                             typical hit (0 ordinary, 1 a strong accent)
//   sinceHit         s        seconds since the last hit
//   perBeat          0..8     hits per beat, smoothed over ~2 bars
//   activity                  perBeat / (perBeat + 1): 1 per beat -> 0.5
//   present                   the layer is playing (fast attack, ~2 bar release)
//   barPos, step              where in the bar the last hit landed (0..1, and
//                             its sixteenth 0..15, swing-corrected)
//   pattern          16 x 0..1 the learned hit strength on each sixteenth
//   Kicks are confirmed ~0.2 s later by their decay; an unconfirmed low onset
//   (a bass note) still fires `hit` but feeds bass.activity, not the drum
//   pattern or presence.
//
// groove
//   confidence                how far the grid channels can be trusted
//   swing                     0 straight eighths .. 1 triplet (2:1) swing
//   swingRatio       1..3     long:short eighth ratio (1 straight, 2 triplet)
//   syncopation               share of accented hits on weak sixteenths, ~3 s
//   regularity                how well recent bars match the learned 1-2 bar
//                             pattern; updated each bar
//   fill             impulse  a fill started (tau .6 s); fillSerial; latency
//                             1/4..1 beat into the fill
//   fillIntensity             envelope, high while a fill plays
//   sinceFill        s
//   drums                     overall drum presence
//   breakdown                 drums were established and are gone while the
//                             music plays on (envelope)
//   dropout          impulse  drums vanished (tau .8 s); dropoutSerial; ~2 beats
//   drumReturn       impulse  drums came back (tau .8 s); drumReturnSerial; ~1 beat
//
// harmony
//   chroma           12 x 0..1 smoothed pitch-class profile (C = 0), max = 1
//   root             -1..11   current chord root (-1 none)
//   quality          string   'major' 'minor' 'diminished' 'augmented'
//                             'suspended' 'dominant7' 'none'; qualityIndex
//   qualities        7 x 0..1 probabilities in ENSEMBLE_CHORD_QUALITIES order
//   confidence                template fit of the current chord
//   change           impulse  the chord changed (1 root, .6 quality only;
//                             tau .35 s); changeSerial; ~250-350 ms
//   sinceChange      s
//   changesPerBar    0..4     harmonic rhythm, smoothed over ~8 s
//   tension                   dissonance: chord quality, clashing pitch
//                             classes, notes outside the chord and the key
//   degree           -1..11   chord root relative to the key's tonic
//   key.tonic        0..11    Krumhansl key over ~10 s; key.mode 'major'|'minor'
//   key.major, key.minor      mode probabilities (sum 1)
//   key.confidence, key.stability (how settled), key.changeSerial; 5-20 s
//
// bass
//   pitchClass       -1..11   bass note (-1 none); confidence
//   note             impulse  a new bass note (tau .15 s); noteSerial; ~120 ms
//   interval         -6..6    last move in semitones (shortest way round)
//   stepwise                  share of recent moves that were steps (<= 2 st)
//   walking                   stepwise and about one note per beat
//   perBeat, activity         bass notes per beat (pitch changes and re-attacks)
//   level                     low-register level
//
// articulation
//   legato                    0 staccato .. 1 legato (mid register weighted);
//                             staccato = 1 - legato. From each note's level
//                             ~85 ms after its onset relative to its peak and
//                             the level before it; ~4 notes to settle
//   low, mid, high            the same per register
//   sustain                   sustained floor over peaks, mid register, ~1.5 s
//   pad                       sustained-pad presence: tonal, sustained, few
//                             onsets
//   noteRate         /s       tonal onsets per second
//
// texture
//   eventsPerSecond  /s       all hits and notes, ~2 s
//   density                   eventsPerSecond / (eventsPerSecond + 5)
//   trend            -1..1    energy, density and brightness slope over ~8 s
//   build                     rising part of the trend (smoothed)
//   low, mid, high            register levels (adaptive, 0..1)
//   register         -1..1    high minus low balance
//   width                     stereo side share (0 mono); correlation -1..1;
//                             stereoKnown false -> neutral 0.3 / 0.7
//   tonality                  pitched vs noisy (chroma peakiness, flatness);
//                             noisiness = 1 - tonality
//
// Reset: a new source (beginSource) clears everything song-specific (patterns,
// chord, key, bass line, swing, articulation, trends) and keeps the serials and
// the last tempo as a prior until the new clock is known.

import type { AudioFeatureFrame, VisualDirectorFrame } from '$lib/visualizer/director/types';
import type { SignalSpectrumProfile } from '$lib/visualizer/signal/spectrum';

export const ENSEMBLE_LAYERS = ['kick', 'snare', 'hat', 'perc', 'notes'] as const;
export type EnsembleLayerName = (typeof ENSEMBLE_LAYERS)[number];
export const ENSEMBLE_DRUM_LAYERS = ['kick', 'snare', 'hat', 'perc'] as const;

export const ENSEMBLE_CHORD_QUALITIES = [
	'major',
	'minor',
	'diminished',
	'augmented',
	'suspended',
	'dominant7',
	'none'
] as const;
export type EnsembleChordQuality = (typeof ENSEMBLE_CHORD_QUALITIES)[number];

export type EnsembleLayer = {
	hit: number;
	serial: number;
	velocity: number;
	accent: number;
	sinceHit: number;
	perBeat: number;
	activity: number;
	present: number;
	barPos: number;
	step: number;
	readonly pattern: Float32Array;
};

export type EnsembleFrame = {
	/** Seconds of ensemble time (sum of dt since construction). */
	time: number;
	readonly grid: {
		known: boolean;
		bpm: number;
		beatPhase: number;
		barPhase: number;
		bar: number;
	};
	readonly drums: {
		readonly kick: EnsembleLayer;
		readonly snare: EnsembleLayer;
		readonly hat: EnsembleLayer;
		readonly perc: EnsembleLayer;
	};
	readonly notes: EnsembleLayer;
	readonly groove: {
		confidence: number;
		swing: number;
		swingRatio: number;
		syncopation: number;
		regularity: number;
		fill: number;
		fillSerial: number;
		fillIntensity: number;
		sinceFill: number;
		drums: number;
		breakdown: number;
		dropout: number;
		dropoutSerial: number;
		drumReturn: number;
		drumReturnSerial: number;
	};
	readonly harmony: {
		readonly chroma: Float32Array;
		root: number;
		quality: EnsembleChordQuality;
		qualityIndex: number;
		readonly qualities: Float32Array;
		confidence: number;
		change: number;
		changeSerial: number;
		sinceChange: number;
		changesPerBar: number;
		tension: number;
		degree: number;
		readonly key: {
			tonic: number;
			mode: 'major' | 'minor';
			major: number;
			minor: number;
			confidence: number;
			stability: number;
			changeSerial: number;
		};
	};
	readonly bass: {
		pitchClass: number;
		confidence: number;
		note: number;
		noteSerial: number;
		interval: number;
		stepwise: number;
		walking: number;
		perBeat: number;
		activity: number;
		level: number;
	};
	readonly articulation: {
		legato: number;
		staccato: number;
		low: number;
		mid: number;
		high: number;
		sustain: number;
		pad: number;
		noteRate: number;
	};
	readonly texture: {
		eventsPerSecond: number;
		density: number;
		trend: number;
		build: number;
		low: number;
		mid: number;
		high: number;
		register: number;
		width: number;
		correlation: number;
		stereoKnown: boolean;
		tonality: number;
		noisiness: number;
	};
};

// ---- Tuning ------------------------------------------------------------------

const HIT_TAU = [0.12, 0.14, 0.06, 0.1, 0.12];
/** Leaky-rate time constant for hits per second, seconds. */
const RATE_TAU_S = 2.5;
const PRESENT_RELEASE_BARS = 2;
/** Weight of each layer in swing (offbeat placement) and syncopation. */
const SWING_WEIGHT = [0.15, 0.35, 1, 0.6, 0.25];
const SYNC_WEIGHT = [1, 0.8, 0.15, 0.6, 0.6];
/** Metrical weight of each sixteenth in a 4/4 bar (1 = downbeat). */
const METRIC_WEIGHT = new Float32Array([1, 0.1, 0.35, 0.1, 0.8, 0.1, 0.35, 0.1, 0.9, 0.1, 0.35, 0.1, 0.8, 0.1, 0.35, 0.1]);
const SWING_BINS = 80; // hit histogram over relative phase 0.1 .. 0.9 (0.01 bins)
const SWING_KERNEL = [0.25, 0.6, 1, 0.6, 0.25];
const SWING_HIST_TAU_S = 8;
const PHASE_BINS = 24;
/** Own tempo: onset envelope bins per second, history length, lag range. */
const TEMPO_RATE = 60;
const TEMPO_BINS = 360;
const TEMPO_MIN_LAG = 16; // 225 bpm
const TEMPO_MAX_LAG = 70; // ~51 bpm
const PATTERN_LEARN = 0.3;
const FILL_THRESHOLD = 0.42;
const KICK_CONFIRM_S = 0.2;
/** A kick keeps less than this share of its rise after KICK_CONFIRM_S; a bass note more. */
const KICK_KEPT_MAX = 0.72;
const CHORD_TAU_S = 0.12;
const CHORD_HOLD_S = 0.1;
const CHORD_MARGIN = 0.04;
const KEY_TAU_S = 10;
const KEY_HOLD_S = 2;
const BASS_TAU_S = 0.09;
const BASS_HOLD_S = 0.06;
const ARTIC_PEAK_S = 0.04;
const ARTIC_MEASURE_S = 0.085;
const NEUTRAL_WIDTH = 0.3;
const NEUTRAL_CORRELATION = 0.7;

type ChordTemplate = { category: number; weights: Float32Array };

/** Chord templates: intervals with weights; categories index ENSEMBLE_CHORD_QUALITIES. */
const TEMPLATE_SPECS: readonly [number, readonly (readonly [number, number])[]][] = [
	[0, [[0, 1], [4, 0.9], [7, 0.8]]], // major
	[1, [[0, 1], [3, 0.9], [7, 0.8]]], // minor
	[2, [[0, 1], [3, 0.9], [6, 0.85]]], // diminished
	[3, [[0, 1], [4, 0.9], [8, 0.85]]], // augmented
	[4, [[0, 1], [5, 0.9], [7, 0.8]]], // sus4
	[4, [[0, 1], [2, 0.9], [7, 0.8]]], // sus2
	[5, [[0, 1], [4, 0.85], [7, 0.75], [10, 0.75]]], // dominant 7th
	[0, [[0, 1], [4, 0.85], [7, 0.75], [11, 0.7]]], // major 7th
	[1, [[0, 1], [3, 0.85], [7, 0.75], [10, 0.7]]], // minor 7th
	[2, [[0, 1], [3, 0.85], [6, 0.8], [10, 0.7]]] // half-diminished
];
/** Sevenths fit any triad they contain a little; triads win a tie. */
const TEMPLATE_PRIOR = [0.02, 0.02, 0.01, 0, 0, 0, 0, 0, 0, 0];
const QUALITY_TENSION = [0.08, 0.22, 0.8, 0.75, 0.42, 0.62, 0.45];

function centredTemplate(spec: readonly (readonly [number, number])[]): Float32Array {
	const t = new Float32Array(12);
	for (const [interval, weight] of spec) t[interval] = weight;
	let mean = 0;
	for (let i = 0; i < 12; i += 1) mean += t[i];
	mean /= 12;
	let norm = 0;
	for (let i = 0; i < 12; i += 1) {
		t[i] -= mean;
		norm += t[i] * t[i];
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < 12; i += 1) t[i] /= norm;
	return t;
}

const TEMPLATES: readonly ChordTemplate[] = TEMPLATE_SPECS.map(([category, spec]) => ({
	category,
	weights: centredTemplate(spec)
}));

/** Krumhansl-Kessler key profiles, tonic first. */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function centred(profile: readonly number[]): Float32Array {
	const out = Float32Array.from(profile);
	let mean = 0;
	for (const v of out) mean += v;
	mean /= out.length;
	let norm = 0;
	for (let i = 0; i < out.length; i += 1) {
		out[i] -= mean;
		norm += out[i] * out[i];
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < out.length; i += 1) out[i] /= norm;
	return out;
}

const KEY_MAJOR = centred(KK_MAJOR);
/** Scale degrees as bit masks (bit n = n semitones above the tonic). */
const MAJOR_SCALE_MASK = (1 << 0) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 9) | (1 << 11);
const MINOR_SCALE_MASK = (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 10);
const KEY_MINOR = centred(KK_MINOR);

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : Number.isFinite(value) ? value : low;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

function wrap01(value: number): number {
	const f = value - Math.floor(value);
	return f < 0 ? f + 1 : f;
}

function decay(dt: number, tau: number): number {
	return Math.exp(-dt / tau);
}

function approach(current: number, target: number, dt: number, tau: number): number {
	return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>, n: number): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na < 1e-9 && nb < 1e-9) return 1;
	if (na < 1e-9 || nb < 1e-9) return 0;
	return dot / Math.sqrt(na * nb);
}

/** Shortest signed distance between two pitch classes, -6..6. */
function pitchInterval(from: number, to: number): number {
	const d = (((to - from) % 12) + 12) % 12;
	return d > 6 ? d - 12 : d;
}

/** Rotate an array left by `by` in place (out[i] = in[(i + by) % n]). */
function rotate(values: Float32Array, by: number): void {
	const n = values.length;
	const k = ((by % n) + n) % n;
	if (k === 0) return;
	const copy = ROTATE_SCRATCH.subarray(0, n);
	copy.set(values);
	for (let i = 0; i < n; i += 1) values[i] = copy[(i + k) % n];
}
const ROTATE_SCRATCH = new Float32Array(32);

function makeLayer(): EnsembleLayer {
	return {
		hit: 0,
		serial: 0,
		velocity: 0,
		accent: 0,
		sinceHit: 1e6,
		perBeat: 0,
		activity: 0,
		present: 0,
		barPos: 0,
		step: 0,
		pattern: new Float32Array(16)
	};
}

function createFrame(): EnsembleFrame {
	return {
		time: 0,
		grid: { known: false, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
		drums: { kick: makeLayer(), snare: makeLayer(), hat: makeLayer(), perc: makeLayer() },
		notes: makeLayer(),
		groove: {
			confidence: 0,
			swing: 0,
			swingRatio: 1,
			syncopation: 0,
			regularity: 0,
			fill: 0,
			fillSerial: 0,
			fillIntensity: 0,
			sinceFill: 1e6,
			drums: 0,
			breakdown: 0,
			dropout: 0,
			dropoutSerial: 0,
			drumReturn: 0,
			drumReturnSerial: 0
		},
		harmony: {
			chroma: new Float32Array(12),
			root: -1,
			quality: 'none',
			qualityIndex: 6,
			qualities: new Float32Array(7),
			confidence: 0,
			change: 0,
			changeSerial: 0,
			sinceChange: 1e6,
			changesPerBar: 0,
			tension: 0,
			degree: -1,
			key: { tonic: 0, mode: 'major', major: 0.5, minor: 0.5, confidence: 0, stability: 0, changeSerial: 0 }
		},
		bass: {
			pitchClass: -1,
			confidence: 0,
			note: 0,
			noteSerial: 0,
			interval: 0,
			stepwise: 0,
			walking: 0,
			perBeat: 0,
			activity: 0,
			level: 0
		},
		articulation: { legato: 0.5, staccato: 0.5, low: 0.5, mid: 0.5, high: 0.5, sustain: 0.5, pad: 0, noteRate: 0 },
		texture: {
			eventsPerSecond: 0,
			density: 0,
			trend: 0,
			build: 0,
			low: 0,
			mid: 0,
			high: 0,
			register: 0,
			width: NEUTRAL_WIDTH,
			correlation: NEUTRAL_CORRELATION,
			stereoKnown: false,
			tonality: 0,
			noisiness: 1
		}
	};
}

/** Per-layer working state behind an EnsembleLayer. */
type LayerState = {
	rate: number;
	typical: number;
	presentHold: number;
	bar: Float32Array;
	patternB: [Float32Array, Float32Array];
	/** Strength per absolute sixteenth, ring of 16. */
	steps: Float32Array;
};

function makeLayerState(): LayerState {
	return {
		rate: 0,
		typical: 0.6,
		presentHold: 0,
		bar: new Float32Array(16),
		patternB: [new Float32Array(16), new Float32Array(16)],
		steps: new Float32Array(16)
	};
}

type Articulator = {
	/** Level history: one value per tick, ring of 8. */
	history: Float32Array;
	head: number;
	armedAt: number;
	floor: number;
	peak: number;
	legato: number;
	weight: number;
};

function makeArticulator(): Articulator {
	return { history: new Float32Array(8), head: 0, armedAt: -1, floor: 0, peak: 0, legato: 0.5, weight: 0 };
}

const TREND_SAMPLES = 32;
const TREND_STEP_S = 0.25;

export class EnsembleTracker {
	private readonly frame = createFrame();
	private readonly layers: EnsembleLayer[];
	private readonly state: LayerState[] = ENSEMBLE_LAYERS.map(() => makeLayerState());
	private time = 0;

	// Grid.
	private tempoPrior = 120;
	// Tempo: onset-strength envelope at 60 bins/s over 6 s.
	private readonly onsetEnvelope = new Float32Array(TEMPO_BINS);
	private readonly tempoScratch = new Float32Array(TEMPO_BINS);
	private readonly tempoScores = new Float32Array(TEMPO_MAX_LAG + 2);
	private envelopeBin = -1;
	private tempoClock = 0;
	private tempo = 120;
	private tempoCandidate = 0;
	private tempoCandidateVotes = 0;
	private tempoConfidence = 0;
	private lastBar = Number.NaN;
	private lastAbsStep = Number.NaN;
	private barsLearned = 0;
	private barIsFill = false;
	private fillBarsInRow = 0;
	/** Beats of the current bar that scored like a fill (kept out of learning). */
	private readonly beatSuspect = new Uint8Array(4);
	private patternGapBeats = 4;
	private regularityAcc = 0;

	// Swing.
	private readonly swingHist = new Float32Array(SWING_BINS);
	private swingPos = 0.5;

	// Syncopation.
	private syncNum = 0;
	private syncDen = 0;

	// Fill / dropout.
	private fillScore = 0;
	private drumRate = 0;
	private drumEstablished = 0;
	private inBreakdown = false;
	private sinceDrum = 1e6;
	private returnHits = 0;
	private readonly expected = new Float32Array(16);
	private readonly actual = new Float32Array(16);

	// Pending kicks awaiting decay confirmation.
	private readonly pendingAt = new Float64Array(4).fill(-1);
	private readonly pendingPre = new Float32Array(4);
	private readonly pendingPeak = new Float32Array(4);
	private readonly pendingVel = new Float32Array(4);
	/** Low-register level per tick, ring of 6, to find the level before a kick. */
	private readonly lowHistory = new Float32Array(6);
	private lowHead = 0;

	// Harmony.
	private readonly chromaSmooth = new Float32Array(12);
	private readonly chromaNorm = new Float32Array(12);
	private readonly scores = new Float32Array(12 * TEMPLATES.length);
	private chordRoot = -1;
	private chordTemplate = -1;
	private candidateRoot = -1;
	private candidateTemplate = -1;
	private candidateTime = 0;
	private noneTime = 0;
	private changeRate = 0;
	private tonalitySmooth = 0;

	// Key.
	private readonly keyChroma = new Float32Array(12);
	private keyIndex = -1;
	private keyCandidate = -1;
	private keyCandidateTime = 0;
	private sinceKeyChange = 0;

	// Bass.
	private readonly bassSmooth = new Float32Array(12);
	private bassPc = -1;
	private bassCandidate = -1;
	private bassCandidateTime = 0;
	private bassRate = 0;
	private sinceKick = 1e6;

	// Articulation.
	private readonly articulators: Articulator[] = [makeArticulator(), makeArticulator(), makeArticulator()];
	private readonly registerLevels = new Float32Array(3);
	private readonly registerTriggers = new Float32Array(3);
	private sustainMin = 0;
	private sustainMax = 0;
	private sustainWindow = 0;
	private sustainValue = 0.5;
	private noteRate = 0;

	// Texture.
	private eventRate = 0;
	private readonly trendEnergy = new Float32Array(TREND_SAMPLES);
	private readonly trendDensity = new Float32Array(TREND_SAMPLES);
	private readonly trendBright = new Float32Array(TREND_SAMPLES);
	private trendCount = 0;
	private trendHead = 0;
	private trendClock = 0;
	private trendAccE = 0;
	private trendAccD = 0;
	private trendAccB = 0;
	private trendAccN = 0;
	private sinceStereo = 1e6;

	// Fallback onsets (frames without raw ensemble fields).
	private readonly fallbackPrev = new Float32Array(5);
	private readonly fallbackOnsets = new Float32Array(5);
	private readonly onsets = new Float32Array(5);

	constructor() {
		const f = this.frame;
		this.layers = [f.drums.kick, f.drums.snare, f.drums.hat, f.drums.perc, f.notes];
	}

	get current(): EnsembleFrame {
		return this.frame;
	}

	/**
	 * A new source: forget the song (patterns, chord, key, bass line, swing,
	 * articulation, trends); keep the serials and the tempo as a prior.
	 */
	beginSource(): void {
		const f = this.frame;
		if (f.grid.known) this.tempoPrior = f.grid.bpm;
		this.onsetEnvelope.fill(0);
		this.envelopeBin = -1;
		this.tempoClock = 0;
		this.tempoCandidate = 0;
		this.tempoCandidateVotes = 0;
		this.tempoConfidence = 0;
		this.tempo = this.tempoPrior;
		this.lastBar = Number.NaN;
		this.lastAbsStep = Number.NaN;
		this.barsLearned = 0;
		this.barIsFill = false;
		this.fillBarsInRow = 0;
		this.patternGapBeats = 4;
		this.regularityAcc = 0;
		this.swingHist.fill(0);
		this.anchor = 0;
		this.anchorVote = 0;
		this.anchorHist.fill(0);
		this.downbeat = 0;
		this.downbeatVote = 0;
		this.kickBeats.fill(0);
		this.snareBeats.fill(0);
		this.swingPos = 0.5;
		this.syncNum = 0;
		this.syncDen = 0;
		this.fillScore = 0;
		this.drumRate = 0;
		this.drumEstablished = 0;
		this.inBreakdown = false;
		this.sinceDrum = 1e6;
		this.returnHits = 0;
		this.pendingAt.fill(-1);
		for (let i = 0; i < this.state.length; i += 1) {
			const s = this.state[i];
			s.rate = 0;
			s.typical = 0.6;
			s.presentHold = 0;
			s.bar.fill(0);
			s.patternB[0].fill(0);
			s.patternB[1].fill(0);
			s.steps.fill(0);
			const layer = this.layers[i];
			layer.perBeat = 0;
			layer.activity = 0;
			layer.present = 0;
			layer.pattern.fill(0);
			layer.accent = 0;
		}
		this.chromaSmooth.fill(0);
		this.chordRoot = -1;
		this.chordTemplate = -1;
		this.candidateRoot = -1;
		this.candidateTime = 0;
		this.changeRate = 0;
		this.keyChroma.fill(0);
		this.keyIndex = -1;
		this.keyCandidate = -1;
		this.keyCandidateTime = 0;
		this.sinceKeyChange = 0;
		this.bassSmooth.fill(0);
		this.bassPc = -1;
		this.bassCandidate = -1;
		this.bassRate = 0;
		for (const a of this.articulators) {
			a.armedAt = -1;
			a.legato = 0.5;
			a.weight = 0;
		}
		this.sustainValue = 0.5;
		this.sustainWindow = 0;
		this.noteRate = 0;
		this.eventRate = 0;
		this.trendCount = 0;
		this.trendHead = 0;
		this.trendClock = 0;
		this.trendAccN = 0;
		f.groove.swing = 0;
		f.groove.swingRatio = 1;
		f.groove.regularity = 0;
		f.groove.syncopation = 0;
		f.groove.breakdown = 0;
		f.groove.fillIntensity = 0;
		f.harmony.root = -1;
		f.harmony.quality = 'none';
		f.harmony.qualityIndex = 6;
		f.harmony.degree = -1;
		f.harmony.key.stability = 0;
		f.harmony.key.confidence = 0;
		f.bass.pitchClass = -1;
		f.bass.stepwise = 0;
		f.bass.walking = 0;
		f.articulation.pad = 0;
		f.texture.trend = 0;
		f.texture.build = 0;
	}

	update(
		features: AudioFeatureFrame | null,
		director: VisualDirectorFrame,
		spectrum: Readonly<SignalSpectrumProfile>,
		dtSeconds: number
	): EnsembleFrame {
		const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? Math.min(dtSeconds, 0.25) : 1 / 60;
		this.time += dt;
		const f = this.frame;
		f.time = this.time;
		const live = features !== null && !director.silence;

		this.readOnsets(features, spectrum, live);
		this.updateGrid(features, director, dt);
		this.updateLayers(spectrum, dt, live);
		this.updateGroove(dt, live);
		this.updateHarmony(features, spectrum, dt, live);
		this.updateBass(features, spectrum, dt, live);
		this.updateArticulation(spectrum, dt, live);
		this.updateTexture(features, director, spectrum, dt, live);
		return f;
	}

	// ---- Onsets ----------------------------------------------------------------

	private readOnsets(features: AudioFeatureFrame | null, spectrum: Readonly<SignalSpectrumProfile>, live: boolean): void {
		const o = this.onsets;
		o.fill(0);
		if (!live || !features) return;
		if (features.onset_kick !== undefined) {
			o[0] = clamp01(features.onset_kick ?? 0);
			o[1] = clamp01(features.onset_snare ?? 0);
			o[2] = clamp01(features.onset_hat ?? 0);
			o[3] = clamp01(features.onset_perc ?? 0);
			o[4] = clamp01(features.onset_tonal ?? 0);
			return;
		}
		// Older frames: rising edges of the spectrum's band deltas.
		const d = spectrum.deltas;
		const values = this.fallbackOnsets;
		values[0] = Math.max(d.kick, d.sub);
		values[1] = Math.min(d.mids, d.presence);
		values[2] = d.air;
		values[3] = d.body;
		values[4] = spectrum.novelty * 0.5;
		for (let i = 0; i < 5; i += 1) {
			if (values[i] > 0.28 && this.fallbackPrev[i] <= 0.28) o[i] = clamp01(values[i] * 1.6);
			this.fallbackPrev[i] = values[i];
		}
	}

	// ---- Grid ------------------------------------------------------------------

	private beatPos = 0;
	/** Live beat count integrated from the clock's tempo. */
	private ownBeat = 0;
	/** Beat anchor in beats (unwrapped) and downbeat rotation in beats. */
	private anchor = 0;
	private anchorVote = 0;
	private readonly anchorHist = new Float32Array(PHASE_BINS);
	private downbeat = 0;
	private downbeatVote = 0;
	private readonly kickBeats = new Float32Array(4);
	private readonly snareBeats = new Float32Array(4);

	private updateGrid(features: AudioFeatureFrame | null, director: VisualDirectorFrame, dt: number): void {
		const g = this.frame.grid;
		const clock = director.clock;
		const scored = director.context.source === 'score';
		// Only a score's clock is trusted. A live beat tracker's tempo can sit
		// an octave out and its phase can lock to an offbeat, so live beats are
		// counted here from this tracker's own tempo (autocorrelation of the
		// hits it hears), anchored on where kicks and snares land, with the
		// downbeat where the kicks fall in the bar.
		const o = this.onsets;
		this.updateTempo(dt, o);
		let bpm: number;
		if (scored) {
			bpm = clock.tempoBpm;
			g.known = true;
		} else if (this.tempoConfidence > 0) {
			bpm = this.tempo;
			g.known = true;
		} else if ((features?.bpm ?? 0) > 30) {
			bpm = features!.bpm;
			g.known = true;
		} else {
			bpm = this.tempoPrior;
			g.known = false;
		}
		g.bpm = clamp(bpm, 30, 260);
		const clockBeat = scored
			? clock.barIndex * 4 + clock.beatIndex + clock.beatPhase
			: (this.ownBeat += (dt * g.bpm) / 60);
		const raw = clockBeat;

		if (g.known) {
			// Beat anchor: the mode of kick/snare hit phases (other layers
			// count a little, for music without them).
			const k = decay(dt, 6);
			const h = this.anchorHist;
			for (let i = 0; i < PHASE_BINS; i += 1) h[i] *= k;
			const w = o[0] + 0.8 * o[1] + 0.1 * (o[2] + o[3] + o[4]);
			if (w > 0) h[Math.floor(wrap01(raw) * PHASE_BINS) % PHASE_BINS] += w;
			let mass = 0;
			for (let i = 0; i < PHASE_BINS; i += 1) mass += h[i];
			if (mass > 1.5) {
				const peak = this.peakBin(h);
				let num = 0;
				let den = 0;
				for (let d = -1; d <= 1; d += 1) {
					const v = h[(peak + d + PHASE_BINS) % PHASE_BINS];
					num += (peak + d + 0.5) * v;
					den += v;
				}
				const target = den > 0 ? num / den / PHASE_BINS : 0;
				const diff = wrap01(target - this.anchor + 0.5) - 0.5;
				if (Math.abs(diff) > 0.2) {
					this.anchorVote += dt;
					if (this.anchorVote > 1.5) {
						this.anchor += diff;
						this.anchorVote = 0;
						// The grid moved by whole sixteenths: move the groove too.
						this.rotatePatterns(-Math.round(diff * 4));
						this.lastAbsStep = Number.NaN;
						this.lastBar = Number.NaN;
					}
				} else {
					// Small drift (tempo estimate a little off): follow it.
					this.anchorVote = 0;
					this.anchor += diff * (1 - Math.exp(-dt / 1));
				}
			}
		}
		this.beatPos = raw - this.downbeat;
		const e = this.beatPos - this.anchor;

		if (g.known) {
			// Downbeat: kicks on 1 (and 3), snares on 2 and 4.
			const k = decay(dt, 12);
			for (let i = 0; i < 4; i += 1) {
				this.kickBeats[i] *= k;
				this.snareBeats[i] *= k;
			}
			const beatInBar = ((Math.round(e) % 4) + 4) % 4;
			if (o[0] > 0) this.kickBeats[beatInBar] += o[0];
			if (o[1] > 0) this.snareBeats[beatInBar] += o[1];
			let best = 0;
			let bestScore = -1e9;
			let current = 0;
			for (let r = 0; r < 4; r += 1) {
				const score =
					this.kickBeats[r] +
					0.5 * this.kickBeats[(r + 2) % 4] +
					0.7 * (this.snareBeats[(r + 1) % 4] + this.snareBeats[(r + 3) % 4]) -
					0.5 * this.snareBeats[r];
				if (r === 0) current = score;
				if (score > bestScore) {
					bestScore = score;
					best = r;
				}
			}
			if (best !== 0 && bestScore > 2 && bestScore > current * 1.25 + 0.5) {
				this.downbeatVote += dt;
				if (this.downbeatVote > 3) {
					this.downbeat += best;
					this.downbeatVote = 0;
					// Re-index the bar histograms and the groove to the new downbeat.
					rotate(this.kickBeats, best);
					rotate(this.snareBeats, best);
					this.rotatePatterns(-best * 4);
					this.lastAbsStep = Number.NaN;
					this.lastBar = Number.NaN;
				}
			} else {
				this.downbeatVote = 0;
			}
		}
		const eb = this.beatPos - this.anchor;
		g.beatPhase = wrap01(eb);
		g.barPhase = wrap01(eb / 4);
		g.bar = Math.floor(eb / 4);
	}

	/**
	 * The tracker's own tempo: autocorrelation of a weighted onset envelope
	 * over the last 6 s, every 0.5 s, scored with a log-Gaussian preference
	 * around 115 bpm plus support from the double period (so a groove at
	 * 120 is not read as 60 or 240). Changes beyond 4 % need two agreeing
	 * estimates in a row.
	 */
	private updateTempo(dt: number, o: Float32Array): void {
		const bin = Math.floor(this.time * TEMPO_RATE);
		const env = this.onsetEnvelope;
		if (this.envelopeBin < 0 || bin - this.envelopeBin > TEMPO_BINS) {
			env.fill(0);
		} else {
			for (let b = this.envelopeBin + 1; b <= bin; b += 1) env[b % TEMPO_BINS] = 0;
		}
		this.envelopeBin = bin;
		const strength = o[0] + o[1] + 0.5 * o[2] + 0.6 * o[3] + 0.5 * o[4];
		if (strength > 0) env[bin % TEMPO_BINS] += strength;
		this.tempoClock += dt;
		if (this.tempoClock < 0.5) return;
		this.tempoClock = 0;
		// Smooth the impulses by one bin each side, oldest first.
		const x = this.tempoScratch;
		let total = 0;
		for (let i = 0; i < TEMPO_BINS; i += 1) {
			const at = (bin + 1 + i) % TEMPO_BINS;
			const prev = env[(at + TEMPO_BINS - 1) % TEMPO_BINS];
			const next = env[(at + 1) % TEMPO_BINS];
			x[i] = env[at] + 0.5 * (prev + next);
			total += x[i];
		}
		if (total < 6) {
			this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.25);
			return;
		}
		const scores = this.tempoScores;
		let mean = 0;
		for (let lag = TEMPO_MIN_LAG; lag <= TEMPO_MAX_LAG + 1; lag += 1) {
			let sum = 0;
			for (let i = lag; i < TEMPO_BINS; i += 1) sum += x[i] * x[i - lag];
			scores[lag] = sum / (TEMPO_BINS - lag);
			mean += scores[lag];
		}
		mean /= TEMPO_MAX_LAG + 2 - TEMPO_MIN_LAG;
		let best = 0;
		let bestScore = 0;
		for (let lag = TEMPO_MIN_LAG + 1; lag <= TEMPO_MAX_LAG; lag += 1) {
			const bpm = (60 * TEMPO_RATE) / lag;
			const octaves = Math.log2(bpm / 115);
			const prior = Math.exp(-0.5 * (octaves / 0.6) ** 2);
			const double = lag * 2 <= TEMPO_MAX_LAG + 1 ? scores[lag * 2] : 0;
			const peak = scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1] ? 1 : 0.5;
			const score = prior * peak * (scores[lag] + 0.5 * double);
			if (score > bestScore) {
				bestScore = score;
				best = lag;
			}
		}
		if (best === 0 || scores[best] < mean * 1.3) {
			this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.25);
			return;
		}
		// Parabolic refinement of the lag.
		const a = scores[best - 1];
		const b = scores[best];
		const c = scores[best + 1];
		const den = a - 2 * b + c;
		const lag = best + (den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0);
		const estimate = (60 * TEMPO_RATE) / lag;
		if (this.tempoConfidence <= 0 || Math.abs(estimate / this.tempo - 1) < 0.04) {
			this.tempo = this.tempoConfidence <= 0 ? estimate : this.tempo + (estimate - this.tempo) * 0.3;
			this.tempoCandidateVotes = 0;
		} else if (Math.abs(estimate / this.tempoCandidate - 1) < 0.04) {
			this.tempoCandidateVotes += 1;
			if (this.tempoCandidateVotes >= 2) {
				this.tempo = estimate;
				this.tempoCandidateVotes = 0;
			}
		} else {
			this.tempoCandidate = estimate;
			this.tempoCandidateVotes = 1;
		}
		this.tempoConfidence = Math.min(1, this.tempoConfidence + 0.25);
	}

	private peakBin(h: Float32Array): number {
		let best = 0;
		let bestValue = -1;
		for (let i = 0; i < h.length; i += 1) {
			const v = h[i] + 0.5 * (h[(i + 1) % h.length] + h[(i - 1 + h.length) % h.length]);
			if (v > bestValue) {
				bestValue = v;
				best = i;
			}
		}
		return best;
	}

	/** Rotate every learned 16-step pattern by `steps` (positive = later). */
	private rotatePatterns(steps: number): void {
		const k = ((steps % 16) + 16) % 16;
		if (k === 0) return;
		for (let i = 0; i < this.state.length; i += 1) {
			const s = this.state[i];
			rotate(this.layers[i].pattern, 16 - k);
			rotate(s.patternB[0], 16 - k);
			rotate(s.patternB[1], 16 - k);
			s.bar.fill(0);
			s.steps.fill(0);
		}
	}

	private resetPatterns(): void {
		for (const s of this.state) {
			s.bar.fill(0);
			s.patternB[0].fill(0);
			s.patternB[1].fill(0);
			s.steps.fill(0);
		}
		for (const layer of this.layers) layer.pattern.fill(0);
		this.barsLearned = 0;
		this.swingHist.fill(0);
		this.lastBar = Number.NaN;
		this.lastAbsStep = Number.NaN;
	}

	/** Warp a beat-relative phase so swung offbeats land on the straight grid. */
	private straighten(phase: number): number {
		const s = this.swingPos;
		return phase < s ? (phase / s) * 0.5 : 0.5 + ((phase - s) / (1 - s)) * 0.5;
	}

	/** Absolute sixteenth index (swing-corrected) of the current moment. */
	private absStepNow(): number {
		const e = this.beatPos - this.anchor;
		const beat = Math.floor(e);
		return beat * 4 + Math.floor(this.straighten(e - beat) * 4 + 0.5);
	}

	// ---- Layers ----------------------------------------------------------------

	private updateLayers(spectrum: Readonly<SignalSpectrumProfile>, dt: number, live: boolean): void {
		const f = this.frame;
		const known = f.grid.known;
		const beatSeconds = 60 / f.grid.bpm;
		const presentRelease = Math.max(1, PRESENT_RELEASE_BARS * 4 * beatSeconds);
		const e = this.beatPos - this.anchor;
		const beat = Math.floor(e);
		const frac = e - beat;
		const straight = this.straighten(frac);
		const absStep = beat * 4 + Math.floor(straight * 4 + 0.5);
		const step = ((absStep % 16) + 16) % 16;
		const barPos = wrap01((((beat % 4) + 4) % 4) / 4 + straight / 4);

		// Bar and step boundaries drive pattern learning and fill detection.
		this.advanceSteps(absStep, Math.floor(absStep / 16), live);

		const low = spectrum.raw.sub + spectrum.raw.kick;
		this.sinceKick += dt;
		for (let i = 0; i < 5; i += 1) {
			const layer = this.layers[i];
			const s = this.state[i];
			layer.hit *= decay(dt, HIT_TAU[i]);
			layer.sinceHit += dt;
			s.rate *= decay(dt, RATE_TAU_S);
			const v = this.onsets[i];
			if (v > 0) {
				layer.hit = Math.max(layer.hit, v);
				layer.serial += 1;
				layer.velocity = v;
				layer.accent = clamp01((v - s.typical) / Math.max(0.15, s.typical * 0.6));
				s.typical += (v - s.typical) * 0.15;
				layer.sinceHit = 0;
				if (known) {
					layer.barPos = barPos;
					layer.step = step;
				}
				// Every hit feeds the groove at once; a kick waits for its decay
				// before it counts as a drum (presence, drop-outs, returns).
				this.countHit(i, v, step, absStep, frac);
				if (i === 0) {
					this.sinceKick = 0;
					this.queueKick(v, low);
				} else if (i < 4) {
					this.countDrum(i);
				}
			}
			layer.perBeat = s.rate * beatSeconds;
			layer.activity = layer.perBeat / (layer.perBeat + 1);
			// Present: rises with hits, holds ~2 bars after the last one.
			s.presentHold = Math.max(0, s.presentHold - dt);
			layer.present = approach(layer.present, s.presentHold > 0 ? 1 : 0, dt, s.presentHold > 0 ? 0.15 : presentRelease * 0.25);
		}
		this.confirmKicks(low);
		this.lowHistory[this.lowHead] = low;
		this.lowHead = (this.lowHead + 1) % this.lowHistory.length;
	}

	private queueKick(velocity: number, low: number): void {
		let slot = 0;
		for (let i = 0; i < 4; i += 1) {
			if (this.pendingAt[i] < 0) {
				slot = i;
				break;
			}
			if (this.pendingAt[i] < this.pendingAt[slot]) slot = i;
		}
		this.pendingAt[slot] = this.time;
		// The hit is reported ~2 frames after it began: the level 4-5 frames
		// back is the level before it.
		const n = this.lowHistory.length;
		this.pendingPre[slot] = Math.min(this.lowHistory[this.lowHead % n], this.lowHistory[(this.lowHead + 1) % n]);
		this.pendingPeak[slot] = low;
		this.pendingVel[slot] = velocity;
	}

	private confirmKicks(low: number): void {
		for (let i = 0; i < 4; i += 1) {
			if (this.pendingAt[i] < 0) continue;
			const age = this.time - this.pendingAt[i];
			if (age < 0.05) this.pendingPeak[i] = Math.max(this.pendingPeak[i], low);
			if (age < KICK_CONFIRM_S) continue;
			const pre = this.pendingPre[i];
			const rise = this.pendingPeak[i] - pre;
			// A drum falls back toward the level before it; a bass note holds.
			const kept = rise > 1e-6 ? (low - pre) / rise : 1;
			if (kept < KICK_KEPT_MAX) this.countDrum(0);
			else this.bassRate += 1 / RATE_TAU_S;
			this.pendingAt[i] = -1;
		}
	}

	/** A drum hit that counts toward presence, drop-outs and returns. */
	private countDrum(layerIndex: number): void {
		const s = this.state[layerIndex];
		const beatSeconds = 60 / this.frame.grid.bpm;
		s.presentHold = Math.max(s.presentHold, PRESENT_RELEASE_BARS * 4 * beatSeconds * 0.5);
		this.drumRate += (layerIndex === 2 ? 0.5 : 1) / 1.5;
		this.sinceDrum = 0;
		if (this.inBreakdown) this.returnHits += layerIndex === 2 ? 0.5 : 1;
	}

	/** Any hit: rate, pattern, swing and syncopation. */
	private countHit(layerIndex: number, velocity: number, step: number, absStep: number, frac: number): void {
		const s = this.state[layerIndex];
		const f = this.frame;
		s.rate += 1 / RATE_TAU_S;
		this.eventRate += 1 / RATE_TAU_S;
		if (layerIndex === 4) {
			this.noteRate += 1 / RATE_TAU_S;
			const beatSeconds = 60 / f.grid.bpm;
			s.presentHold = Math.max(s.presentHold, PRESENT_RELEASE_BARS * 4 * beatSeconds * 0.5);
		}
		if (!f.grid.known) return;
		// Pattern: strongest hit per sixteenth this bar, and in the step ring.
		if (velocity > s.bar[step]) s.bar[step] = velocity;
		const ring = ((absStep % 16) + 16) % 16;
		if (velocity > s.steps[ring]) s.steps[ring] = velocity;
		// Swing: where offbeats sit relative to the beat.
		this.addSwing(layerIndex, velocity, frac);
		// Syncopation: accented hits on weak sixteenths.
		const w = SYNC_WEIGHT[layerIndex] * velocity;
		this.syncNum += w * (1 - METRIC_WEIGHT[step]);
		this.syncDen += w;
	}

	private addSwing(layerIndex: number, velocity: number, frac: number): void {
		const w = SWING_WEIGHT[layerIndex] * velocity;
		// `frac` is already relative to the current anchor.
		const rel = wrap01(frac);
		if (rel >= 0.1 && rel < 0.9) {
			const bin = Math.min(SWING_BINS - 1, Math.floor((rel - 0.1) * 100));
			this.swingHist[bin] += w;
		}
	}

	/** Kernel-smoothed hit mass of the swing histogram at a relative phase. */
	private swingDensity(phase: number): number {
		const centre = Math.round((phase - 0.1) * 100 - 0.5);
		let sum = 0;
		for (let d = -2; d <= 2; d += 1) {
			const bin = centre + d;
			if (bin >= 0 && bin < SWING_BINS) sum += this.swingHist[bin] * SWING_KERNEL[d + 2];
		}
		return sum;
	}

	private advanceSteps(absStep: number, bar: number, live: boolean): void {
		const f = this.frame;
		if (!f.grid.known) {
			this.lastAbsStep = Number.NaN;
			this.lastBar = Number.NaN;
			return;
		}
		if (Number.isNaN(this.lastAbsStep)) {
			this.lastAbsStep = absStep;
			this.lastBar = bar;
			return;
		}
		if (absStep !== this.lastAbsStep) {
			// A new sixteenth: judge the beat that just ended for a fill, then
			// clear the step we are entering.
			if (absStep > this.lastAbsStep && absStep - this.lastAbsStep < 8) {
				for (let s = this.lastAbsStep + 1; s <= absStep; s += 1) {
					if (live) this.judgeFill(s - 1);
					const ring = ((s % 16) + 16) % 16;
					for (const st of this.state) st.steps[ring] = 0;
				}
			} else {
				for (const st of this.state) st.steps.fill(0);
			}
			this.lastAbsStep = absStep;
		}
		if (bar !== this.lastBar) {
			if (bar === this.lastBar + 1) this.finishBar(this.lastBar);
			else for (const st of this.state) st.bar.fill(0);
			this.lastBar = bar;
		}
	}

	private finishBar(bar: number): void {
		const f = this.frame;
		const parity = ((bar % 2) + 2) % 2;
		let simSum = 0;
		let simWeight = 0;
		for (let i = 0; i < 5; i += 1) {
			const s = this.state[i];
			const layer = this.layers[i];
			let energy = 0;
			let learned = 0;
			for (let k = 0; k < 16; k += 1) {
				energy += s.bar[k];
				learned += layer.pattern[k];
			}
			const weight = i < 4 ? energy + learned : 0;
			if (weight > 0.05) {
				const sim = Math.max(cosine(s.bar, layer.pattern, 16), cosine(s.bar, s.patternB[parity], 16));
				simSum += sim * weight;
				simWeight += weight;
			}
			// A fill keeps its bar out of the groove, but only once: a second
			// "fill" bar in a row is a new groove, learned fast.
			// Beats that looked like a fill stay out of the groove (else a fill
			// every few bars would slowly become "expected"); the rest learns.
			// Two flagged bars in a row are a new groove: learned fast, whole.
			const newGroove = this.barIsFill && this.fillBarsInRow >= 1;
			const a = this.barsLearned === 0 ? 1 : newGroove ? 0.7 : PATTERN_LEARN;
			const b = s.patternB[parity];
			const ab = this.barsLearned < 2 || newGroove ? Math.max(a, 0.7) : a;
			for (let k = 0; k < 16; k += 1) {
				if (!newGroove && this.barsLearned > 0 && this.beatSuspect[k >> 2]) continue;
				layer.pattern[k] += (s.bar[k] - layer.pattern[k]) * a;
				b[k] += (s.bar[k] - b[k]) * ab;
			}
			s.bar.fill(0);
		}
		if (simWeight > 0.05 && this.barsLearned > 0) {
			const barSim = simSum / simWeight;
			this.regularityAcc = this.regularityAcc * 0.55 + barSim * 0.45;
		} else if (simWeight <= 0.05) {
			this.regularityAcc *= 0.7;
		}
		if (this.barIsFill && this.fillBarsInRow >= 1) {
			// The groove changed: trust in it has to be rebuilt.
			this.regularityAcc = Math.min(this.regularityAcc, 0.3);
			this.fillBarsInRow = 0;
		} else if (this.barIsFill) {
			this.fillBarsInRow += 1;
		} else {
			this.fillBarsInRow = 0;
		}
		if (!this.barIsFill && simWeight > 0.05) this.barsLearned += 1;
		// The longest silence the learned groove leaves, in beats.
		let marks = 0;
		let first = -1;
		let last = -1;
		let longest = 0;
		for (let k = 0; k < 16; k += 1) {
			let v = 0;
			for (let i = 0; i < 4; i += 1) v = Math.max(v, this.layers[i].pattern[k]);
			if (v < 0.25) continue;
			if (last >= 0) longest = Math.max(longest, k - last);
			if (first < 0) first = k;
			last = k;
			marks += 1;
		}
		if (marks > 0) longest = Math.max(longest, 16 - last + first);
		this.patternGapBeats = marks > 0 ? longest / 4 : 4;
		this.barIsFill = false;
		this.beatSuspect.fill(0);
		f.groove.regularity = clamp01(this.regularityAcc);
	}

	/** Compare the beat that just ended (four sixteenths) with the learned groove. */
	private judgeFill(endStep: number): void {
		const f = this.frame;
		const g = f.groove;
		const bar = Math.floor(endStep / 16);
		// The beat is judged against the 1-bar groove. (A 2-bar pattern would
		// absorb a fill that comes every 4 bars into one of its halves; the
		// 1-bar groove keeps fill beats out of its learning, see finishBar.)
		let actualSum = 0;
		let expectedSum = 0;
		for (let i = 0; i < 4; i += 1) {
			const s = this.state[i];
			const one = this.layers[i].pattern;
			const weight = i === 2 ? 0.3 : i === 0 ? 0.7 : 1;
			for (let k = 0; k < 4; k += 1) {
				const inBar = (((endStep - 3 + k) % 16) + 16) % 16;
				const a = s.steps[inBar];
				this.actual[i * 4 + k] = a;
				this.expected[i * 4 + k] = one[inBar];
				actualSum += a * weight;
				expectedSum += one[inBar] * weight;
			}
		}
		const learned = clamp01((this.barsLearned - 1) / 3);
		const steady = clamp01(g.regularity * 1.4 - 0.2);
		const confidence = learned * steady * g.drums;
		const deviation = 1 - cosine(this.actual, this.expected, 16);
		const excess = clamp01((actualSum - expectedSum) / 1.5);
		const beatInBar = (((endStep % 16) + 16) % 16) >> 2;
		const barInPhrase = ((bar % 4) + 4) % 4;
		// Fills cluster at phrase ends. The downbeat can be half a bar out
		// (kicks on 1 and 3 look alike), so both readings of the phrase end
		// count.
		const phraseEnd = (barInPhrase === 3 && beatInBar >= 2) || (barInPhrase === 0 && beatInBar < 2);
		const prior = phraseEnd ? 1 : 0.72;
		// Only busier-than-usual or reshaped beats with real drumming are fills;
		// an empty beat is a drop-out, not a fill.
		const busy = smoothstep(0.4, 1.2, actualSum);
		const score = confidence * busy * prior * (0.55 * deviation + 0.45 * excess);
		this.fillScore = score;
		if (score > 0.25) this.beatSuspect[beatInBar] = 1;
		// Right after a flagged bar this is the new groove settling in, not
		// a second fill.
		const allowed = this.fillBarsInRow === 0;
		if (allowed && score > FILL_THRESHOLD && g.sinceFill > 1.5 * 4 * (60 / f.grid.bpm)) {
			g.fill = 1;
			g.fillSerial += 1;
			g.sinceFill = 0;
			this.barIsFill = true;
		} else if (score > FILL_THRESHOLD * 0.8 && g.sinceFill < 4 * (60 / f.grid.bpm)) {
			// A fill running on: keep the bar out of the learned groove.
			this.barIsFill = true;
		}
	}

	// ---- Groove ----------------------------------------------------------------

	private updateGroove(dt: number, live: boolean): void {
		const f = this.frame;
		const g = f.groove;
		g.fill *= decay(dt, 0.6);
		g.dropout *= decay(dt, 0.8);
		g.drumReturn *= decay(dt, 0.8);
		g.sinceFill += dt;
		this.sinceDrum += dt;
		const beatSeconds = 60 / f.grid.bpm;

		// Fill intensity follows the per-beat fill score.
		g.fillIntensity = approach(g.fillIntensity, this.fillScore > 0.3 ? clamp01(this.fillScore * 1.6) : 0, dt, this.fillScore > 0.3 ? 0.05 : 0.45);
		if (!live) this.fillScore *= decay(dt, 0.3);

		// Swing: fit the offbeat position s that best explains where the
		// off-the-beat hits sit. A swing s puts the eighth at s and the
		// sixteenths at s/2 and s + (1 - s)/2, so straight sixteenths with
		// accented "e"/"a" still fit s = 0.5 better than a hard swing at 0.75.
		const k = decay(dt, SWING_HIST_TAU_S);
		let mass = 0;
		for (let i = 0; i < SWING_BINS; i += 1) {
			this.swingHist[i] *= k;
			mass += this.swingHist[i];
		}
		if (mass > 2.5) {
			let best = 0.5;
			let bestScore = -1;
			for (let c = 0; c <= 50; c += 1) {
				const sw = 0.5 + c * 0.005;
				const score =
					(this.swingDensity(sw) + 0.5 * (this.swingDensity(sw / 2) + this.swingDensity(sw + (1 - sw) / 2))) *
					(1 - 0.15 * c / 50);
				if (score > bestScore) {
					bestScore = score;
					best = sw;
				}
			}
			const support = this.swingDensity(best) + 0.5 * (this.swingDensity(best / 2) + this.swingDensity(best + (1 - best) / 2));
			const target = support > 0.15 * mass ? best : 0.5;
			this.swingPos = clamp(approach(this.swingPos, target, dt, 1.2), 0.45, 0.78);
		} else {
			// No offbeat evidence (a hat-less bridge): hold the feel, relax slowly.
			this.swingPos = approach(this.swingPos, 0.5, dt, 20);
		}
		const swingPos = Math.max(0.5, this.swingPos);
		g.swing = clamp01((swingPos - 0.5) * 6);
		g.swingRatio = swingPos / (1 - swingPos);

		// Syncopation over ~3 s.
		const ks = decay(dt, 3);
		this.syncNum *= ks;
		this.syncDen *= ks;
		g.syncopation = this.syncDen > 0.3 ? clamp01((this.syncNum / this.syncDen) * 1.3) : approach(g.syncopation, 0, dt, 2);

		// Drum presence and breakdowns.
		this.drumRate *= decay(dt, 1.5);
		const before = this.drumEstablished;
		// Established drumming follows the drums up in seconds, forgets
		// slowly, and holds through a breakdown so the return is recognised.
		const releaseTau = this.inBreakdown ? 120 : 30;
		this.drumEstablished = approach(before, this.drumRate, dt, this.drumRate > before ? 3 : releaseTau);
		const reference = Math.max(1.2, this.drumEstablished * 0.5);
		g.drums = approach(g.drums, clamp01(this.drumRate / reference), dt, 0.25);

		if (live) {
			// Drums were established, and nothing came for twice the longest
			// gap the groove normally leaves (at least two beats) while the
			// music plays on.
			const established = this.drumEstablished > 1.2;
			const gap =
				this.barsLearned >= 2
					? Math.max(1.5 * beatSeconds, (this.patternGapBeats + 1) * beatSeconds, 0.5)
					: Math.max(1.5 * beatSeconds, 2.5 / Math.max(0.5, this.drumEstablished), 0.5);
			if (!this.inBreakdown && established && this.sinceDrum > gap) {
				this.inBreakdown = true;
				this.returnHits = 0;
				g.dropout = 1;
				g.dropoutSerial += 1;
			}
			if (this.inBreakdown) {
				// Drums are back once about two beats' worth of hits arrive
				// close together (a leaky count over one beat).
				this.returnHits *= decay(dt, beatSeconds);
				if (this.returnHits >= 1.6) {
					this.inBreakdown = false;
					g.drumReturn = 1;
					g.drumReturnSerial += 1;
				}
			}
		}
		g.breakdown = approach(g.breakdown, this.inBreakdown && live ? 1 : 0, dt, this.inBreakdown ? 0.3 : 0.15);
		const learned = clamp01(this.barsLearned / 4);
		g.confidence = f.grid.known ? clamp01(0.25 + 0.4 * learned + 0.35 * g.drums) * (live ? 1 : 0.5) : 0;
	}

	// ---- Harmony ---------------------------------------------------------------

	private updateHarmony(
		features: AudioFeatureFrame | null,
		spectrum: Readonly<SignalSpectrumProfile>,
		dt: number,
		live: boolean
	): void {
		const h = this.frame.harmony;
		h.change *= decay(dt, 0.35);
		h.sinceChange += dt;
		this.sinceKeyChange += dt;
		this.changeRate *= decay(dt, 8);
		const raw = live ? features?.chroma : undefined;
		const cs = this.chromaSmooth;
		let peakiness = 0;
		if (raw && raw.length >= 12) {
			let mean = 0;
			let max = 0;
			for (let i = 0; i < 12; i += 1) {
				const v = clamp01(raw[i] ?? 0);
				mean += v;
				if (v > max) max = v;
			}
			mean /= 12;
			if (max > 0) {
				const a = 1 - Math.exp(-dt / CHORD_TAU_S);
				for (let i = 0; i < 12; i += 1) cs[i] += (clamp01(raw[i] ?? 0) - cs[i]) * a;
				peakiness = clamp01((0.75 - mean) / 0.5);
			} else {
				for (let i = 0; i < 12; i += 1) cs[i] *= decay(dt, 0.5);
			}
		} else if (live && features && features.chroma_strength > 0) {
			// Older frames: the dominant pitch class only.
			const pc = Math.round((features.chroma_key ?? 0) * 12) % 12;
			const a = 1 - Math.exp(-dt / 0.3);
			for (let i = 0; i < 12; i += 1) cs[i] += ((i === pc ? 1 : 0.15) - cs[i]) * a;
			peakiness = clamp01(features.chroma_strength) * 0.6;
		} else {
			for (let i = 0; i < 12; i += 1) cs[i] *= decay(dt, 0.5);
		}
		const flat = spectrum.flatness;
		const tonalTarget = live ? peakiness * (1 - 0.35 * smoothstep(0.6, 0.95, flat)) : 0;
		this.tonalitySmooth = approach(this.tonalitySmooth, tonalTarget, dt, 0.3);
		const tonality = this.tonalitySmooth;

		let max = 0;
		for (let i = 0; i < 12; i += 1) if (cs[i] > max) max = cs[i];
		const out = h.chroma;
		const norm = this.chromaNorm;
		if (max > 1e-4) {
			let mean = 0;
			for (let i = 0; i < 12; i += 1) {
				out[i] = cs[i] / max;
				mean += out[i];
			}
			mean /= 12;
			let len = 0;
			for (let i = 0; i < 12; i += 1) {
				norm[i] = out[i] - mean;
				len += norm[i] * norm[i];
			}
			len = Math.sqrt(len);
			for (let i = 0; i < 12; i += 1) norm[i] = len > 1e-6 ? norm[i] / len : 0;
		} else {
			out.fill(0);
			norm.fill(0);
		}

		// Template scores for every root and template.
		const bs = this.bassSmooth;
		let bassMax = 0;
		for (let i = 0; i < 12; i += 1) if (bs[i] > bassMax) bassMax = bs[i];
		let best = 0;
		let bestScore = -2;
		const scores = this.scores;
		for (let t = 0; t < TEMPLATES.length; t += 1) {
			const w = TEMPLATES[t].weights;
			for (let r = 0; r < 12; r += 1) {
				let dot = 0;
				for (let i = 0; i < 12; i += 1) dot += norm[(r + i) % 12] * w[i];
				const bass = bassMax > 0.05 ? (bs[r] / bassMax) * 0.08 : 0;
				const score = dot + bass + TEMPLATE_PRIOR[t];
				scores[t * 12 + r] = score;
				if (score > bestScore) {
					bestScore = score;
					best = t * 12 + r;
				}
			}
		}
		// Quality probabilities: softmax over all chords, marginalised by quality.
		const q = h.qualities;
		q.fill(0);
		let total = 0;
		for (let i = 0; i < scores.length; i += 1) {
			const p = Math.exp((scores[i] - bestScore) * 14);
			q[TEMPLATES[Math.floor(i / 12)].category] += p;
			total += p;
		}
		for (let c = 0; c < 6; c += 1) q[c] = total > 0 ? (q[c] / total) * tonality : 0;
		q[6] = 1 - tonality;

		const bestT = Math.floor(best / 12);
		const bestR = best % 12;
		const tonal = live && tonality > 0.25 && max > 1e-3;
		if (!tonal) {
			this.noneTime += dt;
			if (this.noneTime > 0.4 && this.chordRoot >= 0) {
				this.chordRoot = -1;
				this.chordTemplate = -1;
			}
		} else {
			this.noneTime = 0;
			const currentScore =
				this.chordRoot >= 0 ? this.bestOfCategory(TEMPLATES[this.chordTemplate].category, this.chordRoot) : -2;
			const differs =
				this.chordRoot < 0 ||
				bestR !== this.chordRoot ||
				TEMPLATES[bestT].category !== TEMPLATES[this.chordTemplate].category;
			if (differs && bestScore - currentScore > CHORD_MARGIN) {
				if (bestR === this.candidateRoot && TEMPLATES[bestT].category === TEMPLATES[Math.max(0, this.candidateTemplate)].category) {
					this.candidateTime += dt;
				} else {
					this.candidateRoot = bestR;
					this.candidateTemplate = bestT;
					this.candidateTime = dt;
				}
				if (this.candidateTime >= CHORD_HOLD_S) {
					const rootChanged = bestR !== this.chordRoot;
					this.chordRoot = bestR;
					this.chordTemplate = bestT;
					this.candidateTime = 0;
					h.change = Math.max(h.change, rootChanged ? 1 : 0.6);
					h.changeSerial += 1;
					h.sinceChange = 0;
					this.changeRate += 1 / 8;
				}
			} else {
				this.candidateTime = 0;
				// Same chord: follow the best template within its quality.
				if (!differs) this.chordTemplate = bestT;
			}
		}
		h.root = this.chordRoot;
		if (this.chordRoot >= 0) {
			const category = TEMPLATES[this.chordTemplate].category;
			h.qualityIndex = category;
			h.quality = ENSEMBLE_CHORD_QUALITIES[category];
			h.confidence = clamp01(scores[this.chordTemplate * 12 + this.chordRoot]) * tonality;
		} else {
			h.qualityIndex = 6;
			h.quality = 'none';
			h.confidence = approach(h.confidence, 0, dt, 0.3);
		}
		const beatSeconds = 60 / this.frame.grid.bpm;
		h.changesPerBar = clamp(this.changeRate * 4 * beatSeconds, 0, 4);

		this.updateKey(dt, tonality, live);

		// Tension: the chord's quality, clashing neighbours, and pitch classes
		// outside the chord and the key.
		let rough = 0;
		let energy = 0;
		for (let i = 0; i < 12; i += 1) {
			rough += out[i] * (out[(i + 1) % 12] + 0.7 * out[(i + 6) % 12]);
			energy += out[i] * out[i];
		}
		const roughness = energy > 1e-6 ? clamp01((rough / energy - 0.15) / 0.6) : 0;
		let outside = 0;
		let inChord = 0;
		if (this.chordRoot >= 0) {
			const w = TEMPLATES[this.chordTemplate].weights;
			for (let i = 0; i < 12; i += 1) {
				const v = out[(this.chordRoot + i) % 12];
				if (w[i] > 0) inChord += v;
				else outside += v;
			}
		}
		const nonChord = inChord + outside > 1e-6 ? outside / (inChord + outside) : 0.5;
		const key = h.key;
		let offKey = 0;
		if (this.chordRoot >= 0 && key.confidence > 0.2) {
			const degree = (this.chordRoot - key.tonic + 12) % 12;
			h.degree = degree;
			const diatonic = key.mode === 'major' ? MAJOR_SCALE_MASK : MINOR_SCALE_MASK;
			// Outside the scale is tense; the dominant and leading tone lean.
			offKey = (diatonic >> degree) & 1 ? (degree === 7 || degree === 11 ? 0.5 : 0) : 1;
		} else {
			h.degree = -1;
		}
		const qualityTension = QUALITY_TENSION[h.qualityIndex];
		const tensionTarget = tonal
			? clamp01(0.42 * qualityTension + 0.25 * roughness + 0.18 * nonChord + 0.15 * offKey)
			: 0.5 * roughness;
		h.tension = approach(h.tension, tensionTarget, dt, 0.3);
	}

	private bestOfCategory(category: number, root: number): number {
		let best = -2;
		for (let t = 0; t < TEMPLATES.length; t += 1) {
			if (TEMPLATES[t].category === category) best = Math.max(best, this.scores[t * 12 + root]);
		}
		return best;
	}

	private updateKey(dt: number, tonality: number, live: boolean): void {
		const key = this.frame.harmony.key;
		const kc = this.keyChroma;
		if (live && tonality > 0.15) {
			const a = (1 - Math.exp(-dt / KEY_TAU_S)) * tonality;
			const chroma = this.frame.harmony.chroma;
			const bs = this.bassSmooth;
			let bassMax = 0;
			for (let i = 0; i < 12; i += 1) bassMax = Math.max(bassMax, bs[i]);
			for (let i = 0; i < 12; i += 1) {
				const target = chroma[i] + (bassMax > 0.05 ? (0.5 * bs[i]) / bassMax : 0);
				kc[i] += (target - kc[i]) * a;
			}
		}
		let mean = 0;
		for (let i = 0; i < 12; i += 1) mean += kc[i];
		mean /= 12;
		let len = 0;
		for (let i = 0; i < 12; i += 1) len += (kc[i] - mean) * (kc[i] - mean);
		len = Math.sqrt(len);
		if (len < 1e-4) {
			key.confidence = approach(key.confidence, 0, dt, 2);
			key.stability = approach(key.stability, 0, dt, 2);
			return;
		}
		let bestMajor = -2;
		let bestMinor = -2;
		let second = -2;
		let best = -2;
		let bestIndex = 0;
		for (let tonic = 0; tonic < 12; tonic += 1) {
			let major = 0;
			let minor = 0;
			for (let i = 0; i < 12; i += 1) {
				const v = (kc[(tonic + i) % 12] - mean) / len;
				major += v * KEY_MAJOR[i];
				minor += v * KEY_MINOR[i];
			}
			if (major > bestMajor) bestMajor = major;
			if (minor > bestMinor) bestMinor = minor;
			for (let m = 0; m < 2; m += 1) {
				const value = m === 0 ? major : minor;
				if (value > best) {
					second = best;
					best = value;
					bestIndex = tonic + m * 12;
				} else if (value > second) second = value;
			}
		}
		if (this.keyIndex < 0) {
			this.keyIndex = bestIndex;
			this.sinceKeyChange = 0;
		} else if (bestIndex !== this.keyIndex) {
			if (bestIndex === this.keyCandidate) this.keyCandidateTime += dt;
			else {
				this.keyCandidate = bestIndex;
				this.keyCandidateTime = dt;
			}
			const current = this.keyScore(this.keyIndex, mean, len);
			if (this.keyCandidateTime > KEY_HOLD_S && best - current > 0.03) {
				this.keyIndex = bestIndex;
				this.keyCandidateTime = 0;
				this.sinceKeyChange = 0;
				key.changeSerial += 1;
			}
		} else {
			this.keyCandidateTime = 0;
		}
		key.tonic = this.keyIndex % 12;
		key.mode = this.keyIndex >= 12 ? 'minor' : 'major';
		const pMajor = 1 / (1 + Math.exp(-(bestMajor - bestMinor) * 10));
		key.major = pMajor;
		key.minor = 1 - pMajor;
		key.confidence = clamp01(this.keyScore(this.keyIndex, mean, len));
		const margin = clamp01((best - second) / 0.12);
		key.stability = approach(key.stability, clamp01(1 - Math.exp(-this.sinceKeyChange / 8)) * (0.4 + 0.6 * margin), dt, 1);
	}

	private keyScore(index: number, mean: number, len: number): number {
		const tonic = index % 12;
		const profile = index >= 12 ? KEY_MINOR : KEY_MAJOR;
		let s = 0;
		for (let i = 0; i < 12; i += 1) s += ((this.keyChroma[(tonic + i) % 12] - mean) / len) * profile[i];
		return s;
	}

	// ---- Bass ------------------------------------------------------------------

	private updateBass(
		features: AudioFeatureFrame | null,
		spectrum: Readonly<SignalSpectrumProfile>,
		dt: number,
		live: boolean
	): void {
		const b = this.frame.bass;
		b.note *= decay(dt, 0.15);
		this.bassRate *= decay(dt, RATE_TAU_S);
		const level = clamp01((spectrum.levels.sub + spectrum.levels.kick) * 0.5);
		b.level = approach(b.level, live ? level : 0, dt, 0.08);
		const raw = live ? features?.bass_chroma : undefined;
		const bs = this.bassSmooth;
		// The sweep of a kick drum smears the bass register; skip just after one.
		if (raw && raw.length >= 12 && level > 0.08 && this.sinceKick > 0.08) {
			const a = 1 - Math.exp(-dt / BASS_TAU_S);
			for (let i = 0; i < 12; i += 1) bs[i] += (clamp01(raw[i] ?? 0) - bs[i]) * a;
		} else {
			for (let i = 0; i < 12; i += 1) bs[i] *= decay(dt, live ? 0.6 : 0.25);
		}
		let max = 0;
		let arg = -1;
		let sum = 0;
		for (let i = 0; i < 12; i += 1) {
			sum += bs[i];
			if (bs[i] > max) {
				max = bs[i];
				arg = i;
			}
		}
		const mean = sum / 12;
		const confidence = max > 0.05 ? clamp01((max - mean) / max) * smoothstep(0.05, 0.3, max) : 0;
		b.confidence = approach(b.confidence, confidence, dt, 0.1);
		if (confidence < 0.25) {
			if (max < 0.05) b.pitchClass = -1;
		} else if (arg !== this.bassPc) {
			const currentValue = this.bassPc >= 0 ? bs[this.bassPc] : 0;
			if (arg === this.bassCandidate) this.bassCandidateTime += dt;
			else {
				this.bassCandidate = arg;
				this.bassCandidateTime = dt;
			}
			if (this.bassCandidateTime >= BASS_HOLD_S && max - currentValue > 0.12 * max) {
				if (this.bassPc >= 0) {
					const interval = pitchInterval(this.bassPc, arg);
					b.interval = interval;
					const step = Math.abs(interval) <= 2 ? 1 : 0;
					b.stepwise += (step - b.stepwise) * 0.25;
				}
				this.bassPc = arg;
				b.pitchClass = arg;
				b.note = 1;
				b.noteSerial += 1;
				this.bassRate += 1 / RATE_TAU_S;
				this.bassCandidateTime = 0;
			}
		} else {
			this.bassCandidateTime = 0;
			b.pitchClass = arg;
		}
		const beatSeconds = 60 / this.frame.grid.bpm;
		b.perBeat = this.bassRate * beatSeconds;
		b.activity = b.perBeat / (b.perBeat + 1);
		b.walking = approach(b.walking, b.stepwise * smoothstep(0.45, 0.85, b.perBeat) * (live ? 1 : 0), dt, 0.8);
	}

	// ---- Articulation ------------------------------------------------------------

	private updateArticulation(spectrum: Readonly<SignalSpectrumProfile>, dt: number, live: boolean): void {
		const a = this.frame.articulation;
		const raw = spectrum.raw;
		const levels = this.registerLevels;
		levels[0] = raw.sub + raw.kick;
		levels[1] = raw.body + raw.mids;
		levels[2] = raw.presence + raw.air;
		// Register triggers: low = kicks and bass notes, mid = notes and perc,
		// high = hats.
		const o = this.onsets;
		const triggers = this.registerTriggers;
		triggers[0] = o[0];
		triggers[1] = Math.max(o[4], o[3]);
		triggers[2] = o[2];
		for (let r = 0; r < 3; r += 1) {
			const art = this.articulators[r];
			const level = levels[r];
			const before = art.history[(art.head + 8 - 3) % 8];
			art.history[art.head] = level;
			art.head = (art.head + 1) % 8;
			if (!live) {
				art.armedAt = -1;
				continue;
			}
			if (triggers[r] > 0) {
				art.armedAt = this.time;
				art.floor = before;
				art.peak = level;
				continue;
			}
			if (art.armedAt < 0) continue;
			const age = this.time - art.armedAt;
			if (age <= ARTIC_PEAK_S) {
				art.peak = Math.max(art.peak, level);
				continue;
			}
			if (age >= ARTIC_MEASURE_S) {
				const rise = art.peak - art.floor;
				// How much of the note is left: over the level before it when the
				// note clearly rose out of silence, over its peak when it rose out
				// of the previous note (legato lines barely rise at all).
				const clarity = art.peak > 1e-6 ? clamp01(rise / art.peak) : 0;
				const overFloor = rise > 1e-6 ? clamp01((level - art.floor) / rise) : 1;
				const overPeak = art.peak > 1e-6 ? clamp01(level / art.peak) : 1;
				const kept = clarity * overFloor + (1 - clarity) * overPeak;
				const legatoSample = clamp01((kept - 0.15) / 0.7);
				// A trigger the register barely noticed says little.
				const w = 0.3 * (0.25 + 0.75 * clarity);
				art.legato += (legatoSample - art.legato) * w;
				art.weight = Math.min(1, art.weight + w);
				art.armedAt = -1;
			}
		}
		for (const art of this.articulators) art.weight *= decay(dt, 6);
		a.low = this.articulators[0].legato;
		a.mid = this.articulators[1].legato;
		a.high = this.articulators[2].legato;
		const wl = this.articulators[0].weight * 0.25;
		const wm = this.articulators[1].weight * 0.75 + 1e-3;
		a.legato = clamp01((a.low * wl + a.mid * wm) / (wl + wm));
		a.staccato = 1 - a.legato;

		// Sustain: the mid register's floor over its peaks, in ~1.5 s windows.
		const mid = levels[1];
		if (live) {
			this.sustainWindow += dt;
			this.sustainMin = this.sustainWindow <= dt ? mid : Math.min(this.sustainMin, mid);
			this.sustainMax = this.sustainWindow <= dt ? mid : Math.max(this.sustainMax, mid);
			if (this.sustainWindow >= 1.5) {
				const ratio = this.sustainMax > 1e-6 ? this.sustainMin / this.sustainMax : 0;
				this.sustainValue += (ratio - this.sustainValue) * 0.5;
				this.sustainWindow = 0;
			}
		}
		a.sustain = approach(a.sustain, this.sustainValue, dt, 0.5);
		this.noteRate *= decay(dt, RATE_TAU_S);
		a.noteRate = this.noteRate;
		const tonality = this.tonalitySmooth;
		const padTarget = live
			? tonality * smoothstep(0.35, 0.8, a.sustain) * (1 - smoothstep(1.5, 5, this.noteRate)) * smoothstep(0.05, 0.25, this.frame.texture.mid)
			: 0;
		a.pad = approach(a.pad, padTarget, dt, 0.8);
	}

	// ---- Texture -----------------------------------------------------------------

	private updateTexture(
		features: AudioFeatureFrame | null,
		director: VisualDirectorFrame,
		spectrum: Readonly<SignalSpectrumProfile>,
		dt: number,
		live: boolean
	): void {
		const t = this.frame.texture;
		this.eventRate *= decay(dt, RATE_TAU_S);
		t.eventsPerSecond = this.eventRate;
		t.density = this.eventRate / (this.eventRate + 5);
		const l = spectrum.levels;
		t.low = approach(t.low, live ? clamp01((l.sub + l.kick) * 0.5) : 0, dt, 0.15);
		t.mid = approach(t.mid, live ? clamp01((l.body + l.mids) * 0.5) : 0, dt, 0.15);
		t.high = approach(t.high, live ? clamp01((l.presence + l.air) * 0.5) : 0, dt, 0.15);
		t.register = clamp((t.high - t.low) / (t.high + t.low + 0.05), -1, 1);

		// Stereo image, neutral when no stereo arrives.
		this.sinceStereo += dt;
		if (live && features?.stereo_width !== undefined && features.stereo_corr !== undefined) {
			this.sinceStereo = 0;
			t.stereoKnown = true;
			t.width = approach(t.width, clamp01(features.stereo_width), dt, 0.3);
			t.correlation = approach(t.correlation, clamp(features.stereo_corr, -1, 1), dt, 0.3);
		} else if (this.sinceStereo > 1) {
			t.stereoKnown = false;
			t.width = approach(t.width, NEUTRAL_WIDTH, dt, 1);
			t.correlation = approach(t.correlation, NEUTRAL_CORRELATION, dt, 1);
		}
		t.tonality = this.tonalitySmooth;
		t.noisiness = 1 - t.tonality;

		// Trend: slope of energy, density and brightness over ~8 s.
		if (live) {
			this.trendAccE += director.energy;
			this.trendAccD += t.density;
			this.trendAccB += spectrum.centroid;
			this.trendAccN += 1;
		}
		this.trendClock += dt;
		if (this.trendClock >= TREND_STEP_S) {
			this.trendClock -= TREND_STEP_S;
			if (this.trendAccN > 0) {
				const n = this.trendAccN;
				this.trendEnergy[this.trendHead] = this.trendAccE / n;
				this.trendDensity[this.trendHead] = this.trendAccD / n;
				this.trendBright[this.trendHead] = this.trendAccB / n;
				this.trendHead = (this.trendHead + 1) % TREND_SAMPLES;
				this.trendCount = Math.min(TREND_SAMPLES, this.trendCount + 1);
			}
			this.trendAccE = 0;
			this.trendAccD = 0;
			this.trendAccB = 0;
			this.trendAccN = 0;
		}
		let trend = 0;
		if (this.trendCount >= 8) {
			const energy = this.slope(this.trendEnergy);
			const density = this.slope(this.trendDensity);
			const bright = this.slope(this.trendBright);
			const span = this.trendCount - 1;
			trend = clamp(energy * span * 2.2 + density * span * 1.6 + bright * span * 4, -1, 1);
		}
		t.trend = approach(t.trend, live ? trend : 0, dt, 0.6);
		t.build = approach(t.build, Math.max(0, t.trend), dt, 0.8);
	}

	/** Least-squares slope per sample over the filled part of a trend ring. */
	private slope(ring: Float32Array): number {
		const n = this.trendCount;
		const start = (this.trendHead - n + TREND_SAMPLES) % TREND_SAMPLES;
		const meanX = (n - 1) / 2;
		let meanY = 0;
		for (let k = 0; k < n; k += 1) meanY += ring[(start + k) % TREND_SAMPLES];
		meanY /= n;
		let num = 0;
		let den = 0;
		for (let k = 0; k < n; k += 1) {
			const dx = k - meanX;
			num += dx * (ring[(start + k) % TREND_SAMPLES] - meanY);
			den += dx * dx;
		}
		return den > 0 ? num / den : 0;
	}
}
