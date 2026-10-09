// Signal's GPU uniform contract. The order here is the order of the vec4
// fields in the WGSL Params struct in shaders.ts; keep both in sync.

export const SIGNAL_UNIFORM_GROUPS = [
	['view', ['width', 'height', 'elapsed', 'dt']],
	['bandsA', ['sub', 'kick', 'body', 'mids']],
	['bandsB', ['presence', 'air', 'rms', 'centroid']],
	['pulse', ['impact', 'beatGlow', 'sectionPulse', 'ringOut']],
	['shape', ['tension', 'release', 'openness', 'asymmetry']],
	['forms', ['ellipse', 'lissajous', 'ribbon', 'rosette']],
	['figure', ['figurePhase', 'complexity', 'mode', 'spread']],
	['sweep', ['sweepPhase', 'channels', 'sweepStep', 'packetPhase']],
	['palette', ['baseHue', 'accentHue', 'rimHue', 'saturation']],
	['tone', ['keyStrength', 'energy', 'silence', 'stroke']],
	['post', ['feedbackFade', 'floorFade', 'bloomThreshold', 'aberration']],
	['placement', ['horizon', 'heroX', 'heroY', 'heroScale']],
	['motion', ['yaw', 'spectralMotion', 'crest', 'flatness']],
	['terrain', ['tickPhase', 'headIndex', 'terrainLift', 'tickFlash']],
	['context', ['sectionProgress', 'energySlope', 'lookahead', 'tempo']]
] as const;

type Group = (typeof SIGNAL_UNIFORM_GROUPS)[number];
export type SignalUniformName = Group[1][number];
export type SignalUniformValues = Record<SignalUniformName, number>;

export const SIGNAL_UNIFORM_FLOATS = SIGNAL_UNIFORM_GROUPS.length * 4;
export const SIGNAL_UNIFORM_BYTES = SIGNAL_UNIFORM_FLOATS * 4;

const ORDER: readonly SignalUniformName[] = SIGNAL_UNIFORM_GROUPS.flatMap(
	([, names]) => names as readonly SignalUniformName[]
);

/** Pack named values into the GPU layout; non-finite values become zero. */
export function packSignalUniforms(out: Float32Array, values: SignalUniformValues): Float32Array {
	for (let index = 0; index < ORDER.length; index += 1) {
		const value = values[ORDER[index]];
		out[index] = Number.isFinite(value) ? value : 0;
	}
	return out;
}
