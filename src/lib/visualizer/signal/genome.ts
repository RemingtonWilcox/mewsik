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
import {
	CHARACTER_FEATURES,
	characterWeights,
	type CharacterFeature,
	type MusicCharacter
} from '$lib/visualizer/character';
import {
	SIGNAL_CAMERA_PROTOTYPES,
	SIGNAL_DISPLAY_PROTOTYPES,
	SIGNAL_FAMILY_PROTOTYPES,
	SIGNAL_LAYOUT_PROTOTYPES,
	SIGNAL_PALETTE_PROTOTYPES,
	signalCharacterView,
	type SignalCharacterView
} from './voice';

export const SIGNAL_LAYOUT_COUNT = 8;
export const SIGNAL_FAMILY_COUNT = 8;
export const SIGNAL_PALETTE_COUNT = 22;
export const SIGNAL_CAMERA_COUNT = 5;
export const SIGNAL_DISPLAY_COUNT = 6;
export const SIGNAL_TRACE_MAP_COUNT = 3;

export const SIGNAL_VARIATION_AXES: readonly VariationAxis[] = [
	// Section scale: a new scene.
	{ kind: 'choice', name: 'layout', options: SIGNAL_LAYOUT_COUNT, scale: 'section', chance: 0.96, memory: 2, tau: 3.2 },
	{ kind: 'choice', name: 'family', options: SIGNAL_FAMILY_COUNT, scale: 'section', chance: 0.92, memory: 2, tau: 2.6 },
	{ kind: 'choice', name: 'palette', options: SIGNAL_PALETTE_COUNT, scale: 'section', chance: 1, memory: 3, tau: 3.6 },
	{ kind: 'choice', name: 'camera', options: SIGNAL_CAMERA_COUNT, scale: 'section', chance: 0.55, memory: 2, tau: 4.5 },
	{ kind: 'continuous', name: 'figureScale', min: 0, max: 1, scale: 'section', step: 0.34, tau: 3 },
	{ kind: 'continuous', name: 'persistence', min: 0, max: 1, scale: 'section', step: 0.36, tau: 4 },
	{ kind: 'continuous', name: 'relief', min: 0, max: 1, scale: 'section', step: 0.36, tau: 3 },
	{ kind: 'continuous', name: 'grid', min: 0, max: 1, scale: 'section', step: 0.4, tau: 3 },
	{ kind: 'continuous', name: 'coupling', min: 0, max: 1, scale: 'section', step: 0.4, tau: 3 },
	// Era scale: a new reel.
	{ kind: 'choice', name: 'display', options: SIGNAL_DISPLAY_COUNT, scale: 'era', chance: 1, memory: 3, tau: 4 },
	{ kind: 'continuous', name: 'scan', min: 0, max: 1, scale: 'era', step: 0.4, tau: 3.5 },
	{ kind: 'continuous', name: 'curvature', min: 0, max: 1, scale: 'era', step: 0.4, tau: 3.5 },
	{ kind: 'continuous', name: 'grain', min: 0, max: 1, scale: 'era', step: 0.4, tau: 3.5 },
	{ kind: 'continuous', name: 'warmth', min: -1, max: 1, scale: 'era', step: 0.4, tau: 4 },
	{ kind: 'continuous', name: 'stroke', min: 0, max: 1, scale: 'era', step: 0.36, tau: 3.5 },
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
/** After the music changes character, the look it answered with holds this long. */
const SHIFT_HOLD_SECONDS = 15;
/** The shared tracker's fast envelope time constant (character.ts FAST_TAU_S). */
const CHARACTER_TAU_SECONDS = 1.1;
const SOURCE_TAU_SECONDS = 0.44;
/** How sharply character weights prefer the best-fitting options. */
const WEIGHT_SHARPNESS = 14;

export type SignalShiftEvent = {
	/** 0..1; 1 for a new source. */
	strength: number;
	/** The shared character's shiftSerial this answers. */
	serial: number;
};

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
	/**
	 * The shared character's shiftSerial this look last answered. It lives with
	 * the look, so a remount or a new source never answers the same shift twice.
	 */
	private answeredSerial: number | null = null;
	private readonly projectedRaw = {} as Record<CharacterFeature, number>;
	/** Per-feature rate of change of the character envelopes (per second). */
	private readonly velocity = {} as Record<CharacterFeature, number>;
	private readonly lastRaw = {} as Record<CharacterFeature, number>;
	private rawPrimed = false;
	private readonly projected: SignalCharacterView = signalCharacterView(null);
	private holdSeconds = 0;
	/** Phrase index the genome is held on during an answer's hold. */
	private heldPhrase: number | null = null;
	private readonly view: SignalCharacterView = signalCharacterView(null);
	private readonly weightScratch = {
		layout: [] as number[],
		family: [] as number[],
		palette: [] as number[],
		camera: [] as number[],
		display: [] as number[]
	};

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
		this.answeredSerial = null;
		this.rawPrimed = false;
		this.holdSeconds = 0;
		this.heldPhrase = null;
	}

	/** The last shared shiftSerial this look answered (null before the first frame). */
	get answered(): number | null {
		return this.answeredSerial;
	}

	/**
	 * Listen to the music's character once per frame, before advance(). Keeps
	 * the option weights fitted to what is playing, steers the character-led
	 * genome axes, and answers each new shift exactly once with genome.shift.
	 * Returns the shift answered this frame, if any.
	 */
	respond(
		character: Readonly<MusicCharacter> | null | undefined,
		energy: number,
		dt: number
	): SignalShiftEvent | null {
		const step = Math.min(0.5, Math.max(0, Number.isFinite(dt) ? dt : 0));
		this.holdSeconds = Math.max(0, this.holdSeconds - step);
		if (!character) return null;
		const view = signalCharacterView(character, this.view);
		this.trackVelocity(character, step);
		const genome = this.genome;
		this.fitWeights(view);

		// Character-led axes lean toward the music; the genome still walks them.
		const pull = Math.min(1, step * 0.8);
		genome.pull('persistence', (1 - view.tempo) * (1 - view.noise), pull);
		genome.pull('grain', view.noise, pull);
		genome.pull('figureScale', view.bass, pull * 0.6);
		genome.pull('stroke', view.bass * 0.6 + (1 - view.punch) * 0.4, pull * 0.6);
		const warmth = 0.5 + (view.valence - 0.5) + view.punch * 0.35 - view.brightness * 0.4;
		genome.pull('warmth', Math.min(1, Math.max(0, warmth)), pull * 0.6);

		let event: SignalShiftEvent | null = null;
		const serial = character.shiftSerial;
		if (this.answeredSerial === null) {
			// First frame this look has ever seen: adopt what is playing.
			this.answeredSerial = serial;
		} else if (serial !== this.answeredSerial) {
			this.answeredSerial = serial;
			event = { strength: Math.min(1, Math.max(0.3, character.shiftStrength)), serial };
			// The character envelopes are still travelling when the shift fires.
			// Pick for where the music is heading, not for the blend of old and
			// new it reads at this instant. A new source's envelopes run faster
			// (character.ts) until its shift fires.
			const newSource = character.shiftStrength >= 0.99;
			this.project(character, newSource ? SOURCE_TAU_SECONDS : CHARACTER_TAU_SECONDS);
			this.fitWeights(this.projected);
			genome.shift(event.strength, energy);
			this.fitWeights(view);
			// The answer is the new scene: no section label piles a second
			// scene change on top of it while it lands.
			this.sceneAge = 0;
			this.phrasesInScene = 0;
			this.holdSeconds = SHIFT_HOLD_SECONDS;
			this.heldPhrase ??= this.lastPhrase;
		}
		return event;
	}

	/** Bias every choice axis toward options that fit this character. */
	private fitWeights(view: SignalCharacterView): void {
		const w = this.weightScratch;
		const genome = this.genome;
		const c = view as unknown as MusicCharacter;
		genome.setWeights('layout', characterWeights(SIGNAL_LAYOUT_PROTOTYPES, c, WEIGHT_SHARPNESS, 0.01, w.layout));
		genome.setWeights('family', characterWeights(SIGNAL_FAMILY_PROTOTYPES, c, WEIGHT_SHARPNESS, 0.01, w.family));
		genome.setWeights('palette', characterWeights(SIGNAL_PALETTE_PROTOTYPES, c, WEIGHT_SHARPNESS * 1.4, 0.005, w.palette));
		genome.setWeights('camera', characterWeights(SIGNAL_CAMERA_PROTOTYPES, c, 3, 0.15, w.camera));
		genome.setWeights('display', characterWeights(SIGNAL_DISPLAY_PROTOTYPES, c, WEIGHT_SHARPNESS, 0.01, w.display));
	}

	private trackVelocity(character: Readonly<MusicCharacter>, step: number): void {
		if (step <= 0) return;
		const k = 1 - Math.exp(-step / 0.15);
		for (const key of CHARACTER_FEATURES) {
			const value = Number.isFinite(character[key]) ? character[key] : 0;
			const rate = this.rawPrimed ? (value - this.lastRaw[key]) / step : 0;
			this.velocity[key] = (this.velocity[key] ?? 0) + (rate - (this.velocity[key] ?? 0)) * k;
			this.lastRaw[key] = value;
		}
		this.rawPrimed = true;
	}

	/**
	 * Where the music's character is heading. The shared envelopes approach
	 * the new music exponentially (about a second), so the remaining travel is
	 * roughly the current rate times that time constant. Signal answers on
	 * the projection, read as its own view (so roughness follows the projected
	 * tempo instead of lagging behind it).
	 */
	private project(character: Readonly<MusicCharacter>, tau: number): void {
		for (const key of CHARACTER_FEATURES) {
			// Never trust a projection further than most of the feature's range.
			const ahead = Math.max(-0.6, Math.min(0.6, (this.velocity[key] ?? 0) * tau));
			const value = (Number.isFinite(character[key]) ? character[key] : 0) + ahead;
			this.projectedRaw[key] = value < 0 ? 0 : value > 1 ? 1 : value;
		}
		signalCharacterView(this.projectedRaw as unknown as MusicCharacter, this.projected);
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
		if (
			(labelMove || fallbackMove) &&
			this.sceneAge >= MIN_SCENE_SECONDS &&
			this.holdSeconds <= 0 &&
			!input.silence
		) {
			this.sceneIndex += 1;
			this.emittedSection = this.candidateSection;
			this.sceneAge = 0;
			this.phrasesInScene = 0;
		}

		// While an answer holds, the genome sees no phrase boundary either, so
		// the look the music asked for is not nudged off while it lands; the
		// held boundary arrives once the hold ends.
		if (this.holdSeconds <= 0) this.heldPhrase = null;
		this.genome.advance({
			phraseIndex: this.heldPhrase ?? phrase,
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
