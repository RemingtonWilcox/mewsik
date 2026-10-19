// Mandala's long-listen look: which fractal world the picture is in, which
// variant of it, how many mirror sectors fold it, the jewel palette, and the
// continuous fractal parameters that drift with the music. The genome walks
// these at musical boundaries and leaps on a character shift; a change of
// world, variant or fold reaches the shader as an A -> B morph (both worlds
// rendered, the new one opening out of the old), never a cut.
//
// Worlds are genuinely different places with their own camera regime:
//   bloom    kaleidoscopic Kaliset filigree, an endless layered zoom (plane)
//   spiral   an n-fold Julia set dived into forever about a repelling fixed
//            point, self-similar spiral by spiral (zoom dive)
//   yantra   sacred-geometry line work in a Droste spiral (spiral recursion)
//   sponge   inside the Menger sponge, x3 self-similar flight (3D zoom)
//   cavern   pseudo-Kleinian caverns flown through on a corridor (3D flight)
//   foam     an Apollonian sphere-inversion foam drifted through (open space)
//   crystal  a kaleidoscopic IFS cathedral orbited up close (object orbit)
//   bulb     the Mandelbulb's surface, power drifting (surface orbit)

import type { CharacterFeature, MusicCharacter } from '../character';
import { characterWeights } from '../character';
import type { VariationAxis, VariationGenome } from '../variation';

export type Rgb = [number, number, number];

export const MANDALA_WORLDS = [
	'bloom',
	'spiral',
	'yantra',
	'sponge',
	'cavern',
	'foam',
	'crystal',
	'bulb'
] as const;
export type MandalaWorld = (typeof MANDALA_WORLDS)[number];
/** Worlds rendered by raymarching (the rest are escape-time planes). */
export const MANDALA_RAYMARCHED: ReadonlySet<MandalaWorld> = new Set(['sponge', 'cavern', 'foam', 'crystal', 'bulb']);
export const MANDALA_VARIANTS = 4;

/** Listener-neutral names per (world, variant), for QA attributes. */
export const MANDALA_VARIANT_NAMES: Record<MandalaWorld, readonly string[]> = {
	bloom: ['kaliset', 'twisted', 'rings', 'lattice'],
	spiral: ['rosettes', 'rings', 'galaxy', 'mirror rosettes'],
	yantra: ['flower of life', 'sri yantra', 'metatron', 'phyllotaxis'],
	sponge: ['cross', 'arches', 'octahedral', 'jerusalem'],
	cavern: ['kleinian', 'filaments', 'arcade', 'lattice'],
	foam: ['apollonian', 'pearls', 'shells', 'coral'],
	crystal: ['octahedral', 'icosahedral', 'cathedral', 'menger'],
	bulb: ['bulb', 'quintic', 'tri', 'nine']
};

/** Mirror sectors the planes are folded into (the 3D worlds read it as fold strength). */
export const MANDALA_FOLDS = [3, 4, 5, 6, 7, 8, 9, 10, 12] as const;

export type MandalaPalette = {
	name: string;
	/** Four emission stops, deep to hot. The background is always black. */
	stops: [Rgb, Rgb, Rgb, Rgb];
	/** Local beat sparks. */
	spark: Rgb;
	/** 0..1 how much the stops cycle with view angle and orbit (iridescence). */
	sheen: number;
	/** 0..1 how warm the family reads. */
	warmth: number;
};

