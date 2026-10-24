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

/** Uniform floats: 24 legacy scalars + 60 vec4 groups. */
export const PRISM_UNIFORM_FLOATS = 264;
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
	morph: 132,
	prevPos: 136,
	prevRight: 140,
	prevUp: 144,
	prevFwd: 148,
	sunDir: 152,
	vol: 156,
	lightBox: 160,
	arcade: 164,
	side: 168,
	feel: 172,
	rig: 176,
	ringIn: 180,
	ringMid: 184,
	ringOut: 188,
	ringLight: 192,
	chromaA: 196,
	chromaB: 200,
	chromaC: 204,
	snarePk: 208,
	hatPk: 212,
	fillPk: 216,
	low: 220,
	parts: 224,
	parts2: 228,
	arcs: 232,
	notePk: 236,
	bayPk: 240,
	ringPrevIn: 244,
	ringPrevMid: 248,
	ringPrevOut: 252,
	ringSweep: 256,
	ringStart: 260
} as const;

/** The window's light map: transmitted light in wall coordinates. */
export const PRISM_LIGHTMAP_WIDTH = 1024;
export const PRISM_LIGHTMAP_HEIGHT = 192;

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
	// 0..1 fade from black when the renderer (re)starts, so opening the
	// visualizer never pops
	fadeIn: f32,
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
	// previous frame's camera position xyz, history valid (0 or 1)
	prevPos: vec4<f32>,
	// previous frame's camera right xyz, unused
	prevRight: vec4<f32>,
	// previous frame's camera up xyz, unused
	prevUp: vec4<f32>,
	// previous frame's camera forward xyz, unused
	prevFwd: vec4<f32>,
	// unit direction toward the light behind the glass xyz, shaft intensity
	sunDir: vec4<f32>,
	// haze density, forward scattering, dust, light the windows throw into the nave
	vol: vec4<f32>,
	// light map region on the wall: left x, bottom y, width, height
	lightBox: vec4<f32>,
	// arcade presence, plane z, column radius, arch spring height
	arcade: vec4<f32>,
	// unit direction toward the clerestory xyz, clerestory light strength
	side: vec4<f32>,
	// lead edge contrast, ruin brokenness, volume history weight, jitter frame
	feel: vec4<f32>,
	// camera anchor x, frame seconds, beat push, unused
	rig: vec4<f32>,
	// The ensemble's voices (voices.ts). Each ring of glass is voiced by a
	// chord: hue turn (radians), temperature -1..1, saturation, value.
	ringIn: vec4<f32>,
	ringMid: vec4<f32>,
	ringOut: vec4<f32>,
	// light of the inner, middle and outer ring, petal chroma contrast
	ringLight: vec4<f32>,
	// pitch-class weights C..B, four per group
	chromaA: vec4<f32>,
	chromaB: vec4<f32>,
	chromaC: vec4<f32>,
	// snare crack in the middle ring: strength, progress 0..1, serial, angle
	snarePk: vec4<f32>,
	// hat glints on the outer panes: strength, progress 0..1, serial, density
	hatPk: vec4<f32>,
	// fill cascading round the rose: strength, progress 0..1, start angle, direction
	fillPk: vec4<f32>,
	// low light the bass walks: floor pool shift x, shift z, power, low haze
	low: vec4<f32>,
	// left bays, right bays, high haze, floor caustics
	parts: vec4<f32>,
	// dust glint, candles, tracery glow, swing lean
	parts2: vec4<f32>,
	// kick arc centre and half-width, hat arc centre and half-width (radians)
	arcs: vec4<f32>,
	// a heard note in its petal: strength, progress 0..1, circle-of-fifths index,
	// seconds into a breakdown (the petals withdraw one by one)
	notePk: vec4<f32>,
	// flares in the neighbouring bays: left pulse, right pulse, left angle, right angle
	bayPk: vec4<f32>,
	// the chord each ring is leaving (same layout as ringIn, ringMid, ringOut)
	ringPrevIn: vec4<f32>,
	ringPrevMid: vec4<f32>,
	ringPrevOut: vec4<f32>,
	// how far round each ring its new chord has travelled (0..1), unused
	ringSweep: vec4<f32>,
	// where round each ring the new chord set out (radians), unused
	ringStart: vec4<f32>,
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

// The neighbouring bays on each side of the hero answer their own voices
// (voices.ts: bayLeft, bayRight); the hero bay is always fully lit.
fn baySide(bay: f32, anchorBay: f32) -> f32 {
	let off = bay - anchorBay;
	let side = select(u.parts.y, u.parts.x, off < 0.0);
	return mix(1.0, side, smoothstep(0.3, 0.8, abs(off)));
}

// Value noise in 3D for the nave's haze (integer hashed, no sine).
fn hash3(c: vec3<f32>) -> f32 {
	let ic = bitcast<vec3<u32>>(vec3<i32>(c));
	return f32(pmix((ic.x * 0x9e3779b1u) ^ pmix((ic.y * 0x85ebca6bu) ^ pmix(ic.z ^ 0x27d4eb2fu))) >> 8u) / 16777216.0;
}

fn vnoise3(p: vec3<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	let a = mix(hash3(i), hash3(i + vec3<f32>(1.0, 0.0, 0.0)), w.x);
	let b = mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), hash3(i + vec3<f32>(1.0, 1.0, 0.0)), w.x);
	let c = mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), hash3(i + vec3<f32>(1.0, 0.0, 1.0)), w.x);
	let d = mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), hash3(i + vec3<f32>(1.0, 1.0, 1.0)), w.x);
	return mix(mix(a, b, w.y), mix(c, d, w.y), w.z);
}

