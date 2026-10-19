// Soma's authored look space: which organism lives in the water, where, in
// which light and through which eyes. The audio stays in charge of reaction
// (contractions, photophores, light packets); this module is in charge of
// variety. Every species is a point in ONE continuous anatomy space that a
// single signed-distance body plan renders, so a species change is a
// metamorphosis of the same body rather than a swap.
//
// Pure data and pure functions: deterministic and testable without WebGPU.

import type { VariationAxis } from '../variation';

export type Rgb = [number, number, number];

// ── Anatomy ────────────────────────────────────────────────────────────────
// Packed in this order into twelve uniform vec4s (see shaders.ts).
export const SOMA_ANATOMY_KEYS = [
	// body0: bell/mantle radius, height, cavity opening, (reserved)
	'bellR',
	'bellH',
	'bellOpen',
	'bellNeck',
	// body1: scalloped lobes, dorsoventral squash, fin skirt, stalk length
	'lobeAmp',
	'squash',
	'fin',
	'stalk',
	// tent0: tentacle length, thickness, direction (radians from the apex axis), root radius
	'tentLen',
	'tentThick',
	'tentDir',
	'tentRoot',
	// tent1: root height, curl, sway, tip bulbs
	'tentRootY',
	'tentCurl',
	'tentWave',
	'tipBulb',
	// app: frilled oral arms, dorsal cerata, eyes, mouth
	'oral',
	'cerata',
	'eyes',
	'mouth',
	// chain0: colony count (fractional = budding), spacing, taper, sinuous curve
	'chainCount',
	'chainSpacing',
	'chainTaper',
	'chainCurve',
	// chain1: colony axis in body space, world size
	'chainDirX',
	'chainDirY',
	'chainDirZ',
	'size',
	// skin0: lattice shell, comb rows, chromatophores, membrane opacity
	'lattice',
	'combs',
	'chromato',
	'opacity',
	// skin1: radial spines, iridescence, rim glow, organ glow
	'spines',
	'iridescence',
	'rimGlow',
	'organGlow',
	// organs seen through the membrane
	'gonad',
	'canal',
	'nucleus',
	'vacuole',
	// photophores: body spot density, rim ring, along appendages, note gain
	'photoDensity',
	'photoRim',
	'photoTentacle',
	'notesGain',
	// posture: body pitch (0 apex up, PI/2 horizontal, PI apex down), floor dwelling, jet, undulation
	'pitch',
	'dwell',
	'jet',
	'undulate'
] as const;

export type SomaAnatomyKey = (typeof SOMA_ANATOMY_KEYS)[number];
export type SomaAnatomy = Record<SomaAnatomyKey, number>;
export const SOMA_ANATOMY_SIZE = SOMA_ANATOMY_KEYS.length;

type SpeciesSpec = {
	name: string;
	/** Scalloped lobe counts the 'fold' axis picks from. 0 = smooth. */
	folds: readonly number[];
	/** Tentacle counts the 'arms' axis picks from. */
	arms: readonly number[];
	anatomy: Partial<SomaAnatomy>;
};

const BASE: SomaAnatomy = {
	bellR: 0.8,
	bellH: 0.8,
	bellOpen: 0,
	bellNeck: 0,
	lobeAmp: 0,
	squash: 1,
	fin: 0,
	stalk: 0,
	tentLen: 0,
	tentThick: 0.02,
	tentDir: Math.PI,
	tentRoot: 0.9,
	tentRootY: 0,
	tentCurl: 0,
	tentWave: 0.4,
	tipBulb: 0,
	oral: 0,
	cerata: 0,
	eyes: 0,
	mouth: 0,
	chainCount: 1,
	chainSpacing: 0.8,
	chainTaper: 1,
	chainCurve: 0,
	chainDirX: 0,
	chainDirY: -1,
	chainDirZ: 0,
	size: 1,
	lattice: 0,
	combs: 0,
	chromato: 0,
	opacity: 0.3,
	spines: 0,
	iridescence: 0.1,
	rimGlow: 0.6,
	organGlow: 0.5,
	gonad: 0,
	canal: 0,
	nucleus: 0,
	vacuole: 0,
	photoDensity: 0.2,
	photoRim: 0.4,
	photoTentacle: 0.3,
	notesGain: 1,
	pitch: 0,
	dwell: 0,
	jet: 0,
	undulate: 0
};

const PI = Math.PI;

