// Prism's authored look space. The audio stays in charge of reaction (beats,
// envelopes, spectrum); this module is in charge of variety. Every visual
// identity decision (window grammar, fold, mosaic cut, palette family, camera,
// environment, light behind the glass, how beats travel) is an axis of the
// shared variation genome, so the window keeps turning into new windows over
// an hours-long stream while staying the same obsidian rose.
//
// Pure functions only: the renderer stays deterministic and the choices are
// testable without WebGPU.

import type { CharacterFeature } from '../character';
import type { ChoiceState, VariationAxis, VariationGenome } from '../variation';

export type PrismFamily = 'quiet' | 'verse' | 'rise' | 'peak' | 'drift';

export function prismFamily(section: string): PrismFamily {
	switch (section) {
		case 'verse':
			return 'verse';
		case 'pre_chorus':
		case 'build':
			return 'rise';
		case 'drop':
		case 'chorus':
			return 'peak';
		case 'bridge':
		case 'breakdown':
			return 'drift';
		default:
			return 'quiet';
	}
}

/**
 * What each section family earns regardless of the look: how much backlight,
 * how much of the outer tier is lit, how fine the mosaic is cut, how much air.
 * This is the section reactivity and stays independent of the genome.
 */
export const PRISM_FAMILY_DRIVE: Record<
	PrismFamily,
	{ light: number; air: number; outerLit: number; cells: number; packet: number }
> = {
	quiet: { light: 0.54, air: 0.7, outerLit: 0.16, cells: 14, packet: 0.85 },
	verse: { light: 0.7, air: 0.85, outerLit: 0.4, cells: 19, packet: 1 },
	rise: { light: 0.8, air: 1, outerLit: 0.64, cells: 22, packet: 1.05 },
	peak: { light: 0.98, air: 1.2, outerLit: 1, cells: 26, packet: 1.15 },
	drift: { light: 0.62, air: 1.05, outerLit: 0.28, cells: 16, packet: 0.9 }
};

// ── Window grammars ────────────────────────────────────────────────────────
// Each is its own generator in the rose shader (branching on one uniform).
export const PRISM_GRAMMARS = [
	'gothic', // pointed-vesica petals, roundels, spandrel eyes
	'rayonnant', // many radiating lancets with trefoil heads, two tiers
	'flamboyant', // curved mouchette daggers in flame pairs, soufflets
	'romanesque', // spoked wheel of round-arched panels, oculi ring
	'girih', // Islamic star lattice of strapwork, central star
	'nouveau', // art-nouveau whiplash stems and flower heads, round arch
	'deco', // art-deco sunburst and stepped bands, ziggurat top
	'modern' // abstract colour fields and cut-out leaves (Chagall/Matisse)
] as const;
export type PrismGrammar = (typeof PRISM_GRAMMARS)[number];

/** Grammars 0..4 are radial roses; 5..7 are tall windows with their own outline. */
export function prismGrammarIsRadial(grammar: number): boolean {
	return grammar < 4.5;
}

/** Fold options per grammar (radial symmetry, or stems / rays / fields for tall windows). */
const FOLDS: readonly (readonly number[])[] = [
	[5, 6, 7, 8, 9, 10, 12, 14],
	[10, 12, 14, 16, 18, 20, 24, 12],
	[4, 5, 6, 7, 8, 5, 6, 4],
	[8, 9, 10, 12, 14, 16, 10, 12],
	[5, 6, 8, 10, 12, 8, 6, 10],
	[2, 3, 3, 4, 2, 3, 4, 3],
	[5, 6, 7, 8, 9, 10, 11, 12],
	[3, 4, 5, 6, 3, 4, 5, 6]
];

export function prismFold(grammar: number, option: number): number {
	const table = FOLDS[Math.max(0, Math.min(FOLDS.length - 1, Math.round(grammar)))];
	return table[((Math.round(option) % table.length) + table.length) % table.length];
}

export const PRISM_MOSAICS = ['organic', 'quarry', 'segments', 'slivers', 'slabs'] as const;
export const PRISM_BEAT_FORMS = ['rings', 'wheel', 'pairs', 'spiral', 'cascade', 'lightning'] as const;
export const PRISM_ENVIRONMENTS = ['nave', 'crypt', 'ruin', 'apse', 'void'] as const;
export const PRISM_CAMERAS = [
	'orbit', // a slow orbit around the window, square-on at the start of its path
	'arcade', // from one side, the window at an angle and its neighbours receding
	'crane', // from the floor looking up into the window to above it looking down
	'glass', // a close pass over the glass: the facets and tracery become the picture
	'gallery', // a lateral dolly along a wall of windows
	'flooded', // low over a flooded floor that mirrors the window
	'nave', // from the far end of the nave, pushing in through the arcade
	'dutch' // a mid-distance arc with the horizon rolled off level
] as const;

export type Rgb = [number, number, number];

