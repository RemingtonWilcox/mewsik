<script lang="ts">
	import { page } from '$app/state';
	import * as api from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import CollectionHeader from '$lib/components/tracks/collection-header.svelte';
	import { formatTotal, plural } from '$lib/media';
	import type { LibraryTrack } from '$lib/types';

	const library = useLibrary();
	const player = usePlayer();

	const id = $derived(page.params.id ?? '');
	const summary = $derived(library.albums.find((album) => album.id === id));
	let tracks = $state<LibraryTrack[]>([]);
	let loaded = $state(false);

	// Album order (disc, track number) comes from the backend.
	$effect(() => {
		const albumId = id;
		void library.tracks;
		loaded = false;
		void api.getAlbumTracks(albumId).then((list) => {
			if (albumId !== id) return;
			tracks = list;
			loaded = true;
		});
	});

	const total = $derived(tracks.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0));
	const artists = $derived([...new Map(tracks.map((t) => [t.artist_id, t.artist_name])).entries()]);

	function play(shuffle = false) {
		const ids = tracks.map((t) => t.id);
		void (shuffle ? player.playShuffled(ids) : player.playOrdered(ids));
	}
</script>

{#if loaded && tracks.length === 0}
	<p class="py-16 text-center text-muted-foreground">This album isn't in your library.</p>
{:else}
	<div class="flex flex-col gap-6">
		<CollectionHeader
			kind="Album"
			title={summary?.title ?? tracks[0]?.album_title ?? ''}
			cover={summary?.cover ?? tracks[0]?.cover_art_path ?? null}
			onplay={() => play()}
			onshuffle={() => play(true)}
		>
			{#snippet meta()}
				{#each artists.slice(0, 3) as [artistId, name], i (artistId)}
					{#if i > 0}<span>, </span>{/if}
					<a href="/artists/{artistId}" class="font-medium text-foreground hover:underline">{name}</a>
				{/each}
				{#if artists.length > 3}<span> and others</span>{/if}
				{#if summary?.year}<span> · {summary.year}</span>{/if}
				{#if loaded}<span> · {plural(tracks.length, 'song')}, {formatTotal(total)}</span>{/if}
			{/snippet}
		</CollectionHeader>

		<TrackList {tracks} showAlbum={false} numbered />
	</div>
{/if}
