import { expect, test } from '@playwright/test';

// Signal's WGSL Params struct and its TypeScript packing helper must never
// drift apart, and with layout: 'auto' every declared binding has to be used
// or Chrome rejects the bind group (a silent black screen). This spec checks
// both on every Signal shader module.
test.describe('Signal uniform contract', () => {
	test('WGSL Params layout matches packing, and every binding is referenced', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layout = await import('/src/lib/visualizer/signal/uniform-layout.ts');
			const shaders = await import('/src/lib/visualizer/signal/shaders.ts');

			const parseParams = (source: string) => {
				const match = source.match(/struct Params \{([\s\S]*?)\};/);
				if (!match) return null;
				const fields: Array<{ group: string; slots: string[] }> = [];
				const fieldPattern = /\/\/\s*([a-zA-Z][a-zA-Z0-9]*(?:,\s*[a-zA-Z][a-zA-Z0-9]*){3})\s*\n\s*(\w+): vec4<f32>/g;
				let field: RegExpExecArray | null;
				while ((field = fieldPattern.exec(match[1])) !== null) {
					fields.push({
						group: field[2],
						slots: field[1].split(',').map((slot) => slot.trim())
					});
				}
				return fields;
			};

			const unusedBindings = (source: string) => {
				const names = [...source.matchAll(/@binding\(\d+\)\s+var(?:<[^>]+>)?\s+(\w+)\s*:/g)].map(
					(match) => match[1]
				);
				return names.filter((name) => source.split(name).length - 1 < 2);
			};

			const modules = {
				scene: shaders.SIGNAL_SCENE_WGSL,
				beam: shaders.SIGNAL_BEAM_WGSL,
				feedback: shaders.SIGNAL_FEEDBACK_WGSL,
				glowDown: shaders.SIGNAL_GLOW_DOWN_WGSL,
				tightH: shaders.SIGNAL_TIGHT_BLUR_H_WGSL,
				tightV: shaders.SIGNAL_TIGHT_BLUR_V_WGSL,
				wideDown: shaders.SIGNAL_WIDE_DOWN_WGSL,
				wideH: shaders.SIGNAL_WIDE_BLUR_H_WGSL,
				wideV: shaders.SIGNAL_WIDE_BLUR_V_WGSL,
				composite: shaders.SIGNAL_COMPOSITE_WGSL
			};
			const layoutGroups = layout.SIGNAL_UNIFORM_GROUPS.map(([group, slots]) => ({
				group,
				slots: [...slots]
			}));
			const values = Object.fromEntries(
				layout.SIGNAL_UNIFORM_GROUPS.flatMap(([, slots], groupIndex) =>
					slots.map((slot, slotIndex) => [slot, groupIndex * 4 + slotIndex + 1])
				)
			) as Parameters<typeof layout.packSignalUniforms>[1];
			const packed = layout.packSignalUniforms(
				new Float32Array(layout.SIGNAL_UNIFORM_FLOATS),
				values
			);
			return {
				fields: Object.fromEntries(
					Object.entries(modules).map(([name, source]) => [name, parseParams(source)])
				),
				unused: Object.fromEntries(
					Object.entries(modules).map(([name, source]) => [name, unusedBindings(source)])
				),
				layoutGroups,
				floats: layout.SIGNAL_UNIFORM_FLOATS,
				bytes: layout.SIGNAL_UNIFORM_BYTES,
				packed: Array.from(packed)
			};
		});

		expect(result.floats).toBe(result.layoutGroups.length * 4);
		expect(result.bytes % 16).toBe(0);
		for (const fields of Object.values(result.fields)) {
			expect(fields).toEqual(result.layoutGroups);
		}
		for (const unused of Object.values(result.unused)) {
			expect(unused).toEqual([]);
		}
		expect(result.packed).toEqual(
			Array.from({ length: result.floats }, (_, index) => index + 1)
		);
		// The scene reads the shared figure polyline; its size must match.
		expect(result.fields.scene).not.toBeNull();
	});

	test('the scene shader is sized from the figure, horizon and instance constants', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const shaders = await import('/src/lib/visualizer/signal/shaders.ts');
			const figures = await import('/src/lib/visualizer/signal/figures.ts');
			const source = shaders.SIGNAL_SCENE_WGSL;
			const scopeArray = `array<vec2<f32>, ${shaders.SIGNAL_SCOPE_WINDOW}>`;
			return {
				figureArray: source.includes(`array<vec4<f32>, ${figures.SIGNAL_FIGURE_POINTS * 2}>`),
				// The stroke and XY beam modules read the same stereo window.
				scopeArrays:
					source.includes(scopeArray) &&
					shaders.SIGNAL_BEAM_WGSL.includes(scopeArray) &&
					shaders.SIGNAL_BEAM_WGSL.includes(`array<vec4<f32>, ${figures.SIGNAL_FIGURE_POINTS * 2}>`),
				passes: shaders.SIGNAL_RENDER_PASSES,
				terrainArray: source.includes(
					`array<vec2<f32>, ${shaders.SIGNAL_TERRAIN_ROWS * shaders.SIGNAL_TERRAIN_BINS}>`
				),
				terrainFloats: shaders.SIGNAL_TERRAIN_FLOATS,
				expectedTerrain: shaders.SIGNAL_TERRAIN_ROWS * shaders.SIGNAL_TERRAIN_BINS * 2,
				instances: shaders.SIGNAL_TRACE_INSTANCES,
				segments: shaders.SIGNAL_SEGMENTS,
				figureSegments: figures.SIGNAL_FIGURE_SEGMENTS,
				// Any backtick inside the generated WGSL would mean a broken template.
				backticks: [
					shaders.SIGNAL_SCENE_WGSL,
					shaders.SIGNAL_BEAM_WGSL,
					shaders.SIGNAL_FEEDBACK_WGSL,
					shaders.SIGNAL_GLOW_DOWN_WGSL,
					shaders.SIGNAL_TIGHT_BLUR_H_WGSL,
					shaders.SIGNAL_WIDE_DOWN_WGSL,
					shaders.SIGNAL_WIDE_BLUR_V_WGSL,
					shaders.SIGNAL_COMPOSITE_WGSL
				].some((code) => code.includes('`'))
			};
		});
		expect(result.figureArray).toBe(true);
		expect(result.scopeArrays).toBe(true);
		// Beams, phosphor, glow prefilter, tight H/V, wide prefilter, wide H/V, present.
		expect(result.passes).toBe(9);
		expect(result.terrainArray).toBe(true);
		expect(result.terrainFloats).toBe(result.expectedTerrain);
		// Hero A and B, X/Y plus six voice lanes, three feeds, seven rails, 22 rows.
		expect(result.instances).toBe(2 + 8 + 3 + 7 + 22);
		expect(result.segments).toBe(result.figureSegments);
		expect(result.backticks).toBe(false);
	});
});

