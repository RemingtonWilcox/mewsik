import { expect, test } from '@playwright/test';

// Soma's organs answer different parts of the band (parts.ts): each arm group,
// the rim, the photophore clusters, the bell, the colony, the snow and the far
// animals have their own voice, a breakdown draws the organs in one by one,
// and the bell never moves on the director's predicted beat clock.

const FAKE = `
	globalThis.__somaEnsemble = () => {
		const layer = () => ({ hit: 0, serial: 0, velocity: 0, accent: 0, sinceHit: 9, perBeat: 0, activity: 0, present: 0, barPos: 0, step: 0, pattern: new Float32Array(16) });
		return {
			time: 0,
			grid: { known: true, bpm: 120, beatPhase: 0, barPhase: 0, bar: 0 },
			drums: { kick: layer(), snare: layer(), hat: layer(), perc: layer() },
			notes: layer(),
			groove: { confidence: 1, swing: 0, swingRatio: 1, syncopation: 0, regularity: 1, fill: 0, fillSerial: 0, fillIntensity: 0, sinceFill: 9, drums: 1, breakdown: 0, dropout: 0, dropoutSerial: 0, drumReturn: 0, drumReturnSerial: 0 },
			harmony: { chroma: new Float32Array(12), root: 0, quality: 'major', qualityIndex: 0, qualities: Float32Array.from([1, 0, 0, 0, 0, 0, 0]), confidence: 1, change: 0, changeSerial: 0, sinceChange: 9, changesPerBar: 1, tension: 0.2, degree: 0, key: { tonic: 0, mode: 'major', major: 1, minor: 0, confidence: 1, stability: 1, changeSerial: 0 } },
			bass: { pitchClass: 0, confidence: 1, note: 0, noteSerial: 0, interval: 0, stepwise: 1, walking: 0, perBeat: 1, activity: 0.5, level: 0.5 },
			articulation: { legato: 0.5, staccato: 0.5, low: 0.5, mid: 0.5, high: 0.5, sustain: 0.3, pad: 0.2, noteRate: 1 },
			texture: { eventsPerSecond: 4, density: 0.45, trend: 0, build: 0, low: 0.5, mid: 0.5, high: 0.5, register: 0, width: 0.3, correlation: 0.7, stereoKnown: true, tonality: 0.7, noisiness: 0.3 }
		};
	};
	globalThis.__somaHit = (e, name) => {
		const l = name === 'notes' ? e.notes : e.drums[name];
		l.serial += 1;
		l.hit = 1;
		l.velocity = 1;
	};
	globalThis.__somaPartsInput = (e, dt = 1 / 60) => ({
		ensemble: e,
		dt,
		silence: 0,
		glow: [0.1, 0.8, 1],
		accent: [0.6, 0.2, 1],
		organ: [1, 0.45, 0.2],
		reroute: 0,
		restless: 0.5,
		center: [0, 0, 0],
		radius: 2
	});
`;