export const SOMA_SPECIES: readonly SpeciesSpec[] = [
	{
		name: 'medusa',
		folds: [8, 12, 16, 6, 10, 8],
		arms: [16, 24, 12, 32, 20],
		anatomy: {
			bellR: 1,
			bellH: 0.68,
			bellOpen: 1,
			lobeAmp: 0.07,
			tentLen: 3.4,
			tentThick: 0.011,
			tentDir: PI,
			tentRoot: 0.93,
			tentRootY: -0.06,
			tentCurl: 0.5,
			tentWave: 0.85,
			oral: 1,
			opacity: 0.22,
			iridescence: 0.15,
			rimGlow: 0.85,
			organGlow: 0.75,
			gonad: 1,
			canal: 0.85,
			vacuole: 0.1,
			photoDensity: 0.15,
			photoRim: 1,
			photoTentacle: 0.5,
			jet: 1,
			undulate: 0.1
		}
	},
	{
		name: 'siphonophore',
		folds: [4, 5, 6, 4],
		arms: [6, 8, 5, 10],
		anatomy: {
			bellR: 0.42,
			bellH: 0.5,
			bellOpen: 0.85,
			lobeAmp: 0.12,
			tentLen: 2.3,
			tentThick: 0.008,
			tentDir: PI - 0.25,
			tentRoot: 0.5,
			tentRootY: -0.3,
			tentCurl: 0.7,
			tentWave: 0.85,
			tipBulb: 0.55,
			chainCount: 6.5,
			chainSpacing: 0.66,
			chainTaper: 0.92,
			chainCurve: 0.55,
			chainDirX: 0,
			chainDirY: -1,
			chainDirZ: 0,
			size: 0.85,
			opacity: 0.18,
			iridescence: 0.25,
			rimGlow: 0.95,
			organGlow: 0.6,
			gonad: 0.3,
			canal: 0.5,
			nucleus: 0.35,
			photoDensity: 0.2,
			photoRim: 0.8,
			photoTentacle: 0.9,
			pitch: 0.18,
			jet: 0.7
		}
	},
	{
		name: 'ctenophore',
		folds: [2, 4, 2, 8],
		arms: [2, 2, 4],
		anatomy: {
			bellR: 0.68,
			bellH: 1.22,
			bellOpen: 0,
			lobeAmp: 0.06,
			tentLen: 3.2,
			tentThick: 0.006,
			tentDir: PI - 0.5,
			tentRoot: 0.55,
			tentRootY: 0.05,
			tentCurl: 1.4,
			tentWave: 1.2,
			combs: 1,
			opacity: 0.12,
			iridescence: 1,
			rimGlow: 0.5,
			organGlow: 0.55,
			canal: 1,
			nucleus: 0.25,
			vacuole: 0.2,
			photoDensity: 0.1,
			photoRim: 0.2,
			photoTentacle: 0.6,
			pitch: 0.12,
			jet: 0.15
		}
	},
	{
		name: 'radiolarian',
		folds: [0],
		arms: [24, 32, 18, 40],
		anatomy: {
			bellR: 0.95,
			bellH: 0.95,
			tentLen: 1.15,
			tentThick: 0.008,
			tentDir: PI / 2,
			tentRoot: 0.92,
			tentRootY: 0,
			tentCurl: 0.05,
			tentWave: 0.25,
			tipBulb: 0.25,
			lattice: 1,
			spines: 1,
			opacity: 0.55,
			iridescence: 0.35,
			rimGlow: 0.55,
			organGlow: 0.7,
			nucleus: 0.8,
			vacuole: 0.6,
			photoDensity: 0.35,
			photoRim: 0,
			photoTentacle: 0.7,
			size: 0.9
		}
	},
	{
		name: 'cuttlefish',
		folds: [0],
		arms: [8, 10, 8],
		anatomy: {
			bellR: 0.55,
			bellH: 1.3,
			squash: 0.62,
			fin: 1,
			tentLen: 0.95,
			tentThick: 0.065,
			tentDir: 0.14,
			tentRoot: 0.24,
			tentRootY: 1.12,
			tentCurl: -0.25,
			tentWave: 0.3,
			eyes: 1,
			chromato: 1,
			opacity: 0.86,
			iridescence: 0.45,
			rimGlow: 0.25,
			organGlow: 0.15,
			photoDensity: 0.25,
			photoRim: 0,
			photoTentacle: 0.2,
			pitch: PI / 2,
			jet: 0.2,
			undulate: 1,
			size: 1.1
		}
	},
	{
		name: 'nudibranch',
		folds: [0],
		arms: [2, 4, 2],
		anatomy: {
			bellR: 0.36,
			bellH: 1.35,
			squash: 0.55,
			fin: 0.45,
			tentLen: 0.42,
			tentThick: 0.045,
			tentDir: 0.35,
			tentRoot: 0.22,
			tentRootY: 1.18,
			tentCurl: -0.2,
			tentWave: 0.3,
			cerata: 1,
			chromato: 0.5,
			opacity: 0.68,
			iridescence: 0.6,
			rimGlow: 0.6,
			organGlow: 0.4,
			photoDensity: 0.45,
			photoRim: 0,
			photoTentacle: 0.4,
			pitch: PI / 2,
			dwell: 0.8,
			undulate: 0.65,
			size: 1
		}
	},
	{
		name: 'mycelial bloom',
		folds: [6, 7, 5, 9],
		arms: [18, 24, 14, 30],
		anatomy: {
			bellR: 0.55,
			bellH: 0.42,
			bellOpen: 0.25,
			lobeAmp: 0.22,
			tentLen: 1.9,
			tentThick: 0.008,
			tentDir: 2.15,
			tentRoot: 0.5,
			tentRootY: -0.05,
			tentCurl: 1.2,
			tentWave: 0.4,
			tipBulb: 1,
			stalk: 0.9,
			opacity: 0.42,
			iridescence: 0.2,
			rimGlow: 0.7,
			organGlow: 0.6,
			nucleus: 0.3,
			vacuole: 0.8,
			photoDensity: 0.55,
			photoRim: 0.5,
			photoTentacle: 1,
			pitch: PI,
			dwell: 0.9,
			size: 1
		}
	},
	{
		name: 'polyp colony',
		folds: [8, 6, 10, 8],
		arms: [12, 16, 10, 18],
		anatomy: {
			bellR: 0.3,
			bellH: 0.48,
			bellOpen: 0.7,
			lobeAmp: 0.1,
			stalk: 1.1,
			tentLen: 0.72,
			tentThick: 0.012,
			tentDir: PI - 0.65,
			tentRoot: 0.88,
			tentRootY: -0.08,
			tentCurl: 0.45,
			tentWave: 0.55,
			tipBulb: 0.2,
			chainCount: 5.2,
			chainSpacing: 0.78,
			chainTaper: 0.94,
			chainCurve: 0.45,
			chainDirX: 1,
			chainDirY: 0,
			chainDirZ: 0.35,
			opacity: 0.5,
			iridescence: 0.25,
			rimGlow: 0.8,
			organGlow: 0.7,
			gonad: 0.35,
			nucleus: 0.25,
			photoDensity: 0.2,
			photoRim: 0.9,
			photoTentacle: 0.6,
			pitch: PI,
			dwell: 1,
			size: 0.9
		}
	},
	{
		name: 'anglerfish',
		folds: [0],
		arms: [1],
		anatomy: {
			bellR: 0.72,
			bellH: 1,
			squash: 0.82,
			fin: 0.3,
			mouth: 1,
			eyes: 0.55,
			tentLen: 1.35,
			tentThick: 0.022,
			tentDir: 0.62,
			tentRoot: 0.55,
			tentRootY: 0.62,
			tentCurl: -0.55,
			tentWave: 0.25,
			tipBulb: 1.6,
			chromato: 0.25,
			opacity: 0.95,
			iridescence: 0.2,
			rimGlow: 0.14,
			organGlow: 0,
			photoDensity: 0.35,
			photoRim: 0,
			photoTentacle: 0.2,
			pitch: PI / 2,
			undulate: 0.75,
			size: 1.05
		}
	},
	{
		name: 'salp chain',
		folds: [0, 6],
		arms: [0],
		anatomy: {
			bellR: 0.32,
			bellH: 0.56,
			bellOpen: 1,
			bellNeck: 0.6,
			chainCount: 7.5,
			chainSpacing: 0.6,
			chainTaper: 0.97,
			chainCurve: 0.75,
			chainDirX: 1,
			chainDirY: 0,
			chainDirZ: 0,
			opacity: 0.1,
			iridescence: 0.25,
			rimGlow: 0.75,
			organGlow: 1,
			nucleus: 1,
			canal: 0.65,
			photoDensity: 0.25,
			photoRim: 0.5,
			pitch: PI / 2,
			jet: 0.6,
			size: 0.92
		}
	},
	{
		name: 'cell colony',
		folds: [0],
		arms: [0],
		anatomy: {
			bellR: 0.5,
			bellH: 0.5,
			spines: 0.12,
			chainCount: 4.2,
			chainSpacing: 0.62,
			chainTaper: 0.96,
			chainCurve: 0.6,
			chainDirX: 1,
			chainDirY: 0.3,
			chainDirZ: 0.2,
			opacity: 0.3,
			iridescence: 0.5,
			rimGlow: 0.65,
			organGlow: 0.9,
			nucleus: 1,
			vacuole: 1,
			photoDensity: 0.15,
			photoRim: 0,
			photoTentacle: 0.3,
			pitch: 0.3,
			size: 0.95
		}
	},
	{
		name: 'pyrosome',
		folds: [0, 10],
		arms: [0],
		anatomy: {
			bellR: 0.38,
			bellH: 1.75,
			bellOpen: 1,
			bellNeck: 0.25,
			opacity: 0.34,
			iridescence: 0.3,
			rimGlow: 0.5,
			organGlow: 0.25,
			vacuole: 0.3,
			photoDensity: 1,
			photoRim: 0.6,
			pitch: PI / 2,
			jet: 0.35,
			undulate: 0.2,
			size: 1.1
		}
	}
];

