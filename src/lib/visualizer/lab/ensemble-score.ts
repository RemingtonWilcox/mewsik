// The synthetic ensemble behind each lab music profile: chord progressions per
// section, a bass line, per-layer drum patterns (swing, phrase-end fills,
// breakdowns with the drums out) and the rhythm of tonal onsets. From it the
// lab synthesises the raw ensemble features a native frame carries (chroma,
// bass chroma, per-layer onset strengths), so the EnsembleTracker hears the
// same kinds of input in the lab as from real audio. Everything is a pure
// function of song position, so any window of the song is deterministic.
//
// The profile's existing synthetic fields (bins, rms, onset, chroma_key, ...)
// are not touched by this: the engines render exactly as before.

export type LabChordQuality = 'major' | 'minor' | 'diminished' | 'augmented' | 'suspended' | 'dominant7';

/** A chord held for a number of beats. */
export type LabChord = readonly [root: number, quality: LabChordQuality, beats: number];

/**
 * One bar of a drum layer as 16 sixteenths: '.' is a rest, '1'..'9' a hit of
 * that strength (/9), 'x' full strength.
 */
export type LabDrumBar = { kick: string; snare: string; hat: string; perc: string };

export type LabBassStyle = 'roots' | 'octaves' | 'walking' | 'pedal' | 'fifths' | 'none';
export type LabTonalStyle = 'pad' | 'strum' | 'stab' | 'comp' | 'arp' | 'swell' | 'none';

export type LabEnsembleSpec = {
	/** Progression per section label; `default` for the rest. */
	progressions: Readonly<Record<string, readonly LabChord[]>>;
	bass: LabBassStyle;
	/** Drum bar per section label (null = drums out); `default` for the rest. */
	drums: Readonly<Record<string, LabDrumBar | null>>;
	/** Offbeat eighth position within the beat: 0.5 straight, 2/3 triplet swing. */
	swing: number;
	/** A fill replaces the last `fillBeats` beats of every `fillEvery`-th bar (0 = none). */
	fillEvery: number;
	fillBeats: number;
	/** Sections where fills play. Empty = everywhere drums play. */
	fillSections?: readonly string[];
	tonal: LabTonalStyle;
	/** Pitched content at all (noise has none). */
	atonal?: boolean;
};

export type LabEnsembleEvent = { layer: 'kick' | 'snare' | 'hat' | 'perc' | 'tonal'; at: number; strength: number };

const TRIADS: Record<LabChordQuality, readonly number[]> = {
	major: [0, 4, 7],
	minor: [0, 3, 7],
	diminished: [0, 3, 6],
	augmented: [0, 4, 8],
	suspended: [0, 5, 7],
	dominant7: [0, 4, 7, 10]
};
const TONE_WEIGHT = [1, 0.8, 0.85, 0.65];

const bar = (kick: string, snare: string, hat: string, perc = '................'): LabDrumBar => ({ kick, snare, hat, perc });

