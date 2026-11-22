// Opens mewsik:// share links: a station starts playing, a playlist opens
// the /shared preview where it can be added to the library.

import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import * as api from '$lib/api/tauri';
import { cleanStationName } from '$lib/radio/names';
import { parseAppLink, type SharedPlaylist } from '$lib/share';
import { usePlayer } from '$lib/state/player.svelte';

let pending = $state<SharedPlaylist | null>(null);
let started = false;

/** The playlist from the last opened link, shown by /shared. */
export function useSharedPlaylist() {
	return {
		get current() {
			return pending;
		},
		clear() {
			pending = null;
		}
	};
}

/** Listen for share links. Call once from the root layout. */
export async function startAppLinks(): Promise<void> {
	if (started) return;
	started = true;
	let deepLink: typeof import('@tauri-apps/plugin-deep-link');
	try {
		deepLink = await import('@tauri-apps/plugin-deep-link');
	} catch {
		return;
	}
	try {
		await deepLink.onOpenUrl((urls) => void openAll(urls));
		// The link that launched the app, if any.
		const initial = await deepLink.getCurrent();
		if (initial?.length) void openAll(initial);
	} catch {
		// Not inside the app (browser preview): nothing to listen to.
	}
}

async function openAll(urls: string[]) {
	for (const url of urls) {
		if (await openAppLink(url)) return;
	}
}

export async function openAppLink(raw: string): Promise<boolean> {
	const link = await parseAppLink(raw);
	if (!link) return false;
	if (link.kind === 'playlist') {
		pending = link.playlist;
		await goto('/shared');
		return true;
	}
	const [station] = await api.getRadioStationDetails([link.uuid]);
	if (!station) {
		toast.error('That station isn’t in the radio directory anymore');
		return true;
	}
	const name = cleanStationName(station.name);
	try {
		await usePlayer().playStation({ name, url: station.url }, () =>
			api.playStationSearchResult(station)
		);
		toast(`Playing ${name}`, { description: 'Shared with you' });
	} catch (error) {
		toast.error(`Couldn’t play ${name}: ${error}`);
	}
	return true;
}
