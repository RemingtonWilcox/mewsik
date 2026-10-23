// Signal is a phosphor instrument at night: one vector scope whose parts are
// wired together. The hero figure is a CPU-evaluated polyline (see
// figures.ts); channel traces 0 and 1 are its X and Y deflection signals with
// their write heads feeding the figure's beam head; the horizon rows are the
// figure's silhouette history, born under it and cooling from the hero
// phosphor to the horizon phosphor as they age; the beam head is the one light
// source for graticule, floor and rows. Layout, surface, camera, palette and
// display character all come from the genome as uniforms.
//
// Beam physics (after the published vector-display maths of dood.al's
// oscilloscope and woscope): every stroke is a Gaussian spot dragged along
// each segment, shaded with the analytic integral of that drag. A segment
// carries a fixed amount of light per unit of beam time, so light per pixel
// falls as the beam speeds up: slow strokes and turning points burn, fast
// jumps are faint, and a figure drawn larger gets dimmer, not thinner.
// Strokes add in HDR; the phosphor pass decays the sum with a
// brightness-dependent afterglow; a tight and a very wide glow plus glass
// reflections give halation; the output tone map is 1 - exp(-k light),
// pushing overdriven phosphor toward white whatever its hue.
//
// NOTE: these are JS template literals. Never put a backtick inside a WGSL
// comment here; it terminates the string and silently breaks the shader.

import { SIGNAL_FIGURE_POINTS, SIGNAL_FIGURE_SEGMENTS } from './figures';
import { signalParamsWgsl } from './uniform-layout';

export const SIGNAL_SEGMENTS = SIGNAL_FIGURE_SEGMENTS;
export const SIGNAL_VERTEX_COUNT = SIGNAL_SEGMENTS * 6;
/** Stereo pairs uploaded per frame for the XY beam and the channel traces. */
export const SIGNAL_SCOPE_WINDOW = 4096;
/** Most pairs the XY beam draws in one frame (about 40 ms at 48 kHz). */
export const SIGNAL_BEAM_MAX_PAIRS = 2048;
/** Beam segments per stereo pair (windowed-sinc upsampling on the GPU). */
export const SIGNAL_BEAM_UPSAMPLE = 6;
/** Phosphor full res; tight glow half res; wide glow an eighth. */
export const SIGNAL_TIGHT_DIVISOR = 2;
export const SIGNAL_WIDE_DIVISOR = 8;
export const SIGNAL_HERO_INSTANCES = 2;
export const SIGNAL_CHANNELS = 4;
/** X feed, Y feed, and the drip from the beam head to the newest horizon row. */
export const SIGNAL_FEEDS = 3;
export const SIGNAL_RAILS = 7;
export const SIGNAL_TERRAIN_ROWS = 22;
export const SIGNAL_TERRAIN_BINS = 64;
/** Two floats per horizon bin: height and heat (beat stamps). */
export const SIGNAL_TERRAIN_FLOATS = SIGNAL_TERRAIN_ROWS * SIGNAL_TERRAIN_BINS * 2;
export const SIGNAL_TRACE_INSTANCES =
	SIGNAL_HERO_INSTANCES + SIGNAL_CHANNELS + SIGNAL_FEEDS + SIGNAL_RAILS + SIGNAL_TERRAIN_ROWS;
/**
 * Beams (synthesized strokes and the XY beam in one pass), phosphor, glow
 * prefilter, tight blur H and V, wide prefilter, wide blur H and V, present.
 */
export const SIGNAL_RENDER_PASSES = 9;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
${signalParamsWgsl()}
};
`;

// Shared by the stroke and XY beam modules: the spot integral, the quad
// that holds it, and the fragment that writes the light. Each module
// declares params itself.
const BEAM_COMMON_WGSL = /* wgsl */ `
struct TraceOut {
	@builtin(position) position: vec4<f32>,
	// Light per unit dwell: colour x intensity x speed gain x deposit.
	@location(0) color: vec3<f32>,
	// x along the segment from its start, y across it, z its length; pixels.
	@location(1) local: vec3<f32>,
	@location(2) sigma: f32,
	// Phosphor class: 1 long persistence (figures), 0 fast (traces, rows).
	@location(3) persist: f32,
};

const SQRT_TAU: f32 = 2.50662827463;
const SQRT_HALF_PI: f32 = 1.25331413732;

fn aspect() -> f32 {
	return params.view.x / max(params.view.y, 1.0);
}

fn toNdc(p: vec2<f32>) -> vec2<f32> {
	return vec2<f32>(p.x / aspect(), p.y);
}

// Closed-form erf (Winitzki), within about 1e-4: plenty for light.
fn erfApprox(x: f32) -> f32 {
	let x2 = x * x;
	let t = x2 * (1.27323954474 + 0.147 * x2) / (1.0 + 0.147 * x2);
	return sign(x) * sqrt(1.0 - exp(-t));
}

// The light a unit Gaussian spot (peak 1) leaves at this point while it is
// dragged along the segment, averaged over the segment's beam time. Long
// segments (fast beam) spread the same light thinner; a segment shorter than
// the spot is the spot itself.
fn beamDwell(local: vec3<f32>, sigma: f32) -> f32 {
	let inv = 1.0 / sigma;
	let across = exp(-0.5 * local.y * local.y * inv * inv);
	let len = local.z;
	if (len < sigma * 0.05) {
		return across * exp(-0.5 * local.x * local.x * inv * inv);
	}
	let k = 0.70710678118 * inv;
	let along = (erfApprox(local.x * k) - erfApprox((local.x - len) * k)) * sigma * SQRT_HALF_PI / len;
	return across * along;
}

struct BeamQuad {
	position: vec4<f32>,
	local: vec3<f32>,
	len: f32,
};

// One segment's quad in figure space (x in aspect units), padded by the
// spot's reach on every side so both ends of the integral are covered and
// neighbouring segments tile into one continuous line.
fn beamQuad(start: vec2<f32>, end: vec2<f32>, sigma: f32, corner: u32) -> BeamQuad {
	let resolution = params.view.xy;
	let a = toNdc(start) * resolution * 0.5;
	let b = toNdc(end) * resolution * 0.5;
	let d = b - a;
	let len = length(d);
	let tangent = select(vec2<f32>(1.0, 0.0), d / max(len, 1e-6), len > 1e-4);
	let normal = vec2<f32>(-tangent.y, tangent.x);
	let reach = sigma * 3.2 + 1.0;
	let useEnd = corner == 1u || corner == 4u || corner == 5u;
	let positive = corner == 2u || corner == 3u || corner == 5u;
	let along = select(-reach, len + reach, useEnd);
	let across = select(-reach, reach, positive);
	let pixel = a + tangent * along + normal * across;
	var out: BeamQuad;
	out.position = vec4<f32>(pixel * 2.0 / resolution, 0.0, 1.0);
	out.local = vec3<f32>(along, across, len);
	out.len = len;
	return out;
}

// Light gain for a segment: brightness at the reference speed times the
// reference length the beam would cover per segment at that speed. A
// segment that long reads at exactly the stroke's intensity.
fn speedGain(referenceLength: f32, sigma: f32) -> f32 {
	return referenceLength / (sigma * SQRT_TAU);
}

// A beam almost at rest would burn one point white (the classic scope
// burn, and on a centred figure an orb). Below a tenth of the reference
// speed the beam current eases off, so dwell still glows but cannot run away.
fn dwellCap(len: f32, reference: f32) -> f32 {
	return sqrt(clamp(len / max(reference * 0.12, 1e-4), 0.0, 1.0));
}

