<script lang="ts">
	import { page } from '$app/state';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import Tile from '$lib/components/tracks/tile.svelte';
	import { fold, formatTotal, plural } from '$lib/media';
	import { toast } from 'svelte-sonner';
	import { Play, Shuffle, RefreshCw, Search, X, Settings, ArrowUpDown, FolderOpen, Radio, LoaderCircle } from '@lucide/svelte';
	import * as api from '$lib/api/tauri';
	import type { LibraryTrack } from '$lib/types';
	import MobileShortcuts from '$lib/components/mobile/mobile-shortcuts.svelte';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';

	const isMobile = new IsMobile();

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
	// A new library starts from a folder of music the user already has.
	let addingFolder = $state(false);
	async function addMusicFolder() {
		if (addingFolder) return;
		addingFolder = true;
		try {
			const path = await api.pickFolder();
			if (!path) return;
			const paths = await api.getLibraryPaths();
			if (!paths.includes(path)) await api.updateLibraryPaths([...paths, path]);
			const result = await library.scan();
			if (result) toast.success(`Found ${plural(result.new_tracks, 'song')}`);
		} catch (error) {
			toast.error(`Couldn't add that folder: ${error}`);
		} finally {
			addingFolder = false;
		}
	}

	const counts = $derived({ songs: songs.length, albums: albums.length, artists: artists.length });
</script>

<div class="flex flex-col gap-5">
	{#if isMobile.current}
		<header class="flex flex-col gap-4">
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-[34px] font-bold leading-tight tracking-tight">Library</h1>
					{#if library.loaded && library.tracks.length}
						<p class="text-[15px] text-muted-foreground">
							{plural(library.tracks.length, 'song')} · {formatTotal(totalMs)}
						</p>
					{/if}
				</div>
				<a
					href="/settings"
					class="press flex size-10 items-center justify-center rounded-full bg-white/[0.08] text-foreground"
					aria-label="Settings"
				>
					<Settings class="size-5" />
				</a>
			</div>
			{#if songs.length}
				<div class="grid grid-cols-2 gap-3">
					<button
						class="press flex h-12 items-center justify-center gap-2 rounded-xl bg-white/[0.08] text-[17px] font-semibold text-primary"
						onclick={() => playList(songs)}
					>
						<Play class="size-5 fill-current" /> Play
					</button>
					<button
						class="press flex h-12 items-center justify-center gap-2 rounded-xl bg-white/[0.08] text-[17px] font-semibold text-primary"
						onclick={() => playList(songs, true)}
					>
						<Shuffle class="size-5" /> Shuffle
					</button>
				</div>
			{/if}
		</header>

		<MobileShortcuts />

		<div class="flex flex-col gap-3">
			<nav class="segmented" aria-label="Library view">
				{#each tabs as tab (tab.id)}
					<a
						href={tab.id === 'songs' ? '/library' : `/library?view=${tab.id}`}
						data-sveltekit-replacestate
						data-sveltekit-noscroll
						aria-current={view === tab.id ? 'page' : undefined}
					>
						{tab.label}
					</a>
				{/each}
			</nav>
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<input
						bind:value={query}
						placeholder="Find in library"
						class="h-10 w-full rounded-xl bg-white/[0.08] pl-9 pr-8 text-base outline-none placeholder:text-muted-foreground"
					/>
					{#if query}
						<button
							class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
							aria-label="Clear filter"
							onclick={() => (query = '')}
						>
							<X class="size-4" />
						</button>
					{/if}
				</div>
				{#if view === 'songs'}
					<label class="relative flex h-10 items-center overflow-hidden rounded-xl bg-white/[0.08] px-3 text-sm text-muted-foreground">
						<ArrowUpDown class="size-4" />
						<span class="sr-only">Sort songs</span>
						<select bind:value={sort} aria-label="Sort songs" class="absolute inset-0 size-full appearance-none opacity-0">
							<option value="added">Recently added</option>
							<option value="title">Title</option>
							<option value="artist">Artist</option>
							<option value="album">Album</option>
						</select>
					</label>
				{/if}
			</div>
		</div>

		{#if library.error}
			<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{library.error}
			</p>
		{/if}
	{:else}
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

	{/if}

	{#if !library.loaded}
		<div class="space-y-2">
			{#each Array(8) as _, i (i)}
				<div class="h-12 animate-pulse rounded-md bg-white/5"></div>
			{/each}
		</div>
	{:else if library.tracks.length === 0}
		<div class="py-4" data-testid="library-empty">
			<p class="text-xl font-semibold">Start your library</p>
			<p class="mt-1 text-sm text-muted-foreground">Songs you add, download or import show up here.</p>
			<div class="mt-5 grid gap-3 {isMobile.current ? '' : 'max-w-4xl sm:grid-cols-3'}">
				<a href="/search" class="start-card">
					<Search class="size-5 text-primary" />
					<span class="font-medium">Find any song</span>
					<span class="text-sm text-muted-foreground">Search YouTube and SoundCloud, then tap + to keep it.</span>
				</a>
				<a href="/stations" class="start-card">
					<Radio class="size-5 text-primary" />
					<span class="font-medium">Turn on the radio</span>
					<span class="text-sm text-muted-foreground">Over 50,000 live stations from around the world.</span>
				</a>
				{#if !isMobile.current}
					<button class="start-card text-left" onclick={addMusicFolder} disabled={addingFolder}>
						{#if addingFolder}
							<LoaderCircle class="size-5 animate-spin text-primary" />
						{:else}
							<FolderOpen class="size-5 text-primary" />
						{/if}
						<span class="font-medium">{addingFolder ? 'Adding your music…' : 'Add your music folder'}</span>
						<span class="text-sm text-muted-foreground">Point at the folder where your music files live.</span>
					</button>
				{/if}
			</div>
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

<style>
	.start-card {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		border-radius: 0.75rem;
		border: 1px solid rgb(255 255 255 / 0.08);
		background: rgb(255 255 255 / 0.03);
		padding: 1.25rem;
		transition: background-color 150ms;
	}
	.start-card:hover {
		background: rgb(255 255 255 / 0.06);
	}
</style>
