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

/**
 * Where a bench sits inside its own room of good compositions. Every value is
 * -1..1 and continuous; the renderer roams them (motion.ts Roamer), so a bench
 * is a region of arrangements, not one fixed table. Each builder maps them
 * onto ranges that keep its composition readable.
 */
export type SignalCompose = {
	/** Where the hero sits across the bench. */
	pan: number;
	/** How high the instrument rides over the horizon. */
	lift: number;
	/** Hero and screen size. */
	size: number;
	/** How widely the channel traces are spaced. */
	spread: number;
	/** How deep and tall the horizon runs. */
	depth: number;
	/** Which side the traces reach from, and how far. */
	reach: number;
	/** Where the horizon sits, independent of the instrument above it. */
	horizon: number;
	/** How much light the horizon history holds against the hero. */
	glow: number;
};

export const SIGNAL_COMPOSE_DIMS = 8;

export const SIGNAL_COMPOSE_NEUTRAL: Readonly<SignalCompose> = {
	pan: 0,
	lift: 0,
	size: 0,
	spread: 0,
	depth: 0,
	reach: 0,
	horizon: 0,
	glow: 0
};

/** Read a roamer's -1..1 values as a composition. */
export function signalCompose(values: ArrayLike<number>, out: SignalCompose): SignalCompose {
	const at = (i: number) => {
		const v = values[i] ?? 0;
		return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
	};
	out.pan = at(0);
	out.lift = at(1);
	out.size = at(2);
	out.spread = at(3);
	out.depth = at(4);
	out.reach = at(5);
	out.horizon = at(6);
	out.glow = at(7);
	return out;
}

type Compose = Readonly<SignalCompose>;

function clampY(y: number) {
	return Math.max(-0.92, Math.min(0.93, y));
}

function bench(A: number, k: Compose): SignalLayout {
	const l = blank();
	const fx = k.pan * 0.4 * A;
	const fy = 0.2 + k.lift * 0.11;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = 0.42 * (1 + k.size * 0.28);
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0.62;
	// The traces reach in from one side or the other; spread opens or
	// closes their stack around the figure.
	const x0 = (-0.93 + Math.max(0, k.reach) * 0.42) * A;
	const x1 = (0.93 + Math.min(0, k.reach) * 0.42) * A;
	const spread = 1 + k.spread * 0.35;
	const level = (y: number) => clampY(0.3 + (y - 0.3) * spread + k.lift * 0.06);
	setTrace(l, 0, sweep(x0, x1, level(0.7), 0.075));
	setTrace(l, 1, sweep(x0, x1, level(-0.24), 0.075));
	setTrace(l, 2, sweep(x0, x1, level(0.86), 0.06));
	setTrace(l, 3, sweep(x0, x1, level(0.45), 0.06));
	l.feed = 0.85;
	l.surface = SURFACE_FLOOR;
	l.anchorX = 0;
	l.anchorY = -0.5 + k.lift * 0.08 - k.depth * 0.06 + k.horizon * 0.13;
	l.anchorFollow = 1;
	l.camHeight = 0.36 * (1 + k.depth * 0.4);
	l.span = 2.6 * (1 + k.depth * 0.2);
	l.far = 7.5 * (1 + k.depth * 0.25);
	l.rails = 1;
	l.faceAX = fx * 0.35;
	l.faceAY = 0.21 + k.lift * 0.06;
	l.faceAW = 0.94 * A - Math.abs(fx * 0.35);
	l.faceAH = 0.71;
	l.faceAVis = 1;
	l.reflectY = l.anchorY;
	l.reflect = 1;
	l.seamY = l.anchorY;
	l.seam = 1;
	return l;
}

