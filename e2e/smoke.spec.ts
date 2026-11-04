import { expect, test } from '@playwright/test';

test.describe('app smoke', () => {
	test('home renders without runtime errors', async ({ page }) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];

		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text());
			}
		});
		page.on('pageerror', (error) => {
			pageErrors.push(String(error));
		});

		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await expect(page).toHaveURL(/\/library$/);
		await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
		expect(consoleErrors).toEqual([]);
		expect(pageErrors).toEqual([]);
	});

	test('sidebar routes render expected headings', async ({ page }) => {
		await page.goto('/');

		await page.locator('a[href="/search"]').first().click();
		await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();

		await page.locator('a[href="/library"]').first().click();
		await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

		await page.locator('a[href="/stations"]').first().click();
		await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();

		await page.locator('a[href="/downloads"]').first().click();
		await expect(page.locator('h1').filter({ hasText: 'Downloads' })).toBeVisible();

		await page.locator('a[href="/settings"]').first().click();
		await expect(page.locator('h1').filter({ hasText: 'Settings' })).toBeVisible();
	});

	test('Ctrl+K jumps to search with the box focused', async ({ page }) => {
		await page.goto('/library');
		await page.waitForLoadState('networkidle');
		await page.keyboard.press('Control+k');
		await expect(page).toHaveURL(/\/search/);
		await expect(page.locator('[data-search-input]')).toBeFocused();
	});

	test('space on an interactive control does not toggle playback', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await page.evaluate(() => {
			(window as Window & { __playbackToggleCount?: number }).__playbackToggleCount = 0;
			window.addEventListener('toggle-playback', () => {
				const auditWindow = window as Window & { __playbackToggleCount?: number };
				auditWindow.__playbackToggleCount = (auditWindow.__playbackToggleCount ?? 0) + 1;
			});
		});

		const settingsLink = page.getByRole('link', { name: 'Settings' }).first();
		await settingsLink.focus();
		await page.keyboard.press('Space');

		await expect
			.poll(() =>
				page.evaluate(
					() => (window as Window & { __playbackToggleCount?: number }).__playbackToggleCount
				)
			)
			.toBe(0);
	});
});
