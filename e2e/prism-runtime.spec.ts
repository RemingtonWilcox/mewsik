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
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const rig = await import('/src/lib/visualizer/prism/camera.ts');
			const at = (regime: number, shot: number[], side = 0, focus = 0) =>
				rig.prismCameraAt(regime, shot, { side, focus, drift: 0, anchor: 0 });
			const straight = prism.prismCameraBasis(at(0, [0, 0, 0, 0, 0, 0]));
			// Shots across the whole roaming box: its corners and a scatter inside.
			const shots: number[][] = [];
			for (let corner = 0; corner < 64; corner += 1) {
				shots.push(Array.from({ length: 6 }, (_, k) => ((corner >> k) & 1 ? 1.2 : -1.2)));
			}
			let state = 0x2545f491;
			const rand = () => {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				return ((state >>> 0) / 0x100000000) * 2.4 - 1.2;
			};
			for (let i = 0; i < 40; i += 1) shots.push(Array.from({ length: 6 }, rand));
			const centre = prism.prismProject(straight, [0, prism.PRISM_ROSE_Y, 0]);
			const edge = prism.prismProject(straight, [prism.PRISM_ROSE_R, prism.PRISM_ROSE_Y, 0]);
			const lows: number[] = [];
			let lost = 0;
			let worstScreen = 0;
			for (let from = 0; from < prism.PRISM_CAMERAS.length; from += 1) {
				for (let to = 0; to < prism.PRISM_CAMERAS.length; to += 1) {
					for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
						for (const side of [-1, 0.3, 1]) {
							for (const shot of shots) {
								const a = at(from, shot, side, 0.4);
								const b = at(to, shot, side, 0.4);
								const cam = rig.prismBlendCameras(a, b, mix);
								const basis = prism.prismCameraBasis(cam);
								lows.push(basis.pos[1]);
								// Every shot keeps the working window in the frame (on a third
								// at most), or looks at a point on its glass.
								const onGlass = Math.hypot(cam.tx, cam.ty - prism.PRISM_ROSE_Y) / prism.PRISM_ROSE_R < 1.05;
								const hero = prism.prismProject(basis, [0, prism.PRISM_ROSE_Y, 0]);
								const screen = hero ? Math.max(Math.abs(hero[0]) / 0.84, Math.abs(hero[1]) / 0.46) : 9;
								if (!onGlass) worstScreen = Math.max(worstScreen, screen);
								if (!onGlass && screen > 1) lost += 1;
							}
						}
					}
				}
			}
			const regimes = prism.PRISM_CAMERAS.map((_: string, regime: number) =>
				at(regime, [0.3, -0.5, 0.2, 0.4, -0.3, 0.6], 0.7, 0.2)
			);
			return { centre, edge, lowest: Math.min(...lows), floor: prism.PRISM_FLOOR_Y, regimes, lost, worstScreen };
		});

		// The orbit's centre is square-on: the original framing, the rose at (0, 0.07), radius 0.32.
		expect(result.centre[0]).toBeCloseTo(0, 5);
		expect(result.centre[1]).toBeCloseTo(0.07, 5);
		expect(result.edge[0]).toBeCloseTo(0.32, 5);
		expect(result.lowest).toBeGreaterThan(result.floor);
		expect(result.lost, `worst screen offset ${result.worstScreen}`).toBe(0);
		// Regions are genuinely different framings, not one camera jittered.
		const signatures = new Set(
			result.regimes.map((c: { yaw: number; pitch: number; roll: number; dist: number }) =>
				[c.yaw.toFixed(1), c.pitch.toFixed(1), c.roll.toFixed(1), c.dist.toFixed(1)].join()
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

// Prism never cuts: every discrete change is a crossfade, a morph or a
// dissolve, and a new song or a remount carries the picture on.
test.describe('Prism continuity', () => {
	test('every discrete axis is crossfaded or morphed', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const continuity = await import('/src/lib/visualizer/prism/continuity.ts');
			const choices = prism.PRISM_AXES.filter((axis: { kind: string }) => axis.kind === 'choice').map(
				(axis: { name: string }) => axis.name
			);
			const covered = [...continuity.PRISM_FOLLOWED_CHOICES, ...continuity.PRISM_MORPHED_CHOICES];
			const source = await (await fetch('/src/lib/components/visualizer/visualizer.svelte?raw')).text();
			return { choices: choices.sort(), covered: [...covered].sort(), source };
		});
		expect(result.covered).toEqual(result.choices);
		// The renderer reads followed axes through their followers, never raw.
		expect(result.source).not.toMatch(/genome\.choice\('(palette|roles|guest|camera|beatForm|environment)'\)/);
	});

	test('a choice retargeted mid-fade never drops a half-shown option', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { ChoiceFollower } = await import('/src/lib/visualizer/prism/continuity.ts');
			const dt = 1 / 60;
			const tau = 3;
			const weights = (s: { from: number; to: number; mix: number }) => {
				const w = [0, 0, 0, 0];
				w[s.from] += 1 - s.mix;
				w[s.to] += s.mix;
				return w;
			};
			const follower = new ChoiceFollower(0);
			// The genome target over time: 0 -> 1, then 2 while 1 is half in,
			// then straight back to 1, then 3.
			const plan: [number, number][] = [
				[1, 60],
				[2, 40],
				[1, 30],
				[3, 600]
			];
			let previous = weights(follower.state());
			let maxStep = 0;
			for (const [target, frames] of plan) {
				for (let frame = 0; frame < frames; frame += 1) {
					const now = weights(follower.update(target, tau, dt));
					maxStep = Math.max(maxStep, ...now.map((value, index) => Math.abs(value - previous[index])));
					previous = now;
				}
			}
			// Reversal is exact: returning to the outgoing option mid-fade keeps the frame.
			const reverse = new ChoiceFollower(0);
			for (let i = 0; i < 50; i += 1) reverse.update(1, tau, dt);
			const before = weights(reverse.state());
			const after = weights(reverse.update(0, tau, 0));
			return { maxStep, end: follower.state(), before, after };
		});
		// Smoothstep at the hurried rate peaks at 1.5 x 1.8 / (tau x 60) per frame.
		expect(result.maxStep).toBeLessThan(0.02);
		expect(result.end).toEqual({ from: 1, to: 3, mix: 1 });
		result.before.forEach((value: number, index: number) => expect(result.after[index]).toBeCloseTo(value, 6));
	});

	test('the mosaic re-drafts at irregular phrase ends and glides through clock jumps', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { MosaicDraft } = await import('/src/lib/visualizer/prism/continuity.ts');
			const draft = new MosaicDraft();
			const dt = 1 / 60;
			let maxStep = 0;
			let previous = 0;
			const sample = () => {
				const position = draft.phrase + draft.mix;
				maxStep = Math.max(maxStep, Math.abs(position - previous));
				previous = position;
			};
			// Forty natural 8-second phrases: note which ones end in a re-draft.
			const redrafts: number[] = [];
			for (let phrase = 0; phrase < 40; phrase += 1) {
				const at = draft.phrase;
				for (let frame = 0; frame < 480; frame += 1) {
					draft.update(phrase, frame / 480, dt);
					sample();
				}
				if (draft.phrase > at) redrafts.push(phrase);
			}
			const natural = draft.phrase;
			const gaps = new Set(redrafts.slice(1).map((p, i) => p - redrafts[i]));
			// A new song mid-phrase: the clock restarts at phrase 0, position 0.
			for (let frame = 0; frame < 200; frame += 1) {
				draft.update(40, 0.3 + frame / 2000, dt);
				sample();
			}
			draft.continueSource();
			for (let frame = 0; frame < 300; frame += 1) {
				draft.update(0, frame / 1000, dt);
				sample();
			}
			// A phrase position re-sync without an index change.
			for (let frame = 0; frame < 120; frame += 1) {
				draft.update(0, frame < 60 ? 0.95 : 0.1, dt);
				sample();
			}
			return { maxStep, natural, final: draft.phrase, count: redrafts.length, gaps: gaps.size };
		});
		// Some phrases re-draft the glass, not every one, and not on a fixed count.
		expect(result.count).toBeGreaterThan(12);
		expect(result.count).toBeLessThan(36);
		expect(result.gaps).toBeGreaterThanOrEqual(3);
		expect(result.final).toBeGreaterThanOrEqual(result.natural);
		// Never more than a hair of a re-draft per frame at 60 fps.
		expect(result.maxStep).toBeLessThan(0.03);
	});

	test('structure morphs start and end invisible and never jump a pixel', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const c = await import('/src/lib/visualizer/prism/continuity.ts');
			const live = { petalWidth: 0.7, petalReach: 0.6, tracery: 0.5, cusp: 0.5, sprinkle: 0.5 };
			const structure = (grammar: number) => ({
				grammar,
				fold: prism.prismFold(grammar, 2),
				mosaic: 1,
				cellScale: 18,
				tiers: 0.5,
				outline: 0
			});
			const morph = new c.StructureMorph(structure(0), 'verse', live, 1234);
			const dt = 1 / 60;
			const radii = [0, 0.3, 0.8, 1, 1.6, 2.2, 3.2];
			const keys = [0, 0.25, 0.5, 0.75, 1];
			const weightsNow = () => {
				const { front, globalMix } = morph.uniforms();
				return radii.flatMap((rn) =>
					keys.map((key) => (morph.morphing ? c.prismMorphWeight(front, rn, key, globalMix) : 1))
				);
			};
			morph.update(structure(4), 'verse', live, dt);
			const started = morph.morphing;
			const first = weightsNow();
			const saltChanged = morph.a.salt !== morph.b.salt;
			let previous = first;
			let maxStep = 0;
			let frames = 0;
			let queuedWaited = true;
			let endedOnB = false;
			let nextFromB = false;
			while (frames < 2000) {
				const bBefore = JSON.stringify({ ...morph.b, petalWidth: 0, petalReach: 0, outerLit: 0 });
				// A third structure arrives mid-morph: it must wait its turn.
				morph.update(structure(frames > 30 ? 6 : 4), 'verse', live, dt);
				frames += 1;
				if (morph.serial !== 1) {
					// The first morph finished and the queued one began on the same
					// frame: it starts from the window that was on screen.
					nextFromB = JSON.stringify({ ...morph.a, petalWidth: 0, petalReach: 0, outerLit: 0 }) === bBefore;
					endedOnB = Math.min(...previous) > 0.999;
					break;
				}
				if (morph.b.grammar !== 4) queuedWaited = false;
				const now = weightsNow();
				maxStep = Math.max(maxStep, ...now.map((value, index) => Math.abs(value - previous[index])));
				previous = now;
			}
			return {
				started,
				first: Math.max(...first),
				last: Math.min(...previous),
				maxStep,
				seconds: frames * dt,
				saltChanged,
				queuedWaited,
				endedOnB,
				nextFromB,
				nextStarted: morph.morphing && morph.b.grammar === 6 && Math.max(...weightsNow()) === 0
			};
		});
		expect(result.started).toBe(true);
		expect(result.first).toBe(0);
		expect(result.last).toBeGreaterThan(0.999);
		// No pixel crosses more than a few percent of the way in one frame.
		expect(result.maxStep).toBeLessThan(0.06);
		expect(result.seconds).toBeGreaterThan(2.5);
		expect(result.seconds).toBeLessThan(5);
		expect(result.saltChanged).toBe(true);
		expect(result.queuedWaited).toBe(true);
		expect(result.endedOnB).toBe(true);
		expect(result.nextFromB).toBe(true);
		expect(result.nextStarted).toBe(true);
	});

	test('the rose turn, clock and camera side carry through a source reset', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const rig = await import('/src/lib/visualizer/prism/camera.ts');
			const { PrismMotion } = await import('/src/lib/visualizer/prism/continuity.ts');
			const motion = new PrismMotion(0.8);
			const dt = 1 / 60;
			let trace = 0;
			let maxTurn = 0;
			let maxClockStep = 0;
			let rotation = motion.rotation;
			let clock = motion.clock;
			for (let frame = 0; frame < 1200; frame += 1) {
				trace += dt * 0.2;
				if (frame === 600) {
					// The next song: the shared trace phase restarts, the turn preference flips.
					trace = 0;
					motion.continueSource(0.2);
				}
				motion.update({ tracePhase: trace, dt, motion: 1, energy: 0.6, silence: 0 });
				maxTurn = Math.max(maxTurn, Math.abs(motion.rotation - rotation));
				maxClockStep = Math.max(maxClockStep, motion.clock - clock);
				rotation = motion.rotation;
				clock = motion.clock;
			}
			const sides = Array.from({ length: 201 }, (_, i) => -1 + i / 100);
			const yaws = sides.map(
				(side) => rig.prismCameraAt(1, [0.2, 0, 0, 0, 0, 0], { side, focus: 0.3, drift: 0, anchor: 0 }).yaw
			);
			const yawStep = Math.max(...yaws.slice(1).map((yaw: number, i: number) => Math.abs(yaw - yaws[i])));
			return { maxTurn, maxClockStep, clock: motion.clock, turn: motion.turn, yawStep };
		});
		expect(result.maxTurn).toBeLessThan(0.002);
		expect(result.maxClockStep).toBeLessThan(0.02);
		expect(result.clock).toBeCloseTo(20, 1);
		// The turn eases toward the new song's direction instead of flipping.
		expect(result.turn).toBeLessThan(1);
		expect(result.turn).toBeGreaterThan(-1);
		// Receding camera: the side swings through square-on, no flip at zero.
		expect(result.yawStep).toBeLessThan(0.05);
	});

	test('a new source keeps the composition and a remount resumes it', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const prism = await import('/src/lib/visualizer/prism/composition.ts');
			const c = await import('/src/lib/visualizer/prism/continuity.ts');
			const { VariationGenome } = await import('/src/lib/visualizer/variation.ts');
			type Run = {
				motion: InstanceType<typeof c.PrismMotion>;
				draft: InstanceType<typeof c.MosaicDraft>;
				morph: InstanceType<typeof c.StructureMorph>;
				resyncBeat: boolean;
			};
			const state = { genome: new VariationGenome(prism.PRISM_AXES, 0.5), epoch: -1, run: null as Run | null };
			let creates = 0;
			const create = (): Run => {
				creates += 1;
				return {
					motion: new c.PrismMotion(0.3),
					draft: new c.MosaicDraft(),
					morph: new c.StructureMorph(
						prism.prismStructure(state.genome, 'verse'),
						'verse',
						prism.prismLive(state.genome),
						99
					),
					resyncBeat: false
				};
			};
			const step = (phraseIndex: number, section: string) => {
				const run = state.run!;
				state.genome.advance({ phraseIndex, sectionKey: section, energy: 0.6, dt: 1 / 30 });
				run.morph.update(prism.prismStructure(state.genome, 'verse'), 'verse', prism.prismLive(state.genome), 1 / 30);
				run.draft.update(phraseIndex, 0.5, 1 / 30);
			};
			const first = c.prismEnterSource(state, 1, 0.3, create);
			for (let phrase = 0; phrase < 20; phrase += 1) for (let f = 0; f < 60; f += 1) step(phrase, `s${phrase >> 2}`);
			const shown = () => `${prism.prismStructureKey(state.run!.morph.b)}:${state.run!.morph.b.salt}`;
			const before = { b: shown(), draft: state.run!.draft.phrase };
			const runBefore = state.run;
			const second = c.prismEnterSource(state, 2, 0.9, create);
			// The new song's first frame: its phrase clock restarts at zero.
			step(0, 'intro');
			const after = { b: shown(), draft: state.run!.draft.phrase };
			const resync = state.run!.resyncBeat;
			const third = c.prismEnterSource(state, 2, 0.9, create);
			return {
				first,
				second,
				third,
				creates,
				sameRun: runBefore === state.run,
				keptStructure: before.b === after.b,
				keptDraft: before.draft === after.draft,
				resync
			};
		});
		expect(result.first).toBe('reset');
		expect(result.second).toBe('continue');
		expect(result.third).toBe('resume');
		expect(result.creates).toBe(1);
		expect(result.sameRun).toBe(true);
		expect(result.keptStructure).toBe(true);
		expect(result.keptDraft).toBe(true);
		expect(result.resync).toBe(true);
	});
});
