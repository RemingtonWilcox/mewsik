// Share links for stations and playlists.
//
// A station link is https://remingtonwilcox.github.io/mewsik/s/#<id>, where
// <id> is the radio-browser UUID as 22 base64url characters; a playlist link
// is .../mewsik/p/#<data>. The page behind both (site/open/index.html) shows
// what was shared, offers downloads, and hands it to the app as
// mewsik://station/<uuid> or mewsik://playlist/<data>. Everything rides in
// the #fragment, which the browser never sends to the server. Older
// .../open/#station=<uuid>&name=... links still work.
//
// A playlist travels inside the link itself: base64url of deflate-raw JSON
// { v: 1, n: name, t: SharedTrack[] }. No account, no server copy.

import { invoke } from '@tauri-apps/api/core';
import { toast } from 'svelte-sonner';

const SITE = 'https://remingtonwilcox.github.io/mewsik/';
/** The first share links (0.4.3) used this page with ?-style hash params. */
export const SHARE_PAGE = `${SITE}open/`;
const STATION_PAGE = `${SITE}s/`;
const PLAYLIST_PAGE = `${SITE}p/`;

/** One song as a share link carries it (`SharedTrack` in db/models.rs). */
export interface SharedTrack {
	t: string;
	a: string;
	d?: number;
	s?: string;
	i?: string;
}

export interface SharedPlaylist {
	v: 1;
	n: string;
	t: SharedTrack[];
}

export type AppLink =
	| { kind: 'station'; uuid: string }
	| { kind: 'playlist'; playlist: SharedPlaylist };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stationShareUrl(uuid: string): string {
	return `${STATION_PAGE}#${compactUuid(uuid)}`;
}

export async function playlistShareUrl(name: string, tracks: SharedTrack[]): Promise<string> {
	const data = await encodePlaylist({ v: 1, n: name, t: tracks });
	return `${PLAYLIST_PAGE}#${data}`;
}

/** A UUID's 16 bytes as 22 base64url characters. */
export function compactUuid(uuid: string): string {
	const hex = uuid.replace(/-/g, '').toLowerCase();
	let binary = '';
	for (let i = 0; i < 32; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function expandUuid(id: string): string | null {
	if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
	const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/') + '==');
	const hex = Array.from(binary, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function encodePlaylist(playlist: SharedPlaylist): Promise<string> {
	const json = new TextEncoder().encode(JSON.stringify(playlist));
	const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodePlaylist(data: string): Promise<SharedPlaylist | null> {
	try {
		const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(b64 + '==='.slice((b64.length + 3) % 4));
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
		const parsed = (await new Response(stream).json()) as Partial<SharedPlaylist>;
		if (!Array.isArray(parsed.t)) return null;
		const tracks = parsed.t
			.filter((t): t is SharedTrack => !!t && typeof t.t === 'string' && t.t.trim() !== '')
			.slice(0, 200)
			.map((t) => ({
				t: t.t,
				a: typeof t.a === 'string' ? t.a : '',
				...(typeof t.d === 'number' ? { d: t.d } : {}),
				...(typeof t.s === 'string' && typeof t.i === 'string' ? { s: t.s, i: t.i } : {})
			}));
		return { v: 1, n: typeof parsed.n === 'string' ? parsed.n : 'Shared playlist', t: tracks };
	} catch {
		return null;
	}
}

/** Reads a mewsik:// link, or a pasted share-page link. */
export async function parseAppLink(raw: string): Promise<AppLink | null> {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol === 'mewsik:') {
		// mewsik://station/<uuid>: "station" parses as the host.
		const kind = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
		const rest = (url.hostname ? url.pathname : url.pathname.replace(/^\/+[^/]+/, '')).replace(/^\/+/, '');
		if (kind === 'station' && UUID.test(rest)) return { kind: 'station', uuid: rest.toLowerCase() };
		if (kind === 'playlist' && rest) {
			const playlist = await decodePlaylist(rest);
			return playlist ? { kind: 'playlist', playlist } : null;
		}
		return null;
	}
	const hash = url.hash.slice(1);
	if (url.href.startsWith(STATION_PAGE)) {
		const uuid = expandUuid(hash) ?? (UUID.test(hash) ? hash.toLowerCase() : null);
		return uuid ? { kind: 'station', uuid } : null;
	}
	if (url.href.startsWith(PLAYLIST_PAGE) && hash) {
		const playlist = await decodePlaylist(hash);
		return playlist ? { kind: 'playlist', playlist } : null;
	}
	if (url.href.startsWith(SHARE_PAGE)) {
		const params = new URLSearchParams(url.hash.slice(1));
		const station = params.get('station');
		if (station && UUID.test(station)) return { kind: 'station', uuid: station.toLowerCase() };
		const data = params.get('playlist');
		if (data) {
			const playlist = await decodePlaylist(data);
			return playlist ? { kind: 'playlist', playlist } : null;
		}
	}
	return null;
}

/** The system share sheet where there is one (iPhone), else the clipboard. */
export async function shareLink(url: string, title: string): Promise<void> {
	if (typeof navigator.share === 'function' && /iPhone|iPad/.test(navigator.userAgent)) {
		try {
			await navigator.share({ title, url });
			return;
		} catch (error) {
			if ((error as DOMException)?.name === 'AbortError') return;
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		toast.success('Link copied', { description: `Send it to anyone. It opens ${title} in mewsik.` });
	} catch {
		toast.error('Couldn’t copy the link');
	}
}

/** Songs of a playlist as a link carries them. */
export const getPlaylistShareItems = (playlistId: string) =>
	invoke<SharedTrack[]>('get_playlist_share_items', { playlistId });

/** Share the saved station with this local id (the one that's playing). */
export async function shareStation(stationId: string | null): Promise<void> {
	const station = stationId
		? await invoke<{ name: string; radio_browser_id: string | null } | null>(
				'get_station',
				{ stationId }
			).catch(() => null)
		: null;
	const uuid = station?.radio_browser_id;
	if (!station || !uuid || !UUID.test(uuid)) {
		toast('This station can’t be shared', {
			description: 'Only stations from the radio directory have a link.'
		});
		return;
	}
	const { cleanStationName } = await import('$lib/radio/names');
	const name = cleanStationName(station.name);
	await shareLink(stationShareUrl(uuid), name);
}
