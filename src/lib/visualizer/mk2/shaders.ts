// Soma's renderer: one raymarched animal (plus an optional juvenile) built
// from a single parametric body plan, in an analytic underwater world, then
// the shared post language: ping-pong max-blend feedback, half-res bloom with
// two blur rounds, depth of field, r-squared chromatic aberration, a planar
// mirror, ACES, dither.
//
// The water is a participating medium, not a backdrop: every path through it
// is absorbed per channel (red first, so distance turns things blue or green),
// and light only comes from real sources: the animal's own bioluminescence
// (which lights the water around it, the marine snow and the seabed with an
// inverse-square falloff), far animals, vents and, only where the world is
// shallow enough to have it, downwelling light from the surface with its
// shafts and caustics. In the abyss and the void the water is black except
// where something living lights it.
//
// WGSL notes for whoever edits this: with layout 'auto' every declared binding
// must be used from the entry point; never put a backtick in a comment inside
// these template literals (it ends the string and breaks the shader silently).

/** Uniform vec4 slots, in order. The WGSL struct is generated from this list. */
export const SOMA_UNIFORM_FIELDS = [
	'frame', // scene width, scene height, look time, frame index
	'outp', // output width, output height, aspect, quality tier 0..2
	'audio', // bass, mid, treble, energy
	'beat', // beat phase, contraction, packet strength, impact
	'beat2', // kick, sparkle, silence, beat count
	'camPos', // xyz, focal
	'camRight', // xyz, focus distance
	'camUp', // xyz, aperture
	'camFwd', // xyz, dof taps
	'lens', // shift x, shift y, fog, exposure
	'orgPos', // xyz, bound radius
	'orgX', // body x axis, sway phase
	'orgY', // body y axis (apex), fin phase
	'orgZ', // body z axis, growth
	'orgBound', // bound centre xyz, world size
	'body0', // bellR, bellH, bellOpen, bellNeck
	'body1', // lobeAmp, squash, fin, stalk
	'tent0', // tentLen, tentThick, tentDir, tentRoot
	'tent1', // tentRootY, tentCurl, tentWave, tipBulb
	'app', // oral, cerata, water current phase, comb-row phase
	'chain0', // chainCount, chainSpacing, chainTaper, chainCurve
	'chain1', // chain dir xyz, size
	'skin0', // lattice, combs, chromato, opacity
	'skin1', // spines, iridescence, rimGlow, organGlow
	'organs', // gonad, canal, nucleus, vacuole
	'photo', // body spots, rim ring, appendages, note gain
	'posture', // pitch, dwell, jet, undulate
	'counts', // lobes, lobe fade, arms, arm fade
	'modes', // beat form from, to, mix, shedding
	'env', // environment from, to, mix, floor y
	'envB', // surface y, reflect, snow, shafts
	'keyDir', // towards the key light, key power
	'keyCol', // key colour, ambient
	'water',
	'haze',
	'bodyCol',
	'glow',
	'accent',
	'organ',
	'post', // feedback fade, bloom threshold, aberration, bloom gain
	'orgScreen', // animal uv x, y, plankton layer height (world y), plankton layer density
	'mood', // agitation, punch, calm, pulse (what kind of music the animal hears)
	'medium', // per-channel extinction rgb (fog x absorption), downwelling light
	'flow', // snow drift phase, animal light power, far-life density, shiver phase
	'march', // steps, shadow steps, interior steps, particle cells
	'comp', // companion xyz, relative scale
	'drag', // swim velocity in body space (appendages trail it), iridescent film phase
	'seeds', // seed, layout seed, reflection plane y, reflection mode (0 floor, 1 surface)
	'debug' // dev-only profiling mask (1 no animal, 2 no world, 4 no particles, 8 no shadow/interior, 16 part ids)
] as const;

export type SomaUniformField = (typeof SOMA_UNIFORM_FIELDS)[number];
export const SOMA_UNIFORM_OFFSETS = Object.fromEntries(
	SOMA_UNIFORM_FIELDS.map((name, index) => [name, index * 4])
) as Record<SomaUniformField, number>;
export const SOMA_UNIFORM_FLOATS = SOMA_UNIFORM_FIELDS.length * 4;
export const SOMA_UNIFORM_BYTES = SOMA_UNIFORM_FLOATS * 4;
/** 64 note levels followed by 64 note onsets. */
export const SOMA_BIN_COUNT = 128;

const UNIFORMS_WGSL = /* wgsl */ `
struct Uniforms {
${SOMA_UNIFORM_FIELDS.map((name) => `	${name}: vec4<f32>,`).join('\n')}
};
`;

const COMMON_WGSL = /* wgsl */ `
${UNIFORMS_WGSL}
const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;

fn pcg3(v0: vec3<u32>) -> vec3<u32> {
	var v = v0 * 1664525u + vec3<u32>(1013904223u);
	v.x = v.x + v.y * v.z;
	v.y = v.y + v.z * v.x;
	v.z = v.z + v.x * v.y;
	v = v ^ (v >> vec3<u32>(16u));
	v.x = v.x + v.y * v.z;
	v.y = v.y + v.z * v.x;
	v.z = v.z + v.x * v.y;
	return v;
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
	let q = bitcast<vec3<u32>>(vec3<i32>(floor(p)));
	return vec3<f32>(pcg3(q) & vec3<u32>(0xffffffu)) / 16777215.0;
}

fn vnoise(p: vec3<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	let a = hash33(i).x;
	let b = hash33(i + vec3<f32>(1.0, 0.0, 0.0)).x;
	let c = hash33(i + vec3<f32>(0.0, 1.0, 0.0)).x;
	let d = hash33(i + vec3<f32>(1.0, 1.0, 0.0)).x;
	let e = hash33(i + vec3<f32>(0.0, 0.0, 1.0)).x;
	let g = hash33(i + vec3<f32>(1.0, 0.0, 1.0)).x;
	let h = hash33(i + vec3<f32>(0.0, 1.0, 1.0)).x;
	let k = hash33(i + vec3<f32>(1.0, 1.0, 1.0)).x;
	return mix(mix(mix(a, b, w.x), mix(c, d, w.x), w.y), mix(mix(e, g, w.x), mix(h, k, w.x), w.y), w.z);
}

fn gauss(x: f32, width: f32) -> f32 {
	let z = x / width;
	return exp(-z * z);
}

fn camRay(p: vec2<f32>) -> vec3<f32> {
	return normalize(u.camFwd.xyz * u.camPos.w + u.camRight.xyz * (p.x - u.lens.x) + u.camUp.xyz * (p.y - u.lens.y));
}

/** World point to output uv (x right, y down); z < 0 when behind the camera. */
fn project(x: vec3<f32>, aspect: f32) -> vec3<f32> {
	let v = x - u.camPos.xyz;
	let z = dot(v, u.camFwd.xyz);
	let px = dot(v, u.camRight.xyz) / max(z, 1e-3) * u.camPos.w + u.lens.x;
	let py = dot(v, u.camUp.xyz) / max(z, 1e-3) * u.camPos.w + u.lens.y;
	return vec3<f32>(px / aspect + 0.5, 0.5 - py, z);
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

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
export const SOMA_SCENE_WGSL = /* wgsl */ `
${COMMON_WGSL}
${FULLSCREEN_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, 128>;

struct Sample {
	d: f32,
	part: f32,
	u: f32,
	seg: f32,
};

struct App {
	d: f32,
	k: f32,
	bulb: f32,
};

fn sdEllipsoid(p: vec3<f32>, r: vec3<f32>) -> f32 {
	let k0 = length(p / r);
	let k1 = length(p / (r * r));
	return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

fn sdRoundCylY(p: vec3<f32>, r: f32, h: f32, rb: f32) -> f32 {
	let d = vec2<f32>(length(p.xz) - r + rb, abs(p.y) - h + rb);
	return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0))) - rb;
}

// Written as a weighted sum, not mix(): HLSL's lerp is b + h * (a - b), and
// with an absent part (b = 1e5) that cancels catastrophically, quantizing the
// whole body's distance to the f32 spacing near 1e5 (about 0.008) and
// banding its shading into bright moire.
fn smin(a: f32, b: f32, k: f32) -> f32 {
	let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return a * h + b * (1.0 - h) - k * h * (1.0 - h);
}

