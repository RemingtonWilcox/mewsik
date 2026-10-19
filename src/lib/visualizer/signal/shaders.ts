// Signal is a phosphor instrument at night: one vector scope whose parts are
// wired together. The hero figure is a CPU-evaluated polyline (see
// figures.ts); channel traces 0 and 1 are its X and Y deflection signals with
// their write heads feeding the figure's beam head; the horizon rows are the
// figure's silhouette history, born under it and cooling from the hero
// phosphor to the horizon phosphor as they age; the beam head is the one light
// source for graticule, floor and rows. Layout, surface, camera, palette and
// display character all come from the genome as uniforms.
//
// NOTE: these are JS template literals. Never put a backtick inside a WGSL
// comment here; it terminates the string and silently breaks the shader.

import { SIGNAL_FIGURE_POINTS, SIGNAL_FIGURE_SEGMENTS } from './figures';
import { signalParamsWgsl } from './uniform-layout';

export const SIGNAL_SEGMENTS = SIGNAL_FIGURE_SEGMENTS;
export const SIGNAL_VERTEX_COUNT = SIGNAL_SEGMENTS * 6;
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
/** Scene, feedback, bloom prefilter, 4 blur passes, composite. */
export const SIGNAL_RENDER_PASSES = 8;

const PARAMS_WGSL = /* wgsl */ `
struct Params {
${signalParamsWgsl()}
};
`;

