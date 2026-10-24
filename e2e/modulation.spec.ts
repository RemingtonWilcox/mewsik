import { expect, test } from '@playwright/test';

// The modulation matrix: many parts, each listening to its own musical
// sources, re-routing over time without jumps.
test.describe('modulation matrix', () => {
	test('parts answer different sources, re-route without cuts, and resume', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { ModMatrix } = await import('/src/lib/visualizer/modulation.ts');
			const sources = [
				{ name: 'kick', family: 'drums', impulse: true },
				{ name: 'hats', family: 'drums', impulse: true },
				{ name: 'minor', family: 'harmony' },
				{ name: 'chordChange', family: 'harmony', impulse: true },
				{ name: 'swing', family: 'groove' },
				{ name: 'legato', family: 'articulation' },
				{ name: 'pan', family: 'space', signed: true }
			];
			const parts = Array.from({ length: 12 }, (_, i) => ({
				name: `cell${i}`,
				params: [
					{ name: 'glow', prefers: ['drums'] },
					{ name: 'hue', prefers: ['harmony'], depth: 0.5 },
					{ name: 'size', rest: 0.3, smooth: 0.5 }
				]
			}));
			const make = () => new ModMatrix(sources, parts, 'test', { meanHold: 12, crossfade: 2 });
			const m = make();
			const dt = 1 / 60;
			const channels = new Float32Array(sources.length);
			const trace: number[][] = [];
			let maxStep = 0;
			const routeSets = new Set<string>();
			let last = Array.from(m.values);
			for (let f = 0; f < 60 * 240; f += 1) {
				const t = f * dt;
				// Independent synthetic instruments.
				channels[0] = (t * 2) % 1 < 0.05 ? 1 : 0; // kick on beats
				channels[1] = (t * 8) % 1 < 0.03 ? 1 : 0; // hats
				channels[2] = 0.5 + 0.5 * Math.sin(t * 0.21);
				channels[3] = t % 4 < 0.03 ? 1 : 0;
				channels[4] = 0.5 + 0.5 * Math.sin(t * 0.07 + 1);
				channels[5] = 0.5 + 0.5 * Math.sin(t * 0.13 + 2);
				channels[6] = Math.sin(t * 0.05);
				const v = m.update(channels, dt, 0.5, f === 60 * 120 ? 1 : 0);
				if (f % 30 === 0) trace.push(Array.from(v));
				for (let i = 0; i < v.length; i += 1) {
					// size declares smooth: 0.5, so it must glide even when routed to a hit.
					if (i % 3 === 2) maxStep = Math.max(maxStep, Math.abs(v[i] - last[i]));
				}
				last = Array.from(v);
				if (f % 600 === 0) routeSets.add(JSON.stringify(m.routing().map((r) => r.source)));
			}
			// Distinct dominant sources across the glow params of the 12 cells.
			const glowSources = new Set(m.routing().filter((r) => r.param === 'glow').map((r) => r.source));
			// Mean pairwise correlation of the 12 cells' glow traces: low = independent cubies.
			const series = Array.from({ length: 12 }, (_, c) => trace.map((row) => row[c * 3]));
			const corr = (a: number[], b: number[]) => {
				const ma = a.reduce((x, y) => x + y, 0) / a.length;
				const mb = b.reduce((x, y) => x + y, 0) / b.length;
				let sab = 0;
				let saa = 0;
				let sbb = 0;
				for (let i = 0; i < a.length; i += 1) {
					sab += (a[i] - ma) * (b[i] - mb);
					saa += (a[i] - ma) ** 2;
					sbb += (b[i] - mb) ** 2;
				}
				return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
			};
			let sum = 0;
			let pairs = 0;
			for (let i = 0; i < 12; i += 1) for (let j = i + 1; j < 12; j += 1) {
				sum += Math.abs(corr(series[i], series[j]));
				pairs += 1;
			}
			// Resume: a restored matrix continues identically.
			const a = make();
			const b = make();
			for (let f = 0; f < 600; f += 1) a.update(channels, dt);
			b.restore(JSON.parse(JSON.stringify(a.snapshot())));
			let resumeDiff = 0;
			for (let f = 0; f < 300; f += 1) {
				const va = Array.from(a.update(channels, dt));
				const vb = Array.from(b.update(channels, dt));
				resumeDiff = Math.max(resumeDiff, ...va.map((x, i) => Math.abs(x - vb[i])));
			}
			const inRange = trace.every((row) => row.every((x) => x >= 0 && x <= 1));
			return { glowSources: glowSources.size, meanCorr: sum / pairs, routeChanges: routeSets.size, maxStep, resumeDiff, inRange };
		});
		// Different cubies answer different instruments...
		expect(result.glowSources).toBeGreaterThanOrEqual(3);
		expect(result.meanCorr).toBeLessThan(0.45);
		// ...and the wiring itself keeps changing over four minutes.
		expect(result.routeChanges).toBeGreaterThan(5);
		// Slow parameters glide; nothing leaves 0..1; resume is exact.
		expect(result.maxStep).toBeLessThan(0.08);
		expect(result.inRange).toBe(true);
		expect(result.resumeDiff).toBeLessThan(1e-6);
	});
});
