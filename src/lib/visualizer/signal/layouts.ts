// Instrument layouts, camera regimes and display characters. A layout is a
// flat table of numbers in scope space (x across -aspect..aspect, y up -1..1)
// so two layouts crossfade by plain interpolation; only the horizon surface
// type is categorical and the shader blends the two surfaces it is given.
//
// Every layout keeps the same instrument: figure A is drawn by channel traces
// 0 (X deflection) and 1 (Y deflection); traces 2 and 3 carry bands on the
// same time base; the horizon is born under (or around) the figure.

export const SIGNAL_LAYOUT_NAMES = [
	'bench',
	'construction',
	'dual',
	'monitor',
	'bank',
	'tunnel',
	'ring',
	'radar'
] as const;

export const SIGNAL_CAMERA_NAMES = ['straight', 'bench', 'low', 'overhead', 'dolly'] as const;

export const SIGNAL_DISPLAY_NAMES = [
	'lab scope',
	'raster crt',
	'long persistence',
	'worn tube',
	'vector monitor',
	'broadcast'
] as const;

/** Horizon surfaces understood by the scene shader. */
export const SURFACE_FLOOR = 0;
export const SURFACE_RING = 1;
export const SURFACE_WATERFALL = 2;
export const SURFACE_TUNNEL = 3;

const TRACE_KEYS = ['ox', 'oy', 'tx', 'ty', 'vx', 'vy', 'scroll', 'vis'] as const;

const LAYOUT_KEYS = [
	'figAX', 'figAY', 'figAScale',
	'figBX', 'figBY', 'figBScale', 'figBScreen', 'partner', 'drift',
	...[0, 1, 2, 3].flatMap((k) => TRACE_KEYS.map((key) => `t${k}${key}`)),
	'feed',
	'surface', 'anchorX', 'anchorY', 'anchorFollow', 'span', 'near', 'far', 'camHeight', 'pitch', 'yaw', 'focal',
	'ringInner', 'ringOuter', 'ringZ', 'relief', 'terrainVis', 'wfDx', 'wfDy', 'rails', 'radarArm',
	'faceAX', 'faceAY', 'faceAW', 'faceAH', 'faceARadius', 'faceARepeat', 'faceAGap', 'faceAVis', 'faceABezel',
	'faceBX', 'faceBY', 'faceBW', 'faceBH', 'faceBRadius', 'faceBVis', 'faceBBezel',
	'reflectY', 'reflect', 'seamY', 'seam', 'freedom'
] as const;

export type SignalLayoutKey = (typeof LAYOUT_KEYS)[number];
export type SignalLayout = Record<SignalLayoutKey, number>;

function blank(): SignalLayout {
	const out = {} as SignalLayout;
	for (const key of LAYOUT_KEYS) out[key] = 0;
	out.focal = 1.05;
	out.near = 0.6;
	out.far = 7.5;
	out.span = 2.6;
	out.camHeight = 0.36;
	out.relief = 0.3;
	out.terrainVis = 1;
	out.faceARepeat = 1;
	out.freedom = 1;
	out.figBScale = 0.4;
	return out;
}

type Trace = { o: [number, number]; t: [number, number]; v: [number, number]; scroll?: number; vis?: number };

function setTrace(layout: SignalLayout, k: number, trace: Trace) {
	const key = (name: (typeof TRACE_KEYS)[number]) => `t${k}${name}` as SignalLayoutKey;
	layout[key('ox')] = trace.o[0];
	layout[key('oy')] = trace.o[1];
	layout[key('tx')] = trace.t[0];
	layout[key('ty')] = trace.t[1];
	layout[key('vx')] = trace.v[0];
	layout[key('vy')] = trace.v[1];
	layout[key('scroll')] = trace.scroll ?? 0;
	layout[key('vis')] = trace.vis ?? 1;
}

/** A horizontal sweep trace from x0 to x1 at height y. */
function sweep(x0: number, x1: number, y: number, amplitude: number, vis = 1): Trace {
	return { o: [x0, y], t: [x1 - x0, 0], v: [0, amplitude], vis };
}

function bench(A: number): SignalLayout {
	const l = blank();
	l.figAX = 0;
	l.figAY = 0.2;
	l.figAScale = 0.42;
	l.figBX = 0;
	l.figBY = 0.2;
	l.drift = 0.62;
	setTrace(l, 0, sweep(-0.93 * A, 0.93 * A, 0.7, 0.075));
	setTrace(l, 1, sweep(-0.93 * A, 0.93 * A, -0.24, 0.075));
	setTrace(l, 2, sweep(-0.93 * A, 0.93 * A, 0.86, 0.06));
	setTrace(l, 3, sweep(-0.93 * A, 0.93 * A, 0.45, 0.06));
	l.feed = 0.85;
	l.surface = SURFACE_FLOOR;
	l.anchorX = 0;
	l.anchorY = -0.5;
	l.anchorFollow = 1;
	l.rails = 1;
	l.faceAX = 0;
	l.faceAY = 0.21;
	l.faceAW = 0.94 * A;
	l.faceAH = 0.71;
	l.faceAVis = 1;
	l.reflectY = -0.5;
	l.reflect = 1;
	l.seamY = -0.5;
	l.seam = 1;
	return l;
}

