import { expect, test, type Page } from '@playwright/test';

interface PlaybackMockOptions {
	initialShuffle?: boolean;
}

async function installPlaybackMock(page: Page, options: PlaybackMockOptions = {}) {
	await page.addInitScript(({ initialShuffle }) => {
		type Invocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & { __PLAYBACK_INVOCATIONS__?: Invocation[] };
		runtimeWindow.__PLAYBACK_INVOCATIONS__ = [];

		const tracks = [
			{
				id: 'track-1',
				title: 'Context One',
				artist_name: 'Artist One',
				artist_id: 'artist-1',
				album_title: 'Context Album',
				album_id: 'album-1',
				duration_ms: 180_000,
				cover_art_path: null,
				cover_art_url: null,
				genre: null,
				year: 2026,
				source: 'local',
				is_downloaded: true,
				local_file_path: 'C:/Music/context-one.mp3',
				playlist_track_id: 'playlist-track-1',
				playlist_position: 1
			},
			{
				id: 'track-2',
				title: 'Context Two',
				artist_name: 'Artist Two',
				artist_id: 'artist-1',
				album_title: 'Context Album',
				album_id: 'album-1',
				duration_ms: 210_000,
				cover_art_path: null,
				cover_art_url: null,
				genre: null,
				year: 2026,
				source: 'local',
				is_downloaded: true,
				local_file_path: 'C:/Music/context-two.mp3',
				playlist_track_id: 'playlist-track-2',
				playlist_position: 2
			},
			{
				id: 'track-3',
				title: 'Context Three',
				artist_name: 'Artist Three',
				artist_id: 'artist-1',
				album_title: 'Context Album',
				album_id: 'album-1',
				duration_ms: 240_000,
				cover_art_path: null,
				cover_art_url: null,
				genre: null,
				year: 2026,
				source: 'local',
				is_downloaded: true,
				local_file_path: 'C:/Music/context-three.mp3',
				playlist_track_id: 'playlist-track-3',
				playlist_position: 3
			}
		];
		const searchResults = tracks.map((track) => ({
			recording_id: track.id,
			title: track.title,
			artist_name: track.artist_name,
			artist_id: track.artist_id,
			album_title: track.album_title,
			album_id: track.album_id,
			source: track.source,
			source_id: null,
			cover_art_url: null,
			duration_ms: track.duration_ms
		}));
		const playlist = {
			id: 'playlist-1',
			name: 'Continuity Playlist',
			description: 'Ordered playback context',
			cover_art_path: null,
			is_smart: false,
			smart_rules: null,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z'
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
			is_shuffle: initialShuffle,
			repeat_mode: 'off',
			source: null
		};
		const queueSnapshot = {
			session_id: 'queue-session-1',
			revision: 4,
			now_playing: {
				entry_id: 'entry-now',
				index: 0,
				recording_id: 'track-1',
				title: 'Context One',
				artist_name: 'Artist One',
				duration_ms: 180_000,
				cover_art_url: null,
				is_current: true
			},
			upcoming: [
				{
					entry_id: 'entry-next',
					index: 0,
					recording_id: 'track-2',
					title: 'Context Two',
					artist_name: 'Artist Two',
					duration_ms: 210_000,
					cover_art_url: null,
					is_current: false
				},
				{
					entry_id: 'entry-later',
					index: 1,
					recording_id: 'track-3',
					title: 'Context Three',
					artist_name: 'Artist Three',
					duration_ms: 240_000,
					cover_art_url: null,
					is_current: false
				}
			]
		};

		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__PLAYBACK_INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'get_playback_state':
						return { ...playbackState };
					case 'get_library_tracks':
						return tracks;
					case 'get_all_artists':
						return [];
					case 'get_all_albums':
						return [];
					case 'get_artist':
						return {
							id: 'artist-1',
							name: 'Continuity Artist',
							sort_name: null,
							bio: null,
							image_path: null,
							image_url: null,
							musicbrainz_id: null,
							created_at: '2026-01-01T00:00:00Z',
							updated_at: '2026-01-01T00:00:00Z'
						};
					case 'get_artist_tracks':
						return tracks;
					case 'get_playlists':
						return [playlist];
					case 'get_playlist_tracks':
						return tracks;
					case 'get_daily_mix':
						return tracks.map((track, index) => ({
							...track,
							title: `Quick ${['One', 'Two', 'Three'][index]}`
						}));
					case 'get_recently_played':
						return [];
					case 'get_play_stats':
						return { total_plays: 0, total_time_ms: 0, unique_tracks: 0 };
					case 'search_library':
						return searchResults;
					case 'set_shuffle':
						playbackState.is_shuffle = Boolean(args.enabled);
						return null;
					case 'play_tracks_from':
						return null;
					case 'get_queue':
						return queueSnapshot;
					case 'play_queue_entry':
					case 'remove_queue_entry':
					case 'clear_queue':
						return null;
					case 'plugin:event|listen':
						return 1;
					case 'plugin:event|unlisten':
					case 'start_sidecar':
						return null;
					default:
						return [];
				}
			},
			transformCallback: () => 1,
			unregisterCallback: () => undefined
		};
		(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
			unregisterListener: () => undefined
		};
	}, { initialShuffle: options.initialShuffle ?? false });
}

