import { expect, test, type Page } from '@playwright/test';

type SearchMockScenario = 'success' | 'fail-once' | 'partial-then-fail';

interface SearchMockOptions {
	discoveryPick?: 'daft-punk' | 'ella-langley';
	scenario?: SearchMockScenario;
}

async function installTauriSearchMock(page: Page, options: SearchMockOptions = {}) {
	await page.addInitScript(({ discoveryPick, scenario }) => {
		type MockInvocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & { __MEWSIK_TEST_INVOCATIONS__?: MockInvocation[] };
		runtimeWindow.__MEWSIK_TEST_INVOCATIONS__ = [];
		const callbacks = new Map<number, (payload: unknown) => void>();
		const eventCallbacks = new Map<string, Set<number>>();
		let nextCallbackId = 1;
		let searchAttempts = 0;
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
		const isEllaPick = discoveryPick === 'ella-langley';
		const discoveryItem = {
			id: isEllaPick ? 'apple-ella-langley' : 'apple-1',
			item_kind: 'track',
			title: isEllaPick ? "Choosin' Texas" : 'One More Time',
			artist: isEllaPick ? 'Ella Langley' : 'Daft Punk',
			album: null,
			artwork_url: null,
			search_query: isEllaPick ? "Ella Langley Choosin' Texas" : 'Daft Punk One More Time',
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
		const resultForQuery = (searchQuery: string) => {
			const isRadiohead = searchQuery.includes('Radiohead');
			const isEllaLangley = searchQuery === "Ella Langley Choosin' Texas";
			const isRecovery = searchQuery === 'Recovery Artist Recovery Song';
			return {
				source: 'youtube',
				source_id: isRadiohead
					? 'radiohead-1'
					: isEllaLangley
						? 'ella-langley-1'
						: isRecovery
							? 'recovery-1'
							: 'daft-punk-1',
				title: isRadiohead
					? 'Weird Fishes / Arpeggi'
					: isEllaLangley
						? "Choosin' Texas"
						: isRecovery
							? 'Recovery Song'
							: 'One More Time',
				artist: isRadiohead
					? 'Radiohead'
					: isEllaLangley
						? 'Ella Langley'
						: isRecovery
							? 'Recovery Artist'
							: 'Daft Punk',
				album: null,
				duration_ms: 300_000,
				cover_art_url: null,
				source_url: null,
				play_count: 1_000_000,
				is_saved: false,
				is_downloaded: false,
				recording_id: null
			};
		};
		const emitEvent = (event: string, payload: unknown) => {
			for (const callbackId of eventCallbacks.get(event) ?? []) {
				callbacks.get(callbackId)?.({ event, id: callbackId, payload });
			}
		};

		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__MEWSIK_TEST_INVOCATIONS__?.push({ command, args });
				if (command === 'plugin:event|listen') {
					const event = String(args.event ?? '');
					const callbackId = Number(args.handler);
					const listeners = eventCallbacks.get(event) ?? new Set<number>();
					listeners.add(callbackId);
					eventCallbacks.set(event, listeners);
					return callbackId;
				}
				if (command === 'plugin:event|unlisten') return null;
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
					searchAttempts += 1;
					if (scenario === 'fail-once' && searchAttempts === 1) {
						const staleRequestId = String(args.requestId ?? '');
						window.setTimeout(() => {
							emitEvent('external-search-partial', {
								request_id: staleRequestId,
								query: searchQuery,
								source: 'youtube',
								results: [{
									source: 'youtube',
									source_id: 'stale-first-attempt',
									title: 'Stale First Attempt',
									artist: 'Should Never Render',
									album: null,
									duration_ms: 1,
									cover_art_url: null,
									source_url: null,
									play_count: null,
									is_saved: false,
									is_downloaded: false,
									recording_id: null
								}]
							});
						}, 250);
						throw new Error('All music providers timed out.');
					}
					if (scenario === 'partial-then-fail') {
						const partialResult = {
							source: 'soundcloud',
							source_id: 'partial-1',
							title: 'Partial Result',
							artist: 'Partial Artist',
							album: null,
							duration_ms: 180_000,
							cover_art_url: null,
							source_url: null,
							play_count: null,
							is_saved: false,
							is_downloaded: false,
							recording_id: null
						};
						emitEvent('external-search-partial', {
							request_id: String(args.requestId ?? ''),
							query: searchQuery,
							source: 'soundcloud',
							results: [partialResult]
						});
						return {
							items: [partialResult],
							failed_sources: ['youtube', 'bandcamp']
						};
					}
					return { items: [resultForQuery(searchQuery)], failed_sources: [] };
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
			unregisterListener: (event: string, callbackId: number) => {
				eventCallbacks.get(event)?.delete(callbackId);
			}
		};
	}, {
		discoveryPick: options.discoveryPick ?? 'daft-punk',
		scenario: options.scenario ?? 'success'
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
				args: { query: 'Daft Punk One More Time', requestId: '1' }
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

test("a discovery query containing an apostrophe searches exactly once and renders the result", async ({ page }) => {
	await installTauriSearchMock(page, { discoveryPick: 'ella-langley' });
	await page.goto('/search');

	const input = page.getByPlaceholder('Search songs, artists...');
	await expect(input).toBeVisible({ timeout: 15_000 });
	const pick = page.getByTestId('discovery-card-top-now').first();
	await expect(pick).toHaveAccessibleName("Search for Choosin' Texas by Ella Langley");
	await pick.click();

	await expect(input).toHaveValue("Ella Langley Choosin' Texas");
	await expect(page.getByText("Choosin' Texas", { exact: true })).toBeVisible();
	await expect(page.getByText('Ella Langley', { exact: true })).toBeVisible();
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
					.filter(({ command }) => command === 'search_all_sources')
					.map(({ args }) => args);
			})
		)
		.toEqual([{ query: "Ella Langley Choosin' Texas", requestId: '1' }]);
});

