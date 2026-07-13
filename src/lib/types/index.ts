export interface Recording {
	id: string;
	title: string;
	duration_ms: number | null;
	year: number | null;
	genre: string[] | null;
	cover_art_path: string | null;
	cover_art_url: string | null;
	loudness_lufs: number | null;
	musicbrainz_id: string | null;
	is_in_library: boolean;
	created_at: string;
	updated_at: string;
}

export interface TrackSource {
	id: string;
	recording_id: string;
	source: SourceType;
	source_id: string | null;
	source_url: string | null;
	file_path: string | null;
	file_format: string | null;
	file_size_bytes: number | null;
	bitrate: number | null;
	sample_rate: number | null;
	quality_score: number;
	content_hash: string | null;
	is_available: boolean;
	created_at: string;
	updated_at: string;
}

export type SourceType = 'local' | 'youtube' | 'soundcloud' | 'bandcamp' | 'torrent' | 'radio';

export interface Artist {
	id: string;
	name: string;
	sort_name: string | null;
	musicbrainz_id: string | null;
	image_path: string | null;
	image_url: string | null;
	bio: string | null;
	created_at: string;
	updated_at: string;
}

export interface Album {
	id: string;
	title: string;
	year: number | null;
	genre: string | null;
	track_count: number | null;
	cover_art_path: string | null;
	cover_art_url: string | null;
	musicbrainz_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface Playlist {
	id: string;
	name: string;
	description: string | null;
	cover_art_path: string | null;
	is_smart: boolean;
	smart_rules: string | null;
	created_at: string;
	updated_at: string;
}

export interface PlaylistTrack {
	id: string;
	playlist_id: string;
	recording_id: string;
	position: number;
	added_at: string;
}

export interface Station {
	id: string;
	name: string;
	url: string;
	homepage: string | null;
	favicon_url: string | null;
	favicon_path: string | null;
	country: string | null;
	language: string | null;
	tags: string[] | null;
	codec: string | null;
	bitrate: number | null;
	radio_browser_id: string | null;
	is_favorite: boolean;
	fail_count: number;
	last_played_at: string | null;
	last_checked_at: string | null;
	created_at: string;
}

export interface StationHealthResult {
	station_id: string | null;
	url: string;
	status: 'ok' | 'stale' | 'dead';
	last_checked_at: string | null;
}

export interface PlayHistory {
	id: string;
	recording_id: string | null;
	source_used: string | null;
	station_id: string | null;
	started_at: string;
	ended_at: string | null;
	duration_ms: number | null;
	completed: boolean;
}

export interface Download {
	id: string;
	recording_id: string | null;
	source: string;
	source_url: string;
	status: 'pending' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled';
	progress: number;
	file_path: string | null;
	error_message: string | null;
	created_at: string;
	updated_at: string;
}

// Library view types
export interface LibraryTrack {
	id: string;
	title: string;
	artist_name: string;
	artist_id: string;
	album_title: string | null;
	album_id: string | null;
	duration_ms: number | null;
	cover_art_path: string | null;
	cover_art_url: string | null;
	genre: string[] | null;
	year: number | null;
	source: SourceType;
	is_downloaded: boolean;
	local_file_path: string | null;
	playlist_track_id?: string | null;
	playlist_position?: number | null;
}

export interface SearchResult {
	recording_id: string;
	title: string;
	artist_name: string;
	artist_id: string | null;
	album_title: string | null;
	album_id: string | null;
	source: SourceType;
	source_id: string | null;
	cover_art_url: string | null;
	duration_ms: number | null;
}

// Playback state
export type RepeatMode = 'off' | 'one' | 'all';

export interface PlaybackState {
	is_playing: boolean;
	is_buffering: boolean;
	can_seek: boolean;
	current_recording_id: string | null;
	current_title: string | null;
	current_artist: string | null;
	current_album_art: string | null;
	current_source_url: string | null;
	current_station_id: string | null;
	position_ms: number;
	duration_ms: number;
	volume: number;
	is_shuffle: boolean;
	repeat_mode: RepeatMode;
	source: SourceType | null;
}

export interface PlaybackWaveform {
	recording_id: string;
	peaks: number[];
	source: string;
}

export interface QueueItem {
	index: number;
	recording_id: string;
	title: string;
	artist_name: string;
	duration_ms: number | null;
	cover_art_url: string | null;
	is_current: boolean;
}