@fragment
fn fs_main(in: TraceOut) -> @location(0) vec4<f32> {
	let light = in.color * beamDwell(in.local, in.sigma);
	// Alpha carries the long-persistence share of the light (summed too).
	let peak = max(light.r, max(light.g, light.b));
	return vec4<f32>(light, peak * in.persist);
}
`;

export const SIGNAL_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}

const TAU: f32 = 6.28318530718;
const SCOPE_WINDOW: u32 = ${SIGNAL_SCOPE_WINDOW}u;
const SEGMENTS: u32 = ${SIGNAL_SEGMENTS}u;
const POINTS: u32 = ${SIGNAL_FIGURE_POINTS}u;
const HERO_INSTANCES: u32 = ${SIGNAL_HERO_INSTANCES}u;
const CHANNELS: u32 = ${SIGNAL_CHANNELS}u;
const FEEDS: u32 = ${SIGNAL_FEEDS}u;
const RAILS: u32 = ${SIGNAL_RAILS}u;
const ROWS: u32 = ${SIGNAL_TERRAIN_ROWS}u;
const BINS: u32 = ${SIGNAL_TERRAIN_BINS}u;
const CHANNEL_BASE: u32 = HERO_INSTANCES;
const FEED_BASE: u32 = CHANNEL_BASE + CHANNELS;
const RAIL_BASE: u32 = FEED_BASE + FEEDS;
const ROW_BASE: u32 = RAIL_BASE + RAILS;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>;
@group(0) @binding(2) var<storage, read> terrainRows: array<vec2<f32>, ${SIGNAL_TERRAIN_ROWS * SIGNAL_TERRAIN_BINS}>;
@group(0) @binding(3) var<storage, read> figure: array<vec4<f32>, ${SIGNAL_FIGURE_POINTS * 2}>;
// The stereo window (oldest first); channel traces 0 and 1 read it as the
// real left and right waveforms when the XY beam is up.
@group(0) @binding(4) var<storage, read> scope: array<vec2<f32>, ${SIGNAL_SCOPE_WINDOW}>;

${BEAM_COMMON_WGSL}

fn sq(x: f32) -> f32 {
	return x * x;
}

fn hash11(n: f32) -> f32 {
	return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

// Rough music breaks the beam: the stroke is cut into fragments that crawl
// along it, a few left lit at full strength, the rest dark. 1 means whole.
fn fractureGate(along: f32, cells: f32, salt: f32) -> f32 {
	let amount = clamp(params.voice.x, 0.0, 1.0);
	if (amount < 0.002) {
		return 1.0;
	}
	let cell = along * cells + params.voice.z;
	let id = floor(cell);
	let f = fract(cell);
	let keep = step(amount * 0.32, hash11(id + salt * 17.0));
	let edges = smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.9, 1.0, f));
	return mix(1.0, keep * mix(1.0, edges, 0.8) * 1.9 + 0.025, amount);
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

// ---- Figure -------------------------------------------------------------

fn figureAnchor(which: u32) -> vec3<f32> {
	if (which == 0u) {
		return params.figureA.xyz;
	}
	return params.figureB.xyz;
}

fn figureRaw(which: u32, index: u32) -> vec4<f32> {
	return figure[which * POINTS + min(index, POINTS - 1u)];
}

fn figureLocal(which: u32, u: f32) -> vec2<f32> {
	let position = fract(u) * f32(SEGMENTS);
	let i0 = min(u32(floor(position)), SEGMENTS - 1u);
	let f = fract(position);
	return mix(figureRaw(which, i0).xy, figureRaw(which, i0 + 1u).xy, f);
}

fn figureScreen(which: u32, u: f32) -> vec2<f32> {
	let anchor = figureAnchor(which);
	return anchor.xy + figureLocal(which, u) * anchor.z;
}

// ---- Channel traces -------------------------------------------------------

fn traceOrigin(k: u32) -> vec4<f32> {
	switch k {
		case 0u: { return params.trace0; }
		case 1u: { return params.trace1; }
		case 2u: { return params.trace2; }
		default: { return params.trace3; }
	}
}

fn traceAxis(k: u32) -> vec4<f32> {
	switch k {
		case 0u: { return params.trace0v; }
		case 1u: { return params.trace1v; }
		case 2u: { return params.trace2v; }
		default: { return params.trace3v; }
	}
}

fn traceVisibility(k: u32) -> f32 {
	let channels = params.sweep.y;
	var gate = 1.0;
	switch k {
		case 0u: { gate = 1.0; }
		case 1u: { gate = clamp(0.55 + channels * 0.45, 0.0, 1.0); }
		case 2u: { gate = clamp(channels - 1.4, 0.0, 1.0); }
		default: { gate = clamp(channels - 2.4, 0.0, 1.0); }
	}
	return gate * traceAxis(k).w;
}

// Band traces 2 and 3: four partials whose strengths are the live detail of
// the bins the band owns, on the figure's own time base.
fn bandWave(k: u32, u: f32) -> f32 {
	let band = select(params.band3, params.band2, k == 2u);
	let level = band.x;
	let drift = params.context.z * (0.21 + f32(k) * 0.13);
	var wave = 0.0;
	var total = 0.0;
	for (var j = 0u; j < 4u; j = j + 1u) {
		let partial = f32(j);
		let bin = (band.y + (partial + 0.5) * 0.25 * (band.z - band.y)) / 63.0;
		let strength = (0.32 / (1.0 + partial * 0.8)) + max(smoothDetail(bin), 0.0) * 3.0;
		let harmonic = 1.0 + partial * (1.0 + params.bandsB.y * 0.6);
		wave = wave + sin(TAU * (u * band.w * harmonic + drift * (1.0 + partial * 0.7) + partial * 1.3)) * strength;
		total = total + strength;
	}
	let detail = smoothDetail((band.y + u * (band.z - band.y)) / 63.0);
	wave = wave / max(total, 0.001) * 1.25 + detail * 0.8;
	wave = wave * (0.6 + params.pulse.y * 0.7 * level);
	return wave * (0.25 + level * 1.1 + params.pulse.x * 0.25) * (1.0 - params.tone.y);
}

// The real left (k = 0) or right (k = 1) waveform across a channel trace,
// read from the triggered position in the stereo window.
fn scopeWave(k: u32, f: f32) -> f32 {
	let position = params.scopeTrace.x + clamp(f, 0.0, 1.0) * params.scopeTrace.y;
	let i0 = u32(clamp(floor(position), 0.0, f32(SCOPE_WINDOW - 2u)));
	let v = mix(scope[i0], scope[i0 + 1u], fract(position));
	// The same soft knee as the XY beam keeps loud peaks in the trace's lane.
	let value = select(v.y, v.x, k == 0u) * params.scopeTrace.z;
	return 0.95 * tanh(value / 0.95);
}

fn traceValue(k: u32, u: f32) -> f32 {
	switch k {
		case 0u: { return figureLocal(0u, u).x; }
		case 1u: { return figureLocal(0u, u).y; }
		default: { return bandWave(k, fract(u)); }
	}
}

// Sweep traces are written by a moving head that wraps across the frame;
// scroll traces keep the head fixed at the end nearest the figure and let the
// history stream away from it. Both share the figure's head parameter.
const CHANNEL_TAIL: f32 = 0.94;

struct TracePoint {
	p: vec2<f32>,
	u: f32,
};

fn tracePoint(k: u32, f: f32) -> TracePoint {
	let origin = traceOrigin(k);
	let axis = traceAxis(k);
	let head = params.head.x;
	let uSweep = head - CHANNEL_TAIL * (1.0 - f);
	let positionSweep = fract(uSweep);
	let window = smoothstep(0.0, 0.05, positionSweep) * (1.0 - smoothstep(0.95, 1.0, positionSweep));
	let pSweep = origin.xy + origin.zw * positionSweep + axis.xy * traceValue(k, uSweep) * mix(window, 1.0, select(0.0, 1.0, k < 2u) * 0.6);
	let uScroll = head - (1.0 - f);
	let pScroll = origin.xy + origin.zw * f + axis.xy * traceValue(k, uScroll);
	var out: TracePoint;
	out.p = mix(pSweep, pScroll, axis.z);
	out.u = uSweep;
	// With the XY beam up, X and Y show the real channels as a triggered
	// sweep across the whole trace.
	let wave = select(0.0, params.scopeTrace.w, k < 2u);
	if (wave > 0.001) {
		let pWave = origin.xy + origin.zw * f + axis.xy * scopeWave(k, f);
		out.p = mix(out.p, pWave, wave);
	}
	return out;
}

fn traceHead(k: u32) -> vec2<f32> {
	return tracePoint(k, 1.0).p;
}

// ---- Horizon surfaces --------------------------------------------------------

// A surface rig: the camera and geometry one bench sees its horizon with. A
// bench change keeps the leaving bench's rig (slot 0) and the arriving one's
// (slot 1) and blends what they project on screen. Interpolating one camera
// between two benches instead swings it through poses where the horizon
// falls behind the lens and bursts back: a jump cut in all but name.
struct Rig {
	camera: vec4<f32>,
	offset: vec2<f32>,
	nearFar: vec2<f32>,
	span: f32,
	relief: f32,
	rings: vec3<f32>,
	waterfall: vec4<f32>,
};

fn surfaceRig(slot: u32) -> Rig {
	var r: Rig;
	if (slot == 0u) {
		r.camera = params.camera;
		r.offset = params.anchors.xy;
		r.nearFar = params.depth.xy;
		r.span = params.depth.z;
		r.relief = params.terrain.w;
		r.rings = params.rings.xyz;
		r.waterfall = params.waterfall;
	} else {
		r.camera = params.cameraB;
		r.offset = params.anchors.zw;
		r.nearFar = params.depthB.xy;
		r.span = params.depthB.z;
		r.relief = params.depthB.w;
		r.rings = params.ringsB.xyz;
		r.waterfall = params.waterfallB;
	}
	return r;
}

fn project(world: vec3<f32>, rig: Rig) -> vec3<f32> {
	let yaw = rig.camera.z;
	let pitch = rig.camera.y;
	let cy = cos(yaw);
	let sy = sin(yaw);
	var p = vec3<f32>(world.x * cy + world.z * sy, world.y, -world.x * sy + world.z * cy);
	let cp = cos(pitch);
	let sp = sin(pitch);
	p = vec3<f32>(p.x, p.y * cp + p.z * sp, -p.y * sp + p.z * cp);
	let z = max(p.z, 0.03);
	return vec3<f32>(p.xy * rig.camera.w / z + rig.offset, select(0.0, 1.0, p.z > 0.06));
}

fn rowDepth(age: f32, rig: Rig) -> f32 {
	return 1.0 / mix(1.0 / rig.nearFar.y, 1.0 / rig.nearFar.x, pow(age, 1.45));
}

// Map the along-row coordinate to a turn around the figure. Floors and
// waterfalls unroll the silhouette from the top, so the figure's underside
// runs down the centre line; rings and tunnels keep it circular.
fn rowTurn(kind: u32, u: f32) -> f32 {
	if (kind == 0u || kind == 2u || kind == 3u) {
		return fract(u + 0.25);
	}
	return fract(u);
}

fn surfacePoint(kind: u32, u: f32, age: f32, height: f32, rig: Rig) -> vec3<f32> {
	let relief = rig.relief;
	switch kind {
		case 1u: {
			// Ring: concentric silhouettes expanding out from under the figure.
			let theta = u * TAU;
			let radius = mix(rig.rings.x, rig.rings.y, pow(age, 0.85)) * (1.0 + height * relief * 0.45);
			let world = vec3<f32>(radius * cos(theta), -rig.camera.x + height * relief * 0.6, rig.rings.z + radius * sin(theta));
			return project(world, rig);
		}
		case 2u: {
			// Waterfall: rows stacked obliquely, newest nearest the figure.
			let shrink = 1.0 - age * 0.3;
			let x = (u * 2.0 - 1.0) * rig.span * shrink;
			let p = rig.waterfall.xy + vec2<f32>(x, height * relief) + rig.waterfall.zw * age;
			return vec3<f32>(p, 1.0);
		}
		case 3u: {
			// Canyon: a half-pipe running away to the figure; each row is the
			// silhouette bent into a U, walls lifting with the figure's reach.
			let theta = TAU * 0.5 + u * TAU * 0.5;
			let radius = rig.rings.x * (1.0 - clamp(height, -0.3, 1.5) * relief * 0.4);
			let world = vec3<f32>(radius * cos(theta) * 1.3, radius * sin(theta) + rig.camera.x, rowDepth(age, rig));
			return project(world, rig);
		}
		default: {
			let world = vec3<f32>((u * 2.0 - 1.0) * rig.span, -rig.camera.x + height * relief, rowDepth(age, rig));
			return project(world, rig);
		}
	}
}

fn rowSample(row: u32, turn: f32) -> vec2<f32> {
	let slot = (u32(params.terrain.y) + ROWS - row) % ROWS;
	let scaled = fract(turn) * f32(BINS);
	let i0 = u32(floor(scaled)) % BINS;
	let i1 = (i0 + 1u) % BINS;
	let f = fract(scaled);
	return mix(terrainRows[slot * BINS + i0], terrainRows[slot * BINS + i1], f);
}

struct SurfaceOut {
	p: vec2<f32>,
	valid: f32,
	value: vec2<f32>,
	ring: f32,
};

// A bench change does not re-lay the whole horizon at once: the new surface
// is written in from the newest row and the old scene's rows age out on the
// old surface, so the change ripples down the history like new signal does.
fn surfaceMix(age: f32) -> f32 {
	let global = clamp(params.surface.z, 0.0, 1.0);
	let ripple = max(params.ringsB.w, 0.0);
	return smoothstep(0.0, 1.0, clamp(global * (1.0 + ripple) - clamp(age, 0.0, 1.0) * ripple, 0.0, 1.0));
}

fn blendedSurface(u: f32, age: f32, row: u32, sampled: bool) -> SurfaceOut {
	let kindA = u32(params.surface.x + 0.5);
	let kindB = u32(params.surface.y + 0.5);
	let mixAB = surfaceMix(age);
	var valueA = vec2<f32>(0.0);
	var valueB = vec2<f32>(0.0);
	if (sampled) {
		valueA = rowSample(row, rowTurn(kindA, u));
		valueB = rowSample(row, rowTurn(kindB, u));
	}
	let a = surfacePoint(kindA, u, age, valueA.x, surfaceRig(0u));
	let b = surfacePoint(kindB, u, age, valueB.x, surfaceRig(1u));
	var out: SurfaceOut;
	out.p = mix(a.xy, b.xy, mixAB);
	out.valid = min(mix(a.z, 1.0, mixAB), mix(1.0, b.z, mixAB));
	out.value = mix(valueA, valueB, mixAB);
	let ringA = select(0.0, 1.0, kindA == 1u);
	let ringB = select(0.0, 1.0, kindB == 1u);
	out.ring = mix(ringA, ringB, mixAB);
	return out;
}

// How much a surface's near rows sprawl across the frame (rings, canyons).
fn surfaceDensity(mixAB: f32) -> f32 {
	var density = array<f32, 4>(0.0, 0.3, 0.0, 0.55);
	let kindA = min(u32(params.surface.x + 0.5), 3u);
	let kindB = min(u32(params.surface.y + 0.5), 3u);
	return mix(density[kindA], density[kindB], mixAB) * (1.0 - params.rings.w);
}

// Surfaces differ in how much line they put on screen; dense ones run lower.
fn surfaceGain(mixAB: f32) -> f32 {
	var gains = array<f32, 4>(1.0, 0.64, 0.46, 0.5);
	let kindA = min(u32(params.surface.x + 0.5), 3u);
	let kindB = min(u32(params.surface.y + 0.5), 3u);
	return mix(gains[kindA], gains[kindB], mixAB) * (1.0 - params.rings.w * 0.4);
}

fn edgeFade(u: f32, mixAB: f32) -> f32 {
	let kindA = u32(params.surface.x + 0.5);
	let kindB = u32(params.surface.y + 0.5);
	let flatFade = 1.0 - smoothstep(0.55, 1.0, abs(u * 2.0 - 1.0));
	let fadeA = select(1.0, flatFade, kindA == 0u || kindA == 2u);
	let fadeB = select(1.0, flatFade, kindB == 0u || kindB == 2u);
	return mix(fadeA, fadeB, mixAB);
}

// Where along a row the beam head's turn lands on one surface kind.
fn landingU(kind: u32, turn: f32) -> f32 {
	return select(fract(turn - 0.25), turn, kind == 1u);
}

// Light from the beam head: one source for the whole bench.
fn headLight(p: vec2<f32>) -> f32 {
	let d = length(p - params.head.yz);
	return exp(-d * d * 3.5) * params.head.w;
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
	// Pixels the beam covers per segment at the stroke's reference speed;
	// negative means the segment's own length (a stroke of even brightness).
	reference: f32,
};

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instance: u32
) -> TraceOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let useEnd = corner == 1u || corner == 4u || corner == 5u;
	let f0 = f32(segment) / f32(SEGMENTS);
	let f1 = f32(segment + 1u) / f32(SEGMENTS);
	let resolution = params.view.xy;
	let pixelScale = resolution.y / 640.0;
	let halfHeight = resolution.y * 0.5;
	let energy = params.tone.x;
	let silence = params.tone.y;
	let stroke = params.tone.z;
	let gain = params.heroColor.w;

	let heroRgb = params.heroColor.rgb;
	let traceRgb = params.traceColor.rgb;
	let horizonRgb = params.horizonColor.rgb;
	let hotRgb = params.hotColor.rgb;
	let headU = params.head.x;
	let transient = params.pulse.y;
	// The XY beam takes over the hero (and the X and Y traces) by this much.
	let beamMix = clamp(params.beam.w, 0.0, 1.0);

	var s: Stroke;
	s.hot = vec3<f32>(0.0);
	s.along = select(f0, f1, useEnd);
	s.persist = 1.0;
	s.reference = -1.0;
	if (instance < HERO_INSTANCES) {
		let which = instance;
		let raw0 = figureRaw(which, segment);
		let raw1 = figureRaw(which, segment + 1u);
		let anchor = figureAnchor(which);
		s.start = anchor.xy + raw0.xy * anchor.z;
		s.end = anchor.xy + raw1.xy * anchor.z;
		let depth = select(raw0.z, raw1.z, useEnd);
		let u = s.along;
		// The beam head: a comet that the channel traces are writing.
		let behind = fract(headU - u);
		let comet = exp(-behind * 7.0);
		let spot = exp(-behind * 70.0) + exp(-(1.0 - behind) * 140.0) * 0.6;
		let heroLevel = (0.62 + energy * 0.4 + params.pulse.z * 0.3) * (1.0 - silence * 0.55) * gain * (1.0 - beamMix);
		let screen = params.figureB.w;
		// One pass of the figure per frame at uniform parameter speed: the
		// mean segment is the reference, so turning points and cusps burn
		// and long sweeps thin out. figureLen.zw shrink big figures' light.
		let meanLen = select(params.figureLen.y * params.figureLen.w, params.figureLen.x * params.figureLen.z, which == 0u);
		s.reference = meanLen * anchor.z * halfHeight;
		if (which == 0u) {
			s.color = heroRgb;
			s.intensity = heroLevel * (0.5 + depth * 0.6) * (0.62 + comet * 0.55) * params.figureA.w
				* fractureGate(u, 46.0, 0.0);
			s.halfWidth = (0.8 + energy * 0.25 + depth * 0.4) * stroke * pixelScale;
			s.hot = mix(heroRgb, hotRgb, 0.7) * spot * (0.4 + transient * 1.2 + params.pulse.x) * params.hotColor.w * (1.0 - beamMix);
		} else {
			// Figure B: the stereo ghost of A, or (dual bench) A seen from the side
			// on its own screen.
			let spread = clamp(params.traceColor.w * 4.0, 0.0, 1.0);
			let ghostLevel = (0.06 + spread * 0.24) * (0.45 + depth * 0.55);
			let screenLevel = (0.5 + depth * 0.6) * (0.62 + comet * 0.55);
			s.color = mix(mix(heroRgb, horizonRgb, 0.55), heroRgb, screen * 0.6);
			s.intensity = heroLevel * mix(ghostLevel, screenLevel * 0.85, screen) * fractureGate(u, 46.0, 1.0);
			s.halfWidth = mix(0.7 + depth * 0.25, 0.8 + depth * 0.4, screen) * stroke * pixelScale;
			s.hot = mix(heroRgb, hotRgb, 0.7) * spot * (0.4 + transient * 1.2) * params.hotColor.w * screen * (1.0 - beamMix);
		}
	} else if (instance < FEED_BASE) {
		let k = instance - CHANNEL_BASE;
		s.persist = mix(0.18, 0.0, traceAxis(k).z);
		let visibility = traceVisibility(k);
		let a = tracePoint(k, f0);
		let b = tracePoint(k, f1);
		s.start = a.p;
		s.end = b.p;
		let axis = traceAxis(k);
		let scroll = axis.z;
		// The real waveforms on X and Y draw as one triggered sweep.
		let wave = select(0.0, params.scopeTrace.w, k < 2u);
		let level = select(select(params.band3.x, params.band2.x, k == 2u), 0.6 + energy * 0.3, k < 2u);
		let tip = smoothstep(0.985, 1.0, s.along) * (1.0 - wave);
		// Phosphor tail: brightest at the write head.
		let age = 1.0 - s.along;
		let tail = mix(mix(exp(-age * 2.2) * (1.0 - smoothstep(0.8, 1.0, age)), exp(-age * 1.3), scroll), 0.8, wave);
		let wraps = select(0.0, 1.0, floor(a.u) != floor(b.u)) * (1.0 - scroll) * (1.0 - wave);
		// X and Y lean toward the hero phosphor: they are the figure's own signals.
		s.color = select(traceRgb, mix(traceRgb, heroRgb, 0.28), k < 2u);
		// Hierarchy: traces dim where they pass behind the figure.
		let mid = (s.start + s.end) * 0.5;
		let heroDistance = length((mid - params.figureA.xy) * vec2<f32>(0.8, 1.0)) / max(params.figureA.z, 0.05);
		let behindHero = mix(0.3, 1.0, smoothstep(0.35, 1.25, heroDistance));
		s.intensity = visibility * tail * behindHero * (1.0 - wraps)
			* (0.5 + level * 0.6 + energy * 0.2) * (1.0 - silence * 0.4) * gain
			* (1.0 + headLight(mid) * 0.6) * fractureGate(s.along, 22.0, f32(k) + 3.0);
		s.halfWidth = (0.95 + level * 0.3) * stroke * pixelScale;
		let flare = select(level * 0.6, 0.5 + transient * 1.2, k < 2u);
		s.hot = mix(traceRgb, hotRgb, 0.5) * tip * visibility * flare * 1.6 * (1.0 - wraps);
		// A time-domain trace slows where the signal is flat and races up
		// the edges: the reference is the sweep's own step along its axis.
		s.reference = length(traceOrigin(k).zw) * halfHeight / f32(SEGMENTS) * mix(CHANNEL_TAIL, 1.0, max(scroll, wave));
		if (visibility <= 0.001) {
			s.start = vec2<f32>(-9.0, -9.0);
			s.end = vec2<f32>(-9.0, -9.0);
		}
	} else if (instance < RAIL_BASE) {
		// Feed lines: from each deflection trace's write head into the beam
		// head, with a dot carried along them once per beat. The third feed is
		// the drip: from the beam head down to the point of the newest horizon
		// row that the head is writing, so the floor visibly comes from the
		// figure.
		let k = instance - FEED_BASE;
		s.persist = 0.0;
		var dripFade = 1.0;
		let figureHead = mix(figureScreen(0u, headU), params.head.yz, beamMix);
		var source = vec2<f32>(0.0);
		var goal = figureHead;
		if (k < 2u) {
			source = traceHead(k);
			goal = mix(figureHead, figureScreen(1u, headU), select(0.0, params.figureB.w * (1.0 - beamMix), k == 1u));
		} else {
			let headLocal = (figureHead - params.figureA.xy) / max(params.figureA.z, 1e-3);
			let turn = fract(atan2(headLocal.y, headLocal.x) / TAU + 1.0);
			// Land on both surfaces and blend, so a bench change carries the drip
			// across instead of re-pointing it.
			let landingAge = 0.5 / f32(ROWS);
			let landingMix = surfaceMix(landingAge);
			let rowUA = landingU(u32(params.surface.x + 0.5), turn);
			let rowUB = landingU(u32(params.surface.y + 0.5), turn);
			let landingA = blendedSurface(rowUA, landingAge, 0u, true);
			let landingB = blendedSurface(rowUB, landingAge, 0u, true);
			source = figureHead;
			goal = mix(landingA.p, landingB.p, landingMix);
			// On flat surfaces the landing wraps from one edge to the other once a
			// revolution; it fades out at the edges so the wrap is never seen.
			dripFade = mix(edgeFade(rowUA, 0.0), edgeFade(rowUB, 1.0), landingMix);
		}
		s.start = mix(source, goal, f0);
		s.end = mix(source, goal, f1);
		let along = s.along;
		let dash = smoothstep(0.18, 0.32, abs(fract(along * 26.0 - params.view.z * 0.7) - 0.5));
		let travel = smoothstep(0.0, 0.62, params.sweep.w);
		let dotGlow = exp(-sq((along - travel) / 0.03)) * (1.0 - smoothstep(0.62, 0.8, params.sweep.w));
		let visibility = select(traceVisibility(min(k, 1u)) * params.sweep.z, params.sweep.z * params.surface.w * 0.8 * dripFade, k == 2u);
		s.color = select(mix(traceRgb, heroRgb, 0.5), mix(heroRgb, horizonRgb, along), k == 2u);
		s.intensity = visibility * (0.13 + energy * 0.08) * dash * gain * smoothstep(0.0, 0.06, along) * (1.0 - smoothstep(0.94, 1.0, along));
		s.halfWidth = 0.6 * stroke * pixelScale;
		s.hot = hotRgb * dotGlow * visibility * (0.5 + transient * 1.2);
	} else if (instance < ROW_BASE) {
		// Rails run along the age direction of the horizon surface; on radar
		// benches rail zero is the rotating sweep arm.
		let r = instance - RAIL_BASE;
		s.persist = 0.0;
		let arm = select(0.0, params.rings.w, r == 0u);
		let u = mix((f32(r) + 0.5) / f32(RAILS), params.sweep.x, arm);
		let a = blendedSurface(u, f0, 0u, false);
		let b = blendedSurface(u, f1, 0u, false);
		s.start = a.p;
		s.end = b.p;
		let fade = smoothstep(0.0, 0.25, s.along) * (1.0 - smoothstep(0.85, 1.0, s.along));
		let railLevel = params.depth.w * (1.0 - a.ring) * (1.0 - arm) * 0.05;
		s.color = mix(horizonRgb, heroRgb, arm * 0.6);
		s.intensity = railLevel * fade * min(a.valid, b.valid) * gain * params.surface.w
			* (1.0 + headLight((a.p + b.p) * 0.5) * 2.0);
		s.halfWidth = mix(0.55, 0.9, arm) * stroke * pixelScale;
		s.hot = vec3<f32>(0.0);
	} else {
		let row = instance - ROW_BASE;
		s.persist = 0.0;
		let age = (f32(row) + params.terrain.x) / f32(ROWS);
		let a = blendedSurface(f0, age, row, true);
		let b = blendedSurface(f1, age, row, true);
		s.start = a.p;
		s.end = b.p;
		let fadeIn = smoothstep(0.0, 0.22, age);
		let rowMix = surfaceMix(age);
		let dense = clamp(surfaceDensity(rowMix), 0.0, 1.0);
		let fadeOut = 1.0 - smoothstep(mix(0.78, 0.5, dense), mix(1.0, 0.82, dense), age);
		let u = s.along;
		let value = select(a.value, b.value, useEnd);
		let edge = edgeFade(u, rowMix);
		// Fresh rows carry the figure's own phosphor and cool into the horizon
		// role as they age: the floor is the figure's memory.
		s.color = mix(heroRgb, horizonRgb, smoothstep(0.04, 0.42, age));
		let mid = (a.p + b.p) * 0.5;
		let light = headLight(mid);
		// Radar: the arm re-excites the long phosphor as it passes.
		let turn = fract(u);
		let behindArm = fract(params.sweep.x - turn);
		// P7 radar: rows glow only in the sweep's wake, a rotating reveal rather
		// than a lit disc.
		let radar = params.rings.w * a.ring * (exp(-behindArm * 2.6) * 2.1 - 0.9);
		s.intensity = fadeIn * fadeOut * edge * (0.05 + max(value.x, 0.0) * 1.4) * (0.45 + age * 0.55)
			* (1.0 - silence * 0.5) * min(a.valid, b.valid) * gain * params.surface.w
			* max(1.0 + light * 1.4 + radar, 0.06) * surfaceGain(rowMix)
			* fractureGate(u, 30.0, f32(row) + 7.0);
		s.halfWidth = (0.55 + age * 0.75) * stroke * pixelScale;
		// The newest row flashes as it is written on the beat tick, and beat
		// stamps from the beam head ride the rows down the horizon.
		let fresh = 1.0 - smoothstep(0.0, 2.5 / f32(ROWS), age);
		let stamp = clamp(value.y, 0.0, 2.0);
		s.hot = (horizonRgb * fresh * params.terrain.z * 0.8 + hotRgb * stamp * (0.9 - age * 0.5))
			* fadeIn * edge * min(a.valid, b.valid) * params.surface.w;
	}

	// The spot: focused by the music's punch, never under a pixel wide.
	let sigma = max(params.deposit.z, s.halfWidth * 0.62 * params.deposit.w);
	let quad = beamQuad(s.start, s.end, sigma, corner);
	let reference = select(s.reference, quad.len, s.reference < 0.0);
	let deposit = mix(params.deposit.y, params.deposit.x, s.persist);
	let cap = select(1.0, dwellCap(quad.len, reference), s.reference > 0.0);
	var out: TraceOut;
	out.position = quad.position;
	out.local = quad.local;
	out.sigma = sigma;
	out.color = (s.color * s.intensity + s.hot) * speedGain(max(reference, 0.0), sigma) * deposit * cap;
	out.persist = s.persist;
	return out;
}
`;