/** The ensemble of each lab profile (keyed by profile id). */
export const LAB_ENSEMBLE_SPECS: Readonly<Record<string, LabEnsembleSpec>> = {
	// D major club: I-V-vi-IV, a diminished passing chord into the drop,
	// four on the floor, claps on 2 and 4, straight 16th hats, offbeat bass.
	club128: {
		progressions: {
			default: [[2, 'major', 4], [9, 'major', 4], [11, 'minor', 4], [7, 'major', 4]],
			build: [[11, 'minor', 4], [7, 'major', 4], [2, 'major', 4], [1, 'diminished', 4]],
			breakdown: [[11, 'minor', 8], [7, 'major', 8]]
		},
		bass: 'octaves',
		drums: {
			default: bar('x...x...x...x...', '....x.......x...', '3393339333933393', '..........3.....'),
			intro: bar('x...x...x...x...', '................', '..7...7...7...7.'),
			build: bar('x...x...x...x...', '..5.x.5...5.x.5.', '3393339333933393'),
			breakdown: null,
			outro: bar('x...x...x...x...', '................', '..7...7...7...7.')
		},
		swing: 0.5,
		fillEvery: 8,
		fillBeats: 2,
		fillSections: ['verse', 'build', 'drop'],
		tonal: 'stab'
	},
	// F minor hip-hop: Fm7-ish i, iv, a dominant VII7 and the relative major;
	// the bridge leans on ii-dim and V7. Boom-bap kick, swung hats (2:1),
	// a walking bass.
	swing86: {
		progressions: {
			default: [[5, 'minor', 4], [10, 'minor', 4], [3, 'dominant7', 4], [8, 'major', 4]],
			bridge: [[7, 'diminished', 4], [0, 'dominant7', 4], [5, 'minor', 8]]
		},
		bass: 'walking',
		drums: {
			default: bar('x.....x...x.....', '....x.......x...', '7.4.7.4.7.4.7.4.', '.......2.....2..'),
			intro: bar('x.........x.....', '................', '7.4.7.4.7.4.7.4.'),
			bridge: bar('x.........x.....', '....x.......x...', '................'),
			outro: null
		},
		swing: 2 / 3,
		fillEvery: 8,
		fillBeats: 1,
		tonal: 'comp'
	},
	// G major indie: I-V-vi-IV verse, IV-I-V-vi chorus, a suspended bridge;
	// live-band backbeat with a fill at the end of every 4th bar.
	indie118: {
		progressions: {
			default: [[7, 'major', 4], [2, 'major', 4], [4, 'minor', 4], [0, 'major', 4]],
			chorus: [[0, 'major', 4], [7, 'major', 4], [2, 'major', 4], [4, 'minor', 4]],
			bridge: [[9, 'minor', 4], [0, 'major', 4], [2, 'suspended', 2], [2, 'major', 2]]
		},
		bass: 'roots',
		drums: {
			default: bar('x.....x.x.......', '....x.......x...', '7.5.7.5.7.5.7.5.'),
			intro: bar('................', '................', '7.5.7.5.7.5.7.5.'),
			chorus: bar('x.....x.x.x.....', '....x.......x...', '9.6.9.6.9.6.9.6.', '..............3.'),
			bridge: bar('x.......x.......', '........x.......', '7...7...7...7...'),
			outro: bar('................', '................', '7.5.7.5.7.5.7.5.')
		},
		swing: 0.5,
		fillEvery: 4,
		fillBeats: 1,
		tonal: 'arp'
	},
	// A major ambient: long pads two bars a chord, an augmented line cliche
	// in the bridge, no drums at all.
	ambient64: {
		progressions: {
			default: [[9, 'major', 8], [6, 'minor', 8], [2, 'major', 8], [4, 'suspended', 8]],
			bridge: [[9, 'major', 8], [9, 'augmented', 8], [2, 'major', 8], [2, 'minor', 8]]
		},
		bass: 'pedal',
		drums: { default: null },
		swing: 0.5,
		fillEvery: 0,
		fillBeats: 0,
		tonal: 'pad'
	},
	// C major acoustic: I-vi-IV-V, a ii-V7-I with a diminished turn in the
	// bridge; strums and plucks, no kit, body slaps in the chorus.
	acoustic94: {
		progressions: {
			default: [[0, 'major', 4], [9, 'minor', 4], [5, 'major', 4], [7, 'major', 4]],
			chorus: [[5, 'major', 4], [7, 'major', 4], [0, 'major', 4], [9, 'minor', 4]],
			bridge: [[2, 'minor', 4], [7, 'dominant7', 4], [0, 'major', 4], [11, 'diminished', 4]]
		},
		bass: 'fifths',
		drums: {
			default: null,
			chorus: bar('................', '................', '................', '....6.......6...')
		},
		swing: 0.5,
		fillEvery: 0,
		fillBeats: 0,
		tonal: 'strum'
	},
	// Atonal noise: no chords; blast-beat 16th hats, a fill every 4 bars,
	// the drums drop out in the breakdown.
	noise172: {
		progressions: { default: [[11, 'minor', 16]] },
		bass: 'none',
		drums: {
			default: bar('x.......x.......', '....x.......x...', 'xxxxxxxxxxxxxxxx', 'x.x.x.x.x.x.x.x.'),
			intro: bar('x.......x.......', '................', 'x.x.x.x.x.x.x.x.'),
			breakdown: null
		},
		swing: 0.5,
		fillEvery: 4,
		fillBeats: 1,
		tonal: 'none',
		atonal: true
	},
	// Eb minor cinematic: i-VI-III-VII, a ii-dim to V7 in the build;
	// timpani downbeats, a snare roll building, taiko in the chorus.
	cinematic72: {
		progressions: {
			default: [[3, 'minor', 8], [11, 'major', 8], [6, 'major', 8], [1, 'major', 8]],
			build: [[11, 'major', 4], [1, 'major', 4], [5, 'diminished', 4], [10, 'dominant7', 4]],
			chorus: [[3, 'minor', 4], [11, 'major', 4], [6, 'major', 4], [1, 'major', 4]]
		},
		bass: 'pedal',
		drums: {
			default: bar('x.......x.......', '................', '................'),
			intro: null,
			build: bar('x.......x.......', '5.5.5.5.7.7.7.7.', '................', '...........4....'),
			chorus: bar('x.......x.......', '....x.......x...', '................', 'x..x..x.x..x..x.'),
			outro: null
		},
		swing: 0.5,
		fillEvery: 8,
		fillBeats: 2,
		fillSections: ['build', 'chorus'],
		tonal: 'swell'
	}
};

