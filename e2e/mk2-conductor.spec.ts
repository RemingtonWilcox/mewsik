import { expect, test } from '@playwright/test';

const FIXTURES = {
	director: {
		section: 'verse',
		sectionAge: 0,
		motif: 'organism',
		motifIndex: 0,
		silence: false,
		energy: 0.48,
		density: 0.5,
		motion: 0.44,
		structure: 0.5,
		phrase: 0.25,
		palette: { baseHue: 0.62, accentHue: 0.08, rimHue: 0.78, saturation: 0.8, warmth: 0.2 },
		paletteBase: 0.62,
		paletteAccent: 0.08,
		clock: {
			tempoBpm: 124,
			beatPhase: 0.4,
			beatPulse: 0,
			downbeatFlag: false,
			barIndex: 0,
			beatIndex: 0,
			phrasePos: 0.25,
			phraseIndex: 0
		},
		drop: {
			buildActive: false,
			buildProgress: 0,
			dropEta: 99,
			anticipation: 0,
			postDropDecay: 0
		},
		valence: 0.55,
		arousal: 0.48,
		bassPunch: 0,
		trebleSparkle: 0.35,
		tonnetz: [0.5, 0.2, -0.1, 0.1, -0.2, 0.3],
		bassRaw: 0.45,
		midRaw: 0.48,
		trebleRaw: 0.32,
		centroidRaw: 0.46,
		context: {
			source: 'score',
			sectionProgress: 0.5,
			sectionEnergy: 0.5,
			trackProgress: 0.3,
			energyCurrent: 0.48,
			energySlope: 0,
			energyLookahead: 0.48,
			keyPitchClass: 2 / 12,
			keyMode: 'minor',
			keyConfidence: 0.8
		}
	},
	signal: {
		section: 'verse',
		shapeWeights: { ellipse: 0.2, lissajous: 0.52, ribbon: 0.22, rosette: 0.06 },
		tension: 0.27,
		release: 0.24,
		openness: 0.54,
		asymmetry: 0.27,
		signedAsymmetry: 0.1,
		impact: 0,
		ringOut: 0,
		sectionPulse: 0,
		tempo: 0.53,
		motion: 0.42,
		phrase: 0.25,
		phraseVariation: 0.56,
		spectrumTravel: 0,
		key: 2 / 12
	},
	spectrum: {
		sampleRate: 48_000,
		raw: { sub: 0.2, kick: 0.25, body: 0.3, mids: 0.32, presence: 0.22, air: 0.15 },
		fast: { sub: 0.2, kick: 0.25, body: 0.3, mids: 0.32, presence: 0.22, air: 0.15 },
		slow: { sub: 0.18, kick: 0.23, body: 0.28, mids: 0.3, presence: 0.2, air: 0.14 },
		levels: { sub: 0.4, kick: 0.48, body: 0.5, mids: 0.52, presence: 0.4, air: 0.3 },
		deltas: { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 },
		detailBins: [],
		novelty: 0,
		spectralMotion: 0.22,
		spectralDirection: 0.04,
		centroid: 0.46,
		centroidVelocity: 0,
		crestRatio: 2.1,
		crestFactor: 0.28,
		bass: 0.44,
		mid: 0.49,
		treble: 0.34
	}
};

