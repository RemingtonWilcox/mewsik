import { expect, test } from '@playwright/test';

test.describe('station discovery flow', () => {
	test('editorial stations keep real, unique Radio Browser recovery ids', async ({ page }) => {
		await page.goto('/stations');
		const catalog = await page.evaluate(async () => {
			const { curatedStations, curatedCollections } = await import('/src/lib/radio/curated.ts');
			return {
				ids: curatedStations.map((station) => station.stationuuid),
				collectionCount: curatedCollections.length,
				allCollectionStations: curatedCollections.flatMap((collection) =>
					collection.stations.map((station) => station.stationuuid)
				)
			};
		});

		expect(catalog.ids).toHaveLength(22);
		expect(catalog.collectionCount).toBe(7);
		expect(new Set(catalog.ids).size).toBe(catalog.ids.length);
		expect(catalog.ids.every((id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))).toBe(true);
		expect(catalog.allCollectionStations.every((id) => catalog.ids.includes(id))).toBe(true);
	});

	test('keeps search first, separates Discover, Favorites, and Directory, and renders the shelf UI honestly without a feed', async ({
		page
	}) => {
		await page.goto('/stations');

		const search = page.getByRole('textbox', { name: 'Search radio stations' });
		await expect(search).toBeVisible();
		await expect(page.getByRole('button', { name: 'Discover' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		// No backend in the browser lab: the feed falls back to `empty`, so the
		// scene chips still render and the page says so instead of faking picks.
		await expect(page.getByRole('heading', { name: 'Scenes' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Workout', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Hip-hop', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Refresh picks', exact: true })).toBeVisible();
		await expect(page.getByText('Nothing cached yet').first()).toBeVisible();
		await expect(page.getByRole('heading', { name: 'No station picks yet' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Refresh picks now' })).toBeVisible();

		// The hero falls back to the first editor pick and keeps the Play naming.
		await expect(page.getByRole('button', { name: 'Play Liquid DnB' })).toBeVisible();

		// A scene chip that has no shelf opens its "See all" list in place.
		await page.getByRole('button', { name: 'Workout', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Workout' })).toBeVisible();
		await expect(page.getByText('No cached stations for Workout yet')).toBeVisible();
		await page.getByRole('button', { name: 'Hide Workout' }).click();
		await expect(page.getByRole('heading', { name: 'Workout' })).toHaveCount(0);

		await expect(page.getByRole('button', { name: 'Favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Favorites' }).click();
		await expect(page.getByRole('button', { name: 'Favorites' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.getByRole('heading', { name: 'Your dial is empty' })).toBeVisible();

		await page.getByRole('button', { name: 'Discover' }).click();

		// Editor picks live in one collapsed shelf at the bottom.
		const editorPicks = page.getByRole('button', { name: 'Editor picks' });
		await expect(editorPicks).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByRole('button', { name: /Deep focus/ })).toHaveCount(0);
		await editorPicks.click();
		await expect(editorPicks).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('button', { name: /Deep focus/ }).click();
		await expect(
			page.getByRole('button', { name: 'Play SomaFM Groove Salad' }).first()
		).toBeVisible();
		await expect(page.getByText('Checking stream').first()).toBeVisible();

		await page.getByRole('button', { name: 'Directory' }).click();
		await expect(page.getByRole('heading', { name: 'Station directory' })).toBeVisible();
		await expect(page.getByRole('combobox', { name: 'Sort stations' })).toHaveValue('smart');
		await expect(page.getByLabel('About station ranking')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Jazz', exact: true })).toBeVisible();

		await search.fill('jazz');
		await expect(page.getByRole('button', { name: 'Directory' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.getByRole('heading', { name: 'No stations found' })).toBeVisible();

		await page.getByRole('button', { name: 'Clear station search' }).click();
		await expect(page.getByRole('button', { name: 'Directory' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.getByRole('heading', { name: 'Station directory' })).toBeVisible();

		await page.getByRole('button', { name: 'Discover' }).click();
		await expect(page.getByRole('heading', { name: 'No station picks yet' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Workout', exact: true })).toBeVisible();
	});
});
