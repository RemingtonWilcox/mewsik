import { expect, test } from '@playwright/test';

// The ensemble listener on the synthetic feature path: the lab profiles carry
// chord progressions, bass lines, per-layer drum patterns with swing, fills
// and breakdowns, and the tracker must hear each part on its own.
test.describe('ensemble tracker', () => {
	test.setTimeout(180_000);

	test('channels stay finite, in range, and keep their identity; same frames give the same ensemble', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SOMA_LAB_PROFILES } = await import('/src/lib/visualizer/lab/music-profiles.ts');
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { setActiveScore, setScorePlayback } = await import('/src/lib/visualizer/director/score.ts');
			const profile = SOMA_LAB_PROFILES.club128;
			setActiveScore(profile.score);
			const run = () => {
				const runtime = new VisualizerJourneyRuntime(0.4, 0);
				runtime.resetSource('ensemble-determinism', 0);
				let prev: number | undefined;
				let first: unknown = null;
				const bad: string[] = [];
				const visit = (value: unknown, path: string) => {
					if (typeof value === 'number') {
						if (!Number.isFinite(value)) bad.push(path);
					} else if (value instanceof Float32Array) {
						value.forEach((v, i) => {
							if (!Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) bad.push(`${path}[${i}]`);
						});
					} else if (value && typeof value === 'object') {
						for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
					}
				};
				let snapshot = null as unknown as ReturnType<typeof runtime.advance>;
				for (let pos = 20_000; pos < 60_000; pos += 1000 / 60) {
					setScorePlayback(pos, false);
					snapshot = runtime.advance(profile.frameAt(pos, 'seed', prev), pos - 20_000);
					prev = pos;
					if (!first) first = snapshot.ensemble;
					visit(snapshot.ensemble, 'ensemble');
				}
				const e = snapshot.ensemble;
				const unit = [
					e.groove.swing,
					e.groove.syncopation,
					e.groove.regularity,
					e.groove.fillIntensity,
					e.groove.drums,
					e.groove.breakdown,
					e.harmony.tension,
					e.harmony.key.major,
					e.bass.walking,
					e.articulation.legato,
					e.articulation.pad,
					e.texture.density,
					e.texture.width,
					e.texture.tonality,
					...Object.values(e.drums).flatMap((l) => [l.hit, l.activity, l.present, l.accent, l.velocity])
				];
				return {
					same: first === e && (first as typeof e).harmony.chroma === e.harmony.chroma,
					bad: bad.slice(0, 10),
					unitOk: unit.every((v) => v >= 0 && v <= 1),
					signedOk: [e.texture.trend, e.texture.register, e.texture.correlation].every((v) => v >= -1 && v <= 1),
					json: JSON.stringify(e)
				};
			};
			const a = run();
			const b = run();
			setActiveScore(null);
			return { a: { ...a, json: undefined }, deterministic: a.json === b.json };
		});
		expect(result.a.same).toBe(true);
		expect(result.a.bad).toEqual([]);
		expect(result.a.unitOk).toBe(true);
		expect(result.a.signedOk).toBe(true);
		expect(result.deterministic).toBe(true);
	});

	test('the lab profiles are heard as different ensembles', async ({ page }) => {
		await page.goto('/');
		const r = await page.evaluate(async () => {
			const { SOMA_LAB_PROFILES, SOMA_LAB_PROFILE_IDS } = await import('/src/lib/visualizer/lab/music-profiles.ts');
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { setActiveScore, setScorePlayback } = await import('/src/lib/visualizer/director/score.ts');
			const out: Record<string, any> = {};
			for (const id of SOMA_LAB_PROFILE_IDS) {
				const p = SOMA_LAB_PROFILES[id];
				setActiveScore(p.score);
				const runtime = new VisualizerJourneyRuntime(0.5, 0);
				runtime.resetSource(`ensemble-profile:${id}`, 0);
				let prev: number | undefined;
				let rootOk = 0;
				let qualityOk = 0;
				let counted = 0;
				const fills: number[] = [];
				const drops: number[] = [];
				const returns: number[] = [];
				let lastFill = 0;
				let lastDrop = 0;
				let lastReturn = 0;
				const sums: Record<string, number> = { swing: 0, swingN: 0, walking: 0, legato: 0, pad: 0, tonality: 0, n: 0 };
				for (let pos = 0; pos < p.score.duration_ms; pos += 1000 / 60) {
					setScorePlayback(pos, false);
					const e = runtime.advance(p.frameAt(pos, 'soma-qa', prev), pos).ensemble;
					prev = pos;
					const t = pos / 1000;
					const beat = t / p.ensemble.beatS;
					const truth = p.ensemble.chordAt(beat);
					if (beat - truth.startBeat > 1) {
						counted += 1;
						if (e.harmony.root === truth.root) {
							rootOk += 1;
							if (e.harmony.quality === truth.quality) qualityOk += 1;
						}
					}
					if (e.groove.fillSerial !== lastFill) fills.push(t);
					if (e.groove.dropoutSerial !== lastDrop) drops.push(t);
					if (e.groove.drumReturnSerial !== lastReturn) returns.push(t);
					lastFill = e.groove.fillSerial;
					lastDrop = e.groove.dropoutSerial;
					lastReturn = e.groove.drumReturnSerial;
					// Steady-state averages over the second half of the song;
					// swing where the full groove plays.
					const label = p.ensemble.label(Math.floor(beat / 4));
					if (['verse', 'chorus', 'drop'].includes(label) && t > 20) {
						sums.swing += e.groove.swingRatio;
						sums.swingN += 1;
					}
					if (t > p.score.duration_ms / 2000) {
						sums.walking += e.bass.walking;
						sums.legato += e.articulation.legato;
						sums.pad += e.articulation.pad;
						sums.tonality += e.texture.tonality;
						sums.n += 1;
					}
				}
				const e = runtime.cachedSnapshot!.ensemble;
				const truthFills = p.ensemble.fillsBetween(0, p.score.duration_ms / 1000);
				const beatS = p.ensemble.beatS;
				const caught = truthFills.filter((at) => fills.some((t) => t >= at - 0.1 && t <= at + 2 * beatS + 0.1)).length;
				const falseFills = fills.filter((t) => !truthFills.some((at) => t >= at - 0.1 && t <= at + 2 * beatS + 0.1)).length;
				const sections = p.score.sections;
				out[id] = {
					rootAccuracy: rootOk / Math.max(1, counted),
					qualityAccuracy: qualityOk / Math.max(1, counted),
					key: e.harmony.key.tonic,
					mode: e.harmony.key.mode,
					keyTruth: p.score.key.pitch_class,
					bpm: e.grid.bpm,
					swing: sums.swing / Math.max(1, sums.swingN),
					walking: sums.walking / sums.n,
					legato: sums.legato / sums.n,
					pad: sums.pad / sums.n,
					tonality: sums.tonality / sums.n,
					truthFills: truthFills.length,
					caught,
					falseFills,
					drops,
					returns,
					breakdown: sections.find((s) => s.label === 'breakdown') ?? null,
					outro: sections.find((s) => s.label === 'outro') ?? null
				};
			}
			setActiveScore(null);
			return out;
		});

		// Harmony: chords and qualities per profile, keys over the song.
		for (const id of ['club128', 'swing86', 'indie118', 'ambient64', 'acoustic94', 'cinematic72']) {
			expect(r[id].rootAccuracy, id).toBeGreaterThan(0.88);
			expect(r[id].qualityAccuracy, id).toBeGreaterThan(0.88);
			expect(r[id].key, id).toBe(r[id].keyTruth);
			expect(r[id].tonality, id).toBeGreaterThan(r.noise172.tonality + 0.2);
		}
		expect(r.swing86.mode).toBe('minor');
		expect(r.cinematic72.mode).toBe('minor');
		expect(r.indie118.mode).toBe('major');
		// Groove: swung hats in swing86 only.
		expect(r.swing86.swing).toBeGreaterThan(1.6);
		for (const id of ['club128', 'indie118', 'noise172']) expect(r[id].swing, id).toBeLessThan(1.2);
		for (const id of ['club128', 'swing86', 'indie118', 'noise172']) {
			expect(Math.abs(r[id].bpm - Number(id.match(/\d+/)![0]))).toBeLessThan(1);
		}
		// A walking bass in swing86 only.
		expect(r.swing86.walking).toBeGreaterThan(0.6);
		for (const id of ['club128', 'indie118', 'ambient64', 'cinematic72']) expect(r[id].walking, id).toBeLessThan(0.35);
		// Articulation: ambient pads are legato and sustained, acoustic plucks are not.
		expect(r.ambient64.legato).toBeGreaterThan(r.acoustic94.legato + 0.3);
		expect(r.ambient64.pad).toBeGreaterThan(r.acoustic94.pad);
		expect(r.ambient64.pad).toBeGreaterThan(r.indie118.pad + 0.2);
		// Fills at phrase ends, few false alarms.
		for (const id of ['club128', 'indie118', 'noise172']) {
			expect(r[id].caught / r[id].truthFills, id).toBeGreaterThan(0.6);
			expect(r[id].falseFills, id).toBeLessThanOrEqual(1);
		}
		expect(r.ambient64.caught + r.ambient64.falseFills).toBe(0);
		expect(r.acoustic94.falseFills).toBe(0);
		// The club breakdown drops the drums and the outro brings them back.
		const club = r.club128;
		expect(club.drops.length).toBe(1);
		expect(club.drops[0]).toBeGreaterThan(club.breakdown.start_ms / 1000);
		expect(club.drops[0] - club.breakdown.start_ms / 1000).toBeLessThan(2.5);
		expect(club.returns.length).toBe(1);
		expect(club.returns[0] - club.outro.start_ms / 1000).toBeLessThan(3);
		expect(r.noise172.drops.length).toBe(1);
		expect(r.noise172.returns.length).toBe(1);
		expect(r.ambient64.drops.length).toBe(0);
	});

	test('a new source forgets the song but keeps serials and the tempo; the tracker is cheap', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SOMA_LAB_PROFILES } = await import('/src/lib/visualizer/lab/music-profiles.ts');
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const { EnsembleTracker } = await import('/src/lib/visualizer/ensemble.ts');
			const { setActiveScore, setScorePlayback } = await import('/src/lib/visualizer/director/score.ts');
			const runtime = new VisualizerJourneyRuntime(0.5, 0);
			const probe = new EnsembleTracker();
			const play = (id: 'swing86' | 'acoustic94', fromMs: number, seconds: number, clockMs: number) => {
				const p = SOMA_LAB_PROFILES[id];
				setActiveScore(p.score);
				let prev: number | undefined;
				let cost = 0;
				let ticks = 0;
				for (let k = 0; k < seconds * 60; k += 1) {
					const pos = fromMs + (k * 1000) / 60;
					setScorePlayback(pos, false);
					const frame = p.frameAt(pos, 'soma-qa', prev);
					prev = pos;
					const snapshot = runtime.advance(frame, clockMs + (k * 1000) / 60);
					const t0 = performance.now();
					probe.update(frame, snapshot.director, snapshot.spectrum, 1 / 60);
					cost += performance.now() - t0;
					ticks += 1;
				}
				return cost / ticks;
			};
			runtime.resetSource('ensemble-a', 0);
			const costA = play('swing86', 20_000, 40, 0);
			const before = runtime.cachedSnapshot!.ensemble;
			const kept = {
				kickSerial: before.drums.kick.serial,
				changeSerial: before.harmony.changeSerial,
				swing: before.groove.swingRatio,
				pattern: Array.from(before.drums.kick.pattern).reduce((a, b) => a + b, 0),
				walking: before.bass.walking
			};
			runtime.resetSource('ensemble-b', 40_000);
			const costB = play('acoustic94', 20_000, 1, 40_000);
			const after = runtime.cachedSnapshot!.ensemble;
			setActiveScore(null);
			return {
				kept,
				after: {
					kickSerial: after.drums.kick.serial,
					changeSerial: after.harmony.changeSerial,
					pattern: Array.from(after.drums.kick.pattern).reduce((a, b) => a + b, 0),
					swing: after.groove.swingRatio,
					walking: after.bass.walking,
					bpm: after.grid.bpm,
					same: after === before
				},
				cost: Math.max(costA, costB)
			};
		});
		expect(result.kept.swing).toBeGreaterThan(1.6);
		expect(result.kept.pattern).toBeGreaterThan(1);
		// Same object, serials only move forward, the song is forgotten.
		expect(result.after.same).toBe(true);
		expect(result.after.kickSerial).toBeGreaterThanOrEqual(result.kept.kickSerial);
		expect(result.after.changeSerial).toBeGreaterThanOrEqual(result.kept.changeSerial);
		expect(result.after.pattern).toBeLessThan(result.kept.pattern / 2);
		expect(result.after.swing).toBeLessThan(1.3);
		expect(result.after.walking).toBeLessThan(result.kept.walking);
		expect(result.after.bpm).toBeGreaterThan(60);
		// Well under the 0.3 ms per tick budget.
		expect(result.cost).toBeLessThan(0.3);
	});
});
