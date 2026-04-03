import type { LibraryTrack, Artist, Album } from '$lib/types';
import * as api from '$lib/api/tauri';

let tracks = $state<LibraryTrack[]>([]);
let artists = $state<Artist[]>([]);
let albums = $state<Album[]>([]);
let loading = $state(false);
let scanning = $state(false);
let error = $state('');

export function useLibrary() {
	return {
		get tracks() { return tracks; },
		get artists() { return artists; },
		get albums() { return albums; },
		get loading() { return loading; },
		get scanning() { return scanning; },
		get error() { return error; },

		async loadTracks() {
			loading = true;
			try {
				tracks = await api.getLibraryTracks();
				error = '';
			} catch (e) {
				error = `Failed to load tracks${e ? `: ${e}` : ''}`;
			} finally {
				loading = false;
			}
		},

		async loadArtists() {
			try {
				artists = await api.getAllArtists();
				error = '';
			} catch (e) {
				error = `Failed to load artists${e ? `: ${e}` : ''}`;
			}
		},

		async loadAlbums() {
			try {
				albums = await api.getAllAlbums();
				error = '';
			} catch (e) {
				error = `Failed to load albums${e ? `: ${e}` : ''}`;
			}
		},

		async loadAll() {
			loading = true;
			try {
				const [t, ar, al] = await Promise.all([
					api.getLibraryTracks(),
					api.getAllArtists(),
					api.getAllAlbums()
				]);
				tracks = t;
				artists = ar;
				albums = al;
				error = '';
			} catch (e) {
				error = `Failed to load library${e ? `: ${e}` : ''}`;
			} finally {
				loading = false;
			}
		},

		async scan(path: string) {
			scanning = true;
			try {
				const result = await api.scanLibrary(path);
				// Reload library after scan
				await this.loadAll();
				return result;
			} finally {
				scanning = false;
			}
		}
	};
}
