// Mandala: an endless flight down a tunnel carved with sacred geometry.
//
// The scene is one fullscreen pass. Each pixel's ray hits two nested tunnel
// surfaces (a pierced fretwork screen and the carved wall behind it), round or
// polygonal, from a camera that drifts off the axis and looks around. Surface
// coordinates are log-polar: depth is measured as log(z), so the carving is
// self-similar and the flight is an infinite zoom, inward and outward forever.
// The angle is folded into mirror sectors (the mandala), sheared by depth (the
// vortex), and the folded coordinates are carved by one of nine grammar
// families: Truchet, flower of life, yantra triangles, girih stars, fractal
// lace (KIFS), Apollonian gaskets, hyperbolic {p,q} tilings in the band model,
// golden-angle phyllotaxis and rings that count sequences.
//
// Light is physical: two rig lights carried behind the camera throw the
// screen's fretwork onto the wall as patterned shadows, sconces fixed along
// the wall pass by as the camera flies, beat rings rush out of the depths
// lighting the carving as they pass, and the inlays glow with the spectrum.
// The tunnel air absorbs with depth (so the far centre is deep, never a lit
// blob) and scatters the lights it holds.
//
// Post stack: temporal feedback (zoomed and rolled with the flight), adapted
// exposure, half-res bloom, composite with chromatic aberration and dither.

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

fn mixU(x0: u32) -> u32 {
	var x = x0;
	x = x ^ (x >> 16u);
	x = x * 0x7feb352du;
	x = x ^ (x >> 15u);
	x = x * 0x846ca68bu;
	x = x ^ (x >> 16u);
	return x;
}

// Hash of two integer-valued floats (cell coordinates), 0..1.
fn hash2(a: f32, b: f32) -> f32 {
	let ia = u32(i32(floor(a)) + 1048576);
	let ib = u32(i32(floor(b)) + 1048576);
	return f32(mixU((ia * 0x9e3779b1u) ^ mixU(ib + 0x632be5abu)) & 0x00ffffffu) / 16777216.0;
}

