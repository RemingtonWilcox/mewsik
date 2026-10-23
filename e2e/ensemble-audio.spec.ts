import { expect, test } from '@playwright/test';
import { encodeWav, ensembleSignal } from '../src/lib/visualizer/lab/ensemble-signals';

// The ensemble listener on real signals: synthesised test music (known
// chords, drum hits, swing, fills, articulation, drop-outs) rendered through
// the lab's file path (WebAnalyzer in an OfflineAudioContext, which reads its
// analyser nodes exactly as a live frame would) into a fresh journey.
type Eval = Awaited<ReturnType<typeof import('../src/lib/visualizer/lab/ensemble-eval').evaluateEnsemble>>;

async function evaluate(page: import('@playwright/test').Page, id: string): Promise<Eval> {
	return page.evaluate(async (id) => {
		const { ensembleSignal } = await import('/src/lib/visualizer/lab/ensemble-signals.ts');
		const { analyzeOffline } = await import('/src/lib/audio/offline-analysis.ts');
		const { evaluateEnsemble } = await import('/src/lib/visualizer/lab/ensemble-eval.ts');
		const signal = ensembleSignal(id as never);
		const frames = await analyzeOffline(signal.left, signal.right, signal.sampleRate);
		const result = evaluateEnsemble(signal, frames);
		return { ...result, timeline: [] };
	}, id);
}

test.describe('ensemble listening on real signals', () => {
	test.setTimeout(120_000);

	test('C - Am - F - G - Bdim: every change, root and quality, within 450 ms', async ({ page }) => {
		await page.goto('/');
		const r = await evaluate(page, 'progression');
		expect(r.chords!.matched).toBe(r.chords!.changes);
		expect(Math.max(...r.chords!.latencyMs)).toBeLessThan(450);
		expect(r.chords!.rootAccuracy).toBeGreaterThan(0.95);
		expect(r.chords!.qualityAccuracy).toBeGreaterThan(0.95);
		// At most one spurious change per ten chords.
		expect(r.chords!.detected - r.chords!.changes).toBeLessThanOrEqual(3);
		expect(r.tickMs).toBeLessThan(0.3);
	});

	test('drum layers, tempo and swing: a straight loop against the same loop swung 2:1', async ({ page }) => {
		await page.goto('/');
		const straight = await evaluate(page, 'drums-straight');
		const swung = await evaluate(page, 'drums-swung');
		for (const r of [straight, swung]) {
			expect(Math.abs(r.bpm - 100)).toBeLessThan(1.5);
			const d = r.drums!;
			expect(d.kick.matched / d.kick.truth).toBeGreaterThan(0.95);
			expect(d.snare.matched / d.snare.truth).toBeGreaterThan(0.95);
			// Hats under a snare are left to the snare; the rest are heard.
			expect(d.hat.matched / d.hat.truth).toBeGreaterThan(0.7);
			expect(d.kick.hits - d.kick.matched).toBeLessThanOrEqual(1);
			expect(d.snare.hits - d.snare.matched).toBeLessThanOrEqual(1);
			expect(d.hat.hits - d.hat.matched).toBeLessThanOrEqual(2);
			expect(d.kick.latencyMs).toBeLessThan(60);
			expect(r.fills!.falsePositives).toBe(0);
		}
		expect(straight.swing!.ratio).toBeLessThan(1.15);
		expect(swung.swing!.ratio).toBeGreaterThan(1.75);
		expect(swung.swing!.ratio).toBeLessThan(2.3);
	});

	test('a fill every 4th bar is caught once the groove is learned, quickly and without false alarms', async ({ page }) => {
		await page.goto('/');
		const r = await evaluate(page, 'drums-fills');
		expect(Math.abs(r.bpm - 120)).toBeLessThan(1.5);
		// The first fill comes before two bars of groove are known.
		expect(r.fills!.caught).toBeGreaterThanOrEqual(3);
		expect(r.fills!.falsePositives).toBe(0);
		expect(Math.max(...r.fills!.latencyMs)).toBeLessThan(600);
	});

	test('the same line plucked and held reads staccato and legato', async ({ page }) => {
		await page.goto('/');
		const staccato = await evaluate(page, 'line-staccato');
		const legato = await evaluate(page, 'line-legato');
		expect(staccato.articulation!.legato).toBeLessThan(0.25);
		expect(legato.articulation!.legato).toBeGreaterThan(0.55);
		expect(legato.articulation!.sustain).toBeGreaterThan(staccato.articulation!.sustain + 0.2);
		for (const r of [staccato, legato]) expect(Math.abs(r.bpm - 110)).toBeLessThan(3);
	});

	test('a breakdown drops the drums out and their return is heard', async ({ page }) => {
		await page.goto('/');
		const r = await evaluate(page, 'breakdown');
		const b = r.breakdown!;
		expect(b.dropouts.length).toBe(1);
		expect(b.dropoutLatencyMs[0]).toBeGreaterThan(0);
		expect(b.dropoutLatencyMs[0]).toBeLessThan(1500);
		expect(b.returns.length).toBe(1);
		expect(b.returnLatencyMs[0]).toBeLessThan(600);
		expect(b.breakdownMid).toBeGreaterThan(0.8);
		expect(b.drumsMid).toBeLessThan(0.25);
		// The chords keep being heard through it.
		expect(r.chords!.rootAccuracy).toBeGreaterThan(0.95);
	});

	test('the lab file picker plays a WAV through the live analyzer into the ensemble', async ({ page }) => {
		const signal = ensembleSignal('progression');
		// The first six bars: C, Am, F, G, Bdim, C.
		const frames = Math.round(signal.sampleRate * 12.5);
		const wav = encodeWav(signal.left.subarray(0, frames), signal.right.subarray(0, frames), signal.sampleRate);
		await page.goto('/visualizer-test?engine=signal&chrome=1&ensemble=1');
		await expect(page.locator('[data-visualizer-lab][data-lab-ready="true"]')).toBeVisible({ timeout: 60_000 });
		await expect(page.locator('[data-ensemble-overlay]')).toBeVisible();
		await page.locator('input[type="file"]').setInputFiles({
			name: 'progression.wav',
			mimeType: 'audio/wav',
			buffer: Buffer.from(wav)
		});
		const seen = await page.evaluate(async () => {
			const lab = (window as unknown as { __MEWSIK_LAB__: { snapshot(): { journey: any } } }).__MEWSIK_LAB__;
			const roots: number[] = [];
			const started = performance.now();
			while (performance.now() - started < 11_000) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				const root = lab.snapshot().journey.ensemble.harmony.root;
				if (root >= 0 && roots[roots.length - 1] !== root) roots.push(root);
			}
			return roots;
		});
		// C, A, F, G, B in order (a live player may start a little late).
		const order = [0, 9, 5, 7, 11];
		const heard = seen.filter((root) => order.includes(root));
		let matched = 0;
		for (const root of heard) if (root === order[matched]) matched += 1;
		expect(matched, `roots heard: ${seen.join(',')}`).toBeGreaterThanOrEqual(4);
	});
});
