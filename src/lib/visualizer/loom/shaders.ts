// Loom is a harmonic weaving instrument. The conductor supplies the reactive
// rails (bands, beats, tension, drops) and the long-listen look (see look.ts):
// which topology grammar the threads are laid on, palette family, material,
// camera regime, environment and beat form. Every grammar is a parametric
// surface; rails, weft and chorus strands are curves on it, so a grammar change
// morphs the same threads into a new architecture instead of cutting.
//
// The weave is an ensemble (ensemble.ts): each strand group plays its own
// instrument, and the floor, mist, dust, far threads and key light each their
// own voice. They are read from the parts storage buffer (LOOM_PART_*),
// so the music moves many small parts of the picture independently instead of
// pulsing the whole frame.

import {
	LOOM_CRAWL_WRAP,
	LOOM_GROUP_VEC4S,
	LOOM_PART,
	LOOM_PART_PACKETS,
	LOOM_PACKET_SLOTS,
	LOOM_PART_VEC4S
} from '$lib/visualizer/loom/ensemble';

export const LOOM_SEGMENTS = 208;
export const LOOM_PRIMARY_RAILS = 3;
export const LOOM_SECONDARY_RAILS = 8;
export const LOOM_CHORUS_STRANDS = 16;
export const LOOM_CHORUS_SEGMENTS = 128;
export const LOOM_CHORUS_SIDES = 6;
export const LOOM_NODES = 0;
export const LOOM_STRANDS = LOOM_PRIMARY_RAILS;
/** Instances in the main (full-resolution) draw: rails + weft. */
export const LOOM_INSTANCES = LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS;
export const LOOM_FIRST_CHORUS = LOOM_INSTANCES;
export const LOOM_TUBE_SIDES = 10;
export const LOOM_VERTEX_COUNT = LOOM_SEGMENTS * LOOM_TUBE_SIDES * 6;
export const LOOM_CHORUS_VERTEX_COUNT = LOOM_CHORUS_SEGMENTS * LOOM_CHORUS_SIDES * 6;
/** The primary rails are the scene's light sources, sampled at this many points each. */
export const LOOM_LIGHT_RAILS = LOOM_PRIMARY_RAILS;
export const LOOM_LIGHT_POINTS = 13;
/** Two vec4 per light point, then one for the stage's adapted exposure. */
export const LOOM_LIGHT_VEC4S = LOOM_LIGHT_RAILS * LOOM_LIGHT_POINTS * 2 + 1;
export const LOOM_LIGHT_BYTES = LOOM_LIGHT_VEC4S * 16;
/** Far threads round the stage, and the strip segments each is drawn with. */
export const LOOM_THREADS = 360;
export const LOOM_THREAD_SEGMENTS = 28;
export const LOOM_THREAD_VERTEX_COUNT = LOOM_THREAD_SEGMENTS * 6;
/** Dust and loose fibres in the air round the figure. */
export const LOOM_DUST = 1400;
/** The participating medium is marched at this fraction of the scene size. */
export const LOOM_VOLUME_SCALE = 1 / 3;

// Field comments double as the machine-checkable packing contract; they must
// match LOOM_UNIFORM_GROUPS in uniform-layout.ts (see e2e loom-uniform-contract).
const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// width, height, elapsed, responseMotion
	view: vec4<f32>,
	// impact, reweave, sectionPulse, beatPhase
	pulse: vec4<f32>,
	// rms, sub, kick, body
	audioA: vec4<f32>,
	// mids, presence, air, centroid
	audioB: vec4<f32>,
	// energy, spectralMotion, spectralLean, tempo
	macroRails: vec4<f32>,
	// tension, release, openness, dropOpenness
	shape: vec4<f32>,
	// curl, sway, braid, twist
	shapeB: vec4<f32>,
	// knot, cage, saddle, helix
	grammar: vec4<f32>,
	// baseHue, accentHue, rimHue, saturation
	palette: vec4<f32>,
	// yaw, pitch, distance, roll
	camera: vec4<f32>,
	// beatConveyor, swayPhase, weftSparse, driftPhase
	cloth: vec4<f32>,
	// warpRadius, weftRadius, glow, silence
	style: vec4<f32>,
	// seedHi, seedLo, key, mode
	harmony: vec4<f32>,
	// feedbackFade, feedbackZoom, bloomThreshold, aberration
	post: vec4<f32>,
	// topoFrom, topoTo, topoMix, strandCount
	topo: vec4<f32>,
	// formTwist, crossDensity, spread, symmetry
	form: vec4<f32>,
	// curvature, taper, bead, swell
	formB: vec4<f32>,
	// frameScale, nearFade, widthScale, emissionGain
	frame: vec4<f32>,
	// focal, lensShiftX, lensShiftY, orbitYaw
	lens: vec4<f32>,
	// heroR, heroG, heroB, heroGain
	heroTint: vec4<f32>,
	// supportR, supportG, supportB, supportGain
	supportTint: vec4<f32>,
	// weftR, weftG, weftB, weftGain
	weftTint: vec4<f32>,
	// deepR, deepG, deepB, envGain
	deepTint: vec4<f32>,
	// hazeR, hazeG, hazeB, hazeGain
	hazeTint: vec4<f32>,
	// glowR, glowG, glowB, glowGain
	glowTint: vec4<f32>,
	// diffuse, gloss, sharpness, aniso
	materialA: vec4<f32>,
	// fresnel, emissive, mirror, whiteCore
	materialB: vec4<f32>,
	// sheen, stripes, translucency, hotspot
	materialC: vec4<f32>,
	// iridescence, glint, chorusLevel, pale
	materialD: vec4<f32>,
	// reflect, roughness, ripple, floorAlbedo
	envA: vec4<f32>,
	// mist, mistHeight, mistNoise, fogExtinction
	envB: vec4<f32>,
	// floorY, floorAmount, envLight, bloomWeight
	envC: vec4<f32>,
	// keyAzimuth, keyElevation, lightWarmth, fillLevel
	light: vec4<f32>,
	// packets, pluck, crossPulse, shuttle
	beat: vec4<f32>,
	// sparks, beatGain, litGain, chorusGlow
	beatB: vec4<f32>,
	// driftX, driftY, spin, flowPhase
	postB: vec4<f32>,
	// threads, warpRows, threadReach, dust
	envD: vec4<f32>,
	// fray, grain, turbulence, edge
	weave: vec4<f32>,
	// twistY, twistX, bend, flare
	deform: vec4<f32>,
	// tiltX, tiltZ, laneGamma, deformAmount
	figure: vec4<f32>,
	// warpAx, warpAy, warpAz, warpAAmp
	warpA: vec4<f32>,
	// warpBx, warpBy, warpBz, warpBAmp
	warpB: vec4<f32>,
	// warpCx, warpCy, warpCz, warpCAmp
	warpC: vec4<f32>,
	// warpAPhase, warpBPhase, warpCPhase, centerY
	warpPhase: vec4<f32>,
	// hybridGrammar, hybridMix, reserveA, reserveB
	hybrid: vec4<f32>,
};
`;

const SHARED_WGSL = /* wgsl */ `
fn hsvToRgb(hsv: vec3<f32>) -> vec3<f32> {
	let p = abs(fract(hsv.xxx + vec3<f32>(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
	return hsv.z * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), hsv.y);
}

fn mixHueShortest(hueA: f32, hueB: f32, amount: f32) -> f32 {
	let delta = fract(hueB - hueA + 0.5) - 0.5;
	return fract(hueA + delta * amount);
}

// Turn a colour's hue by a fraction of the wheel (rotation about grey).
fn hueRotate(c: vec3<f32>, turns: f32) -> vec3<f32> {
	let a = turns * 6.28318530718;
	let k = vec3<f32>(0.57735027);
	let ca = cos(a);
	return max(c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca), vec3<f32>(0.0));
}

fn rotateX(point: vec3<f32>, angle: f32) -> vec3<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec3<f32>(point.x, point.y * c - point.z * s, point.y * s + point.z * c);
}

fn rotateY(point: vec3<f32>, angle: f32) -> vec3<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec3<f32>(point.x * c + point.z * s, point.y, -point.x * s + point.z * c);
}

fn rotateZ(point: vec3<f32>, angle: f32) -> vec3<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec3<f32>(point.x * c - point.y * s, point.x * s + point.y * c, point.z);
}

fn seedWord() -> u32 {
	return (u32(params.harmony.x) << 16u) | u32(params.harmony.y);
}

fn loomMix(x0: u32) -> u32 {
	var x = x0;
	x = x ^ (x >> 16u);
	x = x * 0x7feb352du;
	x = x ^ (x >> 15u);
	x = x * 0x846ca68bu;
	x = x ^ (x >> 16u);
	return x;
}

fn hashUnit(a: u32, b: u32, c: u32) -> f32 {
	let h = loomMix(seedWord() ^ (a * 0x9e3779b1u) ^ (b * 0x85ebca6bu) ^ (c * 0x27d4eb2fu));
	return f32(h & 0x00ffffffu) / 16777216.0;
}

// Camera and stage. Strand space (the grammar surfaces) is scaled into stage
// space, where the floor, the far threads and the dust live; the stage is then
// turned to the camera (view space: camera on +z looking down -z).
const LOOM_NEAR: f32 = 0.1;
const LOOM_FAR: f32 = 32.0;
const STAGE_OFFSET: vec3<f32> = vec3<f32>(0.04, -0.08, -0.18);

// Phrase-scale evolution shared by the hero and the camera: x = phrase index,
// y = blend toward the next phrase over its final eighth, so changes ease in.
fn phraseClock() -> vec2<f32> {
	let beats = params.cloth.x / 32.0;
	return vec2<f32>(floor(beats), smoothstep(0.875, 1.0, fract(beats)));
}

// The viewing angle comes from the look's roaming camera (look.ts): no
// per-phrase step here, which turned the stage on every phrase like clockwork.
fn stageYaw() -> f32 {
	return params.camera.x + 0.62 + params.lens.w;
}

fn stagePitch() -> f32 {
	return params.camera.y - 0.18;
}

fn stagePoint(p0: vec3<f32>) -> vec3<f32> {
	var p = p0 * params.frame.x;
	p.x = p.x * 1.32;
	p.y = p.y * 1.12;
	p.z = p.z * 1.16;
	return p;
}

fn stageRotate(v: vec3<f32>) -> vec3<f32> {
	return rotateZ(rotateX(rotateY(v, stageYaw()), stagePitch()), params.camera.w);
}

fn stageToView(q: vec3<f32>) -> vec3<f32> {
	return stageRotate(q) + STAGE_OFFSET;
}

fn viewToStage(v: vec3<f32>) -> vec3<f32> {
	return rotateY(rotateX(rotateZ(v - STAGE_OFFSET, -params.camera.w), -stagePitch()), -stageYaw());
}

fn viewPoint(p0: vec3<f32>) -> vec3<f32> {
	return stageToView(stagePoint(p0));
}

fn floorStageY() -> f32 {
	return params.envC.x * params.frame.x * 1.12;
}

// The floor fades out as the camera nears it or looks up from below it.
fn floorVisibility() -> f32 {
	let eye = viewToStage(vec3<f32>(0.0, 0.0, params.camera.z));
	return clamp(params.envC.y, 0.0, 1.0) * smoothstep(0.1, 0.45, eye.y - floorStageY());
}

// Perspective with lens shift; w is the depth in front of the camera.
fn projectView(position: vec3<f32>) -> vec4<f32> {
	let depth = params.camera.z - position.z;
	let aspect = params.view.x / max(params.view.y, 1.0);
	let focal = params.lens.x;
	let clipZ = clamp((depth - LOOM_NEAR) / (LOOM_FAR - LOOM_NEAR), -1.0, 2.0) * depth;
	return vec4<f32>(
		position.x * focal / aspect + params.lens.y * depth,
		position.y * focal + params.lens.z * depth,
		clipZ,
		depth
	);
}

// View-space ray through a screen uv (y down), scaled so that its z is -1:
// camera + ray * d is the point at depth d.
fn viewRay(uv: vec2<f32>) -> vec3<f32> {
	let aspect = params.view.x / max(params.view.y, 1.0);
	let focal = params.lens.x;
	let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	return vec3<f32>((ndc.x - params.lens.y) * aspect / focal, (ndc.y - params.lens.z) / focal, -1.0);
}

// Depth along a viewRay at which it meets the floor plane (negative: never).
fn floorDepth(ray: vec3<f32>) -> f32 {
	let n = stageRotate(vec3<f32>(0.0, 1.0, 0.0));
	let q = stageToView(vec3<f32>(0.0, floorStageY(), 0.0));
	let denom = dot(ray, n);
	if (denom > -1e-4) { return -1.0; }
	return dot(q - vec3<f32>(0.0, 0.0, params.camera.z), n) / denom;
}

fn hash3(c: vec3<i32>) -> f32 {
	let h = loomMix((bitcast<u32>(c.x) * 0x8da6b343u) ^ (bitcast<u32>(c.y) * 0xd8163841u) ^ (bitcast<u32>(c.z) * 0xcb1ab31fu));
	return f32(h & 0x00ffffffu) / 16777216.0;
}

