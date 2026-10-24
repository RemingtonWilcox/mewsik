import { expect, test } from '@playwright/test';

// Signal's benches are rooms of arrangements, not fixed tables: the roam
// travels each one continuously, every corner of the room still frames the
// instrument, a bench turning round slides its pieces without collapsing
// them, and the roam itself never closes a loop.

test.describe('Signal roam', () => {
	test('every bench stays framed and continuous across its whole room, and mirrors without collapsing', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layouts = await import('/src/lib/visualizer/signal/layouts.ts');
			const { buildSignalLayout, mirrorSignalLayout, SIGNAL_BENCH_COUNT, signalBenchName } = layouts;
			const keys = ['pan', 'lift', 'size', 'spread', 'depth', 'reach', 'horizon', 'glow'] as const;
			const corner = (bits: number) =>
				Object.fromEntries(keys.map((key, i) => [key, (bits >> i) & 1 ? 1 : -1])) as Record<(typeof keys)[number], number>;
			const problems: string[] = [];
			let worstStep = 0;
			for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
				for (let index = 0; index < SIGNAL_BENCH_COUNT; index += 1) {
					const name = signalBenchName(index);
					for (let bits = 0; bits < 256; bits += 3) {
						const k = corner(bits);
						for (const mirror of [0, 0.5, 1]) {
							const l = mirrorSignalLayout(buildSignalLayout(index, aspect, k), mirror);
							const values = Object.values(l);
							if (!values.every(Number.isFinite)) problems.push(`${name} ${bits} not finite`);
							// The hero (with its largest breath) stays on screen.
							const reach = l.figAScale * 1.3;
							if (Math.abs(l.figAX) + reach > aspect * 1.02 || Math.abs(l.figAY) + reach > 1.08) {
								problems.push(`${name} ${bits} m${mirror} hero off frame`);
							}
							for (let t = 0; t < 8; t += 1) {
								const ox = l[`t${t}ox` as keyof typeof l];
								const oy = l[`t${t}oy` as keyof typeof l];
								const tx = l[`t${t}tx` as keyof typeof l];
								const ty = l[`t${t}ty` as keyof typeof l];
								for (const [x, y] of [[ox, oy], [ox + tx, oy + ty]]) {
									if (Math.abs(x) > aspect * 1.001 || Math.abs(y) > 1.001) problems.push(`${name} ${bits} trace ${t} off frame`);
								}
								// A trace keeps its length through a mirror.
								if (Math.hypot(tx, ty) < 0.1) problems.push(`${name} ${bits} m${mirror} trace ${t} collapsed`);
							}
						}
					}
					// Continuity: a small step through the room moves the bench a little.
					for (let step = 0; step < 200; step += 1) {
						const at = (s: number) =>
							Object.fromEntries(keys.map((key, i) => [key, Math.sin(s * 0.05 + i * 1.7)])) as Record<(typeof keys)[number], number>;
						const a = buildSignalLayout(index, aspect, at(step));
						const b = buildSignalLayout(index, aspect, at(step + 0.02));
						for (const key of Object.keys(a) as (keyof typeof a)[]) {
							worstStep = Math.max(worstStep, Math.abs(a[key] - b[key]));
						}
					}
				}
			}
			const neutral = buildSignalLayout(0, 16 / 9);
			const centre = buildSignalLayout(0, 16 / 9, { pan: 0, lift: 0, size: 0, spread: 0, depth: 0, reach: 0, horizon: 0, glow: 0 });
			return { problems: problems.slice(0, 12), count: problems.length, worstStep, neutralIsCentre: JSON.stringify(neutral) === JSON.stringify(centre) };
		});
		expect(result.problems).toEqual([]);
		expect(result.count).toBe(0);
		// 0.02 of a knob moves nothing more than a few hundredths of the screen.
		expect(result.worstStep).toBeLessThan(0.05);
		expect(result.neutralIsCentre).toBe(true);
	});

	test('roams without looping, holds in silence, resumes deterministically, and answers a shift', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SignalRoam } = await import('/src/lib/visualizer/signal/roam.ts');
			const dt = 1 / 30;
			const run = (roam: InstanceType<typeof SignalRoam>, seconds: number, drive = { tempo: 0.5, energy: 0.5, ringOut: 0 }) => {
				const xs: number[][] = [];
				for (let i = 0; i < seconds * 30; i += 1) {
					roam.update(dt, drive);
					xs.push([...roam.compose.value, ...roam.camera.value]);
				}
				return xs;
			};
			const a = new SignalRoam('signal-roam:spec');
			const pathA = run(a, 600);
			const b = new SignalRoam('signal-roam:spec');
			const pathB = run(b, 600);
			// Strongest autocorrelation of the bench pan at lags of 20 s .. 4 min.
			const pan = pathA.map((v) => v[0]);
			const mean = pan.reduce((s, x) => s + x, 0) / pan.length;
			const c = pan.map((x) => x - mean);
			const var0 = c.reduce((s, x) => s + x * x, 0) || 1;
			let peak = 0;
			for (let lag = 600; lag <= 30 * 240; lag += 15) {
				let sum = 0;
				for (let i = 0; i + lag < c.length; i += 1) sum += c[i] * c[i + lag];
				peak = Math.max(peak, sum / var0);
			}
			let maxStep = 0;
			for (let i = 1; i < pathA.length; i += 1) {
				for (let d = 0; d < pathA[i].length; d += 1) maxStep = Math.max(maxStep, Math.abs(pathA[i][d] - pathA[i - 1][d]));
			}
			// Silence: dt 0 holds the bench where it is.
			const before = [...a.compose.value];
			for (let i = 0; i < 300; i += 1) a.update(0, { tempo: 0.5, energy: 0.5, ringOut: 0 });
			const held = before.every((v, i) => v === a.compose.value[i]);
			// A shift sends the bench somewhere new within a few seconds.
			const c1 = new SignalRoam('signal-roam:spec');
			const c2 = new SignalRoam('signal-roam:spec');
			run(c1, 30);
			run(c2, 30);
			c2.redirect();
			const t1 = run(c1, 4).at(-1)!;
			const t2 = run(c2, 4).at(-1)!;
			const moved = Math.hypot(...t1.slice(0, 8).map((v, i) => v - t2[i]));
			return {
				deterministic: JSON.stringify(pathA) === JSON.stringify(pathB),
				peak,
				maxStep,
				bounded: pathA.every((v) => v.every((x) => Math.abs(x) <= 1.2)),
				held,
				moved,
				noise: [a.noise(1, 0.5), a.noise(1, 0.5)]
			};
		});
		expect(result.deterministic).toBe(true);
		expect(result.peak).toBeLessThan(0.5);
		expect(result.maxStep).toBeLessThan(0.05);
		expect(result.bounded).toBe(true);
		expect(result.held).toBe(true);
		expect(result.moved).toBeGreaterThan(0.3);
		expect(result.noise[0]).toBe(result.noise[1]);
	});
});
