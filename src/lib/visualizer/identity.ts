import type { PlaybackState } from '$lib/types';

export type VisualizerPlaybackIdentity = Pick<
	PlaybackState,
	'source' | 'current_recording_id' | 'current_source_url' | 'current_station_id'
>;

/**
 * Canonical source identity shared by the player, persistent director, and
 * render-engine journey caches. Keep every source field in the tuple: a radio
 * or URL handoff must not inherit temporal state merely because one narrower
 * recording key happened to remain unchanged.
 */
export function visualizerPerformanceIdentity(
	playback: VisualizerPlaybackIdentity
): string | null {
	const hasSource =
		playback.source !== null ||
		playback.current_recording_id !== null ||
		playback.current_source_url !== null ||
		playback.current_station_id !== null;
	if (!hasSource) return null;
	return JSON.stringify([
		playback.source,
		playback.current_recording_id,
		playback.current_source_url,
		playback.current_station_id
	]);
}