// Smooth value noise, 0..1.
fn noise3(p: vec3<f32>) -> f32 {
	let i = vec3<i32>(floor(p));
	let f = fract(p);
	let u = f * f * (3.0 - 2.0 * f);
	let n000 = hash3(i);
	let n100 = hash3(i + vec3<i32>(1, 0, 0));
	let n010 = hash3(i + vec3<i32>(0, 1, 0));
	let n110 = hash3(i + vec3<i32>(1, 1, 0));
	let n001 = hash3(i + vec3<i32>(0, 0, 1));
	let n101 = hash3(i + vec3<i32>(1, 0, 1));
	let n011 = hash3(i + vec3<i32>(0, 1, 1));
	let n111 = hash3(i + vec3<i32>(1, 1, 1));
	return mix(
		mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
		mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
		u.z
	);
}
`;

// The ensemble's parts (ensemble.ts): per strand group five vec4 (A glow,
// width, slack, hue; B detail, lift, lean, sparkle; C crossing offset,
// crossing phase, presence, hit; D cluster, spark seed, slow glow, slow width;
// E wave phase, crawl, hero weight on the rails), the light packets
// in flight on each group, then the stage's own voices. Each module that
// includes this declares the parts binding itself.
const PARTS_WGSL = /* wgsl */ `
const PART_PACKETS: u32 = ${LOOM_PART_PACKETS}u;
const PACKET_SLOTS: u32 = ${LOOM_PACKET_SLOTS}u;
const PART_FLOOR: u32 = ${LOOM_PART.floor}u;
const PART_RING_A: u32 = ${LOOM_PART.ringA}u;
const PART_MIST: u32 = ${LOOM_PART.mist}u;
const PART_DUST: u32 = ${LOOM_PART.dust}u;
const PART_THREADS: u32 = ${LOOM_PART.threads}u;
const PART_LIGHT: u32 = ${LOOM_PART.light}u;
const PART_SHUTTLE: u32 = ${LOOM_PART.shuttle}u;
const PART_BASS: u32 = ${LOOM_PART.bass}u;
const PART_BASS_WALK: u32 = ${LOOM_PART.bassWalk}u;
const PART_THREADS_B: u32 = ${LOOM_PART.threadsB}u;

const GROUP_VEC4S: u32 = ${LOOM_GROUP_VEC4S}u;
fn voiceA(g: u32) -> vec4<f32> { return parts[g * GROUP_VEC4S]; }
fn voiceB(g: u32) -> vec4<f32> { return parts[g * GROUP_VEC4S + 1u]; }
fn voiceC(g: u32) -> vec4<f32> { return parts[g * GROUP_VEC4S + 2u]; }
fn voiceD(g: u32) -> vec4<f32> { return parts[g * GROUP_VEC4S + 3u]; }
// E: the group's own wave phase (it sways at the pace of its instrument),
// crawl (its surface ticks forward a little on each of its own hits) and, on
// the rails, the hero weight (the rail whose instrument leads).
fn voiceE(g: u32) -> vec4<f32> { return parts[g * GROUP_VEC4S + 4u]; }

// The light packets of one group at curve position s; widen > 1 spreads them
// (the ribbon lights are sampled at only a few points).
fn packetLight(g: u32, s: f32, widen: f32) -> f32 {
	var sum = 0.0;
	for (var k = 0u; k < PACKET_SLOTS; k = k + 1u) {
		let p = parts[PART_PACKETS + g * PACKET_SLOTS + k];
		let d = (s - p.x) / max(p.z * widen, 0.004);
		sum = sum + p.y * exp(-d * d);
	}
	return sum;
}

