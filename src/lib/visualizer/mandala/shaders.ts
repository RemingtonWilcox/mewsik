// Mandala: a fractal voyage through eight worlds.
//
// The scene is one fullscreen pass that renders the world on screen (slot A)
// and, while the look is changing, the world it is becoming (slot B), then
// opens B out of A from the centre and through A's brightest structure, so a
// change of world is a passage, never a cut. Three worlds are escape-time
// planes, five are raymarched distance fields:
//
//   bloom    Kaliset kaleidoscope (z -> |z| / |z|^2 - c, folded into n mirror
//            sectors), orbit traps drawn as thin filigree at true pixel width
//            through the running derivative; three scale layers cross-fade
//            so the zoom never ends and each layer reveals the next.
//   spiral   a Julia set of z^n + c dived into about a repelling fixed point:
//            the window z* + lambda^-t u repeats exactly at t + 1, so the dive
//            is infinite with a bounded zoom. Each pixel starts a few
//            iterations before the window (the Poincare function), so the
//            repeat is exact with one layer; the boundary is drawn by its
//            distance estimate, banded by the fractional escape count
//            (which is invariant under one more iteration).
//   yantra   flower of life, Sri Yantra, Metatron's cube and golden-angle
//            phyllotaxis in a Droste spiral (scale step phi^3 per turn).
//   sponge   inside the Menger sponge with every level carved, from far
//            above the camera to below a pixel: x3 about its corner is an
//            exact symmetry, so the flight through its tunnels is endless.
//   cavern   Knighty's pseudo-Kleinian limit set, periodic along the flight,
//            flown along a channel the limit set never crosses.
//   foam     an Apollonian sphere-inversion foam drifted through.
//   crystal  a kaleidoscopic IFS (octahedral, icosahedral and Menger
//            folds) with per-iteration rotations, orbited up close.
//   bulb     the Mandelbulb's surface, power drifting.
//
// Colour is the palette's four authored jewel stops, cycled by orbit traps
// and view angle for iridescence. There is no ambient light: the background
// is black, light comes from the camera's lamp, the fractal's own emissive
// filigree and its specular glints. The spectrum lives in the structure:
// coarse scales answer the bass, the finest filigree the treble. Beats are
// local: a heard kick lights a sparse scatter of elements and flexes the
// folds; it never lifts the frame.
//
// Post stack: temporal feedback (zoomed and rolled with the travel), a
// highlight meter that can only bring exposure down, half-res bloom, and a
// composite with chromatic aberration and dither.

import { mandalaParamsWgsl } from './uniform-layout';

export const MANDALA_BIN_COUNT = 64;

const PARAMS_WGSL = mandalaParamsWgsl();