export const SOMA_SPECIES_NAMES = SOMA_SPECIES.map((species) => species.name);

export function somaSpeciesAnatomy(index: number): SomaAnatomy {
	const spec = SOMA_SPECIES[((Math.round(index) % SOMA_SPECIES.length) + SOMA_SPECIES.length) % SOMA_SPECIES.length];
	return { ...BASE, ...spec.anatomy };
}

export function somaSpeciesFold(index: number, option: number): number {
	const table = SOMA_SPECIES[Math.max(0, Math.min(SOMA_SPECIES.length - 1, Math.round(index)))].folds;
	return table[((Math.round(option) % table.length) + table.length) % table.length];
}

export function somaSpeciesArms(index: number, option: number): number {
	const table = SOMA_SPECIES[Math.max(0, Math.min(SOMA_SPECIES.length - 1, Math.round(index)))].arms;
	return table[((Math.round(option) % table.length) + table.length) % table.length];
}

// ── Environments ───────────────────────────────────────────────────────────
export const SOMA_ENVIRONMENTS = [
	'abyss', // the open water column at depth: faint downwelling, heavy snow
	'vent', // hydrothermal chimneys, an ember glow from below, rising shimmer
	'kelp', // a kelp cathedral: tall fronds, shafts from a far bright surface
	'bay', // a bioluminescent bay seen from below: Snell's window and a mirror
	'ice', // an ice cave: faceted blue walls and a crack of light above
	'void' // black water with marine snow and distant lights
] as const;
export type SomaEnvironment = (typeof SOMA_ENVIRONMENTS)[number];

