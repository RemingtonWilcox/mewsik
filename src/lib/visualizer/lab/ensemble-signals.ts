// Deterministic test music for the ensemble listener. Each signal is real
// stereo PCM synthesised in code (no downloads) together with its ground
// truth: chord changes, drum hits, fills, articulation and drum drop-outs at
// known times. The browser specs render these through the lab's file path
// (WebAnalyzer in an OfflineAudioContext); scripts/ensemble-wavs.mjs writes
// the same signals to WAV files for the lab's file picker and the native
// analyzer.
//
// Self-contained on purpose (no $lib imports) so Node can load it directly.

export const ENSEMBLE_SIGNAL_RATE = 44_100;

export type ChordTruth = { at: number; root: number; quality: 'major' | 'minor' | 'diminished' };
export type DrumLayerName = 'kick' | 'snare' | 'hat' | 'perc';
export type DrumHitTruth = { at: number; layer: DrumLayerName; velocity: number };

export type EnsembleSignal = {
	id: EnsembleSignalId;
	description: string;
	sampleRate: number;
	left: Float32Array;
	right: Float32Array;
	bpm: number;
	/** Seconds at which the first beat lands. */
	startAt: number;
	chords: ChordTruth[];
	hits: DrumHitTruth[];
	/** Fill start times, seconds. */
	fills: number[];
	/** Offbeat eighth position within the beat (0.5 straight, 2/3 for 2:1 swing). */
	swingPosition: number | null;
	/** Drum drop-out and return times, seconds. */
	dropouts: number[];
	returns: number[];
	articulation: 'staccato' | 'legato' | null;
};

export const ENSEMBLE_SIGNAL_IDS = [
	'progression',
	'drums-straight',
	'drums-swung',
	'drums-fills',
	'line-staccato',
	'line-legato',
	'breakdown'
] as const;

export type EnsembleSignalId = (typeof ENSEMBLE_SIGNAL_IDS)[number];

const TAU = Math.PI * 2;
const NOTE_A4 = 440;

function midiHz(note: number): number {
	return NOTE_A4 * Math.pow(2, (note - 69) / 12);
}

/** xorshift32, so every noise burst is the same on every run. */
function rng(seed: number): () => number {
	let x = seed >>> 0 || 0x9e3779b9;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x1_0000_0000;
	};
}

class Mix {
	readonly left: Float32Array;
	readonly right: Float32Array;
	constructor(
		readonly sampleRate: number,
		seconds: number
	) {
		const length = Math.ceil(seconds * sampleRate);
		this.left = new Float32Array(length);
		this.right = new Float32Array(length);
	}

	/** Add `render(t)` over [start, start + length) seconds, panned -1..1. */
	add(start: number, length: number, pan: number, render: (t: number, i: number) => number): void {
		const from = Math.max(0, Math.round(start * this.sampleRate));
		const to = Math.min(this.left.length, Math.round((start + length) * this.sampleRate));
		const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
		const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
		for (let n = from; n < to; n += 1) {
			const t = (n - from) / this.sampleRate;
			const v = render(t, n - from);
			this.left[n] += v * gl;
			this.right[n] += v * gr;
		}
	}

	normalize(peak = 0.8): void {
		let max = 0;
		for (let n = 0; n < this.left.length; n += 1) {
			max = Math.max(max, Math.abs(this.left[n]), Math.abs(this.right[n]));
		}
		if (max <= 0) return;
		const g = peak / max;
		for (let n = 0; n < this.left.length; n += 1) {
			this.left[n] *= g;
			this.right[n] *= g;
		}
	}
}

// ---- Instruments ----------------------------------------------------------

