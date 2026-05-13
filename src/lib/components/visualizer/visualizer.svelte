<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';

	const vis = useVisualizer();
	let { showHud = false } = $props<{ showHud?: boolean }>();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let raf = 0;
	let unsub: (() => void) | null = null;

	const BIN_COUNT = 64;

	// Smoothed feature envelopes — two-pole(ish) so audio drives parameters of
	// parameters rather than mapping 1:1 to geometry. Per the research: "amateur:
	// radius = bass; pro: bass nudges a target an envelope eases toward over
	// 200-800ms". Attack faster than release for punch + sustain.
	const smoothed = {
		bins: new Float32Array(BIN_COUNT),
		bass: 0,
		mid: 0,
		treble: 0,
		centroid: 0.5,
		rms: 0,
		flash: 0,
		rotation: 0, // accumulated rotation (driven by mid)
		// Chroma is circular (C wraps to B → C), so we smooth its (cos, sin)
		// unit vector and recover the angle. Avoids a 11/12→0 snap on key shifts.
		chromaX: 1,
		chromaY: 0,
		chromaStrength: 0,
		bpmNorm: 0
	};

	// Music-character → preset auto-pick. Very slowly smoothed so it doesn't
	// flicker on transients; intent must hold for ~1s before we actually switch.
	const PRESET_COUNT_LOCAL = 4;
	const presetSmoothed = [0, 0, 0, 0]; // smoothed score per preset
	let presetIntentTarget = 0; // currently leading preset
	let presetIntentFrames = 0;

	// Per-song seed. Detect new-track via RMS pattern (sustained quiet then a
	// climb back to audible). On detection, regenerate seed — shaders use it to
	// shift hash inputs so the underlying generated pattern is reshuffled.
	let songSeed = Math.random();
	let quietFrames = 0;
	let trackArmed = false; // armed = we've seen sustained quiet, watching for climb

	// Onset event roulette — each onset has a chance to trigger a brief surprise
	// (trail clear, palette jump, etc.) so reactions aren't deterministic.
	let onsetEventStrip = 0;
	let onsetEventPalJump = 0;

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}

	// Uniform layout — 24 f32s = 96 bytes, multiple of 16 for std140-ish alignment.
	const UNIFORM_FLOATS = 24;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
	const BINS_BYTES = BIN_COUNT * 4;

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
	songSeed: f32,   // 0..1, regenerated per detected new track
	palJump: f32,    // brief palette T jump from onset roulette
	sceneWeight: f32, // 0..1, scales scene output for top-2 blend rendering
	_pad3: f32,
	_pad4: f32,
};

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

// 1D value noise — used as a slow organic modulator on structural parameters
// so they drift in real time rather than being deterministic functions of audio.
// Cheap, smooth, good enough for "alive" feel.
fn snoise(t: f32) -> f32 {
	let i = floor(t);
	let f = t - i;
	let u = f * f * (3.0 - 2.0 * f);
	let h0 = fract(sin(i * 12.9898) * 43758.5453);
	let h1 = fract(sin((i + 1.0) * 12.9898) * 43758.5453);
	return mix(h0, h1, u);
}

// 4-stop iridescence: deep indigo → teal → copper-gold → magenta → loop.
// Picked stops, not RGB cosines — the cosine ramp is the rookie palette.
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

	const SCENE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash21(p: vec2<f32>) -> f32 {
	let h = dot(p, vec2<f32>(127.1, 311.7));
	return fract(sin(h) * 43758.5453);
}

fn rot(a: f32) -> mat2x2<f32> {
	let c = cos(a);
	let s = sin(a);
	return mat2x2<f32>(c, -s, s, c);
}

// Truchet variant A: two diagonal arcs per cell (classic).
fn truchet_arcs(p: vec2<f32>) -> f32 {
	let cell = floor(p);
	let local = fract(p) - 0.5;
	let h = hash21(cell);
	let r = 0.5;
	if (h < 0.5) {
		let d1 = abs(length(local - vec2<f32>(-0.5, -0.5)) - r);
		let d2 = abs(length(local - vec2<f32>( 0.5,  0.5)) - r);
		return min(d1, d2);
	}
	let d1 = abs(length(local - vec2<f32>(-0.5,  0.5)) - r);
	let d2 = abs(length(local - vec2<f32>( 0.5, -0.5)) - r);
	return min(d1, d2);
}

// Truchet variant B: all four corner arcs (denser cross-weave).
fn truchet_cross(p: vec2<f32>) -> f32 {
	let local = fract(p) - 0.5;
	let r = 0.5;
	let d1 = abs(length(local - vec2<f32>(-0.5, -0.5)) - r);
	let d2 = abs(length(local - vec2<f32>( 0.5,  0.5)) - r);
	let d3 = abs(length(local - vec2<f32>(-0.5,  0.5)) - r);
	let d4 = abs(length(local - vec2<f32>( 0.5, -0.5)) - r);
	return min(min(d1, d2), min(d3, d4));
}

// Truchet variant C: straight diagonal slash, random direction (X-grid feel).
fn truchet_diag(p: vec2<f32>) -> f32 {
	let cell = floor(p);
	let local = fract(p) - 0.5;
	let h = hash21(cell);
	if (h < 0.5) {
		return abs(local.x - local.y);
	}
	return abs(local.x + local.y);
}

// Truchet variant D: nested concentric rings (mandala feel).
fn truchet_rings(p: vec2<f32>) -> f32 {
	let cell = floor(p);
	let local = fract(p) - 0.5;
	let h = hash21(cell);
	let r = length(local);
	let baseR = 0.16 + h * 0.16;
	let d1 = abs(r - baseR);
	let d2 = abs(r - baseR * 1.9);
	let d3 = abs(r - baseR * 2.7);
	return min(d1, min(d2, d3));
}

// Variant dispatcher — songSeed quantized picks one tile generator per track.
// Same kaleidoscope framework, fundamentally different texture per song.
fn truchet(p: vec2<f32>, variant: i32) -> f32 {
	if (variant == 0) { return truchet_arcs(p); }
	if (variant == 1) { return truchet_cross(p); }
	if (variant == 2) { return truchet_diag(p); }
	return truchet_rings(p);
}

// Hyperbolic-style radial warp toward the unit disk. Points near r=0 are
// unchanged; near r=1 they stretch to infinity. Mimics the Poincaré recession
// without the full Möbius transform machinery.
fn hyperbolicWarp(p: vec2<f32>, depth: f32) -> vec2<f32> {
	let r = length(p);
	if (r < 1e-4) { return p; }
	let dir = p / r;
	let rWarped = -log(max(1.0 - clamp(r, 0.0, 0.985), 1e-3)) * depth;
	return dir * rWarped;
}

