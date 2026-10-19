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
	test('the long-listen look genome is huge, deterministic and keeps moving', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomConductor } = await import('/src/lib/visualizer/loom/conductor.ts');
			const look = await import('/src/lib/visualizer/loom/look.ts');
			const sections = ['intro', 'verse', 'pre_chorus', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			const run = (seed: string, phrases: number, live = false) => {
				const conductor = new LoomConductor(seed);
				const frame: any = structuredClone(fixtures.director);
				const spectrum: any = structuredClone(fixtures.spectrum);
				frame.context.source = live ? 'live' : 'score';
				const triples: string[] = [];
				const trace: string[] = [];
				let maxStepJump = 0;
				let previousHero: number[] | null = null;
				let invalid = 0;
				let sectionIndex = 0;
				let phrasesLeft = 0;
				for (let phrase = 0; phrase < phrases; phrase += 1) {
					if (!live && phrasesLeft <= 0) {
						sectionIndex += 1;
						// Sections last 3..8 phrases, like real songs.
						phrasesLeft = 3 + ((sectionIndex * 7) % 6);
						frame.section = sections[sectionIndex % sections.length];
					}
					phrasesLeft -= 1;
					if (live) frame.section = 'verse';
					frame.clock.phraseIndex = phrase;
					frame.context.sectionEnergy = 0.35 + 0.5 * Math.abs(Math.sin(phrase * 0.31));
					for (let i = 0; i < 40; i += 1) {
						frame.clock.phrasePos = i / 40;
						const out: any = conductor.update(frame, spectrum, 1 / 8);
						const hero = [...out.look.hero];
						if (previousHero) {
							for (let c = 0; c < 3; c += 1) maxStepJump = Math.max(maxStepJump, Math.abs(hero[c] - previousHero[c]));
						}
						previousHero = hero;
					}
					const l: any = conductor.update(frame, spectrum, 1 / 8).look;
					for (const value of Object.values(l)) {
						if (typeof value === 'number' && !Number.isFinite(value)) invalid += 1;
					}
					triples.push(`${l.paletteIndex}/${l.grammarTo}/${l.cameraIndex}`);
					trace.push(`${l.names.grammar}|${l.names.palette}|${l.names.camera}|${l.names.material}|${l.names.environment}|${l.names.beatForm}`);
				}
				return { triples, trace, maxStepJump, invalid };
			};
			const a = run('look-a', 300);
			const a2 = run('look-a', 300);
			const b = run('look-b', 300);
			const live = run('radio-night', 300, true);

			// Beats and band hits alone never move the look.
			const steady = new LoomConductor('steady-look');
			const frame: any = structuredClone(fixtures.director);
			const spectrum: any = structuredClone(fixtures.spectrum);
			for (let i = 0; i < 120; i += 1) steady.update(frame, spectrum, 1 / 60);
			const before = JSON.stringify(steady.update(frame, spectrum, 1 / 60).look.names);
			const beforeGrammar = steady.update(frame, spectrum, 1 / 60).look.grammarTo;
			for (let i = 0; i < 600; i += 1) {
				frame.clock.beatPhase = (i % 30) / 30;
				frame.clock.beatPulse = i % 30 === 0 ? 1 : 0;
				spectrum.deltas.kick = i % 30 === 0 ? 1 : 0;
				steady.update(frame, spectrum, 1 / 60);
			}
			const after = steady.update(frame, spectrum, 1 / 60).look;

			const distinct = (list: string[]) => new Set(list).size;
			const field = (trace: string[], index: number) => new Set(trace.map((t) => t.split('|')[index])).size;
			return {
				space: look.LOOM_LOOK_SPACE_SIZE,
				deterministic: JSON.stringify(a.trace) === JSON.stringify(a2.trace),
				seedsDiffer: a.trace.filter((t, i) => t !== b.trace[i]).length,
				triples: distinct(a.triples),
				liveTriples: distinct(live.triples),
				grammars: field(a.trace, 0),
				palettes: field(a.trace, 1),
				cameras: field(a.trace, 2),
				materials: field(a.trace, 3),
				environments: field(a.trace, 4),
				beatForms: field(a.trace, 5),
				liveGrammars: field(live.trace, 0),
				livePalettes: field(live.trace, 1),
				maxStepJump: a.maxStepJump,
				invalid: a.invalid + live.invalid,
				beatStable: before === JSON.stringify(after.names) && beforeGrammar === after.grammarTo,
				// Longest run of identical (palette, grammar, camera) phrases.
				longestHold: a.triples.reduce(
					(acc: { run: number; max: number; last: string }, t: string) => {
						const runLength = t === acc.last ? acc.run + 1 : 1;
						return { run: runLength, max: Math.max(acc.max, runLength), last: t };
					},
					{ run: 0, max: 0, last: '' }
				).max,
				grammarCount: look.LOOM_GRAMMARS.length,
				paletteCount: look.LOOM_PALETTES.length
			};
		}, FIXTURES);

		expect(result.space).toBeGreaterThan(1_000_000);
		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(250);
		// 300 phrases (about 75 minutes at 128 bpm) visit many distinct scenes.
		expect(result.triples).toBeGreaterThanOrEqual(40);
		expect(result.liveTriples).toBeGreaterThanOrEqual(40);
		expect(result.grammars).toBe(result.grammarCount);
		expect(result.palettes).toBeGreaterThan(24);
		expect(result.cameras).toBe(7);
		expect(result.materials).toBe(7);
		expect(result.environments).toBe(6);
		expect(result.beatForms).toBe(5);
		expect(result.liveGrammars).toBeGreaterThanOrEqual(10);
		expect(result.livePalettes).toBeGreaterThanOrEqual(15);
		// Colour glides: at 8 updates per second no colour channel jumps.
		expect(result.maxStepJump).toBeLessThan(0.2);
		expect(result.invalid).toBe(0);
		expect(result.beatStable).toBe(true);
		// No scene holds for more than eight phrases (two minutes at 128 bpm).
		expect(result.longestHold).toBeLessThanOrEqual(8);
	});

	test('the light budget normalises every look and keeps the hierarchy', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/loom/look.ts');
			const exposure = await import('/src/lib/visualizer/loom/exposure.ts');
			const linear = (hex: string) => {
				const v = Number.parseInt(hex.slice(1), 16);
				return [16, 8, 0].map((shift) => Math.pow(((v >> shift) & 0xff) / 255, 2.2)) as [number, number, number];
			};
			const out = exposure.createLoomExposure();
			let invalid = 0;
			let hierarchyBroken = 0;
			const raw: number[] = [];
			const normalised: number[] = [];
			const env = { mist: 0.3, threads: 1, dust: 0.4, reflect: 1 };
			for (const family of look.LOOM_PALETTES) {
				for (const material of look.LOOM_MATERIALS) {
					for (const grammar of look.LOOM_GRAMMARS) {
						for (const tone of look.LOOM_TONES) {
							const input = {
								hero: linear(family.hero),
								support: linear(family.support),
								weft: linear(family.weft),
								haze: linear(family.haze),
								glow: linear(family.glow),
								material,
								density: grammar.density,
								strandCount: grammar.strands[1],
								tone,
								env
							};
							exposure.resolveLoomExposure(input, out);
							for (const value of Object.values(out)) if (!Number.isFinite(value)) invalid += 1;
							const heroValue = exposure.loomColourIntensity(input.hero) * out.heroGain;
							const supportValue = exposure.loomColourIntensity(input.support) * out.supportGain;
							if (supportValue > heroValue + 1e-6) hierarchyBroken += 1;
							if (tone.name !== 'glow') continue;
							// Fibre light at rest: colour x material, before and after the budget.
							const materialLight = exposure.loomMaterialLight(material);
							const colour = exposure.loomColourIntensity(input.hero);
							raw.push(colour * materialLight * (1 + grammar.density));
							normalised.push(
								colour * out.heroGain * materialLight * out.litGain * (1 + grammar.density * out.chorusGlow)
							);
						}
					}
				}
			}
			const spread = (list: number[]) => Math.max(...list) / Math.min(...list);
			const at = (density: number, strands: number, tone = look.LOOM_TONES[0]) =>
				({
					...exposure.resolveLoomExposure(
						{
							hero: [1, 0.3, 0.05],
							support: [0.2, 0.4, 1],
							weft: [1, 0.9, 0.3],
							haze: [0.08, 0.03, 0.12],
							glow: [1, 0.4, 0.2],
							material: look.LOOM_MATERIALS[0],
							density,
							strandCount: strands,
							tone,
							env
						},
						exposure.createLoomExposure()
					)
				}) as Record<string, number>;
			const sparse = at(0.35, 0.2);
			const dense = at(0.95, 1);
			const ink = at(0.5, 0.5, look.LOOM_TONES.find((t) => t.name === 'ink'));
			const glow = at(0.5, 0.5);
			return {
				invalid,
				hierarchyBroken,
				rawSpread: spread(raw),
				normalisedSpread: spread(normalised),
				denser: {
					chorusWidth: dense.chorusWidth < sparse.chorusWidth,
					chorusGlow: dense.chorusGlow < sparse.chorusGlow,
					trail: dense.trailOffset < sparse.trailOffset,
					bloom: dense.bloomWeight < sparse.bloomWeight,
					knee: dense.bloomThresholdOffset > sparse.bloomThresholdOffset
				},
				inkBloom: ink.bloomWeight < glow.bloomWeight * 0.3,
				bounded: [sparse, dense, ink, glow].every(
					(o) => o.bloomWeight <= 0.7 && o.litGain <= 1.12 && o.heroGain <= 1.25 && o.trailOffset <= 0.02
				)
			};
		});
		expect(result.invalid).toBe(0);
		expect(result.hierarchyBroken).toBe(0);
		// Raw looks differ by more than 4x in fibre light; the budget holds them
		// within about 2x of each other.
		expect(result.rawSpread).toBeGreaterThan(4);
		expect(result.normalisedSpread).toBeLessThan(result.rawSpread * 0.5);
		expect(result.normalisedSpread).toBeLessThan(2.4);
		expect(result.denser).toEqual({ chorusWidth: true, chorusGlow: true, trail: true, bloom: true, knee: true });
		expect(result.inkBloom).toBe(true);
		expect(result.bounded).toBe(true);
	});

	test('choice morphs never snap, even when targets arrive mid-morph', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { LoomChoiceMorph } = await import('/src/lib/visualizer/loom/look.ts');
			// Options sit on a line; a snap shows as a large step of the blend.
			const values = [0, 10, -7, 4, 13, -2];
			const morph = new LoomChoiceMorph(3);
			const dt = 1 / 60;
			let value = 0;
			let maxStep = 0;
			let target = 0;
			const targets: number[] = [];
			for (let frame = 0; frame < 60 * 120; frame += 1) {
				// Retarget at irregular, often very short intervals.
				if (frame % 37 === 0 || frame % 101 === 0) target = (target + 1 + (frame % 4)) % values.length;
				targets.push(target);
				const view = morph.update(target, dt);
				const next = values[view.from] + (values[view.to] - values[view.from]) * view.mix;
				if (frame > 0) maxStep = Math.max(maxStep, Math.abs(next - value));
				value = next;
			}
			for (let frame = 0; frame < 60 * 10; frame += 1) morph.update(target, dt);
			const settled = morph.update(target, dt);
			return { maxStep, settled: settled.to === target && settled.mix === 1 && !morph.moving };
		});
		// Largest gap between options is 20; a 3 s smoothstep morph rushed 2.4x
		// moves at most about 20 * 1.5 * 2.4 / 3 / 60 = 0.4 per frame.
		expect(result.maxStep).toBeLessThan(0.45);
		expect(result.settled).toBe(true);
	});

	test('a track change carries the picture on instead of cutting', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const runtime = new VisualizerJourneyRuntime(0.4, 0);
			const features = (i: number) => ({
				bins: Array.from({ length: 64 }, (_, k) => (k < 12 ? 0.85 : 0.45)),
				rms: 0.55,
				peak: 0.9,
				centroid: 0.45,
				onset: i % 28 === 0,
				bass: 0.75,
				mid: 0.5,
				treble: 0.35,
				sample_rate: 48000,
				bpm: 128,
				beat_phase: (i % 28) / 28,
				chroma_key: 0.3,
				chroma_strength: 0.6
			});
			runtime.resetSource('song-a', 0);
			let now = 0;
			for (let i = 0; i < 60 * 40; i += 1) {
				now += 1000 / 60;
				runtime.advance(features(i), now);
			}
			const read = (s: any) => ({
				tension: s.loom.tension,
				openness: s.loom.openness,
				curl: s.loom.curl,
				braid: s.loom.braid,
				cameraDistance: s.loom.cameraDistance,
				cameraPitch: s.loom.cameraPitch,
				cameraYaw: s.loom.cameraYaw,
				torus: s.loom.topologyWeights.torus,
				knot: s.loom.topologyWeights.knot,
				frameScale: s.loom.look.frameScale,
				camDistance: s.loom.look.camDistance,
				heroGain: s.loom.look.exposure.heroGain,
				grammarTo: s.loom.look.grammarTo,
				identity: s.loom.look.identity
			});
			const before = read(runtime.advance(features(0), (now += 1000 / 60)));
			runtime.resetSource('song-b', now);
			const after = read(runtime.advance(features(1), (now += 1000 / 60)));
			const deltas: Record<string, number> = {};
			for (const key of Object.keys(before) as Array<keyof typeof before>) {
				deltas[key] = Math.abs((after[key] as number) - (before[key] as number));
			}
			return { deltas };
		});
		for (const [key, delta] of Object.entries(result.deltas)) {
			expect(delta, key).toBeLessThan(0.03);
		}
		// The strand hashes are seeded from the journey, not the song.
		expect(result.deltas.identity).toBe(0);
	});

	test('pacing: long sections still move the scene and tones and framings rotate', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/loom/look.ts');
			const l = new look.LoomLook('long-sections');
			const sections = ['intro', 'verse', 'chorus', 'bridge', 'outro'];
			const scenes: string[] = [];
			const tones = new Set<string>();
			const compositions = new Set<string>();
			const environments = new Set<string>();
			for (let phrase = 0; phrase < 240; phrase += 1) {
				// Twelve-phrase sections: three minutes each at 128 bpm.
				const section = sections[Math.floor(phrase / 12) % sections.length] + Math.floor(phrase / 12);
				let frame: any;
				for (let i = 0; i < 30; i += 1) {
					frame = l.advance({
						phraseIndex: phrase,
						sectionKey: section,
						energy: 0.3 + 0.5 * Math.abs(Math.sin(phrase * 0.2)),
						mode: 0.2,
						key: 0.4,
						dt: 1 / 4
					});
				}
				const n = frame.names;
				scenes.push(`${n.grammar}|${n.palette}|${n.camera}|${n.tone}|${n.composition}`);
				tones.add(n.tone);
				compositions.add(n.composition);
				environments.add(n.environment);
			}
			let longest = 0;
			let run = 0;
			for (let i = 0; i < scenes.length; i += 1) {
				run = i > 0 && scenes[i] === scenes[i - 1] ? run + 1 : 1;
				longest = Math.max(longest, run);
			}
			return {
				longest,
				tones: tones.size,
				compositions: compositions.size,
				environments: environments.size,
				toneCount: look.LOOM_TONES.length,
				compositionCount: look.LOOM_COMPOSITIONS.length
			};
		});
		// Camera holds at most three phrases (maxHold), so no scene lingers past that.
		expect(result.longest).toBeLessThanOrEqual(3);
		expect(result.tones).toBe(result.toneCount);
		expect(result.compositions).toBe(result.compositionCount);
		expect(result.environments).toBe(6);
	});

	test('tone weights follow energy: loud glows, quiet draws', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const look = await import('/src/lib/visualizer/loom/look.ts');
			const loud = look.loomToneWeights(0.95);
			const quiet = look.loomToneWeights(0.1);
			const ink = look.LOOM_TONES.findIndex((t) => t.name === 'ink');
			return {
				loudGlowLeads: loud[0] === Math.max(...loud),
				quietInkBeatsLoud: quiet[ink] > loud[ink] * 2,
				allPositive: [...loud, ...quiet].every((w) => w > 0)
			};
		});
		expect(result).toEqual({ loudGlowLeads: true, quietInkBeatsLoud: true, allPositive: true });
	});
	test('a character shift is answered once, survives a new source, and the weave follows the music', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (fixtures) => {
			const { LoomLook, LOOM_ENVIRONMENTS } = await import('/src/lib/visualizer/loom/look.ts');
			const { LoomConductor } = await import('/src/lib/visualizer/loom/conductor.ts');
			const character = (over: Record<string, number>) => ({
				vector: new Float32Array(8),
				tempo: 0.5,
				energy: 0.4,
				brightness: 0.5,
				bass: 0.5,
				noise: 0.4,
				punch: 0.3,
				motion: 0.5,
				valence: 0.6,
				contrast: 0,
				shift: 0,
				shiftSerial: 0,
				shiftStrength: 0,
				sinceShift: 1e6,
				...over
			});
			// Medians the shared tracker reports for the lab's ambient and noise rock.
			const ambient = { tempo: 0.03, energy: 0.26, brightness: 0.65, bass: 0.32, noise: 0.24, punch: 0.07, valence: 0.66 };
			const noise = { tempo: 0.93, energy: 0.4, brightness: 0.87, bass: 0.12, noise: 0.89, punch: 0.15, valence: 0.61 };
			const ambientCues = { centroid: 0.16, motion: 0.0, air: 0.82 };
			const noiseCues = { centroid: 0.21, motion: 0.43, air: 0.91 };
			const look = new LoomLook('shift-contract');
			const step = (c: any, listen: any, frames: number) => {
				let frame: any;
				for (let i = 0; i < frames; i += 1) {
					frame = look.advance({ phraseIndex: 3, sectionKey: 'verse', energy: 0.5, mode: 0.2, key: 0.4, dt: 1 / 30, character: c, listen });
				}
				return frame;
			};
			const calm = step(character(ambient), ambientCues, 90);
			const calmWeave = { ...calm.weave };
			const before = JSON.stringify(calm.names);
			const mutationsBefore = look.genome.mutations;
			// Noise rock arrives: a strength-1 shift fires once.
			const loud = character({ ...noise, shiftSerial: 1, shiftStrength: 1, shift: 1, sinceShift: 0 });
			const after1s = step(loud, noiseCues, 30);
			const mutationsAfterShift = look.genome.mutations;
			const after3s = step(loud, noiseCues, 60);
			const answered = look.answeredShift;
			const mutationsSettled = look.genome.mutations;
			// A new source rebuilds the conductor on the same journey-owned look:
			// the shift it already answered must not fire again.
			const conductor = new LoomConductor('next-source', look);
			const frame: any = structuredClone(fixtures.director);
			frame.clock.phraseIndex = 3;
			frame.section = 'verse';
			for (let i = 0; i < 30; i += 1) conductor.update(frame, fixtures.spectrum as any, 1 / 30, loud as any);
			return {
				answered,
				shifted: mutationsAfterShift > mutationsBefore,
				onlyOnce: mutationsSettled === mutationsAfterShift,
				noRepeatAfterRemount: look.genome.mutations === mutationsSettled,
				changedBy3s: JSON.stringify(after3s.names) !== before,
				environmentKnown: LOOM_ENVIRONMENTS.some((e: any) => e.name === after3s.names.environment),
				calmWeave,
				loudWeave: { ...after3s.weave },
				midFlow: after1s.weave.flow
			};
		}, FIXTURES);
		expect(result.answered).toBe(1);
		expect(result.shifted).toBe(true);
		expect(result.onlyOnce).toBe(true);
		expect(result.noRepeatAfterRemount).toBe(true);
		expect(result.changedBy3s).toBe(true);
		expect(result.environmentKnown).toBe(true);
		// Fast, noisy music flows faster, frays and churns; the weave glides there.
		expect(result.loudWeave.flow).toBeGreaterThan(result.calmWeave.flow + 0.8);
		expect(result.midFlow).toBeGreaterThan(result.calmWeave.flow);
		expect(result.midFlow).toBeLessThan(result.loudWeave.flow + 1e-6);
		expect(result.loudWeave.fray).toBeGreaterThan(result.calmWeave.fray + 0.3);
		expect(result.loudWeave.turbulence).toBeGreaterThan(result.calmWeave.turbulence + 0.3);
		// Ambient has more bass weight here than this noise track.
		expect(result.calmWeave.weight).toBeGreaterThan(result.loudWeave.weight);
	});
});
