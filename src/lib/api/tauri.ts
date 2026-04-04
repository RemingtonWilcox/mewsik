import { invoke } from '@tauri-apps/api/core';
import type {
	LibraryTrack,
	Artist,
	Album,
	Playlist,
	PlaybackState,
	PlaybackWaveform,
	SearchResult,
	Station,
	StationHealthResult,
	QueueItem,
	Download
} from '$lib/types';

const desktopOnlyMessage = 'This action requires the desktop app runtime.';

function hasTauriRuntime(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}

	const runtime = (window as Window & {
		__TAURI_INTERNALS__?: { invoke?: unknown };
	}).__TAURI_INTERNALS__;

	return typeof runtime?.invoke === 'function';
}

function desktopOnly<T>(message = desktopOnlyMessage): Promise<T> {
	return Promise.reject(new Error(message));
}

function safeInvoke<T>(
	command: string,
	args?: Record<string, unknown>,
	fallback?: T | (() => T | Promise<T>)
): Promise<T> {
	if (hasTauriRuntime()) {
		return invoke<T>(command, args);
	}

	if (fallback !== undefined) {
		if (typeof fallback === 'function') {
			return Promise.resolve((fallback as () => T | Promise<T>)());
		}
		return Promise.resolve(fallback);
	}

	return desktopOnly<T>();
}

const defaultPlaybackState: PlaybackState = {
	is_playing: false,
	is_buffering: false,
	can_seek: false,
	current_recording_id: null,
	current_title: null,
	current_artist: null,
	current_album_art: null,
	current_source_url: null,
	position_ms: 0,
	duration_ms: 0,
	volume: 1,
	is_shuffle: false,
	repeat_mode: 'off',
	source: null
};

const defaultSettings = {
	library_paths: [],
	audio_device: null,
	normalization_enabled: false,
	last_volume: 1
};

// Library
export const scanLibrary = (path: string) =>
	safeInvoke<{ total_files: number; new_tracks: number; updated_tracks: number; errors: string[] }>(
		'scan_library',
		{ path }
	);

export const getLibraryTracks = () => safeInvoke<LibraryTrack[]>('get_library_tracks', undefined, []);

export const getAllArtists = () => safeInvoke<Artist[]>('get_all_artists', undefined, []);

export const getAllAlbums = () => safeInvoke<Album[]>('get_all_albums', undefined, []);

export const getArtist = (artistId: string) =>
	safeInvoke<Artist | null>('get_artist', { artistId }, null);

export const getArtistTracks = (artistId: string) =>
	safeInvoke<LibraryTrack[]>('get_artist_tracks', { artistId }, []);

export const getAlbumTracks = (albumId: string) =>
	safeInvoke<LibraryTrack[]>('get_album_tracks', { albumId }, []);

export const saveToLibrary = (recordingId: string) =>
	safeInvoke('save_to_library', { recordingId });

export const removeFromLibrary = (recordingId: string) =>
	safeInvoke('remove_from_library', { recordingId });

// Playback
export const playRecording = (recordingId: string) =>
	safeInvoke('play_recording', { recordingId });

export const pause = () => safeInvoke('pause');

export const stopPlayback = () => safeInvoke('stop_playback');

export const resume = () => safeInvoke('resume');

export const seek = (positionMs: number) => safeInvoke('seek', { positionMs });

export const setVolume = (volume: number) => safeInvoke('set_volume', { volume });

export const nextTrack = () => safeInvoke('next_track');

export const prevTrack = () => safeInvoke('prev_track');

export const setShuffle = (enabled: boolean) => safeInvoke('set_shuffle', { enabled });

export const setRepeat = (mode: string) => safeInvoke('set_repeat', { mode });

export const getPlaybackState = () =>
	safeInvoke<PlaybackState>('get_playback_state', undefined, defaultPlaybackState);

export const getPlaybackWaveform = (recordingId: string, bins = 144) =>
	safeInvoke<PlaybackWaveform>('get_playback_waveform', { recordingId, bins });

export const playTracksFrom = (recordingIds: string[], startIndex: number) =>
	safeInvoke('play_tracks_from', { recordingIds, startIndex });

export const addToQueue = (recordingId: string) => safeInvoke('add_to_queue', { recordingId });

export const playNext = (recordingId: string) => safeInvoke('play_next', { recordingId });

export const playQueueIndex = (index: number) => safeInvoke('play_queue_index', { index });