// ── Palette families ───────────────────────────────────────────────────────
// Linear-light glass: hero, support, accent, field. Deep and saturated, never
// bright enough to bleach on its own. Curated, never a cosine ramp.
export const PRISM_PALETTES: readonly { name: string; colors: readonly [Rgb, Rgb, Rgb, Rgb] }[] = [
	{ name: 'jewel', colors: [[0.54, 0.02, 0.014], [0.0, 0.27, 0.3], [0.74, 0.3, 0.02], [0.01, 0.04, 0.25]] },
	{ name: 'chartres', colors: [[0.02, 0.08, 0.6], [0.55, 0.01, 0.03], [0.7, 0.36, 0.03], [0.01, 0.03, 0.22]] },
	{ name: 'ember', colors: [[0.62, 0.12, 0.01], [0.3, 0.03, 0.005], [0.74, 0.42, 0.06], [0.08, 0.02, 0.01]] },
	{ name: 'ice', colors: [[0.12, 0.36, 0.6], [0.04, 0.12, 0.42], [0.42, 0.5, 0.62], [0.01, 0.03, 0.12]] },
	{ name: 'verdigris', colors: [[0.04, 0.36, 0.24], [0.0, 0.2, 0.22], [0.6, 0.24, 0.05], [0.01, 0.06, 0.05]] },
	{ name: 'oxblood', colors: [[0.36, 0.01, 0.02], [0.18, 0.02, 0.1], [0.62, 0.38, 0.1], [0.06, 0.0, 0.02]] },
	{ name: 'nocturne', colors: [[0.03, 0.06, 0.5], [0.1, 0.03, 0.36], [0.4, 0.46, 0.6], [0.0, 0.01, 0.12]] },
	{ name: 'absinthe', colors: [[0.3, 0.56, 0.04], [0.05, 0.3, 0.1], [0.36, 0.06, 0.48], [0.02, 0.06, 0.01]] },
	{ name: 'rose-gold', colors: [[0.62, 0.2, 0.18], [0.36, 0.08, 0.2], [0.74, 0.46, 0.22], [0.08, 0.02, 0.05]] },
	{ name: 'bruise', colors: [[0.3, 0.04, 0.5], [0.4, 0.48, 0.04], [0.12, 0.02, 0.26], [0.03, 0.01, 0.07]] },
	{ name: 'tobacco', colors: [[0.5, 0.22, 0.04], [0.22, 0.1, 0.03], [0.62, 0.48, 0.14], [0.05, 0.025, 0.01]] },
	{ name: 'byzantine', colors: [[0.32, 0.02, 0.44], [0.02, 0.32, 0.12], [0.74, 0.46, 0.04], [0.04, 0.0, 0.08]] },
	{ name: 'peacock', colors: [[0.0, 0.34, 0.4], [0.03, 0.1, 0.55], [0.1, 0.5, 0.1], [0.0, 0.04, 0.08]] },
	{ name: 'favrile', colors: [[0.66, 0.4, 0.06], [0.16, 0.42, 0.2], [0.38, 0.22, 0.5], [0.04, 0.06, 0.04]] },
	{ name: 'chagall', colors: [[0.02, 0.1, 0.62], [0.01, 0.04, 0.3], [0.62, 0.04, 0.03], [0.01, 0.02, 0.18]] },
	{ name: 'matisse', colors: [[0.72, 0.6, 0.02], [0.02, 0.12, 0.6], [0.06, 0.42, 0.08], [0.3, 0.02, 0.2]] },
	{ name: 'iznik', colors: [[0.0, 0.38, 0.42], [0.03, 0.08, 0.52], [0.6, 0.05, 0.03], [0.01, 0.05, 0.1]] },
	{ name: 'sodium', colors: [[0.74, 0.3, 0.0], [0.42, 0.12, 0.0], [0.6, 0.5, 0.1], [0.06, 0.02, 0.0]] },
	{ name: 'grisaille', colors: [[0.3, 0.3, 0.28], [0.16, 0.17, 0.2], [0.62, 0.38, 0.08], [0.04, 0.04, 0.05]] },
	{ name: 'forest', colors: [[0.1, 0.34, 0.04], [0.02, 0.16, 0.06], [0.6, 0.34, 0.04], [0.02, 0.04, 0.01]] },
	{ name: 'abyss', colors: [[0.0, 0.2, 0.36], [0.0, 0.06, 0.24], [0.12, 0.5, 0.42], [0.0, 0.02, 0.06]] },
	{ name: 'venom', colors: [[0.34, 0.62, 0.0], [0.16, 0.0, 0.24], [0.62, 0.02, 0.36], [0.02, 0.03, 0.0]] },
	{ name: 'sakura-night', colors: [[0.66, 0.16, 0.3], [0.2, 0.04, 0.32], [0.7, 0.52, 0.24], [0.02, 0.01, 0.1]] },
	{ name: 'cinnabar', colors: [[0.7, 0.08, 0.01], [0.02, 0.3, 0.18], [0.72, 0.44, 0.04], [0.04, 0.01, 0.0]] },
	{ name: 'storm', colors: [[0.12, 0.16, 0.32], [0.22, 0.14, 0.3], [0.56, 0.52, 0.1], [0.02, 0.025, 0.05]] },
	{ name: 'saffron', colors: [[0.74, 0.4, 0.0], [0.5, 0.02, 0.04], [0.74, 0.62, 0.12], [0.1, 0.01, 0.01]] },
	{ name: 'aurora', colors: [[0.04, 0.56, 0.24], [0.24, 0.04, 0.5], [0.0, 0.3, 0.48], [0.01, 0.04, 0.06]] },
	{ name: 'blood-moon', colors: [[0.6, 0.02, 0.0], [0.24, 0.0, 0.0], [0.74, 0.3, 0.06], [0.04, 0.0, 0.0]] },
	{ name: 'lapis', colors: [[0.03, 0.06, 0.52], [0.06, 0.14, 0.42], [0.74, 0.5, 0.06], [0.0, 0.01, 0.12]] },
	{ name: 'geode', colors: [[0.36, 0.06, 0.6], [0.16, 0.02, 0.36], [0.6, 0.36, 0.62], [0.04, 0.0, 0.08]] },
	{ name: 'desert', colors: [[0.56, 0.16, 0.04], [0.0, 0.32, 0.34], [0.72, 0.5, 0.18], [0.06, 0.02, 0.01]] },
	{ name: 'emerald', colors: [[0.02, 0.4, 0.12], [0.0, 0.18, 0.1], [0.56, 0.02, 0.04], [0.0, 0.04, 0.02]] },
	{ name: 'carnival', colors: [[0.6, 0.0, 0.3], [0.0, 0.3, 0.42], [0.66, 0.5, 0.0], [0.03, 0.0, 0.06]] },
	{ name: 'copper', colors: [[0.62, 0.2, 0.06], [0.0, 0.24, 0.2], [0.42, 0.12, 0.02], [0.05, 0.02, 0.01]] },
	{ name: 'opal', colors: [[0.3, 0.42, 0.5], [0.42, 0.24, 0.42], [0.6, 0.48, 0.3], [0.03, 0.04, 0.07]] },
	{ name: 'reef', colors: [[0.7, 0.2, 0.1], [0.0, 0.32, 0.36], [0.7, 0.5, 0.06], [0.0, 0.04, 0.06]] }
];