fn rot2(p: vec2<f32>, a: f32) -> vec2<f32> {
	let c = cos(a);
	let s = sin(a);
	return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn lineDist(v: f32, spacing: f32) -> f32 {
	return abs(fract(v / spacing + 0.5) - 0.5) * spacing;
}

fn binAt(id: f32) -> f32 {
	let index = clamp(i32(floor(fract(id) * ${MANDALA_BIN_COUNT}.0)), 0, ${MANDALA_BIN_COUNT - 1});
	return clamp(bins[index], 0.0, 1.0);
}

// Everything a grammar needs about one surface point.
struct Site {
	// Folded cell coordinates: x across the mirror sector, y along the tunnel.
	fold: vec2<f32>,
	// Whole-circle cell coordinates (0..cellsAround), for counting grammars.
	whole: vec2<f32>,
	// Depth in cells before travel (log depth times cells per log unit).
	depthCells: f32,
	// Whole rows travelled (for hashing).
	row: f32,
	cellsAround: f32,
	halfCells: f32,
	hyper: f32,
	// Phyllotaxis: reduced lattice basis, seed-index coefficients, lattice
	// offset (turns round, cells along) and seeds passed.
	phyllo: vec4<f32>,
	phylloIndex: vec2<f32>,
	phylloShift: vec2<f32>,
	seedRow: f32,
	morph: f32,
};

// A grammar's answer: distance to the nearest carved line (cells), filled
// interior 0..1, a stable per-element id 0..1 and a secondary shade 0..1.
struct Mark {
	d: f32,
	fill: f32,
	id: f32,
	shade: f32,
};

fn mark(d: f32, fill: f32, id: f32, shade: f32) -> Mark {
	var m: Mark;
	m.d = d;
	m.fill = fill;
	m.id = id;
	m.shade = shade;
	return m;
}

// Hex lattice with a y period of exactly one cell (two rows of 0.5).
const HEX_DX = 0.5773502692;
fn hexNearest(p: vec2<f32>) -> vec4<f32> {
	let period = vec2<f32>(HEX_DX, 1.0);
	let a = p - period * round(p / period);
	let offset = vec2<f32>(HEX_DX * 0.5, 0.5);
	let b = p - offset - period * round((p - offset) / period);
	if (dot(a, a) < dot(b, b)) {
		return vec4<f32>(a, p - a);
	}
	return vec4<f32>(b, p - b);
}

// ---- family 0: Truchet (the original kaleidoscope's tiles) ----
fn truchet(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	let cell = floor(p);
	let local = fract(p) - 0.5;
	let h = hash2(cell.x, cell.y + s.row);
	let r = 0.5;
	var d = 1.0;
	var fill = 0.0;
	if (variant == 0) {
		let flip = select(1.0, -1.0, h < 0.5);
		let q = vec2<f32>(local.x, local.y * flip);
		d = min(abs(length(q - vec2<f32>(-0.5, -0.5)) - r), abs(length(q - vec2<f32>(0.5, 0.5)) - r));
		fill = step(length(q - vec2<f32>(-0.5, -0.5)), r);
	} else if (variant == 1) {
		let a = abs(length(local - vec2<f32>(-0.5, -0.5)) - r);
		let b = abs(length(local - vec2<f32>(0.5, 0.5)) - r);
		let c = abs(length(local - vec2<f32>(-0.5, 0.5)) - r);
		let e = abs(length(local - vec2<f32>(0.5, -0.5)) - r);
		d = min(min(a, b), min(c, e));
		fill = step(0.5, h) * step(length(local), 0.2);
	} else if (variant == 2) {
		d = select(abs(local.x + local.y), abs(local.x - local.y), h < 0.5) * 0.7071;
		d = min(d, abs(max(abs(local.x), abs(local.y)) - 0.5));
		fill = step(0.5, fract(h * 7.0)) * step(0.0, local.x * select(1.0, -1.0, h < 0.5) - local.y);
	} else {
		let rr = length(local);
		let base = 0.12 + h * 0.12 + s.morph * 0.06;
		d = min(abs(rr - base), min(abs(rr - base * 1.9), abs(rr - base * 2.75)));
		fill = step(rr, base);
	}
	return mark(d, fill, h, fract(h * 3.1));
}

// ---- family 1: flower of life, tangent circles, vesica, lattice ----
fn flower(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	let near = hexNearest(p);
	let centre = near.zw;
	let v = near.xy;
	var radius = HEX_DX;
	if (variant == 1) { radius = HEX_DX * 0.5; }
	if (variant == 2) { radius = HEX_DX * 0.57735; }
	radius = radius * (0.94 + s.morph * 0.12);
	var dirs = array<vec2<f32>, 7>(
		vec2<f32>(0.0, 0.0),
		vec2<f32>(HEX_DX, 0.0),
		vec2<f32>(-HEX_DX, 0.0),
		vec2<f32>(HEX_DX * 0.5, 0.5),
		vec2<f32>(-HEX_DX * 0.5, 0.5),
		vec2<f32>(HEX_DX * 0.5, -0.5),
		vec2<f32>(-HEX_DX * 0.5, -0.5)
	);
	var d = 1.0;
	var inside = 0.0;
	for (var k = 0; k < 7; k = k + 1) {
		let r = length(v - dirs[k]);
		d = min(d, abs(r - radius));
		inside = inside + step(r, radius);
	}
	if (variant == 1) {
		d = min(d, abs(length(v) - radius * 0.42));
	}
	if (variant == 3) {
		let n0 = abs(v.x);
		let n1 = abs(dot(v, vec2<f32>(0.5, 0.8660254)));
		let n2 = abs(dot(v, vec2<f32>(-0.5, 0.8660254)));
		let hexEdge = HEX_DX * 0.5 - max(n0, max(n1, n2));
		d = min(d, abs(hexEdge));
	}
	let id = hash2(centre.x * 3.4641, centre.y * 2.0 + s.row * 2.0);
	// Petal count parity: lenses where two circles overlap fill.
	let fill = select(step(1.5, inside) * (1.0 - step(2.5, inside)), step(0.5, inside), variant == 1);
	return mark(d, fill, id, clamp(inside / 3.0, 0.0, 1.0));
}

// ---- family 2: yantra triangles, hexagram, sri yantra, Metatron ----
fn triGrid(p: vec2<f32>, h: f32, offset: f32) -> f32 {
	let d0 = lineDist(p.y + offset, h);
	let d1 = lineDist(0.8660254 * p.x - 0.5 * p.y + offset, h);
	let d2 = lineDist(0.8660254 * p.x + 0.5 * p.y + offset, h);
	return min(d0, min(d1, d2));
}

fn yantra(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	let h = 0.5;
	var d = triGrid(p, h, 0.0);
	let upDown = step(0.5, fract((floor(p.y / h) + floor((0.8660254 * p.x - 0.5 * p.y) / h) + floor((0.8660254 * p.x + 0.5 * p.y) / h)) * 0.5));
	let near = hexNearest(p);
	let id = hash2(floor(p.y / h) + s.row * 2.0, floor((0.8660254 * p.x + 0.5 * p.y) / h) * 7.0 + upDown);
	if (variant == 1) {
		d = min(d, triGrid(p, h, h / 3.0));
	} else if (variant == 2) {
		// Interlocking up and down triangles, ringed by lotus circles.
		d = min(d, triGrid(p, h, h * 0.5 + s.morph * 0.04) * 1.4 + 0.003);
		d = min(d, abs(length(near.xy) - (0.36 + s.morph * 0.05)));
	} else if (variant == 3) {
		// Metatron: every hex point joined to its second neighbours.
		let m0 = lineDist(p.x, HEX_DX);
		let m1 = lineDist(dot(p, vec2<f32>(0.5, 0.8660254)), HEX_DX * 1.5);
		let m2 = lineDist(dot(p, vec2<f32>(0.5, -0.8660254)), HEX_DX * 1.5);
		d = min(d, min(m0, min(m1, m2)) * 1.7 + 0.004);
		d = min(d, abs(length(near.xy) - 0.11));
	}
	return mark(d, upDown, id, fract(id * 5.7));
}

// ---- family 3: girih stars (IQ star polygon) ----
fn sdStar(p0: vec2<f32>, r: f32, n: f32, m: f32) -> f32 {
	let an = PI / n;
	let en = PI / m;
	let acs = vec2<f32>(cos(an), sin(an));
	let ecs = vec2<f32>(cos(en), sin(en));
	let ang = atan2(p0.x, p0.y);
	let bn = (ang - 2.0 * an * floor(ang / (2.0 * an))) - an;
	var p = length(p0) * vec2<f32>(cos(bn), abs(sin(bn)));
	p = p - r * acs;
	p = p + ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
	return length(p) * sign(p.x);
}

fn girih(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	var v = vec2<f32>(0.0);
	var id = 0.0;
	var n = 8.0;
	var m = 3.0;
	var radius = 0.44;
	if (variant == 1 || variant == 2) {
		let near = hexNearest(p);
		v = near.xy;
		id = hash2(near.z * 3.4641, near.w * 2.0 + s.row * 2.0);
		n = select(12.0, 6.0, variant == 1);
		m = select(4.2, 2.3, variant == 1);
		radius = HEX_DX * 0.56;
	} else {
		let cell = floor(p);
		v = fract(p) - 0.5;
		id = hash2(cell.x, cell.y + s.row);
		n = select(10.0, 8.0, variant == 0);
		m = select(3.4, 3.0, variant == 0);
	}
	radius = radius * (0.9 + s.morph * 0.18);
	let star = sdStar(v, radius, n, m);
	var lines = 1.0;
	let reach = radius * cos(PI * m / n) * 1.0;
	for (var k = 0; k < 4; k = k + 1) {
		let a = f32(k) * PI / 4.0 + PI / 8.0;
		lines = min(lines, abs(abs(dot(v, vec2<f32>(cos(a), sin(a)))) - reach));
	}
	// Extended edges only outside the star: the interlace between stars.
	let d = min(abs(star), select(1.0, lines, star > 0.0));
	return mark(d, step(star, 0.0), id, smoothstep(0.0, radius, -star));
}

// ---- family 4: fractal lace (Koch and Cesaro curves, mirror tiled) ----
fn kochCurve(p0: vec2<f32>, ang: f32) -> f32 {
	let n = vec2<f32>(sin(ang), cos(ang));
	var p = vec2<f32>(abs(p0.x), p0.y);
	var s = 1.0;
	for (var i = 0; i < 4; i = i + 1) {
		p = p * 3.0;
		s = s * 3.0;
		p.x = abs(p.x - 1.5) - 0.5;
		let d = dot(p, n);
		p = p - min(0.0, d) * n * 2.0;
	}
	return length(p - vec2<f32>(clamp(p.x, -1.0, 1.0), 0.0)) / s;
}

fn lace(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	var ang = 2.0943951;
	if (variant == 1) { ang = 0.6 * PI; }
	if (variant == 2) { ang = 0.72 * PI; }
	if (variant == 3) { ang = 0.56 * PI; }
	ang = ang + (s.morph - 0.5) * 0.08 * PI;
	let q = (fract(p) - 0.5) * 2.0;
	let qy = abs(q.y);
	let d1 = kochCurve(vec2<f32>(q.x, qy), ang);
	let d2 = kochCurve(vec2<f32>(qy, abs(q.x)), ang);
	let cell = floor(p);
	let id = hash2(cell.x, cell.y + s.row);
	let d = min(d1, d2) * 0.5;
	// The lace's own windows fill: the space the curve bulges round.
	let fill = smoothstep(0.35, 0.05, length(q - vec2<f32>(0.0, 0.0)) - 0.25) * 0.4;
	return mark(d, fill, fract(id + select(0.0, 0.5, d1 < d2)), select(0.3, 0.8, d1 < d2));
}

// ---- family 5: Apollonian gasket (iterated circle inversion) ----
fn apollonian(p: vec2<f32>, variant: i32, s: Site) -> Mark {
	var q = p * 2.0;
	var k = 1.0;
	if (variant == 1) { k = 1.12; }
	if (variant == 2) { k = 1.27; }
	if (variant == 3) { k = 0.94; q = q + vec2<f32>(0.5, 0.0); }
	k = k + (s.morph - 0.5) * 0.08;
	var scale = 1.0;
	var trap = 10.0;
	for (var i = 0; i < 7; i = i + 1) {
		q = -1.0 + 2.0 * fract(0.5 * q + 0.5);
		let r2 = max(dot(q, q), 1e-4);
		let f = k / r2;
		q = q * f;
		scale = scale * f;
		trap = min(trap, r2);
	}
	let d = 0.25 * min(abs(q.x), abs(q.y)) / scale;
	let cell = floor(p);
	return mark(d, smoothstep(0.35, 0.0, trap), hash2(cell.x + trap * 13.0, cell.y + s.row), clamp(trap * 2.0, 0.0, 1.0));
}

// ---- family 6: hyperbolic {p,q} tiling in the band model ----
fn hyperbolic(variant: i32, s: Site) -> Mark {
	var pg = 4.0;
	var qg = 5.0;
	if (variant == 1) { pg = 6.0; qg = 4.0; }
	if (variant == 2) { pg = 8.0; qg = 3.0; }
	if (variant == 3) { pg = 4.0; qg = 6.0; }
	// The band's centre line (a mirror of the tiling) sits on the sector's
	// mirror, so the fold is seamless and the large central tiles show.
	let width = max(s.halfCells * 1.1, 0.3);
	let xm = abs(fract(s.fold.x / (2.0 * width) + 0.5) - 0.5) * 2.0;
	let band = 0.47 * PI;
	let scale = band / width;
	let b = xm * band;
	let a = clamp(s.depthCells * scale + s.hyper, -30.0, 30.0);
	let den = cosh(a) + cos(b);
	var z = vec2<f32>(sinh(a), sin(b)) / den;
	// Central p-gon edge circle, orthogonal to the unit circle.
	let alpha = PI / pg;
	let edge = acosh(cos(PI / qg) / sin(alpha));
	let xmid = tanh(edge * 0.5);
	let c = (xmid + 1.0 / xmid) * 0.5;
	let r = (1.0 / xmid - xmid) * 0.5;
	var parity = 0.0;
	for (var i = 0; i < 28; i = i + 1) {
		let ang = atan2(z.y, z.x);
		let turn = round(ang / (2.0 * alpha));
		z = rot2(z, -turn * 2.0 * alpha);
		if (z.y < 0.0) {
			z.y = -z.y;
			parity = 1.0 - parity;
		}
		let w = z - vec2<f32>(c, 0.0);
		let w2 = dot(w, w);
		if (w2 < r * r) {
			z = vec2<f32>(c, 0.0) + w * (r * r / w2);
			parity = 1.0 - parity;
		} else {
			break;
		}
	}
	let euclid = length(z - vec2<f32>(c, 0.0)) - r;
	let lambda = 2.0 / max(1.0 - dot(z, z), 1e-4);
	var dh = euclid * lambda;
	// Secondary mirror lines (the {p,q} triangle group) appear with morph.
	let mirror = abs(z.y) * lambda;
	dh = min(dh, select(10.0, mirror * 1.6 + 0.02, s.morph > 0.55));
	let d = dh * cos(b) / scale;
	return mark(d, parity, fract(parity * 0.5 + length(z) * 0.21), clamp(length(z), 0.0, 1.0));
}

// ---- family 7: golden-angle phyllotaxis (logarithmic lattice) ----
fn phyllotaxis(variant: i32, s: Site) -> Mark {
	let e1 = s.phyllo.xy;
	let e2 = s.phyllo.zw;
	let p = vec2<f32>(s.whole.x + s.phylloShift.x * s.cellsAround, s.depthCells + s.phylloShift.y);
	let det = e1.x * e2.y - e1.y * e2.x;
	let inv = vec2<f32>(e2.y * p.x - e2.x * p.y, -e1.y * p.x + e1.x * p.y) / det;
	let base = round(inv);
	var d1 = 1e5;
	var d2 = 1e5;
	var best = base;
	for (var i = -1; i <= 1; i = i + 1) {
		for (var j = -1; j <= 1; j = j + 1) {
			let lp = base + vec2<f32>(f32(i), f32(j));
			let pt = lp.x * e1 + lp.y * e2;
			let dd = length(p - pt);
			if (dd < d1) {
				d2 = d1;
				d1 = dd;
				best = lp;
			} else if (dd < d2) {
				d2 = dd;
			}
		}
	}
	let spacing = min(length(e1), length(e2));
	let seedR = spacing * (0.4 + s.morph * 0.1);
	var d = abs(d1 - seedR);
	var fill = smoothstep(seedR, seedR * 0.6, d1);
	if (variant == 1) {
		d = (d2 - d1) * 0.5;
		fill = smoothstep(spacing * 0.5, 0.0, d1);
	} else if (variant == 2) {
		d = min(abs(d1 - seedR * 0.45), abs(d1 - seedR * 1.05));
	} else if (variant == 3) {
		let fu = abs(inv.x - round(inv.x)) * abs(det) / max(length(e2), 1e-4);
		let fv = abs(inv.y - round(inv.y)) * abs(det) / max(length(e1), 1e-4);
		d = min(min(fu, fv), abs(d1 - seedR * 0.4));
	}
	// The seed's own index along the spiral: stable while the lattice travels.
	let seedIndex = dot(best, s.phylloIndex);
	let id = fract((seedIndex + s.seedRow) * 0.618034);
	return mark(d, fill, id, smoothstep(0.0, seedR, seedR - d1));
}

// ---- family 8: rings counting sequences round the whole circle ----
fn sequenceCount(variant: i32, index: i32) -> f32 {
	var fib = array<f32, 12>(1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0, 55.0, 89.0, 144.0, 233.0);
	var primes = array<f32, 12>(2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 17.0, 19.0, 23.0, 29.0, 31.0, 37.0);
	var tri = array<f32, 12>(1.0, 3.0, 6.0, 10.0, 15.0, 21.0, 28.0, 36.0, 45.0, 55.0, 66.0, 78.0);
	if (variant == 0) { return fib[index]; }
	if (variant == 1) { return primes[index]; }
	if (variant == 2) { return exp2(f32(index)); }
	return tri[index];
}

fn rings(variant: i32, s: Site) -> Mark {
	let y = s.whole.y;
	let band = floor(y);
	let rowIndex = band + s.row;
	let index = i32(rowIndex - 12.0 * floor(rowIndex / 12.0));
	let count = sequenceCount(variant, clamp(index, 0, 11));
	let fy = fract(y);
	let around = s.whole.x / max(s.cellsAround, 1.0);
	let slot = around * count;
	let arc = (fract(slot) - 0.5) * s.cellsAround / count;
	var d = min(fy, 1.0 - fy);
	let room = min(0.32, 0.45 * s.cellsAround / count);
	var fill = 0.0;
	if (variant == 0) {
		let bead = length(vec2<f32>(arc, fy - 0.5)) - room;
		d = min(d, abs(bead));
		fill = step(bead, 0.0);
	} else if (variant == 1) {
		let tick = max(abs(arc) - 0.012, abs(fy - 0.5) - 0.3);
		d = min(d, abs(tick));
		fill = step(tick, 0.0);
	} else if (variant == 2) {
		let dotR = length(vec2<f32>(arc, fy - 0.5)) - room * 0.6;
		d = min(min(d, abs(dotR)), abs(fy - 0.5) + 0.06);
		fill = step(dotR, 0.0);
	} else {
		let lensA = length(vec2<f32>(arc, fy - 0.5) - vec2<f32>(room * 0.55, 0.0)) - room;
		let lensB = length(vec2<f32>(arc, fy - 0.5) + vec2<f32>(room * 0.55, 0.0)) - room;
		let petal = max(lensA, lensB);
		d = min(d, abs(petal));
		fill = step(petal, 0.0);
	}
	let id = hash2(floor(slot) + rowIndex * 977.0, rowIndex);
	return mark(d, fill, id, f32(index) / 11.0);
}

fn grammar(slot: f32, s: Site) -> Mark {
	let g = i32(round(slot));
	let family = g / 4;
	let variant = g - family * 4;
	if (family == 0) { return truchet(s.fold, variant, s); }
	if (family == 1) { return flower(s.fold, variant, s); }
	if (family == 2) { return yantra(s.fold, variant, s); }
	if (family == 3) { return girih(s.fold, variant, s); }
	if (family == 4) { return lace(s.fold, variant, s); }
	if (family == 5) { return apollonian(s.fold, variant, s); }
	if (family == 6) { return hyperbolic(variant, s); }
	if (family == 7) { return phyllotaxis(variant, s); }
	return rings(variant, s);
}

// Lines carved and inlaid, read off one grammar slot.
struct Carve {
	line: f32,
	fill: f32,
	height: f32,
	glow: f32,
	shade: f32,
};

fn carve(m: Mark, width: f32, aa: f32) -> Carve {
	var c: Carve;
	// Softness (ambient) blurs the line's profile without dimming it.
	let soft = params.mood.x * 0.025;
	let w = width + soft * 0.5;
	let line = 1.0 - smoothstep(w - aa - soft, w + aa + soft, m.d);
	// Past the pixel footprint the carving resolves to its average, so the
	// infinitely fine centre never shimmers.
	let detail = 1.0 - smoothstep(0.18, 0.7, aa);
	c.line = mix(min(0.5, w * 3.0), line, detail);
	c.fill = mix(0.3, m.fill, detail);
	c.height = (1.0 - smoothstep(0.0, w * 2.6 + aa, m.d)) * 0.8 + m.fill * 0.25;
	c.glow = binAt(m.id) * detail + (1.0 - detail) * 0.3;
	c.shade = m.shade;
	return c;
}

fn blendCarve(a: Carve, b: Carve, t: f32) -> Carve {
	var c: Carve;
	c.line = mix(a.line, b.line, t);
	c.fill = mix(a.fill, b.fill, t);
	c.height = mix(a.height, b.height, t);
	c.glow = mix(a.glow, b.glow, t);
	c.shade = mix(a.shade, b.shade, t);
	return c;
}

// Ray against the tunnel: round, polygonal, or a blend. Returns t and the
// inward wall normal (xy).
fn polygonHit(o: vec2<f32>, d: vec2<f32>, radius: f32, sides: f32, turn: f32) -> vec3<f32> {
	let sector = TAU / sides;
	let start = turn * sector;
	let k0 = round((atan2(d.y, d.x) - start) / sector);
	var best = vec3<f32>(1e4, 0.0, 0.0);
	for (var i = -1; i <= 1; i = i + 1) {
		let ang = start + (k0 + f32(i)) * sector;
		let n = vec2<f32>(cos(ang), sin(ang));
		let den = dot(d, n);
		if (den > 1e-6) {
			let t = (radius - dot(o, n)) / den;
			if (t > 0.0 && t < best.x) {
				best = vec3<f32>(t, -n);
			}
		}
	}
	return best;
}

fn roundHit(o: vec2<f32>, d: vec2<f32>, radius: f32) -> vec3<f32> {
	let a = max(dot(d, d), 1e-9);
	let b = dot(o, d);
	let c = dot(o, o) - radius * radius;
	let t = min((-b + sqrt(max(b * b - a * c, 0.0))) / a, 1e4);
	let h = o + d * t;
	return vec3<f32>(t, -h / max(length(h), 1e-5));
}

fn shapeHit(o: vec2<f32>, d: vec2<f32>, radius: f32, sides: f32) -> vec3<f32> {
	if (sides < 2.5) {
		return roundHit(o, d, radius);
	}
	return polygonHit(o, d, radius, sides, params.shape.w);
}

fn tunnelHit(o: vec2<f32>, d: vec2<f32>, radius: f32) -> vec3<f32> {
	let a = shapeHit(o, d, radius, params.shape.x);
	if (params.shape.z <= 0.0) { return a; }
	let b = shapeHit(o, d, radius, params.shape.y);
	let t = params.shape.z;
	let n = normalize(mix(a.yz, b.yz, t) + vec2<f32>(1e-6, 0.0));
	return vec3<f32>(mix(a.x, b.x, t), n);
}

// Surface coordinates for one layer at a tunnel point (angle, log depth).
fn site(theta: f32, logDepth: f32, travel: vec4<f32>, scale: vec4<f32>, phyllo: vec4<f32>, index: vec2<f32>, folds: f32) -> Site {
	var s: Site;
	let cells = scale.y;
	let around = cells * TAU;
	let depthCells = logDepth * cells;
	let row = travel.x;
	let y = depthCells + travel.y;
	// Fracture: every ring band of the carving is knocked round by its own
	// amount, so harsh music shatters the mandala into offset rings.
	let bandHash = hash2(floor(y) + row, 17.0) - 0.5;
	let angle = theta + params.spinRail.x + params.spinRail.y * logDepth + bandHash * params.form.w * 0.9;
	let sector = TAU / max(folds, 1.0);
	var a = angle - sector * floor(angle / sector);
	a = min(a, sector - a);
	s.fold = vec2<f32>(a * cells, y);
	s.whole = vec2<f32>(fract(angle / TAU) * around, y);
	s.depthCells = depthCells;
	s.row = row;
	s.cellsAround = around;
	s.halfCells = scale.z;
	s.hyper = scale.x;
	s.phyllo = phyllo;
	s.phylloIndex = index;
	s.phylloShift = travel.zw;
	s.seedRow = scale.w;
	s.morph = params.form.z;
	return s;
}

fn layerCarve(gA: f32, fA: f32, gB: f32, fB: f32, mixB: f32, theta: f32, logDepth: f32,
		travel: vec4<f32>, scale: vec4<f32>, phyllo: vec4<f32>, index: vec2<f32>, width: f32, aa: f32) -> Carve {
	let sA = site(theta, logDepth, travel, scale, phyllo, index, fA);
	let a = carve(grammar(gA, sA), width, aa);
	if (mixB <= 0.0) { return a; }
	let sB = site(theta, logDepth, travel, scale, phyllo, index, fB);
	let b = carve(grammar(gB, sB), width, aa);
	return blendCarve(a, b, mixB);
}

fn wallCarve(theta: f32, logDepth: f32, aa: f32) -> Carve {
	return layerCarve(params.wallSlots.x, params.wallSlots.y, params.wallSlots.z, params.wallSlots.w,
		params.slotMix.x, theta, logDepth, params.wallTravel, params.wallScale, params.wallPhyllo, params.phylloIndex.xy,
		params.form.x, aa);
}

fn screenCarve(theta: f32, logDepth: f32, aa: f32) -> Carve {
	return layerCarve(params.screenSlots.x, params.screenSlots.y, params.screenSlots.z, params.screenSlots.w,
		params.slotMix.y, theta, logDepth, params.screenTravel, params.screenScale, params.screenPhyllo, params.phylloIndex.zw,
		params.form.x * 1.15 + 0.012, aa);
}

// The fretwork is solid where it is carved thick, pierced elsewhere.
fn screenCover(c: Carve) -> f32 {
	return clamp(c.line, 0.0, 1.0) * params.slotMix.z;
}

fn rigLight(index: i32) -> vec4<f32> {
	if (index == 0) { return vec4<f32>(params.rigA.xyz, 1.0 - params.rigB.w * 0.5); }
	return vec4<f32>(params.rigB.xyz, 0.5 + params.rigB.w * 0.5);
}

// In-scattering of a soft point light along a ray segment (closed form).
fn scatter(origin: vec3<f32>, dir: vec3<f32>, t0: f32, t1: f32, light: vec3<f32>, soft: f32) -> f32 {
	let rel = light - origin;
	let tc = dot(rel, dir);
	let h2 = max(dot(rel, rel) - tc * tc, 0.0) + soft * soft;
	let h = sqrt(h2);
	return (atan((t1 - tc) / h) - atan((t0 - tc) / h)) / h;
}

struct Lit {
	color: vec3<f32>,
	ring: f32,
};

// Shade one carved surface point (tunnel coordinates) with every light.
fn shade(pos: vec3<f32>, normal: vec3<f32>, view: vec3<f32>, c: Carve, isScreen: bool, shadowed: bool) -> Lit {
	let metalMask = clamp(c.line, 0.0, 1.0);
	// Filled cells are dark polished glass: they read by what they reflect.
	let glass = c.fill * (1.0 - metalMask);
	let stone = params.stoneTint.rgb * (0.5 + c.shade * 0.3) * (1.0 - glass * 0.45);
	// Inlays wrap the light round their curved profile, so a lit line reads whole.
	let wrapLight = metalMask * 0.55;
	let metal = params.metalTint.rgb;
	let albedo = mix(stone, metal * 0.55, metalMask);
	let gloss = mix(params.stoneTint.w, 1.0, max(metalMask, glass * 0.8));
	let shininess = mix(mix(10.0, 46.0, glass), 70.0 + params.character.z * 120.0, metalMask);
	var diffuse = vec3<f32>(0.0);
	var specular = vec3<f32>(0.0);

	// Rig lights, carried behind the camera. The wall sees them through the
	// fretwork: its pierced pattern falls on the carving as a shadow.
	for (var i = 0; i < 2; i = i + 1) {
		let rig = rigLight(i);
		let toLight = rig.xyz - pos;
		let dist2 = dot(toLight, toLight);
		let l = toLight * inverseSqrt(max(dist2, 1e-6));
		var visible = 1.0;
		if (shadowed && params.slotMix.z > 0.01) {
			// Where the ray from the rig to this point pierces the screen.
			let back = -l;
			let crossing = tunnelHit(rig.xy, back.xy, params.slotMix.w);
			let sp = rig.xyz + back * min(crossing.x, sqrt(dist2));
			let blocker = screenCarve(atan2(sp.y, sp.x), log(max(sp.z, 0.02)), 0.08);
			visible = 1.0 - screenCover(blocker) * 0.92;
		}
		// Spot cone, with a little spill so the tunnel never goes fully black.
		let aim = select(params.spots.y, params.spots.x, i == 0);
		let spotDir = normalize(vec3<f32>(cos(aim), sin(aim), params.spots.z));
		let cone = smoothstep(params.spots.w, params.spots.w + 0.16, dot(-l, spotDir));
		let gain = params.rigTint.w * rig.w * (0.35 + cone * 0.65) / (dist2 + params.rigA.w * params.rigA.w);
		let ndl = max((dot(normal, l) + wrapLight) / (1.0 + wrapLight), 0.0);
		diffuse = diffuse + params.rigTint.rgb * gain * ndl * visible;
		let hv = normalize(l + view);
		specular = specular + params.rigTint.rgb * gain * pow(max(dot(normal, hv), 0.0), shininess) * visible * gloss;
	}

	// Sconces fixed along the wall: pools of light the flight passes through.
	let logDepth = log(max(pos.z, 0.02));
	let spacing = params.sconce.x;
	let index = floor((logDepth + params.sconce.y) / spacing);
	for (var k = -1; k <= 1; k = k + 1) {
		let n = index + f32(k);
		let sl = (n + 0.5) * spacing - params.sconce.y;
		let sz = exp(sl);
		let ang = params.sconce.w + n * params.sconce.z - params.spinRail.x - params.spinRail.y * sl;
		let sp = vec3<f32>(cos(ang) * 0.82, sin(ang) * 0.82, sz);
		let toLight = sp - pos;
		let dist2 = dot(toLight, toLight);
		let l = toLight * inverseSqrt(max(dist2, 1e-6));
		let bandIndex = i32(n - 6.0 * floor(n / 6.0));
		var level = params.band.x;
		if (bandIndex == 1) { level = params.band.y; }
		if (bandIndex == 2) { level = params.band.z; }
		if (bandIndex == 3) { level = params.band.w; }
		if (bandIndex == 4) { level = params.audio.z; }
		if (bandIndex == 5) { level = params.audio.y; }
		// A contained pool: bright at the sconce, gone a third of its depth away.
		let soft = 0.22 * sz;
		let pool = exp(-dist2 / (0.09 * sz * sz));
		let gain = params.sconceTint.w * (0.35 + level * 0.9) * (sz * sz * 0.04 / (dist2 + soft * soft)) * (0.25 + pool * 0.75);
		let ndl = max((dot(normal, l) + wrapLight) / (1.0 + wrapLight), 0.0);
		diffuse = diffuse + params.sconceTint.rgb * gain * ndl;
		let hv = normalize(l + view);
		specular = specular + params.sconceTint.rgb * gain * pow(max(dot(normal, hv), 0.0), shininess) * gloss;
	}

	// Beat rings: bands of light hugging the wall, rushing out of the depths.
	var ring = 0.0;
	for (var r = 0; r < 6; r = r + 1) {
		var zr = params.ringsA.x;
		var sr = params.ringsA.y;
		if (r == 1) { zr = params.ringsA.z; sr = params.ringsA.w; }
		if (r == 2) { zr = params.ringsB.x; sr = params.ringsB.y; }
		if (r == 3) { zr = params.ringsB.z; sr = params.ringsB.w; }
		if (r == 4) { zr = params.ringsC.x; sr = params.ringsC.y; }
		if (r == 5) { zr = params.ringsC.z; sr = params.ringsC.w; }
		if (zr > 0.0) {
			let radial = length(pos.xy) - 0.9;
			let dz = (pos.z - zr) / (0.14 * zr);
			ring = ring + sr * exp(-dz * dz) / (1.0 + radial * radial * 40.0);
		}
	}
	diffuse = diffuse + params.accentTint.rgb * params.accentTint.w * ring * 0.45;

	// Light bounced round the tunnel: a little of every light, from everywhere.
	let bounce = (params.rigTint.rgb * params.rigTint.w * 0.05 + params.sconceTint.rgb * params.sconceTint.w * 0.03) * params.mood.z
		* (0.6 + 0.4 * max(normal.z + 0.5, 0.0));
	var color = albedo * (diffuse + bounce) + metal * specular * (0.4 + metalMask * 0.8);
	// Inlay emission: the music lights the carving, element by element.
	let facing = abs(dot(normal, view));
	let iri = params.character.w * (1.0 - facing);
	let glowColor = mix(params.glowTint.rgb, params.accentTint.rgb, clamp(iri + c.shade * 0.2, 0.0, 1.0));
	let emit = c.line * (0.3 + c.glow * 1.2 * (0.3 + params.audio.x) + ring * 0.9 + params.audio.w * 0.3);
	var emitGain = params.glowTint.w;
	if (isScreen) { emitGain = emitGain * 0.35; }
	color = color + glowColor * emit * emitGain;
	var out: Lit;
	out.color = color;
	out.ring = ring;
	return out;
}

fn bump(normal: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>, dhx: f32, dhy: f32) -> vec3<f32> {
	let r1 = cross(dpy, normal);
	let r2 = cross(normal, dpx);
	let det = dot(dpx, r1);
	let grad = sign(det) * (dhx * r1 + dhy * r2);
	return normalize(abs(det) * normal - grad);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let res = params.view.xy;
	let frag = in.uv * res;
	let p = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / res.y;
	var dir = normalize(vec3<f32>(p, params.view.w));
	// Look: pitch then yaw.
	let cp = cos(params.camera.y);
	let spit = sin(params.camera.y);
	dir = vec3<f32>(dir.x, dir.y * cp + dir.z * spit, -dir.y * spit + dir.z * cp);
	let cy = cos(params.camera.x);
	let sy = sin(params.camera.x);
	dir = vec3<f32>(dir.x * cy + dir.z * sy, dir.y, -dir.x * sy + dir.z * cy);
	let origin2 = params.camera.zw;
	let origin = vec3<f32>(origin2, 0.0);
	let view = -dir;

	// Wall.
	let wallHit = tunnelHit(origin2, dir.xy, 1.0);
	let tw = wallHit.x;
	let wallPos = origin + dir * tw;
	let wallTheta = atan2(wallPos.y, wallPos.x);
	let wallDepth = log(max(wallPos.z, 0.02));
	let wallAa = params.wallScale.y * length(vec2<f32>(dpdx(wallDepth), dpdy(wallDepth))) * 0.9 + 1e-4;
	let wc = wallCarve(wallTheta, wallDepth, wallAa);
	let reliefScale = params.form.y * wallPos.z / max(params.wallScale.y, 0.1) * 0.05;
	let wallNormal = bump(vec3<f32>(wallHit.yz, 0.0), dpdx(wallPos), dpdy(wallPos),
		dpdx(wc.height) * reliefScale, dpdy(wc.height) * reliefScale);
	let wallLit = shade(wallPos, wallNormal, view, wc, false, true);
	// Dev-only mask view (grain < 0): line, fill, pixel footprint.
	if (params.postC.w < 0.0) {
		return vec4<f32>(wc.line, wc.fill * 0.5, min(wallAa * 4.0, 1.0), 1.0);
	}
	let fogD = params.fogTint.w;
	// Light dies down the tunnel: the depths stay dark and structured.
	var color = wallLit.color * exp(-fogD * tw) / (1.0 + params.mood.y * wallPos.z * wallPos.z * 0.01);

	// Fretwork screen, nearer the camera.
	let screenRadius = params.slotMix.w;
	let screenHit = tunnelHit(origin2, dir.xy, screenRadius);
	let ts = min(screenHit.x, tw);
	let screenPos = origin + dir * ts;
	let screenTheta = atan2(screenPos.y, screenPos.x);
	let screenDepth = log(max(screenPos.z, 0.02));
	let screenAa = params.screenScale.y * length(vec2<f32>(dpdx(screenDepth), dpdy(screenDepth))) * 0.9 + 1e-4;
	var cover = 0.0;
	if (params.slotMix.z > 0.01) {
		let sc = screenCarve(screenTheta, screenDepth, screenAa);
		cover = screenCover(sc);
		let screenNormal = vec3<f32>(screenHit.yz, 0.0);
		let screenLit = shade(screenPos, screenNormal, view, sc, true, false);
		color = mix(color, screenLit.color * exp(-fogD * ts), cover);
	}

	// The tunnel air: absorbs with depth, scatters the rigs and the beat rings.
	var air = vec3<f32>(0.0);
	for (var i = 0; i < 2; i = i + 1) {
		let rig = rigLight(i);
		let inner = scatter(origin, dir, 0.0, ts, rig.xyz, params.rigA.w + 0.2);
		air = air + params.rigTint.rgb * params.rigTint.w * rig.w * inner * 0.05;
	}
	for (var r = 0; r < 6; r = r + 1) {
		var zr = params.ringsA.x;
		var sr = params.ringsA.y;
		if (r == 1) { zr = params.ringsA.z; sr = params.ringsA.w; }
		if (r == 2) { zr = params.ringsB.x; sr = params.ringsB.y; }
		if (r == 3) { zr = params.ringsB.z; sr = params.ringsB.w; }
		if (r == 4) { zr = params.ringsC.x; sr = params.ringsC.y; }
		if (r == 5) { zr = params.ringsC.z; sr = params.ringsC.w; }
		if (zr > 0.0 && sr > 0.0) {
			// The halo hugs the ring itself; far rings are small and thin,
			// so the depths never fill with a glowing disc.
			let tr = zr / max(dir.z, 0.05);
			let at = origin2 + dir.xy * tr;
			let rp = vec3<f32>(at / max(length(at), 1e-4) * 0.9, zr);
			let s = scatter(origin, dir, 0.0, tw, rp, 0.035 * zr) * zr;
			let near = smoothstep(9.0, 2.5, zr);
			air = air + params.accentTint.rgb * params.accentTint.w * sr * s * 0.02 * near * exp(-fogD * tr);
		}
	}
	color = color + air * params.fogTint.rgb * (fogD * 6.0);

	return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;

const POST_COMMON_WGSL = /* wgsl */ `
${PARAMS_WGSL}
${FULLSCREEN_WGSL}
`;

/**
 * Feedback: the previous frame zoomed about the vanishing point and rolled
 * with the flight, decayed, and max-blended with the new scene, so lit
 * carving leaves short trails streaming outward along the travel.
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
 * Exposure meter: averages the frame on a coarse grid and eases toward it
 * with the previous frame's reading, all on the GPU (no readback).
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
	var peak = 0.0;
	for (var y = 0; y < 10; y = y + 1) {
		for (var x = 0; x < 16; x = x + 1) {
			let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) / vec2<f32>(16.0, 10.0);
			let c = textureSampleLevel(frameTexture, linearSampler, uv, 0.0).rgb;
			let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
			sum = sum + l;
			peak = max(peak, l);
		}
	}
	let mean = sum / 160.0;
	let previous = textureSampleLevel(previousTexture, linearSampler, vec2<f32>(0.5, 0.5), 0.0);
	// First frames (or a reset) have nothing to ease from.
	let fresh = select(0.0, 1.0, previous.a < 0.5);
	// Silence adapts slowly, so a pause never pumps the picture up.
	let k = mix(0.05 * (1.0 - params.spinRail.w * 0.7), 1.0, fresh);
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
	// Lens: a touch of barrel, aberration that grows toward the rim and flares on impact.
	let warped = 0.5 + centered * (1.0 + r2 * 0.04);
	let caAmount = (0.00025 + r2 * 0.0026) * params.post.w;
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let scene = vec3<f32>(
		textureSampleLevel(frameTexture, linearSampler, warped + direction * caAmount, 0.0).r,
		textureSampleLevel(frameTexture, linearSampler, warped, 0.0).g,
		textureSampleLevel(frameTexture, linearSampler, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTexture, linearSampler, warped, 0.0).rgb;
	// Adapted exposure: lift dark looks, hold bright ones, never fully
	// normalise (quiet passages stay quieter than drops).
	let metered = textureSampleLevel(exposureTexture, linearSampler, vec2<f32>(0.5, 0.5), 0.0);
	let mean = max(metered.r, 1e-4);
	let adapt = clamp(pow(params.mood.w / mean, 0.5), 0.45, 2.2);
	let exposure = params.postB.w * adapt;
	let vignette = 1.0 - smoothstep(0.35, 0.95, length(centered * vec2<f32>(resolution.x / max(resolution.y, 1.0), 1.0)) * params.postC.z);
	var color = (scene + bloom * params.postC.x) * exposure * (0.72 + vignette * 0.28);
	color = aces(color);
	color = max((color - 0.5) * params.postC.y + 0.5, vec3<f32>(0.0));
	let shoulderStart = 0.86;
	let shoulderRange = 0.125;
	let over = max(color - vec3<f32>(shoulderStart), vec3<f32>(0.0));
	color = min(color, vec3<f32>(shoulderStart)) + (1.0 - exp(-over / shoulderRange)) * shoulderRange;
	color = color + (ign(in.uv * resolution, params.view.z) - 0.5) * (params.postC.w / 255.0);
	return vec4<f32>(color, 1.0);
}
`;

export const MANDALA_SCENE_WGSL = SCENE_WGSL;
