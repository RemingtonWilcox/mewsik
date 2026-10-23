import { expect, test } from '@playwright/test';

// Soma never runs on a closed loop: the animal is a point in a continuous
// anatomy space (the genome's species is only its dominant kin), the camera
// roams a space of viewpoints instead of orbiting at a fixed rate, and the
// shader animates on integrated phases, never on time * constant.

const DRIVE = `
	globalThis.__somaDrive = (look, seconds, opts = {}) => {
		const dt = 1 / 30;
		const bpm = opts.bpm ?? 118;
		const character = { tempo: 0.48, energy: 0.55, brightness: 0.6, bass: 0.5, noise: 0.35, punch: 0.45, motion: 0.5, valence: 0.6, vector: new Float32Array(8), contrast: 0, shift: 0, shiftSerial: 0, shiftStrength: 1, sinceShift: 100 };
		const samples = [];
		let beats = opts.beats ?? 0;
		for (let i = 0; i < seconds / dt; i += 1) {
			beats += (dt * bpm) / 60;
			const bp = beats % 1;
			const f = look.update({
				director: {
					section: opts.section ?? 'verse',
					silence: false,
					energy: 0.55,
					bassPunch: bp < 0.1 ? 0.5 : 0.1,
					drop: { buildActive: false, buildProgress: 0, dropEta: 99, anticipation: 0, postDropDecay: 0 },
					clock: { tempoBpm: bpm, beatPhase: bp, beatPulse: 0, downbeatFlag: false, barIndex: Math.floor(beats / 4), beatIndex: Math.floor(beats) % 4, phrasePos: (beats / 32) % 1, phraseIndex: opts.phrase ?? Math.floor(beats / 32) },
					context: { sectionEnergy: 0.55, keyPitchClass: 0.3, keyConfidence: 0.6, keyMode: 'minor' }
				},
				spectrum: { bass: 0.45, mid: 0.35, treble: 0.25 },
				mk2: { kick: bp < 0.1 ? 0.6 : 0.1, sparkle: 0, impact: bp < 0.08 ? 0.5 : 0.1 },
				live: true,
				dt,
				aspect: 1.78,
				character
			});
			if (i % 15 === 0) {
				const c = f.camera3;
				const o = f.organism;
				const v = [c.pos[0] - o.boundCenter[0], c.pos[1] - o.boundCenter[1], c.pos[2] - o.boundCenter[2]];
				samples.push({ azimuth: Math.atan2(v[2], v[0]), height: v[1] / Math.hypot(...v), shiftX: c.shiftX, anatomy: Array.from(f.anatomy) });
			}
		}
		return { samples, beats };
	};
`;

test.describe('Soma organic motion', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.addInitScript(DRIVE);
		await page.reload();
	});

	test('one species pinned still keeps becoming a different animal', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const { SOMA_ANATOMY_KEYS } = await import('/src/lib/visualizer/mk2/species.ts');
			const look = new SomaLook('organic-anatomy');
			// The genome's species never changes: any variety below is the continuum's.
			look.setForce({ species: 0 });
			const { samples } = (globalThis as any).__somaDrive(look, 600, { phrase: 0 });
			const keys = ['bellH', 'tentLen', 'tentDir', 'tentCurl', 'lattice', 'combs', 'cerata', 'chainCount', 'pitch', 'oral'];
			const spread = Object.fromEntries(
				keys.map((key) => {
					const index = SOMA_ANATOMY_KEYS.indexOf(key as never);
					const values = samples.map((s: { anatomy: number[] }) => s.anatomy[index]);
					return [key, Math.max(...values) - Math.min(...values)];
				})
			);
			// Return check: how often does a sample come back near one from 45 s or more earlier?
			const vec = samples.map((s: { anatomy: number[] }) => keys.map((key) => s.anatomy[SOMA_ANATOMY_KEYS.indexOf(key as never)]));
			const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
			const all: number[] = [];
			for (let i = 0; i < vec.length; i += 4) for (let j = i + 4; j < vec.length; j += 4) all.push(dist(vec[i], vec[j]));
			all.sort((a, b) => a - b);
			const median = all[Math.floor(all.length / 2)];
			const gap = 90; // samples are 0.5 s apart
			let returns = 0;
			let total = 0;
			for (let i = gap; i < vec.length; i += 2) {
				let nearest = Infinity;
				for (let j = 0; j <= i - gap; j += 1) nearest = Math.min(nearest, dist(vec[i], vec[j]));
				total += 1;
				if (nearest < median * 0.2) returns += 1;
			}
			return { spread, returns: returns / total };
		});
		expect(result.spread.bellH).toBeGreaterThan(0.12);
		expect(result.spread.tentDir).toBeGreaterThan(0.25);
		expect(result.spread.tentCurl).toBeGreaterThan(0.4);
		// Parts come and go: a medusa grows a shell, comb rows or cerata for a while.
		expect(Math.max(result.spread.lattice, result.spread.combs, result.spread.cerata)).toBeGreaterThan(0.3);
		// Other kin drift through the body: a colony buds, the posture tilts.
		expect(Math.max(result.spread.chainCount, result.spread.pitch)).toBeGreaterThan(0.25);
		expect(result.returns).toBeLessThan(0.15);
	});

	test('the camera roams instead of orbiting on a clock', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const look = new SomaLook('organic-camera');
			look.setForce({ camera: 3, species: 0 });
			const { samples } = (globalThis as any).__somaDrive(look, 600, { phrase: 0 });
			// Unwrapped azimuth: a fixed-rate orbit is a straight line in time.
			const az: number[] = [];
			let acc = 0;
			for (let i = 0; i < samples.length; i += 1) {
				if (i > 0) {
					let d = samples[i].azimuth - samples[i - 1].azimuth;
					if (d > Math.PI) d -= Math.PI * 2;
					if (d < -Math.PI) d += Math.PI * 2;
					acc += d;
				}
				az.push(acc);
			}
			const rates: number[] = [];
			for (let i = 60; i < az.length; i += 60) rates.push((az[i] - az[i - 60]) / 30);
			const sign = rates.map((r) => Math.sign(r));
			const reversals = sign.filter((s, i) => i > 0 && s !== 0 && s !== sign[i - 1]).length;
			const heights = samples.map((s: { height: number }) => s.height);
			const shifts = samples.map((s: { shiftX: number }) => s.shiftX);
			return {
				reversals,
				heightSpread: Math.max(...heights) - Math.min(...heights),
				shiftSpread: Math.max(...shifts) - Math.min(...shifts)
			};
		});
		// The orbit (pinned regime) slows, stops and turns back of its own accord.
		expect(result.reversals).toBeGreaterThanOrEqual(2);
		// It also moves through height and framing, not only round.
		expect(result.heightSpread).toBeGreaterThan(0.4);
		expect(result.shiftSpread).toBeGreaterThan(0.2);
	});

	test('the shader animates on integrated phases, never on time * constant', async ({ page }) => {
		const code = await page.evaluate(async () => {
			const shaders = await import('/src/lib/visualizer/mk2/shaders.ts');
			return `${shaders.SOMA_SCENE_WGSL}\n${shaders.SOMA_COMPOSITE_WGSL}`;
		});
		// Noise fields may scroll on the look time; periodic functions may not.
		expect(code).not.toMatch(/\b(sin|cos)\([^;\n]*u\.frame\.z/);
	});
});
