// Mandala's long-listen look: which sacred-geometry grammar the tunnel walls
// and the fretwork screen are carved with, how many mirror sectors fold them,
// the tunnel's cross-section, the palette family, and the continuous
// proportions (density, line weight, relief, spiral, wander). The genome walks
// these at musical boundaries and leaps on a character shift; every discrete
// change reaches the shader as an A -> B crossfade.
//
// Grammars are (family, variant) pairs, 9 families x 4 variants = 36 per
// layer. With 9 fold counts, 5 cross-sections and 12 palettes the discrete
// space alone is ~1.8 million wall/screen/fold/shape/palette combinations
// before any continuous axis moves.

import type { CharacterFeature, MusicCharacter } from '../character';
import { characterWeights } from '../character';
import type { VariationAxis, VariationGenome } from '../variation';

export type Rgb = [number, number, number];

export const MANDALA_FAMILIES = [
	'truchet',
	'flower',
	'yantra',
	'girih',
	'lace',
	'apollonian',
	'hyperbolic',
	'phyllotaxis',
	'rings'
] as const;
export type MandalaFamily = (typeof MANDALA_FAMILIES)[number];
export const MANDALA_VARIANTS = 4;
export const MANDALA_GRAMMARS = MANDALA_FAMILIES.length * MANDALA_VARIANTS;

/** Listener-neutral names per (family, variant), for QA attributes. */
export const MANDALA_VARIANT_NAMES: Record<MandalaFamily, readonly string[]> = {
	truchet: ['arcs', 'weave', 'diagonal', 'nested rings'],
	flower: ['flower of life', 'tangent circles', 'vesica', 'flower lattice'],
	yantra: ['triangle grid', 'hexagram', 'sri yantra', 'metatron'],
	girih: ['eight star', 'six star', 'twelve rosette', 'ten star'],
	lace: ['snowflake', 'coral', 'fern', 'crystal'],
	apollonian: ['gasket', 'pearl', 'foam', 'lattice'],
	hyperbolic: ['{4,5}', '{6,4}', '{8,3}', '{4,6}'],
	phyllotaxis: ['golden seeds', 'pinecone', 'florets', 'parastichy'],
	rings: ['fibonacci', 'primes', 'powers of two', 'triangular']
};

/** Hyperbolic {p,q} per variant (p even: the band translation is exact). */
export const MANDALA_HYPERBOLIC: readonly [number, number][] = [
	[4, 5],
	[6, 4],
	[8, 3],
	[4, 6]
];

/** Mirror sectors the kaleidoscope folds the tunnel into. */
export const MANDALA_FOLDS = [3, 4, 5, 6, 7, 8, 10, 12, 16] as const;
/** Tunnel cross-sections: polygon sides, 0 = round. */
export const MANDALA_SHAPES = [0, 3, 4, 6, 8] as const;
export const MANDALA_SHAPE_NAMES = ['round', 'triangle', 'square', 'hexagon', 'octagon'] as const;

export type MandalaPalette = {
	name: string;
	/** Carved wall albedo: always near black. */
	stone: Rgb;
	/** Inlay metal: what the lights glint off. */
	metal: Rgb;
	/** Inlay emission: where the music lights the carving. */
	glow: Rgb;
	/** Beat rings. */
	accent: Rgb;
	/** Camera-carried rig lights. */
	rig: Rgb;
	/** Sconces along the wall. */
	sconce: Rgb;
	/** What the tunnel air scatters. */
	fog: Rgb;
	/** 0..1 view-angle colour play on the inlay (glow toward accent). */
	iridescence: number;
	/** 0..1 how warm the family reads; character warmth pulls toward it. */
	warmth: number;
};

