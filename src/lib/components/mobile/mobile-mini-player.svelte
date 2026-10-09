<script lang="ts">
	import {
		usePlayer,
		connectionStage,
		displayTitle,
		isConnecting
	} from '$lib/state/player.svelte';
	import StationArt from '$lib/components/station-art.svelte';
	import ConnectionStatus from '$lib/components/player/connection-status.svelte';
	import { Play, Pause, SkipForward, Square, RotateCw } from '@lucide/svelte';

	const { onExpand }: { onExpand: () => void } = $props();
	const player = usePlayer();

	let hasCurrentItem = $derived(
		Boolean(
			player.state.current_title ||
				player.state.current_source_url ||
				player.state.current_recording_id
		)
	);

	let isRadio = $derived(player.state.source === 'radio');
	let stage = $derived(connectionStage(player.state));
	let title = $derived(displayTitle(player.state) ?? 'Not playing');
	// Radio shows its connection stage under the name; tracks show the artist.
	let showStage = $derived(isRadio ? stage !== 'idle' : isConnecting(stage));
	let subtitle = $derived(
		isRadio ? 'Radio' : (player.state.current_artist ?? player.state.source ?? '')
	);
	let failed = $derived(stage === 'failed');

	function togglePlayback(e: Event) {
		e.stopPropagation();
		void player.togglePlay();
	}

	function skipNext(e: Event) {
		e.stopPropagation();
		void player.next();
	}

	function handleRowClick(e: MouseEvent | KeyboardEvent) {
		if (e.target instanceof HTMLElement && e.target.closest('button[data-mini-action]')) {
			return;
		}
		onExpand();
	}
</script>

{#if hasCurrentItem}
	<div
		class="flex w-full cursor-pointer items-center gap-3 px-3 py-2 transition-colors active:bg-muted/40"
		role="button"
		tabindex="0"
		onclick={handleRowClick}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleRowClick(e);
			}
		}}
	>
		{#if player.state.current_album_art}
			<div class="relative size-12 shrink-0 overflow-hidden rounded-md bg-muted">
				<img
					src={player.state.current_album_art}
					alt=""
					class="size-full object-cover"
				/>
			</div>
		{:else}
			<StationArt name={title} src={null} class="size-12 rounded-md" monogramClass="text-sm" />
		{/if}

		<div class="flex min-w-0 flex-1 flex-col">
			<span class="truncate text-sm font-medium leading-tight">{title}</span>
			{#if showStage}
				<ConnectionStatus
					playback={player.state}
					class="text-xs leading-tight text-muted-foreground"
				/>
			{:else if subtitle}
				<span class="truncate text-xs text-muted-foreground leading-tight">{subtitle}</span>
			{/if}
		</div>

		<div class="flex shrink-0 items-center gap-1">
			<button
				data-mini-action
				class="flex size-10 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60"
				onclick={togglePlayback}
				aria-label={failed
					? 'Retry station'
					: player.state.is_buffering
						? 'Stop'
						: player.state.is_playing
							? 'Pause'
							: 'Play'}
			>
				{#if failed}
					<RotateCw class="size-5" />
				{:else if player.state.is_buffering}
					<Square class="size-4 fill-current" />
				{:else if player.state.is_playing}
					<Pause class="size-5 fill-current" />
				{:else}
					<Play class="size-5 fill-current pl-0.5" />
				{/if}
			</button>
			<button
				data-mini-action
				class="flex size-10 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60"
				onclick={skipNext}
				aria-label={player.state.source === 'radio' ? 'Next favorite station' : 'Skip next'}
			>
				<SkipForward class="size-5" />
			</button>
		</div>
	</div>
{/if}
