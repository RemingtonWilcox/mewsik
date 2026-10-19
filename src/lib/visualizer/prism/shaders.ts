// Prism: an obsidian stained-glass window that keeps turning into new windows.
// The production scene is a lit window set in a dark building, seen through a
// real camera: jewel glass in lead came on a recessed plane, carved stone
// tracery in front of it, the wall architecture in front of both, and a floor
// that mirrors and catches the light. The glass is a living mosaic: its cells
// divide as a phrase grows and re-draft at phrase boundaries, beats travel
// through the facets as packets of light, and each section re-sets the window
// as a new composition, piece by piece, in a lit dissolve that washes outward
// from its centre. Nothing in the picture ever cuts.
//
// The look is a point in Prism's variation genome (composition.ts): eight
// window grammars, five mosaic cuts, six beat forms, five environments, seven
// camera regimes and dozens of palette families, all chosen by uniforms in
// this one pipeline rather than by separate pipelines.
//
// WGSL footguns (see docs/loom-visualizer-handoff.md section 19): every binding
// must stay referenced from an entry point because pipelines use layout auto,
// and a backtick anywhere in these template strings ends the JS literal.

export const PRISM_BIN_COUNT = 64;

/** Uniform floats: 24 legacy scalars + 28 vec4 groups. */
export const PRISM_UNIFORM_FLOATS = 136;
export const PRISM_UNIFORM_BYTES = PRISM_UNIFORM_FLOATS * 4;

/** Float offsets of each vec4 group, mirrored by the WGSL Uniforms struct. */
export const PRISM_UNIFORM_OFFSETS = {
	comp: 24,
	shapeA: 28,
	shapeB: 32,
	gramA: 36,
	gramB: 40,
	detail: 44,
	organism: 48,
	light: 52,
	modes: 56,
	sun: 60,
	heroCol: 64,
	supportCol: 68,
	accentCol: 72,
	fieldCol: 76,
	post: 80,
	env: 84,
	bands: 88,
	motion: 92,
	camPos: 96,
	camRight: 100,
	camUp: 104,
	camFwd: 108,
	roseScreen: 112,
	world: 116,
	sky: 120,
	atmos: 124,
	shaft: 128,
	morph: 132
} as const;

const COMMON_WGSL = /* wgsl */ `
struct Uniforms {
	resolutionX: f32,
	resolutionY: f32,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	centroid: f32,
	rms: f32,
	flash: f32,
	bloomThreshold: f32,
	feedbackFade: f32,
	feedbackRotation: f32,
	feedbackZoom: f32,
	blurDirX: f32,
	blurDirY: f32,
	beatPhase: f32,
	chromaKey: f32,
	chromaStrength: f32,
	bpmNorm: f32,
	songSeed: f32,
	palJump: f32,
	sceneWeight: f32,
	longPhase: f32,
	sectionEnergy: f32,
	// foldA, foldB, morph front (window radii), light at the front
	comp: vec4<f32>,
	// petalWidth, petalReach, cellScale, outerLit (composition A)
	shapeA: vec4<f32>,
	// petalWidth, petalReach, cellScale, outerLit (composition B)
	shapeB: vec4<f32>,
	// grammar, mosaic cut, tiers, outline variant (composition A)
	gramA: vec4<f32>,
	// grammar, mosaic cut, tiers, outline variant (composition B)
	gramB: vec4<f32>,
	// tracery weight, cusp depth, sprinkle, lit neighbour bays
	detail: vec4<f32>,
	// growth, mosaic draft, eased progress into the next draft, look salt
	organism: vec4<f32>,
	// backlight, packetStrength, beatAge, beatCount
	light: vec4<f32>,
	// beat form from, beat form to, beat form mix, coolness
	modes: vec4<f32>,
	// sunX, sunY, sunPower, haze
	sun: vec4<f32>,
	heroCol: vec4<f32>,
	supportCol: vec4<f32>,
	accentCol: vec4<f32>,
	fieldCol: vec4<f32>,
	// feedbackFade, feedbackZoom, bloomThreshold, aberration
	post: vec4<f32>,
	// spare, spare, silence, roseRotation
	env: vec4<f32>,
	// low, mid, high, impact
	bands: vec4<f32>,
	// feedback rotation delta, frame, energy, exposure
	motion: vec4<f32>,
	// camera position xyz, focal length
	camPos: vec4<f32>,
	// camera right xyz, bay spacing
	camRight: vec4<f32>,
	// camera up xyz, unused
	camUp: vec4<f32>,
	// camera forward xyz, floor wetness
	camFwd: vec4<f32>,
	// hero window on screen: centre xy, radius, unused
	roseScreen: vec4<f32>,
	// environment from, environment to, environment mix, rain
	world: vec4<f32>,
	// light colour behind the glass rgb, night
	sky: vec4<f32>,
	// fog, dust, caustics, sun count
	atmos: vec4<f32>,
	// side shaft strength, side shaft angle, side shaft position, unused
	shaft: vec4<f32>,
	// composition A salt, composition B salt, global finishing fade, unused
	morph: vec4<f32>,
};

const TAU: f32 = 6.28318530718;
const PI: f32 = 3.14159265359;
// Window centre height and radius in world units (screen-height units when
// the camera is square-on), and the floor plane.
const ROSE_Y: f32 = 0.07;
const ROSE_R: f32 = 0.32;
const FLOOR_Y: f32 = -0.29;
const STONE_Z: f32 = 0.014;
const GLASS_Z: f32 = 0.032;

fn fullscreenVS(idx: u32) -> vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

// Slow 1D value noise used by the legacy lab scenes.
fn snoise(t: f32) -> f32 {
	let i = floor(t);
	let f = t - i;
	let w = f * f * (3.0 - 2.0 * f);
	let h0 = fract(sin(i * 12.9898) * 43758.5453);
	let h1 = fract(sin((i + 1.0) * 12.9898) * 43758.5453);
	return mix(h0, h1, w);
}

// Four picked stops for the legacy lab scenes (never a cosine ramp).
fn iridescent(t: f32) -> vec3<f32> {
	let s = fract(t);
	let indigo  = vec3<f32>(0.08, 0.04, 0.32);
	let teal    = vec3<f32>(0.07, 0.55, 0.62);
	let gold    = vec3<f32>(0.94, 0.55, 0.18);
	let magenta = vec3<f32>(0.78, 0.18, 0.66);
	let x = s * 4.0;
	if (x < 1.0) { return mix(indigo,  teal,    smoothstep(0.0, 1.0, x)); }
	if (x < 2.0) { return mix(teal,    gold,    smoothstep(0.0, 1.0, x - 1.0)); }
	if (x < 3.0) { return mix(gold,    magenta, smoothstep(0.0, 1.0, x - 2.0)); }
	return mix(magenta, indigo, smoothstep(0.0, 1.0, x - 3.0));
}
`;

// Integer hashes, camera and small helpers shared by the window and the
// presentation pass (both bind the uniforms as u).
const ROSE_HELPERS_WGSL = /* wgsl */ `
fn pmix(x0: u32) -> u32 {
	var x = x0;
	x = x ^ (x >> 16u);
	x = x * 0x7feb352du;
	x = x ^ (x >> 15u);
	x = x * 0x846ca68bu;
	x = x ^ (x >> 16u);
	return x;
}

fn hcell(c: vec2<f32>, salt: u32) -> vec2<f32> {
	let ic = bitcast<vec2<u32>>(vec2<i32>(c));
	let a = pmix((ic.x * 0x9e3779b1u) ^ pmix(ic.y ^ salt));
	let b = pmix(a ^ 0x68bc21ebu);
	return vec2<f32>(f32(a >> 8u), f32(b >> 8u)) / 16777216.0;
}

fn hnum(n: f32, salt: u32) -> f32 {
	return f32(pmix((bitcast<u32>(i32(n)) * 0x85ebca6bu) ^ salt) >> 8u) / 16777216.0;
}

fn vnoise(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	let a = hcell(i, 17u).x;
	let b = hcell(i + vec2<f32>(1.0, 0.0), 17u).x;
	let c = hcell(i + vec2<f32>(0.0, 1.0), 17u).x;
	let d = hcell(i + vec2<f32>(1.0, 1.0), 17u).x;
	return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn rot2(a: f32) -> mat2x2<f32> {
	let c = cos(a);
	let s = sin(a);
	return mat2x2<f32>(c, s, -s, c);
}

fn seedSalt() -> u32 {
	return u32(max(u.organism.w, 0.0));
}

// Camera: screen point (height units, y up) to a world ray, and back.
fn camRay(p: vec2<f32>) -> vec3<f32> {
	return normalize(u.camRight.xyz * p.x + u.camUp.xyz * p.y + u.camFwd.xyz * u.camPos.w);
}

fn projectScreen(w: vec3<f32>) -> vec2<f32> {
	let d = w - u.camPos.xyz;
	let z = max(dot(d, u.camFwd.xyz), 1e-3);
	return vec2<f32>(dot(d, u.camRight.xyz), dot(d, u.camUp.xyz)) * (u.camPos.w / z);
}

fn toUv(p: vec2<f32>, aspect: f32) -> vec2<f32> {
	return vec2<f32>(p.x / aspect + 0.5, 0.5 - p.y);
}

// Weight of environment e in the current crossfade.
fn envWeight(e: f32) -> f32 {
	return select(0.0, 1.0 - u.world.z, abs(u.world.x - e) < 0.5)
		+ select(0.0, u.world.z, abs(u.world.y - e) < 0.5);
}
`;

// ---------------------------------------------------------------------------
// Production scene: the window, its building and the camera.
// ---------------------------------------------------------------------------
export const PRISM_ROSE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;

${ROSE_HELPERS_WGSL}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

struct Sym {
	q: vec2<f32>,
	wedge: f32,
	side: f32,
};

// Mirror the plane into one half-wedge of an n-fold rose. q.x runs along the
// wedge axis, q.y is the (non-negative) distance from it.
fn foldRose(p: vec2<f32>, n: f32) -> Sym {
	let r = length(p);
	let a = atan2(p.y, p.x);
	let seg = TAU / n;
	let k = floor(a / seg + 0.5);
	let local = a - k * seg;
	let m = abs(local);
	var f: Sym;
	f.q = vec2<f32>(cos(m), sin(m)) * r;
	f.wedge = k - n * floor(k / n);
	f.side = select(-1.0, 1.0, local >= 0.0);
	return f;
}

// Symmetry of each grammar: radial roses fold n ways, the tall nouveau and
// deco windows mirror left-right, modern fields keep no symmetry.
fn symmetry(p: vec2<f32>, n: f32, grammar: f32) -> Sym {
	if (grammar < 4.5) { return foldRose(p, n); }
	var s: Sym;
	if (grammar < 6.5) {
		s.q = vec2<f32>(abs(p.x), p.y);
		s.side = select(-1.0, 1.0, p.x >= 0.0);
	} else {
		s.q = p;
		s.side = 1.0;
	}
	s.wedge = 0.0;
	return s;
}

fn sdVesica(p0: vec2<f32>, r: f32, d: f32) -> f32 {
	let p = abs(p0);
	let b = sqrt(max(r * r - d * d, 0.0));
	if ((p.y - b) * d > p.x * b) {
		return length(p - vec2<f32>(0.0, b));
	}
	return length(p - vec2<f32>(-d, 0.0)) - r;
}

// Pointed vesica of half-width w and half-length l, long axis along y.
fn sdPetal(p: vec2<f32>, w: f32, l: f32) -> f32 {
	let hw = max(w, 0.004);
	let hl = max(l, hw * 1.05);
	let r = (hw + hl * hl / hw) * 0.5;
	let d = (hl * hl / hw - hw) * 0.5;
	return sdVesica(p, r, d);
}

