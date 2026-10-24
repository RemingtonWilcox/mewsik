// Loom as an ensemble of threads. The weave is literally a band: each strand
// group plays its own instrument, so the picture is many small parts that each
// answer their own line of the music (the cubies of the owner's Rubik's cube)
// instead of whole-frame pulses on one energy dial.
//
//   low rail      the bass line: the rail rises and falls with the bass pitch,
//                 leaps pluck it, walking bass ripples along it, and its notes
//                 drop rings on the floor's water
//   centre rail   kick packets (they light the floor beneath them)
//   high rail     snare cracks
//   weft (low)    perc (toms, rims); re-threaded by chord changes
//   weft (high)   tonal onsets (the melody); re-threaded by chord changes
//   chorus i      hats: fine glitter
//   chorus ii     chord tones: a packet at each tone of a new chord
//   chorus iii    offbeats: the "and" of the beat, staggered by swing
//   chorus iv     accents: the hits that stand out
//   shuttle       fills: one pass along one group's threads per fill
//   floor, mist, dust, far threads, the key light, the camera: each their own
//                 slow or fast voice through the modulation matrix
//
// Packets sit where their hit fell in the bar (the strand is a bar of music),
// legato stretches them and makes them glide, staccato makes them short.
// Chord quality sets each group's colour relation (major warm and open, minor
// cool, diminished clashing and clustered). Breakdowns let groups slacken and
// fall away one by one, the drums first; a drum return brings them back. A
// build gathers the chorus toward the middle; stereo width spreads it.
//
// Which group plays which instrument is a starting point, not a rule: two
// groups trade instruments now and then (crossfaded), and every continuous
// parameter listens through the shared ModMatrix, whose routes wander.
//
// CPU only and allocation-free per tick. One instance lives in the shared
// journey (vis.persistentLook), so a remount or a new song carries on. The
// output is a flat vec4 array the shaders read as `parts` (see LOOM_PART_*).

import type { EnsembleFrame, EnsembleLayer } from '$lib/visualizer/ensemble';
import type { MusicCharacter } from '$lib/visualizer/character';
import { ModMatrix, type ModParam, type ModPart, type ModSource } from '$lib/visualizer/modulation';

/** Strand groups: 3 rails, 2 weft groups, 4 chorus groups (shaders.ts strandGroup). */
export const LOOM_GROUPS = 9;
export const LOOM_GROUP_NAMES = [
	'low rail',
	'centre rail',
	'high rail',
	'weft low',
	'weft high',
	'chorus i',
	'chorus ii',
	'chorus iii',
	'chorus iv'
] as const;
/** Light packets in flight per group. */
export const LOOM_PACKET_SLOTS = 4;
/**
 * vec4s per group: A glow, width, slack, hue; B detail, lift, lean, sparkle;
 * C crossing offset, crossing phase, presence, hit; D cluster, spark seed,
 * slow glow, slow width; E wave phase, crawl, hero (rails).
 */
export const LOOM_GROUP_VEC4S = 5;
export const LOOM_PART_PACKETS = LOOM_GROUPS * LOOM_GROUP_VEC4S;
const ENV0 = LOOM_PART_PACKETS + LOOM_GROUPS * LOOM_PACKET_SLOTS;
/** Environment parts (vec4 index into `parts`). */
export const LOOM_PART = {
	/** reflect gain, pool gain, -, - */
	floor: ENV0,
	/** stage x, stage z, age (s), amplitude: a ring on the floor from a bass note */
	ringA: ENV0 + 1,
	ringB: ENV0 + 2,
	/** density, height, scatter, stir */
	mist: ENV0 + 3,
	/** glint, -, -, - */
	dust: ENV0 + 4,
	/** gain, pluck amplitude, pluck phase, sway */
	threads: ENV0 + 5,
	/** warmth shift, fill gain, azimuth offset, eye adaptation rate (per frame) */
	light: ENV0 + 6,
	/** s, intensity, width, group: the shuttle pass of a fill along one group */
	shuttle: ENV0 + 7,
	/** pluck amplitude, pluck mode, pluck phase, walk amplitude */
	bass: ENV0 + 8,
	/** walk phase, -, -, - */
	bassWalk: ENV0 + 9,
	/** pluck sector (radians round the stage), -, -, - */
	threadsB: ENV0 + 10
} as const;
export const LOOM_PART_VEC4S = ENV0 + 11;
export const LOOM_PART_BYTES = LOOM_PART_VEC4S * 16;

/**
 * A group's crawl wraps here: 32 whole turns, so every use of it in the
 * shaders (crawl x 0.25, x 0.125, x 1.5, x 6 / wrap) turns whole times.
 */
export const LOOM_CRAWL_WRAP = Math.PI * 2 * 32;
const WAVE_WRAP = Math.PI * 2 * 512;

/** The instruments a group can play (packet voices). */
export const LOOM_VOICES = ['bass', 'kick', 'snare', 'perc', 'notes', 'hat', 'chord', 'offbeat', 'accent'] as const;
export type LoomVoice = (typeof LOOM_VOICES)[number];
const VOICE = Object.fromEntries(LOOM_VOICES.map((v, i) => [v, i])) as Record<LoomVoice, number>;
/** Voices that are drums: they withdraw first in a breakdown. */
const DRUM_VOICES = new Set<number>([VOICE.kick, VOICE.snare, VOICE.perc, VOICE.hat, VOICE.offbeat, VOICE.accent]);

/** How much each group takes the chord's colour relation (the chord group most). */
const HARMONY_GAIN = [0.45, 0.35, 0.5, 0.75, 0.85, 0.5, 1, 0.6, 0.7];
/** Chorus groups gather on a build at staggered thresholds, one by one. */
const GATHER_AT = [1, 1, 1, 1, 1, 0.15, 0.3, 0.45, 0.6];

