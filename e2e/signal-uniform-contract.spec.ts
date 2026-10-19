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
				feedback: shaders.SIGNAL_FEEDBACK_WGSL,
				bloomDown: shaders.SIGNAL_BLOOM_DOWN_WGSL,
				blurH: shaders.SIGNAL_BLOOM_BLUR_H_WGSL,
				blurV: shaders.SIGNAL_BLOOM_BLUR_V_WGSL,
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
			return {
				figureArray: source.includes(`array<vec4<f32>, ${figures.SIGNAL_FIGURE_POINTS * 2}>`),
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
					shaders.SIGNAL_FEEDBACK_WGSL,
					shaders.SIGNAL_COMPOSITE_WGSL
				].some((code) => code.includes('`'))
			};
		});
		expect(result.figureArray).toBe(true);
		expect(result.terrainArray).toBe(true);
		expect(result.terrainFloats).toBe(result.expectedTerrain);
		expect(result.instances).toBe(2 + 4 + 3 + 7 + 22);
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
			for (let family = 0; family < figures.SIGNAL_FAMILY_NAMES.length; family += 1) {
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
				sampleError: Math.hypot(sample[0] - pts[index * 4], sample[1] - pts[index * 4 + 1])
			};
		});
		expect(result.finite).toBe(true);
		expect(result.extentOk).toBe(true);
		expect(result.minDifference).toBeGreaterThan(0.01);
		expect(result.halfFinite).toBe(true);
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
