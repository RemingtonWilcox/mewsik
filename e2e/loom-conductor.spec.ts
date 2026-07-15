import { expect, test } from '@playwright/test';

const FIXTURES = {
	director: {
		section: 'verse',
		sectionAge: 0,
		motif: 'ribbon',
		motifIndex: 3,
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
		flatness: 0.18,
		bass: 0.44,
		mid: 0.49,
		treble: 0.34
	}
};

test.describe('Loom harmony conductor', () => {
	test('section grammar and phrase variation are normalized and deterministic', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const {
				fillLoomPhraseVariation,
				getLoomSectionProfile,
				normalizeLoomTopologyWeightArray
			} = await import('/src/lib/visualizer/loom/conductor.ts');
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
			] as const;
			const profiles = Object.fromEntries(
				sections.map((section) => {
					const profile = getLoomSectionProfile(section);
					const weights = Object.values(profile.topologyWeights);
					return [section, { sum: weights.reduce((sum, value) => sum + value, 0), ...profile }];
				})
			);
			const first = fillLoomPhraseVariation(new Float32Array(5), 'woven-track', 7);
			const repeated = fillLoomPhraseVariation(new Float32Array(5), 'woven-track', 7);
			const next = fillLoomPhraseVariation(new Float32Array(5), 'woven-track', 8);
			const other = fillLoomPhraseVariation(new Float32Array(5), 'other-track', 7);
			const fallback = normalizeLoomTopologyWeightArray(
				new Float32Array([Number.NaN, -1, 0, 0, 0])
			);
			return {
				profiles,
				first: Array.from(first),
				repeated: Array.from(repeated),
				next: Array.from(next),
				other: Array.from(other),
				fallback: Array.from(fallback),
				biasSum: Array.from(first).reduce((sum, value) => sum + value, 0)
			};
		});

		for (const profile of Object.values(result.profiles)) {
			expect(profile.sum).toBeCloseTo(1, 7);
		}
		expect(result.profiles.calm.topologyWeights.torus).toBeGreaterThan(0.5);
		expect(result.profiles.build.topologyWeights.knot).toBeGreaterThan(0.35);
		expect(result.profiles.bridge.topologyWeights.saddle).toBeGreaterThan(0.4);
		expect(result.profiles.drop.dropOpenness).toBe(1);
		expect(result.first).toEqual(result.repeated);
		expect(result.next).not.toEqual(result.first);
		expect(result.other).not.toEqual(result.first);
		expect(result.biasSum).toBeCloseTo(0, 6);
		expect(result.fallback).toEqual([1, 0, 0, 0, 0]);
	});

	test('returns stable allocation-light objects with finite bounded rails', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomConductor, LOOM_CONDUCTOR_LIMITS } = await import(
				'/src/lib/visualizer/loom/conductor.ts'
			);
			const conductor = new LoomConductor('bounded-loom');
			const frame: any = structuredClone(fixtures.director);
			const spectrum: any = structuredClone(fixtures.spectrum);
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
			let first: any;
			let second: any;
			for (const section of sections) {
				frame.section = section;
				frame.clock.phraseIndex += 1;
				for (let i = 0; i < 120; i += 1) {
					frame.clock.phrasePos = i / 119;
					second = conductor.update(frame, spectrum, 1 / 60);
					if (!first) first = second;
				}
			}
			const sameFrame = first === second;
			const sameTopology = first.topologyWeights === second.topologyWeights;
			const sameBands = first.strandEnergy === second.strandEnergy;

			for (const key of ['energy', 'motion', 'arousal', 'bassPunch']) frame[key] = Number.NaN;
			for (const key of Object.keys(frame.clock)) frame.clock[key] = Number.NaN;
			for (const key of Object.keys(frame.drop)) frame.drop[key] = Number.NaN;
			for (const key of Object.keys(frame.context)) {
				if (typeof frame.context[key] === 'number') frame.context[key] = Number.NaN;
			}
			frame.tonnetz = frame.tonnetz.map(() => Number.NaN);
			for (const key of ['novelty', 'spectralMotion', 'spectralDirection', 'centroidVelocity']) {
				spectrum[key] = Number.NaN;
			}
			for (const group of ['levels', 'deltas']) {
				for (const key of Object.keys(spectrum[group])) spectrum[group][key] = Number.NaN;
			}
			const output: any = conductor.update(frame, spectrum, Number.NaN);
			const invalid: string[] = [];
			for (const [key, value] of Object.entries(output)) {
				if (typeof value === 'number' && !Number.isFinite(value)) invalid.push(key);
			}
			for (const [group, values] of [
				['topologyWeights', output.topologyWeights],
				['strandEnergy', output.strandEnergy]
			] as const) {
				for (const [key, value] of Object.entries(values)) {
					if (!Number.isFinite(value)) invalid.push(`${group}.${key}`);
				}
			}
			const outOfRange: string[] = [];
			for (const [key, range] of Object.entries(LOOM_CONDUCTOR_LIMITS) as Array<
				[string, readonly [number, number]]
			>) {
				const value = Number(output[key]);
				if (value < range[0] - 1e-9 || value > range[1] + 1e-9) {
					outOfRange.push(`${key}:${value}`);
				}
			}
			const topologySum = Object.values(output.topologyWeights).reduce(
				(sum: number, value) => sum + Number(value),
				0
			);
			const nestedOutOfRange = [...Object.values(output.topologyWeights), ...Object.values(output.strandEnergy)].filter(
				(value) => Number(value) < -1e-9 || Number(value) > 1 + 1e-9
			).length;
			return {
				sameFrame,
				sameTopology,
				sameBands,
				invalid,
				outOfRange,
				topologySum,
				nestedOutOfRange
			};
		}, FIXTURES);

		expect(result.sameFrame).toBe(true);
		expect(result.sameTopology).toBe(true);
		expect(result.sameBands).toBe(true);
		expect(result.invalid).toEqual([]);
		expect(result.outOfRange).toEqual([]);
		expect(result.topologySum).toBeCloseTo(1, 5);
		expect(result.nestedOutOfRange).toBe(0);
	});

	test('phrase boundaries reweave while beat-only changes cannot reshuffle topology', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomConductor } = await import('/src/lib/visualizer/loom/conductor.ts');
			const control = new LoomConductor('phrase-scale');
			const beatOnly = new LoomConductor('phrase-scale');
			const controlFrame: any = structuredClone(fixtures.director);
			const beatFrame: any = structuredClone(fixtures.director);
			const spectrum: any = structuredClone(fixtures.spectrum);
			for (let i = 0; i < 360; i += 1) {
				control.update(controlFrame, spectrum, 1 / 60);
				beatOnly.update(beatFrame, spectrum, 1 / 60);
			}
			beatFrame.clock.beatPulse = 1;
			beatFrame.clock.beatPhase = 0.01;
			beatFrame.clock.downbeatFlag = true;
			const controlBeat = { ...control.update(controlFrame, spectrum, 1 / 60) };
			const changedBeat = { ...beatOnly.update(beatFrame, spectrum, 1 / 60) };
			const beatTopology = { ...changedBeat.topologyWeights };
			const controlTopology = { ...controlBeat.topologyWeights };

			beatFrame.clock.phraseIndex = 1;
			beatFrame.clock.phrasePos = 0;
			const phraseHit = beatOnly.update(beatFrame, spectrum, 1 / 60);
			const phraseStart = {
				reweave: phraseHit.reweave,
				variation: phraseHit.phraseVariation,
				weights: { ...phraseHit.topologyWeights },
				crossing: phraseHit.crossingOrder
			};
			let phraseSettled: any;
			for (let i = 0; i < 240; i += 1) {
				beatFrame.clock.phrasePos = i / 239;
				phraseSettled = beatOnly.update(beatFrame, spectrum, 1 / 60);
			}

			beatFrame.section = 'bridge';
			const sectionHit = beatOnly.update(beatFrame, spectrum, 1 / 60);
			return {
				beatEqual: JSON.stringify(beatTopology) === JSON.stringify(controlTopology),
				beatCrossingDelta: Math.abs(changedBeat.crossingOrder - controlBeat.crossingOrder),
				phraseStart,
				phraseSettled: {
					reweave: phraseSettled.reweave,
					weights: { ...phraseSettled.topologyWeights },
					crossing: phraseSettled.crossingOrder
				},
				originalVariation: controlBeat.phraseVariation,
				sectionPulse: sectionHit.sectionPulse
			};
		}, FIXTURES);

		expect(result.beatEqual).toBe(true);
		expect(result.beatCrossingDelta).toBeLessThan(1e-12);
		expect(result.phraseStart.reweave).toBeGreaterThan(0.98);
		expect(result.phraseStart.variation).not.toBe(result.originalVariation);
		expect(result.phraseSettled.reweave).toBeLessThan(result.phraseStart.reweave * 0.22);
		expect(result.phraseSettled.weights).not.toEqual(result.phraseStart.weights);
		expect(Math.abs(result.phraseSettled.crossing - result.phraseStart.crossing)).toBeGreaterThan(0.03);
		expect(result.sectionPulse).toBeGreaterThan(0.97);
	});

	test('each frequency band owns its strand rail and drops unfold the weave', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomConductor } = await import('/src/lib/visualizer/loom/conductor.ts');
			const bandNames = ['sub', 'kick', 'body', 'mids', 'presence', 'air'];
			const bandRuns: Record<string, Record<string, number>> = {};
			for (const band of bandNames) {
				const conductor = new LoomConductor(`band-${band}`);
				const frame: any = structuredClone(fixtures.director);
				const spectrum: any = structuredClone(fixtures.spectrum);
				for (const name of bandNames) {
					spectrum.levels[name] = 0.08;
					spectrum.deltas[name] = 0;
				}
				for (let i = 0; i < 120; i += 1) conductor.update(frame, spectrum, 1 / 60);
				spectrum.levels[band] = 1;
				spectrum.deltas[band] = 0.75;
				let output: any;
				for (let i = 0; i < 15; i += 1) output = conductor.update(frame, spectrum, 1 / 60);
				bandRuns[band] = { ...output.strandEnergy };
			}

			const settleSection = (section: 'build' | 'drop') => {
				const conductor = new LoomConductor(`section-${section}`);
				const frame: any = structuredClone(fixtures.director);
				const spectrum: any = structuredClone(fixtures.spectrum);
				frame.section = section;
				frame.drop.buildActive = section === 'build';
				frame.drop.buildProgress = frame.drop.anticipation = section === 'build' ? 0.9 : 0;
				frame.context.sectionEnergy = frame.context.energyCurrent = section === 'drop' ? 0.92 : 0.66;
				frame.context.energyLookahead = section === 'build' ? 0.94 : 0.92;
				frame.context.energySlope = section === 'build' ? 0.2 : 0;
				let output: any;
				for (let i = 0; i < 600; i += 1) output = conductor.update(frame, spectrum, 1 / 60);
				return {
					dropOpenness: output.dropOpenness,
					openness: output.openness,
					cameraDistance: output.cameraDistance
				};
			};

			const impactConductor = new LoomConductor('kick-impact');
			const impactFrame: any = structuredClone(fixtures.director);
			const impactSpectrum: any = structuredClone(fixtures.spectrum);
			for (let i = 0; i < 120; i += 1) impactConductor.update(impactFrame, impactSpectrum, 1 / 60);
			impactSpectrum.deltas.kick = 1;
			const hit = impactConductor.update(impactFrame, impactSpectrum, 1 / 60);

			return { bandRuns, build: settleSection('build'), drop: settleSection('drop'), impact: hit.impact };
		}, FIXTURES);

		for (const [band, energies] of Object.entries(result.bandRuns)) {
			const selected = energies[band];
			const others = Object.entries(energies)
				.filter(([name]) => name !== band)
				.map(([, value]) => value);
			expect(selected).toBeGreaterThan(Math.max(...others) + 0.35);
		}
		expect(result.drop.dropOpenness).toBeGreaterThan(result.build.dropOpenness + 0.7);
		expect(result.drop.openness).toBeGreaterThan(result.build.openness + 0.45);
		expect(result.drop.cameraDistance).toBeLessThan(result.build.cameraDistance - 0.65);
		expect(result.impact).toBeGreaterThan(0.55);
	});

	test('seeded journeys reset exactly and remain frame-rate stable', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomConductor } = await import('/src/lib/visualizer/loom/conductor.ts');
			const run = (conductor: any, fps: number) => {
				const frame: any = structuredClone(fixtures.director);
				const spectrum: any = structuredClone(fixtures.spectrum);
				const dt = 1 / fps;
				let output: any;
				for (let i = 0; i < 18 * fps; i += 1) {
					const time = (i + 1) * dt;
					frame.clock.phraseIndex = Math.floor(time / 4);
					frame.clock.phrasePos = (time % 4) / 4;
					if (time <= 6) {
						frame.section = 'verse';
						frame.drop.anticipation = frame.drop.buildProgress = 0;
						frame.context.energyCurrent = 0.48;
						frame.context.energyLookahead = 0.5;
					} else if (time <= 12) {
						const progress = (time - 6) / 6;
						frame.section = 'build';
						frame.drop.anticipation = 0.82;
						frame.drop.buildProgress = progress;
						frame.context.energyCurrent = 0.5 + progress * 0.14;
						frame.context.energyLookahead = 0.92;
						frame.context.energySlope = 0.18;
					} else {
						frame.section = 'drop';
						frame.drop.anticipation = frame.drop.buildProgress = 0;
						frame.context.energyCurrent = frame.context.energyLookahead = 0.92;
						frame.context.energySlope = 0;
					}
					spectrum.spectralDirection = Math.sin(time * 0.37) * 0.3;
					spectrum.spectralMotion = 0.2 + Math.abs(Math.sin(time * 0.23)) * 0.28;
					output = conductor.update(frame, spectrum, dt);
				}
				return {
					weights: { ...output.topologyWeights },
					tension: output.tension,
					release: output.release,
					openness: output.openness,
					dropOpenness: output.dropOpenness,
					crossingOrder: output.crossingOrder,
					topologyPhase: output.topologyPhase,
					weavePhase: output.weavePhase,
					longPhase: output.longPhase,
					cameraYaw: output.cameraYaw,
					cameraPitch: output.cameraPitch,
					cameraDistance: output.cameraDistance
				};
			};

			const reusable = new LoomConductor('repeatable-weave');
			const first = run(reusable, 60);
			reusable.reset('repeatable-weave');
			const repeated = run(reusable, 60);
			return {
				first,
				repeated,
				at30: run(new LoomConductor('repeatable-weave'), 30),
				at144: run(new LoomConductor('repeatable-weave'), 144)
			};
		}, FIXTURES);

		expect(result.repeated).toEqual(result.first);
		for (const sample of [result.at30, result.at144]) {
			for (const key of [
				'tension',
				'release',
				'openness',
				'dropOpenness',
				'crossingOrder',
				'cameraYaw',
				'cameraPitch',
				'cameraDistance'
			] as const) {
				expect(Math.abs(sample[key] - result.first[key]), key).toBeLessThan(0.012);
			}
			for (const key of ['topologyPhase', 'weavePhase', 'longPhase'] as const) {
				expect(Math.abs(sample[key] - result.first[key]), key).toBeLessThan(0.018);
			}
			for (const topology of Object.keys(result.first.weights) as Array<keyof typeof result.first.weights>) {
				expect(Math.abs(sample.weights[topology] - result.first.weights[topology])).toBeLessThan(0.004);
			}
		}
		expect(result.first.topologyPhase).toBeGreaterThan(Math.PI * 2);
		expect(result.first.weavePhase).toBeGreaterThan(Math.PI * 2);
	});
});
