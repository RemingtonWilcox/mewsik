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

test.describe('visualizer musical analysis', () => {
	test('ring-buffer slopes follow chronological time', async ({ page }) => {
		await page.goto('/');
		const slopes = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/director/util.ts';
			const { RingBuffer } = await import(modulePath);
			const rising = new RingBuffer(8);
			const falling = new RingBuffer(8);
			for (const value of [0.1, 0.2, 0.4, 0.8]) rising.push(value);
			for (const value of [0.8, 0.4, 0.2, 0.1]) falling.push(value);
			return {
				rising: rising.slope(0, 4),
				falling: falling.slope(0, 4)
			};
		});

		expect(slopes.rising).toBeGreaterThan(0);
		expect(slopes.falling).toBeLessThan(0);
	});

	test('drop detector preserves a build through its bass-and-energy landing', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/director/drop.ts';
			const { DropDetector } = await import(modulePath);
			const detector = new DropDetector();
			let frame = 0;
			let sawBuild = false;
			let sawLanding = false;
			const update = (rms: number, flatness: number, subBass: number, onsetDensity: number) => {
				const time = frame / 60;
				const beat = frame / 30;
				const beatPhase = beat - Math.floor(beat);
				const beatIndexAbsolute = Math.floor(beat);
				frame += 1;
				const state = detector.update({
					time,
					rms,
					flatness,
					subBass,
					onsetDensity,
					clock: {
						tempoBpm: 120,
						beatPhase,
						beatPulse: Math.pow(1 - beatPhase, 3),
						downbeatFlag: beatIndexAbsolute % 4 === 0 && beatPhase < 0.1,
						barIndex: Math.floor(beatIndexAbsolute / 4),
						beatIndex: beatIndexAbsolute % 4,
						phrasePos: (beatIndexAbsolute % 32 + beatPhase) / 32,
						phraseIndex: Math.floor(beatIndexAbsolute / 32)
					}
				});
				sawBuild ||= state.buildActive;
				sawLanding ||= state.postDropDecay >= 0.99 && !state.buildActive;
				return state;
			};

			// Establish a long, stable baseline for the detector's recent and
			// historical windows.
			for (let i = 0; i < 360; i += 1) update(0.08, 0.82, 0.5, 0.04);
			// A classic build signature: RMS and onset density climb, flatness and
			// sub-bass fall.
			for (let i = 0; i < 120; i += 1) {
				const t = i / 119;
				update(0.08 + t * 0.2, 0.82 - t * 0.38, 0.5 - t * 0.32, 0.04 + t * 0.62);
			}
			// The landing restores sub-bass while RMS rises sharply. The build
			// signature itself naturally collapses during this phase.
			for (let i = 0; i < 90 && !sawLanding; i += 1) {
				const t = i / 89;
				update(0.28 + t * 0.58, 0.44, 0.9, 0.66);
			}

			return { sawBuild, sawLanding };
		});

		expect(result).toEqual({ sawBuild: true, sawLanding: true });
	});

	test('real-frequency mapping sends 60-150 Hz energy to the kick band', async ({ page }) => {
		await page.goto('/');
		const bands = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/signal/spectrum.ts';
			const spectrum = await import(modulePath);
			const bins = new Array(spectrum.SIGNAL_SPECTRUM_BIN_COUNT).fill(0);
			for (let index = 0; index < bins.length; index += 1) {
				const [low, high] = spectrum.signalAnalyzerBinRange(index, 48_000, bins.length);
				const center = Math.sqrt(low * high);
				if (center >= 60 && center <= 150) bins[index] = 0.9;
			}
			return Array.from(spectrum.deriveSignalBandEnergies(bins, 48_000));
		});

		const kick = bands[1];
		expect(kick).toBeGreaterThan(0);
		for (const [index, energy] of bands.entries()) {
			if (index !== 1) expect(kick).toBeGreaterThan(energy);
		}
	});

	test('section form profiles are normalized, directional, and phrase-deterministic', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/signal/conductor.ts';
			const conductor = await import(modulePath);
			const sections = [
				'calm',
				'intro',
				'verse',
				'pre_chorus',
				'build',
				'drop',
				'chorus',
				'bridge',
				'breakdown',
				'outro'
			] as const;
			const profiles = Object.fromEntries(
				sections.map((section) => [section, conductor.getSignalSectionProfile(section)])
			);
			const profileWeightSums = sections.map((section) => {
				const shapes = profiles[section].shapes;
				return shapes.ellipse + shapes.lissajous + shapes.ribbon + shapes.rosette;
			});

			const normalized = Array.from(
				conductor.normalizeSignalShapeWeightArray(new Float32Array([3, -2, 1, 2]))
			);
			const degenerate = Array.from(
				conductor.normalizeSignalShapeWeightArray(
					new Float32Array([Number.NaN, -1, 0, Number.NEGATIVE_INFINITY])
				)
			);

			const first = Array.from(
				conductor.fillSignalPhraseVariation(new Float32Array(4), 'deterministic-track', 7)
			);
			const repeated = Array.from(
				conductor.fillSignalPhraseVariation(new Float32Array(4), 'deterministic-track', 7)
			);
			const nextPhrase = Array.from(
				conductor.fillSignalPhraseVariation(new Float32Array(4), 'deterministic-track', 8)
			);

			return {
				profileWeightSums,
				normalized,
				degenerate,
				verse: profiles.verse,
				build: profiles.build,
				drop: profiles.drop,
				first,
				repeated,
				nextPhrase
			};
		});

		for (const sum of result.profileWeightSums) expect(sum).toBeCloseTo(1, 6);
		expect(result.normalized.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
		expect(result.normalized.every((weight) => Number.isFinite(weight) && weight >= 0)).toBe(true);
		expect(result.degenerate).toEqual([0, 1, 0, 0]);

		// A build contracts and winds the trace; its landing reverses those rails
		// into a visibly wider, ringing release.
		expect(result.build.tension).toBeGreaterThan(result.verse.tension);
		expect(result.build.openness).toBeLessThan(result.verse.openness);
		expect(result.drop.openness).toBeGreaterThan(result.build.openness);
		expect(result.drop.release).toBeGreaterThan(result.build.release);

		expect(result.repeated).toEqual(result.first);
		expect(result.nextPhrase).not.toEqual(result.first);
		expect(result.first.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 6);
	});
});