fn rotY(p: vec3<f32>, a: f32) -> vec3<f32> {
	let c = cos(a);
	let s = sin(a);
	return vec3<f32>(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

fn note(x: f32) -> f32 {
	let i = clamp(i32(x * 56.0) + 4, 0, 63);
	return bins[i];
}

fn onset(x: f32) -> f32 {
	let i = clamp(i32(x * 56.0) + 4, 0, 63);
	return bins[64 + i];
}

/** Transmittance of a path of length t through the water, per channel. */
fn absorb(t: f32) -> vec3<f32> {
	return exp(-u.medium.xyz * max(t, 0.0));
}

// A ring of n appendages in the body's own frame: tentacles, arms, axopodia,
// oral arms, a lure. Polar repetition keeps the cost of one.
fn appendage(q: vec3<f32>, n: f32, rootR: f32, rootY: f32, dirA: f32, len: f32, thick: f32, curl: f32, wave: f32, phase: f32, frill: f32, bulbR: f32) -> App {
	var o: App;
	o.d = 1e5;
	o.k = 0.0;
	o.bulb = 0.0;
	if (n < 0.5 || len < 0.01) {
		return o;
	}
	let stepA = TAU / n;
	let phi = atan2(q.z, q.x);
	let idx = round(phi / stepA);
	let a = idx * stepA;
	let qs = rotY(q, a);
	let dir = vec3<f32>(sin(dirA), cos(dirA), 0.0);
	let nrm = vec3<f32>(cos(dirA), -sin(dirA), 0.0);
	let v = qs - vec3<f32>(rootR, rootY, 0.0);
	let s = clamp(dot(v, dir), 0.0, len);
	let k = s / len;
	let ph = idx * 2.39996 + phase;
	let tw = u.orgX.w;
	let halfW = sin(min(stepA * 0.5, 1.2)) * 0.8;
	let w1 = sin(k * 4.6 - tw * 1.35 + ph);
	let w2 = sin(k * 3.2 - tw * 0.95 + ph * 1.7);
	let radial = abs(rootR + dir.x * s);
	let zmax = max(0.015, radial * halfW);
	let zoff = clamp(wave * 0.13 * len * k * w2, -zmax, zmax);
	let nOff = curl * k * k * len * 0.32 + wave * 0.09 * len * k * w1;
	// Appendages stream behind the swim: drag bends them away from the travel.
	let dragS = rotY(u.drag.xyz, a);
	var rel = v - dir * s - nrm * nOff - vec3<f32>(0.0, 0.0, zoff) + dragS * (k * k * len * 1.4);
	var th = thick * (1.0 - 0.7 * k);
	if (frill > 0.001) {
		th = th * (1.0 + frill * 0.55 * sin(k * 26.0 + tw * 2.0 + ph));
		rel = rel * vec3<f32>(1.0, 1.0, 1.8);
	}
	o.d = (length(rel) - th) * 0.7;
	o.k = k;
	if (bulbR > 0.001) {
		let e1 = sin(4.6 - tw * 1.35 + ph);
		let e2 = sin(3.2 - tw * 0.95 + ph * 1.7);
		let zt = max(0.015, abs(rootR + dir.x * len) * halfW);
		let tip = dir * len + nrm * (curl * len * 0.32 + wave * 0.09 * len * e1) + vec3<f32>(0.0, 0.0, clamp(wave * 0.13 * len * e2, -zt, zt)) - dragS * len * 1.4;
		let bd = length(v - tip) - bulbR * (0.9 + 0.2 * u.beat2.x);
		if (bd < o.d) {
			o.d = bd;
			o.k = 1.0;
			o.bulb = 1.0;
		}
	}
	return o;
}

// One zooid of the body plan in its own frame (y = apex axis, x = dorsal).
fn unit(q: vec3<f32>, seg: f32) -> Sample {
	var s: Sample;
	let R = u.body0.x;
	let H = u.body0.y;
	let open = u.body0.z;
	let neck = u.body0.w;
	let lobeAmp = u.body1.x * u.counts.y;
	let squash = u.body1.y;
	let fin = u.body1.z;
	let stalk = u.body1.w;
	let pulse = u.beat.y * (0.25 + 0.75 * u.posture.z);
	let segPhase = seg * 0.9;
	let phi = atan2(q.z, q.x);
	let yN = clamp(q.y / max(H, 0.05), -1.3, 1.3);
	let marginW = smoothstep(0.55, -0.9, yN);
	let lobe = 1.0 - lobeAmp * (0.5 - 0.5 * cos(u.counts.x * phi)) * marginW;
	let breath = 1.0 + 0.02 * sin(u.orgX.w * 0.7 + segPhase);
	let rr = R * lobe * (1.0 - pulse * 0.2 * marginW) * breath;
	let hh = H * (1.0 + pulse * 0.07);
	var d = sdEllipsoid(q, vec3<f32>(rr * squash, hh, rr));
	if (neck > 0.01) {
		d = mix(d, sdRoundCylY(q, rr * 0.86, hh * 0.92, rr * 0.25), neck);
	}
	if (open > 0.01) {
		let ri = vec3<f32>(rr * squash * 0.88, hh * 0.84, rr * 0.88) * mix(0.05, 1.0, open);
		d = max(d, -sdEllipsoid(q - vec3<f32>(0.0, -hh * (0.15 + 0.45 * open), 0.0), ri));
		let tube = rr * 0.66 * smoothstep(0.2, 0.6, neck) * open;
		if (tube > 0.01) {
			d = max(d, tube - length(q.xz));
		}
	}
	d = d - u.skin0.y * 0.012 * smoothstep(0.86, 1.0, cos(8.0 * phi)) * (1.0 - abs(yN));
	// Agitation: the membrane shivers in fine ridges.
	d = d - u.mood.x * 0.012 * sin(phi * 9.0 + q.y * 11.0 + u.flow.w) * (1.0 - abs(yN) * 0.5);
	s.d = d;
	s.part = 0.0;
	s.u = clamp(0.5 - 0.5 * yN, 0.0, 1.0);
	s.seg = seg;

	if (fin > 0.01) {
		let az = abs(q.z);
		let wave = sin(q.y * 6.0 - u.orgY.w + az * 4.0) * 0.07 * fin * smoothstep(rr * 0.5, rr * 1.5, az);
		let fd = sdEllipsoid(q - vec3<f32>(wave, -0.04 * hh, 0.0), vec3<f32>(rr * squash * 0.16 + 0.015, hh * 0.94, rr * (1.0 + 0.5 * fin)));
		if (fd < s.d) {
			s.part = 9.0;
			s.u = clamp(0.5 - 0.5 * yN, 0.0, 1.0);
		}
		s.d = smin(s.d, fd, 0.05);
	}
	if (stalk > 0.01) {
		let top = hh * 0.8;
		let sy = clamp(q.y - top, 0.0, stalk);
		let bend = vec2<f32>(sin(sy * 1.7 + u.orgX.w * 0.6), cos(sy * 1.3 + u.orgX.w * 0.5)) * 0.06 * sy;
		let sd = length(q - vec3<f32>(bend.x, top + sy, bend.y)) - (0.05 + 0.08 * R) * (1.0 - 0.3 * sy / stalk);
		if (sd < s.d) {
			s.part = 6.0;
			s.u = -sy / stalk;
		}
		s.d = smin(s.d, sd, 0.06);
	}
	if (u.skin0.x > 0.01) {
		let f = 7.5;
		let qq = q * f;
		let g = abs(dot(sin(qq), cos(qq.yzx))) / f * 0.7 - 0.035;
		let shell = abs(s.d + 0.03) - 0.032;
		let lat = max(shell, g);
		let cap = length(q) - R * 0.42 * (1.0 + 0.08 * u.beat2.x);
		let ld = min(lat, cap);
		if (u.skin0.x > 0.5) {
			s.part = select(4.0, 5.0, cap < lat);
		}
		s.d = mix(s.d, ld, u.skin0.x);
	}
	if (u.skin1.x > 0.01) {
		let r = length(q);
		let dq = q / max(r, 1e-4);
		let theta = acos(clamp(dq.y, -1.0, 1.0));
		let bands = 7.0;
		let ti = clamp(round(theta / PI * bands), 1.0, bands - 1.0);
		let th0 = ti / bands * PI;
		let nphi = max(3.0, round(sin(th0) * 14.0));
		let ph = atan2(dq.z, dq.x) + ti * 0.7;
		let p0 = round(ph / TAU * nphi) / nphi * TAU - ti * 0.7;
		let sd = vec3<f32>(sin(th0) * cos(p0), cos(th0), sin(th0) * sin(p0));
		let lenS = R * (1.0 + 0.45 * u.skin1.x);
		let a = clamp(dot(q, sd), R * 0.8, lenS);
		let spd = length(q - sd * a) - 0.022 * (1.0 - (a - R * 0.8) / max(lenS - R * 0.8, 1e-3)) - 0.003;
		if (spd < s.d) {
			s.part = 10.0;
			s.u = 1.0;
		}
		s.d = min(s.d, spd);
	}
	// Tentacles (set 0) and frilled oral arms (set 1) share one call site, so
	// the shader compiler inlines the appendage once.
	let armN = u.counts.z;
	let armF = u.counts.w;
	let margin = R * (1.0 - pulse * 0.2);
	let sets = select(1, 2, u.app.x > 0.01);
	for (var limb = 0; limb < sets; limb = limb + 1) {
		let oral = limb == 1;
		let n = select(select(0.0, armN, armF > 0.01), 4.0, oral);
		let bulb = select(select(0.0, (0.02 + 0.055 * u.tent1.w) * armF, u.tent1.w > 0.01), 0.0, oral);
		let ap = appendage(
			q,
			n,
			select(u.tent0.w * margin, R * 0.1, oral),
			select(u.tent1.x * hh, -hh * 0.15, oral),
			select(u.tent0.z - pulse * 0.2 * u.posture.z, PI - 0.08, oral),
			select(u.tent0.x * armF, u.tent0.x * 0.42 * u.app.x, oral),
			select(u.tent0.y * (0.4 + 0.6 * armF), 0.05 * R * (0.6 + 0.4 * u.app.x) + 0.02, oral),
			select(u.tent1.y, 0.25, oral),
			select(u.tent1.z, u.tent1.z * 0.7, oral),
			select(segPhase + u.seeds.x * 6.0, segPhase + 1.3, oral),
			select(0.0, 1.0, oral),
			bulb
		);
		if (ap.d < s.d) {
			s.part = select(select(1.0, 8.0, ap.bulb > 0.5), 2.0, oral);
			s.u = ap.k;
		}
		s.d = smin(s.d, ap.d, select(0.03, 0.04, oral));
	}
	if (u.app.y > 0.01) {
		let stepC = 0.42;
		let ai = clamp(round(phi / stepC), -3.0, 3.0);
		let qs = rotY(q, ai * stepC);
		let ca = cos(ai * stepC);
		let sa = sin(ai * stepC);
		let spacing = 0.16;
		let yi = clamp(round(q.y / spacing) * spacing, -hh * 0.8, hh * 0.75);
		let prof = sqrt(max(0.0, 1.0 - (yi / hh) * (yi / hh)));
		let ra = rr * prof / sqrt(ca * ca / (squash * squash) + sa * sa);
		let lenC = (0.16 + 0.2 * prof) * u.app.y;
		let dirc = normalize(vec3<f32>(1.0, -0.25, 0.0));
		let v = vec3<f32>(qs.x - ra * 0.92, q.y - yi, qs.z);
		let sc = clamp(dot(v, dirc), 0.0, lenC);
		let kk = sc / max(lenC, 1e-3);
		let sw = vec3<f32>(0.0, 0.0, sin(u.orgX.w * 1.4 + yi * 9.0 + ai) * 0.03 * kk);
		let cd = (length(v - dirc * sc - sw) - 0.04 * (1.0 - 0.6 * kk) * u.app.y) * 0.75;
		if (cd < s.d) {
			s.part = 7.0;
			s.u = kk;
		}
		s.d = smin(s.d, cd, 0.03);
	}
	return s;
}

fn chainDir() -> vec3<f32> {
	return normalize(u.chain1.xyz + vec3<f32>(0.0, 1e-4, 0.0));
}

fn chainGrow(i: f32) -> f32 {
	return select(1.0, smoothstep(0.0, 1.0, clamp(u.chain0.x - i, 0.0, 1.0)), i > 0.5);
}

fn chainPos(i: f32, dir: vec3<f32>) -> vec3<f32> {
	let g = chainGrow(i);
	// A bud slides out of its parent as it grows: division, not a pop.
	let along = select(0.0, (i - 1.0 + g) * u.chain0.y, i > 0.5);
	let side = normalize(cross(dir, select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(dir.z) > 0.9)));
	let bin = cross(dir, side);
	let tw = u.orgX.w;
	let curve = u.chain0.w;
	return dir * along + side * (curve * 0.42 * sin(i * 0.95 - tw * 0.6)) + bin * (curve * 0.28 * cos(i * 0.7 - tw * 0.45));
}

fn chainScale(i: f32) -> f32 {
	return pow(u.chain0.z, i) * select(1.0, mix(0.12, 1.0, chainGrow(i)), i > 0.5);
}

fn bodyLocal(pw: vec3<f32>, center: vec3<f32>, scale: f32) -> vec3<f32> {
	let rel = (pw - center) / scale;
	return vec3<f32>(dot(rel, u.orgX.xyz), dot(rel, u.orgY.xyz), dot(rel, u.orgZ.xyz));
}

fn organism(pw: vec3<f32>, center: vec3<f32>, scale: f32) -> Sample {
	let q = bodyLocal(pw, center, scale);
	let chained = u.chain0.x >= 1.02;
	let dir = chainDir();
	let last = ceil(u.chain0.x) - 1.0;
	// Always a neighbouring pair: beyond the last spacing the pair is (last-1,
	// last), so a bud that is still tiny never hides its parent's appendages.
	let i0 = select(0.0, clamp(floor(dot(q, dir) / u.chain0.y), 0.0, max(last - 1.0, 0.0)), chained);
	let members = select(1, 2, chained && i0 + 1.0 <= last);
	var s: Sample;
	s.d = 1e5;
	s.part = 0.0;
	s.u = 0.0;
	s.seg = 0.0;
	for (var j = 0; j < members; j = j + 1) {
		let i = i0 + f32(j);
		let sc = select(1.0, chainScale(i), chained);
		let offset = select(vec3<f32>(0.0), chainPos(i, dir), chained);
		var c = unit((q - offset) / sc, i);
		c.d = c.d * sc;
		if (j == 0) {
			s = c;
		} else {
			let dd = smin(s.d, c.d, 0.1 * u.chain0.y);
			if (c.d < s.d) {
				s = c;
			}
			s.d = dd;
		}
	}
	s.d = s.d * scale;
	return s;
}

fn compCenter() -> vec3<f32> {
	return u.comp.xyz + (u.orgBound.xyz - u.orgPos.xyz) * u.comp.w;
}

fn mapS(p: vec3<f32>) -> Sample {
	var s: Sample;
	s.d = 1e5;
	s.part = 0.0;
	s.u = 0.0;
	s.seg = 0.0;
	let animals = select(1, 2, u.comp.w > 0.01);
	for (var k = 0; k < animals; k = k + 1) {
		let young = k == 1;
		let bc = select(u.orgBound.xyz, compCenter(), young);
		let br = select(u.orgPos.w, u.orgPos.w * u.comp.w, young);
		let bd = length(p - bc) - br;
		if (bd >= s.d) {
			continue;
		}
		if (bd > 0.25) {
			// Outside the bounding sphere its distance is a safe step.
			s.d = bd;
			continue;
		}
		var c = organism(p, select(u.orgPos.xyz, u.comp.xyz, young), select(u.orgBound.w, u.orgBound.w * u.comp.w, young));
		if (young) {
			c.seg = c.seg + 100.0;
		}
		if (c.d < s.d) {
			s = c;
		}
	}
	return s;
}

fn mapD(p: vec3<f32>) -> f32 {
	return mapS(p).d;
}

fn calcNormal(p: vec3<f32>, t: f32) -> vec3<f32> {
	let e = 0.0012 * max(1.0, t * 0.5);
	var n = vec3<f32>(0.0);
	let taps = select(4, 0, u.march.x < 0.0);
	for (var i = 0; i < taps; i = i + 1) {
		let k = vec3<f32>(f32(((i + 3) >> 1u) & 1), f32((i >> 1u) & 1), f32(i & 1)) * 2.0 - 1.0;
		n = n + k * mapD(p + k * e);
	}
	return normalize(n + vec3<f32>(0.0, 1e-6, 0.0));
}

fn softShadow(p: vec3<f32>, l: vec3<f32>, steps: i32) -> f32 {
	var res = 1.0;
	var t = 0.05;
	for (var i = 0; i < 16; i = i + 1) {
		if (i >= steps) {
			break;
		}
		let h = mapD(p + l * t);
		res = min(res, 7.0 * h / t);
		t = t + clamp(h, 0.05, 0.45);
		if (res < 0.02 || t > 5.0) {
			break;
		}
	}
	return clamp(res, 0.0, 1.0);
}

fn sphereHit(ro: vec3<f32>, rd: vec3<f32>, c: vec3<f32>, r: f32) -> vec2<f32> {
	let oc = ro - c;
	let b = dot(oc, rd);
	let cc = dot(oc, oc) - r * r;
	let h = b * b - cc;
	if (h < 0.0) {
		return vec2<f32>(1e5, -1.0);
	}
	let sh = sqrt(h);
	return vec2<f32>(max(0.0, -b - sh), -b + sh);
}

// Thin-film colours for comb rows and nacre: six hand-picked stops.
fn film(x: f32) -> vec3<f32> {
	var stops = array<vec3<f32>, 6>(
		vec3<f32>(0.9, 0.2, 0.7),
		vec3<f32>(0.4, 0.25, 1.0),
		vec3<f32>(0.1, 0.85, 1.0),
		vec3<f32>(0.3, 1.0, 0.45),
		vec3<f32>(1.0, 0.8, 0.25),
		vec3<f32>(1.0, 0.35, 0.4)
	);
	let t = fract(x) * 6.0;
	let i = i32(floor(t)) % 6;
	let j = (i + 1) % 6;
	let f = smoothstep(0.0, 1.0, fract(t));
	return mix(stops[i], stops[j], f);
}

fn voro(p: vec3<f32>) -> vec2<f32> {
	let ip = floor(p);
	let fp = fract(p);
	var best = 9.0;
	var id = 0.0;
	for (var z = -1; z <= 1; z = z + 1) {
		for (var y = -1; y <= 1; y = y + 1) {
			for (var x = -1; x <= 1; x = x + 1) {
				let o = vec3<f32>(f32(x), f32(y), f32(z));
				let h = hash33(ip + o);
				let r = o + h * 0.8 + 0.1 - fp;
				let d = dot(r, r);
				if (d < best) {
					best = d;
					id = h.z;
				}
			}
		}
	}
	return vec2<f32>(sqrt(best), id);
}

/** Unit-local coordinates of the nearest colony member, and its index. */
fn unitLocal(q: vec3<f32>) -> vec4<f32> {
	if (u.chain0.x < 1.02) {
		return vec4<f32>(q, 0.0);
	}
	let dir = chainDir();
	let last = ceil(u.chain0.x) - 1.0;
	// Of the two members either side, the one whose body is nearest: a bud
	// that is still tiny only claims the points right at it, so the parent's
	// patterns never flip to the bud's coordinates as it starts to grow.
	let ia = clamp(floor(dot(q, dir) / u.chain0.y), 0.0, max(last - 1.0, 0.0));
	let ib = min(ia + 1.0, last);
	let sa = chainScale(ia);
	let sb = chainScale(ib);
	let la = (q - chainPos(ia, dir)) / sa;
	let lb = (q - chainPos(ib, dir)) / sb;
	let R = max(u.body0.x, u.body0.y);
	let pickB = (length(lb) - R) * sb < (length(la) - R) * sa;
	return select(vec4<f32>(la, ia), vec4<f32>(lb, ib), pickB);
}

fn heartbeat() -> f32 {
	let ph = u.beat.x;
	return (gauss(ph - 0.04, 0.05) + 0.7 * gauss(ph - 0.27, 0.06)) * u.beat.z;
}

fn formWeight(form: f32) -> f32 {
	let a = select(0.0, 1.0 - u.modes.z, abs(u.modes.x - form) < 0.5);
	let b = select(0.0, u.modes.z, abs(u.modes.y - form) < 0.5);
	return a + b;
}

/** Organs seen through the membrane: emission rgb and density. */
fn organField(qi: vec3<f32>, seg: f32, hb: f32) -> vec4<f32> {
	let R = u.body0.x;
	let H = u.body0.y;
	let inside = smoothstep(0.02, -0.05, sdEllipsoid(qi, vec3<f32>(R * u.body1.y, H, R)));
	if (inside <= 0.0) {
		return vec4<f32>(0.0);
	}
	var e = vec3<f32>(0.0);
	var dens = 0.05;
	let phi = atan2(qi.z, qi.x);
	// Organs pulse with the kick, but as a pulse: at most about 1.7x, never a strobe.
	let throb = 0.65 + 0.4 * u.beat2.x + hb * 0.6;
	if (u.organs.x > 0.01) {
		let a = round(phi / (TAU / 4.0)) * (TAU / 4.0);
		let qs = rotY(qi, a);
		let gd = length(vec3<f32>(qs.x - R * 0.42, (qs.y - H * 0.12) * 1.8, qs.z * 0.6)) - R * 0.17;
		let g = smoothstep(0.035, -0.035, gd) * u.organs.x;
		let man = smoothstep(0.03, -0.03, length(qi.xz) - R * 0.09) * smoothstep(-0.6, -0.2, qi.y / H) * smoothstep(0.35, 0.1, qi.y / H) * u.organs.x * 0.6;
		e = e + u.organ.rgb * (g + man) * throb;
		dens = dens + (g + man) * 2.0;
	}
	if (u.organs.y > 0.01) {
		let nC = max(u.counts.x, 4.0);
		let a = round(phi / (TAU / nC)) * (TAU / nC);
		let qs = rotY(qi, a);
		let along = clamp(0.5 - 0.5 * qi.y / H, 0.0, 1.0);
		let line = exp(-qs.z * qs.z / 0.0005) * smoothstep(0.1, 0.4, length(qi.xz) / R);
		let travel = gauss(along - u.beat.x * 1.5, 0.15) * u.beat.z;
		e = e + u.glow.rgb * line * u.organs.y * (0.12 + travel * 1.6 + note(along) * 0.6);
	}
	if (u.organs.z > 0.01) {
		let nd = length(qi - vec3<f32>(0.0, H * 0.05, 0.0)) - R * (0.24 + 0.05 * u.beat2.x);
		let nn = smoothstep(0.04, -0.04, nd) * u.organs.z;
		e = e + mix(u.organ.rgb, u.glow.rgb, 0.3) * nn * (0.55 + 0.35 * u.audio.x + hb * 0.6);
		dens = dens + nn * 3.0;
	}
	if (u.organs.w > 0.01) {
		let cq = qi * 5.0 + vec3<f32>(0.0, u.orgX.w * 0.15, seg * 3.1);
		let h = hash33(floor(cq));
		let f = fract(cq) - 0.5 - (h - 0.5) * 0.4;
		let vv = smoothstep(0.03, -0.03, length(f) - 0.2 * h.x) * step(0.45, h.y) * u.organs.w;
		e = e + u.accent.rgb * vv * (0.2 + note(h.z) * 1.6 + onset(h.z) * 2.0);
		dens = dens + vv * 1.5;
	}
	return vec4<f32>(e * inside * u.skin1.w, dens * inside);
}

fn packetBand(form: f32, arc: f32, phi: f32, seg: f32) -> f32 {
	let ph = u.beat.x;
	// Punchy music fires narrow, hard-edged packets; soft music broad ones.
	let w = mix(1.45, 0.6, u.mood.y);
	if (form < 0.5) {
		return gauss(arc - ph * 2.6 + 0.1, 0.08 * w);
	} else if (form < 1.5) {
		let pr = fract(ph * 2.0) * 1.6;
		return gauss(arc - pr, 0.1 * w) * (1.0 - 0.4 * floor(ph * 2.0));
	} else if (form < 2.5) {
		let x = fract(arc * 1.3 + phi / TAU - ph * 1.5);
		return gauss(x - 0.5, 0.07 * w);
	} else if (form < 3.5) {
		return gauss(arc - 0.5, 0.6) * 0.15;
	}
	// Cascade: colony members fire one after another, each as a band moving
	// down its own body. A single animal falls back to the descending band.
	let colony = smoothstep(1.05, 2.0, u.chain0.x);
	let member = gauss(seg - ph * (u.chain0.x + 0.5), 0.45) * gauss(arc - fract(ph * (u.chain0.x + 0.5)) * 2.0, 0.2);
	return mix(gauss(arc - ph * 2.6 + 0.1, 0.08), member, colony);
}

// The water at infinity: no backdrop, only the medium scattering whatever
// light reaches it toward the eye. Downwelling light (only where the world is
// shallow) scatters mostly forward (Henyey-Greenstein), returns faintly from
// below, and has crossed more water the further from the light it is seen, so
// it filters toward the water's colour. Without it the deep is nearly black.
// A deep scattering layer: a drifting slab of luminous plankton at some depth,
// patchy, carried by the current. It is real structure in the far field, lit
// by itself, and gives the black water a horizon of living light whose height
// in the frame follows the camera and the layer.
fn plankton(rd: vec3<f32>) -> vec3<f32> {
	let density = u.orgScreen.w;
	if (density < 0.002) {
		return vec3<f32>(0.0);
	}
	let ro = u.camPos.xyz;
	let yL = u.orgScreen.z;
	var acc = 0.0;
	var prev = 0.0;
	for (var i = 0; i < 6; i = i + 1) {
		let t = 1.5 * pow(1.8, f32(i));
		let p = ro + rd * t;
		let slab = exp(-pow((p.y - yL) / 1.3, 2.0));
		let q = p.xz * 0.11 + vec2<f32>(u.app.z * 0.35, -u.app.z * 0.2);
		let clump = smoothstep(0.35, 0.85, vnoise(vec3<f32>(q, p.y * 0.25 + u.app.z * 0.05)));
		let fade = exp(-dot(u.medium.xyz, vec3<f32>(0.33)) * t * 0.8);
		acc = acc + slab * (0.25 + 0.75 * clump) * fade * (t - prev);
		prev = t;
	}
	let tint = mix(u.accent.rgb, u.glow.rgb, 0.35);
	return tint * acc * density * 0.012 * (1.0 + 0.35 * u.beat2.y);
}

fn waterBg(rd: vec3<f32>) -> vec3<f32> {
	let l = u.keyDir.xyz;
	let mu = dot(rd, l);
	let g = 0.72;
	let hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5) / (4.0 * PI);
	// Daylight in water falls off steeply away from the light: looking up is
	// bright, a level view is dim, looking down is near black.
	let lit = pow(smoothstep(-0.75, 0.95, rd.y * sign(l.y + 1e-4)), 2.2);
	let path = 2.0 + 6.0 * (1.0 - lit);
	let down = u.medium.w * u.keyDir.w;
	// Almost no flat floor: lit water glows where it faces the light, not everywhere.
	let scatter = u.haze.rgb * u.keyCol.rgb * absorb(path) * down * (0.12 + 1.6 * lit + hg * 1.3);
	return u.water.rgb * 0.45 + scatter + plankton(rd);
}