async function playbackInvocations(page: Page) {
	return page.evaluate(() => {
		const invocations = (window as Window & {
			__PLAYBACK_INVOCATIONS__?: Array<{
				command: string;
				args: Record<string, unknown>;
			}>;
		}).__PLAYBACK_INVOCATIONS__ ?? [];
		return invocations.filter(({ command }) =>
			command === 'play_tracks_from' || command === 'set_shuffle'
		);
	});
}

test('Quick Picks starts the selected song inside the whole visible recommendation context', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/');

	await page.getByRole('button', { name: /Quick Two/ }).click();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-1', 'track-2', 'track-3'], startIndex: 1 }
			}
		]);
});

test('command search starts the selected song inside the whole visible result context', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'mewsik' })).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggle-command')));

	const dialog = page.getByRole('dialog', { name: 'Command Palette' });
	await expect(dialog).toBeVisible();
	await dialog.getByPlaceholder('Search songs, artists, albums...').fill('Context');
	await dialog.getByText('Context Two', { exact: true }).click();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-1', 'track-2', 'track-3'], startIndex: 1 }
			}
		]);
});

test('artist shuffle submits ordered context and enables backend shuffle', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/library?artist=artist-1');

	await expect(page.getByRole('heading', { name: 'Continuity Artist' })).toBeVisible();
	await page.locator('main').getByRole('button', { name: 'Shuffle', exact: true }).click();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-1', 'track-2', 'track-3'], startIndex: 0 }
			},
			{ command: 'set_shuffle', args: { enabled: true } }
		]);
});

test('playlist Play submits ordered context and disables backend shuffle', async ({ page }) => {
	await installPlaybackMock(page, { initialShuffle: true });
	await page.goto('/playlists/playlist-1');

	await expect(page.locator('main input').first()).toHaveValue('Continuity Playlist');
	await page.locator('main').getByRole('button', { name: 'Play', exact: true }).click();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-1', 'track-2', 'track-3'], startIndex: 0 }
			},
			{ command: 'set_shuffle', args: { enabled: false } }
		]);
});

test('Up Next renders the native snapshot and mutates by stable session and entry IDs', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/');

	await page.getByRole('button', { name: 'Up Next queue' }).click();
	await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
	await expect(page.getByText('Context Two', { exact: true })).toBeVisible();
	await expect(page.getByText('Context Three', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Play Context Two' }).click();
	await page.getByRole('button', { name: 'Remove Context Three from Up Next' }).click();

	await expect
		.poll(() =>
			page.evaluate(() => {
				const invocations = (window as Window & {
					__PLAYBACK_INVOCATIONS__?: Array<{
						command: string;
						args: Record<string, unknown>;
					}>;
				}).__PLAYBACK_INVOCATIONS__ ?? [];
				return invocations
					.filter(({ command }) =>
						['play_queue_entry', 'remove_queue_entry'].includes(command)
					)
					.map(({ command, args }) => ({ command, args }));
			})
		)
		.toEqual([
			{
				command: 'play_queue_entry',
				args: { sessionId: 'queue-session-1', entryId: 'entry-next' }
			},
			{
				command: 'remove_queue_entry',
				args: { sessionId: 'queue-session-1', entryId: 'entry-later' }
			}
		]);
});
