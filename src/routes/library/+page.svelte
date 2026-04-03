<script lang="ts">
	import { page } from '$app/state';
	import * as api from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import TrackTable from '$lib/components/library/track-table.svelte';
	import AlbumGrid from '$lib/components/library/album-grid.svelte';
	import ArtistGrid from '$lib/components/library/artist-grid.svelte';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { Album, Artist, LibraryTrack } from '$lib/types';
	import { Input } from '$lib/components/ui/input';
	import { ArrowLeft, Play, Shuffle, Search } from '@lucide/svelte';

	const library = useLibrary();
	let filterQuery = $state('');
	const player = usePlayer();
	let focusedArtist = $state<Artist | null>(null);
	let focusedAlbum = $state<Album | null>(null);
	let focusedTracks = $state<LibraryTrack[]>([]);
	let focusedLoading = $state(false);

	$effect(() => {
		const artistId = page.url.searchParams.get('artist');
		const albumId = page.url.searchParams.get('album');

		if (artistId) {
			void loadArtistView(artistId);
			return;
		}

		if (albumId) {
			void loadAlbumView(albumId);
			return;
		}

		focusedArtist = null;
		focusedAlbum = null;
		focusedTracks = [];
		void library.loadAll();
	});

	async function loadArtistView(artistId: string) {
		focusedLoading = true;
		try {
			const [artist, tracks] = await Promise.all([
				api.getArtist(artistId),
				api.getArtistTracks(artistId)
			]);
			focusedArtist = artist;
			focusedAlbum = null;
			focusedTracks = tracks;
		} finally {
			focusedLoading = false;
		}
	}

	async function loadAlbumView(albumId: string) {
		focusedLoading = true;
		try {
			const [albums, tracks] = await Promise.all([
				api.getAllAlbums(),
				api.getAlbumTracks(albumId)
			]);
			focusedAlbum = albums.find((album) => album.id === albumId) ?? null;
			focusedArtist = null;
			focusedTracks = tracks;
		} finally {
			focusedLoading = false;
		}
	}

	function shuffleTracks(tracks: LibraryTrack[]): string[] {
		return [...tracks]
			.sort(() => Math.random() - 0.5)
			.map((track) => track.id);
	}

	async function playFocusedTracks(shuffle = false) {
		if (focusedTracks.length === 0) return;
		const ids = shuffle ? shuffleTracks(focusedTracks) : focusedTracks.map((track) => track.id);
		await player.playAll(ids, 0);
	}
</script>

<div class="flex flex-col gap-4">
	{#if library.error}
		<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{library.error}
		</p>
	{/if}

	{#if focusedArtist || focusedAlbum}
		<div class="flex items-center gap-3">
			<Button variant="ghost" size="sm" href="/library">
				<ArrowLeft class="mr-1 size-4" />
				Back
			</Button>
			<div>
				<h1 class="text-2xl font-bold">
					{focusedArtist?.name ?? focusedAlbum?.title ?? 'Library'}
				</h1>
				<p class="text-sm text-muted-foreground">
					{focusedArtist
						? `${focusedTracks.length} track${focusedTracks.length === 1 ? '' : 's'} by this artist`
						: `${focusedTracks.length} track${focusedTracks.length === 1 ? '' : 's'} on this album`}
				</p>
			</div>
			{#if focusedTracks.length > 0}
				<div class="ml-auto flex items-center gap-2">
					<Button variant="outline" size="sm" onclick={() => playFocusedTracks(true)}>
						<Shuffle class="mr-1 size-4" />
						Shuffle
					</Button>
					<Button size="sm" onclick={() => playFocusedTracks(false)}>
						<Play class="mr-1 size-4" />
						Play
					</Button>
				</div>
			{/if}
		</div>

		{#if focusedLoading}
			<div class="space-y-2">
				{#each Array(10) as _}
					<Skeleton class="h-12 w-full" />
				{/each}
			</div>
		{:else}
			<TrackTable tracks={focusedTracks} />
		{/if}
	{:else}
		{@const q = filterQuery.trim().toLowerCase()}
		{@const filteredTracks = q ? library.tracks.filter(t =>
			t.title.toLowerCase().includes(q) ||
			t.artist_name.toLowerCase().includes(q) ||
			(t.album_title ?? '').toLowerCase().includes(q)
		) : library.tracks}
		{@const filteredAlbums = q ? library.albums.filter(a =>
			a.title.toLowerCase().includes(q)
		) : library.albums}
		{@const filteredArtists = q ? library.artists.filter(a =>
			a.name.toLowerCase().includes(q)
		) : library.artists}

		<h1 class="text-2xl font-bold">Library</h1>

		<div class="relative">
			<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				placeholder="Filter your library..."
				class="pl-10"
				bind:value={filterQuery}
			/>
		</div>

		<Tabs value="songs">
			<TabsList>
				<TabsTrigger value="songs">Songs ({filteredTracks.length})</TabsTrigger>
				<TabsTrigger value="albums">Albums ({filteredAlbums.length})</TabsTrigger>
				<TabsTrigger value="artists">Artists ({filteredArtists.length})</TabsTrigger>
			</TabsList>

			<TabsContent value="songs">
				{#if library.loading}
					<div class="space-y-2">
						{#each Array(10) as _}
							<Skeleton class="h-12 w-full" />
						{/each}
					</div>
				{:else}
					<TrackTable tracks={filteredTracks} />
				{/if}
			</TabsContent>

			<TabsContent value="albums">
				{#if library.loading}
					<div class="grid grid-cols-4 gap-4">
						{#each Array(8) as _}
							<Skeleton class="aspect-square w-full rounded-lg" />
						{/each}
					</div>
				{:else}
					<AlbumGrid albums={filteredAlbums} />
				{/if}
			</TabsContent>

			<TabsContent value="artists">
				{#if library.loading}
					<div class="grid grid-cols-4 gap-4">
						{#each Array(8) as _}
							<Skeleton class="aspect-square w-full rounded-lg" />
						{/each}
					</div>
				{:else}
					<ArtistGrid artists={filteredArtists} />
				{/if}
			</TabsContent>
		</Tabs>
	{/if}
</div>
