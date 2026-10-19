// Loom's look: the long-listen variety layer on top of the conductor.
//
// The conductor and the audio stay in charge of reaction (beats, bands,
// tension, drops). This module owns *which* Loom you are looking at: the weave
// topology, the palette family and how its colours are cast, the fibre
// material, the camera regime, the environment and the form beats take. It is
// driven by the shared variation genome (src/lib/visualizer/variation.ts), so
// it mutates only on phrase, section and era boundaries, glides across them,
// never returns to a recent look and keeps moving on hours-long radio.
//
// Everything here is CPU-only and allocation-free per frame: the resolved
// `LoomLookFrame` is one reused object the renderer packs into uniforms.

import { VariationGenome, variationSpaceSize, type VariationAxis } from '$lib/visualizer/variation';
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
};

export const LOOM_GRAMMARS: readonly LoomGrammar[] = [
	{ name: 'ribbon', strands: [0, 0.3], scale: 1, density: 0.35 },
	{ name: 'canopy', strands: [0.4, 0.85], scale: 0.82, density: 0.85 },
	{ name: 'tunnel', strands: [0.4, 0.85], scale: 0.78, density: 0.95 },
	{ name: 'helix-tower', strands: [0.25, 0.7], scale: 0.88, density: 0.55 },
	{ name: 'mobius', strands: [0.4, 0.9], scale: 0.86, density: 0.6 },
	{ name: 'peacock', strands: [0.45, 0.9], scale: 0.86, density: 0.7 },
	{ name: 'braid', strands: [0, 0.5], scale: 0.88, density: 0.45 },
	{ name: 'string-hyperboloid', strands: [0.5, 0.9], scale: 0.84, density: 0.75 },
	{ name: 'saddle-lattice', strands: [0.45, 0.9], scale: 0.82, density: 0.8 },
	{ name: 'thread-galaxy', strands: [0.35, 0.8], scale: 0.72, density: 0.9 },
	{ name: 'trefoil', strands: [0.2, 0.65], scale: 0.9, density: 0.45 },
	{ name: 'orrery-rings', strands: [0.35, 0.8], scale: 0.86, density: 0.55 },
	{ name: 'aurora-curtain', strands: [0.45, 0.85], scale: 0.8, density: 0.85 }
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
// Camera regimes. Offsets on top of the conductor's patient camera rails.

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
	/** How much of the floor/horizon the environment shows from this angle. */
	floor: number;
	floorLine: number;
};

export const LOOM_CAMERAS: readonly LoomCameraRegime[] = [
	{ name: 'three-quarter', yaw: 0, pitch: 0, distance: 1, roll: 0, focal: 3.08, shiftX: 0, shiftY: 0, orbit: 0, floor: 1, floorLine: -0.17 },
	{ name: 'low-hero', yaw: -0.28, pitch: 0.34, distance: 0.86, roll: 0.05, focal: 2.75, shiftX: 0, shiftY: 0.1, orbit: 0, floor: 1, floorLine: -0.31 },
	{ name: 'top-down', yaw: 0.3, pitch: -1.08, distance: 1.02, roll: 0.45, focal: 3, shiftX: 0, shiftY: 0.02, orbit: 0.025, floor: 0.12, floorLine: -0.44 },
	{ name: 'axial', yaw: 0.95, pitch: -0.06, distance: 0.62, roll: 0, focal: 2.05, shiftX: 0, shiftY: 0.02, orbit: 0, floor: 0.45, floorLine: -0.27 },
	{ name: 'macro', yaw: 0.3, pitch: -0.14, distance: 0.72, roll: -0.07, focal: 3.6, shiftX: -0.16, shiftY: 0.05, orbit: 0, floor: 0.55, floorLine: -0.25 },
	{ name: 'slow-orbit', yaw: 0, pitch: -0.28, distance: 1.04, roll: 0, focal: 3, shiftX: 0, shiftY: 0, orbit: 0.085, floor: 1, floorLine: -0.15 },
	{ name: 'wide', yaw: -0.12, pitch: -0.2, distance: 1.42, roll: 0, focal: 3.15, shiftX: 0, shiftY: -0.02, orbit: 0, floor: 1, floorLine: -0.1 }
];

// ---------------------------------------------------------------------------
// Environments: coefficient sets for the composite pass.

export type LoomEnvironment = {
	name: string;
	floorMirror: number;
	ripple: number;
	fog: number;
	stars: number;
	sky: number;
	walls: number;
	pool: number;
	horizon: number;
	/** Off-centre glow source x (screen units), only read when sky > 0. */
	sunX: number;
};

