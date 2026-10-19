import { expect, test } from '@playwright/test';

test.describe('Soma render runtime', () => {
	test('selects eco, balanced, and ultra from display workload and hardware hints', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { selectSomaQuality } = await import(modulePath);
			return {
				ultra: selectSomaQuality(1920, 1080, 1, 16, 8).tier,
				balanced: selectSomaQuality(2560, 1440, 1, 12, 8).tier,
				dense4k: selectSomaQuality(3840, 2160, 1, 24, 16).tier,
				lowEnd: selectSomaQuality(1280, 720, 1, 4, 4).tier,
				eightCore: selectSomaQuality(1920, 1080, 1, 8, 8).tier
			};
		});

		expect(result).toEqual({
			ultra: 'ultra',
			balanced: 'balanced',
			dense4k: 'eco',
			lowEnd: 'eco',
			eightCore: 'balanced'
		});
	});

	test('keeps every tier inside its absolute HDR pixel ceiling', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SOMA_QUALITY_PROFILES, somaBackingSize } = await import(modulePath);
			return Object.fromEntries(
				Object.entries(SOMA_QUALITY_PROFILES).map(([tier, profile]: [string, any]) => {
					const backing = somaBackingSize(7680, 4320, 2, tier);
					return [
						tier,
						{
							...backing,
							pixels: backing.width * backing.height,
							ceiling: profile.maxPixels,
							frameRate: profile.frameRate,
							steps: profile.raymarchSteps
						}
					];
				})
			);
		});

		for (const sample of Object.values(result) as Array<{
			width: number;
			height: number;
			pixels: number;
			ceiling: number;
		}>) {
			expect(sample.pixels).toBeLessThanOrEqual(sample.ceiling);
			expect(sample.width / sample.height).toBeCloseTo(16 / 9, 2);
		}
		expect(result.eco.ceiling).toBeLessThan(result.balanced.ceiling);
		expect(result.balanced.ceiling).toBeLessThan(result.ultra.ceiling);
		expect(result.eco.frameRate).toBeLessThan(result.balanced.frameRate);
		expect(result.balanced.frameRate).toBeLessThan(result.ultra.frameRate);
		expect(result.eco.steps).toBeLessThan(result.balanced.steps);
		expect(result.balanced.steps).toBeLessThan(result.ultra.steps);
	});

	test('paces Soma on whole display-vsync divisors instead of a repeating skip cadence', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { somaFrameStride } = await import(modulePath);
			return {
				hz143: {
					ultra: somaFrameStride(1000 / 143, 60),
					balanced: somaFrameStride(1000 / 143, 50),
					eco: somaFrameStride(1000 / 143, 40)
				},
				hz60: {
					ultra: somaFrameStride(1000 / 60, 60),
					balanced: somaFrameStride(1000 / 60, 50),
					eco: somaFrameStride(1000 / 60, 40)
				}
			};
		});

		expect(result).toEqual({
			hz143: { ultra: 2, balanced: 3, eco: 4 },
			hz60: { ultra: 1, balanced: 1, eco: 2 }
		});
	});

	test('preserves aspect ratio at ordinary and high-DPI viewport sizes', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SOMA_QUALITY_PROFILES, somaBackingSize } = await import(modulePath);
			return {
				ordinary: somaBackingSize(1280, 720, 1, 'ultra'),
				retina4k: somaBackingSize(3840, 2160, 2, 'ultra'),
				ceiling: SOMA_QUALITY_PROFILES.ultra.maxPixels
			};
		});

		expect(result.ordinary.width / result.ordinary.height).toBeCloseTo(16 / 9, 2);
		expect(result.retina4k.width / result.retina4k.height).toBeCloseTo(16 / 9, 2);
		expect(result.retina4k.width * result.retina4k.height).toBeLessThanOrEqual(
			result.ceiling
		);
	});

	test('steps down only after sustained missed frames and ignores ordinary jitter', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SomaAutoQualityController } = await import(modulePath);
			const governor = new SomaAutoQualityController('ultra');

			for (let i = 0; i < 600; i++) governor.observeFrame(i % 2 ? 17.3 : 16);
			const afterJitter = governor.tier;
			governor.observeFrame(120);
			for (let i = 0; i < 180; i++) governor.observeFrame(16.67);
			const afterOneHitch = governor.tier;

			let ultraMisses = 0;
			while (governor.tier === 'ultra' && ultraMisses < 500) {
				governor.observeFrame(34);
				ultraMisses++;
			}
			const afterFirstPressureRun = governor.tier;

			let balancedMisses = 0;
			while (governor.tier === 'balanced' && balancedMisses < 500) {
				governor.observeFrame(30);
				balancedMisses++;
			}

			return {
				afterJitter,
				afterOneHitch,
				afterFirstPressureRun,
				afterSecondPressureRun: governor.tier,
				ultraMisses,
				balancedMisses
			};
		});

		expect(result.afterJitter).toBe('ultra');
		expect(result.afterOneHitch).toBe('ultra');
		expect(result.afterFirstPressureRun).toBe('balanced');
		expect(result.afterSecondPressureRun).toBe('eco');
		expect(result.ultraMisses).toBeGreaterThan(30);
		expect(result.balancedMisses).toBeGreaterThan(30);
	});

	test('recovers slowly without exceeding the hardware and viewport ceiling', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/mk2/runtime.ts';
			const { SomaAutoQualityController } = await import(modulePath);
			const governor = new SomaAutoQualityController('ultra');

			while (governor.tier === 'ultra') governor.observeFrame(34);
			for (let i = 0; i < 1_000; i++) governor.observeFrame(20);
			const afterTwentyStableSeconds = governor.tier;
			for (let i = 0; i < 650; i++) governor.observeFrame(20);
			const afterLongStableRun = governor.tier;

			const capped = new SomaAutoQualityController('balanced');
			for (let i = 0; i < 2_000; i++) capped.observeFrame(20);
			const atInitialCeiling = capped.tier;
			capped.setCeiling('ultra');
			for (let i = 0; i < 1_000; i++) capped.observeFrame(20);
			const beforeFreshStableRun = capped.tier;
			for (let i = 0; i < 650; i++) capped.observeFrame(20);
			const afterFreshStableRun = capped.tier;
			const afterLowerCeiling = capped.setCeiling('eco');
			capped.observeFrame(2_000);

			return {
				afterTwentyStableSeconds,
				afterLongStableRun,
				atInitialCeiling,
				beforeFreshStableRun,
				afterFreshStableRun,
				afterLowerCeiling,
				afterIgnoredPause: capped.tier
			};
		});

		expect(result).toEqual({
			afterTwentyStableSeconds: 'balanced',
			afterLongStableRun: 'ultra',
			atInitialCeiling: 'balanced',
			beforeFreshStableRun: 'balanced',
			afterFreshStableRun: 'ultra',
			afterLowerCeiling: 'eco',
			afterIgnoredPause: 'eco'
		});
	});

	test('renders the raymarched scene at a reduced internal size per tier', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SOMA_QUALITY_PROFILES, somaBackingSize, somaSceneSize } = await import('/src/lib/visualizer/mk2/runtime.ts');
			return Object.fromEntries(
				Object.keys(SOMA_QUALITY_PROFILES).map((tier) => {
					const backing = somaBackingSize(1280, 800, 1, tier);
					const scene = somaSceneSize(backing.width, backing.height, tier);
					return [tier, { backing: backing.width * backing.height, scene: scene.width * scene.height, aspect: scene.width / scene.height }];
				})
			);
		});
		for (const tier of Object.values(result) as Array<{ backing: number; scene: number; aspect: number }>) {
			expect(tier.scene).toBeLessThan(tier.backing * 0.6);
			expect(tier.aspect).toBeCloseTo(1.6, 1);
		}
		expect(result.eco.scene).toBeLessThan(result.balanced.scene);
		expect(result.balanced.scene).toBeLessThan(result.ultra.scene);
	});

	test('the uniform contract matches the WGSL struct and every pass reads its uniforms', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const shaders = await import('/src/lib/visualizer/mk2/shaders.ts');
			const code = shaders.SOMA_SCENE_WGSL;
			const struct = code.slice(code.indexOf('struct Uniforms'), code.indexOf('};'));
			return {
				bytes: shaders.SOMA_UNIFORM_BYTES,
				fields: shaders.SOMA_UNIFORM_FIELDS.length,
				structFields: (struct.match(/: vec4<f32>,/g) ?? []).length,
				usesBins: code.includes('bins['),
				postUsesUniforms: [
					shaders.SOMA_FEEDBACK_WGSL,
					shaders.SOMA_BLOOM_DOWN_WGSL,
					shaders.SOMA_BLUR_H_WGSL,
					shaders.SOMA_BLUR_V_WGSL,
					shaders.SOMA_COMPOSITE_WGSL
				].every((pass) => /fn fs_main[\s\S]*u\./.test(pass))
			};
		});
		expect(result.bytes).toBe(result.fields * 16);
		expect(result.structFields).toBe(result.fields);
		expect(result.usesBins).toBe(true);
		expect(result.postUsesUniforms).toBe(true);
	});

	test('the look lives in the journey: a remount resumes exactly, a new source reseeds without restarting', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { createSomaLookState, somaSyncLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const runtime = new VisualizerJourneyRuntime(0.37, 0);
			const features = {
				bins: Array.from({ length: 64 }, (_, i) => (i < 14 ? 0.8 : 0.45)),
				rms: 0.5,
				peak: 0.9,
				centroid: 0.42,
				onset: false,
				bass: 0.7,
				mid: 0.5,
				treble: 0.3,
				sample_rate: 48_000,
				bpm: 124,
				beat_phase: 0.1,
				chroma_key: 0.3,
				chroma_strength: 0.6
			};
			type Features = typeof features;
			let now = 0;
			// What the renderer component does every frame.
			const renderer = () => {
				const state = runtime.persistentLook('soma', createSomaLookState);
				let epoch = -1;
				return {
					state,
					frame(input: Features | null) {
						now += 1000 / 60;
						const journey = runtime.advance(input, now);
						const sync = journey.sourceEpoch !== epoch ? somaSyncLook(state, journey.sourceEpoch, journey.seed) : 'none';
						epoch = journey.sourceEpoch;
						const f = state.look.update({
							director: journey.director,
							spectrum: journey.spectrum,
							mk2: journey.mk2,
							live: !!input,
							dt: 1 / 60,
							aspect: 1.6
						});
						return { sync, species: f.species.to, eye: [...f.camera3.pos], pos: [...f.organism.pos], anatomy: Array.from(f.anatomy) };
					}
				};
			};
			runtime.resetSource('track-a', 0);
			const first = renderer();
			const syncs: string[] = [];
			let last = first.frame(features);
			syncs.push(last.sync);
			for (let i = 0; i < 900; i += 1) last = first.frame({ ...features, onset: i % 30 === 0, beat_phase: (i / 30) % 1 });
			const beforeUnmount = first.state.look.fingerprint();

			// Leave and re-enter the visualizer: a fresh component, the same source epoch.
			const second = renderer();
			const sameObject = second.state === first.state;
			const fingerprintOnRemount = second.state.look.fingerprint();
			const resumed = second.frame(features);
			syncs.push(resumed.sync);
			const resumeStep = Math.hypot(...resumed.eye.map((v, i) => v - last.eye[i]));

			// A new song: a new source epoch and seed. The picture carries on.
			for (let i = 0; i < 120; i += 1) last = second.frame(features);
			runtime.resetSource('track-b', now + 1);
			const next = second.frame(features);
			syncs.push(next.sync);
			return {
				syncs,
				sameObject,
				remountIdentical: beforeUnmount === fingerprintOnRemount,
				resumeStep,
				eyeStep: Math.hypot(...next.eye.map((v, i) => v - last.eye[i])),
				posStep: Math.hypot(...next.pos.map((v, i) => v - last.pos[i])),
				anatomyStep: Math.max(...next.anatomy.map((v, i) => Math.abs(v - last.anatomy[i]))),
				speciesKept: next.species === last.species
			};
		});
		expect(result.syncs).toEqual(['reset', 'resume', 'reseed']);
		expect(result.sameObject).toBe(true);
		expect(result.remountIdentical).toBe(true);
		expect(result.resumeStep).toBeLessThan(0.05);
		expect(result.eyeStep).toBeLessThan(0.05);
		expect(result.posStep).toBeLessThan(0.02);
		expect(result.anatomyStep).toBeLessThan(0.05);
		expect(result.speciesKept).toBe(true);
	});

	test('reseed changes only the future: the look diverges from a run that kept the old seed', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const a = new SomaLook('song-1');
			const b = new SomaLook('song-1');
			const walk = (look: InstanceType<typeof SomaLook>, from: number, to: number) => {
				for (let phrase = from; phrase < to; phrase += 1) {
					for (let i = 0; i < 4; i += 1) {
						look.genome.advance({ phraseIndex: phrase, sectionKey: `s${Math.floor(phrase / 3)}`, energy: 0.6, dt: 0.25 });
					}
				}
			};
			walk(a, 0, 40);
			walk(b, 0, 40);
			const before = JSON.stringify(a.genome.snapshot());
			a.reseed('song-2');
			const kept = JSON.stringify(a.genome.snapshot()) === before;
			walk(a, 0, 40);
			walk(b, 40, 80);
			return { kept, diverged: JSON.stringify(a.genome.snapshot()) !== JSON.stringify(b.genome.snapshot()) };
		});
		expect(result.kept).toBe(true);
		expect(result.diverged).toBe(true);
	});

	test('the component keeps its look in the journey and its capture contract', async ({ page }) => {
		await page.goto('/');
		const source = await page.evaluate(async () => {
			const modulePath = '/src/lib/components/visualizer/visualizer-mk2.svelte?raw';
			return (await import(/* @vite-ignore */ modulePath)).default as string;
		});
		expect(source).toContain("vis.persistentLook('soma'");
		expect(source).toContain('somaSyncLook(');
		expect(source).toContain('aria-label="Soma audio visualizer"');
		expect(source).toContain('data-soma-ready=');
		// Feedback history resets on resize only, never on a source change.
		const sync = source.slice(source.indexOf('if (journey.sourceEpoch !== rendererSourceEpoch)'), source.indexOf('look.setForce('));
		expect(sync.length).toBeGreaterThan(0);
		expect(sync).not.toContain('feedbackResetFrames');
	});
});
