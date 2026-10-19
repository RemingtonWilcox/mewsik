import { expect, test } from '@playwright/test';

// Visual continuity: leaving and re-entering the visualizer resumes the look,
// and a new song carries the picture on instead of restarting it.
test.describe('visual continuity', () => {
	test('reseed keeps the current look and only changes future mutations', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VariationGenome } = await import('/src/lib/visualizer/variation.ts');
			const axes = [
				{ kind: 'choice', name: 'palette', options: 20, scale: 'section', chance: 1, memory: 4, tau: 3 },
				{ kind: 'continuous', name: 'density', min: 0, max: 1, scale: 'phrase', step: 0.2, tau: 1 }
			];
			const walk = (genome: InstanceType<typeof VariationGenome>, from: number, to: number) => {
				for (let phrase = from; phrase < to; phrase += 1) {
					for (let frame = 0; frame < 30; frame += 1) {
						genome.advance({ phraseIndex: phrase, sectionKey: 's' + Math.floor(phrase / 4), energy: 0.6, dt: 1 / 30 });
					}
				}
			};
			const a = new VariationGenome(axes as never, 'song-1');
			const b = new VariationGenome(axes as never, 'song-1');
			walk(a, 0, 40);
			walk(b, 0, 40);
			const before = JSON.stringify(a.snapshot());
			a.reseed('song-2');
			const afterReseed = JSON.stringify(a.snapshot());
			const targetsAfterReseed = JSON.stringify(a.targetVector());
			// The next song starts its phrase count from zero again.
			a.advance({ phraseIndex: 0, sectionKey: 'next-0', energy: 0.6, dt: 1 / 30 });
			// Values keep gliding, but no new targets: the first frame is not a boundary.
			const firstFrameTargets = JSON.stringify(a.targetVector());
			walk(a, 0, 30);
			walk(b, 40, 70);
			return {
				kept: before === afterReseed,
				noBoundaryOnFirstFrame: firstFrameTargets === targetsAfterReseed,
				diverged: JSON.stringify(a.snapshot()) !== JSON.stringify(b.snapshot())
			};
		});
		expect(result.kept).toBe(true);
		expect(result.noBoundaryOnFirstFrame).toBe(true);
		expect(result.diverged).toBe(true);
	});

	test('the journey keeps engine looks across remounts and new sources', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { signalVariationFor } = await import('/src/lib/visualizer/signal/genome.ts');
			const runtime = new VisualizerJourneyRuntime(0.25, 0);
			const created = { count: 0 };
			const first = runtime.persistentLook('prism', () => ({ id: ++created.count }));
			const again = runtime.persistentLook('prism', () => ({ id: ++created.count }));

			const features = {
				bins: Array.from({ length: 64 }, (_, i) => (i < 12 ? 0.8 : 0.4)),
				rms: 0.5,
				peak: 0.9,
				centroid: 0.4,
				onset: false,
				bass: 0.7,
				mid: 0.5,
				treble: 0.3,
				sample_rate: 48000,
				bpm: 124,
				beat_phase: 0.1,
				chroma_key: 0.3,
				chroma_strength: 0.6
			};
			runtime.resetSource('track-a', 0);
			let now = 0;
			for (let i = 0; i < 600; i += 1) {
				now += 1000 / 60;
				runtime.advance({ ...features, onset: i % 30 === 0 }, now);
			}
			const lookBefore = runtime.advance(features, now + 16).loom.look;
			const loomBefore = { grammar: lookBefore.grammarTo, hero: [...lookBefore.hero] };
			const signalA = signalVariationFor(0.25, runtime.sourceEpoch);
			const signalSceneBefore = JSON.stringify(signalA.genome.snapshot());

			runtime.resetSource('track-b', now + 32);
			const signalB = signalVariationFor(0.75, runtime.sourceEpoch);
			const lookAfter = runtime.advance(features, now + 48).loom.look;
			// Same topology, and the hero colour has only glided a hair: no restart.
			const heroShift = Math.max(...lookAfter.hero.map((c: number, i: number) => Math.abs(c - loomBefore.hero[i])));

			return {
				sameObject: first === again && created.count === 1,
				loomContinues: lookAfter.grammarTo === loomBefore.grammar && heroShift < 0.05,
				signalSameObject: signalA === signalB,
				signalContinues: JSON.stringify(signalB.genome.snapshot()) === signalSceneBefore
			};
		});
		expect(result.sameObject).toBe(true);
		expect(result.loomContinues).toBe(true);
		expect(result.signalSameObject).toBe(true);
		expect(result.signalContinues).toBe(true);
	});
});
