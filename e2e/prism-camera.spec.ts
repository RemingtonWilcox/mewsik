import { expect, test } from '@playwright/test';

// Prism's camera never holds a pose and never walks a loop, and its look
// follows the music's character: pure-module checks of the rig (camera.ts)
// and the character mapping (composition.ts), no WebGPU needed.
test.describe('Prism camera rig', () => {
	test('the camera always travels, even in silence, and never jumps', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { PrismCameraRig } = await import('/src/lib/visualizer/prism/camera.ts');
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const rig = new PrismCameraRig(0.37);
			const dt = 1 / 60;
			const poses: { yaw: number; pitch: number; roll: number; dist: number; tx: number; ty: number }[] = [];
			let maxStep = 0;
			let previous: (typeof poses)[number] | null = null;
			let regime = { from: 0, to: 0, mix: 1 };
			const lows: number[] = [];
			// Ten minutes: regions change every 40 s with an 8 s blend, the third
			// minute is silent, a shift lands at 5:00, kicks land every half second.
			for (let frame = 0; frame < 60 * 600; frame += 1) {
				const t = frame * dt;
				const slot = Math.floor(t / 40);
				const into = t - slot * 40;
				regime = { from: (slot + 7) % 8, to: slot % 8, mix: Math.min(1, into / 8) };
				regime.mix = regime.mix * regime.mix * (3 - 2 * regime.mix);
				const silent = t >= 120 && t < 180;
				if (frame === 60 * 300) rig.shift(1);
				if (!silent && frame % 30 === 0) rig.punch(1);
				const cam = rig.update({
					dt,
					regime,
					side: Math.sin(t * 0.01),
					focus: (t * 0.003) % 1,
					drift: Math.sin(t * 0.02),
					spacing: 1.3,
					tempo: 0.5,
					energy: silent ? 0 : 0.6,
					silence: silent ? 1 : 0,
					motion: 1
				});
				if (previous) {
					const step = Math.max(
						Math.abs(cam.yaw - previous.yaw),
						Math.abs(cam.pitch - previous.pitch),
						Math.abs(cam.roll - previous.roll),
						Math.abs(Math.log(cam.dist / previous.dist)),
						Math.abs(cam.tx - previous.tx),
						Math.abs(cam.ty - previous.ty)
					);
					maxStep = Math.max(maxStep, step);
				}
				previous = cam;
				lows.push(prism.prismCameraBasis(cam).pos[1]);
				if (frame % (60 * 5) === 0) poses.push(cam);
			}
			// How far the camera moved in every 5 s span (angles in radians, log
			// distance, translation in world units): the floor is the stillest span.
			const spans = poses.slice(1).map((pose, i) => {
				const a = poses[i];
				return (
					Math.abs(pose.yaw - a.yaw) +
					Math.abs(pose.pitch - a.pitch) +
					Math.abs(pose.roll - a.roll) +
					Math.abs(Math.log(pose.dist / a.dist)) +
					Math.abs(pose.tx - a.tx) +
					Math.abs(pose.ty - a.ty)
				);
			});
			const silentSpans = spans.slice(24, 35);
			return {
				maxStep,
				stillest: Math.min(...spans),
				stillestSilent: Math.min(...silentSpans),
				mean: spans.reduce((sum, v) => sum + v, 0) / spans.length,
				lowest: Math.min(...lows),
				floor: prism.PRISM_FLOOR_Y,
				fast: PrismCameraRig.rateFor(1, 0.6, 0, 1),
				slow: PrismCameraRig.rateFor(0, 0.6, 0, 1),
				quiet: PrismCameraRig.rateFor(0, 0, 1, 1)
			};
		});
		// Never a jump: no pose channel moves more than ~0.6 degrees in a frame.
		expect(result.maxStep).toBeLessThan(0.012);
		// Never parked: every 5 s span moves, even the silent minute.
		expect(result.stillest).toBeGreaterThan(0.01);
		expect(result.stillestSilent).toBeGreaterThan(0.01);
		expect(result.mean).toBeGreaterThan(0.05);
		expect(result.lowest).toBeGreaterThan(result.floor);
		// Tempo sets the roam rate; silence slows it to a floor, not to zero.
		expect(result.fast).toBeGreaterThan(result.slow * 1.5);
		expect(result.quiet).toBeGreaterThan(0.03);
	});

	test('a shift redirects the shot and surges the roam, then the rig settles back', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { PrismCameraRig } = await import('/src/lib/visualizer/prism/camera.ts');
			const rig = new PrismCameraRig(0.6);
			const input = {
				dt: 1 / 60,
				regime: { from: 0, to: 0, mix: 1 },
				side: 0.2,
				focus: 0.1,
				drift: 0,
				spacing: 1.3,
				tempo: 0.5,
				energy: 0.5,
				silence: 0,
				motion: 1
			};
			type Pose = { yaw: number; pitch: number; roll: number; dist: number; tx: number; ty: number };
			const moved = (a: Pose, b: Pose) =>
				Math.abs(a.yaw - b.yaw) +
				Math.abs(a.pitch - b.pitch) +
				Math.abs(a.roll - b.roll) +
				Math.abs(Math.log(a.dist / b.dist)) +
				Math.abs(a.tx - b.tx) +
				Math.abs(a.ty - b.ty);
			// The typical 3 s of cruising, over two minutes.
			let pose = rig.update(input);
			const cruising: number[] = [];
			for (let span = 0; span < 40; span += 1) {
				const from = pose;
				for (let i = 0; i < 180; i += 1) pose = rig.update(input);
				cruising.push(moved(from, pose));
			}
			cruising.sort((a, b) => a - b);
			const before = rig.travel;
			for (let i = 0; i < 120; i += 1) rig.update(input);
			const cruise = rig.travel - before;
			const atShift = rig.travel;
			const shiftedFrom = pose;
			rig.shift(1);
			for (let i = 0; i < 180; i += 1) pose = rig.update(input);
			const reframed = moved(shiftedFrom, pose);
			const surged = rig.travel - atShift;
			for (let i = 0; i < 900; i += 1) rig.update(input);
			const later = rig.travel;
			for (let i = 0; i < 120; i += 1) rig.update(input);
			return { cruise, surged: surged * (120 / 180), settled: rig.travel - later, reframed, median: cruising[20] };
		});
		// The roam surges, and the shot visibly heads somewhere new.
		expect(result.surged).toBeGreaterThan(result.cruise * 1.4);
		expect(result.reframed).toBeGreaterThan(result.median * 1.5);
		expect(result.settled).toBeLessThan(result.cruise * 1.2);
	});

	test('the camera roams: no loop, no rhythm, and a region revisited is a new place', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { PrismCameraRig } = await import('/src/lib/visualizer/prism/camera.ts');
			const rig = new PrismCameraRig(0.21);
			const dt = 1 / 30;
			const input = {
				dt,
				regime: { from: 0, to: 0, mix: 1 },
				side: 0.4,
				focus: 0.3,
				drift: 0,
				spacing: 1.3,
				tempo: 0.55,
				energy: 0.6,
				silence: 0,
				motion: 1
			};
			// Twenty minutes in one region, sampled every second.
			const yaw: number[] = [];
			const dist: number[] = [];
			const tx: number[] = [];
			const long: number[][] = [];
			for (let frame = 0; frame < 30 * 1200; frame += 1) {
				const cam = rig.update(input);
				if (frame % 30 === 0) {
					yaw.push(cam.yaw);
					dist.push(Math.log(cam.dist));
					tx.push(cam.tx);
					long.push([cam.yaw, cam.pitch, cam.roll, Math.log(cam.dist), cam.tx, cam.ty]);
				}
			}
			const gap = (a: number[], b: number[]) => a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0);
			// How far apart two moments of one long stay in the region typically are.
			let spread = 0;
			for (let i = 0; i + 90 < long.length; i += 1) spread += gap(long[i], long[i + 90]);
			spread /= long.length - 90;
			// Strongest autocorrelation beyond the first zero crossing, 20-240 s:
			// an authored orbit (sines of one phase) scores close to 1.
			const cadence = (signal: number[]) => {
				const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
				const c = signal.map((v) => v - mean);
				const var0 = c.reduce((a, b) => a + b * b, 0) || 1;
				const r = (lag: number) => {
					let sum = 0;
					for (let i = 0; i + lag < c.length; i += 1) sum += c[i] * c[i + lag];
					return (sum / var0) * (c.length / (c.length - lag));
				};
				let zero = 1;
				while (zero < 240 && r(zero) > 0) zero += 1;
				let best = 0;
				for (let lag = Math.max(20, zero); lag <= 240; lag += 1) best = Math.max(best, r(lag));
				return best;
			};
			// How much of the region the shot covers: occupied cells of a 6 x 6
			// grid over the yaw / distance range it actually used.
			const coverage = () => {
				const lo = (a: number[]) => Math.min(...a);
				const hi = (a: number[]) => Math.max(...a);
				const cells = new Set<string>();
				for (let i = 0; i < yaw.length; i += 1) {
					const a = Math.min(5, Math.floor(((yaw[i] - lo(yaw)) / (hi(yaw) - lo(yaw) + 1e-9)) * 6));
					const b = Math.min(5, Math.floor(((dist[i] - lo(dist)) / (hi(dist) - lo(dist) + 1e-9)) * 6));
					cells.add(`${a}:${b}`);
				}
				return cells.size;
			};

			// A region left and revisited later starts wherever the shot is now.
			const visit = (regime: number) => {
				const poses: number[][] = [];
				for (let frame = 0; frame < 30 * 30; frame += 1) {
					const cam = rig.update({ ...input, regime: { from: regime, to: regime, mix: 1 } });
					if (frame % 30 === 0) poses.push([cam.yaw, cam.pitch, cam.roll, Math.log(cam.dist), cam.tx, cam.ty]);
				}
				return poses;
			};
			const first = visit(0);
			visit(3);
			visit(5);
			const second = visit(0);
			const apart = first.reduce((sum, pose, i) => sum + gap(pose, second[i]), 0) / first.length;
			return {
				yawCadence: cadence(yaw),
				distCadence: cadence(dist),
				txCadence: cadence(tx),
				coverage: coverage(),
				apart,
				spread
			};
		});
		expect(result.yawCadence).toBeLessThan(0.4);
		expect(result.distCadence).toBeLessThan(0.4);
		expect(result.txCadence).toBeLessThan(0.4);
		// It wanders the whole region, not one track through it.
		expect(result.coverage).toBeGreaterThan(18);
		// The same region twice is not the same shot twice: the two visits are
		// as far apart as any two unrelated moments in the region.
		expect(result.apart).toBeGreaterThan(result.spread * 0.6);
	});
});

