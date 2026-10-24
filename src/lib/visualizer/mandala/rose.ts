// Mandala's rose: the picture as many small parts, each answering its own
// part of the music, the way each cubie of a Rubik's cube turns on its own
// while the cube stays one object.
//
// The frame is read as a rose window round the mandala's centre: four rings
// (the scale layers of the zoom: the deep core, the inner, middle and outer
// rings of recursion) times eight petals. Each of the 32 panes carries its own
// light, palette voicing, line softness, strike, glints, colour temperature
// and trail. The structure is still one fractal in one palette under one
// lamp; the panes only decide how each part of it is lit and drawn, with
// soft borders, so the window never shows seams.
//
// Who plays which pane:
//   - tides (light, palette voicing, line softness) come from the shared
//     modulation matrix: each listens to a blend of the slow channels (bass
//     line, chord qualities, groove, articulation, texture), with ring-level
//     intent rotated per petal so neighbours differ; routes wander and
//     re-route over time, crossfading, never cutting;
//   - strikes and glints come from a strike router: each pane follows one
//     instrument's heard hits: its filigree flashes on them and its glints
//     (a sparse scatter of elements) re-scatter and light up. The core
//     prefers the kick and the bass notes, the inner ring the notes and the
//     chord changes, the middle ring the hats and percussion, the outer ring
//     the snare; each pane drifts to another instrument at irregular times
//     with a crossfade, so which part answers which instrument keeps changing;
//     A hit reaches at most two of its listeners (busy instruments deal
//     their hits round them in turn), so no instrument lights a whole ring.
//     Each ring has its own attack: the core swells, the hats snap;
//   - authored events on top: a kick pushes the core outward (a local lens),
//     the bass line turns it, a snare cracks one outer petal, the chord's
//     pitch classes light the inner petals round the circle of fifths, a
//     chord change re-voices one ring's palette petal by petal (the root's
//     place on the circle of fifths sets where), its quality warms or cools
//     each pane after its own lag (the core first, the rim last), a fill
//     runs a flare out along one spoke, legato vs staccato per register sets
//     each ring's line softness, strike decay and trail, a breakdown
//     withdraws the panes that listened to the drums one by one (outer
//     first), a build gathers the rose inward, stereo width spreads it,
//     swing leans it, and a new palette arrives pane by pane.
//
// Nothing here lifts the whole frame: every reaction is local to a pane or a
// ring. The rose's frame (its angle and scale) only drifts slowly. Rings are
// staggered by half a petal, brick-wise, so a seam is never shared.
//
// The output is a Float32Array laid out as vec4s for the scene shader's
// storage buffer (see ROSE_* below and the WGSL `rose` binding).

import { ModMatrix, type ModParam, type ModPart, type ModSource } from '../modulation';
import { Wander } from '../motion';
import type { EnsembleFrame } from '../ensemble';

export const ROSE_RINGS = 4;
export const ROSE_PETALS = 8;
export const ROSE_PARTS = ROSE_RINGS * ROSE_PETALS;
export const ROSE_RING_NAMES = ['core', 'inner', 'middle', 'outer'] as const;
/**
 * vec4 slots: two per pane (a, b), then from ROSE_FRAME_SLOT: the frame, the
 * warp, the voices, the hub (three slots), each pane's palette arrival (six
 * slots, one float per pane) and the palette being left (four stops).
 */
export const ROSE_FRAME_SLOT = ROSE_PARTS * 2;
export const ROSE_ARRIVAL_SLOT = ROSE_FRAME_SLOT + 6;
export const ROSE_LEAVING_SLOT = ROSE_ARRIVAL_SLOT + ROSE_PARTS / 4;
export const ROSE_VEC4S = ROSE_LEAVING_SLOT + 4;
export const ROSE_FLOATS = ROSE_VEC4S * 4;
/** Ring centres in screen heights (before the rose's scale), core to outer. */
export const ROSE_RING_RADII = [0, 0.2, 0.42, 0.72] as const;

type SourceDef = ModSource & { read: (e: EnsembleFrame) => number };

const qual = (e: EnsembleFrame, i: number) => e.harmony.qualities[i] ?? 0;

