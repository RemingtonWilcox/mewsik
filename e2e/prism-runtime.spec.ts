import { expect, test } from '@playwright/test';

test.describe('Prism render foundations', () => {
	test('caps HDR backing pixels without distorting the viewport', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const runtime = await import(modulePath);
			return {
				ordinary: runtime.prismBackingSize(1280, 720, 1),
				retina4k: runtime.prismBackingSize(3840, 2160, 2),
				ceiling: runtime.PRISM_MAX_INTERNAL_PIXELS
			};
		});

		expect(result.ordinary).toEqual({ width: 1280, height: 720 });
		expect(result.retina4k.width * result.retina4k.height).toBeLessThanOrEqual(result.ceiling);
		expect(result.retina4k.width / result.retina4k.height).toBeCloseTo(16 / 9, 2);
	});

	test('gates high-refresh displays to one stable 60 Hz render stream', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const { FixedFrameScheduler } = await import(modulePath);
			const scheduler = new FixedFrameScheduler();
			let renders = 0;
			for (let tick = 0; tick <= 1440; tick += 1) {
				if (scheduler.next((tick * 1000) / 144) !== null) renders += 1;
			}
			const resumedDt = scheduler.next(20_000);
			const immediateCatchup = scheduler.next(20_001);
			return { renders, resumedDt, immediateCatchup };
		});

		expect(result.renders).toBeGreaterThanOrEqual(599);
		expect(result.renders).toBeLessThanOrEqual(602);
		expect(result.resumedDt).toBe(1);
		expect(result.immediateCatchup).toBeNull();
	});

	test('derives repeatable onset choices from the musical journey', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/runtime.ts';
			const { prismEventUnit } = await import(modulePath);
			const sequence = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 0)
			);
			const repeated = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 0)
			);
			const alternateChannel = Array.from({ length: 8 }, (_, index) =>
				prismEventUnit(0.421337, 7, index, 1)
			);
			return { sequence, repeated, alternateChannel };
		});

		expect(result.repeated).toEqual(result.sequence);
		expect(result.alternateChannel).not.toEqual(result.sequence);
		expect(result.sequence.every((value) => value >= 0 && value < 1)).toBe(true);
	});

	test('the look genome is enormous, seeded and keeps moving', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const compositionPath = '/src/lib/visualizer/prism/composition.ts';
			const variationPath = '/src/lib/visualizer/variation.ts';
			const prism = await import(compositionPath);
			const { VariationGenome, variationSpaceSize } = await import(variationPath);
			const labels = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const run = (seed: string, phrases: number, live = false) => {
				const genome = new VariationGenome(prism.PRISM_AXES, seed);
				const triples = new Set<string>();
				const grammars = new Set<number>();
				const cameras = new Set<number>();
				const palettes = new Set<number>();
				const trace: string[] = [];
				let section = 0;
				let sectionLeft = 2;
				for (let phrase = 0; phrase < phrases; phrase += 1) {
					if (!live && --sectionLeft <= 0) {
						section += 1;
						// Sections of one to three phrases, like the lab songs and real tracks.
						sectionLeft = 1 + ((section * 7) % 3);
					}
					const sectionKey = live ? 'live' : labels[section % labels.length];
					const family = prism.prismFamily(sectionKey);
					for (let frame = 0; frame < 30; frame += 1) {
						genome.advance({ phraseIndex: phrase, sectionKey, energy: 0.55, dt: 1 / 30 });
					}
					const structure = prism.prismStructure(genome, family);
					const palette = genome.choice('palette').to;
					const camera = genome.choice('camera').to;
					triples.add(`${palette}:${structure.grammar}:${camera}`);
					grammars.add(structure.grammar);
					cameras.add(camera);
					palettes.add(palette);
					trace.push(`${palette}:${prism.prismStructureKey(structure)}:${camera}`);
				}
				return { triples: triples.size, grammars: grammars.size, cameras: cameras.size, palettes: palettes.size, trace };
			};
			const a = run('station-a', 300);
			const a2 = run('station-a', 300);
			const b = run('station-b', 300);
			const live = run('radio-night', 300, true);
			return {
				space: variationSpaceSize(prism.PRISM_AXES),
				a: { ...a, trace: undefined },
				live: { ...live, trace: undefined },
				deterministic: JSON.stringify(a.trace) === JSON.stringify(a2.trace),
				seedsDiffer: a.trace.filter((value: string, index: number) => value !== b.trace[index]).length,
				paletteCount: prism.PRISM_PALETTES.length,
				grammarCount: prism.PRISM_GRAMMARS.length,
				cameraCount: prism.PRISM_CAMERAS.length
			};
		});

		expect(result.space).toBeGreaterThan(1_000_000);
		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(250);
		expect(result.paletteCount).toBeGreaterThanOrEqual(30);
		expect(result.grammarCount).toBeGreaterThanOrEqual(8);
		expect(result.cameraCount).toBeGreaterThanOrEqual(7);
		// 300 phrases (over an hour of music) walk through at least 40 distinct
		// (palette family, window grammar, camera) triples...
		expect(result.a.triples).toBeGreaterThanOrEqual(40);
		expect(result.a.grammars).toBe(result.grammarCount);
		expect(result.a.cameras).toBe(result.cameraCount);
		expect(result.a.palettes).toBeGreaterThanOrEqual(10);
		// ...and so does a live stream that never reports a section.
		expect(result.live.triples).toBeGreaterThanOrEqual(30);
		expect(result.live.palettes).toBeGreaterThanOrEqual(6);
	});

	test('structure, fold and family drive stay in authored ranges', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/composition.ts';
			const variationPath = '/src/lib/visualizer/variation.ts';
			const prism = await import(modulePath);
			const { VariationGenome } = await import(variationPath);
			const families = ['intro', 'verse', 'build', 'drop', 'bridge'].map((section) => prism.prismFamily(section));
			const folds = prism.PRISM_GRAMMARS.map((_: string, grammar: number) =>
				Array.from({ length: 8 }, (__, option) => prism.prismFold(grammar, option))
			);
			const genome = new VariationGenome(prism.PRISM_AXES, 'ranges');
			const structures = [];
			for (let phrase = 0; phrase < 200; phrase += 1) {
				genome.advance({ phraseIndex: phrase, sectionKey: `s${Math.floor(phrase / 2)}`, energy: 0.7, dt: 0.5 });
				structures.push(prism.prismStructure(genome, families[phrase % families.length]));
			}
			return { families, folds, structures, drive: prism.PRISM_FAMILY_DRIVE };
		});

		expect(result.families).toEqual(['quiet', 'verse', 'rise', 'peak', 'drift']);
		// Peaks are lit further out and cut finer than quiet sections.
		expect(result.drive.peak.outerLit).toBeGreaterThan(result.drive.quiet.outerLit);
		expect(result.drive.peak.cells).toBeGreaterThan(result.drive.quiet.cells);
		for (const options of result.folds) for (const fold of options) expect(fold).toBeGreaterThanOrEqual(2);
		for (const radial of result.folds.slice(0, 5)) for (const fold of radial) expect(fold).toBeGreaterThanOrEqual(4);
		for (const s of result.structures) {
			expect(s.grammar).toBeGreaterThanOrEqual(0);
			expect(s.grammar).toBeLessThan(8);
			expect(s.mosaic).toBeLessThan(5);
			expect(s.cellScale).toBeGreaterThanOrEqual(4);
			expect(s.cellScale).toBeLessThanOrEqual(40);
		}
	});

	test('palette families stay dark jewel glass and follow harmony', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/composition.ts';
			const prism = await import(modulePath);
			const steady = (option: number) => ({ from: option, to: option, mix: 1 });
			const harmony = (keyPitchClass: number, keyMinor: boolean, keyConfidence: number) => ({
				keyPitchClass,
				keyMinor,
				keyConfidence,
				energy: 0.5
			});
			const all = prism.PRISM_PALETTES.map((_: unknown, family: number) =>
				prism.prismPalette(steady(family), steady(0), 0, { ...harmony(0, false, 0), energy: 1 })
			);
			const keyed = Array.from({ length: 12 }, (_, pitch) =>
				prism.prismPalette(steady(0), steady(0), 0, harmony(pitch / 12, false, 0.9))
			);
			const minor = prism.prismPalette(steady(0), steady(0), 0, harmony(0, true, 0.9));
			const major = prism.prismPalette(steady(0), steady(0), 0, harmony(0, false, 0.9));
			const guested = prism.prismPalette(steady(0), steady(0), 0, harmony(0, false, 0), steady(12), 1);
			const day = Array.from({ length: 24 }, (_, i) => prism.prismDaylight(i / 24));
			return { all, keyed, minor, major, guested, day, names: prism.PRISM_PALETTES.map((p: { name: string }) => p.name) };
		});

		expect(new Set(result.names).size).toBe(result.names.length);
		for (const roles of result.all) {
			expect(roles.hero).not.toEqual(roles.support);
			for (const channel of [...roles.hero, ...roles.support, ...roles.accent, ...roles.field]) {
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThan(0.8);
			}
			// The field stays the darkest glass.
			expect(Math.max(...roles.field)).toBeLessThan(Math.max(...roles.hero));
		}
		// Key leans the hue: twelve keys give more than a handful of heroes.
		const heroes = new Set(result.keyed.map((r: { hero: number[] }) => r.hero.map((v) => v.toFixed(3)).join()));
		expect(heroes.size).toBeGreaterThan(6);
		expect(result.minor.accent).not.toEqual(result.major.accent);
		// A guest family changes the support glass but keeps the era's hero.
		expect(result.guested.hero).toEqual(result.all[0].hero.map((v: number) => v));
		expect(result.guested.support).not.toEqual(result.all[0].support);
		for (const light of result.day) {
			expect(Math.max(...light.color)).toBeLessThanOrEqual(1.0001);
			expect(Math.min(...light.color)).toBeGreaterThan(0.5);
			expect(light.power).toBeGreaterThan(0.85);
		}
	});

	test('cameras frame the wall and never sink through the floor', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/composition.ts';
			const prism = await import(modulePath);
			const straight = prism.prismCameraBasis(prism.prismCameraRegime(0, 0, 0, 0, 0));
			const centre = prism.prismProject(straight, [0, prism.PRISM_ROSE_Y, 0]);
			const edge = prism.prismProject(straight, [prism.PRISM_ROSE_R, prism.PRISM_ROSE_Y, 0]);
			const lows: number[] = [];
			for (let from = 0; from < prism.PRISM_CAMERAS.length; from += 1) {
				for (let to = 0; to < prism.PRISM_CAMERAS.length; to += 1) {
					for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
						for (const side of [-1, 0.3, 1]) {
							const basis = prism.prismCameraBasis(prism.prismCamera({ from, to, mix }, side, 0.4, 0.5, 0.8));
							lows.push(basis.pos[1]);
						}
					}
				}
			}
			const regimes = prism.PRISM_CAMERAS.map((_: string, regime: number) => prism.prismCameraRegime(regime, 0.7, 0.2, 0, 0));
			return { centre, edge, lowest: Math.min(...lows), floor: prism.PRISM_FLOOR_Y, regimes };
		});

		// Square-on is the original framing: the rose at (0, 0.07), radius 0.32.
		expect(result.centre[0]).toBeCloseTo(0, 5);
		expect(result.centre[1]).toBeCloseTo(0.07, 5);
		expect(result.edge[0]).toBeCloseTo(0.32, 5);
		expect(result.lowest).toBeGreaterThan(result.floor);
		// Regimes are genuinely different framings, not one camera jittered.
		const signatures = new Set(
			result.regimes.map((c: { yaw: number; pitch: number; dist: number }) =>
				[c.yaw.toFixed(1), c.pitch.toFixed(1), c.dist.toFixed(1)].join()
			)
		);
		expect(signatures.size).toBe(result.regimes.length);
	});

	test('shader uniform groups stay packed in the declared order', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/prism/shaders.ts';
			const shaders = await import(modulePath);
			const struct = shaders.PRISM_ROSE_WGSL.match(/struct Uniforms \{([\s\S]*?)\};/)?.[1] ?? '';
			const vecFields = [...struct.matchAll(/^\s*(\w+): vec4<f32>,/gm)].map((match) => match[1]);
			const scalarFields = [...struct.matchAll(/^\s*(\w+): f32,/gm)].map((match) => match[1]);
			return {
				vecFields,
				scalarCount: scalarFields.length,
				offsets: shaders.PRISM_UNIFORM_OFFSETS,
				floats: shaders.PRISM_UNIFORM_FLOATS,
				hasBacktick: [
					shaders.PRISM_ROSE_WGSL,
					shaders.PRISM_COMPOSITE_WGSL,
					shaders.PRISM_FEEDBACK_WGSL
				].some((code: string) => code.includes('`'))
			};
		});

		expect(result.hasBacktick).toBe(false);
		expect(result.scalarCount).toBe(24);
		const ordered = Object.entries(result.offsets as Record<string, number>).sort((a, b) => a[1] - b[1]);
		expect(ordered.map(([name]) => name)).toEqual(result.vecFields);
		ordered.forEach(([, offset], index) => expect(offset).toBe(24 + index * 4));
		expect(result.floats).toBe(24 + result.vecFields.length * 4);
	});
});
