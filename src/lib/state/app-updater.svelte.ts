import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type AppUpdateStatus =
	| 'idle'
	| 'checking'
	| 'current'
	| 'available'
	| 'downloading'
	| 'ready'
	| 'relaunching'
	| 'unavailable'
	| 'error';

export interface AvailableAppUpdate {
	version: string;
	currentVersion: string;
	date: string | null;
	body: string | null;
}

type UnavailableReason = 'development' | 'configuration' | 'feed' | null;

interface ReleaseRuntimeInfo {
	appVersion: string;
	updateChannel: string | null;
	updaterConfigured: boolean;
	platform: string;
	architecture: string;
}

interface DownloadJobStatus {
	status: string;
}

interface UpdateInstallReadiness {
	ready: boolean;
	activeDownloads: number;
}

const configuredVersion = __MEWSIK_APP_VERSION__;

let status = $state<AppUpdateStatus>('idle');
let currentVersion = $state(configuredVersion);
let availableUpdate = $state<AvailableAppUpdate | null>(null);
let errorMessage = $state('');
let unavailableReason = $state<UnavailableReason>(null);
let downloadedBytes = $state(0);
let totalBytes = $state<number | null>(null);
let noticeDismissed = $state(false);
let updaterRuntimeReady = $state(false);
let launchCheckStarted = false;
let pendingUpdate: Update | null = null;
let updatePackageDownloaded = false;
let runtimeInfoPromise: Promise<ReleaseRuntimeInfo | null> | null = null;

function hasTauriRuntime(): boolean {
	if (typeof window === 'undefined') return false;
	const runtime = (window as Window & {
		__TAURI_INTERNALS__?: { invoke?: unknown };
	}).__TAURI_INTERNALS__;
	return typeof runtime?.invoke === 'function';
}

function allowDevelopmentUpdaterOverride(): boolean {
	if (!hasTauriRuntime()) return false;
	const testOverride = Boolean(
		(window as Window & { __MEWSIK_TEST_ALLOW_UPDATER__?: boolean })
			.__MEWSIK_TEST_ALLOW_UPDATER__
	);
	return !import.meta.env.DEV || testOverride;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error ?? 'Unknown updater error');
}

function isConfigurationError(error: unknown): boolean {
	const message = normalizeError(error).toLowerCase();
	return [
		'not configured',
		'endpoint',
		'public key',
		'pubkey',
		'plugin not found',
		'command plugin:updater',
		'not allowed',
		'permission denied'
	].some((fragment) => message.includes(fragment));
}

function isUnpublishedFeedError(error: unknown): boolean {
	return normalizeError(error)
		.toLowerCase()
		.includes('could not fetch a valid release json from the remote');
}

async function inspectReleaseRuntime(): Promise<ReleaseRuntimeInfo | null> {
	if (runtimeInfoPromise) return runtimeInfoPromise;
	runtimeInfoPromise = (async () => {
		if (!hasTauriRuntime() || !allowDevelopmentUpdaterOverride()) {
			status = 'unavailable';
			unavailableReason = 'development';
			return null;
		}

		try {
			const info = await invoke<ReleaseRuntimeInfo>('get_release_runtime_info');
			currentVersion = info.appVersion || currentVersion;
			if (!info.updaterConfigured || !info.updateChannel) {
				status = 'unavailable';
				unavailableReason = 'configuration';
				return info;
			}
			updaterRuntimeReady = true;
			unavailableReason = null;
			return info;
		} catch {
			// Older or partially configured desktop builds can still report their
			// version, but must never guess that an update endpoint is safe to call.
			try {
				currentVersion = await getVersion();
			} catch {
				// Keep the build-time package version fallback.
			}
			status = 'unavailable';
			unavailableReason = 'configuration';
			return null;
		}
	})();
	return runtimeInfoPromise;
}

async function releasePendingUpdate() {
	const update = pendingUpdate;
	pendingUpdate = null;
	updatePackageDownloaded = false;
	if (update) {
		await update.close().catch(() => undefined);
	}
}

async function performCheck() {
	if (status === 'checking' || status === 'downloading' || status === 'relaunching') return;

	await inspectReleaseRuntime();
	if (!updaterRuntimeReady) return;

	status = 'checking';
	errorMessage = '';
	unavailableReason = null;
	downloadedBytes = 0;
	totalBytes = null;
	await releasePendingUpdate();
	availableUpdate = null;

	try {
		const update = await check({ timeout: 15_000 });
		if (!update) {
			status = 'current';
			return;
		}

		pendingUpdate = update;
		currentVersion = update.currentVersion || currentVersion;
		availableUpdate = {
			version: update.version,
			currentVersion: update.currentVersion || currentVersion,
			date: update.date ?? null,
			body: update.body?.trim() || null
		};
		noticeDismissed = false;
		status = 'available';
	} catch (error) {
		if (isConfigurationError(error)) {
			status = 'unavailable';
			unavailableReason = 'configuration';
			return;
		}
		if (isUnpublishedFeedError(error)) {
			// A bootstrap release can exist before GitHub has ever published a
			// latest.json asset. That is a quiet feed state, not evidence that the
			// listener's internet connection is broken.
			status = 'unavailable';
			unavailableReason = 'feed';
			return;
		}

		status = 'error';
		errorMessage = 'Could not reach the update service. Check your connection and try again.';
	}
}

