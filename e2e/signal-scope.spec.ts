import { expect, test } from '@playwright/test';

// The stereo scope stream: native base64 pairs decode exactly, the reader
// plays bursts back as a steady beam (every pair drawn once), the lab's
// synthetic stereo is deterministic and continuous, and none of it reaches
// the shared journey.
test.describe('Signal scope stream', () => {
	test('decodes the native payload and plays bursts back as a steady beam', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { ScopeStream, ScopeReader, measureScope, createScopeStats } = await import(
				'/src/lib/visualizer/scope.ts'
			);
			// Little-endian i16 pairs (16384, -8192), (32767, -32767), as the
			// analyzer encodes them.
			const bytes = new Uint8Array(8);
			const view = new DataView(bytes.buffer);
			view.setInt16(0, 16384, true);
			view.setInt16(2, -8192, true);
			view.setInt16(4, 32767, true);
			view.setInt16(6, -32767, true);
			const text = btoa(String.fromCharCode(...bytes));
			const stream = new ScopeStream();
			stream.pushBase64(text, 48_000, 0);
			const decoded = Array.from(stream.ring.slice(0, 4));

			// 60 Hz events of 800 pairs arriving in uneven bursts, drawn at 60 fps.
			const steady = new ScopeStream();
			const reader = new ScopeReader(0.04);
			let next = 0;
			const counts: number[] = [];
			let drawn = 0;
			let expectedStart = -1;
			let gaps = 0;
			for (let frame = 0; frame < 600; frame += 1) {
				const now = frame * (1000 / 60);
				// Bursty delivery: two events together every third frame.
				const events = frame % 3 === 0 ? 2 : frame % 3 === 1 ? 1 : 0;
				for (let e = 0; e < events; e += 1) {
					const pcm = new Float32Array(1600);
					for (let i = 0; i < 800; i += 1) {
						const t = (next + i) / 48_000;
						pcm[i * 2] = Math.sin(2 * Math.PI * 100 * t) * 0.5;
						pcm[i * 2 + 1] = Math.cos(2 * Math.PI * 100 * t) * 0.5;
					}
					next += 800;
					steady.pushPairs(pcm, 800, 48_000, now);
				}
				const range = reader.take(steady, 1 / 60, 2048);
				if (frame > 60) {
					counts.push(range.count);
					if (expectedStart >= 0 && range.start !== expectedStart) gaps += 1;
					drawn += range.count;
				}
				expectedStart = range.start + range.count;
			}
			const stats = measureScope(steady, steady.written - 2000, 1600, createScopeStats());
			const mean = drawn / counts.length;
			return {
				decoded,
				mean,
				min: Math.min(...counts),
				max: Math.max(...counts),
				gaps,
				width: stats.width,
				correlation: stats.correlation,
				frequency: stats.frequency
			};
		});
		expect(result.decoded[0]).toBeCloseTo(16384 / 32767, 5);
		expect(result.decoded[1]).toBeCloseTo(-8192 / 32767, 5);
		expect(result.decoded[2]).toBeCloseTo(1, 5);
		expect(result.decoded[3]).toBeCloseTo(-1, 5);
		// Every frame draws about one frame of pairs, never a burst or a stall,
		// and each frame starts exactly where the previous one ended.
		expect(result.mean).toBeGreaterThan(780);
		expect(result.mean).toBeLessThan(820);
		expect(result.min).toBeGreaterThan(700);
		expect(result.max).toBeLessThan(900);
		expect(result.gaps).toBe(0);
		// A sine/cosine pair: half side energy, uncorrelated, turning at 100 Hz.
		expect(result.width).toBeCloseTo(0.5, 1);
		expect(Math.abs(result.correlation)).toBeLessThan(0.05);
		expect(result.frequency).toBeGreaterThan(90);
		expect(result.frequency).toBeLessThan(110);
	});

	test('lab stereo is deterministic, continuous, and never reaches the journey', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { SOMA_LAB_PROFILES, SOMA_LAB_PROFILE_IDS } = await import('/src/lib/visualizer/lab/music-profiles.ts');
			const { VisualizerJourneyRuntime } = await import('/src/lib/visualizer/journey.ts');
			const profiles = SOMA_LAB_PROFILE_IDS.map((id) => {
				const profile = SOMA_LAB_PROFILES[id];
				const a = profile.scopeBetween(30_000, 30_050, 'seed');
				const b = profile.scopeBetween(30_000, 30_050, 'seed');
				// Two windows back to back equal one long window.
				const first = profile.scopeBetween(30_000, 30_020, 'seed');
				const second = profile.scopeBetween(30_020, 30_050, 'seed');
				let joined = true;
				for (let i = 0; i < a.length; i += 1) {
					const value = i < first.length ? first[i] : second[i - first.length];
					if (Math.abs(value - a[i]) > 1e-6) joined = false;
				}
				let peak = 0;
				let lr = 0;
				let ll = 0;
				let rr = 0;
				for (let i = 0; i < a.length; i += 2) {
					peak = Math.max(peak, Math.abs(a[i]), Math.abs(a[i + 1]));
					lr += a[i] * a[i + 1];
					ll += a[i] * a[i];
					rr += a[i + 1] * a[i + 1];
				}
				const frame = profile.frameAt(30_050, 'seed', 30_000);
				return {
					id,
					same: a.every((value, i) => value === b[i]),
					joined,
					pairs: a.length / 2,
					peak,
					correlation: lr / Math.sqrt(ll * rr),
					framePairs: (frame.scope_pcm?.length ?? 0) / 2,
					rate: frame.scope_rate
				};
			});
			// The journey sees the same snapshot with or without scope samples.
			const run = (withScope: boolean) => {
				const runtime = new VisualizerJourneyRuntime(0.5, 0);
				runtime.resetSource('scope-free', 0);
				let snapshot = null as unknown as ReturnType<typeof runtime.advance>;
				for (let step = 0; step < 240; step += 1) {
					const frame = SOMA_LAB_PROFILES.club128.frameAt(20_000 + step * 16.7, 'seed');
					if (!withScope) {
						delete frame.scope_pcm;
						delete frame.scope_rate;
					}
					snapshot = runtime.advance(frame, step * 16.7);
				}
				return JSON.stringify(snapshot);
			};
			return { profiles, journeyUntouched: run(true) === run(false) };
		});
		for (const profile of result.profiles) {
			expect(profile.same, profile.id).toBe(true);
			expect(profile.joined, profile.id).toBe(true);
			expect(profile.pairs, profile.id).toBe(2205);
			expect(profile.peak, profile.id).toBeGreaterThan(0.05);
			expect(profile.peak, profile.id).toBeLessThanOrEqual(1);
			// Real stereo: the channels differ (not a mono diagonal).
			expect(Math.abs(profile.correlation), profile.id).toBeLessThan(0.97);
			expect(profile.framePairs, profile.id).toBe(2205);
			expect(profile.rate, profile.id).toBe(44_100);
		}
		expect(result.journeyUntouched).toBe(true);
	});
});
