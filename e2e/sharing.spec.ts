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
		const data = new URLSearchParams(new URL(playlistUrl).hash.slice(1)).get('playlist')!;
		const stationUrl = share.stationShareUrl({ uuid: uuid.toUpperCase(), name: 'Radio Kakadu', country: 'Australia' });
		return {
			playlistUrl,
			fromPage: await share.parseAppLink(playlistUrl),
			fromApp: await share.parseAppLink(`mewsik://playlist/${data}`),
			stationUrl,
			station: await share.parseAppLink(stationUrl),
			stationApp: await share.parseAppLink(`mewsik://station/${uuid}`),
			junk: await share.parseAppLink('mewsik://playlist/not-a-playlist'),
			other: await share.parseAppLink('https://example.com/#station=' + uuid)
		};
	}, RANDOM_UUID);

	expect(result.playlistUrl.startsWith('https://remingtonwilcox.github.io/mewsik/open/#playlist=')).toBe(true);
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
	expect(result.stationUrl).toContain(`station=${RANDOM_UUID}`);
	expect(result.station).toEqual({ kind: 'station', uuid: RANDOM_UUID });
	expect(result.stationApp).toEqual({ kind: 'station', uuid: RANDOM_UUID });
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
	const html = readFileSync('site/open/index.html', 'utf8');
	await page.route('https://remingtonwilcox.github.io/mewsik/open/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: html })
	);
	await page.goto(url);
	await expect(page.getByRole('heading', { name: 'Road trip' })).toBeVisible();
	await expect(page.getByText('2 songs')).toBeVisible();
	await expect(page.getByText('M83 – Midnight City')).toBeVisible();
	const href = await page.getByRole('link', { name: 'Open in mewsik' }).getAttribute('href');
	expect(href).toBe(`mewsik://playlist/${new URL(url).hash.split('=')[1]}`);
});
