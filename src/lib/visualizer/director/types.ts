// Director v2 — frame schema and type contracts.
//
// Three tiers feed one output frame:
//   Tier 0 (raw)  → AudioFeatures from sidecar (FFT bins, RMS, onset, chroma, bpm)
//   Tier 1 (mid)  → clock, key/tonnetz, onset density, novelty, sub-bass envelope
//   Tier 2 (high) → structure FSM, drop anticipation, palette, motion/density, phrase
//
// Renderers only ever see the V2 frame.

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
};