const SOURCES: readonly ModSource[] = [
	{ name: 'kick', family: 'kick', impulse: true },
	{ name: 'kickActivity', family: 'kick' },
	{ name: 'snare', family: 'snare', impulse: true },
	{ name: 'snareActivity', family: 'snare' },
	{ name: 'hat', family: 'hat', impulse: true },
	{ name: 'hatActivity', family: 'hat' },
	{ name: 'perc', family: 'perc', impulse: true },
	{ name: 'percActivity', family: 'perc' },
	{ name: 'notes', family: 'notes', impulse: true },
	{ name: 'notesActivity', family: 'notes' },
	{ name: 'noteRate', family: 'notes' },
	{ name: 'swing', family: 'groove' },
	{ name: 'syncopation', family: 'groove' },
	{ name: 'fill', family: 'groove' },
	{ name: 'breakdown', family: 'groove' },
	{ name: 'drums', family: 'groove' },
	{ name: 'major', family: 'harmony' },
	{ name: 'minor', family: 'harmony' },
	{ name: 'diminished', family: 'harmony' },
	{ name: 'suspended', family: 'harmony' },
	{ name: 'dominant7', family: 'harmony' },
	{ name: 'tension', family: 'harmony' },
	{ name: 'chordChange', family: 'harmony', impulse: true },
	{ name: 'root', family: 'harmony', signed: true },
	{ name: 'bassLevel', family: 'bass' },
	{ name: 'bassNote', family: 'bass', impulse: true },
	{ name: 'bassPitch', family: 'bass' },
	{ name: 'walking', family: 'bass' },
	{ name: 'legato', family: 'articulation' },
	{ name: 'sustain', family: 'articulation' },
	{ name: 'pad', family: 'articulation' },
	{ name: 'legatoHigh', family: 'articulation' },
	{ name: 'density', family: 'texture' },
	{ name: 'build', family: 'texture' },
	{ name: 'width', family: 'texture' },
	{ name: 'register', family: 'texture', signed: true },
	{ name: 'low', family: 'texture' },
	{ name: 'mid', family: 'texture' },
	{ name: 'high', family: 'texture' },
	{ name: 'trend', family: 'texture', signed: true }
];
const SRC = Object.fromEntries(SOURCES.map((s, i) => [s.name, i])) as Record<string, number>;

/** A parameter that may only listen to these families (first = preferred). */
function param(name: string, allow: readonly string[], options: Omit<ModParam, 'name' | 'prefers' | 'avoid'> = {}): ModParam {
	return {
		name,
		prefers: allow,
		avoid: SOURCES.filter((s) => !allow.includes(s.family ?? '')).map((s) => s.name),
		...options
	};
}

/** Each group's glow and width listen first to its own instrument. */
const GROUP_GLOW: readonly (readonly string[])[] = [
	['bass', 'kick', 'texture'],
	['kick', 'bass', 'groove'],
	['snare', 'groove', 'texture'],
	['perc', 'kick', 'groove'],
	['notes', 'harmony', 'articulation'],
	['hat', 'texture'],
	['harmony', 'notes', 'articulation'],
	['groove', 'hat', 'perc'],
	['articulation', 'snare', 'texture']
];
const GROUP_WIDTH: readonly (readonly string[])[] = [
	['bass'],
	['kick', 'bass'],
	['snare', 'texture'],
	['perc', 'texture'],
	['notes', 'articulation'],
	['hat', 'texture'],
	['harmony', 'articulation'],
	['groove', 'texture'],
	['articulation', 'texture']
];

const PARTS: readonly ModPart[] = [
	...LOOM_GROUP_NAMES.map((name, g) => ({
		name,
		params: [
			param('glow', GROUP_GLOW[g], { rest: 0.4, depth: 0.85 }),
			param('width', GROUP_WIDTH[g], { rest: 0.45, depth: 0.7, smooth: 0.05 }),
			param('slack', ['groove', 'articulation', 'texture'], { rest: 0.3, depth: 0.8, smooth: 0.8 }),
			param('hue', ['harmony', 'bass', 'articulation'], { rest: 0.5, depth: 0.7, smooth: 0.6 }),
			param('detail', g === 5 ? ['hat', 'texture'] : ['hat', 'perc', 'texture', 'articulation', 'notes'], {
				rest: 0.4,
				depth: 0.8,
				smooth: 0.08
			}),
			param('lean', ['groove', 'bass', 'texture'], { rest: 0.5, depth: 0.8, smooth: 0.8 })
		]
	})),
	{
		name: 'floor',
		params: [
			param('reflect', ['bass', 'texture', 'articulation'], { rest: 0.45, smooth: 0.5 }),
			param('pool', ['kick', 'bass', 'texture'], { rest: 0.4, smooth: 0.12 })
		]
	},
	{
		name: 'mist',
		params: [
			param('density', ['articulation', 'harmony', 'texture'], { rest: 0.45, smooth: 1.5 }),
			param('height', ['articulation', 'texture', 'bass'], { rest: 0.45, smooth: 2 }),
			param('scatter', ['notes', 'harmony', 'articulation'], { rest: 0.4, smooth: 0.4 }),
			param('stir', ['groove', 'texture'], { rest: 0.3, smooth: 1 })
		]
	},
	// The air answers the melody and the harmony, so the stage keeps moving
	// when the drums drop out.
	{ name: 'dust', params: [param('glint', ['notes', 'harmony', 'articulation'], { rest: 0.35, depth: 0.9 })] },
	{
		name: 'threads',
		params: [
			param('gain', ['harmony', 'articulation', 'notes'], { rest: 0.45, smooth: 0.3 }),
			param('sway', ['groove', 'texture'], { rest: 0.4, smooth: 1 })
		]
	},
	{
		name: 'light',
		params: [
			param('warmth', ['harmony'], { rest: 0.5, depth: 0.7, smooth: 2 }),
			param('fill', ['harmony', 'texture'], { rest: 0.5, depth: 0.6, smooth: 2 }),
			param('azimuth', ['texture', 'harmony'], { rest: 0.5, depth: 0.6, smooth: 4 })
		]
	},
	{
		name: 'camera',
		params: [
			param('dolly', ['texture', 'groove'], { rest: 0.5, depth: 0.7, smooth: 3 }),
			param('yaw', ['texture', 'bass'], { rest: 0.5, depth: 0.7, smooth: 4 }),
			param('height', ['bass', 'texture'], { rest: 0.5, depth: 0.6, smooth: 4 }),
			param('focal', ['texture', 'groove'], { rest: 0.5, depth: 0.6, smooth: 4 })
		]
	}
];
const GROUP_PARAMS = 6;
const ENV_OFFSET = LOOM_GROUPS * GROUP_PARAMS;

type VoiceEvent = { s: number; strength: number; offbeat: boolean };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

function hash(a: number, b: number, c: number): number {
	let h = 0x9e3779b1 ^ Math.imul(a | 0, 0x85ebca6b);
	h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
	h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 13;
	return (h >>> 0) / 0x100000000;
}

/** Camera offsets the renderer lays over the look's roaming camera. */
export type LoomEnsembleCamera = { dolly: number; yaw: number; pitch: number; focal: number };

export type LoomEnsembleInput = {
	/** Journey identity (0..1); seeds the matrix and the group mirrors once. */
	identity: number;
	/** 0 playing .. 1 silent (the renderer's smoothed silence). */
	silence: number;
	/** Weight of the shuttle beat form (look.beat[3]): snare turnarounds also throw it. */
	shuttleForm: number;
	/** The music's flow rate (look.weave.flow, tempo): the slow container for every group's pace. */
	flow?: number;
};

