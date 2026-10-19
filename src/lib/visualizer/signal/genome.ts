// Signal's visual genome: which instrument is on the bench, which phosphor is
// in the tube, how the camera looks at it and what the glass does to it. The
// conductor and the audio stay in charge of reaction; this decides the look
// and walks it forward at musical boundaries for as long as the stream runs.
//
// Scales:
//   phrase  - figure parameters, spin, tilt, hue lean, band-trace mapping
//   section - instrument layout, figure family, phosphor palette, camera,
//             persistence, relief, grid, history coupling
//   era     - display character (tube type, scan, curvature, grain, grade)
//
// The feeder below turns the director's clock and section into genome input.
// It debounces flickery live section labels and guarantees a scene move at
// least every few phrases, so a radio stream that never reports a section
// still changes scene about every 45 seconds.

import {
	VariationGenome,
	variationSpaceSize,
	type ChoiceState,
	type VariationAxis
} from '$lib/visualizer/variation';

export const SIGNAL_LAYOUT_COUNT = 8;
export const SIGNAL_FAMILY_COUNT = 8;
export const SIGNAL_PALETTE_COUNT = 22;
export const SIGNAL_CAMERA_COUNT = 5;
export const SIGNAL_DISPLAY_COUNT = 6;
export const SIGNAL_TRACE_MAP_COUNT = 3;

export const SIGNAL_VARIATION_AXES: readonly VariationAxis[] = [
	// Section scale: a new scene.
	{ kind: 'choice', name: 'layout', options: SIGNAL_LAYOUT_COUNT, scale: 'section', chance: 0.92, memory: 4, tau: 3.2 },
	{ kind: 'choice', name: 'family', options: SIGNAL_FAMILY_COUNT, scale: 'section', chance: 0.85, memory: 4, tau: 2.6 },
	{ kind: 'choice', name: 'palette', options: SIGNAL_PALETTE_COUNT, scale: 'section', chance: 0.72, memory: 9, tau: 3.6 },
	{ kind: 'choice', name: 'camera', options: SIGNAL_CAMERA_COUNT, scale: 'section', chance: 0.55, memory: 2, tau: 4.5 },
	{ kind: 'continuous', name: 'figureScale', min: 0, max: 1, scale: 'section', step: 0.34, tau: 3 },
	{ kind: 'continuous', name: 'persistence', min: 0, max: 1, scale: 'section', step: 0.36, tau: 4 },
	{ kind: 'continuous', name: 'relief', min: 0, max: 1, scale: 'section', step: 0.36, tau: 3 },
	{ kind: 'continuous', name: 'grid', min: 0, max: 1, scale: 'section', step: 0.4, tau: 3 },
	{ kind: 'continuous', name: 'coupling', min: 0, max: 1, scale: 'section', step: 0.4, tau: 3 },
	// Era scale: a new reel.
	{ kind: 'choice', name: 'display', options: SIGNAL_DISPLAY_COUNT, scale: 'era', chance: 1, memory: 3, tau: 6 },
	{ kind: 'continuous', name: 'scan', min: 0, max: 1, scale: 'era', step: 0.4, tau: 6 },
	{ kind: 'continuous', name: 'curvature', min: 0, max: 1, scale: 'era', step: 0.4, tau: 6 },
	{ kind: 'continuous', name: 'grain', min: 0, max: 1, scale: 'era', step: 0.4, tau: 6 },
	{ kind: 'continuous', name: 'warmth', min: -1, max: 1, scale: 'era', step: 0.4, tau: 8 },
	{ kind: 'continuous', name: 'stroke', min: 0, max: 1, scale: 'era', step: 0.36, tau: 6 },
	// Phrase scale: the same scene keeps breathing.
	{ kind: 'choice', name: 'traceMap', options: SIGNAL_TRACE_MAP_COUNT, scale: 'phrase', chance: 0.4, memory: 1, tau: 1.6 },
	{ kind: 'continuous', name: 'p1', min: 0, max: 1, scale: 'phrase', step: 0.32, tau: 2.6 },
	{ kind: 'continuous', name: 'p2', min: 0, max: 1, scale: 'phrase', step: 0.32, chance: 0.75, tau: 2.6 },
	{ kind: 'continuous', name: 'spin', min: -1, max: 1, scale: 'phrase', step: 0.4, tau: 3 },
	{ kind: 'continuous', name: 'tilt', min: 0, max: 1, scale: 'phrase', step: 0.32, tau: 3.4 },
	{ kind: 'continuous', name: 'hueLean', min: -1, max: 1, scale: 'phrase', step: 0.36, tau: 3 },
	{ kind: 'continuous', name: 'drift', min: 0, max: 1, scale: 'phrase', step: 0.4, tau: 3.5 }
];

export function signalVariationSpaceSize(): number {
	return variationSpaceSize(SIGNAL_VARIATION_AXES);
}

export type SignalChoiceName = 'layout' | 'family' | 'palette' | 'camera' | 'display' | 'traceMap';
export type SignalContinuousName =
	| 'figureScale'
	| 'persistence'
	| 'relief'
	| 'grid'
	| 'coupling'
	| 'scan'
	| 'curvature'
	| 'grain'
	| 'warmth'
	| 'stroke'
	| 'p1'
	| 'p2'
	| 'spin'
	| 'tilt'
	| 'hueLean'
	| 'drift';

export type SignalVariationInput = {
	phraseIndex: number;
	section: string;
	energy: number;
	silence: boolean;
	dt: number;
};