const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOut {
	var points = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 3.0, -1.0),
		vec2<f32>(-1.0,  3.0)
	);
	let point = points[index];
	var out: FullscreenOut;
	out.position = vec4<f32>(point, 0.0, 1.0);
	out.uv = vec2<f32>(point.x * 0.5 + 0.5, 1.0 - (point.y * 0.5 + 0.5));
	return out;
}
`;

const SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${FULLSCREEN_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${MANDALA_BIN_COUNT}>;

const PI = 3.14159265359;
const TAU = 6.28318530718;
const PHI = 1.61803398875;

fn mixU(x0: u32) -> u32 {
	var x = x0;
	x = x ^ (x >> 16u);
	x = x * 0x7feb352du;
	x = x ^ (x >> 15u);
	x = x * 0x846ca68bu;
	x = x ^ (x >> 16u);
	return x;
}

// Hash of an integer-valued float, 0..1.
fn hash11(a: f32) -> f32 {
	let ia = u32(i32(floor(a)) + 1048576);
	return f32(mixU(ia * 0x9e3779b1u + 0x632be5abu) & 0x00ffffffu) / 16777216.0;
}

fn rot2(p: vec2<f32>, a: f32) -> vec2<f32> {
	let c = cos(a);
	let s = sin(a);
	return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
	return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Spectrum at a position 0 (sub) .. 1 (air), interpolated.
fn band(x: f32) -> f32 {
	let f = clamp(x, 0.0, 1.0) * ${(MANDALA_BIN_COUNT - 2).toFixed(1)};
	let i = i32(floor(f));
	return clamp(mix(bins[i], bins[i + 1], fract(f)), 0.0, 1.0);
}

// ---- palette: four authored stops, never a cosine ----
fn palStop(i: i32) -> vec3<f32> {
	switch (i) {
		case 0: { return params.pal0.xyz; }
		case 1: { return params.pal1.xyz; }
		case 2: { return params.pal2.xyz; }
		default: { return params.pal3.xyz; }
	}
}

// Deep to hot, clamped.
fn ramp(t: f32) -> vec3<f32> {
	let x = clamp(t, 0.0, 1.0) * 3.0;
	let i = min(i32(floor(x)), 2);
	return mix(palStop(i), palStop(i + 1), smoothstep(0.0, 1.0, x - f32(i)));
}

// Looping through the stops (the iridescent cycle).
fn cycle(t: f32) -> vec3<f32> {
	let x = fract(t) * 4.0;
	let i = i32(floor(x)) % 4;
	return mix(palStop(i), palStop((i + 1) % 4), smoothstep(0.0, 1.0, fract(x)));
}

// The colour of structure at ramp position t; iri moves it round the cycle.
fn jewel(t: f32, iri: f32) -> vec3<f32> {
	return mix(ramp(t), cycle(t * 0.75 + iri + params.tone.z), params.tone.y);
}

// Mirror fold into n sectors about the origin (the mandala).
fn foldN(p: vec2<f32>, n: f32) -> vec2<f32> {
	let seg = TAU / max(n, 1.0);
	var a = atan2(p.y, p.x);
	a = abs(a - round(a / seg) * seg);
	return vec2<f32>(cos(a), sin(a)) * length(p);
}

// Local beat sparks: a heard kick lights a sparse, seeded scatter of small
// elements (about one in thirty); an onset lights another. The rest of
// the structure gives back what the sparks take, so the frame's mean
// brightness does not move on the beat. Returns a brightness multiplier.
fn sparkle(id: f32) -> f32 {
	let h1 = hash11(id * 13.0 + floor(params.pulse.y * 977.0) * 7.0);
	let h2 = hash11(id * 7.0 + floor(params.pulse.w * 613.0) * 11.0);
	let kick = params.pulse.x;
	let onset = params.pulse.z;
	let lit = step(0.97, h1) * kick * 3.5 + step(0.97, h2) * onset * 2.4;
	return 1.0 + lit - kick * 0.105 - onset * 0.072;
}

struct Slot {
	world: i32,
	variant: i32,
	fold: f32,
	phase: f32,
	turn: f32,
	yaw: f32,
	pitch: f32,
	level: f32,
	jc: vec2<f32>,
	jz: vec2<f32>,
	js: vec2<f32>,
	jn: f32,
	// Iterations the dive starts before its window (see spiralWorld).
	jw: f32,
};

fn slotA() -> Slot {
	var s: Slot;
	s.world = i32(params.slotA.x + 0.5);
	s.variant = i32(params.slotA.y + 0.5);
	s.fold = params.slotA.z;
	s.phase = params.motionA.x;
	s.turn = params.motionA.y;
	s.yaw = params.motionA.z;
	s.pitch = params.motionA.w;
	s.level = params.pal0.w;
	s.jc = params.juliaA.xy;
	s.jz = params.juliaA.zw;
	s.js = params.zoomA.xy;
	s.jn = params.juliaMix.x;
	s.jw = params.juliaMix.y;
	return s;
}

fn slotB() -> Slot {
	var s: Slot;
	s.world = i32(params.slotB.x + 0.5);
	s.variant = i32(params.slotB.y + 0.5);
	s.fold = params.slotB.z;
	s.phase = params.motionB.x;
	s.turn = params.motionB.y;
	s.yaw = params.motionB.z;
	s.pitch = params.motionB.w;
	s.level = params.pal1.w;
	s.jc = params.juliaB.xy;
	s.jz = params.juliaB.zw;
	s.js = params.zoomB.xy;
	s.jn = params.juliaMix.z;
	s.jw = params.juliaMix.w;
	return s;
}

fn pixelSize() -> f32 {
	return 1.0 / max(params.view.y, 1.0);
}

// =====================================================================
// bloom: Kaliset kaleidoscope, three scale layers
// =====================================================================
fn kaliLayer(p0: vec2<f32>, c: vec2<f32>, iters: i32, pix: f32, s: Slot, layerId: f32) -> vec3<f32> {
	var z = p0;
	var der = 1.0;
	let twist = (params.form.z - 0.5) * 0.9 + params.motion.x * 0.05;
	let ringR = 0.45 + params.form.w * 0.35;
	// The orbit's two closest approaches to the trap, measured in screen
	// pixels through the running derivative: one crisp filigree, not a fog.
	// Density is judged at a fixed reference resolution, so a bigger screen
	// gets finer lines, not more of them.
	let refPix = pix * params.view.y / 300.0;
	var best = 1e9;
	var bestI = 0.0;
	var bestAng = 0.0;
	var bestCell = 0.0;
	var second = 1e9;
	var secondI = 0.0;
	for (var i = 0; i < iters; i = i + 1) {
		let r2 = max(dot(z, z), 1e-9);
		z = abs(z) / r2 - c;
		der = min(der / r2, 1e20);
		if (s.variant == 1) {
			z = rot2(z, twist);
		}
		var trap: f32;
		switch (s.variant) {
			case 2: {
				let l = length(z);
				trap = abs(fract(l * 1.5 + 0.5) - 0.5) / 1.5;
			}
			case 3: {
				trap = min(abs(z.x), abs(z.y));
			}
			default: {
				trap = abs(length(z) - ringR);
			}
		}
		// Iterations finer than a pixel are noise: they do not count.
		let dPix = trap / max(der, 1e-20) / pix + max(0.0, log2(max(der * refPix / 0.015, 1e-9))) * 5.0;
		if (dPix < best) {
			second = best;
			secondI = bestI;
			best = dPix;
			bestI = f32(i);
			bestAng = atan2(z.y, z.x);
			bestCell = dot(floor(z * 3.0), vec2<f32>(17.0, 59.0));
		} else if (dPix < second) {
			second = dPix;
			secondI = f32(i);
		}
	}
	let fi = bestI / f32(iters);
	let fj = secondI / f32(iters);
	let id = layerId * 37.0 + bestI * 3.0 + floor(bestAng * 4.0) * 101.0 + bestCell;
	let sp = sparkle(id);
	let gainA = 0.35 + band(0.03 + fi * 0.9) * 1.6;
	let gainB = 0.35 + band(0.03 + fj * 0.9) * 1.6;
	var col = jewel(0.25 + fi * 0.75, fi + bestAng * 0.08) * (exp(-best * 0.8) * 1.2 + exp(-best * 0.1) * 0.06) * gainA * sp;
	col = col + jewel(0.1 + fj * 0.6, fj + 0.5) * exp(-second * 1.0) * 0.35 * gainB;
	return col;
}

fn bloomWorld(uv: vec2<f32>, s: Slot) -> vec3<f32> {
	var p = rot2(uv, s.turn);
	p = foldN(p, s.fold);
	let f = fract(s.phase);
	let base = floor(s.phase);
	let iters = i32(clamp(13.0 * params.quality.y + params.form.w * 5.0, 6.0, 22.0));
	let c0 = vec2<f32>(0.42 + params.form.x * 0.5, 0.3 + params.form.y * 0.55) + vec2<f32>(params.motion.x * 0.04, -params.motion.x * 0.03);
	var col = vec3<f32>(0.0);
	for (var L = 0; L < 3; L = L + 1) {
		let x = (f32(L) + 1.0 - f) / 3.0;
		let w = sin(PI * x);
		let weight = w * w * w * w * 1.2;
		if (weight < 0.002) {
			continue;
		}
		let id = f32(L) + base;
		let scale = 1.6 * exp(3.3 * (x - 0.5));
		let jitter = vec2<f32>(hash11(id * 3.0) - 0.5, hash11(id * 5.0 + 1.0) - 0.5) * 0.05;
		col = col + kaliLayer(p * scale, c0 + jitter, iters, pixelSize() * scale, s, id) * weight;
	}
	return col;
}

// =====================================================================
// spiral: infinite Julia dive about a repelling fixed point
// =====================================================================
fn juliaLayer(w0: vec2<f32>, s: Slot, iters: i32, pixW: f32) -> vec3<f32> {
	var z = w0;
	var dz = vec2<f32>(1.0, 0.0);
	let n = i32(s.jn + 0.5);
	let nf = f32(n);
	var escaped = false;
	var i = 0;
	var trap = 1e9;
	for (; i < iters; i = i + 1) {
		var zn1 = z;
		for (var k = 2; k < n; k = k + 1) {
			zn1 = cmul(zn1, z);
		}
		dz = nf * cmul(zn1, dz);
		z = cmul(zn1, z) + s.jc;
		let r2 = dot(z, z);
		trap = min(trap, abs(sqrt(r2) - 0.6));
		if (r2 > 1e4) {
			escaped = true;
			break;
		}
	}
	if (!escaped) {
		// Inside the filled set: black, with a faint jewel vein from the trap.
		return ramp(0.05) * exp(-trap * 30.0) * 0.08;
	}
	let r = length(z);
	let de = 0.5 * r * log(r) / max(length(dz), 1e-30);
	let dPix = de / pixW;
	let mu = f32(i) + 1.0 - log(log(r)) / log(nf);
	let t = fract(mu);
	// Full light at the set's edge, less where a pixel sits wholly inside
	// dense dust: a thick region reads as outlined filigree, not a blob.
	let line = exp(-dPix * 0.9) * (0.1 + 0.9 * smoothstep(0.0, 0.9, dPix));
	let halo = exp(-dPix * 0.12) * 0.035;
	let gain = 0.4 + band(clamp(0.1 + t * 0.85, 0.0, 1.0)) * 1.4;
	let sp = sparkle(floor(mu) * 5.0 + floor(t * 6.0) * 31.0 + floor(atan2(z.y, z.x) * 6.0) * 211.0);
	return jewel(t, t * 0.5) * (line * 1.3 + halo) * gain * sp;
}

fn spiralWorld(uv: vec2<f32>, s: Slot) -> vec3<f32> {
	var p = rot2(uv, s.turn * 0.25);
	if (s.variant >= 2) {
		p = foldN(p, s.fold);
		// Variant 2 sets the spiral's eye off the mirror centre: a ring of
		// spirals turning round the fold instead of a star.
		if (s.variant == 2) {
			p = p - vec2<f32>(0.32, 0.0);
		}
	}
	// Each pixel starts lead iterations before the window, near z*, so the
	// iteration itself carries it out along the Poincare function: the dive
	// repeats exactly every period with one layer.
	let iters = i32(clamp(200.0 * params.quality.y, 60.0, 220.0)) + i32(s.jw);
	let pixW = pixelSize() * length(s.js);
	return juliaLayer(s.jz + cmul(s.js, p), s, iters, pixW);
}

// =====================================================================
// yantra: sacred geometry in a Droste spiral
// =====================================================================
fn sdSegment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
	let pa = p - a;
	let ba = b - a;
	let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	return length(pa - ba * h);
}

// Regular n-gon of circumradius r, signed.
fn sdPolygon(p: vec2<f32>, r: f32, n: f32) -> f32 {
	let seg = TAU / n;
	let a = atan2(p.y, p.x) + PI / n;
	let sector = a - seg * floor(a / seg) - seg * 0.5;
	let q = vec2<f32>(cos(sector), abs(sin(sector))) * length(p);
	return q.x - r * cos(PI / n);
}

// Distance to the pattern in annulus coordinates, plus an element id.
fn yantraPattern(q: vec2<f32>, s: Slot, lnK: f32) -> vec2<f32> {
	let n = s.fold;
	let r = length(q);
	var d = 1e9;
	var id = 0.0;
	switch (s.variant) {
		case 1: {
			// Sri Yantra: interlocking up and down triangles, a lotus ring.
			for (var j = 0; j < 5; j = j + 1) {
				let rj = exp(lnK * (f32(j) + 0.7) / 5.0);
				let up = select(0.0, PI, j % 2 == 1);
				let dj = abs(sdPolygon(rot2(q, up + params.motion.x * 0.12 * f32(j % 2 * 2 - 1)), rj, 3.0));
				if (dj < d) {
					d = dj;
					id = f32(j);
				}
			}
			let petals = foldN(q, n);
			let lr = exp(lnK * 0.5);
			let dp = abs(length(petals - vec2<f32>(lr, 0.0)) - lr * sin(PI / n) * 0.9);
			if (dp < d) {
				d = dp;
				id = 7.0;
			}
		}
		case 2: {
			// Metatron's cube: two rings of n points, every point joined.
			let r1 = exp(lnK * 0.3);
			let r2 = exp(lnK * 0.72);
			let fq = foldN(q, n);
			let a0 = vec2<f32>(r1, 0.0);
			let b0 = rot2(vec2<f32>(r2, 0.0), PI / n);
			let m = i32(n + 0.5);
			for (var k = 0; k < m; k = k + 1) {
				let ang = TAU * f32(k) / n;
				let ak = rot2(a0, ang);
				let bk = rot2(b0, ang);
				d = min(d, sdSegment(fq, a0, ak));
				d = min(d, sdSegment(fq, a0, bk));
				d = min(d, sdSegment(fq, b0, bk));
			}
			let dc = min(abs(length(fq - a0) - r1 * sin(PI / n)), abs(length(fq - b0) - r1 * 0.5));
			if (dc < d) {
				id = 3.0;
			}
			d = min(d, dc);
		}
		case 3: {
			// Golden-angle phyllotaxis, 21 seeds per scale step, in log space.
			let w = vec2<f32>(log(max(r, 1e-6)), atan2(q.y, q.x));
			let seedStep = lnK / 21.0;
			let k0 = floor(w.x / seedStep);
			for (var k = -3; k <= 3; k = k + 1) {
				let kk = k0 + f32(k);
				let u = kk * seedStep;
				var dth = w.y - kk * TAU * 0.381966011;
				dth = dth - TAU * round(dth / TAU);
				let dd = abs(length(vec2<f32>(w.x - u, dth)) - seedStep * 0.85) * r;
				if (dd < d) {
					d = dd;
					id = kk;
				}
			}
		}
		default: {
			// Flower of life: rings of overlapping circles through each other's centres.
			for (var j = 0; j < 3; j = j + 1) {
				let rj = exp(lnK * (f32(j) + 0.5) / 3.0);
				let fq = foldN(rot2(q, f32(j) * PI / n), n);
				let rc = rj * sin(PI / n);
				let dj = min(abs(length(fq - vec2<f32>(rj, 0.0)) - rc), abs(length(fq - vec2<f32>(rj, 0.0)) - rc * 2.0));
				if (dj < d) {
					d = dj;
					id = f32(j);
				}
			}
		}
	}
	// The seam rings belong to every layer.
	d = min(d, min(abs(r - 1.0), abs(r - exp(lnK))));
	return vec2<f32>(d, id);
}

fn yantraWorld(uv: vec2<f32>, s: Slot) -> vec3<f32> {
	let lnK = log(PHI) * 3.0;
	let p = rot2(uv, s.turn);
	let r = max(length(p), 1e-6);
	let beta = vec2<f32>(1.0, -lnK / TAU);
	var w = cmul(vec2<f32>(log(r), atan2(p.y, p.x)), beta);
	w.x = w.x - fract(s.phase) * lnK;
	let layer = floor(w.x / lnK);
	let u = w.x - layer * lnK;
	let pix = pixelSize() * length(beta) / r;
	var col = vec3<f32>(0.0);
	// The pattern is evaluated in this layer and both neighbours, so nothing
	// that crosses a seam is ever cut.
	for (var j = -1; j <= 1; j = j + 1) {
		let uu = u - f32(j) * lnK;
		let q = exp(uu) * vec2<f32>(cos(w.y), sin(w.y));
		let pat = yantraPattern(q, s, lnK);
		let dPix = pat.x / (exp(uu) * pix);
		let absLayer = layer + f32(j) + floor(s.phase);
		let t = fract(absLayer * 0.381966 + pat.y * 0.13);
		let line = exp(-dPix * 1.0) + exp(-dPix * 0.1) * 0.08;
		let gain = 0.35 + band(fract(pat.y * 0.17 + 0.05) * 0.9) * 1.5;
		let sp = sparkle(absLayer * 17.0 + pat.y * 5.0 + floor(atan2(q.y, q.x) * 6.0) * 131.0);
		col = col + jewel(0.2 + t * 0.8, uu * 0.3) * line * gain * sp;
	}
	// The spiral's eye: detail converges, it does not glow.
	return col * smoothstep(0.0, 0.04, r);
}

// =====================================================================
// 3D worlds
// =====================================================================
// One level of the sponge in that level's own units: positive inside the
// level's tunnels (the middle third of a cell in two coordinates).
fn spongeHole(x: vec3<f32>, variant: i32, width: f32) -> f32 {
	let h = abs(fract(x) - 0.5);
	switch (variant) {
		case 1: {
			let w = width * 1.12;
			return max(max(w - length(h.xy), w - length(h.yz)), w - length(h.zx));
		}
		case 2: {
			let w = width * 1.3;
			return max(max(w - (h.x + h.y) * 0.7071, w - (h.y + h.z) * 0.7071), w - (h.z + h.x) * 0.7071);
		}
		default: {
			return max(max(width - max(h.x, h.y), width - max(h.y, h.z)), width - max(h.z, h.x));
		}
	}
}

fn spongeWidth(m: i32, s: Slot) -> f32 {
	let breathe = 1.0 + (params.form.x - 0.5) * 0.18 + params.motion.x * 0.04;
	var w = breathe / 6.0;
	if (s.variant == 3 && ((m + i32(s.level)) % 2 + 2) % 2 == 1) {
		w = w * 0.75;
	}
	return w;
}

// The sponge carved at every level, anchored at its corner: x3 about the
// origin maps it onto itself exactly. Evaluated in the camera's frame,
// where the world is scaled by 3^f, so the level range never has to move.
// Returns distance, carving level, nearest rim (frame units) and its level.
fn deSponge(q: vec3<f32>, s: Slot) -> vec4<f32> {
	let f = fract(s.phase);
	var d = -1e5;
	var lvl = 0.0;
	var rim = 1e5;
	var rimLvl = 0.0;
	let fine = i32(clamp(8.0 * params.quality.y, 5.0, 8.0));
	var sc = pow(3.0, -2.0 - f);
	let variant = select(s.variant, 0, s.variant == 3);
	for (var m = -2; m <= fine; m = m + 1) {
		let c = spongeHole(q * sc, variant, spongeWidth(m, s)) / sc;
		if (c > d) {
			d = c;
			lvl = f32(m);
		}
		if (abs(c) < rim) {
			rim = abs(c);
			rimLvl = f32(m);
		}
		sc = sc * 3.0;
	}
	return vec4<f32>(d, lvl, rim, rimLvl);
}

// The camera's route through one period, in world units at the start of
// the period: down the level-0 tunnel, along a level-1 tunnel, along
// another, arriving at a third of where it set out. Corners are rounded
// inside the tunnels' width.
fn spongeCorner(a: vec3<f32>, corner: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
	let u = 1.0 - t;
	return a * u * u + corner * 2.0 * u * t + b * t * t;
}

fn spongeRoute(u0: f32) -> vec3<f32> {
	let s = fract(u0);
	let A = vec3<f32>(0.5, 0.5, 0.5);
	let B = vec3<f32>(0.5, 0.5, 1.0 / 6.0);
	let C = vec3<f32>(0.5, 1.0 / 6.0, 1.0 / 6.0);
	let D = vec3<f32>(1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0);
	let rA = 0.1;
	let rB = 0.08;
	let rC = 0.035;
	let rD = rA / 3.0;
	let third = 1.0 / 3.0;
	if (s < rA) {
		// Leaving the corner the previous period arrived at (seen x3).
		let t = (s + rA) / (2.0 * rA);
		return spongeCorner(A + vec3<f32>(rA, 0.0, 0.0), A, A - vec3<f32>(0.0, 0.0, rA), t);
	}
	if (s > 1.0 - rD) {
		let t = (s - 1.0 + rD) / (2.0 * rD);
		return spongeCorner(D + vec3<f32>(rD, 0.0, 0.0), D, D - vec3<f32>(0.0, 0.0, rD), t);
	}
	if (abs(s - third) < rB) {
		let t = (s - third + rB) / (2.0 * rB);
		return spongeCorner(B + vec3<f32>(0.0, 0.0, rB), B, B - vec3<f32>(0.0, rB, 0.0), t);
	}
	if (abs(s - 2.0 * third) < rC) {
		let t = (s - 2.0 * third + rC) / (2.0 * rC);
		return spongeCorner(C + vec3<f32>(0.0, rC, 0.0), C, C - vec3<f32>(rC, 0.0, 0.0), t);
	}
	if (s < third) {
		return mix(A, B, s / third);
	}
	if (s < 2.0 * third) {
		return mix(B, C, (s - third) / third);
	}
	return mix(C, D, (s - 2.0 * third) / third);
}

// A point of the route at period position g, in the frame of period position f.
fn spongeRouteIn(g: f32, f: f32) -> vec3<f32> {
	let whole = floor(g);
	return spongeRoute(g - whole) * pow(3.0, f - whole);
}

// The cavern's flight line: a channel along z that the limit set never
// crosses for any box size the form axes reach (found by scanning the
// distance field), with a gentle sway inside its clearance.
fn cavernPath(z: f32, period: f32) -> vec2<f32> {
	let a = z * TAU / period;
	return vec2<f32>(-0.78 + sin(a) * 0.03, 0.78 + cos(a * 2.0) * 0.03);
}

fn deCavern(p0: vec3<f32>, s: Slot) -> vec4<f32> {
	let C = vec3<f32>(0.83 + (params.form.x - 0.5) * 0.08, 0.83 + (params.form.y - 0.5) * 0.08, 1.167);
	let period = 4.0 * C.z;
	var p = p0;
	p.z = p.z - period * floor(p.z / period + 0.5);
	var k = 1.0;
	var orb = vec4<f32>(1e5);
	let size = 1.0 + (params.form.z - 0.5) * 0.16 + params.motion.x * 0.03;
	let iters = i32(clamp(9.0 * params.quality.y, 5.0, 11.0));
	for (var i = 0; i < iters; i = i + 1) {
		p = 2.0 * clamp(p, -C, C) - p;
		let r2 = dot(p, p);
		orb = min(orb, vec4<f32>(abs(p), r2));
		let kk = max(size / r2, 1.0);
		p = p * kk;
		k = k * kk;
	}
	let rxy = length(p.xy);
	var d: f32;
	switch (s.variant) {
		case 1: { d = max(rxy - 0.55, abs(rxy * p.z) / length(p)) / k; }
		case 2: { d = (length(p.xz) - 0.42) / k; }
		case 3: { d = max(rxy - 0.72, abs(rxy * p.z) / length(p)) / k; }
		default: { d = max(rxy - 0.92784, abs(rxy * p.z) / length(p)) / k; }
	}
	return vec4<f32>(d * 0.7, orb.w, orb.x, orb.y);
}

// The foam's flight line runs along the cell edges, the one channel every
// variant leaves open.
fn foamPath(z: f32) -> vec2<f32> {
	return vec2<f32>(1.0 + sin(z * PI) * 0.04, 1.0 + cos(z * PI * 0.5) * 0.04);
}

fn deFoam(p0: vec3<f32>, s: Slot) -> vec4<f32> {
	var p = p0;
	var scale = 1.0;
	var orb = vec4<f32>(1e5);
	let sv = 1.08 + params.form.x * 0.32 + params.motion.x * 0.025;
	let iters = i32(clamp(8.0 * params.quality.y, 5.0, 9.0));
	for (var i = 0; i < iters; i = i + 1) {
		p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
		let r2 = dot(p, p);
		orb = min(orb, vec4<f32>(abs(p), r2));
		let k = sv / r2;
		p = p * k;
		scale = scale * k;
	}
	var d: f32;
	switch (s.variant) {
		case 1: { d = 0.25 * (length(p) - 0.5) / scale; }
		case 2: { d = 0.25 * abs(length(p) - 0.8) / scale; }
		case 3: { d = 0.25 * (length(p.xz) - 0.25) / scale; }
		default: { d = 0.25 * abs(p.y) / scale; }
	}
	return vec4<f32>(d, orb.w, orb.x, orb.z);
}

fn crystalFold(p0: vec3<f32>, variant: i32) -> vec3<f32> {
	var p = p0;
	switch (variant) {
		case 1: {
			// Icosahedral (Knighty): abs, then the two mirror planes, twice.
			let n1 = normalize(vec3<f32>(-PHI, PHI - 1.0, 1.0));
			let n2 = normalize(vec3<f32>(1.0, -PHI, PHI + 1.0));
			for (var k = 0; k < 2; k = k + 1) {
				p = abs(p);
				p = p - 2.0 * max(0.0, dot(p, n1)) * n1;
				p = p - 2.0 * max(0.0, dot(p, n2)) * n2;
			}
			p = abs(p);
		}
		default: {
			// Octahedral (and the Menger sort).
			p = abs(p);
			if (p.x < p.y) { p = vec3<f32>(p.y, p.x, p.z); }
			if (p.x < p.z) { p = vec3<f32>(p.z, p.y, p.x); }
			if (p.y < p.z) { p = vec3<f32>(p.x, p.z, p.y); }
		}
	}
	return p;
}

fn deCrystal(p0: vec3<f32>, s: Slot) -> vec4<f32> {
	var p = p0;
	var S = 2.0 + params.form.x * 0.45;
	if (s.variant == 2) {
		S = 2.35 + params.form.x * 0.3;
	}
	if (s.variant == 3) {
		S = 3.0;
	}
	let evolve = s.phase * TAU / 84.0;
	let a1 = params.form.y * 0.55 + sin(evolve) * 0.12 + params.motion.x * 0.12;
	let a2 = params.form.z * 0.45 + cos(evolve * 0.618) * 0.1 - params.motion.x * 0.08;
	// Each fold family has its own canonical offset (a vertex of its solid);
	// formD leans it, which is where the cathedral's proportions come from.
	var offset: vec3<f32>;
	switch (s.variant) {
		case 1: { offset = vec3<f32>(0.851, 0.526 + params.form.w * 0.15, params.form.w * 0.1); }
		case 2: { offset = vec3<f32>(1.0, 0.35 + params.form.w * 0.3, 0.9); }
		case 3: { offset = vec3<f32>(1.0, 1.0, 1.0); }
		default: { offset = vec3<f32>(1.0, 0.85 + params.form.w * 0.3, 0.55 + params.form.w * 0.5); }
	}
	let iters = i32(clamp(10.0 * params.quality.y, 6.0, 12.0));
	var orb = vec4<f32>(1e5);
	for (var i = 0; i < iters; i = i + 1) {
		p = vec3<f32>(rot2(p.xy, a1), p.z);
		// Variant 2 is a second octahedral cathedral with its own proportions.
		p = crystalFold(p, select(s.variant, 0, s.variant == 2));
		p = vec3<f32>(rot2(p.xz, a2), p.y).xzy;
		p = p * S - offset * (S - 1.0);
		if (s.variant == 3 && p.z < -0.5 * offset.z * (S - 1.0)) {
			p.z = p.z + offset.z * (S - 1.0);
		}
		orb = min(orb, vec4<f32>(abs(p), dot(p, p)));
	}
	let d = (max(abs(p.x), max(abs(p.y), abs(p.z))) - 1.0) * pow(S, -f32(iters));
	return vec4<f32>(d, orb.w, orb.x, orb.y);
}

fn deBulb(p0: vec3<f32>, s: Slot) -> vec4<f32> {
	var z = p0;
	var dr = 1.0;
	var r = 0.0;
	var power = 8.0;
	switch (s.variant) {
		case 1: { power = 5.0; }
		case 2: { power = 3.0; }
		case 3: { power = 9.0; }
		default: { power = 8.0; }
	}
	power = power + (params.form.x - 0.5) * 1.6 + params.motion.x * 0.15;
	var orb = vec4<f32>(1e5);
	let iters = i32(clamp(7.0 * params.quality.y, 4.0, 9.0));
	for (var i = 0; i < iters; i = i + 1) {
		r = length(z);
		if (r > 2.0) {
			break;
		}
		let theta = acos(clamp(z.z / max(r, 1e-6), -1.0, 1.0)) * power;
		let phi = atan2(z.y, z.x) * power;
		dr = pow(r, power - 1.0) * power * dr + 1.0;
		let zr = pow(r, power);
		z = zr * vec3<f32>(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p0;
		orb = min(orb, vec4<f32>(abs(z), dot(z, z)));
	}
	let d = 0.5 * log(max(r, 1e-6)) * r / dr;
	return vec4<f32>(d, orb.w, orb.x, orb.y);
}

fn deWorld(s: Slot, p: vec3<f32>) -> vec4<f32> {
	switch (s.world) {
		case 3: { return deSponge(p, s); }
		case 4: { return deCavern(p, s); }
		case 5: { return deFoam(p, s); }
		case 6: { return deCrystal(p, s); }
		default: { return deBulb(p, s); }
	}
}

struct Camera {
	ro: vec3<f32>,
	rd: vec3<f32>,
	// World units per "metre": the sponge shrinks as it dives.
	unit: f32,
	maxT: f32,
	// How far the camera's lamp carries before the structure sinks to black.
	reach: f32,
};

fn lookAt(ro: vec3<f32>, aim: vec3<f32>, roll: f32, uv: vec2<f32>, focal: f32) -> vec3<f32> {
	let fwd = normalize(aim - ro);
	var right = normalize(cross(fwd, vec3<f32>(0.0, 1.0, 0.0)));
	if (abs(fwd.y) > 0.999) {
		right = vec3<f32>(1.0, 0.0, 0.0);
	}
	let up = cross(right, fwd);
	let r2 = right * cos(roll) + up * sin(roll);
	let u2 = cross(r2, fwd);
	return normalize(uv.x * r2 + uv.y * u2 + focal * fwd);
}

fn camera3d(uv: vec2<f32>, s: Slot) -> Camera {
	var cam: Camera;
	let focal = params.quality.z;
	switch (s.world) {
		case 3: {
			// Threading the sponge's tunnels: one period goes x3 deeper and
			// returns to the same view, so the flight never ends.
			let f = fract(s.phase);
			let ro = spongeRouteIn(f, f);
			let ahead = spongeRouteIn(f + 0.045, f);
			// The look rakes across the walls rather than down the tunnel, so the
			// vanishing point sits near the frame's edge, not in its centre.
			let along = normalize(ahead - ro);
			var side = normalize(cross(along, vec3<f32>(0.3, 1.0, 0.2)));
			let up = cross(side, along);
			let look = ro + along + side * (0.55 + s.yaw * 0.5) + up * (0.25 + s.pitch * 0.5);
			cam.ro = ro;
			cam.rd = lookAt(ro, look, s.turn, uv, focal);
			cam.unit = 1.0;
			cam.maxT = 3.0;
			cam.reach = 0.22;
		}
		case 4: {
			let period = 4.0 * 1.167;
			let z = fract(s.phase / 4.0) * period;
			let ro = vec3<f32>(cavernPath(z, period), z);
			let ahead = vec3<f32>(cavernPath(z + 0.35, period), z + 0.35);
			// The look swings off the channel's axis, so the lattice is seen
			// raking past instead of face-on.
			let look = ahead + vec3<f32>(0.18 + s.yaw * 0.6, -0.1 + s.pitch * 0.45, 0.0);
			cam.ro = ro;
			cam.rd = lookAt(ro, look, s.turn * 0.5, uv, focal);
			cam.unit = 1.0;
			cam.maxT = 6.0;
			cam.reach = 2.0;
		}
		case 5: {
			let z = fract(s.phase / 8.0) * 16.0;
			let ro = vec3<f32>(foamPath(z), z);
			let ahead = vec3<f32>(foamPath(z + 0.3), z + 0.3);
			let look = ahead + vec3<f32>(s.yaw * 0.3, s.pitch * 0.25, 0.0);
			cam.ro = ro;
			cam.rd = lookAt(ro, look, s.turn * 0.4, uv, focal);
			cam.unit = 1.0;
			cam.maxT = 5.0;
			cam.reach = 2.6;
		}
		case 6: {
			let orbit = s.turn + s.phase * TAU / 84.0;
			let elev = 0.35 + s.pitch * 0.8;
			var dist = 4.4;
			switch (s.variant) {
				case 1: { dist = 1.75; }
				case 2: { dist = 2.0; }
				case 3: { dist = 3.0; }
				default: { dist = 3.2; }
			}
			dist = dist * (1.0 - params.form.w * 0.15);
			let ro = dist * vec3<f32>(cos(orbit) * cos(elev), sin(elev), sin(orbit) * cos(elev));
			// Aimed off the centre: the crystal is a place beside you, not an orb.
			let sideways = normalize(cross(ro, vec3<f32>(0.0, 1.0, 0.0)));
			let aim = sideways * (0.9 * sin(s.turn * 0.31 + 1.1) + s.yaw * 0.6) + vec3<f32>(0.0, 0.25, 0.0);
			cam.ro = ro;
			cam.rd = lookAt(ro, aim, s.yaw * 0.2, uv, focal);
			cam.unit = 1.0;
			cam.maxT = 12.0;
			cam.reach = 5.5;
		}
		default: {
			let orbit = s.turn + s.phase * TAU / 84.0;
			let elev = 0.25 + s.pitch * 0.7;
			let dist = 2.15 - params.form.w * 0.3;
			let ro = dist * vec3<f32>(cos(orbit) * cos(elev), sin(elev), sin(orbit) * cos(elev));
			let sideways = normalize(cross(ro, vec3<f32>(0.0, 1.0, 0.0)));
			let aim = sideways * (0.75 * sin(s.turn * 0.29 + 2.0) + s.yaw * 0.3) + vec3<f32>(0.0, 0.15, 0.0);
			cam.ro = ro;
			cam.rd = lookAt(ro, aim, s.yaw * 0.25, uv, focal);
			cam.unit = 1.0;
			cam.maxT = 5.0;
			cam.reach = 1.4;
		}
	}
	return cam;
}

struct RayHit {
	t: f32,
	hit: bool,
	glow: f32,
	steps: f32,
};

fn march(s: Slot, cam: Camera) -> RayHit {
	var h: RayHit;
	h.t = 0.0;
	h.hit = false;
	h.glow = 0.0;
	h.steps = 0.0;
	let steps = i32(params.quality.x);
	let pixAngle = pixelSize() / params.quality.z;
	for (var i = 0; i < steps; i = i + 1) {
		let d = deWorld(s, cam.ro + cam.rd * h.t).x;
		let eps = max(pixAngle * h.t * 0.7, 1e-6 * cam.unit);
		h.glow = h.glow + 1.0 / (1.0 + (d * d) / (0.0004 * cam.unit * cam.unit));
		if (d < eps) {
			h.hit = true;
			break;
		}
		h.t = h.t + d * 0.9;
		h.steps = h.steps + 1.0;
		if (h.t > cam.maxT) {
			break;
		}
	}
	return h;
}

fn normal3d(s: Slot, p: vec3<f32>, eps: f32) -> vec3<f32> {
	let k = vec2<f32>(1.0, -1.0);
	return normalize(
		k.xyy * deWorld(s, p + k.xyy * eps).x +
		k.yyx * deWorld(s, p + k.yyx * eps).x +
		k.yxy * deWorld(s, p + k.yxy * eps).x +
		k.xxx * deWorld(s, p + k.xxx * eps).x
	);
}

fn occlusion(s: Slot, p: vec3<f32>, n: vec3<f32>, unit: f32) -> f32 {
	if (params.quality.w < 0.5) {
		return 1.0;
	}
	var occ = 0.0;
	var w = 1.0;
	for (var i = 1; i <= 4; i = i + 1) {
		let h = 0.012 * unit * f32(i * i);
		occ = occ + (h - deWorld(s, p + n * h).x) * w;
		w = w * 0.6;
	}
	return clamp(1.0 - occ * 5.0 / unit, 0.2, 1.0);
}

// Emissive rims round every hole of the sponge at every scale a pixel can see.
fn spongeRims(q: vec3<f32>, s: Slot, pix: f32) -> vec3<f32> {
	let f = fract(s.phase);
	var col = vec3<f32>(0.0);
	let fine = i32(clamp(8.0 * params.quality.y, 5.0, 8.0));
	var sc = pow(3.0, -2.0 - f);
	let variant = select(s.variant, 0, s.variant == 3);
	for (var m = -2; m <= fine; m = m + 1) {
		let hole = 1.0 / sc;
		if (hole > pix * 10.0) {
			let c = abs(spongeHole(q * sc, variant, spongeWidth(m, s))) / sc;
			let absLevel = f32(m) + s.level;
			let line = exp(-c / (pix * 0.9)) * 0.4;
			// Fine levels whisper, the level at the camera's own scale speaks.
			let fineFade = smoothstep(pix * 10.0, pix * 90.0, hole);
			let cell = floor(q * sc);
			let id = absLevel * 101.0 + dot(cell, vec3<f32>(7.0, 13.0, 29.0));
			let gain = 0.3 + band(clamp(f32(m + 2) / f32(fine + 3), 0.0, 1.0) * 0.9 + 0.05) * 1.6;
			col = col + jewel(fract(absLevel * 0.25) * 0.75 + 0.25, absLevel * 0.13) * line * fineFade * gain * select(1.0, sparkle(id), hole < pix * 60.0);
		}
		sc = sc * 3.0;
	}
	return col;
}

fn render3d(uv: vec2<f32>, s: Slot) -> vec3<f32> {
	let cam = camera3d(uv, s);
	let h = march(s, cam);
	let fogK = params.pal2.w;
	let glowCol = jewel(0.45, 0.2) * params.tone.x;
	var col = glowCol * h.glow * 0.0035 * exp(-h.t / cam.unit * fogK * 0.6);
	if (params.mood.z > 1.5) {
		return vec3<f32>(h.t / cam.maxT, select(0.0, 1.0, h.hit), h.steps / params.quality.x);
	}
	if (!h.hit) {
		return col;
	}
	let p = cam.ro + cam.rd * h.t;
	let pixAngle = pixelSize() / params.quality.z;
	let pix = max(pixAngle * h.t, 1e-6 * cam.unit);
	let n = normal3d(s, p, pix * 0.6);
	let info = deWorld(s, p);
	let view = -cam.rd;
	let ndv = clamp(dot(n, view), 0.0, 1.0);
	if (params.mood.z > 2.5) {
		return vec3<f32>(n * 0.5 + 0.5) * exp(-h.t * 0.3);
	}

	// Material index: which level, which orbit, which trap.
	var t = 0.0;
	var emit = vec3<f32>(0.0);
	var id = 0.0;
	// How much the lamp's diffuse shows on this material (stone is dark, glints carry it).
	var matte = 1.0;
	switch (s.world) {
		case 3: {
			let absLevel = info.y + s.level;
			t = fract(absLevel * 0.25);
			emit = spongeRims(p, s, pix);
			id = absLevel;
			matte = 0.4;
		}
		case 4: {
			t = fract(log2(max(info.y, 1e-4)) * 0.18 + info.z * 0.5);
			id = floor(log2(max(info.y, 1e-4)) * 3.0);
			emit = jewel(0.8, t) * exp(-info.z * 40.0) * (0.4 + band(0.75) * 1.5);
		}
		case 5: {
			t = fract(log2(max(info.y, 1e-4)) * 0.22 + info.w);
			id = floor(info.y * 40.0);
			// The foam's membranes glow from within: ambient light lives in it.
			emit = jewel(0.9, t) * (exp(-info.z * 14.0) * 0.6 + exp(-info.z * 60.0) * 0.9) * (0.35 + band(0.6) * 1.2);
		}
		case 6: {
			t = fract(sqrt(info.y) * 0.08 + info.z * 0.15);
			id = floor(info.z * 9.0) + floor(info.w * 5.0) * 13.0;
			emit = jewel(0.85, t) * exp(-min(info.z, info.w) * 9.0) * (0.35 + band(0.8) * 1.6);
			matte = 0.6;
		}
		default: {
			t = fract(sqrt(info.y) * 0.6 + info.z * 0.3);
			id = floor(info.y * 12.0);
			emit = jewel(0.85, t) * exp(-info.z * 14.0) * (0.3 + band(0.7) * 1.4);
		}
	}
	// Sparks key on small cells of space as well as the material, so one
	// kick lights a scatter of fragments, never a whole level or surface.
	// The sponge's rims spark per cell already.
	if (s.world != 3) {
		let cell = floor(p * (24.0 / cam.unit));
		emit = emit * sparkle(id * 131.0 + dot(cell, vec3<f32>(7.0, 13.0, 29.0)));
	}

	// Light: the camera's own lamp, a little above. It falls off over the
	// world's own scale, so the far structure sinks to black.
	let reach = cam.reach;
	let lampPos = cam.ro + vec3<f32>(0.0, reach * 0.06, 0.0);
	let toLamp = lampPos - p;
	let lampDist = length(toLamp) / reach;
	let l = toLamp / max(length(toLamp), 1e-6);
	let atten = 1.0 / (1.0 + lampDist * lampDist * 3.0);
	let diff = max(dot(n, l), 0.0);
	let hv = normalize(l + view);
	let spec = pow(max(dot(n, hv), 0.0), 56.0);
	let fres = pow(1.0 - ndv, 4.0);
	let ao = occlusion(s, p, n, cam.unit);
	// Orbit traps walk the whole palette, so one structure holds several jewels.
	let albedo = mix(jewel(0.2 + t * 0.6, t), cycle(t * 1.7 + params.tone.z) * 0.8, 0.55);
	let sheenCol = cycle(t + ndv * 1.3 + params.tone.z);
	let lampCol = mix(params.pal3.xyz, vec3<f32>(1.0), 0.6);
	col = col + albedo * diff * atten * ao * 0.26 * matte;
	col = col + lampCol * spec * atten * ao * (1.6 + params.character.z);
	col = col + sheenCol * fres * atten * ao * (0.15 + params.tone.y * 0.6);
	col = col + emit * (0.4 + 0.6 * ao);
	// Objects seen from outside (crystal, bulb) also take a key light from
	// above and a coloured rim from behind, so their form reads.
	if (s.world >= 6) {
		let keyDir = normalize(vec3<f32>(0.5, 0.85, -0.2));
		let kd = max(dot(n, keyDir), 0.0);
		let ks = pow(max(dot(n, normalize(keyDir + view)), 0.0), 64.0);
		col = col + albedo * kd * ao * 0.16 + params.pal2.xyz * ks * ao * 1.2;
		col = col + params.pal1.xyz * fres * max(dot(n, -keyDir), 0.0) * ao * 0.8;
	}
	// The air absorbs with distance: far is black, not grey.
	// The sponge's tunnels swallow light fastest: their far end is black.
	let fogScale = select(0.5, 1.1, s.world == 3);
	col = col * exp(-h.t / reach * fogK * fogScale);
	return col;
}

fn renderSlot(uv: vec2<f32>, s: Slot) -> vec3<f32> {
	switch (s.world) {
		case 0: { return bloomWorld(uv, s); }
		case 1: { return spiralWorld(uv, s); }
		case 2: { return yantraWorld(uv, s); }
		default: { return render3d(uv, s); }
	}
}

fn luma(c: vec3<f32>) -> f32 {
	return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let res = params.view.xy;
	let frag = in.uv * res;
	let uv = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / max(res.y, 1.0);
	let a = renderSlot(uv, slotA());
	var color = a;
	let m = params.slotA.w;
	if (m > 0.0005) {
		let b = renderSlot(uv, slotB());
		// The new world opens out of the centre and through the old one's
		// structure, never as a flat dissolve.
		let r = length(uv) * 1.25;
		let seed = params.slotB.w;
		let swirl = sin(atan2(uv.y, uv.x) * 3.0 + seed * TAU) * 0.08;
		let lead = (luma(b) - luma(a)) * 0.25;
		let reveal = clamp(m * 1.6 - r * 0.6 + swirl + lead, 0.0, 1.0);
		color = mix(a, b, reveal);
	}
	color = color * params.tone.w;
	return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;

const POST_COMMON_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${FULLSCREEN_WGSL}
`;