/** A harmonic tone with an attack/decay/release envelope. */
function tone(
	mix: Mix,
	at: number,
	note: number,
	length: number,
	opts: { gain: number; pan?: number; decay?: number; release?: number; attack?: number; bright?: number }
): void {
	const f = midiHz(note);
	const attack = opts.attack ?? 0.008;
	const release = opts.release ?? 0.03;
	const decay = opts.decay ?? 0;
	const bright = opts.bright ?? 1;
	const harmonics = Math.max(1, Math.min(8, Math.floor(9000 / f)));
	mix.add(at, length + release * 6, opts.pan ?? 0, (t) => {
		let env = t < attack ? t / attack : 1;
		if (decay > 0) env *= Math.exp(-(t - Math.min(t, attack)) / decay);
		if (t > length) env *= Math.exp(-(t - length) / release);
		if (env < 1e-5) return 0;
		let v = 0;
		for (let h = 1; h <= harmonics; h += 1) {
			v += Math.sin(TAU * f * h * t + h * 0.7) * Math.pow(h, -1.1 - (1 - bright));
		}
		return v * env * opts.gain;
	});
}

function kick(mix: Mix, at: number, velocity: number, seed: number): void {
	const noise = rng(seed);
	mix.add(at, 0.45, 0, (t) => {
		const phase = TAU * (45 * t + (105 * (1 - Math.exp(-t * 28))) / 28);
		const body = Math.sin(phase) * Math.exp(-t * 7);
		const click = t < 0.003 ? (noise() * 2 - 1) * (1 - t / 0.003) * 0.35 : 0;
		return (body + click) * velocity * 0.9;
	});
}

function snare(mix: Mix, at: number, velocity: number, seed: number): void {
	const noise = rng(seed);
	let lp = 0;
	let prev = 0;
	mix.add(at, 0.35, 0.05, (t) => {
		const white = noise() * 2 - 1;
		// One-pole high-pass then gentle low-pass: a 1–9 kHz noise burst.
		const hp = white - prev;
		prev = white;
		lp += (hp - lp) * 0.75;
		const body = (Math.sin(TAU * 185 * t) * 0.8 + Math.sin(TAU * 330 * t) * 0.4) * Math.exp(-t * 28);
		const rattle = lp * Math.exp(-t * 17) * 1.1;
		return (body + rattle) * velocity * 0.7;
	});
}

function hat(mix: Mix, at: number, velocity: number, seed: number, pan = 0.3): void {
	const noise = rng(seed);
	let x1 = 0;
	let x2 = 0;
	mix.add(at, 0.12, pan, (t) => {
		const white = noise() * 2 - 1;
		// Second difference: a steep high-pass, the energy lands above ~7 kHz.
		const hp = white - 2 * x1 + x2;
		x2 = x1;
		x1 = white;
		return hp * Math.exp(-t * 55) * velocity * 0.18;
	});
}

function tom(mix: Mix, at: number, velocity: number, pitch: number): void {
	mix.add(at, 0.4, -0.2, (t) => {
		const f = pitch * (1 + 0.35 * Math.exp(-t * 30));
		return Math.sin(TAU * f * t) * Math.exp(-t * 9) * velocity * 0.75;
	});
}

// ---- Chords ---------------------------------------------------------------

const TRIADS: Record<ChordTruth['quality'], readonly number[]> = {
	major: [0, 4, 7],
	minor: [0, 3, 7],
	diminished: [0, 3, 6]
};

/** Close voicing around middle C, with the root an octave below in the bass. */
function voiceChord(root: number, quality: ChordTruth['quality']): { notes: number[]; bass: number } {
	const notes = TRIADS[quality].map((interval) => {
		let note = 60 + ((root + interval) % 12);
		if (note > 67) note -= 12;
		return note;
	});
	const bass = 36 + (root % 12) + (root % 12 > 7 ? -12 : 0) + 12;
	return { notes, bass };
}

const PROGRESSION: readonly ChordTruth[] = [
	{ at: 0, root: 0, quality: 'major' },
	{ at: 0, root: 9, quality: 'minor' },
	{ at: 0, root: 5, quality: 'major' },
	{ at: 0, root: 7, quality: 'major' },
	{ at: 0, root: 11, quality: 'diminished' }
];

function padChord(mix: Mix, at: number, length: number, chord: ChordTruth, gain = 0.16): void {
	const { notes, bass } = voiceChord(chord.root, chord.quality);
	notes.forEach((note, i) =>
		tone(mix, at, note, length, { gain, pan: (i - 1) * 0.5, attack: 0.02, release: 0.05, bright: 0.6 })
	);
	tone(mix, at, bass, length, { gain: gain * 1.4, attack: 0.015, release: 0.05, bright: 0.4 });
}

