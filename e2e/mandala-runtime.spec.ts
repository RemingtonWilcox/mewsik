import { expect, test } from '@playwright/test';

test.describe('Mandala render foundations', () => {
	test('the look genome is enormous, seeded and keeps moving through every grammar', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			const { VariationGenome, variationSpaceSize } = await import('/src/lib/visualizer/variation.ts');
			const labels = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const run = (seed: string, phrases: number, live = false) => {
				const genome = new VariationGenome(look.MANDALA_AXES, seed);
				const triples = new Set<string>();
				const families = new Set<number>();
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
					const wall = genome.choice('wall').to;
					const palette = genome.choice('palette').to;
					const fold = genome.choice('fold').to;
					families.add(Math.floor(wall / look.MANDALA_VARIANTS));
					palettes.add(palette);
					triples.add(`${Math.floor(wall / look.MANDALA_VARIANTS)}:${palette}:${fold}`);
					trace.push(genome.signature());
				}
				return { triples: triples.size, families: families.size, palettes: palettes.size, trace };
			};
			const a = run('station-a', 300);
			const a2 = run('station-a', 300);
			const b = run('station-b', 300);
			const live = run('radio-night', 300, true);
			return {
				space: variationSpaceSize(look.MANDALA_AXES),
				grammars: look.MANDALA_GRAMMARS,
				familyCount: look.MANDALA_FAMILIES.length,
				a: { ...a, trace: undefined },
				live: { ...live, trace: undefined },
				deterministic: JSON.stringify(a.trace) === JSON.stringify(a2.trace),
				seedsDiffer: a.trace.filter((value: string, index: number) => value !== b.trace[index]).length,
				names: look.MANDALA_FAMILIES.every((family) => look.MANDALA_VARIANT_NAMES[family].length === look.MANDALA_VARIANTS)
			};
		});

		expect(result.space).toBeGreaterThan(1e9);
		expect(result.grammars).toBe(36);
		expect(result.names).toBe(true);
		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(250);
		// An hour of music visits every grammar family and most palettes...
		expect(result.a.families).toBe(result.familyCount);
		expect(result.a.palettes).toBeGreaterThanOrEqual(10);
		expect(result.a.triples).toBeGreaterThanOrEqual(60);
		// ...and so does a live stream that never reports a section.
		expect(result.live.families).toBeGreaterThanOrEqual(7);
		expect(result.live.triples).toBeGreaterThanOrEqual(30);
	});

	test('genres lean toward palettes and grammars that fit them', async ({ page }) => {
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
			const index = (name: string) => look.MANDALA_PALETTES.findIndex((p) => p.name === name);
			return {
				iceForNoise: look.mandalaPaletteFit(index('ice'), noise),
				saffronForNoise: look.mandalaPaletteFit(index('saffron'), noise),
				moonstoneForAmbient: look.mandalaPaletteFit(index('moonstone'), ambient),
				iceForAmbient: look.mandalaPaletteFit(index('ice'), ambient)
			};
		});
		expect(result.iceForNoise).toBeGreaterThan(result.saffronForNoise * 4);
		expect(result.moonstoneForAmbient).toBeGreaterThan(result.iceForAmbient * 4);
	});

	test('phyllotaxis lattice is reduced and indexes seeds along the spiral', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			return [12, 24.3, 40.8, 80].map((around) => {
				const rise = 1.2 / around;
				const { e1, e2, n1, n2 } = look.phyllotaxisBasis(around, look.MANDALA_DIVERGENCE, rise);
				const turns = (e: [number, number], n: number) => (e[0] - n * around * look.MANDALA_DIVERGENCE) / around;
				const l1 = Math.hypot(...e1);
				const l2 = Math.hypot(...e2);
				return {
					riseMatches: Math.abs(e1[1] - n1 * rise) < 1e-9 && Math.abs(e2[1] - n2 * rise) < 1e-9,
					wholeTurns:
						Math.abs(turns(e1, n1) - Math.round(turns(e1, n1))) < 1e-6 &&
						Math.abs(turns(e2, n2) - Math.round(turns(e2, n2))) < 1e-6,
					reduced: l1 <= l2 + 1e-9 && Math.abs(e1[0] * e2[0] + e1[1] * e2[1]) <= (l1 * l1) / 2 + 1e-9,
					area: Math.abs(e1[0] * e2[1] - e1[1] * e2[0])
				};
			});
		});
		for (const basis of result) {
			expect(basis.riseMatches).toBe(true);
			expect(basis.wholeTurns).toBe(true);
			expect(basis.reduced).toBe(true);
			expect(basis.area).toBeCloseTo(1.2, 6);
		}
	});

	test('the flight integrates increments: no jumps, rows wrap exactly, rings fade in', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const flightModule = await import('/src/lib/visualizer/mandala/flight.ts');
			const look = await import('/src/lib/visualizer/mandala/look.ts');
			const many = new flightModule.LayerTravel();
			const once = new flightModule.LayerTravel();
			const period = flightModule.hyperbolicPeriod(0);
			for (let i = 0; i < 1000; i += 1) many.advance(0.0137, 0.8, [period], look.MANDALA_DIVERGENCE, 0.047);
			once.advance(13.7, 0.8, [period], look.MANDALA_DIVERGENCE, 0.047);
			const wrap = new flightModule.LayerTravel();
			wrap.row = 65_535;
			wrap.advance(1.5, 0.8, [], look.MANDALA_DIVERGENCE, 0.047);

			const input = {
				dt: 1 / 60,
				speed: 0.3,
				kick: 0,
				wallCells: 4,
				screenCells: 5,
				screenRate: 1.35,
				wallHyperScale: 0.8,
				screenHyperScale: 0.7,
				wallHyperPeriods: [],
				screenHyperPeriods: [],
				divergence: look.MANDALA_DIVERGENCE,
				wallRise: 0.05,
				screenRise: 0.04,
				corkscrew: 0.2,
				wander: 0.2,
				offset: 0.1,
				restless: 0.6,
				silence: 0,
				sconceSpacing: 0.55,
				sconceTurn: 2.39996
			};
			const flight = new flightModule.MandalaFlight(0.42);
			let maxYawStep = 0;
			let maxRollStep = 0;
			let lastYaw = flight.yaw;
			let lastRoll = flight.roll;
			const ringTrace: number[] = [];
			for (let frame = 0; frame < 600; frame += 1) {
				if (frame === 300) flight.continueSource(0.91);
				if (frame === 120) flight.launchRing(1);
				flight.update({ ...input, kick: frame % 28 === 0 ? 0.8 : 0 });
				maxYawStep = Math.max(maxYawStep, Math.abs(flight.yaw - lastYaw));
				const rollDelta = Math.abs(((flight.roll - lastRoll + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
				maxRollStep = Math.max(maxRollStep, rollDelta);
				lastYaw = flight.yaw;
				lastRoll = flight.roll;
				if (frame >= 120 && frame < 140) ringTrace.push(Math.max(...flight.ringS));
			}
			return {
				many: [many.row, many.frac, many.hyper, many.phylloY, many.phylloTurn, many.seedRow],
				once: [once.row, once.frac, once.hyper, once.phylloY, once.phylloTurn, once.seedRow],
				period,
				wrapped: [wrap.row, wrap.frac],
				maxYawStep,
				maxRollStep,
				ringTrace,
				velocity: flight.velocity
			};
		});

		for (let i = 0; i < result.once.length; i += 1) {
			expect(result.many[i], `travel component ${i}`).toBeCloseTo(result.once[i], 4);
		}
		expect(result.period).toBeGreaterThan(0.5);
		expect(result.many[2]).toBeLessThan(result.period);
		expect(result.wrapped).toEqual([0, 0.5]);
		// The camera glides: no frame turns it by more than a hair.
		expect(result.maxYawStep).toBeLessThan(0.01);
		expect(result.maxRollStep).toBeLessThan(0.05);
		// A beat ring rises from nothing over a few frames instead of popping in.
		expect(result.ringTrace[0]).toBeLessThan(0.15);
		expect(result.ringTrace.at(-1)).toBeGreaterThan(0.9);
		expect(result.velocity).toBeGreaterThan(0.2);
	});

	test('a grammar crossfade can never drop a half-shown option', async ({ page }) => {
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
});