// Henyey-Greenstein phase, scaled so isotropic scattering is 1.
fn phaseHG(c: f32, g: f32) -> f32 {
	let g2 = g * g;
	return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

// Light from behind the glass, and from the clerestory behind the camera.
fn sunL() -> vec3<f32> {
	return u.sunDir.xyz;
}

fn sideL() -> vec3<f32> {
	return u.side.xyz;
}

// Project with the previous frame's camera (feedback and volume history).
fn projectPrev(w: vec3<f32>) -> vec2<f32> {
	let d = w - u.prevPos.xyz;
	let z = max(dot(d, u.prevFwd.xyz), 1e-3);
	return vec2<f32>(dot(d, u.prevRight.xyz), dot(d, u.prevUp.xyz)) * (u.camPos.w / z);
}

// The arcade: a screen of masonry standing in front of the window wall, with
// round columns on the bay boundaries, a pointed arch over every bay and a
// spandrel wall above. Signed distance in its plane: negative in the opening.
fn arcadeTop() -> f32 {
	return u.arcade.w + 0.95;
}

fn arcadeSd(P: vec2<f32>) -> f32 {
	let spacing = u.camRight.w;
	let lx = P.x - floor(P.x / spacing + 0.5) * spacing;
	let r = u.arcade.z;
	let hw = spacing * 0.5 - r;
	let spring = u.arcade.w;
	let R = hw * 1.55;
	var d = abs(lx) - hw;
	if (P.y > spring) {
		d = length(vec2<f32>(abs(lx) + (R - hw), P.y - spring)) - R;
	}
	// A ruin has lost its upper courses along a broken line.
	let broken = u.feel.y;
	let top = mix(arcadeTop(), spring + 0.04 + 0.42 * vnoise(vec2<f32>(P.x * 2.3, 5.0)) + 0.1 * vnoise(vec2<f32>(P.x * 9.0, 2.0)), broken);
	return min(d, top - P.y);
}

// The camera never lets masonry fill the lens: arcade surfaces fade out as
// they come within arm's length, the way a dolly grip would steer past them.
fn arcadeNear(t: f32) -> f32 {
	return smoothstep(0.28, 0.6, t);
}

// How much of the light crossing the arcade plane at P is blocked.
fn arcadeBlock(P: vec2<f32>) -> f32 {
	if (u.arcade.x < 0.01 || P.y < FLOOR_Y) { return 0.0; }
	return smoothstep(-0.008, 0.008, arcadeSd(P)) * u.arcade.x;
}

// Nearest arcade surface along a ray: (t, normal). t = 1e9 when missed.
fn arcadeHit(ro: vec3<f32>, rd: vec3<f32>) -> vec4<f32> {
	var best = vec4<f32>(1e9, 0.0, 0.0, -1.0);
	if (u.arcade.x < 0.01 || abs(rd.z) < 1e-4) { return best; }
	let zA = u.arcade.y;
	let spacing = u.camRight.w;
	let r = u.arcade.z;
	let spring = u.arcade.w;
	let tP = (zA - ro.z) / rd.z;
	if (tP > 0.0) {
		let P = ro + rd * tP;
		// Spandrel and arch: the planar part above the capitals.
		if (P.y > spring - 0.02 && P.y > FLOOR_Y && arcadeSd(P.xy) > 0.0) {
			best = vec4<f32>(tP, 0.0, 0.0, -sign(rd.z));
		}
	}
	// Columns: vertical cylinders, tested around where the ray crosses the plane.
	let cross = ro.x + rd.x * max(tP, 0.0);
	let k0 = floor(cross / spacing);
	let a = dot(rd.xz, rd.xz);
	for (var j = -1; j <= 2; j = j + 1) {
		let cx = (k0 + f32(j) - 0.5) * spacing;
		let oc = ro.xz - vec2<f32>(cx, zA);
		let b = dot(oc, rd.xz);
		let cc = dot(oc, oc) - r * r;
		let disc = b * b - a * cc;
		if (disc <= 0.0) { continue; }
		let t = (-b - sqrt(disc)) / a;
		if (t <= 0.02 || t >= best.x) { continue; }
		let y = ro.y + rd.y * t;
		if (y < FLOOR_Y || y > spring) { continue; }
		let h = ro + rd * t;
		let n = normalize(vec3<f32>(h.x - cx, 0.0, h.z - zA));
		best = vec4<f32>(t, n);
	}
	return best;
}
`;

// Physical light in the nave, for passes that bind the window's light map as
// lightTex with a sampler samp. The light map holds what the glass transmits,
// in wall coordinates, so a point anywhere in the nave finds the light that
// reaches it by following the sun's direction back to the wall.
const LIGHT_WGSL = /* wgsl */ `
fn lightAt(W: vec2<f32>) -> vec3<f32> {
	let uv = vec2<f32>((W.x - u.lightBox.x) / u.lightBox.z, 1.0 - (W.y - u.lightBox.y) / u.lightBox.w);
	if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) { return vec3<f32>(0.0); }
	let fade = smoothstep(0.0, 0.06, min(uv.x, 1.0 - uv.x));
	return textureSampleLevel(lightTex, samp, uv, 0.0).rgb * fade;
}

// Sunlight through the glass at X: traced back along the sun to the wall,
// shadowed by the arcade it crosses on the way.
fn shaftLight(X: vec3<f32>) -> vec3<f32> {
	if (X.z > -0.002) { return vec3<f32>(0.0); }
	let L = sunL();
	let W = X.xy + L.xy * (-X.z / L.z);
	var lit = lightAt(W);
	let zA = u.arcade.y;
	if (X.z < zA) {
		let P = X.xy + L.xy * ((zA - X.z) / L.z);
		lit = lit * (1.0 - arcadeBlock(P));
	}
	return lit;
}

// The clerestory: tall lancet pairs high in the opposite wall behind the
// camera, their glass in the support and accent colours, mullions and transoms
// casting real structure into the beams.
fn clerestoryAt(Q: vec2<f32>) -> vec3<f32> {
	let spacing = u.camRight.w * 0.5;
	let cell = floor(Q.x / spacing + 0.5);
	let lx = Q.x - cell * spacing;
	let x = abs(lx) - 0.1;
	let hw = 0.042;
	let bottom = 0.62;
	let spring = 1.18;
	var d = max(abs(x) - hw, bottom - Q.y);
	if (Q.y > spring) {
		d = length(vec2<f32>(abs(x) + hw, Q.y - spring)) - 2.0 * hw;
	}
	let open = smoothstep(0.006, -0.006, d);
	let transom = smoothstep(0.004, 0.009, abs(fract((Q.y - bottom) / 0.15) - 0.5) * 0.15);
	let leftSide = lx < 0.0;
	let pane = floor((Q.y - bottom) / 0.15);
	let alt = fract(pane * 0.5 + select(0.0, 0.5, leftSide) + hnum(cell, 0x3a1u) * 0.5) > 0.25;
	let glass = select(u.accentCol.rgb, mix(u.supportCol.rgb, u.heroCol.rgb, 0.35), alt) * u.sky.rgb;
	return glass * open * transom * 2.2;
}

fn sideLight(X: vec3<f32>) -> vec3<f32> {
	if (u.side.w < 0.01 || X.z > -0.002) { return vec3<f32>(0.0); }
	let L2 = sideL();
	let zC = -2.9;
	if (X.z < zC + 0.05) { return vec3<f32>(0.0); }
	let Q = X + L2 * ((zC - X.z) / L2.z);
	var lit = clerestoryAt(Q.xy);
	let zA = u.arcade.y;
	if (X.z > zA) {
		let P = X.xy + L2.xy * ((zA - X.z) / L2.z);
		lit = lit * (1.0 - arcadeBlock(P));
	}
	return lit * u.side.w;
}

