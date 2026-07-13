import { expect, test } from '@playwright/test';

async function expectProductionEngine(
	page: import('@playwright/test').Page,
	saved: 'auto' | 'mk1' | 'mk2' | 'signal',
	rendered: 'mk1' | 'mk2' | 'signal'
) {
	await expect(page.locator('[data-visualizer-host]')).toHaveAttribute(
		'data-render-engine',
		rendered
	);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.engine')))
		.toBe(saved);
}

test.describe('visualizer engine roster', () => {
	test('lab exposes only the supported engines and keyboard routes', async ({ page }) => {
		await page.goto('/visualizer-test');
		await page.waitForLoadState('networkidle');

		await expect(page.getByText('visualizer lab')).toBeVisible();
		await expect(page.getByRole('button', { name: 'auto · stable' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'mk1', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'mk2 · experimental' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'signal', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'mk3', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'runtime', exact: true })).toHaveCount(0);
		// Lab engines are embedded canvases, not fake full-screen buttons.
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toHaveCount(0);

		await page.getByRole('button', { name: 'signal', exact: true }).click();
		await expect(page.getByText('signal · oscilloscope / vectorscope engine')).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.engine')))
			.toBe('signal');

		await page.keyboard.press('w');
		await expect(page.getByText('mk2 · experimental', { exact: false }).last()).toBeVisible();
		await page.keyboard.press('q');
		await expect(page.getByText(/mk1 · hyperbolic kaleidoscope/)).toBeVisible();
	});

	test('production Auto renders Mk1, V follows the roster, and Escape closes', async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('mewsik.visualizer.engine', 'auto');
		});
		await page.goto('/');
		await page.getByRole('button', { name: 'Visualizer' }).click();

		await expectProductionEngine(page, 'auto', 'mk1');
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toBeVisible();

		await page.keyboard.press('v');
		await expectProductionEngine(page, 'mk1', 'mk1');
		await page.keyboard.press('v');
		await expectProductionEngine(page, 'mk2', 'mk2');
		await page.keyboard.press('v');
		await expectProductionEngine(page, 'signal', 'signal');
		await expect(page.getByLabel('Signal audio visualizer')).toHaveCount(1);
		await page.keyboard.press('v');
		await expectProductionEngine(page, 'auto', 'mk1');

		await page.keyboard.press('Escape');
		await expect(page.locator('[data-visualizer-host]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toHaveCount(0);
	});

	test('legacy engines migrate to their real production renderers', async ({ browser }) => {
		for (const [legacy, expectedSaved, expectedRendered] of [
			['mk3', 'signal', 'signal'],
			['runtime', 'auto', 'mk1']
		] as const) {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.addInitScript((savedEngine) => {
				localStorage.setItem('mewsik.visualizer.engine', savedEngine);
			}, legacy);
			await page.goto('/');
			await page.getByRole('button', { name: 'Visualizer' }).click();
			await expectProductionEngine(page, expectedSaved, expectedRendered);
			if (legacy === 'mk3') {
				await expect(page.getByLabel('Signal audio visualizer')).toHaveCount(1);
			}
			await context.close();
		}
	});

	test('feature frames expire and can be invalidated immediately', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/state/visualizer.svelte.ts';
			const visualizerModule = await import(modulePath);
			const vis = visualizerModule.useVisualizer();
			const frame = {
				bins: Array.from({ length: 64 }, () => 0.25),
				rms: 0.5,
				peak: 0.7,
				centroid: 0.4,
				onset: true,
				bass: 0.6,
				mid: 0.4,
				treble: 0.2,
				sample_rate: 48_000,
				bpm: 128,
				beat_phase: 0.25,
				chroma_key: 0.5,
				chroma_strength: 0.8
			};

			vis.setLatest(frame);
			const freshRms = vis.getLatest()?.rms ?? null;
			const expired = vis.getLatest(
				performance.now() + visualizerModule.AUDIO_FEATURE_FRESHNESS_MS + 1
			);
			vis.setLatest(frame);
			vis.clearLatest();
			const cleared = vis.getLatest();

			return {
				freshRms,
				expiredIsNull: expired === null,
				clearedIsNull: cleared === null,
				timeoutMs: visualizerModule.AUDIO_FEATURE_FRESHNESS_MS
			};
		});

		expect(result).toEqual({
			freshRms: 0.5,
			expiredIsNull: true,
			clearedIsNull: true,
			timeoutMs: 250
		});
	});
});
