import { expect, test, type Page } from '@playwright/test';

type StationInvocation = { command: string; args: Record<string, unknown> };

/** A desktop runtime stub with a ready feed: a dead pick leads (as a stale
 *  cache could), a healthy verified pick follows, and an unverified pick
 *  trails. Playing the dead one fails the way the backend reports it. */
async function installStationRuntime(page: Page) {
	await page.addInitScript(() => {
		const runtimeWindow = window as Window & {
			__STATION_INVOCATIONS__?: StationInvocation[];
			__TAURI_INTERNALS__?: {
				invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
				transformCallback: () => number;
				unregisterCallback: () => void;
			};
		};
		type StationInvocation = { command: string; args: Record<string, unknown> };
		runtimeWindow.__STATION_INVOCATIONS__ = [];
		const station = (uuid: string, name: string, tags: string) => ({
			name,
			url: `https://radio.example/${uuid}`,
			homepage: null,
			favicon: null,
			country: 'United States',
			language: 'english',
			tags,
			codec: 'MP3',
			bitrate: 128,
			votes: 100,
			clickcount: 50,
			clicktrend: 0,
			stationuuid: uuid
		});
		const pick = (uuid: string, name: string, verified: boolean) => ({
			station: station(uuid, name, 'hip hop,rap'),
			sceneId: 'hip-hop',
			reason: 'Popular in Hip-hop',
			score: 3,
			bailRate: 0,
			plays: 0,
			verified,
			lastCheckedAt: verified ? '2026-10-07T00:00:00+00:00' : null
		});
		const feed = {
			generatedAt: '2026-10-07T12:00:00+00:00',
			status: 'ready',
			cacheAgeSeconds: 120,
			scenes: [],
			shelves: [
				{
					id: 'fresh',
					kind: 'fresh',
					title: 'Fresh today',
					subtitle: 'A new deal across every scene, rotating daily',
					sceneId: null,
					items: [
						pick('00000000-0000-4000-8000-000000000001', 'VINYL 90S :: Hip Hop, Rap, Trap, Techno, House, Jazz | www.vinyl90s.example [128kbps]', true),
						pick('00000000-0000-4000-8000-000000000002', 'Golden Era Radio', true),
						pick('00000000-0000-4000-8000-000000000003', 'Unchecked FM', false)
					]
				}
			]
		};
		runtimeWindow.__TAURI_INTERNALS__ = {
			invoke: async (command, args = {}) => {
				runtimeWindow.__STATION_INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'get_station_discovery':
						return feed;
					case 'play_station_search_result':
						if (args.stationuuid === '00000000-0000-4000-8000-000000000001') {
							throw 'station_unavailable: Station is unavailable and no working replacement stream was found';
						}
						return 'local-station-id';
					case 'search_radio_stations_by_tags':
						return [station('00000000-0000-4000-8000-000000000009', 'Tag Merge Hip Hop', 'hip hop')];
					case 'browse_radio_stations':
						return { items: [], next_offset: 0, has_more: false };
					case 'get_favorite_stations':
					case 'verify_station_urls':
					case 'verify_favorite_stations':
					case 'get_radio_station_details':
					case 'search_radio_stations_advanced':
					case 'get_scene_stations':
						return [];
					default:
						return null;
				}
			},
			transformCallback: () => 1,
			unregisterCallback: () => {}
		};
	});
}

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

	test('the hero only features verified picks and a pick that fails to play is dropped at once', async ({
		page
	}) => {
		await installStationRuntime(page);
		await page.goto('/stations');

		// Station names are cleaned for display: no slogan, genre list, URL or bitrate.
		const hero = page.getByRole('heading', { name: 'VINYL 90S' });
		await expect(hero).toBeVisible();
		await expect(page.getByText('www.vinyl90s.example')).toHaveCount(0);

		// Unverified picks trail the shelf and never take the hero. Only they
		// are probed locally; verified picks were checked by the backend.
		await expect(page.getByRole('button', { name: 'Play Unchecked FM' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Unchecked FM' })).toHaveCount(0);
		await expect(page.getByTitle('Stream checked').first()).toBeVisible();
		const probed = await page.evaluate(() =>
			(window as Window & { __STATION_INVOCATIONS__?: StationInvocation[] }).__STATION_INVOCATIONS__
				?.filter((call) => call.command === 'verify_station_urls')
				.flatMap((call) => call.args.urls as string[])
		);
		expect(probed).toEqual(['https://radio.example/00000000-0000-4000-8000-000000000003']);

		await page.getByRole('button', { name: 'Play VINYL 90S' }).first().click();
		await expect(page.getByText('VINYL 90S is off the air. Removed from picks.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Play VINYL 90S' })).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Golden Era Radio' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Play Golden Era Radio' }).first()).toBeVisible();
	});

	test('a Directory genre chip queries its real tag set', async ({ page }) => {
		await installStationRuntime(page);
		await page.goto('/stations');
		await page.getByRole('button', { name: 'Directory' }).click();
		await page.getByRole('button', { name: 'Hip-hop', exact: true }).click();
		await expect(page.getByText('Tag Merge Hip Hop')).toBeVisible();
		const invocation = await page.evaluate(() =>
			(
				window as Window & { __STATION_INVOCATIONS__?: StationInvocation[] }
			).__STATION_INVOCATIONS__?.find((call) => call.command === 'search_radio_stations_by_tags')
		);
		expect(invocation?.args.tags).toEqual(['hip hop', 'hiphop', 'hip-hop', 'rap']);
	});
});