// Authored stops, never a cosine ramp: saturated jewel colour, a deep stop
// that is dark but never grey, and a hot stop that burns toward white.
export const MANDALA_PALETTES: readonly MandalaPalette[] = [
	{
		name: 'sapphire gold',
		stops: [
			[0.02, 0.05, 0.42],
			[0.0, 0.42, 1.0],
			[0.1, 0.88, 1.0],
			[1.0, 0.7, 0.2]
		],
		spark: [1.0, 0.86, 0.5],
		sheen: 0.35,
		warmth: 0.4
	},
	{
		name: 'emerald',
		stops: [
			[0.0, 0.14, 0.07],
			[0.0, 0.66, 0.34],
			[0.4, 1.0, 0.55],
			[1.0, 0.95, 0.55]
		],
		spark: [1.0, 0.75, 0.25],
		sheen: 0.3,
		warmth: 0.45
	},
	{
		name: 'ruby',
		stops: [
			[0.3, 0.0, 0.04],
			[0.95, 0.03, 0.12],
			[1.0, 0.36, 0.12],
			[1.0, 0.86, 0.55]
		],
		spark: [1.0, 0.95, 0.8],
		sheen: 0.2,
		warmth: 0.9
	},
	{
		name: 'amethyst',
		stops: [
			[0.14, 0.0, 0.34],
			[0.55, 0.08, 1.0],
			[1.0, 0.28, 0.85],
			[1.0, 0.82, 1.0]
		],
		spark: [0.55, 1.0, 1.0],
		sheen: 0.5,
		warmth: 0.5
	},
	{
		name: 'peacock',
		stops: [
			[0.0, 0.08, 0.3],
			[0.0, 0.62, 0.62],
			[0.35, 1.0, 0.3],
			[1.0, 0.82, 0.15]
		],
		spark: [1.0, 0.3, 0.8],
		sheen: 0.85,
		warmth: 0.45
	},
	{
		name: 'oil slick',
		stops: [
			[0.1, 0.04, 0.4],
			[0.05, 0.62, 0.7],
			[1.0, 0.58, 0.16],
			[0.9, 0.16, 0.72]
		],
		spark: [0.9, 1.0, 1.0],
		sheen: 1.0,
		warmth: 0.5
	},
	{
		name: 'ember',
		stops: [
			[0.24, 0.02, 0.0],
			[0.95, 0.2, 0.0],
			[1.0, 0.58, 0.06],
			[1.0, 0.92, 0.62]
		],
		spark: [0.4, 0.9, 1.0],
		sheen: 0.1,
		warmth: 1.0
	},
	{
		name: 'arctic',
		stops: [
			[0.0, 0.05, 0.16],
			[0.08, 0.5, 1.0],
			[0.7, 0.95, 1.0],
			[1.0, 1.0, 1.0]
		],
		spark: [1.0, 0.16, 0.24],
		sheen: 0.25,
		warmth: 0.0
	},
	{
		name: 'acid',
		stops: [
			[0.02, 0.1, 0.0],
			[0.42, 0.95, 0.0],
			[0.92, 1.0, 0.3],
			[1.0, 1.0, 0.9]
		],
		spark: [1.0, 0.1, 0.7],
		sheen: 0.3,
		warmth: 0.35
	},
	{
		name: 'nebula',
		stops: [
			[0.04, 0.02, 0.24],
			[0.26, 0.2, 0.9],
			[0.92, 0.44, 0.78],
			[1.0, 0.9, 0.86]
		],
		spark: [0.45, 0.92, 1.0],
		sheen: 0.6,
		warmth: 0.35
	},
	{
		name: 'honey',
		stops: [
			[0.18, 0.06, 0.0],
			[0.8, 0.36, 0.04],
			[1.0, 0.72, 0.3],
			[1.0, 0.95, 0.8]
		],
		spark: [0.5, 0.9, 0.55],
		sheen: 0.15,
		warmth: 0.95
	},
	{
		name: 'blood moon',
		stops: [
			[0.1, 0.0, 0.03],
			[0.62, 0.02, 0.06],
			[1.0, 0.42, 0.1],
			[1.0, 0.88, 0.66]
		],
		spark: [0.5, 0.72, 1.0],
		sheen: 0.12,
		warmth: 0.85
	},
	{
		name: 'cobalt neon',
		stops: [
			[0.0, 0.0, 0.3],
			[0.12, 0.12, 1.0],
			[1.0, 0.1, 0.62],
			[1.0, 0.82, 1.0]
		],
		spark: [0.2, 1.0, 1.0],
		sheen: 0.55,
		warmth: 0.3
	}
];