function construction(A: number): SignalLayout {
	const l = blank();
	const fx = 0.36 * A;
	const fy = 0.3;
	const s = 0.46;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = s;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0;
	// The Lissajous table: X deflection runs down from under the figure, Y
	// deflection runs out to the left, and the beam sits where they cross.
	const gap = 0.1;
	setTrace(l, 0, { o: [fx, -0.96], t: [0, fy - s - gap + 0.96], v: [s, 0] });
	setTrace(l, 1, { o: [fx - s - gap, fy], t: [-(fx - s - gap + 0.95 * A), 0], v: [0, s] });
	setTrace(l, 2, sweep(-0.95 * A, 0.95 * A, 0.92, 0.035, 0.55));
	setTrace(l, 3, sweep(fx + s + 0.12, 0.95 * A, -0.2, 0.05, 0.7));
	l.feed = 1;
	l.surface = SURFACE_WATERFALL;
	// The waterfall fills the lower-left quadrant, newest row nearest the figure.
	l.anchorX = (-0.95 * A + fx - s - gap) * 0.5 + 0.08;
	l.anchorY = -0.32;
	l.span = (fx - s - gap + 0.95 * A) * 0.46;
	l.wfDx = -0.2 * A;
	l.wfDy = -0.9;
	l.relief = 0.18;
	l.rails = 0.35;
	l.faceAX = fx;
	l.faceAY = fy;
	l.faceAW = s + 0.06;
	l.faceAH = s + 0.06;
	l.faceARadius = 0.03;
	l.faceAVis = 1;
	l.freedom = 0.3;
	return l;
}

function dual(A: number): SignalLayout {
	const l = blank();
	const cx = 0.48 * A;
	l.figAX = -cx;
	l.figAY = 0.3;
	l.figAScale = 0.38;
	l.figBX = cx;
	l.figBY = 0.3;
	l.figBScale = 0.38;
	l.figBScreen = 1;
	l.partner = 1;
	l.drift = 0.04;
	setTrace(l, 0, sweep(-0.93 * A, 0.93 * A, -0.36, 0.06));
	setTrace(l, 1, sweep(-0.93 * A, 0.93 * A, -0.5, 0.06));
	setTrace(l, 2, sweep(-0.93 * A, -0.04 * A, 0.93, 0.03, 0.6));
	setTrace(l, 3, sweep(0.04 * A, 0.93 * A, 0.93, 0.03, 0.6));
	l.feed = 0.8;
	l.surface = SURFACE_FLOOR;
	l.anchorX = 0;
	l.anchorY = -0.62;
	l.camHeight = 0.2;
	l.relief = 0.22;
	l.rails = 0.7;
	l.faceAX = -cx;
	l.faceAY = 0.3;
	l.faceAW = 0.43 * A;
	l.faceAH = 0.52;
	l.faceARadius = 0.035;
	l.faceAVis = 1;
	l.faceBX = cx;
	l.faceBY = 0.3;
	l.faceBW = 0.43 * A;
	l.faceBH = 0.52;
	l.faceBRadius = 0.035;
	l.faceBVis = 1;
	l.reflectY = -0.62;
	l.reflect = 0.55;
	l.seamY = -0.62;
	l.seam = 0.7;
	return l;
}

function monitor(A: number): SignalLayout {
	const l = blank();
	const mx = -0.44 * A;
	const my = 0.16;
	l.figAX = mx;
	l.figAY = my;
	l.figAScale = 0.34;
	l.figBX = mx;
	l.figBY = my;
	l.drift = 0.05;
	const x0 = 0.08 * A;
	const x1 = 0.94 * A;
	setTrace(l, 0, sweep(x0, x1, 0.62, 0.07));
	setTrace(l, 1, sweep(x0, x1, 0.34, 0.07));
	setTrace(l, 2, sweep(x0, x1, 0.06, 0.055));
	setTrace(l, 3, sweep(x0, x1, -0.2, 0.055));
	l.feed = 1;
	l.surface = SURFACE_FLOOR;
	l.anchorX = mx;
	l.anchorY = -0.44;
	l.anchorFollow = 1;
	l.pitch = 0.16;
	l.camHeight = 0.5;
	l.relief = 0.26;
	l.rails = 0.8;
	l.faceAX = mx;
	l.faceAY = my;
	l.faceAW = 0.52;
	l.faceAH = 0.47;
	l.faceARadius = 0.12;
	l.faceAVis = 1;
	l.faceABezel = 1;
	l.reflectY = -0.44;
	l.reflect = 0.5;
	l.seamY = -0.44;
	l.seam = 0.5;
	return l;
}

