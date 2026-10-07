import { expect, test } from '@playwright/test';

test.describe('deterministic visualizer lab profiles', () => {
	test('publishes seven finite, repeatable, musically contrasting profiles', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const modulePath = '/src/lib/visualizer/lab/music-profiles.ts';
			const { SOMA_LAB_PROFILE_IDS, SOMA_LAB_PROFILES } = await import(modulePath);
			const samples = Object.fromEntries(
				SOMA_LAB_PROFILE_IDS.map((id: string) => {
					const profile = SOMA_LAB_PROFILES[id];
					const stage = profile.stages.find((candidate: any) => candidate.id !== 'intro') ?? profile.stages[0];
					const first = profile.frameAt(stage.atMs, 'repeatable-seed');
					const repeated = profile.frameAt(stage.atMs, 'repeatable-seed');
					const alternate = profile.frameAt(stage.atMs, 'alternate-seed');
					return [
						id,
						{
							first,
							repeated,
							alternate,
							stageIds: profile.stages.map((candidate: any) => candidate.id),
							energyFinite: profile.score.energy_curve.every(Number.isFinite)
						}
					];
				})
			);
			return { ids: SOMA_LAB_PROFILE_IDS, samples };
		});

		expect(result.ids).toEqual([
			'club128',
			'swing86',
			'indie118',
			'ambient64',
			'acoustic94',
			'noise172',
			'cinematic72'
		]);
		for (const sample of Object.values(result.samples) as Array<any>) {
			expect(sample.repeated).toEqual(sample.first);
			expect(sample.alternate.bins).not.toEqual(sample.first.bins);
			expect(sample.first.bins).toHaveLength(64);
			expect(sample.first.bins.every(Number.isFinite)).toBe(true);
			expect(sample.energyFinite).toBe(true);
			expect(sample.stageIds.length).toBeGreaterThanOrEqual(5);
		}

		expect(result.samples.club128.first.bass).toBeGreaterThan(
			result.samples.indie118.first.bass
		);
		expect(result.samples.indie118.first.mid).toBeGreaterThan(
			result.samples.swing86.first.mid
		);
		expect(result.samples.noise172.first.treble).toBeGreaterThan(
			result.samples.acoustic94.first.treble
		);
		expect(result.samples.acoustic94.first.peak / result.samples.acoustic94.first.rms).toBeGreaterThan(
			result.samples.ambient64.first.peak / result.samples.ambient64.first.rms + 1
		);
	});

	test('URL, controls, and lab API select and settle a score-backed stage', async ({ page }) => {
		await page.goto(
			'/visualizer-test?engine=mk2&profile=swing86&stage=verse&seed=contract-test&chrome=1'
		);

		const lab = page.locator('[data-visualizer-lab]');
		await expect(lab).toHaveAttribute('data-lab-profile', 'swing86');
		await expect(lab).toHaveAttribute('data-lab-stage', 'verse');
		await expect(lab).toHaveAttribute('data-lab-seed', 'contract-test');
		await expect(lab).toHaveAttribute('data-lab-ready', 'true');
		await expect(page.getByLabel('Music profile')).toHaveValue('swing86');
		await expect(page.getByLabel('Song stage')).toHaveValue('verse');
		await expect(page.getByLabel('Profile seed')).toHaveValue('contract-test');

		const initial = await page.evaluate(async () => {
			const api = (window as any).__MEWSIK_LAB__;
			if (!api) throw new Error('visualizer lab API was not installed');
			return api.settle(4);
		});
		expect(initial.profile).toBe('swing86');
		expect(initial.stage).toBe('verse');
		expect(initial.latest.bpm).toBe(86);
		expect(initial.journey.director.context.source).toBe('score');
		expect(initial.journey.director.section).toBe('verse');

		const changed = await page.evaluate(async () => {
			const api = (window as any).__MEWSIK_LAB__;
			const selected = api.select('noise172', 'build', 'noise-seed');
			const snapshot = await api.settle(4);
			return { selected, snapshot, search: location.search };
		});
		expect(changed.selected).toBe(true);
		expect(changed.snapshot.profile).toBe('noise172');
		expect(changed.snapshot.stage).toBe('build');
		expect(changed.snapshot.seed).toBe('noise-seed');
		expect(changed.snapshot.latest.bpm).toBe(172);
		expect(changed.snapshot.journey.director.context.source).toBe('score');
		expect(changed.snapshot.journey.director.section).toBe('build');
		expect(changed.search).toContain('engine=mk2');
		expect(changed.search).toContain('profile=noise172');
		expect(changed.search).toContain('stage=build');
		expect(changed.search).toContain('seed=noise-seed');
		expect(changed.search).toContain('chrome=1');
		await expect(lab).toHaveAttribute('data-lab-profile', 'noise172');
		await expect(lab).toHaveAttribute('data-lab-stage', 'build');
	});
});