// The beat light as the water sees it: the body fires on the beat, the water
// around it swells over the first part of the beat instead of stepping, so a
// dark world never strobes as a whole on every beat.
fn waterPulse() -> f32 {
	let ph = u.beat.x;
	return u.beat.z * smoothstep(0.0, 0.4, ph) * (1.0 - ph) * 1.35;
}

// The water lit by the animal itself: single scattering of a point light at
// the animal's centre along the view ray up to depth tMax, attenuated on both
// legs. Closed form of the inverse-square line integral (softened by the
// body's size), so it costs one atan pair. Its colour shifts with distance.
fn livingScatter(ro: vec3<f32>, rd: vec3<f32>, tMax: f32) -> vec3<f32> {
	let c = u.orgBound.xyz;
	let tc = clamp(dot(c - ro, rd), 0.0, tMax);
	let h = length(ro + rd * tc - c);
	let soft = max(h, u.orgPos.w * 0.45 + 0.2);
	let span = atan2(tMax - tc, soft) - atan2(-tc, soft);
	let flash = 0.7 + 0.5 * u.mood.z + (waterPulse() * (0.6 + 0.8 * u.mood.y) + u.beat2.x * 0.5) * (1.0 - 0.6 * u.mood.z);
	return u.glow.rgb * span / soft * absorb(tc + h) * u.flow.y * flash * 0.03 * (1.0 - u.beat2.z * 0.7);
}