fn kaleidoscope(p: vec2<f32>, sides: f32) -> vec2<f32> {
	let r = length(p);
	var a = atan2(p.y, p.x);
	let seg = 6.28318530718 / sides;
	a = abs(a - round(a / seg) * seg);
	return vec2<f32>(cos(a), sin(a)) * r;
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;
	let rEye = length(uv);

	// Tighter disk — falloff from 0.92 to 0.55. Brings the visible window in
	// from the corners (no more wide-angle stretch artifact at the rim).
	let diskMask = smoothstep(0.92, 0.55, rEye);
	if (diskMask < 1e-3) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}

	// Hyperbolic radial warp — reduced depth so structure stays legible at
	// the edges rather than stretching out into infinity.
	let warpDepth = 0.85 + u.mid * 0.12;
	var p = hyperbolicWarp(uv, warpDepth);

	// Slow drift — feedback handles "breathing"; scene rotates slowly via mid.
	p = rot(u.feedbackRotation * 0.6) * p;

	// Kaleidoscope fold count — audio sets the *target*, but a slow noise drift
	// wanders ±2 around it so the symmetry isn't deterministically tied to the
	// current audio frame. The visual evolves on its own timescale.
	let driftSlow = snoise(u.time * 0.07 + u.songSeed * 31.0);
	let kalSidesRaw = 4.0 + floor(u.centroid * 6.0 + u.bpmNorm * 2.0 + (driftSlow - 0.5) * 4.0) * 2.0;
	let kalSides = clamp(kalSidesRaw, 4.0, 18.0);
	let kal = kaleidoscope(p, kalSides);

	// Beat pulse — sharp punch at phase=0, decays toward 0.5. Drives both a
	// per-beat brightness lift on the edges and a subtle scale punch so the
	// whole geometry breathes on tempo. This is what makes the visual feel
	// locked to the music instead of just reactive.
	let beatPulse = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 4.0);

	// Tile scale evolves organically — audio target plus slow noise drift.
	let scaleDrift = snoise(u.time * 0.05 + u.songSeed * 71.0);
	let tileScale = 2.5 + u.bpmNorm * 0.9 - u.chromaStrength * 0.4 + u.bass * 0.2 + scaleDrift * 0.8;
	let scalePunch = 1.0 - beatPulse * 0.12;
	// Per-song seed shifts the tile-grid origin. Continuous variant morphing:
	// we pick a "current" and "next" variant and BLEND between them over time
	// (variantPhase oscillates 0→1→0 with ~12s period, modulated by noise).
	// Result: same kaleidoscope framework but textures continuously mutate
	// across (arcs / cross / diag / rings) rather than locking to one per song.
	let variantClock = u.time * 0.08 + u.songSeed * 23.0;
	let variantA = i32(floor(variantClock)) - i32(floor(variantClock / 4.0)) * 4;
	let variantB = (variantA + 1) - ((variantA + 1) / 4) * 4;
	let variantPhase = smoothstep(0.0, 1.0, variantClock - floor(variantClock));
	let seedShift = vec2<f32>(u.songSeed * 17.3, u.songSeed * 23.7);
	let q = kal * tileScale * scalePunch + seedShift;
	let dA = truchet(q, variantA);
	let dB = truchet(q, variantB);
	let d = mix(dA, dB, variantPhase);

	// Thin glowing edges — two falloffs (inner sharp + outer haze).
	let innerEdge = smoothstep(0.022, 0.0, d);
	let outerEdge = smoothstep(0.16, 0.0, d) * 0.35;
	let edge = innerEdge + outerEdge;

	// Bin-indexed pulse: each kaleidoscope arm samples a different FFT bin,
	// so spectrum reads as the LEFT/RIGHT/UP/DOWN structure of the geometry.
	let arm = atan2(kal.y, kal.x) / 6.28318530718 + 0.5; // 0..1
	let binIdx = i32(floor(arm * f32(${BIN_COUNT})));
	let binIdxClamped = clamp(binIdx, 0i, ${BIN_COUNT - 1}i);
	let binV = bins[binIdxClamped];

	// Distance from origin in kaleidoscope space — for radial palette indexing.
	let kalR = length(kal);

	// Palette rotation — chroma + centroid + song seed + slow noise drift, so
	// the palette wanders organically across the cycle instead of sitting in a
	// fixed zone.
	let palDrift = snoise(u.time * 0.03 + u.songSeed * 113.0);
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.7 * (1.0 - u.chromaStrength * 0.6);
	let palT = keyBias + timbreBias + kalR * 0.15 + u.time * 0.012 + u.songSeed * 0.5 + palDrift * 0.35 + u.palJump;
	let colA = iridescent(palT);
	let colB = iridescent(palT + 0.5); // complementary stripe for the outer haze

	// Sharper beat-snap clarity: a tighter beat curve (exp 8 instead of 4)
	// means the edges punch HARD at the beat and fall back to a quieter
	// baseline between. The visualizer has a clarity rhythm, not constant spam.
	let beatPunch = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 8.0);

	// HDR composition — quieter base + bigger on-beat lift gives the "insane
	// moment" rhythm. Outer haze suppressed so it doesn't fill the negative space.
	var col = vec3<f32>(0.0);
	col = col + colA * innerEdge * (0.7 + binV * 1.1 + u.bass * 0.3 + beatPunch * 1.2);
	col = col + colB * outerEdge * (0.25 + u.rms * 0.2 + beatPunch * 0.25);

	// (Onset no longer adds a global iridescent overlay — that read as a cheap
	// centered strobe. Onset now affects palette + scale via uniforms upstream.)

	// Soft disk vignette so the tiling fades into the void, not a hard circle.
	col = col * diskMask;

	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

	// Preset 2: 3D volumetric raymarched flythrough through a lattice of luminous
	// columns. Camera moves forward + yaws + bobs; volumetric fog accumulates
	// iridescent color near column surfaces. No central focus, no kaleidoscopic
	// symmetry — gives a completely different read from preset 1.
	const CATHEDRAL_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash13(p: vec3<f32>) -> f32 {
	var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
	q = q + dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}

// SDF: nearest infinite vertical column in a 2D lattice in the X/Z plane.
// Per-song seed offsets the lattice origin and biases the hash so the column
// layout itself is genuinely different each track, not just the camera path.
fn columnsDE(p: vec3<f32>, period: f32, radiusBase: f32, seed: f32) -> f32 {
	let seedOffset = vec2<f32>(seed * 50.0, seed * 73.0);
	let shifted = p.xz + seedOffset;
	let cellXZ = round(shifted / period) * period;
	let local = shifted - cellXZ;
	let h = hash13(vec3<f32>(cellXZ.x, seed * 100.0, cellXZ.y));
	let radius = radiusBase + h * 0.06;
	return length(local) - radius;
}

