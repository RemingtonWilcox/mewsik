import { expect, test } from '@playwright/test';

// Music character: a genre or tempo change is heard within seconds, fires one
// shift, and the genome answers it at once without jumping.
test.describe('music character', () => {
	test('a new source and a genre change each fire one shift, steady music fires none', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const runtime = new VisualizerJourneyRuntime(0.3, 0);
			const frame = (bass: number, treble: number, rms: number, bpm: number, i: number) => ({
				bins: Array.from({ length: 64 }, (_, k) => (k < 10 ? bass : k > 40 ? treble : (bass + treble) / 2)),
				rms,
				peak: Math.min(1, rms * 1.8),
				centroid: treble > bass ? 0.7 : 0.25,
				onset: i % Math.max(4, Math.round(3600 / bpm)) === 0,
				bass,
				mid: 0.4,
				treble,
				sample_rate: 48000,
				bpm,
				beat_phase: ((i * bpm) / 3600) % 1,
				chroma_key: 0.2,
				chroma_strength: 0.5
			});
			let now = 0;
			let i = 0;
			const shifts: number[] = [];
			let lastSerial = 0;
			const play = (seconds: number, make: (i: number) => ReturnType<typeof frame>) => {
				for (let n = 0; n < seconds * 60; n += 1) {
					now += 1000 / 60;
					i += 1;
					const character = runtime.advance(make(i), now).character;
					if (character.shiftSerial !== lastSerial) {
						lastSerial = character.shiftSerial;
						shifts.push(Number((now / 1000).toFixed(2)));
					}
				}
			};
			runtime.resetSource('song-a', 0);
			// Ambient: soft, dark, slow.
			play(30, (k) => frame(0.25, 0.1, 0.18, 64, k));
			const ambientCount = shifts.length;
			const ambientShiftAt = shifts[0];
			// Same source, the station flips to fast bright noise.
			const switchAt = now / 1000;
			play(6, (k) => frame(0.85, 0.8, 0.75, 172, k));
			const reactedAfter = shifts.length > ambientCount ? shifts[ambientCount] - switchAt : null;
			// Stay on it: no more shifts.
			play(25, (k) => frame(0.85, 0.8, 0.75, 172, k));
			const steadyAfterNoise = shifts.length;
			return { ambientCount, ambientShiftAt, reactedAfter, steadyAfterNoise, shifts };
		});
		// The new source fires once, after ~0.8 s of audio, and steady music never re-fires.
		expect(result.ambientCount).toBe(1);
		expect(result.ambientShiftAt).toBeLessThan(1.5);
		// The genre change is caught within 2.5 s.
		expect(result.reactedAfter).not.toBeNull();
		expect(result.reactedAfter!).toBeLessThan(2.5);
		expect(result.steadyAfterNoise).toBe(2);
	});

	test('genome shift moves targets at once and glides faster, without a jump', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VariationGenome } = await import('/src/lib/visualizer/variation.ts');
			const { characterWeights } = await import('/src/lib/visualizer/character.ts');
			const axes = [
				{ kind: 'continuous', name: 'speed', min: 0, max: 1, scale: 'phrase', step: 0.2, chance: 0.5, tau: 3 },
				{ kind: 'continuous', name: 'hue', min: 0, max: 1, scale: 'era', step: 0.3, wrap: true, tau: 6 },
				{ kind: 'choice', name: 'scene', options: 12, scale: 'section', chance: 0.4, memory: 3, tau: 4 }
			];
			const genome = new VariationGenome(axes as never, 'shift-test');
			for (let n = 0; n < 120; n += 1) genome.advance({ phraseIndex: 0, sectionKey: 's', energy: 0.5, dt: 1 / 60 });
			const before = genome.targetVector();
			genome.shift(1, 0.8);
			const movedBy = genome.distanceTo(before);
			const speedNow = genome.glideSpeed;
			// Glide: measure how far 'speed' gets toward its new target in 1.5 s and the largest per-frame step.
			const startValue = genome.value('speed');
			let maxStep = 0;
			let last = startValue;
			for (let n = 0; n < 90; n += 1) {
				genome.advance({ phraseIndex: 0, sectionKey: 's', energy: 0.5, dt: 1 / 60 });
				const v = genome.value('speed');
				maxStep = Math.max(maxStep, Math.abs(v - last));
				last = v;
			}
			const scene = genome.choice('scene');
			for (let n = 0; n < 400; n += 1) genome.advance({ phraseIndex: 0, sectionKey: 's', energy: 0.5, dt: 1 / 60 });
			const speedLater = genome.glideSpeed;

			genome.pull('speed', 1, 1);
			const pulled = genome.targetVector()[0];

			const weights = characterWeights(
				[{ tempo: 0.9, noise: 0.9 }, { tempo: 0.1, noise: 0.1 }],
				{ tempo: 0.95, noise: 0.85 } as never
			);
			return { movedBy, speedNow, speedLater, maxStep, sceneMix: scene.mix, pulled, weights };
		});
		// A strength-1 shift moves most axes (a choice flip alone is 1/3).
		expect(result.movedBy).toBeGreaterThan(0.3);
		expect(result.speedNow).toBeGreaterThan(3);
		expect(result.speedLater).toBe(1);
		// Fast, but still a glide: no frame moves more than ~4% of the range.
		expect(result.maxStep).toBeLessThan(0.04);
		// The 4 s crossfade is well underway after 1.5 s at shift speed.
		expect(result.sceneMix).toBeGreaterThan(0.5);
		expect(result.pulled).toBe(1);
		expect(result.weights[0]).toBeGreaterThan(result.weights[1] * 3);
	});
});