test.describe('Signal variation genome', () => {
	test('is enormous, deterministic per seed, and keeps changing scene on songs and radio', async ({
		page
	}) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const genomeModule = await import('/src/lib/visualizer/signal/genome.ts');
			const { SignalVariation, signalVariationSpaceSize } = genomeModule;
			const sections = ['intro', 'verse', 'build', 'drop', 'breakdown', 'chorus', 'bridge', 'outro'];
			// 128 bpm: one 32-beat phrase is 15 s. Songs change section about
			// every two phrases; radio never reports a section.
			const run = (seed: string, phrases: number, live: boolean) => {
				const variation = new SignalVariation(seed);
				const triples = new Set<string>();
				const families = new Set<number>();
				const layouts = new Set<number>();
				const palettes = new Set<number>();
				const timeline: string[] = [];
				const fps = 20;
				const phraseSeconds = 15;
				for (let phrase = 0; phrase < phrases; phrase += 1) {
					const section = live ? 'verse' : `${sections[Math.floor(phrase / 2) % sections.length]}`;
					const energy = 0.5 + 0.4 * Math.sin(phrase * 0.41);
					for (let frame = 0; frame < phraseSeconds * fps; frame += 1) {
						variation.advance({ phraseIndex: phrase, section, energy, silence: false, dt: 1 / fps });
					}
					triples.add(variation.triple());
					families.add(variation.choice('family').to);
					layouts.add(variation.choice('layout').to);
					palettes.add(variation.choice('palette').to);
					timeline.push(variation.triple());
				}
				// Longest run of consecutive phrases showing the same triple.
				let longest = 1;
				let current = 1;
				for (let i = 1; i < timeline.length; i += 1) {
					current = timeline[i] === timeline[i - 1] ? current + 1 : 1;
					longest = Math.max(longest, current);
				}
				return {
					triples: triples.size,
					families: families.size,
					layouts: layouts.size,
					palettes: palettes.size,
					longest,
					timeline,
					scenes: variation.scene,
					signature: variation.genome.signature(6)
				};
			};
			const song = run('soma-qa', 300, false);
			const songAgain = run('soma-qa', 300, false);
			const other = run('radio-night', 300, false);
			const radio = run('radio-night', 300, true);
			// The first eight minutes of a song mix (32 phrases at 15 s).
			const eight = run('soma-qa', 32, false);
			return {
				space: signalVariationSpaceSize(),
				deterministic:
					JSON.stringify(song.timeline) === JSON.stringify(songAgain.timeline) &&
					song.signature === songAgain.signature,
				seedsDiffer: song.timeline.filter((triple, i) => triple !== other.timeline[i]).length,
				song: { ...song, timeline: undefined },
				radio: { ...radio, timeline: undefined },
				eight: { ...eight, timeline: undefined }
			};
		});
		expect(result.space).toBeGreaterThan(1_000_000);
		expect(result.deterministic).toBe(true);
		expect(result.seedsDiffer).toBeGreaterThan(250);
		expect(result.song.triples).toBeGreaterThanOrEqual(40);
		expect(result.radio.triples).toBeGreaterThanOrEqual(40);
		// Radio with no section labels still changes scene every few phrases.
		expect(result.radio.scenes).toBeGreaterThan(80);
		// No look holds longer than about a minute (four 15 s phrases).
		expect(result.song.longest).toBeLessThanOrEqual(4);
		expect(result.radio.longest).toBeLessThanOrEqual(4);
		// Eight minutes reach at least 6 palettes, 5 figure families, 3 layouts.
		expect(result.eight.palettes).toBeGreaterThanOrEqual(6);
		expect(result.eight.families).toBeGreaterThanOrEqual(5);
		expect(result.eight.layouts).toBeGreaterThanOrEqual(3);
	});

	test('overrides pin a look and parse defensively', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SignalVariation, parseSignalLookOverride } = await import(
				'/src/lib/visualizer/signal/genome.ts'
			);
			const parsed = parseSignalLookOverride('layout:3,family=2,palette:99,camera:x,bogus:1');
			const variation = new SignalVariation('pin');
			variation.setOverride(parsed);
			for (let phrase = 0; phrase < 40; phrase += 1) {
				for (let frame = 0; frame < 60; frame += 1) {
					variation.advance({ phraseIndex: phrase, section: `s${phrase}`, energy: 0.8, silence: false, dt: 0.25 });
				}
			}
			return { parsed, layout: variation.choice('layout'), family: variation.choice('family') };
		});
		expect(result.parsed).toEqual({ layout: 3, family: 2 });
		expect(result.layout).toEqual({ from: 3, to: 3, mix: 1 });
		expect(result.family).toEqual({ from: 2, to: 2, mix: 1 });
	});
});