// The real XY beam: the stereo signal itself deflects the spot, left on X
// and right on Y (or turned a quarter for the goniometer view). Pairs are
// upsampled on the GPU with a Lanczos-3 windowed sinc, so the beam is the
// band-limited curve between samples rather than a polyline through them.
// Every segment carries the same beam time, so the dwell physics is the
// real thing: slow parts of the picture burn, fast strokes are faint. While
// the hero hands over, the beam's deflection blends from the synthesized
// figure (traced once per frame) to the signal, so the figure morphs into
// the music's own picture instead of being swapped for it.
export const SIGNAL_BEAM_WGSL = /* wgsl */ `
${PARAMS_WGSL}

const PI: f32 = 3.14159265359;
const SCOPE_WINDOW: i32 = ${SIGNAL_SCOPE_WINDOW};
const POINTS: u32 = ${SIGNAL_FIGURE_POINTS}u;
const FIGURE_SEGMENTS: u32 = ${SIGNAL_SEGMENTS}u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> figure: array<vec4<f32>, ${SIGNAL_FIGURE_POINTS * 2}>;
@group(0) @binding(2) var<storage, read> scope: array<vec2<f32>, ${SIGNAL_SCOPE_WINDOW}>;

${BEAM_COMMON_WGSL}

fn figureLocal(which: u32, u: f32) -> vec2<f32> {
	let position = fract(u) * f32(FIGURE_SEGMENTS);
	let i0 = min(u32(floor(position)), FIGURE_SEGMENTS - 1u);
	let base = which * POINTS;
	return mix(figure[base + i0].xy, figure[base + i0 + 1u].xy, fract(position));
}

fn scopeAt(index: i32) -> vec2<f32> {
	return scope[clamp(index, 0, SCOPE_WINDOW - 1)];
}

fn lanczos3(x: f32) -> f32 {
	let ax = abs(x);
	if (ax < 1e-4) {
		return 1.0;
	}
	if (ax >= 3.0) {
		return 0.0;
	}
	let px = PI * x;
	return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}

// The band-limited signal at a fractional window position.
fn resample(position: f32) -> vec2<f32> {
	let base = floor(position);
	let f = position - base;
	let i = i32(base);
	var sum = vec2<f32>(0.0);
	var weight = 0.0;
	for (var k = -2; k <= 3; k = k + 1) {
		let w = lanczos3(f - f32(k));
		sum = sum + scopeAt(i + k) * w;
		weight = weight + w;
	}
	return sum / max(weight, 1e-3);
}

// Screen position of the beam at segment boundary j. Instance 1 is the
// second screen of a dual bench, showing the other view of the same signal.
fn beamPoint(which: u32, j: f32) -> vec2<f32> {
	let up = max(params.beam.z, 1.0);
	var q = resample(params.beam.x + j / up) * params.beamDrive.y;
	// Soft knee per axis, like a scope's deflection amplifiers easing into
	// saturation: a peak the gain pushes past the reach stays on the face,
	// and a dense mix fills a woven box, never a disc (tanh, so small
	// pictures are untouched).
	let reach = 0.95;
	q = reach * tanh(q / reach);
	let other = select(0.78539816, -0.78539816, params.beamDrive.z > 0.39);
	let turn = params.beamDrive.z + select(0.0, other, which == 1u);
	let c = cos(turn);
	let s = sin(turn);
	q = vec2<f32>(q.x * c - q.y * s, q.x * s + q.y * c);
	// While handing over, the beam traces the synthesized figure once.
	let synth = figureLocal(which, j / max(params.beam.y, 1.0));
	let p = mix(synth, q, clamp(params.beam.w, 0.0, 1.0));
	let anchor = select(params.figureB.xyz, params.figureA.xyz, which == 0u);
	return anchor.xy + p * anchor.z;
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instance: u32
) -> TraceOut {
	let segment = vertexIndex / 6u;
	let corner = vertexIndex % 6u;
	let j = f32(segment);
	let a = beamPoint(instance, j);
	let b = beamPoint(instance, j + 1.0);
	// The same spot the strokes use, at the hero's stroke weight.
	let sigma = max(params.deposit.z, 0.55 * params.tone.z * (params.view.y / 640.0) * params.deposit.w);
	let quad = beamQuad(a, b, sigma, corner);
	let screen = select(params.figureB.w, 1.0, instance == 0u);
	var out: TraceOut;
	out.position = quad.position;
	out.local = quad.local;
	out.sigma = sigma;
	// beamGain is the light at reference speed times the reference length
	// per segment: the same for every segment, which is what makes it real.
	// Every segment is the same beam time; beamStep is the frame's mean
	// segment in pixels, the reference the dwell cap measures against.
	let cap = dwellCap(quad.len, params.beamDrive.w);
	out.color = params.heroColor.rgb * params.beamDrive.x * screen * speedGain(1.0, sigma) * params.deposit.x * cap;
	out.persist = 1.0;
	return out;
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

// Phosphor. Fresh beam light adds to what the phosphor still holds, so
// retraces and crossings stack. The held light decays with afterglow: at
// full rate while bright, more slowly as it dims, so a hard-driven stroke
// falls off quickly to a glow that lingers, the way real phosphor has a
// fast exponential head and a long low tail. Alpha carries the
// long-persistence share; the rest (channel tails, horizon rows) uses the
// fast phosphor. A small extinction floor puts the last glimmer out so the
// tube returns to true black. The trail drifts a hair outward from the
// figure and cools toward the hero phosphor as it ages.
export const SIGNAL_FEEDBACK_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;
@group(0) @binding(3) var previousTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let aspectRatio = params.view.x / max(params.view.y, 1.0);
	let heroUv = vec2<f32>(params.figureA.x / aspectRatio * 0.5 + 0.5, 0.5 - params.figureA.y * 0.5);
	let zoom = 1.0 - (0.0003 + params.bandsA.x * 0.0006 + params.pulse.w * 0.0006);
	let previousUv = heroUv + (in.uv - heroUv) * zoom;
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.02, edge);
	let previous = textureSampleLevel(previousTexture, linearSampler, previousUv, 0.0);
	let scene = textureLoad(sceneTexture, vec2<i32>(in.position.xy), 0);
	let peak = max(previous.r, max(previous.g, previous.b));
	let longShare = clamp(previous.a / max(peak, 1e-6), 0.0, 1.0);
	// Afterglow: the fade per frame scales with how bright the phosphor is
	// against the knee, never below a floor share.
	let bright = peak / (peak + max(params.post.z, 1e-4));
	let fadeLong = clamp(params.post.x * mix(0.5, 1.0, bright), 0.0, 1.0);
	let fadeShort = clamp(params.post.y * mix(0.7, 1.0, bright), 0.0, 1.0);
	let keptLong = peak * longShare * (1.0 - fadeLong);
	let keptShort = peak * (1.0 - longShare) * (1.0 - fadeShort);
	let kept = max(keptLong + keptShort - params.output.w, 0.0);
	let scale = select(0.0, kept / max(peak, 1e-6), peak > 1e-6) * border;
	let persistRgb = params.heroColor.rgb;
	let tint = mix(vec3<f32>(1.0), persistRgb / max(max(persistRgb.r, persistRgb.g), max(persistRgb.b, 0.001)), 0.03);
	let trail = previous.rgb * scale * tint;
	let trailLong = select(0.0, kept * keptLong / max(keptLong + keptShort, 1e-6), kept > 0.0) * border;
	return vec4<f32>(trail + scene.rgb, trailLong + scene.a);
}
`;

