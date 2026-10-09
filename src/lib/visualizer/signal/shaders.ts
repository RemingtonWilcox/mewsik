// Signal is a phosphor instrument at night: a vector scope that has come
// alive. One hero XY figure (a 3D Lissajous whose frequency ratio is a musical
// interval chosen by harmony and section), up to four Y-T channel traces
// written by a beat-locked sweep, and a spectral horizon whose rows are real
// spectrum history flowing toward the viewer. Phosphor persistence lives in a
// ping-pong feedback buffer; bloom, lens and grain finish it like glass.
//
// NOTE: these are JS template literals. Never put a backtick inside a WGSL
// comment here; it terminates the string and silently breaks the shader.

export const SIGNAL_SEGMENTS = 384;
export const SIGNAL_VERTEX_COUNT = SIGNAL_SEGMENTS * 6;
export const SIGNAL_HERO_INSTANCES = 2;
export const SIGNAL_CHANNELS = 4;
export const SIGNAL_TERRAIN_ROWS = 22;
export const SIGNAL_TERRAIN_BINS = 64;
export const SIGNAL_TRACE_INSTANCES =
	SIGNAL_HERO_INSTANCES + SIGNAL_CHANNELS + SIGNAL_TERRAIN_ROWS;
/** Scene, feedback, bloom prefilter, 4 blur passes, composite. */
export const SIGNAL_RENDER_PASSES = 8;

// Field order mirrors SIGNAL_UNIFORM_GROUPS in uniform-layout.ts.
const PARAMS_WGSL = /* wgsl */ `
struct Params {
	// width, height, elapsed, dt
	view: vec4<f32>,
	// sub, kick, body, mids
	bandsA: vec4<f32>,
	// presence, air, rms, centroid
	bandsB: vec4<f32>,
	// impact, beatGlow, sectionPulse, ringOut
	pulse: vec4<f32>,
	// tension, release, openness, asymmetry
	shape: vec4<f32>,
	// ellipse, lissajous, ribbon, rosette
	forms: vec4<f32>,
	// figurePhase, complexity, mode, spread
	figure: vec4<f32>,
	// sweepPhase, channels, sweepStep, packetPhase
	sweep: vec4<f32>,
	// baseHue, accentHue, rimHue, saturation
	palette: vec4<f32>,
	// keyStrength, energy, silence, stroke
	tone: vec4<f32>,
	// feedbackFade, floorFade, bloomThreshold, aberration
	post: vec4<f32>,
	// horizon, heroX, heroY, heroScale
	placement: vec4<f32>,
	// yaw, spectralMotion, crest, flatness
	motion: vec4<f32>,
	// tickPhase, headIndex, terrainLift, tickFlash
	terrain: vec4<f32>,
	// sectionProgress, energySlope, lookahead, tempo
	context: vec4<f32>,
};
`;

// Phosphor roles. Each role has a fixed anchor hue (green, amber, ice, hot)
// that leans toward the director's harmonic palette, so colour shifts with
// key and mode without ever becoming a hue sweep.
const COLOR_WGSL = /* wgsl */ `
fn hsvToRgb(hsv: vec3<f32>) -> vec3<f32> {
	let p = abs(fract(hsv.xxx + vec3<f32>(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
	return hsv.z * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), hsv.y);
}

fn mixHueShortest(hueA: f32, hueB: f32, amount: f32) -> f32 {
	let delta = fract(hueB - hueA + 0.5) - 0.5;
	return fract(hueA + delta * amount);
}

fn roleLean() -> f32 {
	return 0.14 + params.tone.x * 0.14;
}

fn heroHue() -> f32 {
	let anchor = 0.37 + params.figure.z * -0.035;
	return mixHueShortest(anchor, params.palette.x, roleLean());
}

fn amberHue() -> f32 {
	return mixHueShortest(0.085, params.palette.y, roleLean() * 0.5);
}

fn iceHue() -> f32 {
	return mixHueShortest(0.545, params.palette.z, roleLean() * 0.8);
}

fn hotHue() -> f32 {
	return mixHueShortest(0.975, params.palette.y, 0.14);
}

fn roleSaturation(scale: f32) -> f32 {
	return clamp((0.6 + params.palette.w * 0.3) * scale, 0.35, 0.95);
}
`;

export const SIGNAL_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}

