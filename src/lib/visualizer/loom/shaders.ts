// Loom is a harmonic weaving instrument. The conductor supplies the reactive
// rails (bands, beats, tension, drops) and the long-listen look (see look.ts):
// which topology grammar the threads are laid on, palette family, material,
// camera regime, environment and beat form. Every grammar is a parametric
// surface; rails, weft and chorus strands are curves on it, so a grammar change
// morphs the same threads into a new architecture instead of cutting.

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
	// floorMirror, ripple, fog, stars
	envA: vec4<f32>,
	// sky, walls, pool, horizon
	envB: vec4<f32>,
	// floorLine, sunX, floorAmount, bloomWeight
	envC: vec4<f32>,
	// keyAzimuth, keyElevation, lightWarmth, fillLevel
	light: vec4<f32>,
	// packets, pluck, crossPulse, shuttle
	beat: vec4<f32>,
	// sparks, beatGain, litGain, chorusGlow
	beatB: vec4<f32>,
	// driftX, driftY, spin, paper
	postB: vec4<f32>,
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

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${LOOM_SEGMENTS}u;
const TUBE_SIDES: u32 = ${LOOM_TUBE_SIDES}u;
const CHORUS_SEGMENTS: u32 = ${LOOM_CHORUS_SEGMENTS}u;
const CHORUS_SIDES: u32 = ${LOOM_CHORUS_SIDES}u;
const PRIMARY: u32 = ${LOOM_PRIMARY_RAILS}u;
const FIRST_CHORUS: u32 = ${LOOM_FIRST_CHORUS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;

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
fn architecturePoint(s: f32, rail: f32, family: u32, role: f32, band: f32) -> vec3<f32> {
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
		+ params.cloth.y * (0.42 + params.macroRails.w * 0.38)
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

	let beatCenter = fract(params.cloth.x * 0.1618 + familyUnit * 0.37 + role * 0.13);
	let beatWindow = exp(-pow(s - beatCenter, 2.0) * 95.0);
	p.y = p.y + beatWindow * params.pulse.x * (0.05 + band * 0.08) * sign(rail + 0.001);
	p.z = p.z + beatWindow * params.pulse.x * (0.10 + band * 0.07);

	p.x = p.x + params.pulse.y * env * sin(q * 15.0 + rail * 4.0) * 0.035;
	p.y = p.y + params.pulse.z * env * sin(q * 8.0 - params.view.z * 4.0) * 0.035;
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
			let p = architecturePoint(s, lane * 1.08, strand.family, strand.role, strandBand(strand));
			out = GPoint(p, vec3<f32>(0.0, 0.28, 0.96), vec3<f32>(0.0, 0.96, -0.28), 0.0, 0.0);
		}
	}
	return out;
}

// The current grammar, crossfading from the previous one while a section
// change morphs the threads; mid-morph the weave lifts apart a little.
fn surfacePoint(s: f32, strand: Strand, lane: f32) -> GPoint {
	let t = clamp(params.topo.z, 0.0, 1.0);
	let gTo = u32(params.topo.y + 0.5);
	let gFrom = u32(params.topo.x + 0.5);
	let b = grammarPoint(gTo, s, strand, lane);
	if (t >= 0.999 || gFrom == gTo) { return b; }
	let a = grammarPoint(gFrom, s, strand, lane);
	let lift = sin(t * PI) * (0.06 + strand.sid * 0.08);
	return GPoint(
		mix(a.p, b.p, t) + normalize(mix(a.n, b.n, t) + vec3<f32>(0.0001, 0.0002, 0.0003)) * lift,
		normalize(mix(a.n, b.n, t) + vec3<f32>(0.0001, 0.0002, 0.0003)),
		normalize(mix(a.b, b.b, t) + vec3<f32>(0.0002, 0.0001, 0.0003)),
		mix(a.closed, b.closed, t),
		mix(a.react, b.react, t)
	);
}

// Phrase-scale evolution shared by the hero and the camera: x = phrase index,
// y = blend toward the next phrase over its final eighth, so changes ease in.
fn phraseClock() -> vec2<f32> {
	let beats = params.cloth.x / 32.0;
	return vec2<f32>(floor(beats), smoothstep(0.875, 1.0, fract(beats)));
}

