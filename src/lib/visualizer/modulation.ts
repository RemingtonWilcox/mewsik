// Modulation matrix: the music drives many small parts of a picture
// independently, the way each cubie of a Rubik's cube turns on its own while
// the whole cube stays one object.
//
// An engine declares its parts and their parameters (a ring's width, a
// pane's glow, a strand's twist, the camera's restlessness...). Each
// parameter listens to a small blend of musical sources (ensemble channels
// such as the hats, the chord's minor-ness, the swing, a fill), each through
// its own response: gain, polarity, attack and release, a shaping curve.
// The routing itself is part of the look: it wanders, and now and then a
// route crossfades to a different source, so which part answers which
// instrument keeps changing without ever cutting.
//
// Sources are read through a plain Float32Array of channel values (0..1,
// or signed -1..1 where a source declares it) that the engine fills each
// tick, so this module does not depend on how the channels are computed.
//
// Determinism: given the same seed, sources and update() calls, the same
// outputs. State is plain data (see snapshot/restore) for resume on re-entry.

import { noise1 } from '$lib/visualizer/motion';

export type ModSource = {
	name: string;
	/** Signed sources are -1..1 (e.g. a pan); others 0..1. */
	signed?: boolean;
	/** Impulses (hits, chord changes) suit fast attack routes. */
	impulse?: boolean;
	/** Musical family, so a part can prefer e.g. 'drums' or 'harmony'. */
	family?: string;
};

export type ModParam = {
	name: string;
	/** Preferred source families, most preferred first (soft bias, not a rule). */
	prefers?: readonly string[];
	/** Sources this parameter must never listen to. */
	avoid?: readonly string[];
	/**
	 * Allow-list: only sources of these families (or with these exact names)
	 * may drive this parameter. Use for bindings with intent (a comb row that
	 * only ever answers percussion). Overrides `prefers` for eligibility.
	 */
	only?: readonly string[];
	/** Resting value 0..1 the parameter returns to when its sources are quiet. */
	rest?: number;
	/** How far the music may move it from rest, 0..1. */
	depth?: number;
	/**
	 * Shortest response time, seconds. Parts that must never snap (a
	 * camera distance, a whole-figure scale) set this; hits then swell
	 * instead of jumping. Default 0 (impulse routes may snap).
	 */
	smooth?: number;
};

export type ModPart = { name: string; params: readonly ModParam[] };

type Route = {
	/** Current and next source index; crossfading by `mix`. */
	from: number;
	to: number;
	mix: number;
	/** Seconds until this route considers a new source. */
	hold: number;
	/** Response, wandering slowly. */
	attack: number;
	release: number;
	invert: boolean;
	envelope: number;
};

type ParamState = {
	param: ModParam;
	routes: [Route, Route];
	/** Blend between the two routes, wandering. */
	blendT: number;
	value: number;
};

export type ModMatrixOptions = {
	/** Mean seconds a route keeps its source before it may re-route. */
	meanHold?: number;
	/** Seconds a re-route takes to crossfade. */
	crossfade?: number;
};

