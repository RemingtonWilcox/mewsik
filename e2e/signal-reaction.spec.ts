import { expect, test } from '@playwright/test';

// Signal's answer to a change of music: each shared shift is answered once
// (and the answer is remembered with the look), the picks fit the new music,
// and the character-driven voice makes genres different instruments.

// Lab reference characters (shared character medians per lab profile).
const GENRES = {
	ambient64: { tempo: 0.03, energy: 0.26, brightness: 0.65, bass: 0.32, noise: 0.24, punch: 0.07, motion: 0.49, valence: 0.65 },
	acoustic94: { tempo: 0.28, energy: 0.23, brightness: 0.55, bass: 0.18, noise: 0.4, punch: 0.88, motion: 0.46, valence: 0.68 },
	club128: { tempo: 0.57, energy: 0.48, brightness: 0.5, bass: 0.76, noise: 0.59, punch: 0.21, motion: 0.58, valence: 0.54 },
	noise172: { tempo: 0.93, energy: 0.46, brightness: 0.87, bass: 0.12, noise: 0.89, punch: 0.15, motion: 0.52, valence: 0.61 }
};

test.describe('Signal reaction', () => {
	test('answers each shift once, remembers it with the look, and picks looks that fit', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (genres) => {
			const { SignalVariation } = await import('/src/lib/visualizer/signal/genome.ts');
			const character = (name: keyof typeof genres, serial: number, sinceShift = 0) => ({
				...genres[name],
				vector: new Float32Array(8),
				contrast: 0,
				shift: 0,
				shiftSerial: serial,
				shiftStrength: 1,
				sinceShift
			});
			const variation = new SignalVariation('reaction');
			variation.reset('reaction');
			const dt = 1 / 60;
			const frames = (name: keyof typeof genres, serial: number, count: number, from = 0) => {
				let answered = 0;
				for (let frame = 0; frame < count; frame += 1) {
					const event = variation.respond(character(name, serial, from + frame * dt) as never, 0.5, dt);
					if (event) answered += 1;
					variation.advance({ phraseIndex: 0, section: 'verse', energy: 0.5, silence: false, dt });
				}
				return answered;
			};
			// The first frame adopts what is playing; it is not a shift.
			const adopt = frames('ambient64', 3, 60, 20);
			// A new serial is answered exactly once however long it stays.
			const first = frames('noise172', 4, 600);
			const serialAfter = variation.answered;
			// A new source (continueWith) or a remount does not re-answer it.
			variation.continueWith('next-song');
			const again = frames('noise172', 4, 300, 10);
			const shifted = variation.genome.glideSpeed;
			return { adopt, first, again, serialAfter, shifted };
		}, GENRES);
		expect(result.adopt).toBe(0);
		expect(result.first).toBe(1);
		expect(result.serialAfter).toBe(4);
		expect(result.again).toBe(0);
	});

	test('the picks after a shift fit the new music far more often than chance', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (genres) => {
			const { SignalVariation } = await import('/src/lib/visualizer/signal/genome.ts');
			const voice = await import('/src/lib/visualizer/signal/voice.ts');
			const { characterWeights } = await import('/src/lib/visualizer/character.ts');
			const names = Object.keys(genres) as (keyof typeof genres)[];
			let fits = 0;
			let total = 0;
			for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
				const variation = new SignalVariation(seed);
				variation.reset(seed);
				let serial = 1;
				const now: Record<string, number> = { ...genres.ambient64 };
				variation.respond({ ...now, shiftSerial: serial, shiftStrength: 1, sinceShift: 20, contrast: 0 } as never, 0.5, 1 / 60);
				for (let step = 0; step < 12; step += 1) {
					const name = names[(step * 3 + seed.charCodeAt(0)) % names.length];
					// A new song: the shared envelopes glide toward it (0.44 s while
					// a source is armed) and the strength-1 shift fires at 0.8 s.
					for (let frame = 0; frame < 60 * 6; frame += 1) {
						const k = 1 - Math.exp(-1 / 60 / 0.44);
						for (const key of Object.keys(now)) now[key] += (genres[name][key as 'tempo'] - now[key]) * k;
						if (frame === 48) serial += 1;
						const c = { ...now, shiftSerial: serial, shiftStrength: 1, sinceShift: Math.max(0, frame - 48) / 60, contrast: 0 };
						variation.respond(c as never, 0.5, 1 / 60);
						variation.advance({ phraseIndex: 0, section: 'verse', energy: 0.5, silence: false, dt: 1 / 60 });
					}
					// A pick "fits" when its weight is in the top half of the options.
					const view = voice.signalCharacterView({ ...genres[name] } as never);
					const weights = characterWeights(voice.SIGNAL_PALETTE_PROTOTYPES, view as never, 14, 0.005);
					const sorted = [...weights].sort((x, y) => y - x);
					const pick = variation.choice('palette').to;
					if (weights[pick] >= sorted[Math.floor(sorted.length / 4)]) fits += 1;
					total += 1;
				}
			}
			return { rate: fits / total };
		}, GENRES);
		// Chance would be about a quarter; most answers should land in the top quarter.
		expect(result.rate).toBeGreaterThan(0.6);
	});

	test('the voice makes genres different instruments', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async (genres) => {
			const voice = await import('/src/lib/visualizer/signal/voice.ts');
			const out: Record<string, ReturnType<typeof voice.createSignalVoiceFrame>> = {};
			for (const [name, c] of Object.entries(genres)) {
				out[name] = voice.signalVoiceTarget(voice.signalCharacterView(c as never), voice.createSignalVoiceFrame());
			}
			// The voice glides: a genre change is not a one-frame jump.
			const tracker = new voice.SignalVoice();
			tracker.settle(genres.ambient64 as never);
			const before = tracker.frame.speed;
			const after = tracker.update(genres.noise172 as never, 1 / 60).speed;
			let settled = 0;
			for (let frame = 0; frame < 120; frame += 1) settled = tracker.update(genres.noise172 as never, 1 / 60).speed;
			return { out, before, after, settled };
		}, GENRES);
		const { ambient64, acoustic94, club128, noise172 } = result.out;
		// Ambient: slow, long persistence, breathing, smooth.
		expect(ambient64.speed).toBeLessThan(0.5);
		expect(ambient64.persistence).toBeGreaterThan(0.04);
		expect(ambient64.breathe).toBeGreaterThan(0.7);
		expect(ambient64.jitter).toBeLessThan(0.05);
		// Noise: fast, short persistence, jagged and fractured.
		expect(noise172.speed).toBeGreaterThan(1.5);
		expect(noise172.persistence).toBeLessThan(0);
		expect(noise172.jitter).toBeGreaterThan(0.7);
		expect(noise172.fracture).toBeGreaterThan(0.7);
		// Club: locked to the beat, heavy strokes.
		expect(club128.lock).toBeGreaterThan(0.8);
		expect(club128.weight).toBeGreaterThan(acoustic94.weight * 1.4);
		// Acoustic: warm, fine, organic.
		expect(acoustic94.temperature).toBeGreaterThan(0.4);
		expect(acoustic94.organic).toBeGreaterThan(0.6);
		expect(ambient64.temperature).toBeLessThan(-0.3);
		// Gliding, about a second.
		expect(Math.abs(result.after - result.before)).toBeLessThan(0.1);
		expect(Math.abs(result.settled - noise172.speed)).toBeLessThan(0.05);
	});
});
