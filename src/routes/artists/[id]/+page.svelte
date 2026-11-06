<script lang="ts">
	import { page } from '$app/state';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import Tile from '$lib/components/tracks/tile.svelte';
	import CollectionHeader from '$lib/components/tracks/collection-header.svelte';
	import { plural } from '$lib/media';

	const library = useLibrary();
	const player = usePlayer();

	const id = $derived(page.params.id ?? '');
	const artist = $derived(library.artists.find((a) => a.id === id));
	const tracks = $derived(
		library.tracks
			.filter((t) => t.artist_id === id)
			.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
	);
	const albums = $derived(
		library.albums
			.filter((album) => album.tracks.some((t) => t.artist_id === id))
			.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
	);

	function play(shuffle = false) {
		const ids = tracks.map((t) => t.id);
		void (shuffle ? player.playShuffled(ids) : player.playOrdered(ids));
	}
</script>

{#if library.loaded && !artist}
	<p class="py-16 text-center text-muted-foreground">This artist isn't in your library.</p>
{:else if artist}
	<div class="flex flex-col gap-8">
		<CollectionHeader
			kind="Artist"
			title={artist.name}
			cover={artist.cover}
			round
			onplay={() => play()}
			onshuffle={() => play(true)}
		>
			{#snippet meta()}
				{plural(artist.trackCount, 'song')}{#if albums.length}, {plural(albums.length, 'album')}{/if}
			{/snippet}
		</CollectionHeader>

		{#if albums.length > 0}
			<section>
				<h2 class="mb-3 text-xl font-bold">Albums</h2>
				<div class="tile-grid">
					{#each albums as album (album.id)}
						<Tile
							href="/albums/{album.id}"
							title={album.title}
							subtitle={album.year ? String(album.year) : plural(album.tracks.length, 'song')}
							cover={album.cover}
							onplay={() => void player.playAlbum(album.id)}
						/>
					{/each}
				</div>
			</section>
		{/if}

		<section>
			<h2 class="mb-3 text-xl font-bold">Songs</h2>
			<TrackList {tracks} />
		</section>
	</div>
{/if}
