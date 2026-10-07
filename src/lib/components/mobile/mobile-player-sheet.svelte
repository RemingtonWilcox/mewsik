<script lang="ts">
	import * as Drawer from '$lib/components/ui/drawer';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import { Slider } from '$lib/components/ui/slider';
	import {
		Play,
		Pause,
		SkipBack,
		SkipForward,
		Shuffle,
		Repeat,
		Repeat1,
		Radio,
		ChevronDown,
		LoaderCircle
	} from '@lucide/svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const player = usePlayer();

	let canSeek = $derived(
		!player.state.is_buffering &&
			player.state.can_seek &&
			player.state.duration_ms > 0
	);
	let isRadio = $derived(player.state.source === 'radio');
	let title = $derived(player.state.current_title ?? '');
	let artist = $derived(player.state.current_artist ?? '');

	function onSeekChange(values: number[]) {
		if (!canSeek) return;
		const ms = values[0];
		if (typeof ms === 'number') {
			void player.seek(ms);
		}
	}
</script>

<Drawer.Root bind:open shouldScaleBackground={false}>
	<Drawer.Portal>
		<Drawer.Overlay class="fixed inset-0 z-40 bg-black/50" />
		<Drawer.Content
			class="fixed inset-x-0 bottom-0 z-50 mt-24 flex h-[96vh] flex-col rounded-t-2xl bg-background outline-none"
		>
			<!-- grabber -->
			<div class="flex w-full justify-center pt-2 pb-1">
				<div class="h-1.5 w-10 rounded-full bg-muted-foreground/30"></div>
			</div>

			<Drawer.Title class="sr-only">Now playing</Drawer.Title>

			<!-- header -->
			<div class="flex items-center justify-between px-4 py-2">
				<button
					class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted active:bg-muted/60"
					onclick={() => (open = false)}
					aria-label="Close player"
				>
					<ChevronDown class="size-5" />
				</button>
				<div class="text-xs uppercase tracking-wider text-muted-foreground">
					{player.state.source ?? ''}
				</div>
				<div class="size-9"></div>
			</div>

			<!-- album art -->
			<div class="flex flex-1 flex-col items-center justify-center gap-8 px-8 pb-4">
				<div
					class="aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-muted shadow-2xl"
				>
					{#if player.state.current_album_art}
						<img
							src={player.state.current_album_art}
							alt=""
							class="size-full object-cover"
						/>
					{:else}
						<div class="flex size-full items-center justify-center">
							<Radio class="size-20 text-muted-foreground" />
						</div>
					{/if}
				</div>

				<!-- title + artist -->
				<div class="flex w-full flex-col items-center gap-1 px-4 text-center">
					<h2 class="line-clamp-2 text-xl font-bold leading-tight">{title}</h2>
					{#if artist}
						<p class="line-clamp-1 text-base text-muted-foreground">{artist}</p>
					{/if}
				</div>

				<!-- timeline -->
				<div class="flex w-full flex-col gap-1.5">
					{#if isRadio}
						<div class="flex items-center justify-center gap-2 text-xs text-muted-foreground">
							<span class="size-2 animate-pulse rounded-full bg-red-500"></span>
							<span class="uppercase tracking-widest">Live</span>
						</div>
					{:else}
						<Slider
							value={[player.state.position_ms]}
							max={player.state.duration_ms || 1}
							step={1000}
							disabled={!canSeek}
							onValueChange={onSeekChange}
						/>
						<div class="flex justify-between text-[11px] tabular-nums text-muted-foreground">
							<span>{formatTime(player.state.position_ms)}</span>
							<span>{formatTime(player.state.duration_ms)}</span>
						</div>
					{/if}
				</div>

				<!-- controls -->
				<div class="flex w-full items-center justify-between px-4">
					<button
						class="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60 {player
							.state.is_shuffle
							? 'text-primary'
							: 'text-muted-foreground'}"
						onclick={() => player.toggleShuffle()}
						disabled={isRadio}
						aria-label="Shuffle"
					>
						<Shuffle class="size-5" />
					</button>

					<button
						class="flex size-12 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60 disabled:opacity-30"
						onclick={() => player.prev()}
						aria-label={isRadio ? 'Previous favorite station' : 'Previous'}
					>
						<SkipBack class="size-7 fill-current" />
					</button>

					<button
						class="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:bg-primary/90 active:scale-95"
						onclick={() => player.togglePlay()}
						aria-label={player.state.is_playing ? 'Pause' : 'Play'}
					>
						{#if player.state.is_buffering}
							<LoaderCircle class="size-7 animate-spin" />
						{:else if player.state.is_playing}
							<Pause class="size-7 fill-current" />
						{:else}
							<Play class="size-7 fill-current pl-1" />
						{/if}
					</button>

					<button
						class="flex size-12 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60 disabled:opacity-30"
						onclick={() => player.next()}
						aria-label={isRadio ? 'Next favorite station' : 'Next'}
					>
						<SkipForward class="size-7 fill-current" />
					</button>

					<button
						class="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-muted active:bg-muted/60 {player
							.state.repeat_mode !== 'off'
							? 'text-primary'
							: 'text-muted-foreground'}"
						onclick={() => player.cycleRepeat()}
						disabled={isRadio}
						aria-label="Repeat"
					>
						{#if player.state.repeat_mode === 'one'}
							<Repeat1 class="size-5" />
						{:else}
							<Repeat class="size-5" />
						{/if}
					</button>
				</div>
			</div>

			<!-- footer safe-area spacer -->
			<div style="height: max(env(safe-area-inset-bottom), 12px);"></div>
		</Drawer.Content>
	</Drawer.Portal>
</Drawer.Root>