// Authored stops, never a cosine ramp. Every stone is near black; light only
// comes from inlays, rigs, sconces and beat rings.
export const MANDALA_PALETTES: readonly MandalaPalette[] = [
	{
		name: 'obsidian gold',
		stone: [0.03, 0.026, 0.024],
		metal: [1.0, 0.74, 0.36],
		glow: [1.0, 0.6, 0.22],
		accent: [0.32, 0.84, 0.92],
		rig: [1.0, 0.86, 0.66],
		sconce: [1.0, 0.55, 0.2],
		fog: [0.42, 0.34, 0.26],
		iridescence: 0.1,
		warmth: 0.8
	},
	{
		name: 'lapis',
		stone: [0.016, 0.024, 0.06],
		metal: [0.95, 0.78, 0.42],
		glow: [0.26, 0.46, 1.0],
		accent: [1.0, 0.42, 0.18],
		rig: [0.7, 0.8, 1.0],
		sconce: [1.0, 0.72, 0.36],
		fog: [0.2, 0.27, 0.55],
		iridescence: 0.2,
		warmth: 0.35
	},
	{
		name: 'byzantine',
		stone: [0.05, 0.012, 0.016],
		metal: [1.0, 0.78, 0.38],
		glow: [0.96, 0.2, 0.16],
		accent: [0.26, 0.9, 0.56],
		rig: [1.0, 0.8, 0.6],
		sconce: [1.0, 0.46, 0.24],
		fog: [0.5, 0.2, 0.18],
		iridescence: 0.1,
		warmth: 0.85
	},
	{
		name: 'jade abyss',
		stone: [0.008, 0.03, 0.026],
		metal: [0.55, 0.95, 0.76],
		glow: [0.18, 0.95, 0.68],
		accent: [0.85, 0.95, 1.0],
		rig: [0.62, 1.0, 0.86],
		sconce: [0.3, 0.9, 0.62],
		fog: [0.12, 0.36, 0.32],
		iridescence: 0.3,
		warmth: 0.3
	},
	{
		name: 'ultraviolet',
		stone: [0.018, 0.008, 0.045],
		metal: [0.86, 0.6, 1.0],
		glow: [0.82, 0.18, 1.0],
		accent: [0.2, 0.95, 1.0],
		rig: [0.7, 0.52, 1.0],
		sconce: [1.0, 0.3, 0.7],
		fog: [0.32, 0.16, 0.58],
		iridescence: 0.55,
		warmth: 0.4
	},
	{
		name: 'ember',
		stone: [0.036, 0.016, 0.012],
		metal: [1.0, 0.52, 0.26],
		glow: [1.0, 0.28, 0.06],
		accent: [1.0, 0.86, 0.52],
		rig: [1.0, 0.62, 0.42],
		sconce: [1.0, 0.36, 0.1],
		fog: [0.46, 0.18, 0.08],
		iridescence: 0.05,
		warmth: 1.0
	},
	{
		name: 'moonstone',
		stone: [0.026, 0.03, 0.04],
		metal: [0.85, 0.9, 1.0],
		glow: [0.58, 0.74, 1.0],
		accent: [0.9, 0.7, 1.0],
		rig: [0.76, 0.86, 1.0],
		sconce: [0.62, 0.72, 1.0],
		fog: [0.3, 0.35, 0.46],
		iridescence: 0.4,
		warmth: 0.15
	},
	{
		name: 'verdigris',
		stone: [0.012, 0.03, 0.03],
		metal: [0.96, 0.56, 0.32],
		glow: [0.24, 0.85, 0.74],
		accent: [1.0, 0.6, 0.3],
		rig: [0.92, 0.95, 0.85],
		sconce: [0.42, 0.95, 0.8],
		fog: [0.17, 0.34, 0.32],
		iridescence: 0.25,
		warmth: 0.55
	},
	{
		name: 'rose quartz',
		stone: [0.04, 0.016, 0.03],
		metal: [1.0, 0.7, 0.72],
		glow: [1.0, 0.4, 0.58],
		accent: [1.0, 0.86, 0.56],
		rig: [1.0, 0.8, 0.82],
		sconce: [1.0, 0.56, 0.6],
		fog: [0.46, 0.26, 0.36],
		iridescence: 0.3,
		warmth: 0.7
	},
	{
		name: 'ice',
		stone: [0.016, 0.02, 0.026],
		metal: [0.9, 0.95, 1.0],
		glow: [0.74, 0.9, 1.0],
		accent: [1.0, 1.0, 1.0],
		rig: [0.86, 0.92, 1.0],
		sconce: [0.6, 0.8, 1.0],
		fog: [0.26, 0.31, 0.38],
		iridescence: 0.15,
		warmth: 0.0
	},
	{
		name: 'saffron',
		stone: [0.044, 0.012, 0.016],
		metal: [1.0, 0.7, 0.22],
		glow: [1.0, 0.54, 0.1],
		accent: [0.36, 0.42, 1.0],
		rig: [1.0, 0.86, 0.6],
		sconce: [1.0, 0.6, 0.16],
		fog: [0.46, 0.3, 0.16],
		iridescence: 0.1,
		warmth: 0.95
	},
	{
		name: 'oil slick',
		stone: [0.01, 0.01, 0.016],
		metal: [0.7, 0.76, 0.92],
		glow: [0.28, 0.9, 0.84],
		accent: [1.0, 0.4, 0.8],
		rig: [0.8, 0.86, 1.0],
		sconce: [0.52, 0.42, 1.0],
		fog: [0.18, 0.22, 0.32],
		iridescence: 0.9,
		warmth: 0.35
	}
];

