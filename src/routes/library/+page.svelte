<script lang="ts">
	import { page } from '$app/state';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import Tile from '$lib/components/tracks/tile.svelte';
	import { fold, formatTotal, plural } from '$lib/media';
	import { toast } from 'svelte-sonner';
	import { Play, Shuffle, RefreshCw, Search, X } from '@lucide/svelte';
	import type { LibraryTrack } from '$lib/types';

	const library = useLibrary();
	const player = usePlayer();

	type View = 'songs' | 'albums' | 'artists';
	type Sort = 'added' | 'title' | 'artist' | 'album';

	const view = $derived((page.url.searchParams.get('view') as View) || 'songs');
	let query = $state('');
	let sort = $state<Sort>('added');

	const words = $derived(fold(query).split(/\s+/).filter(Boolean));
	const matches = (text: string) => words.every((word) => text.includes(word));

	const haystacks = $derived(
		new Map(
			library.tracks.map((t) => [t.id, fold(`${t.title} ${t.artist_name} ${t.album_title ?? ''}`)])
		)
	);

	const byText = (a: string | null, b: string | null) =>
		(a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });

	const songs = $derived.by(() => {
		let list = words.length
			? library.tracks.filter((t) => matches(haystacks.get(t.id) ?? ''))
			: [...library.tracks];
		switch (sort) {
			// ULIDs sort by creation time, so newest ids are newest additions.
			case 'added':
				list.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
				break;
			case 'title':
				list.sort((a, b) => byText(a.title, b.title));
				break;
			case 'artist':
				list.sort(
					(a, b) =>
						byText(a.artist_name, b.artist_name) ||
						byText(a.album_title, b.album_title) ||
						byText(a.title, b.title)
				);
				break;
			case 'album':
				list.sort((a, b) => byText(a.album_title, b.album_title) || byText(a.title, b.title));
				break;
		}
		return list;
	});

	const albums = $derived(
		words.length
			? library.albums.filter((a) => matches(fold(`${a.title} ${a.artist}`)))
			: library.albums
	);
	const artists = $derived(
		words.length ? library.artists.filter((a) => matches(fold(a.name))) : library.artists
	);

	const totalMs = $derived(library.tracks.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0));

	function playList(list: LibraryTrack[], shuffle = false) {
		const ids = list.map((t) => t.id);
		void (shuffle ? player.playShuffled(ids) : player.playOrdered(ids));
	}

	async function rescan() {
		const summary = await library.scan();
		if (!summary) return;
		const parts = [];
		if (summary.new_tracks) parts.push(`${summary.new_tracks} new`);
		if (summary.removed_tracks) parts.push(`${summary.removed_tracks} removed`);
		toast.success(parts.length ? `Library updated: ${parts.join(', ')}` : 'Library is up to date');
	}

	const tabs: { id: View; label: string }[] = [
		{ id: 'songs', label: 'Songs' },
		{ id: 'albums', label: 'Albums' },
		{ id: 'artists', label: 'Artists' }
	];
	const counts = $derived({ songs: songs.length, albums: albums.length, artists: artists.length });
</script>

<div class="flex flex-col gap-5">
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-3xl font-bold tracking-tight">Library</h1>
			{#if library.loaded}
				<p class="mt-1 text-sm text-muted-foreground">
					{plural(library.tracks.length, 'song')} · {formatTotal(totalMs)}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<button
				class="flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50"
				disabled={songs.length === 0}
				onclick={() => playList(songs)}
			>
				<Play class="size-4 fill-current" /> Play
			</button>
			<button
				class="flex h-9 items-center gap-2 rounded-full border border-white/10 px-4 text-sm font-medium hover:bg-white/5 disabled:opacity-50"
				disabled={songs.length === 0}
				onclick={() => playList(songs, true)}
			>
				<Shuffle class="size-4" /> Shuffle
			</button>
			<button
				class="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-50"
				title="Rescan music folders"
				aria-label="Rescan music folders"
				disabled={library.scanning}
				onclick={rescan}
			>
				<RefreshCw class="size-4 {library.scanning ? 'animate-spin' : ''}" />
			</button>
		</div>
	</header>

	{#if library.error}
		<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{library.error}
		</p>
	{/if}

	<div class="flex flex-wrap items-center gap-3">
		<div class="flex rounded-full bg-white/5 p-1">
			{#each tabs as tab (tab.id)}
				<a
					href={tab.id === 'songs' ? '/library' : `/library?view=${tab.id}`}
					data-sveltekit-replacestate
					data-sveltekit-noscroll
					class="rounded-full px-4 py-1.5 text-sm transition-colors {view === tab.id
						? 'bg-white/10 font-medium text-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					{tab.label}
					<span class="ml-1 text-xs text-muted-foreground">{counts[tab.id].toLocaleString()}</span>
				</a>
			{/each}
		</div>

		<div class="relative ml-auto w-full max-w-xs">
			<Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<input
				bind:value={query}
				placeholder="Filter"
				class="h-9 w-full rounded-full border border-white/10 bg-white/5 pl-9 pr-8 text-sm outline-none placeholder:text-muted-foreground focus:border-white/25"
				onkeydown={(e) => e.key === 'Escape' && (query = '')}
			/>
			{#if query}
				<button
					class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label="Clear filter"
					onclick={() => (query = '')}
				>
					<X class="size-4" />
				</button>
			{/if}
		</div>

		{#if view === 'songs'}
			<select
				bind:value={sort}
				aria-label="Sort songs"
				class="h-9 rounded-full border border-white/10 bg-white/5 px-3 text-sm outline-none"
			>
				<option value="added">Recently added</option>
				<option value="title">Title</option>
				<option value="artist">Artist</option>
				<option value="album">Album</option>
			</select>
		{/if}
	</div>

	{#if !library.loaded}
		<div class="space-y-2">
			{#each Array(8) as _, i (i)}
				<div class="h-12 animate-pulse rounded-md bg-white/5"></div>
			{/each}
		</div>
	{:else if library.tracks.length === 0}
		<div class="rounded-xl border border-dashed border-white/10 px-6 py-16 text-center">
			<p class="text-lg font-medium">Your library is empty</p>
			<p class="mt-1 text-sm text-muted-foreground">
				Add a music folder in <a href="/settings" class="underline">Settings</a>, or find songs in
				<a href="/search" class="underline">Search</a>.
			</p>
		</div>
	{:else if view === 'songs'}
		<TrackList tracks={songs} emptyText="No songs match “{query}”." />
	{:else if view === 'albums'}
		{#if albums.length === 0}
			<p class="py-10 text-center text-sm text-muted-foreground">No albums match “{query}”.</p>
		{:else}
			<div class="tile-grid">
				{#each albums as album (album.id)}
					<Tile
						href="/albums/{album.id}"
						title={album.title}
						subtitle={album.year ? `${album.artist} · ${album.year}` : album.artist}
						cover={album.cover}
						onplay={() => void player.playAlbum(album.id)}
					/>
				{/each}
			</div>
		{/if}
	{:else if artists.length === 0}
		<p class="py-10 text-center text-sm text-muted-foreground">No artists match “{query}”.</p>
	{:else}
		<div class="tile-grid">
			{#each artists as artist (artist.id)}
				<Tile
					href="/artists/{artist.id}"
					title={artist.name}
					subtitle={plural(artist.trackCount, 'song')}
					cover={artist.cover}
					round
					onplay={() => playList(library.tracks.filter((t) => t.artist_id === artist.id))}
				/>
			{/each}
		</div>
	{/if}
</div>
