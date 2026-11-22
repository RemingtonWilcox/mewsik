import { expect, test, type Page } from '@playwright/test';

type Invocation = { command: string; args: Record<string, unknown> };

/** A brand-new install: empty library, a reachable directory and YouTube. */
async function installRuntime(page: Page) {
	await page.addInitScript(() => {
		const runtimeWindow = window as Window & {
			__INVOCATIONS__?: Invocation[];
			__TAURI_INTERNALS__?: unknown;
		};
		type Invocation = { command: string; args: Record<string, unknown> };
		runtimeWindow.__INVOCATIONS__ = [];
		const station = (n: number) => ({
			name: `Station ${n}`,
			url: `https://radio.example/${n}`,
			homepage: null,
			favicon: null,
			country: n === 1 ? 'Brazil' : 'Japan',
			language: 'portuguese',
			tags: 'pop,music',
			codec: 'MP3',
			bitrate: 128,
			stationuuid: `00000000-0000-4000-8000-00000000000${n}`
		});
		const song = (n: number) => ({
			source: 'youtube',
			source_id: `vid0000000${n}`,
			title: `Hit ${n}`,
			artist: `Artist ${n}`,
			album: null,
			duration_ms: null,
			cover_art_url: null,
			source_url: null,
			play_count: 1000 * n,
			is_saved: false,
			is_downloaded: false,
			recording_id: null
		});
		runtimeWindow.__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'browse_radio_stations':
						return { items: [station(1), station(2)], next_offset: 2, has_more: false };
					case 'trending_tracks':
						return [song(1), song(2), song(3)];
					case 'play_station_search_result':
						return 'local-station-id';
					case 'get_library_tracks':
					case 'get_albums':
					case 'get_artists':
					case 'get_playlists':
					case 'get_library_paths':
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

const calls = (page: Page, command: string) =>
	page.evaluate(
		(name) =>
			((window as Window & { __INVOCATIONS__?: Invocation[] }).__INVOCATIONS__ ?? []).filter(
				(call) => call.command === name
			),
		command
	);

test('empty search shows popular radio and trending songs that play', async ({ page }) => {
	await installRuntime(page);
	await page.goto('/search');
	const stations = page.getByTestId('popular-stations');
	await expect(stations.getByText('Station 1')).toBeVisible();
	await expect(stations.getByText('Brazil')).toBeVisible();
	const trending = page.getByTestId('trending');
	await expect(trending.getByText('Hit 2')).toBeVisible();
	await expect(trending.getByText('Artist 3')).toBeVisible();

	await stations.getByText('Station 2').click();
	await expect.poll(async () => (await calls(page, 'play_station_search_result')).length).toBe(1);

	await trending.getByRole('button', { name: 'Play' }).nth(1).click();
	await expect
		.poll(async () => (await calls(page, 'play_external_context'))[0]?.args)
		.toMatchObject({ startIndex: 1 });

	// Typing hides the empty screen.
	await page.locator('[data-search-input]').fill('massive attack');
	await expect(page.getByTestId('trending')).toHaveCount(0);
});

test('an empty library offers ways to start', async ({ page }) => {
	await installRuntime(page);
	await page.goto('/library');
	const start = page.getByTestId('library-empty');
	await expect(start.getByRole('link', { name: /Find any song/ })).toHaveAttribute('href', '/search');
	await expect(start.getByRole('link', { name: /Turn on the radio/ })).toHaveAttribute('href', '/stations');
	await expect(start.getByRole('button', { name: /Add your music folder/ })).toBeVisible();
});
