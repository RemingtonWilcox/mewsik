import type { PlaybackState, RepeatMode } from '$lib/types';
import * as api from '$lib/api/tauri';
import { setActiveScore, setScorePlayback } from '$lib/visualizer/director/score';
import { useVisualizer } from '$lib/state/visualizer.svelte';
import { visualizerPerformanceIdentity } from '$lib/visualizer/identity';

const defaultState: PlaybackState = {
	is_playing: false,
	is_buffering: false,
	can_seek: false,
	current_recording_id: null,
	current_title: null,
	current_artist: null,
	current_album_art: null,
	current_source_url: null,
	current_station_id: null,
	position_ms: 0,
	duration_ms: 0,
	volume: 1.0,
	is_shuffle: false,
	repeat_mode: 'off',
	source: null
};

let state = $state<PlaybackState>({ ...defaultState });
let pollInterval: ReturnType<typeof setInterval> | null = null;
let refreshCycle = 0;
let pendingSeek:
	| {
			recordingId: string | null;
			sourceUrl: string | null;
			positionMs: number;
			expiresAt: number;
	  }
	| null = null;

function clearPendingSeek() {
	pendingSeek = null;
}

// ---- Visual score lifecycle ----
// On every state merge the director's playback anchor is refreshed; when the
// playing recording changes, the cached offline analysis is fetched (or
// kicked off) and handed to the director. Null score = live-FSM fallback.
let scoreRecordingId: string | null = null;
let analysisListenerStarted = false;

function clearVisualizerAudio() {
	useVisualizer().clearLatest();
}

function playbackSourceChanged(previous: PlaybackState, next: PlaybackState): boolean {
	return (
		previous.source !== next.source ||
		previous.current_recording_id !== next.current_recording_id ||
		previous.current_source_url !== next.current_source_url ||
		previous.current_station_id !== next.current_station_id
	);
}

function syncVisualScore(next: PlaybackState) {
	setScorePlayback(next.position_ms, next.is_playing);

	const id = next.source === 'radio' ? null : next.current_recording_id;
	if (id === scoreRecordingId) return;
	scoreRecordingId = id;
	setActiveScore(null);
	if (!id) return;

	if (!analysisListenerStarted) {
		analysisListenerStarted = true;
		void api.listenAnalysisComplete((payload) => {
			if (payload.recording_id !== scoreRecordingId) return;
			void api.getTrackAnalysis(payload.recording_id).then((score) => {
				if (payload.recording_id === scoreRecordingId) setActiveScore(score);
			});
		});
	}

	void api.requestTrackAnalysis(id).then(async (status) => {
		if (status === 'cached' && id === scoreRecordingId) {
			const score = await api.getTrackAnalysis(id);
			// The user may have switched tracks while the cached score was loading.
			// Recheck after the await so A can never overwrite B's active journey.
			if (id === scoreRecordingId) setActiveScore(score);
		}
		// 'started' resolves via the analysis:complete listener;
		// 'unavailable' stays on the live fallback.
	});
}

function mergePlaybackState(nextState: PlaybackState) {
	// Clear immediately when playback is no longer producing trustworthy audio.
	// The store's 250 ms freshness timeout remains a backstop for missed polls or
	// native analyzer stalls, while source identity protects fast track switches.
	const sourceChanged = playbackSourceChanged(state, nextState);
	if (sourceChanged) {
		useVisualizer().resetPerformance(visualizerPerformanceIdentity(nextState));
	} else if (!nextState.is_playing || nextState.is_buffering) {
		clearVisualizerAudio();
	}
	if (pendingSeek) {
		const sameTarget =
			pendingSeek.recordingId === nextState.current_recording_id &&
			pendingSeek.sourceUrl === nextState.current_source_url;
		const expired = Date.now() >= pendingSeek.expiresAt;
		const settled = Math.abs(nextState.position_ms - pendingSeek.positionMs) <= 1200;

		if (!sameTarget || expired || settled) {
			pendingSeek = null;
		} else {
			nextState = { ...nextState, position_ms: pendingSeek.positionMs };
		}
	}

	state = nextState;
	syncVisualScore(nextState);
}