/** Which family colour plays hero, support and accent. Field stays the field. */
const ROLE_PERMUTATIONS: readonly [number, number, number][] = [
	[0, 1, 2],
	[1, 0, 2],
	[0, 2, 1],
	[2, 0, 1],
	[1, 2, 0],
	[2, 1, 0]
];

// ── Genome ─────────────────────────────────────────────────────────────────
export const PRISM_AXES: readonly VariationAxis[] = [
	// Era: a new reel. Palette family, the building, the hour, the weather.
	{ kind: 'choice', name: 'palette', options: PRISM_PALETTES.length, scale: 'era', chance: 1, memory: 12, tau: 9 },
	{ kind: 'choice', name: 'environment', options: PRISM_ENVIRONMENTS.length, scale: 'era', chance: 0.85, memory: 3, tau: 8 },
	{ kind: 'continuous', name: 'timeOfDay', min: 0, max: 1, wrap: true, scale: 'era', step: 0.3, tau: 14 },
	{ kind: 'continuous', name: 'rain', min: 0, max: 1, scale: 'era', step: 0.55, chance: 0.6, tau: 10 },
	{ kind: 'continuous', name: 'wetness', min: 0, max: 1, scale: 'era', step: 0.45, tau: 10 },
	{ kind: 'continuous', name: 'caustics', min: 0, max: 1, scale: 'era', step: 0.5, tau: 10 },
	// Section: a new scene in the same film. Window, cut, camera, beat form.
	{ kind: 'choice', name: 'grammar', options: PRISM_GRAMMARS.length, scale: 'section', chance: 0.8, memory: 5, tau: 3 },
	{ kind: 'choice', name: 'fold', options: 8, scale: 'section', chance: 0.85, memory: 2, tau: 3 },
	{ kind: 'choice', name: 'camera', options: PRISM_CAMERAS.length, scale: 'section', chance: 0.72, memory: 5, tau: 11 },
	{ kind: 'choice', name: 'beatForm', options: PRISM_BEAT_FORMS.length, scale: 'section', chance: 0.75, memory: 2, tau: 2.5 },
	{ kind: 'choice', name: 'mosaic', options: PRISM_MOSAICS.length, scale: 'section', chance: 0.6, memory: 2, tau: 3 },
	{ kind: 'choice', name: 'roles', options: ROLE_PERMUTATIONS.length, scale: 'section', chance: 0.55, memory: 2, tau: 5 },
	// A guest family lends the section its support and accent glass.
	{ kind: 'choice', name: 'guest', options: PRISM_PALETTES.length, scale: 'section', chance: 0.75, memory: 6, tau: 6 },
	{ kind: 'continuous', name: 'guestMix', min: 0, max: 1, scale: 'section', step: 0.45, tau: 6 },
	{ kind: 'continuous', name: 'tiers', min: 0, max: 1, scale: 'section', step: 0.4, tau: 3 },
	{ kind: 'continuous', name: 'cusp', min: 0, max: 1, scale: 'section', step: 0.35, tau: 4 },
	{ kind: 'continuous', name: 'outline', min: 0, max: 1, scale: 'section', step: 0.5, tau: 3 },
	{ kind: 'continuous', name: 'baySpacing', min: 0, max: 1, scale: 'section', step: 0.35, tau: 6 },
	{ kind: 'continuous', name: 'fog', min: 0, max: 1, scale: 'section', step: 0.3, tau: 6 },
	{ kind: 'continuous', name: 'sideShaft', min: 0, max: 1, scale: 'section', step: 0.45, tau: 6 },
	{ kind: 'continuous', name: 'shaftAngle', min: -1, max: 1, scale: 'section', step: 0.4, tau: 8 },
	{ kind: 'continuous', name: 'camSide', min: -1, max: 1, scale: 'section', step: 0.6, tau: 8 },
	{ kind: 'continuous', name: 'camFocus', min: 0, max: 1, wrap: true, scale: 'section', step: 0.33, tau: 8 },
	// Phrase: the window breathes. Proportions, light, tint, dust, camera drift.
	{ kind: 'continuous', name: 'petalWidth', min: 0, max: 1, scale: 'phrase', step: 0.2, tau: 3 },
	{ kind: 'continuous', name: 'petalReach', min: 0, max: 1, scale: 'phrase', step: 0.18, tau: 3 },
	{ kind: 'continuous', name: 'cellScale', min: 0, max: 1, scale: 'phrase', step: 0.22, tau: 3 },
	{ kind: 'continuous', name: 'tracery', min: 0, max: 1, scale: 'phrase', step: 0.22, tau: 3 },
	{ kind: 'continuous', name: 'sprinkle', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 3 },
	{ kind: 'continuous', name: 'tint', min: -1, max: 1, scale: 'phrase', step: 0.18, tau: 5 },
	{ kind: 'continuous', name: 'sunAngle', min: 0, max: 1, wrap: true, scale: 'phrase', step: 0.25, tau: 7 },
	{ kind: 'continuous', name: 'sunCount', min: 0, max: 1, scale: 'phrase', step: 0.35, chance: 0.4, tau: 6 },
	{ kind: 'continuous', name: 'dust', min: 0, max: 1, scale: 'phrase', step: 0.3, tau: 5 },
	{ kind: 'continuous', name: 'camDrift', min: -1, max: 1, scale: 'phrase', step: 0.3, tau: 9 }
];

