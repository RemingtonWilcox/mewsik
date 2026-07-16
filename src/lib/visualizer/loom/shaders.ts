// Loom is a dimensional signal instrument: twelve frequency-owned traces are
// woven through one depth-tested scene, then presented over a restrained scope
// graticule. There are no translucent scene layers or full-screen texture stacks.

export const LOOM_SEGMENTS = 192;
export const LOOM_STRANDS = 12;
export const LOOM_GUIDES = 1;
export const LOOM_INSTANCES = LOOM_STRANDS + LOOM_GUIDES;
export const LOOM_TUBE_SIDES = 6;
export const LOOM_VERTEX_COUNT = LOOM_SEGMENTS * LOOM_TUBE_SIDES * 6;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// xy: internal resolution, z: elapsed seconds, w: frame delta
	resolutionTimeDt: vec4<f32>,
	// impact envelope, continuous signal travel, phrase position, normalized tempo
	clock: vec4<f32>,
	// RMS, conductor strand energy: sub, kick, low body
	audio: vec4<f32>,
	// conductor strand energy: mids, presence, air; then centroid
	bands: vec4<f32>,
	// energy, spectral motion, impact, openness
	motion: vec4<f32>,
	// tension, release, crossing order, topology phase
	weave: vec4<f32>,
	// plane, helix, fold, braid weights
	formsA: vec4<f32>,
	// chamber weight, braid amount, twist amount, signed asymmetry
	formsB: vec4<f32>,
	// base, accent, rim hue and saturation
	palette: vec4<f32>,
	// reweave pulse, section pulse, manifold depth, section energy
	context: vec4<f32>,
	// yaw, pitch, distance, roll
	camera: vec4<f32>,
	// strand radius, glow, silence, response motion
	style: vec4<f32>,
	// long phase, weave phase, phrase variation, harmonic key
	flow: vec4<f32>,
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
`;

export const LOOM_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${SHARED_WGSL}

const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${LOOM_SEGMENTS}u;
const STRANDS: u32 = ${LOOM_STRANDS}u;
const TUBE_SIDES: u32 = ${LOOM_TUBE_SIDES}u;
const VERTICES_PER_SEGMENT: u32 = TUBE_SIDES * 6u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;

struct LoomOut {
	@builtin(position) position: vec4<f32>,
	@location(0) worldNormal: vec3<f32>,
	@location(1) viewDirection: vec3<f32>,
	@location(2) color: vec3<f32>,
	@location(3) traceData: vec3<f32>,
};

fn bandEnergy(index: u32) -> f32 {
	if (index >= STRANDS) { return params.motion.x; }
	switch index % 6u {
		case 0u: { return params.audio.y; }
		case 1u: { return params.audio.z; }
		case 2u: { return params.audio.w; }
		case 3u: { return params.bands.x; }
		case 4u: { return params.bands.y; }
		default: { return params.bands.z; }
	}
}

fn smoothDetail(position: f32) -> f32 {
	let scaled = clamp(position, 0.0, 0.999) * 63.0;
	let index = u32(floor(scaled));
	let fraction = fract(scaled);
	let index0 = select(index - 1u, 0u, index == 0u);
	let index1 = index;
	let index2 = min(index + 1u, 63u);
	let index3 = min(index + 2u, 63u);
	let a = clamp(detailBins[index0], 0.0, 1.0);
	let b = clamp(detailBins[index1], 0.0, 1.0);
	let c = clamp(detailBins[index2], 0.0, 1.0);
	let d = clamp(detailBins[index3], 0.0, 1.0);
	let f2 = fraction * fraction;
	let f3 = f2 * fraction;
	return clamp(0.5 * ((2.0 * b) + (-a + c) * fraction
		+ (2.0 * a - 5.0 * b + 4.0 * c - d) * f2
		+ (-a + 3.0 * b - 3.0 * c + d) * f3), 0.0, 1.0);
}

fn traceSignal(s: f32, strandIndex: u32, laneAngle: f32) -> vec2<f32> {
	let family = f32(strandIndex % 6u);
	let band = bandEnergy(strandIndex);
	let detail = smoothDetail(s * 0.92 + 0.04);
	let harmonic = 1.0 + family * 0.52;
	let travel = params.clock.y * TAU;
	let carrier = sin(s * TAU * harmonic + laneAngle + params.flow.y * 0.48);
	let overtone = sin(s * TAU * (harmonic * 2.43 + 0.37) - laneAngle * 0.7 - params.flow.y * 0.31);
	let spectral = detail * (carrier * 0.74 + overtone * 0.26)
		* (0.045 + params.motion.y * 0.055);
	let amplitude = (0.025 + band * 0.145 + params.audio.x * 0.025)
		* clamp(params.style.w, 0.62, 1.2);

	// Percussion travels through the instrument as a local packet. It never
	// scales, rotates, or punches the complete weave.
	let pulseCenter = fract(params.clock.y + f32(strandIndex % 3u) * 0.055);
	let pulseDistance = abs(s - pulseCenter);
	let packet = exp(-pulseDistance * pulseDistance * 92.0) * params.motion.z;
	let packetWave = sin(s * TAU * (4.0 + family * 0.32) - travel) * packet * 0.14;
	let y = carrier * amplitude + overtone * amplitude * 0.28 + spectral + packetWave;
	let z = overtone * amplitude * 0.62 - carrier * amplitude * 0.2
		+ spectral * 0.58 + packetWave * 0.44;
	return vec2<f32>(y, z);
}

fn planeForm(s: f32, lane: f32, laneAngle: f32) -> vec3<f32> {
	let x = (s - 0.5) * 3.2;
	let current = sin(s * TAU * 1.15 + laneAngle + params.flow.x * 0.22);
	return vec3<f32>(x, lane * (0.76 + params.motion.w * 0.18), current * 0.22);
}

fn helixForm(s: f32, lane: f32, laneAngle: f32) -> vec3<f32> {
	let x = (s - 0.5) * 3.2;
	let angle = s * TAU * (0.72 + params.formsB.z * 0.42)
		+ laneAngle + params.flow.y * 0.23;
	let radius = 0.34 + abs(lane) * 0.56 + params.motion.w * 0.08;
	return vec3<f32>(x, cos(angle) * radius, sin(angle) * radius);
}

fn foldForm(s: f32, lane: f32, laneAngle: f32) -> vec3<f32> {
	let x = (s - 0.5) * 3.2;
	let fold = sin((s - 0.5) * 3.14159265);
	let y = lane * (0.52 + abs(fold) * 0.35);
	let z = lane * fold * (0.82 + params.context.z * 0.2)
		+ sin(s * TAU * 1.5 + laneAngle) * 0.12;
	return vec3<f32>(x, y, z);
}

fn braidForm(s: f32, lane: f32, laneAngle: f32) -> vec3<f32> {
	let x = (s - 0.5) * 3.2;
	let envelope = sin(s * 3.14159265);
	let centerY = sin(s * TAU * 1.08 + params.flow.x * 0.16) * 0.28 * envelope;
	let centerZ = sin(s * TAU * 2.16 + params.flow.x * 0.11) * 0.2 * envelope;
	let angle = s * TAU * (1.25 + params.formsB.z * 0.62) + laneAngle + params.flow.y * 0.18;
	let radius = (0.2 + abs(lane) * 0.43) * (0.72 + envelope * 0.28);
	return vec3<f32>(x, centerY + cos(angle) * radius, centerZ + sin(angle) * radius);
}

fn chamberForm(s: f32, lane: f32, laneAngle: f32) -> vec3<f32> {
	let x = (s - 0.5) * 3.2;
	let slowTurn = sin(s * TAU + params.flow.x * 0.13) * 0.2;
	let angle = laneAngle + slowTurn;
	let radius = 0.56 + abs(lane) * 0.34 + cos(s * TAU * 2.0 + laneAngle) * 0.05;
	return vec3<f32>(x, cos(angle) * radius, sin(angle) * radius);
}

fn shuttleGuidePoint(s: f32) -> vec3<f32> {
	let angle = s * TAU;
	let travel = 0.5 + 0.5 * sin(params.clock.y * TAU - 1.57079633);
	let x = mix(-1.36, 1.36, travel);
	let ripple = sin(angle * 6.0 + params.flow.y * 0.7) * params.motion.y * 0.018;
	let radiusY = 0.84 + params.motion.w * 0.13 + ripple;
	let radiusZ = (0.58 + params.context.z * 0.21) * (1.0 + ripple);
	var point = vec3<f32>(x, cos(angle) * radiusY, sin(angle) * radiusZ);
	point = rotateY(point, params.camera.x);
	point = rotateX(point, params.camera.y);
	point = rotateZ(point, params.camera.w);
	return point;
}

fn loomPoint(s: f32, strandIndex: u32) -> vec3<f32> {
	if (strandIndex >= STRANDS) { return shuttleGuidePoint(s); }
	let strand = f32(strandIndex);
	let lane = ((strand + 0.5) / f32(STRANDS)) * 2.0 - 1.0;
	let phraseOffset = (params.flow.z - 0.5) * 0.18;
	let laneAngle = (strand + 0.5) / f32(STRANDS) * TAU
		+ phraseOffset + params.weave.z * 0.22;
	let forms = max(params.formsA, vec4<f32>(0.0));
	let chamberWeight = max(params.formsB.x, 0.0);
	let total = max(dot(forms, vec4<f32>(1.0)) + chamberWeight, 0.0001);
	var point = (
		planeForm(s, lane, laneAngle) * forms.x
			+ helixForm(s, lane, laneAngle) * forms.y
			+ foldForm(s, lane, laneAngle) * forms.z
			+ braidForm(s, lane, laneAngle) * forms.w
			+ chamberForm(s, lane, laneAngle) * chamberWeight
	) / total;

	let signal = traceSignal(s, strandIndex, laneAngle);
	let openAmount = 0.82 + params.motion.w * 0.3;
	point.y *= openAmount;
	point.z *= 0.78 + params.context.z * 0.5;
	point.y += signal.x;
	point.z += signal.y;

	// Phrase changes re-thread limited regions instead of exploding the whole form.
	let rethreadCenter = fract(params.flow.z * 1.73 + strand * 0.071);
	let rethreadDistance = abs(s - rethreadCenter);
	let rethreadWindow = exp(-rethreadDistance * rethreadDistance * 38.0) * params.context.x;
	point.y += rethreadWindow * sin(laneAngle + s * TAU) * 0.12;
	point.z += rethreadWindow * cos(laneAngle - s * TAU) * 0.12;
	point.x += params.formsB.w * point.y * 0.1;

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
	let segment = vertexIndex / VERTICES_PER_SEGMENT;
	let faceVertex = vertexIndex % VERTICES_PER_SEGMENT;
	let face = faceVertex / 6u;
	let corner = faceVertex % 6u;
	let endpoint = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
	let radialSide = select(0u, 1u, corner == 2u || corner == 3u || corner == 5u);
	let sample = min(segment + endpoint, SEGMENTS);
	let s = f32(sample) / f32(SEGMENTS);
	let epsilon = 1.0 / f32(SEGMENTS);
	let center = loomPoint(s, instanceIndex);
	let previous = loomPoint(max(s - epsilon, 0.0), instanceIndex);
	let following = loomPoint(min(s + epsilon, 1.0), instanceIndex);
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
	let band = bandEnergy(instanceIndex);
	let family = f32(instanceIndex % 6u);
	let isGuide = instanceIndex >= STRANDS;
	let traceHierarchy = select(0.68, 1.0, instanceIndex < 6u);
	let traceRadius = params.style.x
		* (0.76 + band * 0.58 + params.motion.y * 0.12)
		* (1.0 - params.style.z * 0.42) * traceHierarchy;
	let radius = select(traceRadius, params.style.x * 0.48, isGuide);
	let position = center + radial * radius;

	let depth = max(0.42, params.camera.z - position.z);
	let focal = 2.82 / depth;
	let resolution = params.resolutionTimeDt.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let projected = vec2<f32>(position.x * focal / aspect, position.y * focal);

	let familyUnit = family / 5.0;
	let firstArc = mixHueShortest(params.palette.x, params.palette.y, min(familyUnit * 2.0, 1.0));
	let secondArc = mixHueShortest(params.palette.y, params.palette.z, clamp(familyUnit * 2.0 - 1.0, 0.0, 1.0));
	let harmonicHue = select(firstArc, secondArc, familyUnit > 0.5);
	let hue = fract(harmonicHue + (familyUnit - 0.5) * 0.075
		+ params.flow.w * 0.1 + params.flow.z * 0.045);
	let saturation = clamp(params.palette.w * (0.72 + band * 0.2), 0.38, 0.96);
	let hierarchy = select(0.68, 1.0, instanceIndex < 6u);
	let value = (0.64 + band * 0.42 + select(0.0, 0.12, family == 1.0 || family == 4.0))
		* hierarchy;
	let traceColor = hsvToRgb(vec3<f32>(hue, saturation, value));
	let guideColor = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.48, 0.58));
	let baseColor = select(traceColor, guideColor, isGuide);
	let cameraPoint = vec3<f32>(0.0, 0.0, params.camera.z);

	var out: LoomOut;
	out.position = vec4<f32>(projected, clamp(depth / 8.0, 0.0, 1.0), 1.0);
	out.worldNormal = radial;
	out.viewDirection = normalize(cameraPoint - position);
	out.color = baseColor;
	out.traceData = vec3<f32>(s, select(familyUnit, 1.25, isGuide), band);
	return out;
}

@fragment
fn fs_main(in: LoomOut) -> @location(0) vec4<f32> {
	let normal = normalize(in.worldNormal);
	let view = normalize(in.viewDirection);
	let keyLight = normalize(vec3<f32>(-0.42, 0.7, 0.56));
	let fillLight = normalize(vec3<f32>(0.66, -0.18, 0.48));
	let diffuse = 0.18 + max(dot(normal, keyLight), 0.0) * 0.72
		+ max(dot(normal, fillLight), 0.0) * 0.22;
	let rim = pow(1.0 - abs(dot(normal, view)), 2.4);
	let specular = pow(max(dot(reflect(-keyLight, normal), view), 0.0), 28.0);
	let longitudinal = 0.94 + 0.06 * cos(in.traceData.x * 620.0 + in.traceData.y * 31.0);
	let rimColor = hsvToRgb(vec3<f32>(params.palette.z, params.palette.w * 0.56, 1.1));
	let localImpact = params.motion.z
		* exp(-pow(in.traceData.x - fract(params.clock.y + in.traceData.y * 0.16), 2.0) * 88.0);
	let guide = step(1.1, in.traceData.y);
	var lit = in.color * diffuse * longitudinal
		+ rimColor * rim * (0.18 + params.style.y * 0.1)
		+ vec3<f32>(1.0, 0.96, 0.9) * specular * 0.24
		+ in.color * localImpact * 0.34;
	lit = mix(lit, lit * 0.62 + rimColor * rim * 0.14, guide);
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

fn scopeGrid(uv: vec2<f32>) -> vec3<f32> {
	let aspect = params.resolutionTimeDt.x / max(params.resolutionTimeDt.y, 1.0);
	var p = (uv - 0.5) * vec2<f32>(aspect, 1.0);
	p.y += sin(p.x * 1.4 + params.flow.x * 0.12) * 0.018;
	p.x += params.camera.x * 0.08 + params.flow.x * 0.002;
	p.y += params.camera.y * 0.06;
	let minorX = exp(-pow(abs(sin(p.x * 18.0)), 2.0) * 520.0);
	let minorY = exp(-pow(abs(sin(p.y * 18.0)), 2.0) * 520.0);
	let majorX = exp(-pow(abs(sin(p.x * 4.5)), 2.0) * 980.0);
	let majorY = exp(-pow(abs(sin(p.y * 4.5)), 2.0) * 980.0);
	let centerX = exp(-p.x * p.x * 2100.0);
	let centerY = exp(-p.y * p.y * 2100.0);
	let grid = max(minorX, minorY) * 0.22 + max(majorX, majorY) * 0.34
		+ max(centerX, centerY) * 0.18;
	let distance = length(p * vec2<f32>(0.72, 1.0));
	let contour = exp(-pow(abs(sin(distance * 11.0 - params.flow.x * 0.08)), 2.0) * 620.0)
		* smoothstep(0.22, 0.95, distance) * 0.13;
	let hue = mixHueShortest(params.palette.x, params.palette.z, 0.42);
	let ink = hsvToRgb(vec3<f32>(hue, params.palette.w * 0.5, 0.24));
	return ink * (grid + contour) * (0.62 + params.context.z * 0.18);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.resolutionTimeDt.xy;
	let pixel = 1.0 / max(resolution, vec2<f32>(1.0));
	let scene = textureSampleLevel(sceneTexture, sceneSampler, in.uv, 0.0).rgb;
	let blurRadius = 1.25 + params.style.y * 0.85;
	let blur =
		textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>( pixel.x, 0.0) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(-pixel.x, 0.0) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(0.0,  pixel.y) * blurRadius, 0.0).rgb
		+ textureSampleLevel(sceneTexture, sceneSampler, in.uv + vec2<f32>(0.0, -pixel.y) * blurRadius, 0.0).rgb;

	let aspect = resolution.x / max(resolution.y, 1.0);
	let p = (in.uv - 0.5) * vec2<f32>(aspect, 1.0);
	let distance = length(p * vec2<f32>(0.68, 1.0));
	let base = hsvToRgb(vec3<f32>(params.palette.x, params.palette.w * 0.48, 0.11));
	let horizon = exp(-p.y * p.y * (7.0 - params.context.z * 1.4));
	let chamber = exp(-distance * (2.7 - params.motion.w * 0.28));
	let background = vec3<f32>(0.0025, 0.0035, 0.0065)
		+ base * horizon * chamber * (0.055 + params.context.w * 0.018)
		+ scopeGrid(in.uv) * (1.0 - params.style.z * 0.72);
	let vignette = 1.0 - smoothstep(0.56, 1.12, distance);
	let glow = blur * 0.25 * (0.12 + params.style.y * 0.08);
	let exposure = 1.03 + params.motion.x * 0.12;
	let color = (background + scene + glow) * exposure * (0.72 + vignette * 0.28);
	return vec4<f32>(aces(color), 1.0);
}
`;
