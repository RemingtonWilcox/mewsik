import { expect, test } from '@playwright/test';

// Soma's instant reaction: the music character steers the animal at once, a
// character shift is answered exactly once per serial (and never re-fired by a
// remount), and a jump from one genre to another stays a continuous
// transformation, never a cut.

const FAKES = `
	globalThis.__somaReactFake = (state) => ({
		director: {
			section: 'verse',
			silence: false,
			energy: state.energy,
			bassPunch: 0.3,
			drop: { buildActive: false, buildProgress: 0, dropEta: 99, anticipation: 0, postDropDecay: 0 },
			clock: {
				tempoBpm: state.bpm,
				beatPhase: state.beatPhase,
				beatPulse: 0,
				downbeatFlag: false,
				barIndex: state.bar,
				beatIndex: state.beat,
				phrasePos: state.phrasePos,
				phraseIndex: state.phrase
			},
			context: { sectionEnergy: state.energy, keyPitchClass: 0.3, keyConfidence: 0.6, keyMode: 'minor' }
		},
		spectrum: { bass: state.energy * 0.8, mid: state.energy * 0.6, treble: state.energy * 0.4 },
		mk2: { kick: state.beatPhase < 0.1 ? 0.7 : 0.1, sparkle: 0, impact: 0.2 }
	});
	// Lab medians for two contrasting genres (see character.ts).
	globalThis.__somaCharacters = {
		ambient: { tempo: 0.03, energy: 0.26, brightness: 0.65, bass: 0.32, noise: 0.24, punch: 0.07, motion: 0.5, valence: 0.65 },
		noise: { tempo: 0.93, energy: 0.45, brightness: 0.87, bass: 0.12, noise: 0.89, punch: 0.15, motion: 0.55, valence: 0.6 }
	};
	globalThis.__somaCharacter = (kind, serial, sinceShift, strength = 1) => ({
		...globalThis.__somaCharacters[kind],
		vector: new Float32Array(8),
		contrast: 0,
		shift: sinceShift < 2 ? 1 : 0,
		shiftSerial: serial,
		shiftStrength: strength,
		sinceShift
	});
`;

