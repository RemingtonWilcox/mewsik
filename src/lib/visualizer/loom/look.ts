// Loom's look: the long-listen variety layer on top of the conductor.
//
// The conductor and the audio stay in charge of reaction (beats, bands,
// tension, drops). This module owns *which* Loom you are looking at: the weave
// topology, the palette family and how its colours are cast, the fibre
// material, the camera regime, the environment and the form beats take. It is
// driven by the shared variation genome (src/lib/visualizer/variation.ts), so
// it mutates on phrase, section and era boundaries, glides across them, never
// returns to a recent look and keeps moving on hours-long radio. Between
// boundaries nothing parks: the camera roams a space of viewpoints around the
// genome's regime (motion.ts Roamer), the figure's form wanders continuously
// on top of its grammar (LoomFigure), and the place's details drift.
//
// Everything here is CPU-only and allocation-free per frame: the resolved
// `LoomLookFrame` is one reused object the renderer packs into uniforms.

import { VariationGenome, variationSpaceSize, type VariationAxis } from '$lib/visualizer/variation';
import { Roamer, Wander } from '$lib/visualizer/motion';
import {
	characterWeights,
	type CharacterFeature,
	type MusicCharacter
} from '$lib/visualizer/character';
import {
	createLoomExposure,
	resolveLoomExposure,
	type LoomExposure,
	type LoomExposureInput
} from '$lib/visualizer/loom/exposure';

// ---------------------------------------------------------------------------
// Topology grammars. Each is a parametric surface the strands are laid on (see
// `grammarPoint` in shaders.ts); the index order is the WGSL switch order.

export type LoomGrammar = {
	name: string;
	/** Fraction of the 16 chorus strands shown, low..high, chosen by the `strands` axis. */
	strands: readonly [number, number];
	/** Overall framing scale for this grammar. */
	scale: number;
	/**
	 * 0..1 how crowded the grammar reads at full strand count. Feeds the light
	 * budget (exposure.ts): dense grammars get thinner, quieter chorus strands,
	 * shorter trails and less bloom so the figure never dissolves into a blob.
	 */
	density: number;
	/**
	 * Height of the floor under this grammar in strand space: just below its
	 * lowest threads, so towers stand on it, fans spring from it and curtains
	 * hang just clear of it.
	 */
	floor: number;
	/**
	 * Bounds of the figure in strand space, before any deformation, measured on
	 * screen (bright-pixel extent per grammar, output/loom3/calib.mjs):
	 * [half-width x, lowest y, highest y, half-depth z]. The look frames the
	 * figure from these, so every grammar owns the frame at the same size
	 * whatever its proportions (a tower, a platter, a tunnel).
	 */
	reach: readonly [number, number, number, number];
};

export const LOOM_GRAMMARS: readonly LoomGrammar[] = [
	{ name: 'ribbon', strands: [0, 0.3], scale: 1, density: 0.35, floor: -0.86, reach: [0.76, -0.29, 0.37, 0.38] },
	{ name: 'canopy', strands: [0.4, 0.85], scale: 0.82, density: 0.85, floor: -1.06, reach: [0.89, -0.52, 0.42, 0.51] },
	{ name: 'tunnel', strands: [0.4, 0.85], scale: 0.78, density: 0.95, floor: -0.96, reach: [1.27, -0.56, 0.54, 0.55] },
	{ name: 'helix-tower', strands: [0.25, 0.7], scale: 0.88, density: 0.55, floor: -1.02, reach: [0.44, -0.87, 0.73, 0.44] },
	{ name: 'mobius', strands: [0.4, 0.9], scale: 0.86, density: 0.6, floor: -1.0, reach: [0.92, -0.75, 0.48, 0.73] },
	{ name: 'peacock', strands: [0.45, 0.9], scale: 0.86, density: 0.7, floor: -0.68, reach: [0.64, -0.52, 0.24, 0.29] },
	{ name: 'braid', strands: [0, 0.5], scale: 0.88, density: 0.45, floor: -0.72, reach: [0.85, -0.3, 0.47, 0.35] },
	{ name: 'string-hyperboloid', strands: [0.5, 0.9], scale: 0.84, density: 0.75, floor: -0.74, reach: [0.59, -0.55, 0.55, 0.48] },
	{ name: 'saddle-lattice', strands: [0.45, 0.9], scale: 0.82, density: 0.8, floor: -0.86, reach: [0.75, -0.45, 0.39, 0.75] },
	{ name: 'thread-galaxy', strands: [0.35, 0.8], scale: 0.72, density: 0.9, floor: -0.5, reach: [0.92, -0.16, 0.27, 0.92] },
	{ name: 'trefoil', strands: [0.2, 0.65], scale: 0.9, density: 0.45, floor: -0.88, reach: [0.76, -0.71, 0.51, 0.65] },
	{ name: 'orrery-rings', strands: [0.35, 0.8], scale: 0.86, density: 0.55, floor: -0.86, reach: [1.37, -0.57, 0.51, 0.54] },
	{ name: 'aurora-curtain', strands: [0.45, 0.85], scale: 0.8, density: 0.85, floor: -0.64, reach: [0.92, -0.38, 0.65, 0.32] }
];

// ---------------------------------------------------------------------------
// Palette families. Three colour roles (hero / support / weft) plus the three
// environment tints (deep background, haze, glow light). Hand-picked sRGB, no
// procedural hue sweeps. The first block is Loom's euphoric home; the last
// eight are darker eras used for contrast.

export type LoomPaletteFamily = {
	name: string;
	hero: string;
	support: string;
	weft: string;
	deep: string;
	haze: string;
	glow: string;
	dark?: boolean;
};

export const LOOM_PALETTES: readonly LoomPaletteFamily[] = [
	{ name: 'sunrise', hero: '#ff8a2b', support: '#ff3b4e', weft: '#ffd166', deep: '#1a0b2e', haze: '#5a2a6e', glow: '#ff9a5a' },
	{ name: 'tropical', hero: '#00e5c7', support: '#ff7a2b', weft: '#ffe34d', deep: '#021a24', haze: '#0b5560', glow: '#ff7aa8' },
	{ name: 'aurora', hero: '#3dffb0', support: '#5a7cff', weft: '#c77dff', deep: '#020818', haze: '#0d2a4a', glow: '#3dffb0' },
	{ name: 'candy-neon', hero: '#ff2bd6', support: '#2be7ff', weft: '#fff04d', deep: '#12021f', haze: '#3d0b5c', glow: '#ff5ce1' },
	{ name: 'citrus', hero: '#ffb000', support: '#9bff2e', weft: '#ff5a1f', deep: '#1a1200', haze: '#4a3a06', glow: '#ffcf4d' },
	{ name: 'festival', hero: '#ff3355', support: '#ffc21a', weft: '#3d8bff', deep: '#14051a', haze: '#4a1440', glow: '#ff6a3d' },
	{ name: 'oil-slick', hero: '#7b5cff', support: '#00d9a0', weft: '#c8ff5a', deep: '#05040f', haze: '#1d1840', glow: '#a07bff' },
	{ name: 'pastel-dusk', hero: '#ffa8c5', support: '#a8c8ff', weft: '#ffe1a8', deep: '#1c1430', haze: '#4a3a66', glow: '#ffb8a0' },
	{ name: 'electric-lagoon', hero: '#00b3ff', support: '#00ffd5', weft: '#e8fff9', deep: '#00101e', haze: '#003a5c', glow: '#33d6ff' },
	{ name: 'mango-teal', hero: '#ffd23f', support: '#ff6b6b', weft: '#4ecdc4', deep: '#1f0f12', haze: '#5c2a2a', glow: '#ffd23f' },
	{ name: 'ultraviolet-rave', hero: '#8f3dff', support: '#ff3dbe', weft: '#3df5ff', deep: '#0a0218', haze: '#2d0a5c', glow: '#b45cff' },
	{ name: 'coral-reef', hero: '#ff6f59', support: '#43e0c0', weft: '#ffd6a5', deep: '#04161c', haze: '#1a4a52', glow: '#ff8f6b' },
	{ name: 'spring-meadow', hero: '#a6ff4d', support: '#3dd6ff', weft: '#f2ffe0', deep: '#08140a', haze: '#224a1f', glow: '#c8ff7a' },
	{ name: 'golden-hour', hero: '#ffb347', support: '#ff6f3c', weft: '#ffe8b0', deep: '#1a0d05', haze: '#5c2e12', glow: '#ffb347' },
	{ name: 'ice-and-fire', hero: '#ff4d2e', support: '#3dc8ff', weft: '#fff4ea', deep: '#050a14', haze: '#1a2a40', glow: '#ff7a4d' },
	{ name: 'bubblegum-sky', hero: '#ff77c8', support: '#6fd6ff', weft: '#c9a8ff', deep: '#120a24', haze: '#3a2a5c', glow: '#ff9ad5' },
	{ name: 'jade-and-gold', hero: '#19e68c', support: '#ffc94d', weft: '#fff1d0', deep: '#03140e', haze: '#0d3d2a', glow: '#ffd56b' },
	{ name: 'synth-sunset', hero: '#ff2e88', support: '#ff9e2e', weft: '#7a3dff', deep: '#10031c', haze: '#3d0c40', glow: '#ff5f6d' },
	{ name: 'tidal', hero: '#2ef2ff', support: '#2e6bff', weft: '#ffb02e', deep: '#010a1a', haze: '#082a4a', glow: '#2ec5ff' },
	{ name: 'berry', hero: '#e62e8a', support: '#8a2ee6', weft: '#ff9ec8', deep: '#14031a', haze: '#3d0a33', glow: '#ff4da6' },
	{ name: 'limeade', hero: '#d4ff2e', support: '#2effc4', weft: '#2e8bff', deep: '#0c1400', haze: '#2a3d05', glow: '#e6ff66' },
	{ name: 'flamingo-lagoon', hero: '#ff5c8a', support: '#00c2a8', weft: '#ffc2d1', deep: '#0a1418', haze: '#1f3d44', glow: '#ff7aa0' },
	{ name: 'prism-white', hero: '#f0f4ff', support: '#ffc46b', weft: '#8af5ff', deep: '#0a0a18', haze: '#2a2a4a', glow: '#c8d0ff' },
	{ name: 'tangerine-teal', hero: '#ff7b00', support: '#00b8b8', weft: '#ffe600', deep: '#071214', haze: '#12383a', glow: '#ff9a33' },
	{ name: 'orchid', hero: '#da70ff', support: '#ffb86b', weft: '#6bffe1', deep: '#12061c', haze: '#3a1a4a', glow: '#e48aff' },
	{ name: 'lantern-festival', hero: '#ff3d3d', support: '#ffb23d', weft: '#fff0c2', deep: '#1a0505', haze: '#4a1010', glow: '#ff6a3d' },
	{ name: 'peacock', hero: '#00a8a8', support: '#3d5afe', weft: '#c6ff00', deep: '#01101a', haze: '#053344', glow: '#00e0c0' },
	{ name: 'sherbet', hero: '#ff8fa3', support: '#ffc48f', weft: '#8fe3c4', deep: '#1a1018', haze: '#4a2a3a', glow: '#ffb0a0' },
	// Darker eras: still saturated, but the room goes to night.
	{ name: 'midnight-cobalt', hero: '#3d6bff', support: '#1f3aa8', weft: '#9ec2ff', deep: '#000208', haze: '#050f2e', glow: '#2a4aff', dark: true },
	{ name: 'ember', hero: '#ff5a1a', support: '#a8240e', weft: '#ffb36b', deep: '#080200', haze: '#2a0a02', glow: '#ff4a10', dark: true },
	{ name: 'deep-sea', hero: '#00e0b0', support: '#00618a', weft: '#6bffe8', deep: '#00050a', haze: '#00202a', glow: '#00c8a0', dark: true },
	{ name: 'noir-rose', hero: '#ff2e6b', support: '#6b1236', weft: '#ffc2d4', deep: '#050003', haze: '#1f0510', glow: '#ff2e6b', dark: true },
	{ name: 'violet-storm', hero: '#a040ff', support: '#3d138a', weft: '#e0c2ff', deep: '#030008', haze: '#14052e', glow: '#8a2eff', dark: true },
	{ name: 'emerald-night', hero: '#2eff8a', support: '#0f5c3d', weft: '#c2ffe0', deep: '#000805', haze: '#021f12', glow: '#1aff7a', dark: true },
	{ name: 'blood-orange-moon', hero: '#ff7a2e', support: '#7a0f52', weft: '#ffe0b0', deep: '#060104', haze: '#240714', glow: '#ff6a2e', dark: true },
	{ name: 'ice-cave', hero: '#9ef0ff', support: '#2e7aff', weft: '#ffffff', deep: '#00040a', haze: '#0a2440', glow: '#7ad8ff', dark: true }
];

const VIVID_PALETTES = LOOM_PALETTES.map((p, i) => (p.dark ? -1 : i)).filter((i) => i >= 0);
const DARK_PALETTES = LOOM_PALETTES.map((p, i) => (p.dark ? i : -1)).filter((i) => i >= 0);

/** Which family colour lands on which role: [hero, support, weft] indices into (hero, support, weft). */
export const LOOM_ROLE_ORDERS = [
	[0, 1, 2],
	[1, 0, 2],
	[0, 2, 1],
	[2, 0, 1],
	[1, 2, 0],
	[2, 1, 0]
] as const;

// ---------------------------------------------------------------------------
// Materials: coefficient sets the single fragment path blends between.

export type LoomMaterial = {
	name: string;
	diffuse: number;
	gloss: number;
	sharpness: number;
	aniso: number;
	fresnel: number;
	emissive: number;
	mirror: number;
	whiteCore: number;
	sheen: number;
	stripes: number;
	translucency: number;
	hotspot: number;
	iridescence: number;
	glint: number;
	/** Desaturates the body toward a luminous white (pearl, chrome). */
	pale: number;
	/** Feedback-trail bonus (phosphor persistence). */
	trail: number;
	/** Tube radius multiplier. */
	width: number;
};

