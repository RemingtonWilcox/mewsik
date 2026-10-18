// A visual genome: the set of authored parameters that decide what a renderer
// looks like (palette family, composition, camera regime, motif choice,
// densities, lighting...), walked through over the life of a stream so the
// picture keeps evolving instead of cycling a handful of looks.
//
// The audio stays in charge of *reaction* (beats, envelopes, spectrum). The
// genome is in charge of *variety*: it mutates at musical boundaries and glides
// between values, so a change always lands on a phrase or section edge and
// never as a jolt.
//
// Scales, from fastest to slowest:
//   phrase  - may mutate at every phrase boundary
//   section - mutates at every section change, and every SECTION_FALLBACK_PHRASES
//             phrases when a stream never reports one (live radio)
//   era     - big identity moves (palette family, environment) every few
//             sections, or every ERA_FALLBACK_PHRASES phrases
//
// Determinism: given the same seed and the same sequence of advance() inputs
// the genome produces the same values. It counts boundary *events* rather than
// reading absolute phrase indices, so a looping score or an hours-long radio
// stream keeps moving forward instead of replaying.

export type VariationScale = 'phrase' | 'section' | 'era';

export type ContinuousAxis = {
	kind: 'continuous';
	name: string;
	min: number;
	max: number;
	scale: VariationScale;
	/** Typical jump per mutation as a fraction of the range (0..1). */
	step: number;
	/** Chance that a boundary mutates this axis (0..1). Default 1. */
	chance?: number;
	/** Periodic axis (e.g. hue): wraps instead of reflecting at the bounds. */
	wrap?: boolean;
	/** Seconds to glide to a new target. */
	tau: number;
};

export type ChoiceAxis = {
	kind: 'choice';
	name: string;
	/** Number of options; values are integers 0..options-1. */
	options: number;
	scale: VariationScale;
	/** Chance that a boundary switches option (0..1). */
	chance: number;
	/** Do not return to any of the last `memory` options. */
	memory?: number;
	/** Seconds to crossfade from the previous option to the new one. */
	tau: number;
};

export type VariationAxis = ContinuousAxis | ChoiceAxis;

export type VariationInput = {
	/** Phrase counter from the conductor; any change counts as a boundary. */
	phraseIndex: number;
	/** Section identity (label or label+index); any change counts as a boundary. */
	sectionKey: string;
	/** 0..1 musical energy; bolder mutations when the music is loud. */
	energy: number;
	/** Seconds since the previous advance(). */
	dt: number;
};

/** A choice axis mid-crossfade: blend `from` -> `to` by `mix`. */
export type ChoiceState = { from: number; to: number; mix: number };

const SECTION_FALLBACK_PHRASES = 6;
const ERA_SECTIONS = 4;
const ERA_FALLBACK_PHRASES = 24;