fn sdBox(p: vec2<f32>, b: vec2<f32>) -> f32 {
	let d = abs(p) - b;
	return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

// Opening within half-angle k of axis angle a0, between radii r0 and r1.
fn sdSector(rn: f32, ang: f32, a0: f32, k: f32, r0: f32, r1: f32) -> f32 {
	return max((abs(ang - a0) - k) * rn, max(r0 - rn, rn - r1));
}

// Window outlines in window-radius units: circles for the roses, a pointed
// Islamic arch for some lattices, a round arch for nouveau, a stepped
// ziggurat for deco, a lancet or a tall panel for modern fields.
fn sdPointedArch(p: vec2<f32>, w: f32, bottom: f32, spring: f32) -> f32 {
	let x = abs(p.x);
	if (p.y > spring) {
		return length(vec2<f32>(x + w, p.y - spring)) - 2.0 * w;
	}
	return max(x - w, bottom - p.y);
}

fn sdRoundArch(p: vec2<f32>, w: f32, bottom: f32, spring: f32) -> f32 {
	if (p.y > spring) {
		return length(vec2<f32>(p.x, p.y - spring)) - w;
	}
	return max(abs(p.x) - w, bottom - p.y);
}

fn outlineSd(p: vec2<f32>, grammar: f32, ov: f32) -> f32 {
	if (grammar < 3.5 || (grammar < 4.5 && ov < 0.5)) { return length(p) - 1.0; }
	if (grammar < 4.5) { return sdPointedArch(p, 0.7, -0.95, -0.2); }
	if (grammar < 5.5) { return sdRoundArch(p, 0.56, -0.95, 0.42); }
	if (grammar < 6.5) {
		let a = sdBox(p - vec2<f32>(0.0, -0.225), vec2<f32>(0.62, 0.725));
		let b = sdBox(p - vec2<f32>(0.0, -0.095), vec2<f32>(0.46, 0.855));
		let c = sdBox(p - vec2<f32>(0.0, 0.015), vec2<f32>(0.29, 0.965));
		return min(a, min(b, c));
	}
	if (ov < 0.5) { return sdPointedArch(p, 0.52, -0.95, 0.08); }
	return sdBox(p - vec2<f32>(0.0, 0.02), vec2<f32>(0.54, 0.91)) - 0.06;
}

struct Tracery {
	sd: f32,
	kind: f32,
};

// kind: 1 hero, 2 support tier, 3 accent eye, 4 rim, 5 boss, 6 field.
fn rim(t0: Tracery, rn: f32) -> Tracery {
	var t = t0;
	let dRim = abs(rn - 0.962) - 0.026;
	if (dRim < t.sd) { t.sd = dRim; t.kind = 4.0; }
	return t;
}

// Gothic rose: pointed-vesica petals on every axis, roundels on the outer
// tier, spandrel eyes between petals, a narrow rim of small glass.
fn trGothic(q: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, cusp: f32) -> Tracery {
	let rn = length(q);
	let h = PI / n;
	var t: Tracery;
	t.sd = rn - 0.13;
	t.kind = 5.0;
	let a0 = 0.17;
	let a1 = shape.y;
	let c = (a0 + a1) * 0.5;
	let halfLen = (a1 - a0) * 0.5;
	let halfWid = clamp(shape.x * c * sin(h) * 0.94, 0.02, halfLen * 0.86);
	let lobes = abs(sin(clamp((q.x - a0) / max(a1 - a0, 0.01), 0.0, 1.0) * PI * 3.0));
	let dPetal = sdPetal(vec2<f32>(q.y, q.x - c), halfWid, halfLen) + cusp * 0.018 * lobes;
	if (dPetal < t.sd) { t.sd = dPetal; t.kind = 1.0; }
	if (tiers > 0.25) {
		let rc = clamp(a1 + 0.13, 0.66, 0.8);
		let ra = h * 0.5;
		let rCenter = vec2<f32>(cos(ra), sin(ra)) * rc;
		let rr = min(min(rc * sin(ra) * 0.86, 0.915 - rc), 0.13);
		let dRound = length(q - rCenter) - rr;
		if (dRound < t.sd) { t.sd = dRound; t.kind = 2.0; }
	}
	if (tiers > 0.75) {
		let dTip = length(q - vec2<f32>(0.87, 0.0)) - min(0.05, 0.87 * sin(h) * 0.35);
		if (dTip < t.sd) { t.sd = dTip; t.kind = 3.0; }
	}
	let rs = a1 * 0.72 + 0.05;
	let sCenter = vec2<f32>(cos(h), sin(h)) * rs;
	let gap = max(rs * sin(h) - halfWid * 0.85, 0.012);
	let dEye = length(q - sCenter) - min(gap * 0.55, 0.05);
	if (dEye < t.sd) { t.sd = dEye; t.kind = 3.0; }
	return rim(t, rn);
}

// Rayonnant: many narrow lancets radiating from the boss, each with a round
// (or cusped trefoil) head, and a second tier of short lancets between them.
fn trRayonnant(q: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, cusp: f32) -> Tracery {
	let rn = length(q);
	let ang = atan2(q.y, q.x);
	let h = PI / n;
	var t: Tracery;
	t.sd = rn - 0.15;
	t.kind = 5.0;
	let k = h * (0.38 + shape.x * 0.36);
	let r1 = shape.y + 0.06;
	let dL = sdSector(rn, ang, 0.0, k, 0.21, r1);
	if (dL < t.sd) { t.sd = dL; t.kind = 1.0; }
	let hr = r1 * sin(k) * 1.15;
	var dHead = length(q - vec2<f32>(r1 + hr * 0.9, 0.0)) - hr;
	if (cusp > 0.4) {
		let lobe = hr * 0.62;
		let up = length(q - vec2<f32>(r1 + hr * 0.7, lobe * 0.9)) - lobe;
		let tip = length(q - vec2<f32>(r1 + hr * 1.5, 0.0)) - lobe;
		dHead = min(dHead, min(up, tip));
	}
	if (dHead < t.sd) { t.sd = dHead; t.kind = 3.0; }
	if (tiers > 0.25) {
		let r2 = min(r1 + hr * 2.4 + 0.04, 0.84);
		let dOuter = sdSector(rn, ang, h, h * 0.42, r2, 0.92);
		if (dOuter < t.sd) { t.sd = dOuter; t.kind = 2.0; }
	}
	if (tiers > 0.75) {
		let dInner = sdSector(rn, ang, h, h * 0.3, 0.3, r1 * 0.7);
		if (dInner < t.sd) { t.sd = dInner; t.kind = 6.0; }
	}
	return rim(t, rn);
}

// Flamboyant: curved mouchette daggers in mirrored flame pairs around the
// boss, quatrefoil soufflets on the axes, small daggers on the outer tier.
fn trFlamboyant(q: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, cusp: f32) -> Tracery {
	let rn = length(q);
	let ang = atan2(q.y, q.x);
	let h = PI / n;
	var t: Tracery;
	t.sd = rn - 0.12;
	t.kind = 5.0;
	let a1 = shape.y + 0.05;
	let c = 0.19 + (a1 - 0.19) * 0.5;
	let halfLen = (a1 - 0.19) * 0.5;
	let off = c * sin(h) * 0.5;
	let x = q.x - c;
	let bend = (0.7 + cusp * 0.9) / max(halfLen, 0.1);
	let v = q.y - off - bend * x * abs(x) * 0.5 + x * 0.18;
	let halfWid = clamp(shape.x * off * 0.95, 0.03, halfLen * 0.62);
	let dDag = sdPetal(vec2<f32>(v, x), halfWid, halfLen);
	if (dDag < t.sd) { t.sd = dDag; t.kind = 1.0; }
	let dAxis = sdPetal(vec2<f32>(q.y, q.x - 0.27), 0.03, 0.08);
	if (dAxis < t.sd) { t.sd = dAxis; t.kind = 2.0; }
	let rq = min(a1 + 0.1, 0.83);
	let lobe = min(0.045, rq * sin(h) * 0.3);
	let qq = q - vec2<f32>(rq, 0.0);
	let dSouf = min(
		min(length(qq - vec2<f32>(lobe, 0.0)), length(qq + vec2<f32>(lobe, 0.0))),
		length(vec2<f32>(qq.x, abs(qq.y) - lobe))
	) - lobe * 0.95;
	if (dSouf < t.sd) { t.sd = dSouf; t.kind = 3.0; }
	if (tiers > 0.25) {
		let dOuter = sdSector(rn, ang, h, h * 0.3, 0.84, 0.925);
		if (dOuter < t.sd) { t.sd = dOuter; t.kind = 2.0; }
	}
	if (tiers > 0.75) {
		let dFlame = sdPetal(vec2<f32>(q.y - sin(h) * 0.6 * 0.62, q.x - 0.62), 0.022, 0.07);
		if (dFlame < t.sd) { t.sd = dFlame; t.kind = 6.0; }
	}
	return rim(t, rn);
}

// Romanesque wheel: stone spokes from a broad hub to round-arched heads, a
// ring of oculi outside, and optionally a transom splitting each panel.
fn trRomanesque(q: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, weight: f32) -> Tracery {
	let rn = length(q);
	let h = PI / n;
	var t: Tracery;
	t.sd = rn - 0.18;
	t.kind = 5.0;
	let st = 0.016 + weight * 0.022;
	let ra = clamp(shape.y + 0.04, 0.58, 0.78);
	let side = q.y * cos(h) - (q.x * sin(h) - st);
	let hw = ra * sin(h) - st;
	let dRect = max(side, max(0.25 - q.x, q.x - ra));
	let dArch = length(q - vec2<f32>(ra, 0.0)) - hw;
	var dPanel = max(min(dRect, dArch), side);
	if (tiers > 0.25) {
		dPanel = max(dPanel, -(abs(q.x - mix(0.4, 0.46, shape.x)) - st * 0.8));
	}
	if (dPanel < t.sd) { t.sd = dPanel; t.kind = 1.0; }
	let ro = 0.885;
	let orr = min(0.055, ro * sin(h) * 0.42);
	let dAxisEye = length(q - vec2<f32>(ro, 0.0)) - orr;
	if (dAxisEye < t.sd) { t.sd = dAxisEye; t.kind = 3.0; }
	let dGapEye = length(q - vec2<f32>(cos(h), sin(h)) * ro) - orr;
	if (dGapEye < t.sd) { t.sd = dGapEye; t.kind = 2.0; }
	if (tiers > 0.75) {
		let dHub = sdSector(rn, atan2(q.y, q.x), 0.0, h * 0.5, 0.2, 0.235);
		if (dHub < t.sd) { t.sd = dHub; t.kind = 6.0; }
	}
	return rim(t, rn);
}

// n-pointed star in folded coordinates: negative inside.
fn starSd(q: vec2<f32>, n: f32, r1: f32, r2: f32) -> f32 {
	let h = PI / n;
	let a = vec2<f32>(r1, 0.0);
	let b = vec2<f32>(cos(h), sin(h)) * r2;
	let e = b - a;
	let w = q - a;
	return (w.x * e.y - w.y * e.x) / max(length(e), 1e-4);
}

// Girih: a square lattice of eight-point stars in carved strapwork, with a
// central n-point star held in its own strap ring.
fn trGirih(p: vec2<f32>, q: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, weight: f32, ov: f32) -> Tracery {
	let rn = length(p);
	let k = 2.3 + tiers * 1.4 + shape.x * 0.6;
	let c = fract(p * k + 0.5) - 0.5;
	var a = abs(c);
	if (a.y > a.x) { a = a.yx; }
	let sr = length(a);
	let sa = atan2(a.y, a.x);
	let folded8 = vec2<f32>(cos(sa), sin(sa)) * sr;
	let d8 = starSd(folded8, 8.0, 0.44, 0.44 * mix(0.5, 0.66, shape.y));
	let strap = 0.035 + weight * 0.04;
	var t: Tracery;
	t.sd = (strap - abs(d8)) / k;
	t.kind = select(6.0, 1.0, d8 < 0.0);
	if (length(a - vec2<f32>(0.5, 0.5)) < 0.17) { t.kind = 3.0; }
	let r1 = 0.24 + shape.y * 0.12;
	let dStar = starSd(q, n, r1, r1 * 0.58);
	let band = 0.022 + weight * 0.012;
	if (dStar < 0.0) {
		t.sd = dStar + band;
		t.kind = select(2.0, 3.0, rn < 0.09);
	} else {
		t.sd = max(t.sd, band * 1.6 - dStar);
	}
	if (ov < 0.5 && rn > 0.93) {
		t.sd = abs(rn - 0.962) - 0.026;
		t.kind = 4.0;
	}
	return t;
}

// Art nouveau: whiplash stems rising and swaying up a round-arched window,
// flower heads on their tips, glass fields between the stems.
fn trNouveau(p: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, weight: f32, salt: u32) -> Tracery {
	let x = abs(p.x);
	let v = p.y;
	let lead = 0.013 + weight * 0.012;
	let amp = 0.05 + shape.x * 0.07;
	let freq = 2.0 + n * 0.55;
	let ph = hnum(n, salt) * TAU;
	var dStem = 1e9;
	var region = 0.0;
	var t: Tracery;
	t.kind = 1.0;
	for (var i = 0; i < 3; i = i + 1) {
		let fi = f32(i);
		let sway = smoothstep(-1.0, 0.7, v) * (1.0 + fi * 0.35);
		let s = sin(v * freq + ph + fi * 1.9);
		let xs = 0.1 + fi * 0.165 + amp * s * sway;
		let slope = amp * freq * cos(v * freq + ph + fi * 1.9) * sway;
		let d = abs(x - xs) / sqrt(1.0 + slope * slope);
		dStem = min(dStem, d);
		region = region + select(0.0, 1.0, x > xs);
		// Flower head at the top of each stem.
		let vf = 0.6 - fi * 0.27;
		let fc = vec2<f32>(0.1 + fi * 0.165 + amp * sin(vf * freq + ph + fi * 1.9) * smoothstep(-1.0, 0.7, vf) * (1.0 + fi * 0.35), vf);
		let fr = 0.06 + shape.y * 0.06 - fi * 0.008;
		let dF = length(vec2<f32>(x, v) - fc) - fr;
		if (dF < 0.0) {
			t.kind = 3.0;
			t.sd = dF + lead * 0.7;
			return t;
		}
		dStem = min(dStem, dF + lead * 0.3);
	}
	t.sd = lead - dStem;
	let m = region - 4.0 * floor(region / 4.0);
	t.kind = select(select(select(6.0, 2.0, m > 1.5 && m < 2.5), 6.0, m > 0.5 && m < 1.5), 1.0, m < 0.5);
	if (tiers > 0.25) { t.sd = max(t.sd, lead - abs(v + 0.38)); }
	if (tiers > 0.75) { t.sd = max(t.sd, lead - abs(v - 0.2)); }
	return t;
}

// Art deco: a sunburst of rays from the sill crossed by stepped bands, under a
// ziggurat top.
fn trDeco(p: vec2<f32>, n: f32, shape: vec4<f32>, tiers: f32, weight: f32) -> Tracery {
	let rel = vec2<f32>(abs(p.x), p.y + 0.95);
	let rad = length(rel);
	let ang = atan2(rel.x, rel.y);
	let sp = (PI * 0.5) / (n * 0.5 + 0.5);
	let fa = ang / sp;
	let distRay = min(fract(fa), 1.0 - fract(fa)) * sp * rad;
	let m2 = mix(rad, max(rel.x * 1.25, rel.y), 0.45 + tiers * 0.4);
	let bw = 0.3 - shape.x * 0.09;
	let fb = m2 / bw;
	let distBand = min(fract(fb), 1.0 - fract(fb)) * bw;
	let lead = 0.013 + weight * 0.016;
	var t: Tracery;
	t.sd = lead - min(distRay, distBand);
	let band = floor(fb);
	let ray = floor(fa);
	let m = (band + ray) - 3.0 * floor((band + ray) / 3.0);
	t.kind = select(select(6.0, 2.0, m > 0.5 && m < 1.5), 1.0, m < 0.5);
	if (band < 1.0) { t.kind = 3.0; }
	return t;
}

// Modern: large abstract colour fields between heavy flowing leads, with a
// few cut-out leaves floating over them.
fn trModern(p: vec2<f32>, n: f32, shape: vec4<f32>, weight: f32, salt: u32) -> Tracery {
	let off = vec2<f32>(hnum(n, salt) * 17.0, hnum(n + 3.0, salt) * 11.0);
	let w = p * 1.1 + off;
	let f = vnoise(w * 0.9) * 0.65 + vnoise(w * 2.1 + 4.0) * 0.35;
	let levels = 2.4 + n * 0.4;
	let g = f * levels;
	let distIso = min(fract(g), 1.0 - fract(g)) / (levels * 1.5);
	let lead = 0.016 + weight * 0.02;
	var t: Tracery;
	t.sd = lead - distIso;
	let region = floor(g);
	let m = region - 4.0 * floor(region / 4.0);
	t.kind = select(select(select(1.0, 2.0, m > 1.5 && m < 2.5), 6.0, m > 0.5 && m < 1.5), 1.0, m < 0.5);
	for (var i = 0; i < 3; i = i + 1) {
		let fi = f32(i);
		let hc = vec2<f32>(hnum(fi + n * 7.0, salt ^ 0x3c6ef372u), hnum(fi + n * 7.0, salt ^ 0x1b873593u));
		let c = (hc - 0.5) * vec2<f32>(0.8, 1.4);
		let lp = rot2(hc.x * TAU) * (p - c);
		let dLeaf = sdPetal(lp, 0.09 + shape.x * 0.07, 0.2 + shape.y * 0.1);
		if (dLeaf < 0.0) {
			t.kind = 3.0;
			t.sd = dLeaf + lead * 0.6;
			return t;
		}
		t.sd = max(t.sd, lead * 0.6 - dLeaf);
	}
	return t;
}

fn tracery(p: vec2<f32>, s: Sym, n: f32, shape: vec4<f32>, gram: vec4<f32>, salt: u32) -> Tracery {
	let g = gram.x;
	let tiers = gram.z;
	var t: Tracery;
	if (g < 0.5) { t = trGothic(s.q, n, shape, tiers, u.detail.y); }
	else if (g < 1.5) { t = trRayonnant(s.q, n, shape, tiers, u.detail.y); }
	else if (g < 2.5) { t = trFlamboyant(s.q, n, shape, tiers, u.detail.y); }
	else if (g < 3.5) { t = trRomanesque(s.q, n, shape, tiers, u.detail.x); }
	else if (g < 4.5) { t = trGirih(p, s.q, n, shape, tiers, u.detail.x, gram.w); }
	else if (g < 5.5) { t = trNouveau(p, n, shape, tiers, u.detail.x, salt); }
	else if (g < 6.5) { t = trDeco(p, n, shape, tiers, u.detail.x); }
	else { t = trModern(p, n, shape, u.detail.x, salt); }
	// Heavier tracery eats into every opening.
	t.sd = t.sd + u.detail.x * 0.012;
	return t;
}

struct Cell {
	edge: f32,
	id: vec2<f32>,
	center: vec2<f32>,
	birth: f32,
};

// One mosaic seed. xy: position in cell space, z: division progress. Each grid
// cell owns a mother and a daughter; the daughter only exists once the phrase
// growth passes the cell's own threshold, then drifts apart from its mother so
// the cell visibly divides. Positions glide into the next draft at the end of
// every phrase; the CPU owns the draft counter and its eased progress, so a
// phrase-clock jump (a new song, a re-sync) glides instead of re-cutting.
fn mosaicSeed(g: vec2<f32>, which: u32, salt: u32, jitter: f32) -> vec3<f32> {
	let phrase = u32(max(u.organism.y, 0.0));
	let jNow = hcell(g, salt ^ (phrase * 0x9e3779b1u));
	let jNext = hcell(g, salt ^ ((phrase + 1u) * 0x9e3779b1u));
	let redraft = clamp(u.organism.z, 0.0, 1.0);
	let j = mix(jNow, jNext, redraft);
	let base = g + 0.5 + (j - 0.5) * jitter;
	let dv = hcell(g, salt ^ 0x51ed270bu);
	let split = smoothstep(dv.x * 0.8, dv.x * 0.8 + 0.2, u.organism.x);
	let axis = dv.y * TAU + j.x * 1.7;
	let off = vec2<f32>(cos(axis), sin(axis)) * split * 0.21;
	let sgn = select(-1.0, 1.0, which == 1u);
	return vec3<f32>(base + off * sgn, split);
}

fn mosaic(x: vec2<f32>, salt: u32, jitter: f32) -> Cell {
	let g0 = floor(x);
	var pts: array<vec3<f32>, 18>;
	var cellOf: array<vec2<f32>, 18>;
	var best = 1e9;
	var bestI = 0;
	for (var j = 0; j < 9; j = j + 1) {
		let g = g0 + vec2<f32>(f32(j % 3) - 1.0, f32(j / 3) - 1.0);
		for (var w = 0; w < 2; w = w + 1) {
			let i = j * 2 + w;
			let s = mosaicSeed(g, u32(w), salt, jitter);
			pts[i] = s;
			cellOf[i] = g;
			if (w == 1 && s.z < 0.02) { continue; }
			let dv = s.xy - x;
			let d = dot(dv, dv);
			if (d < best) {
				best = d;
				bestI = i;
			}
		}
	}

	let a = pts[bestI].xy;
	var edge = 1e9;
	var birth = 0.0;
	for (var i = 0; i < 18; i = i + 1) {
		if (i == bestI) { continue; }
		let s = pts[i];
		if ((i % 2) == 1 && s.z < 0.02) { continue; }
		let dv = s.xy - a;
		let len = length(dv);
		if (len < 1e-4) { continue; }
		var e = dot((a + s.xy) * 0.5 - x, dv / len);
		if ((i / 2) == (bestI / 2)) {
			// Sister membrane: thin and luminous while it forms.
			let sp = s.z;
			birth = max(birth, sp * (1.0 - sp) * 4.0 * exp(-e * 22.0));
			e = e / max(sp, 0.05);
		}
		edge = min(edge, e);
	}

	let owner = cellOf[bestI];
	let idSalt = salt ^ 0x2c1b3c6du;
	let motherId = hcell(owner, idSalt);
	var id = motherId;
	if ((bestI % 2) == 1) {
		id = mix(motherId, hcell(owner + vec2<f32>(517.0, 211.0), idSalt), pts[bestI].z);
	}
	var c: Cell;
	c.edge = edge;
	c.id = id;
	c.center = a;
	c.birth = birth;
	return c;
}

// Mosaic cuts: organic Voronoi, diamond quarries, concentric segments, long
// radial slivers, and broad opalescent slabs. Domain maps window space into
// cell space; inverse brings a cell centre back for the beat packets.
fn mosaicDomain(q: vec2<f32>, style: f32, cs: f32) -> vec2<f32> {
	if (style < 0.5) { return q * cs; }
	if (style < 1.5) { return rot2(0.785398) * q * (cs * 0.75); }
	if (style < 2.5) {
		let r = length(q);
		return vec2<f32>(r * cs * 0.85, atan2(q.y, q.x) * max(r, 0.2) * cs * 0.85);
	}
	if (style < 3.5) { return vec2<f32>(q.x * cs * 0.45, q.y * cs * 1.5); }
	return q * (cs * 0.5);
}

fn mosaicInverse(c: vec2<f32>, style: f32, cs: f32) -> vec2<f32> {
	if (style < 0.5) { return c / cs; }
	if (style < 1.5) { return rot2(-0.785398) * c / (cs * 0.75); }
	if (style < 2.5) {
		let r = c.x / (cs * 0.85);
		let a = c.y / (max(r, 0.2) * cs * 0.85);
		return vec2<f32>(cos(a), sin(a)) * r;
	}
	if (style < 3.5) { return vec2<f32>(c.x / (cs * 0.45), c.y / (cs * 1.5)); }
	return c / (cs * 0.5);
}

fn mosaicJitter(style: f32) -> f32 {
	if (style < 0.5) { return 0.62; }
	if (style < 1.5) { return 0.07; }
	if (style < 2.5) { return 0.32; }
	if (style < 3.5) { return 0.55; }
	return 0.7;
}

fn wrapAngle(a: f32) -> f32 {
	return a - TAU * floor(a / TAU + 0.5);
}

// Light that the window lets through: one to three suns drifting behind the
// glass and clouds passing across it, so a symmetric window is never lit
// symmetrically.
fn backlight(rel: vec2<f32>) -> f32 {
	let d = rel - u.sun.xy;
	var hot = exp(-dot(d, d) * 9.0);
	let count = u.atmos.w;
	let d2 = rel - vec2<f32>(-u.sun.x * 0.8 - 0.12, u.sun.y * 0.4 - 0.1);
	hot = hot + exp(-dot(d2, d2) * 14.0) * smoothstep(0.34, 0.6, count) * 0.7;
	let d3 = rel - vec2<f32>(u.sun.y * 0.6 + 0.14, -u.sun.x * 0.5 + 0.12);
	hot = hot + exp(-dot(d3, d3) * 18.0) * smoothstep(0.67, 0.9, count) * 0.55;
	let drift = vec2<f32>(u.time * 0.031, -u.time * 0.019) + vec2<f32>(u.organism.w * 0.0007, 0.0);
	let cloud = 0.62 + 0.62 * vnoise(rel * 3.1 + drift) * (0.6 + 0.4 * vnoise(rel * 7.3 - drift * 1.7));
	return u.light.x * (0.42 + hot * u.sun.z) * cloud;
}

// Beat light travelling through the window in one of six forms. Glass forms
// read a cell's centre so light jumps piece to piece; lightning runs along the
// lead itself. Returns (glass, came).
fn packetForm(form: f32, cellRn: f32, cellAngle: f32, n: f32, cellHash: f32, pixRn: f32, pixAngle: f32) -> vec2<f32> {
	let age = clamp(u.light.z, 0.0, 1.0);
	let front = 0.1 + age * 1.15;
	let ring = exp(-pow((cellRn - front) * 6.5, 2.0));
	let seg = TAU / n;
	let beat = u.light.w;
	if (form < 0.5) {
		return vec2<f32>(ring, 0.0);
	}
	if (form < 1.5) {
		let sweep = (beat + age) * seg;
		let angDist = abs(wrapAngle(cellAngle - sweep));
		return vec2<f32>(exp(-pow(angDist / (seg * 0.55), 2.0)) * exp(-pow((cellRn - (0.14 + age * 0.86)) * 3.4, 2.0)) * 1.2, 0.0);
	}
	if (form < 2.5) {
		let chosen = floor(hnum(beat, seedSalt() ^ 0x7a3du) * n);
		let halfN = floor(n * 0.5);
		let opposite = chosen + halfN - n * floor((chosen + halfN) / n);
		let wa = cellAngle - TAU * floor(cellAngle / TAU);
		let wraw = floor(wa / seg + 0.5);
		let wedge = wraw - n * floor(wraw / n);
		let petalOn = select(0.0, 1.0, abs(wedge - chosen) < 0.5 || abs(wedge - opposite) < 0.5);
		return vec2<f32>(petalOn * (ring * 0.7 + 0.3 * smoothstep(front + 0.2, front - 0.2, cellRn)), 0.0);
	}
	if (form < 3.5) {
		let phase = hnum(beat, seedSalt() ^ 0x51u) * TAU;
		let arm = abs(wrapAngle(cellAngle * 2.0 - cellRn * 7.0 + age * 4.5 + phase)) * 0.5;
		return vec2<f32>(exp(-pow(arm / 0.3, 2.0)) * exp(-pow((cellRn - 0.1 - age * 0.9) * 2.2, 2.0)) * 1.2, 0.0);
	}
	if (form < 4.5) {
		let oa = hnum(beat, seedSalt() ^ 0x9du) * TAU;
		let origin = vec2<f32>(cos(oa), sin(oa)) * (0.25 + 0.4 * hnum(beat, seedSalt() ^ 0x3fu));
		let cp = vec2<f32>(cos(cellAngle), sin(cellAngle)) * cellRn;
		let at = length(cp - origin) * 0.55 + cellHash * 0.3;
		return vec2<f32>(exp(-pow((age - at) * 8.0, 2.0)) * 1.3, 0.0);
	}
	let boltA = hnum(beat, seedSalt() ^ 0xb017u) * TAU;
	let wander = (vnoise(vec2<f32>(pixRn * 5.0, beat * 3.1)) - 0.5) * 0.9;
	let off = abs(wrapAngle(pixAngle - boltA - wander)) * max(pixRn, 0.05);
	let reach = smoothstep(front + 0.05, front - 0.15, pixRn);
	return vec2<f32>(ring * 0.3, exp(-pow(off * 26.0, 2.0)) * reach);
}

// Rain on the glass: drops sliding down, each a small lens with a bright rim.
// Returns lens offset xy and coverage.
fn rainOnGlass(pn: vec2<f32>) -> vec3<f32> {
	let g = vec2<f32>(pn.x * 7.0, pn.y * 3.5);
	let id = floor(g);
	let h = hcell(id, 211u);
	let f = fract(g) - vec2<f32>(0.5);
	let slide = fract(u.time * (0.12 + h.y * 0.2) + h.x);
	let c = vec2<f32>((h.x - 0.5) * 0.6, 0.42 - slide * 0.84);
	let d = vec2<f32>(f.x - c.x, (f.y - c.y) * 0.62);
	let r = 0.07 + h.y * 0.06;
	let inside = smoothstep(r, r * 0.55, length(d));
	let present = step(0.42, h.y);
	let trail = smoothstep(0.025, 0.0, abs(f.x - c.x)) * step(c.y, f.y) * (1.0 - smoothstep(c.y, c.y + 0.45, f.y)) * 0.35;
	return vec3<f32>(d / r * inside * 0.035 * present, (inside + trail) * present);
}

fn stoneTint() -> vec3<f32> {
	return vec3<f32>(0.11, 0.1, 0.12);
}

// ── Environments around the window ──────────────────────────────────────────
struct WallIn {
	P: vec2<f32>,
	wl: vec2<f32>,
	od: f32,
	n: f32,
	back: f32,
	lx: f32,
	spacing: f32,
	rd: vec3<f32>,
	seam: f32,
};

fn archOrders(wl: vec2<f32>) -> vec2<f32> {
	let springY = -0.1;
	let halfSpan = 0.5;
	let archR = 0.78;
	let offset = archR - halfSpan;
	var archD = abs(wl.x) - halfSpan;
	if (wl.y > springY) {
		archD = length(vec2<f32>(abs(wl.x) + offset, wl.y - springY)) - archR;
	}
	let orders = exp(-pow(archD * 260.0, 2.0)) * 1.0
		+ exp(-pow((archD + 0.024) * 300.0, 2.0)) * 0.7
		+ exp(-pow((archD + 0.052) * 300.0, 2.0)) * 0.45
		+ exp(-pow((archD - 0.03) * 300.0, 2.0)) * 0.35;
	return vec2<f32>(orders, smoothstep(0.01, -0.02, archD));
}

fn masonry(P: vec2<f32>) -> f32 {
	let course = abs(fract(P.y / 0.052) - 0.5);
	let stagger = select(0.0, 0.5, fract(floor(P.y / 0.052) * 0.5) > 0.25);
	let headJoint = abs(fract(P.x / 0.11 + stagger) - 0.5);
	return 1.0 - 0.45 * (exp(-pow((0.5 - course) * 140.0, 2.0)) + exp(-pow((0.5 - headJoint) * 90.0, 2.0)));
}

// Clustered pier shafts between bays.
fn piers(lx: f32, spacing: f32) -> f32 {
	let e = abs(abs(lx) - spacing * 0.5);
	return exp(-pow(e * 140.0, 2.0)) + 0.6 * exp(-pow((e - 0.022) * 180.0, 2.0)) + 0.6 * exp(-pow((e + 0.022) * 180.0, 2.0));
}

// Cathedral nave: ashlar, a moulded ring with radiating voussoirs, a pointed
// archivolt whose jambs run down to the floor, clustered piers between bays.
fn wallNave(w: WallIn) -> vec3<f32> {
	let hero = u.heroCol.rgb;
	let support = u.supportCol.rgb;
	let accent = u.accentCol.rgb;
	let spillW = w.back * exp(-max(w.od, 0.0) * 2.1);
	let rnW = length(w.wl) / ROSE_R;
	let a = atan2(w.wl.y, w.wl.x);
	let segs = w.n * 2.0;
	let joint = abs(fract(a / TAU * segs) - 0.5);
	let jointLine = exp(-pow((0.5 - joint) * rnW * TAU / segs * 80.0, 2.0));
	let ringBand = smoothstep(0.06, 0.08, w.od) * smoothstep(0.42, 0.38, w.od);
	let moulding = exp(-pow((w.od - 0.012) * 110.0, 2.0)) * 1.2
		+ exp(-pow((w.od - 0.055) * 140.0, 2.0)) * 0.6
		+ exp(-pow((w.od - 0.41) * 160.0, 2.0)) * 0.35;
	let ao = archOrders(w.wl);
	let roomLight = w.back * exp(-length(w.wl) * 1.7) * (0.6 + 0.4 * u.sun.w);
	let warmStone = mix(stoneTint(), accent, 0.25);
	var col = warmStone * (0.045 + roomLight * 1.25 * (0.55 + ao.y * 0.6)) * masonry(w.P)
		+ mix(hero, accent, 0.5) * moulding * spillW * 0.22
		+ warmStone * ringBand * spillW * (0.07 - jointLine * 0.06)
		+ mix(accent, support, 0.4) * ao.x * (0.035 + roomLight * 0.5)
		+ mix(accent, support, 0.5) * piers(w.lx, w.spacing) * (0.012 + roomLight * 0.25);
	col = max(col, vec3<f32>(0.0));
	return col + accent * w.seam * (moulding + ao.x * 0.5 + ringBand * 0.3) * (0.05 + spillW * 0.25);
}

// Crypt: rubble stone under a low vault, lit by two candles near the floor.
fn wallCrypt(w: WallIn) -> vec3<f32> {
	let accent = u.accentCol.rgb;
	let g = w.P * vec2<f32>(10.0, 13.0);
	let g0 = floor(g);
	var d1 = 9.0;
	var d2 = 9.0;
	var tone = 0.0;
	for (var j = 0; j < 9; j = j + 1) {
		let c = g0 + vec2<f32>(f32(j % 3) - 1.0, f32(j / 3) - 1.0);
		let h = hcell(c, 0x5bd1u);
		let d = length(g - c - 0.5 - (h - 0.5) * 0.7);
		if (d < d1) { d2 = d1; d1 = d; tone = h.x; } else if (d < d2) { d2 = d; }
	}
	let mortar = smoothstep(0.02, 0.12, d2 - d1);
	let candle = vec3<f32>(1.0, 0.52, 0.18);
	var lightSum = 0.0;
	var flames = 0.0;
	for (var i = 0; i < 2; i = i + 1) {
		let side = select(-1.0, 1.0, i == 1);
		let cp = vec2<f32>(w.P.x - w.lx + side * 0.43, FLOOR_Y + 0.075);
		let flick = 0.82 + 0.18 * vnoise(vec2<f32>(u.time * 7.0, f32(i) * 13.0));
		let dd = w.P - cp;
		lightSum = lightSum + exp(-dot(dd, dd) * 14.0) * flick;
		flames = flames + exp(-(pow(dd.x * 120.0, 2.0) + pow((dd.y - 0.012) * 50.0, 2.0))) * flick;
	}
	let vault = 1.0 - smoothstep(0.3, 0.62, w.P.y);
	let ring = exp(-pow((w.od - 0.03) * 70.0, 2.0)) * 0.6;
	let spill = w.back * exp(-max(w.od, 0.0) * 3.0);
	let stone = mix(stoneTint(), candle * 0.3, 0.35) * (0.5 + tone * 0.5) * mortar;
	return stone * (0.035 + lightSum * 0.45 * vault + spill * 0.75)
		+ mix(accent, u.heroCol.rgb, 0.4) * ring * spill * 0.25
		+ candle * flames * 1.0
		+ accent * w.seam * ring * 0.2;
}

// Night sky through a broken wall: stars, moonlit cloud, a cold gradient.
fn nightSky(rd: vec3<f32>) -> vec3<f32> {
	let sp = rd.xy / max(rd.z, 0.05);
	let moonCol = mix(vec3<f32>(0.5, 0.6, 0.9), u.sky.rgb, 0.4);
	let grad = mix(u.fieldCol.rgb * 0.08, moonCol * 0.035, smoothstep(0.0, 0.8, sp.y));
	let sc = floor(sp * 110.0);
	let sh = hcell(sc, 0x51a7u);
	let tw = 0.6 + 0.4 * sin(u.time * (1.0 + sh.y * 3.0) + sh.x * 30.0);
	let star = step(0.988, sh.x) * smoothstep(0.35, 0.0, length(fract(sp * 110.0) - 0.5)) * tw;
	let cloud = smoothstep(0.45, 0.85, vnoise(sp * 2.2 + vec2<f32>(u.time * 0.012, 0.0)) * 0.7 + vnoise(sp * 5.0) * 0.3);
	let md = sp - vec2<f32>(0.75, 0.55);
	let moon = exp(-dot(md, md) * 30.0) * 0.08 + smoothstep(0.06, 0.05, length(md)) * 0.5;
	return grad * (1.0 - cloud * 0.6) + moonCol * (star * 0.5 + moon) + moonCol * cloud * 0.02;
}

// Ruined chapel: the nave wall broken off above the window, open to the sky.
fn wallRuin(w: WallIn) -> vec3<f32> {
	let breakY = 0.46 + 0.1 * vnoise(vec2<f32>(w.P.x * 3.0, 1.0)) + 0.05 * vnoise(vec2<f32>(w.P.x * 11.0, 2.0)) + abs(w.lx) * 0.12;
	if (w.P.y > breakY) {
		return nightSky(w.rd);
	}
	let moonCol = mix(vec3<f32>(0.5, 0.6, 0.9), u.sky.rgb, 0.4);
	let edge = exp(-pow((w.P.y - breakY) * 70.0, 2.0)) * 0.05;
	return wallNave(w) * 0.85 + moonCol * edge * masonry(w.P);
}

// Candle-lit apse: dark marble panels curving round, gilt frieze, a row of
// candles along the floor.
fn wallApse(w: WallIn) -> vec3<f32> {
	let accent = u.accentCol.rgb;
	let candle = vec3<f32>(1.0, 0.56, 0.2);
	let pf = fract(w.P.x / 0.21 + 0.5);
	let shade = 0.5 + 0.5 * cos((pf - 0.5) * 2.6);
	let seamLine = exp(-pow((min(pf, 1.0 - pf)) * 70.0, 2.0));
	let vw = w.P * vec2<f32>(3.0, 7.0);
	let vein = exp(-pow(vnoise(vw + vnoise(w.P * 9.0) * 1.6) - 0.5, 2.0) * 700.0);
	let cell = floor(w.P.x / 0.085);
	let cx = (cell + 0.5) * 0.085;
	let ch = hcell(vec2<f32>(cell, 3.0), 0xca4du);
	let cy = FLOOR_Y + 0.045 + ch.x * 0.06;
	let flick = 0.78 + 0.22 * vnoise(vec2<f32>(u.time * 8.0, cell));
	let dd = w.P - vec2<f32>(cx, cy);
	let lit = step(0.62, ch.y) * step(abs(w.lx), 0.5);
	let flame = exp(-(pow(dd.x * 130.0, 2.0) + pow((dd.y - 0.01) * 52.0, 2.0))) * flick * lit * (0.6 + 0.4 * ch.x);
	let warm = (0.06 + 0.5 * exp(-(w.P.y - FLOOR_Y) * 5.0)) * (0.8 + 0.2 * flick);
	let frieze = smoothstep(0.012, 0.0, abs(w.P.y - 0.52)) * step(0.4, hcell(floor(w.P * 140.0), 0x7e55u).x);
	let spill = w.back * exp(-max(w.od, 0.0) * 2.0);
	let marble = mix(stoneTint() * 0.8, u.fieldCol.rgb * 0.6, 0.3);
	let ring = exp(-pow((w.od - 0.02) * 90.0, 2.0)) + exp(-pow((w.od - 0.07) * 120.0, 2.0)) * 0.5;
	return marble * shade * (warm * candle * 0.5 + spill * 0.9 + 0.02) * (1.0 - seamLine * 0.5)
		+ marble * vein * (0.02 + spill * 0.2)
		+ accent * frieze * (0.05 + spill * 0.6)
		+ mix(accent, u.heroCol.rgb, 0.5) * ring * spill * 0.2
		+ candle * flame * 0.85
		+ accent * w.seam * ring * 0.15;
}

// Void: no building at all, the window floats in darkness among drifting
// shards of glass on two depth planes behind it.
fn shardLayer(ro: vec3<f32>, rd: vec3<f32>, z: f32, scale: f32, salt: u32) -> vec3<f32> {
	let t = (z - ro.z) / max(rd.z, 1e-3);
	let P = (ro + rd * t).xy;
	let g = P * scale + vec2<f32>(u.time * 0.02, u.time * 0.013);
	let cid = floor(g);
	let h = hcell(cid, salt);
	let local = rot2(u.time * (h.y - 0.5) * 0.4 + h.x * 6.0) * (fract(g) - 0.5 - (h - 0.5) * 0.35);
	let sd = sdBox(local, vec2<f32>(0.07 + 0.08 * h.y, 0.025 + 0.05 * h.x));
	let present = step(0.7, h.x);
	let col = select(select(u.accentCol.rgb, u.supportCol.rgb, h.y > 0.4), u.heroCol.rgb, h.y > 0.72);
	let glow = smoothstep(0.012, -0.012, sd) * (0.6 + 0.4 * sin(u.time * 0.7 + h.x * 20.0));
	let rimL = exp(-pow(sd * 160.0, 2.0)) * 0.6;
	return col * (glow + rimL) * present;
}

fn wallVoid(w: WallIn) -> vec3<f32> {
	let ro = u.camPos.xyz;
	let pulse = 0.12 + u.light.x * 0.5 + u.light.y * 0.25 * pow(1.0 - clamp(u.light.z, 0.0, 1.0), 2.0);
	let near = shardLayer(ro, w.rd, 0.35, 5.0, 0x77u);
	let far = shardLayer(ro, w.rd, 1.1, 3.0, 0x99u) * 0.45;
	let halo = mix(u.heroCol.rgb, u.accentCol.rgb, 0.4) * w.back * exp(-max(w.od, 0.0) * 4.0) * 0.06;
	return (near + far) * pulse * 0.5 + halo + u.fieldCol.rgb * 0.01;
}

fn wallFor(e: f32, w: WallIn) -> vec3<f32> {
	if (e < 0.5) { return wallNave(w); }
	if (e < 1.5) { return wallCrypt(w); }
	if (e < 2.5) { return wallRuin(w); }
	if (e < 3.5) { return wallApse(w); }
	return wallVoid(w);
}

// Where one composition is evaluated: the pixel's ray and its landing points
// on the wall, the carved stone and the recessed glass of its bay.
struct PaneIn {
	rd: vec3<f32>,
	wall: vec3<f32>,
	wallRel: vec2<f32>,
	stoneRel: vec2<f32>,
	glassRel: vec2<f32>,
	lx: f32,
	bay: f32,
	spacing: f32,
	footprint: f32,
	back: f32,
	lit: f32,
};

// One complete window (glass, tracery, the wall around it) for one
// composition. xyz: colour, w: the dissolve key of what this pixel shows (one
// value per glass piece, so a morph re-sets the window piece by piece).
fn windowPane(pi: PaneIn, n: f32, shape: vec4<f32>, gram: vec4<f32>, baseSalt: u32) -> vec4<f32> {
	let grammar = gram.x;
	let radial = grammar < 4.5;
	let salt = baseSalt ^ select(0u, pmix(u32(i32(pi.bay) + 4096)), abs(pi.bay) > 0.5);
	// Only round roses turn; arched outlines stay upright.
	let round = radial && !(grammar > 3.5 && gram.w > 0.5);
	let rot = select(0.0, u.env.w + pi.bay * 0.37, round);
	let stoneP = rot2(rot) * pi.stoneRel / ROSE_R;
	var glassP = rot2(rot) * pi.glassRel / ROSE_R;
	let back = pi.back;
	let lit = pi.lit;
	let footprint = pi.footprint;
	let rd = pi.rd;
	let glassRel = pi.glassRel;
	let hero = u.heroCol.rgb;
	let support = u.supportCol.rgb;
	let accent = u.accentCol.rgb;
	let field = u.fieldCol.rgb;
	let lightCol = u.sky.rgb;
	let lead = vec3<f32>(0.004, 0.0035, 0.005);
	let od = outlineSd(stoneP, grammar, gram.w);
	// Stone and wall dissolve in soft blotches; glass pieces override below.
	var key = vnoise(pi.wallRel / ROSE_R * 5.0 + vec2<f32>(f32(baseSalt & 255u) * 0.37, 0.0));

	var col = vec3<f32>(0.0);

	if (od < 0.0) {
		let fs = symmetry(stoneP, n, grammar);
		let ts = tracery(stoneP, fs, n, shape, gram, salt);

		// Carved stone: near black, catching coloured spill on its bevels.
		let spill = exp(-max(ts.sd, 0.0) * 22.0) * back;
		let bevel = exp(-pow((ts.sd - 0.016) * 150.0, 2.0));
		let ridge = exp(-pow(ts.sd * 260.0, 2.0));
		let frame = exp(-pow((od + 0.02) * 120.0, 2.0));
		col = stoneTint() * (0.05 + back * 0.12)
			+ mix(hero, accent, 0.35) * spill * 0.12
			+ accent * (bevel * 0.14 + frame * 0.08) * back
			+ support * ridge * back * 0.05;

		let inner = od < -0.012;
		if (ts.sd < 0.006 && inner) {
			let rain = u.world.w;
			var drop = vec3<f32>(0.0);
			if (rain > 0.02) {
				drop = rainOnGlass(glassRel / ROSE_R);
				glassP = glassP + drop.xy * rain;
			}
			let fg = symmetry(glassP, n, grammar);
			let cellScale = shape.z;
			let style = gram.y;
			let cell = mosaic(mosaicDomain(fg.q, style, cellScale), salt, mosaicJitter(style));
			let kind = ts.kind;

			var c1 = hero;
			var c2 = support;
			var c3 = accent;
			var tierLit = 1.0;
			if (kind == 2.0) {
				c1 = support; c2 = hero; c3 = field * 1.8;
				tierLit = mix(0.2, 0.62, shape.w);
			} else if (kind == 3.0) {
				c1 = accent; c2 = hero; c3 = support;
				tierLit = mix(0.45, 1.0, shape.w);
			} else if (kind == 4.0) {
				c1 = accent; c2 = support; c3 = hero;
				tierLit = mix(0.15, 0.45, shape.w);
			} else if (kind == 5.0) {
				c1 = field; c2 = support; c3 = accent;
				tierLit = 0.18;
			} else if (kind == 6.0) {
				c1 = field * 1.9 + support * 0.35; c2 = support; c3 = accent;
				tierLit = mix(0.45, 0.9, shape.w);
			}
			// Mosaic: mostly the role colour in varied density, with sparse pieces of
			// the neighbouring roles and the odd deep variant of the main one.
			let sprinkle = u.detail.z;
			var glass = c1 * mix(1.0, 0.55, smoothstep(0.32, 0.36, cell.id.x) * (1.0 - smoothstep(0.44, 0.48, cell.id.x)));
			let t2 = mix(0.86, 0.66, sprinkle);
			let t3 = mix(0.975, 0.9, sprinkle);
			glass = mix(glass, c2 * 0.75, smoothstep(t2, t2 + 0.04, cell.id.x));
			glass = mix(glass, c3, smoothstep(t3, t3 + 0.03, cell.id.x));
			glass = glass * lightCol;

			let slab = select(1.0, 2.2, gram.y > 3.5);
			let density = 0.3 + 0.95 * cell.id.y * cell.id.y;
			let interior = mix(0.75, smoothstep(0.0, 0.42, cell.edge), 1.0 - smoothstep(0.18, 0.5, footprint * cellScale));
			let grainDir = vec2<f32>(cos(cell.id.y * 9.0), sin(cell.id.y * 9.0));
			let mx = mosaicDomain(fg.q, style, cellScale);
			let streak = 1.0 - 0.12 * slab + 0.12 * slab * sin(dot(mx, grainDir) * 17.0 / slab + cell.id.x * 40.0);
			let cq = mosaicInverse(cell.center, style, cellScale);
			let cellRn = length(cq);
			var cellAngle = atan2(cq.y, cq.x);
			if (radial) {
				cellAngle = (fs.wedge * TAU / n) + fs.side * atan2(cq.y, cq.x);
			} else if (grammar < 6.5) {
				cellAngle = atan2(cq.x * fs.side, cq.y);
			}
			let pixRn = length(glassP);
			let pixAngle = atan2(glassP.y, glassP.x);
			let spectral = bins[clamp(i32(cellRn * 46.0), 0, ${PRISM_BIN_COUNT - 1})];

			let transmitted = back * density * tierLit * (0.5 + 0.5 * interior) * streak * (0.82 + spectral * 0.45);
			let nForm = select(8.0, n, radial);
			var pkv = packetForm(u.modes.y, cellRn, cellAngle, nForm, cell.id.x, pixRn, pixAngle);
			if (u.modes.z < 0.995) {
				pkv = mix(packetForm(u.modes.x, cellRn, cellAngle, nForm, cell.id.x, pixRn, pixAngle), pkv, u.modes.z);
			}
			let tail = pow(1.0 - clamp(u.light.z, 0.0, 1.0), 1.3) * u.light.y * lit;
			let pk = pkv.x * tail * (0.35 + 0.65 * tierLit);
			var g = glass * (transmitted + pk * 2.4) * 3.0
				+ mix(glass, accent, 0.5) * cell.birth * (0.5 + back * 1.4);

			// Ruins have lost pieces: the night shows through.
			let ruinW = envWeight(2.0);
			if (ruinW > 0.01 && cell.id.y < 0.07 * ruinW) {
				g = nightSky(rd) * 1.5;
			}
			// Raindrops: small lenses with a bright rim.
			g = g + mix(accent, lightCol, 0.6) * drop.z * rain * back * 0.18;

			// Lead came between pieces and around every opening; lightning beats
			// run along it.
			let cellsPerPixel = footprint * cellScale;
			let detail = 1.0 - smoothstep(0.18, 0.5, cellsPerPixel);
			let aa = cellsPerPixel * 0.6;
			let came = (1.0 - smoothstep(0.075 - aa, 0.15 + aa, cell.edge)) * mix(0.35, 1.0, detail);
			let leadGlint = accent * back * 0.03 * exp(-pow((cell.edge - 0.02) * 60.0, 2.0));
			let bolt = mix(accent, vec3<f32>(1.0), 0.35) * pkv.y * tail * 2.2;
			g = mix(g, lead + leadGlint + bolt, came);
			let rimLead = smoothstep(-0.026, -0.01, ts.sd);
			g = mix(g, lead + bolt * 0.5, rimLead);
			if (kind == 5.0) {
				// Polished obsidian boss: it only mirrors the window, a dim sheen
				// that leans toward the sun and a fine bright edge.
				let sheenDir = normalize(u.sun.xy - glassRel + vec2<f32>(1e-4, 0.0));
				let sheen = pow(max(dot(normalize(glassP + vec2<f32>(1e-4, 0.0)), rot2(rot) * sheenDir), 0.0), 3.0);
				g = g * 0.6 + mix(support, accent, 0.5) * (sheen * length(glassP) * 0.5 + exp(-pow((ts.sd + 0.03) * 90.0, 2.0)) * 0.25) * back;
			}
			let opening = smoothstep(0.006, -0.002, ts.sd) * smoothstep(-0.012, -0.024, od);
			col = mix(col, g, opening);
			// Each glass piece is re-set as one: its key is the piece's own
			// (decorrelated from the hash that picks its colour).
			key = mix(key, fract(cell.id.x * 7.31 + cell.id.y * 3.17), opening);
		}
	} else {
		var w: WallIn;
		w.P = pi.wall.xy;
		w.wl = pi.wallRel;
		w.od = od;
		w.n = n;
		w.back = back;
		w.lx = pi.lx;
		w.spacing = pi.spacing;
		w.rd = rd;
		w.seam = 0.0;
		let envMix = u.world.z;
		if (envMix > 0.995 || abs(u.world.x - u.world.y) < 0.5) {
			col = wallFor(u.world.y, w);
		} else if (envMix < 0.005) {
			col = wallFor(u.world.x, w);
		} else {
			col = mix(wallFor(u.world.x, w), wallFor(u.world.y, w), envMix);
		}
	}
	return vec4<f32>(col, key);
}

// Morph weights, mirrored by prismMorphWeight in continuity.ts.
const MORPH_BAND: f32 = 0.5;
const MORPH_SPREAD: f32 = 1.2;

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let p = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / res.y;
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	// The floor and everything below it belong to the presentation pass.
	if (rd.z <= 1e-3) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}
	let tWall = -ro.z / rd.z;
	let wall = ro + rd * tWall;
	// Pixel footprint on the wall in window radii: distant and grazing windows
	// fold their mosaic detail away instead of shimmering.
	let footprint = tWall / (u.camPos.w * res.y * max(rd.z, 0.2) * ROSE_R);
	if (wall.y < FLOOR_Y) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}

	// Three planes: glass recessed deepest, carved tracery in front of it, the
	// wall surface in front of both, so the camera reveals the window's depth.
	let stoneW = (ro + rd * ((STONE_Z - ro.z) / rd.z)).xy;
	let glassW = (ro + rd * ((GLASS_Z - ro.z) / rd.z)).xy;
	let spacing = u.camRight.w;
	let bay = floor(wall.x / spacing + 0.5);
	let center = vec2<f32>(bay * spacing, ROSE_Y);
	var pi: PaneIn;
	pi.rd = rd;
	pi.wall = wall;
	pi.wallRel = wall.xy - center;
	pi.stoneRel = stoneW - center;
	pi.glassRel = glassW - center;
	pi.lx = wall.x - center.x;
	pi.bay = bay;
	pi.spacing = spacing;
	pi.footprint = footprint;
	// Neighbouring bays light up as the camera reveals them; unlit ones hang
	// as dark tracery silhouettes.
	let bayLit = clamp(u.detail.w - abs(bay) + 1.0, 0.0, 1.0);
	pi.lit = mix(0.06, 1.0, bayLit);
	pi.back = backlight(pi.glassRel) * pi.lit;
	let rnW = length(pi.wallRel) / ROSE_R;

	// Structure morph: composition B re-sets the window piece by piece as a
	// front washes outward (each piece on its own staggered threshold, lit as
	// it is set), then a global fade finishes whatever lies beyond the front.
	// Outside a morph both compositions are the same and only B is drawn.
	let front = u.comp.z;
	let finish = clamp(u.morph.z, 0.0, 1.0);
	let reach = (front - rnW) / MORPH_BAND - MORPH_SPREAD * 0.5;
	var col: vec3<f32>;
	if (finish >= 0.999 || reach - MORPH_SPREAD * 0.5 >= 1.0) {
		col = windowPane(pi, u.comp.y, u.shapeB, u.gramB, u32(max(u.morph.y, 0.0))).rgb;
	} else if (reach + MORPH_SPREAD * 0.5 <= 0.0 && finish <= 0.001) {
		col = windowPane(pi, u.comp.x, u.shapeA, u.gramA, u32(max(u.morph.x, 0.0))).rgb;
	} else {
		let paneB = windowPane(pi, u.comp.y, u.shapeB, u.gramB, u32(max(u.morph.y, 0.0)));
		let spatial = smoothstep(0.0, 1.0, reach + (paneB.w - 0.5) * MORPH_SPREAD);
		let wB = max(spatial, finish);
		var mixed = paneB.rgb;
		if (wB < 0.999) {
			let paneA = windowPane(pi, u.comp.x, u.shapeA, u.gramA, u32(max(u.morph.x, 0.0)));
			mixed = mix(paneA.rgb, paneB.rgb, wB);
		}
		// Light leads the reveal: a piece glows while it is being set.
		let seam = u.comp.w * 4.0 * spatial * (1.0 - spatial);
		col = mixed + paneB.rgb * seam * 1.1;
	}

	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Legacy lab scenes. Production Prism always renders the rose; the lab can