/**
 * Feedback: the previous frame zoomed about the vanishing point and rolled
 * with the travel, decayed, and max-blended with the new scene, so lit
 * filigree leaves short trails streaming along the flight.
 */
export const MANDALA_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;
@group(0) @binding(3) var previousTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspect = params.view.x / max(params.view.y, 1.0);
	let vanish = params.postB.xy;
	var rel = (in.uv - vanish) * vec2<f32>(aspect, 1.0);
	let c = cos(params.postB.z);
	let s = sin(params.postB.z);
	rel = vec2<f32>(rel.x * c - rel.y * s, rel.x * s + rel.y * c) * params.post.y;
	let previousUv = vanish + rel / vec2<f32>(aspect, 1.0);
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.02, edge);
	let previous = textureSampleLevel(previousTexture, linearSampler, previousUv, 0.0).rgb;
	let scene = textureSampleLevel(sceneTexture, linearSampler, in.uv, 0.0).rgb;
	return vec4<f32>(max(previous * params.post.x * border, scene), 1.0);
}
`;

/**
 * Highlight meter: the mean and the average of the brightest samples on a
 * coarse grid, eased with the previous frame's reading, all on the GPU. The
 * composite uses it only to bring exposure down when highlights would clip;
 * it never lifts a dark frame.
 */
export const MANDALA_EXPOSURE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var frameTexture: texture_2d<f32>;
@group(0) @binding(3) var previousTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	var sum = 0.0;
	var top = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
	for (var y = 0; y < 12; y = y + 1) {
		for (var x = 0; x < 20; x = x + 1) {
			let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) / vec2<f32>(20.0, 12.0);
			let c = textureSampleLevel(frameTexture, linearSampler, uv, 0.0).rgb;
			var l = max(c.r, max(c.g, c.b));
			sum = sum + dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
			// Keep the eight brightest samples (insertion into a sorted list).
			for (var k = 0; k < 8; k = k + 1) {
				if (l > top[k]) {
					let held = top[k];
					top[k] = l;
					l = held;
				}
			}
		}
	}
	var peak = 0.0;
	for (var k = 0; k < 8; k = k + 1) {
		peak = peak + top[k] / 8.0;
	}
	let mean = sum / 240.0;
	let previous = textureSampleLevel(previousTexture, linearSampler, vec2<f32>(0.5, 0.5), 0.0);
	// First frames (or a reset) have nothing to ease from.
	let fresh = select(0.0, 1.0, previous.a < 0.5);
	let k = mix(params.mood.y, 1.0, fresh);
	return vec4<f32>(mix(previous.r, mean, k), mix(previous.g, peak, k), 0.0, 1.0);
}
`;