export class LoomEnsemble {
	/** The `parts` storage buffer, vec4 per entry (LOOM_PART_VEC4S). */
	readonly parts = new Float32Array(LOOM_PART_VEC4S * 4);
	readonly camera: LoomEnsembleCamera = { dolly: 0, yaw: 0, pitch: 0, focal: 0 };
	private matrix: ModMatrix | null = null;
	private seed = 0;
	private readonly channels = new Float32Array(SOURCES.length);
	private primed = false;
	private time = 0;
	// Serials last answered.
	private readonly layerSerial = new Float64Array(5);
	private chordSerial = 0;
	private bassSerial = 0;
	private fillSerial = 0;
	private dropoutSerial = 0;
	private returnSerial = 0;
	private shiftSerial = 0;
	// Routing: group g plays voiceFrom[g] crossfading to voiceTo[g].
	private readonly voiceFrom = new Int8Array(LOOM_GROUPS);
	private readonly voiceTo = new Int8Array(LOOM_GROUPS);
	private readonly voiceMix = new Float32Array(LOOM_GROUPS);
	private swapIn = 30;
	private swaps = 0;
	private readonly mirror = new Uint8Array(LOOM_GROUPS);
	// Events heard this tick, per voice.
	private readonly events: VoiceEvent[][] = LOOM_VOICES.map(() => []);
	private readonly eventPool: VoiceEvent[] = [];
	private eventsUsed = 0;
	// Packets: s, intensity, width, velocity per slot; and each slot's decay.
	private readonly packets = new Float32Array(LOOM_GROUPS * LOOM_PACKET_SLOTS * 4);
	private readonly packetTau = new Float32Array(LOOM_GROUPS * LOOM_PACKET_SLOTS).fill(0.3);
	/** Light still arriving in each slot, and how fast it arrives. */
	private readonly pending = new Float32Array(LOOM_GROUPS * LOOM_PACKET_SLOTS);
	private readonly packetAttack = new Float32Array(LOOM_GROUPS * LOOM_PACKET_SLOTS).fill(0.03);
	private readonly hit = new Float32Array(LOOM_GROUPS);
	/** Each group's recent hits per second (about 4 s). */
	private readonly rate = new Float32Array(LOOM_GROUPS);
	private readonly sparkle = new Float32Array(LOOM_GROUPS);
	private readonly sparkSeed = new Float32Array(LOOM_GROUPS);
	// Re-threading: crossing offset and phase per group, current and target.
	private readonly cross = new Float32Array(LOOM_GROUPS);
	private readonly crossGoal = new Float32Array(LOOM_GROUPS);
	private readonly phase = new Float32Array(LOOM_GROUPS);
	private readonly phaseGoal = new Float32Array(LOOM_GROUPS);
	private rethreads = 0;
	// Breakdown: groups withdraw one by one.
	private readonly presence = new Float32Array(LOOM_GROUPS).fill(1);
	private readonly withdrawAt = new Float32Array(LOOM_GROUPS).fill(-1);
	private breakdownOn = false;
	private breakdownArmed = true;
	private breakdownClock = 0;
	private breakdowns = 0;
	// Colour relation, cluster, lift (bass pitch).
	private readonly hue = new Float32Array(LOOM_GROUPS);
	private readonly cluster = new Float32Array(LOOM_GROUPS);
	private readonly slowGlow = new Float32Array(LOOM_GROUPS).fill(1);
	/** Each group's own wave phase and crawl (and the crawl's goal). */
	private readonly wave = new Float64Array(LOOM_GROUPS);
	private readonly crawl = new Float64Array(LOOM_GROUPS);
	private readonly crawlGoal = new Float64Array(LOOM_GROUPS);
	private readonly waveRate = new Float32Array(LOOM_GROUPS).fill(0.3);
	private readonly actMean = new Float32Array(LOOM_GROUPS).fill(0.3);
	/** The hero rail: whichever rail's instrument leads, handed over slowly. */
	private readonly lead = new Float32Array(3);
	private readonly hero = new Float32Array([0, 1, 0]);
	private heroRail = 1;
	private heroHeld = 0;
	private readonly slowWidth = new Float32Array(LOOM_GROUPS).fill(1);
	private lift = 0;
	// Shuttle pass.
	private shuttleT = 1;
	private shuttleDur = 1.5;
	private shuttleDir = 1;
	private shuttleGain = 0;
	private shuttleGroup = 2;
	private shuttles = 0;
	// Bass rail and floor rings.
	private pluckAmp = 0;
	private pluckMode = 2;
	private pluckPhase = 0;
	private walkPhase = 0;
	private walkAmp = 0;
	private ring = 0;
	private readonly rings = new Float32Array(8);
	// Far threads.
	private threadPluck = 0;
	private threadPhase = 0;
	private threadSector = 0;
	private sinceShift = 1e6;
	// Smoothed slow channels.
	private build = 0;
	private breakdown = 0;
	private width = 0.3;

	/**
	 * The renderer mounted again: answer only what happens from now on (the
	 * hits heard while Loom was away are not replayed as one burst).
	 */
	resume(): void {
		this.primed = false;
	}

	/** The rail leading now (0 low, 1 centre, 2 high). */
	get heroIndex(): number {
		return this.heroRail;
	}

	/** Which instrument each group plays now (diagnostics, HUD, tests). */
	voices(): string[] {
		return LOOM_GROUP_NAMES.map((_, g) => LOOM_VOICES[this.voiceMix[g] < 0.5 ? this.voiceFrom[g] : this.voiceTo[g]]);
	}

	/** The matrix's current routes (diagnostics). */
	routing() {
		return this.matrix?.routing() ?? [];
	}

	get counts() {
		return { swaps: this.swaps, rethreads: this.rethreads, breakdowns: this.breakdowns, shuttles: this.shuttles };
	}

	/** Per-group presence (1 playing, 0 withdrawn), for tests. */
	presenceOf(group: number): number {
		return this.presence[group] ?? 1;
	}