async function refreshState() {
	try {
		mergePlaybackState(await api.getPlaybackState());
	} catch {
		// ignore refresh errors
	}
}

function scheduleRefresh(delays = [0, 90, 250]) {
	const cycle = ++refreshCycle;
	for (const delay of delays) {
		setTimeout(() => {
			if (cycle !== refreshCycle) {
				return;
			}
			void refreshState();
		}, delay);
	}
}

function startPolling() {
	if (pollInterval) return;
	void refreshState();
	pollInterval = setInterval(async () => {
		void refreshState();
	}, 250);
}

function stopPolling() {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}

export function usePlayer() {
	startPolling();

	return {
		get state() {
			return state;
		},

		async play(recordingId: string) {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.playRecording(recordingId);
			scheduleRefresh();
		},

		async playAll(ids: string[], startIndex: number) {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.playTracksFrom(ids, startIndex);
			scheduleRefresh();
		},

		async pause() {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.pause();
			scheduleRefresh([0, 50]);
		},

		async stop() {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.stopPlayback();
			scheduleRefresh([0, 50]);
		},

		async resume() {
			clearPendingSeek();
			await api.resume();
			scheduleRefresh([0, 50]);
		},

		async togglePlay() {
			clearPendingSeek();
			if (state.is_buffering) {
				clearVisualizerAudio();
				await api.stopPlayback();
			} else if (state.is_playing) {
				clearVisualizerAudio();
				await api.pause();
			} else {
				if (!state.current_recording_id && !state.current_source_url && !state.current_title) {
					return;
				}
				await api.resume();
			}
			scheduleRefresh([0, 50]);
		},

		async seek(ms: number) {
			pendingSeek = {
				recordingId: state.current_recording_id,
				sourceUrl: state.current_source_url,
				positionMs: ms,
				expiresAt: Date.now() + 1500
			};
			state = { ...state, position_ms: ms };
			try {
				await api.seek(ms);
			} catch (error) {
				clearPendingSeek();
				void refreshState();
				throw error;
			}
			scheduleRefresh([0, 50, 120, 250, 500]);
		},

		async setVolume(vol: number) {
			await api.setVolume(vol);
			scheduleRefresh([0, 50]);
		},

		async next() {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.nextTrack();
			scheduleRefresh();
		},

		async prev() {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.prevTrack();
			scheduleRefresh();
		},

		async toggleShuffle() {
			await api.setShuffle(!state.is_shuffle);
			scheduleRefresh([0, 50]);
		},

		async cycleRepeat() {
			const modes: RepeatMode[] = ['off', 'all', 'one'];
			const current = modes.indexOf(state.repeat_mode);
			const next = modes[(current + 1) % modes.length];
			await api.setRepeat(next);
			scheduleRefresh([0, 50]);
		},

		async addToQueue(recordingId: string) {
			await api.addToQueue(recordingId);
			scheduleRefresh([0, 50]);
		},

		async playNext(recordingId: string) {
			await api.playNext(recordingId);
			scheduleRefresh([0, 50]);
		},

		async getQueue() {
			return api.getQueue();
		},

		async playQueueIndex(index: number) {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.playQueueIndex(index);
			scheduleRefresh();
		},

		async playQueueEntry(sessionId: string, entryId: string) {
			clearPendingSeek();
			clearVisualizerAudio();
			await api.playQueueEntry(sessionId, entryId);
			scheduleRefresh();
		},

		async removeFromQueue(index: number) {
			await api.removeFromQueue(index);
			scheduleRefresh([0, 50]);
		},

		async removeQueueEntry(sessionId: string, entryId: string) {
			await api.removeQueueEntry(sessionId, entryId);
			scheduleRefresh([0, 50]);
		},

		async clearQueue() {
			await api.clearQueue();
			scheduleRefresh([0, 50]);
		},

		destroy() {
			stopPolling();
		}
	};
}

export function formatTime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