const TAU: f32 = 6.28318530718;
const SEGMENTS: u32 = ${SIGNAL_SEGMENTS}u;
const HERO_INSTANCES: u32 = ${SIGNAL_HERO_INSTANCES}u;
const CHANNELS: u32 = ${SIGNAL_CHANNELS}u;
const ROWS: u32 = ${SIGNAL_TERRAIN_ROWS}u;
const BINS: u32 = ${SIGNAL_TERRAIN_BINS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;
@group(0) @binding(2) var<storage, read> terrainRows: array<f32, ${SIGNAL_TERRAIN_ROWS * SIGNAL_TERRAIN_BINS}>;

${COLOR_WGSL}

struct TraceOut {
	@builtin(position) position: vec4<f32>,
	@location(0) color: vec3<f32>,
	// x: along the stroke 0..1, y: across the stroke -1..1
	@location(1) local: vec2<f32>,
	@location(2) intensity: f32,
	@location(3) hot: vec3<f32>,
	// Phosphor class written to alpha: 1 long persistence (hero), lower
	// values decay faster in the feedback pass (channels, horizon rows).
	@location(4) persist: f32,
};

fn aspect() -> f32 {
	return params.view.x / max(params.view.y, 1.0);
}

fn smoothDetail(position: f32) -> f32 {
	let scaled = clamp(position, 0.0, 0.999) * 63.0;
	let index = u32(floor(scaled));
	let fraction = fract(scaled);
	let index0 = select(index - 1u, 0u, index == 0u);
	let index2 = min(index + 1u, 63u);
	let index3 = min(index + 2u, 63u);
	let a = clamp(detailBins[index0], -1.0, 1.0);
	let b = clamp(detailBins[index], -1.0, 1.0);
	let c = clamp(detailBins[index2], -1.0, 1.0);
	let d = clamp(detailBins[index3], -1.0, 1.0);
	let f2 = fraction * fraction;
	let f3 = f2 * fraction;
	return clamp(0.5 * ((2.0 * b) + (-a + c) * fraction
		+ (2.0 * a - 5.0 * b + 4.0 * c - d) * f2
		+ (-a + 3.0 * b - 3.0 * c + d) * f3), -1.0, 1.0);
}

fn rotateY(p: vec3<f32>, angle: f32) -> vec3<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec3<f32>(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

fn rotateX(p: vec3<f32>, angle: f32) -> vec3<f32> {
	let c = cos(angle);
	let s = sin(angle);
	return vec3<f32>(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

// Musical intervals as XY frequency ratios. Complexity walks unison, octave,
// fifth, fourth, then the mode's colour intervals (major sixth and third, or
// minor sixth and third).
fn intervalRatio(index: u32, major: bool) -> vec2<f32> {
	var majorRatios = array<vec2<f32>, 6>(
		vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 2.0), vec2<f32>(2.0, 3.0),
		vec2<f32>(3.0, 4.0), vec2<f32>(3.0, 5.0), vec2<f32>(4.0, 5.0)
	);
	var minorRatios = array<vec2<f32>, 6>(
		vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 2.0), vec2<f32>(2.0, 3.0),
		vec2<f32>(3.0, 4.0), vec2<f32>(5.0, 8.0), vec2<f32>(5.0, 6.0)
	);
	let i = min(index, 5u);
	if (major) {
		return majorRatios[i];
	}
	return minorRatios[i];
}

fn lissajous(t: f32, ratio: vec2<f32>, phase: f32) -> vec3<f32> {
	return vec3<f32>(
		sin(ratio.x * t + phase),
		sin(ratio.y * t),
		sin((ratio.x + ratio.y) * t + phase * 0.61 + 1.3)
	);
}

fn intervalFigure(t: f32, phase: f32, major: bool) -> vec3<f32> {
	let c = clamp(params.figure.y, 0.0, 1.0) * 5.0;
	let i0 = u32(floor(c));
	let i1 = min(i0 + 1u, 5u);
	let f = smoothstep(0.0, 1.0, fract(c));
	return mix(
		lissajous(t, intervalRatio(i0, major), phase),
		lissajous(t, intervalRatio(i1, major), phase),
		f
	);
}

// Hero XY figure in scope space (x across -aspect..aspect, y up -1..1).
// Returns xy and a depth cue in z (1 near, 0 far).
fn heroPoint(u: f32, ghost: f32) -> vec3<f32> {
	let t = u * TAU;
	let phase = params.figure.x + ghost * params.figure.w;
	let majorWeight = clamp(params.figure.z * 0.5 + 0.5, 0.0, 1.0);
	var p = mix(intervalFigure(t, phase, false), intervalFigure(t, phase, true), majorWeight);

	let formTotal = max(dot(params.forms, vec4<f32>(1.0)), 0.0001);
	let forms = params.forms / formTotal;
	// Ellipse: a calm open orbit. Ribbon: the figure lies down into a band.
	// Rosette: petals breathe around the figure as tension builds.
	let orbit = vec3<f32>(cos(t + phase * 0.3), sin(t) * 0.8, sin(t * 2.0 + phase) * 0.5);
	p = mix(p, orbit, forms.x * 0.7);
	p.x = p.x * (1.0 + forms.z * 0.42);
	p.y = p.y * (1.0 - forms.z * 0.3);
	let petals = floor(3.0 + params.figure.y * 4.0);
	let rose = 1.0 + forms.w * (0.12 + params.shape.x * 0.14) * cos(petals * t + phase * 1.3);
	p = vec3<f32>(p.xy * rose, p.z);

	// Low bands own horizontal deflection, upper bands own vertical: the
	// figure is a phase plot of the mix, not a fixed preset.
	p.x = p.x * (0.8 + params.bandsA.z * 0.16 + params.bandsA.x * 0.12);
	p.y = p.y * (0.76 + params.bandsA.w * 0.16 + params.bandsB.x * 0.12) * (1.0 - params.shape.x * 0.12);

	// Signed spectral ripple: arriving partials push outward, receding
	// partials pull inward.
	let detail = smoothDetail(fract(u * 2.0 + params.figure.x * 0.021));
	let outward = normalize(p.xy + vec2<f32>(0.0001, 0.0002));
	let ripple = detail * (0.03 + params.motion.y * 0.05) + sin(t * 41.0 + params.figure.x * 3.0) * params.bandsB.y * 0.006;
	p = vec3<f32>(p.xy + outward * ripple, p.z);

	p = rotateY(p, params.motion.x);
	p = rotateX(p, 0.34 + params.shape.x * 0.2 - params.shape.y * 0.08);
	let perspective = 1.0 / (1.0 + p.z * 0.3);
	let scale = params.placement.w * (1.0 + ghost * 0.035);
	let xy = p.xy * perspective * scale + params.placement.yz;
	return vec3<f32>(xy, clamp(0.5 - p.z * 0.5, 0.0, 1.0));
}

fn channelLevel(k: u32) -> f32 {
	switch k {
		case 0u: { return params.bandsA.w; }
		case 1u: { return params.bandsA.y; }
		case 2u: { return params.bandsB.x; }
		default: { return params.bandsA.x; }
	}
}

// Channel layout in order of appearance: melodic mids first, then kick,
// presence and finally sub.
fn channelSlot(k: u32) -> f32 {
	let top = 0.86;
	let bottom = params.placement.x + 0.13;
	switch k {
		case 0u: { return mix(bottom, top, 0.7); }
		case 1u: { return mix(bottom, top, 0.06); }
		case 2u: { return mix(bottom, top, 0.95); }
		default: { return mix(bottom, top, 0.38); }
	}
}

fn channelBinRange(k: u32) -> vec2<f32> {
	switch k {
		case 0u: { return vec2<f32>(22.0, 40.0); }
		case 1u: { return vec2<f32>(6.0, 15.0); }
		case 2u: { return vec2<f32>(40.0, 56.0); }
		default: { return vec2<f32>(0.0, 7.0); }
	}
}

fn channelCycles(k: u32) -> f32 {
	switch k {
		case 0u: { return 5.0; }
		case 1u: { return 2.5; }
		case 2u: { return 13.0; }
		default: { return 1.25; }
	}
}

fn channelVisibility(k: u32) -> f32 {
	return clamp(params.sweep.y - f32(k), 0.0, 1.0);
}

// Each channel is drawn from just behind the previous sweep's tail up to the
// write head. Unwrapped: values below zero belong to the previous sweep and
// are wrapped back onto the right edge of the face.
const CHANNEL_TAIL: f32 = 0.94;

fn channelU(fraction: f32) -> f32 {
	return params.sweep.x - CHANNEL_TAIL * (1.0 - fraction);
}

fn channelPoint(u: f32, k: u32) -> vec2<f32> {
	let x = (u * 2.0 - 1.0) * aspect() * 0.93;
	let level = channelLevel(k);
	let cycles = channelCycles(k);
	let drift = params.figure.x * (0.21 + f32(k) * 0.13);
	let range = channelBinRange(k);
	// Resynthesis: four partials whose strengths are the live detail of the
	// bins this channel owns, so each trace is a picture of its band.
	var wave = 0.0;
	var total = 0.0;
	for (var j = 0u; j < 4u; j = j + 1u) {
		let partial = f32(j);
		let bin = (range.x + (partial + 0.5) * 0.25 * (range.y - range.x)) / 63.0;
		let strength = (0.32 / (1.0 + partial * 0.8)) + max(smoothDetail(bin), 0.0) * 3.0;
		let harmonic = 1.0 + partial * (1.0 + params.motion.w * 0.6);
		wave = wave + sin(TAU * (u * cycles * harmonic + drift * (1.0 + partial * 0.7) + partial * 1.3)) * strength;
		total = total + strength;
	}
	let detail = smoothDetail((range.x + u * (range.y - range.x)) / 63.0);
	wave = wave / max(total, 0.001) * 1.25 + detail * 0.8;
	if (k == 1u) {
		// The kick channel carries a decaying burst per beat.
		wave = wave * (0.55 + params.pulse.y * 0.9);
	}
	let window = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.95, 1.0, u));
	let quiet = 1.0 - params.tone.z;
	let amplitude = (0.018 + level * 0.085 + params.pulse.x * 0.02) * quiet;
	return vec2<f32>(x, channelSlot(k) + wave * amplitude * window);
}

