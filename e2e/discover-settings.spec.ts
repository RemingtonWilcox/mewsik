import { expect, test, type Page } from '@playwright/test';

async function installDiscoveryProfileRuntime(page: Page) {
	await page.addInitScript(() => {
		const runtimeWindow = window as Window & {
			__DISCOVERY_PROFILE_READY__?: boolean;
			__TAURI_INTERNALS__?: {
				invoke: (command: string) => Promise<unknown>;
				transformCallback: () => number;
				unregisterCallback: () => void;
			};
		};
		runtimeWindow.__DISCOVERY_PROFILE_READY__ = false;
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
			invoke: async (command) => {
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
						return {
							generated_at: 0,
							source: 'Test picks',
							is_stale: false,
							is_fallback: true,
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
		for (const section of ['editorial-starts', 'editorial-detours', 'editorial-rabbit-holes']) {
			const shelf = page.getByTestId(`discovery-section-${section}`);
			await expect(shelf).toBeVisible();
			await expect(shelf.getByTestId(`discovery-card-${section}`).first()).toBeVisible();
		}

		await page.getByTestId('discovery-card-editorial-starts').first().click();
		await expect.poll(() => new URL(page.url()).pathname).toBe('/search');
		expect(new URL(page.url()).searchParams.get('q')).toBe('Daft Punk One More Time');
	});

	test('Discover uses the backend readiness decision for the five-track boundary', async ({ page }) => {
		await installDiscoveryProfileRuntime(page);
		await page.goto('/discover');

		await expect(page.getByText('Learning your rotation', { exact: true })).toBeVisible();
		await expect(page.getByText(/5\/5 different tracks played/)).toBeVisible();

		await page.evaluate(() => {
			(window as Window & { __DISCOVERY_PROFILE_READY__?: boolean }).__DISCOVERY_PROFILE_READY__ = true;
		});
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect(page.getByText('Your rotation is active', { exact: true })).toBeVisible();
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
});
