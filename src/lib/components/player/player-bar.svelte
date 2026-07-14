<script lang="ts">
	import * as api from '$lib/api/tauri';
	import type { PlaybackWaveform } from '$lib/types';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { useVisualizerChrome } from '$lib/state/visualizer-chrome.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Toggle } from '$lib/components/ui/toggle';
	import { Slider } from '$lib/components/ui/slider';
	import QueueSheet from '$lib/components/queue/queue-sheet.svelte';
	import WaveformScrubber from '$lib/components/player/waveform-scrubber.svelte';
	import {
		Play,
		Pause,
		Square,
		SkipBack,
		SkipForward,
		Shuffle,
		Repeat,
		Repeat1,
		Volume2,
		VolumeX,
		ListMusic,
		LoaderCircle,
		Sparkles
	} from '@lucide/svelte';

	const visualizer = useVisualizer();
	const visualizerChrome = useVisualizerChrome();

	import { onMount } from 'svelte';

	const player = usePlayer();
	const waveformCache = new Map<string, PlaybackWaveform | null>();

	onMount(() => {
		const handler = () => player.togglePlay();
		window.addEventListener('toggle-playback', handler);
		return () => window.removeEventListener('toggle-playback', handler);
	});

	// The visualizer rail and player bar share one idle clock. Pointer clicks can
	// leave focus on a control, so only genuine keyboard focus pins the chrome.
	let keyboardFocusMode = true;

	function handlePlayerPointerDown() {
		if (!visualizer.active) return;
		keyboardFocusMode = false;
		visualizerChrome.setHold('player-focus', false);
		visualizerChrome.setHold('player-drag', true);
	}

	function handlePlayerPointerEnd() {
		if (!visualizer.active) return;
		visualizerChrome.setHold('player-drag', false);
	}

	function handlePlayerFocusIn() {
		if (!visualizer.active) return;
		visualizerChrome.wake();
		visualizerChrome.setHold('player-focus', keyboardFocusMode);
	}

	function handlePlayerFocusOut(event: FocusEvent) {
		if (!visualizer.active) return;
		const bar = event.currentTarget;
		if (
			bar instanceof HTMLElement &&
			event.relatedTarget instanceof Node &&
			bar.contains(event.relatedTarget)
		) return;
		visualizerChrome.setHold('player-focus', false);
	}

	function handleWindowKeydown() {
		keyboardFocusMode = true;
	}

	let showQueue = $state(false);
	let prevVolume = $state(1);
	let waveform = $state<PlaybackWaveform | null>(null);
	let waveformLoading = $state(false);
	let waveformRequest = 0;
	let hasCurrentItem = $derived(
		Boolean(
			player.state.current_title ||
			player.state.current_source_url ||
			player.state.current_recording_id
		)
	);
	let canSeek = $derived(
		!player.state.is_buffering && player.state.can_seek && player.state.duration_ms > 0
	);
	let hasTimeline = $derived(hasCurrentItem && player.state.duration_ms > 0);
	let wantsWaveform = $derived(player.state.source === 'local' && hasTimeline);
	let showWaveform = $derived(
		Boolean(canSeek && wantsWaveform && waveform?.peaks?.length)
	);

	$effect(() => {
		const recordingId = player.state.current_recording_id;
		const durationMs = player.state.duration_ms;
		const source = player.state.source;
		const requestId = ++waveformRequest;

		waveform = null;
		waveformLoading = false;

		if (!recordingId || durationMs <= 0 || source !== 'local') {
			return;
		}

		const cached = waveformCache.get(recordingId);
		if (cached !== undefined) {
			waveform = cached;
			return;
		}

		waveformLoading = true;
		void api
			.getPlaybackWaveform(recordingId, 160)
			.then((data) => {
				if (requestId !== waveformRequest) {
					return;
				}
				waveformCache.set(recordingId, data);
				waveform = data;
			})
			.catch(() => {
				if (requestId !== waveformRequest) {
					return;
				}
				waveformCache.set(recordingId, null);
				waveform = null;
			})
			.finally(() => {
				if (requestId === waveformRequest) {
					waveformLoading = false;
				}
			});
	});

	function toggleMute() {
		if (player.state.volume > 0) {
			prevVolume = player.state.volume;
			player.setVolume(0);
		} else {
			player.setVolume(prevVolume);
		}
	}

	function handleSeekCommit(positionMs: number) {
		if (player.state.duration_ms > 0) {
			player.seek(positionMs);
		}
	}

	function handleVolumeChange(values: number[]) {
		player.setVolume(values[0] / 100);
	}