// The shuttle of a fill: a band running along one group's threads (the one
// playing the fill), a local cascade through one part of the weave.
fn shuttleBandAt(g: u32, s: f32, widen: f32) -> f32 {
	let sh = parts[PART_SHUTTLE];
	if (u32(sh.w + 0.5) != g) { return 0.0; }
	let d = (s - sh.x) / max(sh.z * widen, 0.004);
	return sh.y * exp(-d * d);
}
`;

export const LOOM_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${LOOM_SEGMENTS}u;
const TUBE_SIDES: u32 = ${LOOM_TUBE_SIDES}u;
const CHORUS_SEGMENTS: u32 = ${LOOM_CHORUS_SEGMENTS}u;
const CHORUS_SIDES: u32 = ${LOOM_CHORUS_SIDES}u;
const PRIMARY: u32 = ${LOOM_PRIMARY_RAILS}u;
const FIRST_CHORUS: u32 = ${LOOM_FIRST_CHORUS}u;
const LIGHT_RAILS: u32 = ${LOOM_LIGHT_RAILS}u;
const LIGHT_POINTS: u32 = ${LOOM_LIGHT_POINTS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;
@group(0) @binding(3) var<storage, read> parts: array<vec4<f32>, ${LOOM_PART_VEC4S}>;
// The stage's adapted exposure (written by cs_lights last frame), read by the
// strands so a dim era's threads are lifted a little and a bright one's held.
@group(0) @binding(4) var<storage, read> lightsIn: array<vec4<f32>, ${LOOM_LIGHT_VEC4S}>;
${PARTS_WGSL}

struct LoomOut {
	@builtin(position) position: vec4<f32>,
	@location(0) worldNormal: vec3<f32>,
	@location(1) viewDirection: vec3<f32>,
	@location(2) color: vec3<f32>,
	// x: curve position, y: instance kind, z: band energy, w: rail role
	@location(3) dataA: vec4<f32>,
	// x: signed detail, y: emission, z: harmonic intersection, w: depth cue
	@location(4) dataB: vec4<f32>,
	@location(5) tangent: vec3<f32>,
	// x: lane, y: strand hash, z: spark, w: hotspot phase
	@location(6) dataC: vec4<f32>,
	// x: height above the floor, y: mirrored, z: reflection dim, w: the group's crawl
	@location(7) envData: vec4<f32>,
};

// A point on a grammar surface: position, two directions perpendicular to the
// strand (n: main displacement, b: secondary), whether the strand is a closed
// loop, and how much of the shared reactive layer it takes (the ribbon grammar
// carries its own, tuned reactive terms).
struct GPoint {
	p: vec3<f32>,
	n: vec3<f32>,
	b: vec3<f32>,
	closed: f32,
	react: f32,
};

struct Strand {
	kind: f32,
	lane: f32,
	laneB: f32,
	family: u32,
	role: f32,
	sid: f32,
	weft: u32,
	// Rails blend toward their upper band as the centroid rises (it used to
	// switch family outright, which snapped the rail's shape and width).
	familyHi: u32,
	bandT: f32,
	// Ensemble group: 0..2 rails, 3..4 weft, 5..8 chorus (ensemble.ts).
	group: u32,
};

fn smoothDetail(position: f32) -> f32 {
	let scaled = clamp(position, 0.0, 0.999) * 63.0;
	let index = u32(floor(scaled));
	let fraction = fract(scaled);
	let index0 = select(index - 1u, 0u, index == 0u);
	let index1 = index;
	let index2 = min(index + 1u, 63u);
	let index3 = min(index + 2u, 63u);
	let a = clamp(detailBins[index0], -1.0, 1.0);
	let b = clamp(detailBins[index1], -1.0, 1.0);
	let c = clamp(detailBins[index2], -1.0, 1.0);
	let d = clamp(detailBins[index3], -1.0, 1.0);
	let f2 = fraction * fraction;
	let f3 = f2 * fraction;
	return clamp(0.5 * ((2.0 * b) + (-a + c) * fraction
		+ (2.0 * a - 5.0 * b + 4.0 * c - d) * f2
		+ (-a + 3.0 * b - 3.0 * c + d) * f3), -1.0, 1.0);
}

fn bandEnergy(family: u32) -> f32 {
	switch family % 6u {
		case 0u: { return params.audioA.y; }
		case 1u: { return params.audioA.z; }
		case 2u: { return params.audioA.w; }
		case 3u: { return params.audioB.x; }
		case 4u: { return params.audioB.y; }
		default: { return params.audioB.z; }
	}
}

fn strandBand(st: Strand) -> f32 {
	return mix(bandEnergy(st.family), bandEnergy(st.familyHi), st.bandT);
}

fn bandDetail(family: u32, s: f32) -> f32 {
	let base = f32(family % 6u) * 10.5;
	return smoothDetail(clamp((base + clamp(s, 0.0, 1.0) * 10.0) / 63.0, 0.0, 1.0));
}

fn compositionRails() -> vec4<f32> {
	let knot = params.grammar.x;
	let cage = params.grammar.y;
	let saddle = params.grammar.z;
	let helix = params.grammar.w;
	let plain = clamp(1.0 - knot - cage - saddle - helix, 0.0, 1.0);

	let ghost = clamp(params.cloth.z * 0.95 + params.style.w * 0.85, 0.0, 1.0);
	let vault = clamp(params.shape.w * 0.75 + params.shape.y * 0.25 + cage * 0.22, 0.0, 1.0);
	let knotState = clamp(params.shape.x * 0.55 + knot * 0.65 + params.shapeB.x * 0.18, 0.0, 1.0);
	let tuning = clamp(plain * 0.55 + (1.0 - params.macroRails.x) * 0.35 + ghost * 0.22, 0.0, 1.0);
	return vec4<f32>(tuning, vault, knotState, ghost);
}

fn taperEnv(s: f32) -> f32 {
	let q = s * 2.0 - 1.0;
	return pow(max(0.0, 1.0 - q * q), 0.72);
}

// Grammar 0, the original Loom ribbon bundle: rails sweep a coiled throat,
// pinch into knots under tension and fan open as ghosts in silence.
fn architecturePoint(s: f32, rail: f32, family: u32, role: f32, band: f32, group: u32) -> vec3<f32> {
	let q = s * 2.0 - 1.0;
	let env = pow(max(0.0, 1.0 - q * q), 0.72);
	let rails = compositionRails();
	let familyUnit = f32(family) / 5.0;
	let harmonic = sin((params.harmony.z + familyUnit * 0.17 + params.shapeB.z * 0.08) * TAU);

	let phase = rail * 1.92 + params.harmony.z * TAU + params.cloth.w * 0.12;
	let len = 1.08 + rails.y * 0.16 - rails.z * 0.10;
	let coil = q * TAU * (0.44 + params.shapeB.w * 0.46 + rails.z * 0.34 + params.form.x * 0.22) + phase;
	let aperture = 0.28 + params.shape.z * 0.20 + rails.y * 0.34 - rails.z * 0.08 + params.form.z * 0.1;
	let throat = mix(0.38, 0.10, env) * aperture;
	var p = vec3<f32>(
		q * len,
		cos(coil) * (throat + abs(rail) * 0.08),
		sin(coil) * (throat + 0.06 + rails.y * 0.18)
	);

	let braidCenter = sin(q * TAU * 0.5 + phase) * env * (0.08 + params.shapeB.z * 0.09);
	p.y = p.y + braidCenter;
	p.z = p.z + cos(q * TAU * 0.5 + phase) * env * (0.08 + params.shapeB.z * 0.12);

	let osc = sin(q * TAU * (0.85 + familyUnit * 0.7 + params.shapeB.w * 0.55)
		+ voiceE(group).x
		+ f32(family) * 1.41);
	let slow = sin(q * 2.2 + params.cloth.w * 0.21 + rail * 2.0);
	p.y = p.y + osc * env * (0.045 + band * 0.09 + params.macroRails.y * 0.035) * params.view.w;
	p.z = p.z + slow * env * (0.12 + rails.y * 0.34 + params.shapeB.y * 0.12);

	let vaultLift = env * rails.y * (0.22 + params.shape.w * 0.16);
	p.y = p.y + vaultLift;
	p.z = p.z + rails.y * (0.18 + abs(rail) * 0.16);

	let pinch = env * clamp(0.24 + rails.z * 0.64 + params.shapeB.z * 0.20, 0.0, 0.88);
	let harmonicCenter = harmonic * env * (0.06 + params.shapeB.z * 0.06);
	p.y = mix(p.y, p.y * (1.0 - pinch) + harmonicCenter, clamp(0.18 + rails.z * 0.62, 0.0, 0.88));
	p.z = p.z + pinch * (0.12 + abs(rail) * 0.13);

	let knotAng = q * TAU * (1.0 + params.shapeB.z * 0.85) + rail * 2.8 + harmonic;
	p.y = mix(p.y, p.y * 0.42 + cos(knotAng) * (0.34 + abs(rail) * 0.18), rails.z * env);
	p.z = mix(p.z, p.z * 0.72 + sin(knotAng) * (0.42 + params.shapeB.w * 0.28), rails.z * env);

	let ghostFan = rails.w * (0.24 + hashUnit(family, u32(role * 10.0 + 3.0), 8u) * 0.28);
	p.y = mix(p.y, cos(phase) * (0.36 + familyUnit * 0.12), ghostFan);
	p.z = mix(p.z, sin(phase) * (0.28 + familyUnit * 0.1) + smoothDetail(s) * 0.06, ghostFan);

	let detail = bandDetail(family, s);
	p.z = p.z + detail * env * (0.05 + band * 0.08) * params.view.w;

	// Each group's own hits push its threads where its packets sit.
	let beatWindow = min(packetLight(group, s, 1.6), 1.5);
	p.y = p.y + beatWindow * (0.05 + band * 0.08) * sign(rail + 0.001);
	p.z = p.z + beatWindow * (0.10 + band * 0.07);
	return p;
}

fn gpoint(p: vec3<f32>, n: vec3<f32>, b: vec3<f32>, closed: f32) -> GPoint {
	return GPoint(p, n, b, closed, 1.0);
}

// 1: vaulted canopy. Strands run along the nave; lanes sweep an arch.
fn gCanopy(s: f32, lane: f32) -> GPoint {
	let q = s * 2.0 - 1.0;
	let open = params.shape.z;
	let arc = (0.40 + params.form.z * 0.36 + params.shape.w * 0.08) * PI;
	let phi = lane * arc + params.form.x * q * 0.9 + sin(params.cloth.w * 0.2) * 0.12;
	let swellH = 0.58 + 0.42 * (1.0 - q * q) * (0.55 + open * 0.6);
	let billow = sin(q * PI * (1.0 + params.formB.x * 2.0) - params.cloth.y * 0.55 + lane * 2.2);
	let r = 0.74 + 0.10 * billow - params.shape.x * 0.08;
	let p = vec3<f32>(q * 1.18, -0.36 + r * cos(phi) * swellH, r * sin(phi) * 0.92);
	let n = vec3<f32>(0.0, cos(phi), sin(phi));
	return gpoint(p, n, vec3<f32>(0.0, -sin(phi), cos(phi)), 0.0);
}

// 2: tunnel. A tube of threads along x that breathes and bends; the axial
// camera regime looks straight down it.
fn gTunnel(s: f32, lane: f32) -> GPoint {
	let q = s * 2.0 - 1.0;
	let theta = lane * PI + params.form.x * q * PI * 0.9 + params.cloth.w * 0.15;
	let breathe = 0.78 + 0.22 * sin(q * PI * (1.0 + params.formB.x * 2.0) + params.cloth.y * 0.3);
	let r = 0.5 * breathe * (0.8 + params.form.z * 0.36 + params.shape.z * 0.12 - params.shape.x * 0.1);
	let bend = vec2<f32>(sin(q * PI * 0.8 + params.cloth.w * 0.2), cos(q * PI * 0.6 + params.cloth.w * 0.13))
		* params.formB.x * 0.28;
	let p = vec3<f32>(q * 1.5, bend.x + r * cos(theta), bend.y + r * sin(theta));
	let n = vec3<f32>(0.0, cos(theta), sin(theta));
	return gpoint(p, n, vec3<f32>(0.0, -sin(theta), cos(theta)), 0.0);
}

// 3: helix tower. Interleaved helices climb a tapering column; symmetry turns
// half of them against the others into a lattice.
fn gHelix(s: f32, lane: f32, sid: f32) -> GPoint {
	let q = s * 2.0 - 1.0;
	let y = q * 0.98;
	let turns = 1.0 + (params.form.x * 0.5 + 0.5) * 1.7 + params.shape.x * 0.5;
	let counter = select(0.0, 1.0, sid > 0.5) * params.form.w;
	let dir = 1.0 - 2.0 * counter;
	let theta = lane * PI + s * turns * TAU * dir + params.cloth.w * 0.3;
	let r = (0.5 - 0.2 * s * (1.0 - params.form.z)) * (0.86 + 0.14 * sin(y * 4.0 + params.cloth.y * 0.4))
		* (0.9 + params.shape.z * 0.18);
	let p = vec3<f32>(r * cos(theta), y, r * sin(theta));
	let n = vec3<f32>(cos(theta), 0.0, sin(theta));
	return gpoint(p, n, vec3<f32>(-sin(theta), 0.0, cos(theta)), 0.0);
}

// 4: Moebius band. Each thread loops twice around the band before closing.
fn gMobius(s: f32, lane: f32) -> GPoint {
	let phi = s * 2.0 * TAU + params.cloth.w * 0.1;
	let w = (lane * 0.5 + 0.5) * (0.36 + params.form.z * 0.24) * (0.9 + params.shape.z * 0.2);
	let k = 0.5 * phi;
	let rr = 0.8 + w * cos(k);
	let wobble = 0.1 * sin(2.0 * phi + params.cloth.y * 0.3) * params.formB.x;
	var p = vec3<f32>(rr * cos(phi), w * sin(k) + wobble, rr * sin(phi));
	var widthDir = vec3<f32>(cos(k) * cos(phi), sin(k), cos(k) * sin(phi));
	let tilt = 0.42 + params.form.x * 0.32;
	p = rotateX(p, tilt);
	widthDir = rotateX(widthDir, tilt);
	let along = rotateX(vec3<f32>(-sin(phi), 0.0, cos(phi)), tilt);
	let normal = normalize(cross(along, widthDir) + vec3<f32>(0.0001, 0.0002, 0.0001));
	return gpoint(p, normal, widthDir, 1.0);
}

// 5: peacock fan. Threads spring from a low root and arc outward and toward
// the viewer like a displayed tail.
fn gFan(s: f32, lane: f32) -> GPoint {
	let spreadAngle = 0.72 + params.form.z * 0.62 + params.shape.w * 0.18;
	let alpha = lane * spreadAngle + params.form.x * s * 0.55 + sin(params.cloth.w * 0.15) * 0.08;
	let r = s * (1.12 + params.form.w * 0.12);
	var p = vec3<f32>(sin(alpha) * r, -0.62 + cos(alpha) * r, 0.0);
	p.y = p.y - params.formB.x * r * r * 0.42;
	p.z = r * r * 0.34 * cos(alpha * 1.4) + sin(alpha * 2.3 + params.cloth.w * 0.3) * 0.12 * r
		+ 0.1 * sin(s * TAU * 1.2 - params.cloth.y * 0.6 + lane * 3.0) * r;
	return gpoint(p, vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(cos(alpha), -sin(alpha), 0.0), 0.0);
}

// 6: braided rope. A three-strand plait along a gentle S; chorus strands wind
// an outer sheath against the plait.
fn gBraid(s: f32, lane: f32, kind: f32) -> GPoint {
	let q = s * 2.0 - 1.0;
	let c = vec3<f32>(
		q * 1.22,
		0.2 * sin(q * PI * (0.6 + params.formB.x) + params.cloth.w * 0.2),
		0.16 * cos(q * PI * 0.8 + params.cloth.w * 0.17)
	);
	let t = s * TAU * (2.0 + (params.form.x * 0.5 + 0.5) * 2.4 + params.shape.x) + params.cloth.y * 0.12;
	let phase = lane * PI;
	let radius = 0.15 + params.form.z * 0.12 + params.shape.z * 0.04;
	var off = vec3<f32>(0.0, radius * sin(t + phase), radius * 0.62 * sin(2.0 * (t + phase)));
	if (kind > 1.5) {
		let sheath = radius * (1.75 + params.form.w * 0.5);
		let a = -t * 0.55 + phase;
		off = vec3<f32>(0.0, sheath * cos(a), sheath * sin(a));
	}
	let n = normalize(off + vec3<f32>(0.0, 0.0001, 0.0));
	return gpoint(c + off, n, vec3<f32>(0.0, -n.z, n.y), 0.0);
}

// 7: string-art hyperboloid. Straight chords between two rings; the twist
// between the rings pinches the waist and kicks tighten it.
fn gHyperboloid(s: f32, lane: f32) -> GPoint {
	let h = 0.66;
	let ring = 0.64 + params.form.z * 0.14 + params.shape.z * 0.06;
	let theta0 = lane * PI + params.cloth.w * 0.12;
	let tw = 1.15 + (params.form.x * 0.5 + 0.5) * 1.35 + params.shape.x * 0.35 + params.pulse.x * 0.22;
	let a = theta0 - tw * 0.5;
	let b = theta0 + tw * 0.5;
	let topScale = 1.0 - params.form.w * 0.35;
	let bottom = vec3<f32>(ring * cos(a), -h, ring * sin(a));
	let top = vec3<f32>(ring * topScale * cos(b), h, ring * topScale * sin(b));
	var p = mix(bottom, top, s);
	let lean = (params.formB.x - 0.5) * 0.9;
	p = rotateZ(p, lean);
	let radial = normalize(vec3<f32>(p.x, 0.0, p.z) + vec3<f32>(0.0001, 0.0, 0.0001));
	return gpoint(p, radial, normalize(cross(radial, top - bottom)), 0.0);
}

// 8: saddle lattice. Two families of threads cross on a hyperbolic paraboloid.
fn gLattice(s: f32, lane: f32, sid: f32) -> GPoint {
	let q = s * 2.0 - 1.0;
	let family = select(0.0, 1.0, sid > 0.5);
	let u = mix(q, lane, family);
	let v = mix(lane, q, family);
	let x = u * 1.0;
	let z = v * 0.86;
	let saddle = (0.42 + params.formB.x * 0.4 + params.shape.x * 0.15) * (x * x - z * z);
	let wave = sin(x * 2.0 + params.cloth.w * 0.2) * 0.07 + sin(z * 2.6 - params.cloth.y * 0.2) * 0.05;
	var p = vec3<f32>(x, saddle * 0.75 + wave, z);
	let rot = 0.785 + params.form.x * 0.45;
	p = rotateY(p, rot);
	let along = rotateY(select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), family > 0.5), rot);
	return gpoint(p, vec3<f32>(0.0, 1.0, 0.0), along, 0.0);
}

// 9: thread galaxy. Logarithmic spiral arms in a warped disc; the centre stays
// hollow so the composition never collapses onto a glowing core.
fn gGalaxy(s: f32, lane: f32) -> GPoint {
	let r0 = 0.24;
	let r = r0 + s * (0.92 + params.form.z * 0.18);
	let arm = lane * PI;
	let wind = 1.5 + (params.form.x * 0.5 + 0.5) * 1.7 - params.shape.w * 0.3;
	let theta = arm + wind * log(r / r0) + params.cloth.w * 0.25;
	let y = 0.06 * sin(r * 9.0 - params.cloth.y * 0.8 + arm) + (params.formB.x - 0.5) * 0.36 * r * r;
	var p = vec3<f32>(r * cos(theta), y, r * sin(theta));
	// Seen near edge-on, so the disc reads as a woven platter in perspective,
	// never as a face-on vortex.
	// Kept horizontal: the orbit regime yaws all the way round, so any tilt here
	// would add to the camera pitch at some angle and show a face-on vortex.
	// Only the top-down regime sees the spiral face-on.
	let tilt = params.form.w * 0.05;
	p = rotateX(p, tilt);
	let up = rotateX(vec3<f32>(0.0, 1.0, 0.0), tilt);
	let radial = rotateX(vec3<f32>(cos(theta), 0.0, sin(theta)), tilt);
	return gpoint(p, up, radial, 0.0);
}

// 10: trefoil that ties and unties: tension and curvature tighten the knot,
// release lets it relax toward a ring.
fn gKnot(s: f32, lane: f32) -> GPoint {
	let phi = s * TAU + params.cloth.w * 0.05;
	let tie = clamp(0.2 + params.formB.x * 0.6 + params.shape.x * 0.35 - params.shape.y * 0.2, 0.05, 1.0);
	let big = 0.6;
	let small = 0.34 * tie;
	let pa = 2.0 * phi;
	let qa = 3.0 * phi;
	let base = vec3<f32>((big + small * cos(qa)) * cos(pa), small * sin(qa) * 1.3, (big + small * cos(qa)) * sin(pa));
	let radial = vec3<f32>(cos(pa), 0.0, sin(pa));
	let psi = lane * PI + s * TAU * 2.0 * params.form.x;
	let o = 0.07 * (0.6 + params.form.z);
	var p = base + radial * o * cos(psi) + vec3<f32>(0.0, o * sin(psi), 0.0);
	p = rotateX(p, 0.55);
	return gpoint(p, rotateX(radial, 0.55), rotateX(vec3<f32>(0.0, 1.0, 0.0), 0.55), 1.0);
}

// 11: orrery rings. Each strand closes on itself as a tilted ring; symmetry
// gathers them onto one centre as an armillary, low symmetry strings them out.
fn gRings(s: f32, lane: f32, sid: f32) -> GPoint {
	let phi = s * TAU;
	// Never fully concentric: a gathered armillary would read as a centred orb.
	let gather = params.form.w * 0.5;
	let rho = (0.24 + 0.26 * (1.0 - abs(lane)) + params.form.z * 0.1) * (1.0 + gather * 0.35);
	let c = vec3<f32>(
		lane * 0.95 * (1.0 - gather),
		sin(lane * 3.0 + params.cloth.w * 0.3) * 0.12 * (1.0 - gather),
		cos(lane * 2.0) * 0.1 * (1.0 - gather)
	);
	let tiltA = lane * (0.9 + params.form.x * 0.9) + params.cloth.w * 0.2 * (0.5 + sid);
	let tiltB = 0.6 * sin(lane * 2.3 + params.cloth.w * 0.17) + gather * lane * 1.4;
	var local = vec3<f32>(rho * cos(phi), rho * sin(phi), 0.0);
	local = rotateY(rotateX(local, tiltA), tiltB);
	let n = rotateY(rotateX(vec3<f32>(cos(phi), sin(phi), 0.0), tiltA), tiltB);
	let b = rotateY(rotateX(vec3<f32>(0.0, 0.0, 1.0), tiltA), tiltB);
	return gpoint(c + local, n, b, 1.0);
}

// 12: aurora curtain. Hanging threads in a folded drape; the fold travels.
fn gCurtain(s: f32, lane: f32) -> GPoint {
	let y = mix(-0.55, 0.88, s);
	let folds = 1.2 + params.form.z * 1.6;
	let fold = sin(lane * PI * folds + params.cloth.w * 0.35 + y * (0.8 + params.form.x * 0.8));
	let x = lane * 1.25 + 0.12 * sin(y * 2.5 + params.cloth.w * 0.4 + lane * 2.0) * s;
	let z = fold * (0.3 + params.shape.x * 0.1) * (0.55 + 0.45 * s) + params.formB.x * 0.26 * (1.0 - lane * lane);
	return gpoint(vec3<f32>(x, y, z), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), 0.0);
}

fn grammarPoint(g: u32, s: f32, strand: Strand, lane: f32) -> GPoint {
	var out: GPoint;
	switch g {
		case 1u: { out = gCanopy(s, lane); }
		case 2u: { out = gTunnel(s, lane); }
		case 3u: { out = gHelix(s, lane, strand.sid); }
		case 4u: { out = gMobius(s, lane); }
		case 5u: { out = gFan(s, lane); }
		case 6u: { out = gBraid(s, lane, strand.kind); }
		case 7u: { out = gHyperboloid(s, lane); }
		case 8u: { out = gLattice(s, lane, strand.sid); }
		case 9u: { out = gGalaxy(s, lane); }
		case 10u: { out = gKnot(s, lane); }
		case 11u: { out = gRings(s, lane, strand.sid); }
		case 12u: { out = gCurtain(s, lane); }
		default: {
			let p = architecturePoint(s, lane * 1.08, strand.family, strand.role, strandBand(strand), strand.group);
			out = GPoint(p, vec3<f32>(0.0, 0.28, 0.96), vec3<f32>(0.0, 0.96, -0.28), 0.0, 0.0);
		}
	}
	return out;
}

// The current grammar, crossfading from the previous one while a section
// change morphs the threads; mid-morph the weave lifts apart a little. The
// look can also lean the figure toward a second grammar (hybrid), so the
// grammars are corners of a continuous space rather than a set of shapes.
fn surfacePoint(s: f32, strand: Strand, lane: f32) -> GPoint {
	let t = clamp(params.topo.z, 0.0, 1.0);
	let gTo = u32(params.topo.y + 0.5);
	let gFrom = u32(params.topo.x + 0.5);
	var out = grammarPoint(gTo, s, strand, lane);
	if (t < 0.999 && gFrom != gTo) {
		let a = grammarPoint(gFrom, s, strand, lane);
		let lift = sin(t * PI) * (0.06 + strand.sid * 0.08);
		let n = normalize(mix(a.n, out.n, t) + vec3<f32>(0.0001, 0.0002, 0.0003));
		out = GPoint(
			mix(a.p, out.p, t) + n * lift,
			n,
			normalize(mix(a.b, out.b, t) + vec3<f32>(0.0002, 0.0001, 0.0003)),
			mix(a.closed, out.closed, t),
			mix(a.react, out.react, t)
		);
	}
	let h = clamp(params.hybrid.y, 0.0, 0.6);
	if (h > 0.002) {
		let c = grammarPoint(u32(params.hybrid.x + 0.5), s, strand, lane);
		out = GPoint(
			mix(out.p, c.p, h),
			normalize(mix(out.n, c.n, h) + vec3<f32>(0.0001, 0.0002, 0.0003)),
			normalize(mix(out.b, c.b, h) + vec3<f32>(0.0002, 0.0001, 0.0003)),
			mix(out.closed, c.closed, h),
			mix(out.react, c.react, h)
		);
	}
	return out;
}

// Strand spacing across the surface: < 1 crowds the strands to the edges,
// > 1 gathers them to the middle. Wanders with the look.
fn laneSpacing(lane: f32) -> f32 {
	return sign(lane) * pow(abs(lane), params.figure.z);
}

// The figure's continuous form (look.ts LoomFigure), in strand space: centred
// on its bounds, wrung about its vertical and long axes, bent, flared, rippled
// by three slow travelling waves whose directions drift, then leant. Every
// parameter wanders on non-repeating noise, so the ribbons keep finding forms.
fn deformFigure(p0: vec3<f32>) -> vec3<f32> {
	var p = p0;
	p.y = p.y - params.warpPhase.w;
	let k = params.figure.w;
	p = rotateY(p, params.deform.x * p.y * k);
	p = rotateX(p, params.deform.y * p.x * k);
	p.y = p.y + params.deform.z * k * (p.x * p.x - 0.4);
	let flare = max(0.35, 1.0 + params.deform.w * k * p.y);
	p.x = p.x * flare;
	p.z = p.z * flare;
	let dirA = normalize(params.warpB.xyz + vec3<f32>(0.0001, 0.0002, 0.0003));
	let dirB = normalize(params.warpC.xyz + vec3<f32>(0.0002, 0.0001, 0.0003));
	let dirC = normalize(params.warpA.xyz + vec3<f32>(0.0003, 0.0002, 0.0001));
	let waveA = sin(dot(params.warpA.xyz, p) + params.warpPhase.x) * params.warpA.w;
	let waveB = sin(dot(params.warpB.xyz, p) + params.warpPhase.y) * params.warpB.w;
	let waveC = sin(dot(params.warpC.xyz, p) + params.warpPhase.z) * params.warpC.w;
	p = p + (dirA * waveA + dirB * waveB + dirC * waveC) * k;
	return rotateZ(rotateX(p, params.figure.x), params.figure.y);
}

// Which primary rail leads: the one whose instrument leads the band right now
// (ensemble.ts), handed over in a slow glide; never on a predicted phrase.
fn heroWeight(instanceIndex: u32) -> f32 {
	return clamp(voiceE(min(instanceIndex, 2u)).z, 0.0, 1.0);
}

// One weft draft: how many times a filament crosses between its two rails in
// a phrase, and where the crossing pattern starts. Hashed from the phrase so
// every phrase re-drafts the weave; knot weight, energy and the genome's
// crossing density densify it.
fn weftDraft(phrase: f32, index: u32) -> vec2<f32> {
	let h = hashUnit(u32(max(phrase, 0.0)) + 1u, index + 11u, 5u);
	let h2 = hashUnit(u32(max(phrase, 0.0)) + 1u, index + 23u, 9u);
	let crossings = 1.0 + floor(h * 3.0) + params.grammar.x * 2.0 + params.macroRails.x * 1.5
		+ params.form.y * 3.0;
	return vec2<f32>(crossings, h2 * TAU);
}

// Each weft strand keeps its own draft; the whole weave no longer re-drafts at
// once on every phrase. Chord changes re-thread one weft group at a time (its
// crossings and phase glide to the chord, ensemble.ts).
fn weftAngle(s: f32, index: u32) -> f32 {
	let draft = weftDraft(0.0, index);
	let rethread = voiceC(3u + (index & 1u));
	let crossings = max(0.5, draft.x + rethread.x);
	let phase = draft.y + params.harmony.z * TAU * 0.5 + rethread.y;
	return s * TAU * crossings + phase;
}

// Shuttle position along the threads: advances one step per beat with an eased
// throw, so the sweep lands on the beat.
fn shuttleS() -> f32 {
	let beat = params.cloth.x;
	let stepped = floor(beat) + smoothstep(0.0, 0.55, fract(beat));
	return fract(stepped * 0.125);
}

fn strandInfo(instanceIndex: u32) -> Strand {
	var st: Strand;
	if (instanceIndex < PRIMARY) {
		st.kind = 0.0;
		st.lane = (f32(instanceIndex) - 1.0) * 0.6666667;
		st.laneB = st.lane;
		st.family = min(instanceIndex * 2u, 5u);
		st.familyHi = min(instanceIndex * 2u + 1u, 5u);
		st.bandT = smoothstep(0.5, 0.62, params.audioB.w);
		st.role = 0.0;
		st.sid = hashUnit(instanceIndex, 71u, 3u);
		st.weft = 0u;
		st.group = instanceIndex;
	} else if (instanceIndex < FIRST_CHORUS) {
		let sub = instanceIndex - PRIMARY;
		let pairA = sub & 1u;
		st.kind = 1.0;
		st.lane = (f32(pairA) - 1.0) * 0.6666667;
		st.laneB = f32(pairA) * 0.6666667;
		st.family = min(pairA * 2u, 5u);
		st.familyHi = st.family;
		st.bandT = 0.0;
		st.role = 0.0;
		st.sid = hashUnit(sub, 73u, 5u);
		st.weft = sub;
		st.group = 3u + pairA;
	} else {
		let k = instanceIndex - FIRST_CHORUS;
		// Bit-reversed lane order: any visible prefix is spread evenly.
		let rev = ((k & 1u) << 3u) | ((k & 2u) << 1u) | ((k & 4u) >> 1u) | ((k & 8u) >> 3u);
		st.kind = 2.0;
		st.lane = -1.0 + (f32(rev) + 0.5) / 8.0;
		st.laneB = st.lane;
		st.family = k % 6u;
		st.familyHi = st.family;
		st.bandT = 0.0;
		st.role = f32(k & 1u);
		st.sid = f32(k & 1u) * 0.6 + hashUnit(k, 79u, 7u) * 0.4;
		st.weft = k;
		// Chorus groups are bands of four neighbouring lanes, so each answers
		// its instrument in its own part of the weave (the first visible
		// strands, in bit-reversed order, fall one in each band).
		st.group = 5u + (rev / 4u);
	}
	return st;
}

// World-space point on strand: grammar surface, weft threading, the shared
// reactive layer and the genome's beat form. w = how closed the loop is.
fn loomPoint(s: f32, st: Strand) -> vec4<f32> {
	let va = voiceA(st.group);
	let vb = voiceB(st.group);
	let vc = voiceC(st.group);
	// A build gathers a chorus group toward the middle, a diminished chord
	// clusters it, stereo width spreads it.
	let gather = 1.0 - voiceD(st.group).x;
	var lane = laneSpacing(st.lane) * gather;
	var weftLift = 0.0;
	if (st.kind == 1.0) {
		let angle = weftAngle(s, st.weft);
		lane = mix(laneSpacing(st.lane), laneSpacing(st.laneB), 0.5 + 0.5 * sin(angle)) * gather;
		weftLift = cos(angle);
	}
	let g = surfacePoint(s, st, lane);
	let env = mix(taperEnv(s), 1.0, g.closed);
	var p = g.p;
	if (st.kind == 1.0) {
		// Thread around the rails rather than through them.
		p = p + g.n * weftLift * (0.055 + params.shapeB.z * 0.03) * env;
	}

	let band = strandBand(st);
	let familyUnit = f32(st.family) / 5.0;
	let sw = fract(s);
	let q = sw * 2.0 - 1.0;
	if (g.react > 0.001) {
		// Swing (lean) skews the group's wave, so it leans off the beat.
		let osc = sin(q * TAU * (0.85 + familyUnit * 0.7 + params.shapeB.w * 0.55)
			+ voiceE(st.group).x + f32(st.family) * 1.41 + vb.z * q * 1.4);
		var r = g.n * osc * env * (0.04 + band * 0.05 + params.macroRails.y * 0.03) * params.view.w;
		// Legato smooths a group's ribbon; hats and staccato roughen it.
		r = r + g.b * bandDetail(st.family, sw) * env * (0.022 + band * 0.025) * params.view.w * vb.x;
		// The group's own hits push its threads where its packets sit.
		let beatWindow = min(packetLight(st.group, sw, 1.6), 1.5);
		r = r + (g.n * (0.05 + band * 0.08) + g.b * (0.06 + band * 0.06)) * beatWindow;
		p = p + r * g.react;
	}

	// Slack: a loosened group sags and sways; a breakdown lets withdrawn groups
	// fall away. Lean tilts the group along its length.
	let slack = va.z;
	let sag = mix(sin(PI * sw), 1.0, g.closed);
	p.y = p.y - slack * 0.3 * sag * env;
	p = p + g.b * slack * 0.1 * sin(sw * TAU * 2.0 + params.postB.w * 1.3 + st.sid * 5.0) * env;
	p = p + g.n * vb.z * 0.035 * q * env;
	if (st.group == 0u) {
		// The bass line: the low rail rises and falls with the bass pitch, a
		// leap plucks it, a walking bass ripples along it.
		let bass = parts[PART_BASS];
		let walk = parts[PART_BASS_WALK];
		let pluck = bass.x * 0.075 * sin(PI * sw * bass.y) * cos(bass.z);
		let walking = bass.w * 0.04 * sin(sw * TAU * 1.5 - walk.x * 2.0);
		p.y = p.y + vb.y * 0.09 * env;
		p = p + (g.n + vec3<f32>(0.0, 0.6, 0.0)) * (pluck + walking) * env;
	}

	// Turbulence (noisy, restless music): the threads churn in an eddying
	// current; fraying shivers loose fibres off the weft and chorus.
	let turbulence = params.weave.z;
	if (turbulence > 0.001) {
		let tt = params.postB.w * 1.7;
		let eddy = vec3<f32>(
			sin(sw * 11.0 + tt * 2.3 + st.sid * 7.0) + 0.5 * sin(sw * 27.0 - tt * 3.9 + st.sid * 2.0),
			sin(sw * 13.0 - tt * 1.9 + st.sid * 3.0) + 0.5 * sin(sw * 23.0 + tt * 4.3 + st.sid * 5.0),
			sin(sw * 9.0 + tt * 2.7 + st.sid * 5.0) + 0.5 * sin(sw * 31.0 - tt * 3.1 + st.sid * 9.0)
		);
		p = p + eddy * turbulence * 0.032 * env;
	}
	let frayAmount = params.weave.x * select(0.004, 0.011, st.kind > 0.5);
	if (frayAmount > 0.0001) {
		p = p + vec3<f32>(sin(sw * 97.0 + st.sid * 13.0), sin(sw * 83.0 + st.sid * 29.0), sin(sw * 71.0 + st.sid * 7.0))
			* frayAmount * env;
	}

	// Beat forms. Plucked strings ring a standing wave on each kick; the
	// shuttle bump rides the threads one step per beat.
	// Plucked strings ring a standing wave on each of their own group's hits;
	// a fill's shuttle lifts every thread as it passes.
	let modeCount = 2.0 + f32(st.family % 3u);
	let pluck = params.beat.y * vc.w * 0.085 * sin(PI * sw * modeCount)
		* sin(params.view.z * TAU * 6.5 + st.sid * 9.0) * mix(env, 1.0, 0.4);
	let shuttle = shuttleBandAt(st.group, sw, 1.6) * 0.05;
	p = p + g.n * (pluck + shuttle) * params.beatB.y;
	return vec4<f32>(deformFigure(p), g.closed);
}

fn colorPeak(c: vec3<f32>) -> vec3<f32> {
	return c / max(max(c.r, max(c.g, c.b)), 1e-3);
}

// The floor's reflection of a strand point: mirrored through the floor plane
// in stage space and, on water, rippled (kicks and sub send swells, and the
// deeper the image the more the surface bends it). w: height of the original
// above the floor (negative = the strand dips under the surface).
fn mirrorStage(q: vec3<f32>) -> vec4<f32> {
	let floorY = floorStageY();
	let height = q.y - floorY;
	let t = params.view.z;
	// The water swells with the bass notes' rings (ensemble.ts), not the mix.
	let rings = parts[PART_RING_A].w + parts[PART_RING_A + 1u].w;
	let swell = params.envA.z * (0.45 + rings * 0.9) * (0.2 + max(height, 0.0));
	let wobble = vec2<f32>(
		sin(q.z * 6.3 + t * 1.3 + sin(q.x * 3.1 - t * 0.7)) + 0.5 * sin(q.x * 13.0 - t * 2.1),
		sin(q.x * 5.7 - t * 1.1) + 0.5 * sin(q.z * 11.0 + t * 1.7)
	) * 0.016 * swell;
	return vec4<f32>(q.x + wobble.x, 2.0 * floorY - q.y, q.z + wobble.y, height);
}

// Strand point in view space; w is its height above the floor.
fn strandView(world: vec3<f32>, mirrored: bool) -> vec4<f32> {
	let q = stagePoint(world);
	if (mirrored) {
		let m = mirrorStage(q);
		return vec4<f32>(stageToView(m.xyz), m.w);
	}
	return vec4<f32>(stageToView(q), q.y - floorStageY());
}

fn strandVertex(vertexIndex: u32, instanceIndex: u32, mirrored: bool) -> LoomOut {
	let isChorus = instanceIndex >= FIRST_CHORUS;
	let segments = select(SEGMENTS, CHORUS_SEGMENTS, isChorus);
	let sides = select(TUBE_SIDES, CHORUS_SIDES, isChorus);
	let verticesPerSegment = sides * 6u;
	let segment = vertexIndex / verticesPerSegment;
	let faceVertex = vertexIndex % verticesPerSegment;
	let face = faceVertex / 6u;
	let corner = faceVertex % 6u;
	let endpoint = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
	let radialSide = select(0u, 1u, corner == 2u || corner == 3u || corner == 5u);
	let sample = min(segment + endpoint, segments);
	let s = f32(sample) / f32(segments);
	let epsilon = 1.0 / f32(segments);

	let st = strandInfo(instanceIndex);
	let centerWorld = loomPoint(s, st);
	let previousWorld = loomPoint(s - epsilon, st);
	let followingWorld = loomPoint(s + epsilon, st);
	let closed = clamp(centerWorld.w, 0.0, 1.0);
	let centerView = strandView(centerWorld.xyz, mirrored);
	let center = centerView.xyz;
	let height = centerView.w;
	let previous = strandView(previousWorld.xyz, mirrored).xyz;
	let following = strandView(followingWorld.xyz, mirrored).xyz;
	let tangent = normalize(following - previous + vec3<f32>(0.0001, 0.0002, 0.0003));
	let reference = select(
		vec3<f32>(0.0, 1.0, 0.0),
		vec3<f32>(1.0, 0.0, 0.0),
		abs(tangent.y) > 0.86
	);
	let axisA = normalize(cross(tangent, reference) + vec3<f32>(0.0001, 0.0002, 0.0003));
	let axisB = normalize(cross(axisA, tangent) + vec3<f32>(0.0001, 0.0002, 0.0003));
	let radialIndex = face + radialSide;
	let radialAngle = f32(radialIndex) / f32(sides) * TAU;
	let radial = axisA * cos(radialAngle) + axisB * sin(radialAngle);

	let kind = st.kind;
	let family = st.family;
	let band = strandBand(st);
	let familyUnit = f32(family % 6u) / 5.0;
	let rails = compositionRails();
	let q = s * 2.0 - 1.0;

	// Thickness profile from the genome: tapered, even, beaded or swelling.
	let capEnds = mix(smoothstep(0.0, 0.05, s) * smoothstep(1.0, 0.95, s), 1.0, closed);
	let taper = mix(1.0, 0.45 + 0.55 * pow(max(0.0, 1.0 - q * q), 0.5), params.formB.y * (1.0 - closed));
	let crawl = voiceE(st.group).y;
	let bead = 1.0 + params.formB.z * 0.95 * pow(0.5 + 0.5 * sin(s * TAU * 9.0 - crawl * 0.25 + st.sid * 4.0), 6.0);
	let swell = 1.0 + params.formB.w * 0.75 * (0.5 + 0.5 * sin(s * TAU * 1.5 + params.cloth.w * 0.4 + st.sid * 3.0));
	// Fraying (noisy music): the tube surface goes ragged, fibre by fibre.
	let frayNoise = hashUnit(sample + instanceIndex * 409u, radialIndex % sides, 29u);
	let fray = 1.0 + params.weave.x * (frayNoise - 0.4) * 0.9;
	let profile = capEnds * taper * bead * swell * fray * params.frame.z;

	let va = voiceA(st.group);
	let vb = voiceB(st.group);
	let vc = voiceC(st.group);
	let vd = voiceD(st.group);
	var hero = 0.0;
	var radius = params.style.x;
	var visible = 1.0;
	if (kind == 0.0) {
		hero = heroWeight(instanceIndex);
		// Hierarchy: the hero rail is clearly the thickest line in the frame.
		radius = params.style.x * (1.22 + hero * 1.2 + band * 0.15);
	} else if (kind == 1.0) {
		radius = params.style.x * 0.55 * (0.5 + band * 0.12) * (1.0 - params.cloth.z * 0.6);
	} else {
		let k = f32(instanceIndex - FIRST_CHORUS);
		visible = smoothstep(k, k + 1.0, params.topo.w * 16.0);
		// chorusLevel is the light budget's chorus width: thin when the grammar is dense.
		radius = params.style.x * (0.56 + band * 0.16) * visible * params.materialD.z;
	}
	// Each group's own voice sets its weight (and a withdrawn group thins out).
	// A hit swells its own thread where its packet sits (weight on the beat).
	let packet = packetLight(st.group, fract(s), 1.0);
	radius = radius * profile * va.y * (1.0 + min(packet, 1.5) * 0.5);

	// A reflection deep below a rough floor spreads and dims (energy kept).
	var mirrorDim = 1.0;
	if (mirrored) {
		let spread = 1.0 + params.envA.y * max(height, 0.0) * 3.0;
		radius = radius * spread;
		mirrorDim = floorVisibility() / spread;
	}

	// Proper perspective with near clipping, so camera regimes can fly inside
	// the weave; threads close to the lens thin out instead of filling it.
	let depth0 = params.camera.z - center.z;
	radius = radius * mix(1.0, smoothstep(0.12, 0.95, depth0), params.frame.y);
	let position = center + radial * radius;
	let depth = params.camera.z - position.z;
	let clip = projectView(position);

	let detail = bandDetail(family, fract(s));
	let intersection = exp(-pow(abs(fract(s) - fract(crawl * 6.0 / ${LOOM_CRAWL_WRAP.toFixed(6)} + familyUnit * 0.23)), 2.0) * 70.0);
	// Phosphor core: rails carry an HDR emissive charge that bloom and the
	// feedback trail pick up. Light packets are the group's own hits, sitting
	// where they fell in the bar (ensemble.ts): kick on one rail, snare on
	// another, hats glittering in a chorus group, chord tones in another.
	let packetsW = 0.6 + params.beat.x * 0.4;
	var emission = 0.2 + band * 0.08;
	var flash = packet * 1.1 * packetsW;
	if (kind == 0.0) {
		emission = (0.48 + hero * 0.66) + band * 0.15;
		flash = packet * 3.6 * packetsW;
	} else if (kind == 2.0) {
		// Chorus strands are structure: their glow comes from the light budget.
		emission = (0.36 + band * 0.1) * params.beatB.w;
		flash = packet * 2.4 * packetsW * max(params.beatB.w, 0.6);
	}
	// Crossing pulses: where the weft passes over a thread, the group's hits flash.
	let crossAngle = weftAngle(s, st.weft + select(0u, 1u, kind == 0.0 && instanceIndex == 2u));
	let crossing = pow(abs(sin(crossAngle)), 22.0);
	flash = flash + params.beat.z * crossing * vc.w * 2.6 * select(1.0, 0.5, kind == 1.0);
	// Shuttle: a fill throws a bright band along one group's threads, once.
	flash = flash + shuttleBandAt(st.group, fract(s), 1.0) * (1.4 + params.beat.w * 1.2);
	// Sparks: fine glints shed along the threads; the hat group glitters with
	// every hat (a new scatter of glints per hit), fraying sheds more.
	let sparkSeed = hashUnit(u32(fract(s) * 61.0) + 1u, instanceIndex + 3u, u32(vd.y) + u32(crawl * 0.5) * 977u);
	let spark = select(0.0, 1.0, sparkSeed > 0.95 - params.weave.x * 0.04 - vb.w * 0.07) * pow(max(0.0, sin(s * 157.0 + st.sid * 13.7 - params.view.z * 11.0)), 40.0)
		* (params.beatB.x * (0.3 + vc.w * 1.6) + vb.w * 2.2 + params.materialD.y * 0.12 + params.weave.x * 0.35)
		* select(1.0, 0.5, kind == 2.0);
	// The music's flashes keep their contrast in dark, drawn tones: light
	// where the music puts it, even when the weave itself is dim.
	// The eye adapts slowly to how much steady light the rails give: the
	// whole song keeps one exposure while the parts carry the music.
	let adapted = lightsIn[LIGHT_RAILS * LIGHT_POINTS * 2u].z;
	let eye = select(1.0, clamp(pow(max(adapted, 0.01), 0.6), 0.7, 1.4), adapted > 0.0);
	let emissionScale = params.style.z * (1.0 - params.style.w * 0.8) * eye;
	emission = emission * emissionScale * params.frame.w * va.x
		+ flash * emissionScale * max(params.frame.w, 0.75) * mix(1.0, va.x, 0.5);
	// Beats read as a colour event, not only a brightness event: the packet
	// shifts toward the weft colour as it travels.
	let packetMix = clamp(packet * 1.5 * packetsW, 0.0, 1.0) * select(0.8, 1.0, kind == 0.0);

	// Three colour roles, not a sweep: hero rail = hero, supporting rails =
	// support, weft = weft; chorus strands span support to weft across lanes.
	let heroC = params.heroTint.rgb * params.heroTint.w;
	let supportC = params.supportTint.rgb * params.supportTint.w;
	let weftC = params.weftTint.rgb * params.weftTint.w;
	var base = mix(supportC, heroC, hero);
	var value = 0.36 + hero * 0.2 + band * 0.3 + params.macroRails.x * 0.1;
	if (kind == 1.0) {
		base = weftC;
		value = value * (0.9 + rails.w * 0.15);
	} else if (kind == 2.0) {
		base = mix(supportC, weftC, 0.5 + 0.5 * st.lane);
		base = mix(base, heroC, 0.25 * (1.0 - abs(st.lane)));
		value = value * 0.92;
	}
	base = mix(base, weftC, max(0.0, -params.harmony.w) * 0.12);
	// The chord's colour relation, per group: major warm, minor cool,
	// diminished clashing (alternate groups pulled apart round the wheel).
	base = hueRotate(base, va.w);
	value = value * (1.0 - params.style.w * 0.56);

	let cameraPoint = vec3<f32>(0.0, 0.0, params.camera.z);
	var out: LoomOut;
	out.position = clip;
	out.worldNormal = radial;
	out.viewDirection = normalize(cameraPoint - position);
	// A packet runs hot: the weft colour lifted toward white, so it reads on
	// a bright ribbon as well as on a dim one.
	let hot = mix(colorPeak(weftC), vec3<f32>(1.0, 0.96, 0.9), 0.35) * max(value, 0.45) * 1.5;
	out.color = mix(base * value, hot, packetMix);
	out.dataA = vec4<f32>(s, kind, band, select(st.role, hero, kind == 0.0));
	out.dataB = vec4<f32>(detail, emission, intersection, depth);
	out.tangent = tangent;
	out.dataC = vec4<f32>(st.lane, st.sid, spark * params.style.z * (1.0 - params.style.w) * min(va.x, 1.4), visible);
	out.envData = vec4<f32>(height, select(0.0, 1.0, mirrored), mirrorDim, crawl);
	return out;
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> LoomOut {
	return strandVertex(vertexIndex, instanceIndex, false);
}

// The same strands drawn mirrored through the floor plane, before the floor
// itself, which then lays its Fresnel-weighted surface over them.
@vertex
fn vs_mirror(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> LoomOut {
	return strandVertex(vertexIndex, instanceIndex, true);
}

// What a chrome or pearl fibre sees: the dark stage, the key light's glint,
// and the floor's pool of ribbon light below.
fn envReflection(r: vec3<f32>, keyLight: vec3<f32>, keyColor: vec3<f32>) -> vec3<f32> {
	let glow = params.glowTint.rgb;
	let haze = params.hazeTint.rgb;
	let up = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);
	var c = haze * 0.12 * up;
	c = c + glow * 0.32 * exp(-pow((r.y + 0.45) * 3.0, 2.0)) * params.envC.y;
	c = c + keyColor * pow(max(dot(r, keyLight), 0.0), 24.0) * 1.6;
	return c;
}

fn shadeStrand(in: LoomOut) -> vec3<f32> {
	let normal = normalize(in.worldNormal);
	let view = normalize(in.viewDirection);
	// The key light has its own slow voice (the chord's warmth, the fill).
	let lightVoice = parts[PART_LIGHT];
	let az = (params.light.x + lightVoice.z) * TAU;
	let keyLight = normalize(vec3<f32>(-0.66 * cos(az), params.light.y, 0.5 + 0.32 * sin(az)));
	let rimLight = normalize(vec3<f32>(0.72 * cos(az), -0.24, 0.52 - 0.2 * sin(az)));
	let kind = in.dataA.y;
	let isSecondary = kind == 1.0;
	let isChorus = kind == 2.0;
	let matA = params.materialA;
	let matB = params.materialB;
	let matC = params.materialC;
	let matD = params.materialD;
	// Punchy music cuts hard, hot-cored edges; soft music glows softly.
	let edge = params.weave.w;

	let ndv = dot(normal, view);
	let diffuseKey = max(dot(normal, keyLight), 0.0);
	let diffuseFill = max(dot(normal, rimLight), 0.0);
	let rim = pow(1.0 - abs(ndv), mix(2.6, 1.6, edge));
	let specPower = mix(12.0, 110.0, matA.z) * mix(0.6, 1.7, edge);
	let specular = pow(max(dot(reflect(-keyLight, normal), view), 0.0), specPower);
	let hero = select(0.0, in.dataA.w, kind == 0.0);
	// Striations crawl along the rail a quarter period per beat, so tempo is
	// visible on the surface; the hero carries the strongest pattern.
	// Coarse enough to resolve at Loom's pixel cap: finer striations alias into
	// shimmering noise on thin strands.
	let stripePhase = in.dataA.x * select(190.0, 330.0, isSecondary) - in.envData.w * 1.5;
	let stripeAmount = clamp((0.015 + hero * 0.075) * matC.y + max(0.0, matC.y - 2.0) * 0.09, 0.0, 0.62);
	let striation = (1.0 - stripeAmount) + stripeAmount * cos(stripePhase);
	// Fibre grain (noisy, dark timbres): a fixed, coarse grain on the surface.
	let grainNoise = hashUnit(u32(in.dataA.x * 420.0), u32(in.dataC.y * 977.0) + u32(kind), 17u);
	let grain = 1.0 - params.weave.y * 0.5 * grainNoise;

	let warm = clamp(params.light.z + lightVoice.x, 0.0, 1.0);
	let warmTint = mix(vec3<f32>(0.96, 0.98, 1.04), vec3<f32>(1.06, 0.94, 0.8), warm);
	let rimColor = mix(vec3<f32>(1.0), colorPeak(params.weftTint.rgb), 0.6) * 1.05;
	// Coloured light rig: key carries the support colour, fill the hero, so
	// highlights never bleach the palette to white.
	let keyColor = mix(vec3<f32>(1.0), colorPeak(params.supportTint.rgb), 0.45) * warmTint;
	let fillColor = colorPeak(params.heroTint.rgb) * params.light.w * lightVoice.y;
	let detailShade = 1.0 + in.dataB.x * select(0.18, 0.5, !isSecondary);

	// Pearl: the body colour slides toward the weft colour at grazing angles.
	let lum = dot(in.color, vec3<f32>(0.3, 0.55, 0.15));
	let iridColor = colorPeak(params.weftTint.rgb) * lum * 1.5;
	var body = mix(in.color, vec3<f32>(lum * 1.25), matD.w);
	body = mix(body, iridColor, clamp(rim * matD.x * 1.3, 0.0, 1.0));

	// Brushed-fibre highlight: the tube reads as wound filament, not plastic.
	let tangent = normalize(in.tangent);
	let halfVector = normalize(keyLight + view);
	let tangentDot = dot(tangent, halfVector);
	let sinT = sqrt(max(1.0 - tangentDot * tangentDot, 0.0));
	let aniso = pow(sinT, select(48.0, 90.0, isSecondary));
	let sheen = pow(sinT, 6.0);
	let coreExponent = mix(1.5, 4.2, edge);
	let core = pow(max(ndv, 0.0), coreExponent) * mix(0.85, 1.35, edge);
	// Molten glass: long, slowly flowing heat bands along the thread.
	let hot = 1.0 + matC.w * 0.9 * pow(0.5 + 0.5 * sin(in.dataA.x * TAU * 1.5 + in.dataC.y * 6.0 - in.envData.w * 0.125), 2.5);
	let emissive = body * in.dataB.y * (0.4 + core * 1.3) * (1.0 + in.dataB.x * 0.6 * hero) * matB.y * hot;
	let whiteCore = vec3<f32>(1.0, 0.97, 0.94) * in.dataB.y * pow(max(ndv, 0.0), 5.0) * matB.w * 0.32;
	let crossingGlow = rimColor * in.dataB.z * (0.16 + params.pulse.y * 0.12);
	let mirror = envReflection(reflect(-view, normal), keyLight, keyColor) * matB.z * (0.35 + rim * 0.9);
	let backLight = body * pow(max(dot(-view, keyLight), 0.0) * 0.5 + 0.5, 3.0) * rim * matC.z * 0.6;
	let sparkle = vec3<f32>(1.0, 0.96, 0.92) * in.dataC.z * 2.4;

	// Matte tones (low emission gain) also quieten the rim, so they read as lit
	// sculpture instead of outlined glow.
	let glowSurface = 0.4 + 0.6 * clamp(params.frame.w * 1.4, 0.0, 1.0);
	var lit = body * (0.13 + diffuseKey * 0.58 * keyColor + diffuseFill * 0.22 * fillColor) * striation * detailShade * matA.x
		+ rimColor * rim * (0.17 + params.style.z * 0.14) * matB.x * glowSurface
		+ keyColor * specular * 0.18 * matA.y
		+ keyColor * aniso * select(0.10, 0.24, !isSecondary) * matA.w
		+ body * sheen * 0.32 * matC.x
		+ emissive + whiteCore + crossingGlow + mirror + backLight + sparkle;
	lit = mix(lit, lit * 0.7, select(0.0, 0.3, isSecondary));
	return lit * select(1.0, 0.92, isChorus) * params.beatB.z * grain;
}

@fragment
fn fs_main(in: LoomOut) -> @location(0) vec4<f32> {
	return vec4<f32>(shadeStrand(in), 1.0);
}

@fragment
fn fs_mirror(in: LoomOut) -> @location(0) vec4<f32> {
	// A strand that dips under the surface has no reflection above it.
	if (in.envData.x < 0.0) { discard; }
	return vec4<f32>(shadeStrand(in) * in.envData.z, 1.0);
}

// The ribbons as light sources. Each primary rail is sampled at a few points
// (view space) with the light it gives off, so the floor, the medium, the far
// threads and the dust can be lit by it. Packets and the shuttle travel along
// it, so beats light the room where they run.
// rgb: the rail's steady light (its slow glow and width); w: how much its
// transients (packets, the shuttle, the band) multiply that right now. The far
// stage takes only the steady light, so a kick on one rail never relights the
// whole room; surfaces near the rails take the transients too.
fn railLight(s: f32, rail: u32, st: Strand) -> vec4<f32> {
	let hero = heroWeight(rail);
	let band = strandBand(st);
	let packetsW = 0.6 + params.beat.x * 0.4;
	let va = voiceA(rail);
	let vd = voiceD(rail);
	// Wider than the visible packet: the light is sampled at only a few points.
	let packet = packetLight(rail, s, 2.6);
	let shuttle = shuttleBandAt(rail, s, 2.4) * 1.2;
	let gain = params.style.z * (1.0 - params.style.w * 0.8) * params.frame.w;
	let steadyEmission = (0.42 + hero * 0.62) * vd.z * gain;
	let transientEmission = (band * 0.2 + packet * 2.4 * packetsW + shuttle) * gain;
	let base = hueRotate(mix(params.supportTint.rgb * params.supportTint.w, params.heroTint.rgb * params.heroTint.w, hero), va.w);
	let value = 0.36 + hero * 0.2 + params.macroRails.x * 0.1;
	let glowing = clamp(params.materialB.y, 0.2, 2.2);
	let width = (1.22 + hero * 1.2) * params.style.x * 60.0 * vd.w;
	let steady = base * value * (0.3 + steadyEmission * glowing) * width * params.envC.z;
	let full = (0.3 + (steadyEmission + transientEmission) * glowing) / (0.3 + steadyEmission * glowing);
	return vec4<f32>(steady, full);
}

@group(0) @binding(2) var<storage, read_write> lightsOut: array<vec4<f32>, ${LOOM_LIGHT_VEC4S}>;

var<workgroup> lightLevels: array<f32, 64>;

@compute @workgroup_size(64)
fn cs_lights(@builtin(local_invocation_index) index: u32) {
	let count = LIGHT_RAILS * LIGHT_POINTS;
	var level = 0.0;
	if (index < count) {
		let rail = index / LIGHT_POINTS;
		let k = index % LIGHT_POINTS;
		let s = 0.04 + 0.92 * f32(k) / f32(LIGHT_POINTS - 1u);
		let st = strandInfo(rail);
		let world = loomPoint(s, st);
		let light = railLight(s, rail, st);
		lightsOut[index * 2u] = vec4<f32>(viewPoint(world.xyz), 0.0);
		lightsOut[index * 2u + 1u] = light;
		level = dot(light.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
	}
	lightLevels[index] = level;
	workgroupBarrier();
	if (index == 0u) {
		// The stage's eye adapts (about a second) to how much steady light the
		// ribbons give, so a quiet, dim weave still shows the space it lives in;
		// transients never pump it.
		var total = 0.0;
		for (var i = 0u; i < count; i = i + 1u) { total = total + lightLevels[i]; }
		let goal = clamp(pow(9.0 / max(total, 0.05), 0.8), 0.4, 8.0);
		let previous = lightsOut[count * 2u].x;
		let adapted = select(mix(previous, goal, 0.025), goal, previous <= 0.0);
		// z: the same goal, adapted over about ten seconds: the strands' eye,
		// slow enough never to pulse, quick enough to follow a new era.
		let previousSlow = lightsOut[count * 2u].z;
		let slowAdapted = select(mix(previousSlow, goal, clamp(parts[PART_LIGHT].w, 0.0005, 0.1)), goal, previousSlow <= 0.0);
		lightsOut[count * 2u] = vec4<f32>(adapted, total, slowAdapted, 0.0);
	}
}
`;