// still force these through the preset keys for comparison.
// ---------------------------------------------------------------------------
export const PRISM_CATHEDRAL_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash13(p: vec3<f32>) -> f32 {
	var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
	q = q + dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}

fn columnsDE(p: vec3<f32>, period: f32, radiusBase: f32, seed: f32) -> f32 {
	let seedOffset = vec2<f32>(seed * 50.0, seed * 73.0);
	let shifted = p.xz + seedOffset;
	let cellXZ = round(shifted / period) * period;
	let local = shifted - cellXZ;
	let h = hash13(vec3<f32>(cellXZ.x, seed * 100.0, cellXZ.y));
	let radius = radiusBase + h * 0.06;
	return length(local) - radius;
}

fn poi(idx: i32, seed: f32) -> vec3<f32> {
	let fi = f32(idx);
	let h1 = hash13(vec3<f32>(fi * 17.3, seed * 137.1, fi * 31.7));
	let h2 = hash13(vec3<f32>(fi * 47.1, seed * 217.5, fi * 13.9));
	let h3 = hash13(vec3<f32>(fi * 23.7, seed * 311.7, fi * 71.3));
	let theta = h1 * 6.28318;
	let r = 1.5 + h2 * 3.0;
	let yOff = (h3 - 0.5) * 1.8;
	return vec3<f32>(cos(theta) * r, yOff, sin(theta) * r);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;
	let t = u.time;
	let POI_DURATION = 13.0;
	let POI_COUNT = 4;
	let seededT = t + u.songSeed * 47.0;
	let cycleT = seededT / POI_DURATION;
	let idxF = floor(cycleT);
	let phase = cycleT - idxF;
	let idxA = i32(idxF) - i32(idxF / f32(POI_COUNT)) * POI_COUNT;
	let idxB = (idxA + 1) - ((idxA + 1) / POI_COUNT) * POI_COUNT;
	let poiA = poi(idxA, u.songSeed);
	let poiB = poi(idxB, u.songSeed);
	let handoff = smoothstep(0.65, 1.0, phase);
	let activePOI = mix(poiA, poiB, handoff);
	let speedDrift = snoise(t * 0.025 + u.songSeed * 73.0);
	let baseSpeed = 0.04 + u.bass * 0.10 + u.bpmNorm * 0.06 + speedDrift * 0.03;
	let driftZ = seededT * baseSpeed;
	let radiusDrift = snoise(t * 0.03 + u.songSeed * 29.0);
	let speedDrift2 = snoise(t * 0.04 + u.songSeed * 53.0);
	let orbitRadius = 2.3 + u.mid * 0.4 + radiusDrift * 0.6;
	let orbitSpeed = 0.12 + u.mid * 0.14 + u.bpmNorm * 0.08 + speedDrift2 * 0.15;
	let orbitAngle = seededT * orbitSpeed;
	let orbitOffset = vec3<f32>(
		cos(orbitAngle) * orbitRadius,
		sin(orbitAngle * 0.43) * orbitRadius * 0.35,
		sin(orbitAngle) * orbitRadius
	);
	let camPos = activePOI + orbitOffset + vec3<f32>(0.0, 0.0, driftZ);
	let lookTarget = activePOI + vec3<f32>(0.0, 0.0, driftZ + 0.4);
	let forward = normalize(lookTarget - camPos);
	let right = normalize(cross(forward, vec3<f32>(0.0, 1.0, 0.0)));
	let upVec = cross(right, forward);
	let fovScale = 1.8 - u.flash * 0.4;
	let rayDir = normalize(uv.x * right + uv.y * upVec + forward * fovScale);
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.6 * (1.0 - u.chromaStrength * 0.6);
	let beatPulse = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 4.0);
	let period = 1.4 + u.bass * 0.9 - u.treble * 0.35 + u.bpmNorm * 0.3;
	let radiusBase = 0.04 + u.bass * 0.06;
	var col = vec3<f32>(0.0);
	var p = camPos;
	var depth = 0.0;
	for (var i: i32 = 0; i < 96; i = i + 1) {
		if (depth > 28.0) { break; }
		let d = columnsDE(p, period, radiusBase, u.songSeed);
		let stepSize = max(d * 0.55, 0.045);
		let density = exp(-d * 7.5) * (0.5 + beatPulse * 0.5);
		let palDrift = snoise(t * 0.03 + u.songSeed * 97.0);
		let palT = keyBias + timbreBias + depth * 0.06 + length(p.xz) * 0.04 + t * 0.01 + palDrift * 0.3 + u.palJump;
		let fog = exp(-depth * 0.085);
		let cellAngle = atan2(p.z, p.x) / 6.28318530718 + 0.5;
		let binIdx = clamp(i32((fract(depth * 0.12 + cellAngle)) * f32(${PRISM_BIN_COUNT})), 0i, ${PRISM_BIN_COUNT - 1}i);
		col = col + iridescent(palT) * density * fog * 0.055 * (1.0 + u.bass * 0.4 + bins[binIdx] * 0.7);
		p = p + rayDir * stepSize;
		depth = depth + stepSize;
	}
	col = col + iridescent(u.centroid + 0.6) * u.flash * 0.55;
	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