function bank(A: number): SignalLayout {
	const l = blank();
	const fx = 0.6 * A;
	const fy = 0.3;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = 0.34;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0.03;
	// Four stacked strips on the left, one trace each.
	const stripH = 0.13;
	const gapH = 0.05;
	const top = 0.86;
	const cx = -0.34 * A;
	const half = 0.56 * A;
	for (let k = 0; k < 4; k += 1) {
		const y = top - stripH - k * (stripH * 2 + gapH);
		setTrace(l, k, sweep(cx - half * 0.96, cx + half * 0.96, y, 0.085));
	}
	l.feed = 1;
	l.surface = SURFACE_FLOOR;
	l.anchorX = fx;
	l.anchorY = -0.5;
	l.anchorFollow = 1;
	l.camHeight = 0.26;
	l.relief = 0.22;
	l.rails = 0.6;
	l.faceAX = cx;
	l.faceAY = top - (4 * stripH * 2 + 3 * gapH) * 0.5;
	l.faceAW = half;
	l.faceAH = stripH;
	l.faceARepeat = 4;
	l.faceAGap = gapH;
	l.faceARadius = 0.02;
	l.faceAVis = 1;
	l.faceBX = fx;
	l.faceBY = fy;
	l.faceBW = 0.4;
	l.faceBH = 0.4;
	l.faceBRadius = 0.03;
	l.faceBVis = 1;
	l.reflectY = -0.5;
	l.reflect = 0.6;
	l.seamY = -0.5;
	l.seam = 0.6;
	return l;
}

function tunnel(A: number): SignalLayout {
	const l = blank();
	const vx = 0.3 * A;
	const vy = 0.12;
	l.figAX = vx;
	l.figAY = vy;
	l.figAScale = 0.34;
	l.figBX = vx;
	l.figBY = vy;
	l.drift = 0.08;
	setTrace(l, 0, sweep(-0.93 * A, 0.93 * A, 0.86, 0.05));
	setTrace(l, 1, sweep(-0.93 * A, 0.93 * A, -0.86, 0.05));
	setTrace(l, 2, sweep(-0.93 * A, -0.2 * A, 0.72, 0.035, 0.6));
	setTrace(l, 3, sweep(-0.93 * A, -0.2 * A, -0.72, 0.035, 0.6));
	l.feed = 0.9;
	l.surface = SURFACE_TUNNEL;
	l.anchorX = vx;
	l.anchorY = vy;
	l.anchorFollow = 1;
	l.near = 0.5;
	l.far = 9;
	l.ringInner = 1.05;
	l.camHeight = 0.45;
	l.focal = 0.95;
	l.relief = 0.32;
	l.rails = 0.5;
	l.freedom = 0.45;
	return l;
}

function ring(A: number): SignalLayout {
	const l = blank();
	const fx = 0.16 * A;
	const fy = 0.3;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = 0.36;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0.1;
	// X runs along the top edge, Y climbs the left edge, bands on the right.
	setTrace(l, 0, sweep(-0.6 * A, 0.93 * A, 0.88, 0.05));
	setTrace(l, 1, { o: [-0.88 * A, -0.82], t: [0, 1.62], v: [0.07, 0] });
	setTrace(l, 2, { o: [0.88 * A, -0.82], t: [0, 1.4], v: [0.05, 0], vis: 0.8 });
	setTrace(l, 3, { o: [0.78 * A, -0.82], t: [0, 1.4], v: [0.05, 0], vis: 0.8 });
	l.feed = 0.9;
	l.surface = SURFACE_RING;
	l.anchorX = fx;
	l.anchorY = fy - 0.36 - 0.12;
	l.anchorFollow = 1;
	l.camHeight = 0.9;
	l.pitch = 0.5;
	l.ringInner = 0.32;
	l.ringOuter = 2.6;
	l.ringZ = 3.7;
	l.relief = 0.34;
	l.rails = 0.4;
	l.freedom = 0.6;
	return l;
}