const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOut {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	let point = positions[index];
	var out: FullscreenOut;
	out.position = vec4<f32>(point, 0.0, 1.0);
	out.uv = vec2<f32>(point.x * 0.5 + 0.5, 1.0 - (point.y * 0.5 + 0.5));
	return out;
}
`;

const POST_COMMON_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}
${FULLSCREEN_WGSL}
`;

// Temporal feedback: the previous frame is warped a hair outward and along the
// signal axis, decayed, and max-blended with the new scene. Max-blend (not add)
// is what keeps trails silky without accumulating to white.
export const LOOM_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;
@group(0) @binding(3) var previousTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let centered = in.uv - 0.5;
	// The genome picks the trail's drift and spin per section, so trails smear
	// in a different direction from scene to scene.
	let theta = params.postB.z * params.view.w;
	let c = cos(theta);
	let sn = sin(theta);
	let rotated = vec2<f32>(centered.x * c - centered.y * sn, centered.x * sn + centered.y * c) * params.post.y;
	let previousUv = rotated + 0.5 + vec2<f32>(-0.0006 + params.postB.x, params.postB.y) * params.view.w;
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.03, edge);
	let previous = textureSampleLevel(previousTexture, sceneSampler, previousUv, 0.0);
	let scene = textureSampleLevel(sceneTexture, sceneSampler, in.uv, 0.0);
	let trail = previous * params.post.x * border;
	// rgb: light trail; a: coverage trail, kept shorter than the light.
	return max(vec4<f32>(trail.rgb, trail.a * 0.8), scene);
}
`;

// Bloom prefilter: half-resolution 4-tap downsample with a soft HDR knee so
// only the phosphor cores and light packets bloom, never the stage.
export const LOOM_BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / max(params.view.xy, vec2<f32>(1.0));
	var color = textureSampleLevel(sourceTexture, sceneSampler, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, sceneSampler, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, sceneSampler, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, sceneSampler, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0).rgb;
	color = color * 0.25;
	let bright = max(color.r, max(color.g, color.b));
	let knee = max(0.0, bright - params.post.z);
	let factor = knee / max(1e-4, bright);
	return vec4<f32>(color * factor, 1.0);
}
`;

