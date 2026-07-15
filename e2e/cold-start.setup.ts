import { expect, test } from '@playwright/test';

const routes = [
	{ path: '/', heading: 'mewsik' },
	{ path: '/search', heading: 'Search' },
	{ path: '/library', heading: 'Library' },
	{ path: '/stations', heading: 'Stations' },
	{ path: '/discover', heading: 'Discover' },
	{ path: '/downloads', heading: 'Downloads' },
	{ path: '/settings', heading: 'Settings' }
];

test('warms the Vite route graph before parallel browser tests', async ({ page }) => {
	for (const route of routes) {
		await page.goto(route.path);
		const heading = page.getByRole('heading', { name: route.heading, exact: true }).first();
		await expect(heading).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(300);
		await expect(heading).toBeVisible();
	}

	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'mewsik', exact: true }).first()).toBeVisible({
		timeout: 30_000
	});

	await expect
		.poll(
			async () => {
				try {
					return await page.evaluate(async () => {
						const modulePath = '/src/lib/state/visualizer.svelte.ts';
						await import(modulePath);
						return true;
					});
				} catch {
					return false;
				}
			},
			{ timeout: 30_000, intervals: [250, 500, 1_000] }
		)
		.toBe(true);

	await page.reload();
	await expect(page.getByRole('heading', { name: 'mewsik', exact: true }).first()).toBeVisible({
		timeout: 30_000
	});
});
