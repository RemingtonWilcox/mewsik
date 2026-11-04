import type { LibraryTrack } from '$lib/types';

/** Extra actions a list can add to the track menu (e.g. a playlist page). */
export interface TrackMenuExtra {
	label: string;
	danger?: boolean;
	run: (tracks: LibraryTrack[]) => void | Promise<void>;
}

interface MenuState {
	x: number;
	y: number;
	tracks: LibraryTrack[];
	/** Plays these tracks in list order starting at `tracks[0]`. */
	play: () => void;
	extras: TrackMenuExtra[];
}

let menu = $state<MenuState | null>(null);

export function useTrackMenu() {
	return {
		get current() {
			return menu;
		},
		open(next: MenuState) {
			menu = next;
		},
		close() {
			menu = null;
		}
	};
}