struct EnvHit {
	col: vec3<f32>,
	t: f32,
	add: vec3<f32>,
};

fn ember() -> vec3<f32> {
	return mix(vec3<f32>(1.0, 0.34, 0.07), u.organ.rgb, 0.25);
}

fn orgLight() -> vec3<f32> {
	return u.glow.rgb * (0.12 + u.skin1.z * 0.15 + waterPulse() * 0.5 + u.audio.w * 0.15);
}

fn floorShade(p: vec3<f32>, rd: vec3<f32>, wVent: f32, wIce: f32, wKelp: f32) -> vec3<f32> {
	let l = u.keyDir.xyz;
	let key = u.keyCol.rgb * u.keyDir.w;
	let n1 = vnoise(vec3<f32>(p.xz * 1.3, 0.0));
	let n2 = vnoise(vec3<f32>(p.xz * 4.1, 3.0));
	let ripple = 0.5 + 0.5 * sin(p.x * 3.0 + p.z * 1.3 + n1 * 5.0);
	let silt = u.haze.rgb * 0.7 + u.water.rgb * 2.0;
	// The seabed only shows where light reaches it: downwelling light from
	// above (with caustics) in shallow worlds, the animal's own pool below.
	let down = u.medium.w;
	var col = silt * (0.35 + 0.4 * n1 + 0.2 * n2) * (0.85 + 0.3 * ripple) * (0.06 + 0.94 * down);
	let t = u.frame.z;
	let ca = vnoise(vec3<f32>(p.xz * 1.1 + vec2<f32>(t * 0.12, t * 0.07), t * 0.2));
	let cb = vnoise(vec3<f32>(p.xz * 1.6 - vec2<f32>(t * 0.09, -t * 0.05), 4.0 + t * 0.15));
	let caustic = pow(max(1.0 - abs(ca - cb) * 2.0, 0.0), 8.0);
	col = col + key * max(l.y, 0.0) * (0.06 + caustic * 0.16 * (u.envB.w + wKelp)) * silt * 4.0 * down;
	// Basalt and glowing fissures in a vent field.
	if (wVent > 0.001) {
		let crack = smoothstep(0.05, 0.0, abs(vnoise(vec3<f32>(p.xz * 0.7, 9.0)) - 0.5));
		let basalt = vec3<f32>(0.012, 0.01, 0.009) * (0.5 + n2);
		let glowC = ember() * crack * (0.35 + 0.65 * u.audio.x) * 0.6;
		col = mix(col, basalt + glowC, wVent);
	}
	// Ice: pale blue glaze with glints.
	if (wIce > 0.001) {
		// Lit only by what filters down through the ice, so it stays dim and mottled.
		let glaze = mix(u.haze.rgb * 1.6, vec3<f32>(0.05, 0.12, 0.16), 0.5) * (0.6 + 0.6 * n1) * (0.08 + 0.3 * down * (0.4 + 0.6 * caustic));
		col = mix(col, glaze, wIce);
	}
	// The animal's own light pools on the seabed beneath it.
	let dxz = p.xz - u.orgPos.xz;
	let h = max(0.3, u.orgPos.y - p.y);
	let pool = orgLight() * 1.6 * u.flow.y / (1.0 + dot(dxz, dxz) * 0.9 + h * h * 0.35) * absorb(sqrt(dot(dxz, dxz) + h * h));
	col = col + pool * (0.4 + 0.6 * silt * 8.0);
	return col;
}