/** Scene moves at least this often (in phrases) when the section never changes. */
const SCENE_FALLBACK_PHRASES = 3;
/** A new section label must hold this long before it counts as a scene. */
const SECTION_DEBOUNCE_SECONDS = 3;
/** Never cut two scenes closer together than this. */
const MIN_SCENE_SECONDS = 9;

export type SignalLookOverride = Partial<Record<SignalChoiceName, number>>;

/**
 * Genome plus the musical feeder. Deterministic: the same seed and the same
 * sequence of inputs produce the same looks.
 */
export class SignalVariation {
	readonly genome: VariationGenome;
	private sceneIndex = 0;
	private emittedSection: string | null = null;
	private candidateSection: string | null = null;
	private candidateAge = 0;
	private sceneAge = 0;
	private phrasesInScene = 0;
	private lastPhrase: number | null = null;
	private override: SignalLookOverride = {};

	constructor(seed: number | string) {
		this.genome = new VariationGenome(SIGNAL_VARIATION_AXES, `signal:${seed}`);
	}

	/** Carry the current look into a new source: keep the scene, change future draws. */
	continueWith(seed: number | string): void {
		this.genome.reseed(`signal:${seed}`);
		this.lastPhrase = null;
		this.candidateSection = null;
		this.candidateAge = 0;
	}

	reset(seed: number | string): void {
		this.genome.reset(`signal:${seed}`);
		this.sceneIndex = 0;
		this.emittedSection = null;
		this.candidateSection = null;
		this.candidateAge = 0;
		this.sceneAge = 0;
		this.phrasesInScene = 0;
		this.lastPhrase = null;
	}

	/** Pin choice axes for inspection (lab ?signalLook=layout:3,family:2). */
	setOverride(override: SignalLookOverride): void {
		this.override = { ...override };
	}

	get scene(): number {
		return this.sceneIndex;
	}

	advance(input: SignalVariationInput): void {
		const dt = Math.min(0.5, Math.max(0, Number.isFinite(input.dt) ? input.dt : 0));
		const phrase = Number.isFinite(input.phraseIndex) ? Math.floor(input.phraseIndex) : 0;
		this.sceneAge += dt;
		const phraseChanged = this.lastPhrase !== null && phrase !== this.lastPhrase;
		this.lastPhrase = phrase;
		if (phraseChanged) this.phrasesInScene += 1;

		if (this.emittedSection === null) this.emittedSection = input.section;
		if (input.section !== this.candidateSection) {
			this.candidateSection = input.section;
			this.candidateAge = 0;
		} else {
			this.candidateAge += dt;
		}
		const labelMove =
			this.candidateSection !== this.emittedSection && this.candidateAge >= SECTION_DEBOUNCE_SECONDS;
		const fallbackMove = phraseChanged && this.phrasesInScene >= SCENE_FALLBACK_PHRASES;
		if ((labelMove || fallbackMove) && this.sceneAge >= MIN_SCENE_SECONDS && !input.silence) {
			this.sceneIndex += 1;
			this.emittedSection = this.candidateSection;
			this.sceneAge = 0;
			this.phrasesInScene = 0;
		}

		this.genome.advance({
			phraseIndex: phrase,
			sectionKey: `${this.emittedSection}:${this.sceneIndex}`,
			energy: input.energy,
			dt
		});
	}

	choice(name: SignalChoiceName): ChoiceState {
		const forced = this.override[name];
		if (forced !== undefined && Number.isFinite(forced)) {
			return { from: forced, to: forced, mix: 1 };
		}
		return this.genome.choice(name);
	}

	value(name: SignalContinuousName): number {
		return this.genome.value(name);
	}

	/** The (palette, family, layout) triple currently being shown. */
	triple(): string {
		return `${this.choice('palette').to}/${this.choice('family').to}/${this.choice('layout').to}`;
	}
}

/** Parse "layout:3,family:2,palette:5" (also accepts "=") into an override. */
export function parseSignalLookOverride(text: string | null | undefined): SignalLookOverride {
	const out: SignalLookOverride = {};
	if (!text) return out;
	const limits: Record<SignalChoiceName, number> = {
		layout: SIGNAL_LAYOUT_COUNT,
		family: SIGNAL_FAMILY_COUNT,
		palette: SIGNAL_PALETTE_COUNT,
		camera: SIGNAL_CAMERA_COUNT,
		display: SIGNAL_DISPLAY_COUNT,
		traceMap: SIGNAL_TRACE_MAP_COUNT
	};
	for (const part of text.split(',')) {
		const [rawName, rawValue] = part.split(/[:=]/);
		const name = rawName?.trim() as SignalChoiceName;
		const value = Number(rawValue);
		if (name in limits && Number.isInteger(value) && value >= 0 && value < limits[name]) out[name] = value;
	}
	return out;
}

// One genome per journey, so remounting the renderer mid-song keeps the look.
let cached: { seed: number; epoch: number; variation: SignalVariation } | null = null;

export function signalVariationFor(seed: number, epoch: number): SignalVariation {
	if (cached && cached.seed === seed && cached.epoch === epoch) return cached.variation;
	if (!cached) {
		const variation = new SignalVariation(seed);
		variation.reset(seed);
		cached = { seed, epoch, variation };
		return variation;
	}
	// A new source continues the picture instead of restarting it.
	cached.variation.continueWith(seed);
	cached = { seed, epoch, variation: cached.variation };
	return cached.variation;
}
