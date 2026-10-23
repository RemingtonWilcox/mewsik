import { expect, test } from '@playwright/test';

// Organic motion: smooth, bounded, deterministic, and never periodic.
test.describe('organic motion', () => {
	test('wander and roamer never repeat, stay smooth and bounded, and are deterministic', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { Wander, Roamer, noise1 } = await import('/src/lib/visualizer/motion.ts');
			const dt = 1 / 30;
			const frames = 30 * 60 * 10; // ten minutes
			const trace = (make: () => { update(dt: number): Float32Array }) => {
				const m = make();
				const xs: number[] = [];
				for (let i = 0; i < frames; i += 1) xs.push(m.update(dt)[0]);
				return xs;
			};
			const w = trace(() => new Wander(2, 'w', 12));
			const r = trace(() => new Roamer(3, 'r', { meanHold: 8 }));
			const r2 = trace(() => new Roamer(3, 'r', { meanHold: 8 }));

			// Strongest normalized autocorrelation at lags of 20 s .. 5 min: a
			// periodic path scores ~1 at its period; organic motion stays low.
			const peakCorrelation = (xs: number[]) => {
				const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
				const c = xs.map((x) => x - mean);
				const var0 = c.reduce((a, b) => a + b * b, 0);
				let peak = 0;
				for (let lag = 30 * 20; lag <= 30 * 300; lag += 15) {
					let sum = 0;
					for (let i = 0; i + lag < c.length; i += 1) sum += c[i] * c[i + lag];
					peak = Math.max(peak, sum / var0);
				}
				return peak;
			};
			const maxStep = (xs: number[]) => xs.reduce((m, x, i) => (i ? Math.max(m, Math.abs(x - xs[i - 1])) : 0), 0);
			// A sine path for contrast.
			const sine = Array.from({ length: frames }, (_, i) => Math.sin((i * dt * Math.PI * 2) / 40));
			return {
				wanderPeak: peakCorrelation(w),
				roamerPeak: peakCorrelation(r),
				sinePeak: peakCorrelation(sine),
				wanderStep: maxStep(w),
				roamerStep: maxStep(r),
				bounded: [...w, ...r].every((x) => x >= -1.05 && x <= 1.05),
				deterministic: JSON.stringify(r) === JSON.stringify(r2),
				noiseRange: [noise1(1, 0, 0.3), noise1(1, 0, 123.4)].every((x) => x >= -1 && x <= 1)
			};
		});
		// The sine control is periodic; wander and roam are not.
		expect(result.sinePeak).toBeGreaterThan(0.9);
		expect(result.wanderPeak).toBeLessThan(0.5);
		expect(result.roamerPeak).toBeLessThan(0.5);
		// Smooth at 30 fps: no frame jumps more than a few percent of the range.
		expect(result.wanderStep).toBeLessThan(0.03);
		expect(result.roamerStep).toBeLessThan(0.05);
		expect(result.bounded).toBe(true);
		expect(result.deterministic).toBe(true);
		expect(result.noiseRange).toBe(true);
	});
});