/** The slow channels the panes' tides may listen to, by musical family. */
export const ROSE_SOURCES: readonly SourceDef[] = [
	{ name: 'kickActivity', family: 'kick', read: (e) => e.drums.kick.activity },
	{ name: 'snareActivity', family: 'snare', read: (e) => e.drums.snare.activity },
	{ name: 'hatActivity', family: 'hat', read: (e) => e.drums.hat.activity },
	{ name: 'noteRate', family: 'notes', read: (e) => e.articulation.noteRate / (e.articulation.noteRate + 4) },
	{ name: 'bassLevel', family: 'bass', read: (e) => e.bass.level },
	{ name: 'bassPitch', family: 'bass', read: (e) => (e.bass.pitchClass >= 0 ? e.bass.pitchClass / 11 : 0.5) },
	{ name: 'walking', family: 'bass', read: (e) => e.bass.walking },
	{ name: 'major', family: 'chord', read: (e) => qual(e, 0) },
	{ name: 'minor', family: 'chord', read: (e) => qual(e, 1) },
	{ name: 'tense', family: 'chord', read: (e) => Math.min(1, qual(e, 2) + qual(e, 3)) },
	{ name: 'colour', family: 'chord', read: (e) => Math.min(1, qual(e, 4) + qual(e, 5)) },
	{ name: 'tension', family: 'chord', read: (e) => e.harmony.tension },
	{ name: 'root', family: 'chord', read: (e) => (e.harmony.root >= 0 ? e.harmony.root / 11 : 0.5) },
	{ name: 'swing', family: 'groove', read: (e) => e.groove.swing },
	{ name: 'syncopation', family: 'groove', read: (e) => e.groove.syncopation },
	{ name: 'fill', family: 'groove', read: (e) => e.groove.fillIntensity },
	{ name: 'breakdown', family: 'groove', read: (e) => e.groove.breakdown },
	{ name: 'legato', family: 'artic', read: (e) => e.articulation.legato },
	{ name: 'legatoHigh', family: 'artic', read: (e) => e.articulation.high },
	{ name: 'pad', family: 'artic', read: (e) => e.articulation.pad },
	{ name: 'sustain', family: 'artic', read: (e) => e.articulation.sustain },
	{ name: 'density', family: 'texture', read: (e) => e.texture.density },
	{ name: 'build', family: 'texture', read: (e) => e.texture.build },
	{ name: 'width', family: 'texture', read: (e) => e.texture.width },
	{ name: 'register', family: 'texture', signed: true, read: (e) => e.texture.register },
	{ name: 'noisiness', family: 'texture', read: (e) => e.texture.noisiness },
	{ name: 'air', family: 'texture', read: (e) => e.texture.high },
	{ name: 'floor', family: 'texture', read: (e) => e.texture.low }
];

/** The instruments a pane can strike with: their serial (one per hit) and the hit's strength. */
type Striker = { name: string; serial: (e: EnsembleFrame) => number; strength: (e: EnsembleFrame) => number; decay: number };
export const ROSE_STRIKERS: readonly Striker[] = [
	{ name: 'kick', serial: (e) => e.drums.kick.serial, strength: (e) => e.drums.kick.velocity, decay: 0.16 },
	{ name: 'snare', serial: (e) => e.drums.snare.serial, strength: (e) => e.drums.snare.velocity, decay: 0.2 },
	{ name: 'hat', serial: (e) => e.drums.hat.serial, strength: (e) => e.drums.hat.velocity * 0.85, decay: 0.09 },
	{ name: 'perc', serial: (e) => e.drums.perc.serial, strength: (e) => e.drums.perc.velocity, decay: 0.14 },
	{ name: 'notes', serial: (e) => e.notes.serial, strength: (e) => e.notes.velocity, decay: 0.22 },
	{ name: 'bass', serial: (e) => e.bass.noteSerial, strength: (e) => Math.max(0.5, e.bass.level), decay: 0.24 },
	{ name: 'chord', serial: (e) => e.harmony.changeSerial, strength: () => 1, decay: 0.45 }
];
const STRIKER = Object.fromEntries(ROSE_STRIKERS.map((s, i) => [s.name, i])) as Record<string, number>;
const DRUM_STRIKERS = ['kick', 'snare', 'hat', 'perc'].map((name) => STRIKER[name]);

// Ring intent, most preferred first; each petal rotates the list so
// neighbouring panes lead with different instruments.
/** A pane's light is a tide that follows the slow parts. */
const RING_LIGHT: readonly (readonly string[])[] = [
	['bass', 'kick', 'artic'],
	['chord', 'notes', 'bass'],
	['hat', 'groove', 'notes'],
	['groove', 'texture', 'snare']
];
/** Its strike: the instrument whose hits flash its filigree. */
const RING_STRIKE: readonly (readonly string[])[] = [
	['kick', 'bass', 'perc'],
	['notes', 'chord', 'bass'],
	['hat', 'perc', 'notes'],
	['snare', 'hat', 'perc']
];
/** Where a pane's glints first come from (they then follow its strike). */
const RING_GLINT: readonly (readonly string[])[] = [
	['bass', 'perc', 'kick'],
	['notes', 'chord', 'perc'],
	['hat', 'perc', 'notes'],
	['perc', 'snare', 'notes']
];
/**
 * Each ring's attack, seconds: the deep core swells into a hit (weight, not
 * a flash), the inner ring blooms, the middle ring's hats snap, the outer
 * ring's snares crack.
 */
const RING_ATTACK = [0.11, 0.07, 0, 0.025];
/** Matrix parameters per pane, in this order: light, tone, soft. */
const PANE_PARAMS = 3;

