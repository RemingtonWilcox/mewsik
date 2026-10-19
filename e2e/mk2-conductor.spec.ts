import { expect, test } from '@playwright/test';

// Soma (mk2): the reactive conductor rails, the look genome's size and
// variety, and the metamorphosis between species staying continuous.

/** A minimal director/spectrum/conductor frame for driving SomaLook directly. */
const FAKE_FRAMES = `
	globalThis.__somaFake = (state) => ({
		director: {
			section: state.section,
			silence: !!state.silent,
			energy: state.energy,
			bassPunch: state.punch ?? 0,
			drop: { buildActive: false, buildProgress: 0, dropEta: 99, anticipation: 0, postDropDecay: 0 },
			clock: {
				tempoBpm: 120,
				beatPhase: state.beatPhase,
				beatPulse: 0,
				downbeatFlag: false,
				barIndex: state.bar,
				beatIndex: state.beat,
				phrasePos: state.phrasePos,
				phraseIndex: state.phrase
			},
			context: { sectionEnergy: state.energy, keyPitchClass: 0.3, keyConfidence: 0.6, keyMode: 'minor' }
		},
		spectrum: { bass: state.energy * 0.8, mid: state.energy * 0.6, treble: state.energy * 0.4 },
		mk2: { kick: state.kick ?? 0, sparkle: 0, impact: state.kick ?? 0 }
	});
`;

test.describe('Soma conductor', () => {
	test('impact rises on kicks, releases in about 300 ms, and phases stay monotonic', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const runtime = new VisualizerJourneyRuntime(0.31, 0);
			runtime.resetSource('soma-conductor', 0);
			const loud = {
				bins: Array.from({ length: 64 }, (_, i) => (i < 16 ? 0.9 : 0.5)),
				rms: 0.6,
				peak: 0.95,
				centroid: 0.4,
				onset: true,
				bass: 0.95,
				mid: 0.55,
				treble: 0.3,
				sample_rate: 48_000,
				bpm: 124,
				beat_phase: 0.02,
				chroma_key: 0.3,
				chroma_strength: 0.8
			};
			let now = 0;
			let peak = 0;
			const phases: number[][] = [];
			for (let i = 0; i < 90; i += 1) {
				now += 1000 / 60;
				const s = runtime.advance({ ...loud, onset: i % 15 === 0, bass: i % 15 < 3 ? 0.95 : 0.4 }, now);
				peak = Math.max(peak, s.mk2.impact);
				phases.push([s.mk2.cameraPhase, s.mk2.backgroundFlowPhase, Math.abs(s.mk2.rotationPhase)]);
			}
			let silentImpact = 1;
			for (let i = 0; i < 150; i += 1) {
				now += 1000 / 60;
				const s = runtime.advance(null, now);
				silentImpact = s.mk2.impact;
				phases.push([s.mk2.cameraPhase, s.mk2.backgroundFlowPhase, Math.abs(s.mk2.rotationPhase)]);
			}
			const monotonic = phases.every((p, i) => i === 0 || (p[0] > phases[i - 1][0] && p[1] > phases[i - 1][1] && p[2] >= phases[i - 1][2]));
			const forms = runtime.cachedSnapshot!.mk2;
			const sum = forms.seedForm + forms.sproutForm + forms.windingForm + forms.bloomForm + forms.sheddingForm + forms.dormancyForm;
			return { peak, silentImpact, monotonic, sum };
		});
		expect(result.peak).toBeGreaterThan(0.25);
		expect(result.silentImpact).toBeLessThan(0.02);
		expect(result.monotonic).toBe(true);
		expect(result.sum).toBeCloseTo(1, 5);
	});

	test('the Signal conductor is optional', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { Mk2Conductor } = await import('/src/lib/visualizer/mk2/conductor.ts');
			const runtime = new VisualizerJourneyRuntime(0.5, 0);
			runtime.resetSource('soma-optional', 0);
			const snap = runtime.advance(null, 16);
			const conductor = new Mk2Conductor(0.5);
			const a = conductor.update(snap.director, snap.spectrum, 1 / 60);
			const b = new Mk2Conductor(0.5).update(snap.director, snap.spectrum, 1 / 60, snap.signal);
			return { a: a.cameraPhase, b: b.cameraPhase, finite: Object.values(a).every((v) => typeof v !== 'number' || Number.isFinite(v)) };
		});
		expect(result.finite).toBe(true);
		expect(result.a).toBeCloseTo(result.b, 8);
	});
});

