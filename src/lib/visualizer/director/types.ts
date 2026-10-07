// Director v2 — frame schema and type contracts.
//
// Three tiers feed one output frame:
//   Tier 0 (raw)  → AudioFeatures from sidecar (FFT bins, RMS, onset, chroma, bpm)
//   Tier 1 (mid)  → clock, key/tonnetz, onset density, novelty, sub-bass envelope
//   Tier 2 (high) → structure FSM, drop anticipation, palette, motion/density, phrase
//
// Renderers only ever see the V2 frame.

// Kept in the director contract rather than the visualizer store so the store
// can own one persistent VisualDirector without creating a runtime import
// cycle. `AudioFeatures` remains publicly exported by visualizer.svelte.ts as
// an alias of this shape.
export type AudioFeatureFrame = {
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

export type VisualizerSection =
	| 'calm'
	| 'intro'
	| 'verse'
	| 'pre_chorus'
	| 'build'
	| 'drop'
	| 'chorus'
	| 'bridge'
	| 'breakdown'
	| 'outro';

export type VisualizerMotif = 'organism' | 'tunnel' | 'lattice' | 'ribbon';

export type PaletteHSV = {
	baseHue: number;
	accentHue: number;
	rimHue: number;
	saturation: number;
	warmth: number;
};

export type MusicalClock = {
	tempoBpm: number;
	beatPhase: number;
	beatPulse: number;
	downbeatFlag: boolean;
	barIndex: number;
	beatIndex: number;
	phrasePos: number;
	phraseIndex: number;
};

export type DropState = {
	buildActive: boolean;
	buildProgress: number;
	dropEta: number;
	anticipation: number;
	postDropDecay: number;
};

export type PerformanceContextSource = 'live' | 'score';
export type PerformanceKeyMode = 'major' | 'minor' | 'unknown';

/**
 * Slow musical context shared by every renderer. Score-backed values are
 * deterministic for local tracks; live values remain useful fallbacks for
 * radio and streamed-only playback.
 */
export type MusicalPerformanceContext = {
	source: PerformanceContextSource;
	/** 0..1 through the scored section; live fallback follows phrase position. */
	sectionProgress: number;
	/** 0..1 normalized section loudness; live fallback is director energy. */
	sectionEnergy: number;
	/** 0..1 through a scored track. Zero when no offline timeline exists. */
	trackProgress: number;
	/** Current 2 Hz score-energy sample, or live director energy as fallback. */
	energyCurrent: number;
	/** Local score-energy change (future minus past), nominally -1..1. */
	energySlope: number;
	/** Score energy eight seconds ahead, or current live energy as fallback. */
	energyLookahead: number;
	/** Pitch class normalized to 0..1, matching AudioFeatureFrame.chroma_key. */
	keyPitchClass: number;
	keyMode: PerformanceKeyMode;
	keyConfidence: number;
};

export type VisualDirectorFrame = {
	section: VisualizerSection;
	sectionAge: number;
	motif: VisualizerMotif;
	motifIndex: number;
	silence: boolean;
	energy: number;
	density: number;
	motion: number;
	structure: number;
	phrase: number;
	palette: PaletteHSV;
	paletteBase: number;
	paletteAccent: number;
	clock: MusicalClock;
	drop: DropState;
	valence: number;
	arousal: number;
	bassPunch: number;
	trebleSparkle: number;
	tonnetz: [number, number, number, number, number, number];
	// Fast rail — raw bass/mid/treble/centroid with only a one-frame denoise
	// (~30ms half-life). Renderers that want gen-1-style instant audio response
	// read these instead of the longer-tail envelopes (energy/bassPunch).
	// Filled with zeros when features are absent or silence is held.
	bassRaw: number;
	midRaw: number;
	trebleRaw: number;
	centroidRaw: number;
	context: MusicalPerformanceContext;
};