test.describe('Soma reaction', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.addInitScript(FAKES);
		await page.reload();
	});

	test('answers each character shift once, adopts an old one, and never re-fires on a remount', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const g = globalThis as any;
			const look = new SomaLook(0.27);
			const dt = 1 / 60;
			let time = 0;
			const frame = (character: unknown) => {
				time += dt;
				const beats = time * 2;
				return look.update({
					...g.__somaReactFake({ energy: 0.5, bpm: 120, beatPhase: beats % 1, beat: Math.floor(beats) % 4, bar: Math.floor(beats / 4), phrase: 0, phrasePos: 0.3 }),
					live: true,
					dt,
					aspect: 1.6,
					character
				});
			};
			// First sight long after shift 4: adopted, not answered.
			frame(g.__somaCharacter('ambient', 4, 40));
			const start = look.genome.mutations;
			for (let i = 0; i < 120; i += 1) frame(g.__somaCharacter('ambient', 4, 40 + i * dt));
			const afterAdopt = look.genome.mutations;
			// A fresh shift: answered once, however many frames carry it.
			for (let i = 0; i < 180; i += 1) frame(g.__somaCharacter('noise', 5, i * dt));
			const afterShift = look.genome.mutations;
			const glide = look.genome.glideSpeed;
			// The same look object seen again by a remounted renderer: same serial, no re-fire.
			for (let i = 0; i < 60; i += 1) frame(g.__somaCharacter('noise', 5, 3 + i * dt));
			const afterRemount = look.genome.mutations;
			const fingerprint = look.fingerprint();
			return { start, afterAdopt, afterShift, afterRemount, glide, fingerprint };
		});
		expect(result.afterAdopt).toBe(result.start);
		expect(result.afterShift).toBeGreaterThan(result.afterAdopt);
		expect(result.afterRemount).toBe(result.afterShift);
		expect(result.fingerprint).toContain('|5|');
	});

	test('ambient and noise make a different animal: calm drift versus frantic, bristling darting', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook, somaMoodTarget } = await import('/src/lib/visualizer/mk2/look.ts');
			const g = globalThis as any;
			const run = (kind: 'ambient' | 'noise', bpm: number) => {
				const look = new SomaLook(0.61);
				const dt = 1 / 60;
				let travelled = 0;
				let previous: number[] | null = null;
				let f: any = null;
				for (let i = 0; i < 60 * 20; i += 1) {
					const time = i * dt;
					const beats = (time * bpm) / 60;
					f = look.update({
						...g.__somaReactFake({ energy: 0.5, bpm, beatPhase: beats % 1, beat: Math.floor(beats) % 4, bar: Math.floor(beats / 4), phrase: 0, phrasePos: 0.3 }),
						live: true,
						dt,
						aspect: 1.6,
						character: g.__somaCharacter(kind, 0, 100)
					});
					const pos = [...f.organism.pos];
					if (previous && i > 60 * 5) travelled += Math.hypot(pos[0] - previous[0], pos[1] - previous[1], pos[2] - previous[2]);
					previous = pos;
				}
				const eye = f.camera3.pos;
				const target = f.organism.boundCenter;
				return {
					speed: travelled / 15,
					distance: Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]) / Math.max(0.1, f.organism.extent),
					spines: f.anatomy[32],
					mood: { ...f.mood }
				};
			};
			const mood = somaMoodTarget(g.__somaCharacter('ambient', 0, 100), {} as any);
			return { ambient: run('ambient', 64), noise: run('noise', 172), calmAmbient: mood.calm };
		});
		expect(result.calmAmbient).toBeGreaterThan(0.6);
		expect(result.ambient.mood.calm).toBeGreaterThan(0.6);
		expect(result.noise.mood.agitation).toBeGreaterThan(0.8);
		// Frantic darting covers far more water than calm drifting.
		expect(result.noise.speed).toBeGreaterThan(result.ambient.speed * 2);
		// Agitation bristles the body.
		expect(result.noise.spines).toBeGreaterThan(result.ambient.spines + 0.4);
		// Calm music is filmed from further back (relative to the animal's size).
		expect(result.ambient.distance).toBeGreaterThan(result.noise.distance);
	});

	test('a genre jump transforms continuously: no anatomy, camera or colour step is a cut', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { SomaLook } = await import('/src/lib/visualizer/mk2/look.ts');
			const g = globalThis as any;
			const look = new SomaLook(0.42);
			const dt = 1 / 60;
			let prev: { anatomy: number[]; eye: number[]; glow: number[] } | null = null;
			let maxAnatomy = 0;
			let maxEye = 0;
			let maxGlow = 0;
			let glowBefore: number[] = [];
			let glowAfter: number[] = [];
			for (let i = 0; i < 60 * 24; i += 1) {
				const time = i * dt;
				const switched = time >= 12;
				const bpm = switched ? 172 : 64;
				const beats = (time * bpm) / 60;
				// The character's own envelope lags the music by about a second.
				const k = switched ? 1 - Math.exp(-(time - 12) / 0.45) : 0;
				const a = g.__somaCharacters.ambient;
				const n = g.__somaCharacters.noise;
				const character = {
					...Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + (n[key] - a[key]) * k])),
					vector: new Float32Array(8),
					contrast: 0,
					shift: 0,
					shiftSerial: switched && time > 12.8 ? 2 : 1,
					shiftStrength: 1,
					sinceShift: switched && time > 12.8 ? time - 12.8 : 50
				};
				const f = look.update({
					...g.__somaReactFake({ energy: 0.5, bpm, beatPhase: beats % 1, beat: Math.floor(beats) % 4, bar: Math.floor(beats / 4), phrase: 0, phrasePos: 0.3 }),
					live: true,
					dt,
					aspect: 1.6,
					character
				});
				const now = { anatomy: Array.from(f.anatomy), eye: [...f.camera3.pos], glow: [...f.colors.glow] };
				if (prev && time > 1) {
					for (let j = 0; j < now.anatomy.length; j += 1) {
						maxAnatomy = Math.max(maxAnatomy, Math.abs(now.anatomy[j] - prev.anatomy[j]) / Math.max(1, Math.abs(prev.anatomy[j])));
					}
					maxEye = Math.max(maxEye, Math.hypot(...now.eye.map((v, j) => v - prev!.eye[j])));
					maxGlow = Math.max(maxGlow, ...now.glow.map((v, j) => Math.abs(v - prev!.glow[j])));
				}
				if (Math.abs(time - 11.9) < dt / 2) glowBefore = now.glow;
				if (Math.abs(time - 15) < dt / 2) glowAfter = now.glow;
				prev = now;
			}
			const colourMove = Math.hypot(...glowAfter.map((v, j) => v - glowBefore[j]));
			return { maxAnatomy, maxEye, maxGlow, colourMove };
		});
		// Per 60 fps frame: small steps only.
		expect(result.maxAnatomy).toBeLessThan(0.025);
		expect(result.maxEye).toBeLessThan(0.06);
		expect(result.maxGlow).toBeLessThan(0.04);
		// ...yet within 3 s the living light has clearly changed.
		expect(result.colourMove).toBeGreaterThan(0.15);
	});
});
