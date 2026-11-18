import { expect as baseExpect, test, type Page } from '@playwright/test';

// The CI runner's first page load can take several seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

interface PlaybackMockOptions {
	initialShuffle?: boolean;
	playback?: Record<string, unknown>;
	online?: Record<string, unknown>[];
}

async function installPlaybackMock(page: Page, options: PlaybackMockOptions = {}) {
	await page.addInitScript(({ initialShuffle, playback, online }) => {
		type Invocation = { command: string; args: Record<string, unknown> };
		const runtimeWindow = window as Window & {
			__PLAYBACK_INVOCATIONS__?: Invocation[];
			__SET_PLAYBACK__?: (patch: Record<string, unknown>) => void;
		};
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
			source: null,
			...playback
		};
		runtimeWindow.__SET_PLAYBACK__ = (patch) => {
			Object.assign(playbackState, patch);
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
					case 'get_album_tracks':
						return tracks;
					case 'search_all_sources':
						return { items: online, failed_sources: [] };
					case 'ensure_external_recording':
						return `rec-${args.sourceId}`;
					case 'play_external_context':
						return 'entry-1';
					case 'is_library_scanning':
						return false;
					case 'search_library':
						return searchResults;
					case 'set_shuffle':
						playbackState.is_shuffle = Boolean(args.enabled);
						return null;
					case 'play_tracks_from':
					case 'play_station':
					case 'seek':
						return null;
					case 'get_playback_waveform':
						return {
							recording_id: args.recordingId,
							peaks: Array.from({ length: 600 }, (_, i) => 0.4 + 0.4 * Math.abs(Math.sin(i / 9))),
							rms: Array.from({ length: 600 }, (_, i) => 0.3 + 0.3 * Math.abs(Math.sin(i / 9))),
							source: 'local'
						};
					case 'get_queue':
						return queueSnapshot;
					case 'get_station_songs':
						return [
							{
								id: 'song-now',
								station_id: 'station-1',
								station_name: 'BADRADIO',
								title: 'ROLAND JONES - DEMONZ',
								artist: 'ROLAND JONES',
								track: 'DEMONZ',
								started_at: new Date().toISOString(),
								ended_at: null,
								bpm: 130,
								musical_key: 'Cm',
								tempo_source: 'station',
								artwork_url: null
							},
							{
								id: 'song-before',
								station_id: 'station-2',
								station_name: 'Bassdrive',
								title: 'Calibre - Mr Right On',
								artist: 'Calibre',
								track: 'Mr Right On',
								started_at: new Date(Date.now() - 600_000).toISOString(),
								ended_at: new Date(Date.now() - 300_000).toISOString(),
								bpm: 174,
								musical_key: null,
								tempo_source: 'measured',
								artwork_url: null
							}
						];
					case 'delete_station_song':
						return null;
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
	}, {
		initialShuffle: options.initialShuffle ?? false,
		playback: options.playback ?? {},
		online: options.online ?? []
	});
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
			command === 'play_tracks_from' || command === 'set_shuffle' || command === 'play_external_context'
		);
	});
}

test('double-clicking a library song plays it inside the whole visible list', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/library');

	// Recently added first: newest ids lead.
	await page.getByText('Context Two', { exact: true }).dblclick();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-3', 'track-2', 'track-1'], startIndex: 1 }
			}
		]);
});