test('Retry search restarts the provider and succeeds after a total first-attempt failure', async ({ page }) => {
	await installTauriSearchMock(page, { scenario: 'fail-once' });
	await page.goto('/search');

	const input = page.getByPlaceholder('Search songs, artists...');
	await expect(input).toBeVisible({ timeout: 15_000 });
	await input.fill('Recovery Artist Recovery Song');
	await input.press('Enter');

	await expect(page.getByText('Search is unavailable: All music providers timed out.')).toBeVisible();
	await page.getByRole('button', { name: 'Retry search' }).click();

	await expect(page.getByText('Recovery Song', { exact: true })).toBeVisible();
	await expect(page.getByText('Recovery Artist', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry search' })).toBeHidden();
	await page.waitForTimeout(350);
	await expect(page.getByText('Stale First Attempt', { exact: true })).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const invocations = (window as Window & {
					__MEWSIK_TEST_INVOCATIONS__?: Array<{
						command: string;
						args: Record<string, unknown>;
					}>;
				}).__MEWSIK_TEST_INVOCATIONS__ ?? [];
				return {
					providerStarts: invocations.filter(({ command }) => command === 'start_sidecar').length,
					searches: invocations
						.filter(({ command }) => command === 'search_all_sources')
						.map(({ args }) => args)
				};
			})
		)
		.toEqual({
			providerStarts: 2,
			searches: [
				{ query: 'Recovery Artist Recovery Song', requestId: '1' },
				{ query: 'Recovery Artist Recovery Song', requestId: '2' }
			]
		});
});

test('a degraded provider response keeps partial results and shows only the compact retry warning', async ({ page }) => {
	await installTauriSearchMock(page, { scenario: 'partial-then-fail' });
	await page.goto('/search');

	const input = page.getByPlaceholder('Search songs, artists...');
	await expect(input).toBeVisible({ timeout: 15_000 });
	await expect
		.poll(() =>
			page.evaluate(() => {
				const invocations = (window as Window & {
					__MEWSIK_TEST_INVOCATIONS__?: Array<{
						command: string;
						args: Record<string, unknown>;
					}>;
				}).__MEWSIK_TEST_INVOCATIONS__ ?? [];
				return invocations.some(
					({ command, args }) =>
						command === 'plugin:event|listen' && args.event === 'external-search-partial'
				);
			})
		)
		.toBe(true);

	await input.fill('Partial Artist Partial Song');
	await input.press('Enter');

	await expect(page.getByText('Partial Result', { exact: true })).toBeVisible();
	await expect(page.getByText('Partial Artist', { exact: true })).toBeVisible();
	const warning = page
		.getByRole('status')
		.filter({ hasText: 'Some music sources could not finish. Showing the results that did arrive' });
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('Bandcamp and YouTube are temporarily unavailable.');
	await expect(warning.getByRole('button', { name: 'Retry missing sources' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry search' })).toHaveCount(0);
	await expect(page.getByText(/^Search is unavailable/)).toHaveCount(0);
});
