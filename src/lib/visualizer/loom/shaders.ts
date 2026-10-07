// Loom is a harmonic signal-architecture engine. The conductor still supplies
// weave/harmony rails, but the renderer reads them as a dark spatial instrument:
// a few strong oscilloscope-like ribbons, secondary harmonic filaments, and
// phrase-born nodes inside one deep chamber. Beat energy is local. Song sections
// recompose the structure instead of pulsing or spinning the whole world.

export const LOOM_SEGMENTS = 208;
export const LOOM_PRIMARY_RAILS = 3;
export const LOOM_SECONDARY_RAILS = 8;
export const LOOM_NODES = 0;
export const LOOM_STRANDS = LOOM_PRIMARY_RAILS;
export const LOOM_INSTANCES = LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS + LOOM_NODES;
export const LOOM_TUBE_SIDES = 10;
export const LOOM_VERTEX_COUNT = LOOM_SEGMENTS * LOOM_TUBE_SIDES * 6;

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
`;

export const LOOM_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}

const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${LOOM_SEGMENTS}u;
const TUBE_SIDES: u32 = ${LOOM_TUBE_SIDES}u;
const VERTICES_PER_SEGMENT: u32 = TUBE_SIDES * 6u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;

struct LoomOut {
	@builtin(position) position: vec4<f32>,
	@location(0) worldNormal: vec3<f32>,
	@location(1) viewDirection: vec3<f32>,
	@location(2) color: vec3<f32>,
	// x: curve position, y: instance kind, z: band energy, w: rail role
	@location(3) dataA: vec4<f32>,
	// x: signed detail, y: node glow, z: harmonic intersection, w: depth cue
	@location(4) dataB: vec4<f32>,
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

fn bandDetail(family: u32, s: f32) -> f32 {
	let base = f32(family) * 10.5;
	return smoothDetail(clamp((base + s * 10.0) / 63.0, 0.0, 1.0));
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

fn architecturePoint(s: f32, rail: f32, family: u32, role: f32) -> vec3<f32> {
	let q = s * 2.0 - 1.0;
	let env = pow(max(0.0, 1.0 - q * q), 0.72);
	let rails = compositionRails();
	let band = bandEnergy(family);
	let familyUnit = f32(family) / 5.0;
	let harmonic = sin((params.harmony.z + familyUnit * 0.17 + params.shapeB.z * 0.08) * TAU);

	let phase = rail * 1.92 + params.harmony.z * TAU + params.cloth.w * 0.12;
	let len = 1.08 + rails.y * 0.16 - rails.z * 0.10;
	let coil = q * TAU * (0.44 + params.shapeB.w * 0.46 + rails.z * 0.34) + phase;
	let aperture = 0.28 + params.shape.z * 0.20 + rails.y * 0.34 - rails.z * 0.08;
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
		+ params.cloth.y * (0.42 + params.macroRails.w * 0.38)
		+ f32(family) * 1.41);
	let slow = sin(q * 2.2 + params.cloth.w * 0.21 + rail * 2.0);
	p.y = p.y + osc * env * (0.045 + band * 0.09 + params.macroRails.y * 0.035) * params.view.w;
	p.z = p.z + slow * env * (0.12 + rails.y * 0.34 + params.shapeB.y * 0.12);

	let vaultLift = env * rails.y * (0.40 + params.shape.w * 0.28);
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

	let beatCenter = fract(params.cloth.x * 0.1618 + familyUnit * 0.37 + role * 0.13);
	let beatWindow = exp(-pow(s - beatCenter, 2.0) * 95.0);
	p.y = p.y + beatWindow * params.pulse.x * (0.05 + band * 0.08) * sign(rail + 0.001);
	p.z = p.z + beatWindow * params.pulse.x * (0.10 + band * 0.07);

	p.x = p.x + params.pulse.y * env * sin(q * 15.0 + rail * 4.0) * 0.035;
	p.y = p.y + params.pulse.z * env * sin(q * 8.0 - params.view.z * 4.0) * 0.035;
	return p;
}

fn primaryRailPoint(s: f32, railIndex: u32) -> vec3<f32> {
	let rail = (f32(railIndex) - 1.0) * 0.72;
	let family = min(railIndex * 2u + select(0u, 1u, params.audioB.w > 0.56), 5u);
	return architecturePoint(s, rail, family, 0.0);
}

fn secondaryRailPoint(s: f32, index: u32) -> vec3<f32> {
	let pair = index % 6u;
	let side = select(-1.0, 1.0, (index & 1u) == 1u);
	let rail = ((f32(pair) + 0.5) / 6.0) * 1.5 - 0.75 + side * (0.05 + params.shapeB.z * 0.02);
	var p = architecturePoint(s, rail, pair, 1.0);
	let q = s * 2.0 - 1.0;
	let env = pow(max(0.0, 1.0 - q * q), 0.7);
	p.x = p.x + side * env * (0.035 + params.shapeB.w * 0.025);
	p.y = p.y * (0.75 + params.cloth.z * 0.15);
	p.z = p.z - 0.08 + side * sin(q * TAU + params.cloth.w * 0.13) * env * 0.02;
	return p;
}

fn nodePoint(s: f32, index: u32) -> vec3<f32> {
	let nodeS = fract(hashUnit(index, 4u, 2u) * 0.62 + params.cloth.x * 0.03125);
	let railA = floor(hashUnit(index, 8u, 2u) * 3.0);
	let rail = (railA - 1.0) * 0.72;
	var center = architecturePoint(nodeS, rail, u32(railA), 2.0);
	let rails = compositionRails();

	let u = s * 2.0 - 1.0;
	let length = 0.035 + rails.y * 0.026 + params.pulse.y * 0.02;
	let side = select(-1.0, 1.0, (index & 1u) == 1u);
	let orient = params.harmony.z * TAU + f32(index) * 1.17;
	var local = vec3<f32>(u * length, side * u * length * 0.25, (1.0 - abs(u)) * (0.035 + params.pulse.w * 0.025));
	local = rotateZ(local, orient);
	center.z = center.z + 0.035 + rails.z * 0.03;
	return center + local;
}

fn loomPoint(s: f32, instanceIndex: u32) -> vec3<f32> {
	if (instanceIndex < ${LOOM_PRIMARY_RAILS}u) {
		return primaryRailPoint(s, instanceIndex);
	}
	if (instanceIndex < ${LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS}u) {
		return secondaryRailPoint(s, instanceIndex - ${LOOM_PRIMARY_RAILS}u);
	}
	return nodePoint(s, instanceIndex - ${LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS}u);
}

fn viewPoint(p0: vec3<f32>) -> vec3<f32> {
	var p = p0;
	p.x = p.x * 0.94;
	p.y = p.y * 1.02;
	p.z = p.z * 1.16;
	p = rotateY(p, params.camera.x + 0.62);
	p = rotateX(p, params.camera.y - 0.18);
	p = rotateZ(p, params.camera.w);
	p.x = p.x - 0.05;
	p.y = p.y - 0.08;
	p.z = p.z - 0.18;
	return p;
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> LoomOut {
	let segment = vertexIndex / VERTICES_PER_SEGMENT;
	let faceVertex = vertexIndex % VERTICES_PER_SEGMENT;
	let face = faceVertex / 6u;
	let corner = faceVertex % 6u;
	let endpoint = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
	let radialSide = select(0u, 1u, corner == 2u || corner == 3u || corner == 5u);
	let sample = min(segment + endpoint, SEGMENTS);
	let s = f32(sample) / f32(SEGMENTS);
	let epsilon = 1.0 / f32(SEGMENTS);

	let centerWorld = loomPoint(s, instanceIndex);
	let previousWorld = loomPoint(max(s - epsilon, 0.0), instanceIndex);
	let followingWorld = loomPoint(min(s + epsilon, 1.0), instanceIndex);
	let center = viewPoint(centerWorld);
	let previous = viewPoint(previousWorld);
	let following = viewPoint(followingWorld);
	let tangent = normalize(following - previous + vec3<f32>(0.0001, 0.0002, 0.0003));
	let reference = select(
		vec3<f32>(0.0, 1.0, 0.0),
		vec3<f32>(1.0, 0.0, 0.0),
		abs(tangent.y) > 0.86
	);
	let axisA = normalize(cross(tangent, reference) + vec3<f32>(0.0001, 0.0002, 0.0003));
	let axisB = normalize(cross(axisA, tangent) + vec3<f32>(0.0001, 0.0002, 0.0003));
	let radialIndex = face + radialSide;
	let radialAngle = f32(radialIndex) / f32(TUBE_SIDES) * TAU;
	let radial = axisA * cos(radialAngle) + axisB * sin(radialAngle);

	var kind = 0.0;
	var role = 0.0;
	var family = instanceIndex;
	var radius = params.style.x * 1.2;
	if (instanceIndex < ${LOOM_PRIMARY_RAILS}u) {
		kind = 0.0;
		family = min(instanceIndex * 2u, 5u);
		radius = params.style.x * (1.38 + bandEnergy(family) * 0.48);
	} else if (instanceIndex < ${LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS}u) {
		kind = 1.0;
		let sub = instanceIndex - ${LOOM_PRIMARY_RAILS}u;
		family = sub;
		role = f32(sub & 1u);
		radius = params.style.x * 0.16 * (0.42 + bandEnergy(family) * 0.15) * (1.0 - params.cloth.z * 0.7);
	} else {
		kind = 2.0;
		let sub = instanceIndex - ${LOOM_PRIMARY_RAILS + LOOM_SECONDARY_RAILS}u;
		family = sub % 6u;
		role = f32(sub);
		radius = params.style.y * (0.42 + params.pulse.w * 0.72 + params.pulse.y * 0.28);
	}

	let position = center + radial * radius;
	let depth = max(0.42, params.camera.z - position.z);
	let focal = 3.08 / depth;
	let resolution = params.view.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let projected = vec2<f32>(position.x * focal / aspect, position.y * focal);

	let band = bandEnergy(family);
	let familyUnit = f32(family % 6u) / 5.0;
	let rails = compositionRails();
	let detail = select(bandDetail(family, s), smoothDetail(fract(s + role * 0.13)), kind > 1.5);
	let intersection = exp(-pow(abs(s - fract(params.cloth.x * 0.03125 + familyUnit * 0.23)), 2.0) * 70.0);

	var hue = mixHueShortest(params.palette.x, params.palette.y, familyUnit * 0.72);
	hue = mixHueShortest(hue, params.palette.z, rails.y * 0.35 + max(0.0, -params.harmony.w) * 0.12);
	var saturation = clamp(params.palette.w * (0.48 + band * 0.28), 0.28, 0.86);
	var value = 0.42 + band * 0.34 + params.macroRails.x * 0.12;
	if (kind == 1.0) {
		saturation = saturation * 0.58;
		value = value * (0.22 + rails.w * 0.12);
	}
	if (kind == 2.0) {
		hue = mixHueShortest(params.palette.y, params.palette.z, 0.62 + params.harmony.z * 0.12);
		saturation = clamp(params.palette.w * 0.72, 0.3, 0.9);
		value = 0.64 + params.pulse.w * 0.28 + intersection * 0.20;
	}
	value = value * (1.0 - params.style.w * 0.56);

	let cameraPoint = vec3<f32>(0.0, 0.0, params.camera.z);
	var out: LoomOut;
	out.position = vec4<f32>(projected, clamp(depth / 8.0, 0.0, 1.0), 1.0);
	out.worldNormal = radial;
	out.viewDirection = normalize(cameraPoint - position);
	out.color = hsvToRgb(vec3<f32>(hue, saturation, value));
	out.dataA = vec4<f32>(s, kind, band, role);
	out.dataB = vec4<f32>(detail, select(0.0, 1.0, kind == 2.0), intersection, depth);
	return out;
}

@fragment
fn fs_main(in: LoomOut) -> @location(0) vec4<f32> {
	let normal = normalize(in.worldNormal);
	let view = normalize(in.viewDirection);
	let keyLight = normalize(vec3<f32>(-0.48, 0.72, 0.50));
	let rimLight = normalize(vec3<f32>(0.72, -0.24, 0.52));
	let kind = in.dataA.y;
	let isNode = kind == 2.0;
	let isSecondary = kind == 1.0;

	let diffuse = 0.13 + max(dot(normal, keyLight), 0.0) * 0.58 + max(dot(normal, rimLight), 0.0) * 0.16;
	let rim = pow(1.0 - abs(dot(normal, view)), 2.0);
	let specPower = select(42.0, 82.0, isNode);
	let specular = pow(max(dot(reflect(-keyLight, normal), view), 0.0), specPower);
	let striation = 0.985 + 0.015 * cos(in.dataA.x * select(360.0, 620.0, isSecondary) + in.dataA.w * 4.1);
	let rimColor = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.45, 1.05));
	let detailShade = 1.0 + in.dataB.x * select(0.18, 0.32, !isSecondary);
	let nodeGlow = in.color * in.dataB.y * (0.34 + params.style.z * 0.26);
	let crossingGlow = rimColor * in.dataB.z * (0.16 + params.pulse.y * 0.12);

	var lit = in.color * diffuse * striation * detailShade
		+ rimColor * rim * (0.17 + params.style.z * 0.14)
		+ vec3<f32>(1.0, 0.96, 0.88) * specular * select(0.14, 0.34, isNode)
		+ nodeGlow + crossingGlow;
	lit = mix(lit, lit * 0.54, select(0.0, 0.46, isSecondary));
	return vec4<f32>(lit, 1.0);
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

export const LOOM_COMPOSITE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}
${FULLSCREEN_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;

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

fn chamberLines(p: vec2<f32>) -> f32 {
	let horizon = exp(-p.y * p.y * 34.0);
	let vertical = exp(-pow(abs(sin((p.x + params.camera.x * 0.05) * 16.0)), 2.0) * 900.0)
		* smoothstep(0.06, 0.52, abs(p.y));
	let radial = exp(-pow(abs(sin(length(p * vec2<f32>(0.8, 1.0)) * 12.0 - params.cloth.w * 0.06)), 2.0) * 820.0)
		* smoothstep(0.18, 0.95, length(p));
	return horizon * 0.2 + vertical * 0.12 + radial * 0.10;
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let pixel = 1.0 / max(resolution, vec2<f32>(1.0));
	let scene = textureSampleLevel(sceneTexture, sceneSampler, in.uv, 0.0).rgb;
	let blurRadius = 1.05 + params.style.z * 0.72;
	let blur =
		textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>( pixel.x, 0.0) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(-pixel.x, 0.0) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(0.0,  pixel.y) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(0.0, -pixel.y) * blurRadius, 0.0).rgb;

	let aspect = resolution.x / max(resolution.y, 1.0);
	let p = (in.uv - 0.5) * vec2<f32>(aspect, 1.0);
	let distance = length(p * vec2<f32>(0.72, 1.0));
	let baseHue = mixHueShortest(params.palette.x, params.palette.z, 0.28 + params.shape.w * 0.18);
	let chamber = hsvToRgb(vec3<f32>(baseHue, params.palette.w * 0.34, 0.09));
	let depthHaze = exp(-distance * (2.5 - params.shape.z * 0.36));
	var background = vec3<f32>(0.0018, 0.0024, 0.0048)
		+ chamber * depthHaze * (0.14 + params.macroRails.x * 0.065);

	let floor = smoothstep(-0.18, -0.54, p.y);
	let floorSheen = textureSampleLevel(sceneTexture, sceneSampler, vec2<f32>(in.uv.x, 1.0 - in.uv.y * 0.55), 0.0).rgb;
	background = background + floorSheen * floor * exp((p.y + 0.25) * 4.0) * 0.055;

	let lineColor = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.38, 0.24));
	background = background + lineColor * chamberLines(p) * (0.34 + params.shape.x * 0.34) * (1.0 - params.style.w * 0.7);

	let vignette = 1.0 - smoothstep(0.54, 1.14, distance);
	let glow = blur * 0.25 * (0.12 + params.style.z * 0.10);
	let exposure = 1.06 + params.macroRails.x * 0.14;
	var color = (background + scene + glow) * exposure * (0.70 + vignette * 0.30);
	color = aces(color);
	color = color + (ign(in.uv * resolution, fract(params.view.z) * 60.0) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;
