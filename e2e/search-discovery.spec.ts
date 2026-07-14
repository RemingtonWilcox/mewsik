import { expect, test, type Page } from '@playwright/test';

async function installTauriSearchMock(page: Page) {
	await page.addInitScript(() => {
		const callbacks = new Map<number, (payload: unknown) => void>();
		let nextCallbackId = 1;
		const playbackState = {
			is_playing: false,
			is_buffering: false,
			can_seek: false,
			current_recording_id: null,
			current_title: null,
			current_artist: null,
			current_album_art: null,
			current_source_url: null,
			current_station_id: null,
			position_ms: 0,
			duration_ms: 0,
			volume: 1,
			is_shuffle: false,
			repeat_mode: 'off',
			source: null
		};
		const discoveryItem = {
			id: 'apple-1',
			title: 'One More Time',
			artist: 'Daft Punk',
			album: null,
			artwork_url: null,
			search_query: 'Daft Punk One More Time',
			listen_count: null,
			rank: 1,
			momentum: null,
			context: 'U.S. chart'
		};

		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				if (command === 'get_playback_state') return playbackState;
				if (command === 'get_search_discovery_feed') {
					return {
						generated_at: 1,
						source: 'Apple Music charts (U.S.) + Mewsik editorial',
						is_stale: false,
						is_fallback: false,
						sections: [
							{
								id: 'us-top',
								title: 'Top songs in the U.S.',
								subtitle: 'Apple Music public chart, one song per artist',
								items: [discoveryItem]
							},
							{
								id: 'world',
								title: 'Around the world',
								subtitle: 'Apple Music charts in the United Kingdom, Japan, and Brazil',
								items: []
							},
							{
								id: 'editorial',
								title: 'Reliable rabbit holes',
								subtitle: 'Mewsik editorial; not personalized',
								items: []
							}
						]
					};
				}
				if (command === 'search_all_sources') {
					const searchQuery = String(args.query ?? '');
					const isRadiohead = searchQuery.includes('Radiohead');
					return [
						{
							source: 'youtube',
							source_id: isRadiohead ? 'radiohead-1' : 'daft-punk-1',
							title: isRadiohead ? 'Weird Fishes / Arpeggi' : 'One More Time',
							artist: isRadiohead ? 'Radiohead' : 'Daft Punk',
							album: null,
							duration_ms: 300_000,
							cover_art_url: null,
							source_url: null,
							play_count: 1_000_000,
							is_saved: false,
							is_downloaded: false,
							recording_id: null
						}
					];
				}
				if (command === 'start_sidecar' || command.startsWith('plugin:event|')) return null;
				return [];
			},
			transformCallback: (callback: (payload: unknown) => void) => {
				const id = nextCallbackId++;
				callbacks.set(id, callback);
				return id;
			},
			unregisterCallback: (id: number) => callbacks.delete(id)
		};
		(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
			unregisterListener: () => undefined
		};
	});
}

test('a chart pick runs a real provider search and renders its result', async ({ page }) => {
	await installTauriSearchMock(page);
	await page.goto('/search');

	const input = page.getByPlaceholder('Search songs, artists...');
	await expect(input).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('search-discovery-feed')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Top songs in the U.S.' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Around the world' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Reliable rabbit holes' })).toBeVisible();

	const pick = page.getByTestId('discovery-card-us-top').first();
	await expect(pick).toHaveAccessibleName('Search for One More Time by Daft Punk');
	await pick.click();

	await expect(input).toHaveValue('Daft Punk One More Time');
	await expect(page.getByTestId('search-discovery-feed')).toBeHidden();
	await expect(page.getByText('One More Time', { exact: true })).toBeVisible();
	await expect(page.getByText(/No results for/)).toBeHidden();
});

test('a q URL auto-runs once and opens directly on real results', async ({ page }) => {
	await installTauriSearchMock(page);
	await page.goto('/search?q=Radiohead%20Weird%20Fishes%20%2F%20Arpeggi');

	await expect(page.getByPlaceholder('Search songs, artists...')).toHaveValue(
		'Radiohead Weird Fishes / Arpeggi'
	);
	await expect(page.getByText('Weird Fishes / Arpeggi', { exact: true })).toBeVisible();
	await expect(page.getByText(/No results for/)).toBeHidden();
});