fn ventEnv(ro: vec3<f32>, rd: vec3<f32>, w: f32, floorY: f32, fog: f32) -> EnvHit {
	var e: EnvHit;
	e.t = 1e5;
	e.col = vec3<f32>(0.0);
	e.add = vec3<f32>(0.0);
	let em = ember();
	for (var i = 0; i < 4; i = i + 1) {
		let h = hash33(vec3<f32>(f32(i) * 7.0 + 1.0, u.seeds.y * 97.0, 3.0));
		let ang = f32(i) * 1.7 + u.seeds.y * 6.28 + h.x;
		let rad = 7.5 + h.y * 7.0;
		let c = vec2<f32>(cos(ang), sin(ang)) * rad;
		let r = 0.45 + h.z * 0.5;
		let height = (2.2 + h.x * 3.2) * w;
		if (height < 0.05) {
			continue;
		}
		let top = floorY + height;
		let o = ro.xz - c;
		let dxz = rd.xz;
		let a = max(dot(dxz, dxz), 1e-6);
		let b = dot(o, dxz);
		let cc = dot(o, o) - r * r;
		let disc = b * b - a * cc;
		if (disc > 0.0) {
			let t = (-b - sqrt(disc)) / a;
			let y = ro.y + rd.y * t;
			if (t > 2.5 && y > floorY && y < top && t < e.t) {
				e.t = t;
				let p = ro + rd * t;
				let rough = vnoise(p * 3.0);
				let crack = smoothstep(0.06, 0.0, abs(vnoise(p * vec3<f32>(1.5, 0.6, 1.5)) - 0.5));
				let heat = smoothstep(top - 1.4, top, y);
				e.col = vec3<f32>(0.013, 0.011, 0.01) * (0.4 + rough) + em * (crack * 0.35 + heat * heat * 0.7) * (0.45 + 0.55 * u.audio.x);
			}
		}
		// A shimmering plume rising out of the mouth.
		let tl = max(0.0, -b / a);
		let pc = ro + rd * tl;
		let dl = length(pc.xz - c);
		let above = smoothstep(top - 0.2, top + 0.6, pc.y) * (1.0 - smoothstep(top + 2.0, top + 9.0, pc.y));
		let flow = vnoise(vec3<f32>(pc.x * 1.3, pc.y * 0.8 - u.frame.z * 0.9, pc.z * 1.3));
		let spread = r * r * 1.5 + max(pc.y - top, 0.0) * 0.25;
		e.add = e.add + em * exp(-dl * dl / spread) * above * (0.04 + 0.1 * flow) * w * absorb(tl);
	}
	return e;
}

fn kelpEnv(ro: vec3<f32>, rd: vec3<f32>, w: f32, floorY: f32) -> EnvHit {
	var e: EnvHit;
	e.t = 1e5;
	e.col = vec3<f32>(0.0);
	e.add = vec3<f32>(0.0);
	let l = u.keyDir.xyz;
	let key = u.keyCol.rgb * u.keyDir.w;
	for (var i = 0; i < 9; i = i + 1) {
		let h = hash33(vec3<f32>(f32(i) * 3.0 + 2.0, u.seeds.y * 53.0, 11.0));
		let ang = f32(i) * 0.71 + u.seeds.y * 4.0 + h.x * 0.5;
		let rad = 5.5 + h.y * 8.0;
		let base = vec2<f32>(cos(ang), sin(ang)) * rad;
		let top = floorY + (6.0 + h.z * 9.0) * w;
		if (top < floorY + 0.1) {
			continue;
		}
		var c = base;
		var width = 0.16 + h.x * 0.12;
		var hitT = -1.0;
		for (var it = 0; it < 2; it = it + 1) {
			let o = ro.xz - c;
			let a = max(dot(rd.xz, rd.xz), 1e-6);
			let b = dot(o, rd.xz);
			let cc = dot(o, o) - width * width;
			let disc = b * b - a * cc;
			if (disc < 0.0) {
				hitT = -1.0;
				break;
			}
			hitT = (-b - sqrt(disc)) / a;
			let y = ro.y + rd.y * hitT;
			let sway = sin(y * 0.45 + u.app.z + h.y * 6.0) * 0.45 * (y - floorY) / 10.0;
			c = base + vec2<f32>(sway, sway * 0.6);
			width = (0.16 + h.x * 0.12) * (0.7 + 0.6 * abs(sin(y * 2.3 + h.z * 9.0)));
		}
		if (hitT > 2.0 && hitT < e.t) {
			let p = ro + rd * hitT;
			if (p.y > floorY && p.y < top) {
				e.t = hitT;
				let n = normalize(vec3<f32>(p.x - c.x, 0.0, p.z - c.y));
				let edge = pow(1.0 - abs(dot(n, -rd)), 3.0);
				let back = pow(max(dot(rd, l), 0.0), 3.0);
				let vein = vnoise(vec3<f32>(p.y * 2.6, atan2(n.z, n.x) * 2.0, h.x * 9.0));
				let frond = (vec3<f32>(0.03, 0.04, 0.014) + u.bodyCol.rgb * 0.012) * (0.6 + 0.8 * vein);
				let height = smoothstep(floorY, top, p.y);
				let lit = key * (max(dot(n, l), 0.0) * 0.16 + back * 0.7 + edge * 0.25) * vec3<f32>(0.6, 0.9, 0.32) * (0.45 + 0.9 * vein);
				let bead = smoothstep(0.86, 0.98, sin(p.y * 3.1 + h.x * 20.0)) * smoothstep(0.3, 0.7, vein);
				e.col = frond + lit * (0.35 + 0.9 * height) + mix(u.accent.rgb, u.glow.rgb, 0.5) * bead * (0.06 + 0.25 * u.beat2.y);
			}
		}
	}
	return e;
}

fn iceEnv(ro: vec3<f32>, rd: vec3<f32>, w: f32) -> EnvHit {
	var e: EnvHit;
	e.t = 1e5;
	e.col = vec3<f32>(0.0);
	e.add = vec3<f32>(0.0);
	let radii = vec3<f32>(15.0, 9.0, 15.0) * mix(3.0, 1.0, w);
	let center = vec3<f32>(0.0, 1.5, 0.0);
	let o = (ro - center) / radii;
	let d = rd / radii;
	let a = dot(d, d);
	let b = dot(o, d);
	let c = dot(o, o) - 1.0;
	let disc = b * b - a * c;
	if (disc < 0.0) {
		return e;
	}
	let t = (-b + sqrt(disc)) / a;
	if (t <= 0.0) {
		return e;
	}
	e.t = t;
	let p = ro + rd * t;
	let n = -normalize((p - center) / (radii * radii));
	let v = voro(p * 0.55);
	let facet = 0.5 + 0.5 * sin(v.y * 40.0);
	let l = u.keyDir.xyz;
	let key = u.keyCol.rgb * u.keyDir.w;
	// Ice glows only with the daylight it pipes down from the cracks above, and
	// where the animal's own light reaches the wall.
	// Brighter toward the ceiling, where the cracks let the light in.
	let piped = smoothstep(-0.4, 0.95, (p.y - center.y) / radii.y);
	let deep = mix(vec3<f32>(0.006, 0.03, 0.055), u.haze.rgb * 1.4, 0.45) * (0.05 + 0.75 * u.medium.w * piped);
	var col = deep * (0.4 + 0.7 * facet) * (0.6 + 0.6 * smoothstep(0.05, 0.4, v.x));
	let toAnimal = length(p - u.orgBound.xyz);
	col = col + orgLight() * u.flow.y * (0.5 + 0.8 * facet) * 6.0 / (1.0 + toAnimal * toAnimal * 0.12) * absorb(toAnimal);
	col = col + key * pow(max(dot(n, l), 0.0), 2.0) * 0.05 * vec3<f32>(0.6, 0.85, 1.0);
	let crackLight = smoothstep(0.82, 0.95, (p.y - center.y) / radii.y) * smoothstep(0.022, 0.0, abs(vnoise(p * 0.4) - 0.5));
	col = col + key * crackLight * 1.2 * u.medium.w;
	let glint = step(0.985, hash33(floor(p * 3.0)).x) * (0.3 + u.beat2.y);
	col = col + vec3<f32>(0.6, 0.85, 1.0) * glint * 0.12;
	e.col = col * w + waterBg(rd) * (1.0 - w);
	return e;
}

fn surfaceShade(p: vec3<f32>, rd: vec3<f32>, wBay: f32) -> vec3<f32> {
	let t = u.frame.z;
	let rip = vnoise(vec3<f32>(p.xz * 0.9, t * 0.3)) - 0.5;
	let cosA = rd.y + rip * 0.08;
	let window = smoothstep(0.4, 0.52, cosA);
	let moonDir = normalize(vec3<f32>(0.35, 1.0, -0.2));
	let sky = vec3<f32>(0.02, 0.034, 0.07) + vec3<f32>(0.6, 0.7, 0.9) * pow(max(dot(rd, moonDir), 0.0), 220.0) * 2.0 + u.haze.rgb * 1.6;
	// Outside Snell's window the surface is a rippling mirror of the deep.
	let lines = pow(max(1.0 - abs(rip) * 5.0, 0.0), 6.0);
	let tir = waterBg(reflect(rd, vec3<f32>(0.0, -1.0, 0.0))) * 0.9 + u.haze.rgb * lines * 0.5;
	let g = p.xz * 2.2;
	let cell = floor(g);
	let hh = hash33(vec3<f32>(cell, 5.0));
	let f = fract(g) - 0.5 - (hh.xy - 0.5) * 0.6;
	let flash = step(0.72, hh.z) * (0.15 + 2.4 * u.beat2.y + u.beat.z * (1.0 - u.beat.x) * 1.5 + note(hh.x) * 1.2);
	let spark = exp(-dot(f, f) * 140.0) * flash;
	return (mix(tir, sky, window) + u.glow.rgb * spark * 0.6) * wBay + waterBg(rd) * (1.0 - wBay);
}

