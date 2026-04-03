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
		await expect(page.getByRole('heading', { name: 'mewsik' })).toBeVisible();
		await expect(page.getByText('Library, search, radio, and recommendations in one player.')).toBeVisible();
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

		await page.locator('a[href="/discover"]').first().click();
		await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();

		await page.locator('a[href="/downloads"]').first().click();
		await expect(page.locator('h1').filter({ hasText: 'Downloads' })).toBeVisible();

		await page.locator('a[href="/settings"]').first().click();
		await expect(page.locator('h1').filter({ hasText: 'Settings' })).toBeVisible();
	});

	test('command palette opens from app event wiring', async ({ page }) => {
		await page.goto('/');
		await page.waitForTimeout(200);
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent('toggle-command', { bubbles: true }));
		});
		const dialog = page.locator('[data-slot="dialog-content"]');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByPlaceholder('Search songs, artists, albums...')).toBeVisible();
	});
});