	update(
		e: Readonly<EnsembleFrame> | null | undefined,
		character: Readonly<MusicCharacter> | null | undefined,
		dtSeconds: number,
		input: LoomEnsembleInput
	): Float32Array {
		const dt = Math.max(0, Math.min(0.25, finite(dtSeconds)));
		this.time += dt;
		if (!this.matrix) this.init(input.identity);
		const matrix = this.matrix as ModMatrix;
		if (e && !this.primed) this.prime(e, character);
		const playing = 1 - clamp01(input.silence);
		this.sinceShift = character ? finite(character.sinceShift, 1e6) : 1e6;
		this.fillChannels(e, playing);
		let reroute = 0;
		if (character && character.shiftSerial !== this.shiftSerial) {
			reroute = character.shiftSerial > this.shiftSerial ? clamp01(character.shiftStrength) : 0;
			this.shiftSerial = character.shiftSerial;
		}
		const density = e ? clamp01(e.texture.density) : 0.3;
		const values = matrix.update(this.channels, dt, density, reroute);
		this.eventsUsed = 0;
		for (const list of this.events) list.length = 0;
		if (e && playing > 0.2) this.hear(e);
		this.route(dt, density);
		this.play(e, dt, input);
		this.harmony(e, dt);
		this.withdraw(e, dt);
		this.write(values, e, dt);
		return this.parts;
	}