// Procedural Point-Of-Interest in the lattice. SongSeed seeds the positions
// so each track gets its own set of random spots the camera will investigate.
fn poi(idx: i32, seed: f32) -> vec3<f32> {
	let fi = f32(idx);
	let h1 = hash13(vec3<f32>(fi * 17.3, seed * 137.1, fi * 31.7));
	let h2 = hash13(vec3<f32>(fi * 47.1, seed * 217.5, fi * 13.9));
	let h3 = hash13(vec3<f32>(fi * 23.7, seed * 311.7, fi * 71.3));
	let theta = h1 * 6.28318;
	let r = 1.5 + h2 * 3.0; // radial offset from forward axis
	let yOff = (h3 - 0.5) * 1.8; // vertical bob
	return vec3<f32>(cos(theta) * r, yOff, sin(theta) * r);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = (frag.xy - 0.5 * res) / res.y;

	let t = u.time;

	// Procedural orbital flythrough — the camera ORBITS each POI in turn
	// (visible lateral + rotational motion) while a slow forward drift carries
	// the whole scene through the lattice. Long dwells so each POI gets a real
	// moment of inspection rather than a frantic flyby.
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

	// Active POI = blends from A → B near the end of each window, creating
	// a smooth "handoff" between targets rather than a snap.
	let handoff = smoothstep(0.65, 1.0, phase);
	let activePOI = mix(poiA, poiB, handoff);

	// Slow forward drift — about 1/3 of previous speed, so audio adds reactivity
	// ON TOP of a calm baseline instead of frantic motion overwhelming everything.
	let speedDrift = snoise(t * 0.025 + u.songSeed * 73.0);
	let baseSpeed = 0.04 + u.bass * 0.10 + u.bpmNorm * 0.06 + speedDrift * 0.03;
	let driftZ = seededT * baseSpeed;

	// Calmer orbit. Lower base orbit speed; noise drift dampened so the camera
	// breathes around the POI rather than whipping past it.
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

	// Bass shake — very subtle, just a hint of bass-driven micro-motion.
	let bassShake = vec3<f32>(
		sin(t * 17.0),
		cos(t * 13.0),
		sin(t * 19.0)
	) * u.bass * 0.025;

	let camPos = activePOI + orbitOffset + bassShake + vec3<f32>(0.0, 0.0, driftZ);

	// Look directly AT the active POI (offset slightly forward so we always
	// see "through" the orbit center into the depth). This is the key — the
	// camera ALWAYS faces a specific point, so its rotation becomes visible
	// rather than hiding in a static forward-axis view.
	let lookTarget = activePOI + vec3<f32>(0.0, 0.0, driftZ + 0.4);
	let toTarget = lookTarget - camPos;
	let forward = normalize(toTarget);
	let worldUp = vec3<f32>(0.0, 1.0, 0.0);
	let right = normalize(cross(forward, worldUp));
	let upVec = cross(right, forward);
	// Narrower FOV than 1.4 (less fisheye). Onset = brief zoom punch.
	let fovScale = 1.8 - u.flash * 0.4;
	let rayDir = normalize(uv.x * right + uv.y * upVec + forward * fovScale);

	// Same per-song palette mapping as preset 1 — strongly tonal locks color
	// to the key; atonal falls back to centroid. Wider rotation than before so
	// different stations actually show different palette quadrants.
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.6 * (1.0 - u.chromaStrength * 0.6);
	let beatPulse = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 4.0);

	// Column lattice geometry varies with music character:
	// • Bass widens the spacing (open cathedral) and thickens columns.
	// • Treble narrows it (dense forest of thin spires).
	// • Slow songs get sparser layouts; fast songs get more verticals per frame.
	let period = 1.4 + u.bass * 0.9 - u.treble * 0.35 + u.bpmNorm * 0.3;
	let radiusBase = 0.04 + u.bass * 0.06;

	// Volumetric raymarch — accumulate iridescent fog density inversely related
	// to distance from columns. No surface shading; pure volumetric.
	var col = vec3<f32>(0.0);
	var p = camPos;
	var depth = 0.0;
	let MAX_STEPS = 96;
	let MAX_DEPTH = 28.0;

	for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
		if (depth > MAX_DEPTH) { break; }
		let d = columnsDE(p, period, radiusBase, u.songSeed);
		let stepSize = max(d * 0.55, 0.045);
		// Density falls off exponentially from the column surface; beat punches it.
		let density = exp(-d * 7.5) * (0.5 + beatPulse * 0.5);
		// Palette indexed by chroma/centroid bias + spatial depth + organic drift +
		// onset palette-jump roulette.
		let palDrift = snoise(t * 0.03 + u.songSeed * 97.0);
		let palT = keyBias + timbreBias + depth * 0.06 + length(p.xz) * 0.04 + t * 0.01 + palDrift * 0.3 + u.palJump;
		let glow = iridescent(palT);
		// Distance fog so far cells fade — gives true depth perception.
		let fog = exp(-depth * 0.085);
		// Per-step bin lookup: each ray-march step pulls a different FFT bin
		// keyed by depth+angle, so column glow shimmers with the spectrum.
		// (Also keeps the bins binding live in the auto pipeline layout.)
		let cellAngle = atan2(p.z, p.x) / 6.28318530718 + 0.5;
		let binIdxCath = clamp(i32((fract(depth * 0.12 + cellAngle)) * f32(${BIN_COUNT})), 0i, ${BIN_COUNT - 1}i);
		let binBoost = bins[binIdxCath] * 0.7;
		col = col + glow * density * fog * 0.055 * (1.0 + u.bass * 0.4 + binBoost);
		p = p + rayDir * stepSize;
		depth = depth + stepSize;
	}

	// Treble sparkles — screen-space high-frequency noise, gated by treble.
	let sparkSeed = uv * 26.0 + vec2<f32>(t * 0.6, -t * 0.4);
	let sparkH = fract(sin(dot(sparkSeed, vec2<f32>(12.9898, 78.233))) * 43758.5453);
	let spark = smoothstep(0.94 - u.treble * 0.18, 0.99, sparkH);
	col = col + iridescent(u.centroid + 0.35) * spark * (0.5 + u.treble * 0.7);

	// Onset chromatic burst.
	col = col + iridescent(u.centroid + 0.6) * u.flash * 0.55;

	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

	// Preset 3: Voronoi caustic field. No kaleidoscope, no 3D — organic cell
	// boundaries with refractive UV warp gives a flowing "submerged temple
	// caustic" look. Reads ambient/textural; auto-pick lands here for slow,
	// atonal, treble-rich music.
	const VORONOI_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
	let q = vec2<f32>(
		dot(p, vec2<f32>(127.1, 311.7)),
		dot(p, vec2<f32>(269.5, 183.3))
	);
	return fract(sin(q) * 43758.5453);
}