function construction(A: number, k: Compose): SignalLayout {
	const l = blank();
	const s = 0.46 * (1 + k.size * 0.16);
	// Leave the band trace on the right at least a fifth of the screen.
	const fx = Math.min((0.36 + k.pan * 0.1) * A, 0.95 * A - s - 0.32);
	const fy = 0.3 + k.lift * 0.08;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = s;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0;
	// The Lissajous table: X deflection runs down from under the figure, Y
	// deflection runs out to the left, and the beam sits where they cross.
	const gap = 0.1 + k.spread * 0.03;
	setTrace(l, 0, { o: [fx, -0.96], t: [0, fy - s - gap + 0.96], v: [s, 0] });
	setTrace(l, 1, { o: [fx - s - gap, fy], t: [-(fx - s - gap + 0.95 * A), 0], v: [0, s] });
	setTrace(l, 2, sweep(-0.95 * A, 0.95 * A, 0.93, 0.035, 0.55));
	setTrace(l, 3, sweep(fx + s + 0.12, 0.95 * A, clampY(-0.2 + k.spread * 0.12 - k.lift * 0.05), 0.05, 0.7));
	l.feed = 1;
	l.surface = SURFACE_WATERFALL;
	// The waterfall fills the lower-left quadrant, newest row nearest the figure.
	l.anchorX = (-0.95 * A + fx - s - gap) * 0.5 + 0.08;
	l.anchorY = -0.32 + k.lift * 0.05 + k.horizon * 0.06;
	l.span = (fx - s - gap + 0.95 * A) * (0.46 + k.reach * 0.06);
	l.wfDx = -0.2 * A * (1 + k.reach * 0.6);
	l.wfDy = -0.9 * (1 + k.depth * 0.15);
	l.relief = 0.18 * (1 + k.depth * 0.3);
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

function dual(A: number, k: Compose): SignalLayout {
	const l = blank();
	const cx = (0.48 + k.spread * 0.05) * A;
	const shift = k.pan * 0.03 * A;
	const fy = 0.3 + k.lift * 0.07;
	// One screen can grow while the other shrinks: the pair is never a
	// mirror image of itself for long.
	const lean = k.reach * 0.1;
	const scale = 0.38 * (1 + k.size * 0.1);
	l.figAX = -cx + shift;
	l.figAY = fy;
	l.figAScale = scale * (1 - lean);
	l.figBX = cx + shift;
	l.figBY = fy;
	l.figBScale = scale * (1 + lean);
	l.figBScreen = 1;
	l.partner = 1;
	l.drift = 0.04;
	const below = clampY(fy - 0.66 - k.spread * 0.04);
	setTrace(l, 0, sweep(-0.93 * A, 0.93 * A, below, 0.06));
	setTrace(l, 1, sweep(-0.93 * A, 0.93 * A, clampY(below - 0.14 - k.spread * 0.06), 0.06));
	setTrace(l, 2, sweep(-0.93 * A, -0.04 * A, 0.93, 0.03, 0.6));
	setTrace(l, 3, sweep(0.04 * A, 0.93 * A, 0.93, 0.03, 0.6));
	l.feed = 0.8;
	l.surface = SURFACE_FLOOR;
	l.anchorX = 0;
	l.anchorY = -0.62 + k.lift * 0.05 - k.depth * 0.04 + k.horizon * 0.1;
	l.camHeight = 0.2 * (1 + k.depth * 0.5);
	l.far = 7.5 * (1 + k.depth * 0.2);
	l.relief = 0.22;
	l.rails = 0.7;
	const halfW = 0.91 * A - cx - Math.abs(shift);
	const halfH = 0.52 * (1 + k.size * 0.08);
	l.faceAX = -cx + shift;
	l.faceAY = fy;
	l.faceAW = halfW * (1 - lean * 0.5);
	l.faceAH = halfH * (1 - lean * 0.5);
	l.faceARadius = 0.035;
	l.faceAVis = 1;
	l.faceBX = cx + shift;
	l.faceBY = fy;
	l.faceBW = halfW * (1 + lean * 0.3);
	l.faceBH = halfH * (1 + lean * 0.3);
	l.faceBRadius = 0.035;
	l.faceBVis = 1;
	l.reflectY = l.anchorY;
	l.reflect = 0.55;
	l.seamY = l.anchorY;
	l.seam = 0.7;
	return l;
}

function monitor(A: number, k: Compose): SignalLayout {
	const l = blank();
	const mx = (-0.44 + k.pan * 0.13) * A;
	const my = 0.16 + k.lift * 0.13;
	const grow = 1 + k.size * 0.18;
	l.figAX = mx;
	l.figAY = my;
	l.figAScale = 0.34 * grow;
	l.figBX = mx;
	l.figBY = my;
	l.drift = 0.05;
	const x0 = (0.08 + k.pan * 0.1 + Math.max(0, k.reach) * 0.15) * A;
	const x1 = 0.94 * A;
	const centre = 0.21 + k.lift * 0.08;
	const step = 0.28 * (1 + k.spread * 0.25);
	for (let i = 0; i < 4; i += 1) {
		setTrace(l, i, sweep(x0, x1, clampY(centre + (1.5 - i) * step), i < 2 ? 0.07 : 0.055));
	}
	l.feed = 1;
	l.surface = SURFACE_FLOOR;
	l.anchorX = mx;
	l.anchorY = -0.44 + k.lift * 0.06 - k.depth * 0.04 + k.horizon * 0.12;
	l.anchorFollow = 1;
	l.pitch = 0.16;
	l.camHeight = 0.5 * (1 + k.depth * 0.4);
	l.span = 2.6 * (1 + k.depth * 0.15);
	l.relief = 0.26;
	l.rails = 0.8;
	l.faceAX = mx;
	l.faceAY = my;
	l.faceAW = 0.52 * grow;
	l.faceAH = 0.47 * grow;
	l.faceARadius = 0.12;
	l.faceAVis = 1;
	l.faceABezel = 1;
	l.reflectY = l.anchorY;
	l.reflect = 0.5;
	l.seamY = l.anchorY;
	l.seam = 0.5;
	return l;
}

function bank(A: number, k: Compose): SignalLayout {
	const l = blank();
	const grow = 1 + k.size * 0.18;
	// The screen keeps a margin from the frame edge on narrow displays.
	const fx = Math.min((0.6 + k.pan * 0.05) * A, 0.97 * A - 0.4 * grow);
	const fy = 0.3 + k.lift * 0.1;
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = 0.34 * grow;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0.03;
	// Four stacked strips on the left, one trace each.
	const stripH = 0.13 * (1 + k.spread * 0.12);
	const gapH = 0.05 * (1 + k.spread * 0.5);
	const top = 0.86 + k.lift * 0.04;
	const cx = (-0.34 + k.pan * 0.06) * A;
	const half = 0.56 * A * (1 + k.reach * 0.05);
	for (let i = 0; i < 4; i += 1) {
		const y = top - stripH - i * (stripH * 2 + gapH);
		setTrace(l, i, sweep(cx - half * 0.96, cx + half * 0.96, y, 0.085 * (1 + k.spread * 0.12)));
	}
	l.feed = 1;
	l.surface = SURFACE_FLOOR;
	l.anchorX = fx;
	l.anchorY = -0.5 + k.lift * 0.05 - k.depth * 0.04 + k.horizon * 0.12;
	l.anchorFollow = 1;
	l.camHeight = 0.26 * (1 + k.depth * 0.5);
	l.far = 7.5 * (1 + k.depth * 0.2);
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
	l.faceBW = 0.4 * grow;
	l.faceBH = 0.4 * grow;
	l.faceBRadius = 0.03;
	l.faceBVis = 1;
	l.reflectY = l.anchorY;
	l.reflect = 0.6;
	l.seamY = l.anchorY;
	l.seam = 0.6;
	return l;
}

function tunnel(A: number, k: Compose): SignalLayout {
	const l = blank();
	const vx = (0.3 + k.pan * 0.28) * A;
	const vy = 0.12 + k.lift * 0.14;
	l.figAX = vx;
	l.figAY = vy;
	l.figAScale = 0.34 * (1 + k.size * 0.26);
	l.figBX = vx;
	l.figBY = vy;
	l.drift = 0.08;
	const edge = 0.86 - k.spread * 0.06;
	const inner = 0.72 - k.spread * 0.1;
	const reach = (-0.2 + k.reach * 0.18) * A;
	setTrace(l, 0, sweep(-0.93 * A, 0.93 * A, edge, 0.05));
	setTrace(l, 1, sweep(-0.93 * A, 0.93 * A, -edge, 0.05));
	setTrace(l, 2, sweep(-0.93 * A, reach, inner, 0.035, 0.6));
	setTrace(l, 3, sweep(-0.93 * A, reach, -inner, 0.035, 0.6));
	l.feed = 0.9;
	l.surface = SURFACE_TUNNEL;
	l.anchorX = vx;
	l.anchorY = vy;
	l.anchorFollow = 1;
	l.near = 0.5;
	l.far = 9 * (1 + k.depth * 0.2);
	l.ringInner = 1.05 * (1 + k.spread * 0.3);
	l.camHeight = 0.45 * (1 + k.depth * 0.45);
	l.focal = 0.95 * (1 + k.reach * 0.1);
	l.relief = 0.32;
	l.rails = 0.5;
	l.freedom = 0.45;
	return l;
}

function ring(A: number, k: Compose): SignalLayout {
	const l = blank();
	const fx = (0.16 + k.pan * 0.2) * A;
	const fy = 0.3 + k.lift * 0.08;
	const s = 0.36 * (1 + k.size * 0.22);
	l.figAX = fx;
	l.figAY = fy;
	l.figAScale = s;
	l.figBX = fx;
	l.figBY = fy;
	l.drift = 0.1;
	// X runs along the top edge, Y climbs the left edge, bands on the right.
	const right = (0.88 - Math.max(0, -k.reach) * 0.06) * A;
	setTrace(l, 0, sweep((-0.6 + k.reach * 0.2) * A, 0.93 * A, 0.88, 0.05));
	setTrace(l, 1, { o: [-0.88 * A, -0.82], t: [0, 1.62], v: [0.07, 0] });
	setTrace(l, 2, { o: [right, -0.82], t: [0, 1.4], v: [0.05, 0], vis: 0.8 });
	setTrace(l, 3, { o: [right - (0.1 + k.spread * 0.04) * A, -0.82], t: [0, 1.4], v: [0.05, 0], vis: 0.8 });
	l.feed = 0.9;
	l.surface = SURFACE_RING;
	l.anchorX = fx;
	l.anchorY = fy - s - 0.12 + k.horizon * 0.1;
	l.anchorFollow = 1;
	l.camHeight = 0.9 * (1 + k.depth * 0.35);
	l.pitch = 0.5 + k.lift * 0.12;
	l.ringInner = 0.32;
	l.ringOuter = 2.6 * (1 + k.reach * 0.25);
	l.ringZ = 3.7 * (1 + k.spread * 0.2);
	l.relief = 0.34;
	l.rails = 0.4;
	l.freedom = 0.6;
	return l;
}

function radar(A: number, k: Compose): SignalLayout {
	const l = blank();
	const rx = (0.44 + k.pan * 0.07) * A;
	const r = 0.84 * (1 + Math.min(0, k.size) * 0.1);
	const ry = k.lift * 0.05;
	l.figAX = rx;
	l.figAY = ry;
	l.figAScale = 0.2 * (1 + k.size * 0.2);
	l.figBX = rx;
	l.figBY = ry;
	l.drift = 0;
	const x0 = -0.94 * A;
	const x1 = rx - r - 0.1;
	const centre = 0.05 + k.lift * 0.06;
	const step = 0.34 * (1 + k.spread * 0.22);
	for (let i = 0; i < 4; i += 1) {
		setTrace(l, i, sweep(x0, x1, clampY(centre + (1.5 - i) * step), i < 2 ? 0.07 : 0.055));
	}
	l.feed = 1;
	l.surface = SURFACE_RING;
	l.anchorX = rx;
	l.anchorY = ry;
	l.camHeight = 2.4;
	l.pitch = Math.PI * 0.5;
	l.ringInner = 0.3;
	l.ringOuter = 1.85 * (r / 0.84);
	l.ringZ = 0;
	l.relief = 0.22 * (1 + k.depth * 0.3);
	l.rails = 0;
	l.radarArm = 1;
	l.faceAX = rx;
	l.faceAY = ry;
	l.faceAW = r;
	l.faceAH = r;
	l.faceARadius = r;
	l.faceAVis = 1;
	l.faceABezel = 0.7;
	l.freedom = 0.1;
	return l;
}

const BUILDERS = [bench, construction, dual, monitor, bank, tunnel, ring, radar];

// ---- Horizons ---------------------------------------------------------------
// A bench is an arrangement of instruments plus the horizon its history is
// written on. The two are composed, not authored as one table: each
// arrangement keeps its own horizon as variant 0 and can stand over up to
// four others, placed relative to its hero: up to 40 benches, each a room the
// roam travels. A ring puddle only ever lies under the ring bench (under any
// hero it reads as the same picture), and the radar has only its own.

type HorizonKind = 'floor' | 'canyon' | 'waterfall' | 'cascade';

/** Clear every horizon key back to a blank bench's. */
function clearHorizon(l: SignalLayout) {
	const b = blank();
	for (const key of [
		'surface', 'anchorX', 'anchorY', 'anchorFollow', 'span', 'near', 'far', 'camHeight', 'pitch', 'yaw', 'focal',
		'ringInner', 'ringOuter', 'ringZ', 'relief', 'terrainVis', 'wfDx', 'wfDy', 'rails', 'radarArm',
		'reflectY', 'reflect', 'seamY', 'seam', 'freedom'
	] as const) {
		l[key] = b[key];
	}
}

/** Put a horizon of `kind` under (or around) the arrangement's hero. */
function standOn(l: SignalLayout, kind: HorizonKind, A: number, k: Compose): SignalLayout {
	// Two screens share one horizon, centred between them.
	const hx = l.partner > 0.5 ? (l.figAX + l.figBX) * 0.5 : l.figAX;
	const hy = l.figAY;
	const s = l.figAScale;
	const vis = l.terrainVis;
	clearHorizon(l);
	l.terrainVis = vis;
	switch (kind) {
		case 'floor': {
			l.surface = SURFACE_FLOOR;
			l.anchorX = hx * 0.6;
			l.anchorY = Math.max(-0.78, Math.min(-0.38, hy - s - 0.22 + k.horizon * 0.1));
			l.anchorFollow = 1;
			l.camHeight = 0.36 * (1 + k.depth * 0.4);
			l.span = 2.6 * (1 + k.depth * 0.2);
			l.far = 7.5 * (1 + k.depth * 0.25);
			l.relief = 0.28;
			l.rails = 0.8;
			l.reflectY = l.anchorY;
			l.reflect = 0.6;
			l.seamY = l.anchorY;
			l.seam = 0.6;
			break;
		}
		case 'canyon': {
			l.surface = SURFACE_TUNNEL;
			l.anchorX = hx;
			l.anchorY = hy;
			l.anchorFollow = 1;
			l.near = 0.5;
			l.far = 9 * (1 + k.depth * 0.2);
			l.ringInner = 1.05 * (1 + k.spread * 0.3);
			l.camHeight = 0.45 * (1 + k.depth * 0.45);
			l.focal = 0.95 * (1 + k.reach * 0.1);
			l.relief = 0.3;
			l.rails = 0.5;
			l.freedom = 0.45;
			break;
		}
		case 'waterfall': {
			// Rows stack down the open side, away from the hero; a hero near
			// the middle lets them fall straight down beneath it. Continuous in
			// the hero's place, so a roaming hero carries its waterfall across.
			const side = -Math.tanh(hx / (0.12 * A));
			l.surface = SURFACE_WATERFALL;
			l.anchorX = side * 0.5 * A;
			l.anchorY = -0.3 + k.horizon * 0.06;
			l.span = 0.36 * A * (1 + k.reach * 0.1);
			l.wfDx = side * 0.2 * A * (1 + k.reach * 0.5);
			l.wfDy = -0.75 * (1 + k.depth * 0.15);
			l.relief = 0.18 * (1 + k.depth * 0.3);
			l.rails = 0.35;
			l.freedom = 0.3;
			break;
		}
		case 'cascade': {
			// The history hangs above the bench like a rack-mounted spectrum
			// display: rows rise from a band over the hero and recede upward.
			l.surface = SURFACE_WATERFALL;
			l.anchorX = hx * 0.35 - k.reach * 0.25 * A;
			l.anchorY = Math.max(0.44, Math.min(0.6, hy + s + 0.1)) + k.horizon * 0.06;
			l.span = 0.45 * A * (1 + k.spread * 0.25);
			l.wfDx = -hx * 0.18 * (1 + k.reach * 0.5);
			l.wfDy = 0.24 * (1 + k.depth * 0.2);
			l.relief = 0.14 * (1 + k.depth * 0.3);
			l.rails = 0.25;
			l.freedom = 0.3;
			break;
		}
	}
	return l;
}

/** The horizons each arrangement may stand on besides its own (variants 1..3). */
const ALTERNATE_HORIZONS: readonly (readonly HorizonKind[])[] = [
	['canyon', 'waterfall', 'cascade'], // bench
	['floor', 'canyon', 'cascade'], // construction
	['canyon', 'waterfall', 'cascade'], // dual
	['canyon', 'waterfall', 'cascade'], // monitor
	['canyon', 'waterfall', 'cascade'], // bank
	['floor', 'waterfall', 'cascade'], // tunnel
	['floor', 'canyon', 'waterfall', 'cascade'], // ring
	[] // radar: its rings are its face
];

/** The guest horizon of a bench index, or null for its own (or one it lacks). */
function guestKind(index: number): HorizonKind | null {
	const variant = signalHorizonVariant(index);
	return variant === 0 ? null : (ALTERNATE_HORIZONS[signalArrangement(index)][variant - 1] ?? null);
}

/** Horizon variants per arrangement (0 = its own). */
export const SIGNAL_HORIZON_VARIANTS = 5;
/** Every bench the genome can pick: arrangement + 8 x horizon variant. */
export const SIGNAL_BENCH_COUNT = SIGNAL_LAYOUT_NAMES.length * SIGNAL_HORIZON_VARIANTS;

/** Arrangement (0..7) of a bench index. */
export function signalArrangement(index: number): number {
	const n = SIGNAL_LAYOUT_NAMES.length;
	return ((Math.floor(index) % n) + n) % n;
}

/** Horizon variant (0 = the arrangement's own) of a bench index. */
export function signalHorizonVariant(index: number): number {
	const v = Math.floor(Math.floor(index) / SIGNAL_LAYOUT_NAMES.length) % SIGNAL_HORIZON_VARIANTS;
	return v < 0 ? v + SIGNAL_HORIZON_VARIANTS : v;
}

/**
 * How often a bench is picked relative to its arrangement standing on its own
 * horizon (1). A canyon fills the frame the same way whatever stands in it,
 * so it is the rarest guest.
 */
const GUEST_WEIGHT: Record<HorizonKind, number> = { floor: 0.7, waterfall: 0.6, canyon: 0.08, cascade: 0.35 };

export function signalBenchWeight(index: number): number {
	if (signalHorizonVariant(index) === 0) return 1;
	const kind = guestKind(index);
	return kind ? GUEST_WEIGHT[kind] : 0;
}

/** Display name: "bench" or "bench on ring". */
export function signalBenchName(index: number): string {
	const name = SIGNAL_LAYOUT_NAMES[signalArrangement(index)];
	const kind = guestKind(index);
	return kind ? `${name} on ${kind}` : name;
}

/**
 * One bench at one point of its composition room. `compose` defaults to the
 * bench's centre (the authored arrangement). Indices 0..7 are the authored
 * benches; 8..39 stand the same arrangements on other horizons.
 */
export function buildSignalLayout(
	index: number,
	aspect: number,
	compose: Compose = SIGNAL_COMPOSE_NEUTRAL
): SignalLayout {
	const A = Math.max(0.6, aspect);
	const arrangement = signalArrangement(index);
	const layout = BUILDERS[arrangement](A, compose);
	const kind = guestKind(index);
	if (kind) standOn(layout, kind, A, compose);
	// Some arrangements let the hero carry the frame, others the history.
	layout.terrainVis *= 0.72 + compose.glow * 0.28;
	return layout;
}
/**
 * Blend a bench toward its mirror image by `amount` (0 as built, 1 mirrored).
 * Pieces slide across to their mirrored places; a sweep keeps its direction
 * and length, so nothing collapses to zero width on the way.
 */
export function mirrorSignalLayout(layout: SignalLayout, amount: number): SignalLayout {
	const t = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
	if (t <= 0) return layout;
	for (const key of ['figAX', 'figBX', 'anchorX', 'faceAX', 'faceBX', 'wfDx'] as const) {
		layout[key] -= 2 * layout[key] * t;
	}
	for (let k = 0; k < 4; k += 1) {
		const ox = `t${k}ox` as SignalLayoutKey;
		const tx = `t${k}tx` as SignalLayoutKey;
		// Mirrored span: -(ox + tx) .. -ox, same direction of travel.
		layout[ox] += (-(layout[ox] + layout[tx]) - layout[ox]) * t;
	}
	return layout;
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
