import type { AudioFeatureFrame } from '$lib/visualizer/director/types';
import type { TrackScore } from '$lib/visualizer/director/score';

export const SOMA_LAB_PROFILE_IDS = [
	'club128',
	'swing86',
	'indie118',
	'ambient64',
	'acoustic94',
	'noise172',
	'cinematic72'
] as const;

export type SomaLabProfileId = (typeof SOMA_LAB_PROFILE_IDS)[number];

export type SomaLabStage = {
	id: string;
	label: string;
	startMs: number;
	endMs: number;
	atMs: number;
};

type BandVector = readonly [
	sub: number,
	kick: number,
	body: number,
	mids: number,
	presence: number,
	air: number
];

type SectionInput = readonly [label: string, durationSeconds: number, energy: number];

type ProfileSpec = {
	id: SomaLabProfileId;
	label: string;
	description: string;
	bpm: number;
	beatConfidence: number;
	keyPitchClass: number;
	keyMode: 'major' | 'minor' | 'unknown';
	keyConfidence: number;
	bands: BandVector;
	transients: BandVector;
	rms: number;
	crest: number;
	spectralRate: number;
	sections: readonly SectionInput[];
	dropLabels?: readonly string[];
};

export type SomaLabProfile = {
	id: SomaLabProfileId;
	label: string;
	description: string;
	bpm: number;
	score: TrackScore;
	stages: readonly SomaLabStage[];
	defaultStage: string;
	frameAt(positionMs: number, seed?: string): AudioFeatureFrame;
};

const SAMPLE_RATE = 44_100;
const BIN_COUNT = 64;
const ENERGY_HZ = 2;