export type SomaEnvironmentSpec = {
	/** Fog extinction per world unit. */
	fog: number;
	/** Seabed height; the seabed rises for floor-dwelling species. */
	floorY: number;
	/** Water surface height (only the bay shows it as a mirror). */
	surfaceY: number;
	/** Mirror strength for the planar reflection (seabed or surface). */
	reflect: number;
	/** Marine snow density. */
	snow: number;
	/** Light shafts from the key light. */
	shafts: number;
	/** Key light direction (towards the light), world space. */
	keyDir: [number, number, number];
	keyPower: number;
	/** Tint of the key light, mixed with the palette's haze. */
	keyTint: Rgb;
	keyTintMix: number;
	ambient: number;
	/** Exposure lift so a dark world still reads. */
	exposure: number;
};

export const SOMA_ENVIRONMENT_SPECS: Record<SomaEnvironment, SomaEnvironmentSpec> = {
	abyss: {
		fog: 0.085,
		floorY: -7.5,
		surfaceY: 30,
		reflect: 0.15,
		snow: 1,
		shafts: 0.35,
		keyDir: [0.18, 1, 0.12],
		keyPower: 0.55,
		keyTint: [0.35, 0.6, 1],
		keyTintMix: 0.35,
		ambient: 0.05,
		exposure: 1.1
	},
	vent: {
		fog: 0.07,
		floorY: -3.1,
		surfaceY: 30,
		reflect: 0.25,
		snow: 0.75,
		shafts: 0.55,
		keyDir: [-0.2, -1, 0.3],
		keyPower: 0.95,
		keyTint: [1, 0.36, 0.08],
		keyTintMix: 0.75,
		ambient: 0.05,
		exposure: 1
	},
	kelp: {
		fog: 0.06,
		floorY: -3.6,
		surfaceY: 30,
		reflect: 0.2,
		snow: 0.55,
		shafts: 1,
		keyDir: [0.3, 1, -0.2],
		keyPower: 1,
		keyTint: [0.75, 0.95, 0.45],
		keyTintMix: 0.6,
		ambient: 0.07,
		exposure: 1
	},
	bay: {
		fog: 0.05,
		floorY: -8,
		surfaceY: 4.6,
		reflect: 0.85,
		snow: 0.5,
		shafts: 0.85,
		keyDir: [0.1, 1, 0.25],
		keyPower: 0.85,
		keyTint: [0.5, 0.75, 1],
		keyTintMix: 0.5,
		ambient: 0.06,
		exposure: 1
	},
	ice: {
		fog: 0.05,
		floorY: -3.8,
		surfaceY: 30,
		reflect: 0.45,
		snow: 0.35,
		shafts: 0.7,
		keyDir: [-0.25, 1, 0.15],
		keyPower: 0.9,
		keyTint: [0.7, 0.92, 1],
		keyTintMix: 0.7,
		ambient: 0.09,
		exposure: 1
	},
	void: {
		fog: 0.1,
		floorY: -9,
		surfaceY: 30,
		reflect: 0.1,
		snow: 0.85,
		shafts: 0.1,
		keyDir: [0.4, 0.8, 0.45],
		keyPower: 0.35,
		keyTint: [0.6, 0.6, 0.75],
		keyTintMix: 0.3,
		ambient: 0.04,
		exposure: 1.2
	}
};

