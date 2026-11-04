<script lang="ts">
	import { onMount } from 'svelte';
	import {
		usePlayer,
		connectionMessage,
		connectionStage,
		displayTitle
	} from '$lib/state/player.svelte';
	import { useLibrary } from '$lib/state/library.svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import StationArt from '$lib/components/station-art.svelte';
	import ConnectionStatus from '$lib/components/player/connection-status.svelte';
	import Cover from '$lib/components/tracks/cover.svelte';
	import SeekBar from './seek-bar.svelte';
	import QueuePanel from './queue-panel.svelte';
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
		Volume1,
		VolumeX,
		ListMusic,
		Sparkles,
		LoaderCircle
	} from '@lucide/svelte';

	const player = usePlayer();
	const library = useLibrary();
	const visualizer = useVisualizer();

	let queueOpen = $state(false);
	let lastVolume = 1;
	// Volume follows the slider immediately; the engine catches up.
	let volume = $state<number | null>(null);

	onMount(() => {
		const toggle = () => void player.togglePlay();
		window.addEventListener('toggle-playback', toggle);
		return () => window.removeEventListener('toggle-playback', toggle);
	});

	const s = $derived(player.state);
	const hasItem = $derived(Boolean(s.current_title || s.current_source_url || s.current_recording_id));
	const isRadio = $derived(s.source === 'radio');
	const stage = $derived(connectionStage(s));
	const track = $derived(s.current_recording_id ? library.trackById(s.current_recording_id) : undefined);
	const title = $derived(displayTitle(s));
	const artist = $derived(
		isRadio
			? (connectionMessage(s) ?? (stage === 'playing' ? 'Live radio' : 'Radio'))
			: (s.current_artist ?? '')
	);
	const shownVolume = $derived(volume ?? s.volume);
	const busy = $derived(s.is_buffering && !isRadio);

	function setVolume(value: number) {
		volume = value;
		void player.setVolume(value).finally(() => {
			if (volume === value) volume = null;
		});
	}

	function toggleMute() {
		if (shownVolume > 0) {
			lastVolume = shownVolume;
			setVolume(0);
		} else {
			setVolume(lastVolume || 1);
		}
	}

	function wheelVolume(event: WheelEvent) {
		event.preventDefault();
		setVolume(Math.max(0, Math.min(1, shownVolume - Math.sign(event.deltaY) * 0.05)));
	}
</script>

<!-- While the visualizer is open it owns playback; the bar stays mounted
     underneath, inert, so nothing remounts when the listener comes back. -->
<footer
	data-player-bar
	data-visualizer-open={visualizer.active || undefined}
	aria-hidden={visualizer.active ? 'true' : undefined}
	inert={visualizer.active}
	class="relative z-50 grid h-[88px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-6 border-t border-white/5 bg-[oklch(0.16_0.004_285)] px-4"