test('a picked song shows as playing before the engine reports it', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/library');

	await page.getByText('Context Two', { exact: true }).dblclick();

	// The mock engine never reports a current song; the bar answers at once.
	const bar = page.locator('[data-player-bar]');
	await expect(bar.getByText('Context Two', { exact: true })).toBeVisible();
	await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('clicking the waveform seeks to that point of a downloaded song', async ({ page }) => {
	await installPlaybackMock(page, {
		playback: {
			is_playing: true,
			can_seek: true,
			current_recording_id: 'track-1',
			current_title: 'Context One',
			current_artist: 'Artist One',
			position_ms: 10_000,
			duration_ms: 180_000,
			source: 'local'
		}
	});
	await page.goto('/library');

	const seek = page.locator('[data-player-bar]').getByRole('slider', { name: 'Seek' });
	await expect(seek).toHaveAttribute('data-waveform', 'ready');
	const box = (await seek.boundingBox())!;
	await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);

	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					(window as Window & {
						__PLAYBACK_INVOCATIONS__?: Array<{ command: string; args: Record<string, unknown> }>;
					}).__PLAYBACK_INVOCATIONS__ ?? []
				)
					.filter(({ command }) => command === 'seek')
					.map(({ args }) => Math.round(Number(args.positionMs) / 1000))
			)
		)
		.toEqual([90]);
});

test('search plays the chosen song inside the matching library songs', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/search');

	await page.locator('[data-search-input]').fill('Context');
	await page.locator('main').getByText('Context Two', { exact: true }).dblclick();

	await expect
		.poll(() => playbackInvocations(page))
		.toEqual([
			{
				command: 'play_tracks_from',
				args: { recordingIds: ['track-1', 'track-2', 'track-3'], startIndex: 1 }
			}
		]);
});

test('artist Shuffle plays the artist songs with backend shuffle on', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/artists/artist-1');

	await expect(page.getByRole('heading', { name: 'Artist One' })).toBeVisible();
	await page.locator('main').getByRole('button', { name: 'Shuffle', exact: true }).click();

	await expect.poll(() => playbackInvocations(page)).toHaveLength(2);
	const [play, shuffle] = await playbackInvocations(page);
	expect(play.command).toBe('play_tracks_from');
	expect([...(play.args.recordingIds as string[])].sort()).toEqual(['track-1', 'track-2', 'track-3']);
	expect(shuffle).toEqual({ command: 'set_shuffle', args: { enabled: true } });
});

