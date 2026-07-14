import { expect, test, type Page } from '@playwright/test';

type UpdateScenario =
	| 'available'
	| 'current'
	| 'unconfigured'
	| 'network-error'
	| 'feed-missing'
	| 'active-download'
	| 'download-started-mid-update'
	| 'atomic-download-race'
	| 'install-error';

async function installUpdaterRuntime(page: Page, scenario: UpdateScenario) {
	await page.addInitScript(({ scenario }) => {
		type Invocation = { command: string; args: Record<string, unknown> };
		type Callback = (payload: unknown) => void;
		const runtimeWindow = window as Window & {
			__MEWSIK_TEST_ALLOW_UPDATER__?: boolean;
			__UPDATE_INVOCATIONS__?: Invocation[];
			__FINISH_UPDATE__?: () => void;
			__SET_DOWNLOADS_IDLE__?: () => void;
		};
		runtimeWindow.__MEWSIK_TEST_ALLOW_UPDATER__ = true;
		runtimeWindow.__UPDATE_INVOCATIONS__ = [];

		const callbacks = new Map<number, Callback>();
		let nextCallbackId = 1;
		let appPackageDownloadStarted = false;
		let forceDownloadsIdle = false;
		runtimeWindow.__SET_DOWNLOADS_IDLE__ = () => {
			forceDownloadsIdle = true;
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

		function emitChannel(channel: unknown, index: number, message: unknown) {
			const callbackId = Number((channel as { id?: number })?.id);
			callbacks.get(callbackId)?.({ index, message });
		}

		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: Record<string, unknown> = {}) => {
				runtimeWindow.__UPDATE_INVOCATIONS__?.push({ command, args });
				switch (command) {
					case 'get_release_runtime_info':
						return {
							appVersion: '0.1.0',
							updateChannel: scenario === 'unconfigured' ? null : 'stable',
							updaterConfigured: scenario !== 'unconfigured',
							platform: 'windows',
							architecture: 'x86_64'
						};
					case 'plugin:updater|check':
						if (scenario === 'network-error') throw new Error('network timed out');
						if (scenario === 'feed-missing') {
							throw new Error('Could not fetch a valid release JSON from the remote');
						}
						if (
							scenario !== 'available' &&
							scenario !== 'active-download' &&
							scenario !== 'download-started-mid-update' &&
							scenario !== 'atomic-download-race' &&
							scenario !== 'install-error'
						)
							return null;
						return {
							rid: 41,
							currentVersion: '0.1.0',
							version: '0.2.0',
							date: '2026-07-14T12:00:00Z',
							body: 'A steadier queue and a safer update path.',
							rawJson: {}
						};
					case 'plugin:updater|download': {
						appPackageDownloadStarted = true;
						const channel = args.onEvent;
						emitChannel(channel, 0, {
							event: 'Started',
							data: { contentLength: 1_000 }
						});
						emitChannel(channel, 1, {
							event: 'Progress',
							data: { chunkLength: 400 }
						});
						await new Promise<void>((resolve) => {
							runtimeWindow.__FINISH_UPDATE__ = () => {
								emitChannel(channel, 2, {
									event: 'Progress',
									data: { chunkLength: 600 }
								});
								emitChannel(channel, 3, { event: 'Finished' });
								const callbackId = Number((channel as { id?: number })?.id);
								callbacks.get(callbackId)?.({ index: 4, end: true });
								resolve();
							};
						});
						return 73;
					}
					case 'prepare_update_install':
						if (scenario === 'atomic-download-race' && !forceDownloadsIdle) {
							return { ready: false, activeDownloads: 1 };
						}
						return { ready: true, activeDownloads: 0 };
					case 'plugin:updater|install':
						if (scenario === 'install-error') throw new Error('installer extraction failed');
						// A successful Windows updater exits in native code. Model that
						// terminal promise instead of pretending JavaScript continues.
						await new Promise(() => undefined);
						return null;
					case 'plugin:process|restart':
						if (scenario === 'install-error') throw new Error('restart failed');
						return null;
					case 'plugin:resources|close':
					case 'plugin:event|unlisten':
					case 'start_sidecar':
						return null;
					case 'plugin:event|listen':
						return 1;
					case 'get_playback_state':
						return playbackState;
					case 'get_downloads':
						if (scenario === 'active-download') {
							return [{ id: 'active', status: 'downloading' }];
						}
						if (
							scenario === 'download-started-mid-update' &&
							appPackageDownloadStarted &&
							!forceDownloadsIdle
						) {
							return [{ id: 'late', status: 'processing' }];
						}
						return [];
					case 'get_library_paths':
					case 'get_library_tracks':
					case 'get_all_artists':
					case 'get_all_albums':
					case 'get_playlists':
					case 'get_daily_mix':
					case 'get_recently_played':
						return [];
					case 'get_play_stats':
						return { total_plays: 0, total_time_ms: 0, unique_tracks: 0 };
					case 'get_download_location':
						return {
							directory: 'C:\\Users\\listener\\Music\\Mewsik',
							default_directory: 'C:\\Users\\listener\\Music\\Mewsik',
							is_custom: false,
							exists: true,
							legacy_file_count: 0,
							legacy_bytes: 0
						};
					case 'sidecar_status':
						return false;
					default:
						return null;
				}
			},
			transformCallback: (callback: Callback) => {
				const id = nextCallbackId++;
				callbacks.set(id, callback);
				return id;
			},
			unregisterCallback: (id: number) => callbacks.delete(id)
		};
		(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
			unregisterListener: () => undefined
		};
	}, { scenario });
}