export const LOOM_MATERIALS: readonly LoomMaterial[] = [
	{ name: 'glass-fibre', diffuse: 0.9, gloss: 0.55, sharpness: 0.75, aniso: 0.9, fresnel: 1, emissive: 1, mirror: 0.15, whiteCore: 0.25, sheen: 0, stripes: 1, translucency: 0.35, hotspot: 0, iridescence: 0, glint: 0.2, pale: 0, trail: 0, width: 1 },
	{ name: 'liquid-chrome', diffuse: 0.18, gloss: 2.2, sharpness: 1, aniso: 0.5, fresnel: 0.4, emissive: 0.14, mirror: 2.4, whiteCore: 0, sheen: 0, stripes: 0.1, translucency: 0, hotspot: 0, iridescence: 0.15, glint: 0.5, pale: 0.6, trail: -0.03, width: 1.15 },
	{ name: 'silk', diffuse: 1.9, gloss: 0.05, sharpness: 0.2, aniso: 0.3, fresnel: 0.5, emissive: 0.26, mirror: 0, whiteCore: 0, sheen: 2.4, stripes: 2.2, translucency: 0.4, hotspot: 0, iridescence: 0.1, glint: 0, pale: 0, trail: 0, width: 0.85 },
	{ name: 'neon-tube', diffuse: 0.05, gloss: 0.2, sharpness: 0.9, aniso: 0, fresnel: 0.2, emissive: 2.1, mirror: 0, whiteCore: 1.6, sheen: 0, stripes: 0, translucency: 0.2, hotspot: 0, iridescence: 0, glint: 0, pale: 0, trail: 0.025, width: 0.6 },
	{ name: 'molten-glass', diffuse: 0.3, gloss: 0.8, sharpness: 0.7, aniso: 0.2, fresnel: 1, emissive: 1.4, mirror: 0.35, whiteCore: 0.4, sheen: 0, stripes: 0.2, translucency: 1, hotspot: 2.2, iridescence: 0, glint: 0.15, pale: 0, trail: 0.01, width: 1.05 },
	{ name: 'pearl', diffuse: 1.5, gloss: 0.6, sharpness: 0.55, aniso: 0.3, fresnel: 1.1, emissive: 0.3, mirror: 0.5, whiteCore: 0, sheen: 0.8, stripes: 0.3, translucency: 0.3, hotspot: 0, iridescence: 1.6, glint: 0.1, pale: 0.65, trail: 0, width: 1.05 },
	{ name: 'phosphor', diffuse: 0.2, gloss: 0.1, sharpness: 0.5, aniso: 0.1, fresnel: 0.6, emissive: 1.4, mirror: 0, whiteCore: 0.5, sheen: 0, stripes: 4.5, translucency: 0.1, hotspot: 0.4, iridescence: 0, glint: 0.7, pale: 0, trail: 0.05, width: 0.62 }
];

// ---------------------------------------------------------------------------
// Camera regimes. Regions of the roaming camera's space, not paths: the
// genome blends between them and a Roamer (LoomLook.roam) travels freely
// around the blend, so no viewpoint is ever a fixed, returning shot.

export type LoomCameraRegime = {
	name: string;
	yaw: number;
	pitch: number;
	/** Multiplies the conductor's camera distance. */
	distance: number;
	roll: number;
	focal: number;
	shiftX: number;
	shiftY: number;
	/** Radians per second of held orbit while this regime is active. */
	orbit: number;
};

export const LOOM_CAMERAS: readonly LoomCameraRegime[] = [
	{ name: 'three-quarter', yaw: 0, pitch: 0.06, distance: 1, roll: 0, focal: 3.08, shiftX: 0, shiftY: 0, orbit: 0 },
	{ name: 'low-hero', yaw: -0.28, pitch: 0.34, distance: 0.86, roll: 0.05, focal: 2.75, shiftX: 0, shiftY: 0.1, orbit: 0 },
	// Looks up from under the weave into the hanging threads: no floor shows.
	{ name: 'top-down', yaw: 0.3, pitch: -1.08, distance: 1.02, roll: 0.45, focal: 3, shiftX: 0, shiftY: 0.02, orbit: 0.02 },
	{ name: 'axial', yaw: 0.95, pitch: 0.02, distance: 0.62, roll: 0, focal: 2.05, shiftX: 0, shiftY: 0.02, orbit: 0 },
	{ name: 'macro', yaw: 0.3, pitch: 0.02, distance: 0.72, roll: -0.07, focal: 3.6, shiftX: -0.16, shiftY: 0.05, orbit: 0 },
	{ name: 'slow-orbit', yaw: 0, pitch: 0.12, distance: 1.04, roll: 0, focal: 3, shiftX: 0, shiftY: 0, orbit: 0.055 },
	{ name: 'wide', yaw: -0.12, pitch: 0.2, distance: 1.42, roll: 0, focal: 3.15, shiftX: 0, shiftY: -0.02, orbit: 0 }
];

// ---------------------------------------------------------------------------
// Environments: the place the weave lives in. Nothing here paints a
// backdrop: every family is physical stage furniture lit only by the ribbons
// themselves (see the environment shaders): a floor that pools their light
// and mirrors them, participating mist that scatters it, far threads that
// catch it and recede into the dark, dust that glints only near a strand.

export type LoomEnvironment = {
	name: string;
	/** 0 no floor .. 1 a floor under the figure. */
	floor: number;
	/** Mirror strength of the floor, Fresnel-weighted. */
	reflect: number;
	/** 0 polished .. 1 rough: the reflection spreads and dims with depth. */
	roughness: number;
	/** Standing water: ripples, and kicks send swells across it. */
	ripple: number;
	/** How much ribbon light pools on the floor. */
	albedo: number;
	/** Density of the participating medium the ribbons light. */
	mist: number;
	/** Height of the medium above the floor (low = ground mist). */
	mistHeight: number;
	/** How wispy and patchy the medium is. */
	mistNoise: number;
	/** Far threads hanging around the figure. */
	threads: number;
	/** 0 a scattered hall of threads .. 1 ordered warp rings, a loom's warp. */
	warpRows: number;
	/** 0 short hanging threads .. 1 taut floor-to-ceiling warp. */
	threadReach: number;
	/** Dust and loose fibres catching the ribbon light. */
	dust: number;
};

export const LOOM_ENVIRONMENTS: readonly LoomEnvironment[] = [
	{ name: 'black-pool', floor: 1, reflect: 1, roughness: 0.04, ripple: 0.12, albedo: 0.03, mist: 0.16, mistHeight: 0.28, mistNoise: 0.5, threads: 0, warpRows: 0.2, threadReach: 0.6, dust: 0.25 },
	{ name: 'thread-hall', floor: 1, reflect: 0.34, roughness: 0.5, ripple: 0, albedo: 0.16, mist: 0.3, mistHeight: 0.42, mistNoise: 0.6, threads: 1, warpRows: 0, threadReach: 0.3, dust: 0.45 },
	{ name: 'warp-frame', floor: 1, reflect: 0.55, roughness: 0.24, ripple: 0, albedo: 0.1, mist: 0.24, mistHeight: 0.38, mistNoise: 0.4, threads: 1, warpRows: 1, threadReach: 1, dust: 0.3 },
	{ name: 'ground-mist', floor: 1, reflect: 0.22, roughness: 0.7, ripple: 0, albedo: 0.08, mist: 0.7, mistHeight: 0.5, mistNoise: 0.9, threads: 0.3, warpRows: 0.3, threadReach: 0.7, dust: 0.35 },
	{ name: 'flooded-loom', floor: 1, reflect: 0.9, roughness: 0.1, ripple: 1, albedo: 0.04, mist: 0.3, mistHeight: 0.32, mistNoise: 0.6, threads: 0.85, warpRows: 0.75, threadReach: 1, dust: 0.2 },
	{ name: 'dust-void', floor: 0.4, reflect: 0.3, roughness: 0.6, ripple: 0, albedo: 0.06, mist: 0.22, mistHeight: 0.6, mistNoise: 1, threads: 0, warpRows: 0, threadReach: 0.4, dust: 1 }
];

// ---------------------------------------------------------------------------
// Beat expression: how a beat shows, never whether it shows. Packets always
// keep a floor so Loom's tight beat sync never weakens.

export const LOOM_BEAT_FORMS = ['packets', 'pluck', 'crossings', 'shuttle', 'sparks'] as const;
/** Thread thickness profiles: [taper, bead, swell]. */
export const LOOM_THICKNESS = [
	{ name: 'tapered', taper: 1, bead: 0, swell: 0 },
	{ name: 'even', taper: 0.15, bead: 0, swell: 0 },
	{ name: 'beaded', taper: 0.5, bead: 1, swell: 0 },
	{ name: 'swelling', taper: 0.7, bead: 0, swell: 1 }
] as const;

// ---------------------------------------------------------------------------
// Tones: the value structure of a scene, which is what the eye reads first.
// Palettes alone all read as saturated neon on a dark room; tones change how
// light sits in the frame (light on dark, matte sculpture, dark ink lines,
// monochrome, a thick lit medium) so scenes differ before any colour is read.
// Every tone keeps the room dark: none of them lifts or tints the backdrop.

export type LoomTone = {
	name: string;
	/** Multiplies the fibre emission (glow vs lit surface). */
	emission: number;
	/** Multiplies the key/fill diffuse light (matte tones are lit, not glowing). */
	diffuse: number;
	/** Thickens the participating medium the ribbons light (more scattering). */
	room: number;
	/** Collapses the palette onto the hero hue in value steps. */
	mono: number;
	/** Bloom weight multiplier. */
	bloom: number;
	/** Feedback trail offset (negative = shorter). */
	trail: number;
};

export const LOOM_TONES: readonly LoomTone[] = [
	{ name: 'glow', emission: 1, diffuse: 1, room: 0, mono: 0, bloom: 1, trail: 0 },
	{ name: 'graphic', emission: 0.4, diffuse: 1.8, room: 0, mono: 0, bloom: 0.3, trail: -0.07 },
	// Dark ink lines: barely emissive fibres drawn by the key light, in a
	// thicker medium so the little light they do give carries the space.
	{ name: 'ink', emission: 0.3, diffuse: 1.6, room: 0.55, mono: 0, bloom: 0.14, trail: -0.04 },
	{ name: 'mono', emission: 0.78, diffuse: 1.15, room: 0, mono: 1, bloom: 0.75, trail: 0 },
	{ name: 'dusk', emission: 0.5, diffuse: 1.25, room: 1, mono: 0, bloom: 0.5, trail: -0.03 }
];

/** Tone pick weights by musical energy: loud passages glow, quiet ones draw. */
export function loomToneWeights(energy: number, out: number[] = []): number[] {
	const e = clamp01(energy);
	out[0] = 1.2 + e * 2.6; // glow
	out[1] = 1.3 - e * 0.5; // graphic
	out[2] = Math.max(0.15, 1.25 - e * 1.3); // ink
	out[3] = 0.9 + e * 0.3; // mono
	out[4] = Math.max(0.2, 1.2 - e * 0.9); // dusk
	return out;
}

// Compositions: where the figure sits and how much of the frame it owns.
// They are biases of the roaming framing (see LoomLook.roam), not fixed
// shots: `scale` multiplies the frame fill the camera roams around. Even the
// most open one keeps the weave owning the frame; a small clump floating in a
// black void is never a composition.
export type LoomComposition = { name: string; scale: number; shiftX: number; shiftY: number };

export const LOOM_COMPOSITIONS: readonly LoomComposition[] = [
	{ name: 'centre', scale: 1, shiftX: 0, shiftY: 0 },
	{ name: 'left-third', scale: 0.92, shiftX: -0.16, shiftY: 0.02 },
	{ name: 'right-third', scale: 0.92, shiftX: 0.16, shiftY: -0.02 },
	{ name: 'monument', scale: 1.16, shiftX: 0, shiftY: -0.05 },
	{ name: 'open-space', scale: 0.84, shiftX: 0.08, shiftY: 0.06 },
	{ name: 'high-horizon', scale: 0.96, shiftX: -0.05, shiftY: -0.1 }
];

// ---------------------------------------------------------------------------
// The genome.