const AXIS_INDEX = new Map(PRISM_AXES.map((axis, index) => [axis.name, index]));

/** A continuous axis' target (where it is gliding to), in its own units. */
function target(genome: VariationGenome, vector: readonly number[], name: string): number {
	const index = AXIS_INDEX.get(name);
	const axis = index === undefined ? undefined : PRISM_AXES[index];
	if (!axis || axis.kind !== 'continuous') return genome.value(name);
	return axis.min + vector[index!] * (axis.max - axis.min);
}

// ── Structure: what a morph carries (see continuity.ts) ────────────────────
export type PrismStructure = {
	grammar: number;
	fold: number;
	mosaic: number;
	/** Mosaic cells per window radius (section drive x genome). */
	cellScale: number;
	/** Quantized so that a change is a deliberate morph, not a drift. */
	tiers: number;
	outline: number;
};

export function prismStructureKey(s: PrismStructure): string {
	return `${s.grammar}:${s.fold}:${s.mosaic}:${s.tiers}:${s.outline}`;
}

/**
 * The structural composition the genome is heading for. Read from targets so
 * a morph launched on a boundary carries the new window, not the old one.
 */
export function prismStructure(genome: VariationGenome, family: PrismFamily): PrismStructure {
	const vector = genome.targetVector();
	const grammar = genome.choice('grammar').to;
	const cellAxis = target(genome, vector, 'cellScale');
	const drive = PRISM_FAMILY_DRIVE[family];
	// Modern fields and slab mosaics cut much larger pieces.
	const mosaic = genome.choice('mosaic').to;
	const coarse = grammar === 7 ? 0.5 : 1;
	return {
		grammar,
		fold: prismFold(grammar, genome.choice('fold').to),
		mosaic,
		cellScale: Math.round(drive.cells * (0.72 + cellAxis * 0.56) * coarse),
		tiers: Math.round(target(genome, vector, 'tiers') * 2) / 2,
		outline: target(genome, vector, 'outline') < 0.5 ? 0 : 1
	};
}

/** Proportions that glide live inside the current structure. */
export type PrismLive = {
	petalWidth: number;
	petalReach: number;
	tracery: number;
	cusp: number;
	sprinkle: number;
};

export function prismLive(genome: VariationGenome): PrismLive {
	return {
		petalWidth: 0.5 + genome.value('petalWidth') * 0.44,
		petalReach: 0.54 + genome.value('petalReach') * 0.22,
		tracery: genome.value('tracery'),
		cusp: genome.value('cusp'),
		sprinkle: genome.value('sprinkle')
	};
}

