// Section-driven motif weight policy. Replaces the "swap one component"
// model with continuous parameter morphs: every motif always runs (so trails
// and feedback don't snap), but each contributes to the final HDR target at
// a weight derived from the director's high-level intent.
//
// Atmosphere is always full — it's the backdrop. The active "subject" motif
// (Physarum, future organism, future particle field) is gated by section,
// energy, and drop state so musical structure drives composition.

import type { VisualDirectorFrame } from '../director/types.js';
import type { MotifId, MotifWeights } from './types.js';

export function weightsForFrame(frame: VisualDirectorFrame): MotifWeights {
	const energy = frame.energy;
	const antic = frame.drop.anticipation;
	const postDrop = frame.drop.postDropDecay;

	let physarum = 0;
	switch (frame.section) {
		case 'calm':
		case 'intro':
		case 'breakdown':
			physarum = 0.18 + energy * 0.4;
			break;
		case 'verse':
			physarum = 0.45 + energy * 0.35;
			break;
		case 'pre_chorus':
		case 'build':
			physarum = 0.55 + energy * 0.3 + antic * 0.4;
			break;
		case 'drop':
		case 'chorus':
			physarum = 0.9 + postDrop * 0.1;
			break;
		case 'bridge':
			physarum = 0.4 + energy * 0.4;
			break;
		case 'outro':
			physarum = 0.3 + energy * 0.3;
			break;
		default:
			physarum = 0.5;
	}

	if (frame.silence) {
		physarum = 0;
	}
	physarum = Math.max(0, Math.min(1, physarum));

	return {
		atmosphere: 1,
		particles: physarum
	} as Record<MotifId, number>;
}