// Tone relights the whole room, so it is era-scale: the slow container, picked
// for the music on a change of genre and every few sections. The palette
// family may move at a section, but less often than it used to and as a slow
// glide; within it the parts carry the music (ensemble.ts): each strand
// group's colour follows its own chord relation.
export const LOOM_LOOK_AXES: readonly VariationAxis[] = [
	{ kind: 'choice', name: 'grammar', options: LOOM_GRAMMARS.length, scale: 'section', chance: 0.85, memory: 6, maxHold: 2, tau: 3.6 },
	{ kind: 'choice', name: 'palette', options: LOOM_PALETTES.length, scale: 'section', chance: 0.5, memory: 12, maxHold: 3, tau: 4.5 },
	{ kind: 'choice', name: 'roles', options: LOOM_ROLE_ORDERS.length, scale: 'phrase', chance: 0.2, memory: 2, tau: 3.5 },
	{ kind: 'choice', name: 'camera', options: LOOM_CAMERAS.length, scale: 'phrase', chance: 0.5, memory: 3, maxHold: 3, tau: 4.5 },
	{ kind: 'choice', name: 'material', options: LOOM_MATERIALS.length, scale: 'section', chance: 0.55, memory: 3, maxHold: 2, tau: 3.5 },
	{ kind: 'choice', name: 'environment', options: LOOM_ENVIRONMENTS.length, scale: 'section', chance: 0.4, memory: 3, maxHold: 3, tau: 6 },
	{ kind: 'choice', name: 'beatForm', options: LOOM_BEAT_FORMS.length, scale: 'section', chance: 0.55, memory: 2, tau: 2 },
	{ kind: 'choice', name: 'thickness', options: LOOM_THICKNESS.length, scale: 'phrase', chance: 0.25, memory: 2, tau: 3 },
	{ kind: 'continuous', name: 'twist', min: -1, max: 1, scale: 'phrase', step: 0.3, chance: 0.7, tau: 4 },
	{ kind: 'continuous', name: 'crossings', min: 0, max: 1, scale: 'phrase', step: 0.3, chance: 0.6, tau: 3 },
	{ kind: 'continuous', name: 'strands', min: 0, max: 1, scale: 'section', step: 0.35, tau: 4 },
	{ kind: 'continuous', name: 'spread', min: 0, max: 1, scale: 'phrase', step: 0.25, chance: 0.6, tau: 4 },
	{ kind: 'continuous', name: 'symmetry', min: 0, max: 1, scale: 'section', step: 0.4, chance: 0.6, tau: 5 },
	{ kind: 'continuous', name: 'curvature', min: 0, max: 1, scale: 'phrase', step: 0.3, chance: 0.6, tau: 4 },
	{ kind: 'continuous', name: 'scale', min: 0, max: 1, scale: 'section', step: 0.3, chance: 0.6, tau: 5 },
	{ kind: 'continuous', name: 'framing', min: -1, max: 1, scale: 'phrase', step: 0.3, chance: 0.4, tau: 5 },
	{ kind: 'continuous', name: 'hueDrift', min: 0, max: 1, scale: 'phrase', step: 0.12, wrap: true, chance: 0.5, tau: 6 },
	{ kind: 'continuous', name: 'lightAzimuth', min: 0, max: 1, scale: 'section', step: 0.25, wrap: true, tau: 5 },
	{ kind: 'continuous', name: 'lightWarmth', min: 0, max: 1, scale: 'era', step: 0.4, tau: 7 },
	{ kind: 'continuous', name: 'trail', min: 0, max: 1, scale: 'era', step: 0.35, tau: 6 },
	{ kind: 'continuous', name: 'bloom', min: 0, max: 1, scale: 'section', step: 0.3, tau: 4 },
	{ kind: 'continuous', name: 'drift', min: -1, max: 1, scale: 'section', step: 0.4, chance: 0.5, tau: 5 },
	{ kind: 'continuous', name: 'vivid', min: 0, max: 1, scale: 'era', step: 0.35, tau: 6 },
	// Appended axes keep every earlier axis's seeded walk unchanged.
	{ kind: 'choice', name: 'tone', options: LOOM_TONES.length, scale: 'era', chance: 0.5, memory: 1, maxHold: 3, tau: 10 },
	{ kind: 'choice', name: 'composition', options: LOOM_COMPOSITIONS.length, scale: 'phrase', chance: 0.3, memory: 2, maxHold: 5, tau: 5 }
];

export const LOOM_LOOK_SPACE_SIZE = variationSpaceSize(LOOM_LOOK_AXES);

/** Section order used to give each starting section its own opening look. */
const SECTION_ORDER = [
	'intro',
	'verse',
	'pre_chorus',
	'build',
	'drop',
	'chorus',
	'bridge',
	'breakdown',
	'outro',
	'calm'
];

// ---------------------------------------------------------------------------
// Continuity: a choice crossfade that can never snap.
//
// The genome retargets a choice axis from wherever its own crossfade got to
// (`from = mix >= 0.5 ? to : from`), which lands as a jump when two boundaries
// fall inside one crossfade (a short section, a track change, a relabel).
// Loom keeps its own morph per axis instead: a morph in flight always
// finishes (faster when a newer target is waiting) and the next morph starts
// exactly where the last one ended, so the shader only ever blends two
// neighbouring states and every value is continuous.

export type LoomChoiceView = { from: number; to: number; mix: number };

export class LoomChoiceMorph {
	from: number;
	to: number;
	/** Wall-clock seconds of the current update (dt may be sped up by a shift). */
	realDt = Infinity;
	private progress = 1;
	readonly view: LoomChoiceView;

	constructor(
		readonly tau: number,
		initial = 0,
		/** Speed-up while a newer target is queued behind the current morph. */
		readonly rush = 2.4
	) {
		this.from = initial;
		this.to = initial;
		this.view = { from: initial, to: initial, mix: 1 };
	}

	/** True while a morph is in flight. */
	get moving(): boolean {
		return this.progress < 1;
	}

	/** Jump straight to a state (first frame only: nothing is on screen yet). */
	snap(option: number): LoomChoiceView {
		this.from = option;
		this.to = option;
		this.progress = 1;
		return this.write();
	}