test.describe('Signal instrument coupling', () => {
	test('every figure family is finite, distinct, and drives the horizon silhouette', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const figures = await import('/src/lib/visualizer/signal/figures.ts');
			const detail = new Float32Array(64).map((_, i) => Math.sin(i * 0.3) * 0.4);
			const input = (family: number) => ({
				familyFrom: family,
				familyTo: family,
				familyMix: 1,
				phase: 1.7,
				complexity: 0.45,
				mode: 1,
				p1: 0.4,
				p2: 0.6,
				ellipse: 0.2,
				lissajous: 0.5,
				ribbon: 0.2,
				rosette: 0.1,
				tension: 0.3,
				release: 0.4,
				spread: 0.05,
				sub: 0.5,
				kick: 0.6,
				body: 0.4,
				mids: 0.5,
				presence: 0.3,
				air: 0.2,
				spectralMotion: 0.3,
				energy: 0.6,
				detail,
				yaw: 0.3,
				tilt: 0.4,
				roll: 0.1,
				partner: 0,
				dt: 1 / 60,
				pace: 1
			});
			const silhouettes: number[][] = [];
			let finite = true;
			let extentOk = true;
			// The scope family draws the real stereo signal on the GPU; its
			// polyline is a stand-in for the family it morphs from or to.
			for (let family = 0; family < figures.SIGNAL_FAMILY_NAMES.length; family += 1) {
				if (family === figures.SIGNAL_SCOPE_FAMILY) continue;
				const engine = new figures.SignalFigureEngine();
				const points = engine.evaluate(input(family));
				let maxR = 0;
				for (let i = 0; i < points.length; i += 1) if (!Number.isFinite(points[i])) finite = false;
				for (let i = 0; i < figures.SIGNAL_FIGURE_POINTS; i += 1) {
					maxR = Math.max(maxR, Math.hypot(points[i * 4], points[i * 4 + 1]));
				}
				if (maxR < 0.3 || maxR > 2.2) extentOk = false;
				silhouettes.push(Array.from(engine.silhouette(new Float32Array(64))));
			}
			// Pairwise mean silhouette difference: families must not look alike.
			let minDifference = Infinity;
			for (let a = 0; a < silhouettes.length; a += 1) {
				for (let b = a + 1; b < silhouettes.length; b += 1) {
					let d = 0;
					for (let i = 0; i < 64; i += 1) d += Math.abs(silhouettes[a][i] - silhouettes[b][i]);
					minDifference = Math.min(minDifference, d / 64);
				}
			}
			// Family crossfade is continuous: halfway lies between the two ends.
			const engine = new figures.SignalFigureEngine();
			const half = Array.from(engine.evaluate({ ...input(0), familyFrom: 2, familyTo: 7, familyMix: 0.5 }));
			const halfFinite = half.every(Number.isFinite);
			// Morphing into the scope family keeps the leaving family's polyline
			// (the XY beam traces it while it hands over), and the share eases.
			const rose = Array.from(new figures.SignalFigureEngine().evaluate({ ...input(2) }));
			const toScope = Array.from(
				new figures.SignalFigureEngine().evaluate({
					...input(2),
					familyFrom: 2,
					familyTo: figures.SIGNAL_SCOPE_FAMILY,
					familyMix: 0.4
				})
			);
			const standIn = rose.every((value, i) => Math.abs(value - toScope[i]) < 1e-6);
			const shares = [0, 0.25, 0.5, 1].map((mix) =>
				figures.signalScopeShare(2, figures.SIGNAL_SCOPE_FAMILY, mix)
			);
			// Sampling at u returns the polyline the X and Y traces draw.
			const sampleEngine = new figures.SignalFigureEngine();
			const pts = sampleEngine.evaluate(input(3));
			const sample = sampleEngine.sample(0, 0.25, [0, 0]);
			const index = Math.round(0.25 * figures.SIGNAL_FIGURE_SEGMENTS);
			return {
				finite,
				extentOk,
				minDifference,
				halfFinite,
				standIn,
				shares,
				sampleError: Math.hypot(sample[0] - pts[index * 4], sample[1] - pts[index * 4 + 1])
			};
		});
		expect(result.finite).toBe(true);
		expect(result.extentOk).toBe(true);
		expect(result.minDifference).toBeGreaterThan(0.01);
		expect(result.halfFinite).toBe(true);
		expect(result.standIn).toBe(true);
		expect(result.shares).toEqual([0, 0.25, 0.5, 1]);
		expect(result.sampleError).toBeLessThan(1e-4);
	});

	test('layouts wire X and Y traces into figure A and keep every layout on screen', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layouts = await import('/src/lib/visualizer/signal/layouts.ts');
			const aspect = 1.6;
			const out = layouts.SIGNAL_LAYOUT_NAMES.map((name, index) => {
				const layout = layouts.buildSignalLayout(index, aspect);
				const inside = (x: number, y: number) => Math.abs(x) <= aspect * 1.001 && Math.abs(y) <= 1.001;
				let tracesInside = true;
				for (let k = 0; k < 4; k += 1) {
					const ox = layout[`t${k}ox` as 'figAX'];
					const oy = layout[`t${k}oy` as 'figAX'];
					const tx = layout[`t${k}tx` as 'figAX'];
					const ty = layout[`t${k}ty` as 'figAX'];
					if (!inside(ox, oy) || !inside(ox + tx, oy + ty)) tracesInside = false;
				}
				return {
					name,
					tracesInside,
					figureInside: inside(layout.figAX, layout.figAY),
					feeds: layout.feed > 0,
					xyVisible: layout.t0vis > 0 && layout.t1vis > 0
				};
			});
			// Halfway between two layouts is a valid finite layout.
			const mid = layouts.lerpSignalLayout(
				layouts.buildSignalLayout(1, aspect),
				layouts.buildSignalLayout(7, aspect),
				0.5,
				layouts.createSignalLayout()
			);
			return { out, midFinite: Object.values(mid).every(Number.isFinite) };
		});
		expect(result.out).toHaveLength(8);
		for (const layout of result.out) {
			expect(layout, layout.name).toMatchObject({ tracesInside: true, figureInside: true, feeds: true, xyVisible: true });
		}
		expect(result.midFinite).toBe(true);
	});

	test('palette families are authored, distinct and blend without leaving gamut', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const palettes = await import('/src/lib/visualizer/signal/palettes.ts');
			const out = palettes.createSignalPaletteOut();
			let inGamut = true;
			for (let a = 0; a < palettes.SIGNAL_PALETTES.length; a += 1) {
				for (const mix of [0, 0.37, 0.5, 1]) {
					palettes.resolveSignalPalette(a, (a + 7) % palettes.SIGNAL_PALETTES.length, mix, { hueLean: 0.6, mode: -1, energy: 1, warmth: 0.8 }, out);
					for (const role of [out.hero, out.trace, out.horizon, out.hot, out.room]) {
						for (const channel of role) if (!(channel >= 0 && channel <= 1.0001)) inGamut = false;
					}
				}
			}
			const names = new Set(palettes.SIGNAL_PALETTES.map((p) => p.name));
			return { count: palettes.SIGNAL_PALETTES.length, unique: names.size, inGamut };
		});
		expect(result.count).toBeGreaterThanOrEqual(20);
		expect(result.unique).toBe(result.count);
		expect(result.inGamut).toBe(true);
	});
});