// Glow prefilter: the phosphor at half resolution, a 4x4 tent so thin
// strokes do not alias. Everything glows in proportion to its light; there
// is no threshold, since halation is the glass scattering all of it.
export const SIGNAL_GLOW_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	// One texel of the full-resolution phosphor.
	let texel = 1.0 / max(params.view.xy, vec2<f32>(1.0));
	var color = vec3<f32>(0.0);
	for (var i = 0u; i < 4u; i = i + 1u) {
		let offset = vec2<f32>(select(-1.0, 1.0, (i & 1u) == 1u), select(-1.0, 1.0, i >= 2u));
		color = color + textureSampleLevel(sourceTexture, linearSampler, in.uv + offset * texel, 0.0).rgb;
	}
	return vec4<f32>(color * 0.25, 1.0);
}
`;

// Wide glow prefilter: the tight glow at an eighth of full resolution, a
// 4x4 grid of bilinear taps covering an 8x8 block of the half-res source.
export const SIGNAL_WIDE_DOWN_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	// One texel of the half-resolution tight glow.
	let texel = ${SIGNAL_TIGHT_DIVISOR}.0 / max(params.view.xy, vec2<f32>(1.0));
	var color = vec3<f32>(0.0);
	for (var y = 0u; y < 4u; y = y + 1u) {
		for (var x = 0u; x < 4u; x = x + 1u) {
			let offset = vec2<f32>(f32(x) * 2.0 - 3.0, f32(y) * 2.0 - 3.0);
			color = color + textureSampleLevel(sourceTexture, linearSampler, in.uv + offset * texel, 0.0).rgb;
		}
	}
	return vec4<f32>(color / 16.0, 1.0);
}
`;

