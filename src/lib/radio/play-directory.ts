import * as api from '$lib/api/tauri';
import type { RadioBrowserStation } from '$lib/api/tauri';
import { cleanStationName } from '$lib/radio/names';
import { usePlayer } from '$lib/state/player.svelte';

/** Play a station straight from the radio directory (a search result, a
 *  shared link, a random pick). The player shows "Connecting to …" while the
 *  stream is checked. */
export function playDirectoryStation(station: RadioBrowserStation): Promise<string> {
	return usePlayer().playStation({ name: cleanStationName(station.name), url: station.url }, () =>
		api.playStationSearchResult(station)
	);
}

/** "Name · Country", for toasts. */
export function stationLabel(station: RadioBrowserStation): string {
	const where = station.country?.trim();
	return `${cleanStationName(station.name)}${where ? ` · ${where}` : ''}`;
}