function loomBlurShader(directionX: number, directionY: number) {
	return /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 3.2 / max(params.view.xy, vec2<f32>(1.0));
	let direction = vec2<f32>(${directionX.toFixed(1)}, ${directionY.toFixed(1)}) * texel;
	var color = textureSampleLevel(sourceTexture, sceneSampler, in.uv, 0.0).rgb * 0.227027;
	color = color + (textureSampleLevel(sourceTexture, sceneSampler, in.uv + direction * 1.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, sceneSampler, in.uv - direction * 1.0, 0.0).rgb) * 0.1945946;
	color = color + (textureSampleLevel(sourceTexture, sceneSampler, in.uv + direction * 2.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, sceneSampler, in.uv - direction * 2.0, 0.0).rgb) * 0.1216216;
	color = color + (textureSampleLevel(sourceTexture, sceneSampler, in.uv + direction * 3.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, sceneSampler, in.uv - direction * 3.0, 0.0).rgb) * 0.054054;
	color = color + (textureSampleLevel(sourceTexture, sceneSampler, in.uv + direction * 4.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, sceneSampler, in.uv - direction * 4.0, 0.0).rgb) * 0.016216;
	return vec4<f32>(color, 1.0);
}
`;
}

export const LOOM_BLOOM_BLUR_H_WGSL = loomBlurShader(1, 0);
export const LOOM_BLOOM_BLUR_V_WGSL = loomBlurShader(0, 1);

// The place the weave lives in. Nothing here paints a backdrop: the primary
// rails are the only light sources (cs_lights writes them as short emitting
// segments), and every surface and medium below is lit by them with real
// falloff, so the room is dark wherever the ribbons are not.
//   floor    a plane under the figure: pools the ribbons' light, and lays a
//            Fresnel-weighted surface over their mirrored image (vs_mirror),
//            rippled when it is water
//   threads  a hall of hanging threads or the rings of a warp, far round the
//            stage, catching ribbon light and receding into fog (parallax)
//   dust     motes and loose fibres that glint only near a strand
//   volume   a participating medium (ground mist, haze), ray-marched at low
//            resolution, scattering the ribbon light toward the camera
const ENV_COMMON_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const LIGHT_RAILS: u32 = ${LOOM_LIGHT_RAILS}u;
const LIGHT_POINTS: u32 = ${LOOM_LIGHT_POINTS}u;
const THREADS: u32 = ${LOOM_THREADS}u;
const THREAD_SEGMENTS: u32 = ${LOOM_THREAD_SEGMENTS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> lights: array<vec4<f32>, ${LOOM_LIGHT_VEC4S}>;
// Every stage pipeline (floor, threads, dust, medium) reads its own voice here.
@group(0) @binding(2) var<storage, read> parts: array<vec4<f32>, ${LOOM_PART_VEC4S}>;
${PARTS_WGSL}

// Light arriving at p from the ribbons. Each segment between two light samples
// is a uniformly emitting line; its contribution is the closed-form integral
// of 1/d^2 along it (a small core keeps it finite on the strand). normalWeight
// blends in a Lambert term toward the closest point (surfaces), fibreWeight a
// Kajiya-Kay term for thin fibres with tangent t (threads); extinction is how
// fast the light dies out with distance through the medium.
// transient 0..1: how much of the rails' packets and shuttle this surface takes
// (near surfaces all of it, the far stage none: see railLight).
fn ribbonLight(p: vec3<f32>, n: vec3<f32>, normalWeight: f32, t: vec3<f32>, fibreWeight: f32, core: f32, extinction: f32, transient: f32) -> vec3<f32> {
	var sum = vec3<f32>(0.0);
	for (var rail = 0u; rail < LIGHT_RAILS; rail = rail + 1u) {
		let first = rail * LIGHT_POINTS;
		var a = lights[first * 2u].xyz;
		let la = lights[first * 2u + 1u];
		var ca = la.rgb * mix(1.0, la.w, transient);
		for (var k = 1u; k < LIGHT_POINTS; k = k + 1u) {
			let b = lights[(first + k) * 2u].xyz;
			let lb = lights[(first + k) * 2u + 1u];
			let cb = lb.rgb * mix(1.0, lb.w, transient);
			let d = b - a;
			let len = max(length(d), 1e-4);
			let dir = d / len;
			let ap = p - a;
			let t0 = dot(ap, dir);
			let h2 = max(dot(ap, ap) - t0 * t0, 0.0) + core;
			let h = sqrt(h2);
			// Light also thins as it travels through the medium (extinction).
			let w = (atan((len - t0) / h) + atan(t0 / h)) / h * exp(-h * extinction);
			let toLight = normalize(a + dir * clamp(t0, 0.0, len) - p + vec3<f32>(1e-5, 2e-5, 1e-5));
			let lambert = mix(1.0, max(dot(n, toLight), 0.0), normalWeight);
			let td = dot(t, toLight);
			let fibre = mix(1.0, sqrt(max(1.0 - td * td, 0.0)), fibreWeight);
			sum = sum + (ca + cb) * (0.5 * w * lambert * fibre);
			a = b;
			ca = cb;
		}
	}
	return sum * 0.0796 * lights[LIGHT_RAILS * LIGHT_POINTS * 2u].x;
}

fn ign(pixel: vec2<f32>) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}

fn colorPeakEnv(c: vec3<f32>) -> vec3<f32> {
	return c / max(max(c.r, max(c.g, c.b)), 1e-3);
}

// Fog between the camera and a point at this depth.
fn fogTransmittance(depth: f32) -> f32 {
	return exp(-max(depth, 0.0) * params.envB.w);
}
`;

