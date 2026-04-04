import * as api from '$lib/api/tauri';

let _activeCount = $state(0);
let _polling = false;

export function useActiveDownloads() {
	if (!_polling) {
		_polling = true;
		const poll = async () => {
			try {
				const downloads = await api.getDownloads();
				_activeCount = downloads.filter(
					(d: any) => d.status === 'pending' || d.status === 'downloading' || d.status === 'processing'
				).length;
			} catch {
				// ignore
			}
		};
		void poll();
		setInterval(poll, 2000);
	}

	return {
		get count() { return _activeCount; },
	};
}
