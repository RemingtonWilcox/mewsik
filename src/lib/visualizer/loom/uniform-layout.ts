// Loom's uniform contract is declared once here so TypeScript packing and the
// WGSL `Params` struct cannot silently diverge. The WGSL struct in shaders.ts
// mirrors these groups in the same order, with a machine-checkable comment
// above each field listing the four slot names. e2e/loom-uniform-contract
// enforces that both sides agree.

export const LOOM_UNIFORM_GROUPS = [
	['view', ['width', 'height', 'elapsed', 'responseMotion']],
	['pulse', ['impact', 'reweave', 'sectionPulse', 'beatPhase']],
	['audioA', ['rms', 'sub', 'kick', 'body']],
	['audioB', ['mids', 'presence', 'air', 'centroid']],
	['macroRails', ['energy', 'spectralMotion', 'spectralLean', 'tempo']],
	['shape', ['tension', 'release', 'openness', 'dropOpenness']],
	['shapeB', ['curl', 'sway', 'braid', 'twist']],
	['grammar', ['knot', 'cage', 'saddle', 'helix']],
	['palette', ['baseHue', 'accentHue', 'rimHue', 'saturation']],
	['camera', ['yaw', 'pitch', 'distance', 'roll']],
	['cloth', ['beatConveyor', 'swayPhase', 'weftSparse', 'driftPhase']],
	['style', ['warpRadius', 'weftRadius', 'glow', 'silence']],
	['harmony', ['seedHi', 'seedLo', 'key', 'mode']],
	['post', ['feedbackFade', 'feedbackZoom', 'bloomThreshold', 'aberration']]
] as const;

export const LOOM_UNIFORM_FLOATS = LOOM_UNIFORM_GROUPS.length * 4;
export const LOOM_UNIFORM_BYTES = LOOM_UNIFORM_FLOATS * 4;

export type LoomUniformGroupName = (typeof LOOM_UNIFORM_GROUPS)[number][0];
export type LoomUniformSlot = (typeof LOOM_UNIFORM_GROUPS)[number][1][number];
export type LoomUniformValues = Record<LoomUniformSlot, number>;

/** Pack named values into the 56-float uniform block in contract order. */
export function packLoomUniforms(
	out: Float32Array,
	values: Readonly<LoomUniformValues>
): Float32Array {
	if (out.length < LOOM_UNIFORM_FLOATS) {
		throw new RangeError(`Loom uniform buffer needs ${LOOM_UNIFORM_FLOATS} floats.`);
	}
	let offset = 0;
	for (const [, slots] of LOOM_UNIFORM_GROUPS) {
		for (const slot of slots) {
			const value = values[slot];
			out[offset] = Number.isFinite(value) ? value : 0;
			offset += 1;
		}
	}
	return out;
}