export const getQueue = () => safeInvoke<QueueItem[]>('get_queue', undefined, []);

export const removeFromQueue = (index: number) => safeInvoke('remove_from_queue', { index });

export const clearQueue = () => safeInvoke('clear_queue');

// Playlists
export const getPlaylists = () => safeInvoke<Playlist[]>('get_playlists', undefined, []);

export const createPlaylist = (name: string, description?: string) =>
	safeInvoke<Playlist>('create_playlist', { name, description });

export const deletePlaylist = (playlistId: string) =>
	safeInvoke('delete_playlist', { playlistId });

export const addToPlaylist = (playlistId: string, recordingId: string) =>
	safeInvoke('add_to_playlist', { playlistId, recordingId });

export const removeFromPlaylist = (playlistTrackId: string) =>
	safeInvoke('remove_from_playlist', { playlistTrackId });

export const getPlaylistTracks = (playlistId: string) =>
	safeInvoke<LibraryTrack[]>('get_playlist_tracks', { playlistId }, []);

export const reorderPlaylistTrack = (
	playlistId: string,
	playlistTrackId: string,
	newPosition: number
) => safeInvoke('reorder_playlist_track', { playlistId, trackId: playlistTrackId, newPosition });

export const updatePlaylist = (
	playlistId: string,
	name?: string,
	description?: string
) => safeInvoke('update_playlist', { playlistId, name, description });

// Search
export const searchLibrary = (query: string) =>
	safeInvoke<SearchResult[]>('search_library', { query }, []);

// Settings
export const getSettings = () =>
	safeInvoke<{
		library_paths: string[];
		audio_device: string | null;
		normalization_enabled: boolean;
		last_volume: number;
	}>('get_settings', undefined, defaultSettings);

export const updateLibraryPaths = (paths: string[]) =>
	safeInvoke('update_library_paths', { paths });

export const getLibraryPaths = () => safeInvoke<string[]>('get_library_paths', undefined, []);

// Smart playlists
export const createSmartPlaylist = (name: string, rules: { field: string; operator: string; value: string }[]) =>
	safeInvoke<Playlist>('create_smart_playlist', { name, rules });

export const evaluateSmartPlaylist = (playlistId: string) =>
	safeInvoke<LibraryTrack[]>('evaluate_smart_playlist', { playlistId }, []);

// External search
export interface ExternalSearchResult {
	source: string;
	source_id: string;
	title: string;
	artist: string;
	album: string | null;
	duration_ms: number | null;
	cover_art_url: string | null;
	source_url: string | null;
	play_count: number | null;
	is_saved: boolean;
	is_downloaded: boolean;
	recording_id: string | null;
}

export interface ExternalSearchPage {
	items: ExternalSearchResult[];
	has_more: boolean;
}

export interface ExternalSearchPartialEvent {
	query: string;
	source: string;
	results: ExternalSearchResult[];
}

export interface ExternalSearchCompleteEvent {
	query: string;
	results: ExternalSearchResult[];
}

async function listenDesktopEvent<T>(
	event: string,
	handler: (payload: T) => void
): Promise<() => void> {
	if (!hasTauriRuntime()) {
		return () => {};
	}

	const { listen } = await import('@tauri-apps/api/event');
	return listen<T>(event, (tauriEvent) => handler(tauriEvent.payload));
}

export const searchExternal = (query: string, source: string, page = 0) =>
	safeInvoke<ExternalSearchPage>(
		'search_external',
		{ query, source, page },
		{ items: [], has_more: false }
	);

export const searchAllSources = (query: string) =>
	safeInvoke<ExternalSearchResult[]>('search_all_sources', { query }, []);

export const listenExternalSearchPartial = (
	handler: (payload: ExternalSearchPartialEvent) => void
) => listenDesktopEvent<ExternalSearchPartialEvent>('external-search-partial', handler);

export const listenExternalSearchComplete = (
	handler: (payload: ExternalSearchCompleteEvent) => void
) => listenDesktopEvent<ExternalSearchCompleteEvent>('external-search-complete', handler);

export const ensureExternalRecording = (
	source: string,
	sourceId: string,
	title: string,
	artist: string,
	durationMs?: number,
	coverArtUrl?: string
) =>
	safeInvoke<string>('ensure_external_recording', {
		source,
		sourceId,
		title,
		artist,
		durationMs,
		coverArtUrl
	});