// Spectral horizon: rows of real spectrum history laid on a ground plane,
// newest at the horizon, flowing toward the viewer once per tick.
const CAMERA_HEIGHT: f32 = 0.36;
const FOCAL: f32 = 1.05;
const Z_NEAR: f32 = 0.6;
const Z_FAR: f32 = 7.5;

fn terrainAge(row: u32) -> f32 {
	return (f32(row) + params.terrain.x) / f32(ROWS);
}

fn terrainValue(row: u32, position: f32) -> f32 {
	let slot = (u32(params.terrain.y) + ROWS - row) % ROWS;
	let scaled = clamp(position, 0.0, 1.0) * f32(BINS - 1u);
	let i0 = u32(floor(scaled));
	let i1 = min(i0 + 1u, BINS - 1u);
	let f = fract(scaled);
	return mix(terrainRows[slot * BINS + i0], terrainRows[slot * BINS + i1], f);
}

fn terrainBin(u: f32) -> f32 {
	return pow(abs(u * 2.0 - 1.0), 0.62);
}

fn terrainDepth(age: f32) -> f32 {
	// Between true perspective and an even conveyor: rows stay legible near
	// the horizon and still accelerate as they approach.
	return 1.0 / mix(1.0 / Z_FAR, 1.0 / Z_NEAR, pow(age, 1.45));
}