// Which primary rail leads this phrase. The centre rail leads most phrases;
// roughly one in three hands the lead to an outer rail.
fn heroRail(phrase: f32) -> u32 {
	let h = hashUnit(u32(max(phrase, 0.0)) + 3u, 41u, 7u);
	if (h < 0.66) { return 1u; }
	return select(0u, 2u, h > 0.83);
}

fn heroWeight(instanceIndex: u32) -> f32 {
	let clock = phraseClock();
	let now = select(0.0, 1.0, heroRail(clock.x) == instanceIndex);
	let next = select(0.0, 1.0, heroRail(clock.x + 1.0) == instanceIndex);
	return mix(now, next, clock.y);
}

// A small per-phrase change of viewing angle, so long passages do not hold one
// framing; it eases across the phrase boundary instead of cutting.
fn phraseYaw() -> f32 {
	let clock = phraseClock();
	let now = hashUnit(u32(max(clock.x, 0.0)) + 5u, 53u, 3u) - 0.5;
	let next = hashUnit(u32(max(clock.x + 1.0, 0.0)) + 5u, 53u, 3u) - 0.5;
	return mix(now, next, clock.y) * 0.42 * params.view.w;
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

fn weftAngle(s: f32, index: u32) -> f32 {
	let phrase = floor(params.cloth.x / 32.0);
	let phrasePos = fract(params.cloth.x / 32.0);
	let draftNow = weftDraft(phrase, index);
	let draftNext = weftDraft(phrase + 1.0, index);
	let blend = smoothstep(0.92, 1.0, phrasePos);
	let crossings = mix(draftNow.x, draftNext.x, blend);
	let phase = mix(draftNow.y, draftNext.y, blend) + params.harmony.z * TAU * 0.5;
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
	}
	return st;
}

// World-space point on strand: grammar surface, weft threading, the shared
// reactive layer and the genome's beat form. w = how closed the loop is.
fn loomPoint(s: f32, st: Strand) -> vec4<f32> {
	var lane = st.lane;
	var weftLift = 0.0;
	if (st.kind == 1.0) {
		let angle = weftAngle(s, st.weft);
		lane = mix(st.lane, st.laneB, 0.5 + 0.5 * sin(angle));
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
		let osc = sin(q * TAU * (0.85 + familyUnit * 0.7 + params.shapeB.w * 0.55)
			+ params.cloth.y * (0.42 + params.macroRails.w * 0.38) + f32(st.family) * 1.41);
		var r = g.n * osc * env * (0.04 + band * 0.085 + params.macroRails.y * 0.03) * params.view.w;
		r = r + g.b * bandDetail(st.family, sw) * env * (0.045 + band * 0.075) * params.view.w;
		let beatCenter = fract(params.cloth.x * 0.1618 + familyUnit * 0.37 + st.role * 0.13);
		let beatWindow = exp(-pow(sw - beatCenter, 2.0) * 95.0);
		r = r + (g.n * (0.05 + band * 0.08) + g.b * (0.06 + band * 0.06)) * beatWindow * params.pulse.x;
		r = r + g.n * params.pulse.y * env * sin(q * 15.0 + lane * 6.0) * 0.032;
		r = r + g.b * params.pulse.z * env * sin(q * 8.0 - params.view.z * 4.0) * 0.032;
		p = p + r * g.react;
	}

	// Beat forms. Plucked strings ring a standing wave on each kick; the
	// shuttle bump rides the threads one step per beat.
	let modeCount = 2.0 + f32(st.family % 3u);
	let pluck = params.beat.y * params.pulse.x * 0.085 * sin(PI * sw * modeCount)
		* sin(params.view.z * TAU * 6.5 + st.sid * 9.0) * mix(env, 1.0, 0.4);
	let shuttle = params.beat.w * exp(-pow((sw - shuttleS()) * 14.0, 2.0)) * (0.03 + params.pulse.w * 0.05);
	p = p + g.n * (pluck + shuttle) * params.beatB.y;
	return vec4<f32>(p, g.closed);
}