test.describe('Mk2 macro conductor', () => {
	test('all rails remain finite and inside their public ranges', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor, MK2_CONDUCTOR_LIMITS } = await import(modulePath);
			const conductor = new Mk2Conductor('finite-rails');
			const sections = [
				'calm',
				'intro',
				'verse',
				'pre_chorus',
				'build',
				'drop',
				'chorus',
				'bridge',
				'breakdown',
				'outro'
			];
			const semantics: Record<string, [number, number, number, number]> = {
				calm: [0.08, 0.08, 0.34, 0.08],
				intro: [0.1, 0.16, 0.43, 0.17],
				verse: [0.27, 0.24, 0.54, 0.42],
				pre_chorus: [0.7, 0.12, 0.38, 0.68],
				build: [0.88, 0.06, 0.27, 0.82],
				drop: [0.28, 1, 0.94, 1],
				chorus: [0.34, 0.78, 0.86, 0.86],
				bridge: [0.24, 0.34, 0.61, 0.32],
				breakdown: [0.08, 0.28, 0.48, 0.15],
				outro: [0.04, 0.14, 0.38, 0.1]
			};
			const invalid: string[] = [];
			const outOfRange: string[] = [];
			let output: Record<string, number | string> = {};

			for (const section of sections) {
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				frame.section = section;
				signal.section = section;
				[signal.tension, signal.release, signal.openness, signal.motion] = semantics[section];
				frame.drop.buildActive = section === 'build' || section === 'pre_chorus';
				frame.drop.anticipation = frame.drop.buildActive ? 0.8 : 0;
				frame.context.energyLookahead = frame.drop.buildActive ? 0.82 : 0.48;
				for (let i = 0; i < 180; i += 1) {
					frame.context.sectionProgress = i / 179;
					frame.clock.phraseIndex = Math.floor(i / 90);
					output = { ...conductor.update(frame, signal, spectrum, 1 / 60) };
					for (const [name, value] of Object.entries(output)) {
						if (name !== 'section' && !Number.isFinite(value)) invalid.push(`${section}.${name}`);
					}
				}
			}

			// NaN inputs must degrade to safe fallbacks, not poison a persistent rail.
			const damagedFrame: any = structuredClone(fixtures.director);
			const damagedSignal: any = structuredClone(fixtures.signal);
			const damagedSpectrum: any = structuredClone(fixtures.spectrum);
			for (const key of ['energy', 'motion', 'bassPunch']) damagedFrame[key] = Number.NaN;
			for (const key of Object.keys(damagedFrame.clock)) damagedFrame.clock[key] = Number.NaN;
			for (const key of Object.keys(damagedFrame.drop)) damagedFrame.drop[key] = Number.NaN;
			for (const key of Object.keys(damagedFrame.context)) {
				if (typeof damagedFrame.context[key] === 'number') damagedFrame.context[key] = Number.NaN;
			}
			for (const key of ['tension', 'release', 'openness', 'impact', 'motion', 'key']) {
				damagedSignal[key] = Number.NaN;
			}
			for (const key of ['novelty', 'spectralMotion', 'spectralDirection', 'centroid', 'bass', 'treble']) {
				damagedSpectrum[key] = Number.NaN;
			}
			for (const group of ['levels', 'deltas']) {
				for (const key of Object.keys(damagedSpectrum[group])) damagedSpectrum[group][key] = Number.NaN;
			}
			output = { ...conductor.update(damagedFrame, damagedSignal, damagedSpectrum, Number.NaN) };
			for (const [name, value] of Object.entries(output)) {
				if (name !== 'section' && !Number.isFinite(value)) invalid.push(`damaged.${name}`);
			}

			for (const [name, range] of Object.entries(MK2_CONDUCTOR_LIMITS) as Array<
				[string, readonly [number, number]]
			>) {
				const outputName = name === 'rotationRateMagnitude' ? 'rotationRate' : name;
				const raw = Number(output[outputName]);
				const value = name === 'rotationRateMagnitude' ? Math.abs(raw) : raw;
				if (value < range[0] - 1e-9 || value > range[1] + 1e-9) {
					outOfRange.push(`${name}:${value}`);
				}
			}

			return { invalid: [...new Set(invalid)], outOfRange };
		}, FIXTURES);

		expect(result.invalid).toEqual([]);
		expect(result.outOfRange).toEqual([]);
	});

	test('30, 60, and 144 Hz converge on the same song journey', async ({ page }) => {
		await page.goto('/');
		const samples = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const run = (fps: number) => {
				const conductor = new Mk2Conductor('frame-rate-track');
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				const dt = 1 / fps;
				let output: any;
				for (let i = 0; i < 22 * fps; i += 1) {
					const time = (i + 1) * dt;
					if (time <= 6) {
						frame.section = signal.section = 'verse';
						frame.context.sectionProgress = time / 6;
						frame.context.energyCurrent = 0.46;
						frame.context.energyLookahead = 0.5;
						frame.context.energySlope = 0.01;
						frame.context.sectionEnergy = frame.energy = 0.48;
						frame.motion = 0.44;
						frame.drop.buildActive = false;
						frame.drop.buildProgress = frame.drop.anticipation = 0;
						Object.assign(signal, { tension: 0.27, release: 0.24, openness: 0.54, motion: 0.42 });
					} else if (time <= 14) {
						const progress = (time - 6) / 8;
						frame.section = signal.section = 'build';
						frame.context.sectionProgress = progress;
						frame.context.energyCurrent = 0.5 + progress * 0.12;
						frame.context.energyLookahead = 0.9;
						frame.context.energySlope = 0.18;
						frame.context.sectionEnergy = frame.energy = 0.62;
						frame.motion = 0.78;
						frame.drop.buildActive = true;
						frame.drop.buildProgress = progress;
						frame.drop.anticipation = 0.82;
						Object.assign(signal, { tension: 0.88, release: 0.06, openness: 0.27, motion: 0.82 });
					} else {
						const progress = (time - 14) / 8;
						frame.section = signal.section = 'drop';
						frame.context.sectionProgress = progress;
						frame.context.energyCurrent = frame.context.energyLookahead = 0.9;
						frame.context.energySlope = 0;
						frame.context.sectionEnergy = frame.energy = 0.9;
						frame.motion = 0.92;
						frame.drop.buildActive = false;
						frame.drop.buildProgress = frame.drop.anticipation = 0;
						Object.assign(signal, { tension: 0.28, release: 1, openness: 0.94, motion: 1 });
					}
					frame.clock.phraseIndex = Math.floor(time / 4);
					output = conductor.update(frame, signal, spectrum, dt);
				}
				return { ...output };
			};

			return { hz30: run(30), hz60: run(60), hz144: run(144) };
		}, FIXTURES);

		const slowRails = [
			'suspense',
			'growth',
			'tension',
			'release',
			'openness',
			'macroEnergy',
			'rotationRate',
			'cameraSpeed',
			'cameraDistance',
			'topologyBias',
			'fogDensity',
			'shaftIntensity',
			'backgroundFlow',
			'postureYaw',
			'posturePitch',
			'shotZoom',
			'closeStudy',
			'detailFocus',
			'perspectiveAzimuth',
			'perspectiveElevation',
			'shotFramingX',
			'shotFramingY',
			'seedForm',
			'sproutForm',
			'windingForm',
			'bloomForm',
			'sheddingForm',
			'dormancyForm',
			'morphRate',
			'rootMass',
			'axialStretch',
			'lobeSplit',
			'foldDepth',
			'cavityOpen',
			'surfaceRidges',
			'filamentReach',
			'spectralLean',
			'spectralTravelRate',
			'paletteWarmth',
			'materialDensity',
			'materialIridescence',
			'materialErosion'
		] as const;
		for (const key of slowRails) {
			expect(Math.abs(samples.hz30[key] - samples.hz144[key]), `30/144 ${key}`).toBeLessThan(
				0.012
			);
			expect(Math.abs(samples.hz60[key] - samples.hz144[key]), `60/144 ${key}`).toBeLessThan(
				0.006
			);
		}
		expect(Math.abs(samples.hz30.rotationPhase - samples.hz144.rotationPhase)).toBeLessThan(0.01);
		expect(Math.abs(samples.hz60.rotationPhase - samples.hz144.rotationPhase)).toBeLessThan(0.006);
		expect(Math.abs(samples.hz30.morphPhase - samples.hz144.morphPhase)).toBeLessThan(0.01);
		expect(Math.abs(samples.hz60.morphPhase - samples.hz144.morphPhase)).toBeLessThan(0.006);
		expect(
			Math.abs(samples.hz30.spectralTravelPhase - samples.hz144.spectralTravelPhase)
		).toBeLessThan(0.012);
		expect(Math.abs(samples.hz30.palettePhase - samples.hz144.palettePhase)).toBeLessThan(0.01);
	});

	test('verse winds into build, then opens and releases into drop', async ({ page }) => {
		await page.goto('/');
		const journey = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const conductor = new Mk2Conductor('journey-track');
			const frame: any = structuredClone(fixtures.director);
			const signal: any = structuredClone(fixtures.signal);
			const spectrum: any = structuredClone(fixtures.spectrum);
			const settle = (
				section: string,
				seconds: number,
				semantics: { tension: number; release: number; openness: number; motion: number },
				energy: number
			) => {
				frame.section = signal.section = section;
				Object.assign(signal, semantics);
				frame.context.sectionEnergy = frame.context.energyCurrent = frame.energy = energy;
				frame.context.energyLookahead = section === 'build' ? 0.94 : energy;
				frame.context.energySlope = section === 'build' ? 0.2 : 0;
				frame.drop.buildActive = section === 'build';
				frame.drop.anticipation = section === 'build' ? 0.9 : 0;
				frame.drop.buildProgress = section === 'build' ? 0.86 : 0;
				let output: any;
				for (let i = 0; i < seconds * 60; i += 1) {
					frame.context.sectionProgress = (i + 1) / (seconds * 60);
					output = conductor.update(frame, signal, spectrum, 1 / 60);
				}
				return { ...output };
			};

			const verse = settle('verse', 6, { tension: 0.27, release: 0.24, openness: 0.54, motion: 0.42 }, 0.48);
			const build = settle('build', 8, { tension: 0.88, release: 0.06, openness: 0.27, motion: 0.82 }, 0.64);
			const drop = settle('drop', 7, { tension: 0.28, release: 1, openness: 0.94, motion: 1 }, 0.92);
			return { verse, build, drop };
		}, FIXTURES);

		expect(journey.build.tension).toBeGreaterThan(journey.verse.tension + 0.28);
		expect(journey.build.openness).toBeLessThan(journey.verse.openness - 0.16);
		expect(journey.build.growth).toBeLessThan(journey.verse.growth);
		expect(journey.build.suspense).toBeGreaterThan(journey.verse.suspense + 0.45);
		expect(journey.build.cameraSpeed).toBeGreaterThan(journey.verse.cameraSpeed + 0.006);

		expect(journey.drop.growth).toBeGreaterThan(journey.build.growth + 0.25);
		expect(journey.drop.openness).toBeGreaterThan(journey.build.openness + 0.45);
		expect(journey.drop.release).toBeGreaterThan(journey.build.release + 0.6);
		expect(journey.drop.tension).toBeLessThan(journey.build.tension - 0.38);
		expect(journey.drop.macroEnergy).toBeGreaterThan(journey.build.macroEnergy + 0.2);
		expect(journey.drop.cameraDistance).toBeLessThan(journey.build.cameraDistance - 0.02);
		expect(journey.drop.shaftIntensity).toBeGreaterThan(journey.build.shaftIntensity + 0.1);
	});

	test('the song crosses distinct seed, sprout, winding, bloom, shedding, and dormant forms', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const conductor = new Mk2Conductor('full-lifecycle');
			const frame: any = structuredClone(fixtures.director);
			const signal: any = structuredClone(fixtures.signal);
			const spectrum: any = structuredClone(fixtures.spectrum);
			const settle = (section: string, seconds: number) => {
				frame.section = signal.section = section;
				frame.drop.buildActive = section === 'build';
				frame.drop.anticipation = section === 'build' ? 0.9 : 0;
				frame.context.energyLookahead = section === 'build' ? 0.92 : frame.energy;
				let output: any;
				for (let i = 0; i < seconds * 60; i += 1) {
					frame.context.sectionProgress = (i + 1) / (seconds * 60);
					output = conductor.update(frame, signal, spectrum, 1 / 60);
				}
				return { ...output };
			};
			const seed = { ...conductor.update(frame, signal, spectrum, 1 / 60) };
			const sprout = settle('verse', 9);
			const winding = settle('build', 9);
			const bloom = settle('drop', 9);
			const shedding = settle('bridge', 9);
			const dormant = settle('outro', 11);

			conductor.reset('boundary-crossfade');
			settle('verse', 7);
			const before = { ...conductor.update(frame, signal, spectrum, 1 / 60) };
			frame.section = signal.section = 'drop';
			frame.context.sectionProgress = 0;
			const after = { ...conductor.update(frame, signal, spectrum, 1 / 60) };
			const formNames = [
				'seedForm',
				'sproutForm',
				'windingForm',
				'bloomForm',
				'sheddingForm',
				'dormancyForm'
			];
			const sums = [seed, sprout, winding, bloom, shedding, dormant].map((sample) =>
				formNames.reduce((sum, name) => sum + sample[name], 0)
			);
			const boundaryDelta = Math.max(
				...formNames.map((name) => Math.abs(after[name] - before[name]))
			);
			return { seed, sprout, winding, bloom, shedding, dormant, sums, boundaryDelta };
		}, FIXTURES);

		expect(result.seed.seedForm).toBeGreaterThan(0.75);
		expect(result.sprout.sproutForm).toBeGreaterThan(0.5);
		expect(result.winding.windingForm).toBeGreaterThan(0.7);
		expect(result.bloom.bloomForm).toBeGreaterThan(0.8);
		expect(result.shedding.sheddingForm).toBeGreaterThan(0.58);
		expect(result.dormant.dormancyForm).toBeGreaterThan(0.68);
		for (const sum of result.sums) expect(sum).toBeCloseTo(1, 5);
		expect(result.boundaryDelta).toBeLessThan(0.012);
		expect(result.winding.foldDepth).toBeGreaterThan(result.sprout.foldDepth + 0.16);
		expect(result.bloom.lobeSplit).toBeGreaterThan(result.winding.lobeSplit + 0.2);
		expect(result.shedding.cavityOpen).toBeGreaterThan(result.bloom.cavityOpen + 0.3);
		expect(result.shedding.materialErosion).toBeGreaterThan(
			result.bloom.materialErosion + 0.3
		);
	});

	test('sub, body, mids, presence, and air control different anatomical scales', async ({ page }) => {
		await page.goto('/');
		const samples = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const run = (band?: string) => {
				const conductor = new Mk2Conductor('band-anatomy');
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				for (const name of Object.keys(spectrum.levels)) spectrum.levels[name] = 0.05;
				spectrum.bass = spectrum.mid = spectrum.treble = 0.05;
				if (band) spectrum.levels[band] = 1;
				if (band === 'sub') spectrum.bass = 1;
				if (band === 'mids') spectrum.mid = 1;
				if (band === 'air') spectrum.treble = 1;
				let output: any;
				for (let i = 0; i < 5 * 60; i += 1) {
					output = conductor.update(frame, signal, spectrum, 1 / 60);
				}
				return { ...output };
			};
			return {
				low: run(),
				sub: run('sub'),
				body: run('body'),
				mids: run('mids'),
				presence: run('presence'),
				air: run('air')
			};
		}, FIXTURES);

		expect(samples.sub.rootMass).toBeGreaterThan(samples.low.rootMass + 0.5);
		expect(samples.body.axialStretch).toBeGreaterThan(samples.low.axialStretch + 0.25);
		expect(samples.mids.foldDepth).toBeGreaterThan(samples.low.foldDepth + 0.2);
		expect(samples.mids.lobeSplit).toBeGreaterThan(samples.low.lobeSplit + 0.18);
		expect(samples.presence.surfaceRidges).toBeGreaterThan(
			samples.low.surfaceRidges + 0.42
		);
		expect(samples.air.filamentReach).toBeGreaterThan(samples.low.filamentReach + 0.48);
		expect(samples.presence.rootMass - samples.low.rootMass).toBeLessThan(0.03);
		expect(samples.sub.surfaceRidges - samples.low.surfaceRidges).toBeLessThan(0.03);
	});

	test('spectral travel and harmonic palette cross direction and hue wraps without snapping', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const conductor = new Mk2Conductor('continuous-travel');
			const frame: any = structuredClone(fixtures.director);
			const signal: any = structuredClone(fixtures.signal);
			const spectrum: any = structuredClone(fixtures.spectrum);
			spectrum.spectralMotion = 0.9;
			spectrum.spectralDirection = 1;
			frame.context.keyPitchClass = 11.8 / 12;
			signal.key = 11.8 / 12;
			let output: any;
			for (let i = 0; i < 7 * 60; i += 1) output = conductor.update(frame, signal, spectrum, 1 / 60);
			const forward = { ...output };
			const phaseBeforeReverse = output.spectralTravelPhase;
			spectrum.spectralDirection = -1;
			frame.context.keyPitchClass = 0.2 / 12;
			signal.key = 0.2 / 12;
			let maxPaletteStep = 0;
			let maxTravelStep = 0;
			let priorPalette = output.palettePhase;
			let priorTravel = output.spectralTravelPhase;
			for (let i = 0; i < 7 * 60; i += 1) {
				output = conductor.update(frame, signal, spectrum, 1 / 60);
				maxPaletteStep = Math.max(maxPaletteStep, Math.abs(output.palettePhase - priorPalette));
				maxTravelStep = Math.max(maxTravelStep, Math.abs(output.spectralTravelPhase - priorTravel));
				priorPalette = output.palettePhase;
				priorTravel = output.spectralTravelPhase;
			}
			return {
				forward,
				reverse: { ...output },
				phaseBeforeReverse,
				maxPaletteStep,
				maxTravelStep
			};
		}, FIXTURES);

		expect(result.forward.spectralLean).toBeGreaterThan(0.75);
		expect(result.forward.spectralTravelRate).toBeGreaterThan(0.1);
		expect(result.reverse.spectralLean).toBeLessThan(-0.75);
		expect(result.reverse.spectralTravelRate).toBeLessThan(-0.1);
		expect(result.reverse.spectralTravelPhase).toBeLessThan(result.phaseBeforeReverse);
		expect(result.maxTravelStep).toBeLessThan(0.003);
		expect(result.maxPaletteStep).toBeLessThan(0.002);
		expect(result.reverse.palettePhase).toBeGreaterThan(result.forward.palettePhase);
	});

	test('phrase-scale shot direction stays patient and reserves close studies for sustained detail', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const shotRails = [
				'shotZoom',
				'closeStudy',
				'detailFocus',
				'perspectiveAzimuth',
				'perspectiveElevation',
				'shotFramingX',
				'shotFramingY'
			];
			const runJourney = (detailed: boolean) => {
				const conductor = new Mk2Conductor('patient-shot-journey');
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				frame.section = signal.section = 'bridge';
				frame.context.sectionProgress = 0.68;
				frame.motion = 0.34;
				Object.assign(signal, { tension: 0.24, release: 0.35, openness: 0.61, motion: 0.32 });
				spectrum.levels.presence = spectrum.levels.air = detailed ? 1 : 0.03;
				spectrum.treble = detailed ? 1 : 0.03;
				spectrum.spectralMotion = detailed ? 0.92 : 0.03;
				const maxStep: Record<string, number> = Object.fromEntries(
					shotRails.map((name) => [name, 0])
				);
				const samples: any[] = [];
				let prior: any;
				for (let phrase = 0; phrase < 48; phrase += 1) {
					frame.clock.phraseIndex = phrase;
					for (let i = 0; i < 6 * 30; i += 1) {
						frame.clock.phrasePos = (i + 1) / (6 * 30);
						const output: any = conductor.update(frame, signal, spectrum, 1 / 30);
						if (prior) {
							for (const name of shotRails) {
								maxStep[name] = Math.max(maxStep[name], Math.abs(output[name] - prior[name]));
							}
						}
						prior = { ...output };
					}
					samples.push(prior);
				}
				return { samples, maxStep };
			};

			const runBeatComparison = () => {
				const control = new Mk2Conductor('beat-independent-camera');
				const hit = new Mk2Conductor('beat-independent-camera');
				const controlFrame: any = structuredClone(fixtures.director);
				const hitFrame: any = structuredClone(fixtures.director);
				const controlSignal: any = structuredClone(fixtures.signal);
				const hitSignal: any = structuredClone(fixtures.signal);
				const controlSpectrum: any = structuredClone(fixtures.spectrum);
				const hitSpectrum: any = structuredClone(fixtures.spectrum);
				controlFrame.clock.phraseIndex = hitFrame.clock.phraseIndex = 7;
				for (let i = 0; i < 20 * 60; i += 1) {
					control.update(controlFrame, controlSignal, controlSpectrum, 1 / 60);
					hit.update(hitFrame, hitSignal, hitSpectrum, 1 / 60);
				}
				hitFrame.clock.beatPulse = 1;
				hitFrame.bassPunch = 1;
				hitSignal.impact = 1;
				hitSpectrum.deltas.kick = 1;
				const quiet: any = control.update(controlFrame, controlSignal, controlSpectrum, 1 / 60);
				const beat: any = hit.update(hitFrame, hitSignal, hitSpectrum, 1 / 60);
				return Object.fromEntries(
					shotRails.map((name) => [name, Math.abs(quiet[name] - beat[name])])
				);
			};

			return {
				detailed: runJourney(true),
				flat: runJourney(false),
				beatDelta: runBeatComparison()
			};
		}, FIXTURES);

		const detailed = result.detailed.samples;
		const flat = result.flat.samples;
		const closePhrases = detailed.filter((sample: any) => sample.closeStudy > 0.5).length;
		const heroPhrases = detailed.filter((sample: any) => sample.shotZoom < 1.32).length;
		const max = (samples: any[], name: string) =>
			Math.max(...samples.map((sample: any) => sample[name]));
		expect(closePhrases).toBeGreaterThanOrEqual(2);
		expect(closePhrases).toBeLessThan(14);
		expect(heroPhrases).toBeGreaterThan(34);
		expect(max(detailed, 'shotZoom')).toBeGreaterThan(1.55);
		expect(max(detailed, 'closeStudy')).toBeGreaterThan(max(flat, 'closeStudy') + 0.12);
		expect(max(detailed, 'detailFocus')).toBeGreaterThan(max(flat, 'detailFocus') + 0.25);
		expect(result.detailed.maxStep.shotZoom).toBeLessThan(0.009);
		expect(result.detailed.maxStep.closeStudy).toBeLessThan(0.009);
		expect(result.detailed.maxStep.detailFocus).toBeLessThan(0.007);
		expect(result.detailed.maxStep.perspectiveAzimuth).toBeLessThan(0.004);
		expect(result.detailed.maxStep.perspectiveElevation).toBeLessThan(0.003);
		expect(result.detailed.maxStep.shotFramingX).toBeLessThan(0.002);
		expect(result.detailed.maxStep.shotFramingY).toBeLessThan(0.002);
		for (const delta of Object.values(result.beatDelta)) expect(delta).toBeLessThan(1e-9);
	});

	test('macro rails cannot snap while impact attacks quickly and releases cleanly', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const conductor = new Mk2Conductor('bounded-step');
			const frame: any = structuredClone(fixtures.director);
			const signal: any = structuredClone(fixtures.signal);
			const spectrum: any = structuredClone(fixtures.spectrum);
			for (let i = 0; i < 360; i += 1) conductor.update(frame, signal, spectrum, 1 / 60);
			const before = { ...conductor.update(frame, signal, spectrum, 1 / 60) };

			frame.section = signal.section = 'drop';
			frame.energy = frame.context.sectionEnergy = frame.context.energyCurrent = 1;
			frame.motion = 1;
			Object.assign(signal, { tension: 0.28, release: 1, openness: 0.94, motion: 1, impact: 1 });
			Object.assign(spectrum.deltas, { kick: 1, body: 1 });
			spectrum.novelty = spectrum.spectralMotion = 1;
			frame.clock.beatPulse = 1;
			frame.bassPunch = 1;
			const hit = { ...conductor.update(frame, signal, spectrum, 1 / 60) };

			signal.impact = 0;
			Object.assign(spectrum.deltas, { kick: 0, body: 0 });
			spectrum.novelty = 0;
			frame.clock.beatPulse = 0;
			frame.bassPunch = 0;
			let released: any;
			for (let i = 0; i < 18; i += 1) {
				released = conductor.update(frame, signal, spectrum, 1 / 60);
			}
			return { before, hit, released: { ...released } };
		}, FIXTURES);

		const delta = (key: keyof typeof result.hit) =>
			Math.abs(Number(result.hit[key]) - Number(result.before[key]));
		expect(delta('growth')).toBeLessThan(0.012);
		expect(delta('tension')).toBeLessThan(0.018);
		expect(delta('release')).toBeLessThan(0.018);
		expect(delta('openness')).toBeLessThan(0.015);
		expect(delta('macroEnergy')).toBeLessThan(0.018);
		expect(delta('rotationRate')).toBeLessThan(0.001);
		expect(delta('cameraSpeed')).toBeLessThan(0.001);
		expect(delta('cameraDistance')).toBeLessThan(0.001);
		expect(delta('topologyBias')).toBeLessThan(0.008);
		expect(delta('fogDensity')).toBeLessThan(0.002);
		expect(delta('shaftIntensity')).toBeLessThan(0.012);
		expect(delta('backgroundFlow')).toBeLessThan(0.002);
		expect(delta('shotZoom')).toBeLessThan(0.006);
		expect(delta('closeStudy')).toBeLessThan(0.006);
		expect(delta('detailFocus')).toBeLessThan(0.006);
		expect(delta('perspectiveAzimuth')).toBeLessThan(0.003);
		expect(delta('perspectiveElevation')).toBeLessThan(0.003);
		expect(delta('shotFramingX')).toBeLessThan(0.002);
		expect(delta('shotFramingY')).toBeLessThan(0.002);
		expect(delta('seedForm')).toBeLessThan(0.012);
		expect(delta('sproutForm')).toBeLessThan(0.012);
		expect(delta('windingForm')).toBeLessThan(0.012);
		expect(delta('bloomForm')).toBeLessThan(0.012);
		expect(delta('sheddingForm')).toBeLessThan(0.012);
		expect(delta('dormancyForm')).toBeLessThan(0.012);
		expect(delta('axialStretch')).toBeLessThan(0.018);
		expect(delta('lobeSplit')).toBeLessThan(0.018);
		expect(delta('foldDepth')).toBeLessThan(0.02);
		expect(delta('cavityOpen')).toBeLessThan(0.012);
		expect(delta('materialDensity')).toBeLessThan(0.012);
		expect(delta('materialErosion')).toBeLessThan(0.012);
		expect(result.hit.impact).toBeGreaterThan(0.4);
		expect(result.hit.rootPulse).toBeGreaterThan(0.4);
		expect(result.hit.impact).toBeLessThanOrEqual(0.78);
		expect(result.released.impact).toBeGreaterThan(result.hit.impact * 0.3);
		expect(result.released.impact).toBeLessThan(result.hit.impact * 0.42);
	});

	test('reset is deterministic and rotation remains continuous beyond one turn', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor } = await import(modulePath);
			const conductor = new Mk2Conductor('repeatable-track');
			const run = () => {
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				let output: any;
				for (let i = 0; i < 720; i += 1) {
					const t = i / 60;
					frame.clock.phraseIndex = Math.floor(t / 3);
					frame.context.sectionProgress = (t % 3) / 3;
					frame.context.keyPitchClass = ((Math.floor(t / 4) * 5) % 12) / 12;
					frame.context.energyCurrent = 0.48 + Math.sin(t * 0.3) * 0.08;
					frame.context.energyLookahead = frame.context.energyCurrent + Math.max(0, Math.sin(t * 0.2)) * 0.15;
					spectrum.spectralDirection = Math.sin(t * 0.47) * 0.35;
					spectrum.spectralMotion = 0.18 + Math.abs(Math.sin(t * 0.31)) * 0.25;
					output = conductor.update(frame, signal, spectrum, 1 / 60);
				}
				return { ...output };
			};

			const first = run();
			conductor.reset('repeatable-track');
			const second = run();
			const direction = Math.sign(second.rotationRate);
			const frame: any = structuredClone(fixtures.director);
			const signal: any = structuredClone(fixtures.signal);
			const spectrum: any = structuredClone(fixtures.spectrum);
			let reversed = false;
			let longRun: any;
			for (let i = 0; i < 180 * 30; i += 1) {
				longRun = conductor.update(frame, signal, spectrum, 1 / 30);
				reversed ||= Math.sign(longRun.rotationRate) !== direction;
			}
			return { first, second, longRun: { ...longRun }, reversed };
		}, FIXTURES);

		expect(result.second).toEqual(result.first);
		expect(result.reversed).toBe(false);
		expect(Math.abs(result.longRun.rotationPhase)).toBeGreaterThan(2.5);
		expect(Math.abs(result.longRun.rotationRate)).toBeGreaterThanOrEqual(0.006);
		expect(Math.abs(result.longRun.rotationRate)).toBeLessThanOrEqual(0.052);
	});

	test('tempo gently changes camera flow and phrase palette motion wraps continuously', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const modulePath = '/src/lib/visualizer/mk2/conductor.ts';
			const { Mk2Conductor, mk2ContinuousPaletteBlend } = await import(modulePath);
			const runTempo = (bpm: number) => {
				const conductor = new Mk2Conductor('tempo-camera');
				const frame: any = structuredClone(fixtures.director);
				const signal: any = structuredClone(fixtures.signal);
				const spectrum: any = structuredClone(fixtures.spectrum);
				frame.clock.tempoBpm = bpm;
				signal.tempo = (bpm - 60) / 120;
				let output: any;
				for (let i = 0; i < 12 * 60; i += 1) {
					output = conductor.update(frame, signal, spectrum, 1 / 60);
				}
				return output.cameraSpeed;
			};

			return {
				slow: runTempo(60),
				fast: runTempo(180),
				paletteBeforeWrap: mk2ContinuousPaletteBlend(0.999_999),
				paletteAfterWrap: mk2ContinuousPaletteBlend(0.000_001)
			};
		}, FIXTURES);

		expect(result.fast).toBeGreaterThan(result.slow + 0.0025);
		expect(Math.abs(result.paletteBeforeWrap - result.paletteAfterWrap)).toBeLessThan(0.00001);
	});

});
