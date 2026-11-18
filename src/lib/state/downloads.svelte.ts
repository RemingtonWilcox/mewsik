import * as api from '$lib/api/tauri';

let _activeCount = $state(0);
let _polling = false;
let _completed: Set<string> | null = null;
const _finishedListeners = new Set<() => void>();

function startPolling() {
	if (_polling) return;
	_polling = true;
	const poll = async () => {
		try {
			const downloads = await api.getDownloads();
			_activeCount = downloads.filter(
				(d: any) => d.status === 'pending' || d.status === 'downloading' || d.status === 'processing'
			).length;
			const completed = new Set(
				downloads.filter((d: any) => d.status === 'completed').map((d: any) => d.id as string)
			);
			const finishedNew = _completed !== null && [...completed].some((id) => !_completed!.has(id));
			_completed = completed;
			if (finishedNew) for (const listener of _finishedListeners) listener();
		} catch {
			// ignore
		}
	};
	void poll();
	setInterval(poll, 2000);
}

export function useActiveDownloads() {
	startPolling();
	return {
		get count() { return _activeCount; },
	};
}

/** Calls `listener` whenever a download finishes (a finished song joins the library). */
export function onDownloadFinished(listener: () => void) {
	startPolling();
	_finishedListeners.add(listener);
	return () => _finishedListeners.delete(listener);
}