export const LOOM_ENV_WGSL = /* wgsl */ `
${ENV_COMMON_WGSL}

struct FloorOut {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

struct FloorFragment {
	@location(0) color: vec4<f32>,
	@builtin(frag_depth) depth: f32,
};

@vertex
fn vs_floor(@builtin(vertex_index) index: u32) -> FloorOut {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	let point = positions[index];
	var out: FloorOut;
	out.position = vec4<f32>(point, 0.0, 1.0);
	out.uv = vec2<f32>(point.x * 0.5 + 0.5, 1.0 - (point.y * 0.5 + 0.5));
	return out;
}

// Height of the floor surface (stage xz). Water carries a few wave trains and
// rings that kicks and sub send out from under the weave; stone is flat.
fn floorHeight(xz: vec2<f32>) -> f32 {
	let t = params.postB.w;
	var h = sin(dot(xz, vec2<f32>(1.7, 0.6)) * 3.1 - t * 1.4) * 0.5;
	h = h + sin(dot(xz, vec2<f32>(-0.8, 1.3)) * 4.3 - t * 1.9) * 0.35;
	h = h + sin(dot(xz, vec2<f32>(0.3, -1.9)) * 6.7 - t * 2.6) * 0.2;
	// Bass notes drop rings on the water where they land (two alternate, so a
	// new note never cuts the last one off).
	for (var k = 0u; k < 2u; k = k + 1u) {
		let ring = parts[PART_RING_A + k];
		let d = length(xz - ring.xy);
		let front = d - ring.z * 1.3;
		h = h + sin(front * 12.0) * exp(-front * front * 5.0) * exp(-d * 0.35) * ring.w * 1.6;
	}
	return h * params.envA.z * 0.012;
}

@fragment
fn fs_floor(in: FloorOut) -> FloorFragment {
	let visibility = floorVisibility();
	if (visibility < 0.002) { discard; }
	let ray = viewRay(in.uv);
	let depth = floorDepth(ray);
	if (depth < LOOM_NEAR || depth > LOOM_FAR * 0.98) { discard; }
	let hit = vec3<f32>(0.0, 0.0, params.camera.z) + ray * depth;
	let stage = viewToStage(hit);

	// Surface normal: water ripples, plus a fine stone grain on rough floors.
	let e = 0.02;
	let h0 = floorHeight(stage.xz);
	let hx = floorHeight(stage.xz + vec2<f32>(e, 0.0));
	let hz = floorHeight(stage.xz + vec2<f32>(0.0, e));
	let gx = noise3(vec3<f32>(stage.xz * 23.0, 0.5)) - noise3(vec3<f32>(stage.xz * 23.0 + vec2<f32>(0.37, 0.0), 0.5));
	let gz = noise3(vec3<f32>(stage.xz * 23.0, 1.5)) - noise3(vec3<f32>(stage.xz * 23.0 + vec2<f32>(0.0, 0.37), 1.5));
	let grain = vec2<f32>(gx, gz) * params.envA.y * 0.5;
	let stageNormal = normalize(vec3<f32>(-(hx - h0) / e - grain.x, 1.0, -(hz - h0) / e - grain.y));
	let normal = stageRotate(stageNormal);

	let toEye = normalize(-ray);
	let cosView = clamp(dot(toEye, normal), 0.0, 1.0);
	let fresnel = 0.02 + 0.98 * pow(1.0 - cosView, 5.0);
	let fog = fogTransmittance(depth);

	// Worn stone: albedo varies slab to slab and grain to grain, and on dry
	// floors only the wet patches hold a mirror; standing water is wet all over.
	let slab = noise3(vec3<f32>(stage.xz * 1.7, 3.5));
	let speck = noise3(vec3<f32>(stage.xz * 9.0, 7.5));
	let albedoVariation = 0.45 + slab * 0.8 + (speck - 0.5) * 0.35;
	let puddles = smoothstep(0.42, 0.62, noise3(vec3<f32>(stage.xz * 0.75, 11.5)) + slab * 0.15);
	let wet = mix(mix(0.25, 1.0, puddles), 1.0, clamp(params.envA.z * 2.0 + (1.0 - params.envA.y) * 0.5, 0.0, 1.0));

	// The ribbons' light pooling on the floor, tinted a touch by the family.
	let tint = mix(vec3<f32>(1.0), colorPeakEnv(params.deepTint.rgb), 0.3);
	let floorVoice = parts[PART_FLOOR];
	let pooled = ribbonLight(hit, normal, 1.0, vec3<f32>(0.0), 0.0, 0.004, 0.3, 0.25) * params.envA.w * 6.5 * tint * floorVoice.y
		* albedoVariation * (1.0 - fresnel * 0.5) * (1.0 - wet * params.envA.x * 0.4);
	// Mirror strength over the reflected strands drawn beneath this surface.
	let reflectance = clamp(params.envA.x * floorVoice.x * wet * (0.24 + 0.76 * fresnel) * (1.0 - params.envA.y * 0.35), 0.0, 1.0) * fog;

	// Pooled light rolls off well below the ribbons: a floor right under a hot
	// rail glows, it never floods the frame.
	let pooledLevel = dot(pooled, vec3<f32>(0.2126, 0.7152, 0.0722));
	// The floor right under the lens stays dark, so a low camera never looks
	// through a glowing foreground.
	let pooledSoft = pooled / (1.0 + pooledLevel * 5.0) * smoothstep(0.6, 2.2, depth);
	var out: FloorFragment;
	out.color = vec4<f32>(pooledSoft * fog * visibility, mix(1.0, reflectance, visibility));
	out.depth = clamp((depth - LOOM_NEAR) / (LOOM_FAR - LOOM_NEAR), 0.0, 1.0);
	return out;
}

struct ThreadOut {
	@builtin(position) position: vec4<f32>,
	@location(0) color: vec3<f32>,
	@location(1) across: f32,
};

// Where a thread hangs (stage xz). The first half of the threads is a hall,
// scattered; the second half stands on the concentric rings of a warp. A
// change of arrangement crossfades the two sets (threadWeight); no thread
// ever travels, which would sweep lines across the frame.
fn threadAnchor(i: u32) -> vec2<f32> {
	let half = THREADS / 2u;
	if (i < half) {
		let h1 = hashUnit(i, 101u, 1u);
		let h2 = hashUnit(i, 103u, 2u);
		let radius = sqrt(mix(3.0 * 3.0, 12.0 * 12.0, h1));
		return vec2<f32>(cos(h2 * TAU), sin(h2 * TAU)) * radius;
	}
	let k = i - half;
	let rings = 6u;
	let ring = k % rings;
	let slot = k / rings;
	let perRing = half / rings;
	let ringRadius = 3.2 * pow(1.3, f32(ring));
	let ringAngle = (f32(slot) + 0.5 + f32(ring) * 0.37) / f32(perRing) * TAU;
	return vec2<f32>(cos(ringAngle), sin(ringAngle)) * ringRadius;
}

fn threadWeight(i: u32) -> f32 {
	let warp = clamp(params.envD.y, 0.0, 1.0);
	// Each set at full strength stands for the whole thread count.
	return 2.0 * select(warp, 1.0 - warp, i < THREADS / 2u);
}

fn threadPoint(i: u32, u: f32) -> vec3<f32> {
	let anchor = threadAnchor(i);
	let floorY = floorStageY();
	let top = 5.2;
	let hang = 1.6 + hashUnit(i, 107u, 3u) * 3.6;
	let reach = params.envD.z;
	let bottom = max(floorY, mix(top - hang, floorY, reach));
	let y = mix(top, bottom, u);
	// Free ends sway; taut warp only bows between its ends. Kicks pluck them.
	let freeness = mix(u, sin(PI * u), reach);
	let phase = hashUnit(i, 109u, 4u) * TAU;
	let t = params.postB.w;
	// The far threads have their own voice: chord changes make them ring.
	let voice = parts[PART_THREADS];
	let sway = vec2<f32>(sin(y * 0.9 + t * 0.6 + phase), cos(y * 0.7 + t * 0.5 + phase * 1.3))
		* (0.04 + params.weave.z * 0.12) * freeness * voice.w;
	let mode = f32(1u + i % 3u);
	// Only the threads in the sector the chord's root points to ring.
	let sector = parts[PART_THREADS_B].x;
	let away = abs(fract((atan2(anchor.y, anchor.x) - sector) / TAU + 0.5) - 0.5) * TAU;
	let ring = smoothstep(1.1, 0.3, away);
	let pluck = voice.y * ring * 0.024 * sin(PI * u * mode) * sin(voice.z + phase * 3.0);
	return vec3<f32>(anchor.x + sway.x + pluck, y, anchor.y + sway.y);
}

@vertex
fn vs_threads(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> ThreadOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let endpoint = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
	let side = select(-1.0, 1.0, corner == 2u || corner == 3u || corner == 5u);
	let u = f32(segment + endpoint) / f32(THREAD_SEGMENTS);
	let du = 1.0 / f32(THREAD_SEGMENTS);
	let here = stageToView(threadPoint(instanceIndex, u));
	let along = stageToView(threadPoint(instanceIndex, clamp(u + select(du, -du, endpoint == 1u), 0.0, 1.0)));
	let tangent = normalize(along - here + vec3<f32>(1e-5, 2e-5, 1e-5));
	var clip = projectView(here);
	let clipAlong = projectView(along);
	let aspect = params.view.x / max(params.view.y, 1.0);
	let height = max(params.view.y, 1.0);
	let screen = (clipAlong.xy / max(clipAlong.w, 1e-3) - clip.xy / max(clip.w, 1e-3)) * vec2<f32>(aspect, 1.0);
	let screenDir = normalize(screen + vec2<f32>(1e-6, 0.0));
	let perpendicular = vec2<f32>(-screenDir.y, screenDir.x);
	// Physically thin; drawn at least about a pixel wide with matching coverage.
	let depth = max(clip.w, 1e-3);
	let physicalPx = 0.0028 * 2.0 * params.lens.x / depth * height * 0.5;
	let drawnPx = clamp(physicalPx, 1.8, 3.0);
	clip = vec4<f32>(clip.xy + vec2<f32>(perpendicular.x / aspect, perpendicular.y) * side * drawnPx / height * clip.w, clip.zw);

	let light = ribbonLight(here, vec3<f32>(0.0), 0.0, tangent, 1.0, 0.01, 0.05, 0.0);
	// Threads between the camera and the figure step aside (fade) so they
	// never veil it; distance hides the rest in fog.
	let front = 1.0 - smoothstep(0.2, 1.4, here.z);
	// Threads right by the lens would sweep past as bars: they fade out first.
	let near = smoothstep(1.4, 3.2, depth);
	let tint = mix(vec3<f32>(1.0), colorPeakEnv(params.hazeTint.rgb), 0.25);
	var out: ThreadOut;
	out.position = clip;
	out.color = light * tint * 6.0 * (physicalPx / drawnPx) * front * near * fogTransmittance(depth) * params.envD.x
		* threadWeight(instanceIndex) * parts[PART_THREADS].x;
	out.across = side;
	return out;
}

@fragment
fn fs_threads(in: ThreadOut) -> @location(0) vec4<f32> {
	let soft = 1.0 - in.across * in.across;
	return vec4<f32>(in.color * soft, 0.0);
}

struct DustOut {
	@builtin(position) position: vec4<f32>,
	@location(0) color: vec3<f32>,
	@location(1) corner: vec2<f32>,
};

@vertex
fn vs_dust(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> DustOut {
	var corners = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
		vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
	);
	let corner = corners[vertexIndex % 6u];
	let h = vec3<f32>(
		hashUnit(instanceIndex, 201u, 1u),
		hashUnit(instanceIndex, 203u, 2u),
		hashUnit(instanceIndex, 207u, 3u)
	);
	// Motes drift on a slow current (faster with tempo) and churn with
	// turbulence; they wrap through a box round the stage, faded at its edges.
	let box = vec3<f32>(5.4, 3.4, 5.4);
	let flow = params.postB.w;
	let drift = vec3<f32>(0.06, 0.02 + params.weave.z * 0.04, -0.035) * flow;
	let cell = fract(h + drift / box);
	var p = (cell - vec3<f32>(0.5, 0.0, 0.5)) * box + vec3<f32>(0.0, floorStageY(), 0.0);
	let tt = flow * 0.6;
	p = p + vec3<f32>(
		sin(p.y * 2.1 + tt + h.x * 6.0),
		sin(p.z * 1.7 - tt * 0.8 + h.y * 6.0),
		sin(p.x * 1.9 + tt * 0.9 + h.z * 6.0)
	) * (0.05 + params.weave.z * 0.22);
	let edgeFade = pow(max(sin(PI * cell.x) * sin(PI * cell.y) * sin(PI * cell.z), 0.0), 0.35);
	let view = stageToView(p);
	var clip = projectView(view);
	let depth = max(clip.w, 1e-3);
	let size = vec2<f32>(max(params.view.x, 1.0), max(params.view.y, 1.0));
	let physicalPx = (0.004 + h.y * 0.006) * params.lens.x / depth * size.y;
	let drawnPx = clamp(physicalPx, 1.4, 3.2);
	clip = vec4<f32>(clip.xy + corner * drawnPx / size * clip.w, clip.zw);
	let coverage = min(1.0, (physicalPx * physicalPx) / (drawnPx * drawnPx) * 4.0);
	// Steep falloff: a mote glints only within reach of a strand, so dust never
	// spreads over the frame like a field of stars.
	let light = ribbonLight(view, vec3<f32>(0.0), 0.0, vec3<f32>(0.0), 0.0, 0.004, 1.6, 1.0);
	// Motes right at the lens would streak past like stars: they fade first.
	let near = smoothstep(1.0, 2.6, depth);
	var out: DustOut;
	out.position = clip;
	out.color = light * (0.4 + h.x * 0.8) * coverage * edgeFade * near * fogTransmittance(depth) * params.envD.w * 22.0
		* parts[PART_DUST].x;
	out.corner = corner;
	return out;
}

@fragment
fn fs_dust(in: DustOut) -> @location(0) vec4<f32> {
	let r2 = dot(in.corner, in.corner);
	if (r2 > 1.0) { discard; }
	return vec4<f32>(in.color * exp(-r2 * 3.0), 0.0);
}
`;