type Prototype = Partial<Record<CharacterFeature, number>>;

/**
 * Which music each world fits, fitted to what Mandala actually hears from
 * each genre (tempo, hiss, spectral tilt, punch, bass): ambient is vast and
 * slow (foam), noise fractured and violent (crystal, cavern), club hypnotic
 * and locked (spiral, sponge), acoustic warm and organic (yantra, bloom),
 * cinematic and swing huge and slow-revealing (bulb).
 */
const WORLD_PROTOTYPES: Record<MandalaWorld, Prototype> = {
	bloom: { tempo: 0.3, punch: 0.65, bass: 0.45, brightness: 0.45 },
	spiral: { tempo: 0.57, noise: 0.07, bass: 0.76, punch: 0.21 },
	yantra: { tempo: 0.2, punch: 0.75, brightness: 0.75, bass: 0.15 },
	sponge: { tempo: 0.5, noise: 0.04, bass: 0.6, brightness: 0.5, punch: 0.28 },
	cavern: { tempo: 0.75, noise: 0.6, brightness: 0.8, bass: 0.25 },
	foam: { tempo: 0.03, noise: 0, punch: 0.05, brightness: 0.71, bass: 0.33 },
	crystal: { tempo: 0.93, noise: 0.97, brightness: 0.94, bass: 0.11 },
	bulb: { tempo: 0.12, bass: 0.72, punch: 0.45, brightness: 0.35 }
};

const PALETTE_PROTOTYPES: readonly Prototype[] = [
	{ tempo: 0.5, brightness: 0.5, valence: 0.5 },
	{ tempo: 0.3, valence: 0.7, noise: 0.08 },
	{ energy: 0.75, valence: 0.45, tempo: 0.2, bass: 0.6 },
	{ tempo: 0.55, bass: 0.7, punch: 0.65 },
	{ tempo: 0.4, valence: 0.65, brightness: 0.55 },
	{ tempo: 0.55, punch: 0.6, valence: 0.55 },
	{ noise: 0.6, energy: 0.85, tempo: 0.8, valence: 0.4 },
	{ noise: 0.95, brightness: 0.95, tempo: 0.95 },
	{ noise: 0.85, tempo: 0.92, punch: 0.3 },
	{ tempo: 0.03, energy: 0.18, noise: 0.03, punch: 0.05 },
	{ tempo: 0.28, valence: 0.75, noise: 0.05, bass: 0.2 },
	{ tempo: 0.1, energy: 0.55, bass: 0.6, valence: 0.3 },
	{ tempo: 0.6, bass: 0.85, punch: 0.8, noise: 0.25 }
];

const FOLD_PROTOTYPES: readonly Prototype[] = MANDALA_FOLDS.map((fold) => {
	// Few sectors read harsh and fractured, many read hypnotic and ornate.
	const t = (fold - 3) / 9;
	return { noise: 0.85 - t * 0.75, tempo: 0.85 - t * 0.5, punch: 0.3 + t * 0.45 };
});

const VARIANT_PROTOTYPES: readonly Prototype[] = [
	{ noise: 0.15, tempo: 0.3 },
	{ tempo: 0.55, punch: 0.6 },
	{ noise: 0.6, tempo: 0.8 },
	{ bass: 0.7, energy: 0.6 }
];

