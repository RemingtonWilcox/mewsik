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
	/**
	 * Stereo scope (renderer-only, never read by the journey): the left/right
	 * pairs heard since the previous frame, base64 of interleaved
	 * little-endian i16 scaled by 32767. Empty while silent. Native frames.
	 */
	scope?: string;
	/** Pair rate of `scope` / `scope_pcm` after any decimation, Hz. */
	scope_rate?: number;
	/** Browser analyzers and lab profiles: the same pairs as -1..1 floats. */
	scope_pcm?: Float32Array;
	// ---- Raw ensemble features (read by EnsembleTracker, ensemble.ts) ----
	// Optional so older frames and hand-built test frames stay valid; the
	// tracker falls back to the spectrum when they are absent.
	/** 12 pitch classes from C, 100 Hz–5 kHz, max-normalised 0..1. */
	chroma?: number[];
	/** 12 pitch classes from C over the bass register (40–250 Hz), 0..1. */
	bass_chroma?: number[];
	/** Onset strength in this frame per layer, 0..1 (0 = none). */
	onset_kick?: number;
	onset_snare?: number;
	onset_hat?: number;
	onset_perc?: number;
	onset_tonal?: number;
	/** Stereo image of the samples since the previous frame. */
	stereo_width?: number;
	stereo_corr?: number;
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
