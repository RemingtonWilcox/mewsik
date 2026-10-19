import { expect, test } from '@playwright/test';

// Prism's camera never holds a pose, and its look follows the music's
// character: pure-module checks of the rig (camera.ts) and the character
// mapping (composition.ts), no WebGPU needed.
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
			// Ten minutes: regimes change every 40 s with an 8 s blend, the third
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
		// Tempo sets the travel rate; silence slows it to a floor, not to zero.
		expect(result.fast).toBeGreaterThan(result.slow * 1.5);
		expect(result.quiet).toBeGreaterThan(0.03);
	});

	test('a shift surges the travel, then the rig settles back to cruising', async ({ page }) => {
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
			for (let i = 0; i < 600; i += 1) rig.update(input);
			const before = rig.travel;
			for (let i = 0; i < 120; i += 1) rig.update(input);
			const cruise = rig.travel - before;
			rig.shift(1);
			const atShift = rig.travel;
			for (let i = 0; i < 120; i += 1) rig.update(input);
			const surged = rig.travel - atShift;
			for (let i = 0; i < 600; i += 1) rig.update(input);
			const later = rig.travel;
			for (let i = 0; i < 120; i += 1) rig.update(input);
			return { cruise, surged, settled: rig.travel - later };
		});
		expect(result.surged).toBeGreaterThan(result.cruise * 2);
		expect(result.settled).toBeLessThan(result.cruise * 1.2);
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
