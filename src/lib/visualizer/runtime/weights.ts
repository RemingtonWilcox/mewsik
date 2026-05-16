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
//   mandala    — radial sacred geometry (tunnel MotifId). K-fold
//                symmetric kaleidoscope, audio-reactive petals/rings.
//                The runtime's "axis of symmetry" — strongest in drops
//                and choruses where it lands the structural moment,
//                quieter in verses where less symmetric vocabularies lead.
//
// Subject motifs are roughly anti-correlated by section so users see
// clear visual differentiation. Simulated motifs can keep internal state,
// but only one or two should visibly lead at a time; otherwise the HDR
// post-stack collapses into pale visual soup.

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
	let mandala = 0;

	switch (frame.section) {
		case 'calm':
		case 'intro':
			physarum = 0;
			flowfield = 0;
			reaction = 0.12 + energy * 0.12;
			attractor = 0.28 + energy * 0.28;
			mandala = 0.10 + energy * 0.18;
			break;
		case 'verse':
			physarum = 0.12 + energy * 0.14;
			flowfield = 0.48 + energy * 0.26;
			reaction = 0.14 + energy * 0.14;
			attractor = 0.36 + energy * 0.24;
			mandala = 0.08 + energy * 0.12;
			break;
		case 'pre_chorus':
		case 'build':
			physarum = 0.16 + antic * 0.18;
			flowfield = 0.62 + antic * 0.22;
			reaction = 0.10 + antic * 0.16;
			attractor = 0.18 + antic * 0.18;
			mandala = 0.30 + antic * 0.30;
			break;
		case 'drop':
		case 'chorus':
			physarum = 0.68 + postDrop * 0.20;
			flowfield = 0.24 + postDrop * 0.18;
			reaction = 0.30 + postDrop * 0.24;
			attractor = 0.08 + postDrop * 0.16;
			mandala = 0.46 + postDrop * 0.24;
			break;
		case 'bridge':
			physarum = 0.10 + energy * 0.12;
			flowfield = 0.14 + energy * 0.16;
			reaction = 0.44 + energy * 0.20;
			attractor = 0.52 + energy * 0.22;
			mandala = 0.18 + energy * 0.16;
			break;
		case 'breakdown':
			physarum = 0.06 + energy * 0.12;
			flowfield = 0.08 + energy * 0.12;
			reaction = 0.40 + energy * 0.18;
			attractor = 0.24 + energy * 0.16;
			mandala = 0.28 + energy * 0.18;
			break;
		case 'outro':
			physarum = 0.06 + energy * 0.12;
			flowfield = 0.08 + energy * 0.12;
			reaction = 0.24 + energy * 0.16;
			attractor = 0.28 + energy * 0.18;
			mandala = 0.20 + energy * 0.14;
			break;
		default:
			physarum = 0.22;
			flowfield = 0.28;
			reaction = 0.18;
			attractor = 0.28;
			mandala = 0.18;
	}

	if (frame.silence) {
		physarum = 0;
		flowfield = 0;
		// reaction + attractor + mandala keep running quietly so visuals don't snap.
		reaction = Math.min(reaction, 0.12);
		attractor = Math.min(attractor, 0.15);
		mandala = Math.min(mandala, 0.10);
	}

	return {
		atmosphere: 1,
		particles: clamp01(physarum),
		ribbon: clamp01(flowfield),
		lattice: clamp01(reaction),
		organism: clamp01(attractor),
		tunnel: clamp01(mandala)
	} as Record<MotifId, number>;
}