export const SIGNAL_SCENE_WGSL = /* wgsl */ `
${PARAMS_WGSL}

const TAU: f32 = 6.28318530718;
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

struct TraceOut {
	@builtin(position) position: vec4<f32>,
	@location(0) color: vec3<f32>,
	// x: along the stroke 0..1, y: across the stroke -1..1
	@location(1) local: vec2<f32>,
	@location(2) intensity: f32,
	@location(3) hot: vec3<f32>,
	// Phosphor class written to alpha: 1 long persistence (figures), lower
	// values decay faster in the feedback pass (channels, rows, rails).
	@location(4) persist: f32,
};

fn sq(x: f32) -> f32 {
	return x * x;
}

fn aspect() -> f32 {
	return params.view.x / max(params.view.y, 1.0);
}

fn toNdc(p: vec2<f32>) -> vec2<f32> {
	return vec2<f32>(p.x / aspect(), p.y);
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
};

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
	let energy = params.tone.x;
	let silence = params.tone.y;
	let stroke = params.tone.z;
	let gain = params.heroColor.w;

	let heroRgb = params.heroColor.rgb;
	let traceRgb = params.traceColor.rgb;
	let horizonRgb = params.horizonColor.rgb;
	let hotRgb = params.hotColor.rgb;
	let headU = params.head.x;
	let beat = params.pulse.y;

	var s: Stroke;
	s.hot = vec3<f32>(0.0);
	s.along = select(f0, f1, useEnd);
	s.persist = 1.0;
	if (instance < HERO_INSTANCES) {
		let which = instance;
		let raw0 = figureRaw(which, segment);
		let raw1 = figureRaw(which, segment + 1u);
		let anchor = figureAnchor(which);
		s.start = anchor.xy + raw0.xy * anchor.z;
		s.end = anchor.xy + raw1.xy * anchor.z;
		let depth = select(raw0.z, raw1.z, useEnd);
		let dwell = select(raw0.w, raw1.w, useEnd);
		let u = s.along;
		// The beam head: a comet that the channel traces are writing.
		let behind = fract(headU - u);
		let comet = exp(-behind * 7.0);
		let spot = exp(-behind * 70.0) + exp(-(1.0 - behind) * 140.0) * 0.6;
		let heroLevel = (0.62 + energy * 0.4 + params.pulse.z * 0.3) * (1.0 - silence * 0.55) * gain;
		let screen = params.figureB.w;
		if (which == 0u) {
			s.color = heroRgb;
			s.intensity = heroLevel * dwell * (0.5 + depth * 0.6) * (0.62 + comet * 0.55) * params.figureA.w;
			s.halfWidth = (0.8 + energy * 0.25 + depth * 0.4) * stroke * pixelScale;
			s.hot = mix(heroRgb, hotRgb, 0.7) * spot * (0.5 + beat * 1.5 + params.pulse.x) * params.hotColor.w;
		} else {
			// Figure B: the stereo ghost of A, or (dual bench) A seen from the side
			// on its own screen.
			let spread = clamp(params.traceColor.w * 4.0, 0.0, 1.0);
			let ghostLevel = (0.06 + spread * 0.24) * (0.45 + depth * 0.55);
			let screenLevel = (0.5 + depth * 0.6) * (0.62 + comet * 0.55);
			s.color = mix(mix(heroRgb, horizonRgb, 0.55), heroRgb, screen * 0.6);
			s.intensity = heroLevel * dwell * mix(ghostLevel, screenLevel * 0.85, screen);
			s.halfWidth = mix(0.7 + depth * 0.25, 0.8 + depth * 0.4, screen) * stroke * pixelScale;
			s.hot = mix(heroRgb, hotRgb, 0.7) * spot * (0.5 + beat * 1.5) * params.hotColor.w * screen;
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
		let level = select(select(params.band3.x, params.band2.x, k == 2u), 0.6 + energy * 0.3, k < 2u);
		let tip = smoothstep(0.985, 1.0, s.along);
		// Phosphor tail: brightest at the write head.
		let age = 1.0 - s.along;
		let tail = mix(exp(-age * 2.2) * (1.0 - smoothstep(0.8, 1.0, age)), exp(-age * 1.3), scroll);
		let wraps = select(0.0, 1.0, floor(a.u) != floor(b.u)) * (1.0 - scroll);
		// X and Y lean toward the hero phosphor: they are the figure's own signals.
		s.color = select(traceRgb, mix(traceRgb, heroRgb, 0.28), k < 2u);
		// Hierarchy: traces dim where they pass behind the figure.
		let mid = (s.start + s.end) * 0.5;
		let heroDistance = length((mid - params.figureA.xy) * vec2<f32>(0.8, 1.0)) / max(params.figureA.z, 0.05);
		let behindHero = mix(0.3, 1.0, smoothstep(0.35, 1.25, heroDistance));
		s.intensity = visibility * tail * behindHero * (1.0 - wraps)
			* (0.5 + level * 0.6 + energy * 0.2) * (1.0 - silence * 0.4) * gain
			* (1.0 + headLight(mid) * 0.6);
		s.halfWidth = (0.95 + level * 0.3) * stroke * pixelScale;
		let flare = select(level * 0.6, 0.5 + beat * 1.2, k < 2u);
		s.hot = mix(traceRgb, hotRgb, 0.5) * tip * visibility * flare * 1.6 * (1.0 - wraps);
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
		let figureHead = figureScreen(0u, headU);
		var source = vec2<f32>(0.0);
		var goal = figureHead;
		if (k < 2u) {
			source = traceHead(k);
			goal = mix(figureHead, figureScreen(1u, headU), select(0.0, params.figureB.w, k == 1u));
		} else {
			let headLocal = figureLocal(0u, headU);
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
		s.hot = hotRgb * dotGlow * visibility * (0.8 + beat * 1.6);
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
		let armLevel = 0.0;
		s.color = mix(horizonRgb, heroRgb, arm * 0.6);
		s.intensity = (railLevel + armLevel) * fade * min(a.valid, b.valid) * gain * params.surface.w
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
			* max(1.0 + light * 1.4 + radar, 0.06) * surfaceGain(rowMix);
		s.halfWidth = (0.55 + age * 0.75) * stroke * pixelScale;
		// The newest row flashes as it is written on the beat tick, and beat
		// stamps from the beam head ride the rows down the horizon.
		let fresh = 1.0 - smoothstep(0.0, 2.5 / f32(ROWS), age);
		let stamp = clamp(value.y, 0.0, 2.0);
		s.hot = (horizonRgb * fresh * params.terrain.z * 0.8 + hotRgb * stamp * (0.9 - age * 0.5))
			* fadeIn * edge * min(a.valid, b.valid) * params.surface.w;
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
// from the figure, and is max-blended with the fresh scene so trails never
// accumulate to white. Decay is tinted toward the hero phosphor so old light
// cools into the role colour the way a long-persistence phosphor does.
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
	let zoom = 1.0 - (0.0005 + params.bandsA.x * 0.0009 + params.pulse.w * 0.0008);
	let previousUv = heroUv + (in.uv - heroUv) * zoom;
	let edge = min(min(previousUv.x, previousUv.y), min(1.0 - previousUv.x, 1.0 - previousUv.y));
	let border = smoothstep(0.0, 0.02, edge);
	let previous = textureSampleLevel(previousTexture, linearSampler, previousUv, 0.0);
	let scene = textureSampleLevel(sceneTexture, linearSampler, in.uv, 0.0);
	// Per-element persistence: the class stored in alpha picks between the
	// long figure phosphor and the fast phosphor used by traces and rows.
	let fade = mix(params.post.y, params.post.x, clamp(previous.a, 0.0, 1.0));
	let persistRgb = params.heroColor.rgb;
	let tint = mix(vec3<f32>(1.0), persistRgb / max(max(persistRgb.r, persistRgb.g), max(persistRgb.b, 0.001)), 0.035);
	let trail = previous.rgb * fade * tint * border;
	let luma = vec3<f32>(0.3, 0.5, 0.2);
	let sceneWins = dot(scene.rgb, luma) >= dot(trail, luma);
	let persistClass = select(previous.a, scene.a, sceneWins);
	return vec4<f32>(max(trail, scene.rgb), persistClass);
}
`;

