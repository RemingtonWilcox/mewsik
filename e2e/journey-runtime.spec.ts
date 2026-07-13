import { expect, test } from '@playwright/test';

test.describe('shared visualizer journey runtime', () => {
	test('cached getters are idempotent and analyzer events advance every engine while Mk1 is selected', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/state/visualizer.svelte.ts';
			const { useVisualizer } = await import(modulePath);
			const vis = useVisualizer();
			const base = performance.now() + 100;
			const identity = `journey-idempotent-${Math.random()}`;
			const frame = {
				bins: Array.from({ length: 64 }, (_, index) => 0.52 + Math.sin(index * 0.7) * 0.08),
				rms: 0.28,
				peak: 0.62,
				centroid: 0.43,
				onset: false,
				bass: 0.48,
				mid: 0.4,
				treble: 0.31,
				sample_rate: 48_000,
				bpm: 124,
				beat_phase: 0.35,
				chroma_key: 0.42,
				chroma_strength: 0.72
			};

			vis.setEngine('mk1');
			vis.resetPerformance(identity, base);
			vis.setLatest(frame, base + 16);
			const first = vis.getJourney(base + 16);
			const before = {
				epoch: first.sourceEpoch,
				travel: first.signal.spectrumTravel,
				trace: first.signal.tracePhase,
				camera: first.mk2.cameraPhase,
				background: first.mk2.backgroundFlowPhase,
				rotation: first.mk2.rotationPhase
			};
			const repeated = vis.getJourney(base + 16);
			const directorOnly = vis.getPerformance(base + 16);
			vis.setLatest({ ...frame, beat_phase: 0.41, onset: true }, base + 32);
			const progressed = vis.getJourney(base + 32);

			return {
				sameSnapshot: first === repeated,
				sameDirector: directorOnly === repeated.director,
				newSnapshotAfterEvent: progressed !== first,
				before,
				after: {
					epoch: progressed.sourceEpoch,
					travel: progressed.signal.spectrumTravel,
					trace: progressed.signal.tracePhase,
					camera: progressed.mk2.cameraPhase,
					background: progressed.mk2.backgroundFlowPhase,
					rotation: progressed.mk2.rotationPhase
				}
			};
		});

		expect(result.sameSnapshot).toBe(true);
		expect(result.sameDirector).toBe(true);
		expect(result.newSnapshotAfterEvent).toBe(true);
		expect(result.after.epoch).toBe(result.before.epoch);
		expect(result.after.travel).toBeGreaterThan(result.before.travel);
		expect(result.after.trace).toBeGreaterThan(result.before.trace);
		expect(result.after.camera).toBeGreaterThan(result.before.camera);
		expect(result.after.background).toBeGreaterThan(result.before.background);
		expect(result.after.rotation).not.toBe(result.before.rotation);
	});

	test('Signal and Mk2 remount against the same continuously advancing source epoch', async ({
		page
	}) => {
		await page.goto('/visualizer-test');
		await page.getByRole('button', { name: 'Signal', exact: true }).click();
		await page.waitForTimeout(120);
		const readJourney = () =>
			page.evaluate(async () => {
				const { useVisualizer } = await import('/src/lib/state/visualizer.svelte.ts');
				const snapshot = useVisualizer().getJourney();
				return {
					epoch: snapshot.sourceEpoch,
					travel: snapshot.signal.spectrumTravel,
					trace: snapshot.signal.tracePhase,
					camera: snapshot.mk2.cameraPhase,
					background: snapshot.mk2.backgroundFlowPhase
				};
			});

		const before = await readJourney();
		await page.getByRole('button', { name: 'Soma · mk2', exact: true }).click();
		await page.waitForTimeout(120);
		const duringMk2 = await readJourney();
		await page.getByRole('button', { name: 'Signal', exact: true }).click();
		await page.waitForTimeout(120);
		const after = await readJourney();

		expect(duringMk2.epoch).toBe(before.epoch);
		expect(after.epoch).toBe(before.epoch);
		expect(duringMk2.travel).toBeGreaterThan(before.travel);
		expect(after.travel).toBeGreaterThan(duringMk2.travel);
		expect(after.trace).toBeGreaterThan(before.trace);
		expect(after.camera).toBeGreaterThan(duringMk2.camera);
		expect(after.background).toBeGreaterThan(duringMk2.background);
	});

	test('A to B to A creates clean monotonic epochs without synthesizing an initial impact', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { useVisualizer } = await import('/src/lib/state/visualizer.svelte.ts');
			const vis = useVisualizer();
			const base = performance.now() + 100;
			const unique = `journey-aba-${Math.random()}`;
			const sample = (identity: string, at: number) => {
				vis.resetPerformance(identity, at);
				const snapshot = vis.getJourney(at);
				return {
					epoch: snapshot.sourceEpoch,
					seed: snapshot.seed,
					signalImpact: snapshot.signal.impact,
					mk2Impact: snapshot.mk2.impact,
					trace: snapshot.signal.tracePhase,
					camera: snapshot.mk2.cameraPhase,
					background: snapshot.mk2.backgroundFlowPhase,
					detailMagnitude: Array.from(snapshot.spectrum.detailBins).reduce(
						(sum, value) => sum + Math.abs(value),
						0
					)
				};
			};

			return {
				a: sample(`${unique}-a`, base),
				b: sample(`${unique}-b`, base + 50),
				aAgain: sample(`${unique}-a`, base + 100)
			};
		});

		expect(result.b.epoch - result.a.epoch).toBe(1);
		expect(result.aAgain.epoch - result.b.epoch).toBe(1);
		expect(result.aAgain.seed).toBe(result.a.seed);
		expect(result.b.seed).not.toBe(result.a.seed);
		expect(result.aAgain.camera).toBeCloseTo(result.a.camera, 8);
		expect(result.aAgain.background).toBeCloseTo(result.a.background, 8);
		for (const snapshot of [result.a, result.b, result.aAgain]) {
			expect(snapshot.signalImpact).toBe(0);
			expect(snapshot.mk2Impact).toBe(0);
			expect(snapshot.trace).toBe(0);
			expect(snapshot.detailMagnitude).toBe(0);
		}
	});

	test('pause decays the same journey without changing its source epoch', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { useVisualizer } = await import('/src/lib/state/visualizer.svelte.ts');
			const vis = useVisualizer();
			const base = performance.now() + 100;
			const identity = `journey-pause-${Math.random()}`;
			const bins = Array.from({ length: 64 }, (_, index) =>
				index < 18 ? 0.92 : 0.58
			);
			const loud = {
				bins,
				rms: 0.62,
				peak: 0.98,
				centroid: 0.36,
				onset: true,
				bass: 0.95,
				mid: 0.55,
				treble: 0.32,
				sample_rate: 48_000,
				bpm: 128,
				beat_phase: 0.02,
				chroma_key: 0.25,
				chroma_strength: 0.8
			};

			vis.resetPerformance(identity, base);
			for (let index = 1; index <= 24; index += 1) {
				vis.setLatest({ ...loud, onset: index % 6 === 0 }, base + index * 16);
			}
			const before = vis.getJourney(base + 24 * 16);
			const beforeValues = {
				epoch: before.sourceEpoch,
				seed: before.seed,
				impact: before.mk2.impact,
				camera: before.mk2.cameraPhase
			};
			const pausedAt = base + 24 * 16 + 1;
			vis.clearLatest(pausedAt);
			let after = vis.getJourney(pausedAt);
			for (let index = 1; index <= 150; index += 1) {
				after = vis.getJourney(pausedAt + index * 16);
			}
			return {
				before: beforeValues,
				after: {
					epoch: after.sourceEpoch,
					seed: after.seed,
					impact: after.mk2.impact,
					camera: after.mk2.cameraPhase
				}
			};
		});

		expect(result.before.impact).toBeGreaterThan(0.1);
		expect(result.after.impact).toBeLessThan(result.before.impact);
		expect(result.after.impact).toBeLessThan(0.02);
		expect(result.after.epoch).toBe(result.before.epoch);
		expect(result.after.seed).toBe(result.before.seed);
		expect(result.after.camera).toBeGreaterThan(result.before.camera);
	});

	test('null journey cadence is stable on 60 and 144 Hz render loops', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { useVisualizer } = await import('/src/lib/state/visualizer.svelte.ts');
			const vis = useVisualizer();
			const bins = Array.from({ length: 64 }, (_, index) =>
				index < 20 ? 0.86 : 0.48 + Math.sin(index * 0.4) * 0.08
			);
			const loud = {
				bins,
				rms: 0.54,
				peak: 0.92,
				centroid: 0.38,
				onset: false,
				bass: 0.82,
				mid: 0.5,
				treble: 0.3,
				sample_rate: 48_000,
				bpm: 126,
				beat_phase: 0.2,
				chroma_key: 0.3,
				chroma_strength: 0.7
			};

			const run = (hz: number, base: number) => {
				vis.resetPerformance(`null-cadence-${hz}-${Math.random()}`, base);
				for (let index = 1; index <= 30; index += 1) {
					vis.setLatest({ ...loud, onset: index % 10 === 0 }, base + index * (1000 / 60));
				}
				const pausedAt = base + 30 * (1000 / 60) + 1;
				const before = vis.getJourney(pausedAt - 1);
				const origin = {
					camera: before.mk2.cameraPhase,
					background: before.mk2.backgroundFlowPhase,
					trace: before.signal.tracePhase
				};
				vis.clearLatest(pausedAt);
				const step = 1000 / hz;
				for (let elapsed = step; elapsed <= 2000 + 1e-6; elapsed += step) {
					vis.getJourney(pausedAt + elapsed);
				}
				const after = vis.getJourney(pausedAt + 2000);
				return {
					impact: after.mk2.impact,
					camera: after.mk2.cameraPhase - origin.camera,
					background: after.mk2.backgroundFlowPhase - origin.background,
					trace: after.signal.tracePhase - origin.trace
				};
			};

			return {
				at60: run(60, performance.now() + 100),
				at144: run(144, performance.now() + 10_000)
			};
		});

		expect(result.at60.impact).toBeLessThan(0.02);
		expect(result.at144.impact).toBeLessThan(0.02);
		expect(Math.abs(result.at60.camera - result.at144.camera)).toBeLessThan(0.002);
		expect(Math.abs(result.at60.background - result.at144.background)).toBeLessThan(0.002);
		expect(Math.abs(result.at60.trace - result.at144.trace)).toBeLessThan(0.003);
	});
});
