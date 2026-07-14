import { expect, test, type Page } from '@playwright/test';

async function installTauriSearchMock(page: Page) {
	await page.addInitScript(() => {
		type MockInvocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & { __MEWSIK_TEST_INVOCATIONS__?: MockInvocation[] };
		runtimeWindow.__MEWSIK_TEST_INVOCATIONS__ = [];
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
			item_kind: 'track',
			title: 'One More Time',
			artist: 'Daft Punk',
			album: null,
			artwork_url: null,
			search_query: 'Daft Punk One More Time',
			listen_count: null,
			rank: 1,
			momentum: null,
			context: 'Apple Music chart',
			reason: '#1 Apple US',
			source_labels: ['Apple Music'],
			release_date: null,
			audience_delta: null,
			audience_label: null
		};

		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__MEWSIK_TEST_INVOCATIONS__?.push({ command, args });
				if (command === 'get_playback_state') return playbackState;
				if (command === 'get_search_discovery_feed') {
					return {
						snapshot_id: 'snapshot-v2-search',
						generated_at: 1,
						source: 'Apple Music + ListenBrainz + Bandcamp Daily',
						is_stale: false,
						is_fallback: false,
						has_history: false,
						next_refresh_at: 61,
						source_statuses: [
							{
								id: 'apple',
								label: 'Apple Music',
								state: 'live',
								updated_at: 1,
								detail: 'Public charts'
							},
							{
								id: 'listenbrainz',
								label: 'ListenBrainz',
								state: 'live',
								updated_at: 1,
								detail: 'Fresh releases'
							}
						],
						sections: [
							{
								id: 'top-now',
								kind: 'top_now',
								personalized: false,
								title: 'Top now',
								subtitle: 'What is landing across current public charts',
								items: [discoveryItem]
							},
							{
								id: 'new-and-worth-a-look',
								kind: 'new_and_rising',
								personalized: false,
								title: 'New and worth a look',
								subtitle: 'Recent releases with a real signal behind them',
								items: []
							},
							{
								id: 'editors-found-this',
								kind: 'editors_found',
								personalized: false,
								title: 'Editors found this',
								subtitle: 'Current trails from Bandcamp Daily',
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
				if (command === 'record_discovery_event') return null;
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
	await expect(page.getByRole('heading', { name: 'Top now' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'New and worth a look' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Editors found this' })).toBeVisible();
	await expect(page.getByText('#1 Apple US', { exact: true })).toBeVisible();
	await expect(page.getByText('2 live signals', { exact: true })).toBeVisible();

	const pick = page.getByTestId('discovery-card-top-now').first();
	await expect(pick).toHaveAccessibleName('Search for One More Time by Daft Punk');
	await pick.click();

	await expect(input).toHaveValue('Daft Punk One More Time');
	await expect(page.getByTestId('search-discovery-feed')).toBeHidden();
	await expect(page.getByText('One More Time', { exact: true })).toBeVisible();
	await expect(page.getByText(/No results for/)).toBeHidden();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const invocations = (window as Window & {
					__MEWSIK_TEST_INVOCATIONS__?: Array<{
						command: string;
						args: Record<string, unknown>;
					}>;
				}).__MEWSIK_TEST_INVOCATIONS__ ?? [];
				return invocations
					.filter(({ command }) => command === 'record_discovery_event' || command === 'search_all_sources')
					.map(({ command, args }) => ({ command, args }));
			})
		)
		.toEqual([
			{
				command: 'record_discovery_event',
				args: {
					itemId: 'apple-1',
					eventType: 'click',
					sectionId: 'top-now',
					snapshotId: 'snapshot-v2-search'
				}
			},
			{
				command: 'search_all_sources',
				args: { query: 'Daft Punk One More Time' }
			}
		]);
});

test('a q URL auto-runs once and opens directly on real results', async ({ page }) => {
	await installTauriSearchMock(page);
	await page.goto('/search?q=Radiohead%20Weird%20Fishes%20%2F%20Arpeggi');

	await expect(page.getByPlaceholder('Search songs, artists...')).toHaveValue(
		'Radiohead Weird Fishes / Arpeggi'
	);
	await expect(page.getByText('Weird Fishes / Arpeggi', { exact: true })).toBeVisible();
	await expect(page.getByText(/No results for/)).toBeHidden();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const invocations = (window as Window & {
					__MEWSIK_TEST_INVOCATIONS__?: Array<{ command: string }>;
				}).__MEWSIK_TEST_INVOCATIONS__ ?? [];
				return invocations.filter(({ command }) => command === 'search_all_sources').length;
			})
		)
		.toBe(1);
});
