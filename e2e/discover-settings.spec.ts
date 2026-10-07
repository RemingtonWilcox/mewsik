import { expect, test, type Page } from '@playwright/test';

async function installDiscoveryProfileRuntime(page: Page) {
	await page.addInitScript(() => {
		type DiscoveryInvocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & {
			__DISCOVERY_PROFILE_READY__?: boolean;
			__DISCOVERY_FEED_FAIL__?: boolean;
			__DISCOVERY_INVOCATIONS__?: DiscoveryInvocation[];
			__TAURI_INTERNALS__?: {
				invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
				transformCallback: () => number;
				unregisterCallback: () => void;
			};
		};
		runtimeWindow.__DISCOVERY_PROFILE_READY__ = false;
		runtimeWindow.__DISCOVERY_FEED_FAIL__ = false;
		runtimeWindow.__DISCOVERY_INVOCATIONS__ = [];
		const track = {
			id: 'saved-track',
			title: 'Saved Track',
			artist_name: 'Saved Artist',
			artist_id: 'saved-artist',
			album_title: null,
			album_id: null,
			duration_ms: 180_000,
			cover_art_path: null,
			cover_art_url: null,
			genre: null,
			year: null,
			source: 'local',
			is_downloaded: false,
			local_file_path: 'C:\\Music\\saved-track.mp3'
		};
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
		runtimeWindow.__TAURI_INTERNALS__ = {
			invoke: async (command, args = {}) => {
				runtimeWindow.__DISCOVERY_INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'get_daily_mix':
					case 'get_recently_played':
						return [track];
					case 'get_rediscover':
					case 'get_playlists':
					case 'get_downloads':
						return [];
					case 'get_play_stats':
						return {
							total_plays: 12,
							total_time_ms: 540_000,
							unique_tracks: 5,
							profile_track_goal: 5,
							profile_ready: runtimeWindow.__DISCOVERY_PROFILE_READY__
						};
					case 'get_search_discovery_feed':
						if (runtimeWindow.__DISCOVERY_FEED_FAIL__ && args.force === true) {
							throw new Error('simulated refresh failure');
						}
						return {
							snapshot_id: 'snapshot-v2-discover',
							generated_at: 0,
							source: 'Test picks',
							is_stale: false,
							is_fallback: true,
							has_history: false,
							next_refresh_at: null,
							source_statuses: [],
							sections: []
						};
					case 'get_playback_state':
						return playbackState;
					default:
						return null;
				}
			},
			transformCallback: () => 1,
			unregisterCallback: () => {}
		};
	});
}

async function installDownloadLocationRuntime(page: Page) {
	await page.addInitScript(() => {
		type DownloadInvocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & {
			__DOWNLOAD_INVOCATIONS__?: DownloadInvocation[];
			__TAURI_INTERNALS__?: {
				invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
				transformCallback: () => number;
				unregisterCallback: () => void;
			};
		};
		runtimeWindow.__DOWNLOAD_INVOCATIONS__ = [];
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

		runtimeWindow.__TAURI_INTERNALS__ = {
			invoke: async (command, args = {}) => {
				runtimeWindow.__DOWNLOAD_INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'get_downloads':
					case 'refresh_download_files':
					case 'get_playlists':
					case 'get_library_paths':
					case 'get_library_tracks':
					case 'get_all_artists':
					case 'get_all_albums':
						return [];
					case 'get_download_location':
						return {
							directory: 'E:\\Portable Music\\Mewsik',
							default_directory: 'C:\\Users\\listener\\Music\\Mewsik',
							is_custom: true,
							exists: false,
							legacy_file_count: 0,
							legacy_bytes: 0
						};
					case 'get_playback_state':
						return playbackState;
					case 'sidecar_status':
						return false;
					default:
						return null;
				}
			},
			transformCallback: () => 1,
			unregisterCallback: () => {}
		};
	});
}

