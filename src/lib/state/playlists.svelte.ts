import type { Playlist } from '$lib/types';
import * as api from '$lib/api/tauri';
import { toast } from 'svelte-sonner';

let playlists = $state<Playlist[]>([]);
let started = false;

async function refresh() {
	try {
		playlists = await api.getPlaylists();
	} catch {
		// keep the last list
	}
}

export function usePlaylists() {
	if (!started) {
		started = true;
		void refresh();
	}
	return {
		get all() {
			return playlists;
		},
		refresh,
		byId(id: string) {
			return playlists.find((playlist) => playlist.id === id);
		},
		async create(name = 'New playlist') {
			const playlist = await api.createPlaylist(name);
			playlists = [...playlists, playlist];
			return playlist;
		},
		async rename(id: string, name: string) {
			const trimmed = name.trim();
			if (!trimmed) return;
			await api.updatePlaylist(id, trimmed);
			playlists = playlists.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
		},
		async remove(id: string) {
			await api.deletePlaylist(id);
			playlists = playlists.filter((p) => p.id !== id);
		},
		async addTracks(id: string, recordingIds: string[]) {
			const playlist = playlists.find((p) => p.id === id);
			for (const recordingId of recordingIds) {
				await api.addToPlaylist(id, recordingId);
			}
			const label = recordingIds.length === 1 ? '1 song' : `${recordingIds.length} songs`;
			toast.success(`Added ${label} to ${playlist?.name ?? 'playlist'}`);
			window.dispatchEvent(new CustomEvent('playlist-tracks-changed', { detail: id }));
		}
	};
}