export const LOOM_VOLUME_WGSL = /* wgsl */ `
${ENV_COMMON_WGSL}
${FULLSCREEN_WGSL}

// The participating medium, marched from the camera to the floor (or into the
// dark). Density: a low layer over the floor plus a thin haze, made wispy by
// drifting noise that turbulence stirs; it scatters the ribbon light only.
@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let ray = viewRay(in.uv);
	let rayLength = length(ray);
	let eye = vec3<f32>(0.0, 0.0, params.camera.z);
	var end = 14.0;
	if (floorVisibility() > 0.002) {
		let floorAt = floorDepth(ray);
		if (floorAt > 0.0) { end = min(end, floorAt); }
	}
	let start = 0.35;
	let steps = 16;
	let stepDepth = max(end - start, 0.0) / f32(steps);
	let stepLength = stepDepth * rayLength;
	let jitter = ign(in.position.xy);
	let floorY = floorStageY();
	// The medium has its own slow voice (pads thicken it, the groove stirs it).
	let voice = parts[PART_MIST];
	let density = params.envB.x * params.hazeTint.w * voice.x;
	let flow = params.postB.w;
	let stir = params.weave.z + voice.w;
	var transmittance = 1.0;
	var light = vec3<f32>(0.0);
	for (var i = 0; i < steps; i = i + 1) {
		let d = start + (f32(i) + jitter) * stepDepth;
		let pv = eye + ray * d;
		let ps = viewToStage(pv);
		let height = ps.y - floorY;
		let layer = exp(-max(height, 0.0) / max(params.envB.y * voice.y, 0.05)) + 0.004;
		let drift = vec3<f32>(flow * 0.05, -flow * 0.015, flow * 0.03);
		let curl = vec3<f32>(sin(ps.y * 1.3 + flow * 0.4), 0.0, cos(ps.x * 1.1 - flow * 0.3)) * stir * 0.6;
		// Banks and wisps with clear air between them, so the light shows the
		// medium's shape instead of a glow round the figure.
		let n = noise3(ps * vec3<f32>(1.0, 2.2, 1.0) + drift + curl) * 0.65 + noise3(ps * 2.6 - drift * 1.7) * 0.35;
		let wisps = mix(1.0, smoothstep(0.4, 0.72, n) * 2.4, params.envB.z);
		// Clear air right in front of the lens: a camera flying in the weave sees
		// the medium ahead of it, not a fog stuck to the glass.
		let sigma = density * layer * wisps * 0.3 * smoothstep(0.6, 2.2, d);
		if (sigma > 1e-4) {
			// A wide core: the medium right at a strand is lit softly, so the
			// scattering pools in the mist instead of haloing the figure.
			let scatter = ribbonLight(pv, vec3<f32>(0.0), 0.0, vec3<f32>(0.0), 0.0, 0.09, 1.1, 0.15);
			light = light + scatter * (transmittance * sigma * stepLength);
			transmittance = transmittance * exp(-sigma * stepLength);
		}
	}
	let tint = mix(vec3<f32>(1.0), colorPeakEnv(params.hazeTint.rgb), 0.3);
	return vec4<f32>(light * tint * 5.0 * voice.z, 1.0);
}
`;