export const PRISM_VORONOI_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
	let q = vec2<f32>(dot(p, vec2<f32>(127.1, 311.7)), dot(p, vec2<f32>(269.5, 183.3)));
	return fract(sin(q) * 43758.5453);
}

fn voronoi(p: vec2<f32>, t: f32) -> vec3<f32> {
	let cell = floor(p);
	let f = fract(p);
	var d1 = 1e10;
	var d2 = 1e10;
	var bestHash = 0.0;
	for (var y: i32 = -1; y <= 1; y = y + 1) {
		for (var x: i32 = -1; x <= 1; x = x + 1) {
			let offset = vec2<f32>(f32(x), f32(y));
			let h2 = hash22(cell + offset);
			let pointOff = offset + 0.5 + 0.45 * sin(t * 0.35 + h2 * 6.28318);
			let v = pointOff - f;
			let d = dot(v, v);
			if (d < d1) {
				d2 = d1;
				d1 = d;
				bestHash = h2.x;
			} else if (d < d2) {
				d2 = d;
			}
		}
	}
	return vec3<f32>(sqrt(d1), sqrt(d2) - sqrt(d1), bestHash);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;
	let t = u.time;
	let beatPulse = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 4.0);
	let warpV = voronoi(uv * 1.2 + vec2<f32>(t * 0.08, -t * 0.06), t * 0.6);
	let warp = vec2<f32>(sin(warpV.z * 6.28318 + t * 0.5), cos(warpV.z * 6.28318 + t * 0.5))
		* (0.06 + u.treble * 0.10) * warpV.y;
	let scale = 2.0 + u.bass * 1.6 + u.bpmNorm * 0.7 + snoise(t * 0.04 + u.songSeed * 89.0) * 1.4;
	let p = uv * scale + warp + vec2<f32>(t * 0.05, t * 0.03) + vec2<f32>(u.songSeed * 30.0, u.songSeed * 47.0);
	let v = voronoi(p, t);
	let edgeWidth = 0.035 + u.treble * 0.08 + snoise(t * 0.07 + u.songSeed * 41.0) * 0.04;
	let edge = smoothstep(edgeWidth, 0.0, v.y);
	let fill = smoothstep(0.7, 0.1, v.x);
	let binBoost = bins[clamp(i32(v.z * f32(${PRISM_BIN_COUNT})), 0i, ${PRISM_BIN_COUNT - 1}i)] * 0.55;
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.55 * (1.0 - u.chromaStrength * 0.6);
	let palT = v.z * 0.55 + keyBias + timbreBias + u.songSeed * 0.4 + t * 0.01
		+ snoise(t * 0.025 + u.songSeed * 67.0) * 0.3 + u.palJump;
	var col = iridescent(palT) * fill * (0.5 + u.rms * 0.5 + beatPulse * 0.3 + binBoost);
	col = col + iridescent(palT + 0.35) * edge * (1.0 + beatPulse * 0.45 + u.treble * 0.5 + binBoost * 0.6);
	col = col + iridescent(u.centroid + 0.5) * u.flash * 0.5;
	let vig = smoothstep(1.4, 0.4, length(uv));
	col = col * (0.55 + 0.45 * vig);
	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

