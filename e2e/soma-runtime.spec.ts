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
});