// Light transport in the water: shafts from the key light, integrated along
// the view ray through a noise field projected down the light direction.
fn volumeShafts(ro: vec3<f32>, rd: vec3<f32>, tMax: f32, jitter: f32) -> vec3<f32> {
	let l = u.keyDir.xyz;
	let ly = select(min(l.y, -0.2), max(l.y, 0.2), l.y >= 0.0);
	let span = min(tMax, 16.0);
	var acc = vec3<f32>(0.0);
	for (var i = 0; i < 6; i = i + 1) {
		let t = (f32(i) + jitter) / 6.0 * span;
		let p = ro + rd * t;
		let q = p.xz - l.xz / ly * p.y;
		let n = vnoise(vec3<f32>(q * 0.33, u.frame.z * 0.04)) * 0.65 + vnoise(vec3<f32>(q * 0.9, u.frame.z * 0.07 + 5.0)) * 0.35;
		let shaft = smoothstep(0.5, 0.82, n);
		acc = acc + absorb(t * 0.8) * shaft;
	}
	let toward = 0.35 + 0.65 * pow(max(dot(rd, l), 0.0), 2.0);
	return u.keyCol.rgb * mix(u.haze.rgb * 6.0, vec3<f32>(0.05), 0.15) * u.keyDir.w * u.envB.w * acc / 6.0 * span * 0.06 * toward;
}

/** The world behind the animal: colour with fog, and the distance of the first opaque surface. */
fn world(ro: vec3<f32>, rd: vec3<f32>, bg: vec3<f32>) -> vec4<f32> {
	let fog = u.lens.z;
	var col = bg;
	var tHit = 1e5;
	var add = vec3<f32>(0.0);
	let ia = i32(u.env.x + 0.5);
	let ib = i32(u.env.y + 0.5);
	let m = u.env.z;
	var wts = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
	wts[clamp(ia, 0, 5)] = wts[clamp(ia, 0, 5)] + 1.0 - m;
	wts[clamp(ib, 0, 5)] = wts[clamp(ib, 0, 5)] + m;
	let floorY = u.env.w;
	if (rd.y < -1e-4) {
		let tf = (floorY - ro.y) / rd.y;
		if (tf > 0.0) {
			tHit = tf;
			col = floorShade(ro + rd * tf, rd, wts[1], wts[4], wts[2]);
		}
	}
	if (rd.y > 1e-4) {
		let ts = (u.envB.x - ro.y) / rd.y;
		if (ts > 0.0 && ts < tHit) {
			tHit = ts;
			col = surfaceShade(ro + rd * ts, rd, wts[3]);
		}
	}
	if (wts[1] > 0.001) {
		let e = ventEnv(ro, rd, wts[1], floorY, fog);
		if (e.t < tHit) {
			tHit = e.t;
			col = e.col;
		}
		add = add + e.add;
	}
	if (wts[2] > 0.001) {
		let e = kelpEnv(ro, rd, wts[2], floorY);
		if (e.t < tHit) {
			tHit = e.t;
			col = e.col;
		}
	}
	if (wts[4] > 0.001) {
		let e = iceEnv(ro, rd, wts[4]);
		if (e.t < tHit) {
			tHit = e.t;
			col = e.col;
		}
	}
	let tr = absorb(min(tHit, 400.0));
	col = bg * (vec3<f32>(1.0) - tr) + col * tr + add;
	return vec4<f32>(col, tHit);
}

// Marine snow, world-anchored in a 3D grid walked along the ray. It has no
// light of its own: each flake shows only by the animal's light reaching it
// (inverse-square, absorbed on the way) and, in shallow worlds, by the
// downwelling light; the path back to the eye is absorbed too. Two layers at
// different cell sizes give near and far flakes their own parallax.
fn particles(ro: vec3<f32>, rd: vec3<f32>, tMax: f32, cells: i32, cs: f32, salt: f32) -> vec3<f32> {
	var acc = vec3<f32>(0.0);
	let t = u.flow.x;
	let drift = vec3<f32>(t * 0.02, -t * 0.035, t * 0.012) / cs;
	let o = ro / cs + drift;
	var cell = floor(o);
	let st = sign(rd);
	let rs = select(vec3<f32>(-1e-4), vec3<f32>(1e-4), rd >= vec3<f32>(0.0)) + rd;
	let inv = 1.0 / rs;
	var tmv = (cell + max(st, vec3<f32>(0.0)) - o) * inv;
	let tdel = abs(inv);
	let density = 0.12 + 0.3 * u.envB.z;
	let shed = u.modes.w;
	for (var i = 0; i < 24; i = i + 1) {
		if (i >= cells) {
			break;
		}
		let h = hash33(cell + vec3<f32>(u.seeds.y * 37.0 + salt, salt * 3.0, 0.0));
		// Agitation stirs the flakes: each one swirls around its drift point with
		// the current (on the tempo-scaled flow clock, never a strobe).
		let stir = (hash33(cell + vec3<f32>(9.0, salt, 1.0)) - 0.5) * u.mood.x * 0.3 * sin(u.flow.x * 2.2 + h.x * TAU);
		let pc = (cell + 0.2 + 0.6 * h.yzx - drift) * cs + stir * cs;
		let toOrg = pc - u.orgBound.xyz;
		let r2 = dot(toOrg, toOrg);
		let nearOrg = 1.0 / (1.0 + r2 * 0.6);
		let spore = shed * nearOrg * 0.6;
		if (h.x < density + spore) {
			let tp = dot(pc - ro, rd);
			if (tp > 0.08 && tp < tMax) {
				let dp = length(ro + rd * tp - pc);
				let size = cs * (0.005 + 0.012 * h.z);
				let coc = u.camUp.w * abs(tp - u.camRight.w) * 0.6 + size;
				let disc = 1.0 - smoothstep(coc * 0.65, coc, dp);
				let energy = (size * size) / (coc * coc);
				let living = orgLight() * u.flow.y * (2.4 + 3.0 * u.beat2.y) / (0.25 + r2 * 0.55) * absorb(sqrt(r2));
				let sun = u.keyCol.rgb * u.keyDir.w * u.medium.w * 0.1;
				let lit = living + sun + u.glow.rgb * spore * 1.2;
				// Flakes brushing the lens fade out instead of flashing across the frame.
				acc = acc + lit * disc * energy * absorb(tp) * (0.4 + h.y) * smoothstep(0.3, 1.4, tp);
			}
		}
		if (tmv.x < tmv.y && tmv.x < tmv.z) {
			cell.x = cell.x + st.x;
			tmv.x = tmv.x + tdel.x;
		} else if (tmv.y < tmv.z) {
			cell.y = cell.y + st.y;
			tmv.y = tmv.y + tdel.y;
		} else {
			cell.z = cell.z + st.z;
			tmv.z = tmv.z + tdel.z;
		}
		if (min(tmv.x, min(tmv.y, tmv.z)) * cs > tMax) {
			break;
		}
	}
	return acc;
}

// Far lights: other animals out in the dark, blinking, some on the beat.
fn farLights(ro: vec3<f32>, rd: vec3<f32>, tMax: f32) -> vec3<f32> {
	var acc = vec3<f32>(0.0);
	let cs = 3.2;
	let t = u.frame.z;
	let o = ro / cs + vec3<f32>(t * 0.004, 0.0, -t * 0.003);
	var cell = floor(o);
	let st = sign(rd);
	let rs = select(vec3<f32>(-1e-4), vec3<f32>(1e-4), rd >= vec3<f32>(0.0)) + rd;
	let inv = 1.0 / rs;
	var tmv = (cell + max(st, vec3<f32>(0.0)) - o) * inv;
	let tdel = abs(inv);
	for (var i = 0; i < 9; i = i + 1) {
		let h = hash33(cell * 1.31 + vec3<f32>(5.0, u.seeds.y * 13.0, 2.0));
		// How many distant animals share the water wanders (flow.z): some
		// stretches are empty black, others a scatter of far lights.
		if (h.x < 0.06 + 0.3 * u.flow.z) {
			let pc = (cell + 0.25 + 0.5 * h.zxy - vec3<f32>(t * 0.004, 0.0, -t * 0.003)) * cs;
			let tp = dot(pc - ro, rd);
			if (tp > 3.0 && tp < tMax) {
				let dp = length(ro + rd * tp - pc);
				// Each far light flickers on its own noise, never on a fixed cycle.
				let blink = smoothstep(0.6, 0.85, vnoise(vec3<f32>(h.z * 40.0, h.x * 17.0, t * (0.3 + 0.5 * h.y)))) * select(1.0, u.beat.z * (1.0 - u.beat.x) * 2.0, h.y > 0.7);
				// A small hot core and a wide soft body: a far animal out of focus.
				let core = exp(-dp * dp / (0.0004 * tp)) + exp(-dp * dp / (0.012 * tp)) * 0.12 + exp(-dp * dp / (0.05 * tp)) * 0.05 * u.flow.z;
				let tint = select(u.glow.rgb, u.accent.rgb, h.z > 0.5);
				acc = acc + tint * core * blink * absorb(tp * 0.7) * 0.5;
			}
		}
		if (tmv.x < tmv.y && tmv.x < tmv.z) {
			cell.x = cell.x + st.x;
			tmv.x = tmv.x + tdel.x;
		} else if (tmv.y < tmv.z) {
			cell.y = cell.y + st.y;
			tmv.y = tmv.y + tdel.y;
		} else {
			cell.z = cell.z + st.z;
			tmv.z = tmv.z + tdel.z;
		}
		if (min(tmv.x, min(tmv.y, tmv.z)) * cs > tMax) {
			break;
		}
	}
	return acc;
}