// ── Cameras: how a diver or an ROV films the animal ────────────────────────
export const SOMA_CAMERAS = [
	'companion', // three-quarter, swimming alongside
	'below', // looking up at it against the light
	'macro', // close on the margin and tentacles, shallow focus
	'orbit', // a slow ROV orbit
	'profile', // side-on tracking as it crosses
	'wide', // far back: the animal small in its world
	'descent' // above, looking down into the deep
] as const;
export type SomaCamera = (typeof SOMA_CAMERAS)[number];

export type SomaCameraSpec = {
	/** Elevation in radians (negative = below the animal looking up). */
	elevation: number;
	/** Distance in multiples of the animal's extent. */
	distance: number;
	/** Azimuth offset in radians around the world up axis. */
	azimuth: number;
	/** How fast the azimuth orbits (radians per second at full energy). */
	orbit: number;
	/** Lens aperture for depth of field. */
	aperture: number;
	/** Vertical focal length (bigger = narrower). */
	focal: number;
	/** Look-target offset along the body axis (negative = towards the tentacles). */
	focusAlong: number;
	/** 0 = orbit in world space, 1 = hold a side-on angle to the animal's heading. */
	follow: number;
};

export const SOMA_CAMERA_SPECS: Record<SomaCamera, SomaCameraSpec> = {
	companion: { elevation: 0.16, distance: 1.9, azimuth: 0.6, orbit: 0.012, aperture: 0.035, focal: 1.55, focusAlong: -0.1, follow: 0.35 },
	below: { elevation: -0.55, distance: 2.05, azimuth: -0.4, orbit: 0.01, aperture: 0.03, focal: 1.45, focusAlong: 0.05, follow: 0 },
	macro: { elevation: 0.05, distance: 1.35, azimuth: 1.1, orbit: 0.016, aperture: 0.07, focal: 1.65, focusAlong: -0.25, follow: 0.25 },
	orbit: { elevation: 0.24, distance: 2.3, azimuth: 0, orbit: 0.05, aperture: 0.03, focal: 1.55, focusAlong: 0, follow: 0 },
	profile: { elevation: 0.02, distance: 2.1, azimuth: 1.57, orbit: 0.006, aperture: 0.04, focal: 1.6, focusAlong: -0.05, follow: 1 },
	wide: { elevation: 0.12, distance: 2.7, azimuth: -0.9, orbit: 0.008, aperture: 0.012, focal: 1.35, focusAlong: 0, follow: 0 },
	descent: { elevation: 0.78, distance: 2.3, azimuth: 2.2, orbit: 0.014, aperture: 0.03, focal: 1.5, focusAlong: 0.1, follow: 0 }
};

// ── Beat forms: how a beat's light travels through the body ────────────────
export const SOMA_BEAT_FORMS = [
	'descend', // a packet from the apex down the bell and every tentacle
	'ripple', // rings opening around the margin
	'spiral', // a helix of light winding around the body
	'heartbeat', // the organs double-pulse inside
	'cascade' // colony members fire one after another
] as const;

// ── Skins ──────────────────────────────────────────────────────────────────
export const SOMA_SKINS = [
	'gel', // the species' own membrane
	'glass', // clearer, sharper rim, more refraction
	'velvet', // denser, soft sheen, deep colour
	'nacre', // pearly iridescent film
	'ember' // warm subsurface glow from within
] as const;

// ── Palettes ───────────────────────────────────────────────────────────────
// Dark water first, life second. Linear light. Hand-picked, never a ramp.
// water: the deep field; haze: lit water; body: membrane tint;
// glow: primary bioluminescence; accent: second light; organ: inner light.
export type SomaPalette = {
	name: string;
	water: Rgb;
	haze: Rgb;
	body: Rgb;
	glow: Rgb;
	accent: Rgb;
	organ: Rgb;
};

