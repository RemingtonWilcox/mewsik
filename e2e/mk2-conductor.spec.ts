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
			'posturePitch'
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
		expect(result.hit.impact).toBeGreaterThan(0.4);
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
		expect(Math.abs(result.longRun.rotationPhase)).toBeGreaterThan(Math.PI * 2);
		expect(Math.abs(result.longRun.rotationRate)).toBeGreaterThanOrEqual(0.02);
		expect(Math.abs(result.longRun.rotationRate)).toBeLessThanOrEqual(0.12);
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
