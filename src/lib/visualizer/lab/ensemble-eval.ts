// Score the ensemble listener against the ground truth of the synthesised
// test music (ensemble-signals.ts). Feature frames come from the lab's file
// path (WebAnalyzer, rendered offline) or from any other producer of
// AudioFeatureFrames, e.g. the native analyzer's dump; they run through a
// fresh journey exactly as live frames would.

import type { AudioFeatureFrame } from '$lib/visualizer/director/types';
import { VisualizerJourneyRuntime } from '$lib/visualizer/journey';
import { EnsembleTracker } from '$lib/visualizer/ensemble';
import type { EnsembleSignal } from './ensemble-signals';

export type TimedFrame = { atMs: number; features: AudioFeatureFrame };

export type EnsembleEval = {
	id: string;
	frames: number;
	bpm: number;
	/** Mean and worst cost of EnsembleTracker.update, ms per tick. */
	tickMs: number;
	tickMsMax: number;
	chords?: {
		changes: number;
		detected: number;
		/** Change events after the first chord whose root matched the new chord. */
		matched: number;
		latencyMs: number[];
		/** Share of mid-chord time with the right root / root and quality. */
		rootAccuracy: number;
		qualityAccuracy: number;
		key: string;
	};
	drums?: Record<'kick' | 'snare' | 'hat' | 'perc', { truth: number; hits: number; matched: number; latencyMs: number }>;
	swing?: { ratio: number; swing: number; expectedRatio: number };
	fills?: { truth: number; caught: number; falsePositives: number; latencyMs: number[] };
	articulation?: { legato: number; mid: number; sustain: number; pad: number };
	breakdown?: { dropouts: number[]; returns: number[]; dropoutLatencyMs: number[]; returnLatencyMs: number[]; breakdownMid: number; drumsMid: number };
	timeline: Array<Record<string, number | string>>;
};

const QUALITY_LETTER: Record<string, string> = {
	major: '',
	minor: 'm',
	diminished: 'dim',
	augmented: 'aug',
	suspended: 'sus',
	dominant7: '7',
	none: '-'
};
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function chordName(root: number, quality: string): string {
	return root < 0 ? '-' : `${NAMES[root]}${QUALITY_LETTER[quality] ?? '?'}`;
}

