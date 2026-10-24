import { expect, test } from '@playwright/test';

// Mandala's rose: the picture as many panes, each answering its own part of
// the ensemble. Driven here by a synthetic band whose instruments play on
// their own schedules.
test.describe('Mandala rose', () => {
	test('panes answer different instruments, a few at a time, and settle in silence', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const rose = await import('/src/lib/visualizer/mandala/rose.ts');
			const layer = () => ({ hit: 0, serial: 0, velocity: 0.8, accent: 0.3, sinceHit: 1, perBeat: 1, activity: 0.5, present: 1, barPos: 0, step: 0, pattern: new Float32Array(16) });
			const frame = {
				time: 0,
				grid: { known: true, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
				drums: { kick: layer(), snare: layer(), hat: layer(), perc: layer() },
				notes: layer(),
				groove: { confidence: 1, swing: 0.2, swingRatio: 1.2, syncopation: 0.3, regularity: 0.8, fill: 0, fillSerial: 0, fillIntensity: 0, sinceFill: 9, drums: 1, breakdown: 0, dropout: 0, dropoutSerial: 0, drumReturn: 0, drumReturnSerial: 0 },
				harmony: {
					chroma: new Float32Array(12),
					root: 0,
					quality: 'major',
					qualityIndex: 0,
					qualities: new Float32Array([1, 0, 0, 0, 0, 0, 0]),
					confidence: 0.8,
					change: 0,
					changeSerial: 0,
					sinceChange: 0,
					changesPerBar: 1,
					tension: 0.2,
					degree: 0,
					key: { tonic: 0, mode: 'major', major: 1, minor: 0, confidence: 1, stability: 1, changeSerial: 0 }
				},
				bass: { pitchClass: 0, confidence: 0.8, note: 0, noteSerial: 0, interval: 0, stepwise: 0.5, walking: 0.2, perBeat: 1, activity: 0.5, level: 0.7 },
				articulation: { legato: 0.4, staccato: 0.6, low: 0.4, mid: 0.4, high: 0.4, sustain: 0.4, pad: 0.3, noteRate: 2 },
				texture: { eventsPerSecond: 6, density: 0.55, trend: 0, build: 0, low: 0.5, mid: 0.5, high: 0.5, register: 0, width: 0.4, correlation: 0.6, stereoKnown: true, tonality: 0.7, noisiness: 0.2 }
			};
			const hit = (l: ReturnType<typeof layer>) => {
				l.serial += 1;
				l.hit = l.velocity;
			};
			const CHORDS = [0, 9, 5, 7];
			const make = () => new rose.MandalaRose(0.4242);
			const a = make();
			const b = make();
			const dt = 1 / 60;
			const panes = rose.ROSE_PARTS;
			const strikes: number[][] = Array.from({ length: panes }, () => []);
			let maxTogether = 0;
			let last = new Float32Array(panes);
			let same = true;
			let lightMin = Infinity;
			let lightMax = -Infinity;
			const input = (silence: number) => ({ dt, silence, restless: 0.5, reroute: 0, centreX: 0, centreY: 0, paletteWeight: 1, leaving: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][] });
			for (let f = 0; f < 60 * 90; f += 1) {
				const t = f * dt;
				// Each instrument on its own schedule.
				if (f % 30 === 0) hit(frame.drums.kick);
				if (f % 60 === 30) hit(frame.drums.snare);
				if (f % 8 === 4) hit(frame.drums.hat);
				if (f % 97 === 11) hit(frame.drums.perc);
				if (f % 43 === 7) hit(frame.notes);
				if (f % 120 === 0) {
					frame.harmony.changeSerial += 1;
					frame.harmony.change = 1;
					frame.harmony.root = CHORDS[(f / 120) % 4];
					frame.harmony.qualities[0] = (f / 120) % 2 ? 0 : 1;
					frame.harmony.qualities[1] = (f / 120) % 2 ? 1 : 0;
					frame.harmony.chroma.fill(0.1);
					for (const k of [0, 4, 7]) frame.harmony.chroma[(frame.harmony.root + k) % 12] = 1;
				}
				if (f % 60 === 45) {
					frame.bass.noteSerial += 1;
					frame.bass.pitchClass = (frame.bass.pitchClass + 5) % 12;
				}
				for (const l of [frame.drums.kick, frame.drums.snare, frame.drums.hat, frame.drums.perc, frame.notes]) l.hit *= Math.exp(-dt / 0.1);
				frame.harmony.change *= Math.exp(-dt / 0.35);
				frame.time = t;
				const out = a.update(frame as never, input(0));
				const twin = b.update(frame as never, input(0));
				if (same && out.some((v, i) => v !== twin[i])) same = false;
				if (f > 60 * 20) {
					let together = 0;
					for (let i = 0; i < panes; i += 1) {
						const crack = out[i * 8 + 4];
						if (crack - last[i] > 0.15) together += 1;
						last[i] = crack;
						if (f % 6 === 0) strikes[i].push(crack);
						lightMin = Math.min(lightMin, out[i * 8]);
						lightMax = Math.max(lightMax, out[i * 8]);
					}
					maxTogether = Math.max(maxTogether, together);
				} else {
					for (let i = 0; i < panes; i += 1) last[i] = out[i * 8 + 4];
				}
			}
			const routing = a.strikeRouting().map((r: string) => r.split(':')[1]);
			const corr = (x: number[], y: number[]) => {
				const n = x.length;
				const mx = x.reduce((s, v) => s + v, 0) / n;
				const my = y.reduce((s, v) => s + v, 0) / n;
				let sxy = 0;
				let sxx = 0;
				let syy = 0;
				for (let i = 0; i < n; i += 1) {
					sxy += (x[i] - mx) * (y[i] - my);
					sxx += (x[i] - mx) ** 2;
					syy += (y[i] - my) ** 2;
				}
				return sxx > 1e-9 && syy > 1e-9 ? sxy / Math.sqrt(sxx * syy) : 0;
			};
			let sum = 0;
			let pairs = 0;
			for (let i = 0; i < panes; i += 1) for (let j = i + 1; j < panes; j += 1) {
				sum += Math.abs(corr(strikes[i], strikes[j]));
				pairs += 1;
			}
			// Silence: everything returns to rest.
			for (let f = 0; f < 60 * 6; f += 1) a.update(frame as never, input(1));
			const quiet = a.update(frame as never, input(1));
			let restLight = 0;
			let restCrack = 0;
			let restGlint = 0;
			for (let i = 0; i < panes; i += 1) {
				restLight = Math.max(restLight, Math.abs(quiet[i * 8] - 1));
				restGlint = Math.max(restGlint, quiet[i * 8 + 3]);
				restCrack = Math.max(restCrack, quiet[i * 8 + 4]);
			}
			return {
				panes,
				instruments: new Set(routing).size,
				meanCorr: sum / pairs,
				maxTogether,
				lightMin,
				lightMax,
				same,
				restLight,
				restGlint,
				restCrack
			};
		});
		expect(result.panes).toBeGreaterThanOrEqual(24);
		// Different panes listen to different instruments...
		expect(result.instruments).toBeGreaterThanOrEqual(5);
		// ...so their strikes are largely independent...
		expect(result.meanCorr).toBeLessThan(0.3);
		// ...and no hit lights more than a handful of panes at once (no face turning).
		expect(result.maxTogether).toBeLessThanOrEqual(6);
		// The panes' light moves, within a range that keeps one picture.
		expect(result.lightMax - result.lightMin).toBeGreaterThan(0.3);
		expect(result.lightMin).toBeGreaterThan(0.2);
		expect(result.lightMax).toBeLessThan(2.5);
		// Deterministic: the same seed and music give the same rose.
		expect(result.same).toBe(true);
		// Silence holds the look at rest.
		expect(result.restLight).toBeLessThan(0.02);
		expect(result.restGlint).toBeLessThan(0.02);
		expect(result.restCrack).toBeLessThan(0.02);
	});
});
