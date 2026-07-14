// Palette engine — maps detected key + chroma onto a smooth 6-d tonnetz
// coordinate, then collapses to HSV swatches (base / accent / rim) for
// renderers. Harmonically related chords end up with nearby palettes
// because tonnetz neighbors are perfect-fifth / major-third / minor-third
// related (Harte et al. 2006).
//
// The analyzer exposes chroma_key normalized to 0..1 (C=0, B=11/12) plus
// chroma_strength. Convert to pitch-class units only at the Tonnetz boundary.

import { wrap01, lerp, alphaForTau, AsymmetricEnvelope } from './util.js';
import type { PaletteHSV } from './types.js';

const TWO_PI = Math.PI * 2;

function pitchClassToTonnetz(pc: number): [number, number, number, number, number, number] {
	const fifth = (pc * 7) % 12; // perfect-fifth axis
	const majorThird = (pc * 4) % 12; // major-third axis
	const minorThird = (pc * 3) % 12; // minor-third axis
	const a = (fifth / 12) * TWO_PI;
	const b = (majorThird / 12) * TWO_PI;
	const c = (minorThird / 12) * TWO_PI;
	return [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
}

export class PaletteEngine {
	private tonnetz: [number, number, number, number, number, number] = [1, 0, 1, 0, 1, 0];
	private baseHue = 0;
	private accentHue = 0.18;
	private rimHue = 0.5;
	private warmth = new AsymmetricEnvelope(1, 2, 60, 0.5);
	private saturation = new AsymmetricEnvelope(0.5, 1.5, 60, 0.6);
	private aTonnetz = alphaForTau(0.6, 60);

	update(opts: {
		chromaKey: number;
		chromaStrength: number;
		valence: number;
		arousal: number;
		energy: number;
	}): { palette: PaletteHSV; tonnetz: [number, number, number, number, number, number] } {
		const { chromaKey, chromaStrength, valence, arousal, energy } = opts;
		const t = pitchClassToTonnetz(wrap01(chromaKey) * 12);
		const w = Math.max(0.05, chromaStrength);
		for (let i = 0; i < 6; i++) {
			this.tonnetz[i] = lerp(this.tonnetz[i], t[i], this.aTonnetz * w);
		}

		// Fifth-axis angle = base hue (slow chromatic motion around the wheel)
		const baseAngle = Math.atan2(this.tonnetz[1], this.tonnetz[0]);
		const targetBase = wrap01(baseAngle / TWO_PI + 0.5);
		// Major-third axis = accent offset (warm complement)
		const accentAngle = Math.atan2(this.tonnetz[3], this.tonnetz[2]);
		const targetAccent = wrap01(targetBase + (accentAngle / TWO_PI) * 0.18 + 0.13);
		// Minor-third axis = rim hue (cool counter)
		const rimAngle = Math.atan2(this.tonnetz[5], this.tonnetz[4]);
		const targetRim = wrap01(targetBase + (rimAngle / TWO_PI) * 0.22 + 0.5);

		const aHue = alphaForTau(1.2, 60);
		this.baseHue = wrap01(lerp(this.baseHue, targetBase, aHue));
		this.accentHue = wrap01(lerp(this.accentHue, targetAccent, aHue));
		this.rimHue = wrap01(lerp(this.rimHue, targetRim, aHue));

		const warmth = this.warmth.tick(0.5 + 0.5 * valence);
		const saturation = this.saturation.tick(0.4 + 0.5 * arousal + 0.15 * energy);

		return {
			palette: {
				baseHue: this.baseHue,
				accentHue: this.accentHue,
				rimHue: this.rimHue,
				saturation,
				warmth
			},
			tonnetz: [...this.tonnetz] as [number, number, number, number, number, number]
		};
	}
}
