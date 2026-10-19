export const VISUALIZER_ENGINES = ['mk1', 'mandala', 'mk2', 'signal', 'loom'] as const;

export type VisualizerEngine = (typeof VISUALIZER_ENGINES)[number];

/** How an engine is presented to a listener. `subtitle` and `description`
 * are listener-facing copy: evocative, never technical. */
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
		subtitle: 'Rose window',
		role: 'Impact',
		description: 'Beats travel as light through a turning rose window.',
		accent: '#e9d5ff',
		accentMuted: 'rgba(216, 180, 254, 0.46)'
	},
	mandala: {
		name: 'Mandala',
		subtitle: 'Endless vortex',
		role: 'Infinity',
		description: 'An endless flight through sacred geometry that folds in on itself forever.',
		accent: '#fda4af',
		accentMuted: 'rgba(251, 113, 133, 0.46)'
	},
	mk2: {
		name: 'Soma',
		subtitle: 'Deep-sea organism',
		role: 'Evolution',
		description: 'A deep-sea creature that glows and breathes with the song.',
		accent: '#fde68a',
		accentMuted: 'rgba(251, 191, 36, 0.46)'
	},
	signal: {
		name: 'Signal',
		subtitle: 'Phosphor scope',
		role: 'Flow',
		description: 'A phosphor scope that draws the music as living traces.',
		accent: '#a7f3d0',
		accentMuted: 'rgba(52, 211, 153, 0.46)'
	},
	loom: {
		name: 'Loom',
		subtitle: 'Woven light',
		role: 'Harmony',
		description: 'Ribbons of light that reweave themselves as the harmony shifts.',
		accent: '#bfdbfe',
		accentMuted: 'rgba(96, 165, 250, 0.46)'
	}
};

// Per-engine tuning constants. These used to be the "Flow" column of a
// Calm/Flow/Surge response switch that never meaningfully changed the
// picture; the switch is gone and every engine runs its authored baseline.
export const VISUALIZER_TUNING = {
	mk1: { motion: 1, impact: 1, bloomThresholdOffset: 0, feedbackFadeOffset: 0 },
	mandala: { motion: 1, impact: 1 },
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
