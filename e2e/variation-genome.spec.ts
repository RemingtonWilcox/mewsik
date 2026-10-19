import { expect, test } from '@playwright/test';

// The shared visual genome is the variety engine behind every renderer. These
// tests pin its promises: deterministic, boundary-only mutation, smooth glides,
// endless forward motion on live streams, and no short-range repetition.
test.describe('visual variation genome', () => {
	test('is deterministic, boundary-driven, varied and smooth', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VariationGenome, variationSpaceSize } = await import('/src/lib/visualizer/variation.ts');
			const axes = [
				{ kind: 'choice', name: 'palette', options: 24, scale: 'era', chance: 1, memory: 6, tau: 4 },
				{ kind: 'choice', name: 'motif', options: 9, scale: 'section', chance: 0.85, memory: 3, tau: 2 },
				{ kind: 'choice', name: 'camera', options: 6, scale: 'section', chance: 0.7, memory: 2, tau: 3 },
				{ kind: 'continuous', name: 'hue', min: 0, max: 1, scale: 'phrase', step: 0.12, wrap: true, tau: 2.5 },
				{ kind: 'continuous', name: 'density', min: 0, max: 1, scale: 'phrase', step: 0.22, tau: 1.5 },
				{ kind: 'continuous', name: 'twist', min: -1, max: 1, scale: 'phrase', step: 0.18, chance: 0.6, tau: 2 },
				{ kind: 'continuous', name: 'depth', min: 0, max: 1, scale: 'section', step: 0.3, tau: 3 },
				{ kind: 'continuous', name: 'warmth', min: 0, max: 1, scale: 'era', step: 0.4, tau: 6 }
			] as const;

			const sections = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const run = (seed: string, phrases: number, liveOnly = false) => {
				const genome = new VariationGenome(axes as never, seed);
				const signatures: string[] = [];
				const vectors: number[][] = [];
				let nearestReturn = Infinity;
				const hueTrace: number[] = [];
				let maxFrameJump = 0;
				let previousDensity = genome.value('density');
				for (let phrase = 0; phrase < phrases; phrase += 1) {
					const sectionKey = liveOnly ? 'live' : `${sections[Math.floor(phrase / 8) % sections.length]}-${Math.floor(phrase / 8)}`;
					const energy = 0.5 + 0.45 * Math.sin(phrase * 0.37);
					// 60 frames per phrase is plenty to observe glides.
					for (let frame = 0; frame < 60; frame += 1) {
						genome.advance({ phraseIndex: phrase, sectionKey, energy, dt: 1 / 60 });
						const density = genome.value('density');
						maxFrameJump = Math.max(maxFrameJump, Math.abs(density - previousDensity));
						previousDensity = density;
					}
					// Closest the look comes to any state 8..60 phrases back (a return
					// to a recent look, not a small wobble inside one phrase).
					for (let back = 8; back <= 60 && phrase - back >= 0; back += 1) {
						nearestReturn = Math.min(nearestReturn, genome.distanceTo(vectors[phrase - back]));
					}
					vectors.push(genome.targetVector());
					signatures.push(genome.signature(6));
					hueTrace.push(genome.value('hue'));
				}
				return { genome, signatures, hueTrace, maxFrameJump, nearestReturn };
			};

			const a = run('song-a', 1200);
			const a2 = run('song-a', 1200);
			const b = run('song-b', 1200);
			const live = run('radio', 400, true);

			// No mutation without a boundary: hold one phrase for 10 seconds.
			const still = new VariationGenome(axes as never, 'still');
			still.advance({ phraseIndex: 0, sectionKey: 'verse', energy: 0.5, dt: 1 / 60 });
			const before = still.snapshot();
			for (let i = 0; i < 600; i += 1) still.advance({ phraseIndex: 0, sectionKey: 'verse', energy: 0.9, dt: 1 / 60 });
			const after = still.snapshot();

			// Choice memory: the palette never returns to one of its last 6 picks.
			const memoryGenome = new VariationGenome(axes as never, 'memory');
			const palettePicks: number[] = [];
			for (let phrase = 0; phrase < 2000; phrase += 1) {
				memoryGenome.advance({ phraseIndex: phrase, sectionKey: `s${Math.floor(phrase / 8)}`, energy: 0.6, dt: 0.5 });
				const pick = memoryGenome.choice('palette').to;
				if (palettePicks[palettePicks.length - 1] !== pick) palettePicks.push(pick);
			}
			let memoryViolations = 0;
			for (let i = 1; i < palettePicks.length; i += 1) {
				if (palettePicks.slice(Math.max(0, i - 6), i).includes(palettePicks[i])) memoryViolations += 1;
			}

			// maxHold: a low-chance axis still changes within the limit.
			const holdAxes = [
				{ kind: 'choice', name: 'rare', options: 10, scale: 'section', chance: 0.05, memory: 3, maxHold: 2, tau: 1 }
			];
			const holdGenome = new VariationGenome(holdAxes as never, 'hold');
			// The first frame is never a boundary; start counting after it.
			holdGenome.advance({ phraseIndex: 0, sectionKey: 's0', energy: 0.5, dt: 1.5 });
			let longestHold = 0;
			let currentHold = 0;
			let lastRare = holdGenome.choice('rare').to;
			for (let section = 1; section < 400; section += 1) {
				// advance() clamps dt to 0.5 s: four frames let each fade finish before the next boundary.
				for (let frame = 0; frame < 4; frame += 1) {
					holdGenome.advance({ phraseIndex: section, sectionKey: 's' + section, energy: 0.5, dt: 0.5 });
				}
				const rare = holdGenome.choice('rare').to;
				currentHold = rare === lastRare ? currentHold + 1 : 0;
				longestHold = Math.max(longestHold, currentHold);
				lastRare = rare;
			}

			// Weights: an option weighted 0 is never chosen while others are
			// allowed, and a heavily weighted option dominates.
			const weightAxes = [{ kind: 'choice', name: 'pick', options: 4, scale: 'phrase', chance: 1, memory: 1, tau: 1 }];
			const weighted = new VariationGenome(weightAxes as never, 'weights');
			weighted.setWeights('pick', [0, 1, 8, 1]);
			const counts = [0, 0, 0, 0];
			for (let phrase = 0; phrase < 800; phrase += 1) {
				for (let frame = 0; frame < 4; frame += 1) {
					weighted.advance({ phraseIndex: phrase, sectionKey: 's', energy: 0.5, dt: 0.5 });
				}
				counts[weighted.choice('pick').to] += 1;
			}

			// settle(): values sit on their targets with no glide left.
			const settling = new VariationGenome(axes as never, 'settle');
			for (let phrase = 0; phrase < 5; phrase += 1) {
				settling.advance({ phraseIndex: phrase, sectionKey: 's' + phrase, energy: 0.8, dt: 0 });
			}
			settling.settle();
			const target = settling.targetVector();

			// Retargeting mid-crossfade: the visible blend never jumps. Boundaries
			// every 10 frames, fades 40 frames long.
			const fast = new VariationGenome(
				[{ kind: 'choice', name: 'x', options: 8, scale: 'phrase', chance: 1, memory: 2, tau: 40 / 60 }] as never,
				'fast'
			);
			let maxBlendJump = 0;
			let lastVisible: Record<number, number> | null = null;
			for (let frame = 0; frame < 3000; frame += 1) {
				fast.advance({ phraseIndex: Math.floor(frame / 10), sectionKey: 's', energy: 0.7, dt: 1 / 60 });
				const c = fast.choice('x');
				const visible: Record<number, number> = {};
				visible[c.from] = (visible[c.from] ?? 0) + (1 - c.mix);
				visible[c.to] = (visible[c.to] ?? 0) + c.mix;
				if (lastVisible) {
					for (const key of new Set([...Object.keys(visible), ...Object.keys(lastVisible)])) {
						maxBlendJump = Math.max(maxBlendJump, Math.abs((visible[Number(key)] ?? 0) - (lastVisible[Number(key)] ?? 0)));
					}
				}
				lastVisible = visible;
			}

			return {
				maxBlendJump,
				longestHold,
				weightCounts: counts,
				settledGap: Math.abs(settling.value('density') - target[4]),
				settledMix: settling.choice('motif').mix,
				deterministic: JSON.stringify(a.signatures) === JSON.stringify(a2.signatures),
				seedsDiffer: a.signatures.filter((s, i) => s !== b.signatures[i]).length,
				distinct: new Set(a.signatures).size,
				nearestReturn: a.nearestReturn,
				maxFrameJump: a.maxFrameJump,
				liveBoundaries: live.genome.boundaries,
				liveDistinct: new Set(live.signatures).size,
				stillUnchanged: JSON.stringify(before) === JSON.stringify(after),
				memoryViolations,
				paletteChanges: palettePicks.length,
				hueInRange: a.hueTrace.every((h) => h >= 0 && h < 1),
				space: variationSpaceSize(axes as never)
			};
		});

		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(1100);
		// 1200 phrases visit well over a thousand distinct quantized looks...
		expect(result.distinct).toBeGreaterThan(1000);
		// ...and never come back close to a look from 8-60 phrases earlier
		// (up to about four minutes at 128 bpm): at least one choice axis or a
		// broad continuous move always separates them.
		expect(result.nearestReturn).toBeGreaterThan(0.08);
		// Glides, not jumps: at 60 fps density moves at most a few percent per frame.
		expect(result.maxFrameJump).toBeLessThan(0.03);
		// A live stream with no section labels still gets section and era moves.
		expect(result.liveBoundaries.sections).toBeGreaterThan(50);
		expect(result.liveBoundaries.eras).toBeGreaterThan(10);
		expect(result.liveDistinct).toBeGreaterThan(300);
		expect(result.stillUnchanged).toBe(true);
		expect(result.memoryViolations).toBe(0);
		expect(result.paletteChanges).toBeGreaterThan(60);
		expect(result.hueInRange).toBe(true);
		expect(result.space).toBeGreaterThan(1_000_000);
		// maxHold 2: never more than one extra boundary without a change.
		expect(result.longestHold).toBeLessThanOrEqual(1);
		expect(result.weightCounts[0]).toBe(0);
		// Memory 1 forbids picking the heavy option twice in a row, so it tops
		// out near half the picks; it must still clearly beat each light option.
		expect(result.weightCounts[2]).toBeGreaterThan(result.weightCounts[1] * 1.5);
		expect(result.weightCounts[2]).toBeGreaterThan(result.weightCounts[3] * 1.5);
		expect(result.settledGap).toBeLessThan(1e-9);
		expect(result.settledMix).toBe(1);
		// A smoothstepped 40-frame fade moves at most ~4% per frame; a retarget snap would be 50%+.
		expect(result.maxBlendJump).toBeLessThan(0.06);
	});
});