export const MANDALA_BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / max(params.view.xy, vec2<f32>(1.0));
	var color = textureSampleLevel(sourceTexture, linearSampler, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, linearSampler, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, linearSampler, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0).rgb;
	color = color + textureSampleLevel(sourceTexture, linearSampler, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0).rgb;
	color = color * 0.25;
	let bright = max(color.r, max(color.g, color.b));
	let knee = max(0.0, bright - params.post.z);
	return vec4<f32>(color * (knee / max(1e-4, bright)), 1.0);
}
`;

function blurShader(directionX: number, directionY: number) {
	return /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 3.0 / max(params.view.xy, vec2<f32>(1.0));
	let direction = vec2<f32>(${directionX.toFixed(1)}, ${directionY.toFixed(1)}) * texel;
	var color = textureSampleLevel(sourceTexture, linearSampler, in.uv, 0.0).rgb * 0.227027;
	color = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction, 0.0).rgb
		+ textureSampleLevel(sourceTexture, linearSampler, in.uv - direction, 0.0).rgb) * 0.1945946;
	color = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction * 2.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, linearSampler, in.uv - direction * 2.0, 0.0).rgb) * 0.1216216;
	color = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction * 3.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, linearSampler, in.uv - direction * 3.0, 0.0).rgb) * 0.054054;
	color = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction * 4.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, linearSampler, in.uv - direction * 4.0, 0.0).rgb) * 0.016216;
	return vec4<f32>(color, 1.0);
}
`;
}

