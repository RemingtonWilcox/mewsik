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

	test('sections re-compose the rose and returning sections vary', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/composition.ts';
			const { prismComposition, prismFamily } = await import(modulePath);
			const seed = 0.421337;
			const families = ['intro', 'verse', 'build', 'drop', 'bridge'].map((section) =>
				prismFamily(section)
			);
			const first = families.map((family) => prismComposition(family, seed, 0));
			const repeat = families.map((family) => prismComposition(family, seed, 0));
			const secondDrop = prismComposition('peak', seed, 1);
			return { families, first, repeat, secondDrop };
		});

		expect(result.families).toEqual(['quiet', 'verse', 'rise', 'peak', 'drift']);
		expect(result.repeat).toEqual(result.first);
		// Every family is a different composition, not a brightness change.
		const signatures = new Set(
			result.first.map((comp: { fold: number; petals: number; spiral: number; rings: number }) =>
				[comp.fold, comp.rings, comp.spiral, comp.petals].join(':')
			)
		);
		expect(signatures.size).toBe(result.first.length);
		const firstDrop = result.first[3];
		expect(result.secondDrop.fold !== firstDrop.fold || result.secondDrop.cellScale !== firstDrop.cellScale).toBe(true);
		for (const comp of result.first) {
			expect(comp.fold).toBeGreaterThanOrEqual(5);
			expect(comp.petalReach).toBeLessThan(0.8);
			expect(comp.outerLit).toBeGreaterThanOrEqual(0);
			expect(comp.outerLit).toBeLessThanOrEqual(1);
		}
	});

	test('palette roles follow harmony with dark jewel glass', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/composition.ts';
			const { prismPaletteRoles, PRISM_JEWELS } = await import(modulePath);
			const keys = Array.from({ length: 12 }, (_, pitch) =>
				prismPaletteRoles(pitch / 12, false, 0.9, 0, 'verse')
			);
			const minor = prismPaletteRoles(0, true, 0.9, 0, 'verse');
			const drift = prismPaletteRoles(0, false, 0.9, 0, 'drift');
			const keyless = prismPaletteRoles(0, false, 0, 0.62, 'verse');
			return { keys, minor, drift, keyless, jewels: PRISM_JEWELS };
		});

		const triads = new Set(result.keys.map((roles: { triad: number }) => roles.triad));
		expect(triads.size).toBe(5);
		expect(result.minor.triad).not.toBe(result.keys[0].triad);
		expect(result.drift.triad).not.toBe(result.keys[0].triad);
		expect(result.keyless.hero).toEqual(result.jewels.sapphire);
		for (const roles of result.keys) {
			expect(roles.hero).not.toEqual(roles.support);
			expect(roles.accent).not.toEqual(roles.hero);
			// Jewel glass is deep: no channel is bright enough to bleach on its own.
			for (const channel of [...roles.hero, ...roles.support, ...roles.accent, ...roles.field]) {
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThan(0.8);
			}
		}
	});

	test('shader uniform groups stay packed in the declared order', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/shaders.ts';
			const shaders = await import(modulePath);
			const struct = shaders.PRISM_ROSE_WGSL.match(/struct Uniforms \{([\s\S]*?)\};/)?.[1] ?? '';
			const vecFields = [...struct.matchAll(/^\s*(\w+): vec4<f32>,/gm)].map((match) => match[1]);
			const scalarFields = [...struct.matchAll(/^\s*(\w+): f32,/gm)].map((match) => match[1]);
			return {
				vecFields,
				scalarCount: scalarFields.length,
				offsets: shaders.PRISM_UNIFORM_OFFSETS,
				floats: shaders.PRISM_UNIFORM_FLOATS,
				hasBacktick: [
					shaders.PRISM_ROSE_WGSL,
					shaders.PRISM_COMPOSITE_WGSL,
					shaders.PRISM_FEEDBACK_WGSL
				].some((code: string) => code.includes('`'))
			};
		});

		expect(result.hasBacktick).toBe(false);
		expect(result.scalarCount).toBe(24);
		const ordered = Object.entries(result.offsets as Record<string, number>).sort((a, b) => a[1] - b[1]);
		expect(ordered.map(([name]) => name)).toEqual(result.vecFields);
		ordered.forEach(([, offset], index) => expect(offset).toBe(24 + index * 4));
		expect(result.floats).toBe(24 + result.vecFields.length * 4);
	});
});
