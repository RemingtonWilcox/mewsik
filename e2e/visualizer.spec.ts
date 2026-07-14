import { expect, test } from '@playwright/test';

async function expectProductionEngine(
	page: import('@playwright/test').Page,
	engine: 'mk1' | 'mk2' | 'signal'
) {
	await expect(page.locator('[data-visualizer-host]')).toHaveAttribute(
		'data-render-engine',
		engine
	);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.engine')))
		.toBe(engine);
}

async function expectVisualizerChrome(
	page: import('@playwright/test').Page,
	visible: boolean,
	timeout = 4_000
) {
	const expected = String(visible);
	await expect
		.poll(
			async () => ({
				host: await page.locator('[data-visualizer-host]').getAttribute('data-controls-visible'),
				player: await page.locator('[data-player-bar]').getAttribute('data-visualizer-chrome-visible')
			}),
			{ timeout }
		)
		.toEqual({ host: expected, player: expected });
}

test.describe('visualizer engine roster', () => {
	test('lab exposes only the supported engines and keyboard routes', async ({ page }) => {
		await page.goto('/visualizer-test');
		await page.waitForLoadState('networkidle');

		await expect(page.getByText('visualizer lab')).toBeVisible();
		await expect(page.getByRole('button', { name: 'auto · stable' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Prism · mk1', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Soma · mk2', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Signal', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'mk3', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'runtime', exact: true })).toHaveCount(0);
		// Lab engines are embedded canvases, not fake full-screen buttons.
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toHaveCount(0);

		await page.getByRole('button', { name: 'Signal', exact: true }).click();
		await expect(page.getByText(/Signal · phosphor score/)).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.engine')))
			.toBe('signal');
		await page.keyboard.press('a');
		await expect(page.getByText(/Signal · phosphor score/)).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.engine')))
			.toBe('signal');

		await page.keyboard.press('w');
		await expect(page.getByText(/Soma · mk2/).last()).toBeVisible();
		await page.keyboard.press('q');
		await expect(page.getByText(/Prism · mk1/).last()).toBeVisible();
	});

	test('named production rail uses arrows, retires V, persists response, and Escape closes', async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('mewsik.visualizer.engine', 'auto');
		});
		await page.goto('/');
		await page.getByRole('button', { name: 'Visualizer' }).click();

		await expectProductionEngine(page, 'mk1');
		await expect(page.locator('[data-visualizer-host]')).toHaveAttribute('data-engine-name', 'Prism');
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toBeVisible();
		await expect(page.locator('[data-app-content]')).toHaveAttribute('inert', '');
		await page.keyboard.press('Control+k');
		await expect(page.getByPlaceholder('Search songs, artists, albums...')).toHaveCount(0);

		await page.keyboard.press('v');
		await expectProductionEngine(page, 'mk1');
		await page.keyboard.press('ArrowRight');
		await expectProductionEngine(page, 'mk2');
		await expect(page.locator('[data-visualizer-host]')).toHaveAttribute('data-engine-name', 'Soma');
		await expect(page.getByLabel('Soma audio visualizer')).toHaveAttribute(
			'data-mk2-render-passes',
			'8'
		);
		await expect(page.getByLabel('Soma audio visualizer')).toHaveAttribute(
			'data-mk2-uniform-bytes',
			'288'
		);
		await expect(page.getByLabel('Soma audio visualizer')).toHaveAttribute(
			'data-mk2-form',
			/seed|sprout|winding|bloom|shedding|dormancy/
		);
		await page.keyboard.press('ArrowRight');
		await expectProductionEngine(page, 'signal');
		await expect(page.getByLabel('Signal audio visualizer')).toHaveCount(1);
		await page.keyboard.press('ArrowRight');
		await expectProductionEngine(page, 'mk1');
		await page.keyboard.press('ArrowLeft');
		await expectProductionEngine(page, 'signal');
		await page.getByRole('button', { name: /Signal: Phosphor score\. Show details/ }).click();
		await page.getByRole('button', { name: 'Calm', exact: true }).click();
		await expect(page.locator('[data-visualizer-host]')).toHaveAttribute(
			'data-visualizer-response',
			'still'
		);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.response')))
			.toBe('still');
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-visualizer-host]')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Close visualizer' })).toHaveCount(0);
		await expect(page.locator('[data-app-content]')).not.toHaveAttribute('inert', '');
	});

	test('engine and playback chrome share one fast idle clock and interaction holds', async ({ page }) => {
		await page.goto('/');
		const opener = page.getByRole('button', { name: 'Visualizer' });
		await opener.click();
		await expect(page.locator('[data-visualizer-host]')).toBeFocused();
		await expect(page.locator('[data-app-content]')).toHaveAttribute('inert', '');
		await expectVisualizerChrome(page, true);
		await expectVisualizerChrome(page, false);

		// A Window-level event is not enough; wake events must come from an app surface.
		await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove')));
		await page.waitForTimeout(200);
		await expectVisualizerChrome(page, false, 500);

		// Activity over the actual visualizer surface wakes both layers together.
		await page.mouse.move(160, 280);
		await expectVisualizerChrome(page, true);

		// A stationary pointer over either control surface keeps both available.
		const playerBar = page.locator('[data-player-bar]');
		await playerBar.hover();
		await page.waitForTimeout(2_500);
		await expectVisualizerChrome(page, true, 500);
		await page.mouse.move(160, 280);
		await expectVisualizerChrome(page, false);

		// Genuine keyboard focus is also a hold, unlike focus left by a pointer click.
		await page.mouse.move(180, 300);
		await expectVisualizerChrome(page, true);
		const title = page.getByRole('button', { name: /Prism: Rhythmic geometry\. Show details/ });
		await title.focus();
		await expect(title).toBeFocused();
		await page.waitForTimeout(2_500);
		await expectVisualizerChrome(page, true, 500);

		await page.keyboard.press('Escape');
		await expect(opener).toBeFocused();
	});

	test('manual Hide stays locked until H, I, or a stage click explicitly reveals it', async ({ page }) => {
		await page.goto('/');
		const opener = page.getByRole('button', { name: 'Visualizer' });
		await opener.click();

		const host = page.locator('[data-visualizer-host]');
		await page
			.getByRole('navigation', { name: 'Visualizer engines' })
			.getByRole('button', { name: 'Hide visualizer controls', exact: true })
			.click();
		await expect(host).toHaveAttribute('data-controls-mode', 'locked-hidden');
		await expectVisualizerChrome(page, false);

		// Ordinary movement and engine keyboard routes must not defeat the lock.
		await page.mouse.move(80, 180);
		await page.mouse.move(360, 420);
		await page.keyboard.press('ArrowRight');
		await expectProductionEngine(page, 'mk2');
		await page.waitForTimeout(350);
		await expectVisualizerChrome(page, false, 500);

		await page.keyboard.press('i');
		await expect(host).toHaveAttribute('data-controls-mode', 'auto');
		await expectVisualizerChrome(page, true);
		await expect(page.getByRole('region', { name: 'Soma visualizer details' })).toBeVisible();
		await page.keyboard.press('i');

		await page.keyboard.press('h');
		await expect(host).toHaveAttribute('data-controls-mode', 'locked-hidden');
		await expectVisualizerChrome(page, false);
		await page.keyboard.press('h');
		await expect(host).toHaveAttribute('data-controls-mode', 'auto');
		await expectVisualizerChrome(page, true);

		await page.keyboard.press('h');
		await page.getByRole('button', { name: 'Show visualizer controls' }).click();
		await expect(host).toHaveAttribute('data-controls-mode', 'auto');
		await expectVisualizerChrome(page, true);

		await page.keyboard.press('Escape');
		await expect(opener).toBeFocused();
	});

	test('response mode repairs invalid storage and hydrates across a reload', async ({ page }) => {
		await page.addInitScript(() => {
			if (sessionStorage.getItem('response-seeded')) return;
			sessionStorage.setItem('response-seeded', 'true');
			localStorage.setItem('mewsik.visualizer.response', 'maximum-chaos');
		});
		await page.goto('/');
		await page.getByRole('button', { name: 'Visualizer' }).click();
		await expect(page.locator('[data-visualizer-host]')).toHaveAttribute(
			'data-visualizer-response',
			'flow'
		);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('mewsik.visualizer.response')))
			.toBe('flow');

		await page.keyboard.press('i');
		await page.getByRole('button', { name: 'Surge', exact: true }).click();
		await page.keyboard.press('Escape');
		await page.reload();
		await page.getByRole('button', { name: 'Visualizer' }).click();
		await expect(page.locator('[data-visualizer-host]')).toHaveAttribute(
			'data-visualizer-response',
			'surge'
		);
	});

	test('response profiles preserve Flow and scale Calm through Surge monotonically', async ({ page }) => {
		await page.goto('/');
		const profiles = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/catalog.ts';
			const { VISUALIZER_RESPONSE_PROFILES } = await import(modulePath);
			return VISUALIZER_RESPONSE_PROFILES;
		});

		expect(profiles.mk1.flow).toEqual({
			motion: 1,
			impact: 1,
			bloomThresholdOffset: 0,
			feedbackFadeOffset: 0
		});
		expect(profiles.mk2.flow).toEqual({ motion: 1, impact: 1, fog: 1, shafts: 1 });
		expect(profiles.signal.flow).toEqual({
			motion: 1,
			impact: 1,
			persistenceOffset: 0,
			stroke: 1,
			saturation: 1
		});

		for (const rail of ['motion', 'impact'] as const) {
			expect(profiles.mk1.still[rail]).toBeLessThan(profiles.mk1.flow[rail]);
			expect(profiles.mk1.flow[rail]).toBeLessThan(profiles.mk1.surge[rail]);
			expect(profiles.mk2.still[rail]).toBeLessThan(profiles.mk2.flow[rail]);
			expect(profiles.mk2.flow[rail]).toBeLessThan(profiles.mk2.surge[rail]);
			expect(profiles.signal.still[rail]).toBeLessThan(profiles.signal.flow[rail]);
			expect(profiles.signal.flow[rail]).toBeLessThan(profiles.signal.surge[rail]);
		}
		for (const rail of ['fog', 'shafts'] as const) {
			expect(profiles.mk2.still[rail]).toBeLessThan(profiles.mk2.flow[rail]);
			expect(profiles.mk2.flow[rail]).toBeLessThan(profiles.mk2.surge[rail]);
		}
		for (const rail of ['persistenceOffset', 'stroke', 'saturation'] as const) {
			expect(profiles.signal.still[rail]).toBeLessThan(profiles.signal.flow[rail]);
			expect(profiles.signal.flow[rail]).toBeLessThan(profiles.signal.surge[rail]);
		}
		expect(profiles.mk1.still.feedbackFadeOffset).toBeLessThan(
			profiles.mk1.flow.feedbackFadeOffset
		);
		expect(profiles.mk1.flow.feedbackFadeOffset).toBeLessThan(
			profiles.mk1.surge.feedbackFadeOffset
		);
		expect(profiles.mk1.still.bloomThresholdOffset).toBeGreaterThan(
			profiles.mk1.flow.bloomThresholdOffset
		);
		expect(profiles.mk1.flow.bloomThresholdOffset).toBeGreaterThan(
			profiles.mk1.surge.bloomThresholdOffset
		);
	});

	test('legacy and unknown engines migrate to supported renderers', async ({ browser }) => {
		for (const [legacy, expectedEngine] of [
			['mk3', 'signal'],
			['runtime', 'mk1'],
			['not-an-engine', 'mk1']
		] as const) {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.addInitScript((savedEngine) => {
				localStorage.setItem('mewsik.visualizer.engine', savedEngine);
			}, legacy);
			await page.goto('/');
			await page.getByRole('button', { name: 'Visualizer' }).click();
			await expectProductionEngine(page, expectedEngine);
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

	test('weak steady air cannot self-normalize to kick strength', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/signal/spectrum.ts';
			const spectrum = await import(modulePath);
			const sampleRate = 48_000;
			const encodeMagnitude = (magnitude: number) =>
				Math.max(0, Math.min(1, Math.log10(Math.max(magnitude, 1e-7)) * 0.4 + 1));
			const bins = new Array(spectrum.SIGNAL_SPECTRUM_BIN_COUNT).fill(0);
			for (let index = 0; index < bins.length; index += 1) {
				const [low, high] = spectrum.signalAnalyzerBinRange(index, sampleRate, bins.length);
				const center = Math.sqrt(low * high);
				if (center >= 60 && center < 150) bins[index] = encodeMagnitude(0.5);
				else if (center >= 6_000) bins[index] = encodeMagnitude(0.005);
			}

			const tracker = new spectrum.SignalSpectrumTracker(sampleRate);
			let profile = tracker.update(null, 1 / 60);
			const frame = {
				bins,
				rms: 0.2,
				peak: 0.5,
				centroid: 0.35,
				sample_rate: sampleRate
			};
			for (let i = 0; i < 600; i += 1) profile = tracker.update(frame, 1 / 60);
			return {
				kick: profile.levels.kick,
				air: profile.levels.air,
				ratio: profile.levels.air / Math.max(profile.levels.kick, 1e-6)
			};
		});

		expect(result.kick).toBeGreaterThan(0.65);
		expect(result.air).toBeLessThan(0.2);
		expect(result.ratio).toBeLessThan(0.25);
	});

	test('signed spectrum detail preserves broadband contrast without onset clipping', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/signal/spectrum.ts';
			const spectrum = await import(modulePath);
			const encodeMagnitude = (magnitude: number) =>
				Math.max(0, Math.min(1, Math.log10(Math.max(magnitude, 1e-7)) * 0.4 + 1));
			const magnitudes = Array.from(
				{ length: spectrum.SIGNAL_SPECTRUM_BIN_COUNT },
				(_, index) =>
					0.025 +
					0.22 *
						(0.5 + Math.sin(index * 1.73) * 0.5) *
						(1 - index / 96)
			);
			const bins = magnitudes.map(encodeMagnitude);
			const tracker = new spectrum.SignalSpectrumTracker(48_000);
			const profile = tracker.update(
				{ bins, rms: 0.12, peak: 0.3, centroid: 0.38, sample_rate: 48_000 },
				1 / 60
			);
			const detail = Array.from(profile.detailBins);
			let strongestIndex = 0;
			let weakestIndex = 0;
			for (let index = 1; index < magnitudes.length; index += 1) {
				if (magnitudes[index] > magnitudes[strongestIndex]) strongestIndex = index;
				if (magnitudes[index] < magnitudes[weakestIndex]) weakestIndex = index;
			}
			return {
				clipped: detail.filter((value) => Math.abs(value) >= 0.999).length,
				strongest: detail[strongestIndex],
				weakest: detail[weakestIndex],
				finite: detail.every(Number.isFinite)
			};
		});

		expect(result.finite).toBe(true);
		expect(result.clipped).toBeLessThanOrEqual(2);
		expect(result.strongest).toBeGreaterThan(0.45);
		expect(result.weakest).toBeLessThan(0.2);
		expect(result.strongest - result.weakest).toBeGreaterThan(0.3);
	});

	test('phrase polarity and spectrum travel remain continuous across a phrase wrap', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const conductorPath = '/src/lib/visualizer/signal/conductor.ts';
			const spectrumPath = '/src/lib/visualizer/signal/spectrum.ts';
			const conductorModule = await import(conductorPath);
			const spectrumModule = await import(spectrumPath);

			let seed: number | string = 'phrase-continuity';
			for (let candidate = 1; candidate < 1_000; candidate += 1) {
				const before = conductorModule.fillSignalPhraseVariation(
					new Float32Array(4),
					candidate,
					7
				);
				const after = conductorModule.fillSignalPhraseVariation(
					new Float32Array(4),
					candidate,
					8
				);
				if (before[3] * after[3] < 0) {
					seed = candidate;
					break;
				}
			}

			const spectral = new spectrumModule.SignalSpectrumTracker(48_000);
			const bins = new Array(64).fill(0.65);
			let spectrum = spectral.update(
				{ bins, rms: 0.18, peak: 0.4, centroid: 0.42, sample_rate: 48_000 },
				1 / 60
			);
			for (let i = 0; i < 180; i += 1) {
				spectrum = spectral.update(
					{ bins, rms: 0.18, peak: 0.4, centroid: 0.42, sample_rate: 48_000 },
					1 / 60
				);
			}

			const makeFrame = (phraseIndex: number, phrasePos: number) =>
				({
					section: 'verse',
					sectionAge: 8,
					motif: 'organism',
					motifIndex: 0,
					silence: false,
					energy: 0.45,
					density: 0.4,
					motion: 0.42,
					structure: 0.6,
					phrase: phrasePos,
					palette: { baseHue: 0.4, accentHue: 0.58, rimHue: 0.82, saturation: 0.7, warmth: 0.5 },
					paletteBase: 0.4,
					paletteAccent: 0.58,
					clock: {
						tempoBpm: 120,
						beatPhase: 0.9,
						beatPulse: 0.001,
						downbeatFlag: false,
						barIndex: phraseIndex * 8 + 7,
						beatIndex: 3,
						phrasePos,
						phraseIndex
					},
					drop: { buildActive: false, buildProgress: 0, dropEta: 0, anticipation: 0, postDropDecay: 0 },
					valence: 0.5,
					arousal: 0.45,
					bassPunch: 0,
					trebleSparkle: 0,
					tonnetz: [1, 0, 0.5, 0.866, -0.5, 0.866],
					bassRaw: 0.2,
					midRaw: 0.3,
					trebleRaw: 0.2,
					centroidRaw: 0.42,
					context: {
						source: 'live',
						sectionProgress: phrasePos,
						sectionEnergy: 0.45,
						trackProgress: 0,
						energyCurrent: 0.45,
						energySlope: 0,
						energyLookahead: 0.45,
						keyPitchClass: 0,
						keyMode: 'unknown',
						keyConfidence: 0.5
					}
				}) as any;

			const conductor = new conductorModule.SignalConductor(seed);
			let before = conductor.update(makeFrame(7, 0.99), spectrum as any, 1 / 60);
			for (let i = 0; i < 240; i += 1) {
				before = conductor.update(makeFrame(7, 0.99), spectrum as any, 1 / 60);
			}
			const beforeWeights = { ...before.shapeWeights };
			const beforeAsymmetry = before.signedAsymmetry;
			const beforeTravel = before.spectrumTravel;
			const after = conductor.update(makeFrame(8, 0), spectrum as any, 1 / 60);
			const travelDeltaRaw = Math.abs(after.spectrumTravel - beforeTravel);
			return {
				asymmetryDelta: Math.abs(after.signedAsymmetry - beforeAsymmetry),
				travelDelta: Math.min(travelDeltaRaw, 1 - travelDeltaRaw),
				shapeDelta: Math.max(
					Math.abs(after.shapeWeights.ellipse - beforeWeights.ellipse),
					Math.abs(after.shapeWeights.lissajous - beforeWeights.lissajous),
					Math.abs(after.shapeWeights.ribbon - beforeWeights.ribbon),
					Math.abs(after.shapeWeights.rosette - beforeWeights.rosette)
				)
			};
		});

		expect(result.asymmetryDelta).toBeLessThan(0.03);
		expect(result.travelDelta).toBeLessThan(0.001);
		expect(result.shapeDelta).toBeLessThan(0.01);
	});

	test('landing ring-out stays tempo-relative and does not retrigger from drop to chorus', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const conductorPath = '/src/lib/visualizer/signal/conductor.ts';
			const spectrumPath = '/src/lib/visualizer/signal/spectrum.ts';
			const conductorModule = await import(conductorPath);
			const spectrumModule = await import(spectrumPath);
			const tracker = new spectrumModule.SignalSpectrumTracker(48_000);
			const bins = new Array(64).fill(0.62);
			let spectrum = tracker.update(
				{ bins, rms: 0.2, peak: 0.42, centroid: 0.45, sample_rate: 48_000 },
				1 / 60
			);
			for (let i = 0; i < 120; i += 1) {
				spectrum = tracker.update(
					{ bins, rms: 0.2, peak: 0.42, centroid: 0.45, sample_rate: 48_000 },
					1 / 60
				);
			}

			const makeFrame = (
				section: 'verse' | 'drop' | 'chorus',
				postDropDecay: number,
				tempoBpm: number
			) =>
				({
					section,
					sectionAge: 4,
					motif: 'organism', motifIndex: 0, silence: false,
					energy: 0.65, density: 0.55, motion: 0.62, structure: 0.6, phrase: 0.2,
					palette: { baseHue: 0.4, accentHue: 0.58, rimHue: 0.82, saturation: 0.7, warmth: 0.5 },
					paletteBase: 0.4, paletteAccent: 0.58,
					clock: {
						tempoBpm, beatPhase: 0.4, beatPulse: 0.08, downbeatFlag: false,
						barIndex: 8, beatIndex: 1, phrasePos: 0.2, phraseIndex: 1
					},
					drop: { buildActive: false, buildProgress: 0, dropEta: 0, anticipation: 0, postDropDecay },
					valence: 0.5, arousal: 0.65, bassPunch: 0, trebleSparkle: 0,
					tonnetz: [1, 0, 0.5, 0.866, -0.5, 0.866],
					bassRaw: 0.2, midRaw: 0.3, trebleRaw: 0.2, centroidRaw: 0.45,
					context: {
						source: 'live', sectionProgress: 0.2, sectionEnergy: 0.65, trackProgress: 0,
						energyCurrent: 0.65, energySlope: 0, energyLookahead: 0.65,
						keyPitchClass: 0, keyMode: 'unknown', keyConfidence: 0.5
					}
				}) as any;

			const dt = 1 / 60;
			// Mirrors the live director: hold the landing for 0.4s, then apply its
			// historical 0.985-per-analyzer-frame post-drop decay.
			const productionPostDrop = (elapsed: number) =>
				elapsed <= 0.4 ? 1 : Math.pow(0.985, (elapsed - 0.4) * 60);
			const runTempo = (tempoBpm: number) => {
				const conductor = new conductorModule.SignalConductor(`ring-out-${tempoBpm}`);
				for (let i = 0; i < 120; i += 1) {
					conductor.update(makeFrame('verse', 0, tempoBpm), spectrum as any, dt);
				}

				let elapsed = dt;
				let current = conductor.update(makeFrame('drop', 1, tempoBpm), spectrum as any, dt);
				const landingRingOut = current.ringOut;
				const advanceDropTo = (targetSeconds: number) => {
					while (elapsed + dt <= targetSeconds + 1e-8) {
						elapsed += dt;
						current = conductor.update(
							makeFrame('drop', productionPostDrop(elapsed), tempoBpm),
							spectrum as any,
							dt
						);
					}
				};

				advanceDropTo(120 / tempoBpm);
				const twoBeatRingOut = current.ringOut;
				// The live FSM commonly relabels the same peak from drop to chorus
				// around here. That semantic relabel must not create another landing.
				advanceDropTo(2.75);
				const beforeChorus = current.ringOut;
				elapsed += dt;
				current = conductor.update(
					makeFrame('chorus', productionPostDrop(elapsed), tempoBpm),
					spectrum as any,
					dt
				);
				const afterChorus = current.ringOut;

				while (elapsed + dt <= 8 + 1e-8) {
					elapsed += dt;
					current = conductor.update(
						makeFrame('chorus', productionPostDrop(elapsed), tempoBpm),
						spectrum as any,
						dt
					);
				}
				return {
					tempoBpm,
					landingRingOut,
					twoBeatRingOut,
					beforeChorus,
					afterChorus,
					lateRingOut: current.ringOut,
					lateRelease: current.release,
					lateOpenness: current.openness
				};
			};

			const handoffConductor = new conductorModule.SignalConductor('live-score-handoff');
			for (let i = 0; i < 120; i += 1) {
				handoffConductor.update(makeFrame('verse', 0, 120), spectrum as any, dt);
			}
			const scoreFrame = makeFrame('chorus', 1, 120);
			scoreFrame.context.source = 'score';
			const handoff = handoffConductor.update(scoreFrame, spectrum as any, dt);

			return {
				tempoRuns: [60, 120, 180].map(runTempo),
				handoff: { sectionPulse: handoff.sectionPulse, ringOut: handoff.ringOut }
			};
		});

		const twoBeatValues = result.tempoRuns.map((entry) => entry.twoBeatRingOut);
		expect(Math.max(...twoBeatValues) - Math.min(...twoBeatValues)).toBeLessThan(0.03);
		for (const entry of result.tempoRuns) {
			expect(entry.landingRingOut).toBeGreaterThan(0.95);
			expect(entry.twoBeatRingOut).toBeGreaterThan(0.34);
			expect(entry.twoBeatRingOut).toBeLessThan(0.41);
			expect(entry.afterChorus).toBeLessThanOrEqual(entry.beforeChorus);
			expect(entry.afterChorus).toBeLessThan(0.3);
			expect(entry.lateRingOut).toBeLessThan(0.03);
			expect(entry.lateRelease).toBeGreaterThan(0.7);
			expect(entry.lateOpenness).toBeGreaterThan(0.75);
		}
		expect(result.handoff.sectionPulse).toBeLessThan(0.05);
		expect(result.handoff.ringOut).toBe(0);
	});
});