fn terrainPoint(u: f32, row: u32) -> vec2<f32> {
	let age = terrainAge(row);
	let z = terrainDepth(age);
	let span = 2.6;
	let worldX = (u * 2.0 - 1.0) * span;
	// Mirror the spectrum around the centre line: bass runs down a narrow
	// spine in the middle of the floor, air spreads to the far edges.
	let value = terrainValue(row, terrainBin(u));
	let height = value * (0.22 + params.terrain.z * 0.12);
	let x = worldX * FOCAL / z;
	let y = params.placement.x + (height - CAMERA_HEIGHT) * FOCAL / z;
	return vec2<f32>(x, y);
}

struct Stroke {
	start: vec2<f32>,
	end: vec2<f32>,
	color: vec3<f32>,
	hot: vec3<f32>,
	intensity: f32,
	halfWidth: f32,
	along: f32,
	persist: f32,
};

fn toNdc(p: vec2<f32>) -> vec2<f32> {
	return vec2<f32>(p.x / aspect(), p.y);
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instance: u32
) -> TraceOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let useEnd = corner == 1u || corner == 4u || corner == 5u;
	let positiveSide = corner == 2u || corner == 3u || corner == 5u;
	let f0 = f32(segment) / f32(SEGMENTS);
	let f1 = f32(segment + 1u) / f32(SEGMENTS);
	let resolution = params.view.xy;
	let pixelScale = resolution.y / 640.0;
	let energy = params.tone.y;
	let silence = params.tone.z;
	let stroke = params.tone.w;

	let heroRgb = hsvToRgb(vec3<f32>(heroHue(), roleSaturation(0.92), 1.0));
	let amberRgb = hsvToRgb(vec3<f32>(amberHue(), roleSaturation(1.0), 1.0));
	let iceRgb = hsvToRgb(vec3<f32>(iceHue(), roleSaturation(0.85), 1.0));
	let hotRgb = hsvToRgb(vec3<f32>(hotHue(), roleSaturation(0.75), 1.0));

	var s: Stroke;
	s.hot = vec3<f32>(0.0);
	s.along = select(f0, f1, useEnd);
	s.persist = 1.0;
	if (instance < HERO_INSTANCES) {
		let ghost = f32(instance);
		let a = heroPoint(f0, ghost);
		let b = heroPoint(f1, ghost);
		s.start = a.xy;
		s.end = b.xy;
		let depth = select(a.z, b.z, useEnd);
		// Beam-speed brightness: an XY beam dwells where it slows, so turning
		// points burn brighter than fast crossings.
		let lengthPx = length((toNdc(b.xy) - toNdc(a.xy)) * resolution * 0.5);
		let meanPx = params.placement.w * resolution.y * 0.5 * 7.0 * (1.0 + params.figure.y * 1.6) / f32(SEGMENTS);
		let dwell = clamp(pow(meanPx / max(lengthPx, 0.05), 0.55), 0.55, 1.9);
		let u = s.along;
		let packetDistance = abs(fract(u - params.sweep.w + 0.5) - 0.5);
		let packet = exp(-packetDistance * packetDistance * 900.0);
		let packetDrive = 0.35 + params.pulse.x * 1.4 + params.pulse.w * 0.8;
		let heroLevel = (0.72 + energy * 0.4 + params.pulse.z * 0.3) * (1.0 - silence * 0.55);
		if (instance == 0u) {
			s.color = heroRgb;
			s.intensity = heroLevel * dwell * (0.55 + depth * 0.65);
			s.halfWidth = (0.8 + energy * 0.25 + depth * 0.4) * stroke * pixelScale;
			s.hot = mix(heroRgb, hotRgb, 0.7) * packet * packetDrive * 1.3;
		} else {
			// The stereo ghost: a decorrelated second beam that only separates
			// when the mix is wide (air, release, ring-out).
			let spread = clamp(params.figure.w * 4.0, 0.0, 1.0);
			s.color = mix(heroRgb, iceRgb, 0.65);
			s.intensity = heroLevel * dwell * (0.06 + spread * 0.24) * (0.45 + depth * 0.55);
			s.halfWidth = (0.7 + depth * 0.25) * stroke * pixelScale;
		}
	} else if (instance < HERO_INSTANCES + CHANNELS) {
		let k = instance - HERO_INSTANCES;
		s.persist = 0.18;
		let visibility = channelVisibility(k);
		let u0 = channelU(f0);
		let u1 = channelU(f1);
		s.start = channelPoint(fract(u0), k);
		s.end = channelPoint(fract(u1), k);
		let level = channelLevel(k);
		let tip = smoothstep(0.985, 1.0, s.along);
		// Phosphor tail: brightest at the write head, fading back to the
		// previous sweep. A segment that straddles the wrap is not drawn.
		let age = 1.0 - s.along;
		let tail = exp(-age * 2.2) * (1.0 - smoothstep(0.8, 1.0, age));
		let wraps = floor(u0) != floor(u1);
		s.color = select(amberRgb, mix(amberRgb, iceRgb, 0.35), k == 2u);
		// Hierarchy: channels dim where they pass behind the hero figure.
		let mid = (s.start + s.end) * 0.5;
		let heroDistance = length((mid - params.placement.yz) * vec2<f32>(0.8, 1.0)) / max(params.placement.w, 0.05);
		let behindHero = mix(0.3, 1.0, smoothstep(0.35, 1.25, heroDistance));
		s.intensity = visibility * tail * behindHero * select(1.0, 0.0, wraps)
			* (0.5 + level * 0.6 + energy * 0.2) * (1.0 - silence * 0.4);
		s.halfWidth = (0.95 + level * 0.35) * stroke * pixelScale;
		// Write-head flare: the beam spot is the hottest point on a channel.
		let flare = select(level * 0.6, params.bandsA.y * (0.6 + params.pulse.x * 1.4), k == 1u);
		s.hot = mix(amberRgb, hotRgb, 0.5) * tip * visibility * flare * 1.8;
		s.hot = s.hot * select(1.0, 0.0, wraps);
		if (visibility <= 0.001) {
			s.start = vec2<f32>(-9.0, -9.0);
			s.end = vec2<f32>(-9.0, -9.0);
		}
	} else {
		let row = instance - HERO_INSTANCES - CHANNELS;
		s.persist = 0.0;
		s.start = terrainPoint(f0, row);
		s.end = terrainPoint(f1, row);
		let age = terrainAge(row);
		let fadeIn = smoothstep(0.0, 0.22, age);
		let fadeOut = 1.0 - smoothstep(0.78, 1.0, age);
		let u = select(f0, f1, useEnd);
		let value = terrainValue(row, terrainBin(u));
		let edge = 1.0 - smoothstep(0.55, 1.0, abs(u * 2.0 - 1.0));
		s.color = iceRgb;
		s.intensity = fadeIn * fadeOut * edge * (0.025 + max(value, 0.0) * 1.0) * (0.45 + age * 0.55)
			* (1.0 - silence * 0.5);
		s.halfWidth = (0.55 + age * 0.75) * stroke * pixelScale;
		// The newest row flashes as it is written on the beat tick.
		let fresh = 1.0 - smoothstep(0.0, 2.5 / f32(ROWS), age);
		s.hot = iceRgb * fresh * params.terrain.w * fadeIn * edge * 0.8;
	}

	let startPx = toNdc(s.start) * resolution * 0.5;
	let endPx = toNdc(s.end) * resolution * 0.5;
	let tangent = normalize(endPx - startPx + vec2<f32>(0.0001, 0.0));
	let normal = vec2<f32>(-tangent.y, tangent.x);
	let side = select(-1.0, 1.0, positiveSide);
	// The quad is three core widths wide so the halo has room to fall off.
	let extent = max(s.halfWidth, 0.5) * 3.0;
	let base = select(s.start, s.end, useEnd);
	let offset = normal * extent * side * 2.0 / resolution;

	var out: TraceOut;
	out.position = vec4<f32>(toNdc(base) + offset, 0.0, 1.0);
	out.color = s.color;
	out.local = vec2<f32>(s.along, side);
	out.intensity = s.intensity;
	out.hot = s.hot;
	out.persist = s.persist;
	return out;
}