// ── Palette ────────────────────────────────────────────────────────────────
export type PrismPaletteRoles = {
	family: number;
	hero: Rgb;
	support: Rgb;
	accent: Rgb;
	field: Rgb;
};

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Rotate a colour around the grey axis (a hue lean that keeps luminance). */
export function rotateHue(c: Rgb, angle: number): Rgb {
	const cs = Math.cos(angle);
	const sn = Math.sin(angle) / Math.sqrt(3);
	const grey = ((1 - cs) / 3) * (c[0] + c[1] + c[2]);
	return [
		Math.max(0, cs * c[0] + grey + sn * (c[2] - c[1])),
		Math.max(0, cs * c[1] + grey + sn * (c[0] - c[2])),
		Math.max(0, cs * c[2] + grey + sn * (c[1] - c[0]))
	];
}

function familyRoles(family: number, roles: number): [Rgb, Rgb, Rgb, Rgb] {
	const colors = PRISM_PALETTES[((family % PRISM_PALETTES.length) + PRISM_PALETTES.length) % PRISM_PALETTES.length].colors;
	const perm = ROLE_PERMUTATIONS[((roles % ROLE_PERMUTATIONS.length) + ROLE_PERMUTATIONS.length) % ROLE_PERMUTATIONS.length];
	return [colors[perm[0]], colors[perm[1]], colors[perm[2]], colors[3]];
}

function blendRoles(family: ChoiceState, roles: ChoiceState): [Rgb, Rgb, Rgb, Rgb] {
	const at = (f: number, r: ChoiceState) => {
		const a = familyRoles(f, r.from);
		const b = familyRoles(f, r.to);
		return a.map((c, i) => lerpRgb(c, b[i], r.mix)) as [Rgb, Rgb, Rgb, Rgb];
	};
	const from = at(family.from, roles);
	const to = at(family.to, roles);
	return from.map((c, i) => lerpRgb(c, to[i], family.mix)) as [Rgb, Rgb, Rgb, Rgb];
}

export type PrismHarmony = {
	keyPitchClass: number;
	keyMinor: boolean;
	keyConfidence: number;
	energy: number;
};

/**
 * Palette roles: the genome picks the family (era) and who plays hero
 * (section); harmony leans the hue by key, minor keys cool the accent and sink
 * the field, energy lifts the accent. Everything blends through crossfades.
 */
/** Lift a too-dim family colour to a floor of peak channel, keeping its hue. */
function floorPeak(c: Rgb, floor: number): Rgb {
	const peak = Math.max(c[0], c[1], c[2], 1e-4);
	const k = Math.min(1.7, Math.max(1, floor / peak));
	return [c[0] * k, c[1] * k, c[2] * k];
}

export function prismPalette(
	family: ChoiceState,
	roles: ChoiceState,
	tint: number,
	harmony: PrismHarmony,
	guest: ChoiceState = family,
	guestMix = 0
): PrismPaletteRoles {
	const own = blendRoles(family, roles);
	const visiting = blendRoles(guest, roles);
	const g = Math.min(1, Math.max(0, Number.isFinite(guestMix) ? guestMix : 0));
	const hero0 = floorPeak(own[0], 0.5);
	const support0 = floorPeak(lerpRgb(own[1], visiting[1], g * 0.85), 0.3);
	const accent0 = floorPeak(lerpRgb(own[2], visiting[2], g), 0.45);
	const field0 = lerpRgb(own[3], visiting[3], g * 0.5);
	const confidence = Number.isFinite(harmony.keyConfidence) ? Math.min(1, Math.max(0, harmony.keyConfidence)) : 0;
	const pitch = Number.isFinite(harmony.keyPitchClass) ? harmony.keyPitchClass : 0;
	const fifths = (((Math.round(pitch * 12) * 7) % 12) + 12) % 12;
	const keyLean = confidence >= 0.2 ? (fifths / 11 - 0.5) * 0.2 * confidence : 0;
	const angle = (Number.isFinite(tint) ? tint : 0) * 0.24 + keyLean;
	const energy = Number.isFinite(harmony.energy) ? Math.min(1, Math.max(0, harmony.energy)) : 0;
	let accent = rotateHue(accent0, angle);
	let field = rotateHue(field0, angle * 0.6);
	const support = rotateHue(support0, angle);
	if (harmony.keyMinor) {
		accent = lerpRgb(accent, support, 0.25);
		field = field.map((v) => v * 0.78) as Rgb;
	}
	const lift = 0.9 + energy * 0.22;
	accent = accent.map((v) => Math.min(0.78, v * lift)) as Rgb;
	const cap = (c: Rgb) => c.map((v) => Math.min(0.78, Math.max(0, v))) as Rgb;
	return {
		family: family.mix >= 0.5 ? family.to : family.from,
		hero: cap(rotateHue(hero0, angle)),
		support: cap(support),
		accent: cap(accent),
		field: cap(field)
	};
}