/**
 * Separable Gaussian with `taps` taps (odd), folded into bilinear pairs so it
 * costs about half the fetches. Weights are computed here and inlined.
 */
function signalGaussianShader(directionX: number, directionY: number, taps: number, sigma: number) {
	const half = (taps - 1) / 2;
	const weights = Array.from({ length: half + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
	const total = weights[0] + 2 * weights.slice(1).reduce((sum, w) => sum + w, 0);
	const normalized = weights.map((w) => w / total);
	const pairs: string[] = [];
	for (let i = 1; i <= half; i += 2) {
		const w1 = normalized[i];
		const w2 = i + 1 <= half ? normalized[i + 1] : 0;
		const w = w1 + w2;
		const offset = (i * w1 + (i + 1) * w2) / w;
		pairs.push(
			`\tcolor = color + (textureSampleLevel(sourceTexture, linearSampler, in.uv + direction * ${offset.toFixed(6)}, 0.0).rgb + textureSampleLevel(sourceTexture, linearSampler, in.uv - direction * ${offset.toFixed(6)}, 0.0).rgb) * ${w.toFixed(8)};`
		);
	}
	return /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let texel = 1.0 / vec2<f32>(textureDimensions(sourceTexture));
	// Soft music scatters wider (voice halation widens the kernel a little).
	let spread = 0.85 + clamp(params.voice.w, 0.0, 1.0) * 0.3;
	let direction = vec2<f32>(${directionX.toFixed(1)}, ${directionY.toFixed(1)}) * texel * spread;
	var color = textureSampleLevel(sourceTexture, linearSampler, in.uv, 0.0).rgb * ${normalized[0].toFixed(8)};
${pairs.join('\n')}
	return vec4<f32>(color, 1.0);
}
`;
}

/** Tight glow: 17 taps at half resolution. */
export const SIGNAL_TIGHT_BLUR_H_WGSL = signalGaussianShader(1, 0, 17, 3.2);
export const SIGNAL_TIGHT_BLUR_V_WGSL = signalGaussianShader(0, 1, 17, 3.2);
/** Wide glow: 65 taps at an eighth of full resolution. */
export const SIGNAL_WIDE_BLUR_H_WGSL = signalGaussianShader(1, 0, 65, 11);
export const SIGNAL_WIDE_BLUR_V_WGSL = signalGaussianShader(0, 1, 65, 11);

export const SIGNAL_COMPOSITE_WGSL = /* wgsl */ `
${POST_COMMON_WGSL}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var phosphorTexture: texture_2d<f32>;
@group(0) @binding(3) var tightTexture: texture_2d<f32>;
@group(0) @binding(4) var wideTexture: texture_2d<f32>;

const TAU: f32 = 6.28318530718;

fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
	return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715)) + frame * 0.61803398875));
}