test.describe('Soma ensemble', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.addInitScript(FAKE);
		await page.reload();
	});

	test('each instrument lights its own organs, not the whole animal', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaParts, SOMA_PART_SLOTS } = await import('/src/lib/visualizer/mk2/parts.ts');
			const g = globalThis as any;
			const slot = (name: string) => SOMA_PART_SLOTS.indexOf(name as never) * 4;
			const run = (voice: string) => {
				const parts = new SomaParts('ensemble-voices');
				const e = g.__somaEnsemble();
				for (let i = 0; i < 30; i += 1) parts.update(g.__somaPartsInput(e));
				const before = Array.from(parts.lanes);
				g.__somaHit(e, voice);
				for (let i = 0; i < 4; i += 1) parts.update(g.__somaPartsInput(e));
				const after = Array.from(parts.lanes);
				const delta = (name: string, lane: number) => after[slot(name) + lane] - before[slot(name) + lane];
				return {
					arms: [0, 1, 2, 3].map((k) => delta('armLight', k)),
					rim: delta('rimM', 0),
					packet: delta('compM', 2),
					comb: delta('photoM', 3),
					voicing: parts.voicing().arms
				};
			};
			return { kick: run('kick'), snare: run('snare'), hat: run('hat') };
		});
		// The same seed, the same arm voicing: exactly one arm group answers each drum.
		const lit = (v: number[]) => v.filter((x) => x > 0.3).length;
		expect(lit(result.kick.arms)).toBe(1);
		expect(lit(result.snare.arms)).toBe(1);
		expect(result.kick.arms.indexOf(Math.max(...result.kick.arms))).not.toBe(result.snare.arms.indexOf(Math.max(...result.snare.arms)));
		// The snare cracks the rim; the kick sets off the packet of light; the hats run the comb rows.
		expect(result.snare.rim).toBeGreaterThan(1);
		expect(result.kick.rim).toBeLessThan(0.05);
		expect(result.kick.packet).toBeGreaterThan(0.3);
		expect(result.snare.packet).toBeLessThan(0.05);
		expect(result.hat.comb).toBeGreaterThan(0.3);
		expect(result.kick.comb).toBeLessThan(0.05);
	});

	test('a breakdown draws the organs in one by one and the drums bring them back', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaParts, SOMA_PART_SLOTS } = await import('/src/lib/visualizer/mk2/parts.ts');
			const g = globalThis as any;
			const slot = (name: string) => SOMA_PART_SLOTS.indexOf(name as never) * 4;
			const parts = new SomaParts('ensemble-breakdown');
			const e = g.__somaEnsemble();
			const reach = () => [0, 1, 2, 3].map((k) => parts.lanes[slot('armReach') + k]);
			for (let i = 0; i < 60; i += 1) parts.update(g.__somaPartsInput(e));
			const start = reach();
			e.groove.breakdown = 1;
			const order: number[] = [];
			for (let i = 0; i < 60 * 12; i += 1) {
				parts.update(g.__somaPartsInput(e));
				reach().forEach((r, k) => {
					if (r < 0.8 && !order.includes(k)) order.push(k);
				});
			}
			const drawn = reach();
			e.groove.breakdown = 0;
			for (let i = 0; i < 60 * 8; i += 1) parts.update(g.__somaPartsInput(e));
			return { start, drawn, back: reach(), order };
		});
		expect(Math.min(...result.start)).toBeGreaterThan(0.95);
		expect(Math.max(...result.drawn)).toBeLessThan(0.7);
		// One group after another, not all at once.
		expect(result.order).toEqual([3, 2, 1, 0]);
		expect(Math.min(...result.back)).toBeGreaterThan(0.95);
	});

	test('a chord change re-voices one colour layer at a time', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaParts, SOMA_PART_SLOTS } = await import('/src/lib/visualizer/mk2/parts.ts');
			const g = globalThis as any;
			const slot = (name: string) => SOMA_PART_SLOTS.indexOf(name as never) * 4;
			const parts = new SomaParts('ensemble-chords');
			const e = g.__somaEnsemble();
			const colours = () => ['colArm', 'colRim', 'colOrgan'].map((n) => Array.from(parts.lanes.slice(slot(n), slot(n) + 3)));
			for (let i = 0; i < 300; i += 1) parts.update(g.__somaPartsInput(e));
			const moved: number[][] = [];
			for (let chord = 0; chord < 3; chord += 1) {
				const before = colours();
				e.harmony.changeSerial += 1;
				e.harmony.change = 1;
				e.harmony.root = (e.harmony.root + 5) % 12;
				// Minor, then dominant7, then augmented (ENSEMBLE_CHORD_QUALITIES order).
				const quality = [1, 5, 3][chord];
				e.harmony.qualities.set([0, 1, 2, 3, 4, 5, 6].map((i) => (i === quality ? 1 : 0)));
				// About 2.5 s: the chord's re-voicing lands; the slow drift of how hard
				// each layer leans into the harmony barely moves in that time.
				for (let i = 0; i < 150; i += 1) parts.update(g.__somaPartsInput(e));
				const after = colours();
				moved.push(after.map((c, k) => Math.hypot(c[0] - before[k][0], c[1] - before[k][1], c[2] - before[k][2])));
				// Let the layer finish settling before the next chord.
				for (let i = 0; i < 300; i += 1) parts.update(g.__somaPartsInput(e));
			}
			return moved;
		});
		// Each chord recolours mainly one layer; over three chords each layer has moved.
		for (const m of result) {
			const sorted = [...m].sort((a, b) => b - a);
			expect(sorted[0]).toBeGreaterThan(0.02);
			expect(sorted[1]).toBeLessThan(sorted[0] * 0.5);
		}
		const leaders = result.map((m) => m.indexOf(Math.max(...m)));
		expect(new Set(leaders).size).toBe(3);
	});

	test('the bell follows heard bass notes, never the predicted beat clock', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const g = globalThis as any;
			const drive = (clockOffset: number) => {
				const look = new SomaLook('ensemble-bell');
				look.setForce({ species: 0 });
				const e = g.__somaEnsemble();
				const out: number[] = [];
				const dt = 1 / 60;
				for (let i = 0; i < 60 * 8; i += 1) {
					const t = i * dt;
					if (i % 45 === 0) {
						e.bass.noteSerial += 1;
						e.bass.note = 1;
					} else e.bass.note *= 0.9;
					const beats = t * 2 + clockOffset;
					const f = look.update({
						director: {
							section: 'verse',
							silence: false,
							energy: 0.55,
							bassPunch: 0.2,
							drop: { buildActive: false, buildProgress: 0, dropEta: 99, anticipation: 0, postDropDecay: 0 },
							clock: { tempoBpm: 120, beatPhase: beats % 1, beatPulse: 0, downbeatFlag: false, barIndex: Math.floor(beats / 4), beatIndex: Math.floor(beats) % 4, phrasePos: 0.3, phraseIndex: 0 },
							context: { sectionEnergy: 0.55, keyPitchClass: 0.3, keyConfidence: 0.6, keyMode: 'minor' }
						},
						spectrum: { bass: 0.45, mid: 0.35, treble: 0.25 },
						mk2: { kick: 0.1, sparkle: 0, impact: 0.1 },
						live: true,
						dt,
						aspect: 1.78,
						ensemble: e
					} as never);
					if (i > 120) out.push(f.motion.contraction);
				}
				return out;
			};
			const a = drive(0);
			const b = drive(0.37);
			let diff = 0;
			for (let i = 0; i < a.length; i += 1) diff = Math.max(diff, Math.abs(a[i] - b[i]));
			return { diff, range: Math.max(...a) - Math.min(...a) };
		});
		// Shifting the director's beat clock changes nothing; the bass notes squeeze the bell.
		expect(result.diff).toBeLessThan(1e-6);
		expect(result.range).toBeGreaterThan(0.2);
	});

	test('the parts are deterministic per seed and stay finite', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaParts } = await import('/src/lib/visualizer/mk2/parts.ts');
			const g = globalThis as any;
			const run = () => {
				const parts = new SomaParts('ensemble-determinism');
				const e = g.__somaEnsemble();
				const voices = ['kick', 'snare', 'hat', 'perc', 'notes'];
				for (let i = 0; i < 60 * 40; i += 1) {
					if (i % 7 === 0) g.__somaHit(e, voices[(i / 7) % 5 | 0]);
					if (i % 240 === 0) e.groove.fillSerial += 1;
					if (i % 120 === 0) e.harmony.changeSerial += 1;
					parts.update(g.__somaPartsInput(e));
				}
				return parts.fingerprint();
			};
			const a = run();
			return { same: a === run(), finite: !/NaN|Infinity/.test(a) };
		});
		expect(result.same).toBe(true);
		expect(result.finite).toBe(true);
	});
});
