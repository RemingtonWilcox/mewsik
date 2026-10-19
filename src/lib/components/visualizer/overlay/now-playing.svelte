<script lang="ts">
	import { Pause, Play, RotateCw, SkipBack, SkipForward, Square } from '@lucide/svelte';
	import StationArt from '$lib/components/station-art.svelte';
	import ConnectionStatus from '$lib/components/player/connection-status.svelte';
	import { connectionStage, displayTitle, usePlayer } from '$lib/state/player.svelte';

	// What is playing and the three controls that matter while watching. All
	// state and commands come from the shared player; nothing is duplicated.
	const player = usePlayer();

	let playback = $derived(player.state);
	let hasCurrentItem = $derived(
		Boolean(playback.current_title || playback.current_source_url || playback.current_recording_id)
	);
	let isRadio = $derived(playback.source === 'radio');
	let stage = $derived(connectionStage(playback));
	let failed = $derived(isRadio && stage === 'failed');
	let title = $derived(displayTitle(playback) ?? 'Untitled');
	let progress = $derived(
		!isRadio && playback.duration_ms > 0
			? Math.min(1, Math.max(0, playback.position_ms / playback.duration_ms))
			: null
	);
	let playLabel = $derived(
		failed ? 'Retry station' : playback.is_buffering ? 'Stop' : playback.is_playing ? 'Pause' : 'Play'
	);
</script>

{#if hasCurrentItem}
	<section
		aria-label="Now playing"
		data-visualizer-now-playing
		class="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-white/10 bg-black/50 p-2 pr-2.5 shadow-2xl shadow-black/40 backdrop-blur-xl"
	>
		{#if playback.current_album_art}
			<img
				src={playback.current_album_art}
				alt=""
				class="size-11 shrink-0 rounded-lg object-cover"
			/>
		{:else}
			<StationArt name={title} src={null} class="size-11 rounded-lg" monogramClass="text-xs" />
		{/if}

		<div class="flex min-w-0 flex-1 flex-col gap-0.5">
			<p class="truncate text-[13px] font-medium leading-5 text-white" title={playback.current_title ?? undefined}>
				{title}
			</p>
			<div class="min-w-0 truncate text-[11px] leading-4 text-white/55">
				{#if isRadio && stage !== 'idle'}
					<ConnectionStatus
						{playback}
						onRetry={() => void player.retryStation()}
						class={stage === 'playing' ? 'uppercase tracking-[0.16em] text-[10px]' : ''}
					/>
				{:else if isRadio}
					<span class="uppercase tracking-[0.16em] text-[10px]">Radio</span>
				{:else if stage === 'buffering' || stage === 'connecting'}
					<ConnectionStatus {playback} />
				{:else}
					{playback.current_artist ?? ''}
				{/if}
			</div>
		</div>

		<div class="flex shrink-0 items-center gap-0.5">
			<button
				type="button"
				class="grid size-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80 motion-reduce:transition-none"
				aria-label={isRadio ? 'Previous favorite station' : 'Previous'}
				onclick={() => void player.prev()}
			>
				<SkipBack class="size-4 fill-current" />
			</button>
			<button
				type="button"
				class="grid size-10 place-items-center rounded-full bg-white text-black transition-transform hover:scale-[1.04] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transition-none motion-reduce:hover:scale-100"
				aria-label={playLabel}
				aria-keyshortcuts="Space"
				data-visualizer-play
				onclick={() => void player.togglePlay()}
			>
				{#if failed}
					<RotateCw class="size-4" />
				{:else if playback.is_buffering}
					<Square class="size-3.5 fill-current" />
				{:else if playback.is_playing}
					<Pause class="size-4 fill-current" />
				{:else}
					<Play class="size-4 translate-x-px fill-current" />
				{/if}
			</button>
			<button
				type="button"
				class="grid size-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80 motion-reduce:transition-none"
				aria-label={isRadio ? 'Next favorite station' : 'Next'}
				onclick={() => void player.next()}
			>
				<SkipForward class="size-4 fill-current" />
			</button>
		</div>

		{#if progress !== null}
			<div class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.06]" aria-hidden="true">
				<div
					class="h-full origin-left bg-white/45 transition-transform duration-300 ease-linear motion-reduce:transition-none"
					style:transform={`scaleX(${progress})`}
				></div>
			</div>
		{/if}
	</section>
{:else}
	<p
		class="rounded-full border border-white/10 bg-black/45 px-3.5 py-1.5 text-[11px] text-white/55 backdrop-blur-xl"
		data-visualizer-now-playing="idle"
	>
		Nothing playing
	</p>
{/if}