	private init(identity: number): void {
		this.seed = Math.floor(clamp01(identity) * 0xffffff) >>> 0;
		this.matrix = new ModMatrix(SOURCES, PARTS, `loom-ensemble:${this.seed}`, { meanHold: 30, crossfade: 4 });
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			this.voiceFrom[g] = g;
			this.voiceTo[g] = g;
			this.voiceMix[g] = 1;
			this.mirror[g] = hash(this.seed, g, 0x31) < 0.5 ? 1 : 0;
		}
		this.swapIn = 20 + hash(this.seed, 0, 0x55) * 30;
	}

	/** Start answering events from now on (never replay what happened before mount). */
	private prime(e: Readonly<EnsembleFrame>, character: Readonly<MusicCharacter> | null | undefined): void {
		this.primed = true;
		const layers = [e.drums.kick, e.drums.snare, e.drums.hat, e.drums.perc, e.notes];
		layers.forEach((layer, i) => (this.layerSerial[i] = layer.serial));
		this.chordSerial = e.harmony.changeSerial;
		this.bassSerial = e.bass.noteSerial;
		this.fillSerial = e.groove.fillSerial;
		this.dropoutSerial = e.groove.dropoutSerial;
		this.returnSerial = e.groove.drumReturnSerial;
		if (character) this.shiftSerial = character.shiftSerial;
	}

	private fillChannels(e: Readonly<EnsembleFrame> | null | undefined, playing: number): void {
		const c = this.channels;
		if (!e) {
			c.fill(0);
			return;
		}
		const d = e.drums;
		const h = e.harmony;
		const q = h.qualities;
		c[SRC.kick] = d.kick.hit * playing;
		c[SRC.kickActivity] = d.kick.activity * playing;
		c[SRC.snare] = d.snare.hit * playing;
		c[SRC.snareActivity] = d.snare.activity * playing;
		c[SRC.hat] = d.hat.hit * playing;
		c[SRC.hatActivity] = d.hat.activity * playing;
		c[SRC.perc] = d.perc.hit * playing;
		c[SRC.percActivity] = d.perc.activity * playing;
		c[SRC.notes] = e.notes.hit * playing;
		c[SRC.notesActivity] = e.notes.activity * playing;
		c[SRC.noteRate] = clamp01(e.articulation.noteRate / (e.articulation.noteRate + 3));
		c[SRC.swing] = e.groove.swing;
		c[SRC.syncopation] = e.groove.syncopation;
		c[SRC.fill] = e.groove.fillIntensity * playing;
		c[SRC.breakdown] = e.groove.breakdown;
		c[SRC.drums] = e.groove.drums;
		const tonal = clamp01(h.confidence * 1.5);
		c[SRC.major] = (q[0] ?? 0) * tonal;
		c[SRC.minor] = (q[1] ?? 0) * tonal;
		c[SRC.diminished] = clamp01((q[2] ?? 0) + (q[3] ?? 0)) * tonal;
		c[SRC.suspended] = (q[4] ?? 0) * tonal;
		c[SRC.dominant7] = (q[5] ?? 0) * tonal;
		c[SRC.tension] = h.tension;
		c[SRC.chordChange] = h.change * playing;
		c[SRC.root] = h.root >= 0 ? Math.sin((h.root / 12) * Math.PI * 2) * tonal : 0;
		c[SRC.bassLevel] = e.bass.level * playing;
		c[SRC.bassNote] = e.bass.note * playing;
		c[SRC.bassPitch] = e.bass.pitchClass >= 0 ? e.bass.pitchClass / 11 : 0.5;
		c[SRC.walking] = e.bass.walking;
		c[SRC.legato] = e.articulation.legato;
		c[SRC.sustain] = e.articulation.sustain;
		c[SRC.pad] = e.articulation.pad;
		c[SRC.legatoHigh] = e.articulation.high;
		c[SRC.density] = e.texture.density;
		c[SRC.build] = e.texture.build;
		c[SRC.width] = e.texture.width;
		c[SRC.register] = e.texture.register;
		c[SRC.low] = e.texture.low * playing;
		c[SRC.mid] = e.texture.mid * playing;
		c[SRC.high] = e.texture.high * playing;
		c[SRC.trend] = e.texture.trend;
	}

	private event(voice: number, s: number, strength: number, offbeat: boolean): void {
		let ev = this.eventPool[this.eventsUsed];
		if (!ev) {
			ev = { s: 0, strength: 0, offbeat: false };
			this.eventPool.push(ev);
		}
		this.eventsUsed += 1;
		ev.s = s;
		ev.strength = strength;
		ev.offbeat = offbeat;
		this.events[voice].push(ev);
	}

	/** New hits, notes and chords this tick, as events per voice. */
	private hear(e: Readonly<EnsembleFrame>): void {
		const grid = clamp01(e.groove.confidence);
		const layers: readonly EnsembleLayer[] = [e.drums.kick, e.drums.snare, e.drums.hat, e.drums.perc, e.notes];
		const voices = [VOICE.kick, VOICE.snare, VOICE.hat, VOICE.perc, VOICE.notes];
		for (let i = 0; i < layers.length; i += 1) {
			const layer = layers[i];
			if (layer.serial === this.layerSerial[i]) continue;
			this.layerSerial[i] = layer.serial;
			// The strand is a bar of music: a hit sits where it fell in the bar.
			// Without a trusted grid, a hashed place along the thread.
			const pos = grid > 0.3 ? clamp01(layer.barPos) : hash(layer.serial, i, 0x77);
			const strength = Math.max(0.25, clamp01(layer.velocity)) * (0.75 + clamp01(layer.accent) * 0.5);
			const step = Math.round(finite(layer.step)) & 15;
			const onBeat = step % 4 === 0;
			this.event(voices[i], pos, strength, step % 4 === 2);
			// Offbeats: drums off the beat, hats on the "and" (where swing shows).
			if (i !== 4 && grid > 0.3 && ((i === 2 && step % 4 === 2) || (i !== 2 && !onBeat))) {
				this.event(VOICE.offbeat, pos, strength, true);
			}
			if (clamp01(layer.accent) > 0.45) this.event(VOICE.accent, pos, Math.min(1, strength * 1.2), !onBeat);
		}
		if (e.bass.noteSerial !== this.bassSerial) {
			this.bassSerial = e.bass.noteSerial;
			const pc = e.bass.pitchClass;
			const s = pc >= 0 ? pc / 11 : hash(e.bass.noteSerial, 5, 0x78);
			this.event(VOICE.bass, s, 0.55 + clamp01(e.bass.level) * 0.45, false);
			this.bassNote(e, s);
		}
		if (e.harmony.changeSerial !== this.chordSerial) {
			this.chordSerial = e.harmony.changeSerial;
			// A packet at each of the new chord's three strongest tones.
			const chroma = e.harmony.chroma;
			for (let n = 0; n < 3; n += 1) {
				let best = -1;
				let level = 0.25;
				for (let pc = 0; pc < 12; pc += 1) {
					const v = chroma[pc] ?? 0;
					if (v <= level) continue;
					let taken = false;
					for (const ev of this.events[VOICE.chord]) if (Math.abs(ev.s - pc / 11) < 1e-3) taken = true;
					if (!taken) {
						best = pc;
						level = v;
					}
				}
				if (best < 0) break;
				this.event(VOICE.chord, best / 11, 0.5 + level * 0.5, false);
			}
			this.rethread(e);
			// The far threads resonate with the new harmony, in the part of the
			// hall the chord's root points to.
			this.threadPluck = Math.max(this.threadPluck, 0.6 + clamp01(e.harmony.change) * 0.4);
			if (e.harmony.root >= 0) this.threadSector = (e.harmony.root / 12) * Math.PI * 2;
		}
		if (e.groove.fillSerial !== this.fillSerial) {
			this.fillSerial = e.groove.fillSerial;
			this.throwShuttle(e, 0.75 + clamp01(e.groove.fillIntensity) * 0.5);
		}
	}

	/** Now and then two groups trade instruments (crossfaded over a few seconds). */
	private route(dt: number, restless: number): void {
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			if (this.voiceMix[g] < 1) this.voiceMix[g] = Math.min(1, this.voiceMix[g] + dt / 5);
			if (this.voiceMix[g] >= 1) this.voiceFrom[g] = this.voiceTo[g];
		}
		this.swapIn -= dt * (0.7 + restless * 0.8);
		if (this.swapIn > 0) return;
		const ready = (g: number) => this.voiceMix[g] >= 1;
		this.swaps += 1;
		const a = Math.floor(hash(this.seed, this.swaps, 0x91) * LOOM_GROUPS);
		let b = Math.floor(hash(this.seed, this.swaps, 0x92) * (LOOM_GROUPS - 1));
		if (b >= a) b += 1;
		this.swapIn = 18 + -Math.log(Math.max(1e-6, hash(this.seed, this.swaps, 0x93))) * 26;
		if (!ready(a) || !ready(b)) return;
		const va = this.voiceTo[a];
		this.voiceTo[a] = this.voiceTo[b];
		this.voiceTo[b] = va;
		this.voiceMix[a] = 0;
		this.voiceMix[b] = 0;
	}

	/** Spawn packets for this tick's events, then let every packet glide and fade. */
	private play(e: Readonly<EnsembleFrame> | null | undefined, dt: number, input: LoomEnsembleInput): void {
		const swing = e ? clamp01(e.groove.swing) * clamp01(e.groove.confidence * 2) : 0;
		const art = e?.articulation;
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			const m = this.voiceMix[g];
			const mix = m * m * (3 - 2 * m);
			if (this.voiceTo[g] === this.voiceFrom[g]) this.spawn(g, this.voiceTo[g], 1, swing, art);
			else {
				this.spawn(g, this.voiceFrom[g], 1 - mix, swing, art);
				this.spawn(g, this.voiceTo[g], mix, swing, art);
			}
		}
		const P = this.packets;
		for (let i = 0; i < LOOM_GROUPS * LOOM_PACKET_SLOTS; i += 1) {
			const k = i * 4;
			// The light still arriving swells in; what has arrived fades.
			if (this.pending[i] > 0.01) {
				const rise = this.pending[i] * (1 - Math.exp(-dt / Math.max(0.01, this.packetAttack[i])));
				P[k + 1] += rise;
				this.pending[i] -= rise;
				if (this.pending[i] > 0.05) continue;
			} else this.pending[i] = 0;
			if (P[k + 1] <= 1e-4) {
				P[k + 1] = 0;
				continue;
			}
			P[k] += P[k + 3] * dt;
			P[k + 1] *= Math.exp(-dt / Math.max(0.05, this.packetTau[i]));
		}
		const flow = 0.6 + 0.4 * Math.max(0.3, Math.min(2.5, finite(input.flow ?? 1, 1)));
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			this.hit[g] *= Math.exp(-dt / 0.16);
			this.rate[g] *= Math.exp(-dt / 4);
			this.sparkle[g] *= Math.exp(-dt / 0.3);
			// Each group sways at the pace of its own instrument: busy parts
			// ripple, resting ones hang nearly still.
			const m = this.voiceMix[g];
			const act = e ? lerp(this.activity(e, this.voiceFrom[g]), this.activity(e, this.voiceTo[g]), m) : 0;
			// Relative to the song: an instrument that is busier than it has been
			// quickens its group; a steady pattern settles back to the group's
			// own pace, so every song uses the whole range, sparse or dense.
			// (Fast for a few seconds after new music, so a new song starts level.)
			this.actMean[g] += (act - this.actMean[g]) * (1 - Math.exp(-dt / (this.sinceShift < 4 ? 1.5 : 20)));
			const lively = Math.max(0, Math.min(1.5, (act - this.actMean[g]) * 3 + act * 0.35));
			this.waveRate[g] += (0.3 + lively * 0.6 - this.waveRate[g]) * (1 - Math.exp(-dt / 1.2));
			// Both wrap at whole turns of everything the shaders make of them.
			this.wave[g] = (this.wave[g] + this.waveRate[g] * flow * dt) % WAVE_WRAP;
			this.crawl[g] += (this.crawlGoal[g] - this.crawl[g]) * (1 - Math.exp(-dt / 0.12));
			if (this.crawl[g] > LOOM_CRAWL_WRAP) {
				this.crawl[g] -= LOOM_CRAWL_WRAP;
				this.crawlGoal[g] -= LOOM_CRAWL_WRAP;
			}
		}
		// The hero: the rail whose instrument has led for a while (the centre
		// rail by a little when it is close), held at least eight seconds.
		this.heroHeld += dt;
		let best = this.heroRail;
		for (let r = 0; r < 3; r += 1) {
			this.lead[r] *= Math.exp(-dt / 6);
			const score = (s: number) => this.lead[s] * (s === 1 ? 1.25 : 1);
			if (score(r) > score(best) * 1.35 + 0.3) best = r;
		}
		if (best !== this.heroRail && this.heroHeld > 8) {
			this.heroRail = best;
			this.heroHeld = 0;
		}
		for (let r = 0; r < 3; r += 1) {
			this.hero[r] += ((r === this.heroRail ? 1 : 0) - this.hero[r]) * (1 - Math.exp(-dt / 2.5));
		}
		// Shuttle: a fill throws it once across the weave.
		if (this.shuttleT < 1) this.shuttleT = Math.min(1, this.shuttleT + dt / this.shuttleDur);
		// The shuttle beat form also throws it on the bar's last snare.
		if (input.shuttleForm > 0.5) {
			for (const ev of this.events[VOICE.snare]) {
				if (ev.s > 0.7 && this.shuttleT > 0.7) this.throwShuttle(e ?? null, 0.5 * input.shuttleForm);
			}
		}
		// Bass rail pluck and walk, far-thread resonance.
		const legLow = art ? clamp01(art.low) : 0.5;
		this.pluckAmp *= Math.exp(-dt / lerp(0.3, 0.75, legLow));
		this.pluckPhase = (this.pluckPhase + dt * (5 + this.pluckMode * 1.7) * Math.PI * 2) % (Math.PI * 2);
		const walking = e ? clamp01(e.bass.walking) : 0;
		this.walkAmp += (walking - this.walkAmp) * (1 - Math.exp(-dt / 1.2));
		this.walkPhase = (this.walkPhase + dt * (0.8 + walking * 2.4)) % (Math.PI * 200);
		this.threadPluck *= Math.exp(-dt / 0.9);
		this.threadPhase = (this.threadPhase + dt * 6.3 * Math.PI * 2) % (Math.PI * 2);
		for (let r = 0; r < 2; r += 1) {
			this.rings[r * 4 + 2] += dt;
			this.rings[r * 4 + 3] *= Math.exp(-dt / 1.8);
		}
	}

	private spawn(
		g: number,
		voice: number,
		weight: number,
		swing: number,
		art: Readonly<EnsembleFrame['articulation']> | undefined
	): void {
		if (weight < 0.02) return;
		const list = this.events[voice];
		if (!list.length) return;
		// Legato stretches packets and lets them glide; staccato keeps them short.
		const legato = !art
			? 0.5
			: voice === VOICE.kick || voice === VOICE.bass
				? clamp01(art.low)
				: voice === VOICE.hat || voice === VOICE.offbeat
					? clamp01(art.high)
					: clamp01(art.legato);
		const P = this.packets;
		// A sparse hit is an event, a dense pattern is texture: each group's
		// packets dim as its instrument gets busier, so a busy section reads as
		// many small lights rather than the whole weave getting brighter, and a
		// sparse song still lights its threads as fully as a busy one.
		const density = Math.max(0.45, Math.min(1.05, 1.25 / Math.sqrt(0.5 + this.rate[g])));
		for (const ev of list) {
			this.rate[g] += 0.25 * weight;
			let slot = 0;
			let weakest = Infinity;
			for (let k = 0; k < LOOM_PACKET_SLOTS; k += 1) {
				const v = P[(g * LOOM_PACKET_SLOTS + k) * 4 + 1] + this.pending[g * LOOM_PACKET_SLOTS + k];
				if (v < weakest) {
					weakest = v;
					slot = k;
				}
			}
			const i = g * LOOM_PACKET_SLOTS + slot;
			const dir = this.mirror[g] ? -1 : 1;
			let s = this.mirror[g] ? 1 - ev.s : ev.s;
			// Swing staggers the offbeats a little further along their thread.
			if (ev.offbeat) s += dir * swing * 0.06;
			const hat = voice === VOICE.hat;
			P[i * 4] = 0.1 + 0.8 * clamp01(s);
			// The light arrives through the slot's attack: a staccato hit snaps
			// on, a legato note swells in.
			this.pending[i] = Math.max(this.pending[i], ev.strength * weight * density - P[i * 4 + 1]);
			// Drums strike: instant, short light. Tonal voices follow their
			// articulation: staccato snaps, legato swells in and lingers.
			const drum = DRUM_VOICES.has(voice);
			this.packetAttack[i] = drum ? 0.025 : lerp(0.03, 0.22, legato);
			P[i * 4 + 2] = (drum ? lerp(0.016, 0.04, legato) : lerp(0.02, 0.075, legato)) * (hat ? 0.55 : 1);
			P[i * 4 + 3] = dir * (ev.offbeat ? -1 : 1) * lerp(0.004, 0.09, legato);
			this.packetTau[i] = (drum ? lerp(0.08, 0.22, legato) : lerp(0.15, 0.7, legato)) * (hat ? 0.6 : 1);
			this.hit[g] = Math.max(this.hit[g], ev.strength * weight);
			if (g < 3) this.lead[g] += ev.strength * weight;
			// The thread's surface ticks forward on each of its own hits.
			this.crawlGoal[g] += ev.strength * weight;
			if (hat || voice === VOICE.offbeat) {
				this.sparkle[g] = Math.max(this.sparkle[g], ev.strength * weight);
				this.sparkSeed[g] = (this.sparkSeed[g] + 1) % 4096;
			}
		}
	}

	/** How busy a voice's instrument is, 0..1. */
	private activity(e: Readonly<EnsembleFrame>, voice: number): number {
		const d = e.drums;
		switch (voice) {
			case VOICE.bass:
				return clamp01(Math.max(e.bass.activity, e.bass.level * 0.5));
			case VOICE.kick:
				return clamp01(d.kick.activity);
			case VOICE.snare:
				return clamp01(d.snare.activity);
			case VOICE.perc:
				return clamp01(d.perc.activity);
			case VOICE.notes:
				return clamp01(Math.max(e.notes.activity, e.articulation.sustain * 0.5));
			case VOICE.hat:
				return clamp01(d.hat.activity);
			case VOICE.chord:
				// Pads keep the harmony group breathing between chord changes.
				return clamp01(Math.max(e.harmony.changesPerBar / 2, e.articulation.pad * 0.8));
			case VOICE.offbeat:
				return clamp01(e.groove.syncopation * 0.5 + d.hat.activity * 0.5);
			default:
				return clamp01((d.kick.activity + d.snare.activity) * 0.5);
		}
	}

	private bassNote(e: Readonly<EnsembleFrame>, s: number): void {
		const leap = Math.min(1, Math.abs(finite(e.bass.interval)) / 6);
		this.pluckAmp = Math.max(this.pluckAmp * 0.5, 0.35 + leap * 0.65);
		this.pluckMode = 1 + (Math.abs(Math.round(finite(e.bass.interval))) % 3);
		// Two rings alternate, so a new note never cuts off the last one's ring.
		this.ring = (this.ring + 1) % 2;
		const r = this.ring * 4;
		this.rings[r] = (s - 0.5) * 1.6;
		this.rings[r + 1] = (hash(e.bass.noteSerial, 9, 0x41) - 0.5) * 1.1;
		this.rings[r + 2] = 0;
		this.rings[r + 3] = 0.5 + clamp01(e.bass.level) * 0.6;
	}

	private throwShuttle(e: Readonly<EnsembleFrame> | null, gain: number): void {
		const bpm = e && e.grid.known ? clamp01((e.grid.bpm - 30) / 230) * 230 + 30 : 120;
		this.shuttles += 1;
		this.shuttleDir = -this.shuttleDir;
		this.shuttleT = 0;
		// About three beats across the whole weave.
		this.shuttleDur = Math.max(0.9, Math.min(2.4, (180 / bpm) * 1.0));
		this.shuttleGain = Math.min(1.2, gain);
		// A fill is a local cascade through one part: the group playing the
		// snare (or, every other fill, the perc), along its own threads.
		const voice = this.shuttles % 2 === 0 ? VOICE.perc : VOICE.snare;
		let group = this.voiceTo.indexOf(voice);
		if (group < 0) group = 2;
		this.shuttleGroup = group;
	}

	/** A chord change re-threads one weft group (alternating): its crossings and phase glide to the chord. */
	private rethread(e: Readonly<EnsembleFrame>): void {
		const root = e.harmony.root;
		if (root < 0) return;
		const g = 3 + (this.rethreads % 2);
		this.rethreads += 1;
		const q = e.harmony.qualities;
		const minor = q[1] ?? 0;
		const dim = (q[2] ?? 0) + (q[3] ?? 0);
		const sus = q[4] ?? 0;
		this.crossGoal[g] = (((root * 7) % 12) / 12) * 2.4 - 1.2 + dim * 1.2 - sus * 0.6 - minor * 0.3;
		this.phaseGoal[g] = (root / 12) * Math.PI + e.harmony.qualityIndex * 0.4;
	}

	private harmony(e: Readonly<EnsembleFrame> | null | undefined, dt: number): void {
		const q = e?.harmony.qualities;
		const tonal = e ? clamp01(e.harmony.confidence * 1.5) * clamp01(e.texture.tonality * 1.4) : 0;
		const major = (q?.[0] ?? 0) * tonal;
		const minor = (q?.[1] ?? 0) * tonal;
		const dim = (q?.[2] ?? 0) * tonal;
		const aug = (q?.[3] ?? 0) * tonal;
		const sus = (q?.[4] ?? 0) * tonal;
		const dom7 = (q?.[5] ?? 0) * tonal;
		// Major leans warm and opens; minor cools; augmented and dominant reach
		// further round; diminished clashes, alternate groups pulled apart.
		const warm = major * 0.035 - minor * 0.065 + dom7 * 0.045 + aug * 0.09;
		const kc = 1 - Math.exp(-dt / 0.9);
		this.build += ((e ? clamp01(e.texture.build) : 0) - this.build) * (1 - Math.exp(-dt / 1.5));
		this.width += ((e ? clamp01(e.texture.width) : 0.3) - this.width) * (1 - Math.exp(-dt / 1.5));
		// The chord group takes the new colour at once, the weft group the
		// chord re-threaded just after; the rest keep their palette colour, so
		// a chord change recolours one part, never the whole weave at once.
		const chordGroup = this.voiceTo.indexOf(VOICE.chord);
		const threaded = 3 + ((this.rethreads + 1) % 2);
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			const clash = dim * 0.1 * (g % 2 === 0 ? 1 : -1);
			const lead = g === chordGroup ? 1 : g === threaded ? 0.8 : 0;
			const goal = lead > 0 ? (warm + clash) * Math.max(lead, HARMONY_GAIN[g]) : 0;
			const tau = lead > 0 ? 0.45 / lead : 3;
			this.hue[g] += (goal - this.hue[g]) * (1 - Math.exp(-dt / tau));
			const chorus = g >= 5 ? 1 : 0;
			// A build gathers the chorus groups toward the middle one by one;
			// diminished chords cluster them; width and open chords spread them.
			const gather = Math.max(0, Math.min(1, (this.build - GATHER_AT[g]) / 0.25));
			const clusterGoal = chorus * (gather * 0.32 + dim * 0.22 - (this.width - 0.3) * 0.25 - (major + sus) * 0.05);
			this.cluster[g] += (Math.max(-0.2, Math.min(0.42, clusterGoal)) - this.cluster[g]) * kc;
			this.cross[g] += (this.crossGoal[g] - this.cross[g]) * (1 - Math.exp(-dt / 0.5));
			this.phase[g] += (this.phaseGoal[g] - this.phase[g]) * (1 - Math.exp(-dt / 0.5));
		}
		// The bass line moves the low rail: up and down with its pitch.
		const pc = e ? e.bass.pitchClass : -1;
		const conf = e ? clamp01(e.bass.confidence * 1.4) : 0;
		const liftGoal = pc >= 0 ? (pc / 11 - 0.5) * 2 * conf : this.lift * 0.98;
		this.lift += (liftGoal - this.lift) * (1 - Math.exp(-dt / 0.16));
	}

	/** Breakdowns: groups slacken and fall away one by one (drums first); a return brings them back. */
	private withdraw(e: Readonly<EnsembleFrame> | null | undefined, dt: number): void {
		if (!e) return;
		this.breakdown += (clamp01(e.groove.breakdown) - this.breakdown) * (1 - Math.exp(-dt / 0.4));
		let start = false;
		let stop = false;
		if (e.groove.dropoutSerial !== this.dropoutSerial) {
			this.dropoutSerial = e.groove.dropoutSerial;
			start = true;
		}
		if (e.groove.drumReturnSerial !== this.returnSerial) {
			this.returnSerial = e.groove.drumReturnSerial;
			stop = true;
		}
		// After a return the envelope must fall before it can start another.
		if (this.breakdown < 0.3) this.breakdownArmed = true;
		if (!this.breakdownOn && (start || (this.breakdownArmed && this.breakdown > 0.55))) {
			this.breakdownOn = true;
			this.breakdownClock = 0;
			this.breakdowns += 1;
			// Order: drum voices first, then the rest; ties hashed per breakdown.
			const order = Array.from({ length: LOOM_GROUPS }, (_, g) => g).sort((a, b) => {
				const da = DRUM_VOICES.has(this.voiceTo[a]) ? 0 : 1;
				const db = DRUM_VOICES.has(this.voiceTo[b]) ? 0 : 1;
				if (da !== db) return da - db;
				return hash(this.breakdowns, a, 0x21) - hash(this.breakdowns, b, 0x21);
			});
			this.withdrawAt.fill(-1);
			// The last three (harmony, bass, melody most often) keep playing.
			for (let i = 0; i < LOOM_GROUPS - 3; i += 1) this.withdrawAt[order[i]] = 0.35 + i * 0.75;
		} else if (this.breakdownOn && (stop || (this.breakdownClock > 4 && this.breakdown < 0.2))) {
			this.breakdownOn = false;
			this.breakdownArmed = false;
			this.breakdownClock = 0;
		}
		this.breakdownClock += dt;
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			const out = this.breakdownOn && this.withdrawAt[g] >= 0 && this.breakdownClock >= this.withdrawAt[g];
			// Coming back is quicker and staggered the other way round.
			const back = !this.breakdownOn && this.breakdownClock >= (this.withdrawAt[g] >= 0 ? (8 - this.withdrawAt[g]) * 0.03 : 0);
			const goal = out ? 0 : back || !this.breakdownOn ? 1 : this.presence[g];
			const tau = goal < this.presence[g] ? 1.3 : 0.45;
			this.presence[g] += (goal - this.presence[g]) * (1 - Math.exp(-dt / tau));
		}
	}

	private write(values: Float32Array, e: Readonly<EnsembleFrame> | null | undefined, dt: number): void {
		const out = this.parts;
		for (let g = 0; g < LOOM_GROUPS; g += 1) {
			const v = g * GROUP_PARAMS;
			const presence = this.presence[g];
			const a = g * LOOM_GROUP_VEC4S * 4;
			// A: glow, width, slack, hue.
			// A withdrawn group dims and hangs slack, swaying: still there, at rest.
			out[a] = (0.45 + values[v] * 1.3) * lerp(0.5, 1, presence);
			out[a + 1] = (0.7 + values[v + 1] * 0.65) * lerp(0.7, 1, presence);
			out[a + 2] = values[v + 2] * 0.35 + (1 - presence) * 0.7;
			out[a + 3] = this.hue[g] + (values[v + 3] - 0.5) * 0.08;
			// B: detail, lift, lean, sparkle.
			out[a + 4] = 0.3 + values[v + 4] * 1.4;
			out[a + 5] = g === 0 ? this.lift : 0;
			out[a + 6] = (values[v + 5] - 0.5) * 2;
			out[a + 7] = this.sparkle[g];
			// C: crossing offset, crossing phase, presence, hit.
			out[a + 8] = this.cross[g];
			out[a + 9] = this.phase[g];
			out[a + 10] = presence;
			out[a + 11] = this.hit[g];
			// D: cluster, spark seed, and the slow glow and width the far stage
			// is lit by (a rail's hits light only what is near it).
			const slow = 1 - Math.exp(-dt / 1.5);
			this.slowGlow[g] += (out[a] - this.slowGlow[g]) * slow;
			this.slowWidth[g] += (out[a + 1] - this.slowWidth[g]) * slow;
			out[a + 12] = this.cluster[g];
			out[a + 13] = this.sparkSeed[g];
			out[a + 14] = this.slowGlow[g];
			out[a + 15] = this.slowWidth[g];
			// E: wave phase and crawl, each at the pace of the group's instrument.
			out[a + 16] = this.wave[g];
			out[a + 17] = this.crawl[g];
			out[a + 18] = g < 3 ? this.hero[g] : 0;
			out[a + 19] = 0;
		}
		out.set(this.packets, LOOM_PART_PACKETS * 4);
		const env = (index: number, x: number, y: number, z: number, w: number) => {
			out[index * 4] = x;
			out[index * 4 + 1] = y;
			out[index * 4 + 2] = z;
			out[index * 4 + 3] = w;
		};
		let o = ENV_OFFSET;
		const next = () => values[o++];
		env(LOOM_PART.floor, 0.55 + next() * 0.9, 0.55 + next() * 1.0, 0, 0);
		const r = this.rings;
		env(LOOM_PART.ringA, r[0], r[1], r[2], r[3]);
		env(LOOM_PART.ringB, r[4], r[5], r[6], r[7]);
		const pad = e ? clamp01(e.articulation.pad) : 0;
		env(LOOM_PART.mist, 0.5 + next() * 1.0 + pad * 0.3, 0.7 + next() * 0.6, 0.6 + next() * 0.8, next() * 0.6);
		env(LOOM_PART.dust, 0.35 + next() * 1.6, 0, 0, 0);
		env(LOOM_PART.threads, 0.5 + next() * 1.0, this.threadPluck, this.threadPhase, 0.6 + next() * 1.2);
		// The strands' eye adapts over about ten seconds, but within a second or
		// two of new music, so a new look settles instead of drifting.
		const adapt = this.sinceShift < 8 ? 0.015 : 0.0017;
		env(LOOM_PART.light, (next() - 0.5) * 0.5, 0.7 + next() * 0.6, (next() - 0.5) * 0.15, adapt);
		const t = this.shuttleT;
		const along = t * t * (3 - 2 * t);
		const s = this.shuttleDir > 0 ? -0.08 + along * 1.16 : 1.08 - along * 1.16;
		env(LOOM_PART.shuttle, s, t < 1 ? Math.sin(Math.PI * t) ** 0.6 * this.shuttleGain : 0, 0.035, this.shuttleGroup);
		env(LOOM_PART.bass, this.pluckAmp, this.pluckMode, this.pluckPhase, this.walkAmp);
		env(LOOM_PART.bassWalk, this.walkPhase, 0, 0, 0);
		env(LOOM_PART.threadsB, this.threadSector, 0, 0, 0);
		// Camera: the matrix's slow offsets, plus a build gathering in and a
		// breakdown standing back. Small: the camera is the slow container.
		const k = 1 - Math.exp(-dt / 1.5);
		const dolly = (next() - 0.5) * 0.1 - this.build * 0.06 + this.breakdown * 0.07;
		const yaw = (next() - 0.5) * 0.12 + (this.width - 0.3) * 0.1;
		const pitch = (next() - 0.5) * 0.06;
		const focal = (next() - 0.5) * 0.08;
		const cam = this.camera;
		cam.dolly += (dolly - cam.dolly) * k;
		cam.yaw += (yaw - cam.yaw) * k;
		cam.pitch += (pitch - cam.pitch) * k;
		cam.focal += (focal - cam.focal) * k;
	}
}
