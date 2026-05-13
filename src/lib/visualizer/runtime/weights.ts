// Section-driven motif weight policy. Replaces the "swap one component"
// model with continuous parameter morphs: every motif always runs (so trails
// and feedback don't snap), but each contributes to the final HDR target at
// a weight derived from the director's high-level intent.
//
// Vocabularies:
//   atmosphere — backdrop gradient. Always on.
//   physarum   — blob / pheromone / organic networks. Dominant in
//                chorus / drop (the organism blooms on the watershed).
//   flowfield  — linear strokes / streaks (Hobbs Fidenza). Dominant in
//                verse / build (motion, accumulation, anticipation).
//   reaction   — Gray-Scott surface texture (lattice MotifId). Slowly-
//                evolving biological pattern that morphs by section
//                (stripes → maze → spots → coral). Always present as
//                ambient texture, slightly stronger during bridges and
//                breakdowns where it becomes the focal vocabulary.
//   attractor  — De Jong/Clifford iterated maps (organism MotifId).
//                Delicate filament structure driven by the tonnetz
//                6-vector; harmonic key changes warp topology. Active
//                across verse/bridge/intro where geometric structure
//                reads through; subdued in heavy drops.
//
// Subject motifs are roughly anti-correlated by section so users see
// clear visual differentiation, but they never go fully to zero so
// trails persist across transitions.

import type { VisualDirectorFrame } from '../director/types.js';
import type { MotifId, MotifWeights } from './types.js';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function weightsForFrame(frame: VisualDirectorFrame): MotifWeights {
	const energy = frame.energy;
	const antic = frame.drop.anticipation;
	const postDrop = frame.drop.postDropDecay;

	let physarum = 0;
	let flowfield = 0;
	let reaction = 0;
	let attractor = 0;

	switch (frame.section) {
		case 'calm':
		case 'intro':
			physarum = 0.12 + energy * 0.3;
			flowfield = 0.15 + energy * 0.25;
			reaction = 0.35 + energy * 0.25;
			attractor = 0.30 + energy * 0.3;
			break;
		case 'verse':
			physarum = 0.35 + energy * 0.25;
			flowfield = 0.55 + energy * 0.3;
			reaction = 0.30 + energy * 0.2;
			attractor = 0.55 + energy * 0.3;
			break;
		case 'pre_chorus':
		case 'build':
			physarum = 0.45 + antic * 0.35;
			flowfield = 0.75 + antic * 0.20;
			reaction = 0.25 + antic * 0.3;
			attractor = 0.40 + antic * 0.35;
			break;
		case 'drop':
		case 'chorus':
			physarum = 0.95 + postDrop * 0.05;
			flowfield = 0.45 + postDrop * 0.30;
			reaction = 0.55 + postDrop * 0.4;
			attractor = 0.25 + postDrop * 0.5;
			break;
		case 'bridge':
			physarum = 0.32 + energy * 0.3;
			flowfield = 0.30 + energy * 0.3;
			reaction = 0.65 + energy * 0.25;
			attractor = 0.70 + energy * 0.25;
			break;
		case 'breakdown':
			physarum = 0.20 + energy * 0.3;
			flowfield = 0.18 + energy * 0.25;
			reaction = 0.55 + energy * 0.25;
			attractor = 0.45 + energy * 0.25;
			break;
		case 'outro':
			physarum = 0.25 + energy * 0.25;
			flowfield = 0.20 + energy * 0.20;
			reaction = 0.40 + energy * 0.20;
			attractor = 0.40 + energy * 0.25;
			break;
		default:
			physarum = 0.45;
			flowfield = 0.45;
			reaction = 0.40;
			attractor = 0.45;
	}

	if (frame.silence) {
		physarum = 0;
		flowfield = 0;
		// reaction + attractor keep simulating quietly so the field doesn't snap.
		reaction = Math.min(reaction, 0.12);
		attractor = Math.min(attractor, 0.15);
	}

	return {
		atmosphere: 1,
		particles: clamp01(physarum),
		ribbon: clamp01(flowfield),
		lattice: clamp01(reaction),
		organism: clamp01(attractor)
	} as Record<MotifId, number>;
}