// Worley/voronoi — returns (F1 distance, F2-F1 edge proximity, cell hash).
// Animated cell points so the field shimmers organically.
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

	// Refractive caustic warp — sample a slow voronoi at lower scale and use its
	// gradient to displace the main UV. Gives a flowing rippled-water shimmer.
	let warpInput = uv * 1.2 + vec2<f32>(t * 0.08, -t * 0.06);
	let warpV = voronoi(warpInput, t * 0.6);
	let warpAmount = 0.06 + u.treble * 0.10;
	let warp = vec2<f32>(
		sin(warpV.z * 6.28318 + t * 0.5),
		cos(warpV.z * 6.28318 + t * 0.5)
	) * warpAmount * warpV.y;

	// Organic noise drift on cell scale and edge width — so even at constant
	// audio levels the field is alive and shifting, not locked in one density.
	let scaleDrift = snoise(t * 0.04 + u.songSeed * 89.0);
	let scale = 2.0 + u.bass * 1.6 + u.bpmNorm * 0.7 + scaleDrift * 1.4;
	let p = uv * scale + warp + vec2<f32>(t * 0.05, t * 0.03) + vec2<f32>(u.songSeed * 30.0, u.songSeed * 47.0);
	let v = voronoi(p, t);

	// Edge brightness near cell boundaries; cell-center fill.
	let edgeDrift = snoise(t * 0.07 + u.songSeed * 41.0);
	let edgeWidth = 0.035 + u.treble * 0.08 + edgeDrift * 0.04;
	let edge = smoothstep(edgeWidth, 0.0, v.y);
	let fill = smoothstep(0.7, 0.1, v.x);
	// Per-cell spectrum reaction: each cell samples a FFT bin by hash, so the
	// edge intensity flickers with specific frequencies. (Also keeps the bins
	// binding alive in the auto-derived pipeline layout — Chrome prunes it
	// otherwise and the lab page errors.)
	let binIdx = clamp(i32(v.z * f32(${BIN_COUNT})), 0i, ${BIN_COUNT - 1}i);
	let binBoost = bins[binIdx] * 0.55;

	// Palette indexed by cell hash + chroma/centroid + song seed + slow drift.
	let palDrift = snoise(t * 0.025 + u.songSeed * 67.0);
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.55 * (1.0 - u.chromaStrength * 0.6);
	let palT = v.z * 0.55 + keyBias + timbreBias + u.songSeed * 0.4 + t * 0.01 + palDrift * 0.3 + u.palJump;
	let cellCol = iridescent(palT);
	let edgeCol = iridescent(palT + 0.35);

	var col = vec3<f32>(0.0);
	col = col + cellCol * fill * (0.5 + u.rms * 0.5 + beatPulse * 0.3 + binBoost);
	col = col + edgeCol * edge * (1.0 + beatPulse * 0.45 + u.treble * 0.5 + binBoost * 0.6);

	// Onset chromatic burst.
	col = col + iridescent(u.centroid + 0.5) * u.flash * 0.5;

	// Soft vignette — lighter than the kaleidoscope's disk so the field reads
	// as a wide expanse rather than a focused window.
	let vig = smoothstep(1.4, 0.4, length(uv));
	col = col * (0.55 + 0.45 * vig);

	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

	// Preset 4: Nebulae Flow — multi-octave FBM clouds with audio-displaced flow
	// field. No symmetry, no cells, no center. Iridescent gas drifting in a
	// directional flow that bends with bass/onset. Fits atmospheric/melodic/
	// ambient music; reads completely differently from the other three presets.
	const NEBULAE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${BIN_COUNT}>;

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
	let u = f * f * (3.0 - 2.0 * f);
	let a = hash21n(i);
	let b = hash21n(i + vec2<f32>(1.0, 0.0));
	let c = hash21n(i + vec2<f32>(0.0, 1.0));
	let d = hash21n(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
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

	// Flow direction rotates very slowly with song seed + time. Noise wobble
	// damped so the field doesn't whip around its own axis.
	let flowAngle = t * 0.018 + u.songSeed * 6.28 + snoise(t * 0.01 + u.songSeed * 41.0) * 0.8;
	let flowDir = vec2<f32>(cos(flowAngle), sin(flowAngle));

	// Flow speed about 1/3 of previous — clouds drift instead of streaming past.
	let flowSpeed = 0.04 + u.bass * 0.10 + u.bpmNorm * 0.06;
	let scaleDrift = snoise(t * 0.02 + u.songSeed * 73.0);
	let scale = 1.2 + u.bpmNorm * 0.2 + scaleDrift * 0.3;

	// Base sample position drifts with flow.
	let p = uv * scale - flowDir * t * flowSpeed + vec2<f32>(u.songSeed * 17.0);

	// Two FBM layers: warp + main density.
	let warp = vec2<f32>(fbm(p + 5.0, 4), fbm(p - 7.0, 4)) * (0.5 + u.bass * 0.7);
	let layer1 = fbm(p + warp, 5);
	// Density mask — only show cloud where layer1 is positive enough.
	let density = smoothstep(-0.05, 0.35, layer1);
	let highlight = smoothstep(0.15, 0.55, layer1);

	// Treble adds high-frequency noise on top — like dust particles.
	let detail = fbm(p * 6.0 + warp * 2.0, 3);
	let dust = smoothstep(0.25, 0.45, detail) * u.treble * 0.8;

	// Per-cloud spectrum reaction — sample a FFT bin keyed by spatial position
	// so different patches of the nebula react to different frequencies.
	// (Also keeps the bins binding live for the pipeline layout — Chrome
	// prunes it otherwise and the lab page errors.)
	let binIdxNebula = clamp(i32(fract(layer1 + u.songSeed) * f32(${BIN_COUNT})), 0i, ${BIN_COUNT - 1}i);
	let binBoost = bins[binIdxNebula] * 0.5;

	// Palette — chroma + centroid + slow noise + onset palJump.
	let palDrift = snoise(t * 0.025 + u.songSeed * 137.0);
	let keyBias = u.chromaKey * u.chromaStrength;
	let timbreBias = u.centroid * 0.6 * (1.0 - u.chromaStrength * 0.6);
	let palT = keyBias + timbreBias + layer1 * 0.25 + u.songSeed * 0.4 + t * 0.008 + palDrift * 0.3 + u.palJump;
	let cloudCol = iridescent(palT);
	let highCol = iridescent(palT + 0.35);

	let beatPunch = pow(0.5 + 0.5 * cos(u.beatPhase * 6.28318530718), 6.0);

	var col = vec3<f32>(0.0);
	col = col + cloudCol * density * (0.5 + u.rms * 0.5 + beatPunch * 0.3 + binBoost * 0.8);
	col = col + highCol * highlight * (0.7 + u.bass * 0.4 + beatPunch * 0.5 + binBoost);
	col = col + iridescent(u.centroid + 0.4) * dust;

	// Wide soft vignette — keeps the field expansive, doesn't trap the eye.
	let vig = smoothstep(1.8, 0.5, length(uv));
	col = col * (0.55 + 0.45 * vig);

	return vec4<f32>(col * u.sceneWeight, 1.0);
}
`;

	const FEEDBACK_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var feedbackPrev: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = frag.xy / res;
	let centered = uv - 0.5;

	// Warp the prev-feedback sample. feedbackZoom <1.0 samples FROM closer to
	// center and paints further out → trails drift outward, which is the
	// "breathing" we actually want (the previous build inverted this and
	// trails pulled inward, creating a centered hot-spot blob).
	let theta = u.feedbackRotation * 0.04;
	let zoom = u.feedbackZoom;
	let c = cos(theta);
	let s = sin(theta);
	let rotated = vec2<f32>(
		centered.x * c - centered.y * s,
		centered.x * s + centered.y * c
	) * zoom;
	let prevUv = rotated + 0.5;

	let prev = textureSample(feedbackPrev, samp, prevUv).rgb;
	let scene = textureSample(sceneTex, samp, uv).rgb;

	// Max-blend with fade: the brightest of (decayed prev, current scene) wins.
	// Trails dim cleanly without accumulating to white — fixes the cream-saturation
	// blow-out where additive blending pushed every pixel past the bloom threshold.
	let trail = prev * u.feedbackFade;
	return vec4<f32>(max(trail, scene), 1.0);
}
`;

	const BLOOM_DOWN_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let halfRes = vec2<f32>(u.resolutionX, u.resolutionY) * 0.5;
	let uv = frag.xy / halfRes;
	let texel = 1.0 / vec2<f32>(u.resolutionX, u.resolutionY);

	// 4-tap downsample of full-res source into half-res target.
	var c = vec3<f32>(0.0);
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0, -1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0, -1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>(-1.0,  1.0) * texel).rgb;
	c = c + textureSample(srcTex, samp, uv + vec2<f32>( 1.0,  1.0) * texel).rgb;
	c = c * 0.25;

	// HDR threshold — only values above threshold bloom; soft knee.
	let bright = max(c.r, max(c.g, c.b));
	let knee = max(0.0, bright - u.bloomThreshold);
	let factor = knee / max(1e-4, bright);
	return vec4<f32>(c * factor, 1.0);
}
`;

	const BLOOM_BLUR_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let halfRes = vec2<f32>(u.resolutionX, u.resolutionY) * 0.5;
	let uv = frag.xy / halfRes;
	let texel = 1.0 / halfRes;
	let dir = vec2<f32>(u.blurDirX, u.blurDirY) * texel;

	// 9-tap Gaussian (separable, unrolled — WGSL array indexing with dynamic
	// index isn't free across drivers).
	var c = textureSample(srcTex, samp, uv).rgb * 0.227027;
	c = c + (textureSample(srcTex, samp, uv + dir * 1.0).rgb + textureSample(srcTex, samp, uv - dir * 1.0).rgb) * 0.1945946;
	c = c + (textureSample(srcTex, samp, uv + dir * 2.0).rgb + textureSample(srcTex, samp, uv - dir * 2.0).rgb) * 0.1216216;
	c = c + (textureSample(srcTex, samp, uv + dir * 3.0).rgb + textureSample(srcTex, samp, uv - dir * 3.0).rgb) * 0.054054;
	c = c + (textureSample(srcTex, samp, uv + dir * 4.0).rgb + textureSample(srcTex, samp, uv - dir * 4.0).rgb) * 0.016216;
	return vec4<f32>(c, 1.0);
}
`;

	const COMPOSITE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var feedbackTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	return fullscreenVS(idx);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let res = vec2<f32>(u.resolutionX, u.resolutionY);
	let uv = frag.xy / res;
	let centered = uv - 0.5;
	let r2 = dot(centered, centered);

	// Subtle barrel distortion (lens curvature).
	let barrel = 1.0 + r2 * 0.06;
	let warped = 0.5 + centered * barrel;

	// Chromatic aberration — RGB channels offset radially, scaled by r² so it
	// pushes harder at the edges; onset flashes ramp it up.
	let caAmt = (0.0028 + r2 * 0.012) * (1.0 + u.flash * 1.8);
	let dir = normalize(centered + vec2<f32>(1e-4, 1e-4));

	let rUv = warped + dir * caAmt;
	let gUv = warped;
	let bUv = warped - dir * caAmt;

	let r = textureSample(feedbackTex, samp, rUv).r;
	let g = textureSample(feedbackTex, samp, gUv).g;
	let b = textureSample(feedbackTex, samp, bUv).b;
	var col = vec3<f32>(r, g, b);

	// Bloom only adds glow on the brightest pixels (per higher threshold).
	// Lower weight keeps the rest of the frame graphic + dark instead of washed.
	let bloom = textureSample(bloomTex, samp, warped).rgb;
	col = col + bloom * 0.4;

	// Radial vignette — softer floor so the visual keeps mid-tones instead of
	// crushing the whole frame at the rim. The earlier 0.45 floor was killing
	// half the dynamic range before tone-map.
	let vig = smoothstep(1.3, 0.45, length(centered) * 1.4);
	col = col * (0.62 + 0.38 * vig);

	// ACES-fit tone map — punchier highlights/shadows than Reinhard, holds
	// saturation better on bright edges. Final contrast lift around mid-gray.
	let aA = 2.51;
	let aB = 0.03;
	let aC = 2.43;
	let aD = 0.59;
	let aE = 0.14;
	col = clamp((col * (aA * col + aB)) / (col * (aC * col + aD) + aE), vec3<f32>(0.0), vec3<f32>(1.0));
	col = max((col - 0.5) * 1.10 + 0.5, vec3<f32>(0.0));

	// Blue-noise-ish dither — kills banding in dark gradients, the rookie tell.
	let h = fract(sin(dot(frag.xy, vec2<f32>(12.9898, 78.233)) + u.time) * 43758.5453);
	col = col + (h - 0.5) / 255.0;

	return vec4<f32>(col, 1.0);
}
`;

	type Targets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		feedback: [GPUTexture, GPUTexture];
		feedbackView: [GPUTextureView, GPUTextureView];
		bloom: [GPUTexture, GPUTexture];
		bloomView: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuf: GPUBuffer;
		binsBuf: GPUBuffer;
		uniformData: Float32Array;
		pipelines: {
			scenes: GPURenderPipeline[]; // one per preset
			feedback: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			bloomBlur: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: Targets | null;
		// Bind groups depend on targets — rebuilt on resize.
		bindGroups: {
			scenes: GPUBindGroup[]; // one per preset (same buffers, different pipeline layouts)
			// feedback ping-pong: bg[i] reads feedback[i] and writes feedback[1-i]
			feedback: [GPUBindGroup, GPUBindGroup];
			bloomDown: [GPUBindGroup, GPUBindGroup];
			bloomBlurH: GPUBindGroup; // reads bloom[0], writes bloom[1]
			bloomBlurV: GPUBindGroup; // reads bloom[1], writes bloom[0]
			composite: [GPUBindGroup, GPUBindGroup]; // reads feedback[0]/[1] + bloom[0]
		} | null;
		frame: number;
	};

	let gpu: GPU | null = null;
	const t0 = performance.now();

	function createTarget(device: GPUDevice, w: number, h: number, format: GPUTextureFormat) {
		return device.createTexture({
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	function buildTargets(device: GPUDevice, w: number, h: number, hdr: GPUTextureFormat): Targets {
		const halfW = Math.max(1, Math.floor(w / 2));
		const halfH = Math.max(1, Math.floor(h / 2));
		const scene = createTarget(device, w, h, hdr);
		const fA = createTarget(device, w, h, hdr);
		const fB = createTarget(device, w, h, hdr);
		const bA = createTarget(device, halfW, halfH, hdr);
		const bB = createTarget(device, halfW, halfH, hdr);
		return {
			scene,
			sceneView: scene.createView(),
			feedback: [fA, fB],
			feedbackView: [fA.createView(), fB.createView()],
			bloom: [bA, bB],
			bloomView: [bA.createView(), bB.createView()],
			width: w,
			height: h
		};
	}

	function disposeTargets(t: Targets) {
		t.scene.destroy();
		t.feedback[0].destroy();
		t.feedback[1].destroy();
		t.bloom[0].destroy();
		t.bloom[1].destroy();
	}

	function buildBindGroups(g: GPU) {
		if (!g.targets) return null;
		const t = g.targets;
		const { device, pipelines, uniformBuf, binsBuf, sampler } = g;

		const scenes = pipelines.scenes.map((pipeline) =>
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: { buffer: binsBuf } }
				]
			})
		);

		const makeFeedback = (prevIdx: 0 | 1) =>
			device.createBindGroup({
				layout: pipelines.feedback.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: t.sceneView },
					{ binding: 3, resource: t.feedbackView[prevIdx] }
				]
			});

		const makeBloomDown = (srcIdx: 0 | 1) =>
			device.createBindGroup({
				layout: pipelines.bloomDown.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: t.feedbackView[srcIdx] }
				]
			});

		const makeBloomBlur = (srcIdx: 0 | 1) =>
			device.createBindGroup({
				layout: pipelines.bloomBlur.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: t.bloomView[srcIdx] }
				]
			});

		const makeComposite = (fIdx: 0 | 1) =>
			device.createBindGroup({
				layout: pipelines.composite.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuf } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: t.feedbackView[fIdx] },
					{ binding: 3, resource: t.bloomView[0] }
				]
			});

		return {
			scenes,
			feedback: [makeFeedback(0), makeFeedback(1)] as [GPUBindGroup, GPUBindGroup],
			bloomDown: [makeBloomDown(0), makeBloomDown(1)] as [GPUBindGroup, GPUBindGroup],
			bloomBlurH: makeBloomBlur(0),
			bloomBlurV: makeBloomBlur(1),
			composite: [makeComposite(0), makeComposite(1)] as [GPUBindGroup, GPUBindGroup]
		};
	}

	async function initGpu(c: HTMLCanvasElement): Promise<GPU | null> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) {
			errorMsg = 'WebGPU not available in this WebView2 build.';
			return null;
		}
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) {
			errorMsg = 'No WebGPU adapter found.';
			return null;
		}
		const device = (await adapter.requestDevice()) as GPUDevice;

		const context = c.getContext('webgpu') as unknown as GPUCanvasContext;
		if (!context) {
			errorMsg = 'WebGPU canvas context unavailable.';
			return null;
		}
		const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
		context.configure({ device, format, alphaMode: 'opaque' });

		const hdr: GPUTextureFormat = 'rgba16float';

		const mkPipeline = (code: string, targetFormat: GPUTextureFormat) => {
			const module = device.createShaderModule({ code });
			return device.createRenderPipeline({
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_main' },
				fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
				primitive: { topology: 'triangle-list' }
			});
		};

		// Scene pipelines use additive blend so two scene passes per frame sum into
		// sceneTex: out = sceneA * weightA + sceneB * weightB (weight multiplied
		// inside each shader before output). Yields continuous preset blending.
		const mkScenePipeline = (code: string) => {
			const module = device.createShaderModule({ code });
			return device.createRenderPipeline({
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_main' },
				fragment: {
					module,
					entryPoint: 'fs_main',
					targets: [
						{
							format: hdr,
							blend: {
								color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
								alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
							}
						}
					]
				},
				primitive: { topology: 'triangle-list' }
			});
		};

		const pipelines = {
			scenes: [
				mkScenePipeline(SCENE_WGSL),
				mkScenePipeline(CATHEDRAL_WGSL),
				mkScenePipeline(VORONOI_WGSL),
				mkScenePipeline(NEBULAE_WGSL)
			],
			feedback: mkPipeline(FEEDBACK_WGSL, hdr),
			bloomDown: mkPipeline(BLOOM_DOWN_WGSL, hdr),
			bloomBlur: mkPipeline(BLOOM_BLUR_WGSL, hdr),
			composite: mkPipeline(COMPOSITE_WGSL, format)
		};

		const sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});

		const uniformBuf = device.createBuffer({
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const binsBuf = device.createBuffer({
			size: BINS_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		const g: GPU = {
			device,
			context,
			format,
			sampler,
			uniformBuf,
			binsBuf,
			uniformData: new Float32Array(UNIFORM_FLOATS),
			pipelines,
			targets: null,
			bindGroups: null,
			frame: 0
		};

		return g;
	}

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		if (g.targets) disposeTargets(g.targets);
		g.targets = buildTargets(g.device, w, h, 'rgba16float');
		g.bindGroups = buildBindGroups(g);
	}

	function teardownGpu() {
		if (!gpu) return;
		try {
			if (gpu.targets) disposeTargets(gpu.targets);
			gpu.uniformBuf.destroy();
			gpu.binsBuf.destroy();
			gpu.device.destroy?.();
		} catch {
			// Device may already be lost; ignore.
		}
		gpu = null;
	}

	function loop() {
		if (!canvas || !gpu) {
			raf = requestAnimationFrame(loop);
			return;
		}

		// Raise DPR cap so high-DPI / 4K monitors render at native resolution
		// rather than at 2x upscaled. Cap at 3 to keep 8K monitors from melting.
		const dpr = Math.min(window.devicePixelRatio || 1, 3);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ensureTargets(gpu, w, h);
		if (!gpu.bindGroups || !gpu.targets) {
			raf = requestAnimationFrame(loop);
			return;
		}

		// ── Feature smoothing
		const feat = vis.latest;
		const incoming = feat?.bins ?? [];
		const attack = 0.55;
		const release = 0.16;
		for (let i = 0; i < BIN_COUNT; i++) {
			const target = incoming[i] ?? 0;
			const tt = target > smoothed.bins[i] ? attack : release;
			smoothed.bins[i] = lerp(smoothed.bins[i], target, tt);
		}
		smoothed.bass = lerp(smoothed.bass, feat?.bass ?? 0, 0.28);
		smoothed.mid = lerp(smoothed.mid, feat?.mid ?? 0, 0.22);
		smoothed.treble = lerp(smoothed.treble, feat?.treble ?? 0, 0.42);
		smoothed.centroid = lerp(smoothed.centroid, feat?.centroid ?? 0.5, 0.04);
		smoothed.rms = lerp(smoothed.rms, feat?.rms ?? 0, 0.22);
		if (feat?.onset) {
			smoothed.flash = 1.0;
			// Onset roulette: each onset rolls for one of N organic events.
			// 30% chance: trail clear (feedback fade momentarily drops).
			// 30% chance: palette jump (color phase suddenly shifts and decays back).
			// 40% chance: nothing special — keeps onsets feeling unpredictable.
			const roll = Math.random();
			if (roll < 0.3) onsetEventStrip = 1.0;
			else if (roll < 0.6) onsetEventPalJump = (Math.random() - 0.5) * 0.6;
		}
		smoothed.flash *= 0.9;
		onsetEventStrip *= 0.85;
		onsetEventPalJump *= 0.92;

		// Circular chroma smoothing — atan2-recover so key changes glide rather
		// than snap from index 11 → 0.
		const chromaAngle = (feat?.chroma_key ?? 0) * 2 * Math.PI;
		smoothed.chromaX = lerp(smoothed.chromaX, Math.cos(chromaAngle), 0.05);
		smoothed.chromaY = lerp(smoothed.chromaY, Math.sin(chromaAngle), 0.05);
		smoothed.chromaStrength = lerp(smoothed.chromaStrength, feat?.chroma_strength ?? 0, 0.06);
		const chromaKeySmoothed =
			(Math.atan2(smoothed.chromaY, smoothed.chromaX) / (2 * Math.PI) + 1) % 1;

		// BPM normalized to 0..1 across 60..180 BPM, slowly smoothed.
		const bpmRaw = feat?.bpm ?? 0;
		const bpmNormTarget = bpmRaw > 0 ? Math.max(0, Math.min(1, (bpmRaw - 60) / 120)) : 0;
		smoothed.bpmNorm = lerp(smoothed.bpmNorm, bpmNormTarget, 0.02);

		// Rotation rate is non-monotonic — a slow oscillator on top of the audio
		// rate. Direction reverses ~1×/min, speed varies, sometimes pauses.
		// This kills the "always clockwise loop" feel and reads as alive.
		const tSec = (performance.now() - t0) / 1000;
		const rotOsc = Math.sin(tSec * 0.07 + songSeed * 6.28) * 0.7 + Math.sin(tSec * 0.023 + songSeed * 11.0) * 0.5;
		const rotRate = (0.04 + smoothed.mid * 0.55 + smoothed.bpmNorm * 0.15) * rotOsc;
		smoothed.rotation += rotRate * (1 / 60);

		// Audio-conditional post params. Tuned for clarity over smear — feedback
		// punctuates, doesn't blanket; bloom only bites the brightest edges.
		// onsetEventStrip momentarily slashes feedback fade → trail snap-clears
		// on a randomly-chosen subset of onsets ("surprise moments of clarity").
		const bloomThreshold = 1.7 - smoothed.rms * 0.25; // 1.45-1.70 — pickier
		const feedbackFade = 0.78 + smoothed.bass * 0.08 - onsetEventStrip * 0.22;
		const feedbackZoom = 0.997 - smoothed.bass * 0.005; // <1 = outward drift

		// Beat phase taken raw — we want the snap, not a smoothed drift.
		const beatPhase = feat?.beat_phase ?? 0;

		// ── New-track detection → regenerate songSeed
		// Pattern: RMS sustained near-silence for ~30 frames, then climbs above
		// the audible threshold. Track-change in a streaming radio shows as a
		// brief gap; this catches it. Also catches "stopped playback then resumed".
		if (smoothed.rms < 0.02) {
			quietFrames += 1;
			if (quietFrames > 30) trackArmed = true;
		} else if (trackArmed && smoothed.rms > 0.08) {
			songSeed = Math.random();
			trackArmed = false;
			quietFrames = 0;
		} else if (smoothed.rms > 0.05) {
			quietFrames = 0;
		}

		// ── 4-way auto-pick preset from music character.
		// Kaleidoscope: tonal, melodic, mid tempo
		// Cathedral:    energetic, percussive, fast bass-heavy
		// Voronoi:      ambient, textural, treble-rich, slow & atonal
		// Nebulae:      atmospheric, melodic, medium-energy with bass body
		const kaleidoInstant =
			smoothed.chromaStrength * 1.8 + smoothed.mid * 0.4 - smoothed.bpmNorm * 0.4;
		const cathedralInstant =
			smoothed.bpmNorm * 1.2 + smoothed.bass * 0.9 + smoothed.treble * 0.2 - smoothed.chromaStrength * 0.5;
		const voronoiInstant =
			smoothed.treble * 1.0 + (1.0 - smoothed.bpmNorm) * 0.5 - smoothed.chromaStrength * 0.4 - smoothed.bass * 0.5;
		const nebulaeInstant =
			smoothed.chromaStrength * 0.9 + smoothed.bass * 0.5 + smoothed.mid * 0.5 - smoothed.treble * 0.3 - smoothed.bpmNorm * 0.2;
		presetSmoothed[0] = lerp(presetSmoothed[0], kaleidoInstant, 0.008);
		presetSmoothed[1] = lerp(presetSmoothed[1], cathedralInstant, 0.008);
		presetSmoothed[2] = lerp(presetSmoothed[2], voronoiInstant, 0.008);
		presetSmoothed[3] = lerp(presetSmoothed[3], nebulaeInstant, 0.008);
		// Auto-pick disabled — switching between distinct presets created snap
		// transitions even with smoothing. Auto stays on kaleidoscope (idx 0);
		// lab keys force any preset for development. mk2 is the path forward.
		const autoLeader = 0;
		if (vis.forcedPreset < 0 && vis.preset !== 0) {
			vis.setPreset(0);
		}

		// ── Upload uniforms (bins go separately)
		const u = gpu.uniformData;
		u[0] = w;
		u[1] = h;
		u[2] = (performance.now() - t0) / 1000;
		u[3] = smoothed.bass;
		u[4] = smoothed.mid;
		u[5] = smoothed.treble;
		u[6] = smoothed.centroid;
		u[7] = smoothed.rms;
		u[8] = smoothed.flash;
		u[9] = bloomThreshold;
		u[10] = feedbackFade;
		u[11] = smoothed.rotation;
		u[12] = feedbackZoom;
		// blur dir set per-pass; default H
		u[13] = 1;
		u[14] = 0;
		u[15] = beatPhase;
		u[16] = chromaKeySmoothed;
		u[17] = smoothed.chromaStrength;
		u[18] = smoothed.bpmNorm;
		u[19] = songSeed;
		u[20] = onsetEventPalJump;
		// u[21] = sceneWeight — set per scene pass below.
		u[21] = 1;
		u[22] = 0;
		u[23] = 0;

		// ── Single dominant preset (no top-2 blend). Cross-fading two distinct
		// generators produced visible overlay/competition instead of evolution.
		// Whichever preset has the highest score wins; transitions snap at the
		// score boundary (but slow smoothing makes the snap a rare event).
		let sceneIdxA = vis.forcedPreset >= 0 ? vis.forcedPreset : autoLeader;
		const sceneIdxB = sceneIdxA;
		const weightA = 1;
		const weightB = 0;

		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		gpu.device.queue.writeBuffer(
			gpu.binsBuf,
			0,
			smoothed.bins.buffer,
			smoothed.bins.byteOffset,
			smoothed.bins.byteLength
		);

		// ── Render graph
		const prev = (gpu.frame % 2) as 0 | 1;
		const next = (1 - prev) as 0 | 1;
		const t = gpu.targets;
		const bg = gpu.bindGroups;

		const encoder = gpu.device.createCommandEncoder();

		// 1a. Top scene (clears sceneTex, additive blend with weightA)
		u[21] = weightA;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 21 * 4, u.buffer, u.byteOffset + 21 * 4, 4);
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.sceneView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.scenes[sceneIdxA]);
			pass.setBindGroup(0, bg.scenes[sceneIdxA]);
			pass.draw(6);
			pass.end();
		}

		// 1b. Second scene (loads sceneTex, additive blend with weightB on top).
		// Skipped when weightB is negligible (single-preset dominance / forced mode).
		if (weightB > 0.001 && sceneIdxB !== sceneIdxA) {
			u[21] = weightB;
			gpu.device.queue.writeBuffer(gpu.uniformBuf, 21 * 4, u.buffer, u.byteOffset + 21 * 4, 4);
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.sceneView,
						loadOp: 'load',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.scenes[sceneIdxB]);
			pass.setBindGroup(0, bg.scenes[sceneIdxB]);
			pass.draw(6);
			pass.end();
		}

		// 2. Feedback: read feedback[prev] + sceneTex → feedback[next]
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.feedbackView[next],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.feedback);
			pass.setBindGroup(0, bg.feedback[prev]);
			pass.draw(6);
			pass.end();
		}

		// 3. Bloom downsample: read feedback[next] → bloom[0]
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.bloomView[0],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.bloomDown);
			pass.setBindGroup(0, bg.bloomDown[next]);
			pass.draw(6);
			pass.end();
		}

		// 4. Bloom blur H: bloom[0] → bloom[1]. Need updated blur dir uniform.
		u[13] = 1;
		u[14] = 0;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 13 * 4, u.buffer, u.byteOffset + 13 * 4, 8);
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.bloomView[1],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.bloomBlur);
			pass.setBindGroup(0, bg.bloomBlurH);
			pass.draw(6);
			pass.end();
		}

		// 5. Bloom blur V: bloom[1] → bloom[0]
		u[13] = 0;
		u[14] = 1;
		gpu.device.queue.writeBuffer(gpu.uniformBuf, 13 * 4, u.buffer, u.byteOffset + 13 * 4, 8);
		{
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: t.bloomView[0],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.bloomBlur);
			pass.setBindGroup(0, bg.bloomBlurV);
			pass.draw(6);
			pass.end();
		}

		// 6. Composite: feedback[next] + bloom[0] → swap chain
		{
			const view = gpu.context.getCurrentTexture().createView();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(gpu.pipelines.composite);
			pass.setBindGroup(0, bg.composite[next]);
			pass.draw(6);
			pass.end();
		}

		gpu.device.queue.submit([encoder.finish()]);
		gpu.frame++;

		raf = requestAnimationFrame(loop);
	}

	// The visualizer component is mounted once in the layout; the canvas inside
	// is conditionally rendered. Each time `vis.active` flips on we get a fresh
	// canvas element — the GPU state (device, context, pipeline) is bound to a
	// specific canvas, so it must be torn down and rebuilt across remounts or
	// the second open paints to a dead surface (black screen).
	$effect(() => {
		if (!canvas) {
			teardownGpu();
			return;
		}
		if (gpu) return;
		errorMsg = null;
		const initFor = canvas;
		initGpu(initFor)
			.then((g) => {
				if (!g) return;
				if (canvas !== initFor) {
					try {
						g.uniformBuf.destroy();
						g.binsBuf.destroy();
						g.device.destroy?.();
					} catch {}
					return;
				}
				gpu = g;
			})
			.catch((e) => {
				errorMsg = e instanceof Error ? e.message : String(e);
			});
	});

	onMount(async () => {
		unsub = await vis.subscribe();
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
		if (unsub) unsub();
		teardownGpu();
	});
</script>

{#if vis.active}
	<div
		class="fixed inset-0 z-[100] bg-black"
		role="button"
		aria-label="Close visualizer"
		onclick={() => vis.toggle()}
		onkeydown={(e) => {
			if (e.key === 'Escape') vis.toggle();
		}}
		tabindex="0"
	>
		<canvas bind:this={canvas} class="h-full w-full"></canvas>
		{#if showHud}
			<div class="pointer-events-none absolute right-6 top-6 text-xs text-white/40">
				click anywhere or press esc to exit
			</div>
		{/if}
		{#if errorMsg}
			<div class="absolute left-6 top-6 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