type Prototype = Partial<Record<CharacterFeature, number>>;

/**
 * Which music each grammar family fits. Ambient wants vast soft florals,
 * noise wants fractured fractal lace, club wants pulsing rings and
 * hyperbolic counting, acoustic wants organic seeds and flowers.
 */
const FAMILY_PROTOTYPES: Record<MandalaFamily, Prototype> = {
	truchet: { tempo: 0.5, punch: 0.55, noise: 0.25 },
	flower: { tempo: 0.15, noise: 0.08, energy: 0.3 },
	yantra: { tempo: 0.12, energy: 0.45, brightness: 0.35 },
	girih: { tempo: 0.35, valence: 0.65, noise: 0.15 },
	lace: { tempo: 0.9, noise: 0.75, brightness: 0.75 },
	apollonian: { tempo: 0.8, noise: 0.6, energy: 0.8 },
	hyperbolic: { tempo: 0.58, bass: 0.75, punch: 0.65 },
	phyllotaxis: { tempo: 0.28, noise: 0.05, valence: 0.7 },
	rings: { tempo: 0.6, punch: 0.8, bass: 0.85 }
};

const PALETTE_PROTOTYPES: readonly Prototype[] = [
	{ valence: 0.6, brightness: 0.45, noise: 0.2 },
	{ tempo: 0.1, energy: 0.4, valence: 0.4 },
	{ energy: 0.65, valence: 0.55, tempo: 0.15 },
	{ tempo: 0.6, bass: 0.75, noise: 0.2 },
	{ tempo: 0.58, bass: 0.85, punch: 0.75 },
	{ noise: 0.7, energy: 0.9, tempo: 0.85 },
	{ tempo: 0.03, energy: 0.15, noise: 0.05 },
	{ tempo: 0.3, valence: 0.6, noise: 0.08 },
	{ valence: 0.7, tempo: 0.25, punch: 0.4 },
	{ noise: 0.85, brightness: 0.85, tempo: 0.95 },
	{ valence: 0.8, tempo: 0.28, noise: 0.06 },
	{ tempo: 0.5, brightness: 0.65, bass: 0.6 }
];

const SHAPE_PROTOTYPES: readonly Prototype[] = [
	{ noise: 0.1, tempo: 0.2 },
	{ noise: 0.8, tempo: 0.9 },
	{ punch: 0.75, tempo: 0.6 },
	{ tempo: 0.35, valence: 0.6 },
	{ tempo: 0.55, bass: 0.6 }
];

const FOLD_PROTOTYPES: readonly Prototype[] = MANDALA_FOLDS.map((fold) => {
	// Few sectors read harsh and fractured, many read hypnotic and ornate.
	const t = (fold - 3) / 13;
	return { noise: 0.8 - t * 0.7, tempo: 0.85 - t * 0.4, punch: 0.3 + t * 0.5 };
});