fn hash12(p: vec2<f32>) -> f32 {
	var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
	p3 = p3 + dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

fn sq(x: f32) -> f32 {
	return x * x;
}

fn gridLine(coordinate: f32, spacing: f32, width: f32) -> f32 {
	let distance = abs(fract(coordinate / spacing + 0.5) - 0.5) * spacing;
	return 1.0 - smoothstep(width * 0.5, width * 1.6, distance);
}

fn sdRoundBox(p: vec2<f32>, halfSize: vec2<f32>, radius: f32) -> f32 {
	let r = min(radius, min(halfSize.x, halfSize.y));
	let q = abs(p) - halfSize + vec2<f32>(r);
	return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

struct Face {
	inside: f32,
	grid: f32,
	frame: f32,
	bezel: f32,
	glass: f32,
};

// One scope face: a rounded screen with an etched graticule. A face whose
// corner radius reaches its half size is round and carries range rings and
// a crosshair instead of a division grid; count stacks strips vertically.
fn scopeFaceStack(p: vec2<f32>, center: vec2<f32>, halfSize: vec2<f32>, radius: f32, count: f32, gap: f32, bezelAmount: f32, pixel: f32) -> Face {
	var lp = p - center;
	let pitch = halfSize.y * 2.0 + gap;
	let index = clamp(floor(lp.y / pitch + (count - 1.0) * 0.5 + 0.5), 0.0, count - 1.0);
	lp.y = lp.y - (index - (count - 1.0) * 0.5) * pitch;
	let d = sdRoundBox(lp, halfSize, radius);
	var face: Face;
	face.inside = 1.0 - smoothstep(-pixel, pixel, d);
	let roundness = clamp(radius / max(min(halfSize.x, halfSize.y), 1e-3), 0.0, 1.0);
	let density = 8.0 + params.context.x * 6.0;
	let spacing = (halfSize.x * 2.0) / density;
	let lines = max(gridLine(lp.x + halfSize.x, spacing, pixel), gridLine(lp.y + halfSize.y, spacing, pixel));
	let ticks = max(
		gridLine(lp.x, spacing * 0.2, pixel) * (1.0 - smoothstep(pixel * 4.0, pixel * 6.0, abs(lp.y))),
		gridLine(lp.y, spacing * 0.2, pixel) * (1.0 - smoothstep(pixel * 4.0, pixel * 6.0, abs(lp.x)))
	);
	let rectGrid = lines * 0.65 + ticks * 0.8;
	let radial = length(lp);
	let rings = gridLine(radial, halfSize.x / 4.0, pixel);
	let crossLines = max(gridLine(lp.x, 1000.0, pixel), gridLine(lp.y, 1000.0, pixel));
	let roundGrid = rings * 0.7 + crossLines * 0.6 + ticks * 0.5;
	face.grid = mix(rectGrid, roundGrid, smoothstep(0.85, 0.98, roundness)) * face.inside;
	face.frame = (1.0 - smoothstep(0.0, pixel * 2.0, abs(d))) * (1.0 - bezelAmount * 0.7);
	let bezelWidth = 0.075 * bezelAmount;
	face.bezel = select(0.0, (1.0 - smoothstep(bezelWidth - pixel, bezelWidth + pixel, d)) * smoothstep(-pixel, pixel, d), bezelAmount > 0.01);
	face.glass = face.inside * exp(-max(-d, 0.0) * 18.0);
	return face;
}

fn mixFace(a: Face, b: Face, t: f32) -> Face {
	var face: Face;
	face.inside = mix(a.inside, b.inside, t);
	face.grid = mix(a.grid, b.grid, t);
	face.frame = mix(a.frame, b.frame, t);
	face.bezel = mix(a.bezel, b.bezel, t);
	face.glass = mix(a.glass, b.glass, t);
	return face;
}

// A fractional strip count (a bench rearranging into a strip bank) blends
// the two neighbouring whole stacks, so strips divide in instead of popping.
fn scopeFace(p: vec2<f32>, center: vec2<f32>, halfSize: vec2<f32>, radius: f32, stack: f32, gap: f32, bezelAmount: f32, pixel: f32) -> Face {
	let count = max(stack, 1.0);
	let low = floor(count);
	let t = smoothstep(0.0, 1.0, count - low);
	let a = scopeFaceStack(p, center, halfSize, radius, low, gap, bezelAmount, pixel);
	if (t < 0.002) {
		return a;
	}
	let b = scopeFaceStack(p, center, halfSize, radius, low + 1.0, gap, bezelAmount, pixel);
	return mixFace(a, b, t);
}

fn caSample(source: texture_2d<f32>, uv: vec2<f32>, offset: vec2<f32>) -> vec3<f32> {
	return vec3<f32>(
		textureSampleLevel(source, linearSampler, uv + offset, 0.0).r,
		textureSampleLevel(source, linearSampler, uv, 0.0).g,
		textureSampleLevel(source, linearSampler, uv - offset, 0.0).b
	);
}

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let aspectRatio = resolution.x / max(resolution.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// ---- Tube geometry ------------------------------------------------------
	// The frame is the face of one curved tube. The phosphor sits on the inside
	// of a glass cap, so the picture barrels with the curvature, and the face
	// ends in rounded corners where the glass meets the bezel.
	let curvature = params.display.z;
	let warped = 0.5 + centered * (1.0 + r2 * curvature);
	let p = vec2<f32>((warped.x - 0.5) * 2.0 * aspectRatio, (0.5 - warped.y) * 2.0);
	let pixel = 2.0 / max(resolution.y, 1.0);
	let faceHalf = vec2<f32>(aspectRatio, 1.0) - vec2<f32>(0.006);
	let faceD = sdRoundBox(p, faceHalf, params.tube.x);
	let tube = 1.0 - smoothstep(-pixel * 2.0, pixel * 1.5, faceD);
	// Glass normal: a spherical cap whose tilt grows toward the rim. The angle
	// sets both the light falloff across the face (obliquity) and how much of
	// the room the glass reflects (Fresnel). This is the only vignette.
	let rim = length(centered * vec2<f32>(aspectRatio * 0.8, 1.0)) * 2.0;
	let tiltSin = clamp(rim * (0.22 + curvature * 1.6) * (0.7 + params.display2.z), 0.0, 0.95);
	let cosTheta = sqrt(1.0 - tiltSin * tiltSin);
	let obliquity = pow(cosTheta, 2.0 + params.display2.z * 5.0);
	let fresnel = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);

	// ---- Light on the face ----------------------------------------------------
	// Chromatic aberration grows toward the rim and kicks with heard
	// transients, never with the beat clock.
	let caAmount = (0.0004 + r2 * 0.003) * params.display2.y * (1.0 + params.pulse.x * 1.6 + params.pulse.y * 0.5);
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let phosphor = caSample(phosphorTexture, warped, direction * caAmount);
	// Halation: the faceplate scatters the beam light, tightly around each
	// stroke and very widely across the glass. Soft-cored music scatters more.
	let halation = params.display2.x * (0.7 + params.voice.w * 0.7);
	let tight = caSample(tightTexture, warped, direction * caAmount * 2.0) * params.glow.x * halation;
	let wide = textureSampleLevel(wideTexture, linearSampler, warped, 0.0).rgb * params.glow.y * halation;
	// Glass reflections: light bouncing between the curved faceplate's
	// surfaces lands as a few faint, ever larger copies of the wide glow,
	// strongest near the axis. The spread follows the tube's curvature.
	var reflection = vec3<f32>(0.0);
	let spread = params.output.y * (0.6 + curvature * 2.5);
	for (var i = 0u; i < 5u; i = i + 1u) {
		let grow = 1.0 + spread * (f32(i) + 1.0);
		let copyUv = 0.5 + (warped - 0.5) / grow;
		let fromAxis = length((copyUv - 0.5) * vec2<f32>(aspectRatio, 1.0)) * 1.25;
		let falloff = pow(max(1.0 - fromAxis * fromAxis, 0.0), 4.0);
		reflection = reflection + textureSampleLevel(wideTexture, linearSampler, copyUv, 0.0).rgb * falloff / (f32(i) + 1.5);
	}
	reflection = reflection * params.glow.z * params.display2.x;

	// The light the instrument puts into the room: the mean of the wide glow
	// over the face. Everything that is not phosphor (glass, graticule, bezel,
	// the bench) is lit by this and by the local glow, and by nothing else.
	var spill = vec3<f32>(0.0);
	for (var iy = 0u; iy < 3u; iy = iy + 1u) {
		for (var ix = 0u; ix < 4u; ix = ix + 1u) {
			let at = vec2<f32>((f32(ix) + 0.5) / 4.0, (f32(iy) + 0.5) / 3.0);
			spill = spill + textureSampleLevel(wideTexture, linearSampler, at, 0.0).rgb;
		}
	}
	spill = spill / 12.0 * params.display2.x * params.tube.z;
	let spillLum = dot(spill, vec3<f32>(0.3, 0.5, 0.2));

	let heroRgb = params.heroColor.rgb;
	let horizonRgb = params.horizonColor.rgb;

	// Room values are display-referred (added after the tone map) so the
	// darks stay controllable and true black stays black.
	var room = params.roomColor.rgb;

	// The beam head is the brightest light on the bench.
	let headDistance = length((p - params.head.yz) * vec2<f32>(0.85, 1.0));
	let headPool = exp(-headDistance * 2.4) * params.head.w;

	let faceA = scopeFace(p, params.faceA.xy, params.faceA.zw, params.faceAStyle.x, params.faceAStyle.y, params.faceAStyle.z, params.faceBStyle.y, pixel);
	let faceB = scopeFace(p, params.faceB.xy, params.faceB.zw, params.faceBStyle.x, 1.0, 0.0, params.faceBStyle.z, pixel);
	let visA = params.faceAStyle.w;
	let visB = params.faceBStyle.w;
	let inside = max(faceA.inside * visA, faceB.inside * visB);
	let grid = max(faceA.grid * visA, faceB.grid * visB);
	let frame = max(faceA.frame * visA, faceB.frame * visB);
	let bezel = max(faceA.bezel * visA, faceB.bezel * visB);
	let glass = max(faceA.glass * visA, faceB.glass * visB);

	// Local light: the glow here plus the beam head's pool and the room
	// spill. The etched graticule and the screen rims only exist where this
	// light reaches them; with the beam off they are gone.
	let localLight = tight * 0.35 + wide * 1.6 + heroRgb * headPool * 0.05 * params.tone.x + spill * 0.8;
	let localLum = dot(localLight, vec3<f32>(0.3, 0.5, 0.2));
	// The phosphor coat is pale grey: it shows faintly where light lands on it.
	room = room + localLight * inside * 0.1;
	let etch = mix(heroRgb, vec3<f32>(0.75, 0.85, 0.8), 0.4);
	room = room + etch * grid * params.post.w * sqrt(localLum * 0.2) * (0.6 + params.pulse.z * 0.3);
	room = room + mix(heroRgb, vec3<f32>(0.8), 0.5) * frame * sqrt(localLum * 0.2) * 0.5;
	// Bezel plastic: near-black, catching only the spill and the glow, a
	// little more on its upper lip that faces the screen.
	let lip = 0.7 + smoothstep(-0.6, 0.9, p.y) * 0.5;
	let bezelLit = (spill * 0.3 + wide * 0.4 + tight * 0.08) * lip;
	room = mix(room, bezelLit, bezel * 0.92);
	room = room + localLight * glass * params.display2.w * 0.08;

	// Horizon seam: the bench edge glints only where the instrument lights it.
	let seamY = params.floor.z;
	let seam = exp(-sq((p.y - seamY) / (pixel * 2.5))) * params.floor.w;
	room = room + mix(horizonRgb, heroRgb, 0.3) * seam * (dot(tight, vec3<f32>(0.3, 0.5, 0.2)) * 0.5 + spillLum * 0.8);

	// Polished floor glass: the screens reflect, blurred and fading with
	// distance below the reflection line.
	let reflectY = params.floor.x;
	let reflectUv = 0.5 - reflectY * 0.5;
	let mirrored = vec2<f32>(warped.x, 2.0 * reflectUv - warped.y);
	let floorImage = textureSampleLevel(tightTexture, linearSampler, mirrored, 0.0).rgb * 0.6 * params.display2.x
		+ textureSampleLevel(phosphorTexture, linearSampler, mirrored, 0.0).rgb * 0.14;
	let depth = max(reflectY - p.y, 0.0);
	let reflectionFade = exp(-depth * 2.4) * select(0.0, 1.0, p.y < reflectY) * params.floor.y;

	// Front glass. The room is dark, so all the glass can reflect is the room
	// lit by the screen itself: a broad soft image of the spill, brightest
	// toward the rim where Fresnel climbs and toward the top, like a ceiling
	// lit from below. The faceplate thickness also throws a faint ghost of the
	// bright strokes, displaced outward from the tube axis.
	let roomImage = spill * (0.45 + 0.55 * smoothstep(-1.0, 0.9, p.y));
	let glassReflection = roomImage * fresnel * params.tube.y * 4.0;
	let ghostUv = 0.5 + (warped - 0.5) * (1.012 + curvature * 0.06);
	let ghost = textureSampleLevel(tightTexture, linearSampler, ghostUv, 0.0).rgb * params.tube.w * params.display2.x;

	// ---- Tone map -------------------------------------------------------------
	// Light is exposed like film: 1 - exp(-k light). Overdriven phosphor runs
	// to white whatever its hue, by how hot it is, the way a real tube's
	// cores burn white inside a coloured halo.
	let light = (phosphor + tight + wide + reflection + floorImage * reflectionFade * 0.6 + ghost) * obliquity * tube;
	let exposed = vec3<f32>(1.0) - exp(-light * params.glow.w);
	let hottest = max(exposed.r, max(exposed.g, exposed.b));
	let whiten = clamp(params.output.x * hottest * hottest * hottest * hottest, 0.0, 1.0);
	var lit = mix(exposed, vec3<f32>(hottest), whiten);
	// Saturation trim around the light's own luminance.
	let luma = dot(lit, vec3<f32>(0.2126, 0.7152, 0.0722));
	lit = max(mix(vec3<f32>(luma), lit, params.output.z), vec3<f32>(0.0));
	// Raster: scanlines whose pitch and depth are the tube's character.
	let period = mix(5.0, 2.0, params.display.x);
	let scanDepth = max(params.display.y, 0.02);
	let scan = 1.0 - scanDepth * (0.5 - 0.5 * cos(TAU * in.uv.y * resolution.y / period));
	var color = lit * scan + (room * (0.55 + obliquity * 0.45) + glassReflection) * tube;
	// Outside the face: the bezel surround, lit only by the spill.
	color = color + spill * 0.05 * (1.0 - tube) * lip;
	let frameIndex = floor(params.view.z * 60.0);
	// Tube grain rides on light: shot noise shows where the phosphor glows.
	let grainLight = 0.3 + 0.7 * smoothstep(0.0, 0.2, dot(color, vec3<f32>(0.3, 0.5, 0.2)));
	let grain = (hash12(in.uv * resolution + vec2<f32>(frameIndex * 13.1, frameIndex * 7.7)) - 0.5) * params.display.w * grainLight;
	color = color + vec3<f32>(grain) * tube;
	color = color + (ign(in.uv * resolution, fract(params.view.z) * 60.0) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