fn shadeAnimal(p: vec3<f32>, rd: vec3<f32>, t: f32, behind: vec3<f32>, s: Sample) -> vec3<f32> {
	let n = calcNormal(p, t);
	let isComp = s.seg >= 99.5;
	let seg = select(s.seg, s.seg - 100.0, isComp);
	let center = select(u.orgPos.xyz, u.comp.xyz, isComp);
	let scale = select(u.orgBound.w, u.orgBound.w * u.comp.w, isComp);
	let q = bodyLocal(p, center, scale);
	let ul = unitLocal(q);
	let qi = ul.xyz;
	let part = s.part;
	let v = -rd;
	let ndv = clamp(dot(n, v), 0.0, 1.0);
	let fres = pow(1.0 - ndv, 3.0);
	let l = u.keyDir.xyz;
	let key = u.keyCol.rgb * u.keyDir.w;
	let energy = u.audio.w;
	let hb = heartbeat() * formWeight(3.0);

	// Opacity per tissue: thin tissues read denser.
	var opac = u.skin0.w;
	if (part > 0.5 && part < 2.5) {
		opac = mix(opac, 0.85, 0.5);
	} else if (part > 3.5 && part < 4.5) {
		opac = 0.88;
	} else if (part > 4.5 && part < 5.5) {
		opac = 0.55;
	} else if (part > 5.5 && part < 7.5) {
		opac = mix(opac, 0.8, 0.6);
	} else if (part > 7.5 && part < 8.5) {
		opac = 0.35;
	} else if (part > 9.5) {
		opac = 0.9;
	}
	let opacEff = clamp(opac + fres * 0.45, 0.0, 1.0);

	// Albedo, with chromatophores breathing in waves over the skin.
	var albedo = u.bodyCol.rgb;
	if (u.skin0.z > 0.01 && (part < 0.5 || part > 8.5)) {
		let vc = voro(qi * 9.0);
		let wave = 0.5 + 0.5 * sin(dot(qi, vec3<f32>(0.4, 3.2, 0.9)) * 2.2 - u.orgY.w * 0.6 + vc.y * 2.0);
		let open = clamp(wave * 0.75 + u.beat2.x * 0.2 + u.beat.z * gauss(fract(qi.y * 0.4 - u.beat.x) - 0.5, 0.2) * 0.35, 0.0, 1.0);
		let spot = smoothstep(0.08 + 0.32 * open, 0.04 + 0.28 * open, vc.x);
		let pigment = mix(u.accent.rgb * 0.35, u.organ.rgb * 0.4, step(0.5, vc.y));
		let cloud = smoothstep(0.35, 0.95, sin(qi.y * 3.5 - u.orgY.w * 0.45 + qi.z * 1.2));
		albedo = mix(albedo, pigment, spot * u.skin0.z) * (1.0 - cloud * 0.55 * u.skin0.z);
	}

	// Light: wrapped diffuse, soft self-shadow, occlusion, transmission, wet spec.
	var sh = 1.0;
	let dbgS = (u32(u.debug.x + 0.5) & 8u) != 0u;
	let shadowSteps = select(i32(u.march.y + 0.5), 0, dbgS);
	if (shadowSteps > 0) {
		sh = mix(1.0, softShadow(p + n * 0.02, l, shadowSteps), 0.7);
	}
	var occ = 0.0;
	let aoTaps = select(2, 0, u.march.x < 0.0);
	for (var i = 0; i < aoTaps; i = i + 1) {
		let h = select(0.05, 0.15, i == 1);
		occ = occ + (h - mapD(p + n * h)) * select(6.0, 2.5, i == 1);
	}
	let ao = clamp(1.0 - occ, 0.25, 1.0);
	let wrap = (dot(n, l) * 0.5 + 0.5);
	let diff = wrap * wrap;
	let amb = (u.haze.rgb * 2.0 + u.water.rgb * 4.0) * (0.6 + 0.4 * n.y) + u.keyCol.rgb * u.keyCol.w * 0.4;
	// Mesoglea is mostly water: the key light models the form, the animal's own light carries it.
	var col = albedo * (key * diff * sh * 0.4 + amb * 0.6) * ao * opac;
	let back = pow(clamp(dot(rd, l), 0.0, 1.0), 3.0);
	col = col + u.bodyCol.rgb * key * back * (1.0 - opac) * 0.9;
	let hv = normalize(l + v);
	col = col + key * pow(max(dot(n, hv), 0.0), 60.0) * 0.45 * sh;

	// Rim glow: the membrane's edge catching its own bioluminescence.
	let pulse = u.beat.y;
	let rimTint = mix(u.bodyCol.rgb, u.glow.rgb, 0.6);
	col = col + rimTint * (fres * 1.3 + pow(1.0 - ndv, 8.0) * 1.2) * u.skin1.z * (0.45 + 0.55 * energy + 0.3 * pulse);

	// Iridescence and comb rows.
	let phi = atan2(qi.z, qi.x);
	if (u.skin1.y > 0.01) {
		col = col + film(ndv * 1.6 + qi.y * 0.4 + u.orgX.w * 0.05) * fres * u.skin1.y * 0.22;
	}
	if (u.skin0.y > 0.01 && part < 0.5) {
		let row = smoothstep(0.88, 0.99, cos(8.0 * phi));
		let yN = qi.y / max(u.body0.y, 0.05);
		let beat = 0.5 + 0.5 * sin(yN * 14.0 - u.app.w + phi);
		col = col + film(yN * 0.8 + u.drag.w + phi * 0.2) * row * (1.0 - abs(yN)) * u.skin0.y * (0.12 + beat * (0.25 + 1.4 * u.beat2.y + u.audio.z * 0.6));
	}

	// Photophores: rim ring, body spots, along the appendages, bulbs; notes light them.
	var photo = vec3<f32>(0.0);
	let gain = u.photo.w;
	let strike = 0.6 + 0.9 * u.mood.y;
	if (part < 0.5 && u.photo.y > 0.01) {
		let np = max(16.0, u.counts.x * 2.0);
		let k = round(phi / TAU * np);
		let dp = vec2<f32>((phi - k * TAU / np) * u.body0.x, (s.u - 0.93) * u.body0.y * 2.0);
		let spot = exp(-dot(dp, dp) / 0.0014);
		let x = fract(k / np + 0.5);
		photo = photo + mix(u.glow.rgb, u.accent.rgb, step(0.5, fract(k * 0.5))) * spot * u.photo.y * (0.1 + note(x) * gain * 2.4 + onset(x) * 2.5 * strike);
	}
	if (u.photo.x > 0.01 && (part < 0.5 || part > 8.5)) {
		let cq = qi * 6.5 + vec3<f32>(seg * 2.3);
		let h = hash33(floor(cq));
		let f = fract(cq) - 0.5 - (h - 0.5) * 0.5;
		let spot = exp(-dot(f, f) * mix(70.0, 34.0, u.photo.x)) * step(1.0 - u.photo.x * 0.7, h.x);
		let wave = gauss(fract(qi.y * 0.35 + seg * 0.2 - u.beat.x) - 0.5, 0.1) * u.beat.z;
		photo = photo + mix(u.glow.rgb, u.accent.rgb, step(0.6, h.y)) * spot * (0.08 + note(h.z) * gain * 2.0 + onset(h.z) * 2.2 * strike + wave * 2.0 + u.beat2.y * 0.5);
	}
	if ((part > 0.5 && part < 2.5) || (part > 6.5 && part < 7.5)) {
		let nA = max(u.counts.z, 1.0);
		let idx = round(phi / (TAU / nA));
		let beads = gauss(fract(s.u * 10.0 + idx * 0.37) - 0.5, 0.16);
		let x = fract(s.u * 0.7 + idx / nA);
		photo = photo + u.glow.rgb * beads * u.photo.z * (0.06 + note(x) * gain * 1.6 + onset(x) * 2.0) * (1.0 - s.u * 0.4);
		if (part > 6.5) {
			photo = photo + u.accent.rgb * smoothstep(0.6, 1.0, s.u) * (0.3 + u.beat2.y);
		}
	}
	if (part > 7.5 && part < 8.5) {
		photo = photo + mix(u.glow.rgb, u.accent.rgb, 0.3) * (0.9 + (note(0.15) * 1.5 * gain + u.beat2.x * 1.2 + u.beat.z * (1.0 - u.beat.x)) * (1.0 - 0.65 * u.mood.z));
	}
	if (part > 4.5 && part < 5.5) {
		photo = photo + u.organ.rgb * (0.3 + 0.35 * u.audio.x + hb * 0.6) * u.skin1.w;
	}
	col = col + photo;

	// Beat light packets travelling through the body.
	var arc = s.u;
	if (part > 0.5 && part < 2.5) {
		arc = 1.0 + s.u * 1.6;
	} else if (part > 5.5 && part < 6.5) {
		arc = s.u;
	} else if (part > 6.5 && part < 8.5) {
		arc = 0.6 + s.u;
	}
	var band = 0.0;
	if (u.modes.z < 0.999) {
		band = band + packetBand(u.modes.x, arc, phi, seg) * (1.0 - u.modes.z);
	}
	if (u.modes.z > 0.001) {
		band = band + packetBand(u.modes.y, arc, phi, seg) * u.modes.z;
	}
	// The packet is a travelling ring of light: strongest at the rim and in the
	// photophores, a faint wash across the tissue in between.
	let packetMask = 0.12 + 0.7 * fres + min(1.0, length(photo) * 2.0);
	col = col + mix(u.glow.rgb, rimTint, 0.3) * band * u.beat.z * (1.0 - u.beat.x * 0.5) * packetMask * 0.9;

	// Through the membrane: organs, then the world behind.
	var inner = vec3<f32>(0.0);
	var trans = 1.0;
	let steps = select(i32(u.march.z + 0.5), 0, dbgS);
	if (opac < 0.97 && steps > 0) {
		let rdIn = normalize(rd - n * 0.25);
		let stepL = 0.065 * (u.body0.x + u.body0.y) * 0.6;
		for (var i = 0; i < 12; i = i + 1) {
			if (i >= steps) {
				break;
			}
			let pi = p + rdIn * (f32(i) + 0.5) * stepL * scale;
			let qq = unitLocal(bodyLocal(pi, center, scale));
			let og = organField(qq.xyz, qq.w, hb);
			inner = inner + og.rgb * trans * stepL * 5.0;
			trans = trans * exp(-og.w * stepL * 5.0);
		}
	}
	col = col + inner * (1.0 - opacEff * 0.5) * 1.4;
	// The world seen through the body, tinted by the tissue it crossed.
	col = col + behind * mix(vec3<f32>(1.0), u.bodyCol.rgb * 1.4, 0.35) * (1.0 - opacEff) * trans;
	return col;
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let res = u.frame.xy;
	let aspect = res.x / max(res.y, 1.0);
	let p2 = vec2<f32>((in.uv.x - 0.5) * aspect, 0.5 - in.uv.y);
	let ro = u.camPos.xyz;
	let rd = camRay(p2);
	let bg = waterBg(rd);
	let dbg = u32(u.debug.x + 0.5);
	var wv = vec4<f32>(bg, 1e5);
	if ((dbg & 2u) == 0u) {
		wv = world(ro, rd, bg);
	}
	var col = wv.rgb;
	var depth = wv.w;

	let bm = sphereHit(ro, rd, u.orgBound.xyz, u.orgPos.w);
	var t0 = bm.x;
	var t1 = bm.y;
	if (u.comp.w > 0.01) {
		let bc = sphereHit(ro, rd, compCenter(), u.orgPos.w * u.comp.w);
		if (bc.y > 0.0) {
			t0 = min(t0, bc.x);
			t1 = max(t1, bc.y);
		}
	}
	if (t1 > 0.0 && t0 < wv.w && (dbg & 1u) == 0u) {
		let tEnd = min(t1, wv.w);
		var t = t0;
		var hit = false;
		var minD = 1e5;
		var minT = t0;
		var hitS: Sample;
		hitS.d = 1e5;
		hitS.part = 0.0;
		hitS.u = 0.0;
		hitS.seg = 0.0;
		let steps = i32(u.march.x + 0.5);
		for (var i = 0; i < 160; i = i + 1) {
			if (i >= steps) {
				break;
			}
			let ms = mapS(ro + rd * t);
			let d = ms.d;
			let rel = d / max(t, 0.1);
			if (rel < minD) {
				minD = rel;
				minT = t;
			}
			if (d < 0.0006 * t + 0.0008) {
				hit = true;
				hitS = ms;
				t = t + d;
				break;
			}
			t = t + d * 0.82;
			if (t > tEnd) {
				break;
			}
		}
		if (hit) {
			var shaded = shadeAnimal(ro + rd * t, rd, t, wv.rgb, hitS);
			// Dev: debug bit 16 paints the hit part id (0 bell .. 10 spines).
			if ((dbg & 16u) != 0u) {
				shaded = vec3<f32>(fract(hitS.part * 0.37), fract(hitS.part * 0.61 + 0.2), fract(hitS.part * 0.13 + 0.5));
			}
			let tr = absorb(t);
			col = bg * (vec3<f32>(1.0) - tr) + shaded * tr;
			depth = t;
		} else {
			// Filaments thinner than a pixel still glow: a halo from the near miss.
			let halo = exp(-minD * 260.0) * 0.18;
			col = col + mix(u.glow.rgb, u.bodyCol.rgb, 0.4) * halo * (0.4 + 0.6 * u.audio.w + u.beat.z * 0.3) * absorb(minT);
		}
	}
	if ((dbg & 4u) == 0u) {
		col = col + livingScatter(ro, rd, min(depth, 60.0));
		col = col + particles(ro, rd, depth, i32(u.march.w + 0.5), 0.55, 0.0);
		col = col + particles(ro, rd, depth, i32(u.march.w * 0.6 + 0.5), 1.7, 17.0) * 2.2;
		if (u.envB.w > 0.01) {
			col = col + volumeShafts(ro, rd, depth, hash33(vec3<f32>(in.position.xy, 7.0)).x);
		}
		col = col + farLights(ro, rd, depth);
	}
	// Never let a NaN reach the feedback history, where it would spread.
	col = max(select(col, vec3<f32>(0.0), col != col), vec3<f32>(0.0));
	return vec4<f32>(col, min(depth, 300.0));
}
`;

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------
const POST_COMMON_WGSL = /* wgsl */ `
${COMMON_WGSL}
${FULLSCREEN_WGSL}
`;

// Temporal feedback: the previous frame drifts a hair towards the animal and
// decays, max-blended with the new scene, so bioluminescence leaves trails
// without accumulating to white. Depth comes from the new scene.
export const SOMA_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var feedbackPrev: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let center = clamp(u.orgScreen.xy, vec2<f32>(0.1), vec2<f32>(0.9));
	let prevUv = center + (in.uv - center) * (1.0 - 0.0035 * (1.0 + u.audio.x));
	let edge = min(min(prevUv.x, prevUv.y), min(1.0 - prevUv.x, 1.0 - prevUv.y));
	let border = smoothstep(0.0, 0.03, edge);
	let prev = textureSampleLevel(feedbackPrev, samp, prevUv, 0.0).rgb;
	let scene = textureSampleLevel(sceneTex, samp, in.uv, 0.0);
	let trail = max(prev * u.post.x * border - vec3<f32>(0.004), vec3<f32>(0.0));
	return vec4<f32>(max(trail, scene.rgb), scene.a);
}
`;