// The lit windows are area lights too: a soft glow they throw into the nave,
// falling off with distance from the nearest bay.
fn windowGlow(X: vec3<f32>) -> vec3<f32> {
	if (X.z > -0.002) { return vec3<f32>(0.0); }
	let spacing = u.camRight.w;
	let bay = floor(X.x / spacing + 0.5);
	let anchorBay = u.rig.x / spacing;
	let lit = mix(0.06, 1.0, clamp(u.detail.w - abs(bay - anchorBay) + 1.0, 0.0, 1.0)) * baySide(bay, anchorBay);
	let C = vec3<f32>(bay * spacing, ROSE_Y, 0.0);
	let d = X - C;
	let falloff = (ROSE_R * ROSE_R) / (dot(d, d) * 2.5 + ROSE_R * ROSE_R);
	let facing = clamp(-d.z / max(length(d), 1e-3) * 1.2, 0.0, 1.0);
	return mix(u.heroCol.rgb, u.accentCol.rgb, 0.4) * u.sky.rgb * u.light.x * lit * falloff * (0.3 + 0.7 * facing) * u.vol.w;
}
`;

// ---------------------------------------------------------------------------
// Production scene: the window, its building and the camera.
// ---------------------------------------------------------------------------
// The window itself, shared by the camera view and the light map: grammars,
// tracery, mosaic, beat light, the building around it, and the morph between
// two compositions. Needs u and bins.
const ROSE_BODY_WGSL = /* wgsl */ `
// Glass coverage of the last windowPane call: 1 where light passes through.
var<private> gOpen: f32;
// Set by the light map pass: beat packets throw only part of their flash into
// the shafts and onto the floor, so a beat glows in the glass without
// strobing the whole nave.
var<private> gLightPass: f32;
// Which petal (wedge / fold count) the mosaic is being cut for: re-drafts and
// divisions travel round the rose petal by petal instead of all at once.
var<private> gWedge: f32;

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
// cell owns a mother and a daughter; the daughter only exists once the
// growth passes the cell's own threshold, then drifts apart from its mother so
// the cell visibly divides. Positions glide into the next draft at the end of
// some phrases (irregular runs); the CPU owns the draft counter and its eased
// progress, so a phrase-clock jump (a new song, a re-sync) glides instead of
// re-cutting.
fn mosaicSeed(g: vec2<f32>, which: u32, salt: u32, jitter: f32) -> vec3<f32> {
	let phrase = u32(max(u.organism.y, 0.0));
	let jNow = hcell(g, salt ^ (phrase * 0x9e3779b1u));
	let jNext = hcell(g, salt ^ ((phrase + 1u) * 0x9e3779b1u));
	// The re-draft and the divisions travel round the window instead of
	// moving every piece at once: each cell waits by where it sits (its angle
	// round the centre), plus a little of its own.
	let dv = hcell(g, salt ^ 0x51ed270bu);
	let around = fract(gWedge + atan2(g.y + 0.5, g.x + 0.5) / TAU * 0.25 + f32(salt & 1023u) * 0.000977);
	let wait = around * 0.8 + dv.y * 0.2;
	let redraft = clamp((clamp(u.organism.z, 0.0, 1.0) * 1.6 - wait) / 0.6, 0.0, 1.0);
	let j = mix(jNow, jNext, redraft);
	let base = g + 0.5 + (j - 0.5) * jitter;
	let threshold = mix(dv.x, around, 0.6) * 0.8;
	let split = smoothstep(threshold, threshold + 0.2, u.organism.x);
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
// symmetrically. Stained glass diffuses, but it still glows hotter where the
// view looks toward the sun through it, so the light shifts as the camera moves.
fn backlight(rel: vec2<f32>, rd: vec3<f32>) -> f32 {
	let lobe = pow(max(dot(rd, sunL()), 0.0), 8.0);
	return backlightFlat(rel) * (0.8 + 0.45 * lobe);
}

fn backlightFlat(rel: vec2<f32>) -> f32 {
	let d = rel - u.sun.xy;
	var hot = exp(-dot(d, d) * 9.0);
	let count = u.atmos.w;
	let d2 = rel - vec2<f32>(-u.sun.x * 0.8 - 0.12, u.sun.y * 0.4 - 0.1);
	hot = hot + exp(-dot(d2, d2) * 14.0) * smoothstep(0.34, 0.6, count) * 0.7;
	let d3 = rel - vec2<f32>(u.sun.y * 0.6 + 0.14, -u.sun.x * 0.5 + 0.12);
	hot = hot + exp(-dot(d3, d3) * 18.0) * smoothstep(0.67, 0.9, count) * 0.55;
	let drift = vec2<f32>(u.time * 0.013, -u.time * 0.008) + vec2<f32>(u.organism.w * 0.0007, 0.0);
	let cloud = 0.62 + 0.62 * vnoise(rel * 3.1 + drift) * (0.6 + 0.4 * vnoise(rel * 7.3 - drift * 1.7));
	return u.light.x * (0.42 + hot * u.sun.z) * cloud;
}

// ── The ensemble's voices in the glass (voices.ts) ──────────────────────────
// Which ring a piece of glass belongs to: inner, middle, outer (weights).
fn ringWeights(rn: f32) -> vec3<f32> {
	let wIn = 1.0 - smoothstep(0.31, 0.37, rn);
	let wOut = smoothstep(0.64, 0.7, rn);
	return vec3<f32>(wIn, max(1.0 - wIn - wOut, 0.0), wOut);
}

// How far a ring's new chord has reached this piece (0 still the old chord,
// 1 the new): a re-voicing flows round the ring from where it set out.
fn ringReach(angle: f32) -> vec3<f32> {
	let rel = fract((vec3<f32>(angle) - u.ringStart.xyz) / TAU);
	return clamp((u.ringSweep.xyz * 1.2 - rel) / 0.2, vec3<f32>(0.0), vec3<f32>(1.0));
}

// The light at the front of a re-voicing as it travels round its ring.
fn ringFront(angle: f32, w: vec3<f32>) -> f32 {
	let rel = fract((vec3<f32>(angle) - u.ringStart.xyz) / TAU);
	let d = (u.ringSweep.xyz * 1.2 - 0.1 - rel) / 0.07;
	let live = select(vec3<f32>(0.0), vec3<f32>(1.0), u.ringSweep.xyz < vec3<f32>(0.999));
	return dot(w, exp(-d * d) * live);
}

// The chord voicing of the piece's ring: a hue turn about the grey axis
// (luminance kept, the family's relations kept), a white balance toward warm
// or cold, saturation and value. Mirrors rotateHue and prismTemper.
fn voiceGlass(c: vec3<f32>, w: vec3<f32>, reach: vec3<f32>) -> vec3<f32> {
	let v = mix(u.ringPrevIn, u.ringIn, reach.x) * w.x
		+ mix(u.ringPrevMid, u.ringMid, reach.y) * w.y
		+ mix(u.ringPrevOut, u.ringOut, reach.z) * w.z;
	// A lean inside the family, never a new family: the turn and the
	// temperature stay a fraction of the voicing's full swing.
	let cs = cos(v.x * 0.65);
	let sn = sin(v.x * 0.65) * 0.57735;
	let grey = (1.0 - cs) / 3.0 * (c.r + c.g + c.b);
	var r = max(vec3<f32>(
		cs * c.r + grey + sn * (c.b - c.g),
		cs * c.g + grey + sn * (c.r - c.b),
		cs * c.b + grey + sn * (c.g - c.r)
	), vec3<f32>(0.0));
	let t = clamp(v.y, -1.0, 1.0) * 0.45;
	let gain = select(
		vec3<f32>(1.0 + 0.5 * t, 1.0 + 0.04 * t, 1.0 - 0.45 * t),
		vec3<f32>(1.0 + 0.35 * t, 1.0 + 0.04 * t, 1.0 - 0.6 * t),
		t >= 0.0
	);
	let l = dot(r, vec3<f32>(0.2126, 0.7152, 0.0722));
	r = (vec3<f32>(l) + (r - vec3<f32>(l)) * v.z) * gain * v.w;
	return max(r, vec3<f32>(0.0));
}

fn chromaAt(pc: i32) -> f32 {
	let k = clamp(pc, 0, 11);
	var g = u.chromaC;
	if (k < 4) { g = u.chromaA; } else if (k < 8) { g = u.chromaB; }
	return g[k % 4];
}

// Beat light travelling through the window in one of six forms. Glass forms
// read a cell's centre so light jumps piece to piece; lightning runs along the
// lead itself. Each form is a family, not a fixed move: the look's slow drift
// (shaft.w, morph.w, rig.w, each -1..1) widens or tightens the ring, twists
// the spiral and spreads the wheel, so no two passages carry the same shape.
// Returns (glass, came).
fn packetForm(form: f32, cellRn: f32, cellAngle: f32, n: f32, cellHash: f32, pixRn: f32, pixAngle: f32) -> vec2<f32> {
	let age = clamp(u.light.z, 0.0, 1.0);
	let f0 = clamp(u.shaft.w, -1.0, 1.0);
	let f1 = clamp(u.morph.w, -1.0, 1.0);
	let f2 = clamp(u.rig.w, -1.0, 1.0);
	let front = 0.1 + age * (1.15 + 0.2 * f1);
	let ring = exp(-pow((cellRn - front) * 6.5 * (1.0 + 0.4 * f0), 2.0));
	let seg = TAU / n;
	let beat = u.light.w;
	if (form < 0.5) {
		return vec2<f32>(ring, 0.0);
	}
	if (form < 1.5) {
		let sweep = (beat + age * (1.0 + 0.5 * f1)) * seg;
		let angDist = abs(wrapAngle(cellAngle - sweep));
		return vec2<f32>(exp(-pow(angDist / (seg * (0.55 + 0.3 * f2)), 2.0)) * exp(-pow((cellRn - (0.14 + age * 0.86)) * 3.4, 2.0)) * 1.2, 0.0);
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
		let arm = abs(wrapAngle(cellAngle * 2.0 - cellRn * (7.0 + 3.5 * f2) + age * (4.5 + 1.5 * f0) + phase)) * 0.5;
		return vec2<f32>(exp(-pow(arm / (0.3 + 0.1 * f1), 2.0)) * exp(-pow((cellRn - 0.1 - age * 0.9) * 2.2, 2.0)) * 1.2, 0.0);
	}
	if (form < 4.5) {
		let oa = hnum(beat, seedSalt() ^ 0x9du) * TAU;
		let origin = vec2<f32>(cos(oa), sin(oa)) * (0.25 + 0.4 * hnum(beat, seedSalt() ^ 0x3fu));
		let cp = vec2<f32>(cos(cellAngle), sin(cellAngle)) * cellRn;
		let at = length(cp - origin) * (0.55 + 0.15 * f2) + cellHash * (0.3 + 0.12 * f0);
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
	let h0 = hcell(id, 211u);
	let f = fract(g) - vec2<f32>(0.5);
	let slideRun = u.time * (0.12 + h0.y * 0.2) + h0.x;
	let slide = fract(slideRun);
	// A new drop each pass: its lane and size re-roll, so no drop retraces a path.
	let h = hcell(id + vec2<f32>(floor(slideRun) * 7.0, 0.0), 211u);
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
	// The wall is lit from below: the window's light pools on the floor in
	// front of it and bounces back up the stone, in the colours of the glass.
	let roomLight = w.back * exp(-(w.P.y - FLOOR_Y) * 3.2) * (0.45 + 0.55 * exp(-w.lx * w.lx * 2.5)) * (0.6 + 0.4 * u.sun.w);
	let warmStone = mix(stoneTint(), mix(hero, accent, 0.5), 0.3);
	var col = warmStone * (0.012 + roomLight * 0.75 * (0.55 + ao.y * 0.6)) * masonry(w.P)
		+ mix(hero, accent, 0.5) * moulding * spillW * 0.22
		+ warmStone * ringBand * spillW * (0.07 - jointLine * 0.06)
		+ mix(accent, support, 0.4) * ao.x * (0.015 + roomLight * 0.5)
		+ mix(accent, support, 0.5) * piers(w.lx, w.spacing) * (0.006 + roomLight * 0.25);
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
		let flick = 0.92 + 0.08 * vnoise(vec2<f32>(u.time * 7.0, f32(i) * 13.0));
		let dd = w.P - cp;
		lightSum = lightSum + exp(-dot(dd, dd) * 14.0) * flick;
		flames = flames + exp(-(pow(dd.x * 120.0, 2.0) + pow((dd.y - 0.012) * 50.0, 2.0))) * flick;
	}
	let vault = 1.0 - smoothstep(0.3, 0.62, w.P.y);
	let ring = exp(-pow((w.od - 0.03) * 70.0, 2.0)) * 0.6;
	let spill = w.back * exp(-max(w.od, 0.0) * 3.0);
	let stone = mix(stoneTint(), candle * 0.3, 0.35) * (0.5 + tone * 0.5) * mortar;
	// The candles answer their own voice (voices.ts: candles).
	let flameGain = u.parts2.y;
	return stone * (0.035 + lightSum * 0.45 * vault * flameGain + spill * 0.75)
		+ mix(accent, u.heroCol.rgb, 0.4) * ring * spill * 0.25
		+ candle * flames * flameGain
		+ accent * w.seam * ring * 0.2;
}

// Night sky through a broken wall: a moonlit cloud deck. The moon sits in a
// fixed world direction, so the sky stays at infinity as the camera travels;
// the clouds are lit on the side facing it, and only its own glow brightens
// the sky around it.
fn nightSky(rd: vec3<f32>) -> vec3<f32> {
	let sp = rd.xy / max(rd.z, 0.05);
	let moonCol = mix(vec3<f32>(0.5, 0.6, 0.9), u.sky.rgb, 0.4);
	let md = sp - vec2<f32>(0.75, 0.55);
	let moonGlow = exp(-dot(md, md) * 6.0);
	let flow = vec2<f32>(u.time * 0.012, 0.0);
	let c0 = vnoise(sp * 2.2 + flow) * 0.62 + vnoise(sp * 5.3 + flow * 1.6) * 0.28 + vnoise(sp * 11.0 + flow * 2.3) * 0.1;
	let c1 = vnoise((sp - normalize(md + vec2<f32>(1e-4)) * 0.05) * 2.2 + flow) * 0.62 + vnoise((sp - normalize(md + vec2<f32>(1e-4)) * 0.05) * 5.3 + flow * 1.6) * 0.28;
	let cover = smoothstep(0.42, 0.7, c0);
	let rimLit = clamp((c0 - c1) * 8.0, 0.0, 1.0) * cover;
	let moon = smoothstep(0.06, 0.05, length(md)) * 0.5 * (1.0 - cover * 0.85);
	return moonCol * (moonGlow * 0.025 * (1.0 - cover * 0.7) + moon + rimLit * moonGlow * 0.12 + cover * moonGlow * 0.01);
}

// Ruined chapel: the nave wall broken off above the window, open to the sky.
fn wallRuin(w: WallIn) -> vec3<f32> {
	let breakY = 0.46 + 0.1 * vnoise(vec2<f32>(w.P.x * 3.0, 1.0)) + 0.05 * vnoise(vec2<f32>(w.P.x * 11.0, 2.0)) + abs(w.lx) * 0.12;
	if (w.P.y > breakY) {
		return nightSky(w.rd);
	}
	let moonCol = mix(vec3<f32>(0.5, 0.6, 0.9), u.sky.rgb, 0.4);
	let edge = exp(-pow((w.P.y - breakY) * 90.0, 2.0)) * 0.018;
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
	let flick = 0.92 + 0.08 * vnoise(vec2<f32>(u.time * 8.0, cell));
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
		+ candle * flame * 0.85 * u.parts2.y
		+ accent * w.seam * ring * 0.15;
}

// Void: no building at all, the window floats in darkness among slowly
// tumbling shards of glass on two depth planes behind it. The shards are lit
// the way glass is: by the sun behind them, glowing where the view looks
// through them toward it and dark against it elsewhere, with a thin edge
// where the light grazes their cut sides.
fn shardLayer(ro: vec3<f32>, rd: vec3<f32>, z: f32, scale: f32, salt: u32) -> vec3<f32> {
	let t = (z - ro.z) / max(rd.z, 1e-3);
	let P = (ro + rd * t).xy;
	let g = P * scale + vec2<f32>(u.time * 0.02, u.time * 0.013);
	let cid = floor(g);
	let h = hcell(cid, salt);
	let local = rot2(u.time * (h.y - 0.5) * 0.4 + h.x * 6.0) * (fract(g) - 0.5 - (h - 0.5) * 0.35);
	let sd = sdBox(local, vec2<f32>(0.07 + 0.08 * h.y, 0.025 + 0.05 * h.x));
	let present = step(0.82, h.x);
	let col = select(select(u.accentCol.rgb, u.supportCol.rgb, h.y > 0.4), u.heroCol.rgb, h.y > 0.72) * u.sky.rgb;
	let lobe = pow(max(dot(rd, sunL()), 0.0), 6.0);
	let through = smoothstep(0.012, -0.012, sd) * (0.18 + 0.82 * lobe);
	let rimL = exp(-pow(sd * 160.0, 2.0)) * 0.35 * (0.3 + lobe);
	return col * (through * 0.6 + rimL) * present * backlightFlat(P * 0.4);
}

fn wallVoid(w: WallIn) -> vec3<f32> {
	let ro = u.camPos.xyz;
	let near = shardLayer(ro, w.rd, 0.35, 5.0, 0x77u);
	let far = shardLayer(ro, w.rd, 1.1, 3.0, 0x99u) * 0.45;
	let halo = mix(u.heroCol.rgb, u.accentCol.rgb, 0.4) * w.back * exp(-max(w.od, 0.0) * 4.0) * 0.06;
	return (near + far) * 0.9 + halo;
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
	gOpen = 0.0;

	var col = vec3<f32>(0.0);

	if (od < 0.0) {
		let fs = symmetry(stoneP, n, grammar);
		let ts = tracery(stoneP, fs, n, shape, gram, salt);

		// Carved stone: near black, catching coloured spill on its bevels.
		let spill = exp(-max(ts.sd, 0.0) * 22.0) * back;
		let bevel = exp(-pow((ts.sd - 0.016) * 150.0, 2.0));
		let ridge = exp(-pow(ts.sd * 260.0, 2.0));
		let frame = exp(-pow((od + 0.02) * 120.0, 2.0));
		col = stoneTint() * (0.02 + back * 0.1)
			+ mix(hero, accent, 0.35) * spill * 0.12 * u.parts2.z
			+ accent * (bevel * 0.14 * u.parts2.z + frame * 0.08) * back
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
			gWedge = select(0.0, fg.wedge / n, radial);
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
			// Where the piece sits: its ring, its petal, its angle.
			let cq = mosaicInverse(cell.center, style, cellScale);
			let cellRn = length(cq);
			var cellAngle = atan2(cq.y, cq.x);
			if (radial) {
				cellAngle = (fs.wedge * TAU / n) + fs.side * atan2(cq.y, cq.x);
			} else if (grammar < 6.5) {
				cellAngle = atan2(cq.x * fs.side, cq.y);
			}
			let ringW = ringWeights(cellRn);
			// Petals round the rose stand for the pitch classes on the circle of
			// fifths; each glows with its tone in the chord.
			let nSec = select(12.0, n, radial);
			let sec = floor(fract(cellAngle / TAU + 0.5 / nSec) * nSec);
			let secAngle = sec / nSec * TAU;
			let pcf = floor(sec * 12.0 / nSec);
			let pc = i32(pcf * 7.0 - 12.0 * floor(pcf * 7.0 / 12.0));
			// A breakdown puts the petals out one by one (prismPetalWithdraw).
			let rank = hnum(sec + 17.0, seedSalt() ^ 0x5e1u);
			let wStart = vec3<f32>(2.2, 1.3, 0.4) + rank * 5.0;
			let wOut = smoothstep(wStart, wStart + 1.2, vec3<f32>(u.notePk.w)) * vec3<f32>(0.45, 0.6, 0.75);
			let petalTone = mix(1.0, 0.72 + 0.75 * chromaAt(pc), u.ringLight.w) * (1.0 - dot(ringW, wOut));

			// Mosaic: mostly the role colour in varied density, with sparse pieces of
			// the neighbouring roles and the odd deep variant of the main one.
			let sprinkle = u.detail.z;
			var glass = c1 * mix(1.0, 0.55, smoothstep(0.32, 0.36, cell.id.x) * (1.0 - smoothstep(0.44, 0.48, cell.id.x)));
			let t2 = mix(0.86, 0.66, sprinkle);
			let t3 = mix(0.975, 0.9, sprinkle);
			glass = mix(glass, c2 * 0.75, smoothstep(t2, t2 + 0.04, cell.id.x));
			glass = mix(glass, c3, smoothstep(t3, t3 + 0.03, cell.id.x));
			// Each ring sings its own chord.
			glass = voiceGlass(glass, ringW, ringReach(cellAngle)) * lightCol;

			let slab = select(1.0, 2.2, gram.y > 3.5);
			let density = 0.3 + 0.95 * cell.id.y * cell.id.y;
			let interior = mix(0.75, smoothstep(0.0, 0.42, cell.edge), 1.0 - smoothstep(0.18, 0.5, footprint * cellScale));
			let grainDir = vec2<f32>(cos(cell.id.y * 9.0), sin(cell.id.y * 9.0));
			let mx = mosaicDomain(fg.q, style, cellScale);
			let streak = 1.0 - 0.12 * slab + 0.12 * slab * sin(dot(mx, grainDir) * 17.0 / slab + cell.id.x * 40.0);
			let pixRn = length(glassP);
			let pixAngle = atan2(glassP.y, glassP.x);
			let spectral = bins[clamp(i32(cellRn * 46.0), 0, ${PRISM_BIN_COUNT - 1})];

			let transmitted = back * density * tierLit * (0.5 + 0.5 * interior) * streak * (0.9 + spectral * 0.2)
				// The shafts carry the window's light, not every flicker of it: the
				// light map takes the voices' ring light and petal tones damped.
				* mix(dot(ringW, u.ringLight.xyz) * petalTone, 1.0, gLightPass * 0.6);
			// Heard kicks: a packet in the look's beat form, travelling the inner
			// ring only (the form's radius is the inner ring's), leaning with the
			// swing to one side.
			let nForm = select(8.0, n, radial);
			let kickR = 0.5;
			let lean = 1.0 + u.parts2.w * 0.22 * fs.side;
			let kRn = cellRn / kickR * lean;
			let kPix = pixRn / kickR * lean;
			var pkv = packetForm(u.modes.y, kRn, cellAngle, nForm, cell.id.x, kPix, pixAngle);
			if (u.modes.z < 0.995) {
				pkv = mix(packetForm(u.modes.x, kRn, cellAngle, nForm, cell.id.x, kPix, pixAngle), pkv, u.modes.z);
			}
			// Each kick lights one arc of the inner ring, a new side each time.
			let kArc = smoothstep(u.arcs.y, u.arcs.y * 0.45, abs(wrapAngle(cellAngle - u.arcs.x)));
			let innerMask = (1.0 - smoothstep(0.42, 0.56, cellRn)) * mix(kArc, 1.0, smoothstep(0.16, 0.0, cellRn));
			let tail = pow(1.0 - clamp(u.light.z, 0.0, 1.0), 1.3) * u.light.y * lit;
			let pk = pkv.x * tail * innerMask * (0.35 + 0.65 * tierLit) * (1.0 - gLightPass * 0.9);
			// Snare: a crack down one spoke of the middle ring, widening as it fades.
			let sAge = clamp(u.snarePk.y, 0.0, 1.0);
			let sTail = pow(1.0 - sAge, 2.0) * u.snarePk.x * lit;
			let midMask = smoothstep(0.28, 0.36, cellRn) * (1.0 - smoothstep(0.7, 0.8, cellRn));
			let sDist = abs(wrapAngle(cellAngle - u.snarePk.w)) * max(cellRn, 0.2);
			let crack = exp(-pow(sDist / (0.06 + sAge * 0.12), 2.0)) * midMask * sTail;
			let sWob = (vnoise(vec2<f32>(pixRn * 9.0, u.snarePk.z * 3.7)) - 0.5) * 0.35;
			let sPix = abs(wrapAngle(pixAngle - u.snarePk.w - sWob)) * pixRn;
			let pixMid = smoothstep(0.28, 0.36, pixRn) * (1.0 - smoothstep(0.72, 0.8, pixRn));
			let crackLead = exp(-pow(sPix * 34.0, 2.0)) * pixMid * sTail;
			// Hats: single panes of the outer ring glint, a new handful per hit.
			let hArc = smoothstep(u.arcs.w, u.arcs.w * 0.4, abs(wrapAngle(cellAngle - u.arcs.z)));
			let outerMask = smoothstep(0.6, 0.7, cellRn) * hArc;
			let hSel = hnum(floor(cell.id.x * 8191.0) + u.hatPk.z * 37.0, seedSalt() ^ 0x4a7u);
			let glint = select(0.0, 1.0, hSel < u.hatPk.w) * outerMask * pow(1.0 - clamp(u.hatPk.y, 0.0, 1.0), 2.5) * u.hatPk.x * lit;
			// A fill cascades round the rose petal by petal from where it began.
			let fAge = clamp(u.fillPk.y, 0.0, 1.0);
			let fRel = (secAngle - u.fillPk.z) * u.fillPk.w;
			let fBehind = fRel - TAU * floor(fRel / TAU);
			// It runs half way round, through the middle and outer rings.
			let fPassed = fAge * PI * 1.05 - fBehind;
			let cascade = select(0.0, exp(-fPassed * 2.4), fPassed > 0.0 && fBehind < PI) * u.fillPk.x * (1.0 - fAge * 0.6) * lit
				* smoothstep(0.3, 0.4, cellRn);
			// A heard note lights the petal of its pitch class in the middle and
			// outer rings (the melody walking round the rose).
			let noteSec = floor(u.notePk.z * nSec / 12.0 + 0.001);
			let noteOn = select(0.0, 1.0, abs(sec - noteSec) < 0.5) * smoothstep(0.12, 0.3, cellRn);
			let noteGlow = noteOn * pow(1.0 - clamp(u.notePk.y, 0.0, 1.0), 1.6) * u.notePk.x * lit;
			// The heard voices play in the hero window only; the neighbouring bays
			// answer instruments of their own (baySide).
			let bayOff = pi.bay - u.rig.x / pi.spacing;
			let heroBay = 1.0 - smoothstep(0.3, 0.7, abs(bayOff));
			// A neighbouring bay's own event flares one part of its glass.
			let flareL = bayOff < 0.0;
			let flareA = select(u.bayPk.w, u.bayPk.z, flareL);
			let flareP = select(u.bayPk.y, u.bayPk.x, flareL);
			let flare = (1.0 - heroBay) * flareP * exp(-pow(abs(wrapAngle(cellAngle - flareA)) / 0.55, 2.0))
				* smoothstep(0.2, 0.35, cellRn);
			let seen = heroBay * (pk * 4.2
				+ ringFront(cellAngle, ringW) * 0.9
				+ noteGlow * 2.2
				+ crack * 3.0
				+ glint * 5.0
				+ cascade * 1.8)
				+ flare * 4.5;
			// The shafts carry the window's steady light, and only the voices that
			// sit in one arc of it (hat glints, snare cracks), so their beams fall
			// on one part of the nave; a kick or a sweep never floods the air.
			let thrown = heroBay * (glint * 2.5 + crack * 1.5);
			let voices = mix(seen, thrown, gLightPass);
			var g = glass * (transmitted + voices) * 3.0
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
			// Punchy music cuts the lead finer and sharper.
			let cameW = mix(0.17, 0.115, u.feel.x);
			let came = (1.0 - smoothstep(cameW * 0.45 - aa, cameW + aa, cell.edge)) * mix(0.35, 1.0, detail);
			let leadGlint = accent * back * 0.03 * exp(-pow((cell.edge - 0.02) * 60.0, 2.0));
			let bolt = mix(accent, vec3<f32>(1.0), 0.25) * (pkv.y * tail * innerMask * 1.5 + crackLead * 1.3) * heroBay;
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
			gOpen = opening;
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

// Where a wall point sits among the bays, how brightly its bay is lit, and
// where the ray meets the carved stone and the recessed glass of that bay.
// Neighbouring bays light up around the bay the camera is working on; unlit
// ones hang as dark tracery silhouettes.
fn makePane(rd: vec3<f32>, wall: vec3<f32>, stoneW: vec2<f32>, glassW: vec2<f32>, footprint: f32) -> PaneIn {
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
	let anchorBay = u.rig.x / spacing;
	let bayLit = clamp(u.detail.w - abs(bay - anchorBay) + 1.0, 0.0, 1.0);
	pi.lit = mix(0.06, 1.0, bayLit) * baySide(bay, anchorBay);
	pi.back = backlight(pi.glassRel, rd) * pi.lit;
	return pi;
}

// The window at this point through the structure morph: composition B
// re-sets the window piece by piece as a front washes outward (each piece on
// its own staggered threshold, lit as it is set), then a global fade finishes
// whatever lies beyond the front. Outside a morph only B is drawn. Leaves the
// glass coverage of the blend in gOpen.
fn composeWindow(pi: PaneIn) -> vec3<f32> {
	let rnW = length(pi.wallRel) / ROSE_R;
	let front = u.comp.z;
	let finish = clamp(u.morph.z, 0.0, 1.0);
	let reach = (front - rnW) / MORPH_BAND - MORPH_SPREAD * 0.5;
	let onlyB = finish >= 0.999 || reach - MORPH_SPREAD * 0.5 >= 1.0;
	let onlyA = !onlyB && reach + MORPH_SPREAD * 0.5 <= 0.0 && finish <= 0.001;
	// One call site for the whole window, in a loop whose length depends on
	// the uniforms: the shader compiler inlines it once instead of per branch.
	var count = 2;
	if (onlyA || onlyB) { count = 1; }
	var colA = vec3<f32>(0.0);
	var colB = vec3<f32>(0.0);
	var keyB = 0.5;
	var openA = 0.0;
	var openB = 0.0;
	for (var k = 0; k < count; k = k + 1) {
		let useA = onlyA || k == 1;
		let pane = windowPane(
			pi,
			select(u.comp.y, u.comp.x, useA),
			select(u.shapeB, u.shapeA, useA),
			select(u.gramB, u.gramA, useA),
			u32(max(select(u.morph.y, u.morph.x, useA), 0.0))
		);
		if (useA) {
			colA = pane.rgb;
			openA = gOpen;
		} else {
			colB = pane.rgb;
			keyB = pane.w;
			openB = gOpen;
		}
	}
	if (onlyA) {
		gOpen = openA;
		return colA;
	}
	if (onlyB) {
		gOpen = openB;
		return colB;
	}
	let spatial = smoothstep(0.0, 1.0, reach + (keyB - 0.5) * MORPH_SPREAD);
	let wB = max(spatial, finish);
	gOpen = mix(openA, openB, wB);
	// Light leads the reveal: a glass piece glows while it is being set.
	let seam = u.comp.w * 4.0 * spatial * (1.0 - spatial) * openB;
	return mix(colA, colB, wB) + colB * seam * 0.55;
}
`;

// ---------------------------------------------------------------------------
// Production scene: the window wall, the arcade in front of it, the camera.
// ---------------------------------------------------------------------------
export const PRISM_ROSE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;
@group(0) @binding(2) var lightTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

${ROSE_HELPERS_WGSL}
${LIGHT_WGSL}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

${ROSE_BODY_WGSL}

// The arcade's masonry is dark stone that only shows where light reaches it:
// sunlight through the glass on the faces turned to the wall (a rim on the
// columns as seen from the nave), the clerestory beams on the faces turned to
// the camera, and the soft glow the windows throw into the nave.
fn shadeArcade(h: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
	let L = sunL();
	let sun = lightAt(h.xy + L.xy * (-h.z / L.z)) * max(dot(n, L), 0.0);
	let side = sideLight(h) * max(dot(n, sideL()), 0.0);
	let glow = windowGlow(h);
	let column = abs(n.x) > 0.01 || abs(n.z) < 0.99;
	let drums = 1.0 - 0.35 * exp(-pow((0.5 - abs(fract((h.y - FLOOR_Y) / 0.092) - 0.5)) * 90.0, 2.0));
	let courses = select(masonry(h.xy + vec2<f32>(0.37, 0.0)), drums, column);
	let capital = exp(-pow((h.y - u.arcade.w) * 60.0, 2.0)) * 0.6;
	let stone = stoneTint() * 1.2 * courses * (1.0 + capital);
	return stone * (sun * 1.6 + side * 0.6 + glow * (0.25 + 0.75 * max(n.z, 0.0)) + vec3<f32>(0.002));
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let p = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / res.y;
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let tW = select(1e9, -ro.z / rd.z, rd.z > 1e-3);
	let tF = select(1e9, (FLOOR_Y - ro.y) / rd.y, rd.y < -1e-4);
	var col = vec3<f32>(0.0);
	// The floor and everything below it belong to the presentation pass.
	if (rd.z > 1e-3) {
		let wall = ro + rd * tW;
		if (wall.y >= FLOOR_Y) {
			// Pixel footprint on the wall in window radii: distant and grazing
			// windows fold their mosaic detail away instead of shimmering.
			let footprint = tW / (u.camPos.w * res.y * max(rd.z, 0.2) * ROSE_R);
			// Three planes: glass recessed deepest, carved tracery in front of
			// it, the wall surface in front of both.
			let stoneW = (ro + rd * ((STONE_Z - ro.z) / rd.z)).xy;
			let glassW = (ro + rd * ((GLASS_Z - ro.z) / rd.z)).xy;
			col = composeWindow(makePane(rd, wall, stoneW, glassW, footprint));
			// The clerestory's beams land on the stone of the wall too.
			col = col + stoneTint() * 1.4 * sideLight(wall - vec3<f32>(0.0, 0.0, 0.004)) * (1.0 - gOpen);
		}
	}
	let arc = arcadeHit(ro, rd);
	if (arc.x < min(tW, tF)) {
		col = mix(col, shadeArcade(ro + rd * arc.x, arc.yzw), u.arcade.x * arcadeNear(arc.x));
	}
	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

// The window's light map: the same window seen straight through along the
// sun, keeping only what the glass transmits. Every shaft, every coloured
// patch on the floor and every lit mote in the air reads it.
export const PRISM_LIGHTMAP_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${PRISM_BIN_COUNT}>;

${ROSE_HELPERS_WGSL}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

${ROSE_BODY_WGSL}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let size = vec2<f32>(${PRISM_LIGHTMAP_WIDTH}.0, ${PRISM_LIGHTMAP_HEIGHT}.0);
	let uv = frag.xy / size;
	let W = vec2<f32>(u.lightBox.x + uv.x * u.lightBox.z, u.lightBox.y + (1.0 - uv.y) * u.lightBox.w);
	if (W.y < FLOOR_Y) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}
	let footprint = (u.lightBox.z / size.x) / ROSE_R;
	gLightPass = 1.0;
	let col = composeWindow(makePane(sunL(), vec3<f32>(W, 0.0), W, W, footprint));
	return vec4<f32>(col * gOpen, 1.0);
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

// Temporal feedback, reprojected through the camera: each pixel finds where
// its point on the wall was in the previous frame, so the afterglow stays on
// the glass while the camera travels. The trail follows the rose's own turn
// about its centre, drifts a hair outward, decays, and is max-blended with
// the new scene so light leaves silk afterglow without accumulating to white.
export const PRISM_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var feedbackPrev: texture_2d<f32>;

${ROSE_HELPERS_WGSL}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspect = u.resolutionX / max(u.resolutionY, 1.0);
	let p = vec2<f32>((in.uv.x - 0.5) * aspect, 0.5 - in.uv.y);
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let t = select(6.0, min(-ro.z / rd.z, 6.0), rd.z > 1e-3);
	let hit = ro + rd * t;
	let spacing = u.camRight.w;
	let c = vec2<f32>(floor(u.rig.x / spacing + 0.5) * spacing, ROSE_Y);
	let turned = c + rot2(-u.motion.x) * (hit.xy - c) * u.post.y;
	let prevUv = toUv(projectPrev(vec3<f32>(turned, hit.z)), aspect);
	let edge = min(min(prevUv.x, prevUv.y), min(1.0 - prevUv.x, 1.0 - prevUv.y));
	let border = smoothstep(0.0, 0.03, edge) * u.prevPos.w;
	let prev = textureSampleLevel(feedbackPrev, samp, clamp(prevUv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
	let scene = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
	return vec4<f32>(max(prev * u.post.x * border, scene), 1.0);
}
`;

// The air of the nave, at half resolution: a ray march from the camera to
// the first surface through haze that pools near the floor and drifts. Each
// step finds the sunlight that reaches it through the glass (coloured and
// patterned by the window, shadowed by the arcade), the clerestory beams from
// behind the camera, and the windows' own glow, and scatters it toward the
// camera. Jittered steps settle in a reprojected history. Output: in-scattered
// light (rgb) and the transmittance to the surface (a), so depth fog separates
// the arcade, the wall and the far bays.
export const PRISM_VOLUME_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var lightTex: texture_2d<f32>;
@group(0) @binding(3) var volumePrev: texture_2d<f32>;

${ROSE_HELPERS_WGSL}
${LIGHT_WGSL}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel + vec2<f32>(frame * 5.588238, frame * 3.11), vec2<f32>(0.06711056, 0.00583715))));
}