function seedWord(seed: number | string): number {
	if (typeof seed === 'number') return Math.floor((seed - Math.floor(seed)) * 0xffffffff) >>> 0;
	let h = 0x811c9dc5;
	for (const char of seed) {
		h ^= char.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

function hash(a: number, b: number, c: number, d: number): number {
	let h = 0x9e3779b1 ^ Math.imul(a | 0, 0x85ebca6b);
	h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
	h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
	h = Math.imul(h ^ (d | 0), 0x165667b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return (h >>> 0) / 0x100000000;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class ModMatrix {
	private readonly seed: number;
	private readonly opts: Required<ModMatrixOptions>;
	private readonly states: ParamState[] = [];
	private readonly offsets: number[] = [];
	private picks = 0;
	private time = 0;
	/** Outputs in part order, params within a part contiguous. */
	readonly values: Float32Array;

	constructor(
		readonly sources: readonly ModSource[],
		readonly parts: readonly ModPart[],
		seed: number | string,
		options: ModMatrixOptions = {}
	) {
		if (sources.length < 2) throw new Error('ModMatrix needs at least two sources');
		this.seed = seedWord(seed);
		this.opts = { meanHold: options.meanHold ?? 24, crossfade: options.crossfade ?? 3 };
		let count = 0;
		for (const part of parts) {
			this.offsets.push(count);
			for (const param of part.params) {
				const index = this.states.length;
				this.states.push({
					param,
					routes: [this.newRoute(param, index, 0, -1), this.newRoute(param, index, 1, -1)],
					blendT: hash(this.seed, index, 7, 0x61) * 50,
					value: param.rest ?? 0.5
				});
				count += 1;
			}
		}
		this.values = new Float32Array(count);
		for (let i = 0; i < count; i += 1) this.values[i] = this.states[i].value;
	}

	/** Index of a part's first parameter in `values`. */
	offset(partName: string): number {
		const i = this.parts.findIndex((part) => part.name === partName);
		if (i < 0) throw new Error(`Unknown modulation part "${partName}"`);
		return this.offsets[i];
	}

	/** One parameter's current value (0..1). */
	get(partName: string, paramName: string): number {
		const i = this.parts.findIndex((part) => part.name === partName);
		if (i < 0) throw new Error(`Unknown modulation part "${partName}"`);
		const j = this.parts[i].params.findIndex((param) => param.name === paramName);
		if (j < 0) throw new Error(`Unknown parameter "${paramName}" on part "${partName}"`);
		return this.values[this.offsets[i] + j];
	}

	/** Which source each parameter mostly listens to right now (for debugging and tests). */
	routing(): { part: string; param: string; source: string; weight: number }[] {
		const out: { part: string; param: string; source: string; weight: number }[] = [];
		let k = 0;
		for (const part of this.parts) {
			for (const param of part.params) {
				const s = this.states[k];
				const blend = this.blend(s, k);
				const [a, b] = s.routes;
				const strong = blend < 0.5 ? a : b;
				const src = strong.mix < 0.5 ? strong.from : strong.to;
				out.push({ part: part.name, param: param.name, source: this.sources[src].name, weight: Math.max(blend, 1 - blend) });
				k += 1;
			}
		}
		return out;
	}

	/**
	 * Advance: `channels[i]` is source i's current value. `restless` 0..1
	 * shortens holds (energy, novelty); `reroute` 0..1 is a one-shot push to
	 * re-route now (pass the character shift strength on a new shift).
	 */
	update(channels: ArrayLike<number>, dt: number, restless = 0.5, reroute = 0): Float32Array {
		const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
		this.time += step;
		const holdSpeed = 0.6 + clamp01(restless) * 0.9;
		this.states.forEach((s, index) => {
			const param = s.param;
			s.blendT += step / 31;
			for (let r = 0; r < 2; r += 1) {
				const route = s.routes[r];
				route.hold -= step * holdSpeed;
				const pushed = reroute > 0 && hash(this.seed, index, r, ++this.picks) < reroute * 0.6;
				if ((route.hold <= 0 || pushed) && route.mix >= 1) {
					route.from = route.to;
					route.to = this.pickSource(param, index, r, route.from);
					route.mix = 0;
					route.hold = this.nextHold(index, r);
					// An inverted impulse glows constantly and dips on each hit; only
					// continuous sources may invert.
					if (this.sources[route.to].impulse || this.sources[route.from].impulse) route.invert = false;
				}
				if (route.mix < 1) route.mix = Math.min(1, route.mix + step / Math.max(0.2, this.opts.crossfade));
				const m = route.mix * route.mix * (3 - 2 * route.mix);
				const read = (src: number) => {
					const raw = Number(channels[src] ?? 0);
					const v = this.sources[src].signed ? raw * 0.5 + 0.5 : raw;
					return clamp01(Number.isFinite(v) ? v : 0);
				};
				let target = read(route.from) * (1 - m) + read(route.to) * m;
				if (route.invert) target = 1 - target;
				// Per-route envelope: its own attack and release, so the same
				// channel can be a snap on one part and a slow tide on another.
				const tau = Math.max(param.smooth ?? 0, target > route.envelope ? route.attack : route.release);
				route.envelope += (target - route.envelope) * (1 - Math.exp(-step / Math.max(0.01, tau)));
			}
			const blend = this.blend(s, index);
			const signal = s.routes[0].envelope * (1 - blend) + s.routes[1].envelope * blend;
			const rest = param.rest ?? 0.5;
			const depth = param.depth ?? 0.8;
			// Centre the drive around the rest value; depth bounds the swing.
			s.value = clamp01(rest + (signal - 0.5) * 2 * depth * (signal > 0.5 ? 1 - rest : rest));
			this.values[index] = s.value;
		});
		return this.values;
	}

	/** Plain-data state for resume on re-entry. */
	snapshot(): unknown {
		return {
			picks: this.picks,
			time: this.time,
			states: this.states.map((s) => ({ blendT: s.blendT, value: s.value, routes: s.routes.map((r) => ({ ...r })) }))
		};
	}

	restore(data: unknown): void {
		const d = data as { picks: number; time: number; states: { blendT: number; value: number; routes: Route[] }[] };
		if (!d || !Array.isArray(d.states) || d.states.length !== this.states.length) return;
		this.picks = d.picks;
		this.time = d.time;
		d.states.forEach((saved, i) => {
			const s = this.states[i];
			s.blendT = saved.blendT;
			s.value = saved.value;
			saved.routes.forEach((r, k) => {
				if (r.from < this.sources.length && r.to < this.sources.length) Object.assign(s.routes[k], r);
			});
			this.values[i] = s.value;
		});
	}

	private blend(s: ParamState, index: number): number {
		return 0.5 + 0.5 * noise1(this.seed, 5000 + index, s.blendT);
	}

	private newRoute(param: ModParam, index: number, r: number, avoid: number): Route {
		const src = this.pickSource(param, index, r, avoid);
		const u = hash(this.seed, index, r, 0x33);
		const impulse = this.sources[src].impulse === true;
		return {
			from: src,
			to: src,
			mix: 1,
			hold: this.nextHold(index, r) * (0.3 + u * 0.7),
			// Impulse sources snap; continuous ones may be tides.
			attack: impulse ? 0.02 + u * 0.06 : 0.08 + u * 0.9,
			release: impulse ? 0.15 + u * 0.9 : 0.3 + hash(this.seed, index, r, 0x34) * 3.2,
			// An inverted impulse would glow constantly and dip on each hit.
			invert: !impulse && hash(this.seed, index, r, 0x35) < 0.22,
			// Neutral drive: the parameter starts exactly at rest.
			envelope: 0.5
		};
	}

	private pickSource(param: ModParam, index: number, r: number, current: number): number {
		const prefers = param.prefers ?? [];
		const avoid = new Set(param.avoid ?? []);
		const only = param.only ? new Set(param.only) : null;
		// With many sources, an unpreferred source must weigh little or the
		// preference drowns: a parameter that prefers families gives others a
		// small residual chance only.
		const residual = prefers.length ? 0.04 : 0.35;
		let total = 0;
		const weights = this.sources.map((source, i) => {
			if (i === current || avoid.has(source.name)) return 0;
			if (only && !only.has(source.name) && !(source.family && only.has(source.family))) return 0;
			const rank = source.family ? prefers.indexOf(source.family) : -1;
			const w = rank < 0 ? residual : 1.6 / (1 + rank * 0.5);
			total += w;
			return w;
		});
		if (total <= 0) return current < 0 ? 0 : current;
		let cursor = hash(this.seed, index, r * 1000 + ++this.picks, 0x2c) * total;
		for (let i = 0; i < weights.length; i += 1) {
			cursor -= weights[i];
			if (cursor < 0) return i;
		}
		return weights.findIndex((w) => w > 0);
	}

	private nextHold(index: number, r: number): number {
		const u = Math.max(1e-6, hash(this.seed, index, r * 977 + this.picks, 0x4e));
		return 4 + -Math.log(u) * Math.max(1, this.opts.meanHold - 4);
	}
}