// Half-resolution bloom prefilter with a soft knee: only beam cores, write
// heads and stamps bloom; the room never does.
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

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var phosphorTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;

const TAU: f32 = 6.28318530718;

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

@fragment
fn fs_main(in: FullscreenOut) -> @location(0) vec4<f32> {
	let resolution = params.view.xy;
	let aspectRatio = resolution.x / max(resolution.y, 1.0);
	let centered = in.uv - 0.5;
	let r2 = dot(centered, centered);

	// Lens: tube curvature and chromatic aberration growing with r squared,
	// flaring on impacts.
	let warped = 0.5 + centered * (1.0 + r2 * params.display.z);
	// The tube face ends where curvature pushes past the glass: black, not
	// a smeared copy of the last row of pixels.
	let tubeEdge = min(min(warped.x, warped.y), min(1.0 - warped.x, 1.0 - warped.y));
	let tube = smoothstep(0.0, 0.006, tubeEdge);
	let caAmount = (0.0004 + r2 * 0.003) * params.display2.y * (1.0 + params.pulse.x * 1.6 + params.pulse.z * 0.6);
	let direction = normalize(centered + vec2<f32>(1e-4, 1e-4));
	let phosphor = vec3<f32>(
		textureSampleLevel(phosphorTexture, linearSampler, warped + direction * caAmount, 0.0).r,
		textureSampleLevel(phosphorTexture, linearSampler, warped, 0.0).g,
		textureSampleLevel(phosphorTexture, linearSampler, warped - direction * caAmount, 0.0).b
	);
	let bloom = textureSampleLevel(bloomTexture, linearSampler, warped, 0.0).rgb * params.display2.x;
	let bloomLum = dot(bloom, vec3<f32>(0.3, 0.5, 0.2));

	// Scope space: x across -aspect..aspect, y up -1..1.
	let p = vec2<f32>((warped.x - 0.5) * 2.0 * aspectRatio, (0.5 - warped.y) * 2.0);
	let pixel = 2.0 / max(resolution.y, 1.0);
	let heroRgb = params.heroColor.rgb;
	let horizonRgb = params.horizonColor.rgb;
	let hotRgb = params.hotColor.rgb;

	// Room values are display-referred (added after tone mapping) so the
	// darks stay controllable instead of being crushed by the ACES toe.
	var room = params.roomColor.rgb;

	// One light: the beam head. It lights the glass, the grid and the bench.
	let headDistance = length((p - params.head.yz) * vec2<f32>(0.85, 1.0));
	let headPool = exp(-headDistance * 2.4) * params.head.w;
	let figureGlow = exp(-length((p - params.figureA.xy) * vec2<f32>(0.7, 1.0)) / max(params.figureA.z, 0.1) * 0.9);

	let faceA = scopeFace(p, params.faceA.xy, params.faceA.zw, params.faceAStyle.x, params.faceAStyle.y, params.faceAStyle.z, params.faceBStyle.y, pixel);
	let faceB = scopeFace(p, params.faceB.xy, params.faceB.zw, params.faceBStyle.x, 1.0, 0.0, params.faceBStyle.z, pixel);
	let visA = params.faceAStyle.w;
	let visB = params.faceBStyle.w;
	let inside = max(faceA.inside * visA, faceB.inside * visB);
	let grid = max(faceA.grid * visA, faceB.grid * visB);
	let frame = max(faceA.frame * visA, faceB.frame * visB);
	let bezel = max(faceA.bezel * visA, faceB.bezel * visB);
	let glass = max(faceA.glass * visA, faceB.glass * visB);

	// Screens are a shade lighter than the bench and carry the figure's glow.
	room = room + heroRgb * inside * (0.004 + figureGlow * (0.01 + params.tone.x * 0.008));
	room = room + heroRgb * figureGlow * (1.0 - inside) * 0.004;
	let gridLight = params.post.w * (0.026 + bloomLum * 0.35 + headPool * 0.09 + params.pulse.z * 0.05);
	room = room + mix(heroRgb, vec3<f32>(0.7, 0.85, 0.8), 0.4) * grid * gridLight;
	room = room + mix(heroRgb, vec3<f32>(0.8), 0.5) * frame * (0.012 + headPool * 0.03);
	// Bezel: dark plastic with a faint top highlight and glass edge glint.
	let bezelShade = vec3<f32>(0.016, 0.017, 0.019) * (0.8 + smoothstep(-0.6, 0.9, p.y) * 0.5);
	room = mix(room, bezelShade + heroRgb * headPool * 0.01, bezel * 0.92);
	room = room + vec3<f32>(0.012, 0.014, 0.015) * glass * params.display2.w;

	// Horizon seam and haze: only benches with a floor carry them.
	let seamY = params.floor.z;
	let seam = exp(-sq((p.y - seamY) / (pixel * 2.5))) * exp(-sq(p.x - params.head.y) * 0.12) * params.floor.w;
	room = room + mix(horizonRgb, heroRgb, 0.3) * seam * (0.035 + params.bandsA.x * 0.05 + params.pulse.z * 0.08 + headPool * 0.05);
	let hazeShape = exp(-sq((p.y - seamY - 0.08) * 2.6)) * exp(-sq(p.x - params.head.y) * 0.14) * params.floor.w;
	room = room + horizonRgb * hazeShape * (0.01 + params.bandsA.x * 0.012 + params.tone.x * 0.006) * params.roomColor.w;
	// The bench itself takes a pool of light under the beam.
	room = room + heroRgb * headPool * 0.012;

	// Polished floor glass: the screens reflect, blurred and fading with
	// distance below the reflection line.
	let reflectY = params.floor.x;
	let reflectUv = 0.5 - reflectY * 0.5;
	let mirrored = vec2<f32>(warped.x, 2.0 * reflectUv - warped.y);
	let reflection = textureSampleLevel(bloomTexture, linearSampler, mirrored, 0.0).rgb * 0.7 * params.display2.x
		+ textureSampleLevel(phosphorTexture, linearSampler, mirrored, 0.0).rgb * 0.18;
	let depth = max(reflectY - p.y, 0.0);
	let reflectionFade = exp(-depth * 2.4) * select(0.0, 1.0, p.y < reflectY) * params.floor.y;

	// Glass sheen: a very faint curved reflection across the screens.
	let sheen = exp(-sq(length((p - vec2<f32>(-0.55 * aspectRatio, 0.75)) * vec2<f32>(0.6, 1.4)) - 0.55) * 60.0);
	room = room + vec3<f32>(0.01, 0.016, 0.016) * sheen * inside * params.display2.w;

	let vignetteShape = 1.0 - smoothstep(0.45, 1.25, length(centered * vec2<f32>(aspectRatio * 0.9, 1.0)) * 1.15);
	let vignette = 1.0 - params.display2.z * (1.0 - vignetteShape);
	let exposure = 0.95 + params.tone.x * 0.12;
	let emissive = (phosphor + bloom * (0.85 + params.tone.x * 0.25) + reflection * reflectionFade * 0.6) * tube;
	// Raster: scanlines whose pitch and depth are the tube's character.
	let period = mix(5.0, 2.0, params.display.x);
	let scanDepth = max(params.display.y, 0.02);
	let scan = 1.0 - scanDepth * (0.5 - 0.5 * cos(TAU * in.uv.y * resolution.y / period));
	var color = aces(emissive * exposure * scan) * (0.7 + vignette * 0.3) + room * (0.55 + vignette * 0.45);
	// Gentle gamma contrast keeps blacks deep without clipping the room.
	color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.06)) * 1.03;
	let frameIndex = floor(params.view.z * 60.0);
	let grain = (hash12(in.uv * resolution + vec2<f32>(frameIndex * 13.1, frameIndex * 7.7)) - 0.5) * params.display.w;
	color = color + vec3<f32>(grain) * (0.6 + vignette * 0.4);
	color = color + (ign(in.uv * resolution, fract(params.view.z) * 60.0) - 0.5) * (1.3 / 255.0);
	return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
}
`;