export const MANDALA_AXES: readonly VariationAxis[] = [
	// Discrete: a change morphs both worlds on the GPU, so worlds move at
	// section scale; variant and fold change inside a world more often.
	// Memory 1: a change of music must be free to return to the world that
	// fits it best, even one it just left.
	{ kind: 'choice', name: 'world', options: MANDALA_WORLDS.length, scale: 'section', chance: 0.5, memory: 1, maxHold: 3, tau: 7 },
	{ kind: 'choice', name: 'variant', options: MANDALA_VARIANTS, scale: 'phrase', chance: 0.2, memory: 2, maxHold: 8, tau: 5 },
	{ kind: 'choice', name: 'fold', options: MANDALA_FOLDS.length, scale: 'phrase', chance: 0.2, memory: 3, maxHold: 8, tau: 5 },
	{ kind: 'choice', name: 'palette', options: MANDALA_PALETTES.length, scale: 'era', chance: 0.9, memory: 5, maxHold: 2, tau: 6 },
	// Continuous fractal parameters: each world reads them in its own terms
	// (Kaliset constant, Julia angle, sponge hole shape, Kleinian box...).
	{ kind: 'continuous', name: 'formA', min: 0, max: 1, scale: 'phrase', step: 0.3, chance: 0.8, tau: 10 },
	{ kind: 'continuous', name: 'formB', min: 0, max: 1, scale: 'phrase', step: 0.3, chance: 0.8, tau: 12 },
	{ kind: 'continuous', name: 'formC', min: 0, max: 1, scale: 'section', step: 0.4, tau: 9 },
	{ kind: 'continuous', name: 'formD', min: 0, max: 1, scale: 'section', step: 0.4, tau: 9 },
	{ kind: 'continuous', name: 'spin', min: -1, max: 1, scale: 'section', step: 0.45, tau: 9 },
	{ kind: 'continuous', name: 'drift', min: 0, max: 1, scale: 'phrase', step: 0.35, tau: 8 },
	{ kind: 'continuous', name: 'trail', min: 0, max: 1, scale: 'section', step: 0.45, tau: 6 },
	{ kind: 'continuous', name: 'sheen', min: 0, max: 1, scale: 'section', step: 0.4, tau: 7 },
	{ kind: 'continuous', name: 'glow', min: 0, max: 1, scale: 'section', step: 0.4, tau: 7 },
	{ kind: 'continuous', name: 'hue', min: 0, max: 1, scale: 'era', step: 0.25, wrap: true, tau: 10 },
	{ kind: 'continuous', name: 'warmth', min: 0, max: 1, scale: 'era', step: 0.35, tau: 10 }
];

const scratch: number[] = [];

/**
 * Bias every discrete axis toward options that fit the playing music, so a
 * shift (and every later boundary) picks a world, palette, fold and variant
 * that belong to the new genre.
 */
export function mandalaApplyCharacter(genome: VariationGenome, character: MusicCharacter, sharpness = 4): void {
	const worlds = MANDALA_WORLDS.map((world) => WORLD_PROTOTYPES[world]);
	genome.setWeights('world', characterWeights(worlds, character, sharpness, 0.02, scratch.slice()));
	genome.setWeights('palette', characterWeights(PALETTE_PROTOTYPES, character, sharpness * 1.1, 0.02, []));
	genome.setWeights('fold', characterWeights(FOLD_PROTOTYPES, character, sharpness * 0.8, 0.12, []));
	genome.setWeights('variant', characterWeights(VARIANT_PROTOTYPES, character, sharpness * 0.6, 0.2, []));
}

/** How well a palette fits the music, relative to the best fitting one (0..1). */
export function mandalaPaletteFit(palette: number, character: MusicCharacter, sharpness = 8): number {
	const weights = characterWeights(PALETTE_PROTOTYPES, character, sharpness * 1.1, 0.02, []);
	const best = Math.max(...weights);
	return best > 0 ? (weights[palette] ?? 0) / best : 1;
}

/** How well a world fits the music, relative to the best fitting one (0..1). */
export function mandalaWorldFit(world: number, character: MusicCharacter, sharpness = 6): number {
	const worlds = MANDALA_WORLDS.map((name) => WORLD_PROTOTYPES[name]);
	const weights = characterWeights(worlds, character, sharpness, 0.02, []);
	const best = Math.max(...weights);
	return best > 0 ? (weights[world] ?? 0) / best : 1;
}

/**
 * Steer the continuous axes the music's character should own: noise
 * fractures the form (formD is roughness everywhere), slow music trails and
 * glows, valence warms the palette lean.
 */