</script>

<svelte:window
	onkeydown={handleWindowKeydown}
	onpointerup={handlePlayerPointerEnd}
	onpointercancel={handlePlayerPointerEnd}
/>

<div
	data-player-bar
	data-visualizer-chrome-visible={visualizer.active ? visualizerChrome.visible : true}
	aria-hidden={visualizer.active && !visualizerChrome.visible}
	inert={visualizer.active && !visualizerChrome.visible}
	onpointerenter={() => {
		if (visualizer.active) visualizerChrome.setHold('player-pointer', true);
	}}
	onpointermove={() => {
		if (visualizer.active) visualizerChrome.wake();
	}}
	onpointerleave={() => {
		if (visualizer.active) visualizerChrome.setHold('player-pointer', false);
	}}
	onpointerdown={handlePlayerPointerDown}
	onfocusin={handlePlayerFocusIn}
	onfocusout={handlePlayerFocusOut}
	class={`fixed inset-x-0 bottom-0 grid h-[88px] grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-border bg-[oklch(0.18_0.005_285/0.97)] px-5 shadow-[0_-4px_24px_rgba(0,0,0,0.3)] backdrop-blur-sm transition-opacity duration-[250ms] max-[640px]:h-[72px] max-[640px]:grid-cols-[minmax(0,1fr)_auto_auto] max-[640px]:gap-1 max-[640px]:px-2 ${
		visualizer.active
			? visualizerChrome.visible
				? 'z-[110] opacity-100'
				: 'pointer-events-none z-[110] opacity-0'
			: 'z-50 opacity-100'
	}`}
