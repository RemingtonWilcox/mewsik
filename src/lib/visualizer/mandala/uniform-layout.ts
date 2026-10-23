// Mandala's uniform contract, declared once so the TypeScript packing and the
// WGSL `Params` struct cannot silently diverge. The struct in shaders.ts
// mirrors these groups in the same order, with a machine-checkable comment
// above each field listing its four slot names; e2e/mandala-uniform-contract
// enforces that both sides agree.

export const MANDALA_UNIFORM_GROUPS = [
	['view', ['width', 'height', 'frame', 'time']],
	// Quality knob: march steps, fractal iteration scale, focal length, AO on/off.
	['quality', ['steps', 'detail', 'focal', 'occlusion']],
	// The two worlds on screen: world index, variant, mirror sectors; A morphs to B by `mix`.
	['slotA', ['worldA', 'variantA', 'foldA', 'mix']],
	['slotB', ['worldB', 'variantB', 'foldB', 'revealSeed']],
	// Continuous fractal parameters every world reads in its own terms.
	['form', ['formA', 'formB', 'formC', 'formD']],
	// Each slot's own motion: travel/zoom phase, roll, look yaw and pitch.
	['motionA', ['phaseA', 'turnA', 'yawA', 'pitchA']],
	['motionB', ['phaseB', 'turnB', 'yawB', 'pitchB']],
	// Julia dive per slot: constant c and the repelling fixed point it zooms into.
	['juliaA', ['jcxA', 'jcyA', 'jzxA', 'jzyA']],
	// Complex window scale W lambda^-(f+lead); the second pair is unused (zero).
	['zoomA', ['jsxA', 'jsyA', 'jtxA', 'jtyA']],
	['juliaB', ['jcxB', 'jcyB', 'jzxB', 'jzyB']],
	['zoomB', ['jsxB', 'jsyB', 'jtxB', 'jtyB']],
	// Julia power and the lead (iterations started before the window), per slot.
	['juliaMix', ['jnA', 'jwA', 'jnB', 'jwB']],
	['audio', ['energy', 'bass', 'mid', 'treble']],
	// Heard transients: kick hit envelope and its random seed, onset spark and seed.
	['pulse', ['hit', 'hitSeed', 'spark', 'sparkSeed']],
	// snap: damped fold spring; surge: transient travel push.
	['motion', ['snap', 'surge', 'silence', 'drive']],
	['character', ['harsh', 'warmth', 'punch', 'tempo']],
	['tone', ['glow', 'sheen', 'hue', 'gain']],
	// Palette: four emission stops deep -> hot, then the spark colour.
	['pal0', ['pal0r', 'pal0g', 'pal0b', 'levelA']],
	['pal1', ['pal1r', 'pal1g', 'pal1b', 'levelB']],
	['pal2', ['pal2r', 'pal2g', 'pal2b', 'fogDensity']],
	['pal3', ['pal3r', 'pal3g', 'pal3b', 'saturation']],
	['spark', ['sparkR', 'sparkG', 'sparkB', 'sparkGain']],
	['post', ['feedbackFade', 'feedbackZoom', 'bloomThreshold', 'aberration']],
	['postB', ['vanishX', 'vanishY', 'feedbackRoll', 'exposure']],
	['postC', ['bloomWeight', 'contrast', 'vignette', 'grain']],
	// exposureCeil / meanCeil: the brightest highlights and the brightest frame
	// mean the meter allows before exposure comes down (it never goes up).
	['mood', ['exposureCeil', 'meterRate', 'debug', 'meanCeil']],
	// The roaming camera: where the planes' centre sits in the frame, their
	// log zoom, and an extra roll of the whole view.
	['camera', ['panX', 'panY', 'zoomLog', 'roll']],
	// dolly: orbit distance / channel offset; orbit: the orbiting worlds'
	// integrated angle; paint: the drifting palette mapping; eye: the spiral's eye.
	['cameraB', ['dolly', 'orbit', 'paint', 'eye']],
	// Four slow, never-repeating structure morphs (-1..1), read per world.
	['drift', ['morphA', 'morphB', 'morphC', 'morphD']],
	// Where the light sits: the 3D lamp's offset from the camera (in its own
	// reach) and its reach multiplier; extent: how far the planes' pattern
	// carries from its centre before it ends in black (screen heights).
	['light', ['lampX', 'lampY', 'lampReach', 'extent']]
] as const;

export const MANDALA_UNIFORM_FLOATS = MANDALA_UNIFORM_GROUPS.length * 4;
export const MANDALA_UNIFORM_BYTES = MANDALA_UNIFORM_FLOATS * 4;

export type MandalaUniformSlot = (typeof MANDALA_UNIFORM_GROUPS)[number][1][number];
export type MandalaUniformValues = Record<MandalaUniformSlot, number>;

/** Pack named values into the uniform block in contract order. */
export function packMandalaUniforms(out: Float32Array, values: Readonly<MandalaUniformValues>): Float32Array {
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