export const LOOM_ENVIRONMENTS: readonly LoomEnvironment[] = [
	{ name: 'chamber', floorMirror: 1, ripple: 0, fog: 0, stars: 0, sky: 0, walls: 0, pool: 1, horizon: 1, sunX: 0.62 },
	{ name: 'open-sky', floorMirror: 0.55, ripple: 0.15, fog: 0.15, stars: 0, sky: 0.7, walls: 0, pool: 0.25, horizon: 1.2, sunX: -0.66 },
	{ name: 'water', floorMirror: 1.15, ripple: 1, fog: 0.1, stars: 0.25, sky: 0.35, walls: 0, pool: 0.4, horizon: 0.8, sunX: 0.7 },
	{ name: 'mirror-box', floorMirror: 1, ripple: 0, fog: 0, stars: 0, sky: 0, walls: 1, pool: 0.6, horizon: 0.6, sunX: 0.6 },
	{ name: 'fog-bank', floorMirror: 0.4, ripple: 0, fog: 0.7, stars: 0, sky: 0.2, walls: 0, pool: 0.7, horizon: 0.5, sunX: -0.55 },
	{ name: 'starfield', floorMirror: 0.6, ripple: 0.2, fog: 0, stars: 1, sky: 0.15, walls: 0, pool: 0.15, horizon: 0.45, sunX: 0.58 }
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
// light sits in the frame (light on dark, matte sculpture, ink on paper,
// monochrome, mid-key dusk) so scenes differ before any colour is read.

export type LoomTone = {
	name: string;
	/** Multiplies the fibre emission (glow vs lit surface). */
	emission: number;
	/** Multiplies the key/fill diffuse light (matte tones are lit, not glowing). */
	diffuse: number;
	/** 0 light on dark .. 1 ink on a pale paper room (dark on light). */
	paper: number;
	/** Lifts the room toward a mid-key haze. */
	room: number;
	/** Collapses the palette onto the hero hue in value steps. */
	mono: number;
	/** Bloom weight multiplier. */
	bloom: number;
	/** Feedback trail offset (negative = shorter). */
	trail: number;
};

export const LOOM_TONES: readonly LoomTone[] = [
	{ name: 'glow', emission: 1, diffuse: 1, paper: 0, room: 0, mono: 0, bloom: 1, trail: 0 },
	{ name: 'graphic', emission: 0.4, diffuse: 1.8, paper: 0, room: 0, mono: 0, bloom: 0.3, trail: -0.07 },
	{ name: 'ink', emission: 0.1, diffuse: 1.1, paper: 1, room: 0, mono: 0, bloom: 0.1, trail: -0.04 },
	{ name: 'mono', emission: 0.78, diffuse: 1.15, paper: 0, room: 0, mono: 1, bloom: 0.75, trail: 0 },
	{ name: 'dusk', emission: 0.5, diffuse: 1.25, paper: 0, room: 1, mono: 0, bloom: 0.5, trail: -0.03 }
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

// Compositions: where the figure sits and how much negative space it gets.
export type LoomComposition = { name: string; scale: number; shiftX: number; shiftY: number };

export const LOOM_COMPOSITIONS: readonly LoomComposition[] = [
	{ name: 'centre', scale: 1, shiftX: 0, shiftY: 0 },
	{ name: 'left-third', scale: 0.8, shiftX: -0.2, shiftY: 0.02 },
	{ name: 'right-third', scale: 0.8, shiftX: 0.2, shiftY: -0.02 },
	{ name: 'monument', scale: 1.12, shiftX: 0, shiftY: -0.05 },
	{ name: 'small-in-space', scale: 0.72, shiftX: 0.1, shiftY: 0.08 },
	{ name: 'high-horizon', scale: 0.86, shiftX: -0.06, shiftY: -0.12 }
];

// ---------------------------------------------------------------------------
// The genome.

export const LOOM_LOOK_AXES: readonly VariationAxis[] = [
	{ kind: 'choice', name: 'grammar', options: LOOM_GRAMMARS.length, scale: 'section', chance: 0.85, memory: 6, maxHold: 2, tau: 3.6 },
	{ kind: 'choice', name: 'palette', options: LOOM_PALETTES.length, scale: 'section', chance: 0.8, memory: 12, maxHold: 2, tau: 4.5 },
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
	{ kind: 'choice', name: 'tone', options: LOOM_TONES.length, scale: 'section', chance: 0.5, memory: 1, maxHold: 3, tau: 10 },
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

	update(target: number, dtSeconds: number): LoomChoiceView {
		const dt = Math.max(0, Math.min(0.5, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		if (this.progress >= 1 && target !== this.to) {
			this.from = this.to;
			this.to = target;
			this.progress = 0;
		}
		if (this.progress < 1) {
			const rate = (1 / Math.max(0.05, this.tau)) * (target !== this.to ? this.rush : 1);
			this.progress = Math.min(1, this.progress + dt * rate);
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
	floorAmount: number;
	floorLine: number;
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
	tonePaper: number;
	toneRoom: number;
	toneMono: number;
	toneBloom: number;
	toneTrail: number;
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
};

export type LoomLookContext = {
	phraseIndex: number;
	sectionKey: string;
	energy: number;
	/** -1 minor .. +1 major. */
	mode: number;
	/** 0..1 circle-of-fifths position. */
	key: number;
	dt: number;
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
	'floorAmount',
	'floorLine',
	'keyAzimuth',
	'keyElevation',
	'lightWarmth',
	'fillLevel',
	'trail',
	'bloom',
	'drift',
	'toneEmission',
	'toneDiffuse',
	'tonePaper',
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
		floorAmount: 1,
		floorLine: -0.17,
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
		tonePaper: 0,
		toneRoom: 0,
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
		cameraIndex: 0
	};
}

let globalOverride: LoomLookOverride | null = null;

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
			tone: { emission: 1, paper: 0, room: 0, bloom: 1, trail: 0 },
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
		this.carry.valid = false;
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
		// Quiet passages lean toward drawn tones, loud ones toward glow. Weights
		// only bias the next pick, so they never move the current scene.
		this.genome.setWeights('tone', loomToneWeights(energy, this.toneWeights));
		this.genome.advance({
			phraseIndex: context.phraseIndex,
			sectionKey: context.sectionKey,
			energy,
			dt: context.dt
		});
		this.resolve(this.target, context, override ?? globalOverride, first);
		this.smooth(context.dt);
		this.budget();
		this.frame.identity = this.identity;
		return this.frame;
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
		return first ? morph.snap(goal) : morph.update(goal, dt);
	}

	private mapPalette(raw: number, context: LoomLookContext): number {
		const vivid = this.genome.value('vivid');
		const family = LOOM_PALETTES[raw];
		const gate = hashUnit(raw * 31 + 7, this.genome.boundaries.sections);
		if (family?.dark) {
			// Dark families only hold in low-vivid eras; bright major music lifts them.
			const keepDark = vivid < 0.38 && !(context.mode > 0.3 && context.energy > 0.62);
			if (!keepDark) return VIVID_PALETTES[(raw * 7 + this.genome.boundaries.eras) % VIVID_PALETTES.length];
		} else if (vivid < 0.25 && context.mode < -0.25 && context.energy < 0.45 && gate < 0.45) {
			return DARK_PALETTES[raw % DARK_PALETTES.length];
		}
		return raw;
	}

	private resolve(
		out: LoomLookFrame,
		context: LoomLookContext,
		override: LoomLookOverride | null,
		first: boolean
	): void {
		const g = this.genome;
		const dt = context.dt;
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
		const strands = g.value('strands');
		out.strandCount = lerp(
			lerp(gFrom.strands[0], gFrom.strands[1], strands),
			lerp(gTo.strands[0], gTo.strands[1], strands),
			grammar.mix
		);
		out.density = lerp(gFrom.density, gTo.density, grammar.mix);
		out.twist = g.value('twist');
		out.crossings = g.value('crossings');
		out.spread = g.value('spread');
		out.symmetry = g.value('symmetry');
		out.curvature = g.value('curvature');
		const tFrom = LOOM_THICKNESS[thickness.from] ?? LOOM_THICKNESS[0];
		const tTo = LOOM_THICKNESS[thickness.to] ?? LOOM_THICKNESS[0];
		out.taper = lerp(tFrom.taper, tTo.taper, thickness.mix);
		out.bead = lerp(tFrom.bead, tTo.bead, thickness.mix);
		out.swell = lerp(tFrom.swell, tTo.swell, thickness.mix);

		const kFrom = LOOM_COMPOSITIONS[composition.from] ?? LOOM_COMPOSITIONS[0];
		const kTo = LOOM_COMPOSITIONS[composition.to] ?? LOOM_COMPOSITIONS[0];
		const compScale = lerp(kFrom.scale, kTo.scale, composition.mix);
		const scaleAxis = g.value('scale');
		// Dense grammars sit a little smaller so they keep negative space round them.
		out.frameScale =
			lerp(gFrom.scale, gTo.scale, grammar.mix) * (0.88 + scaleAxis * 0.24) * compScale * (1.04 - out.density * 0.08);
		const framing = g.value('framing');
		out.frameShiftX = framing * 0.1 + lerp(kFrom.shiftX, kTo.shiftX, composition.mix);
		out.frameShiftY = lerp(kFrom.shiftY, kTo.shiftY, composition.mix);
		out.frameTilt = framing * 0.06;

		// Palette: family crossfade, role permutation, key + drift hue lean.
		const famFrom = PALETTE_RGB[palette.from] ?? PALETTE_RGB[0];
		const famTo = PALETTE_RGB[palette.to] ?? PALETTE_RGB[0];
		const orderFrom = LOOM_ROLE_ORDERS[roles.from] ?? LOOM_ROLE_ORDERS[0];
		const orderTo = LOOM_ROLE_ORDERS[roles.to] ?? LOOM_ROLE_ORDERS[0];
		const hueLean = Math.sin(g.value('hueDrift') * Math.PI * 2) * 0.045 + (context.key - 0.5) * 0.05;
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
		out.tonePaper = lerp(oFrom.paper, oTo.paper, tm);
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
		if (out.toneRoom > 0.001) {
			const r = out.toneRoom;
			for (let c = 0; c < 3; c += 1) {
				out.deep[c] = lerp(out.deep[c], out.haze[c] * 1.1 + out.glow[c] * 0.03, r * 0.75);
			}
		}

		const mFrom = LOOM_MATERIALS[material.from] ?? LOOM_MATERIALS[0];
		const mTo = LOOM_MATERIALS[material.to] ?? LOOM_MATERIALS[0];
		for (const key of MATERIAL_KEYS) out.material[key] = lerp(mFrom[key], mTo[key], material.mix);
		out.material.diffuse *= out.toneDiffuse;
		const eFrom = LOOM_ENVIRONMENTS[environment.from] ?? LOOM_ENVIRONMENTS[0];
		const eTo = LOOM_ENVIRONMENTS[environment.to] ?? LOOM_ENVIRONMENTS[0];
		for (const key of ENV_KEYS) out.env[key] = lerp(eFrom[key], eTo[key], environment.mix);

		const cFrom = LOOM_CAMERAS[camera.from] ?? LOOM_CAMERAS[0];
		const cTo = LOOM_CAMERAS[camera.to] ?? LOOM_CAMERAS[0];
		const cm = camera.mix;
		out.camYaw = lerp(cFrom.yaw, cTo.yaw, cm);
		out.camPitch = lerp(cFrom.pitch, cTo.pitch, cm);
		out.camDistance = lerp(cFrom.distance, cTo.distance, cm);
		out.camRoll = lerp(cFrom.roll, cTo.roll, cm) + out.frameTilt;
		out.focal = lerp(cFrom.focal, cTo.focal, cm);
		out.lensShiftX = lerp(cFrom.shiftX, cTo.shiftX, cm) + out.frameShiftX;
		out.lensShiftY = lerp(cFrom.shiftY, cTo.shiftY, cm) + out.frameShiftY;
		out.floorAmount = lerp(cFrom.floor, cTo.floor, cm);
		out.floorLine = lerp(cFrom.floorLine, cTo.floorLine, cm);
		const orbitRate = lerp(cFrom.orbit, cTo.orbit, cm);
		const drift = g.value('drift');
		this.orbit += orbitRate * (drift >= 0 ? 1 : -1) * Math.max(0, Math.min(0.25, context.dt));
		out.orbit = this.orbit;
		out.cameraIndex = camera.to;

		out.keyAzimuth = g.value('lightAzimuth');
		out.keyElevation = 0.55 + out.symmetry * 0.3;
		out.lightWarmth = g.value('lightWarmth');
		out.fillLevel = 0.45 + (1 - out.lightWarmth) * 0.35;

		for (let i = 0; i < out.beat.length; i += 1) {
			out.beat[i] = (beatForm.from === i ? 1 - beatForm.mix : 0) + (beatForm.to === i ? beatForm.mix : 0);
		}
		out.trail = g.value('trail');
		out.bloom = g.value('bloom');
		out.drift = drift;

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
	private smooth(dtSeconds: number): void {
		const out = this.frame;
		const src = this.target;
		const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSeconds) ? dtSeconds : 0));
		const k = this.smoothedReady ? 1 - Math.exp(-dt / 0.35) : 1;
		this.smoothedReady = true;
		for (const key of NUMERIC_KEYS) out[key] = lerp(out[key], src[key], k);
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
		input.tone.paper = f.tonePaper;
		input.tone.room = f.toneRoom;
		input.tone.bloom = f.toneBloom;
		input.tone.trail = f.toneTrail;
		resolveLoomExposure(input, f.exposure);
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