async function updateCommands(page: Page) {
	return page.evaluate(() => {
		const invocations = (window as Window & {
			__UPDATE_INVOCATIONS__?: Array<{ command: string }>;
		}).__UPDATE_INVOCATIONS__ ?? [];
		return invocations
			.map(({ command }) => command)
			.filter(
				(command) =>
					command === 'get_release_runtime_info' ||
					command === 'prepare_update_install' ||
					command.startsWith('plugin:updater|') ||
					command === 'plugin:process|restart'
			);
	});
}

test('a packaged launch checks once and offers a nonblocking update action', async ({ page }) => {
	await installUpdaterRuntime(page, 'available');
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'mewsik' })).toBeVisible({ timeout: 15_000 });

	await expect.poll(() => updateCommands(page), { timeout: 15_000 }).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
	const notice = page.getByTestId('update-available-notice');
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('mewsik 0.2.0 is ready');

	await notice.getByRole('link', { name: 'Review update' }).click();
	await expect(page.getByTestId('app-updates')).toContainText('Version 0.2.0 is available');
	await expect(page.getByTestId('app-updates')).toContainText('A steadier queue and a safer update path.');
	await page.waitForTimeout(300);
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
});

test('install reports progress and hands off atomically to the terminal Windows installer', async ({ page }) => {
	await installUpdaterRuntime(page, 'available');
	await page.goto('/settings');

	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Version 0.2.0 is available')).toBeVisible();
	await updateCard.getByRole('button', { name: 'Install and restart' }).evaluate((button) => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});

	await expect(updateCard.getByText('40%', { exact: true })).toBeVisible();
	await expect(updateCard.getByLabel('Update download progress')).toHaveAttribute('value', '40');
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download'
	]);

	await page.evaluate(() => {
		(window as Window & { __FINISH_UPDATE__?: () => void }).__FINISH_UPDATE__?.();
	});
	await expect(updateCard.getByRole('button', { name: 'Installing…' })).toBeVisible();
	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download',
		'prepare_update_install',
		'plugin:updater|install'
	]);
});

test('install refuses to interrupt an active music download', async ({ page }) => {
	await installUpdaterRuntime(page, 'active-download');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Version 0.2.0 is available')).toBeVisible();
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await expect(updateCard.getByRole('alert')).toHaveText(
		'Finish or cancel 1 active music download before restarting for this update.'
	);
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
});

