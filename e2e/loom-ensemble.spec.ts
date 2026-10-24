import { expect, test } from '@playwright/test';

// Loom as an ensemble of threads (src/lib/visualizer/loom/ensemble.ts): each
// strand group plays its own instrument, the stage parts their own voices.
// These run the CPU side on synthetic ensemble frames.
test.describe('Loom ensemble', () => {
	test('groups answer their own instruments, fills throw the shuttle, chords re-thread', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const mod = await import('/src/lib/visualizer/loom/ensemble.ts');
			const { LoomEnsemble, LOOM_PART, LOOM_PART_PACKETS, LOOM_PACKET_SLOTS, LOOM_GROUPS } = mod;
			const layer = () => ({
				hit: 0,
				serial: 0,
				velocity: 0.8,
				accent: 0,
				sinceHit: 0,
				perBeat: 1,
				activity: 0.5,
				present: 1,
				barPos: 0,
				step: 0,
				pattern: new Float32Array(16)
			});
			const frame = {
				time: 0,
				grid: { known: true, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
				drums: { kick: layer(), snare: layer(), hat: layer(), perc: layer() },
				notes: layer(),
				groove: {
					confidence: 1,
					swing: 0,
					swingRatio: 1,
					syncopation: 0,
					regularity: 1,
					fill: 0,
					fillSerial: 0,
					fillIntensity: 0,
					sinceFill: 0,
					drums: 1,
					breakdown: 0,
					dropout: 0,
					dropoutSerial: 0,
					drumReturn: 0,
					drumReturnSerial: 0
				},
				harmony: {
					chroma: new Float32Array(12),
					root: 0,
					quality: 'major',
					qualityIndex: 0,
					qualities: new Float32Array([0.8, 0.1, 0, 0, 0, 0, 0.1]),
					confidence: 0.8,
					change: 0,
					changeSerial: 0,
					sinceChange: 0,
					changesPerBar: 1,
					tension: 0.2,
					degree: 0,
					key: { tonic: 0, mode: 'major', major: 1, minor: 0, confidence: 0.8, stability: 1, changeSerial: 0 }
				},
				bass: { pitchClass: -1, confidence: 0.8, note: 0, noteSerial: 0, interval: 0, stepwise: 0.5, walking: 0, perBeat: 1, activity: 0.5, level: 0.6 },
				articulation: { legato: 0.5, staccato: 0.5, low: 0.5, mid: 0.5, high: 0.5, sustain: 0.5, pad: 0, noteRate: 2 },
				texture: {
					eventsPerSecond: 5,
					density: 0.5,
					trend: 0,
					build: 0,
					low: 0.5,
					mid: 0.5,
					high: 0.5,
					register: 0,
					width: 0.3,
					correlation: 0.7,
					stereoKnown: true,
					tonality: 0.8,
					noisiness: 0.2
				}
			};
			const input = { identity: 0.37, silence: 0, shuttleForm: 0 };
			const dt = 1 / 60;
			const make = () => new LoomEnsemble();
			const groupPackets = (parts: Float32Array, g: number) => {
				let sum = 0;
				for (let k = 0; k < LOOM_PACKET_SLOTS; k += 1) sum += parts[(LOOM_PART_PACKETS + g * LOOM_PACKET_SLOTS + k) * 4 + 1];
				return sum;
			};
			const all = (parts: Float32Array) => Array.from({ length: LOOM_GROUPS }, (_, g) => groupPackets(parts, g));
			const e = make();
			// Serials from before the first update are never answered.
			frame.drums.kick.serial = 50;
			let parts = e.update(frame as never, null, dt, input);
			const primed = all(parts).reduce((a, b) => a + b, 0);
			const step = (n = 1) => {
				for (let i = 0; i < n; i += 1) parts = e.update(frame as never, null, dt, input);
			};
			// Each group's brightest packet light over the next n frames (drums
			// strike and fade within a fifth of a second; tonal voices swell).
			const peak = (n: number) => {
				const best = Array(LOOM_GROUPS).fill(0);
				for (let i = 0; i < n; i += 1) {
					step();
					all(parts).forEach((v, g) => (best[g] = Math.max(best[g], v)));
				}
				return best;
			};
			// A kick on beat 2 lights the centre rail where beat 2 sits.
			frame.drums.kick.serial += 1;
			frame.drums.kick.barPos = 0.25;
			frame.drums.kick.step = 4;
			const afterKick = peak(6);
			let kickS = 0;
			for (let k = 0; k < LOOM_PACKET_SLOTS; k += 1) {
				const i = (LOOM_PART_PACKETS + LOOM_PACKET_SLOTS + k) * 4;
				if (parts[i + 1] > 0.1) kickS = parts[i];
			}
			step(60);
			// A snare lights the high rail only.
			frame.drums.snare.serial += 1;
			frame.drums.snare.barPos = 0.75;
			frame.drums.snare.step = 12;
			const afterSnare = peak(6);
			step(60);
			// Hats make the hat group glitter (sparkle, and a new scatter of glints).
			const seedBefore = parts[(5 * 5 + 3) * 4 + 1];
			frame.drums.hat.serial += 1;
			frame.drums.hat.barPos = 0.125;
			frame.drums.hat.step = 2;
			const hatPeak = peak(3);
			const hatSparkle = parts[(5 * 5 + 1) * 4 + 3];
			const seedAfter = parts[(5 * 5 + 3) * 4 + 1];
			const afterHat = hatPeak;
			step(60);
			// The bass line: a note lights the low rail, lifts it with its pitch and drops a ring.
			frame.bass.noteSerial += 1;
			frame.bass.pitchClass = 11;
			frame.bass.interval = 5;
			step(30);
			const bassLift = parts[1 * 4 + 1];
			const bassPackets = groupPackets(parts, 0);
			const ringAmp = Math.max(parts[LOOM_PART.ringA * 4 + 3], parts[LOOM_PART.ringB * 4 + 3]);
			const pluck = parts[LOOM_PART.bass * 4];
			frame.bass.pitchClass = 0;
			step(60);
			const bassLow = parts[1 * 4 + 1];
			// A chord change: tones on the chord group, and one weft group re-threads.
			frame.harmony.chroma.set([1, 0, 0, 0, 0.9, 0, 0, 0.8, 0, 0, 0, 0]);
			frame.harmony.root = 7;
			frame.harmony.changeSerial += 1;
			const crossBefore = [parts[(3 * 5 + 2) * 4], parts[(4 * 5 + 2) * 4]];
			const chordPackets = peak(20)[6];
			step(120);
			const crossAfter = [parts[(3 * 5 + 2) * 4], parts[(4 * 5 + 2) * 4]];
			// A fill throws the shuttle once across the weave.
			frame.groove.fillSerial += 1;
			frame.groove.fillIntensity = 0.8;
			const shuttle: number[][] = [];
			for (let i = 0; i < 240; i += 1) {
				step();
				shuttle.push([parts[LOOM_PART.shuttle * 4], parts[LOOM_PART.shuttle * 4 + 1]]);
			}
			// Determinism.
			const a = make();
			const b = make();
			let same = true;
			for (let i = 0; i < 600; i += 1) {
				frame.drums.kick.serial += i % 30 === 0 ? 1 : 0;
				const pa = a.update(frame as never, null, dt, input);
				const pb = b.update(frame as never, null, dt, input);
				for (let k = 0; k < pa.length; k += 1) if (pa[k] !== pb[k]) same = false;
			}
			return { primed, afterKick, kickS, afterSnare, afterHat, hatSparkle, seedBefore, seedAfter, bassLift, bassLow, bassPackets, ringAmp, pluck, chordPackets, crossBefore, crossAfter, shuttle, same, voices: e.voices() };
		});
		expect(result.primed).toBe(0);
		// Kick: centre rail only (group 1).
		expect(result.afterKick[1]).toBeGreaterThan(0.5);
		for (const g of [0, 2, 3, 4, 5, 6]) expect(result.afterKick[g]).toBeLessThan(0.05);
		// The strand is a bar: beat 2 sits a quarter of the way along (or mirrored).
		expect(Math.min(Math.abs(result.kickS - 0.3), Math.abs(result.kickS - 0.7))).toBeLessThan(0.03);
		// Snare: high rail, and an accent-free backbeat does not touch the kick rail.
		expect(result.afterSnare[2]).toBeGreaterThan(0.5);
		expect(result.afterSnare[1]).toBeLessThan(0.1);
		// Hats glitter on chorus i, with a fresh scatter of glints.
		expect(result.afterHat[5]).toBeGreaterThan(0.3);
		expect(result.hatSparkle).toBeGreaterThan(0.3);
		expect(result.seedAfter).not.toBe(result.seedBefore);
		// Bass: low rail packets, lift follows pitch, a ring and a pluck.
		expect(result.bassPackets).toBeGreaterThan(0.2);
		expect(result.bassLift).toBeGreaterThan(0.5);
		expect(result.bassLow).toBeLessThan(-0.5);
		expect(result.ringAmp).toBeGreaterThan(0.3);
		expect(result.pluck).toBeGreaterThan(0.3);
		// Chord change: chord tones on chorus ii, one weft group re-threaded.
		expect(result.chordPackets).toBeGreaterThan(0.8);
		const moved = result.crossAfter.map((v, i) => Math.abs(v - result.crossBefore[i]));
		expect(Math.max(...moved)).toBeGreaterThan(0.2);
		expect(Math.min(...moved)).toBeLessThan(1e-3);
		// Shuttle: one pass, monotonic, lit only while it travels.
		const lit = result.shuttle.filter(([, i]) => i > 0.05);
		expect(lit.length).toBeGreaterThan(30);
		const xs = lit.map(([s]) => s);
		const rising = xs[xs.length - 1] > xs[0];
		for (let i = 1; i < xs.length; i += 1) expect(rising ? xs[i] >= xs[i - 1] : xs[i] <= xs[i - 1]).toBe(true);
		expect(Math.abs(xs[xs.length - 1] - xs[0])).toBeGreaterThan(0.6);
		expect(result.shuttle[result.shuttle.length - 1][1]).toBe(0);
		expect(result.same).toBe(true);
		expect(new Set(result.voices).size).toBe(9);
	});

	test('a breakdown lets groups fall away one by one, drums first; they return; nothing jumps', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const { LoomEnsemble, LOOM_GROUPS, LOOM_PART_PACKETS } = await import('/src/lib/visualizer/loom/ensemble.ts');
			const layer = () => ({ hit: 0, serial: 0, velocity: 0.8, accent: 0, sinceHit: 0, perBeat: 1, activity: 0.5, present: 1, barPos: 0, step: 0, pattern: new Float32Array(16) });
			const frame = {
				time: 0,
				grid: { known: true, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
				drums: { kick: layer(), snare: layer(), hat: layer(), perc: layer() },
				notes: layer(),
				groove: { confidence: 1, swing: 0.6, swingRatio: 1.8, syncopation: 0.3, regularity: 1, fill: 0, fillSerial: 0, fillIntensity: 0, sinceFill: 0, drums: 1, breakdown: 0, dropout: 0, dropoutSerial: 0, drumReturn: 0, drumReturnSerial: 0 },
				harmony: { chroma: new Float32Array(12).fill(0.3), root: 2, quality: 'minor', qualityIndex: 1, qualities: new Float32Array([0.1, 0.8, 0, 0, 0, 0, 0.1]), confidence: 0.8, change: 0, changeSerial: 0, sinceChange: 0, changesPerBar: 1, tension: 0.3, degree: 0, key: { tonic: 2, mode: 'minor', major: 0, minor: 1, confidence: 0.8, stability: 1, changeSerial: 0 } },
				bass: { pitchClass: 2, confidence: 0.8, note: 0, noteSerial: 0, interval: 2, stepwise: 0.8, walking: 0.8, perBeat: 1, activity: 0.5, level: 0.6 },
				articulation: { legato: 0.5, staccato: 0.5, low: 0.5, mid: 0.5, high: 0.5, sustain: 0.5, pad: 0.4, noteRate: 2 },
				texture: { eventsPerSecond: 5, density: 0.5, trend: 0, build: 0, low: 0.5, mid: 0.5, high: 0.5, register: 0, width: 0.3, correlation: 0.7, stereoKnown: true, tonality: 0.8, noisiness: 0.2 }
			};
			const e = new LoomEnsemble();
			const input = { identity: 0.81, silence: 0, shuttleForm: 0 };
			const dt = 1 / 60;
			let last = Float32Array.from(e.update(frame as never, null, dt, input));
			let maxSmoothStep = 0;
			let maxRethreadStep = 0;
			const voiceSets = new Set<string>();
			const withdrawnAt: number[] = Array(LOOM_GROUPS).fill(-1);
			let returned = -1;
			// 8 minutes: music for 3, a breakdown for 1, music again.
			for (let f = 0; f < 60 * 480; f += 1) {
				const t = f / 60;
				const beat = Math.floor(t * 2);
				const sixteenth = Math.floor(t * 8);
				const breakdown = t >= 180 && t < 240;
				if (!breakdown && Math.floor((t - dt) * 2) !== beat) {
					frame.drums.kick.serial += 1;
					frame.drums.kick.barPos = (beat % 4) / 4;
					frame.drums.kick.step = (beat % 4) * 4;
					if (beat % 2 === 1) {
						frame.drums.snare.serial += 1;
						frame.drums.snare.barPos = (beat % 4) / 4;
						frame.drums.snare.step = (beat % 4) * 4;
					}
				}
				if (!breakdown && Math.floor((t - dt) * 8) !== sixteenth && sixteenth % 2 === 1) {
					frame.drums.hat.serial += 1;
					frame.drums.hat.barPos = (sixteenth % 16) / 16;
					frame.drums.hat.step = sixteenth % 16;
				}
				if (Math.floor((t - dt) * 0.5) !== Math.floor(t * 0.5)) {
					frame.harmony.changeSerial += 1;
					frame.harmony.root = (frame.harmony.root + 5) % 12;
					frame.bass.noteSerial += 1;
					frame.bass.pitchClass = frame.harmony.root;
				}
				if (f === 60 * 180) frame.groove.dropoutSerial += 1;
				if (f === 60 * 240) frame.groove.drumReturnSerial += 1;
				frame.groove.breakdown = breakdown ? Math.min(1, (t - 180) / 2) : Math.max(0, frame.groove.breakdown - dt);
				frame.groove.drums = breakdown ? 0 : 1;
				const parts = e.update(frame as never, null, dt, input);
				for (let g = 0; g < LOOM_GROUPS; g += 1) {
					if (withdrawnAt[g] < 0 && e.presenceOf(g) < 0.3) withdrawnAt[g] = t;
				}
				if (returned < 0 && t > 240 && Array.from({ length: LOOM_GROUPS }, (_, g) => e.presenceOf(g)).every((p) => p > 0.9)) returned = t;
				// Slack, hue, crossings, presence, cluster and the stage's slow voices must glide.
				for (let g = 0; g < LOOM_GROUPS; g += 1) {
					for (const k of [g * 20 + 2, g * 20 + 3, g * 20 + 10, g * 20 + 12]) {
						maxSmoothStep = Math.max(maxSmoothStep, Math.abs(parts[k] - last[k]));
					}
					// Re-threading is quick (half a second) but still a glide.
					for (const k of [g * 20 + 8, g * 20 + 9]) maxRethreadStep = Math.max(maxRethreadStep, Math.abs(parts[k] - last[k]));
				}
				for (let k = (LOOM_PART_PACKETS + 36 + 3) * 4; k < (LOOM_PART_PACKETS + 36 + 4) * 4; k += 1) {
					maxSmoothStep = Math.max(maxSmoothStep, Math.abs(parts[k] - last[k]));
				}
				last = Float32Array.from(parts);
				if (f % 600 === 0) voiceSets.add(e.voices().join(','));
			}
			const voices = e.voices();
			return { withdrawnAt, returned, maxSmoothStep, maxRethreadStep, voiceSets: voiceSets.size, voices, counts: e.counts, camera: e.camera };
		});
		const out = result.withdrawnAt.map((t, g) => ({ t, g })).filter((x) => x.t >= 180 && x.t < 240);
		// Six groups fall away, one by one (staggered), and three keep playing.
		expect(out.length).toBe(6);
		const times = out.map((x) => x.t).sort((a, b) => a - b);
		for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThan(0.4);
		expect(times[times.length - 1] - times[0]).toBeGreaterThan(3);
		// They all come back after the drums return.
		expect(result.returned).toBeGreaterThan(240);
		expect(result.returned).toBeLessThan(244);
		// Slow parts glide (no step over ~0.06 per frame at 60 fps).
		expect(result.maxSmoothStep).toBeLessThan(0.08);
		expect(result.maxRethreadStep).toBeLessThan(0.25);
		// Instruments trade between groups over minutes, always one each.
		expect(result.voiceSets).toBeGreaterThan(2);
		expect(new Set(result.voices).size).toBe(9);
		expect(result.counts.rethreads).toBeGreaterThan(100);
		expect(Math.abs(result.camera.dolly)).toBeLessThan(0.2);
	});
});