export const MANDALA_AXES: readonly VariationAxis[] = [
	// Discrete. Grammar slots cross-fade on the GPU (two evaluations at once),
	// so they move at section scale and stay a while.
	{ kind: 'choice', name: 'wall', options: MANDALA_GRAMMARS, scale: 'section', chance: 0.8, memory: 6, maxHold: 3, tau: 8 },
	{ kind: 'choice', name: 'screen', options: MANDALA_GRAMMARS, scale: 'section', chance: 0.55, memory: 6, maxHold: 4, tau: 7 },
	{ kind: 'choice', name: 'fold', options: MANDALA_FOLDS.length, scale: 'phrase', chance: 0.28, memory: 3, maxHold: 8, tau: 6 },
	{ kind: 'choice', name: 'shape', options: MANDALA_SHAPES.length, scale: 'section', chance: 0.4, memory: 2, maxHold: 5, tau: 4 },
	{ kind: 'choice', name: 'palette', options: MANDALA_PALETTES.length, scale: 'era', chance: 0.9, memory: 5, maxHold: 2, tau: 6 },
	// Continuous proportions.
	{ kind: 'continuous', name: 'density', min: 0.7, max: 2.6, scale: 'phrase', step: 0.28, chance: 0.6, tau: 12 },
	{ kind: 'continuous', name: 'lineWidth', min: 0.012, max: 0.05, scale: 'phrase', step: 0.35, chance: 0.6, tau: 9 },
	{ kind: 'continuous', name: 'relief', min: 0.25, max: 1.5, scale: 'section', step: 0.4, tau: 6 },
	{ kind: 'continuous', name: 'morph', min: 0, max: 1, scale: 'phrase', step: 0.3, chance: 0.7, tau: 9 },
	{ kind: 'continuous', name: 'spin', min: -0.75, max: 0.75, scale: 'section', step: 0.4, tau: 9 },
	{ kind: 'continuous', name: 'corkscrew', min: -0.5, max: 0.5, scale: 'section', step: 0.45, tau: 8 },
	{ kind: 'continuous', name: 'wander', min: 0.08, max: 0.42, scale: 'section', step: 0.4, tau: 9 },
	{ kind: 'continuous', name: 'offset', min: 0, max: 0.26, scale: 'section', step: 0.4, tau: 9 },
	{ kind: 'continuous', name: 'screenAmount', min: 0, max: 1, scale: 'section', step: 0.5, chance: 0.7, tau: 6 },
	{ kind: 'continuous', name: 'screenRadius', min: 0.48, max: 0.8, scale: 'phrase', step: 0.3, chance: 0.5, tau: 7 },
	{ kind: 'continuous', name: 'screenDensity', min: 0.45, max: 1.6, scale: 'phrase', step: 0.35, chance: 0.5, tau: 7 },
	{ kind: 'continuous', name: 'rigTurn', min: 0, max: 1, scale: 'phrase', step: 0.3, wrap: true, tau: 8 },
	{ kind: 'continuous', name: 'sconces', min: 0, max: 1, scale: 'section', step: 0.45, tau: 6 },
	{ kind: 'continuous', name: 'fog', min: 0.04, max: 0.2, scale: 'section', step: 0.4, tau: 7 },
	{ kind: 'continuous', name: 'trail', min: 0, max: 1, scale: 'section', step: 0.45, tau: 6 },
	{ kind: 'continuous', name: 'shapeTurn', min: 0, max: 1, scale: 'section', step: 0.3, wrap: true, tau: 8 },
	{ kind: 'continuous', name: 'warmth', min: 0, max: 1, scale: 'era', step: 0.35, tau: 10 }
];

const scratch: number[] = [];

/** Per-option weights for the grammar axes: family prototype, shared by variants. */
function grammarWeights(character: MusicCharacter, sharpness: number): number[] {
	const families = MANDALA_FAMILIES.map((family) => FAMILY_PROTOTYPES[family]);
	const perFamily = characterWeights(families, character, sharpness, 0.03, scratch.slice());
	const out: number[] = [];
	for (let family = 0; family < MANDALA_FAMILIES.length; family += 1) {
		for (let variant = 0; variant < MANDALA_VARIANTS; variant += 1) out.push(perFamily[family]);
	}
	return out;
}