	/**
	 * `maxRate` caps the morph's progress per second however fast it is pushed
	 * (a shift's glide speed times a queued target's rush), so a big structural
	 * change always takes at least 1 / maxRate seconds and never reads as a cut.
	 */
	update(target: number, dtSeconds: number, maxRate = Infinity): LoomChoiceView {
		const dt = Math.max(0, Math.min(0.5, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		if (this.progress >= 1 && target !== this.to) {
			this.from = this.to;
			this.to = target;
			this.progress = 0;
		}
		if (this.progress < 1) {
			const rate = (1 / Math.max(0.05, this.tau)) * (target !== this.to ? this.rush : 1);
			const cap = Number.isFinite(maxRate) && Number.isFinite(this.realDt) ? maxRate * this.realDt : Infinity;
			this.progress = Math.min(1, this.progress + Math.min(dt * rate, cap));
			if (this.progress >= 1) this.from = this.to;
		}
		return this.write();
	}

	private write(): LoomChoiceView {
		const p = this.progress;
		this.view.from = this.from;
		this.view.to = this.to;
		this.view.mix = p >= 1 ? 1 : p * p * (3 - 2 * p);
		return this.view;
	}
}

// ---------------------------------------------------------------------------
// Resolved frame.

export type LoomLookFrame = {
	grammarFrom: number;
	grammarTo: number;
	grammarMix: number;
	strandCount: number;
	/** 0..1 crowding of the current grammar, blended across a morph. */
	density: number;
	twist: number;
	crossings: number;
	spread: number;
	symmetry: number;
	curvature: number;
	taper: number;
	bead: number;
	swell: number;
	frameScale: number;
	/** Fraction of the frame's half-height the figure is framed to fill (diagnostics). */
	fill: number;
	frameShiftX: number;
	frameShiftY: number;
	frameTilt: number;
	hero: [number, number, number];
	support: [number, number, number];
	weft: [number, number, number];
	deep: [number, number, number];
	haze: [number, number, number];
	glow: [number, number, number];
	material: Omit<LoomMaterial, 'name'>;
	env: Omit<LoomEnvironment, 'name'>;
	camYaw: number;
	camPitch: number;
	camDistance: number;
	camRoll: number;
	focal: number;
	lensShiftX: number;
	lensShiftY: number;
	/** Floor height under the current grammar (strand space), blended across a morph. */
	floorY: number;
	/** Accumulated orbit yaw; only advances while an orbiting regime is active. */
	orbit: number;
	keyAzimuth: number;
	keyElevation: number;
	lightWarmth: number;
	fillLevel: number;
	beat: [number, number, number, number, number];
	trail: number;
	bloom: number;
	drift: number;
	/** Tone coefficients (LOOM_TONES), crossfaded. */
	toneEmission: number;
	toneDiffuse: number;
	toneRoom: number;
	toneMono: number;
	toneBloom: number;
	toneTrail: number;
	/**
	 * What kind of music is playing, as continuous weave parameters that
	 * always follow it (see LoomLook.followCharacter): never boundaries.
	 */
	weave: LoomWeaveCharacter;
	/** Continuous shape of the figure on top of its grammar (see LoomFigure). */
	figure: LoomFigure;
	/** -1..1 drift of the sway and flow clocks' rate, so no motion keeps one tempo. */
	pace: number;
	/** Light budget resolved from everything above (exposure.ts). */
	exposure: LoomExposure;
	/** Stable per-journey identity in 0..1 (see LoomLook.identitySeed). */
	identity: number;
	/** Diagnostics / QA. */
	names: {
		grammar: string;
		palette: string;
		camera: string;
		material: string;
		environment: string;
		beatForm: string;
		tone: string;
		composition: string;
	};
	paletteIndex: number;
	cameraIndex: number;
	/** Shifts answered so far: from the shared tracker, and heard by Loom itself. */
	shifts: { shared: number; local: number; contrast: number };
};

/**
 * The figure's continuous form on top of its grammar: the grammars are a few
 * parametric surfaces, and this turns them into a continuum. Every number
 * wanders on smooth non-repeating noise (motion.ts), so the ribbons keep
 * finding forms they have not taken before instead of cycling a set. Applied
 * in strand space by deformFigure (shaders.ts).
 */
export type LoomFigure = {
	/** Wring about the vertical axis, radians per unit of height. */
	twistY: number;
	/** Wring about the long (x) axis, radians per unit of length. */
	twistX: number;
	/** Arc of the whole figure along x. */
	bend: number;
	/** Opens the top and gathers the base (negative: the reverse). */
	flare: number;
	/** Lean of the whole figure, radians. */
	tiltX: number;
	tiltZ: number;
	/** Strand spacing: < 1 crowds strands to the edges, > 1 gathers them to the middle. */
	laneGamma: number;
	/** Overall strength of the deformation (character: churning music bends more). */
	amount: number;
	/** Vertical centre of the grammar's bounds (the figure is centred on it). */
	centerY: number;
	/** Three slow travelling waves through the figure: [kx, ky, kz, amplitude] each. */
	warp: number[];
	/** Their phases, radians, integrated at wandering rates. */
	phase: number[];
	/** A second grammar the figure leans toward, and how far (0 most of the time .. 0.42). */
	hybridGrammar: number;
	hybridMix: number;
};

/**
 * Character-driven weave parameters. They glide with the music's fast
 * character envelopes (about a second), so ambient and noise rock differ in
 * structure, not only in tint, even between boundaries.
 */
export type LoomWeaveCharacter = {
	/** Flow-rate multiplier for sway, drift, dust and mist (tempo). */
	flow: number;
	/** 0..1 fibres fraying off the strands (noise). */
	fray: number;
	/** 0..1 fibre grain on the strand surface (noise, dark timbre). */
	grain: number;
	/** 0..1 turbulent wobble of the strands and the medium (noise, motion). */
	turbulence: number;
	/** 0..1 ribbon width and weight (bass). */
	weight: number;
	/** 0..1 hard, hot-cored edges versus soft glow (punch). */
	edge: number;
	/** -1 cool .. +1 warm light colour (valence, timbre brightness). */
	warmth: number;
	/** Light value multiplier (brightness, valence). */
	value: number;
};

export type LoomLookContext = {
	phraseIndex: number;
	sectionKey: string;
	energy: number;
	/**
	 * The song's slow energy (conductor songEnergy). Tone and dark palettes
	 * follow it, so a quiet verse is not a different light from its drop.
	 */
	songEnergy?: number;
	/** -1 minor .. +1 major. */
	mode: number;
	/** 0..1 circle-of-fifths position. */
	key: number;
	dt: number;
	/** The music's character (journey); null in tests and before audio. */
	character?: Readonly<MusicCharacter> | null;
	/** Raw spectrum cues Loom calibrates its own hearing from (see LoomLook.hear). */
	listen?: LoomListenCues | null;
	/** Heard kick/novelty impulse 0..1 (conductor); diagnostics only. */
	impact?: number;
	/** 0..1 how busy the band is (conductor motion): the slow container moves against it. */
	busy?: number;
};

/** Per-frame spectrum cues (SignalSpectrumProfile values). */
export type LoomListenCues = {
	/** Spectral centroid, 0..1. */
	centroid: number;
	/** Spectral motion (how fast the spectrum changes), 0..1. */
	motion: number;
	/** Air band level, 0..1. */
	air: number;
};

/** Fastest a choice morph may run, per second (see LoomChoiceMorph.update). */
const MORPH_MAX_RATE: Partial<Record<string, number>> = {
	grammar: 1 / 2.2,
	camera: 1 / 2.2,
	composition: 1 / 2.2,
	palette: 1 / 1.1,
	environment: 1 / 1.1,
	material: 1 / 1.1,
	tone: 1 / 1.3
};

const CHOICE_AXES = [
	'grammar',
	'palette',
	'roles',
	'camera',
	'material',
	'environment',
	'beatForm',
	'thickness',
	'tone',
	'composition'
] as const;
type LoomChoiceAxis = (typeof CHOICE_AXES)[number];

/** Optional QA override: pin choice axes to a specific option. */
export type LoomLookOverride = Partial<Record<LoomChoiceAxis, number>>;

type Rgb = [number, number, number];

function srgbToLinear(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	const channel = (shift: number) => Math.pow(((value >> shift) & 0xff) / 255, 2.2);
	return [channel(16), channel(8), channel(0)];
}

type ResolvedPalette = { hero: Rgb; support: Rgb; weft: Rgb; deep: Rgb; haze: Rgb; glow: Rgb };
const PALETTE_RGB: readonly ResolvedPalette[] = LOOM_PALETTES.map((p) => ({
	hero: srgbToLinear(p.hero),
	support: srgbToLinear(p.support),
	weft: srgbToLinear(p.weft),
	deep: srgbToLinear(p.deep),
	haze: srgbToLinear(p.haze),
	glow: srgbToLinear(p.glow)
}));

function rotateHue(out: Rgb, rgb: Readonly<Rgb>, shift: number): Rgb {
	// Rotation about the grey axis: keeps luminance roughly, no HSV seams.
	const angle = shift * Math.PI * 2;
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const k = (1 - c) / 3;
	const r3 = Math.sqrt(1 / 3) * s;
	const [r, g, b] = rgb;
	out[0] = Math.max(0, r * (c + k) + g * (k - r3) + b * (k + r3));
	out[1] = Math.max(0, r * (k + r3) + g * (c + k) + b * (k - r3));
	out[2] = Math.max(0, r * (k - r3) + g * (k + r3) + b * (c + k));
	return out;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function clampSigned(value: number, limit: number): number {
	return Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
}

function hashUnit(a: number, b: number): number {
	let h = Math.imul((a | 0) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return (h >>> 0) / 0x100000000;
}

function seedUnit(seed: number | string): number {
	if (typeof seed === 'number') {
		if (!Number.isFinite(seed)) return 0.5;
		return seed - Math.floor(seed);
	}
	let h = 0x811c9dc5;
	for (const char of seed) {
		h ^= char.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h / 0x100000000;
}

// ---------------------------------------------------------------------------
// Character fit: which options suit which music. Each option has a partial
// character prototype; characterWeights() turns the playing music into pick
// weights, so boundaries and shifts land on looks that fit (a harsh lattice in
// a dust storm for noise rock, a curtain over still black water for ambient).

type Prototype = Partial<Record<CharacterFeature, number>>;

const GRAMMAR_FIT: readonly Prototype[] = [
	{ tempo: 0.5, energy: 0.5 }, // ribbon
	{ tempo: 0.2, energy: 0.3, noise: 0.15 }, // canopy
	{ tempo: 0.85, energy: 0.85, bass: 0.7 }, // tunnel
	{ tempo: 0.6, punch: 0.6, energy: 0.6 }, // helix tower
	{ tempo: 0.3, valence: 0.6, noise: 0.2 }, // mobius
	{ energy: 0.7, valence: 0.8, brightness: 0.65 }, // peacock
	{ tempo: 0.35, energy: 0.4, noise: 0.15, punch: 0.35 }, // braid
	{ tempo: 0.7, punch: 0.8, bass: 0.65 }, // hyperboloid
	{ noise: 0.8, tempo: 0.9, energy: 0.85 }, // lattice
	{ tempo: 0.1, energy: 0.2, punch: 0.15 }, // galaxy
	{ tempo: 0.5, bass: 0.5, valence: 0.45 }, // trefoil
	{ tempo: 0.15, valence: 0.35, energy: 0.35 }, // rings
	{ tempo: 0.05, energy: 0.15, noise: 0.1 } // curtain
];

const ENVIRONMENT_FIT: readonly Prototype[] = [
	{ tempo: 0.1, noise: 0.1, energy: 0.2 }, // black pool
	{ tempo: 0.4, energy: 0.45, punch: 0.4 }, // thread hall
	{ tempo: 0.7, punch: 0.75, bass: 0.65 }, // warp frame
	{ tempo: 0.15, brightness: 0.25, energy: 0.3 }, // ground mist
	{ bass: 0.8, tempo: 0.6, energy: 0.75 }, // flooded loom
	{ noise: 0.85, tempo: 0.9, energy: 0.85 } // dust void
];

const CAMERA_FIT: readonly Prototype[] = [
	{ tempo: 0.5, energy: 0.5 }, // three-quarter
	{ energy: 0.8, bass: 0.75 }, // low hero
	{ tempo: 0.35, noise: 0.55 }, // from below
	{ tempo: 0.85, energy: 0.8 }, // axial
	{ noise: 0.45, punch: 0.65 }, // macro
	{ tempo: 0.1, energy: 0.25 }, // slow orbit
	{ tempo: 0.2, energy: 0.3, bass: 0.3 } // wide
];

const MATERIAL_FIT: readonly Prototype[] = [
	{ tempo: 0.5, energy: 0.5 }, // glass fibre
	{ brightness: 0.8, punch: 0.7 }, // liquid chrome
	{ tempo: 0.2, noise: 0.1, energy: 0.25 }, // silk
	{ tempo: 0.85, energy: 0.85, punch: 0.6 }, // neon
	{ bass: 0.75, valence: 0.6 }, // molten glass
	{ valence: 0.7, energy: 0.3, tempo: 0.3 }, // pearl
	{ noise: 0.8, brightness: 0.6 } // phosphor
];

const TONE_FIT: readonly Prototype[] = [
	{ energy: 0.8, tempo: 0.7 }, // glow
	{ punch: 0.75, noise: 0.5 }, // graphic
	{ energy: 0.15, tempo: 0.2 }, // ink
	{ noise: 0.75 }, // mono
	{ tempo: 0.15, energy: 0.3, brightness: 0.25 } // dusk
];

/**
 * Palette fit from the family's own colours: warm families suit happy music,
 * luminous ones bright timbres, dark eras quiet or harsh music.
 */
const PALETTE_FIT: readonly Prototype[] = LOOM_PALETTES.map((family) => {
	const colours = [family.hero, family.support, family.weft].map(srgbToLinear);
	let warmth = 0;
	let light = 0;
	for (const [r, g, b] of colours) {
		warmth += (r - b) / (r + g + b + 0.05) / 3;
		light += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 3;
	}
	return {
		valence: clamp01(0.5 + warmth * 0.55),
		brightness: clamp01(0.2 + light * 1.1),
		energy: family.dark ? 0.25 : 0.65,
		noise: family.dark ? 0.6 : 0.2
	};
});

/**
 * Colour signature of each family: the mean chroma of its three roles on an
 * opponent plane, so a shift can prefer a family that reads as a different
 * colour world rather than a near neighbour.
 */
const PALETTE_SIGNATURE: readonly [number, number][] = LOOM_PALETTES.map((family) => {
	// Weighted by how much of the frame each role holds: the hero leads.
	const roles: [string, number][] = [[family.hero, 0.5], [family.support, 0.3], [family.weft, 0.2]];
	let a = 0;
	let b = 0;
	for (const [hex, weight] of roles) {
		const [r, g, bl] = srgbToLinear(hex);
		const sum = r + g + bl + 0.05;
		a += ((r - g) / sum) * weight;
		b += (((r + g) * 0.5 - bl) / sum) * weight;
	}
	return [a, b];
});

function paletteDistance(from: number, to: number): number {
	const x = PALETTE_SIGNATURE[from] ?? [0, 0];
	const y = PALETTE_SIGNATURE[to] ?? [0, 0];
	return Math.min(1, Math.hypot(x[0] - y[0], x[1] - y[1]) * 1.6);
}

/** Loom's own shift detector on its calibrated hearing (see LoomLook.detect). */
const LOCAL_FEATURES = 6;
const LOCAL_WEIGHTS = [1.3, 0.4, 1.2, 0.9, 1.1, 0.8];
const LOCAL_WEIGHT_SUM = LOCAL_WEIGHTS.reduce((sum, w) => sum + w, 0);
const LOCAL_THRESHOLD = 0.18;
const LOCAL_REFRACTORY_S = 8;
const LOCAL_SLOW_TAU_S = 20;
/** After a shift, the new scene holds this long before phrase boundaries move it. */
const SHIFT_HOLD_S = 10;
const BOUNDARY_DELAY_S = 0.8;
/** Continuous axes Loom glides itself (see LoomLook.followAxes). */
const CONTINUOUS_AXES = LOOM_LOOK_AXES.map((axis, index) => ({ axis, index })).filter(
	(entry): entry is { axis: Extract<VariationAxis, { kind: 'continuous' }>; index: number } =>
		entry.axis.kind === 'continuous'
);
/** Seconds per wander undulation of a continuous axis, by its scale (as the genome's). */
const AXIS_WANDER_PERIOD = { phrase: 24, section: 50, era: 110 } as const;

// Organic motion (motion.ts). The camera roams a space of good viewpoints
// around the genome's regime and composition; the figure's continuous form
// and the place's details wander on noise that never repeats.
const CAM_YAW = 0;
const CAM_PITCH = 1;
const CAM_DOLLY = 2;
const CAM_ROLL = 3;
const CAM_FOCAL = 4;
const CAM_SHIFT_X = 5;
const CAM_SHIFT_Y = 6;
const CAM_FILL = 7;
const CAM_ORBIT = 8;
const CAM_DIMS = 9;

const FIG_TWIST_Y = 0;
const FIG_TWIST_X = 1;
const FIG_BEND = 2;
const FIG_FLARE = 3;
const FIG_TILT_X = 4;
const FIG_TILT_Z = 5;
const FIG_GAMMA = 6;
const FIG_HYBRID = 7;
const FIG_AMOUNT = 8;
const FIG_WARP_AMP = 9; // 3 lanes
const FIG_WARP_K = 12; // 9 lanes
const FIG_WARP_RATE = 21; // 3 lanes
const FIG_PACE = 24;
const FIG_PERIODS = [
	61, 67, 73, 64, 83, 91, 87, 97, 95, 53, 59, 49, 101, 107, 97, 113, 92, 109, 98, 121, 104, 47, 43, 53, 37
];

/** How far each environment detail wanders around its family (fraction of 0..1). */
const ENV_WANDER: Partial<Record<keyof Omit<LoomEnvironment, 'name'>, number>> = {
	reflect: 0.2,
	roughness: 0.2,
	albedo: 0.04,
	mist: 0.14,
	mistHeight: 0.16,
	mistNoise: 0.25,
	threads: 0.32,
	warpRows: 0.35,
	threadReach: 0.3,
	dust: 0.3
};
const ENV_WANDER_KEYS = Object.keys(ENV_WANDER) as Array<keyof Omit<LoomEnvironment, 'name'>>;
/** Nominal camera distance (the conductor's rail), for framing the figure. */
const FRAME_DISTANCE = 3.45;
/** Assumed screen aspect when framing (the visualizer runs fullscreen landscape). */
const FRAME_ASPECT = 16 / 9;
/** The stage's fixed yaw (stageYaw in shaders.ts). */
const STAGE_YAW = 0.62;

function neutralFigure(): LoomFigure {
	return {
		twistY: 0,
		twistX: 0,
		bend: 0,
		flare: 0,
		tiltX: 0,
		tiltZ: 0,
		laneGamma: 1,
		amount: 1,
		centerY: 0,
		warp: [1.6, 0.4, 0, 0, 0, 1.6, 0.5, 0, 0.4, 0, 1.6, 0],
		phase: [0, 0, 0],
		hybridGrammar: 0,
		hybridMix: 0
	};
}

function neutralWeave(): LoomWeaveCharacter {
	return { flow: 1, fray: 0, grain: 0.15, turbulence: 0.15, weight: 0.45, edge: 0.4, warmth: 0, value: 1 };
}

/**
 * Pace of a glide at a given speed-up: `slow` (a fraction) in steady state,
 * full speed once a shift speeds things up by half again or more; continuous
 * in between.
 */
function naturalPace(speed: number, slow: number): number {
	return lerp(slow, 1, clamp01((speed - 1) / 0.5));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

/** Weave targets for one character (see LoomWeaveCharacter). */
function weaveTarget(out: LoomWeaveCharacter, c: Readonly<MusicCharacter>): LoomWeaveCharacter {
	out.flow = 0.4 + c.tempo * 1.3 + c.motion * 0.3;
	out.fray = smoothstep(0.3, 0.85, c.noise) * (0.7 + c.punch * 0.3);
	out.grain = clamp01(smoothstep(0.25, 0.9, c.noise) * 0.8 + (1 - c.brightness) * 0.15);
	out.turbulence = clamp01((c.noise - 0.2) * 1.1 + c.motion * 0.25);
	out.weight = clamp01(c.bass * 0.9 + c.energy * 0.2);
	out.edge = clamp01(c.punch);
	out.warmth = Math.max(-1, Math.min(1, (c.valence - 0.5) * 1.1 - (c.brightness - 0.5) * 1.0));
	out.value = 0.86 + c.brightness * 0.16 + c.energy * 0.1;
	return out;
}

/**
 * Loom's hearing: the shared character, with motion taken from the spectrum's
 * own rate of change (the shared motion barely moves between genres), energy
 * and valence stretched to the range real music spans, and a little spectral
 * steadying of brightness and noise. Tempo, shift serial and strength pass
 * through unchanged.
 */
type Heard = { -readonly [K in keyof MusicCharacter]: MusicCharacter[K] };

function createHeard(): Heard {
	return {
		vector: new Float32Array(8),
		tempo: 0.5,
		energy: 0.5,
		brightness: 0.45,
		bass: 0.5,
		noise: 0.2,
		punch: 0.4,
		motion: 0.4,
		valence: 0.5,
		contrast: 0,
		shift: 0,
		shiftSerial: 0,
		shiftStrength: 0,
		sinceShift: 1e6
	};
}

/** Look numbers that scale the figure on screen, and their top speed (log units per second). */
const SCALE_KEYS = new Set<string>(['frameScale', 'camDistance', 'focal']);
const SCALE_RATE = 0.42;
/**
 * Steady-state speed limits (per second) of the camera's angles and lens
 * shifts: a camera regime change is a slow drift of the whole frame, never a
 * swing, so the music shows through the parts. After a shift they lift
 * (see smooth), so new music is still seen from a new place at once.
 */
const ANGLE_RATE: Partial<Record<string, number>> = {
	camYaw: 0.07,
	camPitch: 0.05,
	camRoll: 0.04,
	lensShiftX: 0.03,
	lensShiftY: 0.02
};

/** Weave numbers that move the geometry glide slower after a shift than colour does. */
const WEAVE_GEOMETRY = new Set<string>(['flow', 'fray', 'turbulence', 'weight', 'edge', 'grain']);

const WEAVE_KEYS = ['flow', 'fray', 'grain', 'turbulence', 'weight', 'edge', 'warmth', 'value'] as const;

/**
 * White balance of the ribbons' own light: warm music shifts it toward amber,
 * cool toward blue. A property of the light sources, not an overlay.
 */
function whiteBalance(rgb: Rgb, warmth: number): void {
	const k = warmth * 0.32;
	rgb[0] = Math.max(0, rgb[0] * (1 + k * 0.7));
	rgb[1] = Math.max(0, rgb[1] * (1 + k * 0.08));
	rgb[2] = Math.max(0, rgb[2] * (1 - k * 0.75));
}

const NUMERIC_KEYS = [
	'strandCount',
	'density',
	'twist',
	'crossings',
	'spread',
	'symmetry',
	'curvature',
	'taper',
	'bead',
	'swell',
	'frameScale',
	'fill',
	'frameShiftX',
	'frameShiftY',
	'frameTilt',
	'camYaw',
	'camPitch',
	'camDistance',
	'camRoll',
	'focal',
	'lensShiftX',
	'lensShiftY',
	'floorY',
	'keyAzimuth',
	'keyElevation',
	'lightWarmth',
	'fillLevel',
	'trail',
	'bloom',
	'drift',
	'toneEmission',
	'toneDiffuse',
	'toneRoom',
	'toneMono',
	'toneBloom',
	'toneTrail'
] as const satisfies readonly (keyof LoomLookFrame)[];

const MATERIAL_KEYS = Object.keys(LOOM_MATERIALS[0]).filter((k) => k !== 'name') as Array<
	keyof Omit<LoomMaterial, 'name'>
>;
const ENV_KEYS = Object.keys(LOOM_ENVIRONMENTS[0]).filter((k) => k !== 'name') as Array<
	keyof Omit<LoomEnvironment, 'name'>
>;
const COLOUR_KEYS = ['hero', 'support', 'weft', 'deep', 'haze', 'glow'] as const;

function emptyFrame(): LoomLookFrame {
	const material = Object.fromEntries(MATERIAL_KEYS.map((k) => [k, LOOM_MATERIALS[0][k]])) as LoomLookFrame['material'];
	const env = Object.fromEntries(ENV_KEYS.map((k) => [k, LOOM_ENVIRONMENTS[0][k]])) as LoomLookFrame['env'];
	return {
		grammarFrom: 0,
		grammarTo: 0,
		grammarMix: 1,
		strandCount: 0,
		density: LOOM_GRAMMARS[0].density,
		twist: 0,
		crossings: 0.5,
		spread: 0.5,
		symmetry: 0.5,
		curvature: 0.5,
		taper: 1,
		bead: 0,
		swell: 0,
		frameScale: 1,
		fill: 0.9,
		frameShiftX: 0,
		frameShiftY: 0,
		frameTilt: 0,
		hero: [1, 0.5, 0.5],
		support: [0.5, 0.5, 1],
		weft: [1, 1, 0.5],
		deep: [0.002, 0.002, 0.004],
		haze: [0.05, 0.05, 0.1],
		glow: [0.4, 0.3, 0.2],
		material,
		env,
		camYaw: 0,
		camPitch: 0,
		camDistance: 1,
		camRoll: 0,
		focal: 3.08,
		lensShiftX: 0,
		lensShiftY: 0,
		floorY: LOOM_GRAMMARS[0].floor,
		orbit: 0,
		keyAzimuth: 0,
		keyElevation: 0.7,
		lightWarmth: 0.5,
		fillLevel: 0.6,
		beat: [1, 0, 0, 0, 0],
		trail: 0,
		bloom: 0,
		drift: 0,
		toneEmission: 1,
		toneDiffuse: 1,
		toneRoom: 0,
		weave: neutralWeave(),
		figure: neutralFigure(),
		pace: 0,
		toneMono: 0,
		toneBloom: 1,
		toneTrail: 0,
		exposure: createLoomExposure(),
		identity: 0.5,
		names: {
			grammar: LOOM_GRAMMARS[0].name,
			palette: LOOM_PALETTES[0].name,
			camera: LOOM_CAMERAS[0].name,
			material: LOOM_MATERIALS[0].name,
			environment: LOOM_ENVIRONMENTS[0].name,
			beatForm: LOOM_BEAT_FORMS[0],
			tone: LOOM_TONES[0].name,
			composition: LOOM_COMPOSITIONS[0].name
		},
		paletteIndex: 0,
		cameraIndex: 0,
		shifts: { shared: 0, local: 0, contrast: 0 }
	};
}

let globalOverride: LoomLookOverride | null = null;
/** QA (?loomMotion=camera:0,figure:0.5): scales the organic motion, for diagnosis. */
const motionQa = { camera: 1, figure: 1, genome: 1 };

export function setLoomMotionQa(text: string | null | undefined): void {
	motionQa.camera = 1;
	motionQa.figure = 1;
	motionQa.genome = 1;
	for (const part of (text ?? '').split(',')) {
		const [key, raw] = part.split(':');
		const value = Number(raw);
		if ((key === 'camera' || key === 'figure' || key === 'genome') && Number.isFinite(value)) motionQa[key] = Math.max(0, value);
	}
}

/**
 * QA hook: pin choice axes for every LoomLook (the Loom component sets it from
 * a `?loomLook=grammar=3,palette=5` URL parameter). Null clears it.
 */
export function setLoomLookOverride(override: LoomLookOverride | null): void {
	globalOverride = override;
}

/** Conductor rails carried from one song to the next (see LoomConductor). */
export type LoomRailCarry = { valid: boolean; readonly data: Float64Array };

/**
 * Long-listen look for Loom. One instance lives in the shared journey, so it
 * survives renderer remounts and carries the picture across songs: a hard
 * reset happens only for a new journey.
 */
export class LoomLook {
	readonly genome: VariationGenome;
	private warmed = false;
	private orbit = 0;
	private smoothedReady = false;
	private identity = 0.5;
	private readonly morphs: Record<LoomChoiceAxis, LoomChoiceMorph>;
	/** Raw genome palette option last seen, and the family it was latched to. */
	private paletteRaw = -1;
	private paletteTarget = 0;
	private readonly toneWeights: number[] = [];
	private readonly toneFit: number[] = [];
	private readonly fitWeights = {
		grammar: [] as number[],
		palette: [] as number[],
		camera: [] as number[],
		material: [] as number[],
		environment: [] as number[]
	};
	/**
	 * The character shift this look last answered. It lives with the
	 * journey-owned look, so a new source's conductor (or a remounted renderer)
	 * never answers the same shift twice.
	 */
	private answeredSerial = 0;
	/** Wall-clock dt of the frame being resolved (morph rate caps use it). */
	private realDt = 0;
	private weaveReady = false;
	private readonly weaveGoal = neutralWeave();
	private readonly heard = createHeard();
	/** Fast envelopes of the spectrum cues (centroid, motion, air). */
	private readonly cueEnvelope = new Float64Array(3);
	private cuesPrimed = false;
	/** Slow memory of the calibrated hearing, and seconds since any shift. */
	private readonly localSlow = new Float64Array(LOCAL_FEATURES);
	private localPrimed = false;
	private sinceAnyShift = 1e6;
	/** Seconds since a new source began, and how long the local contrast has held. */
	private sourceAge = 1e6;
	private localHeld = 0;
	/**
	 * Loom's own glide of the genome's continuous targets: the genome's glide
	 * in steady state, but after a shift every axis lands within about two
	 * seconds instead of creeping on for its full time constant.
	 */
	private readonly axisValues = new Map<string, number>();
	private axesReady = false;
	/** Phrase and section the genome sees (frozen during a post-shift hold). */
	private heldPhrase = 0;
	private heldSection = '';
	private realPhrase = Number.NaN;
	/** Seconds until a natural boundary is passed to the genome (-1: none). */
	private boundaryWait = -1;
	private realSection = '';
	private readonly target = emptyFrame();
	readonly frame = emptyFrame();
	private readonly scratch: Rgb = [0, 0, 0];
	private readonly exposureInput: LoomExposureInput;
	/**
	 * The conductor's slow rails at the end of the previous song, so a new
	 * song's conductor starts exactly where the picture is instead of at its
	 * intro defaults (that restart was the track-change jump cut).
	 */
	readonly carry: LoomRailCarry = { valid: false, data: new Float64Array(40) };
	/**
	 * Organic motion state. It lives here, in the journey-owned look, so a
	 * remount or a new song resumes the same journey instead of restarting it.
	 */
	private camRoam!: Roamer;
	private figureWander!: Wander;
	private envWander!: Wander;
	private axisWander!: Wander;
	/** Travelling-wave phases of the figure warp (radians, wrapped). */
	private readonly warpPhase = [0, 0, 0];
	/** Hybrid partner grammar; re-picked only while the hybrid is invisible. */
	private hybridGrammar = 0;
	private hybridPicks = 0;
	private hybridWasOn = false;
	/** Pace of the slow container (camera, figure): faster when the band is sparse. */
	private containerPace = 1;
	/** Pace of a new choice morph now, and the pace each morph in flight started at. */
	private pace = 1;
	private readonly morphPace: Partial<Record<LoomChoiceAxis, number>> = {};
	/** Floor margin under the deformed figure, smoothed. */
	private floorMargin = 0.1;
	private readonly roamView = new Float32Array(CAM_DIMS);
	private readonly figureView = new Float32Array(FIG_PERIODS.length);

	constructor(seed: number | string = 0) {
		this.genome = new VariationGenome(LOOM_LOOK_AXES, seed);
		const tauOf = (name: string) =>
			LOOM_LOOK_AXES.find((axis) => axis.name === name)?.tau ?? 3;
		this.morphs = Object.fromEntries(
			// A tone change relights the whole room (dark on light and back), so
			// a queued tone never rushes the one in flight much.
			CHOICE_AXES.map((name) => [name, new LoomChoiceMorph(tauOf(name), 0, name === 'tone' ? 1.3 : 2.4)])
		) as Record<LoomChoiceAxis, LoomChoiceMorph>;
		const f = this.frame;
		this.exposureInput = {
			hero: f.hero,
			support: f.support,
			weft: f.weft,
			haze: f.haze,
			glow: f.glow,
			material: f.material,
			density: 0,
			strandCount: 0,
			tone: { emission: 1, room: 0, bloom: 1, trail: 0 },
			env: f.env
		};
		this.reset(seed);
	}

	/**
	 * Stable per-journey identity in 0..1 (the seed of the last hard reset).
	 * The renderer hashes per-strand detail from it, so it must not change on a
	 * new song: a new hash would re-roll every strand at once.
	 */
	get identitySeed(): number {
		return this.identity;
	}

	/**
	 * A new source began (the journey rebuilt the conductor). Its shared
	 * strength-1 shift answers it; Loom's own ear stays quiet meanwhile.
	 */
	beginSource(): void {
		this.sourceAge = 0;
		this.localHeld = 0;
	}

	/** Carry the current look into a new source: only future mutations change. */
	continueWith(seed: number | string): void {
		this.genome.reseed(seed);
	}

	reset(seed: number | string): void {
		this.genome.reset(seed);
		this.identity = seedUnit(seed);
		this.warmed = false;
		this.paletteRaw = -1;
		this.orbit = 0;
		this.smoothedReady = false;
		this.weaveReady = false;
		this.axesReady = false;
		this.carry.valid = false;
		const key = `loom-motion:${typeof seed === 'number' ? seed.toFixed(9) : seed}`;
		this.camRoam = new Roamer(CAM_DIMS, `${key}:camera`, {
			meanHold: 22,
			minHold: 8,
			response: 3.6,
			wander: 0.16,
			wanderPeriod: 47
		});
		this.figureWander = new Wander(FIG_PERIODS.length, `${key}:figure`, FIG_PERIODS);
		this.envWander = new Wander(ENV_WANDER_KEYS.length, `${key}:place`, 57);
		this.axisWander = new Wander(
			CONTINUOUS_AXES.length,
			`${key}:axes`,
			CONTINUOUS_AXES.map(({ axis }) => axis.wanderPeriod ?? AXIS_WANDER_PERIOD[axis.scale])
		);
		this.warpPhase.fill(0);
		this.hybridGrammar = Math.floor(this.identity * LOOM_GRAMMARS.length) % LOOM_GRAMMARS.length;
		this.hybridPicks = 0;
		this.hybridWasOn = false;
		this.floorMargin = 0.1;
	}

	/** The last character shift this look answered (diagnostics, tests). */
	get answeredShift(): number {
		return this.answeredSerial;
	}

	/** Advance on one conductor tick and resolve the frame. */
	advance(context: LoomLookContext, override?: LoomLookOverride | null): Readonly<LoomLookFrame> {
		const energy = clamp01(context.energy);
		let first = false;
		if (!this.warmed) {
			// Give each opening section its own look: walk the genome through a
			// few virtual section boundaries, then settle so the first frame
			// already shows the result instead of gliding in from the seed state.
			this.warmed = true;
			first = true;
			const ordinal = Math.max(0, SECTION_ORDER.indexOf(context.sectionKey.split(':')[0]));
			const steps = 1 + ordinal;
			for (let i = 0; i < steps; i += 1) {
				this.genome.advance({ phraseIndex: -1000 - i, sectionKey: `warm-${i}`, energy: 0.5, dt: 0 });
			}
			// The last virtual step lands on the real phrase/section, so the
			// first real frame is not itself a boundary.
			this.genome.advance({
				phraseIndex: context.phraseIndex,
				sectionKey: context.sectionKey,
				energy: 0.5,
				dt: 0
			});
			this.genome.settle();
		}
		const character = this.hear(context.character ?? null, context.listen ?? null, context.dt);
		// Quiet songs lean toward drawn tones, loud ones toward glow, and
		// every big axis leans toward options that fit the music. Weights only
		// bias the next pick, so they never move the current scene. The song's
		// slow energy decides, not the section's.
		this.fit(character, clamp01(context.songEnergy ?? energy), 3);
		this.answerShift(character, energy, context.dt, context);
		// A scene just re-picked for new music establishes itself before it
		// evolves: phrase and section boundaries during the hold are skipped,
		// and the walk resumes at the next real boundary after it (never with a
		// catch-up boundary the moment the hold ends).
		// The same while the music is audibly changing: a section label that
		// flips with a station's new genre must not spend the morphs the shift
		// is about to need for picks that fit the new music.
		const holding =
			this.sinceAnyShift < SHIFT_HOLD_S || this.frame.shifts.contrast > 0.1 || motionQa.genome <= 0;
		const phraseMoved = context.phraseIndex !== this.realPhrase;
		const sectionMoved = context.sectionKey !== this.realSection;
		this.realPhrase = context.phraseIndex;
		this.realSection = context.sectionKey;
		// Natural boundaries land a beat late (BOUNDARY_DELAY_S), so a change
		// of music that is only just being heard can still claim them.
		if (first) {
			this.heldPhrase = context.phraseIndex;
			this.heldSection = context.sectionKey;
			this.boundaryWait = -1;
		} else if (phraseMoved || sectionMoved) {
			this.boundaryWait = holding ? -1 : BOUNDARY_DELAY_S;
		} else if (this.boundaryWait >= 0) {
			this.boundaryWait = holding ? -1 : Math.max(0, this.boundaryWait - Math.max(0, context.dt || 0));
		}
		if (this.boundaryWait === 0 && !holding) {
			this.heldPhrase = context.phraseIndex;
			this.heldSection = context.sectionKey;
			this.boundaryWait = -1;
		}
		this.genome.advance({
			phraseIndex: this.heldPhrase,
			sectionKey: this.heldSection,
			energy,
			dt: context.dt
		});
		// Loom's own morphs and smoothers run in step with the genome's glides,
		// which run several times faster for a few seconds after a shift.
		const speed = this.genome.glideSpeed;
		this.followAxes(context.dt, speed, first, energy);
		this.followCharacter(character, context.dt, speed);
		// The camera's pace and the figure's wander follow the song, not the
		// section: sections show through the ensemble's parts.
		this.roam(context, character, clamp01(context.songEnergy ?? energy));
		this.resolve(this.target, context, override ?? globalOverride, first, speed);
		this.smooth(context.dt, speed);
		this.shapeFigure();
		this.budget();
		this.frame.identity = this.identity;
		return this.frame;
	}

	/** The calibrated character Loom heard last frame (diagnostics, tests). */
	get hearing(): Readonly<MusicCharacter> | null {
		return this.cuesPrimed ? this.heard : null;
	}

	/** Calibrate the shared character into Loom's hearing (see Heard). */
	private hear(
		character: Readonly<MusicCharacter> | null,
		listen: LoomListenCues | null,
		dtSeconds: number
	): Readonly<MusicCharacter> | null {
		if (!character) return null;
		const h = this.heard;
		const env = this.cueEnvelope;
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		if (listen) {
			const cues = [listen.centroid, listen.motion, listen.air];
			// Quicker right after a shift, so the new music is heard at once.
			const tau = character.sinceShift < 2.5 ? 0.25 : 0.45;
			const k = this.cuesPrimed ? 1 - Math.exp(-dt / tau) : 1;
			for (let i = 0; i < 3; i += 1) {
				const value = Number.isFinite(cues[i]) ? cues[i] : env[i];
				env[i] += (value - env[i]) * k;
			}
			this.cuesPrimed = true;
		} else if (!this.cuesPrimed) {
			env[0] = 0.1;
			env[1] = 0.2;
			env[2] = 0.6;
			this.cuesPrimed = true;
		}
		const [centroid, motion, air] = env;
		h.tempo = character.tempo;
		h.energy = clamp01((character.energy - 0.18) / 0.35);
		// Timbre straight from the shared character (it spans real material);
		// the spectral centroid only steadies brightness a little.
		h.brightness = clamp01(character.brightness * 0.85 + clamp01((centroid - 0.03) / 0.18) * 0.15);
		h.bass = clamp01(character.bass);
		h.noise = clamp01(character.noise * 0.85 + clamp01(motion * 1.3 + (air - 0.6) * 0.9) * 0.15);
		h.punch = clamp01(character.punch / 0.9);
		h.motion = clamp01(motion / 0.45);
		h.valence = clamp01((character.valence - 0.5) / 0.22);
		h.contrast = character.contrast;
		h.shift = character.shift;
		h.shiftSerial = character.shiftSerial;
		h.shiftStrength = character.shiftStrength;
		h.sinceShift = character.sinceShift;
		const v = h.vector;
		v[0] = h.tempo;
		v[1] = h.energy;
		v[2] = h.brightness;
		v[3] = h.bass;
		v[4] = h.noise;
		v[5] = h.punch;
		v[6] = h.motion;
		v[7] = h.valence;
		return h;
	}

	/** Character-conditioned pick weights for the axes that set the scene. */
	private fit(character: Readonly<MusicCharacter> | null, energy: number, sharpness: number): void {
		const g = this.genome;
		const tone = loomToneWeights(energy, this.toneWeights);
		if (!character) {
			g.setWeights('tone', tone);
			return;
		}
		const w = this.fitWeights;
		g.setWeights('grammar', characterWeights(GRAMMAR_FIT, character, sharpness, 0.08, w.grammar));
		g.setWeights('palette', characterWeights(PALETTE_FIT, character, sharpness, 0.08, w.palette));
		g.setWeights('camera', characterWeights(CAMERA_FIT, character, sharpness, 0.1, w.camera));
		g.setWeights('material', characterWeights(MATERIAL_FIT, character, sharpness, 0.1, w.material));
		g.setWeights('environment', characterWeights(ENVIRONMENT_FIT, character, sharpness, 0.06, w.environment));
		characterWeights(TONE_FIT, character, sharpness, 0.1, this.toneFit);
		for (let i = 0; i < tone.length; i += 1) tone[i] *= this.toneFit[i] ?? 1;
		g.setWeights('tone', tone);
	}

	/**
	 * Answer a new character shift exactly once: re-pick the scene for the new
	 * music (sharper weights), mutate the genome now and steer the continuous
	 * axes toward the music. Everything still glides; the glides just run fast.
	 */
	private answerShift(
		character: Readonly<MusicCharacter> | null,
		energy: number,
		dtSeconds: number,
		context: LoomLookContext
	): void {
		if (!character) return;
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		this.sinceAnyShift += dt;
		this.sourceAge += dt;
		const serial = character.shiftSerial;
		if (Number.isFinite(serial) && serial !== this.answeredSerial) {
			const fresh = serial > this.answeredSerial;
			this.answeredSerial = serial;
			const strength = clamp01(character.shiftStrength);
			// A shift Loom already heard for itself a moment ago is the same event.
			if (fresh && strength > 0 && (this.sinceAnyShift > 3 || strength >= 0.99)) {
				this.applyShift(character, energy, strength, context);
				this.frame.shifts.shared += 1;
			}
			return;
		}
		const local = this.detect(character, dt);
		if (local > 0) {
			this.applyShift(character, energy, local, context);
			this.frame.shifts.local += 1;
		}
	}

	/**
	 * Loom's own ear: the shared tracker's timbre features barely move for real
	 * material, so a station drifting from swing to club can pass unnoticed.
	 * The calibrated hearing's fast envelopes are compared with a slow memory;
	 * a large enough difference is a shift (refractory, like the tracker's).
	 */
	private detect(c: Readonly<MusicCharacter>, dt: number): number {
		const now = [c.tempo, c.energy, c.brightness, c.bass, c.noise, c.punch];
		const slow = this.localSlow;
		if (!this.localPrimed) {
			for (let i = 0; i < LOCAL_FEATURES; i += 1) slow[i] = now[i];
			this.localPrimed = true;
			return 0;
		}
		// Right after a shift the envelopes are still settling on the new
		// music: keep re-referencing, so the settling is not a second shift.
		const settling = this.sinceAnyShift < 3 || this.sourceAge < 2.5;
		const k = settling ? 1 : 1 - Math.exp(-dt / LOCAL_SLOW_TAU_S);
		let distance = 0;
		for (let i = 0; i < LOCAL_FEATURES; i += 1) {
			slow[i] += (now[i] - slow[i]) * k;
			distance += Math.abs(now[i] - slow[i]) * LOCAL_WEIGHTS[i];
		}
		const contrast = distance / LOCAL_WEIGHT_SUM;
		this.frame.shifts.contrast = contrast;
		// The change must hold briefly, so the hearing has caught up with the
		// new music before the scene is re-picked for it.
		this.localHeld = contrast >= LOCAL_THRESHOLD ? this.localHeld + dt : 0;
		if (settling || this.sinceAnyShift < LOCAL_REFRACTORY_S || this.localHeld < 0.25) return 0;
		return clamp01(0.5 + (contrast - LOCAL_THRESHOLD) * 3);
	}

	private applyShift(
		character: Readonly<MusicCharacter>,
		energy: number,
		strength: number,
		context: LoomLookContext
	): void {
		this.sinceAnyShift = 0;
		// The new music becomes the reference, so one change fires once.
		const c0 = character;
		const now = [c0.tempo, c0.energy, c0.brightness, c0.bass, c0.noise, c0.punch];
		for (let i = 0; i < LOCAL_FEATURES; i += 1) this.localSlow[i] = now[i];
		this.localPrimed = true;
		this.fit(character, energy, 7);
		// Any shift that fires is a change of character: answer it with a whole
		// new scene (palette, place, camera, era), not a partial one.
		strength = Math.max(strength, 0.9);
		// Prefer a family that reads as a different colour world, and a place
		// built differently (threads or none, mist or mirror).
		const palettes = this.fitWeights.palette;
		const current = this.frame.paletteIndex;
		for (let i = 0; i < palettes.length; i += 1) {
			// Judge the family the option will actually land on (dark eras remap).
			const family = this.mapPalette(i, context);
			// Cubed: close to the best-fitting family in another colour world.
			palettes[i] = (palettes[i] * (0.02 + smoothstep(0.35, 0.9, paletteDistance(current, family)))) ** 3 + 1e-6;
		}
		this.genome.setWeights('palette', palettes);
		const places = this.fitWeights.environment;
		const here = this.frame.env;
		for (let i = 0; i < places.length; i += 1) {
			const e = LOOM_ENVIRONMENTS[i];
			const apart = Math.abs(e.threads - here.threads) + Math.abs(e.mist - here.mist) + Math.abs(e.reflect - here.reflect) * 0.5;
			places[i] *= 0.05 + Math.min(1, apart);
		}
		this.genome.setWeights('environment', places);
		const g = this.genome;
		g.shift(strength, Math.max(energy, character.energy));
		// The camera heads somewhere new at once, swinging round the figure as
		// it goes, so new music is seen from a new place within a second.
		this.camRoam.redirect();
		const swing = hashUnit(this.frame.shifts.shared + this.frame.shifts.local * 7 + 3, 0x5f1) < 0.5 ? -1 : 1;
		this.camRoam.impulse(CAM_YAW, swing * (0.5 + strength * 0.5));
		this.camRoam.impulse(CAM_ORBIT, swing * 0.8);
		const amount = 0.35 + strength * 0.4;
		const c = character;
		g.pull('strands', c.energy * 0.6 + c.noise * 0.4, amount);
		g.pull('twist', c.tempo, amount * 0.6);
		g.pull('crossings', c.punch * 0.5 + c.noise * 0.5, amount);
		g.pull('curvature', c.motion, amount * 0.6);
		g.pull('symmetry', 1 - c.noise, amount);
		g.pull('scale', 0.2 + c.bass * 0.6, amount * 0.6);
		g.pull('trail', 1 - c.tempo, amount);
		g.pull('bloom', c.energy, amount);
		g.pull('vivid', c.valence * 0.6 + c.energy * 0.4, amount);
		g.pull('lightWarmth', clamp01(0.5 + (c.valence - 0.5) * 1.2 - (c.brightness - 0.45) * 0.8), amount);
	}

	private axis(name: string): number {
		return this.axisValues.get(name) ?? this.genome.value(name);
	}

	private followAxes(dtSeconds: number, speed: number, first: boolean, energy: number): void {
		const targets = this.genome.targetVector();
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		// Fast for two seconds after a shift, back to the authored glide by six.
		const landing = 1 + 4 * Math.max(0, Math.min(1, (6 - this.sinceAnyShift) / 4));
		const fast = Math.max(speed, landing);
		const rate = fast * naturalPace(fast, 0.5);
		const snap = first || !this.axesReady;
		// Loom glides the genome's targets itself, so it adds the continuous
		// wander the genome gives its own eased values: no axis ever parks
		// between boundaries. A little faster in loud music, never still.
		const drift = this.axisWander.update(dt, 0.75 + energy * 0.5);
		CONTINUOUS_AXES.forEach(({ axis, index }, lane) => {
			const range = axis.max - axis.min;
			const amount = axis.wander ?? Math.min(0.12, axis.step * 0.6);
			let goal = axis.min + (targets[index] ?? 0.5) * range + drift[lane] * amount * range;
			if (axis.wrap) goal = axis.min + ((((goal - axis.min) % range) + range) % range);
			else {
				// Reflect at the bounds so the drift never sticks to an edge.
				if (goal > axis.max) goal = axis.max - (goal - axis.max);
				if (goal < axis.min) goal = axis.min + (axis.min - goal);
				goal = Math.min(axis.max, Math.max(axis.min, goal));
			}
			this.followAxis(axis, goal, dt, rate, snap);
		});
		this.axesReady = true;
	}

	private followAxis(
		axis: Extract<VariationAxis, { kind: 'continuous' }>,
		goal: number,
		dt: number,
		rate: number,
		snap: boolean
	): void {
		const range = axis.max - axis.min;
		const current = this.axisValues.get(axis.name);
		if (snap || current === undefined) {
			this.axisValues.set(axis.name, goal);
			return;
		}
		const k = 1 - Math.exp((-dt * rate) / Math.max(0.05, axis.tau));
		let delta = goal - current;
		if (axis.wrap) {
			delta = delta % range;
			if (delta > range / 2) delta -= range;
			if (delta < -range / 2) delta += range;
			let next = current + delta * k;
			next = axis.min + ((((next - axis.min) % range) + range) % range);
			this.axisValues.set(axis.name, next);
		} else {
			this.axisValues.set(axis.name, current + delta * k);
		}
	}

	/**
	 * Advance the organic motion: the camera's roam (tempo sets its pace,
	 * energy its restlessness, strong heard transients nudge it), the figure's
	 * wandering form, the place's wandering details and the warp phases.
	 */
	private roam(context: LoomLookContext, character: Readonly<MusicCharacter> | null, energy: number): void {
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(context.dt) ? context.dt : 0));
		const tempo = character ? character.tempo : 0.5;
		const restless = clamp01(energy * 0.7 + (character ? character.motion * 0.3 : 0.15));
		// The slow container breathes against the band: when the ensemble thins
		// out (a breakdown, an intro) the camera and the figure drift a little
		// more; when it is busy they hold and let the parts play. Transients no
		// longer nudge the camera: a hit belongs to its own part (ensemble.ts).
		const pace = lerp(1.45, 0.75, clamp01(context.busy ?? 0.5));
		this.containerPace = pace;
		this.camRoam.update(dt, (0.7 + tempo * 0.6) * pace, restless);
		const flow = this.frame.weave.flow;
		const fig = this.figureWander.update(dt, (0.6 + flow * 0.35 + energy * 0.2) * pace);
		this.envWander.update(dt, 0.8 + energy * 0.4);
		for (let i = 0; i < 3; i += 1) {
			const rate = (0.07 + 0.13 * (fig[FIG_WARP_RATE + i] * 0.5 + 0.5)) * (0.5 + flow * 0.6);
			// Alternate directions, so the waves cross rather than all run one way.
			const sign = i === 1 ? -1 : 1;
			this.warpPhase[i] = (this.warpPhase[i] + sign * rate * motionQa.figure * dt) % (Math.PI * 2);
		}
	}

	/**
	 * Resolve the figure's continuous form (LoomFigure) on the smoothed frame.
	 * Everything here is a wander, already smooth; only the hybrid partner is
	 * discrete, and it is re-picked only while the hybrid is fully off.
	 */
	private shapeFigure(): void {
		const f = this.frame;
		const out = f.figure;
		const w = this.figureView;
		for (let i = 0; i < w.length; i += 1) w[i] = this.figureWander.value[i] * motionQa.figure;
		const turb = f.weave.turbulence;
		out.twistY = w[FIG_TWIST_Y] * 0.62;
		out.twistX = w[FIG_TWIST_X] * 0.5;
		out.bend = w[FIG_BEND] * 0.3;
		out.flare = w[FIG_FLARE] * 0.32;
		out.tiltX = w[FIG_TILT_X] * 0.26;
		out.tiltZ = w[FIG_TILT_Z] * 0.3;
		out.laneGamma = Math.pow(2, w[FIG_GAMMA] * 0.55);
		// Churning music bends the figure further; still music holds its form.
		out.amount = clamp01(0.55 + w[FIG_AMOUNT] * 0.3 + turb * 0.35);
		const bases = [
			[1, 0.35, 0],
			[0, 1, 0.45],
			[0.4, 0, 1]
		];
		for (let i = 0; i < 3; i += 1) {
			let x = bases[i][0] + w[FIG_WARP_K + i * 3] * 0.9;
			let y = bases[i][1] + w[FIG_WARP_K + i * 3 + 1] * 0.9;
			let z = bases[i][2] + w[FIG_WARP_K + i * 3 + 2] * 0.9;
			const length = Math.hypot(x, y, z) || 1;
			const k = (1.5 + 0.9 * (w[FIG_WARP_K + i * 3] * 0.5 + 0.5)) / length;
			x *= k;
			y *= k;
			z *= k;
			out.warp[i * 4] = x;
			out.warp[i * 4 + 1] = y;
			out.warp[i * 4 + 2] = z;
			out.warp[i * 4 + 3] = 0.03 + 0.09 * (w[FIG_WARP_AMP + i] * 0.5 + 0.5);
			out.phase[i] = this.warpPhase[i];
		}
		const from = LOOM_GRAMMARS[f.grammarFrom] ?? LOOM_GRAMMARS[0];
		const to = LOOM_GRAMMARS[f.grammarTo] ?? LOOM_GRAMMARS[0];
		const centre = (g: LoomGrammar) => (g.reach[1] + g.reach[2]) * 0.5;
		out.centerY = lerp(centre(from), centre(to), f.grammarMix);
		// The hybrid is off about half the time; a new partner is chosen only
		// then, so the figure never swaps what it leans toward in view.
		const hybrid = smoothstep(0.05, 0.8, w[FIG_HYBRID]) * 0.42;
		if (hybrid <= 0) {
			if (this.hybridWasOn || out.hybridGrammar === f.grammarTo) {
				this.hybridPicks += 1;
				const pick = Math.floor(hashUnit(this.hybridPicks * 131 + 17, Math.floor(this.identity * 1e6)) * LOOM_GRAMMARS.length);
				let next = pick % LOOM_GRAMMARS.length;
				if (next === f.grammarTo || next === f.grammarFrom) next = (next + 5) % LOOM_GRAMMARS.length;
				this.hybridGrammar = next;
			}
			this.hybridWasOn = false;
		} else this.hybridWasOn = true;
		out.hybridGrammar = this.hybridGrammar;
		out.hybridMix = hybrid;
		f.pace = w[FIG_PACE];
	}

	/** Glide the character-driven weave parameters (seconds; under one after a shift). */
	private followCharacter(character: Readonly<MusicCharacter> | null, dtSeconds: number, speed: number): void {
		const goal = this.weaveGoal;
		if (character) weaveTarget(goal, character);
		else Object.assign(goal, neutralWeave());
		const weave = this.frame.weave;
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		// Slow in steady state, so beat-rate wobble in the hearing never tints
		// the scene; after a shift the genome's glide speed makes it fast.
		// Like the axes: fast for two seconds after a shift, so the new scene
		// settles and then holds instead of creeping on for several seconds.
		const landing = 1 + 4 * Math.max(0, Math.min(1, (6 - this.sinceAnyShift) / 4));
		const fast = Math.max(1, speed, landing);
		const ready = this.weaveReady;
		this.weaveReady = true;
		for (const key of WEAVE_KEYS) {
			// Colour lands in under a second after a shift; ribbon width,
			// churn and fraying take about a second, so the strands never jolt.
			const tau = WEAVE_GEOMETRY.has(key) ? Math.max(1.0, 2.2 / fast) : Math.max(0.6, 2.2 / fast ** 1.3);
			const k = ready ? 1 - Math.exp(-dt / tau) : 1;
			weave[key] = lerp(weave[key], goal[key], k);
		}
		Object.assign(this.target.weave, weave);
	}

	private choice(
		name: LoomChoiceAxis,
		override: LoomLookOverride | null,
		dt: number,
		first: boolean,
		target?: number
	): LoomChoiceView {
		const pinned = override?.[name];
		const goal =
			pinned !== undefined && Number.isFinite(pinned) ? pinned : (target ?? this.genome.choice(name).to);
		const morph = this.morphs[name];
		if (first) return morph.snap(goal);
		morph.realDt = this.realDt;
		// A morph keeps the pace it started at: one begun by a shift lands at
		// shift speed even as the glide eases back; a natural one stays slow.
		if (!morph.moving && goal !== morph.to) this.morphPace[name] = this.pace;
		// A shift arriving mid-morph hurries the morph in flight too.
		else if (morph.moving) this.morphPace[name] = Math.max(this.morphPace[name] ?? 1, this.pace);
		return morph.update(goal, dt * (this.morphPace[name] ?? 1), MORPH_MAX_RATE[name] ?? Infinity);
	}

	private mapPalette(raw: number, context: LoomLookContext): number {
		const vivid = this.axis('vivid');
		const family = LOOM_PALETTES[raw];
		const gate = hashUnit(raw * 31 + 7, this.genome.boundaries.sections);
		const energy = context.songEnergy ?? context.energy;
		if (family?.dark) {
			// Dark families only hold in low-vivid eras; bright major music lifts them.
			const keepDark = vivid < 0.38 && !(context.mode > 0.3 && energy > 0.62);
			if (!keepDark) return VIVID_PALETTES[(raw * 7 + this.genome.boundaries.eras) % VIVID_PALETTES.length];
		} else if (vivid < 0.25 && context.mode < -0.25 && energy < 0.45 && gate < 0.45) {
			return DARK_PALETTES[raw % DARK_PALETTES.length];
		}
		return raw;
	}

	private resolve(
		out: LoomLookFrame,
		context: LoomLookContext,
		override: LoomLookOverride | null,
		first: boolean,
		speed = 1
	): void {
		const g = this.genome;
		// Natural boundaries (no change of music) morph the scene slowly, so a
		// section change never turns the whole frame at once; the music shows
		// through the ensemble's parts instead. After a shift the glide speed
		// takes over and new music still lands within a couple of seconds.
		this.pace = naturalPace(speed, 0.55);
		const dt = context.dt * speed;
		this.realDt = Math.max(0, Math.min(0.5, Number.isFinite(context.dt) ? context.dt : 0));
		// Palette families are re-mapped once, at the moment a raw option becomes
		// the genome's target, so a crossfade never flips mid-way.
		const rawPalette = g.choice('palette').to;
		if (rawPalette !== this.paletteRaw) {
			this.paletteRaw = rawPalette;
			this.paletteTarget = this.mapPalette(rawPalette, context);
		}
		const grammar = this.choice('grammar', override, dt, first);
		const palette = this.choice('palette', override, dt, first, this.paletteTarget);
		const roles = this.choice('roles', override, dt, first);
		const camera = this.choice('camera', override, dt, first);
		const material = this.choice('material', override, dt, first);
		const environment = this.choice('environment', override, dt, first);
		const beatForm = this.choice('beatForm', override, dt, first);
		const thickness = this.choice('thickness', override, dt, first);
		const tone = this.choice('tone', override, dt, first);
		const composition = this.choice('composition', override, dt, first);

		out.grammarFrom = grammar.from;
		out.grammarTo = grammar.to;
		out.grammarMix = grammar.mix;
		const gFrom = LOOM_GRAMMARS[grammar.from] ?? LOOM_GRAMMARS[0];
		const gTo = LOOM_GRAMMARS[grammar.to] ?? LOOM_GRAMMARS[0];
		const strands = this.axis('strands');
		out.strandCount = lerp(
			lerp(gFrom.strands[0], gFrom.strands[1], strands),
			lerp(gTo.strands[0], gTo.strands[1], strands),
			grammar.mix
		);
		out.density = lerp(gFrom.density, gTo.density, grammar.mix);
		// The figure is centred on its bounds (LoomFigure.centerY) and bends,
		// leans and ripples; the floor sits under all of that, eased so it
		// settles slowly rather than bobbing with the figure.
		{
			const w = this.figureWander.value;
			const reachX = lerp(gFrom.reach[0], gTo.reach[0], grammar.mix);
			const margin =
				(Math.abs(w[FIG_TILT_X] * 0.26) + Math.abs(w[FIG_TILT_Z] * 0.3)) * reachX * 0.45 +
				Math.abs(w[FIG_BEND] * 0.3) * 0.5 +
				0.1;
			const k = first ? 1 : 1 - Math.exp(-Math.max(0, Math.min(0.25, context.dt)) / 6);
			this.floorMargin += (margin - this.floorMargin) * k;
			const centre = (g: LoomGrammar) => (g.reach[1] + g.reach[2]) * 0.5;
			out.floorY =
				lerp(gFrom.floor - centre(gFrom), gTo.floor - centre(gTo), grammar.mix) - this.floorMargin;
		}
		out.twist = this.axis('twist');
		out.crossings = this.axis('crossings');
		out.spread = this.axis('spread');
		out.symmetry = this.axis('symmetry');
		out.curvature = this.axis('curvature');
		const tFrom = LOOM_THICKNESS[thickness.from] ?? LOOM_THICKNESS[0];
		const tTo = LOOM_THICKNESS[thickness.to] ?? LOOM_THICKNESS[0];
		out.taper = lerp(tFrom.taper, tTo.taper, thickness.mix);
		out.bead = lerp(tFrom.bead, tTo.bead, thickness.mix);
		out.swell = lerp(tFrom.swell, tTo.swell, thickness.mix);

		const kFrom = LOOM_COMPOSITIONS[composition.from] ?? LOOM_COMPOSITIONS[0];
		const kTo = LOOM_COMPOSITIONS[composition.to] ?? LOOM_COMPOSITIONS[0];
		const compScale = lerp(kFrom.scale, kTo.scale, composition.mix);
		const framing = this.axis('framing');
		out.frameShiftX = framing * 0.1 + lerp(kFrom.shiftX, kTo.shiftX, composition.mix);
		out.frameShiftY = lerp(kFrom.shiftY, kTo.shiftY, composition.mix);
		out.frameTilt = framing * 0.06;

		// Palette: family crossfade, role permutation, key + drift hue lean.
		const famFrom = PALETTE_RGB[palette.from] ?? PALETTE_RGB[0];
		const famTo = PALETTE_RGB[palette.to] ?? PALETTE_RGB[0];
		const orderFrom = LOOM_ROLE_ORDERS[roles.from] ?? LOOM_ROLE_ORDERS[0];
		const orderTo = LOOM_ROLE_ORDERS[roles.to] ?? LOOM_ROLE_ORDERS[0];
		const hueLean = Math.sin(this.axis('hueDrift') * Math.PI * 2) * 0.045 + (context.key - 0.5) * 0.05;
		const roleColor = (fam: ResolvedPalette, slot: number): Rgb =>
			slot === 0 ? fam.hero : slot === 1 ? fam.support : fam.weft;
		const blendRole = (dst: Rgb, role: number) => {
			// Palette and role crossfades are independent: blend the family at
			// the palette mix under both role orders, then blend the orders.
			const fa = roleColor(famFrom, orderFrom[role]);
			const fb = roleColor(famTo, orderFrom[role]);
			const ga = roleColor(famFrom, orderTo[role]);
			const gb = roleColor(famTo, orderTo[role]);
			for (let c = 0; c < 3; c += 1) {
				const before = lerp(fa[c], fb[c], palette.mix);
				const after = lerp(ga[c], gb[c], palette.mix);
				this.scratch[c] = lerp(before, after, roles.mix);
			}
			rotateHue(dst, this.scratch, hueLean);
		};
		blendRole(out.hero, 0);
		blendRole(out.support, 1);
		blendRole(out.weft, 2);
		const warmth = this.frame.weave.warmth;
		whiteBalance(out.hero, warmth);
		whiteBalance(out.support, warmth);
		whiteBalance(out.weft, warmth);
		const blendEnv = (dst: Rgb, key: 'deep' | 'haze' | 'glow') => {
			for (let c = 0; c < 3; c += 1) this.scratch[c] = lerp(famFrom[key][c], famTo[key][c], palette.mix);
			rotateHue(dst, this.scratch, hueLean * 0.6);
		};
		blendEnv(out.deep, 'deep');
		blendEnv(out.haze, 'haze');
		blendEnv(out.glow, 'glow');
		out.paletteIndex = palette.to;

		// Tone: value structure. Mono collapses the roles onto the hero hue in
		// value steps; the mid-key room lifts the deep toward the haze.
		const oFrom = LOOM_TONES[tone.from] ?? LOOM_TONES[0];
		const oTo = LOOM_TONES[tone.to] ?? LOOM_TONES[0];
		const tm = tone.mix;
		out.toneEmission = lerp(oFrom.emission, oTo.emission, tm);
		out.toneDiffuse = lerp(oFrom.diffuse, oTo.diffuse, tm);
		out.toneRoom = lerp(oFrom.room, oTo.room, tm);
		out.toneMono = lerp(oFrom.mono, oTo.mono, tm);
		out.toneBloom = lerp(oFrom.bloom, oTo.bloom, tm);
		out.toneTrail = lerp(oFrom.trail, oTo.trail, tm);
		if (out.toneMono > 0.001) {
			const m = out.toneMono;
			const h = out.hero;
			const grey = (h[0] * 0.2126 + h[1] * 0.7152 + h[2] * 0.0722) * 1.5;
			for (let c = 0; c < 3; c += 1) {
				out.support[c] = lerp(out.support[c], h[c] * 0.34, m);
				out.weft[c] = lerp(out.weft[c], lerp(h[c], grey, 0.6) * 0.62, m);
				out.deep[c] = lerp(out.deep[c], h[c] * 0.01, m * 0.85);
				out.haze[c] = lerp(out.haze[c], h[c] * 0.06, m * 0.85);
				out.glow[c] = lerp(out.glow[c], h[c] * 0.55, m * 0.8);
			}
		}

		const mFrom = LOOM_MATERIALS[material.from] ?? LOOM_MATERIALS[0];
		const mTo = LOOM_MATERIALS[material.to] ?? LOOM_MATERIALS[0];
		for (const key of MATERIAL_KEYS) out.material[key] = lerp(mFrom[key], mTo[key], material.mix);
		out.material.diffuse *= out.toneDiffuse;
		const eFrom = LOOM_ENVIRONMENTS[environment.from] ?? LOOM_ENVIRONMENTS[0];
		const eTo = LOOM_ENVIRONMENTS[environment.to] ?? LOOM_ENVIRONMENTS[0];
		for (const key of ENV_KEYS) out.env[key] = lerp(eFrom[key], eTo[key], environment.mix);
		// Six families of place become a continuum: each detail (how much the
		// floor mirrors, how thick and how high the mist, how many far threads
		// and how ordered, how much dust) wanders round its family.
		const place = this.envWander.value;
		ENV_WANDER_KEYS.forEach((key, lane) => {
			out.env[key] = clamp01(out.env[key] + place[lane] * (ENV_WANDER[key] ?? 0));
		});

		const cFrom = LOOM_CAMERAS[camera.from] ?? LOOM_CAMERAS[0];
		const cTo = LOOM_CAMERAS[camera.to] ?? LOOM_CAMERAS[0];
		const cm = camera.mix;
		// The camera roams around the blended regime: regimes are regions of
		// the space, the Roamer travels it on springs between destinations
		// picked at irregular times, so no viewpoint is a path that returns.
		const roam = this.roamView;
		for (let i = 0; i < CAM_DIMS; i += 1) roam[i] = this.camRoam.value[i] * motionQa.camera;
		out.camYaw = lerp(cFrom.yaw, cTo.yaw, cm) + roam[CAM_YAW] * 0.6;
		out.camPitch = Math.max(-1.25, Math.min(0.55, lerp(cFrom.pitch, cTo.pitch, cm) + roam[CAM_PITCH] * 0.28));
		// Distance sets the perspective (near: steep and immersive, far: flat
		// and graphic); the figure is framed to the same fill either way.
		out.camDistance = Math.max(
			0.75,
			Math.min(1.5, Math.sqrt(lerp(cFrom.distance, cTo.distance, cm)) * Math.exp(roam[CAM_DOLLY] * 0.26))
		);
		out.camRoll = lerp(cFrom.roll, cTo.roll, cm) + out.frameTilt + roam[CAM_ROLL] * 0.1;
		out.focal = lerp(cFrom.focal, cTo.focal, cm) * Math.exp(roam[CAM_FOCAL] * 0.2);
		// Off-centre framings, but never so far that the figure leaves the frame.
		out.lensShiftX = clampSigned(
			lerp(cFrom.shiftX, cTo.shiftX, cm) + out.frameShiftX + roam[CAM_SHIFT_X] * 0.2,
			0.34
		);
		out.lensShiftY = clampSigned(
			lerp(cFrom.shiftY, cTo.shiftY, cm) + out.frameShiftY + roam[CAM_SHIFT_Y] * 0.1,
			0.18
		);
		// Orbit: the regime's held orbit, its direction a smooth function of
		// the drift axis (a hard sign flipped it in place), plus a roaming drift.
		const orbitRate =
			lerp(cFrom.orbit, cTo.orbit, cm) * Math.tanh(this.axis('drift') * 3) + roam[CAM_ORBIT] * 0.025;
		this.orbit += orbitRate * Math.max(0, Math.min(0.25, context.dt));
		out.orbit = this.orbit;

		// Framing: scale the figure so it owns the frame. Its bounds, turned to
		// the current view, are projected through the current lens; the fill
		// the camera roams around (about 0.65..1.2 of the frame's half-height,
		// sometimes overflowing it) sets how much of the frame it takes.
		const reachOf = (i: number) => lerp(gFrom.reach[i], gTo.reach[i], grammar.mix);
		const halfX = reachOf(0) * 1.32;
		const halfZ = reachOf(3) * 1.16;
		const halfY = (reachOf(2) - reachOf(1)) * 0.5 * 1.12;
		const yaw = STAGE_YAW + out.camYaw + this.orbit;
		const across = Math.max(
			Math.hypot(halfX * Math.cos(yaw), halfZ * Math.sin(yaw)),
			Math.max(halfX, halfZ) * 0.6
		);
		const deep = Math.hypot(halfX * Math.sin(yaw), halfZ * Math.cos(yaw));
		const pitch = out.camPitch - 0.18;
		const tall = Math.hypot(halfY * Math.cos(pitch), deep * Math.sin(pitch));
		const extent = Math.max(across / FRAME_ASPECT, tall, 0.2);
		// Owning the frame is not covering it: a figure that bleeds off every
		// edge reads as texture, so the fill stays under about 1.1 and the
		// framing leaves negative space on a side that moves.
		const fill = Math.max(
			0.6,
			Math.min(
				1.1,
				(0.86 + roam[CAM_FILL] * 0.2) *
					compScale *
					(0.94 + this.axis('scale') * 0.12) *
					(1.03 - out.density * 0.06) *
					(0.88 + out.camDistance * 0.12)
			)
		);
		out.fill = fill;
		out.frameScale = (fill * FRAME_DISTANCE * out.camDistance) / (Math.max(1, out.focal) * extent);
		out.cameraIndex = camera.to;

		out.keyAzimuth = this.axis('lightAzimuth');
		out.keyElevation = 0.55 + out.symmetry * 0.3;
		out.lightWarmth = this.axis('lightWarmth');
		out.fillLevel = 0.45 + (1 - out.lightWarmth) * 0.35;

		for (let i = 0; i < out.beat.length; i += 1) {
			out.beat[i] = (beatForm.from === i ? 1 - beatForm.mix : 0) + (beatForm.to === i ? beatForm.mix : 0);
		}
		out.trail = this.axis('trail');
		out.bloom = this.axis('bloom');
		out.drift = this.axis('drift');

		out.names.grammar = gTo.name;
		out.names.palette = LOOM_PALETTES[palette.to]?.name ?? 'unknown';
		out.names.camera = cTo.name;
		out.names.material = mTo.name;
		out.names.environment = eTo.name;
		out.names.beatForm = LOOM_BEAT_FORMS[beatForm.to] ?? LOOM_BEAT_FORMS[0];
		out.names.tone = oTo.name;
		out.names.composition = kTo.name;
	}

	/**
	 * A last, short glide over every resolved number, so nothing the genome
	 * does can produce a visible jump.
	 */
	private smooth(dtSeconds: number, speed = 1): void {
		const out = this.frame;
		const src = this.target;
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		const ready = this.smoothedReady;
		const k = ready ? 1 - Math.exp((-dt * Math.min(2, Math.max(1, speed))) / 0.35) : 1;
		this.smoothedReady = true;
		// Steady state: slow camera; for a few seconds after a shift: free.
		const landing = 1 + 4 * Math.max(0, Math.min(1, (6 - this.sinceAnyShift) / 4));
		// The camera keeps its freedom a little longer than the glides, so a
		// move begun for new music finishes at speed.
		const lift = Math.max(speed, landing) > 1.2 || this.sinceAnyShift < 10 ? 10 : this.containerPace;
		for (const key of NUMERIC_KEYS) {
			const previous = out[key];
			out[key] = lerp(previous, src[key], k);
			const angle = ANGLE_RATE[key];
			if (ready && angle !== undefined) {
				const limit = angle * lift * dt;
				out[key] = previous + Math.max(-limit, Math.min(limit, out[key] - previous));
			}
			// Scale travels at a bounded speed (log space), so a small figure
			// never balloons to fill the frame in a second: a zoom, not a cut.
			if (ready && SCALE_KEYS.has(key) && previous > 0 && out[key] > 0) {
				const limit = SCALE_RATE * (lift > 1 ? 1 : 0.35) * dt;
				const step = Math.log(out[key] / previous);
				if (Math.abs(step) > limit) out[key] = previous * Math.exp(Math.sign(step) * limit);
			}
		}
		for (const key of MATERIAL_KEYS) out.material[key] = lerp(out.material[key], src.material[key], k);
		for (const key of ENV_KEYS) out.env[key] = lerp(out.env[key], src.env[key], k);
		for (const key of COLOUR_KEYS) {
			for (let c = 0; c < 3; c += 1) out[key][c] = lerp(out[key][c], src[key][c], k);
		}
		for (let i = 0; i < out.beat.length; i += 1) out.beat[i] = lerp(out.beat[i], src.beat[i], k);
		// The grammar morph is continuous by construction (LoomChoiceMorph).
		out.grammarFrom = src.grammarFrom;
		out.grammarTo = src.grammarTo;
		out.grammarMix = src.grammarMix;
		out.orbit = src.orbit;
		out.paletteIndex = src.paletteIndex;
		out.cameraIndex = src.cameraIndex;
		Object.assign(out.names, src.names);
	}

	/** Resolve the light budget from the smoothed frame, so gains glide with it. */
	private budget(): void {
		const f = this.frame;
		const input = this.exposureInput;
		input.density = f.density;
		input.strandCount = f.strandCount;
		input.tone.emission = f.toneEmission;
		input.tone.room = f.toneRoom;
		input.tone.bloom = f.toneBloom;
		input.tone.trail = f.toneTrail;
		resolveLoomExposure(input, f.exposure);
		// Light value follows the music's brightness and mood after the budget
		// has normalised the palette, so it is not normalised away.
		const value = f.weave.value;
		f.exposure.heroGain *= value;
		f.exposure.supportGain *= value;
		f.exposure.weftGain *= value;
	}
}

/** Parse a QA override like `grammar=3,palette=5,camera=2`. */
export function parseLoomLookOverride(text: string | null | undefined): LoomLookOverride | null {
	if (!text) return null;
	const out: LoomLookOverride = {};
	const limits: Record<LoomChoiceAxis, number> = {
		grammar: LOOM_GRAMMARS.length,
		palette: LOOM_PALETTES.length,
		roles: LOOM_ROLE_ORDERS.length,
		camera: LOOM_CAMERAS.length,
		material: LOOM_MATERIALS.length,
		environment: LOOM_ENVIRONMENTS.length,
		beatForm: LOOM_BEAT_FORMS.length,
		thickness: LOOM_THICKNESS.length,
		tone: LOOM_TONES.length,
		composition: LOOM_COMPOSITIONS.length
	};
	for (const part of text.split(',')) {
		const [rawKey, rawValue] = part.split('=');
		const key = rawKey?.trim() as LoomChoiceAxis;
		if (!(key in limits)) continue;
		const value = Math.floor(Number(rawValue));
		if (Number.isFinite(value) && value >= 0 && value < limits[key]) out[key] = value;
	}
	return Object.keys(out).length ? out : null;
}