function hash32(a: number, b: number, c: number, d: number): number {
	let h = 0x9e3779b1 ^ Math.imul(a | 0, 0x85ebca6b);
	h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
	h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
	h = Math.imul(h ^ (d | 0), 0x165667b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	h = Math.imul(h, 0x297a2d39);
	h ^= h >>> 15;
	return h >>> 0;
}

function unit(a: number, b: number, c: number, d: number): number {
	return hash32(a, b, c, d) / 0x100000000;
}

function seedWord(seed: number | string): number {
	if (typeof seed === 'number') return Math.floor((seed - Math.floor(seed)) * 0xffffffff) >>> 0;
	let h = 0x811c9dc5;
	for (const char of seed) {
		h ^= char.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

type ContinuousState = { axis: ContinuousAxis; target: number; current: number };
type ChoiceRuntime = { axis: ChoiceAxis; from: number; to: number; mix: number; history: number[] };

export class VariationGenome {
	private readonly axes: readonly VariationAxis[];
	private seed = 0;
	private continuous = new Map<string, ContinuousState>();
	private choices = new Map<string, ChoiceRuntime>();
	private lastPhrase: number | null = null;
	private lastSection: string | null = null;
	private phraseEvents = 0;
	private sectionEvents = 0;
	private eraEvents = 0;
	private phrasesSinceSection = 0;
	private phrasesSinceEra = 0;
	private sectionsSinceEra = 0;
	private mutationCount = 0;

	constructor(axes: readonly VariationAxis[], seed: number | string = 0) {
		const names = new Set<string>();
		for (const axis of axes) {
			if (names.has(axis.name)) throw new Error(`Duplicate variation axis "${axis.name}"`);
			names.add(axis.name);
		}
		this.axes = axes;
		this.reset(seed);
	}

	/** Start a new journey (new source, new song identity). */
	reset(seed: number | string): void {
		this.seed = seedWord(seed);
		this.continuous.clear();
		this.choices.clear();
		this.lastPhrase = null;
		this.lastSection = null;
		this.phraseEvents = 0;
		this.sectionEvents = 0;
		this.eraEvents = 0;
		this.phrasesSinceSection = 0;
		this.phrasesSinceEra = 0;
		this.sectionsSinceEra = 0;
		this.mutationCount = 0;
		this.axes.forEach((axis, index) => {
			const r = unit(this.seed, index, 0, 0x5eed);
			if (axis.kind === 'continuous') {
				const value = axis.min + r * (axis.max - axis.min);
				this.continuous.set(axis.name, { axis, target: value, current: value });
			} else {
				const option = Math.floor(r * axis.options) % axis.options;
				this.choices.set(axis.name, { axis, from: option, to: option, mix: 1, history: [option] });
			}
		});
	}

	/** Feed one frame of musical context. Mutations happen only on boundaries. */
	advance(input: VariationInput): void {
		const energy = Math.min(1, Math.max(0, Number.isFinite(input.energy) ? input.energy : 0));
		const dt = Math.min(0.5, Math.max(0, Number.isFinite(input.dt) ? input.dt : 0));

		const phraseChanged = this.lastPhrase !== null && input.phraseIndex !== this.lastPhrase;
		const sectionChanged = this.lastSection !== null && input.sectionKey !== this.lastSection;
		this.lastPhrase = input.phraseIndex;
		this.lastSection = input.sectionKey;

		if (phraseChanged) {
			this.phraseEvents += 1;
			this.phrasesSinceSection += 1;
			this.phrasesSinceEra += 1;
			this.mutate('phrase', this.phraseEvents, energy);
		}
		const sectionDue =
			sectionChanged || (phraseChanged && this.phrasesSinceSection >= SECTION_FALLBACK_PHRASES);
		if (sectionDue) {
			this.sectionEvents += 1;
			this.sectionsSinceEra += 1;
			this.phrasesSinceSection = 0;
			this.mutate('section', this.sectionEvents, energy);
		}
		const eraDue =
			(sectionDue && this.sectionsSinceEra >= ERA_SECTIONS) ||
			(phraseChanged && this.phrasesSinceEra >= ERA_FALLBACK_PHRASES);
		if (eraDue) {
			this.eraEvents += 1;
			this.sectionsSinceEra = 0;
			this.phrasesSinceEra = 0;
			this.mutate('era', this.eraEvents, energy);
		}

		for (const state of this.continuous.values()) {
			const k = 1 - Math.exp(-dt / Math.max(0.05, state.axis.tau));
			if (state.axis.wrap) {
				const range = state.axis.max - state.axis.min;
				let delta = (state.target - state.current) % range;
				if (delta > range / 2) delta -= range;
				if (delta < -range / 2) delta += range;
				state.current = this.wrapValue(state.axis, state.current + delta * k);
			} else {
				state.current += (state.target - state.current) * k;
			}
		}
		for (const state of this.choices.values()) {
			if (state.mix < 1) state.mix = Math.min(1, state.mix + dt / Math.max(0.05, state.axis.tau));
		}
	}

	/** Eased value of a continuous axis. */
	value(name: string): number {
		const state = this.continuous.get(name);
		if (!state) throw new Error(`Unknown continuous variation axis "${name}"`);
		return state.current;
	}

	/** Crossfade state of a choice axis; `mix` is smoothstepped. */
	choice(name: string): ChoiceState {
		const state = this.choices.get(name);
		if (!state) throw new Error(`Unknown choice variation axis "${name}"`);
		const m = state.mix;
		return { from: state.from, to: state.to, mix: m * m * (3 - 2 * m) };
	}

	/** All eased values (choices report their current target option). */
	snapshot(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [name, state] of this.continuous) out[name] = state.current;
		for (const [name, state] of this.choices) out[name] = state.to;
		return out;
	}

	/** Quantized target state, for variety tests: distinct strings = distinct looks. */
	signature(bins = 6): string {
		const parts: string[] = [];
		for (const state of this.continuous.values()) {
			const t = (state.target - state.axis.min) / Math.max(1e-9, state.axis.max - state.axis.min);
			parts.push(String(Math.min(bins - 1, Math.max(0, Math.floor(t * bins)))));
		}
		for (const state of this.choices.values()) parts.push(`c${state.to}`);
		return parts.join('.');
	}

	/**
	 * Mean per-axis distance between this genome's targets and another state
	 * captured with `targetVector()`: 0 = same look, 1 = every axis maximally
	 * different. Continuous axes use normalized (wrap-aware) distance, choice
	 * axes count 1 when they differ.
	 */
	distanceTo(other: readonly number[]): number {
		const mine = this.targetVector();
		let total = 0;
		this.axes.forEach((axis, index) => {
			const a = mine[index];
			const b = other[index] ?? a;
			if (axis.kind === 'choice') total += a === b ? 0 : 1;
			else {
				const d = Math.abs(a - b);
				total += axis.wrap ? Math.min(d, 1 - d) * 2 : d;
			}
		});
		return total / Math.max(1, this.axes.length);
	}

	/** Targets in axis order: continuous normalized to 0..1, choices as option ids. */
	targetVector(): number[] {
		return this.axes.map((axis) => {
			if (axis.kind === 'choice') return this.choices.get(axis.name)!.to;
			const state = this.continuous.get(axis.name)!;
			return (state.target - axis.min) / Math.max(1e-9, axis.max - axis.min);
		});
	}

	get mutations(): number {
		return this.mutationCount;
	}

	get boundaries(): { phrases: number; sections: number; eras: number } {
		return { phrases: this.phraseEvents, sections: this.sectionEvents, eras: this.eraEvents };
	}

	private wrapValue(axis: ContinuousAxis, value: number): number {
		const range = axis.max - axis.min;
		return axis.min + ((((value - axis.min) % range) + range) % range);
	}

	private mutate(scale: VariationScale, event: number, energy: number): void {
		const scaleId = scale === 'phrase' ? 1 : scale === 'section' ? 2 : 3;
		this.axes.forEach((axis, index) => {
			if (axis.scale !== scale) return;
			const gate = unit(this.seed, index, event, scaleId * 7 + 1);
			if (axis.kind === 'continuous') {
				if (gate > (axis.chance ?? 1)) return;
				const state = this.continuous.get(axis.name)!;
				const range = axis.max - axis.min;
				// Signed jump, bolder with energy, never tiny (a mutation that is
				// invisible is wasted variety).
				const r = unit(this.seed, index, event, scaleId * 7 + 2) * 2 - 1;
				const magnitude = (0.35 + 0.65 * Math.abs(r)) * axis.step * (0.7 + energy * 0.6);
				let next = state.target + Math.sign(r || 1) * magnitude * range;
				if (axis.wrap) {
					next = this.wrapValue(axis, next);
				} else {
					// Reflect at the bounds so the walk never sticks to an edge.
					if (next > axis.max) next = axis.max - (next - axis.max);
					if (next < axis.min) next = axis.min + (axis.min - next);
					next = Math.min(axis.max, Math.max(axis.min, next));
				}
				state.target = next;
				this.mutationCount += 1;
			} else {
				if (gate > axis.chance) return;
				const state = this.choices.get(axis.name)!;
				const memory = Math.min(axis.memory ?? 1, axis.options - 1);
				const recent = state.history.slice(-memory);
				const candidates: number[] = [];
				for (let option = 0; option < axis.options; option += 1) {
					if (!recent.includes(option)) candidates.push(option);
				}
				if (candidates.length === 0) return;
				const pick = candidates[Math.floor(unit(this.seed, index, event, scaleId * 7 + 3) * candidates.length) % candidates.length];
				// Retarget from wherever the current crossfade has got to.
				state.from = state.mix >= 0.5 ? state.to : state.from;
				state.to = pick;
				state.mix = 0;
				state.history.push(pick);
				if (state.history.length > 16) state.history.shift();
				this.mutationCount += 1;
			}
		});
	}
}

/**
 * How many distinct looks a genome can reach: the product of choice option
 * counts times the number of distinguishable steps on each continuous axis
 * (range / step). Used to sanity-check that a renderer's genome is rich enough.
 */
export function variationSpaceSize(axes: readonly VariationAxis[]): number {
	let size = 1;
	for (const axis of axes) {
		size *= axis.kind === 'choice' ? axis.options : Math.max(2, Math.round(1 / Math.max(0.01, axis.step)));
	}
	return size;
}