// ---- Grooves --------------------------------------------------------------

type GrooveOpts = {
	bpm: number;
	start: number;
	bars: number;
	swing: number;
	fillEvery?: number;
	drumsOut?: (bar: number) => boolean;
	hits: DrumHitTruth[];
	fills: number[];
};

function drumGroove(mix: Mix, opts: GrooveOpts): void {
	const beat = 60 / opts.bpm;
	let seed = 1;
	for (let bar = 0; bar < opts.bars; bar += 1) {
		if (opts.drumsOut?.(bar)) continue;
		const barAt = opts.start + bar * 4 * beat;
		const fillBar = opts.fillEvery !== undefined && bar % opts.fillEvery === opts.fillEvery - 1;
		for (let b = 0; b < 4; b += 1) {
			const beatAt = barAt + b * beat;
			const inFill = fillBar && b >= 2;
			if (inFill) {
				if (b === 2) opts.fills.push(beatAt);
				// Sixteenth snares rising in velocity, toms on the last beat.
				for (let s = 0; s < 4; s += 1) {
					const at = beatAt + (s * beat) / 4;
					const velocity = 0.55 + 0.45 * ((b - 2) * 4 + s) / 7;
					if (b === 3 && s % 2 === 1) {
						tom(mix, at, velocity, s === 1 ? 160 : 110);
						opts.hits.push({ at, layer: 'perc', velocity });
					} else {
						snare(mix, at, velocity, (seed += 1));
						opts.hits.push({ at, layer: 'snare', velocity });
					}
				}
				continue;
			}
			if (b === 0 || b === 2) {
				kick(mix, beatAt, 1, (seed += 1));
				opts.hits.push({ at: beatAt, layer: 'kick', velocity: 1 });
			}
			if (b === 1 || b === 3) {
				snare(mix, beatAt, 0.95, (seed += 1));
				opts.hits.push({ at: beatAt, layer: 'snare', velocity: 0.95 });
			}
			hat(mix, beatAt, 0.9, (seed += 1));
			opts.hits.push({ at: beatAt, layer: 'hat', velocity: 0.9 });
			const offAt = beatAt + opts.swing * beat;
			hat(mix, offAt, 0.6, (seed += 1));
			opts.hits.push({ at: offAt, layer: 'hat', velocity: 0.6 });
		}
	}
}

function emptySignal(id: EnsembleSignalId, description: string, mix: Mix, bpm: number, startAt: number): EnsembleSignal {
	return {
		id,
		description,
		sampleRate: mix.sampleRate,
		left: mix.left,
		right: mix.right,
		bpm,
		startAt,
		chords: [],
		hits: [],
		fills: [],
		swingPosition: null,
		dropouts: [],
		returns: [],
		articulation: null
	};
}

/** A bassless sine pad under a groove keeps the drum tests musical. */
function quietBed(mix: Mix, start: number, seconds: number): void {
	tone(mix, start, 57, seconds, { gain: 0.035, attack: 0.3, release: 0.3, bright: 0.2, pan: -0.4 });
	tone(mix, start, 64, seconds, { gain: 0.03, attack: 0.3, release: 0.3, bright: 0.2, pan: 0.4 });
}

