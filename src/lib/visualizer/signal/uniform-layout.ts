// Signal's GPU uniform contract. The order here is the order of the vec4
// fields in the WGSL Params struct in shaders.ts; keep both in sync.

export const SIGNAL_UNIFORM_GROUPS = [
	['view', ['width', 'height', 'elapsed', 'dt']],
	['bandsA', ['sub', 'kick', 'body', 'mids']],
	['bandsB', ['presence', 'air', 'rms', 'centroid']],
	// transient: heard kick/onset envelope (never the predicted beat clock).
	['pulse', ['impact', 'transient', 'sectionPulse', 'ringOut']],
	['tone', ['energy', 'silence', 'stroke', 'beatPhase']],
	// Phosphor roles, resolved on the CPU from the genome's palette family.
	['heroColor', ['heroR', 'heroG', 'heroB', 'paletteGain']],
	['traceColor', ['traceR', 'traceG', 'traceB', 'ghostSpread']],
	['horizonColor', ['horizonR', 'horizonG', 'horizonB', 'coupling']],
	['hotColor', ['hotR', 'hotG', 'hotB', 'headGlow']],
	['roomColor', ['roomR', 'roomG', 'roomB', 'haze']],
	// The figure and its beam head (the instrument's one light source).
	['figureA', ['figAX', 'figAY', 'figAScale', 'figAVis']],
	['figureB', ['figBX', 'figBY', 'figBScale', 'figBScreen']],
	['head', ['headU', 'headX', 'headY', 'lightLevel']],
	// traceLevel: the X/Y traces' own energy, on its own (slower) time.
	['sweep', ['sweepPhase', 'channels', 'feed', 'traceLevel']],
	// Channel trace frames: origin, time axis, value axis, scroll mode, visibility.
	['trace0', ['t0ox', 't0oy', 't0tx', 't0ty']],
	['trace0v', ['t0vx', 't0vy', 't0scroll', 't0vis']],
	['trace1', ['t1ox', 't1oy', 't1tx', 't1ty']],
	['trace1v', ['t1vx', 't1vy', 't1scroll', 't1vis']],
	['trace2', ['t2ox', 't2oy', 't2tx', 't2ty']],
	['trace2v', ['t2vx', 't2vy', 't2scroll', 't2vis']],
	['trace3', ['t3ox', 't3oy', 't3tx', 't3ty']],
	['trace3v', ['t3vx', 't3vy', 't3scroll', 't3vis']],
	// Voice lanes (band.ts): traces 2..7 are bass, harmony, kick, snare, hat
	// and perc, each written by its own head into the voice buffer.
	['trace4', ['t4ox', 't4oy', 't4tx', 't4ty']],
	['trace4v', ['t4vx', 't4vy', 't4scroll', 't4vis']],
	['trace5', ['t5ox', 't5oy', 't5tx', 't5ty']],
	['trace5v', ['t5vx', 't5vy', 't5scroll', 't5vis']],
	['trace6', ['t6ox', 't6oy', 't6tx', 't6ty']],
	['trace6v', ['t6vx', 't6vy', 't6scroll', 't6vis']],
	['trace7', ['t7ox', 't7oy', 't7tx', 't7ty']],
	['trace7v', ['t7vx', 't7vy', 't7scroll', 't7vis']],
	// Each lane's presence, and the fill cascade down the horizon rows.
	['voiceVis', ['vis2', 'vis3', 'vis4', 'vis5']],
	['voiceVis2', ['vis6', 'vis7', 'fillTravel', 'fillAmount']],
	// Each lane's write head, the breakdown withdrawal and the build's gather.
	['voiceHead', ['head2', 'head3', 'head4', 'head5']],
	['voiceHead2', ['head6', 'head7', 'withdraw', 'gather']],
	// Each lane's phosphor and light.
	['voiceColor2', ['v2r', 'v2g', 'v2b', 'v2light']],
	['voiceColor3', ['v3r', 'v3g', 'v3b', 'v3light']],
	['voiceColor4', ['v4r', 'v4g', 'v4b', 'v4light']],
	['voiceColor5', ['v5r', 'v5g', 'v5b', 'v5light']],
	['voiceColor6', ['v6r', 'v6g', 'v6b', 'v6light']],
	['voiceColor7', ['v7r', 'v7g', 'v7b', 'v7light']],
	// Rail lights (each rail listens to its own part of the band) and the
	// graticule's light.
	['rails', ['rail0', 'rail1', 'rail2', 'rail3']],
	['rails2', ['rail4', 'rail5', 'rail6', 'graticule']],
	// Feed dots: travel after the snare (X), the kick (Y), a bass note (drip).
	['feeds', ['feedX', 'feedY', 'feedDrip', 'feedLight']],
	// The horizon's zones: each drum lights its own stretch of the rows (kick
	// under the figure, snares to the sides, hats at the rims, perc between),
	// and the chord root and the bass note light their pitch places.
	['floorDrums', ['floorKick', 'floorSnare', 'floorHat', 'floorPerc']],
	['floorPitch', ['chordTurn', 'chordLight', 'bassTurn', 'bassLight']],
	// Horizon surfaces. Rig A is the leaving bench's camera and geometry, rig B
	// the arriving bench's; the shader blends their projections on screen.
	['surface', ['surfaceA', 'surfaceB', 'surfaceMix', 'terrainVis']],
	['terrain', ['tickPhase', 'headIndex', 'tickFlash', 'relief']],
	['camera', ['camHeight', 'camPitch', 'camYaw', 'focal']],
	['anchors', ['offAX', 'offAY', 'offBX', 'offBY']],
	['depth', ['near', 'far', 'span', 'rails']],
	['rings', ['ringInner', 'ringOuter', 'ringZ', 'radarArm']],
	['waterfall', ['wfX', 'wfY', 'wfDx', 'wfDy']],
	['cameraB', ['camHeightB', 'camPitchB', 'camYawB', 'focalB']],
	['depthB', ['nearB', 'farB', 'spanB', 'reliefB']],
	['ringsB', ['ringInnerB', 'ringOuterB', 'ringZB', 'surfaceRipple']],
	['waterfallB', ['wfXB', 'wfYB', 'wfDxB', 'wfDyB']],
	// Scope faces, bezels and glass.
	['faceA', ['faceAX', 'faceAY', 'faceAW', 'faceAH']],
	['faceAStyle', ['faceARadius', 'faceARepeat', 'faceAGap', 'faceAVis']],
	['faceB', ['faceBX', 'faceBY', 'faceBW', 'faceBH']],
	['faceBStyle', ['faceBRadius', 'faceABezel', 'faceBBezel', 'faceBVis']],
	// Display character.
	['display', ['scanDensity', 'scanStrength', 'curvature', 'grain']],
	['display2', ['bloomGain', 'aberration', 'vignette', 'glass']],
	// Phosphor decay: fade per frame (long, short class) and the afterglow knee.
	['post', ['fadeLong', 'fadeShort', 'afterglow', 'gridLevel']],
	['floor', ['reflectY', 'reflect', 'seamY', 'seam']],
	['context', ['gridDensity', 'sectionProgress', 'figurePhase', 'tempo']],
	// The music's character as an instrument: broken beam, stroke core, crawl.
	['voice', ['fracture', 'sharpness', 'fracturePhase', 'halation']],
	// Tube geometry: face corner radius, glass reflectance, light spilled into
	// the room, ghost from the glass thickness.
	['tube', ['tubeRadius', 'glassReflect', 'roomSpill', 'glassGhost']],
	// Beam physics. Strokes are Gaussian spots dragged along each segment;
	// the mean segment length (figure-local units) and the size compensation
	// set how much light a figure's segment carries (see shaders.ts).
	['figureLen', ['figALen', 'figBLen', 'figAEnergy', 'figBEnergy']],
	// Light each stroke deposits per frame, per phosphor class, and the spot.
	['deposit', ['depositLong', 'depositShort', 'spotSigma', 'focus']],
	// The real XY beam: window index of its first pair, segment count,
	// upsampling factor, and its share of the hero (0 synthesized .. 1 XY).
	['beam', ['beamFirst', 'beamSegments', 'beamUp', 'beamMix']],
	// Speed gain (light at reference speed x reference length), auto gain,
	// rotation (0 XY .. pi/4 goniometer), and the frame's mean segment in
	// pixels (what the dwell cap measures a near-resting beam against).
	['beamDrive', ['beamGain', 'beamAgc', 'beamTurn', 'beamStep']],
	// Channel traces 0 and 1 as the real left/right waveforms (triggered).
	['scopeTrace', ['traceStart', 'traceSpan', 'traceGain', 'traceMix']],
	// Glow and output: tight and wide glow, glass reflections, exposure.
	['glow', ['glowTight', 'glowWide', 'reflection', 'exposure']],
	// Overexposure to white, reflection spread, saturation, and the
	// extinction floor that puts the phosphor's last glimmer out.
	['output', ['overexposure', 'reflectSpread', 'saturation', 'extinction']]
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

/** Params struct body generated from the groups (comment lines feed the contract test). */
export function signalParamsWgsl(): string {
	return SIGNAL_UNIFORM_GROUPS.map(([group, names]) => `\t// ${names.join(', ')}\n\t${group}: vec4<f32>,`).join('\n');
}