export function mandalaPullCharacter(genome: VariationGenome, character: MusicCharacter, amount: number): void {
	genome.pull('formD', 0.1 + character.noise * 0.75 + character.tempo * 0.15, amount);
	genome.pull('trail', 0.85 - character.tempo * 0.55 - character.noise * 0.3, amount);
	genome.pull('glow', 0.75 - character.punch * 0.35 - character.noise * 0.25, amount);
	genome.pull('sheen', 0.35 + (1 - character.noise) * 0.35 + character.valence * 0.2, amount);
	genome.pull('warmth', character.valence * 0.7 + (1 - character.brightness) * 0.2, amount);
	genome.pull('drift', 0.2 + character.motion * 0.4 + character.tempo * 0.3, amount);
}

/**
 * The answer to a change of music for one discrete axis. `leave` (the music
 * really changed): one of the options that fit nearly as well as the best,
 * never the current one. Otherwise keep the current option if it still fits
 * (at least `keep` of the best), else move to a near-best one. `pick01`
 * chooses among the near-best. Unlike a genome shift, a new song in the same
 * genre keeps a world that fits it.
 */
export function mandalaAnswer(
	axis: 'world' | 'palette',
	current: number,
	character: MusicCharacter,
	pick01: number,
	leave = false,
	keep = axis === 'world' ? 0.6 : 0.5
): number {
	const prototypes = axis === 'world' ? MANDALA_WORLDS.map((world) => WORLD_PROTOTYPES[world]) : PALETTE_PROTOTYPES;
	const weights = characterWeights(prototypes, character, axis === 'world' ? 8 : 8.8, 0.02, []);
	if (leave) weights[current] = 0;
	const best = Math.max(...weights);
	if (!leave && (weights[current] ?? 0) >= best * keep) return current;
	const near = weights.flatMap((weight, option) => (weight >= best * 0.7 ? [option] : []));
	return near[Math.min(near.length - 1, Math.floor(pick01 * near.length))] ?? current;
}

/** Two-slot crossfade the renderer can always show (never drops a half-shown option). */
export class MandalaFollower {
	from: number;
	to: number;
	/** Linear progress 0..1. */
	mix = 1;
	private pending: number | null = null;

	constructor(option: number) {
		this.from = option;
		this.to = option;
	}

	update(target: number, tau: number, dt: number): void {
		const goal = Math.round(Number.isFinite(target) ? target : this.to);
		const step = Math.max(0, Number.isFinite(dt) ? dt : 0) / Math.max(0.05, tau);
		if (goal !== this.to) {
			if (this.mix >= 1) {
				this.from = this.to;
				this.to = goal;
				this.mix = 0;
				this.pending = null;
			} else if (goal === this.from) {
				// Back to the option being faded out: reverse in place.
				this.from = this.to;
				this.to = goal;
				this.mix = 1 - this.mix;
				this.pending = null;
			} else {
				this.pending = goal;
			}
		} else {
			this.pending = null;
		}
		// A queued target hurries the running fade.
		if (this.mix < 1) this.mix = Math.min(1, this.mix + step * (this.pending !== null ? 2 : 1));
		if (this.mix >= 1 && this.pending !== null) {
			this.from = this.to;
			this.to = this.pending;
			this.mix = 0;
			this.pending = null;
		}
	}

	/** Smoothstepped blend weight of `to`. */
	get weight(): number {
		const m = Math.min(1, Math.max(0, this.mix));
		return m * m * (3 - 2 * m);
	}
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Scene slot id: world, variant and fold in one integer the follower crossfades. */
export function mandalaSlot(world: number, variant: number, fold: number): number {
	return (world * MANDALA_VARIANTS + variant) * MANDALA_FOLDS.length + fold;
}

export function mandalaSlotParts(slot: number): { world: number; variant: number; fold: number } {
	const fold = slot % MANDALA_FOLDS.length;
	const rest = Math.floor(slot / MANDALA_FOLDS.length);
	return { world: Math.floor(rest / MANDALA_VARIANTS), variant: rest % MANDALA_VARIANTS, fold };
}