export const PRISM_NEBULAE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash21n(p: vec2<f32>) -> f32 {
	return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise2n(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = p - i;
	let w = f * f * (3.0 - 2.0 * f);
	let a = hash21n(i);
	let b = hash21n(i + vec2<f32>(1.0, 0.0));
	let c = hash21n(i + vec2<f32>(0.0, 1.0));
	let d = hash21n(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm(p_in: vec2<f32>, octaves: i32) -> f32 {
	var p = p_in;
	var sum = 0.0;
	var amp = 0.5;
	for (var i: i32 = 0; i < 6; i = i + 1) {
		if (i >= octaves) { break; }
		sum = sum + amp * (noise2n(p) - 0.5);
		p = p * 2.07 + vec2<f32>(7.3, 11.1);
		amp = amp * 0.5;
	}
	return sum;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;
	let t = u.time;
	let flowAngle = t * 0.018 + u.songSeed * 6.28 + snoise(t * 0.01 + u.songSeed * 41.0) * 0.8;
	let flowDir = vec2<f32>(cos(flowAngle), sin(flowAngle));
	let flowSpeed = 0.04 + u.bass * 0.10 + u.bpmNorm * 0.06;
	let scale = 1.2 + u.bpmNorm * 0.2 + snoise(t * 0.02 + u.songSeed * 73.0) * 0.3;
	let p = uv * scale - flowDir * t * flowSpeed + vec2<f32>(u.songSeed * 17.0);
	let warp = vec2<f32>(fbm(p + 5.0, 4), fbm(p - 7.0, 4)) * (0.5 + u.bass * 0.7);
	let layer1 = fbm(p + warp, 5);
	let density = smoothstep(-0.05, 0.35, layer1);
	let highlight = smoothstep(0.15, 0.55, layer1);
	let dust = smoothstep(0.25, 0.45, fbm(p * 6.0 + warp * 2.0, 3)) * u.treble * 0.8;
	let binBoost = bins[clamp(i32(fract(layer1 + u.songSeed) * f32(${PRISM_BIN_COUNT})), 0i, ${PRISM_BIN_COUNT - 1}i)] * 0.5;
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.6 * (1.0 - u.chromaStrength * 0.6);
	let palT = keyBias + timbreBias + layer1 * 0.25 + u.songSeed * 0.4 + t * 0.008
		+ snoise(t * 0.025 + u.songSeed * 137.0) * 0.3 + u.palJump;
	let beatPunch = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 6.0);
	var col = iridescent(palT) * density * (0.5 + u.rms * 0.5 + beatPunch * 0.3 + binBoost * 0.8);
	col = col + iridescent(palT + 0.35) * highlight * (0.7 + u.bass * 0.4 + beatPunch * 0.5 + binBoost);
	col = col + iridescent(u.centroid + 0.4) * dust;
	let vig = smoothstep(1.8, 0.5, length(uv));
	col = col * (0.55 + 0.45 * vig);
	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Post stack: feedback, bloom prefilter, separable blur, presentation.
// ---------------------------------------------------------------------------
const FULLSCREEN_UV_WGSL = /* wgsl */ `
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
${COMMON_WGSL}
${FULLSCREEN_UV_WGSL}
`;

// Temporal feedback around the hero window: the previous frame follows the
// rose's own rotation, drifts a hair outward, decays, and is max-blended with
// the new scene so light leaves silk afterglow without accumulating to white.
export const PRISM_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var feedbackPrev: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspect = u.resolutionX / max(u.resolutionY, 1.0);
	let rs = clamp(u.roseScreen.xy, vec2<f32>(-aspect * 0.5, -0.5), vec2<f32>(aspect * 0.5, 0.5));
	let center = vec2<f32>(0.5 + rs.x / aspect, 0.5 - rs.y);
	var d = in.uv - center;
	d.x = d.x * aspect;
	let th = u.motion.x;
	let c = cos(th);
	let s = sin(th);
	// Screen y grows downward, so the rotation sign flips relative to the scene.
	d = vec2<f32>(c * d.x + s * d.y, -s * d.x + c * d.y) * u.post.y;
	d.x = d.x / aspect;
	let prevUv = center + d;
	let edge = min(min(prevUv.x, prevUv.y), min(1.0 - prevUv.x, 1.0 - prevUv.y));
	let border = smoothstep(0.0, 0.03, edge);
	let prev = textureSampleLevel(feedbackPrev, samp, prevUv, 0.0).rgb;
	let scene = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
	return vec4<f32>(max(prev * u.post.x * border, scene), 1.0);
}
`;

export const PRISM_BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / max(vec2<f32>(u.resolutionX, u.resolutionY), vec2<f32>(1.0));
	var c = textureSampleLevel(srcTex, samp, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0).rgb;
	c = c * 0.25;
	let bright = max(c.r, max(c.g, c.b));
	let knee = max(0.0, bright - u.post.z);
	return vec4<f32>(c * (knee / max(1e-4, bright)), 1.0);
}
`;

function blurShader(directionX: number, directionY: number) {
	return /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 2.8 / max(vec2<f32>(u.resolutionX, u.resolutionY), vec2<f32>(1.0));
	let dir = vec2<f32>(${directionX.toFixed(1)}, ${directionY.toFixed(1)}) * texel;
	var c = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * 0.227027;
	c = c + (textureSampleLevel(srcTex, samp, in.uv + dir, 0.0).rgb + textureSampleLevel(srcTex, samp, in.uv - dir, 0.0).rgb) * 0.1945946;
	c = c + (textureSampleLevel(srcTex, samp, in.uv + dir * 2.0, 0.0).rgb + textureSampleLevel(srcTex, samp, in.uv - dir * 2.0, 0.0).rgb) * 0.1216216;
	c = c + (textureSampleLevel(srcTex, samp, in.uv + dir * 3.0, 0.0).rgb + textureSampleLevel(srcTex, samp, in.uv - dir * 3.0, 0.0).rgb) * 0.054054;
	c = c + (textureSampleLevel(srcTex, samp, in.uv + dir * 4.0, 0.0).rgb + textureSampleLevel(srcTex, samp, in.uv - dir * 4.0, 0.0).rgb) * 0.016216;
	return vec4<f32>(c, 1.0);
}
`;
}

export const PRISM_BLUR_H_WGSL = blurShader(1, 0);
export const PRISM_BLUR_V_WGSL = blurShader(0, 1);

// Presentation: lens, the air of the building (haze, light shafts falling
// from the window, shafts from off-screen windows, dust, rain), the floor
// (its mirror of the window, the coloured light the window throws onto it,
// caustics and rain rings), then ACES, a contrast lift and IGN dither.
export const PRISM_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var feedbackTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

${ROSE_HELPERS_WGSL}

fn aces(color: vec3<f32>) -> vec3<f32> {
	return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

fn inBounds(uv: vec2<f32>) -> f32 {
	return smoothstep(0.0, 0.03, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let aspect = res.x / max(res.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// Lens: slight barrel, chromatic aberration growing with r squared and impact.
	let warped = 0.5 + centered * (1.0 + r2 * 0.05);
	let caAmount = (0.0009 + r2 * 0.007) * u.post.w;
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));
	var scene = vec3<f32>(
		textureSampleLevel(feedbackTex, samp, warped + dir * caAmount, 0.0).r,
		textureSampleLevel(feedbackTex, samp, warped, 0.0).g,
		textureSampleLevel(feedbackTex, samp, warped - dir * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTex, samp, warped, 0.0).rgb;

	let p = vec2<f32>((warped.x - 0.5) * aspect, 0.5 - warped.y);
	let rs = u.roseScreen.xy;
	let rr = max(u.roseScreen.z, 0.02);
	let rel = p - rs;
	let dist = length(rel);
	let silence = u.env.z;
	let back = u.light.x;
	let hero = u.heroCol.rgb;
	let support = u.supportCol.rgb;
	let accent = u.accentCol.rgb;
	let field = u.fieldCol.rgb;
	let lightCol = u.sky.rgb;
	let fog = u.atmos.x;
	let dust = u.atmos.y;
	let rain = u.world.w;

	// Where this pixel's ray lands: the wall, or the floor in front of it.
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let tw = select(1e6, -ro.z / rd.z, rd.z > 1e-4);
	let tf = select(1e6, (FLOOR_Y - ro.y) / rd.y, rd.y < -1e-4);
	let wallY = select(select(1e3, -1e3, rd.y < 0.0), ro.y + rd.y * tw, rd.z > 1e-4);
	let floorMask = select(smoothstep(FLOOR_Y + 0.002, FLOOR_Y - 0.006, wallY), select(0.0, 1.0, tf < 1e5), rd.z <= 1e-4);

	// Air: deep field-coloured haze that thickens near the window and moves
	// slowly, so the darkness has volume instead of being flat black.
	let air = vnoise(p * 2.4 + vec2<f32>(u.time * 0.02, u.time * 0.008))
		* 0.6 + vnoise(p * 5.1 - vec2<f32>(u.time * 0.013, 0.0)) * 0.4;
	let veil = mix(1.0, 0.35, smoothstep(rr * 1.05, rr * 0.8, dist));
	let near = exp(-dist / rr * 0.7);
	let hazeTint = mix(field, mix(hero, accent, 0.4) * lightCol, near * 0.35);
	let haze = hazeTint * (0.06 + fog * 0.08 + near * 0.32 * (0.35 + back)) * (0.7 + air * 0.6) * u.sun.w * veil * (0.6 + fog * 0.9);

	// Light shafts: march the bloom toward the window centre. They lean
	// downward, the way sun through a high window falls into the building.
	let lightUv = toUv(rs, aspect);
	let toLight = lightUv - warped;
	var shafts = vec3<f32>(0.0);
	var weight = 1.0;
	for (var i = 1; i <= 12; i = i + 1) {
		let s = textureSampleLevel(bloomTex, samp, warped + toLight * (f32(i) / 12.0) * 0.82, 0.0).rgb;
		shafts = shafts + s * weight;
		weight = weight * 0.86;
	}
	let downward = 0.12 + 0.88 * smoothstep(-0.1, 0.95, -rel.y / max(dist, 1e-3));
	let outside = smoothstep(rr * 0.92, rr * 1.35, dist);
	let streaks = 0.75 + 0.5 * vnoise(vec2<f32>(atan2(rel.y, rel.x) * 9.0, u.time * 0.05));
	shafts = shafts * outside * downward * streaks * (0.14 + air * 0.1) * u.sun.w * (0.7 + fog * 0.7);

	// A shaft from a window out of frame: a coloured beam slanting down across
	// the air, split into the glass colours across its width.
	let sideStrength = u.shaft.x;
	var beam = vec3<f32>(0.0);
	var beamLum = 0.0;
	if (sideStrength > 0.02) {
		let ang = -0.55 + u.shaft.y * 0.35;
		let bdir = normalize(vec2<f32>(sin(ang), -cos(ang)));
		let origin = vec2<f32>(u.shaft.z * aspect * 0.5, 0.62);
		let rp = p - origin;
		let along = dot(rp, bdir);
		let across = rp.x * bdir.y - rp.y * bdir.x;
		let width = 0.07 + max(along, 0.0) * 0.16;
		let core = exp(-pow(across / width, 2.0)) * smoothstep(0.0, 0.25, along) * exp(-max(along, 0.0) * 0.9);
		let split = clamp(across / width * 0.5 + 0.5, 0.0, 1.0);
		let tint = mix(mix(hero, accent, smoothstep(0.0, 0.5, split)), support, smoothstep(0.5, 1.0, split));
		let flutter = 0.75 + 0.25 * vnoise(vec2<f32>(along * 6.0 - u.time * 0.2, across * 30.0));
		beamLum = core * sideStrength * (0.25 + back * 0.6) * (0.6 + air * 0.6);
		beam = tint * lightCol * beamLum * flutter * 0.2;
	}

	// Dust drifting through the light: two parallax layers of motes that only
	// show where a shaft passes, so the air between window and floor has depth.
	var motes = 0.0;
	for (var layer = 0; layer < 2; layer = layer + 1) {
		let scale = select(52.0, 30.0, layer == 1);
		let flow = vec2<f32>(u.time * 0.11, u.time * -0.045) * select(1.0, 1.7, layer == 1);
		let grid = p * scale + flow;
		let mc = floor(grid);
		let mh = hcell(mc, 91u + u32(layer));
		let md = length(grid - (mc + 0.2 + mh * 0.6));
		let present = step(0.88 - dust * 0.16, hcell(mc, 37u + u32(layer)).x);
		motes = motes + smoothstep(0.11, 0.0, md) * present * select(0.6, 1.0, layer == 1);
	}
	let shaftLum = dot(shafts, vec3<f32>(0.3333)) + beamLum * 0.3;

	// Rain falling through the light.
	var rainLines = 0.0;
	if (rain > 0.02) {
		let rx = p.x * 150.0 + p.y * 14.0;
		let col = floor(rx);
		let rh = hcell(vec2<f32>(col, 7.0), 0x2a1u);
		let fall = fract(p.y * (1.6 + rh.y) + u.time * (2.2 + rh.x * 1.4) + rh.x * 9.0);
		rainLines = smoothstep(0.5, 0.0, abs(fract(rx) - 0.5) * 2.0 - 0.3) * smoothstep(0.86, 1.0, fall) * step(0.75, rh.y) * rain;
	}

	// Floor: where the ray meets the floor plane in front of the wall.
	var floorCol = vec3<f32>(0.0);
	if (floorMask > 0.0 && tf < 1e5) {
		let F = ro + rd * tf;
		let depthZ = max(-F.z, 0.0);
		let wet = u.camFwd.w;
		// Rain rings on standing water.
		var ringN = vec2<f32>(0.0);
		var ringLit = 0.0;
		if (rain > 0.02) {
			let rg = F.xz * 7.0;
			let rc = floor(rg);
			let rh = hcell(rc, 0x41u);
			let life = fract(u.time * 0.8 + rh.x);
			let rl = rg - rc - 0.5 - (rh - 0.5) * 0.5;
			let ringD = length(rl) - life * 0.45;
			let ring = exp(-pow(ringD * 40.0, 2.0)) * (1.0 - life) * step(0.35, rh.y) * rain;
			ringN = normalize(rl + vec2<f32>(1e-4)) * ring;
			ringLit = ring;
		}
		// The mirror: the wall point seen below the floor, reflected back up.
		let W = ro + rd * tw;
		let ripple = (vnoise(vec2<f32>(F.x * 9.0, F.z * 14.0 - u.time * 0.05)) - 0.5) * (0.0015 + (1.0 - wet) * 0.006)
			+ ringN.x * 0.01;
		let M = vec3<f32>(W.x + ripple * 1.5, 2.0 * FLOOR_Y - W.y + ripple + ringN.y * 0.01, 0.0);
		let mUv = toUv(projectScreen(M), aspect);
		let sharp = textureSampleLevel(feedbackTex, samp, mUv, 0.0).rgb;
		let soft = textureSampleLevel(bloomTex, samp, mUv, 0.0).rgb;
		let reflection = mix(soft * 1.2, mix(sharp, soft, 0.35), 0.25 + wet * 0.75)
			* (0.28 + wet * 0.42) * exp(-depthZ * (1.2 - wet * 0.8)) * inBounds(mUv);
		// The window's colours thrown onto the floor by the sun behind it,
		// traced back to the glass they passed through, with caustic veins.
		let L = vec3<f32>(u.sun.x * 1.4, 0.75 + u.sun.y * 1.2, 1.0);
		let G = F + L * depthZ;
		let gUv = toUv(projectScreen(G), aspect);
		let caustic = 1.0 + u.atmos.z * (pow(1.0 - abs(vnoise(F.xz * 8.0 + vec2<f32>(u.time * 0.15, 0.0)) * 2.0 - 1.0), 6.0) * 2.4 - 0.45);
		let carpetWin = smoothstep(0.0, 0.08, depthZ) * exp(-depthZ * 0.7);
		let carpet = (textureSampleLevel(bloomTex, samp, gUv, 0.0).rgb * 0.5
			+ textureSampleLevel(feedbackTex, samp, gUv, 0.0).rgb * 0.14) * carpetWin * caustic * inBounds(gUv);
		// Dry floors show stone flags.
		let fg = abs(fract(F.xz * vec2<f32>(4.0, 3.0)) - 0.5);
		let flags = 1.0 - (1.0 - wet) * 0.5 * (exp(-pow((0.5 - fg.x) * 40.0, 2.0)) + exp(-pow((0.5 - fg.y) * 40.0, 2.0)));
		let horizon = exp(-pow((wallY - FLOOR_Y) * 140.0, 2.0)) * (0.02 + back * 0.03);
		floorCol = (vec3<f32>(0.0015, 0.0016, 0.0022) + carpet * (1.0 - wet * 0.35)) * flags + reflection
			+ mix(accent, hero, 0.4) * horizon
			+ mix(accent, lightCol, 0.5) * ringLit * (0.02 + back * 0.05);
		floorCol = floorCol * exp(-tf * 0.06 * (0.5 + fog));
	}

	scene = scene * (1.0 - floorMask);
	var color = scene + haze + shafts + beam
		+ mix(accent, vec3<f32>(1.0), 0.35) * motes * shaftLum * 5.0 * (1.0 - floorMask)
		+ mix(lightCol, accent, 0.3) * rainLines * (0.008 + shaftLum * 1.0)
		+ bloom * (0.9 + u.motion.z * 0.3) + floorCol * floorMask;

	let vignette = 1.0 - smoothstep(0.5, 1.15, length(centered * vec2<f32>(aspect * 0.8, 1.0)) * 1.25);
	color = color * (0.62 + vignette * 0.38) * (1.0 - silence * 0.25);
	color = aces(color * 1.05 * max(1.0, u.motion.w));
	color = max((color - 0.5) * 1.12 + 0.5, vec3<f32>(0.0));
	color = color + (ign(in.uv * res, u.motion.y) - 0.5) * (1.4 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;