>
	<!-- Now playing -->
	<div class="flex min-w-0 items-center gap-3">
		{#if isRadio}
			<StationArt
				name={title}
				src={s.current_album_art}
				class="size-14 rounded-md"
				monogramClass="text-base"
			/>
		{:else if hasItem}
			<Cover
				src={track?.cover_art_path || track?.cover_art_url || s.current_album_art}
				name={track?.album_title || title}
				class="size-14 rounded-md shadow-lg"
				textClass="text-base"
				eager
			/>
		{:else}
			<div class="flex size-14 shrink-0 items-center justify-center rounded-md bg-white/5">
				<ListMusic class="size-5 text-muted-foreground" />
			</div>
		{/if}
		<div class="min-w-0">
			{#if hasItem}
				{#if track?.album_id}
					<a
						href="/albums/{track.album_id}"
						class="block truncate text-sm font-medium hover:underline"
						title={title ?? undefined}>{title}</a
					>
				{:else}
					<p class="truncate text-sm font-medium" title={title ?? undefined}>{title}</p>
				{/if}
				{#if track?.artist_id}
					<a
						href="/artists/{track.artist_id}"
						class="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
						>{artist}</a
					>
				{:else}
					<p class="truncate text-xs text-muted-foreground" data-player-subtitle>{artist}</p>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">Nothing playing</p>
			{/if}
		</div>
	</div>

	<!-- Controls -->
	<div class="flex min-w-0 flex-col items-center gap-1.5">
		<div class="flex items-center gap-2">
			<button
				class="ctl"
				class:on={s.is_shuffle}
				disabled={!hasItem || isRadio}
				aria-label="Shuffle"
				aria-pressed={s.is_shuffle}
				title="Shuffle"
				onclick={() => player.toggleShuffle()}
			>
				<Shuffle class="size-4" />
			</button>
			<button class="ctl" disabled={!hasItem || isRadio} aria-label="Previous" onclick={() => player.prev()}>
				<SkipBack class="size-[18px] fill-current" />
			</button>
			<button
				class="flex size-10 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
				disabled={!hasItem}
				aria-label={s.is_playing ? 'Pause' : 'Play'}
				onclick={() => player.togglePlay()}
			>
				{#if busy}
					<LoaderCircle class="size-5 animate-spin" />
				{:else if isRadio && s.is_buffering}
					<Square class="size-4 fill-current" />
				{:else if s.is_playing}
					<Pause class="size-5 fill-current" />
				{:else}
					<Play class="ml-0.5 size-5 fill-current" />
				{/if}
			</button>
			<button class="ctl" disabled={!hasItem || isRadio} aria-label="Next" onclick={() => player.next()}>
				<SkipForward class="size-[18px] fill-current" />
			</button>
			<button
				class="ctl"
				class:on={s.repeat_mode !== 'off'}
				disabled={!hasItem || isRadio}
				aria-label="Repeat: {s.repeat_mode}"
				title={s.repeat_mode === 'one' ? 'Repeat one' : s.repeat_mode === 'all' ? 'Repeat all' : 'Repeat'}
				onclick={() => player.cycleRepeat()}
			>
				{#if s.repeat_mode === 'one'}
					<Repeat1 class="size-4" />
				{:else}
					<Repeat class="size-4" />
				{/if}
			</button>
		</div>

		{#if isRadio}
			<div class="flex h-4 items-center text-xs text-muted-foreground">
				{#if stage === 'idle'}
					<span class="font-medium uppercase tracking-[0.18em]">Live radio</span>
				{:else}
					<ConnectionStatus
						playback={s}
						long
						onRetry={() => void player.retryStation()}
						class={stage === 'playing' ? 'font-medium uppercase tracking-[0.18em]' : ''}
					/>
				{/if}
			</div>
		{:else}
			<div class="w-full max-w-xl">
				<SeekBar
					positionMs={s.position_ms}
					durationMs={s.duration_ms || track?.duration_ms || 0}
					playing={s.is_playing && !s.is_buffering}
					enabled={hasItem && s.can_seek && !s.is_buffering}
					onseek={(ms) => void player.seek(ms)}
				/>
			</div>
		{/if}
	</div>

	<!-- Volume, queue, visualizer -->
	<div class="flex items-center justify-end gap-1.5">
		<button
			class="ctl"
			class:on={visualizer.active}
			aria-label="Visualizer"
			title="Visualizer"
			onclick={() => visualizer.toggle()}
		>
			<Sparkles class="size-4" />
		</button>
		<button
			class="ctl"
			class:on={queueOpen}
			aria-label="Queue"
			aria-pressed={queueOpen}
			title="Queue"
			onclick={() => (queueOpen = !queueOpen)}
		>
			<ListMusic class="size-4" />
		</button>
		<button class="ctl" aria-label={shownVolume === 0 ? 'Unmute' : 'Mute'} onclick={toggleMute}>
			{#if shownVolume === 0}
				<VolumeX class="size-4" />
			{:else if shownVolume < 0.5}
				<Volume1 class="size-4" />
			{:else}
				<Volume2 class="size-4" />
			{/if}
		</button>
		<input
			type="range"
			min="0"
			max="1"
			step="0.01"
			value={shownVolume}
			aria-label="Volume"
			class="volume w-28"
			style="--fill: {shownVolume * 100}%"
			oninput={(e) => setVolume(Number(e.currentTarget.value))}
			onwheel={wheelVolume}
		/>
	</div>
</footer>

<QueuePanel bind:open={queueOpen} />

<style>
	.ctl {
		display: flex;
		width: 2rem;
		height: 2rem;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		color: oklch(0.72 0 0);
		transition: color 120ms;
	}
	.ctl:hover:not(:disabled) {
		color: oklch(0.98 0 0);
	}
	.ctl:disabled {
		opacity: 0.35;
	}
	.ctl.on {
		color: var(--color-primary);
	}
	.volume {
		appearance: none;
		height: 4px;
		border-radius: 9999px;
		background: linear-gradient(
			to right,
			oklch(0.95 0 0) var(--fill),
			oklch(1 0 0 / 0.15) var(--fill)
		);
		cursor: pointer;
	}
	.volume:hover {
		background: linear-gradient(
			to right,
			var(--color-primary) var(--fill),
			oklch(1 0 0 / 0.15) var(--fill)
		);
	}
	.volume::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: white;
		opacity: 0;
		transition: opacity 120ms;
	}
	.volume:hover::-webkit-slider-thumb,
	.volume:focus-visible::-webkit-slider-thumb {
		opacity: 1;
	}
</style>