export const SOMA_PALETTES: readonly SomaPalette[] = [
	{ name: 'abyssal-cyan', water: [0.002, 0.008, 0.02], haze: [0.01, 0.05, 0.09], body: [0.2, 0.42, 0.55], glow: [0.1, 0.85, 1], accent: [0.6, 0.2, 1], organ: [1, 0.45, 0.2] },
	{ name: 'midnight-violet', water: [0.006, 0.003, 0.02], haze: [0.04, 0.02, 0.1], body: [0.42, 0.28, 0.62], glow: [0.62, 0.32, 1], accent: [0.15, 0.85, 0.95], organ: [1, 0.3, 0.55] },
	{ name: 'vent-ember', water: [0.012, 0.004, 0.003], haze: [0.09, 0.03, 0.012], body: [0.55, 0.22, 0.12], glow: [1, 0.42, 0.08], accent: [0.2, 0.75, 1], organ: [1, 0.78, 0.3] },
	{ name: 'kelp-gold', water: [0.004, 0.012, 0.008], haze: [0.04, 0.08, 0.04], body: [0.45, 0.48, 0.25], glow: [0.95, 0.75, 0.2], accent: [0.25, 1, 0.55], organ: [1, 0.4, 0.15] },
	{ name: 'dinoflagellate', water: [0.001, 0.006, 0.018], haze: [0.01, 0.04, 0.1], body: [0.18, 0.35, 0.6], glow: [0.15, 0.55, 1], accent: [0.2, 1, 0.85], organ: [0.7, 0.9, 1] },
	{ name: 'ice-aqua', water: [0.004, 0.012, 0.02], haze: [0.04, 0.1, 0.14], body: [0.55, 0.75, 0.85], glow: [0.4, 0.95, 1], accent: [0.85, 0.5, 1], organ: [0.95, 0.85, 0.5] },
	{ name: 'void-pearl', water: [0.003, 0.003, 0.005], haze: [0.03, 0.03, 0.04], body: [0.62, 0.6, 0.66], glow: [0.85, 0.9, 1], accent: [1, 0.55, 0.35], organ: [0.45, 0.85, 1] },
	{ name: 'lure-amber', water: [0.001, 0.005, 0.006], haze: [0.01, 0.04, 0.04], body: [0.12, 0.2, 0.22], glow: [0.2, 1, 0.75], accent: [1, 0.62, 0.15], organ: [1, 0.3, 0.1] },
	{ name: 'comb-spectral', water: [0.002, 0.004, 0.012], haze: [0.02, 0.03, 0.07], body: [0.4, 0.45, 0.6], glow: [1, 0.3, 0.6], accent: [0.2, 0.9, 1], organ: [0.6, 1, 0.3] },
	{ name: 'coral-magenta', water: [0.008, 0.002, 0.012], haze: [0.07, 0.02, 0.08], body: [0.62, 0.22, 0.45], glow: [1, 0.2, 0.62], accent: [1, 0.72, 0.2], organ: [0.4, 1, 0.8] },
	{ name: 'tangerine-dusk', water: [0.006, 0.003, 0.012], haze: [0.05, 0.025, 0.07], body: [0.6, 0.32, 0.22], glow: [1, 0.48, 0.12], accent: [0.62, 0.3, 1], organ: [1, 0.85, 0.35] },
	{ name: 'siphon-rose', water: [0.006, 0.002, 0.008], haze: [0.06, 0.02, 0.05], body: [0.65, 0.35, 0.45], glow: [1, 0.35, 0.45], accent: [0.6, 0.95, 1], organ: [1, 0.6, 0.25] },
	{ name: 'bathyal-crimson', water: [0.006, 0.0, 0.002], haze: [0.05, 0.005, 0.015], body: [0.5, 0.06, 0.08], glow: [1, 0.12, 0.1], accent: [0.25, 0.4, 1], organ: [1, 0.55, 0.2] },
	{ name: 'plankton-green', water: [0.002, 0.008, 0.005], haze: [0.015, 0.07, 0.04], body: [0.3, 0.55, 0.35], glow: [0.35, 1, 0.4], accent: [0.15, 0.6, 1], organ: [1, 0.85, 0.2] },
	{ name: 'sea-angel', water: [0.003, 0.004, 0.012], haze: [0.03, 0.03, 0.08], body: [0.62, 0.45, 0.4], glow: [1, 0.5, 0.25], accent: [0.35, 0.65, 1], organ: [1, 0.25, 0.3] },
	{ name: 'pyro-teal', water: [0.001, 0.007, 0.009], haze: [0.01, 0.06, 0.06], body: [0.2, 0.5, 0.5], glow: [0.2, 1, 0.85], accent: [1, 0.85, 0.35], organ: [0.4, 0.6, 1] },
	{ name: 'cephalopod-copper', water: [0.006, 0.004, 0.003], haze: [0.05, 0.035, 0.02], body: [0.62, 0.38, 0.22], glow: [1, 0.55, 0.25], accent: [0.2, 0.85, 0.8], organ: [0.9, 0.2, 0.15] },
	{ name: 'oceanic-lilac', water: [0.004, 0.004, 0.014], haze: [0.04, 0.035, 0.09], body: [0.55, 0.48, 0.75], glow: [0.75, 0.6, 1], accent: [1, 0.6, 0.75], organ: [0.5, 1, 0.9] },
	{ name: 'nightfall-indigo', water: [0.001, 0.002, 0.016], haze: [0.01, 0.02, 0.09], body: [0.2, 0.25, 0.7], glow: [0.3, 0.4, 1], accent: [1, 0.35, 0.8], organ: [0.4, 1, 1] },
	{ name: 'thermocline-jade', water: [0.002, 0.008, 0.008], haze: [0.02, 0.08, 0.07], body: [0.3, 0.62, 0.52], glow: [0.3, 1, 0.7], accent: [0.85, 0.35, 1], organ: [1, 0.65, 0.3] },
	{ name: 'phosphor-lime', water: [0.003, 0.006, 0.003], haze: [0.03, 0.06, 0.02], body: [0.45, 0.6, 0.25], glow: [0.7, 1, 0.15], accent: [0.25, 0.5, 1], organ: [1, 0.35, 0.6] },
	{ name: 'bruise-abyss', water: [0.005, 0.002, 0.01], haze: [0.04, 0.02, 0.07], body: [0.38, 0.2, 0.5], glow: [0.55, 0.2, 1], accent: [0.85, 1, 0.25], organ: [1, 0.45, 0.25] },
	{ name: 'pacific-cobalt', water: [0.0, 0.004, 0.02], haze: [0.005, 0.03, 0.12], body: [0.15, 0.32, 0.7], glow: [0.15, 0.5, 1], accent: [1, 0.75, 0.3], organ: [1, 0.35, 0.35] },
	{ name: 'mariana-ice', water: [0.002, 0.005, 0.01], haze: [0.03, 0.06, 0.09], body: [0.7, 0.82, 0.9], glow: [0.75, 0.95, 1], accent: [0.3, 0.6, 1], organ: [1, 0.55, 0.85] },
	{ name: 'reef-night', water: [0.002, 0.004, 0.01], haze: [0.02, 0.04, 0.07], body: [0.6, 0.3, 0.2], glow: [1, 0.38, 0.2], accent: [0.1, 0.95, 0.75], organ: [0.95, 0.9, 0.3] },
	{ name: 'ghost-white', water: [0.003, 0.004, 0.006], haze: [0.035, 0.04, 0.05], body: [0.72, 0.72, 0.75], glow: [0.9, 0.95, 1], accent: [0.25, 0.85, 1], organ: [1, 0.7, 0.35] },
	{ name: 'ember-sea', water: [0.008, 0.003, 0.002], haze: [0.07, 0.025, 0.012], body: [0.5, 0.2, 0.15], glow: [1, 0.3, 0.12], accent: [1, 0.8, 0.4], organ: [0.35, 0.75, 1] },
	{ name: 'lagoon-electric', water: [0.0, 0.007, 0.014], haze: [0.0, 0.06, 0.1], body: [0.12, 0.45, 0.55], glow: [0.05, 0.9, 1], accent: [0.9, 0.2, 1], organ: [0.95, 1, 0.4] },
	{ name: 'umber-silt', water: [0.006, 0.005, 0.003], haze: [0.05, 0.04, 0.025], body: [0.5, 0.4, 0.28], glow: [1, 0.7, 0.35], accent: [0.45, 0.85, 1], organ: [0.95, 0.35, 0.2] },
	{ name: 'cerulean-ghost', water: [0.002, 0.006, 0.014], haze: [0.02, 0.06, 0.1], body: [0.45, 0.65, 0.85], glow: [0.5, 0.85, 1], accent: [1, 0.45, 0.4], organ: [0.6, 1, 0.6] },
	{ name: 'aurora-deep', water: [0.002, 0.006, 0.008], haze: [0.02, 0.06, 0.06], body: [0.3, 0.55, 0.45], glow: [0.25, 1, 0.55], accent: [0.7, 0.3, 1], organ: [0.3, 0.75, 1] },
	{ name: 'abyssal-rose-gold', water: [0.005, 0.003, 0.006], haze: [0.05, 0.03, 0.04], body: [0.65, 0.45, 0.38], glow: [1, 0.6, 0.45], accent: [0.35, 0.9, 0.9], organ: [1, 0.3, 0.45] }
];

