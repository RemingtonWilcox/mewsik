import { expect, test } from '@playwright/test';

test.describe('Prism render foundations', () => {
	test('caps HDR backing pixels without distorting the viewport', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const runtime = await import(modulePath);
			return {
				ordinary: runtime.prismBackingSize(1280, 720, 1),
				retina4k: runtime.prismBackingSize(3840, 2160, 2),
				ceiling: runtime.PRISM_MAX_INTERNAL_PIXELS
			};
		});

		expect(result.ordinary).toEqual({ width: 1280, height: 720 });
		expect(result.retina4k.width * result.retina4k.height).toBeLessThanOrEqual(result.ceiling);
		expect(result.retina4k.width / result.retina4k.height).toBeCloseTo(16 / 9, 2);
	});

	test('gates high-refresh displays to one stable 60 Hz render stream', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const { FixedFrameScheduler } = await import(modulePath);
			const scheduler = new FixedFrameScheduler();
			let renders = 0;
			for (let tick = 0; tick <= 1440; tick += 1) {
				if (scheduler.next((tick * 1000) / 144) !== null) renders += 1;
			}
			const resumedDt = scheduler.next(20_000);
			const immediateCatchup = scheduler.next(20_001);
			return { renders, resumedDt, immediateCatchup };
		});

		expect(result.renders).toBeGreaterThanOrEqual(599);
		expect(result.renders).toBeLessThanOrEqual(602);
		expect(result.resumedDt).toBe(1);
		expect(result.immediateCatchup).toBeNull();
	});

	test('derives repeatable onset choices from the musical journey', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const { prismEventUnit } = await import(modulePath);
			const sequence = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 0)
			);
			const repeated = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 0)
			);
			const alternateChannel = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 1)
			);
			return { sequence, repeated, alternateChannel };
		});

		expect(result.repeated).toEqual(result.sequence);
		expect(result.alternateChannel).not.toEqual(result.sequence);
		expect(result.sequence.every((value) => value >= 0 && value < 1)).toBe(true);
	});
});