const PROFILE_SPECS: readonly ProfileSpec[] = [
	{
		id: 'club128',
		label: 'Club 128',
		description: 'Straight four-on-the-floor club track with a bright, major-key drop.',
		bpm: 128,
		beatConfidence: 0.96,
		keyPitchClass: 2,
		keyMode: 'major',
		keyConfidence: 0.9,
		bands: [0.82, 0.95, 0.38, 0.25, 0.36, 0.42],
		transients: [0.62, 1, 0.22, 0.12, 0.48, 0.78],
		rms: 0.38,
		crest: 1.75,
		spectralRate: 3.4,
		sections: [
			['intro', 12, 0.2],
			['verse', 24, 0.48],
			['build', 16, 0.74],
			['drop', 28, 0.98],
			['breakdown', 16, 0.34],
			['outro', 20, 0.16]
		],
		dropLabels: ['drop']
	},
	{
		id: 'swing86',
		label: 'Swing 86',
		description: 'Sub-heavy, sparse minor-key hip-hop pocket with a delayed offbeat.',
		bpm: 86,
		beatConfidence: 0.88,
		keyPitchClass: 5,
		keyMode: 'minor',
		keyConfidence: 0.82,
		bands: [0.98, 0.72, 0.7, 0.24, 0.13, 0.06],
		transients: [0.92, 0.78, 0.62, 0.2, 0.1, 0.05],
		rms: 0.3,
		crest: 2.8,
		spectralRate: 1.25,
		sections: [
			['intro', 12, 0.18],
			['verse', 32, 0.54],
			['chorus', 24, 0.76],
			['bridge', 20, 0.38],
			['outro', 20, 0.14]
		]
	},
	{
		id: 'indie118',
		label: 'Indie 118',
		description: 'Mid-forward live-band backbeat with guitar-like broadband movement.',
		bpm: 118,
		beatConfidence: 0.84,
		keyPitchClass: 7,
		keyMode: 'major',
		keyConfidence: 0.62,
		bands: [0.3, 0.5, 0.76, 0.9, 0.72, 0.34],
		transients: [0.28, 0.54, 0.7, 0.86, 0.82, 0.34],
		rms: 0.34,
		crest: 2.15,
		spectralRate: 2.45,
		sections: [
			['intro', 10, 0.22],
			['verse', 30, 0.5],
			['chorus', 28, 0.82],
			['bridge', 22, 0.45],
			['outro', 18, 0.2]
		]
	},
	{
		id: 'ambient64',
		label: 'Ambient 64',
		description: 'Slow tonal drone with long swells, almost no onsets, and soft air.',
		bpm: 64,
		beatConfidence: 0.4,
		keyPitchClass: 9,
		keyMode: 'major',
		keyConfidence: 0.94,
		bands: [0.16, 0.1, 0.5, 0.76, 0.4, 0.5],
		transients: [0.04, 0.03, 0.12, 0.2, 0.12, 0.2],
		rms: 0.2,
		crest: 1.18,
		spectralRate: 0.16,
		sections: [
			['intro', 20, 0.14],
			['verse', 34, 0.32],
			['bridge', 32, 0.48],
			['breakdown', 26, 0.2],
			['outro', 24, 0.08]
		]
	},
	{
		id: 'acoustic94',
		label: 'Acoustic 94',
		description: 'Sparse high-crest plucks and strums with clear mids and very little sub.',
		bpm: 94,
		beatConfidence: 0.78,
		keyPitchClass: 0,
		keyMode: 'major',
		keyConfidence: 0.92,
		bands: [0.07, 0.15, 0.68, 0.9, 0.72, 0.18],
		transients: [0.04, 0.12, 0.82, 1, 0.84, 0.24],
		rms: 0.19,
		crest: 4.4,
		spectralRate: 1.7,
		sections: [
			['intro', 12, 0.12],
			['verse', 32, 0.38],
			['chorus', 26, 0.62],
			['bridge', 22, 0.28],
			['outro', 18, 0.1]
		]
	},
	{
		id: 'noise172',
		label: 'Noise 172',
		description: 'Fast, atonal, high-flatness pressure with presence and air in constant motion.',
		bpm: 172,
		beatConfidence: 0.76,
		keyPitchClass: 11,
		keyMode: 'unknown',
		keyConfidence: 0.08,
		bands: [0.12, 0.24, 0.54, 0.84, 0.98, 0.96],
		transients: [0.1, 0.3, 0.54, 0.88, 1, 1],
		rms: 0.42,
		crest: 1.5,
		spectralRate: 8.2,
		sections: [
			['intro', 10, 0.3],
			['build', 18, 0.7],
			['drop', 30, 0.96],
			['breakdown', 18, 0.42],
			['outro', 16, 0.18]
		],
		dropLabels: ['drop']
	},
	{
		id: 'cinematic72',
		label: 'Cinematic 72',
		description: 'Minor-key orchestral arc from restrained body to a broad, luminous climax.',
		bpm: 72,
		beatConfidence: 0.9,
		keyPitchClass: 3,
		keyMode: 'minor',
		keyConfidence: 0.95,
		bands: [0.72, 0.52, 0.78, 0.82, 0.6, 0.5],
		transients: [0.86, 0.58, 0.7, 0.62, 0.48, 0.54],
		rms: 0.31,
		crest: 2.65,
		spectralRate: 0.72,
		sections: [
			['intro', 18, 0.12],
			['verse', 30, 0.34],
			['build', 24, 0.68],
			['chorus', 32, 0.94],
			['bridge', 24, 0.48],
			['outro', 24, 0.1]
		]
	}
] as const;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function wrap01(value: number): number {
	const wrapped = value - Math.floor(value);
	return wrapped < 0 ? wrapped + 1 : wrapped;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 1e-9));
	return t * t * (3 - 2 * t);
}

