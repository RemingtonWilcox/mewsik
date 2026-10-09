import { expect, test } from '@playwright/test';

test.describe('Soma render runtime', () => {
	test('selects eco, balanced, and ultra from display workload and hardware hints', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { selectSomaQuality } = await import(modulePath);
			return {
				ultra: selectSomaQuality(1920, 1080, 1, 16, 8).tier,
				balanced: selectSomaQuality(2560, 1440, 1, 12, 8).tier,
				dense4k: selectSomaQuality(3840, 2160, 1, 24, 16).tier,
				lowEnd: selectSomaQuality(1280, 720, 1, 4, 4).tier,
				eightCore: selectSomaQuality(1920, 1080, 1, 8, 8).tier
			};
		});

		expect(result).toEqual({
			ultra: 'ultra',
			balanced: 'balanced',
			dense4k: 'eco',
			lowEnd: 'eco',
			eightCore: 'balanced'
		});
	});

	test('keeps every tier inside its absolute HDR pixel ceiling', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SOMA_QUALITY_PROFILES, somaBackingSize } = await import(modulePath);
			return Object.fromEntries(
				Object.entries(SOMA_QUALITY_PROFILES).map(([tier, profile]: [string, any]) => {
					const backing = somaBackingSize(7680, 4320, 2, tier);
					return [
						tier,
						{
							...backing,
							pixels: backing.width * backing.height,
							ceiling: profile.maxPixels,
							frameRate: profile.frameRate,
							steps: profile.raymarchSteps
						}
					];
				})
			);
		});

		for (const sample of Object.values(result) as Array<{
			width: number;
			height: number;
			pixels: number;
			ceiling: number;
		}>) {
			expect(sample.pixels).toBeLessThanOrEqual(sample.ceiling);
			expect(sample.width / sample.height).toBeCloseTo(16 / 9, 2);
		}
		expect(result.eco.ceiling).toBeLessThan(result.balanced.ceiling);
		expect(result.balanced.ceiling).toBeLessThan(result.ultra.ceiling);
		expect(result.eco.frameRate).toBeLessThan(result.balanced.frameRate);
		expect(result.balanced.frameRate).toBeLessThan(result.ultra.frameRate);
		expect(result.eco.steps).toBeLessThan(result.balanced.steps);
		expect(result.balanced.steps).toBeLessThan(result.ultra.steps);
	});

	test('paces Soma on whole display-vsync divisors instead of a repeating skip cadence', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { somaFrameStride } = await import(modulePath);
			return {
				hz143: {
					ultra: somaFrameStride(1000 / 143, 60),
					balanced: somaFrameStride(1000 / 143, 50),
					eco: somaFrameStride(1000 / 143, 40)
				},
				hz60: {
					ultra: somaFrameStride(1000 / 60, 60),
					balanced: somaFrameStride(1000 / 60, 50),
					eco: somaFrameStride(1000 / 60, 40)
				}
			};
		});

		expect(result).toEqual({
			hz143: { ultra: 2, balanced: 3, eco: 4 },
			hz60: { ultra: 1, balanced: 1, eco: 2 }
		});
	});

	test('preserves aspect ratio at ordinary and high-DPI viewport sizes', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SOMA_QUALITY_PROFILES, somaBackingSize } = await import(modulePath);
			return {
				ordinary: somaBackingSize(1280, 720, 1, 'ultra'),
				retina4k: somaBackingSize(3840, 2160, 2, 'ultra'),
				ceiling: SOMA_QUALITY_PROFILES.ultra.maxPixels
			};
		});

		expect(result.ordinary.width / result.ordinary.height).toBeCloseTo(16 / 9, 2);
		expect(result.retina4k.width / result.retina4k.height).toBeCloseTo(16 / 9, 2);
		expect(result.retina4k.width * result.retina4k.height).toBeLessThanOrEqual(
			result.ceiling
		);
	});

	test('steps down only after sustained missed frames and ignores ordinary jitter', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SomaAutoQualityController } = await import(modulePath);
			const governor = new SomaAutoQualityController('ultra');

			for (let i = 0; i < 600; i++) governor.observeFrame(i % 2 ? 17.3 : 16);
			const afterJitter = governor.tier;
			governor.observeFrame(120);
			for (let i = 0; i < 180; i++) governor.observeFrame(16.67);
			const afterOneHitch = governor.tier;

			let ultraMisses = 0;
			while (governor.tier === 'ultra' && ultraMisses < 500) {
				governor.observeFrame(34);
				ultraMisses++;
			}
			const afterFirstPressureRun = governor.tier;

			let balancedMisses = 0;
			while (governor.tier === 'balanced' && balancedMisses < 500) {
				governor.observeFrame(30);
				balancedMisses++;
			}

			return {
				afterJitter,
				afterOneHitch,
				afterFirstPressureRun,
				afterSecondPressureRun: governor.tier,
				ultraMisses,
				balancedMisses
			};
		});

		expect(result.afterJitter).toBe('ultra');
		expect(result.afterOneHitch).toBe('ultra');
		expect(result.afterFirstPressureRun).toBe('balanced');
		expect(result.afterSecondPressureRun).toBe('eco');
		expect(result.ultraMisses).toBeGreaterThan(30);
		expect(result.balancedMisses).toBeGreaterThan(30);
	});

	test('recovers slowly without exceeding the hardware and viewport ceiling', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SomaAutoQualityController } = await import(modulePath);
			const governor = new SomaAutoQualityController('ultra');

			while (governor.tier === 'ultra') governor.observeFrame(34);
			for (let i = 0; i < 1_000; i++) governor.observeFrame(20);
			const afterTwentyStableSeconds = governor.tier;
			for (let i = 0; i < 650; i++) governor.observeFrame(20);
			const afterLongStableRun = governor.tier;

			const capped = new SomaAutoQualityController('balanced');
			for (let i = 0; i < 2_000; i++) capped.observeFrame(20);
			const atInitialCeiling = capped.tier;
			capped.setCeiling('ultra');
			for (let i = 0; i < 1_000; i++) capped.observeFrame(20);
			const beforeFreshStableRun = capped.tier;
			for (let i = 0; i < 650; i++) capped.observeFrame(20);
			const afterFreshStableRun = capped.tier;
			const afterLowerCeiling = capped.setCeiling('eco');
			capped.observeFrame(2_000);

			return {
				afterTwentyStableSeconds,
				afterLongStableRun,
				atInitialCeiling,
				beforeFreshStableRun,
				afterFreshStableRun,
				afterLowerCeiling,
				afterIgnoredPause: capped.tier
			};
		});

		expect(result).toEqual({
			afterTwentyStableSeconds: 'balanced',
			afterLongStableRun: 'ultra',
			atInitialCeiling: 'balanced',
			beforeFreshStableRun: 'balanced',
			afterFreshStableRun: 'ultra',
			afterLowerCeiling: 'eco',
			afterIgnoredPause: 'eco'
		});
	});

	test('keeps autonomous clocks out of rigid camera composition while retaining local evolution', async ({
		page
	}) => {
		await page.goto('/');
		const source = await page.evaluate(async () => {
			const modulePath = '/src/lib/components/visualizer/visualizer-mk2.svelte?raw';
			return (await import(/* @vite-ignore */ modulePath)).default as string;
		});
		const camera = source.slice(
			source.indexOf('function getCameraPos('),
			source.indexOf('function dominantGesture(')
		);
		const geometry = source.slice(
			source.indexOf('fn organismWarp('),
			source.indexOf('// 4-tap tetrahedral normal estimation.')
		);

		expect(camera).not.toContain('cameraPhase');
		expect(camera).not.toContain('journey.cameraPhase');
		expect(geometry).toContain('let evolutionPhase');
		expect(geometry).not.toContain('u.backgroundPhase');
		expect(geometry).not.toContain('u.journeyPhase');
	});

	test('swims between half-phrase waypoints on both sides of the shot without jumping', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/organism.ts';
			const { SomaSwimmer, SOMA_SWIM_BOUNDS } = await import(modulePath);
			const swimmer = new SomaSwimmer();
			swimmer.reset(0.37);
			const input = {
				dt: 1 / 60,
				beats: 0,
				energy: 0.6,
				motion: 1,
				reach: 0,
				stillness: 0,
				bloom: 0.3,
				dormancy: 0,
				openness: 0.5,
				silence: 0,
				right: [1, 0, 0] as [number, number, number],
				forward: [0, 0, -1] as [number, number, number]
			};
			let maxStep = 0;
			let minX = Infinity;
			let maxX = -Infinity;
			let leftBounds = false;
			let previous: number[] | null = null;
			// 128 beats at 120 bpm: eight waypoints.
			for (let frame = 0; frame < 64 * 60; frame += 1) {
				input.beats = (frame / 60) * 2;
				swimmer.update(input);
				const [x, y, z] = swimmer.position;
				if (previous) {
					maxStep = Math.max(maxStep, Math.hypot(x - previous[0], y - previous[1], z - previous[2]));
				}
				previous = [x, y, z];
				if (frame > 60 * 8) {
					minX = Math.min(minX, x);
					maxX = Math.max(maxX, x);
				}
				if (
					Math.abs(x) > SOMA_SWIM_BOUNDS.across + 0.2 ||
					y > SOMA_SWIM_BOUNDS.up + 0.2 ||
					y < SOMA_SWIM_BOUNDS.down - 0.2
				) {
					leftBounds = true;
				}
			}
			const a = new SomaSwimmer();
			const b = new SomaSwimmer();
			a.reset(0.5);
			b.reset(0.5);
			for (let frame = 0; frame < 600; frame += 1) {
				input.beats = (frame / 60) * 2;
				a.update(input);
				b.update(input);
			}
			return {
				maxStep,
				minX,
				maxX,
				leftBounds,
				deterministic: a.position.every((value: number, i: number) => value === b.position[i]),
				axisLength: Math.hypot(...swimmer.axis)
			};
		});

		expect(result.leftBounds).toBe(false);
		// Speed-limited: never more than 0.32 world units per second.
		expect(result.maxStep).toBeLessThan(0.32 / 60 + 1e-4);
		// It really crosses the shot instead of parking in the centre.
		expect(result.minX).toBeLessThan(-0.45);
		expect(result.maxX).toBeGreaterThan(0.45);
		expect(result.deterministic).toBe(true);
		expect(result.axisLength).toBeCloseTo(1, 5);
	});

	test('stillness and silence calm the swim without moving the body on beats', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/organism.ts';
			const { SomaSwimmer } = await import(modulePath);
			const base = {
				dt: 1 / 60,
				beats: 4,
				energy: 0.7,
				motion: 1,
				reach: 0,
				stillness: 0,
				bloom: 0,
				dormancy: 0,
				openness: 0.4,
				silence: 0,
				right: [1, 0, 0] as [number, number, number],
				forward: [0, 0, -1] as [number, number, number]
			};
			const strokes = (overrides: Record<string, number>) => {
				const swimmer = new SomaSwimmer();
				swimmer.reset(0.2);
				let peak = 0;
				for (let frame = 0; frame < 30 * 60; frame += 1) {
					swimmer.update({ ...base, ...overrides });
					peak = Math.max(peak, swimmer.stroke);
				}
				return peak;
			};
			// Same song position: beats held constant, so only smoothed energy can move it.
			const held = new SomaSwimmer();
			held.reset(0.2);
			for (let frame = 0; frame < 60 * 60; frame += 1) held.update(base);
			const settled = [...held.position];
			for (let frame = 0; frame < 60; frame += 1) held.update(base);
			return {
				active: strokes({}),
				still: strokes({ stillness: 1 }),
				silent: strokes({ silence: 1 }),
				drift: Math.hypot(
					held.position[0] - settled[0],
					held.position[1] - settled[1],
					held.position[2] - settled[2]
				)
			};
		});

		expect(result.active).toBeGreaterThan(0.5);
		expect(result.still).toBeLessThan(result.active * 0.4);
		expect(result.silent).toBeLessThan(result.active * 0.3);
		expect(result.drift).toBeLessThan(0.01);
	});

	test('palette roles stay bioluminescent over an ink-indigo sea for every key', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/organism.ts';
			const { SOMA_BIO_ANCHORS, somaHueDelta, somaPaletteRoles } = await import(modulePath);
			const nearest = (hue: number) =>
				Math.min(...SOMA_BIO_ANCHORS.map((anchor: number) => Math.abs(somaHueDelta(hue, anchor))));
			let worstPull = 0;
			let minSeparation = 1;
			let minInk = 1;
			let maxInk = 0;
			const bases = new Set<string>();
			for (let i = 0; i < 48; i += 1) {
				for (const mode of ['major', 'minor', 'unknown'] as const) {
					const palette = {
						baseHue: i / 48,
						accentHue: (i / 48 + 0.31) % 1,
						rimHue: (i / 48 + 0.62) % 1,
						saturation: 0.6
					};
					const roles = somaPaletteRoles(palette, mode, {
						base: 0,
						accent: 0,
						rim: 0,
						ink: 0,
						saturation: 0
					});
					worstPull = Math.max(worstPull, nearest(roles.base) / Math.max(nearest(palette.baseHue), 1e-3));
					minSeparation = Math.min(minSeparation, Math.abs(somaHueDelta(roles.base, roles.accent)));
					minInk = Math.min(minInk, roles.ink);
					maxInk = Math.max(maxInk, roles.ink);
					bases.add(roles.base.toFixed(2));
					if (roles.saturation < 0.74) worstPull = 99;
				}
			}
			return { worstPull, minSeparation, minInk, maxInk, distinctBases: bases.size };
		});

		// Every base hue moves at least halfway toward a bioluminescent anchor.
		expect(result.worstPull).toBeLessThanOrEqual(0.451);
		expect(result.minSeparation).toBeGreaterThanOrEqual(0.139);
		expect(result.minInk).toBeGreaterThan(0.6);
		expect(result.maxInk).toBeLessThan(0.73);
		// Still a wide range of colours across keys, not one preset.
		expect(result.distinctBases).toBeGreaterThan(20);
	});
});