fn viewPoint(p0: vec3<f32>) -> vec3<f32> {
	var p = p0 * params.frame.x;
	p.x = p.x * 1.32;
	p.y = p.y * 1.12;
	p.z = p.z * 1.16;
	p = rotateY(p, params.camera.x + 0.62 + phraseYaw() + params.lens.w);
	p = rotateX(p, params.camera.y - 0.18);
	p = rotateZ(p, params.camera.w);
	p.x = p.x + 0.04;
	p.y = p.y - 0.08;
	p.z = p.z - 0.18;
	return p;
}

fn colorPeak(c: vec3<f32>) -> vec3<f32> {
	return c / max(max(c.r, max(c.g, c.b)), 1e-3);
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> LoomOut {
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
	let center = viewPoint(centerWorld.xyz);
	let previous = viewPoint(previousWorld.xyz);
	let following = viewPoint(followingWorld.xyz);
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
	let bead = 1.0 + params.formB.z * 0.95 * pow(0.5 + 0.5 * sin(s * TAU * 9.0 - params.cloth.x * 0.25 + st.sid * 4.0), 6.0);
	let swell = 1.0 + params.formB.w * 0.75 * (0.5 + 0.5 * sin(s * TAU * 1.5 + params.cloth.w * 0.4 + st.sid * 3.0));
	let profile = capEnds * taper * bead * swell * params.frame.z;

	var hero = 0.0;
	var radius = params.style.x;
	var visible = 1.0;
	if (kind == 0.0) {
		hero = heroWeight(instanceIndex);
		// Hierarchy: the hero rail is clearly the thickest line in the frame.
		radius = params.style.x * (1.22 + hero * 1.2 + band * 0.6);
	} else if (kind == 1.0) {
		radius = params.style.x * 0.55 * (0.5 + band * 0.2) * (1.0 - params.cloth.z * 0.6);
	} else {
		let k = f32(instanceIndex - FIRST_CHORUS);
		visible = smoothstep(k, k + 1.0, params.topo.w * 16.0);
		// chorusLevel is the light budget's chorus width: thin when the grammar is dense.
		radius = params.style.x * (0.56 + band * 0.34) * visible * params.materialD.z;
	}
	radius = radius * profile;

	// Proper perspective with near clipping, so camera regimes can fly inside
	// the weave; threads close to the lens thin out instead of filling it.
	let depth0 = params.camera.z - center.z;
	radius = radius * mix(1.0, smoothstep(0.12, 0.95, depth0), params.frame.y);
	let position = center + radial * radius;
	let depth = params.camera.z - position.z;
	let focal = params.lens.x;
	let resolution = params.view.xy;
	let aspect = resolution.x / max(resolution.y, 1.0);
	let near = 0.1;
	let far = 14.0;
	let clipZ = clamp((depth - near) / (far - near), -1.0, 2.0) * depth;
	let clip = vec4<f32>(
		position.x * focal / aspect + params.lens.y * depth,
		position.y * focal + params.lens.z * depth,
		clipZ,
		depth
	);

	let detail = bandDetail(family, fract(s));
	let intersection = exp(-pow(abs(fract(s) - fract(params.cloth.x * 0.03125 + familyUnit * 0.23)), 2.0) * 70.0);
	// Phosphor core: rails carry an HDR emissive charge that bloom and the
	// feedback trail pick up; each beat launches a light packet along it.
	let packetsW = 0.45 + params.beat.x * 0.55;
	let packet = exp(-pow(fract(s) - fract(params.cloth.x * 0.1618 + familyUnit * 0.37 + st.role * 0.13), 2.0) * 95.0);
	var emission = 0.16 + band * 0.3 + packet * params.pulse.x * 0.9 * packetsW;
	if (kind == 0.0) {
		emission = (0.42 + hero * 0.62) + band * (0.62 + hero * 0.6) + packet * params.pulse.x * 4.2 * packetsW + params.pulse.w * 0.3;
	} else if (kind == 2.0) {
		// Chorus strands are structure: their glow comes from the light budget.
		emission = (0.3 + band * 0.5 + packet * params.pulse.x * 2.2 * packetsW + params.pulse.w * 0.15) * params.beatB.w;
	}
	// Crossing pulses: where the weft passes over a thread, beats flash.
	let crossAngle = weftAngle(s, st.weft + select(0u, 1u, kind == 0.0 && instanceIndex == 2u));
	let crossing = pow(abs(sin(crossAngle)), 22.0);
	emission = emission + params.beat.z * crossing * (params.pulse.w * 2.4 + params.pulse.x * 2.2) * select(1.0, 0.5, kind == 1.0);
	// Shuttle: a bright band crossing every thread, one throw per beat.
	let shuttleBand = exp(-pow((fract(s) - shuttleS()) * 16.0, 2.0));
	emission = emission + params.beat.w * shuttleBand * (0.9 + params.pulse.x * 3.0);
	// Sparks: fine glints shed along the threads, fed by air and impacts.
	let sparkSeed = hashUnit(u32(fract(s) * 61.0) + 1u, instanceIndex + 3u, u32(params.cloth.x * 2.0));
	let spark = select(0.0, 1.0, sparkSeed > 0.95) * pow(max(0.0, sin(s * 157.0 + st.sid * 13.7 - params.view.z * 11.0)), 40.0)
		* (params.beatB.x * (0.3 + params.audioB.z * 1.2 + params.pulse.x * 1.6) + params.materialD.y * params.audioB.z * 0.25)
		* select(1.0, 0.5, kind == 2.0);
	emission = emission * params.style.z * (1.0 - params.style.w * 0.8) * params.frame.w;
	// Beats read as a colour event, not only a brightness event: the packet
	// shifts toward the weft colour as it travels.
	let packetMix = clamp(packet * params.pulse.x * 1.6 * packetsW, 0.0, 1.0) * select(0.5, 1.0, kind == 0.0);

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
	value = value * (1.0 - params.style.w * 0.56);

	let cameraPoint = vec3<f32>(0.0, 0.0, params.camera.z);
	var out: LoomOut;
	out.position = clip;
	out.worldNormal = radial;
	out.viewDirection = normalize(cameraPoint - position);
	out.color = mix(base * value, weftC * value * 1.35, packetMix);
	out.dataA = vec4<f32>(s, kind, band, select(st.role, hero, kind == 0.0));
	out.dataB = vec4<f32>(detail, emission, intersection, depth);
	out.tangent = tangent;
	out.dataC = vec4<f32>(st.lane, st.sid, spark * params.style.z * (1.0 - params.style.w), visible);
	return out;
}

fn envReflection(r: vec3<f32>, keyLight: vec3<f32>, keyColor: vec3<f32>) -> vec3<f32> {
	let deep = params.deepTint.rgb;
	let haze = params.hazeTint.rgb;
	let glow = params.glowTint.rgb;
	let up = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);
	var c = mix(glow * 0.35 + haze * 0.5, haze * 1.4 + deep, smoothstep(0.42, 0.95, up));
	c = c + glow * exp(-pow((r.y - 0.02) * 7.0, 2.0)) * 1.1;
	c = c + keyColor * pow(max(dot(r, keyLight), 0.0), 24.0) * 1.6;
	return c;
}

