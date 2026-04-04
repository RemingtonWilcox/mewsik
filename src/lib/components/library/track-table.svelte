<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import { Button } from '$lib/components/ui/button';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import type { LibraryTrack } from '$lib/types';
	import { startDrag } from '@crabnebula/tauri-plugin-drag';
	import * as api from '$lib/api/tauri';
	import { toast } from 'svelte-sonner';

	const DRAG_PREVIEW_ICON =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cqXcAAAAASUVORK5CYII=';
	let downloadingIds = $state<Set<string>>(new Set());

	async function downloadTrack(track: LibraryTrack) {
		if (downloadingIds.has(track.id)) return;
		downloadingIds = new Set([...downloadingIds, track.id]);
		try {
			await api.downloadRecording(track.id);
			toast.success(`Download queued: ${track.title}`);
		} catch (e) {
			toast.error(`Failed to download: ${e}`);
		} finally {
			downloadingIds = new Set([...downloadingIds].filter(id => id !== track.id));
		}
	}
	import {
		Music,
		Download,
		ListPlus,
		ListEnd,
		Play,
		Pause,
		Square,
		ListMusic,
		ArrowUp,
		ArrowDown,
		Trash2,
		LoaderCircle
	} from '@lucide/svelte';
	import AddToPlaylistDialog from '$lib/components/playlist/add-to-playlist-dialog.svelte';

	interface PlaylistActions {
		busyTrackId?: string | null;
		onMoveUp?: (track: LibraryTrack, index: number) => void | Promise<void>;
		onMoveDown?: (track: LibraryTrack, index: number) => void | Promise<void>;
		onRemove?: (track: LibraryTrack, index: number) => void | Promise<void>;
	}

	interface Props {
		tracks: LibraryTrack[];
		playlistActions?: PlaylistActions;
	}

	let { tracks, playlistActions }: Props = $props();

	const player = usePlayer();
	let playlistDialogOpen = $state(false);
	let selectedRecordingId = $state('');

	function playTrack(index: number) {
		const ids = tracks.map((t) => t.id);
		player.playAll(ids, index);
	}

	function toggleTrackPlayback(index: number) {
		const track = tracks[index];
		if (player.state.current_recording_id === track.id) {
			void player.togglePlay();
			return;
		}
		playTrack(index);
	}

	function isPlaylistBusy(track: LibraryTrack) {
		return playlistActions?.busyTrackId === (track.playlist_track_id ?? track.id);
	}

	function canDragOut(track: LibraryTrack) {
		return Boolean(track.local_file_path);
	}

	async function handleDragStart(event: DragEvent, track: LibraryTrack) {
		const filePath = track.local_file_path;
		if (!filePath) {
			event.preventDefault();
			return;
		}

		try {
			await startDrag({
				item: [filePath],
				icon: DRAG_PREVIEW_ICON,
				mode: 'copy'
			});
		} catch (error) {
			event.preventDefault();
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Drag failed: ${message}`);
		}
	}
</script>

<div class="w-full overflow-hidden">
	<!-- Header -->
	<div class="grid items-center gap-3 border-b border-border px-2 py-2 text-xs font-medium text-muted-foreground" style="grid-template-columns: 48px 1fr 20% 20% 64px{playlistActions ? ' 100px' : ''};">
		<div></div>
		<div>Title</div>
		<div>Artist</div>
		<div>Album</div>
		<div class="text-right">Duration</div>
		{#if playlistActions}
			<div class="text-right">Actions</div>
		{/if}
	</div>

	<!-- Rows -->
	{#each tracks as track, i (track.playlist_track_id ?? `${track.id}-${i}`)}
		<ContextMenu.Root>
			<ContextMenu.Trigger>
				{@const isCurrent = player.state.current_recording_id === track.id}
				{@const isBuffering = isCurrent && player.state.is_buffering}
				<div
					class={`grid items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 ${
						canDragOut(track) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
					}`}
					style="grid-template-columns: 48px 1fr 20% 20% 64px{playlistActions ? ' 100px' : ''};"
					ondblclick={() => playTrack(i)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							playTrack(i);
						}
					}}
					ondragstart={(event) => void handleDragStart(event, track)}
					draggable={canDragOut(track)}
					role="row"
					tabindex="0"
					title={canDragOut(track) ? 'Drag to copy this file into other apps' : undefined}
				>
					<!-- Play button -->
					<div>
						<button
							class={`flex size-8 items-center justify-center rounded-full transition-colors ${
								(isCurrent && (player.state.is_playing || player.state.is_buffering))
									? 'bg-primary text-primary-foreground'
									: 'bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground'
							}`}
							onclick={() => toggleTrackPlayback(i)}
						>
							{#if isBuffering}
								<Square class="size-3.5" />
							{:else if isCurrent && player.state.is_playing}
								<Pause class="size-3.5" />
							{:else}
								<Play class="size-3.5 pl-0.5" />
							{/if}
						</button>
					</div>
					<!-- Title -->
					<div class="flex min-w-0 items-center gap-2 overflow-hidden">
						{#if track.cover_art_path || track.cover_art_url}
							<img src={track.cover_art_path ?? track.cover_art_url} alt="" class="size-8 shrink-0 rounded object-cover" />
						{:else}
							<div class="flex size-8 shrink-0 items-center justify-center rounded bg-muted">
								<Music class="size-4 text-muted-foreground" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class={`truncate text-sm font-medium ${isCurrent ? 'text-primary' : ''}`}>{track.title}</p>
							{#if isCurrent}
								<p class="text-[11px] text-primary/80">
									{isBuffering ? 'Buffering' : player.state.is_playing ? 'Now playing' : 'Paused'}
								</p>
							{/if}
						</div>
						{#if track.is_downloaded}
							<Download class="size-3.5 shrink-0 text-primary" />
						{:else}
							<button
								class="shrink-0 text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
								onclick={(e) => { e.stopPropagation(); downloadTrack(track); }}
								disabled={downloadingIds.has(track.id)}
							>
								{#if downloadingIds.has(track.id)}
									<LoaderCircle class="size-3.5 animate-spin" />
								{:else}
									<Download class="size-3.5" />
								{/if}
							</button>
						{/if}
					</div>
					<!-- Artist -->
					<div class="truncate text-sm text-muted-foreground">{track.artist_name}</div>
					<!-- Album -->
					<div class="truncate text-sm text-muted-foreground">{track.album_title ?? ''}</div>
					<!-- Duration -->
					<div class="text-right text-sm text-muted-foreground">{track.duration_ms ? formatTime(track.duration_ms) : '--:--'}</div>
					{#if playlistActions}
						<!-- Playlist actions -->
						<div class="flex items-center justify-end gap-1">
							<Button variant="ghost" size="icon-sm" class="size-7" disabled={i === 0 || isPlaylistBusy(track)} onclick={(e) => { e.stopPropagation(); void playlistActions.onMoveUp?.(track, i); }}>
								<ArrowUp class="size-3.5" />
							</Button>
							<Button variant="ghost" size="icon-sm" class="size-7" disabled={i === tracks.length - 1 || isPlaylistBusy(track)} onclick={(e) => { e.stopPropagation(); void playlistActions.onMoveDown?.(track, i); }}>
								<ArrowDown class="size-3.5" />
							</Button>
							<Button variant="ghost" size="icon-sm" class="size-7 text-destructive hover:text-destructive" disabled={isPlaylistBusy(track)} onclick={(e) => { e.stopPropagation(); void playlistActions.onRemove?.(track, i); }}>
								<Trash2 class="size-3.5" />
							</Button>
						</div>
					{/if}
				</div>
			</ContextMenu.Trigger>
			<ContextMenu.Content>
				<ContextMenu.Item onclick={() => playTrack(i)}>
					<Play class="mr-2 size-4" />Play
				</ContextMenu.Item>
				<ContextMenu.Item onclick={() => player.playNext(track.id)}>
					<ListEnd class="mr-2 size-4" />Play Next
				</ContextMenu.Item>
				<ContextMenu.Item onclick={() => { player.addToQueue(track.id); toast.success('Added to queue'); }}>
					<ListPlus class="mr-2 size-4" />Add to Queue
				</ContextMenu.Item>
				<ContextMenu.Separator />
				<ContextMenu.Item onclick={() => { selectedRecordingId = track.id; playlistDialogOpen = true; }}>
					<ListMusic class="mr-2 size-4" />Add to Playlist
				</ContextMenu.Item>
				{#if playlistActions?.onRemove}
					<ContextMenu.Separator />
					<ContextMenu.Item class="text-destructive focus:text-destructive" onclick={() => void playlistActions.onRemove?.(track, i)}>
						<Trash2 class="mr-2 size-4" />Remove from Playlist
					</ContextMenu.Item>
				{/if}
			</ContextMenu.Content>
		</ContextMenu.Root>
	{/each}
</div>

<AddToPlaylistDialog
	recordingId={selectedRecordingId}
	bind:open={playlistDialogOpen}
	onOpenChange={(v) => { playlistDialogOpen = v; }}
/>