test.describe('Prism music character', () => {
	test('tempo, punch and bass move the look structurally, not just its tint', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const base = { tempo: 0.5, energy: 0.4, brightness: 0.3, bass: 0.5, noise: 0.3, punch: 0.3, motion: 0.5, valence: 0.5 };
			const ambient = prism.prismFeel({ ...base, tempo: 0.03, punch: 0.05, energy: 0.25 });
			const noise = prism.prismFeel({ ...base, tempo: 0.93, punch: 0.15, noise: 1 });
			const heavy = prism.prismFeel({ ...base, bass: 1 });
			const light = prism.prismFeel({ ...base, bass: 0 });
			const glass = [0.4, 0.1, 0.3] as [number, number, number];
			const hot = prism.prismTemper(glass, noise);
			const cold = prism.prismTemper(glass, ambient);
			const awayFromRed = prism.prismHueAway([0.6, 0.02, 0.01]);
			const names = prism.PRISM_PALETTES.map((p: { name: string }) => p.name);
			return {
				ambient,
				noise,
				heavyWeight: heavy.weight,
				lightWeight: light.weight,
				hot,
				cold,
				bloodMoon: awayFromRed[names.indexOf('blood-moon')],
				ice: awayFromRed[names.indexOf('ice')]
			};
		});
		// Fast music cuts the glass finer and clears the air; slow music hazes it.
		expect(result.noise.frag).toBeGreaterThan(result.ambient.frag * 1.5);
		expect(result.ambient.haze).toBeGreaterThan(result.noise.haze + 0.3);
		expect(result.noise.temperature).toBeGreaterThan(0.5);
		expect(result.ambient.temperature).toBeLessThan(-0.5);
		// Bass weighs the tracery.
		expect(result.heavyWeight).toBeGreaterThan(result.lightWeight + 0.5);
		// Temperature warms or cools the glass itself, inside the dark range.
		expect(result.hot[0] / result.hot[2]).toBeGreaterThan(result.cold[0] / result.cold[2] * 1.5);
		for (const channel of [...result.hot, ...result.cold]) expect(channel).toBeLessThanOrEqual(0.78);
		// Answering a change, glass of the same hue is nearly ruled out.
		expect(result.bloodMoon).toBeLessThan(0.1);
		expect(result.ice).toBeGreaterThan(0.9);
	});

	test('the renderer answers each shift once and persists the answer in the look', async ({ page }) => {
		await page.goto('/');
		const source = await page.evaluate(async () =>
			(await fetch('/src/lib/components/visualizer/visualizer.svelte?raw')).text()
		);
		expect(source).toMatch(/answeredShift/);
		expect(source).toMatch(/character\.shiftSerial !== lookState\.answeredShift/);
		expect(source).toMatch(/genome\.shift\(/);
		expect(source).toMatch(/genome\.setWeights\('camera'/);
		expect(source).toMatch(/genome\.setWeights\('palette'/);
	});
});