// ── Light behind the glass ────────────────────────────────────────────────
// Picked stops around the day, not a cosine: dawn rose, morning, noon, golden
// hour, dusk violet, moonlight. Intensity and "night" ride along.
const DAY_STOPS: readonly { at: number; color: Rgb; power: number; night: number }[] = [
	{ at: 0, color: [1.0, 0.7, 0.66], power: 0.92, night: 0.3 },
	{ at: 1 / 6, color: [1.0, 0.9, 0.74], power: 1.0, night: 0 },
	{ at: 2 / 6, color: [1.0, 0.98, 0.92], power: 1.06, night: 0 },
	{ at: 3 / 6, color: [1.0, 0.72, 0.42], power: 1.0, night: 0.1 },
	{ at: 4 / 6, color: [0.86, 0.6, 0.92], power: 0.88, night: 0.55 },
	{ at: 5 / 6, color: [0.6, 0.74, 1.0], power: 0.76, night: 1 }
];

export function prismDaylight(timeOfDay: number): { color: Rgb; power: number; night: number } {
	const t = ((Number.isFinite(timeOfDay) ? timeOfDay : 0) % 1 + 1) % 1;
	const scaled = t * DAY_STOPS.length;
	const i = Math.floor(scaled) % DAY_STOPS.length;
	const j = (i + 1) % DAY_STOPS.length;
	const f = scaled - Math.floor(scaled);
	const s = f * f * (3 - 2 * f);
	const a = DAY_STOPS[i];
	const b = DAY_STOPS[j];
	const color = lerpRgb(a.color, b.color, s).map((v) => lerp(1, v, 0.55)) as Rgb;
	// Night glass is cooler, not much darker: the window stays the light source.
	return { color, power: 0.9 + (lerp(a.power, b.power, s) - 0.76) * 0.5, night: lerp(a.night, b.night, s) };
}

// ── Camera ─────────────────────────────────────────────────────────────────
export type PrismCameraParams = {
	yaw: number;
	pitch: number;
	roll: number;
	/** Distance from the look-at point; 1.8 frames the window as the original. */
	dist: number;
	tx: number;
	ty: number;
	/** How many neighbouring bays are lit (0 = only the hero window). */
	bays: number;
	/** Floor wetness the regime asks for. */
	wet: number;
};

export const PRISM_FOCAL = 1.8;
export const PRISM_ROSE_Y = 0.07;
export const PRISM_ROSE_R = 0.32;
export const PRISM_FLOOR_Y = -0.29;

/** A smooth side sign: -1..1 that swings through 0 instead of flipping. */
export function prismSoftSign(side: number, width = 0.3): number {
	const t = Math.min(1, Math.max(-1, (Number.isFinite(side) ? side : 0) / width));
	return t * (1.5 - 0.5 * t * t);
}

export type Vec3 = [number, number, number];
export type PrismCameraBasis = { pos: Vec3; right: Vec3; up: Vec3; fwd: Vec3; focal: number };

/**
 * World: x right, y up, the window wall is the plane z = 0 and the nave is
 * z < 0. The camera looks at (tx, ty, 0) from `dist` away; with no rotation a
 * screen point p (height units) lands on the wall at (tx, ty) + p.
 */
export function prismCameraBasis(c: PrismCameraParams): PrismCameraBasis {
	const cp = Math.cos(c.pitch);
	const fwd: Vec3 = [Math.sin(c.yaw) * cp, Math.sin(c.pitch), Math.cos(c.yaw) * cp];
	const rl = Math.hypot(fwd[2], fwd[0]) || 1;
	const right0: Vec3 = [fwd[2] / rl, 0, -fwd[0] / rl];
	const up0: Vec3 = [
		fwd[1] * right0[2] - fwd[2] * right0[1],
		fwd[2] * right0[0] - fwd[0] * right0[2],
		fwd[0] * right0[1] - fwd[1] * right0[0]
	];
	const cr = Math.cos(c.roll);
	const sr = Math.sin(c.roll);
	const right: Vec3 = [0, 1, 2].map((i) => right0[i] * cr + up0[i] * sr) as Vec3;
	const up: Vec3 = [0, 1, 2].map((i) => up0[i] * cr - right0[i] * sr) as Vec3;
	const pos: Vec3 = [c.tx - fwd[0] * c.dist, c.ty - fwd[1] * c.dist, -fwd[2] * c.dist];
	// Never sink through the floor or into the wall while blending regimes.
	pos[1] = Math.max(PRISM_FLOOR_Y + 0.05, pos[1]);
	pos[2] = Math.min(-0.2, pos[2]);
	return { pos, right, up, fwd, focal: PRISM_FOCAL };
}

/** Project a world point to screen height units (y up), or null behind the camera. */
export function prismProject(b: PrismCameraBasis, point: Vec3): [number, number] | null {
	const d: Vec3 = [point[0] - b.pos[0], point[1] - b.pos[1], point[2] - b.pos[2]];
	const z = d[0] * b.fwd[0] + d[1] * b.fwd[1] + d[2] * b.fwd[2];
	if (z <= 1e-4) return null;
	const x = d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2];
	const y = d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2];
	return [(x * b.focal) / z, (y * b.focal) / z];
}