function strengthAt(pattern: string, step: number): number {
	const c = pattern.charCodeAt(step);
	if (c === 120) return 1; // 'x'
	if (c >= 49 && c <= 57) return (c - 48) / 9;
	return 0;
}

/** Seeded pseudo-random 0..1 from an integer. */
function hash01(n: number): number {
	let x = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
	x ^= x >>> 15;
	x = Math.imul(x, 0xc2b2ae35);
	x ^= x >>> 13;
	return (x >>> 0) / 0x1_0000_0000;
}

export type LabSection = { label: string; startS: number; endS: number };

/** Timing and lookup for one profile's ensemble. */
export class LabEnsembleScore {
	readonly beatS: number;
	/** First bar of each section (by its downbeat time). */
	private readonly sectionBars: number[];

	constructor(
		readonly spec: LabEnsembleSpec,
		readonly bpm: number,
		readonly keyPitchClass: number,
		readonly sections: readonly LabSection[]
	) {
		this.beatS = 60 / bpm;
		this.sectionBars = sections.map((s) => Math.ceil(s.startS / (this.beatS * 4) - 1e-9));
	}

	/** Index of the section that owns a bar (the one holding its downbeat). */
	sectionOfBar(barIndex: number): number {
		let found = 0;
		for (let i = 0; i < this.sectionBars.length; i += 1) if (barIndex >= this.sectionBars[i]) found = i;
		return found;
	}

	label(barIndex: number): string {
		return this.sections[this.sectionOfBar(barIndex)]?.label ?? 'default';
	}

	drumsFor(barIndex: number): LabDrumBar | null {
		const label = this.label(barIndex);
		const table = this.spec.drums;
		return label in table ? table[label] : (table.default ?? null);
	}

	/** The chord sounding at a beat (absolute beat count from the song start). */
	chordAt(beat: number): { root: number; quality: LabChordQuality; startBeat: number } {
		const barIndex = Math.floor(beat / 4);
		const section = this.sectionOfBar(barIndex);
		const label = this.sections[section]?.label ?? 'default';
		const progression = this.spec.progressions[label] ?? this.spec.progressions.default;
		const firstBeat = this.sectionBars[section] * 4;
		let length = 0;
		for (const [, , beats] of progression) length += beats;
		const into = (((beat - firstBeat) % length) + length) % length;
		let cursor = 0;
		for (const [root, quality, beats] of progression) {
			if (into < cursor + beats) return { root, quality, startBeat: beat - (into - cursor) };
			cursor += beats;
		}
		const [root, quality] = progression[0];
		return { root, quality, startBeat: beat - into };
	}

	/** Bass pitch class at a beat, or -1. */
	bassAt(beat: number): number {
		const chord = this.chordAt(beat);
		const root = chord.root;
		const beatInBar = ((Math.floor(beat) % 4) + 4) % 4;
		switch (this.spec.bass) {
			case 'none':
				return -1;
			case 'pedal':
				return this.keyPitchClass;
			case 'roots':
			case 'octaves':
				return root;
			case 'fifths':
				return beatInBar % 2 === 0 ? root : (root + 7) % 12;
			case 'walking': {
				// Root, up a step, the third, then a half step under the next chord.
				const next = this.chordAt(Math.floor(beat) + (4 - beatInBar)).root;
				const third = chord.quality === 'minor' || chord.quality === 'diminished' ? 3 : 4;
				return beatInBar === 0 ? root : beatInBar === 1 ? (root + 2) % 12 : beatInBar === 2 ? (root + third) % 12 : (next + 11) % 12;
			}
		}
	}

	/** Seconds of a sixteenth step inside a bar, with swing on the offbeats. */
	private stepTime(barIndex: number, step: number): number {
		const beat = barIndex * 4 + (step >> 2);
		const sub = step & 3;
		const s = this.spec.swing;
		const offset = sub === 0 ? 0 : sub === 1 ? s / 2 : sub === 2 ? s : s + (1 - s) / 2;
		return (beat + offset) * this.beatS;
	}

	private isFillBar(barIndex: number): boolean {
		const { fillEvery, fillSections } = this.spec;
		if (fillEvery <= 0) return false;
		const section = this.sectionOfBar(barIndex);
		const barInSection = barIndex - this.sectionBars[section];
		if (fillSections && fillSections.length > 0 && !fillSections.includes(this.sections[section]?.label ?? '')) return false;
		// The last bar of a section is always a phrase end too.
		const nextStart = this.sectionBars[section + 1];
		return barInSection % fillEvery === fillEvery - 1 || (nextStart !== undefined && barIndex === nextStart - 1);
	}