export function evaluateEnsemble(signal: EnsembleSignal, frames: readonly TimedFrame[]): EnsembleEval {
	const journey = new VisualizerJourneyRuntime(0.5, 0);
	journey.resetSource(`ensemble-eval:${signal.id}`, 0);
	const probe = new EnsembleTracker();
	const changes: { t: number; root: number; quality: string }[] = [];
	const fills: number[] = [];
	const dropouts: number[] = [];
	const returns: number[] = [];
	const layerHits: Record<string, number[]> = { kick: [], snare: [], hat: [], perc: [] };
	const serials: Record<string, number> = { kick: 0, snare: 0, hat: 0, perc: 0 };
	const samples: { t: number; root: number; quality: string; legato: number; mid: number; sustain: number; pad: number; breakdown: number; drums: number }[] = [];
	const timeline: EnsembleEval['timeline'] = [];
	let lastChange = 0;
	let lastFill = 0;
	let lastDrop = 0;
	let lastReturn = 0;
	let tickMs = 0;
	let tickMsMax = 0;
	let previousAt = 0;
	let bpm = 0;
	for (const { atMs, features } of frames) {
		const snapshot = journey.advance(features, atMs);
		const dt = (atMs - previousAt) / 1000;
		previousAt = atMs;
		// The cost of the tracker alone, on the same inputs.
		const t0 = performance.now();
		probe.update(features, snapshot.director, snapshot.spectrum, dt);
		const cost = performance.now() - t0;
		tickMs += cost;
		tickMsMax = Math.max(tickMsMax, cost);
		const e = snapshot.ensemble;
		const t = atMs / 1000;
		bpm = e.grid.bpm;
		if (e.harmony.changeSerial !== lastChange) {
			lastChange = e.harmony.changeSerial;
			changes.push({ t, root: e.harmony.root, quality: e.harmony.quality });
		}
		if (e.groove.fillSerial !== lastFill) {
			lastFill = e.groove.fillSerial;
			fills.push(t);
		}
		if (e.groove.dropoutSerial !== lastDrop) {
			lastDrop = e.groove.dropoutSerial;
			dropouts.push(t);
		}
		if (e.groove.drumReturnSerial !== lastReturn) {
			lastReturn = e.groove.drumReturnSerial;
			returns.push(t);
		}
		for (const name of ['kick', 'snare', 'hat', 'perc'] as const) {
			const layer = e.drums[name];
			if (layer.serial !== serials[name]) {
				serials[name] = layer.serial;
				layerHits[name].push(t);
			}
		}
		samples.push({
			t,
			root: e.harmony.root,
			quality: e.harmony.quality,
			legato: e.articulation.legato,
			mid: e.articulation.mid,
			sustain: e.articulation.sustain,
			pad: e.articulation.pad,
			breakdown: e.groove.breakdown,
			drums: e.groove.drums
		});
		if (timeline.length === 0 || t - Number(timeline[timeline.length - 1].t) >= 0.5) {
			timeline.push({
				t: Number(t.toFixed(2)),
				bpm: Number(e.grid.bpm.toFixed(1)),
				chord: chordName(e.harmony.root, e.harmony.quality),
				key: `${NAMES[e.harmony.key.tonic]}${e.harmony.key.mode === 'minor' ? 'm' : ''}`,
				swing: Number(e.groove.swingRatio.toFixed(2)),
				reg: Number(e.groove.regularity.toFixed(2)),
				fillI: Number(e.groove.fillIntensity.toFixed(2)),
				drums: Number(e.groove.drums.toFixed(2)),
				brk: Number(e.groove.breakdown.toFixed(2)),
				legato: Number(e.articulation.legato.toFixed(2)),
				bass: e.bass.pitchClass < 0 ? '-' : NAMES[e.bass.pitchClass],
				tension: Number(e.harmony.tension.toFixed(2))
			});
		}
	}
	const result: EnsembleEval = {
		id: signal.id,
		frames: frames.length,
		bpm,
		tickMs: tickMs / Math.max(1, frames.length),
		tickMsMax,
		timeline
	};

	if (signal.chords.length > 0) {
		const truth = signal.chords;
		const latency: number[] = [];
		let matched = 0;
		for (let k = 1; k < truth.length; k += 1) {
			const chord = truth[k];
			if (chord.root === truth[k - 1].root && chord.quality === truth[k - 1].quality) continue;
			const end = truth[k + 1]?.at ?? chord.at + 2;
			const hit = changes.find((c) => c.t >= chord.at - 0.05 && c.t < end && c.root === chord.root);
			if (hit) {
				matched += 1;
				latency.push(Math.round((hit.t - chord.at) * 1000));
			}
		}
		let rootOk = 0;
		let qualityOk = 0;
		let counted = 0;
		for (let k = 0; k < truth.length; k += 1) {
			const from = truth[k].at + 0.5;
			const to = (truth[k + 1]?.at ?? truth[k].at + 2) - 0.05;
			for (const s of samples) {
				if (s.t < from || s.t >= to) continue;
				counted += 1;
				if (s.root === truth[k].root) {
					rootOk += 1;
					if (s.quality === truth[k].quality) qualityOk += 1;
				}
			}
		}
		const last = journey.cachedSnapshot!.ensemble.harmony.key;
		result.chords = {
			changes: truth.length - 1,
			detected: changes.length,
			matched,
			latencyMs: latency,
			rootAccuracy: counted ? rootOk / counted : 0,
			qualityAccuracy: counted ? qualityOk / counted : 0,
			key: `${NAMES[last.tonic]} ${last.mode} (${last.major.toFixed(2)} major, stability ${last.stability.toFixed(2)})`
		};
	}

	if (signal.hits.length > 0) {
		const drums = {} as NonNullable<EnsembleEval['drums']>;
		for (const name of ['kick', 'snare', 'hat', 'perc'] as const) {
			const truth = signal.hits.filter((h) => h.layer === name);
			const used = new Set<number>();
			const lat: number[] = [];
			for (const h of truth) {
				const i = layerHits[name].findIndex((t, k) => !used.has(k) && t >= h.at - 0.02 && t <= h.at + 0.09);
				if (i >= 0) {
					used.add(i);
					lat.push((layerHits[name][i] - h.at) * 1000);
				}
			}
			lat.sort((a, b) => a - b);
			drums[name] = {
				truth: truth.length,
				hits: layerHits[name].length,
				matched: used.size,
				latencyMs: lat.length ? Math.round(lat[lat.length >> 1]) : 0
			};
		}
		result.drums = drums;
	}

	if (signal.swingPosition !== null) {
		const e = journey.cachedSnapshot!.ensemble;
		result.swing = {
			ratio: e.groove.swingRatio,
			swing: e.groove.swing,
			expectedRatio: signal.swingPosition / (1 - signal.swingPosition)
		};
	}

	if (signal.fills.length > 0 || signal.id === 'drums-straight' || signal.id === 'drums-swung') {
		const beat = 60 / signal.bpm;
		const caught = new Set<number>();
		const lat: number[] = [];
		let falsePositives = 0;
		for (const t of fills) {
			const k = signal.fills.findIndex((at) => t >= at - 0.1 && t <= at + 2 * beat + 0.1);
			if (k >= 0 && !caught.has(k)) {
				caught.add(k);
				lat.push(Math.round((t - signal.fills[k]) * 1000));
			} else if (k < 0) falsePositives += 1;
		}
		result.fills = { truth: signal.fills.length, caught: caught.size, falsePositives, latencyMs: lat };
	}

	if (signal.articulation !== null) {
		const tail = samples.filter((s) => s.t > samples[samples.length - 1].t * 0.5);
		const mean = (key: 'legato' | 'mid' | 'sustain' | 'pad') => tail.reduce((sum, s) => sum + s[key], 0) / Math.max(1, tail.length);
		result.articulation = { legato: mean('legato'), mid: mean('mid'), sustain: mean('sustain'), pad: mean('pad') };
	}

	if (signal.dropouts.length > 0) {
		const out = signal.dropouts[0];
		const back = signal.returns[0];
		const mid = samples.filter((s) => s.t > out + 4 && s.t < back - 0.5);
		const avg = (key: 'breakdown' | 'drums') => mid.reduce((sum, s) => sum + s[key], 0) / Math.max(1, mid.length);
		result.breakdown = {
			dropouts,
			returns,
			dropoutLatencyMs: dropouts.map((t) => Math.round((t - out) * 1000)),
			returnLatencyMs: returns.map((t) => Math.round((t - back) * 1000)),
			breakdownMid: avg('breakdown'),
			drumsMid: avg('drums')
		};
	}
	return result;
}
