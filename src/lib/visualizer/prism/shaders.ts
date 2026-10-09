// Prism: an obsidian stained-glass rose. The production scene is a lit rose
// window set in a dark nave: jewel glass in lead came, carved stone tracery on
// its own parallax plane, a moulded archivolt and clustered jambs that run down
// to a polished obsidian floor. The glass is a living mosaic: its cells divide
// as a phrase grows and re-draft at phrase boundaries, beats travel through the
// facets as packets of light, and each section re-leads the window with a new
// composition that washes outward from the centre.
//
// WGSL footguns (see docs/loom-visualizer-handoff.md section 19): every binding
// must stay referenced from an entry point because pipelines use layout auto,
// and a backtick anywhere in these template strings ends the JS literal.

export const PRISM_BIN_COUNT = 64;

/** Uniform floats: 24 legacy scalars + 15 vec4 groups. */
export const PRISM_UNIFORM_FLOATS = 84;
export const PRISM_UNIFORM_BYTES = PRISM_UNIFORM_FLOATS * 4;

/** Float offsets of each vec4 group, mirrored by the WGSL Uniforms struct. */
export const PRISM_UNIFORM_OFFSETS = {
	comp: 24,
	shapeA: 28,
	shapeB: 32,
	organism: 36,
	light: 40,
	modes: 44,
	sun: 48,
	heroCol: 52,
	supportCol: 56,
	accentCol: 60,
	fieldCol: 64,
	post: 68,
	env: 72,
	bands: 76,
	motion: 80
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
	// foldA, foldB, transition front (rose radii), transition glow
	comp: vec4<f32>,
	// petalWidth, petalReach, cellScale, outerLit (composition A)
	shapeA: vec4<f32>,
	// petalWidth, petalReach, cellScale, outerLit (composition B)
	shapeB: vec4<f32>,
	// growth, phraseIndex, phrasePos, seedSalt
	organism: vec4<f32>,
	// backlight, packetStrength, beatAge, beatCount
	light: vec4<f32>,
	// rings, spiral, petals, coolness
	modes: vec4<f32>,
	// sunX, sunY, sunPower, haze
	sun: vec4<f32>,
	heroCol: vec4<f32>,
	supportCol: vec4<f32>,
	accentCol: vec4<f32>,
	fieldCol: vec4<f32>,
	// feedbackFade, feedbackZoom, bloomThreshold, aberration
	post: vec4<f32>,
	// driftX, driftY, silence, roseRotation
	env: vec4<f32>,
	// low, mid, high, impact
	bands: vec4<f32>,
	// rotationDelta, frame, energy, unused
	motion: vec4<f32>,
};

const TAU: f32 = 6.28318530718;
const PI: f32 = 3.14159265359;
// Rose centre and radius in screen-height units (y up, origin at centre).
const ROSE_C: vec2<f32> = vec2<f32>(0.0, 0.07);
const ROSE_R: f32 = 0.32;
const FLOOR_Y: f32 = -0.29;

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