	/** Fill start times (seconds) in [fromS, toS), for tests. */
	fillsBetween(fromS: number, toS: number): number[] {
		const out: number[] = [];
		const first = Math.max(0, Math.floor(fromS / (this.beatS * 4)));
		const last = Math.floor(toS / (this.beatS * 4));
		for (let b = first; b <= last; b += 1) {
			if (!this.drumsFor(b) || !this.isFillBar(b)) continue;
			const at = this.stepTime(b, 16 - this.spec.fillBeats * 4);
			if (at >= fromS && at < toS) out.push(at);
		}
		return out;
	}

	/** Every hit in (fromS, toS], strongest per layer. */
	eventsBetween(fromS: number, toS: number, out: Map<LabEnsembleEvent['layer'], number>): void {
		out.clear();
		if (toS <= fromS) return;
		const barS = this.beatS * 4;
		const first = Math.max(0, Math.floor(fromS / barS));
		const last = Math.floor(toS / barS);
		const put = (layer: LabEnsembleEvent['layer'], strength: number) => {
			if (strength > (out.get(layer) ?? 0)) out.set(layer, strength);
		};
		for (let b = first; b <= last; b += 1) {
			const drums = this.drumsFor(b);
			const fill = drums !== null && this.isFillBar(b);
			const fillFrom = 16 - this.spec.fillBeats * 4;
			for (let step = 0; step < 16; step += 1) {
				const at = this.stepTime(b, step);
				if (at <= fromS || at > toS) continue;
				if (drums) {
					if (fill && step >= fillFrom) {
						// Sixteenth snares rising, toms on the offbeats, a kick to land.
						const rise = 0.55 + (0.45 * (step - fillFrom)) / Math.max(1, 15 - fillFrom);
						if (step % 2 === 1) put('perc', rise);
						else put('snare', rise);
						if (step === 15) put('kick', 0.9);
					} else {
						for (const layer of ['kick', 'snare', 'hat', 'perc'] as const) {
							const v = strengthAt(drums[layer], step);
							if (v > 0) put(layer, v);
						}
					}
				}
				const tonal = this.tonalAt(b, step);
				if (tonal > 0) put('tonal', tonal);
			}
		}
	}

	/** Tonal onset strength on a sixteenth (0 = none). */
	private tonalAt(barIndex: number, step: number): number {
		if (this.spec.atonal) return 0;
		const beat = barIndex * 4 + step / 4;
		const chord = this.chordAt(beat);
		const changes = step % 4 === 0 && Math.abs(chord.startBeat - beat) < 1e-6 ? 1 : 0;
		switch (this.spec.tonal) {
			case 'pad':
				return changes * 0.8;
			case 'swell':
				return changes ? 0.9 : step === 8 ? 0.4 : 0;
			case 'strum':
				// Strums on 1 and 3, a fingerpicked note on the and of 4.
				return changes ? 1 : step === 0 || step === 8 ? 0.85 : step === 14 ? 0.6 : 0;
			case 'stab':
				return changes ? 0.9 : step === 6 || step === 14 ? 0.7 : 0;
			case 'comp':
				return changes ? 0.9 : step === 6 ? 0.6 : 0;
			case 'arp':
				return step % 2 === 0 ? (changes ? 1 : 0.55) : 0;
			case 'none':
				return 0;
		}
	}

	/** Chroma and bass chroma at a position (seconds), max-normalised. */
	pitchAt(positionS: number, chroma: number[], bassChroma: number[], seed: number): void {
		const beat = positionS / this.beatS;
		const jitterKey = Math.floor(positionS * 20);
		if (this.spec.atonal) {
			for (let i = 0; i < 12; i += 1) {
				chroma[i] = 0.55 + 0.45 * hash01(seed + jitterKey * 13 + i);
				bassChroma[i] = 0.4 + 0.6 * hash01(seed + jitterKey * 17 + i + 100);
			}
			normalise(chroma);
			normalise(bassChroma);
			return;
		}
		const chord = this.chordAt(beat);
		for (let i = 0; i < 12; i += 1) chroma[i] = 0.04 + 0.05 * hash01(seed + jitterKey * 13 + i);
		TRIADS[chord.quality].forEach((interval, k) => {
			chroma[(chord.root + interval) % 12] += TONE_WEIGHT[k];
		});
		// The fifth's overtone, a little.
		chroma[(chord.root + 7) % 12] += 0.06;
		normalise(chroma);
		const bass = this.bassAt(beat);
		for (let i = 0; i < 12; i += 1) bassChroma[i] = bass < 0 ? 0 : 0.03 + 0.04 * hash01(seed + jitterKey * 17 + i + 100);
		if (bass >= 0) {
			bassChroma[bass] += 1;
			bassChroma[(bass + 7) % 12] += 0.2;
			normalise(bassChroma);
		}
	}
}

function normalise(values: number[]): void {
	let max = 0;
	for (const v of values) if (v > max) max = v;
	if (max <= 0) return;
	for (let i = 0; i < values.length; i += 1) values[i] = Math.round((values[i] / max) * 1000) / 1000;
}
