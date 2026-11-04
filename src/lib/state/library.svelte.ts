import type { LibraryTrack } from '$lib/types';
import * as api from '$lib/api/tauri';
import { toast } from 'svelte-sonner';

export interface AlbumSummary {
	id: string;
	title: string;
	artist: string;
	artistId: string;
	year: number | null;
	cover: string | null;
	tracks: LibraryTrack[];
}

export interface ArtistSummary {
	id: string;
	name: string;
	cover: string | null;
	trackCount: number;
	albumCount: number;
}

let tracks = $state<LibraryTrack[]>([]);
let loaded = $state(false);
let loading = $state(false);
let scanning = $state(false);
let error = $state('');
let started = false;

// Albums and artists come from the track list itself, so they always agree
// with what is playable and carry a cover and an artist name.
const albums = $derived.by(() => {
	const byId = new Map<string, AlbumSummary>();
	for (const track of tracks) {
		if (!track.album_id || !track.album_title) continue;
		let album = byId.get(track.album_id);
		if (!album) {
			album = {
				id: track.album_id,
				title: track.album_title,
				artist: track.artist_name,
				artistId: track.artist_id,
				year: track.year,
				cover: null,
				tracks: []
			};
			byId.set(track.album_id, album);
		}
		album.cover ??= track.cover_art_path || track.cover_art_url || null;
		album.tracks.push(track);
	}
	return [...byId.values()].sort((a, b) =>
		a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
	);
});

const artists = $derived.by(() => {
	const byId = new Map<string, ArtistSummary & { albums: Set<string> }>();
	for (const track of tracks) {
		if (!track.artist_id) continue;
		let artist = byId.get(track.artist_id);
		if (!artist) {
			artist = {
				id: track.artist_id,
				name: track.artist_name,
				cover: null,
				trackCount: 0,
				albumCount: 0,
				albums: new Set()
			};
			byId.set(track.artist_id, artist);
		}
		artist.trackCount += 1;
		if (track.album_id) artist.albums.add(track.album_id);
		artist.cover ??= track.cover_art_path || track.cover_art_url || null;
	}
	return [...byId.values()]
		.map(({ albums, ...artist }) => ({ ...artist, albumCount: albums.size }))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});

const byId = $derived(new Map(tracks.map((track) => [track.id, track])));

async function refresh() {
	loading = true;
	try {
		tracks = await api.getLibraryTracks();
		error = '';
		loaded = true;
	} catch (e) {
		error = `Couldn't load your library: ${e}`;
	} finally {
		loading = false;
	}
}

function start() {
	if (started) return;
	started = true;
	void refresh();
	void api.isLibraryScanning().then((running) => (scanning = running));
	void api.listenLibraryChanged((summary) => {
		scanning = false;
		void refresh();
		if (summary.new_tracks > 0) {
			toast.success(`Added ${summary.new_tracks.toLocaleString()} new tracks`);
		}
	});
}

export function useLibrary() {
	start();
	return {
		get tracks() {
			return tracks;
		},
		get albums() {
			return albums;
		},
		get artists() {
			return artists;
		},
		get loaded() {
			return loaded;
		},
		get loading() {
			return loading;
		},
		get scanning() {
			return scanning;
		},
		get error() {
			return error;
		},
		refresh,
		trackById(id: string) {
			return byId.get(id);
		},
		/** Rescans every library folder; resolves with the summary. */
		async scan() {
			if (scanning) return null;
			scanning = true;
			try {
				const summary = await api.scanLibrary();
				await refresh();
				return summary;
			} finally {
				scanning = false;
			}
		},
		async remove(ids: string[]) {
			await Promise.all(ids.map((id) => api.removeFromLibrary(id)));
			const gone = new Set(ids);
			tracks = tracks.filter((track) => !gone.has(track.id));
		}
	};
}