/** Bay spacing in world units for the genome's baySpacing axis. */
export function prismBaySpacing(value: number): number {
	return 1.12 + Math.min(1, Math.max(0, value)) * 0.55;
}

// ── Music character ───────────────────────────────────────────────────────
// What kind of music each option suits. The renderer turns these into pick
// weights (characterWeights in character.ts), so a shift to fast punchy music
// lands on fragmented windows, close passes and hot glass, and a shift to
// slow ambient music lands on wide slow orbits over a flooded floor in cold
// glass. Tempo, punch, bass and energy carry most of the identity; noise and
// brightness lean it where the analysis separates them.
export type PrismPrototype = Partial<Record<CharacterFeature, number>>;

// Measured lab medians (tempo / brightness / bass / noise / punch): club
// .57/.50/.76/.59/.21, swing .22/.11/.88/.25/.47, indie .48/.50/.43/.49/.31,
// ambient .03/.65/.32/.24/.07, acoustic .28/.55/.18/.40/.88, noise
// .93/.87/.12/.89/.15, cinematic .10/.53/.48/.23/.43. Each option leans to
// one or two of these worlds; characterWeights keeps a floor for the rest.
export const PRISM_CAMERA_PROTOTYPES: Record<(typeof PRISM_CAMERAS)[number], PrismPrototype> = {
	orbit: { tempo: 0.35, punch: 0.3, bass: 0.45 },
	arcade: { tempo: 0.48, bass: 0.43, noise: 0.49 },
	crane: { tempo: 0.22, bass: 0.88, punch: 0.47 },
	glass: { punch: 0.88, tempo: 0.28, bass: 0.18 },
	gallery: { tempo: 0.57, bass: 0.76, punch: 0.21 },
	flooded: { tempo: 0.03, punch: 0.07, noise: 0.24 },
	nave: { tempo: 0.1, bass: 0.48, punch: 0.43 },
	dutch: { tempo: 0.93, noise: 0.89, bass: 0.12 }
};

export const PRISM_ENVIRONMENT_PROTOTYPES: Record<(typeof PRISM_ENVIRONMENTS)[number], PrismPrototype> = {
	nave: { tempo: 0.3, bass: 0.6, punch: 0.4 },
	crypt: { tempo: 0.03, punch: 0.07, energy: 0.25 },
	ruin: { tempo: 0.93, noise: 0.89, bass: 0.12 },
	apse: { punch: 0.88, tempo: 0.28, bass: 0.18 },
	void: { tempo: 0.57, bass: 0.76, noise: 0.59 }
};

export const PRISM_GRAMMAR_PROTOTYPES: readonly PrismPrototype[] = [
	{ tempo: 0.3, bass: 0.5 }, // gothic
	{ tempo: 0.48, brightness: 0.5, bass: 0.43 }, // rayonnant
	{ tempo: 0.93, noise: 0.89 }, // flamboyant
	{ tempo: 0.1, bass: 0.48, punch: 0.43 }, // romanesque
	{ tempo: 0.57, bass: 0.76, punch: 0.21 }, // girih
	{ punch: 0.88, tempo: 0.28 }, // nouveau
	{ tempo: 0.22, bass: 0.88, punch: 0.47 }, // deco
	{ tempo: 0.03, punch: 0.07, brightness: 0.65 } // modern
];

export const PRISM_MOSAIC_PROTOTYPES: readonly PrismPrototype[] = [
	{ tempo: 0.3, punch: 0.4 }, // organic
	{ tempo: 0.55, bass: 0.7 }, // quarry
	{ punch: 0.85, tempo: 0.28 }, // segments
	{ tempo: 0.93, noise: 0.89 }, // slivers
	{ tempo: 0.05, punch: 0.07, noise: 0.24 } // slabs
];

export const PRISM_BEAT_FORM_PROTOTYPES: readonly PrismPrototype[] = [
	{ tempo: 0.05, punch: 0.07 }, // rings
	{ tempo: 0.57, bass: 0.76 }, // wheel
	{ punch: 0.88, bass: 0.18 }, // pairs
	{ tempo: 0.22, bass: 0.88, punch: 0.47 }, // spiral
	{ tempo: 0.48, punch: 0.31, bass: 0.43 }, // cascade
	{ tempo: 0.93, noise: 0.89 } // lightning
];

/**
 * Palette prototypes from the glass itself: hot families suit fast music,
 * cold deep ones slow music, saturated ones punchy music, luminous ones loud
 * music, warm ones happy music.
 */
export const PRISM_PALETTE_PROTOTYPES: readonly PrismPrototype[] = PRISM_PALETTES.map(({ colors }) => {
	const [hero, support, accent] = colors;
	const warmth = (hero[0] - hero[2]) * 0.6 + (accent[0] - accent[2]) * 0.4;
	const value = Math.max(...hero) * 0.5 + Math.max(...accent) * 0.3 + Math.max(...support) * 0.2;
	const chroma = (c: Rgb) => (Math.max(...c) - Math.min(...c)) / Math.max(1e-3, Math.max(...c));
	const sat = chroma(hero) * 0.6 + chroma(accent) * 0.4;
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	const warm = clamp01(0.5 + warmth * 0.95);
	return {
		tempo: warm,
		valence: warm,
		punch: clamp01((sat - 0.6) * 2.5),
		energy: clamp01((value - 0.3) * 1.8)
	};
});