function radar(A: number): SignalLayout {
	const l = blank();
	const rx = 0.44 * A;
	const r = 0.84;
	l.figAX = rx;
	l.figAY = 0;
	l.figAScale = 0.2;
	l.figBX = rx;
	l.figBY = 0;
	l.drift = 0;
	const x0 = -0.94 * A;
	const x1 = rx - r - 0.1;
	setTrace(l, 0, sweep(x0, x1, 0.56, 0.07));
	setTrace(l, 1, sweep(x0, x1, 0.22, 0.07));
	setTrace(l, 2, sweep(x0, x1, -0.12, 0.055));
	setTrace(l, 3, sweep(x0, x1, -0.46, 0.055));
	l.feed = 1;
	l.surface = SURFACE_RING;
	l.anchorX = rx;
	l.anchorY = 0;
	l.camHeight = 2.4;
	l.pitch = Math.PI * 0.5;
	l.ringInner = 0.3;
	l.ringOuter = 1.85;
	l.ringZ = 0;
	l.relief = 0.22;
	l.rails = 0;
	l.radarArm = 1;
	l.faceAX = rx;
	l.faceAY = 0;
	l.faceAW = r;
	l.faceAH = r;
	l.faceARadius = r;
	l.faceAVis = 1;
	l.faceABezel = 0.7;
	l.freedom = 0.1;
	return l;
}

const BUILDERS = [bench, construction, dual, monitor, bank, tunnel, ring, radar];

export function buildSignalLayout(index: number, aspect: number): SignalLayout {
	const builder = BUILDERS[((index % BUILDERS.length) + BUILDERS.length) % BUILDERS.length];
	return builder(Math.max(0.6, aspect));
}

export function lerpSignalLayout(a: SignalLayout, b: SignalLayout, t: number, out: SignalLayout): SignalLayout {
	for (const key of LAYOUT_KEYS) out[key] = a[key] + (b[key] - a[key]) * t;
	return out;
}

export function createSignalLayout(): SignalLayout {
	return blank();
}

export type SignalCameraPreset = {
	pitch: number;
	height: number;
	focal: number;
	sway: number;
	dolly: number;
};

export const SIGNAL_CAMERAS: readonly SignalCameraPreset[] = [
	{ pitch: 0, height: 1, focal: 1, sway: 0, dolly: 0 },
	{ pitch: 0.2, height: 1.75, focal: 1, sway: 0, dolly: 0 },
	{ pitch: -0.03, height: 0.5, focal: 1.12, sway: 0, dolly: 0 },
	{ pitch: 0.6, height: 2.6, focal: 0.92, sway: 0, dolly: 0 },
	{ pitch: 0.1, height: 1.25, focal: 1, sway: 0.2, dolly: 1 }
];

export type SignalDisplayPreset = {
	/** 0 sparse .. 1 dense raster lines. */
	scanDensity: number;
	scanStrength: number;
	curvature: number;
	grain: number;
	bloom: number;
	aberration: number;
	vignette: number;
	/** Added to the per-frame phosphor persistence. */
	persist: number;
	stroke: number;
	glass: number;
	haze: number;
};

export const SIGNAL_DISPLAYS: readonly SignalDisplayPreset[] = [
	{ scanDensity: 0, scanStrength: 0.02, curvature: 0.03, grain: 0.008, bloom: 0.9, aberration: 1, vignette: 0.3, persist: 0, stroke: 1, glass: 0.3, haze: 1 },
	{ scanDensity: 1, scanStrength: 0.24, curvature: 0.1, grain: 0.012, bloom: 1, aberration: 1.3, vignette: 0.45, persist: 0.01, stroke: 1.06, glass: 0.6, haze: 1 },
	{ scanDensity: 0, scanStrength: 0.03, curvature: 0.05, grain: 0.01, bloom: 1.12, aberration: 0.8, vignette: 0.4, persist: 0.035, stroke: 1, glass: 0.4, haze: 1.3 },
	{ scanDensity: 0.6, scanStrength: 0.14, curvature: 0.15, grain: 0.028, bloom: 0.95, aberration: 1.9, vignette: 0.62, persist: 0.015, stroke: 1.12, glass: 0.8, haze: 1.4 },
	{ scanDensity: 0, scanStrength: 0, curvature: 0.02, grain: 0.006, bloom: 1.08, aberration: 0.7, vignette: 0.34, persist: -0.012, stroke: 0.8, glass: 0.2, haze: 0.7 },
	{ scanDensity: 0.35, scanStrength: 0.3, curvature: 0.07, grain: 0.015, bloom: 1, aberration: 1.1, vignette: 0.5, persist: 0.005, stroke: 1, glass: 0.5, haze: 1 }
];

export function lerpPreset<T extends Record<string, number>>(a: T, b: T, t: number): T {
	const out = {} as Record<string, number>;
	for (const key of Object.keys(a)) out[key] = a[key] + (b[key] - a[key]) * t;
	return out as T;
}