@fragment
fn fs_main(in: LoomOut) -> @location(0) vec4<f32> {
	let normal = normalize(in.worldNormal);
	let view = normalize(in.viewDirection);
	let az = params.light.x * TAU;
	let keyLight = normalize(vec3<f32>(-0.66 * cos(az), params.light.y, 0.5 + 0.32 * sin(az)));
	let rimLight = normalize(vec3<f32>(0.72 * cos(az), -0.24, 0.52 - 0.2 * sin(az)));
	let kind = in.dataA.y;
	let isSecondary = kind == 1.0;
	let isChorus = kind == 2.0;
	let matA = params.materialA;
	let matB = params.materialB;
	let matC = params.materialC;
	let matD = params.materialD;

	let ndv = dot(normal, view);
	let diffuseKey = max(dot(normal, keyLight), 0.0);
	let diffuseFill = max(dot(normal, rimLight), 0.0);
	let rim = pow(1.0 - abs(ndv), 2.0);
	let specPower = mix(12.0, 110.0, matA.z);
	let specular = pow(max(dot(reflect(-keyLight, normal), view), 0.0), specPower);
	let hero = select(0.0, in.dataA.w, kind == 0.0);
	// Striations crawl along the rail a quarter period per beat, so tempo is
	// visible on the surface; the hero carries the strongest pattern.
	// Coarse enough to resolve at Loom's pixel cap: finer striations alias into
	// shimmering noise on thin strands.
	let stripePhase = in.dataA.x * select(190.0, 330.0, isSecondary) - params.cloth.x * 1.5707963;
	let stripeAmount = clamp((0.015 + hero * 0.075) * matC.y + max(0.0, matC.y - 2.0) * 0.09, 0.0, 0.62);
	let striation = (1.0 - stripeAmount) + stripeAmount * cos(stripePhase);

	let warm = params.light.z;
	let warmTint = mix(vec3<f32>(0.96, 0.98, 1.04), vec3<f32>(1.06, 0.94, 0.8), warm);
	let rimColor = mix(vec3<f32>(1.0), colorPeak(params.weftTint.rgb), 0.6) * 1.05;
	// Coloured light rig: key carries the support colour, fill the hero, so
	// highlights never bleach the palette to white.
	let keyColor = mix(vec3<f32>(1.0), colorPeak(params.supportTint.rgb), 0.45) * warmTint;
	let fillColor = colorPeak(params.heroTint.rgb) * params.light.w;
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
	let core = pow(max(ndv, 0.0), 2.2);
	// Molten glass: long, slowly flowing heat bands along the thread.
	let hot = 1.0 + matC.w * 0.9 * pow(0.5 + 0.5 * sin(in.dataA.x * TAU * 1.5 + in.dataC.y * 6.0 - params.cloth.x * 0.125), 2.5);
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
	lit = lit * select(1.0, 0.92, isChorus) * params.beatB.z;
	// Ink on paper: the fibre becomes a deep coloured line, shaded by the key
	// light, with a thin cool sheen; the paper room is composited around it.
	let paper = params.postB.w;
	let ink = in.color * (0.1 + diffuseKey * 0.3 + diffuseFill * 0.08) * striation * mix(1.0, 0.6, hero)
		+ keyColor * (specular * 0.05 + aniso * 0.03) + rimColor * rim * 0.025;
	lit = mix(lit, ink, paper);
	// Alpha is coverage: the composite inks the paper room with it.
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
	let theta = (sin(params.cloth.y * 0.35) * 0.0025 + params.postB.z) * params.view.w;
	let c = cos(theta);
	let sn = sin(theta);
	let rotated = vec2<f32>(centered.x * c - centered.y * sn, centered.x * sn + centered.y * c) * params.post.y;
	let previousUv = rotated + 0.5 + vec2<f32>(-0.0006 + params.postB.x, params.postB.y) * params.view.w;
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.03, edge);
	let previous = textureSampleLevel(previousTexture, sceneSampler, previousUv, 0.0);
	let scene = textureSampleLevel(sceneTexture, sceneSampler, in.uv, 0.0);
	let trail = previous * params.post.x * border;
	// rgb: light trail; a: coverage trail (ink for the paper tone), kept
	// shorter than the light so ink never bleeds into a halo.
	return max(vec4<f32>(trail.rgb, trail.a * 0.8), scene);
}
`;

// Bloom prefilter: half-resolution 4-tap downsample with a soft HDR knee so
// only the phosphor cores and light packets bloom, never the chamber.
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

export const LOOM_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var feedbackTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;

fn aces(color: vec3<f32>) -> vec3<f32> {
	let a = 2.51;
	let b = 0.03;
	let c = 2.43;
	let d = 0.59;
	let e = 0.14;
	return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn colorPeakPost(c: vec3<f32>) -> vec3<f32> {
	return c / max(max(c.r, max(c.g, c.b)), 1e-3);
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);
	let time = params.view.z;

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
	let coverage = clamp(centreTap.a, 0.0, 1.0);
	let paper = clamp(params.postB.w, 0.0, 1.0);
	let bloom = textureSampleLevel(bloomTexture, sceneSampler, warped, 0.0).rgb;

	// Environment. uv.y grows downward, so p.y is flipped to read "up is
	// positive". Colours come from the palette family; which features show is
	// the genome's environment (chamber, open sky, water, mirror box, fog bank,
	// starfield), all blended by coefficients so eras crossfade.
	let aspect = resolution.x / max(resolution.y, 1.0);
	let p = vec2<f32>((warped.x - 0.5) * aspect, 0.5 - warped.y);
	let distance = length(p * vec2<f32>(0.72, 1.0));
	let deep = params.deepTint.rgb;
	// Family haze tints are deep; lift them toward their own hue so the room
	// always reads as coloured light, never as black.
	let haze = mix(params.hazeTint.rgb * 2.2, colorPeakPost(params.hazeTint.rgb) * 0.16, 0.45) * params.hazeTint.w;
	let glow = params.glowTint.rgb * params.glowTint.w;
	let floorLine = params.envC.x;
	let floorAmount = params.envC.z;
	let above = p.y - floorLine;
	let energy = params.macroRails.x;
	let quiet = params.style.w;

	// Deep room: haze that thins toward the edges, a band of light pooling just
	// above the floor line.
	let depthHaze = exp(-distance * (2.2 - params.shape.z * 0.3));
	let pool = exp(-pow((above - 0.05) * 7.0, 2.0));
	var background = vec3<f32>(0.0016, 0.0022, 0.0044) + deep * 0.35
		+ haze * 1.25 * depthHaze * (0.8 + energy * 0.2) * (1.0 - quiet * 0.5)
		+ glow * 0.14 * pool * (0.35 + energy * 0.2 + params.pulse.x * 0.7) * (1.0 - quiet * 0.7) * params.envB.z * floorAmount;

	// Open sky: a gradient that warms toward the horizon and an off-centre
	// glow source low on one side (never a centred orb).
	let skyMask = smoothstep(-0.03, 0.03, above);
	let skyGrad = mix(glow * 0.2 + haze * 0.6, haze * 0.9 + deep * 0.6, smoothstep(0.0, 0.8, above));
	let sunPos = vec2<f32>(params.envC.y * aspect * 0.5, floorLine + 0.1);
	let sunDelta = (p - sunPos) * vec2<f32>(1.0, 1.7);
	let sun = glow * (exp(-length(sunDelta) * 4.5) * 0.32 + exp(-length(sunDelta) * 26.0) * 0.5);
	background = background + (skyGrad * 0.75 + sun) * params.envB.x * mix(1.0, skyMask, floorAmount);

	// Starfield: sparse twinkling points above the horizon, brighter with air.
	let cell = floor(in.uv * resolution / 2.5);
	let starHash = fract(sin(dot(cell, vec2<f32>(12.9898, 78.233))) * 43758.5453);
	let twinkle = 0.55 + 0.45 * sin(time * (1.5 + starHash * 3.0) + starHash * 80.0);
	let star = step(0.9965, starHash) * twinkle * (0.9 + params.audioB.z * 1.2);
	background = background + mix(vec3<f32>(0.85, 0.9, 1.0), colorPeakPost(params.weftTint.rgb), 0.3) * star * params.envA.w
		* mix(1.0, skyMask, floorAmount) * 0.75;

	// Fog bank: a luminous drifting layer sitting on the floor.
	let fogNoise = 0.65 + 0.35 * sin(p.x * 3.1 + time * 0.21 + sin(p.x * 7.3 - time * 0.13) * 1.4);
	let fogBand = exp(-pow((above - 0.05) / 0.2, 2.0)) * fogNoise;
	background = background + (glow * 0.16 + haze * 0.7) * fogBand * params.envA.z;

	// Floor: the instrument reflects in it, blurred and fading with distance
	// from the floor line; water adds travelling ripples.
	let floorMask = smoothstep(floorLine, floorLine - 0.06, p.y) * floorAmount;
	let below = max(0.0, -above);
	let rippleAmount = params.envA.y * (0.5 + params.audioA.y * 1.2) * (0.3 + below * 5.0);
	let ripple = vec2<f32>(
		sin(p.y * 140.0 / (below + 0.25) - time * 2.4 + sin(p.x * 9.0) * 1.5) * 0.0035,
		sin(p.x * 38.0 + time * 1.7 + p.y * 22.0) * 0.0025
	) * rippleAmount;
	let mirroredUv = vec2<f32>(warped.x, 2.0 * (0.5 - floorLine) - warped.y) + ripple;
	let mirroredTap = textureSampleLevel(feedbackTexture, sceneSampler, mirroredUv, 0.0);
	let reflection = mix(
		mirroredTap.rgb,
		textureSampleLevel(bloomTexture, sceneSampler, mirroredUv, 0.0).rgb,
		0.55
	);
	let reflectionFade = exp(-below * 5.0);
	background = background + reflection * floorMask * reflectionFade * (0.22 + params.style.z * 0.1) * params.envA.x;
	background = background + haze * floorMask * params.envA.y * 0.35 * (0.6 + 0.4 * sin(p.x * 20.0 + time));
	// Horizon: a soft lit edge where the floor meets the room.
	background = background + glow * 0.05 * exp(-pow(above * 30.0, 2.0)) * params.envB.w * floorAmount;

	// Mirror box: angled side mirrors. Each panel holds the whole scene,
	// mirrored and compressed toward the seam and shrinking with depth, so it
	// reads as a receding reflection instead of a cut-off copy.
	let halfW = aspect * 0.5;
	let wallX = halfW * 0.6;
	let panel = clamp((abs(p.x) - wallX) / max(halfW - wallX, 1e-3), 0.0, 1.0);
	let inPanel = smoothstep(wallX, wallX + 0.02, abs(p.x));
	let horizonY = floorLine + 0.2;
	let srcX = sign(p.x) * wallX * (1.0 - panel) * 1.05;
	let srcY = horizonY + (p.y - horizonY) * (1.0 + panel * 0.7);
	let wallUv = vec2<f32>(srcX / aspect + 0.5, 0.5 - srcY);
	let wallReflection = textureSampleLevel(bloomTexture, sceneSampler, wallUv, 0.0).rgb * 0.55
		+ textureSampleLevel(feedbackTexture, sceneSampler, wallUv, 0.0).rgb * 0.45;
	let wallFade = inPanel * (1.0 - panel * 0.55) * params.envB.y;
	background = background + (wallReflection * 0.5 + haze * 0.2) * wallFade
		+ glow * 0.04 * exp(-pow((abs(p.x) - wallX) * 90.0, 2.0)) * params.envB.y * (1.0 - smoothstep(0.3, 0.55, abs(p.y)));

	// Paper room (ink tone): a pale sheet tinted by the family, lit from one
	// side, with the instrument's ink shadow on the floor. Light on dark and
	// dark on light are the same composite, crossfaded.
	let paperTint = mix(vec3<f32>(0.84, 0.78, 0.68), colorPeakPost(params.hazeTint.rgb) * 0.8, 0.2);
	let paperLight = 0.82 + 0.18 * smoothstep(-0.7, 0.7, p.y + p.x * 0.35);
	var paperRoom = paperTint * paperLight * 0.74 + glow * 0.02;
	paperRoom = paperRoom * (1.0 - floorMask * reflectionFade * clamp(mirroredTap.a, 0.0, 1.0) * 0.3);
	paperRoom = paperRoom * (1.0 - floorMask * 0.08) + paperTint * 0.04 * exp(-pow(above * 30.0, 2.0)) * floorAmount;
	let room = mix(background, paperRoom, paper);

	let vignette = 1.0 - smoothstep(0.54, 1.14, distance);
	let exposure = (0.94 + energy * 0.2) * params.deepTint.w;
	// Light budget: bloom is an accent whose weight follows how bright the look is.
	let bloomTerm = bloom * params.envC.w * (1.0 + params.style.z * 0.3);
	let inked = room * (1.0 - coverage * paper * 0.94);
	var color = (inked + scene + bloomTerm) * exposure * (0.70 + vignette * 0.30);
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