function handleDownloadEvent(event: DownloadEvent) {
	switch (event.event) {
		case 'Started':
			downloadedBytes = 0;
			totalBytes = event.data.contentLength ?? null;
			break;
		case 'Progress':
			downloadedBytes += event.data.chunkLength;
			break;
		case 'Finished':
			if (totalBytes !== null) downloadedBytes = totalBytes;
			break;
	}
}

async function downloadsAreSafeToInterrupt(): Promise<boolean> {
	let downloads: DownloadJobStatus[];
	try {
		downloads = await invoke<DownloadJobStatus[]>('get_downloads');
	} catch {
		errorMessage =
			'mewsik could not confirm that music downloads are idle. Open Downloads, then try again.';
		return false;
	}

	const activeCount = downloads.filter((download) =>
		['pending', 'downloading', 'processing'].includes(download.status)
	).length;
	if (activeCount > 0) {
		setActiveDownloadsError(activeCount);
		return false;
	}
	return true;
}

function setActiveDownloadsError(activeCount: number) {
	errorMessage = `Finish or cancel ${activeCount} active music ${activeCount === 1 ? 'download' : 'downloads'} before restarting for this update.`;
}

async function restartApp(
	failureMessage = 'mewsik could not restart itself. Restart it normally; your library is safe.'
) {
	if (status !== 'ready') return;
	status = 'relaunching';
	errorMessage = '';
	try {
		await relaunch();
	} catch {
		status = 'ready';
		errorMessage = failureMessage;
	}
}

async function installAndRestart() {
	if (!pendingUpdate || status !== 'available') return;
	// Claim the flow before the first await. Two clicks in the same event turn
	// must not download/install through the same Update resource concurrently.
	status = 'downloading';
	errorMessage = '';
	if (!(await downloadsAreSafeToInterrupt())) {
		status = 'available';
		return;
	}

	if (!updatePackageDownloaded) {
		downloadedBytes = 0;
		totalBytes = null;
		try {
			await pendingUpdate.download(handleDownloadEvent);
			updatePackageDownloaded = true;
		} catch {
			updatePackageDownloaded = false;
			status = 'available';
			errorMessage = 'The update could not be downloaded. Your current version was not changed; try again.';
			return;
		}
	}

	// A music download can begin while the application package is downloading.
	// Check again for a clear user-facing result, then use the native command as
	// the atomic admission gate before any process teardown begins.
	if (!(await downloadsAreSafeToInterrupt())) {
		status = 'available';
		return;
	}

	let readiness: UpdateInstallReadiness;
	let installFailed = false;
	try {
		readiness = await invoke<UpdateInstallReadiness>('prepare_update_install');
	} catch {
		status = 'available';
		errorMessage = 'mewsik could not safely prepare the update. Nothing was installed; try again.';
		return;
	}
	if (!readiness.ready) {
		status = 'available';
		setActiveDownloadsError(readiness.activeDownloads);
		return;
	}

	try {
		// On Windows a successful NSIS install exits from native code, so this
		// promise normally never resolves. If setup fails or another platform
		// returns normally, relaunch immediately because native services are now
		// deliberately quiesced.
		await pendingUpdate.install();
	} catch {
		installFailed = true;
		errorMessage = 'The updater could not finish. mewsik will restart without changing your library.';
	}

	status = 'ready';
	await restartApp(
		installFailed
			? 'The update failed and mewsik could not restart automatically. Restart it normally; your library is safe.'
			: undefined
	);
}

function startLaunchCheck() {
	if (launchCheckStarted) return;
	launchCheckStarted = true;
	void performCheck();
}

export function useAppUpdater() {
	return {
		get status() {
			return status;
		},
		get currentVersion() {
			return currentVersion;
		},
		get availableUpdate() {
			return availableUpdate;
		},
		get errorMessage() {
			return errorMessage;
		},
		get unavailableReason() {
			return unavailableReason;
		},
		get downloadedBytes() {
			return downloadedBytes;
		},
		get totalBytes() {
			return totalBytes;
		},
		get progressPercent() {
			if (!totalBytes || totalBytes <= 0) return null;
			return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
		},
		get showNotice() {
			return status === 'available' && availableUpdate !== null && !noticeDismissed;
		},
		get canCheck() {
			return (
				updaterRuntimeReady &&
				unavailableReason !== 'configuration' &&
				!['checking', 'available', 'downloading', 'ready', 'relaunching'].includes(status)
			);
		},
		startLaunchCheck,
		checkNow: performCheck,
		installAndRestart,
		restartApp,
		dismissNotice() {
			noticeDismissed = true;
		}
	};
}
