<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as api from '$lib/api/tauri';
	import { usePlayer } from '$lib/state/player.svelte';
	import { usePlaylists } from '$lib/state/playlists.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import CollectionHeader from '$lib/components/tracks/collection-header.svelte';
	import type { TrackMenuExtra } from '$lib/state/track-menu.svelte';
	import { formatTotal, plural } from '$lib/media';
	import { toast } from 'svelte-sonner';
	import { Pencil, Trash2 } from '@lucide/svelte';
	import { onMount, tick, untrack } from 'svelte';
	import type { LibraryTrack } from '$lib/types';

	const player = usePlayer();
	const playlists = usePlaylists();

	const id = $derived(page.params.id ?? '');
	const playlist = $derived(playlists.byId(id));
	let tracks = $state<LibraryTrack[]>([]);
	let loaded = $state(false);
	let renaming = $state(false);
	let draft = $state('');
	let nameInput = $state<HTMLInputElement | null>(null);

	async function load(playlistId = id) {
		const list = await api.getPlaylistTracks(playlistId);
		if (playlistId !== id) return;
		tracks = list;
		loaded = true;
	}

	$effect(() => {
		loaded = false;
		void load(id);
	});

	// A brand-new playlist opens with its name ready to type over.
	$effect(() => {
		if (page.url.searchParams.get('rename')) untrack(() => void startRename());
	});

	onMount(() => {
		const changed = (event: Event) => {
			if ((event as CustomEvent<string>).detail === id) void load();
		};
		window.addEventListener('playlist-tracks-changed', changed);
		return () => window.removeEventListener('playlist-tracks-changed', changed);
	});

	const cover = $derived(tracks.find((t) => t.cover_art_path || t.cover_art_url));
	const total = $derived(tracks.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0));

	function play(shuffle = false) {
		const ids = tracks.map((t) => t.id);
		void (shuffle ? player.playShuffled(ids) : player.playOrdered(ids));
	}

	async function startRename() {
		await tick();
		draft = playlists.byId(id)?.name ?? '';
		renaming = true;
		await tick();
		nameInput?.select();
	}

	async function finishRename(save: boolean) {
		if (!renaming) return;
		renaming = false;
		if (save && draft.trim() && draft.trim() !== playlist?.name) {
			try {
				await playlists.rename(id, draft);
			} catch (error) {
				toast.error(`Couldn't rename: ${error}`);
			}
		}
		if (page.url.searchParams.has('rename')) void goto(`/playlists/${id}`, { replaceState: true });
	}

	async function remove() {
		if (!playlist) return;
		if (!confirm(`Delete “${playlist.name}”? The songs stay in your library.`)) return;
		await playlists.remove(playlist.id);
		toast.success('Playlist deleted');
		await goto('/library');
	}

	async function move(track: LibraryTrack, direction: -1 | 1) {
		const from = tracks.findIndex((t) => t.playlist_track_id === track.playlist_track_id);
		const to = from + direction;
		if (from < 0 || to < 0 || to >= tracks.length || !track.playlist_track_id) return;
		// Land between the new neighbours.
		const rest = tracks.filter((_, i) => i !== from);
		const before = rest[to - 1]?.playlist_position;
		const after = rest[to]?.playlist_position;
		const position =
			before == null ? (after ?? 1) - 1 : after == null ? before + 1 : (before + after) / 2;
		await api.reorderPlaylistTrack(id, track.playlist_track_id, position);
		await load();
	}

	const extras: TrackMenuExtra[] = [
		{
			label: 'Move up',
			run: async (selected) => {
				if (selected.length === 1) await move(selected[0], -1);
			}
		},
		{
			label: 'Move down',
			run: async (selected) => {
				if (selected.length === 1) await move(selected[0], 1);
			}
		},
		{
			label: 'Remove from this playlist',
			danger: true,
			run: async (selected) => {
				for (const track of selected) {
					if (track.playlist_track_id) await api.removeFromPlaylist(track.playlist_track_id);
				}
				const gone = new Set(selected.map((t) => t.playlist_track_id));
				tracks = tracks.filter((t) => !gone.has(t.playlist_track_id));
				toast.success(`Removed ${plural(selected.length, 'song')}`);
			}
		}
	];
</script>

{#if playlists.all.length > 0 && !playlist}
	<p class="py-16 text-center text-muted-foreground">This playlist doesn't exist anymore.</p>
{:else}
	<div class="flex flex-col gap-6">
		<CollectionHeader
			kind="Playlist"
			title={playlist?.name ?? ''}
			cover={cover?.cover_art_path || cover?.cover_art_url || null}
			onplay={tracks.length ? () => play() : undefined}
			onshuffle={tracks.length ? () => play(true) : undefined}
		>
			{#snippet titleSlot()}
				{#if renaming}
					<input
						bind:this={nameInput}
						bind:value={draft}
						maxlength="120"
						class="w-full max-w-2xl rounded-md border border-white/15 bg-white/5 px-2 py-1 text-4xl font-bold tracking-tight outline-none focus:border-primary"
						onkeydown={(e) => {
							if (e.key === 'Enter') void finishRename(true);
							if (e.key === 'Escape') void finishRename(false);
						}}
						onblur={() => void finishRename(true)}
					/>
				{:else}
					<button
						class="line-clamp-2 break-words text-left text-4xl font-bold tracking-tight hover:opacity-90"
						title="Rename"
						onclick={startRename}>{playlist?.name ?? ''}</button
					>
				{/if}
			{/snippet}
			{#snippet meta()}
				{#if loaded}{plural(tracks.length, 'song')}{#if total}, {formatTotal(total)}{/if}{/if}
			{/snippet}
			{#snippet actions()}
				<button
					class="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
					title="Rename"
					aria-label="Rename playlist"
					onclick={startRename}
				>
					<Pencil class="size-4" />
				</button>
				<button
					class="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-destructive"
					title="Delete playlist"
					aria-label="Delete playlist"
					onclick={remove}
				>
					<Trash2 class="size-4" />
				</button>
			{/snippet}
		</CollectionHeader>

		{#if loaded}
			<TrackList
				{tracks}
				{extras}
				emptyText="This playlist is empty. Right-click any song and choose Add to playlist."
			/>
		{/if}
	</div>
{/if}
