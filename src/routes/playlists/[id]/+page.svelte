<script lang="ts">
	import { page } from '$app/state';
	import * as api from '$lib/api/tauri';
	import TrackTable from '$lib/components/library/track-table.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Textarea } from '$lib/components/ui/textarea';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import type { LibraryTrack, Playlist } from '$lib/types';
	import { Trash2, Play, Shuffle, Save, RotateCcw } from '@lucide/svelte';

	const player = usePlayer();
	let playlist = $state<Playlist | null>(null);
	let tracks = $state<LibraryTrack[]>([]);
	let loading = $state(true);
	let draftName = $state('');
	let draftDescription = $state('');
	let savingDetails = $state(false);
	let movingTrackId = $state<string | null>(null);
	let removingTrackId = $state<string | null>(null);

	$effect(() => {
		const id = page.params.id;
		void loadPlaylist(id);
	});

	async function loadPlaylist(playlistId = page.params.id, preserveDrafts = false) {
		loading = true;
		if (!playlistId) {
			playlist = null;
			tracks = [];
			loading = false;
			return;
		}
		try {
			const [playlists, playlistTracks] = await Promise.all([
				api.getPlaylists(),
				api.getPlaylistTracks(playlistId)
			]);
			playlist = playlists.find((p) => p.id === playlistId) ?? null;
			tracks = playlistTracks;
			if (playlist && !preserveDrafts) {
				draftName = playlist.name;
				draftDescription = playlist.description ?? '';
			}
		} catch (e) {
			toast.error('Failed to load playlist');
		} finally {
			loading = false;
		}
	}

	async function handleDelete() {
		if (!playlist) return;
		if (!window.confirm(`Delete "${playlist.name}"? This only removes the playlist, not the tracks.`)) {
			return;
		}
		try {
			await api.deletePlaylist(playlist.id);
			window.dispatchEvent(new CustomEvent('playlists-changed'));
			toast.success('Playlist deleted');
			goto('/library');
		} catch {
			toast.error('Failed to delete playlist');
		}
	}

	function isMetadataDirty() {
		if (!playlist) return false;
		return (
			draftName.trim() !== playlist.name ||
			draftDescription.trim() !== (playlist.description ?? '')
		);
	}

	function resetMetadata() {
		if (!playlist) return;
		draftName = playlist.name;
		draftDescription = playlist.description ?? '';
	}

	async function saveMetadata() {
		if (!playlist) return;
		const name = draftName.trim();
		const description = draftDescription.trim();
		if (!name) {
			toast.error('Playlist name is required');
			return;
		}

		savingDetails = true;
		try {
			await api.updatePlaylist(playlist.id, name, description);
			playlist = {
				...playlist,
				name,
				description: description || null
			};
			window.dispatchEvent(new CustomEvent('playlists-changed'));
			toast.success('Playlist updated');
		} catch {
			toast.error('Failed to update playlist');
		} finally {
			savingDetails = false;
		}
	}

	function trackBusyId(track: LibraryTrack) {
		return track.playlist_track_id ?? track.id;
	}

	function trackPositionAt(index: number) {
		return tracks[index]?.playlist_position ?? index + 1;
	}

	function computeReorderPosition(fromIndex: number, toIndex: number) {
		const remaining = tracks.filter((_, index) => index !== fromIndex);
		const previous = toIndex > 0 ? remaining[toIndex - 1] : null;
		const next = toIndex < remaining.length ? remaining[toIndex] : null;

		if (!previous && !next) {
			return 1;
		}

		if (!previous) {
			return trackPositionAt(toIndex) - 1;
		}

		if (!next) {
			return (previous.playlist_position ?? toIndex) + 1;
		}

		return ((previous.playlist_position ?? toIndex) + (next.playlist_position ?? toIndex + 1)) / 2;
	}

	async function moveTrack(track: LibraryTrack, fromIndex: number, direction: -1 | 1) {
		if (!playlist || !track.playlist_track_id) return;
		const toIndex = fromIndex + direction;
		if (toIndex < 0 || toIndex >= tracks.length) return;

		movingTrackId = trackBusyId(track);
		try {
			const newPosition = computeReorderPosition(fromIndex, toIndex);
			await api.reorderPlaylistTrack(playlist.id, track.playlist_track_id, newPosition);
			await loadPlaylist(playlist.id, true);
		} catch {
			toast.error('Failed to reorder track');
		} finally {
			movingTrackId = null;
		}
	}

	async function removeTrack(track: LibraryTrack) {
		if (!track.playlist_track_id) return;
		removingTrackId = trackBusyId(track);
		try {
			await api.removeFromPlaylist(track.playlist_track_id);
			tracks = tracks.filter((item) => item.playlist_track_id !== track.playlist_track_id);
			toast.success('Removed from playlist');
		} catch {
			toast.error('Failed to remove track');
		} finally {
			removingTrackId = null;
		}
	}

	function shuffleTracks(): string[] {
		return [...tracks]
			.sort(() => Math.random() - 0.5)
			.map((track) => track.id);
	}

	async function playPlaylist(shuffle = false) {
		if (tracks.length === 0) return;
		const ids = shuffle ? shuffleTracks() : tracks.map((track) => track.id);
		await player.playAll(ids, 0);
	}
</script>

<div class="flex flex-col gap-4">
	{#if loading}
		<Skeleton class="h-8 w-48" />
		<div class="space-y-2">
			{#each Array(5) as _}
				<Skeleton class="h-12 w-full" />
			{/each}
		</div>
	{:else if playlist}
		<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
			<div class="space-y-3">
				<div class="space-y-1">
					<p class="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
						Playlist
					</p>
					<Input
						bind:value={draftName}
						placeholder="Playlist name"
						maxlength={120}
						class="max-w-xl text-base font-semibold"
					/>
					<Textarea
						bind:value={draftDescription}
						placeholder="What is this playlist for?"
						rows={3}
						class="max-w-xl resize-none"
					/>
					<p class="text-xs text-muted-foreground">
						{tracks.length} track{tracks.length === 1 ? '' : 's'}
					</p>
				</div>
				{#if isMetadataDirty()}
					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={savingDetails}
							onclick={resetMetadata}
						>
							<RotateCcw class="mr-1 size-4" />
							Reset
						</Button>
						<Button
							size="sm"
							disabled={savingDetails || !draftName.trim()}
							onclick={saveMetadata}
						>
							<Save class="mr-1 size-4" />
							Save Details
						</Button>
					</div>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2 lg:justify-self-end">
				{#if tracks.length > 0}
					<Button variant="outline" size="sm" onclick={() => playPlaylist(true)}>
						<Shuffle class="mr-1 size-4" />
						Shuffle
					</Button>
					<Button size="sm" onclick={() => playPlaylist(false)}>
						<Play class="mr-1 size-4" />
						Play
					</Button>
				{/if}
				<Button variant="destructive" size="sm" onclick={handleDelete}>
					<Trash2 class="mr-1 size-4" />
					Delete
				</Button>
			</div>
		</div>

		{#if tracks.length > 0}
			<TrackTable
				{tracks}
				playlistActions={{
					busyTrackId: movingTrackId ?? removingTrackId,
					onMoveUp: (track, index) => moveTrack(track, index, -1),
					onMoveDown: (track, index) => moveTrack(track, index, 1),
					onRemove: (track) => removeTrack(track)
				}}
			/>
		{:else}
			<div class="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
				This playlist is empty. Add tracks from the library or search results to start building it.
			</div>
		{/if}
	{:else}
		<p class="text-muted-foreground">Playlist not found.</p>
	{/if}
</div>