export const playExternal = (
	source: string,
	sourceId: string,
	title: string,
	artist: string,
	durationMs?: number,
	coverArtUrl?: string
) =>
	safeInvoke<string>('play_external', {
		source,
		sourceId: sourceId,
		title,
		artist,
		durationMs,
		coverArtUrl
	});

export const startSidecar = () => safeInvoke<void>('start_sidecar', undefined, () => undefined);
export const stopSidecar = () => safeInvoke<void>('stop_sidecar', undefined, () => undefined);
export const sidecarStatus = () => safeInvoke<boolean>('sidecar_status', undefined, false);

export async function pickFolder(defaultPath?: string): Promise<string | null> {
	if (!hasTauriRuntime()) {
		return null;
	}

	const { open } = await import('@tauri-apps/plugin-dialog');
	const selection = await open({
		directory: true,
		multiple: false,
		defaultPath
	});

	return typeof selection === 'string' ? selection : null;
}

// Discovery
export const getDailyMix = () => safeInvoke<LibraryTrack[]>('get_daily_mix', undefined, []);
export const getRediscover = () => safeInvoke<LibraryTrack[]>('get_rediscover', undefined, []);
export const getPlayStats = () =>
	safeInvoke<{ total_plays: number; total_time_ms: number; unique_tracks: number }>(
		'get_play_stats',
		undefined,
		{ total_plays: 0, total_time_ms: 0, unique_tracks: 0 }
	);
export const getRecentlyPlayed = () => safeInvoke<LibraryTrack[]>('get_recently_played', undefined, []);

// Downloads
export const getDownloads = () => safeInvoke<Download[]>('get_downloads', undefined, []);
export const downloadRecording = (recordingId: string) =>
	safeInvoke<string>('download_recording', { recordingId });
export const cancelDownload = (downloadId: string) =>
	safeInvoke('cancel_download', { downloadId });
export const deleteDownload = (downloadId: string) =>
	safeInvoke('delete_download', { downloadId });
export const revealDownloadPath = (path: string) =>
	safeInvoke('reveal_download_path', { path });

export async function openPath(path: string): Promise<void> {
	if (!hasTauriRuntime()) {
		return desktopOnly();
	}

	const { open } = await import('@tauri-apps/plugin-shell');
	await open(path);
}

// Stations
export interface RadioBrowserStation {
	name: string;
	url: string;
	homepage: string | null;
	favicon: string | null;
	country: string | null;
	language: string | null;
	tags: string | null;
	codec: string | null;
	bitrate: number | null;
	stationuuid: string;
}

export const searchRadioStations = (query: string, mode: 'name' | 'tag' = 'name') =>
	safeInvoke<RadioBrowserStation[]>(
		mode === 'name' ? 'search_radio_stations' : 'search_radio_stations_advanced',
		mode === 'name' ? { query } : { query, mode },
		[]
	);

export const saveStation = (
	name: string,
	url: string,
	homepage?: string,
	faviconUrl?: string,
	country?: string,
	language?: string,
	tags?: string,
	codec?: string,
	bitrate?: number,
	radioBrowserId?: string
) =>
	safeInvoke<Station>('save_station', {
		name,
		url,
		homepage,
		faviconUrl,
		country,
		language,
		tags,
		codec,
		bitrate,
		radioBrowserId
	});

export const getFavoriteStations = () => safeInvoke<Station[]>('get_favorite_stations', undefined, []);

export const verifyFavoriteStations = () =>
	safeInvoke<StationHealthResult[]>('verify_favorite_stations', undefined, []);
export const verifyStationUrls = (urls: string[]) =>
	safeInvoke<StationHealthResult[]>('verify_station_urls', { urls }, []);
export const toggleStationFavorite = (stationId: string) =>
	safeInvoke<boolean>('toggle_station_favorite', { stationId });

export const playStation = (stationId: string, url: string, name: string, favicon?: string) =>
	safeInvoke('play_station', { stationId, url, name, favicon });

export const playStationSearchResult = (station: RadioBrowserStation) =>
	safeInvoke('play_station_search_result', {
		name: station.name,
		url: station.url,
		homepage: station.homepage,
		favicon: station.favicon,
		country: station.country,
		language: station.language,
		tags: station.tags,
		codec: station.codec,
		bitrate: station.bitrate,
		stationuuid: station.stationuuid
	});