function stringHash(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function encodeAnalyzerMagnitude(magnitude: number): number {
	if (!Number.isFinite(magnitude) || magnitude <= 1e-7) return 0;
	return clamp01(Math.log10(clamp01(magnitude)) * 0.4 + 1);
}

function recentPulse(phase: number, eventPhase: number, sharpness: number): number {
	const elapsed = wrap01(phase - eventPhase);
	return Math.exp(-elapsed * sharpness);
}

type PulseFrame = {
	bands: BandVector;
	onset: boolean;
	activity: number;
};

function pulseFrame(spec: ProfileSpec, positionSeconds: number): PulseFrame {
	const beats = (positionSeconds * spec.bpm) / 60;
	const beatIndex = Math.floor(beats);
	const phase = wrap01(beats);
	const quarter = recentPulse(phase, 0, 20);
	const eighth = recentPulse(phase, 0.5, 28);
	const swung = recentPulse(phase, 0.62, 24);
	const sixteenth = Math.max(
		recentPulse(phase, 0.25, 34),
		recentPulse(phase, 0.5, 34),
		recentPulse(phase, 0.75, 34)
	);

	switch (spec.id) {
		case 'club128': {
			const hat = Math.max(eighth, sixteenth * 0.62);
			return {
				bands: [quarter, quarter, quarter * 0.28, hat * 0.18, hat * 0.7, hat],
				onset: quarter > 0.83 || eighth > 0.91,
				activity: Math.max(quarter, hat * 0.72)
			};
		}
		case 'swing86': {
			const kick = beatIndex % 2 === 0 ? quarter : quarter * 0.34;
			return {
				bands: [Math.max(kick, swung * 0.5), kick, Math.max(kick * 0.7, swung), swung * 0.28, swung * 0.12, 0],
				onset: kick > 0.86 || swung > 0.9,
				activity: Math.max(kick, swung * 0.8)
			};
		}
		case 'indie118': {
			const backbeat = beatIndex % 4 === 1 || beatIndex % 4 === 3 ? quarter : 0;
			const kick = beatIndex % 4 === 0 || beatIndex % 4 === 2 ? quarter : quarter * 0.3;
			return {
				bands: [kick * 0.35, kick, Math.max(kick * 0.66, backbeat * 0.52), backbeat, Math.max(backbeat * 0.8, eighth * 0.42), eighth * 0.34],
				onset: Math.max(kick, backbeat) > 0.84,
				activity: Math.max(kick, backbeat, eighth * 0.35)
			};
		}
		case 'ambient64': {
			const swell = 0.5 + Math.sin(positionSeconds * 0.16 + 0.7) * 0.5;
			const rareOnset = beatIndex % 8 === 0 && phase < 0.025;
			return {
				bands: [swell * 0.12, 0, swell * 0.4, swell * 0.72, swell * 0.34, swell * 0.58],
				onset: rareOnset,
				activity: swell * 0.24
			};
		}
		case 'acoustic94': {
			const strum = beatIndex % 2 === 0 ? quarter : 0;
			const finger = beatIndex % 4 === 3 ? eighth : 0;
			return {
				bands: [0, strum * 0.08, Math.max(strum * 0.66, finger * 0.48), Math.max(strum, finger * 0.82), Math.max(strum * 0.72, finger), finger * 0.2],
				onset: Math.max(strum, finger) > 0.84,
				activity: Math.max(strum, finger)
			};
		}
		case 'noise172': {
			const pressure = Math.max(quarter, sixteenth, eighth);
			return {
				bands: [quarter * 0.08, quarter * 0.24, pressure * 0.5, pressure * 0.82, pressure, pressure],
				onset: pressure > 0.86,
				activity: pressure
			};
		}
		case 'cinematic72': {
			const downbeat = beatIndex % 4 === 0 ? quarter : 0;
			const bow = 0.5 + Math.sin(positionSeconds * 0.72) * 0.5;
			return {
				bands: [downbeat, downbeat * 0.72, Math.max(downbeat * 0.5, bow * 0.55), bow * 0.62, bow * 0.42, bow * 0.38],
				onset: downbeat > 0.84,
				activity: Math.max(downbeat, bow * 0.34)
			};
		}
	}
}

function bandIndexForFrequency(frequency: number): number {
	if (frequency < 60) return 0;
	if (frequency < 150) return 1;
	if (frequency < 400) return 2;
	if (frequency < 2_000) return 3;
	if (frequency < 6_000) return 4;
	return 5;
}

function scoreEnergyAt(score: TrackScore, positionMs: number): number {
	const sample = clamp01(positionMs / Math.max(1, score.duration_ms)) * (score.energy_curve.length - 1);
	const low = Math.floor(sample);
	const high = Math.min(score.energy_curve.length - 1, low + 1);
	const amount = sample - low;
	return score.energy_curve[low] + (score.energy_curve[high] - score.energy_curve[low]) * amount;
}

function makeFrame(spec: ProfileSpec, score: TrackScore, positionMs: number, seed: string): AudioFeatureFrame {
	const boundedMs = Math.min(score.duration_ms, Math.max(0, positionMs));
	const positionSeconds = boundedMs / 1_000;
	const energy = scoreEnergyAt(score, boundedMs);
	const pulses = pulseFrame(spec, positionSeconds);
	const seedPhase = (stringHash(`${spec.id}:${seed}`) / 0x1_0000_0000) * Math.PI * 2;
	const beatPhase = wrap01((positionSeconds * spec.bpm) / 60);
	const magnitudes = new Array<number>(BIN_COUNT);
	let centroidNumerator = 0;
	let centroidDenominator = 0;
	const nyquist = SAMPLE_RATE / 2;
	const ratio = nyquist / 20;

	for (let index = 0; index < BIN_COUNT; index += 1) {
		const low = 20 * Math.pow(ratio, index / BIN_COUNT);
		const high = 20 * Math.pow(ratio, (index + 1) / BIN_COUNT);
		const center = Math.sqrt(low * high);
		const band = bandIndexForFrequency(center);
		const base = spec.bands[band];
		const transient = spec.transients[band] * pulses.bands[band];
		const slowTimbre =
			0.86 +
			Math.sin(positionSeconds * spec.spectralRate + index * 0.73 + seedPhase) * 0.09 +
			Math.sin(positionSeconds * spec.spectralRate * 0.37 + index * 1.91 + seedPhase * 0.4) * 0.05;
		const noiseRipple =
			spec.id === 'noise172'
				? 0.78 + Math.sin(index * 2.17 + positionSeconds * 13.4 + seedPhase) * 0.22
				: 1;
		const magnitude = clamp01(
			(0.002 + base * (0.035 + energy * 0.44) + transient * (0.06 + energy * 0.36)) *
				slowTimbre *
				noiseRipple
		);
		magnitudes[index] = magnitude;
		centroidNumerator += center * magnitude;
		centroidDenominator += magnitude;
	}

	const rawBass = spec.bands[0] * 0.28 + spec.bands[1] * 0.48 + spec.bands[2] * 0.24;
	const rawMid = spec.bands[2] * 0.2 + spec.bands[3] * 0.58 + spec.bands[4] * 0.22;
	const rawTreble = spec.bands[4] * 0.58 + spec.bands[5] * 0.42;
	const activityGain = 0.42 + energy * 0.58;
	const rms = clamp01(spec.rms * activityGain + pulses.activity * energy * 0.065);
	const peak = clamp01(rms * spec.crest + pulses.activity * 0.08);

	return {
		bins: magnitudes.map(encodeAnalyzerMagnitude),
		rms,
		peak,
		centroid: clamp01(
			centroidDenominator > 1e-8 ? centroidNumerator / centroidDenominator / nyquist : 0
		),
		onset: pulses.onset,
		bass: clamp01(rawBass * activityGain + pulses.bands[1] * 0.12),
		mid: clamp01(rawMid * activityGain + pulses.bands[3] * 0.1),
		treble: clamp01(rawTreble * activityGain + pulses.bands[5] * 0.1),
		sample_rate: SAMPLE_RATE,
		bpm: spec.bpm,
		beat_phase: beatPhase,
		chroma_key: spec.keyPitchClass / 12,
		chroma_strength: spec.keyConfidence
	};
}

function buildProfile(spec: ProfileSpec): SomaLabProfile {
	let cursorMs = 0;
	const scoreSections: TrackScore['sections'] = spec.sections.map(([label, seconds, energy]) => {
		const start_ms = cursorMs;
		const end_ms = start_ms + seconds * 1_000;
		cursorMs = end_ms;
		return { start_ms, end_ms, label, energy };
	});
	const durationMs = cursorMs;
	const energySampleCount = Math.floor((durationMs / 1_000) * ENERGY_HZ) + 1;
	const energyCurve = Array.from({ length: energySampleCount }, (_, index) => {
		const atMs = (index / ENERGY_HZ) * 1_000;
		const foundSection = scoreSections.findIndex(
			(section) => atMs >= section.start_ms && atMs < section.end_ms
		);
		const sectionIndex = foundSection >= 0 ? foundSection : scoreSections.length - 1;
		const section = scoreSections[sectionIndex] ?? scoreSections.at(-1)!;
		const next = scoreSections[sectionIndex + 1];
		if (!next) return section.energy;
		const transitionStart = section.end_ms - Math.min(8_000, (section.end_ms - section.start_ms) * 0.32);
		const blend = smoothstep(transitionStart, section.end_ms, atMs);
		return section.energy + (next.energy - section.energy) * blend;
	});
	const score: TrackScore = {
		version: 1,
		duration_ms: durationMs,
		bpm: spec.bpm,
		beat_offset_ms: 0,
		beat_confidence: spec.beatConfidence,
		key: {
			pitch_class: spec.keyPitchClass,
			mode: spec.keyMode,
			confidence: spec.keyConfidence
		},
		sections: scoreSections,
		drops: scoreSections
			.filter((section) => spec.dropLabels?.includes(section.label))
			.map((section) => ({ at_ms: section.start_ms, strength: section.energy })),
		energy_hz: ENERGY_HZ,
		energy_curve: energyCurve
	};
	const labelCounts = new Map<string, number>();
	const stages = scoreSections.map((section): SomaLabStage => {
		const count = (labelCounts.get(section.label) ?? 0) + 1;
		labelCounts.set(section.label, count);
		const id = count === 1 ? section.label : `${section.label}-${count}`;
		const duration = section.end_ms - section.start_ms;
		return {
			id,
			label: count === 1 ? section.label : `${section.label} ${count}`,
			startMs: section.start_ms,
			endMs: section.end_ms,
			atMs: section.start_ms + Math.min(2_000, duration * 0.18)
		};
	});

	return {
		id: spec.id,
		label: spec.label,
		description: spec.description,
		bpm: spec.bpm,
		score,
		stages,
		defaultStage: stages.find((stage) => stage.id === 'verse')?.id ?? stages[0].id,
		frameAt(positionMs: number, seed = 'soma-qa') {
			return makeFrame(spec, score, positionMs, seed);
		}
	};
}

export const SOMA_LAB_PROFILES: Readonly<Record<SomaLabProfileId, SomaLabProfile>> =
	Object.fromEntries(PROFILE_SPECS.map((spec) => [spec.id, buildProfile(spec)])) as Record<
		SomaLabProfileId,
		SomaLabProfile
	>;

export function isSomaLabProfileId(value: string | null | undefined): value is SomaLabProfileId {
	return SOMA_LAB_PROFILE_IDS.includes(value as SomaLabProfileId);
}

export function getSomaLabProfile(value: string | null | undefined): SomaLabProfile {
	return SOMA_LAB_PROFILES[isSomaLabProfileId(value) ? value : 'club128'];
}

export function getSomaLabStage(profile: SomaLabProfile, value: string | null | undefined): SomaLabStage {
	return (
		profile.stages.find((stage) => stage.id === value) ??
		profile.stages.find((stage) => stage.id === profile.defaultStage) ??
		profile.stages[0]
	);
}
