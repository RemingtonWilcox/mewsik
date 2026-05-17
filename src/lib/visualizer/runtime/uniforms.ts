// Director uniform packing — V2 frame → std140-compatible Float32Array.
//
// One uniform buffer is shared by every motif module. Layout chosen so that
// related fields cluster (palette/clock/drop) and we don't waste bytes on
// alignment. Total: 32 vec4 slots = 512 bytes.
//
// WGSL side (in motif shaders):
//   struct Director {
//     viewport: vec4<f32>,        // w, h, time, dt
//     energy: vec4<f32>,          // energy, density, motion, structure
//     bands: vec4<f32>,           // bass, mid, treble, centroid
//     palette: vec4<f32>,         // base_hue, accent_hue, rim_hue, saturation
//     palette2: vec4<f32>,        // warmth, paletteAccentOffset, _, _
//     mood: vec4<f32>,            // valence, arousal, bassPunch, trebleSparkle
//     clock: vec4<f32>,           // tempoBpm, beatPhase, beatPulse, phrasePos
//     clockI: vec4<u32>,          // barIndex, beatIndex, phraseIndex, downbeatFlag
//     drop: vec4<f32>,            // buildActive(0/1), buildProgress, dropEta, anticipation
//     drop2: vec4<f32>,           // postDropDecay, _, _, _
//     section: vec4<u32>,         // section_id, motif_id, _, _
//     tonnetz_a: vec4<f32>,       // tonnetz[0..3]
//     tonnetz_b: vec4<f32>,       // tonnetz[4..5], _, _
//     phrase: vec4<f32>,          // phrase, sectionAge, silence(0/1), _
//     controls: vec4<f32>,        // master, exposure, bloom, background
//     post: vec4<f32>,            // contrast, saturation, vignette, edge
//     fx: vec4<f32>,              // chromaticAberration, grain, bloomThreshold, feedbackMix
//     feedback: vec4<f32>,        // decay, warp, rotation, _
//     motifA: vec4<f32>,          // mandalaKFold, mandalaRingDensity, flowStrength, flowCurlScale
//     motifB: vec4<f32>,          // physarumSense, _, _, _
//   };

import type { VisualDirectorFrame } from '../director/types.js';
import { DEFAULT_RUNTIME_CONTROLS, normalizeRuntimeControls } from './controls.js';
import type { RuntimeControls } from './types.js';

export const DIRECTOR_UNIFORM_FLOATS = 32 * 4; // 32 vec4
export const DIRECTOR_UNIFORM_BYTES = DIRECTOR_UNIFORM_FLOATS * 4;

const SECTION_IDS: Record<string, number> = {
	calm: 0,
	intro: 1,
	verse: 2,
	pre_chorus: 3,
	build: 4,
	drop: 5,
	chorus: 6,
	bridge: 7,
	breakdown: 8,
	outro: 9
};

const MOTIF_IDS: Record<string, number> = {
	organism: 0,
	tunnel: 1,
	lattice: 2,
	ribbon: 3
};

