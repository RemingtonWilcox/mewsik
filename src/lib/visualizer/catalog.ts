export const VISUALIZER_ENGINES = ['mk1', 'mk2', 'signal', 'loom'] as const;

export type VisualizerEngine = (typeof VISUALIZER_ENGINES)[number];

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
		description: 'An obsidian rose window; beats travel as light through jewel glass.',
		accent: '#e9d5ff',
		accentMuted: 'rgba(216, 180, 254, 0.46)'
	},
	mk2: {
		name: 'Soma',
		subtitle: 'Living fractal',
		role: 'Evolution',
		description: 'A bioluminescent deep-sea organism; beats travel as light along its body and tendrils.',
		accent: '#fde68a',
		accentMuted: 'rgba(251, 191, 36, 0.46)'
	},
	signal: {
		name: 'Signal',
		subtitle: 'Phosphor score',
		role: 'Flow',
		description: 'A night phosphor scope: an XY figure tuned to harmony, beat-swept channel traces and a spectral horizon.',
		accent: '#a7f3d0',
		accentMuted: 'rgba(52, 211, 153, 0.46)'
	},
	loom: {
		name: 'Loom',
		subtitle: 'Harmonic weave',
		role: 'Harmony',
		description: 'A lit ribbon manifold that reweaves its topology as harmony, phrases, and releases unfold.',
		accent: '#bfdbfe',
		accentMuted: 'rgba(96, 165, 250, 0.46)'
	}
};

// Per-engine tuning constants. These used to be the "Flow" column of a
// Calm/Flow/Surge response switch that never meaningfully changed the
// picture; the switch is gone and every engine runs its authored baseline.
export const VISUALIZER_TUNING = {
	mk1: { motion: 1, impact: 1, bloomThresholdOffset: 0, feedbackFadeOffset: 0 },
	mk2: { motion: 1, impact: 1, fog: 1, shafts: 1 },
	signal: { motion: 1, impact: 1, persistenceOffset: 0, stroke: 1, saturation: 1 },
	loom: { motion: 1, impact: 1, width: 1, glow: 1, bloomThresholdOffset: 0, feedbackFadeOffset: 0 }
} as const satisfies Record<VisualizerEngine, Record<string, number>>;

export function adjacentVisualizer(
	engine: VisualizerEngine,
	direction: 1 | -1
): VisualizerEngine {
	const index = VISUALIZER_ENGINES.indexOf(engine);
	return VISUALIZER_ENGINES[
		(index + direction + VISUALIZER_ENGINES.length) % VISUALIZER_ENGINES.length
	];
}
