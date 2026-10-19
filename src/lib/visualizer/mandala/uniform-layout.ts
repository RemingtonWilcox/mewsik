// Mandala's uniform contract, declared once so the TypeScript packing and the
// WGSL `Params` struct cannot silently diverge. The struct in shaders.ts
// mirrors these groups in the same order, with a machine-checkable comment
// above each field listing its four slot names; e2e/mandala-uniform-contract
// enforces that both sides agree.

export const MANDALA_UNIFORM_GROUPS = [
	['view', ['width', 'height', 'frame', 'focal']],
	// Camera: look direction, lateral offset from the tunnel axis.
	['camera', ['yaw', 'pitch', 'offsetX', 'offsetY']],
	// roll and spiral spin are angles; kick is the push envelope.
	['spinRail', ['roll', 'spin', 'kick', 'silence']],
	// Wall travel: integer and fractional cell rows, phyllotaxis lattice offsets.
	['wallTravel', ['wallRow', 'wallFrac', 'wallPhylloX', 'wallPhylloY']],
	// hyperbolic band phase, cells per log unit, cells per half sector, phyllotaxis seed row
	['wallScale', ['wallHyper', 'wallCells', 'wallHalf', 'wallSeedRow']],
	['screenTravel', ['screenRow', 'screenFrac', 'screenPhylloX', 'screenPhylloY']],
	['screenScale', ['screenHyper', 'screenCells', 'screenHalf', 'screenSeedRow']],
	// Wall grammar slots: family*4+variant, fold sectors; A fades to B.
	['wallSlots', ['wallGrammarA', 'wallFoldA', 'wallGrammarB', 'wallFoldB']],
	['screenSlots', ['screenGrammarA', 'screenFoldA', 'screenGrammarB', 'screenFoldB']],
	['slotMix', ['wallMix', 'screenMix', 'screenAmount', 'screenRadius']],
	// Tunnel cross-section: polygon sides (0 = round) A fades to B.
	['shape', ['shapeA', 'shapeB', 'shapeMix', 'shapeTurn']],
	['form', ['lineWidth', 'relief', 'morph', 'fracture']],
	// Phyllotaxis reduced lattice bases (cells) and seed-index coefficients.
	['wallPhyllo', ['wallE1x', 'wallE1y', 'wallE2x', 'wallE2y']],
	['screenPhyllo', ['screenE1x', 'screenE1y', 'screenE2x', 'screenE2y']],
	['phylloIndex', ['wallN1', 'wallN2', 'screenN1', 'screenN2']],
	['stoneTint', ['stoneR', 'stoneG', 'stoneB', 'stoneGloss']],
	['metalTint', ['metalR', 'metalG', 'metalB', 'metalGain']],
	['glowTint', ['glowR', 'glowG', 'glowB', 'glowGain']],
	['accentTint', ['accentR', 'accentG', 'accentB', 'accentGain']],
	['rigTint', ['rigR', 'rigG', 'rigB', 'rigGain']],
	['sconceTint', ['sconceR', 'sconceG', 'sconceB', 'sconceGain']],
	['fogTint', ['fogR', 'fogG', 'fogB', 'fogDensity']],
	// Two camera-carried rig lights (camera space) and their shared softness.
	['rigA', ['rigAx', 'rigAy', 'rigAz', 'rigSoft']],
	['rigB', ['rigBx', 'rigBy', 'rigBz', 'rigBalance']],
	// The rigs are spots: aim angle round the axis, how far down the tunnel, cone width.
	['spots', ['spotA', 'spotB', 'spotReach', 'spotCone']],
	// Sconces along the wall: log spacing, travel phase, spiral turn per sconce, angle offset.
	['sconce', ['sconceSpacing', 'sconcePhase', 'sconceTurn', 'sconceAngle']],
	// Beat rings rushing out of the depths: camera depth and strength, two per slot.
	['ringsA', ['ring0z', 'ring0s', 'ring1z', 'ring1s']],
	['ringsB', ['ring2z', 'ring2s', 'ring3z', 'ring3s']],
	['ringsC', ['ring4z', 'ring4s', 'ring5z', 'ring5s']],
	['audio', ['energy', 'bass', 'treble', 'beatGlow']],
	['band', ['sub', 'kickBand', 'body', 'presence']],
	['character', ['harsh', 'warmth', 'punch', 'iridescence']],
	['post', ['feedbackFade', 'feedbackZoom', 'bloomThreshold', 'aberration']],
	['postB', ['vanishX', 'vanishY', 'feedbackRoll', 'exposure']],
	['postC', ['bloomWeight', 'contrast', 'vignette', 'grain']],
	// softness blurs the carving (ambient), depthFade how fast light dies down the tunnel.
	['mood', ['softness', 'depthFade', 'bounce', 'exposureKey']]
] as const;

export const MANDALA_UNIFORM_FLOATS = MANDALA_UNIFORM_GROUPS.length * 4;
export const MANDALA_UNIFORM_BYTES = MANDALA_UNIFORM_FLOATS * 4;

export type MandalaUniformSlot = (typeof MANDALA_UNIFORM_GROUPS)[number][1][number];
export type MandalaUniformValues = Record<MandalaUniformSlot, number>;

/** Pack named values into the uniform block in contract order. */
export function packMandalaUniforms(
	out: Float32Array,
	values: Readonly<MandalaUniformValues>
): Float32Array {
	if (out.length < MANDALA_UNIFORM_FLOATS) {
		throw new RangeError(`Mandala uniform buffer needs ${MANDALA_UNIFORM_FLOATS} floats.`);
	}
	let offset = 0;
	for (const [, slots] of MANDALA_UNIFORM_GROUPS) {
		for (const slot of slots) {
			const value = values[slot];
			out[offset] = Number.isFinite(value) ? value : 0;
			offset += 1;
		}
	}
	return out;
}

/** The WGSL struct body generated from the contract, comment line per field. */
export function mandalaParamsWgsl(): string {
	const fields = MANDALA_UNIFORM_GROUPS.map(
		([group, slots]) => `\t// ${slots.join(', ')}\n\t${group}: vec4<f32>,`
	).join('\n');
	return `struct Params {\n${fields}\n};`;
}
