export const VISUALIZER_ENGINES = ['mk1', 'mk2', 'signal'] as const;

export type VisualizerEngine = (typeof VISUALIZER_ENGINES)[number];

export const VISUALIZER_RESPONSES = ['still', 'flow', 'surge'] as const;

export type VisualizerResponse = (typeof VISUALIZER_RESPONSES)[number];

export type VisualizerIdentity = {
	name: string;
	subtitle: string;
	role: string;
	description: string;
	accent: string;
	accentMuted: string;
};

export const VISUALIZER_CATALOG: Record<VisualizerEngine, VisualizerIdentity> = {
	mk1: {
		name: 'Prism',
		subtitle: 'Rhythmic geometry',
		role: 'Impact',
		description: 'Crisp mirrored architecture that turns beats and harmony into immediate motion.',
		accent: '#e9d5ff',
		accentMuted: 'rgba(216, 180, 254, 0.46)'
	},
	mk2: {
		name: 'Soma',
		subtitle: 'Living fractal',
		role: 'Evolution',
		description: 'A cinematic organism that grows, sheds, relights, and changes perspective across the song.',
		accent: '#fde68a',
		accentMuted: 'rgba(251, 191, 36, 0.46)'
	},
	signal: {
		name: 'Signal',
		subtitle: 'Phosphor score',
		role: 'Flow',
		description: 'A continuous instrument trace that draws spectrum, rhythm, harmony, and song structure.',
		accent: '#a7f3d0',
		accentMuted: 'rgba(52, 211, 153, 0.46)'
	}
};

export const VISUALIZER_RESPONSE_LABELS: Record<VisualizerResponse, string> = {
	still: 'Calm',
	flow: 'Flow',
	surge: 'Surge'
};

// Shared response profiles keep the UI modes honest across renderers. Flow is
// deliberately the exact authored baseline (unit multipliers, zero offsets),
// while Still and Surge only scale intensity around that identity.
export const VISUALIZER_RESPONSE_PROFILES = {
	mk1: {
		still: { motion: 0.64, impact: 0.62, bloomThresholdOffset: 0.12, feedbackFadeOffset: -0.025 },
		flow: { motion: 1, impact: 1, bloomThresholdOffset: 0, feedbackFadeOffset: 0 },
		surge: { motion: 1.22, impact: 1.18, bloomThresholdOffset: -0.1, feedbackFadeOffset: 0.02 }
	},
	mk2: {
		still: { motion: 0.68, impact: 0.62, fog: 0.9, shafts: 0.84 },
		flow: { motion: 1, impact: 1, fog: 1, shafts: 1 },
		surge: { motion: 1.15, impact: 1.18, fog: 1.08, shafts: 1.1 }
	},
	signal: {
		still: { motion: 0.76, impact: 0.62, persistenceOffset: -0.018, stroke: 0.82, saturation: 0.88 },
		flow: { motion: 1, impact: 1, persistenceOffset: 0, stroke: 1, saturation: 1 },
		surge: { motion: 1.12, impact: 1.18, persistenceOffset: 0.01, stroke: 1.1, saturation: 1.06 }
	}
} as const satisfies Record<VisualizerEngine, Record<VisualizerResponse, Record<string, number>>>;

export function adjacentVisualizer(
	engine: VisualizerEngine,
	direction: 1 | -1
): VisualizerEngine {
	const index = VISUALIZER_ENGINES.indexOf(engine);
	return VISUALIZER_ENGINES[
		(index + direction + VISUALIZER_ENGINES.length) % VISUALIZER_ENGINES.length
	];
}