>
	<!-- Left: track info -->
	<div class="flex min-w-0 flex-1 items-center gap-3">
		{#if player.state.current_album_art}
			<img
				src={player.state.current_album_art}
				alt="Album art"
				class="size-14 shrink-0 rounded-md object-cover max-[640px]:size-10"
			/>
		{:else}
			<div class="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted max-[640px]:size-10">
				<ListMusic class="size-6 text-muted-foreground max-[640px]:size-4" />
			</div>
		{/if}
		<div class="flex min-w-0 flex-col gap-0.5">
			<p class="truncate text-sm font-medium">
				{player.state.current_title ?? 'Not playing'}
			</p>
			<p class="truncate text-xs text-muted-foreground">
				{player.state.current_artist ?? ''}
			</p>
		</div>
	</div>

	<!-- Center: controls + progress -->
	<div class="flex min-w-0 flex-col items-center gap-1">
		<div class="flex items-center gap-1">
			<Toggle
				size="sm"
				pressed={player.state.is_shuffle}
				disabled={!hasCurrentItem}
				onPressedChange={() => player.toggleShuffle()}
				aria-label="Shuffle"
				class="size-8 max-[640px]:hidden {player.state.is_shuffle ? 'text-primary' : ''}"
			>
				<Shuffle class="size-4" />
			</Toggle>
			<Button variant="ghost" size="icon" class="size-8 max-[640px]:hidden" disabled={!hasCurrentItem} onclick={() => player.prev()}>
				<SkipBack class="size-4" />
			</Button>
			<Button
				size="icon"
				class="size-9 rounded-full"
				disabled={!hasCurrentItem}
				onclick={() => player.togglePlay()}
			>
				{#if player.state.is_buffering}
					<Square class="size-4" />
				{:else if player.state.is_playing}
					<Pause class="size-4" />
				{:else}
					<Play class="size-4 pl-0.5" />
				{/if}
			</Button>
			<Button variant="ghost" size="icon" class="size-8 max-[640px]:hidden" disabled={!hasCurrentItem} onclick={() => player.next()}>
				<SkipForward class="size-4" />
			</Button>
			<Toggle
				size="sm"
				pressed={player.state.repeat_mode !== 'off'}
				disabled={!hasCurrentItem}
				onPressedChange={() => player.cycleRepeat()}
				aria-label="Repeat"
				class="size-8 max-[640px]:hidden {player.state.repeat_mode !== 'off' ? 'text-primary' : ''}"
			>
				{#if player.state.repeat_mode === 'one'}
					<Repeat1 class="size-4" />
				{:else}
					<Repeat class="size-4" />
				{/if}
			</Toggle>
		</div>

		{#if hasTimeline}
			<div class="max-[640px]:hidden" style="display: grid; grid-template-columns: 40px 1fr 40px; align-items: center; gap: 6px; width: calc(100% + 40px); margin-left: -20px; margin-right: -20px;">
				<span class="text-right text-xs tabular-nums text-muted-foreground">{formatTime(player.state.position_ms)}</span>
				<WaveformScrubber
					peaks={showWaveform ? waveform?.peaks ?? null : null}
					valueMs={player.state.position_ms}
					durationMs={player.state.duration_ms}
					interactive={canSeek}
					onCommit={handleSeekCommit}
				/>
				<span class="text-xs tabular-nums text-muted-foreground">{formatTime(player.state.duration_ms)}</span>
			</div>
		{:else if player.state.source === 'radio'}
			<div class="flex w-full items-center justify-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground max-[640px]:hidden">
					{#if player.state.is_buffering}
						<LoaderCircle class="size-3 animate-spin" />
					<span>Connecting</span>
				{:else}
					<span>Live Radio</span>
				{/if}
				<span class="text-[10px]">No seeking</span>
			</div>
		{:else if player.state.is_buffering}
			<div class="flex w-full items-center justify-center gap-2 text-xs text-muted-foreground max-[640px]:hidden">
				<LoaderCircle class="size-3 animate-spin" />
				<span>Buffering playback...</span>
			</div>
		{:else if hasCurrentItem}
			<div class="flex w-full items-center justify-center gap-2 text-xs text-muted-foreground max-[640px]:hidden">
				<span>Playback active</span>
				<span class="text-[10px] uppercase tracking-[0.14em]">Seeking unavailable</span>
			</div>
		{:else}
			<div class="flex w-full items-center justify-center text-xs text-muted-foreground max-[640px]:hidden">
				Select something to play
			</div>
		{/if}
	</div>

	<!-- Right: volume -->
	<div class="flex shrink-0 items-center justify-end gap-2">
		<Button variant="ghost" size="icon" class="size-8 max-[640px]:hidden" onclick={toggleMute}>
			{#if player.state.volume === 0}
				<VolumeX class="size-4" />
			{:else}
				<Volume2 class="size-4" />
			{/if}
		</Button>
		<Slider
			value={[player.state.volume * 100]}
			max={100}
			step={1}
			class="w-28 max-[640px]:hidden"
			onValueChange={handleVolumeChange}
		/>
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			title="Visualizer"
			onclick={() => visualizer.toggle()}
		>
			<Sparkles class="size-4" />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			onclick={() => {
				// The queue sheet portals below the visualizer overlay — leave the
				// visualizer first so the sheet is actually visible.
				if (visualizer.active) visualizer.toggle();
				showQueue = true;
			}}
		>
			<ListMusic class="size-4" />
		</Button>
	</div>
</div>

<QueueSheet bind:open={showQueue} onOpenChange={(open) => { showQueue = open; }} />