/** Continuous look parameters that always follow the playing music. */
export type PrismFeel = {
	/** Glass fragmentation: mosaic cells per radius multiplier. */
	frag: number;
	/** Extra cell division (the mosaic divides as fragmentation rises). */
	divide: number;
	/** Tracery and lead weight, 0..1. */
	weight: number;
	/** Edge contrast, 0..1: lead sharpness and bloom knee. */
	edge: number;
	/** Palette temperature, -1 cold .. 1 hot. */
	temperature: number;
	/** Palette value multiplier. */
	value: number;
	/** Saturation, 0..1.2 (1 = authored). */
	saturation: number;
	/** Nave haze density, 0..1. */
	haze: number;
	/** Dust in the air, 0..1. */
	dust: number;
	/** Light behind the glass, multiplier. */
	light: number;
};

/** Map a (smoothed) music character to the look's continuous parameters. */
export function prismFeel(c: Readonly<Record<CharacterFeature, number>>): PrismFeel {
	const f = (name: CharacterFeature, fallback = 0.5) => {
		const v = c[name];
		return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
	};
	const tempo = f('tempo');
	const energy = f('energy');
	const bright = f('brightness', 0.5);
	const bass = f('bass', 0.3);
	const noise = f('noise', 0.3);
	const punch = f('punch', 0.3);
	const valence = f('valence');
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	return {
		frag: 0.5 + tempo * 0.9 + punch * 0.45 + noise * 0.45,
		divide: clamp01(tempo * 0.45 + punch * 0.35 + noise * 0.3),
		weight: clamp01(0.08 + bass * 0.7 + (1 - tempo) * 0.25),
		edge: clamp01(0.1 + punch * 0.6 + tempo * 0.3),
		temperature: Math.max(-1, Math.min(1, (tempo - 0.42) * 1.7 + (valence - 0.5) * 0.5 + (bright - 0.5) * 0.3)),
		value: 0.6 + energy * 0.5 + bright * 0.25,
		saturation: Math.min(1.2, 0.78 + punch * 0.4 - noise * 0.2 + (1 - bright) * 0.1),
		haze: clamp01(0.95 - tempo * 0.6 - punch * 0.35 + (1 - energy) * 0.15),
		dust: clamp01(0.1 + tempo * 0.35 + noise * 0.45),
		light: 0.6 + energy * 0.55 + bright * 0.2
	};
}

/**
 * Temper the glass with the music: hot music pushes it toward amber and red,
 * cold music toward steel and blue (a white balance, so a curated family keeps
 * its relationships), saturation follows
 * punch, value follows loudness.
 */
export function prismTemper(c: Rgb, feel: Pick<PrismFeel, 'temperature' | 'value' | 'saturation'>, cap = 0.78): Rgb {
	const t = Number.isFinite(feel.temperature) ? Math.max(-1, Math.min(1, feel.temperature)) : 0;
	const gain: Rgb = t >= 0 ? [1 + 0.35 * t, 1 + 0.04 * t, 1 - 0.6 * t] : [1 + 0.5 * t, 1 + 0.04 * t, 1 - 0.45 * t];
	const leaned = c;
	const grey = 0.2126 * leaned[0] + 0.7152 * leaned[1] + 0.0722 * leaned[2];
	const sat = Number.isFinite(feel.saturation) ? feel.saturation : 1;
	const value = Number.isFinite(feel.value) ? feel.value : 1;
	return [0, 1, 2].map((i) => Math.min(cap, Math.max(0, (grey + (leaned[i] - grey) * sat) * gain[i] * value))) as Rgb;
}

/** Hue of a colour in degrees, 0..360 (0 for grey). */
export function prismHue(c: Rgb): number {
	const [r, g, b] = c;
	const max = Math.max(r, g, b);
	const chroma = max - Math.min(r, g, b);
	if (!(chroma > 1e-5)) return 0;
	let h: number;
	if (max === r) h = ((g - b) / chroma + 6) % 6;
	else if (max === g) h = (b - r) / chroma + 2;
	else h = (r - g) / chroma + 4;
	return h * 60;
}

/**
 * Pick-weight multipliers that keep a change of music from landing on glass
 * of the same hue as the glass on screen: families whose hero sits within
 * ~30 degrees are nearly ruled out, those beyond ~90 are untouched.
 */
export function prismHueAway(current: Rgb): number[] {
	const hue = prismHue(current);
	return PRISM_PALETTES.map(({ colors }) => {
		const d = Math.abs(((prismHue(colors[0]) - hue + 540) % 360) - 180);
		const t = Math.min(1, Math.max(0, (d - 25) / 65));
		return 0.06 + t * t * (3 - 2 * t);
	});
}