/** Which of glow / accent / organ plays which role. */
export const SOMA_ROLE_PERMUTATIONS: readonly [number, number, number][] = [
	[0, 1, 2],
	[1, 0, 2],
	[0, 2, 1],
	[2, 0, 1],
	[1, 2, 0],
	[2, 1, 0]
];

// ── Genome ─────────────────────────────────────────────────────────────────
export const SOMA_AXES: readonly VariationAxis[] = [
	// Era: the world changes. Environment, the water's light.
	{ kind: 'choice', name: 'environment', options: SOMA_ENVIRONMENTS.length, scale: 'era', chance: 0.9, memory: 3, maxHold: 2, tau: 12 },
	{ kind: 'continuous', name: 'lightAzimuth', min: 0, max: 1, wrap: true, scale: 'era', step: 0.3, tau: 14 },
	{ kind: 'continuous', name: 'murk', min: 0, max: 1, scale: 'era', step: 0.4, tau: 12 },
	{ kind: 'continuous', name: 'snow', min: 0, max: 1, scale: 'era', step: 0.45, tau: 10 },
	// Section: a new animal, a new colour family, a new way of filming it.
	{ kind: 'choice', name: 'species', options: SOMA_SPECIES.length, scale: 'section', chance: 0.6, memory: 6, maxHold: 2, tau: 16 },
	{ kind: 'choice', name: 'palette', options: SOMA_PALETTES.length, scale: 'section', chance: 0.75, memory: 12, maxHold: 2, tau: 9 },
	{ kind: 'choice', name: 'camera', options: SOMA_CAMERAS.length, scale: 'section', chance: 0.7, memory: 3, maxHold: 2, tau: 10 },
	{ kind: 'choice', name: 'beatForm', options: SOMA_BEAT_FORMS.length, scale: 'section', chance: 0.6, memory: 2, tau: 3 },
	{ kind: 'choice', name: 'skin', options: SOMA_SKINS.length, scale: 'section', chance: 0.45, memory: 2, tau: 6 },
	{ kind: 'choice', name: 'fold', options: 6, scale: 'section', chance: 0.4, memory: 2, tau: 2 },
	{ kind: 'choice', name: 'arms', options: 5, scale: 'section', chance: 0.35, memory: 2, tau: 2 },
	{ kind: 'continuous', name: 'companion', min: 0, max: 1, scale: 'section', step: 0.5, chance: 0.6, tau: 10 },
	{ kind: 'continuous', name: 'camSide', min: -1, max: 1, scale: 'section', step: 0.55, tau: 9 },
	{ kind: 'continuous', name: 'camHeight', min: -1, max: 1, scale: 'section', step: 0.45, tau: 9 },
	// Phrase: the animal breathes and grows. Proportions, colour drift, framing.
	{ kind: 'choice', name: 'roles', options: SOMA_ROLE_PERMUTATIONS.length, scale: 'phrase', chance: 0.2, memory: 2, tau: 5 },
	{ kind: 'continuous', name: 'bellShape', min: -1, max: 1, scale: 'phrase', step: 0.25, tau: 5 },
	{ kind: 'continuous', name: 'lobeDepth', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 4 },
	{ kind: 'continuous', name: 'reach', min: 0, max: 1, scale: 'phrase', step: 0.22, tau: 5 },
	{ kind: 'continuous', name: 'curl', min: -1, max: 1, scale: 'phrase', step: 0.25, tau: 5 },
	{ kind: 'continuous', name: 'sway', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 4 },
	{ kind: 'continuous', name: 'colony', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 6 },
	{ kind: 'continuous', name: 'clarity', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 5 },
	{ kind: 'continuous', name: 'innerLight', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 4 },
	{ kind: 'continuous', name: 'photophores', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 4 },
	{ kind: 'continuous', name: 'bodySize', min: 0, max: 1, scale: 'phrase', step: 0.2, tau: 7 },
	{ kind: 'continuous', name: 'frill', min: 0, max: 1, scale: 'phrase', step: 0.25, tau: 5 },
	{ kind: 'continuous', name: 'hueDrift', min: -1, max: 1, scale: 'phrase', step: 0.25, tau: 6 },
	{ kind: 'continuous', name: 'framing', min: -1, max: 1, scale: 'phrase', step: 0.35, tau: 8 },
	{ kind: 'continuous', name: 'tilt', min: -1, max: 1, scale: 'phrase', step: 0.3, tau: 7 }
];
