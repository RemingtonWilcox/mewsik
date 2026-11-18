<script lang="ts">
	import * as Drawer from '$lib/components/ui/drawer';
	import {
		usePlayer,
		formatTime,
		connectionStage,
		displayTitle,
		isConnecting
	} from '$lib/state/player.svelte';
	import StationArt from '$lib/components/station-art.svelte';
	import ConnectionStatus from '$lib/components/player/connection-status.svelte';
	import { Slider } from '$lib/components/ui/slider';
	import {
		Play,
		Pause,
		SkipBack,
		SkipForward,
		Shuffle,
		Repeat,
		Repeat1,
		ChevronDown,
		Square,
		RotateCw,
		Ellipsis
	} from '@lucide/svelte';
	import { useTrackMenu } from '$lib/state/track-menu.svelte';
	import type { LibraryTrack } from '$lib/types';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const player = usePlayer();

	let canSeek = $derived(
		!player.state.is_buffering &&
			player.state.can_seek &&
			player.state.duration_ms > 0
	);
	let isRadio = $derived(player.state.source === 'radio');
	let stage = $derived(connectionStage(player.state));
	let failed = $derived(stage === 'failed');
	let title = $derived(displayTitle(player.state) ?? '');
	// For a station the engine's second line is its status, which the stage
	// line below already says in full.
	let artist = $derived(isRadio ? '' : (player.state.current_artist ?? ''));

	const SOURCE_LABELS: Record<string, string> = {
		radio: 'Live radio',
		youtube: 'Playing from YouTube',
		soundcloud: 'Playing from SoundCloud',
		local: 'Playing from your library'
	};
	let sourceLabel = $derived(SOURCE_LABELS[player.state.source ?? ''] ?? 'Now playing');

	const menu = useTrackMenu();
	// Play next, playlists and download for the song that's playing.
	function openMenu() {
		const id = player.state.current_recording_id;
		if (!id) return;
		const track: LibraryTrack = {
			id,
			title,
			artist_name: artist,
			artist_id: '',
			album_title: null,
			album_id: null,
			duration_ms: player.state.duration_ms || null,
			cover_art_path: null,
			cover_art_url: player.state.current_album_art,
			genre: null,
			year: null,
			source: (player.state.source ?? 'local') as LibraryTrack['source'],
			is_downloaded: false,
			local_file_path: null
		};
		menu.open({ x: 0, y: 0, tracks: [track], play: () => {}, extras: [] });
	}

	// The slider reports every position update as a change, not only the
	// listener's drags; seeking on those re-buffered the song every second.
	// Seek once, when a drag is let go.
	let dragging = $state(false);
	let dragMs = $state(0);
	let sliderValue = $derived([dragging ? dragMs : player.state.position_ms]);

	function onSeekDrag(values: number[]) {
		if (dragging && typeof values[0] === 'number') dragMs = values[0];
	}

	function onSeekCommit(values: number[]) {
		const ms = values[0];
		dragging = false;
		if (canSeek && typeof ms === 'number') void player.seek(ms);
	}
</script>

<Drawer.Root bind:open shouldScaleBackground={false}>
	<Drawer.Portal>
		<Drawer.Overlay class="fixed inset-0 z-40 bg-black/50" />
		<Drawer.Content
			class="fixed inset-x-0 bottom-0 z-50 mt-24 flex h-[96vh] isolate flex-col overflow-hidden rounded-t-2xl bg-background outline-none"
		>
			<!-- the artwork, blurred, tints the whole sheet -->
			{#if player.state.current_album_art}
				<img
					src={player.state.current_album_art}
					alt=""
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 -z-10 size-full scale-125 object-cover opacity-45 blur-3xl saturate-150"
				/>
				<div class="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-black/10 via-black/30 to-black/70"></div>
			{/if}
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
				<div class="text-[13px] font-medium text-foreground/70">
					{sourceLabel}
				</div>
				<div class="size-9"></div>
			</div>

			<!-- album art -->
			<div class="flex flex-1 flex-col items-center justify-center gap-8 px-8 pb-4">
				{#if player.state.current_album_art}
					<div
						class="aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-muted shadow-2xl"
					>
						<img
							src={player.state.current_album_art}
							alt=""
							class="size-full object-cover"
						/>
					</div>
				{:else}
					<StationArt
						name={title}
						src={null}
						class="aspect-square w-full max-w-sm rounded-2xl shadow-2xl transition-opacity duration-500 {isConnecting(
							stage
						) || failed
							? 'opacity-70'
							: ''}"
						monogramClass="text-7xl"
					/>
				{/if}

				<!-- title + artist -->
				<div class="flex w-full items-center gap-3">
					<div class="min-w-0 flex-1">
						<h2 class="line-clamp-2 text-[22px] font-bold leading-tight" title={player.state.current_title ?? undefined}>
							{title}
						</h2>
						{#if artist}
							<p class="line-clamp-1 text-[19px] text-foreground/60">{artist}</p>
						{/if}
					</div>
					{#if !isRadio && player.state.current_recording_id}
						<button
							class="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-foreground active:bg-white/20"
							aria-label="More"
							onclick={openMenu}
						>
							<Ellipsis class="size-5" />
						</button>
					{/if}
				</div>

				<!-- timeline -->
				<div class="flex w-full flex-col gap-1.5">
					{#if isRadio}
						<div class="flex min-h-7 items-center justify-center text-sm text-muted-foreground">
							{#if stage === 'idle'}
								<span class="text-xs uppercase tracking-widest">Live radio</span>
							{:else}
								<ConnectionStatus
									playback={player.state}
									long
									onRetry={() => void player.retryStation()}
									class={stage === 'playing' ? 'text-xs uppercase tracking-widest' : ''}
								/>
							{/if}
						</div>
					{:else if isConnecting(stage)}
						<div class="flex min-h-7 items-center justify-center text-sm text-muted-foreground">
							<ConnectionStatus playback={player.state} />
						</div>
					{:else}
						<!-- data-vaul-no-drag: a drag here scrubs the song instead of
						     pulling the sheet down. The padding is a bigger touch target. -->
						<div
							data-vaul-no-drag
							data-seek-bar
							class="-my-3 py-3"
							onpointerdowncapture={() => {
								if (!canSeek) return;
								dragMs = player.state.position_ms;
								dragging = true;
							}}
						>
							<Slider
								value={sliderValue}
								max={player.state.duration_ms || 1}
								step={1000}
								disabled={!canSeek}
								onValueChange={onSeekDrag}
								onValueCommit={onSeekCommit}
							/>
						</div>
						<div class="flex justify-between text-[11px] tabular-nums text-muted-foreground">
							<span>{formatTime(dragging ? dragMs : player.state.position_ms)}</span>
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
						aria-label={failed
							? 'Retry station'
							: player.state.is_buffering
								? 'Stop'
								: player.state.is_playing
									? 'Pause'
									: 'Play'}
					>
						{#if failed}
							<RotateCw class="size-7" />
						{:else if player.state.is_buffering}
							<Square class="size-6 fill-current" />
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
