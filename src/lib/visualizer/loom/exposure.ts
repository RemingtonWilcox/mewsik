// Loom's light budget: form over glow.
//
// Every look (palette x material x grammar x tone x environment) is a
// different amount of light. Left alone, bright families on emissive materials
// in dense topologies stack into one clipped, noisy blob and the figure is lost.
// This module turns the resolved look into gains that keep each look inside
// one exposure budget and keep the hierarchy readable: the hero rail leads,
// support rails sit under it, weft and chorus strands are structure, not glow.
//
// Pure and allocation-free per call (writes into a reused output object), so
// the e2e specs can test it directly and the conductor can run it per frame.

export type LoomRgb = readonly [number, number, number];

export type LoomExposureInput = {
	hero: LoomRgb;
	support: LoomRgb;
	weft: LoomRgb;
	haze: LoomRgb;
	glow: LoomRgb;
	material: {
		diffuse: number;
		gloss: number;
		emissive: number;
		mirror: number;
		whiteCore: number;
		sheen: number;
		hotspot: number;
		pale: number;
	};
	/** 0..1 how crowded the current grammar is (blended across a morph). */
	density: number;
	/** 0..1 fraction of chorus strands shown. */
	strandCount: number;
	/** Tone coefficients (see LOOM_TONES in look.ts). */
	tone: { emission: number; paper: number; room: number; bloom: number; trail: number };
	/** Environment brightness terms. */
	env: { sky: number; fog: number; walls: number; floorMirror: number };
};

export type LoomExposure = {
	/** Colour gains for the three roles; keep hero > support > weft in value. */
	heroGain: number;
	supportGain: number;
	weftGain: number;
	/** Chorus strand radius and emission multipliers (thin and quiet when dense). */
	chorusWidth: number;
	chorusGlow: number;
	/** Multiplies the whole lit fibre colour (material normalisation). */
	litGain: number;
	/** Multiplies the emissive term only (tone and density). */
	emissionGain: number;
	/** Room terms. */
	hazeGain: number;
	glowGain: number;
	/** Global composite exposure. */
	envGain: number;
	/** Bloom: additive weight and threshold offset. */
	bloomWeight: number;
	bloomThresholdOffset: number;
	/** Added to the feedback fade: negative shortens trails. */
	trailOffset: number;
	/** 0..1 how busy the frame is (density x strands x light). */
	busy: number;
	/** Estimated relative light of the look before normalisation (diagnostic). */
	rawLight: number;
};

export function createLoomExposure(): LoomExposure {
	return {
		heroGain: 1,
		supportGain: 0.75,
		weftGain: 0.6,
		chorusWidth: 1,
		chorusGlow: 1,
		litGain: 1,
		emissionGain: 1,
		hazeGain: 1,
		glowGain: 1,
		envGain: 1,
		bloomWeight: 1,
		bloomThresholdOffset: 0,
		trailOffset: 0,
		busy: 0,
		rawLight: 1
	};
}

function clamp(value: number, low: number, high: number): number {
	if (!Number.isFinite(value)) return low;
	return value < low ? low : value > high ? high : value;
}