test('playlist Play submits ordered context and turns backend shuffle off', async ({ page }) => {
	await installPlaybackMock(page, { initialShuffle: true });
	await page.goto('/playlists/playlist-1');

	await expect(page.getByRole('button', { name: 'Continuity Playlist' })).toBeVisible();
	await page.locator('main').getByRole('button', { name: 'Play', exact: true }).first().click();

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

test('the queue renders the native snapshot and mutates by stable session and entry IDs', async ({ page }) => {
	await installPlaybackMock(page);
	await page.goto('/library');

	await page.locator('[data-player-bar]').getByRole('button', { name: 'Queue' }).click();
	const queue = page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Queue' }) });
	await expect(queue.getByText('Context Two', { exact: true })).toBeVisible();
	await expect(queue.getByText('Context Three', { exact: true })).toBeVisible();

	await queue.getByText('Context Two', { exact: true }).dblclick();
	await queue.getByRole('button', { name: 'Remove Context Three from queue' }).click();

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

test('radio player names the connection stage and offers Retry when the station fails', async ({ page }) => {
	const rawName = 'RADIO X :: Hip Hop, Rap, Trap, Techno, House | www.radiox.com [128kbps]';
	await installPlaybackMock(page, {
		playback: {
			source: 'radio',
			is_buffering: true,
			current_station_id: 'station-1',
			current_title: rawName,
			current_artist: 'Connecting…',
			current_source_url: 'https://radio.example/live',
			connection_stage: 'connecting',
			reconnect_attempt: 0,
			reconnect_max: 0,
			connection_error: null
		}
	});
	await page.goto('/');

	const bar = page.locator('[data-player-bar]');
	// The cleaned name, never the raw slogan-stuffed one.
	await expect(bar.getByText('RADIO X', { exact: true })).toBeVisible();
	await expect(bar.getByText('Connecting to RADIO X…')).toBeVisible();
	await expect(bar.locator('[data-station-art="generated"]')).toBeVisible();

	await page.evaluate(() =>
		(window as Window & { __SET_PLAYBACK__?: (patch: Record<string, unknown>) => void })
			.__SET_PLAYBACK__?.({
				connection_stage: 'reconnecting',
				reconnect_attempt: 2,
				reconnect_max: 3
			})
	);
	await expect(bar.getByText('Reconnecting · attempt 2 of 3').first()).toBeVisible();

	await page.evaluate(() =>
		(window as Window & { __SET_PLAYBACK__?: (patch: Record<string, unknown>) => void })
			.__SET_PLAYBACK__?.({
				is_buffering: false,
				connection_stage: 'failed',
				reconnect_attempt: 0,
				connection_error: 'Failed to open station stream',
				current_artist: "Couldn't connect"
			})
	);
	const failed = bar.locator('[data-connection-stage="failed"]');
	await expect(failed).toContainText("Couldn't connect");
	await failed.getByRole('button', { name: 'Retry' }).click();

	await expect
		.poll(() =>
			page.evaluate(() =>
				((window as Window & {
					__PLAYBACK_INVOCATIONS__?: Array<{ command: string; args: Record<string, unknown> }>;
				}).__PLAYBACK_INVOCATIONS__ ?? []).filter(({ command }) => command === 'play_station')
			)
		)
		.toEqual([
			{
				command: 'play_station',
				args: {
					stationId: 'station-1',
					url: 'https://radio.example/live',
					name: rawName,
					favicon: null
				}
			}
		]);
});

const radioWithSong = {
	is_playing: true,
	source: 'radio',
	current_station_id: 'station-1',
	current_title: 'BADRADIO',
	current_source_url: 'https://s2.radio.co/s2b2b68744/listen',
	connection_stage: 'playing',
	stream: {
		title: 'ROLAND JONES - DEMONZ',
		artist: 'ROLAND JONES',
		track: 'DEMONZ',
		started_at: new Date().toISOString(),
		bpm: 130,
		musical_key: 'Cm',
		tempo_source: 'station',
		artwork_url: null,
		log_id: 'song-now'
	}
};

test('a station shows the song it is playing, with tempo and key', async ({ page }) => {
	await installPlaybackMock(page, { playback: radioWithSong });
	await page.goto('/library');

	const bar = page.locator('[data-player-bar]');
	await expect(bar.locator('[data-stream-title]')).toHaveText('DEMONZ');
	await expect(bar.locator('[data-player-subtitle]')).toHaveText('ROLAND JONES · BADRADIO');
	await expect(bar.locator('[data-stream-tempo]')).toHaveText('130 BPM · Cm');

	// The title finds the song to save or download.
	await bar.locator('[data-stream-title]').click();
	await expect(page).toHaveURL(/\/search\?q=ROLAND/);
	await expect(page.getByRole('searchbox')).toHaveValue('ROLAND JONES - DEMONZ');
});

test('songs heard on stations are listed to find again', async ({ page }) => {
	await installPlaybackMock(page, { playback: radioWithSong });
	await page.goto('/heard');

	const rows = page.locator('[data-station-song]');
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toContainText('DEMONZ');
	await expect(rows.first()).toContainText('Now');
	await expect(rows.nth(1)).toContainText('≈ 174 BPM');

	await page.getByPlaceholder('Filter songs or stations').fill('bassdrive');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('Mr Right On');
});

const onlineResult = (source: string, id: string, title: string, artist: string) => ({
	source,
	source_id: id,
	title,
	artist,
	album: null,
	duration_ms: 312_000,
	cover_art_url: null,
	source_url: null,
	play_count: 1000,
	is_saved: false,
	is_downloaded: false,
	recording_id: null
});

test.describe('on a phone', () => {
	// iPhone 13 Pro Max
	test.use({ viewport: { width: 428, height: 926 }, hasTouch: true });

	test('the Library tab leads to heard songs, downloads and playlists', async ({ page }) => {
		await installPlaybackMock(page, { playback: radioWithSong });
		await page.goto('/library');

		const shortcuts = page.locator('[data-mobile-shortcuts]');
		await expect(shortcuts.getByRole('link', { name: 'Heard on radio' })).toBeVisible();
		await expect(shortcuts.getByRole('link', { name: 'Downloads' })).toBeVisible();
		await expect(shortcuts.getByRole('link', { name: 'Continuity Playlist' })).toBeVisible();
		await shortcuts.getByRole('link', { name: 'Heard on radio' }).click();
		await expect(page).toHaveURL(/\/heard$/);
		await expect(page.getByRole('link', { name: 'Library', exact: true })).toHaveAttribute('aria-current', 'page');
	});

	test('no page scrolls sideways', async ({ page }) => {
		await installPlaybackMock(page, { playback: radioWithSong });
		for (const path of ['/library', '/stations', '/search', '/settings', '/downloads', '/heard']) {
			await page.goto(path);
			await page.waitForTimeout(600);
			// Long names must truncate, not widen the page.
			await page.evaluate(() => {
				for (const el of document.querySelectorAll('[role="row"] .truncate')) {
					el.textContent = 'Travis Scott - SICKO MODE (Official Music Video) ft. Drake '.repeat(2);
				}
			});
			const wide = await page.evaluate(() => {
				// The page itself, or any scrolling panel inside it, must not be
				// wider than it looks (iOS lets you drag those sideways).
				const scrollers = [
					document.documentElement,
					...[...document.querySelectorAll<HTMLElement>('body *')].filter(
						(el) =>
							/auto|scroll/.test(getComputedStyle(el).overflowX) &&
							!el.classList.contains('station-rail') &&
							!el.hasAttribute('data-rail')
					)
				];
				const culprits = scrollers
					.filter((el) => el.scrollWidth > el.clientWidth + 1)
					.map(
						(el) =>
							`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} ${el.scrollWidth}>${el.clientWidth}`
					);
				return { scroll: culprits.length, width: 0, culprits };
			});
			expect(wide.scroll, `${path} ${wide.culprits.join(' | ')}`).toBeLessThanOrEqual(wide.width);
		}
	});

	test('a tap plays a song and its menu button is showing', async ({ page }) => {
		await installPlaybackMock(page);
		await page.goto('/library');

		const row = page.getByRole('row').filter({ hasText: 'Context Two' });
		await expect(row.getByRole('button', { name: 'More' })).toBeVisible();
		await expect(page.getByRole('grid').getByText('Album', { exact: true })).toHaveCount(0);
		await row.getByText('Context Two').tap();
		await expect
			.poll(async () => (await playbackInvocations(page)).map((call) => call.command))
			.toContain('play_tracks_from');
		await page.screenshot({ path: 'test-results/mobile-library.png' });
	});

	test('search names every song and switches between SoundCloud and YouTube', async ({ page }) => {
		await installPlaybackMock(page, {
			online: [
				onlineResult('youtube', 'yt1', 'SICKO MODE ft. Drake', 'Travis Scott'),
				onlineResult('soundcloud', 'sc1', 'SICKO MODE', 'Travis Scott'),
				onlineResult('youtube', 'yt2', 'SICKO MODE (Skrillex Remix)', 'Travis Scott'),
				onlineResult('soundcloud', 'sc2', 'Sicko Mode (sped up)', 'nightcore kid')
			]
		});
		await page.goto('/search?q=sicko%20mode');

		const results = page.locator('[data-online-results] > [role="button"]');
		await expect(results).toHaveCount(2);
		await expect(results.first()).toContainText('SICKO MODE');
		await expect(results.first()).toContainText('Travis Scott');
		await page.screenshot({ path: 'test-results/phone-search.png' });

		await page.getByRole('button', { name: /YouTube/ }).tap();
		await expect(results.first()).toContainText('SICKO MODE ft. Drake');
		await results.nth(1).getByText('Skrillex Remix').tap();
		await expect
			.poll(async () => (await playbackInvocations(page)).filter((c) => c.command === 'play_external_context'))
			.toEqual([
				expect.objectContaining({
					args: expect.objectContaining({
						startIndex: 1,
						items: [expect.objectContaining({ source_id: 'yt1' }), expect.objectContaining({ source_id: 'yt2' })]
					})
				})
			]);

		await results.first().getByRole('button', { name: 'More' }).tap();
		const sheet = page.getByRole('menu');
		await expect(sheet.getByRole('button', { name: 'Play next' })).toBeVisible();
		await expect(sheet.getByRole('button', { name: 'Add to library' })).toBeVisible();
		await page.waitForTimeout(400);
		await page.screenshot({ path: 'test-results/phone-search-menu.png' });
		await sheet.getByRole('button', { name: 'Cancel' }).tap();
		await expect(sheet).toHaveCount(0);
	});

	test('settings sit behind the Library gear and only show phone settings', async ({ page }) => {
		await installPlaybackMock(page);
		await page.goto('/library');
		await expect(page.getByText('Context Two')).toBeVisible();
		await page.screenshot({ path: 'test-results/phone-library.png' });
		await page.getByRole('link', { name: 'Settings' }).tap();
		await expect(page).toHaveURL(/\/settings$/);
		await expect(page.getByText('Downloaded songs')).toBeVisible();
		await expect(page.getByText('Music library')).toHaveCount(0);
		await expect(page.getByText('App updates')).toHaveCount(0);
		await page.screenshot({ path: 'test-results/phone-settings.png' });
	});

	test('opening Now Playing leaves the song alone; a tap on the bar seeks once', async ({ page }) => {
		await installPlaybackMock(page, {
			playback: {
				is_playing: true,
				can_seek: true,
				source: 'youtube',
				current_recording_id: 'track-2',
				current_title: 'Context Two',
				current_artist: 'Artist Two',
				position_ms: 10_000,
				duration_ms: 300_000
			}
		});
		await page.goto('/library');
		const seeks = () =>
			page.evaluate(
				() =>
					((window as any).__PLAYBACK_INVOCATIONS__ as { command: string }[]).filter(
						(c) => c.command === 'seek'
					).length
			);

		await page.getByRole('button', { name: 'Pause' }).first().waitFor();
		await page.getByText('Context Two').last().tap();
		await expect(page.getByText('Playing from YouTube')).toBeVisible();
		for (const position of [11_000, 12_000, 13_000, 14_000]) {
			await page.evaluate((ms) => (window as any).__SET_PLAYBACK__({ position_ms: ms }), position);
			await page.waitForTimeout(300);
		}
		expect(await seeks()).toBe(0);

		const track = page.locator('[data-seek-bar]');
		const box = (await track.boundingBox())!;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await expect.poll(seeks).toBe(1);
		await page.waitForTimeout(800);
		expect(await seeks()).toBe(1);

		// A drag scrubs: the sheet stays put and one seek lands near the end.
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
		await page.mouse.down();
		for (const f of [0.35, 0.5, 0.65, 0.8]) {
			await page.mouse.move(box.x + box.width * f, box.y + box.height / 2, { steps: 4 });
		}
		await page.mouse.up();
		await expect.poll(seeks).toBe(2);
		const last = await page.evaluate(() =>
			((window as any).__PLAYBACK_INVOCATIONS__ as { command: string; args: { positionMs?: number } }[])
				.filter((c) => c.command === 'seek')
				.at(-1)
		);
		expect(JSON.stringify(last)).toMatch(/2[2-5]\d{4}/);
		await expect(page.getByText('Playing from YouTube')).toBeVisible();

		// A new song starts the bar from zero, not from the last drag.
		await page.evaluate(() =>
			(window as any).__SET_PLAYBACK__({ current_recording_id: 'rec-next', position_ms: 0 })
		);
		await expect(page.getByRole('slider', { name: 'Song position' })).toHaveAttribute(
			'aria-valuenow',
			'0'
		);
	});
});