test.describe('Signal continuity', () => {
	test('choice morphs finish before retargeting, reverse in place and stagger', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SignalChoiceMorph } = await import('/src/lib/visualizer/signal/continuity.ts');
			// Weight of each option on screen: from takes 1 - mix, to takes mix.
			const weights = (state: { from: number; to: number; mix: number }) => {
				const out = [0, 0, 0, 0];
				out[state.from] += 1 - state.mix;
				out[state.to] += state.mix;
				return out;
			};
			const dt = 1 / 60;
			const morph = new SignalChoiceMorph(4, 0);
			morph.update(0, dt);
			let previous = weights(morph.update(0, dt));
			let maxStep = 0;
			let maxStepAtRetarget = 0;
			const run = (target: number, frames: number, retarget = false) => {
				for (let frame = 0; frame < frames; frame += 1) {
					const next = weights(morph.update(target, dt));
					const step = Math.max(...next.map((w, i) => Math.abs(w - previous[i])));
					maxStep = Math.max(maxStep, step);
					if (retarget && frame === 0) maxStepAtRetarget = step;
					previous = next;
				}
			};
			run(1, 60); // a morph 0 -> 1 is a quarter of the way through
			run(2, 1, true); // the genome changes its mind mid-morph
			run(2, 60);
			const stillHeadingToOne = morph.state().to === 1;
			run(2, 400); // the first morph finishes, then 1 -> 2 runs
			const reachedTwo = morph.state().to === 2 && morph.state().mix === 1;
			// Reversal: start 2 -> 3, then go back to 2 half way.
			run(3, 120);
			const before = weights(morph.state());
			run(2, 1, true);
			const reverseStep = maxStepAtRetarget;
			const after = previous;
			run(2, 400);
			const backOnTwo = morph.state().to === 2 && morph.state().mix === 1;

			// Stagger: a delayed axis holds still until its delay has passed.
			const delayed = new SignalChoiceMorph(2, 1.5);
			delayed.update(0, dt);
			let heldFrames = 0;
			for (let frame = 0; frame < 300; frame += 1) {
				const state = delayed.update(3, dt);
				if (state.to === 0 || state.mix === 0) heldFrames += 1;
			}
			return {
				maxStep,
				maxStepAtRetarget,
				stillHeadingToOne,
				reachedTwo,
				reverseStep,
				reverseDelta: Math.max(...before.map((w, i) => Math.abs(w - after[i]))),
				backOnTwo,
				heldSeconds: heldFrames * dt,
				delayedArrived: delayed.state().to === 3 && delayed.state().mix === 1
			};
		});
		// A 4 s quintic morph moves at most ~1.9 / 4 of the weight per second.
		expect(result.maxStep).toBeLessThan(0.01);
		expect(result.maxStepAtRetarget).toBeLessThan(0.01);
		expect(result.stillHeadingToOne).toBe(true);
		expect(result.reachedTwo).toBe(true);
		expect(result.reverseStep).toBeLessThan(0.01);
		expect(result.reverseDelta).toBeLessThan(0.01);
		expect(result.backOnTwo).toBe(true);
		expect(result.heldSeconds).toBeGreaterThan(1.4);
		expect(result.delayedArrived).toBe(true);
	});

	test('a figure family change morphs through intermediate curves', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const figures = await import('/src/lib/visualizer/signal/figures.ts');
			const detail = new Float32Array(64).map((_, i) => Math.sin(i * 0.3) * 0.4);
			const base = {
				phase: 1.7,
				complexity: 0.45,
				mode: 1,
				p1: 0.4,
				p2: 0.6,
				ellipse: 0.2,
				lissajous: 0.5,
				ribbon: 0.2,
				rosette: 0.1,
				tension: 0.3,
				release: 0.4,
				spread: 0.05,
				sub: 0.5,
				kick: 0.6,
				body: 0.4,
				mids: 0.5,
				presence: 0.3,
				air: 0.2,
				spectralMotion: 0.3,
				energy: 0.6,
				detail,
				yaw: 0.3,
				tilt: 0.4,
				roll: 0.1,
				partner: 0,
				// dt 0 freezes the attractor so every evaluation is comparable.
				dt: 0,
				pace: 1
			};
			const curve = (input: Record<string, unknown>) => {
				const engine = new figures.SignalFigureEngine();
				const points = engine.evaluate(input as never);
				return Array.from({ length: figures.SIGNAL_FIGURE_POINTS }, (_, i) => [points[i * 4], points[i * 4 + 1]]);
			};
			const distance = (a: number[][], b: number[][]) =>
				a.reduce((sum, p, i) => sum + Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), 0) / a.length;
			const pairs = [
				[2, 7],
				[5, 0],
				[6, 3],
				[1, 4]
			];
			return pairs.map(([from, to]) => {
				const pureFrom = curve({ ...base, familyFrom: from, familyTo: from, familyMix: 1 });
				const pureTo = curve({ ...base, familyFrom: to, familyTo: to, familyMix: 1 });
				const steps: number[][][] = [];
				for (let k = 0; k <= 40; k += 1) {
					steps.push(curve({ ...base, familyFrom: from, familyTo: to, familyMix: k / 40 }));
				}
				const stepSizes = steps.slice(1).map((c, k) => distance(c, steps[k]));
				const mean = stepSizes.reduce((a, b) => a + b, 0) / stepSizes.length;
				const middle = steps[20];
				return {
					pair: `${from}->${to}`,
					startsAtFrom: distance(steps[0], pureFrom),
					endsAtTo: distance(steps[40], pureTo),
					span: distance(pureFrom, pureTo),
					middleFromBoth: Math.min(distance(middle, pureFrom), distance(middle, pureTo)),
					worstStepRatio: Math.max(...stepSizes) / Math.max(mean, 1e-9)
				};
			});
		});
		for (const pair of result) {
			expect(pair.startsAtFrom, pair.pair).toBeLessThan(1e-5);
			expect(pair.endsAtTo, pair.pair).toBeLessThan(1e-5);
			// Half way is a genuinely new curve, not either end.
			expect(pair.middleFromBoth, pair.pair).toBeGreaterThan(pair.span * 0.2);
			// No step of the morph is a jump.
			expect(pair.worstStepRatio, pair.pair).toBeLessThan(2.5);
		}
	});

	test('figure parameters that used to round (lobes, petals, key mode) glide', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const figures = await import('/src/lib/visualizer/signal/figures.ts');
			const detail = new Float32Array(64).map((_, i) => Math.cos(i * 0.21) * 0.5);
			const base = {
				phase: 0.9,
				complexity: 0.3,
				mode: 1,
				p1: 0.5,
				p2: 0.4,
				ellipse: 0.1,
				lissajous: 0.2,
				ribbon: 0.1,
				rosette: 0.6,
				tension: 0.8,
				release: 0.2,
				spread: 0.05,
				sub: 0.6,
				kick: 0.5,
				body: 0.6,
				mids: 0.4,
				presence: 0.7,
				air: 0.5,
				spectralMotion: 0.2,
				energy: 0.6,
				detail,
				yaw: 0.2,
				tilt: 0.3,
				roll: 0.1,
				partner: 0,
				dt: 0,
				pace: 1
			};
			const curve = (input: Record<string, unknown>) => {
				const points = new figures.SignalFigureEngine().evaluate(input as never);
				return Array.from(points.slice(0, figures.SIGNAL_FIGURE_POINTS * 4));
			};
			const sweep = (family: number, key: string, from: number, to: number, extra: Record<string, number>, steps: number) => {
				const input = { ...base, ...extra, familyFrom: family, familyTo: family, familyMix: 1 };
				let previous = curve({ ...input, [key]: from });
				let worst = 0;
				for (let k = 1; k <= steps; k += 1) {
					const value = from + ((to - from) * k) / steps;
					const next = curve({ ...input, [key]: value });
					let d = 0;
					for (let i = 0; i < figures.SIGNAL_FIGURE_POINTS; i += 1) {
						d = Math.max(d, Math.hypot(next[i * 4] - previous[i * 4], next[i * 4 + 1] - previous[i * 4 + 1]));
					}
					worst = Math.max(worst, d);
					previous = next;
				}
				return worst;
			};
			// A continuous family halves its worst step when the sweep is twice as
			// fine; a threshold (a rounded lobe count, a table switch) does not.
			const worstStep = (family: number, key: string, from: number, to: number, extra: Record<string, number> = {}) => {
				const coarse = sweep(family, key, from, to, extra, 300);
				const fine = sweep(family, key, from, to, extra, 600);
				return { coarse, ratio: fine / Math.max(coarse, 1e-9) };
			};
			return {
				polarLobes: worstStep(6, 'p1', 0.2, 0.8),
				lissajousPetals: worstStep(0, 'complexity', 0.1, 0.9),
				// High complexity reaches the table entries where major and minor differ.
				lissajousMode: worstStep(0, 'mode', -1, 1, { complexity: 0.9 }),
				harmonographMode: worstStep(1, 'mode', -1, 1, { complexity: 0.9 }),
				phasePlotMode: worstStep(4, 'mode', -1, 1, { complexity: 0.9 })
			};
		});
		for (const [name, worst] of Object.entries(result)) {
			expect(worst.coarse, name).toBeLessThan(0.08);
			expect(worst.ratio, name).toBeLessThan(0.6);
		}
	});

	test('a layout change moves panels and traces continuously', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layouts = await import('/src/lib/visualizer/signal/layouts.ts');
			const { SignalChoiceMorph } = await import('/src/lib/visualizer/signal/continuity.ts');
			const aspect = 1.6;
			const out = layouts.createSignalLayout();
			const check = (from: number, to: number) => {
				const a = layouts.buildSignalLayout(from, aspect);
				const b = layouts.buildSignalLayout(to, aspect);
				const morph = new SignalChoiceMorph(7.5, 0.6);
				morph.update(from, 1 / 60);
				let previous = { ...a };
				let worst = 0;
				let worstKey = '';
				let midFaceX = Number.NaN;
				let fractionalRepeat = false;
				for (let frame = 0; frame < 60 * 10; frame += 1) {
					const state = morph.update(to, 1 / 60);
					const layoutFrom = layouts.buildSignalLayout(state.from, aspect);
					const layoutTo = layouts.buildSignalLayout(state.to, aspect);
					const now = layouts.lerpSignalLayout(layoutFrom, layoutTo, state.mix, out);
					for (const key of Object.keys(now) as (keyof typeof now)[]) {
						const range = Math.abs(b[key] - a[key]);
						if (range < 1e-9) continue;
						const step = Math.abs(now[key] - previous[key]) / range;
						if (step > worst) {
							worst = step;
							worstKey = key;
						}
					}
					if (Math.abs(state.mix - 0.5) < 0.01) midFaceX = now.faceAX;
					if (now.faceARepeat % 1 > 0.05 && now.faceARepeat % 1 < 0.95) fractionalRepeat = true;
					previous = { ...now };
				}
				return {
					worst,
					worstKey,
					arrived: Object.keys(b).every((key) => Math.abs(previous[key as 'figAX'] - b[key as 'figAX']) < 1e-9),
					midBetween: Math.min(a.faceAX, b.faceAX) - 1e-9 <= midFaceX && midFaceX <= Math.max(a.faceAX, b.faceAX) + 1e-9,
					fractionalRepeat
				};
			};
			return { benchToBank: check(0, 4), tunnelToRadar: check(5, 7), dualToConstruction: check(2, 1) };
		});
		for (const [name, run] of Object.entries(result)) {
			// 7.5 s quintic morph at 60 fps: at most ~0.42 % of the way per frame.
			expect(run.worst, `${name} ${run.worstKey}`).toBeLessThan(0.006);
			expect(run.arrived, name).toBe(true);
			expect(run.midBetween, name).toBe(true);
		}
		// The strip bank grows through fractional strip counts the shader blends.
		expect(result.benchToBank.fractionalRepeat).toBe(true);
	});

	test('conductor rails carry across a new source and resume after a remount', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const continuity = await import('/src/lib/visualizer/signal/continuity.ts');
			const carry = new continuity.SignalCarry(5);
			const dt = 1 / 60;
			const seen: number[] = [];
			for (let frame = 0; frame < 120; frame += 1) {
				carry.advance(dt);
				seen.push(carry.apply('channels', 3.6));
			}
			const passThrough = seen.every((value) => value === 3.6);
			// New song: the rebuilt conductor starts its rails from intro values.
			carry.rebase();
			let worstStep = 0;
			let previous = seen[seen.length - 1];
			let atTwoSeconds = 0;
			for (let frame = 0; frame < 60 * 6; frame += 1) {
				carry.advance(dt);
				const raw = 1 + Math.min(1, frame / 600) * 0.4;
				const value = carry.apply('channels', raw);
				worstStep = Math.max(worstStep, Math.abs(value - previous));
				previous = value;
				if (frame === 120) atTwoSeconds = value;
			}
			const settled = Math.abs(previous - (1 + Math.min(1, (60 * 6 - 1) / 600) * 0.4)) < 1e-9;
			const memoryA = continuity.signalRendererMemory();
			const memoryB = continuity.signalRendererMemory();
			return {
				passThrough,
				worstStep,
				atTwoSeconds,
				settled,
				active: carry.active,
				sameMemory: memoryA === memoryB && memoryA.figure === memoryB.figure && memoryA.terrainRows === memoryB.terrainRows
			};
		});
		expect(result.passThrough).toBe(true);
		// A 2.6 drop in channels spread over five seconds, never in one frame.
		expect(result.worstStep).toBeLessThan(0.03);
		expect(result.atTwoSeconds).toBeGreaterThan(2);
		expect(result.settled).toBe(true);
		expect(result.active).toBe(false);
		expect(result.sameMemory).toBe(true);
	});

	test('the horizon blends two bench rigs and ripples a new surface down its rows', async ({ page }) => {
		await page.goto('/');
		const source = await page.evaluate(async () => {
			const shaders = await import('/src/lib/visualizer/signal/shaders.ts');
			return shaders.SIGNAL_SCENE_WGSL;
		});
		expect(source).toContain('surfaceRig(0u)');
		expect(source).toContain('surfaceRig(1u)');
		expect(source).toContain('params.cameraB');
		expect(source).toContain('fn surfaceMix(age: f32)');
	});
});