export function packDirectorUniform(
	out: Float32Array,
	outU32: Uint32Array,
	frame: VisualDirectorFrame,
	width: number,
	height: number,
	time: number,
	dt: number,
	controls: RuntimeControls = DEFAULT_RUNTIME_CONTROLS
) {
	const c = normalizeRuntimeControls(controls);

	// viewport
	out[0] = width;
	out[1] = height;
	out[2] = time;
	out[3] = dt;
	// energy
	out[4] = frame.energy;
	out[5] = frame.density;
	out[6] = frame.motion;
	out[7] = frame.structure;
	// bands — fast rail: raw bass/mid/treble/centroid with ~30ms one-frame
	// denoise. Motifs read these instead of the longer-tail envelopes
	// (dir.energy / dir.mood) when they want gen-1 transient response.
	out[8] = frame.bassRaw;
	out[9] = frame.midRaw;
	out[10] = frame.trebleRaw;
	out[11] = frame.centroidRaw;
	// palette
	out[12] = frame.palette.baseHue;
	out[13] = frame.palette.accentHue;
	out[14] = frame.palette.rimHue;
	out[15] = frame.palette.saturation;
	// palette2
	out[16] = frame.palette.warmth;
	out[17] = frame.paletteAccent;
	out[18] = 0;
	out[19] = 0;
	// mood
	out[20] = frame.valence;
	out[21] = frame.arousal;
	out[22] = frame.bassPunch;
	out[23] = frame.trebleSparkle;
	// clock floats
	out[24] = frame.clock.tempoBpm;
	out[25] = frame.clock.beatPhase;
	out[26] = frame.clock.beatPulse;
	out[27] = frame.clock.phrasePos;
	// clock u32
	outU32[28] = frame.clock.barIndex >>> 0;
	outU32[29] = frame.clock.beatIndex >>> 0;
	outU32[30] = frame.clock.phraseIndex >>> 0;
	outU32[31] = frame.clock.downbeatFlag ? 1 : 0;
	// drop
	out[32] = frame.drop.buildActive ? 1 : 0;
	out[33] = frame.drop.buildProgress;
	out[34] = frame.drop.dropEta;
	out[35] = frame.drop.anticipation;
	// drop2
	out[36] = frame.drop.postDropDecay;
	out[37] = 0;
	out[38] = 0;
	out[39] = 0;
	// section + motif as u32
	outU32[40] = SECTION_IDS[frame.section] ?? 0;
	outU32[41] = MOTIF_IDS[frame.motif] ?? 0;
	outU32[42] = 0;
	outU32[43] = 0;
	// tonnetz a
	out[44] = frame.tonnetz[0];
	out[45] = frame.tonnetz[1];
	out[46] = frame.tonnetz[2];
	out[47] = frame.tonnetz[3];
	// tonnetz b
	out[48] = frame.tonnetz[4];
	out[49] = frame.tonnetz[5];
	out[50] = 0;
	out[51] = 0;
	// phrase + section age + silence
	out[52] = frame.phrase;
	out[53] = frame.sectionAge;
	out[54] = frame.silence ? 1 : 0;
	out[55] = frame.motifIndex;
	// runtime controls
	out[56] = c.master;
	out[57] = c.exposure;
	out[58] = c.bloom;
	out[59] = c.background;
	// post controls
	out[60] = c.contrast;
	out[61] = c.saturation;
	out[62] = c.vignette;
	out[63] = c.edge;
	// fx controls + feedbackMix (was free slot fx.w)
	out[64] = c.chromaticAberration;
	out[65] = c.grain;
	out[66] = c.bloomThreshold;
	out[67] = c.feedbackMix;
	// feedback vec4 (was _pad3)
	out[68] = c.feedbackDecay;
	out[69] = c.feedbackWarp;
	out[70] = c.feedbackRotation;
	out[71] = 0;
	// motifA vec4 (was _pad4)
	out[72] = c.mandalaKFold;
	out[73] = c.mandalaRingDensity;
	out[74] = c.flowStrength;
	out[75] = c.flowCurlScale;
	// motifB vec4 (was _pad5)
	out[76] = c.physarumSense;
	out[77] = 0;
	out[78] = 0;
	out[79] = 0;
}

export const DIRECTOR_WGSL_STRUCT = /* wgsl */ `
struct Director {
	viewport: vec4<f32>,
	energy: vec4<f32>,
	bands: vec4<f32>,
	palette: vec4<f32>,
	palette2: vec4<f32>,
	mood: vec4<f32>,
	clock: vec4<f32>,
	clockI: vec4<u32>,
	drop: vec4<f32>,
	drop2: vec4<f32>,
	section: vec4<u32>,
	tonnetz_a: vec4<f32>,
	tonnetz_b: vec4<f32>,
	phrase: vec4<f32>,
	controls: vec4<f32>,
	post: vec4<f32>,
	fx: vec4<f32>,
	feedback: vec4<f32>,
	motifA: vec4<f32>,
	motifB: vec4<f32>,
	_pad6: vec4<f32>,
	_pad7: vec4<f32>,
	_pad8: vec4<f32>,
	_pad9: vec4<f32>,
	_pad10: vec4<f32>,
	_pad11: vec4<f32>,
	_pad12: vec4<f32>,
	_pad13: vec4<f32>,
	_pad14: vec4<f32>,
	_pad15: vec4<f32>,
	_pad16: vec4<f32>,
	_pad17: vec4<f32>,
};

fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
	let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	let p = abs(fract(vec3<f32>(c.x) + K.xyz) * 6.0 - vec3<f32>(K.w));
	return c.z * mix(vec3<f32>(K.x), clamp(p - vec3<f32>(K.x), vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}
`;