export const LOOM_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var feedbackTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;
@group(0) @binding(4) var volumeTexture: texture_2d<f32>;

fn aces(color: vec3<f32>) -> vec3<f32> {
	let a = 2.51;
	let b = 0.03;
	let c = 2.43;
	let d = 0.59;
	let e = 0.14;
	return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// Lens: a touch of barrel curvature, and chromatic aberration that grows
	// toward the edges and flares on impacts.
	let warped = 0.5 + centered * (1.0 + r2 * 0.05);
	let caAmount = (0.0011 + r2 * 0.008) * params.post.w;
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let centreTap = textureSampleLevel(feedbackTexture, sceneSampler, warped, 0.0);
	let scene = vec3<f32>(
		textureSampleLevel(feedbackTexture, sceneSampler, warped + direction * caAmount, 0.0).r,
		centreTap.g,
		textureSampleLevel(feedbackTexture, sceneSampler, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTexture, sceneSampler, warped, 0.0).rgb;
	// The medium is marched at low resolution; a small tent filter hides the
	// march's fixed jitter.
	let volumeTexel = 1.0 / vec2<f32>(textureDimensions(volumeTexture));
	var volume = vec3<f32>(0.0);
	volume = volume + textureSampleLevel(volumeTexture, sceneSampler, warped + vec2<f32>(-0.75, -0.75) * volumeTexel, 0.0).rgb;
	volume = volume + textureSampleLevel(volumeTexture, sceneSampler, warped + vec2<f32>( 0.75, -0.75) * volumeTexel, 0.0).rgb;
	volume = volume + textureSampleLevel(volumeTexture, sceneSampler, warped + vec2<f32>(-0.75,  0.75) * volumeTexel, 0.0).rgb;
	volume = volume + textureSampleLevel(volumeTexture, sceneSampler, warped + vec2<f32>( 0.75,  0.75) * volumeTexel, 0.0).rgb;
	volume = volume * 0.25;
	// The medium is a supporting light: it rolls off before it can rival the
	// ribbons, so dense mist round a low figure never becomes a glowing ball.
	let volumeLevel = dot(volume, vec3<f32>(0.2126, 0.7152, 0.0722));
	volume = volume / (1.0 + volumeLevel * 5.0);

	// No backdrop: the scene already holds the floor, the far threads and the
	// dust, all lit by the ribbons; the medium adds their scattered light.
	let aspect = resolution.x / max(resolution.y, 1.0);
	let p = vec2<f32>((warped.x - 0.5) * aspect, 0.5 - warped.y);
	let distance = length(p * vec2<f32>(0.72, 1.0));
	let vignette = 1.0 - smoothstep(0.54, 1.14, distance);
	let energy = params.macroRails.x;
	let exposure = (1.12 + energy * 0.22) * params.deepTint.w;
	// Light budget: bloom is an accent whose weight follows how bright the look is.
	let bloomTerm = bloom * params.envC.w * (1.0 + params.style.z * 0.3);
	var color = (scene + bloomTerm + volume) * exposure * (0.72 + vignette * 0.28);
	color = aces(color);
	color = max((color - 0.5) * 1.14 + 0.5, vec3<f32>(0.0));
	// Soft shoulder: highlights keep their gradation instead of flattening
	// into clipped plateaus; only the hottest cores reach the ceiling.
	let shoulderStart = 0.86;
	let shoulderRange = 0.125;
	let over = max(color - vec3<f32>(shoulderStart), vec3<f32>(0.0));
	color = min(color, vec3<f32>(shoulderStart)) + (1.0 - exp(-over / shoulderRange)) * shoulderRange;
	color = color + (ign(in.uv * resolution, fract(params.view.z) * 60.0) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;