/**
 * Bias every discrete axis toward options that fit the playing music, so a
 * shift (and every later boundary) picks a grammar, palette, fold and
 * cross-section that belong to the new genre.
 */
export function mandalaApplyCharacter(
	genome: VariationGenome,
	character: MusicCharacter,
	sharpness = 4
): void {
	const grammar = grammarWeights(character, sharpness);
	genome.setWeights('wall', grammar);
	genome.setWeights('screen', grammar);
	genome.setWeights('palette', characterWeights(PALETTE_PROTOTYPES, character, sharpness * 1.1, 0.02, []));
	genome.setWeights('shape', characterWeights(SHAPE_PROTOTYPES, character, sharpness * 0.8, 0.1, []));
	genome.setWeights('fold', characterWeights(FOLD_PROTOTYPES, character, sharpness * 0.8, 0.12, []));
}

/** How well a palette fits the music, relative to the best fitting one (0..1). */
export function mandalaPaletteFit(palette: number, character: MusicCharacter, sharpness = 8): number {
	const weights = characterWeights(PALETTE_PROTOTYPES, character, sharpness * 1.1, 0.02, []);
	const best = Math.max(...weights);
	return best > 0 ? (weights[palette] ?? 0) / best : 1;
}

/**
 * Steer the continuous axes that the music's character should own: ambient
 * is vast (sparse cells, wide soft lines), noise is fine and fractured,
 * bass weighs the relief, valence warms the palette lean.
 */
export function mandalaPullCharacter(
	genome: VariationGenome,
	character: MusicCharacter,
	amount: number
): void {
	const fine = Math.min(1, character.tempo * 0.55 + character.noise * 0.55);
	genome.pull('density', 0.08 + fine * 0.85, amount);
	genome.pull('lineWidth', 0.85 - character.noise * 0.6 - character.punch * 0.25, amount);
	genome.pull('relief', 0.25 + character.bass * 0.6, amount);
	genome.pull('trail', 0.85 - character.tempo * 0.6 - character.noise * 0.3, amount);
	genome.pull('fog', 0.65 - character.energy * 0.45 + (1 - character.tempo) * 0.2, amount);
	genome.pull('warmth', character.valence * 0.7 + (1 - character.brightness) * 0.2, amount);
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

/**
 * Gauss-reduced lattice basis for logarithmic phyllotaxis (cell units). The
 * lattice is generated by one seed step g1 = (cellsAround * divergence, rise)
 * and one full turn g2 = (cellsAround, 0); `n1`/`n2` give each reduced
 * vector's seed-index count, so a seed's index along the spiral is
 * u * n1 + v * n2 for lattice coordinates (u, v).
 */
export function phyllotaxisBasis(
	cellsAround: number,
	divergence: number,
	rise: number
): { e1: [number, number]; e2: [number, number]; n1: number; n2: number } {
	type V = { x: number; y: number; n: number };
	let a: V = { x: cellsAround * divergence, y: rise, n: 1 };
	let b: V = { x: cellsAround, y: 0, n: 0 };
	const dot = (u: V, v: V) => u.x * v.x + u.y * v.y;
	for (let guard = 0; guard < 64; guard += 1) {
		if (dot(a, a) > dot(b, b)) [a, b] = [b, a];
		const k = Math.round(dot(a, b) / Math.max(1e-12, dot(a, a)));
		if (k === 0) break;
		b = { x: b.x - k * a.x, y: b.y - k * a.y, n: b.n - k * a.n };
	}
	return { e1: [a.x, a.y], e2: [b.x, b.y], n1: a.n, n2: b.n };
}

/** The golden angle as a fraction of a turn: every phyllotaxis variant shares it. */
export const MANDALA_DIVERGENCE = 0.381966011;
/** Phyllotaxis and counting rings ignore the fold; they count round the whole circle. */
export const MANDALA_RAW_SECTORS = 8;