test.describe('Discover and Settings fallback experience', () => {
	test('empty Discover still offers useful ways in and searchable outside picks', async ({ page }) => {
		await page.goto('/discover');

		await expect(
			page.getByRole('heading', { name: 'Discover does not need an existing library.' })
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole('link', { name: 'Search music' })).toHaveAttribute('href', '/search');
		await expect(page.getByRole('link', { name: 'Browse stations' })).toHaveAttribute(
			'href',
			'/stations'
		);
		await expect(page.getByRole('link', { name: 'Add a folder' })).toHaveAttribute(
			'href',
			'/settings'
		);

		await expect(page.getByText('Beyond your library', { exact: true })).toBeVisible();
		for (const section of ['fallback-starts', 'fallback-detours', 'fallback-rabbit-holes']) {
			const shelf = page.getByTestId(`discovery-section-${section}`);
			await expect(shelf).toBeVisible();
			await expect(shelf.getByTestId(`discovery-card-${section}`).first()).toBeVisible();
		}

		await page.getByTestId('discovery-card-fallback-starts').first().click();
		await expect.poll(() => new URL(page.url()).pathname).toBe('/search');
		expect(new URL(page.url()).searchParams.get('q')).toBe('Daft Punk One More Time');
	});

	test('Discover uses the backend readiness decision for the five-track boundary', async ({ page }) => {
		await installDiscoveryProfileRuntime(page);
		await page.goto('/discover');

		await expect(page.getByText('Learning your rotation', { exact: true })).toBeVisible({
			timeout: 15_000
		});
		await expect(page.getByText(/5\/5 different tracks played/)).toBeVisible();

		await page.evaluate(() => {
			const runtimeWindow = window as Window & {
				__DISCOVERY_PROFILE_READY__?: boolean;
				__DISCOVERY_FEED_FAIL__?: boolean;
			};
			runtimeWindow.__DISCOVERY_PROFILE_READY__ = true;
			runtimeWindow.__DISCOVERY_FEED_FAIL__ = true;
		});
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect(page.getByText('Your rotation is active', { exact: true })).toBeVisible();
		await expect(page.getByText('Test picks', { exact: true })).toBeVisible();
		await expect(page.getByText(/previous picks are still shown/)).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const calls = (window as Window & {
						__DISCOVERY_INVOCATIONS__?: Array<{
							command: string;
							args: Record<string, unknown>;
						}>;
					}).__DISCOVERY_INVOCATIONS__ ?? [];
					return calls
						.filter(({ command }) => command === 'get_search_discovery_feed')
						.map(({ args }) => args.force);
				})
			)
			.toEqual([false, true]);
	});

	test('Settings exposes the library summary and keeps repair tools out of the way', async ({ page }) => {
		await page.goto('/settings');

		const libraryCard = page.locator('[data-slot="card"]').filter({ hasText: 'Music library' });
		await expect(libraryCard).toBeVisible();
		for (const label of ['Tracks', 'Artists', 'Albums']) {
			const metric = libraryCard.getByText(label, { exact: true }).locator('..');
			await expect(metric.getByText('0', { exact: true })).toBeVisible();
		}
		await expect(libraryCard.getByRole('button', { name: 'Add folder' })).toBeVisible();
		await expect(libraryCard.getByText('No local music folders yet')).toBeVisible();

		const downloadCard = page.locator('[data-slot="card"]').filter({ hasText: 'Download location' });
		await expect(downloadCard).toBeVisible();
		await expect(downloadCard.getByText('Music/Mewsik', { exact: true })).toBeVisible();
		await expect(downloadCard.getByText('Default folder', { exact: false })).toBeVisible();
		await expect(downloadCard.getByText(/Existing files are never moved or deleted automatically/)).toBeVisible();
		await expect(downloadCard.getByRole('button', { name: 'Show folder' })).toBeVisible();
		await expect(downloadCard.getByRole('button', { name: 'Change folder' })).toBeVisible();

		const theme = page.getByRole('group', { name: 'Theme' });
		for (const preference of ['Light', 'Dark', 'System']) {
			await expect(theme.getByRole('button', { name: preference, exact: true })).toBeVisible();
		}
		for (const preference of ['Light', 'Dark', 'System']) {
			const choice = theme.getByRole('button', { name: preference, exact: true });
			await choice.click();
			await expect(choice).toHaveAttribute('aria-pressed', 'true');
		}

		const troubleshooting = page.locator('details').filter({ hasText: 'Search troubleshooting' });
		await expect(troubleshooting).not.toHaveAttribute('open', '');
		await expect(troubleshooting.getByRole('button', { name: 'Restart providers' })).toBeHidden();
		await troubleshooting.locator('summary').click();
		await expect(troubleshooting.getByRole('button', { name: 'Restart providers' })).toBeVisible();
		await troubleshooting.locator('summary').click();
		await expect(troubleshooting.getByRole('button', { name: 'Restart providers' })).toBeHidden();
	});

	test('Downloads keeps mount polling cheap and runs file health only on request', async ({ page }) => {
		await installDownloadLocationRuntime(page);
		await page.goto('/downloads');

		await expect(page.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible();
		await expect(page.getByText('E:\\Portable Music\\Mewsik', { exact: true })).toBeVisible();
		const refreshCount = () =>
			page.evaluate(() => {
				const calls = (window as Window & {
					__DOWNLOAD_INVOCATIONS__?: Array<{ command: string }>;
				}).__DOWNLOAD_INVOCATIONS__ ?? [];
				return calls.filter(({ command }) => command === 'refresh_download_files').length;
			});
		await expect.poll(refreshCount).toBe(0);

		// Leave enough time for both the Downloads-page poll and the global sidebar
		// poll to run. Those reads must never retrigger the expensive health check.
		await page.waitForTimeout(3_250);
		const commandCounts = await page.evaluate(() => {
			const calls = (window as Window & {
				__DOWNLOAD_INVOCATIONS__?: Array<{ command: string }>;
			}).__DOWNLOAD_INVOCATIONS__ ?? [];
			return {
				refreshes: calls.filter(({ command }) => command === 'refresh_download_files').length,
				reads: calls.filter(({ command }) => command === 'get_downloads').length
			};
		});
		expect(commandCounts.refreshes).toBe(0);
		expect(commandCounts.reads).toBeGreaterThanOrEqual(2);

		await page.getByRole('button', { name: 'Check files' }).click();
		await expect.poll(refreshCount).toBe(1);
		await page.waitForTimeout(1_750);
		await expect.poll(refreshCount).toBe(1);

		await page.getByRole('link', { name: 'Settings' }).first().click();
		await expect(
			page.getByText('Custom folder unavailable · Reconnect it or choose another', { exact: true })
		).toBeVisible();
	});
});