export const MANDALA_BLUR_H_WGSL = blurShader(1, 0);
export const MANDALA_BLUR_V_WGSL = blurShader(0, 1);

export const MANDALA_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var frameTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;
@group(0) @binding(4) var exposureTexture: texture_2d<f32>;

// Filmic curve with a true black toe: zero stays zero.
fn filmic(x: vec3<f32>) -> vec3<f32> {
	let a = 2.51;
	let b = 0.03;
	let c = 2.43;
	let d = 0.59;
	let e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);
	// Lens: a touch of curvature that only ever samples inside the frame,
	// aberration that grows toward the rim.
	let warped = 0.5 + centered * (1.0 - r2 * 0.05);
	let caAmount = (0.0002 + r2 * 0.0024) * params.post.w;
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let scene = vec3<f32>(
		textureSampleLevel(frameTexture, linearSampler, warped + direction * caAmount, 0.0).r,
		textureSampleLevel(frameTexture, linearSampler, warped, 0.0).g,
		textureSampleLevel(frameTexture, linearSampler, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTexture, linearSampler, warped, 0.0).rgb;
	// Exposure only ever comes down, when the brightest structure would
	// clip; a dark frame stays dark.
	let metered = textureSampleLevel(exposureTexture, linearSampler, vec2<f32>(0.5, 0.5), 0.0);
	let peak = max(metered.g, 1e-4);
	let average = max(metered.r, 1e-4);
	let protect = clamp(min(params.mood.x / peak, params.mood.w / average), 0.4, 1.0);
	let exposure = params.postB.w * protect;
	let vignette = 1.0 - smoothstep(0.45, 1.05, length(centered * vec2<f32>(resolution.x / max(resolution.y, 1.0), 1.0)) * params.postC.z);
	var color = (scene + bloom * params.postC.x) * exposure * (0.8 + vignette * 0.2);
	// Saturation around luminance, before the curve, keeps jewel colour rich.
	let l = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
	color = max(vec3<f32>(l) + (color - vec3<f32>(l)) * params.pal3.w, vec3<f32>(0.0));
	color = filmic(color);
	color = max((color - 0.5) * params.postC.y + 0.5, vec3<f32>(0.0));
	color = color + (ign(in.uv * resolution, params.view.z) - 0.5) * (params.postC.w / 255.0);
	return vec4<f32>(color, 1.0);
}
`;

export const MANDALA_SCENE_WGSL = SCENE_WGSL;
