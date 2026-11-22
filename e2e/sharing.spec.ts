import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type Invocation = { command: string; args: Record<string, unknown> };

const RANDOM_UUID = '11111111-2222-4333-8444-555555555555';

/** Desktop runtime stub: the directory always deals the same random station. */
async function installRuntime(page: Page) {
	await page.addInitScript((randomUuid) => {
		const runtimeWindow = window as Window & {
			__INVOCATIONS__?: Invocation[];
			__TAURI_INTERNALS__?: unknown;
		};
		type Invocation = { command: string; args: Record<string, unknown> };
		runtimeWindow.__INVOCATIONS__ = [];
		const random = {
			name: 'Radio Kakadu',
			url: 'https://radio.example/kakadu',
			homepage: null,
			favicon: null,
			country: 'Australia',
			language: 'english',
			tags: 'jazz',
			codec: 'MP3',
			bitrate: 128,
			stationuuid: randomUuid
		};
		runtimeWindow.__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'random_station':
						return random;
					case 'play_station_search_result':
						return 'local-station-id';
					case 'get_station_discovery':
						return { generatedAt: null, status: 'empty', cacheAgeSeconds: null, scenes: [], shelves: [] };
					case 'browse_radio_stations':
						return { items: [], next_offset: 0, has_more: false };
					case 'get_favorite_stations':
					case 'verify_station_urls':
					case 'verify_favorite_stations':
					case 'get_radio_station_details':
						return [];
					default:
						return null;
				}
			},
			transformCallback: () => 1,
			unregisterCallback: () => {}
		};
	}, RANDOM_UUID);
}

test('the random station button plays whatever the directory deals', async ({ page }) => {
	await installRuntime(page);
	await page.goto('/stations');
	await page.getByTestId('random-station').click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as Window & { __INVOCATIONS__?: Invocation[] }).__INVOCATIONS__?.find(
					(call) => call.command === 'play_station_search_result'
				)?.args.stationuuid
			)
		)
		.toBe(RANDOM_UUID);
	await expect(page.getByText('Radio Kakadu · Australia')).toBeVisible();
});

test('share links round-trip stations and playlists', async ({ page }) => {
	await page.goto('/');
	const result = await page.evaluate(async (uuid) => {
		const share = await import('/src/lib/share.ts');
		const tracks = [
			{ t: 'Teardrop', a: 'Massive Attack', d: 330_000 },
			{ t: 'Nightcall', a: 'Kavinsky', s: 'youtube', i: 'MV_3Dpw-BRY' },
			{ t: 'Ünïcode & spaces / slashes', a: '' }
		];
		const playlistUrl = await share.playlistShareUrl('Late night ✨', tracks);
		const data = new URL(playlistUrl).hash.slice(1);
		const stationUrl = share.stationShareUrl(uuid.toUpperCase());
		return {
			playlistUrl,
			fromPage: await share.parseAppLink(playlistUrl),
			fromApp: await share.parseAppLink(`mewsik://playlist/${data}`),
			fromOldPage: await share.parseAppLink(`https://remingtonwilcox.github.io/mewsik/open/#playlist=${data}`),
			stationUrl,
			station: await share.parseAppLink(stationUrl),
			stationApp: await share.parseAppLink(`mewsik://station/${uuid}`),
			stationOld: await share.parseAppLink(
				`https://remingtonwilcox.github.io/mewsik/open/#station=${uuid}&name=Radio+Kakadu&where=Australia`
			),
			junk: await share.parseAppLink('mewsik://playlist/not-a-playlist'),
			other: await share.parseAppLink('https://example.com/#station=' + uuid)
		};
	}, RANDOM_UUID);

	expect(result.playlistUrl.startsWith('https://remingtonwilcox.github.io/mewsik/p/#')).toBe(true);
	const expected = {
		kind: 'playlist',
		playlist: {
			v: 1,
			n: 'Late night ✨',
			t: [
				{ t: 'Teardrop', a: 'Massive Attack', d: 330_000 },
				{ t: 'Nightcall', a: 'Kavinsky', s: 'youtube', i: 'MV_3Dpw-BRY' },
				{ t: 'Ünïcode & spaces / slashes', a: '' }
			]
		}
	};
	expect(result.fromPage).toEqual(expected);
	expect(result.fromApp).toEqual(expected);
	expect(result.fromOldPage).toEqual(expected);
	// Short: the UUID's 16 bytes as 22 characters.
	expect(result.stationUrl).toMatch(/^https:\/\/remingtonwilcox\.github\.io\/mewsik\/s\/#[\w-]{22}$/);
	expect(result.station).toEqual({ kind: 'station', uuid: RANDOM_UUID });
	expect(result.stationApp).toEqual({ kind: 'station', uuid: RANDOM_UUID });
	expect(result.stationOld).toEqual({ kind: 'station', uuid: RANDOM_UUID });
	expect(result.junk).toBeNull();
	expect(result.other).toBeNull();
});

test('the share page shows the playlist and hands it to the app', async ({ page }) => {
	await page.goto('/');
	const url = await page.evaluate(async () => {
		const share = await import('/src/lib/share.ts');
		return share.playlistShareUrl('Road trip', [
			{ t: 'Midnight City', a: 'M83' },
			{ t: 'Kids', a: 'MGMT' }
		]);
	});
	await serveSharePage(page);
	await page.goto(url);
	await expect(page.getByRole('heading', { name: 'Road trip' })).toBeVisible();
	await expect(page.getByText('2 songs')).toBeVisible();
	await expect(page.getByText('M83 – Midnight City')).toBeVisible();
	const href = await page.getByRole('link', { name: 'Open in mewsik' }).getAttribute('href');
	expect(href).toBe(`mewsik://playlist/${new URL(url).hash.slice(1)}`);
});

test('a short station link names the station and hands its UUID to the app', async ({ page }) => {
	await page.goto('/');
	const url = await page.evaluate(async (uuid) => {
		const share = await import('/src/lib/share.ts');
		return share.stationShareUrl(uuid);
	}, RANDOM_UUID);
	await serveSharePage(page);
	await page.route('https://*.api.radio-browser.info/**', (route) =>
		route.fulfill({
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*' },
			body: JSON.stringify([{ name: 'Radio Kakadu', country: 'Australia', tags: 'jazz,swing,blues' }])
		})
	);
	await page.goto(url);
	await expect(page.getByRole('heading', { name: 'Radio Kakadu' })).toBeVisible();
	await expect(page.getByText('Australia · jazz, swing')).toBeVisible();
	const href = await page.getByRole('link', { name: 'Open in mewsik' }).getAttribute('href');
	expect(href).toBe(`mewsik://station/${RANDOM_UUID}`);
});

test('in Instagram the share page says to open the link in a browser', async ({ browser }) => {
	const context = await browser.newContext({
		userAgent:
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0'
	});
	const page = await context.newPage();
	await serveSharePage(page);
	await page.goto(`https://remingtonwilcox.github.io/mewsik/s/#${'A'.repeat(22)}`);
	await expect(page.getByText('Opened inside Instagram?')).toBeVisible();
	await context.close();
});

/** Serve site/open/index.html at every share-page path, as Pages does. */
async function serveSharePage(page: Page) {
	const html = readFileSync('site/open/index.html', 'utf8');
	await page.route(/^https:\/\/remingtonwilcox\.github\.io\/mewsik\/(open|s|p)\//, (route) =>
		route.request().url().endsWith('.svg')
			? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
			: route.fulfill({ contentType: 'text/html', body: html })
	);
}
