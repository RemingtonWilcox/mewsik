// Prism's authored compositions and jewel palette roles. Pure functions so the
// renderer stays deterministic and the choices are testable without WebGPU.

import { prismEventUnit } from './runtime';

export type PrismFamily = 'quiet' | 'verse' | 'rise' | 'peak' | 'drift';

export type PrismComposition = {
	/** Fold count of the rose. */
	fold: number;
	/** Hero petal width as a share of its wedge, 0..1. */
	petalWidth: number;
	/** Outer reach of the hero petals in rose radii. */
	petalReach: number;
	/** Mosaic cells per rose radius. */
	cellScale: number;
	/** How much light the outer tier lets through, 0..1. */
	outerLit: number;
	/** Beat light modes: rings outward, a wheel turning one petal per beat, petal pairs. */
	rings: number;
	spiral: number;
	petals: number;
	/** Base backlight the section earns before energy. */
	light: number;
	/** Shaft and haze presence. */
	air: number;
};

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

type Variant = Omit<PrismComposition, 'rings' | 'spiral' | 'petals' | 'light' | 'air'>;

// Two to three authored variants per family. A returning section picks the
// next variant for this song, so a second chorus is a relative of the first
// rather than a replay.
const VARIANTS: Record<PrismFamily, Variant[]> = {
	quiet: [
		{ fold: 6, petalWidth: 0.62, petalReach: 0.56, cellScale: 14, outerLit: 0.18 },
		{ fold: 8, petalWidth: 0.55, petalReach: 0.6, cellScale: 15, outerLit: 0.12 }
	],
	verse: [
		{ fold: 8, petalWidth: 0.78, petalReach: 0.62, cellScale: 19, outerLit: 0.42 },
		{ fold: 10, petalWidth: 0.72, petalReach: 0.6, cellScale: 20, outerLit: 0.36 },
		{ fold: 9, petalWidth: 0.8, petalReach: 0.64, cellScale: 19, outerLit: 0.4 }
	],
	rise: [
		{ fold: 12, petalWidth: 0.82, petalReach: 0.66, cellScale: 22, outerLit: 0.62 },
		{ fold: 10, petalWidth: 0.86, petalReach: 0.68, cellScale: 22, outerLit: 0.66 }
	],
	peak: [
		{ fold: 12, petalWidth: 0.9, petalReach: 0.7, cellScale: 26, outerLit: 1 },
		{ fold: 16, petalWidth: 0.92, petalReach: 0.68, cellScale: 27, outerLit: 1 },
		{ fold: 14, petalWidth: 0.9, petalReach: 0.7, cellScale: 26, outerLit: 0.95 }
	],
	drift: [
		{ fold: 5, petalWidth: 0.5, petalReach: 0.7, cellScale: 15, outerLit: 0.3 },
		{ fold: 7, petalWidth: 0.55, petalReach: 0.72, cellScale: 17, outerLit: 0.26 }
	]
};

const FAMILY_MOTION: Record<
	PrismFamily,
	Pick<PrismComposition, 'rings' | 'spiral' | 'petals' | 'light' | 'air'>
> = {
	quiet: { rings: 0.15, spiral: 0, petals: 0.85, light: 0.42, air: 0.7 },
	verse: { rings: 0.3, spiral: 0, petals: 1, light: 0.62, air: 0.85 },
	rise: { rings: 0.2, spiral: 1, petals: 0, light: 0.72, air: 1 },
	peak: { rings: 1, spiral: 0.25, petals: 0, light: 0.92, air: 1.2 },
	drift: { rings: 0, spiral: 0.35, petals: 0.75, light: 0.5, air: 1.05 }
};

const FAMILY_INDEX: Record<PrismFamily, number> = {
	quiet: 0,
	verse: 1,
	rise: 2,
	peak: 3,
	drift: 4
};

/**
 * Choose the composition for the nth occurrence of a section family. The first
 * occurrence is seeded by the song; each return steps to the next variant.
 */
export function prismComposition(
	family: PrismFamily,
	seed: number,
	occurrence: number
): PrismComposition {
	const variants = VARIANTS[family];
	const start = Math.floor(prismEventUnit(seed, 0, FAMILY_INDEX[family], 11) * variants.length);
	const step = Number.isFinite(occurrence) ? Math.max(0, Math.floor(occurrence)) : 0;
	const variant = variants[(start + step) % variants.length];
	return { ...variant, ...FAMILY_MOTION[family] };
}

export type Rgb = [number, number, number];

/** Linear-light jewel glass. Deep, saturated, never bright enough to bleach. */
export const PRISM_JEWELS = {
	garnet: [0.54, 0.02, 0.014] as Rgb,
	gold: [0.74, 0.3, 0.02] as Rgb,
	teal: [0.0, 0.27, 0.3] as Rgb,
	sapphire: [0.025, 0.075, 0.58] as Rgb,
	amethyst: [0.3, 0.03, 0.52] as Rgb
} as const;

export type PrismJewel = keyof typeof PRISM_JEWELS;

/** Hero, support, accent triads ordered warm to cool around the circle of fifths. */
const TRIADS: [PrismJewel, PrismJewel, PrismJewel][] = [
	['garnet', 'teal', 'gold'],
	['gold', 'sapphire', 'garnet'],
	['teal', 'amethyst', 'gold'],
	['sapphire', 'garnet', 'gold'],
	['amethyst', 'teal', 'gold']
];

const JEWEL_HUES: [number, number][] = [
	[0.985, 0],
	[0.09, 1],
	[0.5, 2],
	[0.62, 3],
	[0.78, 4]
];

function hueDistance(a: number, b: number): number {
	const d = Math.abs((((a - b) % 1) + 1) % 1);
	return Math.min(d, 1 - d);
}

export type PrismPaletteRoles = {
	triad: number;
	hero: Rgb;
	support: Rgb;
	accent: Rgb;
	field: Rgb;
};

/**
 * Palette roles from harmony. A confident key walks the circle of fifths onto
 * one of five jewel triads; without a key the director's base hue picks the
 * nearest jewel. Minor keys and the drift family lean one triad cooler.
 */
export function prismPaletteRoles(
	keyPitchClass: number,
	keyMinor: boolean,
	keyConfidence: number,
	baseHue: number,
	family: PrismFamily
): PrismPaletteRoles {
	let triad: number;
	if (keyConfidence >= 0.2 && Number.isFinite(keyPitchClass)) {
		const pitch = ((Math.round(keyPitchClass * 12) % 12) + 12) % 12;
		const fifths = (pitch * 7) % 12;
		triad = Math.floor((fifths * TRIADS.length) / 12);
	} else {
		const hue = Number.isFinite(baseHue) ? baseHue : 0;
		let best = 0;
		let bestDistance = Infinity;
		for (const [jewelHue, index] of JEWEL_HUES) {
			const distance = hueDistance(hue, jewelHue);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		}
		triad = best;
	}
	if (keyMinor) triad += 2;
	if (family === 'drift') triad += 2;
	triad %= TRIADS.length;
	const [heroName, supportName, accentName] = TRIADS[triad];
	const hero = PRISM_JEWELS[heroName];
	const support = PRISM_JEWELS[supportName];
	const sapphire = PRISM_JEWELS.sapphire;
	const field: Rgb = [
		support[0] * 0.35 + sapphire[0] * 0.3,
		support[1] * 0.35 + sapphire[1] * 0.3,
		support[2] * 0.35 + sapphire[2] * 0.3
	];
	return {
		triad,
		hero: [...hero] as Rgb,
		support: [...support] as Rgb,
		accent: [...PRISM_JEWELS[accentName]] as Rgb,
		field
	};
}