export const SOMA_BLOOM_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / vec2<f32>(textureDimensions(srcTex));
	var c = textureSampleLevel(srcTex, samp, in.uv + vec2<f32>(-1.0, -1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>( 1.0, -1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>(-1.0,  1.0) * texel, 0.0).rgb;
	c = c + textureSampleLevel(srcTex, samp, in.uv + vec2<f32>( 1.0,  1.0) * texel, 0.0).rgb;
	c = c * 0.25;
	let bright = max(c.r, max(c.g, c.b));
	let knee = max(0.0, bright - u.post.y);
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
	let texel = (2.4 + u.post.w * 0.6) / vec2<f32>(textureDimensions(srcTex));
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

export const SOMA_BLUR_H_WGSL = blurShader(1, 0);
export const SOMA_BLUR_V_WGSL = blurShader(0, 1);

// Presentation: depth of field gathered from the scene depth, r-squared
// chromatic aberration, bloom as an accent, the planar mirror (seabed or the underside of the surface), then grade,
// ACES and IGN dither.
export const SOMA_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var feedbackTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

fn aces(color: vec3<f32>) -> vec3<f32> {
	return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

fn coc(depth: f32) -> f32 {
	return clamp(u.camUp.w * abs(depth - u.camRight.w) / max(depth, 0.2) * u.outp.y * 0.5, 0.0, 12.0);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let outRes = u.outp.xy;
	let aspect = outRes.x / max(outRes.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);
	let warped = 0.5 + centered * (1.0 + r2 * 0.04);
	let caAmount = (0.0008 + r2 * 0.006) * u.post.z;
	let caDir = normalize(centered + vec2<f32>(1e-4, 1e-4)) * caAmount;
	let px = 1.0 / outRes;

	// Depth of field: a golden-angle gather that respects occlusion.
	let c0 = textureSampleLevel(feedbackTex, samp, warped, 0.0);
	let centerDepth = c0.a;
	let centerCoc = coc(centerDepth);
	var acc = vec3<f32>(
		textureSampleLevel(feedbackTex, samp, warped + caDir, 0.0).r,
		c0.g,
		textureSampleLevel(feedbackTex, samp, warped - caDir, 0.0).b
	);
	var wsum = 1.0;
	let taps = i32(u.camFwd.w + 0.5);
	if (centerCoc > 0.6 && taps > 0) {
		for (var i = 0; i < 16; i = i + 1) {
			if (i >= taps) {
				break;
			}
			let fi = f32(i) + 0.5;
			let rad = sqrt(fi / f32(taps)) * centerCoc;
			let ang = fi * 2.39996;
			let off = vec2<f32>(cos(ang), sin(ang)) * rad * px;
			let tap = textureSampleLevel(feedbackTex, samp, warped + off, 0.0);
			let tapCoc = coc(tap.a);
			let behind = tap.a >= centerDepth - 0.05;
			let reach = select(tapCoc, min(tapCoc, centerCoc), behind);
			let w = smoothstep(rad - 1.0, rad + 0.5, reach);
			let rgb = vec3<f32>(
				textureSampleLevel(feedbackTex, samp, warped + off + caDir, 0.0).r,
				tap.g,
				textureSampleLevel(feedbackTex, samp, warped + off - caDir, 0.0).b
			);
			acc = acc + rgb * w;
			wsum = wsum + w;
		}
	}
	var scene = acc / wsum;
	let bloom = textureSampleLevel(bloomTex, samp, warped, 0.0).rgb;

	// The mirror: the seabed (or the surface from below) reflects the animal.
	let p = vec2<f32>((warped.x - 0.5) * aspect, 0.5 - warped.y);
	let ro = u.camPos.xyz;
	let rd = camRay(p);
	let planeY = u.seeds.z;
	let below = u.seeds.w < 0.5;
	var refl = vec3<f32>(0.0);
	let facing = select(rd.y > 1e-3, rd.y < -1e-3, below);
	if (facing && u.envB.y > 0.01) {
		let tp = (planeY - ro.y) / rd.y;
		if (tp > 0.0 && tp < centerDepth + 0.05) {
			let hitP = ro + rd * tp;
			let rr = reflect(rd, vec3<f32>(0.0, select(-1.0, 1.0, below), 0.0));
			let ts = max(0.0, dot(u.orgPos.xyz - hitP, rr));
			let x = hitP + rr * ts;
			let mirrored = vec3<f32>(x.x, 2.0 * planeY - x.y, x.z);
			let pr = project(mirrored, aspect);
			if (pr.z > 0.1) {
				let ruv = pr.xy;
				let inside = smoothstep(0.0, 0.05, min(min(ruv.x, ruv.y), min(1.0 - ruv.x, 1.0 - ruv.y)));
				let wob = vec2<f32>(sin(hitP.x * 3.0 + u.app.z * 2.3), cos(hitP.z * 2.6 + u.app.z * 1.7)) * 0.004;
				let sharp = textureSampleLevel(feedbackTex, samp, ruv + wob, 0.0).rgb;
				let soft = textureSampleLevel(bloomTex, samp, ruv + wob, 0.0).rgb;
				let fresnel = 0.25 + 0.75 * pow(1.0 - abs(rd.y), 4.0);
				refl = mix(sharp, soft * 2.0, 0.45) * fresnel * inside * u.envB.y * exp(-u.medium.xyz * tp) * 0.5;
			}
		}
	}

	// No screen-space shafts and no tint here: shafts are real volumetric light
	// in the scene, and the water's colour comes from the medium itself.
	var color = scene + refl + bloom * u.post.w;
	color = color * u.lens.w;
	// Lens falloff, as a real underwater housing has.
	let vig = 1.0 - smoothstep(0.4, 1.0, length(centered * vec2<f32>(aspect * 0.75, 1.0))) * 0.45;
	color = color * vig;
	var mapped = aces(color);
	mapped = pow(mapped, vec3<f32>(1.0 / 1.06));
	let dither = (ign(in.position.xy, u.frame.w) - 0.5) / 255.0;
	mapped = mapped + vec3<f32>(dither);
	return vec4<f32>(mapped, 1.0);
}
`;