function rotate<T>(list: readonly T[], by: number): T[] {
	const n = list.length;
	return list.map((_, i) => list[(i + by) % n]);
}

/** The panes as modulation parts (their tides). */
function roseParts(): ModPart[] {
	const parts: ModPart[] = [];
	for (let ring = 0; ring < ROSE_RINGS; ring += 1) {
		for (let petal = 0; petal < ROSE_PETALS; petal += 1) {
			const params: ModParam[] = [
				// Tides swell and ebb over a second or two, never snap: the hits
				// speak through the strikes, and a tide that jumped with every
				// chord would turn all its panes at once.
				{ name: 'light', prefers: rotate(RING_LIGHT[ring], petal % 3), rest: 0.45, depth: 0.95, smooth: 0.8 },
				{ name: 'tone', prefers: rotate(['chord', 'bass', 'texture'], (petal + ring) % 3), rest: 0.5, depth: 0.55, smooth: 1.5 },
				{ name: 'soft', prefers: rotate(['artic', 'groove', 'texture'], petal % 3), rest: 0.4, depth: 0.7, smooth: 0.8 }
			];
			parts.push({ name: `${ROSE_RING_NAMES[ring]}${petal}`, params });
		}
	}
	return parts;
}

function hash(a: number, b: number): number {
	let h = Math.imul((a | 0) ^ 0x9e3779b1, 0x85ebca6b);
	h = Math.imul(h ^ (b | 0) ^ (h >>> 13), 0xc2b2ae35);
	h ^= h >>> 16;
	h = Math.imul(h, 0x27d4eb2f);
	h ^= h >>> 15;
	return (h >>> 0) / 0x100000000;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const ease = (current: number, target: number, tau: number, dt: number) =>
	current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
const fract = (x: number) => x - Math.floor(x);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Pitch classes in circle-of-fifths order round the petals: a chord lights neighbouring petals. */
const FIFTHS = Array.from({ length: 12 }, (_, f) => (f * 7) % 12);

/** One pane's listening: which instrument it follows, crossfading to the next. */
type StrikeRoute = { from: number; to: number; mix: number; hold: number };

export type RoseInput = {
	dt: number;
	/** 0..1 the director's silence: the rose returns to rest in silence. */
	silence: number;
	/** 0..1 how restless the routing is (energy, density). */
	restless: number;
	/** 0..1 one-shot push to re-route now (a change of music). */
	reroute: number;
	/** Where the mandala's centre sits on screen (screen heights from the middle). */
	centreX: number;
	centreY: number;
	/** 0..1 how far the palette morph has come (1: settled). */
	paletteWeight: number;
	/** The palette being left: four stops (deep to hot), already tinted. */
	leaving: readonly (readonly [number, number, number])[];
	/**
	 * Dev/QA: silence parts of the rose to measure them (bit flags: 1
	 * strikes, 2 glints, 4 snare cracks, 8 chord petals, 16 voicings, 32
	 * temperature, 64 tides, 128 core push and twist, 256 fill flares).
	 */
	mute?: number;
};

type Flare = { spoke: number; t: number; strength: number };

export class MandalaRose {
	readonly matrix: ModMatrix;
	/** The packed storage-buffer contents. */
	readonly out = new Float32Array(ROSE_FLOATS);
	private readonly channels = new Float32Array(ROSE_SOURCES.length);
	private readonly drift: Wander;
	private readonly seedWord: number;
	/** Per instrument: last serial heard and its strike envelope. */
	private readonly strikeSerial = new Float64Array(ROSE_STRIKERS.length);
	/** Per instrument: how alive it is (hits over the last few seconds, 0..1). */
	private readonly alive = new Float32Array(ROSE_STRIKERS.length);
	private readonly rate = new Float32Array(ROSE_STRIKERS.length);
	/** Per pane: strike and glint routes. */
	private readonly strikes: StrikeRoute[] = [];
	private readonly glints: StrikeRoute[] = [];
	private picks = 0;
	// Event envelopes, one per pane.
	private readonly crack = new Float32Array(ROSE_PARTS);
	private readonly flare = new Float32Array(ROSE_PARTS);
	private readonly chroma = new Float32Array(ROSE_PETALS);
	private readonly petalChroma = new Float32Array(ROSE_PETALS);
	/** Per pane: colour temperature and how long it takes to hear the chord's quality. */
	private readonly warm = new Float32Array(ROSE_PARTS);
	private readonly warmLag = new Float32Array(ROSE_PARTS);
	private readonly legato = new Float32Array(ROSE_RINGS).fill(0.5);
	/** Per pane: palette voicing, its target, and a re-voicing on its way round the ring. */
	private readonly voice = new Float64Array(ROSE_PARTS);
	private readonly voiceTarget = new Float64Array(ROSE_PARTS);
	private readonly voiceDue = new Float32Array(ROSE_PARTS);
	private readonly voicePending = new Float32Array(ROSE_PARTS).fill(NaN);
	/** Per ring: the voicing it returns to (the chord's root moves it about this). */
	private readonly home = new Float32Array(ROSE_RINGS);
	private readonly rank = new Float32Array(ROSE_PARTS);
	/** Per pane: when a new palette reaches it (0 first .. 1 last). */
	private readonly arrival = new Float32Array(ROSE_PARTS);
	/** Per pane: the glint seed (which elements catch the glint) and the last glint level. */
	private readonly seeds = new Float32Array(ROSE_PARTS);
	private readonly glintLast = new Float32Array(ROSE_PARTS);
	private readonly strikeNow = new Float32Array(ROSE_PARTS);
	/** The strike as shown: it rises with its ring's attack (see RING_ATTACK). */
	private readonly strikeShown = new Float32Array(ROSE_PARTS);
	private readonly glintNow = new Float32Array(ROSE_PARTS);
	private flares: Flare[] = [];
	private push = 0;
	private twist = 0;
	private twistTarget = 0;
	private lean = 0;
	private spread = 1;
	private breakdown = 0;
	private build = 0;
	private tension = 0;
	// Last serials answered (adopted on the first update, so a new rose never fires on old news).
	private synced = false;
	private snareSerial = 0;
	private fillSerial = 0;
	private changeSerial = 0;
	private cracks = 0;
	private crackPetal = 0;
	private revoices = 0;
	private shifts = 0;

	constructor(seed: number) {
		const s = Number.isFinite(seed) ? seed : 0.5;
		this.seedWord = Math.floor(fract(s) * 0x7fffffff);
		this.matrix = new ModMatrix(ROSE_SOURCES, roseParts(), `mandala-rose-${s.toFixed(6)}`, { meanHold: 26, crossfade: 3.5 });
		this.drift = new Wander(3, s + 0.417, [67, 89, 53]);
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			const ring = Math.floor(i / ROSE_PETALS);
			const petal = i % ROSE_PETALS;
			// A breakdown takes the outer panes first, in a scattered order.
			this.rank[i] = ((ROSE_RINGS - 1 - ring) / (ROSE_RINGS - 1)) * 0.55 + hash(i, this.seedWord) * 0.45;
			this.seeds[i] = hash(i, 991);
			// A new palette arrives at the core first and the rim last, pane by pane.
			this.arrival[i] = (ring / (ROSE_RINGS - 1)) * 0.65 + hash(i, 0xa77 + this.seedWord) * 0.35;
			// The core hears the chord's quality first, the rim last, each pane in its own time.
			this.warmLag[i] = 0.3 + ring * 0.6 + hash(i, 0x3a11 + this.seedWord) * 1.6;
			const strike = this.pick(rotate(RING_STRIKE[ring], petal % 3), -1, i);
			const glint = this.pick(rotate(RING_GLINT[ring], petal % 3), strike, i + 100);
			this.strikes.push({ from: strike, to: strike, mix: 1, hold: this.hold(i) * (0.3 + hash(i, 5) * 0.7) });
			this.glints.push({ from: glint, to: glint, mix: 1, hold: this.hold(i + 100) * (0.3 + hash(i, 6) * 0.7) });
		}
		for (let r = 0; r < ROSE_RINGS; r += 1) this.home[r] = (hash(r, 77 + this.seedWord) - 0.5) * 0.3;
		for (let i = 0; i < ROSE_PARTS; i += 1) this.voice[i] = this.voiceTarget[i] = this.home[Math.floor(i / ROSE_PETALS)];
	}

	/** How many panes the picture has (for QA). */
	get parts(): number {
		return ROSE_PARTS;
	}

	/**
	 * A change of music: every ring takes a new home voicing (the window
	 * re-voices from the core outward within a second or so, pane by pane)
	 * and the panes re-route soon, so the new music is heard by new parts.
	 */
	shift(strength: number, root: number): void {
		if (!(strength > 0)) return;
		this.shifts += 1;
		const fifths = root >= 0 ? ((root * 7) % 12) / 12 : 0.5;
		for (let r = 0; r < ROSE_RINGS; r += 1) {
			// Far enough round the palette to read as a new voicing.
			this.home[r] = fract(this.home[r] + 0.3 + hash(r, this.shifts * 131 + this.seedWord) * 0.4) - 0.5;
			for (let p = 0; p < ROSE_PETALS; p += 1) {
				const i = r * ROSE_PETALS + p;
				this.voicePending[i] = this.home[r] + (fifths - 0.5) * 0.3;
				this.voiceDue[i] = r * 0.18 + hash(i, this.shifts) * 0.25;
			}
		}
		for (const route of this.strikes) route.hold = Math.min(route.hold, 0.5 + hash(this.shifts, route.to) * 2.5 * (1.2 - strength));
	}

	/** Which instrument each pane strikes with right now (QA and debugging). */
	strikeRouting(): string[] {
		return this.strikes.map((r, i) => {
			const src = r.mix < 0.5 ? r.from : r.to;
			return `${ROSE_RING_NAMES[Math.floor(i / ROSE_PETALS)]}${i % ROSE_PETALS}:${ROSE_STRIKERS[src].name}`;
		});
	}

	/** A strike instrument for a pane: its ring's preferences first, any other rarely. */
	private pick(prefers: readonly string[], avoid: number, lane: number): number {
		// Instruments that are playing now are likelier: when the drums drop
		// out, the panes listen to what is left (notes, the bass, the chords).
		const weights = ROSE_STRIKERS.map((s, i) => {
			if (i === avoid) return 0;
			const rank = prefers.indexOf(s.name);
			return (rank < 0 ? 0.06 : 1 / (1 + rank * 0.8)) * (0.35 + this.alive[i]);
		});
		const total = weights.reduce((a, b) => a + b, 0);
		let cursor = hash(lane * 31 + ++this.picks, this.seedWord ^ 0x5eed) * total;
		for (let i = 0; i < weights.length; i += 1) {
			cursor -= weights[i];
			if (cursor < 0) return i;
		}
		return STRIKER.kick;
	}

	/** Seconds a strike route holds before it may drift to another instrument. */
	private hold(lane: number): number {
		const u = Math.max(1e-6, hash(lane * 7 + this.picks, this.seedWord ^ 0x401d));
		return 10 + -Math.log(u) * 22;
	}

	private route(routes: StrikeRoute[], lists: readonly (readonly string[])[], i: number, lane: number, dt: number, pace: number, push: boolean) {
		const r = routes[i];
		r.hold -= dt * pace;
		// An instrument that has fallen silent lets its panes go soon.
		if (r.mix >= 1 && this.alive[r.to] < 0.03 && r.hold > 4) r.hold = 4;
		if ((r.hold <= 0 || push) && r.mix >= 1) {
			const ring = Math.floor(i / ROSE_PETALS);
			r.from = r.to;
			// A glint avoids the instrument its pane strikes with.
			const avoid = routes === this.glints ? this.strikes[i].to : r.from;
			r.to = this.pick(rotate(lists[ring], (i % ROSE_PETALS) % 3), avoid, lane);
			r.mix = r.to === r.from ? 1 : 0;
			r.hold = this.hold(lane);
		}
		if (r.mix < 1) r.mix = Math.min(1, r.mix + dt / 1.8);
	}

	/** How much pane i's route listens to instrument n (0..1, crossfading). */
	private static share(r: StrikeRoute, n: number): number {
		const m = smooth(r.mix);
		return (r.from === n ? 1 - m : 0) + (r.to === n ? m : 0);
	}

	/**
	 * A hit of instrument n reaches the panes that listen to it. A busy
	 * instrument (hats in sixteenths) lights only a few of them per hit, in
	 * turn, so its sparkle travels round the window instead of flashing every
	 * listener at once; a sparse one (a snare, a chord change) lights them all.
	 */
	private deal(routes: StrikeRoute[], env: Float32Array, n: number, v: number, turn: number, most: number): void {
		let listeners = 0;
		for (let i = 0; i < ROSE_PARTS; i += 1) if (MandalaRose.share(routes[i], n) > 0.05) listeners += 1;
		if (!listeners) return;
		const perSecond = this.rate[n] / 3;
		const take = Math.min(most, Math.max(1, Math.round(listeners * Math.min(1, 1.4 / Math.max(0.5, perSecond)))));
		// Which listeners take this hit: a stride through them that turns each hit.
		const start = Math.floor(hash(turn, n * 7919 + this.seedWord) * listeners);
		let k = 0;
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			const w = MandalaRose.share(routes[i], n);
			if (w <= 0.05) continue;
			const slot = (k - start + listeners) % listeners;
			k += 1;
			if (slot >= take) continue;
			env[i] = Math.max(env[i], v * w);
		}
	}

	update(e: EnsembleFrame, input: RoseInput): Float32Array {
		const dt = Math.min(0.25, Math.max(0, Number.isFinite(input.dt) ? input.dt : 0));
		const hush = 1 - clamp01(input.silence);
		const ch = this.channels;
		ROSE_SOURCES.forEach((source, i) => {
			const v = Number(source.read(e));
			ch[i] = Number.isFinite(v) ? v : 0;
		});
		const m = this.matrix.update(ch, dt, input.restless, input.reroute);

		if (!this.synced) {
			this.synced = true;
			this.snareSerial = e.drums.snare.serial;
			this.fillSerial = e.groove.fillSerial;
			this.changeSerial = e.harmony.changeSerial;
			ROSE_STRIKERS.forEach((s, i) => (this.strikeSerial[i] = s.serial(e)));
		}

		// ── Articulation per register: legato rings draw soft lines with long
		// trails and strikes that ring on, staccato rings crisp ones that let go.
		const art = e.articulation;
		const registers = [art.low, art.mid, art.mid * 0.5 + art.high * 0.5, art.high];
		for (let r = 0; r < ROSE_RINGS; r += 1) this.legato[r] = ease(this.legato[r], clamp01(registers[r]), 0.6, dt);
		const linger = 0.6 + clamp01(art.legato) * 1.1;

		// ── Strikes: each instrument's heard hits, dealt out to the panes that
		// listen to it (see deal); each pane's strike and glint ring out with
		// their instrument's decay, longer when the music is legato.
		const pace = 0.6 + clamp01(input.restless) * 0.9;
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			const push = input.reroute > 0 && hash(i * 13 + this.picks, this.seedWord ^ 0xbeef) < input.reroute * 0.5;
			this.route(this.strikes, RING_STRIKE, i, i, dt, pace, push);
			// A pane glints on the instrument it strikes with: its filigree
			// flashes and its glints re-scatter on the same hits.
			Object.assign(this.glints[i], this.strikes[i]);
		}
		const strike = this.strikeNow;
		const glintNow = this.glintNow;
		ROSE_STRIKERS.forEach((s, n) => {
			const serial = s.serial(e);
			if (serial !== this.strikeSerial[n]) {
				this.strikeSerial[n] = serial;
				this.rate[n] += 1;
				if (hush > 0.3) {
					const v = clamp01(s.strength(e)) * 0.7 + 0.3;
					// Never more than a couple of panes per hit: a whole ring lit by
					// one instrument would be a face turning, not a cubie.
					this.deal(this.strikes, strike, n, v, serial, 2);
					this.deal(this.glints, glintNow, n, v, serial, 2);
				}
			}
			this.rate[n] *= Math.exp(-dt / 3);
			this.alive[n] = 1 - Math.exp(-this.rate[n] * 0.8);
		});
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			const st = ROSE_STRIKERS[this.strikes[i].to].decay * linger;
			const gl = ROSE_STRIKERS[this.glints[i].to].decay * linger;
			strike[i] *= Math.exp(-dt / st);
			glintNow[i] *= Math.exp(-dt / gl);
			const attack = RING_ATTACK[Math.floor(i / ROSE_PETALS)];
			const shown = this.strikeShown[i];
			this.strikeShown[i] =
				strike[i] > shown && attack > 0 ? shown + (strike[i] - shown) * (1 - Math.exp(-dt / attack)) : strike[i];
			// A rising glint is a new hit: the pane re-scatters which elements catch it.
			if (glintNow[i] > this.glintLast[i] + 0.15) this.seeds[i] = fract(this.seeds[i] + 0.6180339887);
			this.glintLast[i] = glintNow[i];
		}

		// ── Snare: a crack through one outer petal, a different one each time
		// (never the last), so the outer ring never flashes as one.
		if (e.drums.snare.serial !== this.snareSerial) {
			this.snareSerial = e.drums.snare.serial;
			if (hush > 0.3) {
				this.crackPetal = (this.crackPetal + 1 + Math.floor(hash(++this.cracks, 0x51ae) * (ROSE_PETALS - 1))) % ROSE_PETALS;
				const v = Math.max(0.45, e.drums.snare.velocity) * (0.75 + 0.25 * clamp01(e.drums.snare.accent));
				const i = 3 * ROSE_PETALS + this.crackPetal;
				this.crack[i] = Math.max(this.crack[i], v * 0.75);
			}
		}
		for (let i = 0; i < ROSE_PARTS; i += 1) this.crack[i] *= Math.exp(-dt / (0.18 * linger));

		// ── Fill: a flare runs out along one spoke, core to rim.
		if (e.groove.fillSerial !== this.fillSerial) {
			this.fillSerial = e.groove.fillSerial;
			if (hush > 0.3) {
				const spoke = Math.floor(hash(this.fillSerial, 0xf111) * ROSE_PETALS);
				this.flares.push({ spoke, t: 0, strength: Math.max(0.6, e.groove.fillIntensity) });
				if (this.flares.length > 3) this.flares.shift();
			}
		}
		this.flare.fill(0);
		for (const f of this.flares) {
			f.t += dt;
			const wave = (f.t / 0.85) * (ROSE_RINGS - 1);
			for (let r = 0; r < ROSE_RINGS; r += 1) {
				const g = Math.exp(-((wave - r) ** 2) / 0.45) * f.strength * Math.exp(-f.t / 1.4);
				for (const petal of [f.spoke]) {
					const i = r * ROSE_PETALS + petal;
					this.flare[i] = Math.max(this.flare[i], g);
					// The neighbours catch a little of it.
					for (const side of [petal + 1, petal + ROSE_PETALS - 1]) {
						const j = r * ROSE_PETALS + (side % ROSE_PETALS);
						this.flare[j] = Math.max(this.flare[j], g * 0.25);
					}
				}
			}
		}
		this.flares = this.flares.filter((f) => f.t < 1.6);

		// ── Chords. The pitch classes light the inner petals round the circle of
		// fifths; a chord change re-voices one ring's palette; the chord's
		// quality warms (major) or cools (minor, diminished) each ring after its
		// own lag, so the change spreads outward ring by ring.
		const chroma = e.harmony.chroma;
		const confident = clamp01(e.harmony.confidence * 1.4) * hush;
		let mean = 0;
		const petalChroma = this.petalChroma;
		for (let p = 0; p < ROSE_PETALS; p += 1) {
			// The petal's stretch of the circle of fifths, sampled smoothly.
			let sum = 0;
			for (let k = 0; k < 3; k += 1) {
				const x = ((p + (k + 0.5) / 3) * 12) / ROSE_PETALS;
				const a = Math.floor(x) % 12;
				const t = x - Math.floor(x);
				sum += ((chroma[FIFTHS[a]] ?? 0) * (1 - t) + (chroma[FIFTHS[(a + 1) % 12]] ?? 0) * t) / 3;
			}
			petalChroma[p] = sum;
			mean += sum / ROSE_PETALS;
		}
		for (let p = 0; p < ROSE_PETALS; p += 1) {
			this.chroma[p] = ease(this.chroma[p], (petalChroma[p] - mean) * confident, 0.16, dt);
		}
		if (e.harmony.changeSerial !== this.changeSerial) {
			this.changeSerial = e.harmony.changeSerial;
			if (hush > 0.3) {
				// Which ring answers walks irregularly round the rose.
				// The re-voicing travels round that ring petal by petal.
				const r = Math.floor(hash(++this.revoices, 0xc40d) * ROSE_RINGS);
				const from = Math.floor(hash(this.revoices, 0xc40e) * ROSE_PETALS);
				const way = hash(this.revoices, 0xc40f) < 0.5 ? 1 : ROSE_PETALS - 1;
				// The voicing is the chord's: its root's place on the circle of
				// fifths sets where on the palette the ring sits, so the same chord
				// always colours a ring the same way and a progression cycles them.
				const fifths = e.harmony.root >= 0 ? ((e.harmony.root * 7) % 12) / 12 : 0.5;
				const target = this.home[r] + (fifths - 0.5) * 0.3;
				for (let step = 0; step < ROSE_PETALS; step += 1) {
					const i = r * ROSE_PETALS + ((from + step * way) % ROSE_PETALS);
					this.voicePending[i] = target;
					this.voiceDue[i] = step * 0.2;
				}
			}
		}
		const q = e.harmony.qualities;
		const temperature =
			((q[0] ?? 0) + (q[3] ?? 0) * 0.4 + (q[4] ?? 0) * 0.3 + (q[5] ?? 0) * 0.55 - (q[1] ?? 0) - (q[2] ?? 0) * 0.9) *
			clamp01(e.harmony.confidence * 1.6);
		const heat = Math.max(-1, Math.min(1, temperature)) * hush;
		for (let i = 0; i < ROSE_PARTS; i += 1) this.warm[i] = ease(this.warm[i], heat, this.warmLag[i], dt);
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			if (!Number.isNaN(this.voicePending[i])) {
				this.voiceDue[i] -= dt;
				if (this.voiceDue[i] <= 0) {
					this.voiceTarget[i] = this.voicePending[i];
					this.voicePending[i] = NaN;
				}
			}
			this.voice[i] = ease(this.voice[i], this.voiceTarget[i], 0.45, dt);
		}
		this.tension = ease(this.tension, clamp01(e.harmony.tension) * hush, 0.6, dt);

		// ── Kick and bass: the core is pushed outward by the kick (a local lens,
		// never the frame) and turns with the bass line.
		const kick = e.drums.kick.hit * hush;
		this.push = ease(this.push, kick, kick > this.push ? 0.03 : 0.2, dt);
		if (e.bass.pitchClass >= 0 && e.bass.confidence > 0.25) this.twistTarget = ((e.bass.pitchClass - 5.5) / 5.5) * 0.32;
		this.twist = ease(this.twist, this.twistTarget * hush, 0.22, dt);

		// ── Song shape: a breakdown withdraws panes one by one, a build gathers
		// the rose inward; stereo width spreads it; swing leans it.
		this.breakdown = ease(this.breakdown, clamp01(e.groove.breakdown), 1.2, dt);
		this.build = ease(this.build, clamp01(e.texture.build), 1.5, dt);
		const w = this.drift.update(dt, 0.6 + hush * 0.6);
		this.lean = ease(this.lean, clamp01(e.groove.swing) * 0.15 * clamp01(e.groove.confidence * 1.5), 2, dt);
		const width = e.texture.stereoKnown ? clamp01(e.texture.width) : 0.3;
		this.spread = ease(this.spread, (0.82 + width * 0.45) * (1 - this.build * 0.16) * (1 + w[1] * 0.08), 1.2, dt);

		// ── Pack.
		const mute = input.mute ?? 0;
		const o = this.out;
		const hub = [0, 0, 0, 0, 0, 0, 0, 0];
		for (let r = 0; r < ROSE_RINGS; r += 1) {
			for (let petal = 0; petal < ROSE_PETALS; petal += 1) {
				const i = r * ROSE_PETALS + petal;
				const k = i * PANE_PARAMS;
				// The tide is gentle (it must not read as the look drifting on its
				// own); the strikes carry the fast, bright answers.
				let light = mute & 64 ? 1 : 0.55 + m[k] * 0.95;
				// The core never becomes a glowing orb: its light is held lower.
				if (r === 0) light = Math.min(light, 1.15);
				const st = mute & 1 ? 0 : this.strikeShown[i];
				const fl = mute & 256 ? 0 : this.flare[i];
				if (r === 1 && !(mute & 8)) light *= 1 + this.chroma[petal] * 1.3;
				// Strikes flash the filigree, not the pane's fill (see crack below).
				light += fl * 1.1;
				light += this.build * 0.25 * (r / (ROSE_RINGS - 1));
				// A breakdown withdraws the panes that were listening to the drums,
				// one by one (outer first); the panes on the notes, the bass and the
				// chords play on. Withdrawn panes keep a trace: still there, unlit.
				const route = this.strikes[i];
				const drums = DRUM_STRIKERS.reduce((sum, n) => sum + MandalaRose.share(route, n), 0);
				const out = clamp01((this.breakdown - this.rank[i] * 0.85) / 0.15) * drums;
				light *= 1 - out * 0.45;
				// Bounded, so no pane burns out or goes dead.
				light = 1 + (Math.min(2.2, Math.max(0.15, light)) - 1) * hush;
				const tone = (mute & 64 ? 0 : (m[k + 1] - 0.5) * 0.3) + (mute & 16 ? 0 : this.voice[i]);
				const soft = clamp01(m[k + 2] * 0.55 + this.legato[r] * 0.45);
				const glint = mute & 2 ? 0 : clamp01(glintNow[i]) * hush * (1 - out * 0.8);
				const crack = ((mute & 4 ? 0 : this.crack[i]) + st + fl * 0.5) * hush;
				const warm = mute & 32 ? 0 : this.warm[i];
				const trail = clamp01(0.25 + this.legato[r] * 0.6 + (m[k + 2] - 0.4) * 0.3);
				const values = [light, tone, soft, glint, crack, warm, trail, this.seeds[i]];
				for (let j = 0; j < 8; j += 1) o[i * 8 + j] = values[j];
				if (r === 0) for (let j = 0; j < 8; j += 1) hub[j] += values[j] / ROSE_PETALS;
			}
		}
		const f = ROSE_FRAME_SLOT * 4;
		// Frame: centre, angle, scale.
		o[f] = input.centreX;
		o[f + 1] = input.centreY;
		// The rose's angle: the outer ring's seams sit on the frame's axes and
		// the inner rings are staggered off them, so the frame's left and right,
		// top and bottom each hold panes of their own. It sways a little.
		o[f + 2] = Math.PI / ROSE_PETALS + w[0] * 0.1 + this.lean;
		o[f + 3] = this.spread;
		// Warp: core push, core twist, tension, build.
		o[f + 4] = mute & 128 ? 0 : this.push;
		o[f + 5] = mute & 128 ? 0 : this.twist;
		o[f + 6] = this.tension;
		o[f + 7] = this.build;
		// Each ring's voicing (its first petal's), for QA.
		for (let r = 0; r < ROSE_RINGS; r += 1) o[f + 8 + r] = this.voice[r * ROSE_PETALS];
		// Hub: the core's mean, so the petals meet without a pinwheel at the centre.
		hub[7] = this.seeds[0];
		for (let j = 0; j < 8; j += 1) o[f + 12 + j] = hub[j];
		// Palette arrival per pane: each pane turns over in its own stretch of the morph.
		const pw = clamp01(input.paletteWeight);
		let hubArrival = 0;
		for (let i = 0; i < ROSE_PARTS; i += 1) {
			const a = smooth(clamp01(pw * 2.2 - this.arrival[i] * 1.2));
			o[ROSE_ARRIVAL_SLOT * 4 + i] = a;
			if (i < ROSE_PETALS) hubArrival += a / ROSE_PETALS;
		}
		o[f + 20] = hubArrival;
		for (let s = 0; s < 4; s += 1) {
			const c = input.leaving[s];
			for (let j = 0; j < 3; j += 1) o[(ROSE_LEAVING_SLOT + s) * 4 + j] = c?.[j] ?? 0;
		}
		return o;
	}
}