@fragment
fn fs_main(in: TraceOut) -> @location(0) vec4<f32> {
	let r = abs(in.local.y) * 3.0;
	let core = exp(-r * r * 1.6);
	let halo = exp(-r * r * 0.25) * 0.1;
	// Emissive core: the colour role at HDR intensity with a little white in
	// the very centre, never a bleached white line.
	let body = in.color * (core * 1.35 + halo) * in.intensity;
	let center = vec3<f32>(core * core * 0.18 * in.intensity);
	let flare = in.hot * (core + halo * 2.0);
	let light = body + center + flare;
	// Only the visible part of a stroke claims its persistence class.
	let claim = select(0.0, in.persist, max(light.r, max(light.g, light.b)) > 0.004);
	return vec4<f32>(light, claim);
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
${FULLSCREEN_WGSL}
`;

// Phosphor persistence. The previous frame decays, drifts a hair outward
// from the hero, and is max-blended with the fresh scene so trails never
// accumulate to white. Decay is tinted toward the hero phosphor so old light
// cools into the role colour the way a long-persistence phosphor does. The
// floor decays faster so spectral rows stay crisp as they travel.
export const SIGNAL_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}
${COLOR_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;
@group(0) @binding(3) var previousTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspectRatio = params.view.x / max(params.view.y, 1.0);
	let heroUv = vec2<f32>(params.placement.y / aspectRatio * 0.5 + 0.5, 0.5 - params.placement.z * 0.5);
	let zoom = 1.0 - (0.0005 + params.bandsA.x * 0.0009 + params.shape.y * 0.0005);
	let previousUv = heroUv + (in.uv - heroUv) * zoom;
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.02, edge);
	let previous = textureSampleLevel(previousTexture, linearSampler, previousUv, 0.0);
	let scene = textureSampleLevel(sceneTexture, linearSampler, in.uv, 0.0);
	// Per-element persistence: the class stored in alpha picks between the
	// long hero phosphor and the fast phosphor used by channels and rows.
	let fade = mix(params.post.y, params.post.x, clamp(previous.a, 0.0, 1.0));
	let persistRgb = hsvToRgb(vec3<f32>(heroHue(), 0.55, 1.0));
	let tint = mix(vec3<f32>(1.0), persistRgb / max(max(persistRgb.r, persistRgb.g), persistRgb.b), 0.035);
	let trail = previous.rgb * fade * tint * border;
	let luma = vec3<f32>(0.3, 0.5, 0.2);
	let sceneWins = dot(scene.rgb, luma) >= dot(trail, luma);
	let persistClass = select(previous.a, scene.a, sceneWins);
	return vec4<f32>(max(trail, scene.rgb), persistClass);
}
`;

// Half-resolution bloom prefilter with a soft knee: only beam cores, write
// heads and packets bloom; the room never does.
export const SIGNAL_BLOOM_DOWN_WGSL = /* wgsl */ `
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
	let factor = knee * knee / max(1e-4, bright * (knee + 0.25));
	return vec4<f32>(color * factor, 1.0);
}
`;

function signalBlurShader(directionX: number, directionY: number) {
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
	color = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction * 1.0, 0.0).rgb
		+ textureSampleLevel(sourceTexture, linearSampler, in.uv - direction * 1.0, 0.0).rgb) * 0.1945946;
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