function luminance(c: LoomRgb): number {
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * How hard a colour pushes toward clipping: its peak channel, with a penalty
 * for whiteness (every channel high clips all three at once) and luminance.
 */
export function loomColourIntensity(c: LoomRgb): number {
	const peak = Math.max(c[0], c[1], c[2], 1e-4);
	const low = Math.min(c[0], c[1], c[2]);
	const whiteness = low / peak;
	return peak * (0.62 + whiteness * 0.5) + luminance(c) * 0.28;
}

/** Relative light a material emits/reflects at rest (glass fibre is about 1). */
export function loomMaterialLight(m: LoomExposureInput['material']): number {
	return (
		0.3 +
		m.emissive * 0.5 +
		m.whiteCore * 0.22 +
		m.mirror * 0.16 +
		m.gloss * 0.05 +
		m.diffuse * 0.1 +
		m.sheen * 0.07 +
		m.hotspot * 0.1 +
		m.pale * 0.12
	);
}

/** Role value targets: the hero leads, support sits under it, weft is structure. */
const HERO_TARGET = 0.76;
const SUPPORT_TARGET = 0.52;
const WEFT_TARGET = 0.44;

/**
 * Resolve the exposure budget for one look. Every output is bounded and
 * finite; equal inputs give equal outputs, so it can be tested off-GPU.
 */
export function resolveLoomExposure(input: LoomExposureInput, out: LoomExposure): LoomExposure {
	const density = clamp(input.density, 0, 1);
	const strands = clamp(input.strandCount, 0, 1);
	const tone = input.tone;
	const paper = clamp(tone.paper, 0, 1);

	// Palette normalisation: the same perceived intensity whatever the family,
	// so a white-hot family is not twice as bright as a deep one.
	const heroIntensity = loomColourIntensity(input.hero);
	const supportIntensity = loomColourIntensity(input.support);
	out.heroGain = clamp(HERO_TARGET / heroIntensity, 0.45, 1.25);
	out.supportGain = clamp(SUPPORT_TARGET / supportIntensity, 0.2, 1);
	out.weftGain = clamp(WEFT_TARGET / loomColourIntensity(input.weft), 0.28, 0.9);
	// The support never out-shines the hero, whatever the role permutation
	// handed each of them (a dim hero colour with a bright support).
	out.supportGain = Math.max(0.12, Math.min(out.supportGain, (heroIntensity * out.heroGain * 0.85) / supportIntensity));

	// Material normalisation: neon and molten glass emit far more than silk.
	const materialLight = loomMaterialLight(input.material);
	out.litGain = clamp(0.92 / materialLight, 0.42, 1.12);

	// Busy: how much of the frame is strands. Dense grammars with every chorus
	// strand shown are the worst blob offenders.
	const busy = clamp(density * (0.35 + strands * 0.65), 0, 1);
	out.busy = busy;
	// Thin, not sub-pixel: strands narrower than about two pixels alias into noise.
	out.chorusWidth = clamp(1 - busy * 0.3, 0.72, 1);
	out.chorusGlow = clamp(0.78 - busy * 0.5, 0.25, 0.8);
	out.emissionGain = clamp(tone.emission * (1 - busy * 0.3), 0.06, 1.2);

	// Light the look would have before normalisation, for bloom and trails.
	const paletteLight =
		(loomColourIntensity(input.hero) * 0.5 +
			loomColourIntensity(input.support) * 0.3 +
			loomColourIntensity(input.weft) * 0.2) /
		0.85;
	const rawLight = paletteLight * materialLight * (0.7 + tone.emission * 0.3) * (1 + busy * 0.6);
	out.rawLight = rawLight;

	// Room: dense palettes of haze lift the whole frame; keep the room behind
	// the figure, and lift it on purpose only in the mid-key tone.
	const hazeLight = loomColourIntensity(input.haze) + 1e-3;
	const roomBase = clamp(0.22 / hazeLight, 0.4, 1.3) * (1 - busy * 0.3);
	out.hazeGain = clamp(roomBase * (1 + tone.room * 1.6) * (1 - paper * 0.6), 0.25, 3);
	out.glowGain = clamp((0.9 / (loomColourIntensity(input.glow) + 0.2)) * (1 - busy * 0.25), 0.4, 1.1);

	const envLight = input.env.sky * 0.15 + input.env.fog * 0.15 + input.env.walls * 0.2 + input.env.floorMirror * 0.06;
	out.envGain = clamp(0.92 - envLight * 0.12 - busy * 0.06, 0.7, 1);

	// Bloom is an accent: lighter looks bloom less and from a higher knee.
	const over = Math.max(0, rawLight - 0.9);
	out.bloomWeight = clamp(tone.bloom * (0.62 - busy * 0.22 - over * 0.18), 0.04, 0.7);
	out.bloomThresholdOffset = clamp(0.12 + busy * 0.14 + over * 0.16, 0.08, 0.45);

	// Trails: shorter when the scene is busy so they never smear into fog.
	out.trailOffset = clamp(tone.trail - busy * 0.11 - over * 0.03, -0.18, 0.02);
	return out;
}
