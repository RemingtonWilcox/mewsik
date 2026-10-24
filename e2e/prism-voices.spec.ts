import { expect, test } from '@playwright/test';

// Prism's ensemble voices: every part of the window answers its own part of
// the band. Heard drums light their own rings (never the predicted beat
// clock), chords voice the rings one at a time, the bass walks the low light,
// a breakdown withdraws the rings from the outside in, and the modulation
// matrix keeps routing the rest of the nave to many different instruments.
test.describe('Prism voices', () => {
	test('heard drums light their own rings, chords re-voice one ring at a time, the bass walks the floor', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { PrismVoices, prismChordVoicing, prismPetalWithdraw } = await import('/src/lib/visualizer/prism/voices.ts');
			const layer = () => ({
				hit: 0,
				serial: 0,
				velocity: 0.8,
				accent: 0,
				sinceHit: 0,
				perBeat: 1,
				activity: 0.5,
				present: 1,
				barPos: 0,
				step: 0,
				pattern: new Float32Array(16)
			});
			const qualities = new Float32Array(7);
			const e = {
				time: 0,
				grid: { known: true, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
				drums: { kick: layer(), snare: layer(), hat: layer(), perc: layer() },
				notes: layer(),
				groove: {
					confidence: 1,
					swing: 0,
					swingRatio: 1,
					syncopation: 0,
					regularity: 1,
					fill: 0,
					fillSerial: 0,
					fillIntensity: 0,
					sinceFill: 10,
					drums: 1,
					breakdown: 0,
					dropout: 0,
					dropoutSerial: 0,
					drumReturn: 0,
					drumReturnSerial: 0
				},
				harmony: {
					chroma: new Float32Array(12).fill(0.3),
					root: 0,
					quality: 'major',
					qualityIndex: 0,
					qualities,
					confidence: 0.8,
					change: 0,
					changeSerial: 0,
					sinceChange: 0,
					changesPerBar: 1,
					tension: 0.1,
					degree: 0,
					key: { tonic: 0, mode: 'major', major: 1, minor: 0, confidence: 1, stability: 1, changeSerial: 0 }
				},
				bass: { pitchClass: 0, confidence: 0.9, note: 0, noteSerial: 0, interval: 0, stepwise: 1, walking: 0.8, perBeat: 1, activity: 0.5, level: 0.7 },
				articulation: { legato: 0.5, staccato: 0.5, low: 0.5, mid: 0.5, high: 0.5, sustain: 0.4, pad: 0.2, noteRate: 2 },
				texture: {
					eventsPerSecond: 5,
					density: 0.5,
					trend: 0,
					build: 0,
					low: 0.5,
					mid: 0.5,
					high: 0.5,
					register: 0,
					width: 0.4,
					correlation: 0.6,
					stereoKnown: true,
					tonality: 0.8,
					noisiness: 0.2
				}
			};
			const setQuality = (index: number) => {
				qualities.fill(0);
				qualities[index] = 1;
			};
			setQuality(0);
			const voices = new PrismVoices(0.37);
			const dt = 1 / 60;
			const step = (frames: number, live = true) => {
				for (let i = 0; i < frames; i += 1) voices.update({ ensemble: e as never, dt, live, energy: 0.6, reroute: 0 });
				return voices.frame;
			};
			step(30);

			// 1. Each drum layer moves only its own packet.
			const before = { kick: voices.kick.serial, snare: voices.snare.serial, hat: voices.hat.serial, fill: voices.fill.serial };
			e.drums.kick.serial += 1;
			step(1);
			const afterKick = { kick: voices.kick.serial, snare: voices.snare.serial, hat: voices.hat.serial };
			e.drums.hat.serial += 1;
			step(1);
			const afterHat = { kick: voices.kick.serial, snare: voices.snare.serial, hat: voices.hat.serial };
			const kickProgressFresh = voices.frame.kick.progress;
			step(60);
			const kickProgressLater = voices.frame.kick.progress;
			e.groove.fillSerial += 1;
			step(1);
			const fillStarted = voices.fill.serial - before.fill;
			// Silence answers nothing.
			e.drums.snare.serial += 1;
			step(1, false);
			const snareInSilence = voices.snare.serial - before.snare;

			// 2. Chord changes re-voice exactly one ring each; three changes reach all three.
			step(120);
			const hues = () => voices.frame.rings.map((r: { hue: number; warmth: number }) => [r.hue, r.warmth]);
			const revoiced: number[] = [];
			const roots = [5, 7, 9];
			const qualityOrder = [1, 2, 3];
			for (let c = 0; c < 3; c += 1) {
				const was = hues();
				setQuality(qualityOrder[c]);
				e.harmony.root = roots[c];
				e.harmony.changeSerial += 1;
				e.harmony.change = 1;
				step(90);
				e.harmony.change = 0;
				const now = hues();
				const moved = now.map((v: number[], k: number) => Math.hypot(v[0] - was[k][0], v[1] - was[k][1]));
				revoiced.push(moved.filter((d: number) => d > 0.02).length);
			}
			const distinctRings = new Set(hues().map((v: number[]) => v.map((x) => x.toFixed(2)).join())).size;

			// 3. Chord quality reads in the glass: major warm and open, minor cool,
			// diminished clustered, augmented split wide.
			const voicing = (q: number) => {
				const qs = new Float32Array(7);
				qs[q] = 1;
				return [0, 1, 2].map((ring) => prismChordVoicing(qs, 0, q === 2 ? 0.8 : 0.1, ring));
			};
			const spread = (v: { hue: number }[]) => Math.abs(v[2].hue - v[0].hue);
			const major = voicing(0);
			const minor = voicing(1);
			const dim = voicing(2);
			const aug = voicing(3);

			// 4. The bass walks the low light; its level lifts it.
			const lowAt = (pc: number) => {
				e.bass.pitchClass = pc;
				step(60);
				return [voices.frame.low.x, voices.frame.low.z];
			};
			const lowC = lowAt(0);
			const lowG = lowAt(7);
			const lowE = lowAt(4);
			const walked = Math.hypot(lowC[0] - lowG[0], lowC[1] - lowG[1]) + Math.hypot(lowG[0] - lowE[0], lowG[1] - lowE[1]);

			// 5. A breakdown withdraws the petals one by one, outer ring first and
			// deepest; they relight faster than they went out.
			e.groove.breakdown = 1;
			step(60 * 4);
			const withdrawIn = voices.frame.withdraw;
			e.groove.breakdown = 0;
			step(60);
			const withdrawBack = voices.frame.withdraw;
			const firstDim = (ring: number) => {
				for (let t = 0; t < 12; t += 0.05) if (prismPetalWithdraw(t, 0.3, ring) > 0.2) return t;
				return -1;
			};
			const petalsOut = [0, 0.25, 0.5, 0.75, 1].map((rank) => prismPetalWithdraw(3, rank, 2));

			// 6. The matrix routes the parts to many different instruments, and
			// re-routes over minutes.
			const routes0 = new Set(voices.matrix.routing().map((r: { source: string }) => r.source));
			const before6 = JSON.stringify(voices.matrix.routing().map((r: { source: string }) => r.source));
			step(60 * 120);
			const after6 = JSON.stringify(voices.matrix.routing().map((r: { source: string }) => r.source));

			// 7. Deterministic per seed.
			const a = new PrismVoices(0.61);
			const b = new PrismVoices(0.61);
			for (let i = 0; i < 300; i += 1) {
				e.drums.kick.hit = i % 30 === 0 ? 1 : e.drums.kick.hit * 0.9;
				a.update({ ensemble: e as never, dt, live: true, energy: 0.5, reroute: 0 });
				b.update({ ensemble: e as never, dt, live: true, energy: 0.5, reroute: 0 });
			}
			const same = JSON.stringify(Array.from(a.matrix.values)) === JSON.stringify(Array.from(b.matrix.values));

			return {
				before,
				afterKick,
				afterHat,
				kickProgressFresh,
				kickProgressLater,
				fillStarted,
				snareInSilence,
				revoiced,
				distinctRings,
				major,
				minor,
				dim,
				aug,
				spreads: { major: spread(major), minor: spread(minor), dim: spread(dim), aug: spread(aug) },
				walked,
				dimOrder: [firstDim(2), firstDim(1), firstDim(0)],
				withdrawIn,
				withdrawBack,
				petalsOut,
				deepest: [0, 1, 2].map((ring) => prismPetalWithdraw(30, 0.5, ring)),
				routeCount: routes0.size,
				rerouted: before6 !== after6,
				same
			};
		});

		// Drums: each layer its own packet, aged on the look's own clock.
		expect(result.afterKick.kick).toBe(result.before.kick + 1);
		expect(result.afterKick.snare).toBe(result.before.snare);
		expect(result.afterKick.hat).toBe(result.before.hat);
		expect(result.afterHat.hat).toBe(result.before.hat + 1);
		expect(result.afterHat.kick).toBe(result.afterKick.kick);
		expect(result.kickProgressFresh).toBeLessThan(0.2);
		expect(result.kickProgressLater).toBe(1);
		expect(result.fillStarted).toBe(1);
		expect(result.snareInSilence).toBe(0);

		// Harmony: one ring per chord change, and the rings end up holding different chords.
		expect(result.revoiced).toEqual([1, 1, 1]);
		expect(result.distinctRings).toBe(3);
		const mean = (v: { warmth: number }[]) => v.reduce((s, r) => s + r.warmth, 0) / v.length;
		expect(mean(result.major)).toBeGreaterThan(0.4);
		expect(mean(result.minor)).toBeLessThan(-0.4);
		expect(result.spreads.dim).toBeLessThan(result.spreads.minor);
		expect(result.spreads.minor).toBeLessThan(result.spreads.major);
		expect(result.spreads.major).toBeLessThan(result.spreads.aug);

		// Bass: the low light walks with the line.
		expect(result.walked).toBeGreaterThan(0.2);

		// Breakdown: petal by petal (at one moment some are out and some lit),
		// the outer ring first and deepest, and back faster than it went.
		const [outer, middle, inner] = result.dimOrder;
		expect(outer).toBeGreaterThanOrEqual(0);
		expect(middle).toBeGreaterThan(outer);
		expect(inner).toBeGreaterThan(middle);
		expect(Math.max(...result.petalsOut) - Math.min(...result.petalsOut)).toBeGreaterThan(0.4);
		expect(result.deepest[2]).toBeGreaterThan(result.deepest[0]);
		expect(result.withdrawIn).toBeGreaterThan(3.5);
		expect(result.withdrawBack).toBeLessThan(result.withdrawIn - 2);

		// Matrix: many instruments, routes that move, deterministic.
		expect(result.routeCount).toBeGreaterThanOrEqual(10);
		expect(result.rerouted).toBe(true);
		expect(result.same).toBe(true);
	});
});
