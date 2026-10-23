import { expect, test } from '@playwright/test';

test.describe('Mandala render foundations', () => {
	test('the look genome is enormous, seeded and keeps moving through every world', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			const { VariationGenome, variationSpaceSize } = await import('/src/lib/visualizer/variation.ts');
			const labels = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const run = (seed: string, phrases: number, live = false) => {
				const genome = new VariationGenome(look.MANDALA_AXES, seed);
				const triples = new Set<string>();
				const worlds = new Set<number>();
				const palettes = new Set<number>();
				const trace: string[] = [];
				let section = 0;
				let sectionLeft = 2;
				for (let phrase = 0; phrase < phrases; phrase += 1) {
					if (!live && --sectionLeft <= 0) {
						section += 1;
						sectionLeft = 1 + ((section * 7) % 3);
					}
					const sectionKey = live ? 'live' : labels[section % labels.length];
					for (let frame = 0; frame < 30; frame += 1) {
						genome.advance({ phraseIndex: phrase, sectionKey, energy: 0.55, dt: 1 / 30 });
					}
					const world = genome.choice('world').to;
					const palette = genome.choice('palette').to;
					const variant = genome.choice('variant').to;
					worlds.add(world);
					palettes.add(palette);
					triples.add(`${world}:${variant}:${palette}`);
					trace.push(genome.signature());
				}
				return { triples: triples.size, worlds: worlds.size, palettes: palettes.size, trace };
			};
			const a = run('station-a', 300);
			const a2 = run('station-a', 300);
			const b = run('station-b', 300);
			const live = run('radio-night', 300, true);
			const slot = look.mandalaSlot(5, 3, 7);
			return {
				space: variationSpaceSize(look.MANDALA_AXES),
				worldCount: look.MANDALA_WORLDS.length,
				a: { ...a, trace: undefined },
				live: { ...live, trace: undefined },
				deterministic: JSON.stringify(a.trace) === JSON.stringify(a2.trace),
				seedsDiffer: a.trace.filter((value: string, index: number) => value !== b.trace[index]).length,
				names: look.MANDALA_WORLDS.every((world) => look.MANDALA_VARIANT_NAMES[world].length === look.MANDALA_VARIANTS),
				slotRoundTrip: look.mandalaSlotParts(slot)
			};
		});

		expect(result.space).toBeGreaterThan(1e8);
		expect(result.worldCount).toBe(8);
		expect(result.names).toBe(true);
		expect(result.slotRoundTrip).toEqual({ world: 5, variant: 3, fold: 7 });
		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(250);
		// An hour of music visits every world and most palettes...
		expect(result.a.worlds).toBe(result.worldCount);
		expect(result.a.palettes).toBeGreaterThanOrEqual(10);
		expect(result.a.triples).toBeGreaterThanOrEqual(60);
		// ...and so does a live stream that never reports a section.
		expect(result.live.worlds).toBeGreaterThanOrEqual(7);
		expect(result.live.triples).toBeGreaterThanOrEqual(30);
	});

	test('genres lean toward worlds and palettes that fit them', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			const base = {
				vector: new Float32Array(8),
				contrast: 0,
				shift: 0,
				shiftSerial: 0,
				shiftStrength: 0,
				sinceShift: 100,
				motion: 0.5,
				valence: 0.6
			};
			const noise = { ...base, tempo: 0.93, energy: 0.8, brightness: 0.95, bass: 0.35, noise: 1, punch: 0.16 };
			const ambient = { ...base, tempo: 0.03, energy: 0.2, brightness: 0.4, bass: 0.5, noise: 0, punch: 0.05 };
			// What Mandala hears from the lab's club profile.
			const club = { ...base, tempo: 0.57, energy: 0.48, brightness: 0.42, bass: 0.76, noise: 0.07, punch: 0.21 };
			const palette = (name: string) => look.MANDALA_PALETTES.findIndex((p) => p.name === name);
			const world = (name: string) => look.MANDALA_WORLDS.indexOf(name as (typeof look.MANDALA_WORLDS)[number]);
			return {
				arcticForNoise: look.mandalaPaletteFit(palette('arctic'), noise),
				honeyForNoise: look.mandalaPaletteFit(palette('honey'), noise),
				nebulaForAmbient: look.mandalaPaletteFit(palette('nebula'), ambient),
				arcticForAmbient: look.mandalaPaletteFit(palette('arctic'), ambient),
				crystalForNoise: look.mandalaWorldFit(world('crystal'), noise),
				foamForNoise: look.mandalaWorldFit(world('foam'), noise),
				foamForAmbient: look.mandalaWorldFit(world('foam'), ambient),
				crystalForAmbient: look.mandalaWorldFit(world('crystal'), ambient),
				spiralForClub: look.mandalaWorldFit(world('spiral'), club),
				foamForClub: look.mandalaWorldFit(world('foam'), club)
			};
		});
		expect(result.arcticForNoise).toBeGreaterThan(result.honeyForNoise * 4);
		expect(result.nebulaForAmbient).toBeGreaterThan(result.arcticForAmbient * 4);
		expect(result.crystalForNoise).toBeGreaterThan(result.foamForNoise * 4);
		expect(result.foamForAmbient).toBeGreaterThan(result.crystalForAmbient * 4);
		expect(result.spiralForClub).toBeGreaterThan(result.foamForClub * 2);
	});

	test('the voyage integrates increments: no jumps, phases wrap, a new source keeps its place', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const flight = await import('/src/lib/visualizer/mandala/flight.ts');
			const input = {
				dt: 1 / 60,
				speed: 0.4,
				rates: [0.9, 2, 0.7, 0.3, 0.8, 0.25, 4, 3],
				spin: 0.1,
				surge: 0,
				restless: 0.6,
				drift: 0.5,
				tempo: 0.55,
				silence: 0
			};
			const voyage = new flight.MandalaVoyage(0.42);
			const start = Array.from(voyage.phase);
			let maxYawStep = 0;
			let lastYaw = voyage.yaw;
			let beforeSource: number[] = [];
			let afterSource: number[] = [];
			for (let frame = 0; frame < 1200; frame += 1) {
				if (frame === 600) {
					beforeSource = Array.from(voyage.phase);
					voyage.continueSource();
					afterSource = Array.from(voyage.phase);
				}
				voyage.update({ ...input, surge: frame % 28 === 0 ? 0.6 : 0 });
				maxYawStep = Math.max(maxYawStep, Math.abs(voyage.yaw - lastYaw));
				lastYaw = voyage.yaw;
			}
			const wrapped = new flight.MandalaVoyage(0.1);
			wrapped.phase[0] = 839.99;
			for (let frame = 0; frame < 60; frame += 1) wrapped.update({ ...input, rates: [1, 1, 1, 1, 1, 1, 1, 1] });
			return {
				advanced: Array.from(voyage.phase).map((value, index) => value !== start[index]),
				sourceKept: JSON.stringify(beforeSource) === JSON.stringify(afterSource),
				maxYawStep,
				wrappedPhase: wrapped.phase[0],
				velocity: voyage.velocity
			};
		});
		expect(result.advanced.every(Boolean)).toBe(true);
		expect(result.sourceKept).toBe(true);
		// The look glides: no frame turns it by more than a hair.
		expect(result.maxYawStep).toBeLessThan(0.01);
		expect(result.wrappedPhase).toBeGreaterThanOrEqual(0);
		expect(result.wrappedPhase).toBeLessThan(1);
		expect(result.velocity).toBeGreaterThan(0.2);
	});

	test('the camera roams: it never parks and never closes a loop', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const flight = await import('/src/lib/visualizer/mandala/flight.ts');
			const input = {
				dt: 1 / 30,
				speed: 0.3,
				rates: [1, 1, 1, 1, 1, 1, 1, 1],
				spin: 0.1,
				surge: 0,
				restless: 0.5,
				drift: 0.6,
				tempo: 0.55,
				silence: 0
			};
			const state = (v: InstanceType<typeof flight.MandalaVoyage>) => [
				v.yaw,
				v.pitch,
				v.roll,
				v.panX * 3,
				v.panY * 6,
				v.zoom * 2.5,
				v.lampX,
				v.lampY,
				Math.log(v.extent)
			];
			const run = (seed: number) => {
				const voyage = new flight.MandalaVoyage(seed);
				const samples: number[][] = [];
				// Twenty minutes, sampled every two seconds.
				for (let frame = 0; frame < 30 * 60 * 20; frame += 1) {
					voyage.update(input);
					if (frame % 60 === 0) samples.push(state(voyage));
				}
				return samples;
			};
			const a = run(0.42);
			const again = run(0.42);
			const dist = (x: number[], y: number[]) => Math.hypot(...x.map((v, i) => v - y[i]));
			// No 10 s window in which the view barely moves.
			let parked = 0;
			for (let i = 0; i + 5 < a.length; i += 5) if (dist(a[i], a[i + 5]) < 0.05) parked += 1;
			// No lag (20 s .. 5 min) at which the path comes back to itself.
			let pairs = 0;
			let total = 0;
			for (let i = 0; i < a.length; i += 3) for (let j = i + 3; j < a.length; j += 3) {
				total += dist(a[i], a[j]);
				pairs += 1;
			}
			const typical = total / pairs;
			let tightest = Infinity;
			for (let lag = 10; lag <= 150; lag += 1) {
				let sum = 0;
				let n = 0;
				for (let i = 0; i + lag < a.length; i += 1) {
					sum += dist(a[i], a[i + lag]);
					n += 1;
				}
				tightest = Math.min(tightest, sum / n / typical);
			}
			return {
				deterministic: JSON.stringify(a) === JSON.stringify(again),
				parked: parked / Math.floor(a.length / 5),
				tightest
			};
		});
		expect(result.deterministic).toBe(true);
		expect(result.parked).toBeLessThan(0.05);
		// An authored Lissajous returns at its period (ratio near 0); a roam never does.
		expect(result.tightest).toBeGreaterThan(0.7);
	});

	test('a Julia dive repeats exactly: z* is fixed, its multiplier is the one asked for', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const flight = await import('/src/lib/visualizer/mandala/flight.ts');
			return [2, 3, 4, 5].map((power) => {
				const track = new flight.JuliaTrack(power);
				track.steer(Math.PI * 2 * 0.4, 1.25, 1 / 60, 1);
				let w: [number, number] = [1, 0];
				for (let i = 0; i < power; i += 1) {
					w = [w[0] * track.z[0] - w[1] * track.z[1], w[0] * track.z[1] + w[1] * track.z[0]];
				}
				const residual = Math.hypot(w[0] + track.c[0] - track.z[0], w[1] + track.c[1] - track.z[1]);
				const at0 = track.window(0, 0.6);
				const at1 = track.window(1, 0.6);
				// One period deeper is exactly one multiplier smaller.
				const ratio = Math.hypot(...at0.scale) / Math.hypot(...at1.scale);
				return {
					residual,
					multiplier: Math.hypot(...track.lambda),
					ratio,
					lead: at0.lead,
					lag: Math.hypot(...at0.scale) / (0.6 * Math.hypot(...track.z))
				};
			});
		});
		for (const dive of result) {
			expect(dive.residual).toBeLessThan(1e-9);
			expect(dive.multiplier).toBeCloseTo(1.25, 6);
			expect(dive.ratio).toBeCloseTo(1.25, 6);
			expect(dive.lead).toBeGreaterThanOrEqual(4);
			// The dive starts a few percent of the window away from z*.
			expect(dive.lag).toBeLessThan(0.05);
		}
	});

	test('beats are heard, not predicted: every kick fires once, a held bass never does', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { HeardPulse } = await import('/src/lib/visualizer/mandala/pulse.ts');
			const dt = 1 / 60;
			// held: a bass note that swells in over 1.5 s and then sustains.
			const play = (pulse: InstanceType<typeof HeardPulse>, seconds: number, kickAt: (t: number) => number, held = 0) => {
				let slow = 0;
				const hitTimes: number[] = [];
				for (let frame = 0; frame < seconds * 60; frame += 1) {
					const t = frame * dt;
					const swell = held * Math.min(1, t / 1.5);
					const level = Math.min(1, swell + kickAt(t));
					slow += (level - slow) * (1 - Math.exp(-dt / 0.8));
					const before = pulse.hits;
					pulse.update({
						dt,
						kickDelta: level - slow,
						subDelta: 0,
						kickLevel: level,
						subLevel: swell,
						onset: false,
						novelty: 0,
						loudness: 0.8,
						tempo: 0.55
					});
					if (pulse.hits !== before) hitTimes.push(t);
				}
				return hitTimes;
			};
			// 128 bpm kicks with a ragged, swung feel: no clock could predict them.
			const kicks: number[] = [];
			for (let t = 0.3; t < 8; t += 0.469 + (kicks.length % 3 === 1 ? 0.06 : -0.02)) kicks.push(t);
			const kick = (t: number) => {
				let level = 0;
				for (const k of kicks) if (t >= k) level = Math.max(level, 0.85 * Math.exp(-(t - k) / 0.12));
				return level;
			};
			const hits = play(new HeardPulse(), 8, kick);
			const lags = kicks.map((k) => {
				const nearest = hits.reduce((best, h) => (Math.abs(h - k) < Math.abs(best - k) ? h : best), Infinity);
				return nearest - k;
			});
			const held = play(new HeardPulse(), 6, () => 0, 0.85);
			const silent = play(new HeardPulse(), 6, () => 0, 0);
			return { kicks: kicks.length, hits: hits.length, maxLag: Math.max(...lags.map(Math.abs)), held: held.length, silent: silent.length };
		});
		expect(result.hits).toBe(result.kicks);
		// Within two frames of the drum's attack.
		expect(result.maxLag).toBeLessThan(0.035);
		expect(result.held).toBe(0);
		expect(result.silent).toBe(0);
	});

	test('a world crossfade can never drop a half-shown option', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			const follower = new look.MandalaFollower(3);
			follower.update(7, 1, 0.4);
			const midway = { from: follower.from, to: follower.to, mix: follower.mix };
			// A new target mid-fade waits; the visible pair is unchanged.
			follower.update(11, 1, 0.1);
			const queued = { from: follower.from, to: follower.to };
			for (let i = 0; i < 40; i += 1) follower.update(11, 1, 0.05);
			const finished = { from: follower.from, to: follower.to, mix: follower.mix };
			// Back to the option fading out reverses in place.
			const reverse = new look.MandalaFollower(1);
			reverse.update(2, 1, 0.3);
			const before = reverse.weight;
			reverse.update(1, 1, 0);
			return { midway, queued, finished, before, after: reverse.weight, reverseTo: reverse.to };
		});
		expect(result.midway).toEqual({ from: 3, to: 7, mix: expect.closeTo(0.4, 5) });
		expect(result.queued).toEqual({ from: 3, to: 7 });
		expect(result.finished).toEqual({ from: 7, to: 11, mix: 1 });
		expect(result.reverseTo).toBe(1);
		expect(result.after).toBeCloseTo(1 - result.before, 5);
	});

	test('the fold spring rings out after a kick', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { FoldSpring } = await import('/src/lib/visualizer/mandala/flight.ts');
			const spring = new FoldSpring();
			spring.kick(0.1);
			let peak = 0;
			for (let i = 0; i < 30; i += 1) {
				spring.update(1 / 60);
				peak = Math.max(peak, Math.abs(spring.value));
			}
			for (let i = 0; i < 90; i += 1) spring.update(1 / 60);
			return { peak, after: Math.abs(spring.value) };
		});
		expect(result.peak).toBeGreaterThan(0.02);
		expect(result.after).toBeLessThan(result.peak * 0.05);
	});
});