export function ensembleSignal(id: EnsembleSignalId, sampleRate = ENSEMBLE_SIGNAL_RATE): EnsembleSignal {
	const start = 0.5;
	switch (id) {
		case 'progression': {
			// C, Am, F, G, Bdim, one bar each at 120 bpm, twice.
			const bpm = 120;
			const barSeconds = (4 * 60) / bpm;
			const mix = new Mix(sampleRate, start + barSeconds * 10 + 1);
			const signal = emptySignal(id, 'C - Am - F - G - Bdim, one bar each at 120 bpm, twice', mix, bpm, start);
			for (let k = 0; k < 10; k += 1) {
				const chord = { ...PROGRESSION[k % PROGRESSION.length], at: start + k * barSeconds };
				padChord(mix, chord.at, barSeconds - 0.02, chord);
				signal.chords.push(chord);
			}
			mix.normalize();
			return signal;
		}
		case 'drums-straight':
		case 'drums-swung': {
			const bpm = 100;
			const bars = 16;
			const seconds = bars * 4 * (60 / bpm);
			const mix = new Mix(sampleRate, start + seconds + 1);
			const swing = id === 'drums-swung' ? 2 / 3 : 0.5;
			const signal = emptySignal(
				id,
				id === 'drums-swung' ? 'Kick/snare/hat loop at 100 bpm, offbeat hats swung 2:1' : 'Kick/snare/hat loop at 100 bpm, straight eighths',
				mix,
				bpm,
				start
			);
			quietBed(mix, start, seconds);
			drumGroove(mix, { bpm, start, bars, swing, hits: signal.hits, fills: signal.fills });
			signal.swingPosition = swing;
			mix.normalize();
			return signal;
		}
		case 'drums-fills': {
			const bpm = 120;
			const bars = 16;
			const seconds = bars * 4 * (60 / bpm);
			const mix = new Mix(sampleRate, start + seconds + 1);
			const signal = emptySignal(id, 'Loop at 120 bpm with a snare/tom fill over the last two beats of every 4th bar', mix, bpm, start);
			quietBed(mix, start, seconds);
			drumGroove(mix, { bpm, start, bars, swing: 0.5, fillEvery: 4, hits: signal.hits, fills: signal.fills });
			signal.swingPosition = 0.5;
			mix.normalize();
			return signal;
		}
		case 'line-staccato':
		case 'line-legato': {
			// The same eighth-note line, plucked short or held into the next note.
			const bpm = 110;
			const eighth = 60 / bpm / 2;
			const line = [60, 64, 67, 72, 67, 64, 62, 65, 69, 74, 69, 65, 59, 62, 67, 71];
			const notes = 64;
			const mix = new Mix(sampleRate, start + notes * eighth + 1);
			const staccato = id === 'line-staccato';
			const signal = emptySignal(id, staccato ? 'Eighth-note line at 110 bpm, plucked short' : 'The same line, held legato', mix, bpm, start);
			for (let k = 0; k < notes; k += 1) {
				const at = start + k * eighth;
				const note = line[k % line.length];
				if (staccato) tone(mix, at, note, 0.07, { gain: 0.3, decay: 0.05, release: 0.012, bright: 0.9 });
				else tone(mix, at, note, eighth, { gain: 0.3, attack: 0.012, release: 0.02, bright: 0.9 });
			}
			signal.articulation = staccato ? 'staccato' : 'legato';
			mix.normalize();
			return signal;
		}
		case 'breakdown': {
			// 8 bars of groove and chords, 8 bars of chords alone, 8 bars back.
			const bpm = 120;
			const bars = 24;
			const barSeconds = (4 * 60) / bpm;
			const mix = new Mix(sampleRate, start + bars * barSeconds + 1);
			const signal = emptySignal(id, 'Groove + chords, the drums drop out for bars 9-16, then return', mix, bpm, start);
			for (let bar = 0; bar < bars; bar += 1) {
				const chord = { ...PROGRESSION[bar % 4], at: start + bar * barSeconds };
				padChord(mix, chord.at, barSeconds - 0.02, chord, 0.09);
				signal.chords.push(chord);
			}
			drumGroove(mix, {
				bpm,
				start,
				bars,
				swing: 0.5,
				drumsOut: (bar) => bar >= 8 && bar < 16,
				hits: signal.hits,
				fills: signal.fills
			});
			signal.dropouts.push(start + 8 * barSeconds);
			signal.returns.push(start + 16 * barSeconds);
			signal.swingPosition = 0.5;
			mix.normalize();
			return signal;
		}
	}
}

/** 16-bit PCM stereo WAV bytes. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
	const frames = left.length;
	const bytes = new Uint8Array(44 + frames * 4);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + frames * 4, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, frames * 4, true);
	for (let n = 0; n < frames; n += 1) {
		view.setInt16(44 + n * 4, Math.round(Math.max(-1, Math.min(1, left[n])) * 32767), true);
		view.setInt16(46 + n * 4, Math.round(Math.max(-1, Math.min(1, right[n])) * 32767), true);
	}
	return bytes;
}
