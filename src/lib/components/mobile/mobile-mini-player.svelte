<script lang="ts">
	import { usePlayer } from '$lib/state/player.svelte';
	import { Play, Pause, SkipForward, Radio, LoaderCircle } from '@lucide/svelte';

	const { onExpand }: { onExpand: () => void } = $props();
	const player = usePlayer();

	let hasCurrentItem = $derived(
		Boolean(
			player.state.current_title ||
				player.state.current_source_url ||
				player.state.current_recording_id
		)
	);

	let title = $derived(player.state.current_title ?? 'Not playing');
	let subtitle = $derived(player.state.current_artist ?? player.state.source ?? '');

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
		<div class="relative size-12 shrink-0 overflow-hidden rounded-md bg-muted">
			{#if player.state.current_album_art}
				<img
					src={player.state.current_album_art}
					alt=""
					class="size-full object-cover"
				/>
			{:else}
				<div class="flex size-full items-center justify-center">
					<Radio class="size-5 text-muted-foreground" />
				</div>
			{/if}
		</div>

		<div class="flex min-w-0 flex-1 flex-col">
			<span class="truncate text-sm font-medium leading-tight">{title}</span>
			{#if subtitle}
				<span class="truncate text-xs text-muted-foreground leading-tight">{subtitle}</span>
			{/if}
		</div>

		<div class="flex shrink-0 items-center gap-1">
			<button
				data-mini-action
				class="flex size-10 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60"
				onclick={togglePlayback}
				aria-label={player.state.is_playing ? 'Pause' : 'Play'}
			>
				{#if player.state.is_buffering}
					<LoaderCircle class="size-5 animate-spin" />
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