export const SIGNAL_BLOOM_BLUR_H_WGSL = signalBlurShader(1, 0);
export const SIGNAL_BLOOM_BLUR_V_WGSL = signalBlurShader(0, 1);

export const SIGNAL_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}
${COLOR_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var phosphorTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;

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

fn hash12(p: vec2<f32>) -> f32 {
	var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
	p3 = p3 + dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

fn gridLine(coordinate: f32, spacing: f32, width: f32) -> f32 {
	let distance = abs(fract(coordinate / spacing + 0.5) - 0.5) * spacing;
	return 1.0 - smoothstep(width * 0.5, width * 1.6, distance);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let aspectRatio = resolution.x / max(resolution.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// Lens: slight barrel and chromatic aberration growing with r squared
	// and flaring on impacts.
	let warped = 0.5 + centered * (1.0 + r2 * 0.06);
	let caAmount = (0.0004 + r2 * 0.003) * params.post.w;
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let phosphor = vec3<f32>(
		textureSampleLevel(phosphorTexture, linearSampler, warped + direction * caAmount, 0.0).r,
		textureSampleLevel(phosphorTexture, linearSampler, warped, 0.0).g,
		textureSampleLevel(phosphorTexture, linearSampler, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTexture, linearSampler, warped, 0.0).rgb;
	let bloomLum = dot(bloom, vec3<f32>(0.3, 0.5, 0.2));

	// Scope space: x across -aspect..aspect, y up -1..1.
	let p = vec2<f32>((warped.x - 0.5) * 2.0 * aspectRatio, (0.5 - warped.y) * 2.0);
	let pixel = 2.0 / max(resolution.y, 1.0);
	let horizon = params.placement.x;
	let heroRgb = hsvToRgb(vec3<f32>(heroHue(), roleSaturation(0.8), 1.0));
	let iceRgb = hsvToRgb(vec3<f32>(iceHue(), roleSaturation(0.75), 1.0));
	let amberRgb = hsvToRgb(vec3<f32>(amberHue(), roleSaturation(0.9), 1.0));

	// Room: a green-black instrument chamber. Faint haze pools over the
	// horizon; the scope face is a shade lighter than the floor.
	let face = smoothstep(horizon - 0.01, horizon + 0.02, p.y);
	// Room values are display-referred (added after tone mapping) so the
	// darks stay controllable instead of being crushed by the ACES toe.
	var room = vec3<f32>(0.008, 0.017, 0.014);
	let hazeShape = exp(-pow((p.y - horizon - 0.08) * 2.6, 2.0)) * exp(-p.x * p.x * 0.14);
	room = room + iceRgb * hazeShape * (0.012 + params.bandsA.x * 0.014 + params.tone.y * 0.008);
	// The face glass carries a faint phosphor bloom around the hero.
	room = room + heroRgb * exp(-length((p - params.placement.yz) * vec2<f32>(0.7, 1.0)) * 1.8) * (0.012 + params.tone.y * 0.008) * face;

	// Graticule: an etched 8 x 10 division grid on the face glass, lit edge-on
	// by the beam's own glow, with minor ticks on the centre axes and a sweep
	// line that brightens the divisions as it passes.
	let faceTop = 0.92;
	let faceHalfWidth = aspectRatio * 0.94;
	let inFace = face * (1.0 - smoothstep(faceTop - 0.005, faceTop + 0.005, p.y))
		* (1.0 - smoothstep(faceHalfWidth - 0.005, faceHalfWidth + 0.005, abs(p.x)));
	let division = (faceTop - horizon) / 6.0;
	let gy = p.y - horizon;
	let major = max(gridLine(p.x, division, pixel), gridLine(gy, division, pixel));
	let centerY = horizon + division * 3.0;
	let tickX = gridLine(p.x, division * 0.2, pixel) * (1.0 - smoothstep(pixel * 4.0, pixel * 6.0, abs(p.y - centerY)));
	let tickY = gridLine(gy, division * 0.2, pixel) * (1.0 - smoothstep(pixel * 4.0, pixel * 6.0, abs(p.x)));
	let sweepX = (params.sweep.x * 2.0 - 1.0) * aspectRatio * 0.93;
	let sweepBand = exp(-pow((p.x - sweepX) / 0.05, 2.0)) * smoothstep(0.0, 0.5, params.sweep.y);
	let gridLight = 0.028 + bloomLum * 0.35 + sweepBand * (0.022 + params.pulse.y * 0.02)
		+ params.pulse.z * 0.06;
	let graticule = (major * 0.65 + max(tickX, tickY) * 0.8) * inFace * gridLight;
	room = room + mix(heroRgb, vec3<f32>(0.7, 0.85, 0.8), 0.4) * graticule;

	// Floor: perspective rails converging on the vanishing point, lit only by
	// the spectral rows' own bloom.
	let floorMask = 1.0 - face;
	let depth = max(horizon - p.y, 0.0005);
	let worldX = p.x / depth * 0.38;
	let rail = gridLine(worldX, 0.5, pixel / depth * 0.38) * floorMask * smoothstep(0.0, 0.25, depth);
	room = room + iceRgb * rail * (0.01 + bloomLum * 0.25);

	// Horizon: a thin lit seam that swells with the sub band.
	let seam = exp(-pow((p.y - horizon) / (pixel * 2.5), 2.0)) * exp(-p.x * p.x * 0.12);
	room = room + mix(iceRgb, heroRgb, 0.3) * seam * (0.04 + params.bandsA.x * 0.05 + params.pulse.z * 0.08);

	// Polished floor glass: the face content reflects, blurred and fading
	// with distance below the horizon.
	let horizonUv = 0.5 - horizon * 0.5;
	let mirrored = vec2<f32>(warped.x, 2.0 * horizonUv - warped.y);
	let reflection = textureSampleLevel(bloomTexture, linearSampler, mirrored, 0.0).rgb * 0.7
		+ textureSampleLevel(phosphorTexture, linearSampler, mirrored, 0.0).rgb * 0.18;
	let reflectionFade = exp(-depth * 2.4) * floorMask;

	// Glass sheen: a very faint curved reflection across the face.
	let sheen = exp(-pow(length((p - vec2<f32>(-0.55 * aspectRatio, 0.75)) * vec2<f32>(0.6, 1.4)) - 0.55, 2.0) * 60.0);
	room = room + vec3<f32>(0.01, 0.016, 0.016) * sheen * face;

	let vignette = 1.0 - smoothstep(0.45, 1.25, length(centered * vec2<f32>(aspectRatio * 0.9, 1.0)) * 1.15);
	let exposure = 0.95 + params.tone.y * 0.12;
	let emissive = phosphor + bloom * (0.85 + params.tone.y * 0.25) + reflection * reflectionFade * 0.6;
	// Scanlines and grain stay just above perception.
	let scan = 0.965 + 0.035 * sin(in.uv.y * resolution.y * 3.14159265);
	var color = aces(emissive * exposure * scan) * (0.7 + vignette * 0.3) + room * (0.55 + vignette * 0.45);
	// Gentle gamma contrast keeps blacks deep without clipping the room.
	color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.06)) * 1.03;
	let frameIndex = floor(params.view.z * 60.0);
	let grain = (hash12(in.uv * resolution + vec2<f32>(frameIndex * 13.1, frameIndex * 7.7)) - 0.5) * 0.012;
	color = color + vec3<f32>(grain) * (0.6 + vignette * 0.4);
	color = color + (ign(in.uv * resolution, fract(params.view.z) * 60.0) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
