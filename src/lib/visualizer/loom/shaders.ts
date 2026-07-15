// Loom is deliberately a compact two-pass renderer: a depth-tested 3D ribbon
// manifold, followed by one presentation pass. Its complexity comes from
// topology and musical choreography rather than stacked translucent textures.

export const LOOM_SEGMENTS = 176;
export const LOOM_STRANDS = 12;
export const LOOM_VERTEX_COUNT = LOOM_SEGMENTS * 6;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// xy: internal resolution, z: elapsed seconds, w: frame delta
	resolutionTimeDt: vec4<f32>,
	// beat pulse, beat phase, phrase position, normalized tempo
	clock: vec4<f32>,
	// RMS, conductor strand energy: sub, kick, low body
	audio: vec4<f32>,
	// conductor strand energy: mids, presence, air; then centroid
	bands: vec4<f32>,
	// energy, spectral motion, impact, openness
	motion: vec4<f32>,
	// tension, release, crossing order, topology phase
	weave: vec4<f32>,
	// torus, helix, saddle, knot weights
	formsA: vec4<f32>,
	// cage weight, braid amount, twist amount, signed asymmetry
	formsB: vec4<f32>,
	// base, accent, rim hue and saturation
	palette: vec4<f32>,
	// reweave pulse, section pulse, manifold depth, section energy
	context: vec4<f32>,
	// yaw, pitch, distance, roll
	camera: vec4<f32>,
	// strand width, glow, silence, response motion
	style: vec4<f32>,
	// long phase, weave phase, phrase variation, harmonic key
	flow: vec4<f32>,
};
`;

const COLOR_WGSL = /* wgsl */ `
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
`;

export const LOOM_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${COLOR_WGSL}

const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${LOOM_SEGMENTS}u;
const STRANDS: u32 = ${LOOM_STRANDS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;

struct LoomOut {
	@builtin(position) position: vec4<f32>,
	@location(0) ribbonUv: vec2<f32>,
	@location(1) color: vec3<f32>,
	@location(2) lighting: vec3<f32>,
	@location(3) energy: f32,
};

fn bandEnergy(index: u32) -> f32 {
	switch index % 6u {
		case 0u: { return params.audio.y; }
		case 1u: { return params.audio.z; }
		case 2u: { return params.audio.w; }
		case 3u: { return params.bands.x; }
		case 4u: { return params.bands.y; }
		default: { return params.bands.z; }
	}
}

fn torusForm(t: f32, lane: f32, strand: f32) -> vec3<f32> {
	let major = 0.73 + params.motion.w * 0.11;
	let minor = 0.27 + params.audio.w * 0.08;
	let u = t * 2.0 + lane * 0.42 + params.flow.y * 0.16 + params.weave.w * 0.025;
	let v = t * (3.0 + params.formsB.z * 0.42) - lane + params.weave.z * strand * 0.18;
	return vec3<f32>(
		(major + minor * cos(v)) * cos(u),
		minor * sin(v),
		(major + minor * cos(v)) * sin(u)
	);
}

fn helixForm(t: f32, lane: f32, strand: f32) -> vec3<f32> {
	let progress = t / TAU;
	let turn = t * (1.55 + params.weave.x * 0.65 + params.formsB.z * 0.34)
		+ lane + params.flow.x * 0.13 + params.weave.w * 0.02;
	let radius = 0.58 + sin(t * 2.0 + lane) * 0.10 + params.motion.w * 0.08;
	let foldedY = (progress - 0.5) * 2.05;
	return vec3<f32>(
		cos(turn) * radius,
		foldedY + sin(t * 3.0 + strand) * 0.055,
		sin(turn) * radius
	);
}

fn saddleForm(t: f32, lane: f32, strand: f32) -> vec3<f32> {
	let progress = t / TAU;
	let x = (progress - 0.5) * 2.05;
	let sweep = lane + sin(t * 1.35 + params.flow.x * 0.11) * 0.34;
	let z = sin(sweep) * (0.62 + cos(t * 2.0) * 0.12);
	let y = (x * x - z * z) * 0.42 - 0.28
		+ sin(t * 2.0 + lane * 2.0 + strand * 0.07) * 0.12;
	return vec3<f32>(x, y, z);
}

fn knotForm(t: f32, lane: f32, strand: f32) -> vec3<f32> {
	let q = t + lane * 0.055 + params.flow.y * 0.07 + params.weave.w * 0.012;
	let radius = 0.66 + 0.24 * cos(3.0 * q + lane);
	return vec3<f32>(
		radius * cos(2.0 * q),
		0.34 * sin(3.0 * q + lane) + sin(q + strand) * 0.04,
		radius * sin(2.0 * q)
	);
}

fn cageForm(t: f32, lane: f32, strand: f32) -> vec3<f32> {
	let longitude = t + lane * 0.17 + params.flow.x * 0.08 + params.weave.w * 0.018;
	let latitude = sin(t * 2.0 + lane + params.weave.z * strand * 0.15) * 1.03;
	let radius = 0.82 + cos(t * 4.0 + lane) * 0.055;
	return vec3<f32>(
		cos(latitude) * cos(longitude),
		sin(latitude),
		cos(latitude) * sin(longitude)
	) * radius;
}

fn manifoldPoint(t: f32, strandIndex: u32) -> vec3<f32> {
	let strand = f32(strandIndex);
	let phraseBias = (params.flow.z - 0.5) * 0.52;
	let rethread = params.context.x * sin(strand * 2.399 + params.flow.y) * 0.14;
	let lane = strand / f32(STRANDS) * TAU + phraseBias + rethread;
	let forms = max(params.formsA, vec4<f32>(0.0));
	let cageWeight = max(params.formsB.x, 0.0);
	let total = max(dot(forms, vec4<f32>(1.0)) + cageWeight, 0.0001);
	var point = (
		torusForm(t, lane, strand) * forms.x
			+ helixForm(t, lane, strand) * forms.y
			+ saddleForm(t, lane, strand) * forms.z
			+ knotForm(t, lane, strand) * forms.w
			+ cageForm(t, lane, strand) * cageWeight
	) / total;
	// Section depth slowly unfolds the manifold along the camera axis, while
	// phrase events briefly loosen and re-seat the weave.
	point.z *= 0.7 + params.context.z * 0.62;
	point = rotateY(
		point,
		params.context.x * sin(t * 0.5 + lane + params.flow.z * TAU) * 0.12
	);
	point *= 1.0 + params.context.y * 0.055;

	let band = bandEnergy(strandIndex);
	let detailIndex = min(u32(fract(t / TAU + strand / f32(STRANDS)) * 64.0), 63u);
	let spectralDetail = clamp(detailBins[detailIndex], -1.0, 1.0);
	let breathing = 1.0
		+ band * (0.035 + params.motion.z * 0.035)
		+ params.clock.x * params.audio.z * 0.035
		+ spectralDetail * (0.018 + params.motion.y * 0.035);
	point *= breathing;

	// Braid offsets stay part of the manifold rather than becoming detached
	// particle decoration. Crossing order flips slowly with harmony and phrases.
	let braid = params.formsB.y * clamp(params.style.w, 0.62, 1.18);
	let crossing = sin(
		t * (5.0 + params.formsB.z * 2.4) + lane * 2.0 + params.flow.y + params.weave.z * TAU
	);
	point += normalize(point + vec3<f32>(0.001, 0.002, 0.003))
		* crossing * braid * (0.035 + band * 0.025);
	point.x += params.formsB.w * point.y * 0.12;
	point = rotateY(point, params.camera.x);
	point = rotateX(point, params.camera.y);
	point = rotateZ(point, params.camera.w);
	return point;
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> LoomOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let endpoint = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
	let side = select(-1.0, 1.0, corner == 2u || corner == 3u || corner == 5u);
	let sample = min(segment + endpoint, SEGMENTS);
	let fraction = f32(sample) / f32(SEGMENTS);
	let t = fraction * TAU;
	let epsilon = TAU / f32(SEGMENTS);
	let center = manifoldPoint(t, instanceIndex);
	let previous = manifoldPoint(max(t - epsilon, 0.0), instanceIndex);
	let following = manifoldPoint(min(t + epsilon, TAU), instanceIndex);
	let tangent = normalize(following - previous + vec3<f32>(0.0001, 0.0002, 0.0003));
	let cameraPoint = vec3<f32>(0.0, 0.0, params.camera.z);
	let viewDirection = normalize(cameraPoint - center);
	let across = normalize(cross(tangent, viewDirection) + vec3<f32>(0.0001, 0.0002, 0.0003));
	let band = bandEnergy(instanceIndex);
	let strandWidth = params.style.x
		* (1.0 + band * 0.7 + params.motion.z * 0.24)
		* (1.0 + params.context.x * 0.18 + params.context.y * 0.12)
		* (0.84 + 0.16 * sin(fraction * TAU + f32(instanceIndex)));
	let position = center + across * side * strandWidth;

	let depth = max(0.35, params.camera.z - position.z);
	// Fill the stage like an instrument, not a thumbnail floating in the middle.
	// Camera distance still supplies patient push-ins; this focal length merely
	// gives the authored 2-unit manifold enough screen presence.
	let focal = 3.2 / depth;
	let resolution = params.resolutionTimeDt.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let projected = vec2<f32>(position.x * focal / aspect, position.y * focal);

	let strandUnit = f32(instanceIndex) / max(f32(STRANDS - 1u), 1.0);
	let harmonicHue = mixHueShortest(params.palette.x, params.palette.y, strandUnit);
	let hue = fract(
		harmonicHue
			+ params.flow.w * 0.12
			+ band * 0.045
			+ (params.flow.z - 0.5) * 0.09
			+ params.context.x * 0.025
	);
	let saturation = clamp(params.palette.w * (0.76 + band * 0.18), 0.35, 0.96);
	let baseColor = hsvToRgb(vec3<f32>(hue, saturation, 1.06 + band * 0.48));
	let normal = normalize(cross(tangent, across));
	let lightDirection = normalize(vec3<f32>(-0.38, 0.72, 0.55));
	let diffuse = 0.42 + max(dot(normal, lightDirection), 0.0) * 0.86;
	let rim = pow(1.0 - abs(dot(normal, viewDirection)), 2.2);

	var out: LoomOut;
	out.position = vec4<f32>(projected, clamp(depth / 8.0, 0.0, 1.0), 1.0);
	out.ribbonUv = vec2<f32>(fraction, side);
	out.color = baseColor;
	out.lighting = vec3<f32>(diffuse, rim, strandUnit);
	out.energy = band;
	return out;
}

@fragment
fn fs_main(in: LoomOut) -> @location(0) vec4<f32> {
	let edge = 1.0 - smoothstep(0.58, 1.0, abs(in.ribbonUv.y));
	let fiber = 0.88 + 0.12 * cos(in.ribbonUv.x * 420.0 + in.lighting.z * 19.0);
	let rimColor = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.72, 1.25));
	let lit = in.color * in.lighting.x * fiber
		+ rimColor * in.lighting.y * (0.24 + params.style.y * 0.34)
		+ in.color * in.energy * params.motion.z * 0.18;
	let alpha = edge * (0.9 + in.energy * 0.1) * (1.0 - params.style.z * 0.72);
	// Fragment discard happens before the depth write, so an invisible feathered
	// edge cannot punch holes in ribbons crossing behind it.
	if (alpha < 0.055) { discard; }
	return vec4<f32>(lit * alpha, alpha);
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
${COLOR_WGSL}
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

fn wovenField(uv: vec2<f32>) -> f32 {
	let aspect = params.resolutionTimeDt.x / max(params.resolutionTimeDt.y, 1.0);
	var p = (uv - 0.5) * vec2<f32>(aspect, 1.0);
	let phraseAngle = (params.clock.z + params.flow.z * 0.18) * 6.28318530718;
	let bend = sin(p.y * 3.2 + params.flow.x * 0.11 + phraseAngle)
		* (0.12 + params.motion.y * 0.09 + params.context.x * 0.035);
	p.x += bend;
	p.y += sin(p.x * 2.7 - params.flow.x * 0.08) * (0.07 + params.context.w * 0.045);
	let horizontal = exp(-pow(abs(sin((p.y + sin(p.x * 1.7) * 0.08) * 15.0)), 2.0) * 52.0);
	let vertical = exp(-pow(abs(sin((p.x + sin(p.y * 1.5) * 0.08) * 15.0)), 2.0) * 52.0);
	return max(horizontal, vertical) * (0.24 + params.motion.y * 0.18);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.resolutionTimeDt.xy;
	let pixel = 1.0 / max(resolution, vec2<f32>(1.0));
	let scene = textureSampleLevel(sceneTexture, sceneSampler, in.uv, 0.0).rgb;
	var glow = scene * 0.24;
	let radius = 2.0 + params.style.y * 2.5;
	for (var x: i32 = -1; x <= 1; x = x + 1) {
		for (var y: i32 = -1; y <= 1; y = y + 1) {
			if (x == 0 && y == 0) { continue; }
			let offset = vec2<f32>(f32(x), f32(y)) * pixel * radius;
			glow += textureSampleLevel(sceneTexture, sceneSampler, in.uv + offset, 0.0).rgb * 0.095;
		}
	}

	let p = in.uv - 0.5;
	let distance = length(p * vec2<f32>(resolution.x / max(resolution.y, 1.0), 1.0));
	let base = hsvToRgb(vec3<f32>(params.palette.x, params.palette.w * 0.66, 0.16));
	let accent = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.72, 0.24));
	let halo = exp(-distance * (3.7 - params.motion.w * 0.7 - params.context.z * 0.24));
	let field = wovenField(in.uv) * smoothstep(0.12, 0.9, distance);
	let background = mix(vec3<f32>(0.003, 0.004, 0.008), base * 0.3, halo)
		+ accent * field * (0.035 + params.context.w * 0.025 + params.context.y * 0.025);
	let vignette = 1.0 - smoothstep(0.22, 0.9, distance);
	let exposure = 1.2 + params.motion.x * 0.24 + params.motion.z * 0.16;
	let color = (background + scene + glow * (0.46 + params.style.y * 0.32)) * exposure * vignette;
	return vec4<f32>(aces(color), 1.0);
}
`;