test('a music download that starts mid-update postpones install without redownloading the app', async ({ page }) => {
	await installUpdaterRuntime(page, 'download-started-mid-update');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Version 0.2.0 is available')).toBeVisible();
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await expect(updateCard.getByText('40%', { exact: true })).toBeVisible();
	await page.evaluate(() => {
		(window as Window & { __FINISH_UPDATE__?: () => void }).__FINISH_UPDATE__?.();
	});

	await expect(updateCard.getByRole('alert')).toHaveText(
		'Finish or cancel 1 active music download before restarting for this update.'
	);
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download'
	]);

	await page.evaluate(() => {
		(window as Window & { __SET_DOWNLOADS_IDLE__?: () => void }).__SET_DOWNLOADS_IDLE__?.();
	});
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download',
		'prepare_update_install',
		'plugin:updater|install'
	]);
});

test('the atomic native gate catches a late music download and reuses the app package on retry', async ({ page }) => {
	await installUpdaterRuntime(page, 'atomic-download-race');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Version 0.2.0 is available')).toBeVisible();
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await page.evaluate(() => {
		(window as Window & { __FINISH_UPDATE__?: () => void }).__FINISH_UPDATE__?.();
	});
	await expect(updateCard.getByRole('alert')).toHaveText(
		'Finish or cancel 1 active music download before restarting for this update.'
	);
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download',
		'prepare_update_install'
	]);

	await page.evaluate(() => {
		(window as Window & { __SET_DOWNLOADS_IDLE__?: () => void }).__SET_DOWNLOADS_IDLE__?.();
	});
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download',
		'prepare_update_install',
		'prepare_update_install',
		'plugin:updater|install'
	]);
});

test('an installer setup failure relaunches the deliberately quiesced app', async ({ page }) => {
	await installUpdaterRuntime(page, 'install-error');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Version 0.2.0 is available')).toBeVisible();
	await updateCard.getByRole('button', { name: 'Install and restart' }).click();
	await page.evaluate(() => {
		(window as Window & { __FINISH_UPDATE__?: () => void }).__FINISH_UPDATE__?.();
	});
	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|download',
		'prepare_update_install',
		'plugin:updater|install',
		'plugin:process|restart'
	]);
	await expect(updateCard.getByRole('alert')).toHaveText(
		'The update failed and mewsik could not restart automatically. Restart it normally; your library is safe.'
	);
});

test('an up-to-date release stays quiet and only rechecks on explicit request', async ({ page }) => {
	await installUpdaterRuntime(page, 'current');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('You’re up to date')).toBeVisible();
	await expect(page.getByTestId('update-available-notice')).toHaveCount(0);
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);

	await updateCard.getByRole('button', { name: 'Check again' }).click();
	await expect.poll(() => updateCommands(page)).toEqual([
		'get_release_runtime_info',
		'plugin:updater|check',
		'plugin:updater|check'
	]);
});

test('an unconfigured build never invokes the updater endpoint', async ({ page }) => {
	await installUpdaterRuntime(page, 'unconfigured');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Automatic updates are not configured in this build')).toBeVisible();
	await expect(updateCard.getByRole('button', { name: 'Unavailable in this build' })).toBeDisabled();
	await expect(updateCommands(page)).resolves.toEqual(['get_release_runtime_info']);
});

test('a failed check is announced accessibly and can be retried', async ({ page }) => {
	await installUpdaterRuntime(page, 'network-error');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByRole('alert')).toHaveText(
		'Could not reach the update service. Check your connection and try again.'
	);
	await expect(updateCard.getByRole('button', { name: 'Check again' })).toBeEnabled();
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
});

test('a bootstrap release treats a missing first feed as quiet and retryable', async ({ page }) => {
	await installUpdaterRuntime(page, 'feed-missing');
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('No update feed has been published yet')).toBeVisible();
	await expect(updateCard.getByRole('alert')).toHaveCount(0);
	await expect(updateCard.getByRole('button', { name: 'Check again' })).toBeEnabled();
	await expect(updateCommands(page)).resolves.toEqual([
		'get_release_runtime_info',
		'plugin:updater|check'
	]);
});

test('the browser development preview keeps update controls inert', async ({ page }) => {
	await page.goto('/settings');

	const updateCard = page.getByTestId('app-updates');
	await expect(updateCard.getByText('Update checks are available in installed releases')).toBeVisible();
	await expect(updateCard.getByRole('button', { name: 'Release builds only' })).toBeDisabled();
});