fn hazeDensity(X: vec3<f32>) -> f32 {
	let h = max(X.y - FLOOR_Y, 0.0);
	// Two layers: the pool near the floor (the bass's) and the high air.
	let pool = 0.45 * u.parts.z + 0.55 * exp(-h * 1.8) * u.low.w;
	let flow = vec3<f32>(u.time * 0.02, u.time * 0.007, -u.time * 0.012);
	let q = X * 2.6 + flow;
	let n = vnoise3(q) * 0.65 + vnoise3(q * 2.4 + vec3<f32>(5.3, 1.7, 3.1)) * 0.35;
	return u.vol.x * pool * (0.25 + 1.5 * n * n);
}

const STEPS: i32 = 26;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspect = u.resolutionX / max(u.resolutionY, 1.0);
	let p = vec2<f32>((in.uv.x - 0.5) * aspect, 0.5 - in.uv.y);
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let tW = select(1e9, -ro.z / rd.z, rd.z > 1e-3);
	let tF = select(1e9, (FLOOR_Y - ro.y) / rd.y, rd.y < -1e-4);
	let arc = arcadeHit(ro, rd);
	let tArc = select(1e9, arc.x, arcadeNear(arc.x) > 0.5);
	let tEnd = min(min(tW, tF), min(tArc, 6.0));
	let L = sunL();
	let L2 = sideL();
	let cs = dot(rd, L);
	let ph = mix(phaseHG(cs, u.vol.y), phaseHG(cs, -0.25), 0.2) * u.sunDir.w;
	let cs2 = dot(rd, L2);
	let ph2 = mix(phaseHG(cs2, u.vol.y), phaseHG(cs2, -0.25), 0.35);
	let jitter = ign(in.position.xy, u.feel.w);
	let dt = tEnd / f32(STEPS);
	var T = 1.0;
	var acc = vec3<f32>(0.0);
	for (var i = 0; i < STEPS; i = i + 1) {
		let t = (f32(i) + jitter) * dt;
		let X = ro + rd * t;
		if (X.z > -0.002) { break; }
		// The air right at the lens stays clear, so a beam passing the camera
		// never fills the frame with a flat slab of light.
		let dens = hazeDensity(X) * smoothstep(0.12, 0.75, t);
		let light = shaftLight(X) * ph + sideLight(X) * ph2 + windowGlow(X);
		acc = acc + T * light * dens * dt * 1.8;
		// Thin air: it lights up far more than it hides, so the glass stays
		// vivid while the far bays still sink into it.
		T = T * exp(-dens * 0.2 * dt);
	}
	let H = ro + rd * tEnd;
	let prevUv = toUv(projectPrev(H), aspect);
	let inside = prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0;
	let hist = textureSampleLevel(volumePrev, samp, clamp(prevUv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
	let w = select(1.0, u.feel.z, u.prevPos.w > 0.5 && inside);
	return mix(hist, vec4<f32>(acc, T), w);
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

// Exposure: a 1x1 meter of the lit part of the frame. It averages the
// luminance of what is actually lit (black stays out of the average, so the
// dark nave is never lifted), and adapts slowly and only part of the way, so
// a far view of a small window reads as well as a close pass while quiet
// passages still stay dimmer than drops.
export const PRISM_EXPOSURE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var exposurePrev: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	var lit = 0.0;
	var weight = 0.0;
	for (var j = 0; j < 10; j = j + 1) {
		for (var i = 0; i < 16; i = i + 1) {
			let uv = vec2<f32>((f32(i) + 0.5) / 16.0, (f32(j) + 0.5) / 10.0);
			let c = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;
			let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
			let w = smoothstep(0.004, 0.03, l);
			lit = lit + log(max(l, 1e-4)) * w;
			weight = weight + w;
		}
	}
	let coverage = weight / 160.0;
	let litMean = select(0.08, exp(lit / max(weight, 1e-3)), weight > 0.5);
	// Half-way compensation toward a key, gentler still when little is lit.
	let key = 0.2;
	let aim = clamp(pow(key / max(litMean, 1e-3), 0.65) * mix(1.2, 1.0, smoothstep(0.02, 0.2, coverage)), 0.7, 2.6);
	let prev = textureSampleLevel(exposurePrev, samp, vec2<f32>(0.5), 0.0).r;
	let k = 1.0 - exp(-max(u.rig.y, 0.0) * 0.3);
	let e = select(aim, mix(prev, aim, k), u.prevPos.w > 0.5 && prev > 0.1);
	return vec4<f32>(e, litMean, coverage, 1.0);
}
`;

// Presentation: lens, the floor (its mirror of the window, the window's
// light thrown onto it through the glass, the clerestory beams, caustics and
// rain rings), the air of the nave from the volume pass (depth fog and lit
// haze), dust motes that only show where a beam crosses them, then ACES, a
// contrast lift and IGN dither.
export const PRISM_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var feedbackTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var volumeTex: texture_2d<f32>;
@group(0) @binding(5) var lightTex: texture_2d<f32>;
@group(0) @binding(6) var exposureTex: texture_2d<f32>;

${ROSE_HELPERS_WGSL}
${LIGHT_WGSL}

fn aces(color: vec3<f32>) -> vec3<f32> {
	return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

fn inBounds(uv: vec2<f32>) -> f32 {
	return smoothstep(0.0, 0.03, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
}

// Dust: motes on six world-space slices through the nave, drifting slowly.
// A mote is only visible where a beam crosses it, scattering that beam's
// light; sub-pixel motes dim instead of growing.
fn dustMotes(ro: vec3<f32>, rd: vec3<f32>, tEnd: f32, pix: f32) -> vec3<f32> {
	var acc = vec3<f32>(0.0);
	if (u.vol.z < 0.01 || rd.z <= 1e-4) { return acc; }
	let ph = phaseHG(dot(rd, sunL()), 0.6) * u.sunDir.w;
	let ph2 = phaseHG(dot(rd, sideL()), 0.35);
	for (var k = 0; k < 6; k = k + 1) {
		let fk = f32(k);
		let z = -0.1 - fk * 0.26;
		if (ro.z >= z - 0.05) { continue; }
		let t = (z - ro.z) / rd.z;
		if (t > tEnd) { continue; }
		let P = ro + rd * t;
		let cell = 0.055;
		// The air's slow drift (env.x, env.y from the look's noise) sways the
		// slices against one another; it never cycles.
		let sway = vec2<f32>(u.env.x * (0.6 + fk * 0.15) + u.env.y * 0.01 * fk, u.time * (0.004 + fk * 0.0012));
		let g = (P.xy + sway) / cell;
		let c = floor(g);
		let h = hcell(c + vec2<f32>(fk * 131.0, 0.0), 0x6d2bu);
		if (h.x > u.vol.z * 0.5) { continue; }
		let size = 0.0009 + h.y * 0.0012;
		let r = max(size, t * pix * 1.1);
		let off = (fract(g) - 0.5 - (h - vec2<f32>(0.5)) * 0.6) * cell;
		let m = smoothstep(r, r * 0.2, length(off)) * min(1.0, (size * size) / (r * r) * 1.6);
		if (m <= 0.001) { continue; }
		// Hats are the fine sparkle in the beams: each hit catches a new few motes.
		// The sparkle sits on the side of the nave under the hats' arc of glass.
		let sparkX = u.rig.x + cos(u.arcs.z) * 0.35;
		let spark = 1.0 + u.parts2.x * 2.5 * step(0.72, fract(h.y * 37.0 + u.hatPk.z * 0.618)) * exp(-pow((P.x - sparkX) / 0.22, 2.0));
		acc = acc + (shaftLight(P) * ph + sideLight(P) * ph2) * m * (0.6 + h.y) * spark;
	}
	return acc;
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let aspect = res.x / max(res.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// Lens: slight barrel, chromatic aberration growing with r squared and impact.
	let warped = 0.5 + centered * (1.0 + r2 * 0.05);
	let caAmount = (0.0007 + r2 * 0.005) * u.post.w;
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let scene = vec3<f32>(
		textureSampleLevel(feedbackTex, samp, warped + dir * caAmount, 0.0).r,
		textureSampleLevel(feedbackTex, samp, warped, 0.0).g,
		textureSampleLevel(feedbackTex, samp, warped - dir * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTex, samp, warped, 0.0).rgb;
	let air = textureSampleLevel(volumeTex, samp, warped, 0.0);

	let p = vec2<f32>((warped.x - 0.5) * aspect, 0.5 - warped.y);
	let silence = u.env.z;
	let back = u.light.x;
	let hero = u.heroCol.rgb;
	let accent = u.accentCol.rgb;
	let lightCol = u.sky.rgb;
	let rain = u.world.w;

	// Where this pixel's ray lands: the wall, the arcade, or the floor.
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let tw = select(1e6, -ro.z / rd.z, rd.z > 1e-4);
	let tf = select(1e6, (FLOOR_Y - ro.y) / rd.y, rd.y < -1e-4);
	let arc = arcadeHit(ro, rd);
	let wallY = select(select(1e3, -1e3, rd.y < 0.0), ro.y + rd.y * tw, rd.z > 1e-4);
	var floorMask = select(smoothstep(FLOOR_Y + 0.002, FLOOR_Y - 0.006, wallY), select(0.0, 1.0, tf < 1e5), rd.z <= 1e-4);
	floorMask = floorMask * (1.0 - u.arcade.x * arcadeNear(arc.x) * select(0.0, 1.0, arc.x < tf));

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
			let lifeRun = u.time * 0.8 + rh.x;
			let life = fract(lifeRun);
			// Each ring lands somewhere new in its cell.
			let rp = hcell(rc + vec2<f32>(floor(lifeRun) * 5.0, 3.0), 0x43u);
			let rl = rg - rc - 0.5 - (rp - 0.5) * 0.5;
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
		// The window's light on the floor: sunlight through the glass, traced
		// back along the sun to the piece it passed through and shadowed by the
		// arcade, rippled into caustic veins; the clerestory beams; the
		// windows' own glow.
		let L = sunL();
			let caustic = 1.0 + u.atmos.z * u.parts.w * (pow(1.0 - abs(vnoise(F.xz * 8.0 + vec2<f32>(u.time * 0.15, 0.0)) * 2.0 - 1.0), 6.0) * 2.4 - 0.45);
		let Fl = F + vec3<f32>(0.0, 0.001, 0.0);
		// The bass line walks the pools of glass light across the floor.
		let irradiance = shaftLight(Fl + vec3<f32>(u.low.x, 0.0, u.low.y)) * L.y * 7.0 * caustic * u.low.z
			+ sideLight(Fl) * max(sideL().y, 0.0) * 1.8
			+ windowGlow(Fl) * 0.7;
		// Dry floors show stone flags.
		let fg = abs(fract(F.xz * vec2<f32>(4.0, 3.0)) - 0.5);
		let flags = 1.0 - (1.0 - wet) * 0.5 * (exp(-pow((0.5 - fg.x) * 40.0, 2.0)) + exp(-pow((0.5 - fg.y) * 40.0, 2.0)));
		let albedo = mix(vec3<f32>(0.13, 0.12, 0.12), vec3<f32>(0.05, 0.05, 0.055), wet);
		let horizon = exp(-pow((wallY - FLOOR_Y) * 140.0, 2.0)) * (0.02 + back * 0.03);
		floorCol = (vec3<f32>(0.0015, 0.0016, 0.0022) + albedo * irradiance) * flags + reflection
			+ mix(accent, hero, 0.4) * horizon
			+ mix(accent, lightCol, 0.5) * ringLit * (0.02 + back * 0.05);
	}

	// DEBUG-VIEW (lab only): 1 light map, 2 air, 3 transmittance.
	if (u.palJump > 0.5) {
		var dbg = textureSampleLevel(lightTex, samp, in.uv, 0.0).rgb;
		if (u.palJump > 1.5) { dbg = air.rgb * 4.0; }
		if (u.palJump > 2.5) { dbg = vec3<f32>(air.a); }
		if (u.palJump > 3.5) { dbg = aces(scene * 1.05 * max(1.0, u.motion.w)); }
		return vec4<f32>(dbg, 1.0);
	}
	let surface = scene * (1.0 - floorMask) + floorCol * floorMask;
	let tEnd = min(min(tw, tf), min(select(1e9, arc.x, arcadeNear(arc.x) > 0.5), 6.0));
	let motes = dustMotes(ro, rd, tEnd, 1.0 / (u.camPos.w * res.y));
	var color = surface * air.a + air.rgb + motes * 3.0 + bloom * (0.9 + u.motion.z * 0.3);

	let vignette = 1.0 - smoothstep(0.5, 1.15, length(centered * vec2<f32>(aspect * 0.8, 1.0)) * 1.25);
	color = color * (0.7 + vignette * 0.3) * (1.0 - silence * 0.25) * u.fadeIn;
	let metered = textureSampleLevel(exposureTex, samp, vec2<f32>(0.5), 0.0).r;
	color = aces(color * 1.05 * max(1.0, u.motion.w) * clamp(metered, 0.6, 2.6));
	color = max((color - 0.5) * 1.12 + 0.5, vec3<f32>(0.0));
	color = color + (ign(in.uv * res, u.motion.y) - 0.5) * (1.4 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;