test.describe('Soma look genome', () => {
	test('is larger than a million looks, deterministic per seed, and reaches 40+ species/world/palette looks in 300 phrases', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VariationGenome, variationSpaceSize } = await import('/src/lib/visualizer/variation.ts');
			const { SOMA_AXES, SOMA_SPECIES, SOMA_ENVIRONMENTS, SOMA_PALETTES, SOMA_CAMERAS } = await import('/src/lib/visualizer/mk2/species.ts');
			const run = (seed: string) => {
				const genome = new VariationGenome(SOMA_AXES, seed);
				const looks = new Set<string>();
				const species = new Set<number>();
				const environments = new Set<number>();
				const palettes = new Set<number>();
				const cameras = new Set<number>();
				for (let phrase = 0; phrase < 300; phrase += 1) {
					for (let frame = 0; frame < 8; frame += 1) {
						genome.advance({ phraseIndex: phrase, sectionKey: `s${Math.floor(phrase / 4)}`, energy: 0.5 + 0.4 * Math.sin(phrase * 0.3), dt: 0.25 });
					}
					const s = genome.choice('species').to;
					const e = genome.choice('environment').to;
					const p = genome.choice('palette').to;
					looks.add(`${s}:${e}:${p}`);
					species.add(s);
					environments.add(e);
					palettes.add(p);
					cameras.add(genome.choice('camera').to);
				}
				return { looks: looks.size, species: species.size, environments: environments.size, palettes: palettes.size, cameras: cameras.size, signature: genome.signature() };
			};
			const a = run('soma-variety');
			const b = run('soma-variety');
			const c = run('soma-variety-2');
			return {
				space: variationSpaceSize(SOMA_AXES),
				a,
				deterministic: a.signature === b.signature,
				differs: a.signature !== c.signature,
				totals: [SOMA_SPECIES.length, SOMA_ENVIRONMENTS.length, SOMA_PALETTES.length, SOMA_CAMERAS.length]
			};
		});
		expect(result.space).toBeGreaterThan(1e6);
		expect(result.deterministic).toBe(true);
		expect(result.differs).toBe(true);
		expect(result.a.looks).toBeGreaterThanOrEqual(40);
		expect(result.a.species).toBe(result.totals[0]);
		expect(result.a.environments).toBe(result.totals[1]);
		expect(result.a.palettes).toBeGreaterThan(result.totals[2] * 0.75);
		expect(result.a.cameras).toBe(result.totals[3]);
	});

	test('a species change is a metamorphosis: anatomy, body, camera and colour move continuously', async ({ page }) => {
		await page.goto('/');
		await page.addInitScript(FAKE_FRAMES);
		await page.reload();
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const { SOMA_ANATOMY_KEYS } = await import('/src/lib/visualizer/mk2/species.ts');
			const fake = (globalThis as any).__somaFake;
			const look = new SomaLook(0.42);
			const dt = 1 / 60;
			const fps = 60;
			const beatsPerSecond = 2;
			let previous: number[] | null = null;
			let prevEye: number[] | null = null;
			let prevPos: number[] | null = null;
			let prevGlow: number[] | null = null;
			let maxAnatomyStep = 0;
			let maxEyeStep = 0;
			let eyeMax = '';
			let maxPosStep = 0;
			let maxGlowStep = 0;
			let speciesChanges = 0;
			let lastSpecies = -1;
			const seen = new Set<string>();
			const sections = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const seconds = 60 * 12;
			for (let frame = 0; frame < seconds * fps; frame += 1) {
				const time = frame / fps;
				const beats = time * beatsPerSecond;
				const phrase = Math.floor(beats / 16);
				const f = look.update({
					...fake({
						section: sections[Math.floor(phrase / 3) % sections.length],
						energy: 0.55 + 0.35 * Math.sin(time * 0.05),
						beatPhase: beats % 1,
						beat: Math.floor(beats) % 4,
						bar: Math.floor(beats / 4),
						phrase,
						phrasePos: (beats % 16) / 16,
						kick: beats % 1 < 0.1 ? 0.8 : 0.1
					}),
					live: true,
					dt,
					aspect: 1.6
				});
				const anatomy = Array.from(f.anatomy);
				if (previous) {
					for (let i = 0; i < anatomy.length; i += 1) {
						const scale = Math.max(1, Math.abs(previous[i]));
						maxAnatomyStep = Math.max(maxAnatomyStep, Math.abs(anatomy[i] - previous[i]) / scale);
					}
				}
				const eye = [...f.camera3.pos];
				const pos = [...f.organism.pos];
				const glow = [...f.colors.glow];
				if (prevEye) {
					const step = Math.hypot(eye[0] - prevEye[0], eye[1] - prevEye[1], eye[2] - prevEye[2]);
					if (step > maxEyeStep) eyeMax = `${frame} ${f.names.species} ${f.names.camera} ${f.camera.from}>${f.camera.to}@${f.camera.mix.toFixed(2)} eye ${eye.map((v) => v.toFixed(2))}`;
					maxEyeStep = Math.max(maxEyeStep, step);
				}
				if (prevPos) maxPosStep = Math.max(maxPosStep, Math.hypot(pos[0] - prevPos[0], pos[1] - prevPos[1], pos[2] - prevPos[2]));
				if (prevGlow) maxGlowStep = Math.max(maxGlowStep, ...glow.map((g, i) => Math.abs(g - prevGlow![i])));
				previous = anatomy;
				prevEye = eye;
				prevPos = pos;
				prevGlow = glow;
				if (f.species.to !== lastSpecies) {
					if (lastSpecies !== -1) speciesChanges += 1;
					lastSpecies = f.species.to;
				}
				seen.add(f.names.species);
			}
			return { eyeMax, keys: SOMA_ANATOMY_KEYS.length, maxAnatomyStep, maxEyeStep, maxPosStep, maxGlowStep, speciesChanges, species: seen.size };
		});
		expect(result.keys).toBe(48);
		expect(result.speciesChanges).toBeGreaterThanOrEqual(4);
		expect(result.species).toBeGreaterThanOrEqual(5);
		// At 60 fps no anatomy value moves more than 2.5% of its scale in a frame.
		expect(result.maxAnatomyStep).toBeLessThan(0.025);
		expect(result.maxEyeStep).toBeLessThan(0.05);
		expect(result.maxPosStep).toBeLessThan(0.02);
		expect(result.maxGlowStep).toBeLessThan(0.03);
	});
});