// Integer hashes and small helpers shared by the rose and the presentation.
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
`;

// ---------------------------------------------------------------------------
// Production scene: the rose window and its nave.
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

struct Fold {
	q: vec2<f32>,
	wedge: f32,
	side: f32,
};

// Mirror the plane into one half-wedge of an n-fold rose. q.x runs along the
// wedge axis, q.y is the (non-negative) distance from it.
fn foldRose(p: vec2<f32>, n: f32) -> Fold {
	let r = length(p);
	let a = atan2(p.y, p.x);
	let seg = TAU / n;
	let k = floor(a / seg + 0.5);
	let local = a - k * seg;
	let m = abs(local);
	var f: Fold;
	f.q = vec2<f32>(cos(m), sin(m)) * r;
	f.wedge = k - n * floor(k / n);
	f.side = select(-1.0, 1.0, local >= 0.0);
	return f;
}

fn sdVesica(p0: vec2<f32>, r: f32, d: f32) -> f32 {
	let p = abs(p0);
	let b = sqrt(max(r * r - d * d, 0.0));
	if ((p.y - b) * d > p.x * b) {
		return length(p - vec2<f32>(0.0, b));
	}
	return length(p - vec2<f32>(-d, 0.0)) - r;
}

struct Tracery {
	sd: f32,
	kind: f32,
};

// Glass openings of the rose in folded, radius-normalised space.
// kind: 1 hero petal, 2 roundel, 3 spandrel eye, 4 rim, 5 boss.
fn tracery(q: vec2<f32>, n: f32, shape: vec4<f32>) -> Tracery {
	let rn = length(q);
	let h = PI / n;
	var t: Tracery;

	// Boss: a small dark obsidian eye, never a glowing orb.
	t.sd = rn - 0.13;
	t.kind = 5.0;

	// Hero petals: pointed vesicas on every wedge axis.
	let a0 = 0.17;
	let a1 = shape.y;
	let c = (a0 + a1) * 0.5;
	let halfLen = (a1 - a0) * 0.5;
	let halfWid = clamp(shape.x * c * sin(h) * 0.94, 0.02, halfLen * 0.86);
	let vr = (halfWid + halfLen * halfLen / halfWid) * 0.5;
	let vd = (halfLen * halfLen / halfWid - halfWid) * 0.5;
	let dPetal = sdVesica(vec2<f32>(q.y, q.x - c), vr, vd);
	if (dPetal < t.sd) { t.sd = dPetal; t.kind = 1.0; }

	// Roundels: two per wedge on the outer tier.
	let rc = clamp(a1 + 0.13, 0.66, 0.8);
	let ra = h * 0.5;
	let rCenter = vec2<f32>(cos(ra), sin(ra)) * rc;
	let rr = min(min(rc * sin(ra) * 0.86, 0.915 - rc), 0.13);
	let dRound = length(q - rCenter) - rr;
	if (dRound < t.sd) { t.sd = dRound; t.kind = 2.0; }

	// Spandrel eyes sit on the mirror line between petals.
	let rs = a1 * 0.72 + 0.05;
	let sCenter = vec2<f32>(cos(h), sin(h)) * rs;
	let gap = max(rs * sin(h) - halfWid * 0.85, 0.012);
	let dEye = length(q - sCenter) - min(gap * 0.55, 0.05);
	if (dEye < t.sd) { t.sd = dEye; t.kind = 3.0; }

	// Rim: a narrow ring of small glass.
	let dRim = abs(rn - 0.962) - 0.026;
	if (dRim < t.sd) { t.sd = dRim; t.kind = 4.0; }
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
// the cell visibly divides. Positions re-draft at the end of every phrase.
fn mosaicSeed(g: vec2<f32>, which: u32) -> vec3<f32> {
	let salt = seedSalt();
	let phrase = u32(max(u.organism.y, 0.0));
	let jNow = hcell(g, salt ^ (phrase * 0x9e3779b1u));
	let jNext = hcell(g, salt ^ ((phrase + 1u) * 0x9e3779b1u));
	let redraft = smoothstep(0.82, 1.0, u.organism.z);
	let j = mix(jNow, jNext, redraft);
	let base = g + 0.5 + (j - 0.5) * 0.62;
	let dv = hcell(g, salt ^ 0x51ed270bu);
	let split = smoothstep(dv.x * 0.8, dv.x * 0.8 + 0.2, u.organism.x);
	let axis = dv.y * TAU + j.x * 1.7;
	let off = vec2<f32>(cos(axis), sin(axis)) * split * 0.21;
	let sgn = select(-1.0, 1.0, which == 1u);
	return vec3<f32>(base + off * sgn, split);
}

fn mosaic(x: vec2<f32>) -> Cell {
	let g0 = floor(x);
	var pts: array<vec3<f32>, 18>;
	var cellOf: array<vec2<f32>, 18>;
	var best = 1e9;
	var bestI = 0;
	for (var j = 0; j < 9; j = j + 1) {
		let g = g0 + vec2<f32>(f32(j % 3) - 1.0, f32(j / 3) - 1.0);
		for (var w = 0; w < 2; w = w + 1) {
			let i = j * 2 + w;
			let s = mosaicSeed(g, u32(w));
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
	let salt = seedSalt() ^ 0x2c1b3c6du;
	let motherId = hcell(owner, salt);
	var id = motherId;
	if ((bestI % 2) == 1) {
		id = mix(motherId, hcell(owner + vec2<f32>(517.0, 211.0), salt), pts[bestI].z);
	}
	var c: Cell;
	c.edge = edge;
	c.id = id;
	c.center = a;
	c.birth = birth;
	return c;
}

fn wrapAngle(a: f32) -> f32 {
	return a - TAU * floor(a / TAU + 0.5);
}

// Light that the window lets through: a slow sun drifting behind the glass and
// clouds passing across it, so a symmetric window is never lit symmetrically.
fn backlight(rel: vec2<f32>) -> f32 {
	let d = rel - u.sun.xy;
	let hot = exp(-dot(d, d) * 9.0) * u.sun.z;
	let drift = vec2<f32>(u.time * 0.031, -u.time * 0.019) + vec2<f32>(u.organism.w * 0.0007, 0.0);
	let cloud = 0.62 + 0.62 * vnoise(rel * 3.1 + drift) * (0.6 + 0.4 * vnoise(rel * 7.3 - drift * 1.7));
	return u.light.x * (0.42 + hot) * cloud;
}

// Beat light travelling through the facets. Each mode reads a cell's centre so
// the light jumps piece to piece rather than sweeping as a smooth gradient.
fn packet(cellRn: f32, cellAngle: f32, wedge: f32, n: f32) -> f32 {
	let age = clamp(u.light.z, 0.0, 1.0);
	let tail = pow(1.0 - age, 1.3);
	let front = 0.1 + age * 1.15;
	let ring = exp(-pow((cellRn - front) * 6.5, 2.0));

	let seg = TAU / n;
	let sweep = (u.light.w + age) * seg;
	let angDist = abs(wrapAngle(cellAngle - sweep));
	let spiral = exp(-pow(angDist / (seg * 0.55), 2.0)) * exp(-pow((cellRn - (0.14 + age * 0.86)) * 3.4, 2.0));

	let chosen = floor(hnum(u.light.w, seedSalt() ^ 0x7a3du) * n);
	let halfN = floor(n * 0.5);
	let opposite = chosen + halfN - n * floor((chosen + halfN) / n);
	let petalOn = select(0.0, 1.0, abs(wedge - chosen) < 0.5 || abs(wedge - opposite) < 0.5);

	let shapeSum = u.modes.x * ring + u.modes.y * spiral + u.modes.z * petalOn * ring;
	return u.light.y * tail * shapeSum;
}

fn stoneTint() -> vec3<f32> {
	return vec3<f32>(0.11, 0.1, 0.12);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let p = vec2<f32>(frag.x - 0.5 * res.x, 0.5 * res.y - frag.y) / res.y;
	// The floor and everything below it belong to the presentation pass.
	if (p.y < FLOOR_Y) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}

	let drift = u.env.xy;
	let rel = p - ROSE_C;
	let rot = u.env.w;
	// Three planes: glass sits deepest, carved tracery in front of it, and the
	// wall architecture in front of both, so a drifting camera reveals depth.
	let glassRel = rel - drift * 0.35;
	let stoneRel = rel - drift * 0.7;
	let wallRel = rel - drift;
	let glassP = rot2(rot) * glassRel / ROSE_R;
	let stoneP = rot2(rot) * stoneRel / ROSE_R;
	let rnS = length(stoneP);
	let rnW = length(wallRel) / ROSE_R;

	let useB = rnW < u.comp.z;
	let n = select(u.comp.x, u.comp.y, useB);
	let shape = select(u.shapeA, u.shapeB, useB);
	let back = backlight(glassRel);
	let hero = u.heroCol.rgb;
	let support = u.supportCol.rgb;
	let accent = u.accentCol.rgb;
	let field = u.fieldCol.rgb;
	let seam = u.comp.w * exp(-pow((rnW - u.comp.z) * 9.0, 2.0));
	let lead = vec3<f32>(0.004, 0.0035, 0.005);

	var col = vec3<f32>(0.0);

	if (rnS < 1.0) {
		let fs = foldRose(stoneP, n);
		let ts = tracery(fs.q, n, shape);

		// Carved stone: near black, catching coloured spill on its bevels.
		let spill = exp(-max(ts.sd, 0.0) * 22.0) * back;
		let bevel = exp(-pow((ts.sd - 0.016) * 150.0, 2.0));
		let ridge = exp(-pow(ts.sd * 260.0, 2.0));
		col = stoneTint() * (0.05 + back * 0.12)
			+ mix(hero, accent, 0.35) * spill * 0.12
			+ accent * bevel * back * 0.14
			+ support * ridge * back * 0.05;

		if (ts.sd < 0.006) {
			let fg = foldRose(glassP, n);
			let cellScale = shape.z;
			let cell = mosaic(fg.q * cellScale);
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
			}
			// Mosaic: mostly the role colour in varied density, with sparse pieces of
			// the neighbouring roles and the odd deep variant of the main one.
			var glass = c1 * mix(1.0, 0.55, smoothstep(0.32, 0.36, cell.id.x) * (1.0 - smoothstep(0.44, 0.48, cell.id.x)));
			glass = mix(glass, c2 * 0.75, smoothstep(0.76, 0.8, cell.id.x));
			glass = mix(glass, c3, smoothstep(0.93, 0.96, cell.id.x));

			let density = 0.3 + 0.95 * cell.id.y * cell.id.y;
			let interior = smoothstep(0.0, 0.42, cell.edge);
			let grainDir = vec2<f32>(cos(cell.id.y * 9.0), sin(cell.id.y * 9.0));
			let streak = 0.88 + 0.12 * sin(dot(fg.q * cellScale, grainDir) * 17.0 + cell.id.x * 40.0);
			let cq = cell.center / cellScale;
			let cellRn = length(cq);
			let cellAngle = (fs.wedge * TAU / n) + fs.side * atan2(cq.y, cq.x);
			let spectral = bins[clamp(i32(cellRn * 46.0), 0, ${PRISM_BIN_COUNT - 1})];

			let transmitted = back * density * tierLit * (0.5 + 0.5 * interior) * streak * (0.82 + spectral * 0.45);
			let pk = packet(cellRn, cellAngle, fs.wedge, n) * (0.35 + 0.65 * tierLit);
			var g = glass * (transmitted + pk * 2.4) * 2.7
				+ mix(glass, accent, 0.5) * cell.birth * (0.5 + back * 1.4)
				+ glass * seam * 2.2;

			// Lead came between pieces and around every opening.
			let came = 1.0 - smoothstep(0.075, 0.15, cell.edge);
			let leadGlint = accent * back * 0.03 * exp(-pow((cell.edge - 0.02) * 60.0, 2.0));
			g = mix(g, lead + leadGlint, came);
			let rimLead = smoothstep(-0.026, -0.01, ts.sd);
			g = mix(g, lead, rimLead);
			if (kind == 5.0) {
				// Polished obsidian boss: it only mirrors the window, a dim sheen
				// that leans toward the sun and a fine bright edge.
				let sheenDir = normalize(u.sun.xy - glassRel + vec2<f32>(1e-4, 0.0));
				let sheen = pow(max(dot(normalize(glassP + vec2<f32>(1e-4, 0.0)), rot2(rot) * sheenDir), 0.0), 3.0);
				g = g * 0.6 + mix(support, accent, 0.5) * (sheen * length(glassP) * 0.5 + exp(-pow((ts.sd + 0.03) * 90.0, 2.0)) * 0.25) * back;
			}
			let opening = smoothstep(0.006, -0.002, ts.sd);
			col = mix(col, g, opening);
		}
	} else {
		// Wall around the rose: a static moulded ring, radiating voussoirs, and
		// a pointed archivolt whose jambs run down to the floor.
		let spillW = back * exp(-max(rnW - 1.0, 0.0) * 2.1);
		let a = atan2(wallRel.y, wallRel.x);
		let segs = n * 2.0;
		let joint = abs(fract(a / TAU * segs) - 0.5);
		let jointLine = exp(-pow((0.5 - joint) * rnW * TAU / segs * 80.0, 2.0));
		let ringBand = smoothstep(1.06, 1.08, rnW) * smoothstep(1.42, 1.38, rnW);
		let moulding = exp(-pow((rnW - 1.012) * 110.0, 2.0)) * 1.2
			+ exp(-pow((rnW - 1.055) * 140.0, 2.0)) * 0.6
			+ exp(-pow((rnW - 1.41) * 160.0, 2.0)) * 0.35;

		// Pointed arch: two arcs meeting above the frame, then straight jambs.
		let springY = -0.1;
		let halfSpan = 0.5;
		let archR = 0.78;
		let offset = archR - halfSpan;
		var archD = abs(wallRel.x) - halfSpan;
		if (wallRel.y > springY) {
			archD = length(vec2<f32>(abs(wallRel.x) + offset, wallRel.y - springY)) - archR;
		}
		let orders = exp(-pow(archD * 260.0, 2.0)) * 1.0
			+ exp(-pow((archD + 0.024) * 300.0, 2.0)) * 0.7
			+ exp(-pow((archD + 0.052) * 300.0, 2.0)) * 0.45
			+ exp(-pow((archD - 0.03) * 300.0, 2.0)) * 0.35;
		let insideArch = smoothstep(0.01, -0.02, archD);
		let roomLight = back * exp(-length(wallRel) * 2.2) * (0.6 + 0.4 * u.sun.w);

		// Ashlar courses, visible only where light reaches them.
		let course = abs(fract(p.y / 0.052) - 0.5);
		let stagger = select(0.0, 0.5, fract(floor(p.y / 0.052) * 0.5) > 0.25);
		let headJoint = abs(fract(p.x / 0.11 + stagger) - 0.5);
		let masonry = 1.0 - 0.45 * (exp(-pow((0.5 - course) * 140.0, 2.0)) + exp(-pow((0.5 - headJoint) * 90.0, 2.0)));

		let warmStone = mix(stoneTint(), accent, 0.25);
		col = warmStone * (0.035 + roomLight * 0.9 * (0.55 + insideArch * 0.6)) * masonry
			+ mix(hero, accent, 0.5) * moulding * spillW * 0.22
			+ warmStone * ringBand * spillW * (0.07 - jointLine * 0.06)
			+ mix(accent, support, 0.4) * orders * (0.035 + roomLight * 0.5);
		col = max(col, vec3<f32>(0.0));
		col = col + accent * seam * (moulding + orders * 0.5 + ringBand * 0.3) * (0.05 + spillW * 0.25);
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

// Temporal feedback around the rose centre: the previous frame follows the
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
	let center = vec2<f32>(0.5 + ROSE_C.x / aspect, 0.5 - ROSE_C.y);
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

// Presentation: lens, the nave air (haze and light shafts falling from the
// rose), the obsidian floor with its reflection and the coloured light the
// window throws onto it, then ACES, a contrast lift and IGN dither.
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

fn toUv(p: vec2<f32>, aspect: f32) -> vec2<f32> {
	return vec2<f32>(p.x / aspect + 0.5, 0.5 - p.y);
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
	let rel = p - ROSE_C;
	let dist = length(rel);
	let silence = u.env.z;
	let back = u.light.x;
	let hero = u.heroCol.rgb;
	let accent = u.accentCol.rgb;
	let field = u.fieldCol.rgb;

	// Nave air: deep field-coloured haze that thickens near the window and
	// moves slowly, so the darkness has volume instead of being flat black.
	let air = vnoise(p * 2.4 + vec2<f32>(u.time * 0.02, u.time * 0.008))
		* 0.6 + vnoise(p * 5.1 - vec2<f32>(u.time * 0.013, 0.0)) * 0.4;
	let veil = mix(1.0, 0.35, smoothstep(ROSE_R * 1.05, ROSE_R * 0.8, dist));
	let hazeTint = mix(field, mix(hero, accent, 0.4), exp(-dist * 3.0) * 0.35);
	let haze = hazeTint * (0.09 + exp(-dist * 2.2) * 0.32 * (0.35 + back)) * (0.7 + air * 0.6) * u.sun.w * veil;

	// Light shafts: march the bloom toward the rose centre. They lean downward,
	// the way sun through a high window falls into a nave.
	let lightUv = toUv(ROSE_C, aspect);
	let toLight = lightUv - warped;
	var shafts = vec3<f32>(0.0);
	var weight = 1.0;
	for (var i = 1; i <= 12; i = i + 1) {
		let s = textureSampleLevel(bloomTex, samp, warped + toLight * (f32(i) / 12.0) * 0.82, 0.0).rgb;
		shafts = shafts + s * weight;
		weight = weight * 0.86;
	}
	let downward = 0.12 + 0.88 * smoothstep(-0.1, 0.95, -rel.y / max(dist, 1e-3));
	let outside = smoothstep(ROSE_R * 0.92, ROSE_R * 1.35, dist);
	let streaks = 0.75 + 0.5 * vnoise(vec2<f32>(atan2(rel.y, rel.x) * 9.0, u.time * 0.05));
	shafts = shafts * outside * downward * streaks * (0.14 + air * 0.1) * u.sun.w;

	// Dust drifting through the light: two parallax layers of motes that only
	// show where a shaft passes, so the air between window and floor has depth.
	var motes = 0.0;
	for (var layer = 0; layer < 2; layer = layer + 1) {
		let scale = select(52.0, 30.0, layer == 1);
		let flow = vec2<f32>(u.time * 0.11, u.time * -0.045) * select(1.0, 1.7, layer == 1)
			+ u.env.xy * select(4.0, 9.0, layer == 1) * scale;
		let grid = p * scale + flow;
		let mc = floor(grid);
		let mh = hcell(mc, 91u + u32(layer));
		let md = length(grid - (mc + 0.2 + mh * 0.6));
		let present = step(0.8, hcell(mc, 37u + u32(layer)).x);
		motes = motes + smoothstep(0.11, 0.0, md) * present * select(0.6, 1.0, layer == 1);
	}
	let shaftLum = dot(shafts, vec3<f32>(0.3333));

	// Obsidian floor: a soft mirror of the window and the light it throws.
	let floorMask = smoothstep(FLOOR_Y + 0.002, FLOOR_Y - 0.004, p.y);
	let below = max(FLOOR_Y - p.y, 0.0);
	let ripple = vnoise(vec2<f32>(p.x * 7.0, below * 40.0 - u.time * 0.05)) - 0.5;
	let mirrored = vec2<f32>(warped.x + ripple * 0.004 * below * 10.0, 2.0 * (0.5 - FLOOR_Y) - warped.y);
	let reflection = mix(
		textureSampleLevel(feedbackTex, samp, mirrored, 0.0).rgb,
		textureSampleLevel(bloomTex, samp, mirrored, 0.0).rgb,
		0.45
	) * exp(-below * 4.0) * 0.55;
	// The window's colours pooled on the floor, foreshortened into the nave.
	let depthT = clamp(below / (FLOOR_Y + 0.5), 0.0, 1.0);
	let carpetP = ROSE_C + vec2<f32>(p.x * 1.6 / (0.55 + depthT * 1.3), (depthT - 0.42) * 2.3 * ROSE_R);
	let carpetUv = toUv(carpetP, aspect);
	let carpetWin = smoothstep(0.0, 0.25, depthT) * smoothstep(1.0, 0.55, depthT);
	let carpet = (textureSampleLevel(bloomTex, samp, carpetUv, 0.0).rgb * 0.5
		+ textureSampleLevel(feedbackTex, samp, carpetUv, 0.0).rgb * 0.12) * carpetWin;
	let horizon = exp(-pow((p.y - FLOOR_Y) * 140.0, 2.0)) * (0.02 + back * 0.03);
	let floorCol = vec3<f32>(0.0015, 0.0016, 0.0022) + reflection + carpet + mix(accent, hero, 0.4) * horizon;

	scene = scene * (1.0 - floorMask);
	var color = scene + haze + shafts + mix(accent, vec3<f32>(1.0), 0.35) * motes * shaftLum * 5.0 * (1.0 - floorMask)
		+ bloom * (0.9 + u.motion.z * 0.3) + floorCol * floorMask;

	let vignette = 1.0 - smoothstep(0.5, 1.15, length(centered * vec2<f32>(aspect * 0.8, 1.0)) * 1.25);
	color = color * (0.62 + vignette * 0.38) * (1.0 - silence * 0.25);
	color = aces(color * 1.05);
	color = max((color - 0.5) * 1.12 + 0.5, vec3<f32>(0.0));
	color = color + (ign(in.uv * res, u.motion.y) - 0.5) * (1.4 / 255.0);
	return vec4<f32>(color, 1.0);
}
`;
