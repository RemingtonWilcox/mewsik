<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import * as api from '$lib/api/tauri';
	import type { ExternalSearchResult } from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { useSearchState } from '$lib/state/search.svelte';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import Tile from '$lib/components/tracks/tile.svelte';
	import Cover from '$lib/components/tracks/cover.svelte';
	import SourceIcon from '$lib/components/source-icon.svelte';
	import { fold, formatDuration, plural } from '$lib/media';
	import { Search, X, Play, Pause, Plus, Check, Download, LoaderCircle } from '@lucide/svelte';

	const library = useLibrary();
	const player = usePlayer();
	const saved = useSearchState();

	const SOURCES: Record<string, string> = {
		youtube: 'YouTube',
		soundcloud: 'SoundCloud',
		bandcamp: 'Bandcamp'
	};

	let input = $state<HTMLInputElement | null>(null);
	let query = $state(saved.query || page.url.searchParams.get('q') || '');
	let online = $state<ExternalSearchResult[]>(saved.online);
	let onlineQuery = $state(saved.onlineQuery);
	let searching = $state(false);
	let failed = $state<string[]>([]);
	let onlineError = $state('');
	let busy = $state<Record<string, 'play' | 'save' | 'download'>>({});
	let savedKeys = $state(new Set<string>());
	let downloadedKeys = $state(new Set<string>());
	let request = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clean = $derived(query.trim().replace(/\s+/g, ' '));
	const words = $derived(fold(clean).split(' ').filter(Boolean));
	const has = (text: string) => words.every((w) => text.includes(w));

	// Library matches update on every keystroke.
	const songs = $derived(
		words.length
			? library.tracks
					.filter((t) => has(fold(`${t.title} ${t.artist_name} ${t.album_title ?? ''}`)))
					.slice(0, 50)
			: []
	);
	const albums = $derived(
		words.length ? library.albums.filter((a) => has(fold(`${a.title} ${a.artist}`))).slice(0, 12) : []
	);
	const artists = $derived(
		words.length ? library.artists.filter((a) => has(fold(a.name))).slice(0, 12) : []
	);

	$effect(() => {
		saved.query = query;
	});

	onMount(() => {
		input?.focus();
		const offPartial = api.listenExternalSearchPartial((event) => {
			if (event.request_id !== String(request)) return;
			online = merge(online, event.results);
		});
		const offComplete = api.listenExternalSearchComplete((event) => {
			if (event.request_id !== String(request)) return;
			online = event.results ?? online;
		});
		if (clean.length >= 2 && clean !== onlineQuery) void searchOnline(clean);
		return () => {
			clearTimeout(timer);
			void offPartial.then((off) => off());
			void offComplete.then((off) => off());
		};
	});

	const key = (r: ExternalSearchResult) => `${r.source}:${r.source_id}`;

	function merge(current: ExternalSearchResult[], incoming: ExternalSearchResult[]) {
		const seen = new Map(current.map((r, i) => [key(r), i]));
		const out = [...current];
		for (const r of incoming) {
			const at = seen.get(key(r));
			if (at === undefined) {
				seen.set(key(r), out.length);
				out.push(r);
			} else out[at] = r;
		}
		return out;
	}

	function typed() {
		clearTimeout(timer);
		if (clean.length < 3) return;
		timer = setTimeout(() => void searchOnline(clean), 700);
	}

	async function searchOnline(text: string) {
		clearTimeout(timer);
		if (text.length < 2 || (text === onlineQuery && (searching || online.length))) return;
		const id = ++request;
		online = [];
		onlineQuery = text;
		failed = [];
		onlineError = '';
		searching = true;
		void goto(`/search?q=${encodeURIComponent(text)}`, {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
		try {
			await api.startSidecar();
			const response = await api.searchAllSources(text, String(id));
			if (id !== request) return;
			online = response.items ?? [];
			failed = response.failed_sources ?? [];
		} catch (error) {
			if (id === request && online.length === 0) onlineError = String(error);
		} finally {
			if (id === request) {
				searching = false;
				saved.online = online;
				saved.onlineQuery = text;
			}
		}
	}

	function clear() {
		query = '';
		online = [];
		onlineQuery = '';
		saved.online = [];
		saved.onlineQuery = '';
		request++;
		searching = false;
		void goto('/search', { replaceState: true, noScroll: true, keepFocus: true });
		input?.focus();
	}

	async function task(r: ExternalSearchResult, kind: 'play' | 'save' | 'download', run: () => Promise<void>) {
		const k = key(r);
		if (busy[k]) return;
		busy = { ...busy, [k]: kind };
		try {
			await run();
		} catch (error) {
			toast.error(`Couldn't ${kind === 'save' ? 'add' : kind} “${r.title}”: ${error}`);
		} finally {
			const { [k]: _, ...rest } = busy;
			busy = rest;
		}
	}

	const recordingFor = (r: ExternalSearchResult) =>
		r.recording_id
			? Promise.resolve(r.recording_id)
			: api.ensureExternalRecording(
					r.source,
					r.source_id,
					r.title,
					r.artist,
					r.duration_ms ?? undefined,
					r.cover_art_url ?? undefined
				);

	function isCurrent(r: ExternalSearchResult) {
		const id = player.state.current_recording_id;
		return Boolean(id && r.recording_id === id) ||
			(player.state.current_title === r.title && player.state.current_artist === r.artist);
	}

	function playOnline(index: number) {
		const r = online[index];
		if (isCurrent(r)) return void player.togglePlay();
		void task(r, 'play', async () => {
			// The rest of the results queue up behind it.
			await api.playExternalContext(online, index);
		});
	}

	function save(r: ExternalSearchResult) {
		void task(r, 'save', async () => {
			await api.saveToLibrary(await recordingFor(r));
			savedKeys = new Set(savedKeys).add(key(r));
			toast.success(`Added “${r.title}” to your library`);
			void library.refresh();
		});
	}

	function download(r: ExternalSearchResult) {
		void task(r, 'download', async () => {
			const started = await api.downloadRecording(await recordingFor(r));
			downloadedKeys = new Set(downloadedKeys).add(key(r));
			toast.success(started.already_active ? 'Already downloading' : `Downloading “${r.title}”`);
		});
	}
</script>

<div class="flex flex-col gap-8">
	<h1 class="-mb-4 text-3xl font-bold tracking-tight">Search</h1>
	<div class="relative max-w-2xl">
		<Search class="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
		<input
			bind:this={input}
			bind:value={query}
			data-search-input
			placeholder="Songs, artists, albums — your library and online"
			class="h-12 w-full rounded-full border border-white/10 bg-white/5 pl-12 pr-11 text-base outline-none placeholder:text-muted-foreground focus:border-white/30 focus:bg-white/[0.07]"
			oninput={typed}
			onkeydown={(e) => {
				if (e.key === 'Enter') void searchOnline(clean);
				if (e.key === 'Escape') clear();
			}}
		/>
		{#if query}
			<button
				class="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				aria-label="Clear search"
				onclick={clear}
			>
				<X class="size-5" />
			</button>
		{/if}
	</div>

	{#if !clean}
		<p class="text-sm text-muted-foreground">
			Type to search your library. Online results from YouTube, SoundCloud and Bandcamp show up
			below; press Enter to search right away.
		</p>
	{:else}
		{#if artists.length || albums.length}
			<section>
				<h2 class="mb-3 text-lg font-bold">In your library</h2>
				<div class="tile-grid">
					{#each artists.slice(0, 6) as artist (artist.id)}
						<Tile href="/artists/{artist.id}" title={artist.name} subtitle="Artist" cover={artist.cover} round />
					{/each}
					{#each albums.slice(0, 12 - Math.min(6, artists.length)) as album (album.id)}
						<Tile
							href="/albums/{album.id}"
							title={album.title}
							subtitle={`Album · ${album.artist}`}
							cover={album.cover}
							onplay={() => void player.playAlbum(album.id)}
						/>
					{/each}
				</div>
			</section>
		{/if}

		{#if songs.length}
			<section>
				<h2 class="mb-2 text-lg font-bold">
					Songs <span class="text-sm font-normal text-muted-foreground">{songs.length === 50 ? '50+' : songs.length}</span>
				</h2>
				<TrackList tracks={songs} />
			</section>
		{/if}

		<section>
			<div class="mb-2 flex items-center gap-3">
				<h2 class="text-lg font-bold">Online</h2>
				{#if searching}
					<LoaderCircle class="size-4 animate-spin text-muted-foreground" />
				{:else if onlineQuery !== clean && clean.length >= 2}
					<button
						class="rounded-full border border-white/10 px-3 py-1 text-xs hover:bg-white/5"
						onclick={() => void searchOnline(clean)}>Search online for “{clean}”</button
					>
				{/if}
				{#if failed.length && !searching}
					<span class="text-xs text-muted-foreground">
						{failed.map((s) => SOURCES[s] ?? s).join(', ')} didn't answer
					</span>
				{/if}
			</div>

			{#if onlineError}
				<p class="py-4 text-sm text-destructive">Online search isn't working right now: {onlineError}</p>
			{:else if online.length === 0}
				{#if searching}
					<div class="space-y-1">
						{#each Array(6) as _, i (i)}
							<div class="h-[52px] animate-pulse rounded-md bg-white/[0.04]"></div>
						{/each}
					</div>
				{:else if onlineQuery === clean}
					<p class="py-4 text-sm text-muted-foreground">Nothing found online.</p>
				{/if}
			{:else}
				<div class="flex flex-col">
					{#each online as r, index (key(r))}
						{@const current = isCurrent(r)}
						{@const pending = busy[key(r)]}
						{@const inLibrary = r.is_saved || savedKeys.has(key(r))}
						{@const downloaded = r.is_downloaded || downloadedKeys.has(key(r))}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="track-row group grid h-[52px] grid-cols-[2.75rem_minmax(0,1fr)_7rem_4rem_6rem] items-center gap-3 rounded-md px-3"
							class:is-current={current}
							ondblclick={() => playOnline(index)}
						>
							<button
								class="flex size-8 items-center justify-center justify-self-center text-muted-foreground hover:text-foreground"
								aria-label={current && player.state.is_playing ? 'Pause' : 'Play'}
								onclick={() => playOnline(index)}
							>
								{#if pending === 'play'}
									<LoaderCircle class="size-4 animate-spin" />
								{:else if current && player.state.is_playing}
									<Pause class="size-4 fill-current text-primary" />
								{:else}
									<Play class="size-4 fill-current" />
								{/if}
							</button>
							<div class="flex min-w-0 items-center gap-3">
								<Cover src={r.cover_art_url} name={r.title} class="size-9 rounded" />
								<div class="min-w-0">
									<p class="track-title truncate text-sm font-medium" title={r.title}>{r.title}</p>
									<p class="truncate text-xs text-muted-foreground">{r.artist}</p>
								</div>
							</div>
							<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
								<SourceIcon source={r.source} size={14} />
								{SOURCES[r.source] ?? r.source}
							</span>
							<span class="text-right text-sm tabular-nums text-muted-foreground">{formatDuration(r.duration_ms)}</span>
							<div class="flex items-center justify-end gap-1">
								<button
									class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-100"
									title={inLibrary ? 'In your library' : 'Add to library'}
									aria-label={inLibrary ? 'In your library' : 'Add to library'}
									disabled={inLibrary || Boolean(pending)}
									onclick={() => save(r)}
								>
									{#if pending === 'save'}
										<LoaderCircle class="size-4 animate-spin" />
									{:else if inLibrary}
										<Check class="size-4 text-primary" />
									{:else}
										<Plus class="size-4" />
									{/if}
								</button>
								<button
									class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-100"
									title={downloaded ? 'Downloaded' : 'Download'}
									aria-label={downloaded ? 'Downloaded' : 'Download'}
									disabled={downloaded || Boolean(pending)}
									onclick={() => download(r)}
								>
									{#if pending === 'download'}
										<LoaderCircle class="size-4 animate-spin" />
									{:else if downloaded}
										<Check class="size-4 text-primary" />
									{:else}
										<Download class="size-4" />
									{/if}
								</button>
							</div>
						</div>
					{/each}
				</div>
				<p class="mt-2 px-3 text-xs text-muted-foreground">{plural(online.length, 'result')}</p>
			{/if}
		</section>
	{/if}
</div>
