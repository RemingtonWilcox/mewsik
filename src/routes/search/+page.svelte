<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import * as api from '$lib/api/tauri';
	import type { ExternalSearchResult } from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { useSearchState, type SearchSource } from '$lib/state/search.svelte';
	import { useTrackMenu } from '$lib/state/track-menu.svelte';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';
	import type { LibraryTrack } from '$lib/types';
	import TrackList from '$lib/components/tracks/track-list.svelte';
	import Tile from '$lib/components/tracks/tile.svelte';
	import Cover from '$lib/components/tracks/cover.svelte';
	import { fold, formatDuration, plural } from '$lib/media';
	import { Search, X, Play, Pause, Plus, Check, Download, LoaderCircle, Ellipsis, ArrowDownToLine } from '@lucide/svelte';

	const library = useLibrary();
	const player = usePlayer();
	const saved = useSearchState();
	const menu = useTrackMenu();
	const phone = new IsMobile();

	const SOURCES: Record<string, string> = {
		youtube: 'YouTube',
		soundcloud: 'SoundCloud'
	};
	const SOURCE_TABS: SearchSource[] = ['soundcloud', 'youtube'];

	let input = $state<HTMLInputElement | null>(null);
	// A ?q= link (from "Heard on radio", say) wins over the last search.
	let query = $state(page.url.searchParams.get('q') || saved.query || '');
	let online = $state<ExternalSearchResult[]>(saved.online);
	let onlineQuery = $state(saved.onlineQuery);
	let searching = $state(false);
	let failed = $state<string[]>([]);
	let onlineError = $state('');
	let busy = $state<Record<string, 'play' | 'save' | 'download'>>({});
	let savedKeys = $state(new Set<string>());
	let downloadedKeys = $state(new Set<string>());
	let request = 0;
	// Pages after the first, per provider, loaded as the list scrolls.
	let nextPage = $state<Record<SearchSource, number>>({ soundcloud: 1, youtube: 1 });
	let exhausted = $state<Record<SearchSource, boolean>>({ soundcloud: false, youtube: false });
	let loadingMore = $state(false);
	let moreSentinel = $state<HTMLDivElement | null>(null);
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

	// Both providers are searched; the switch picks which list shows.
	const shown = $derived(online.filter((r) => r.source === saved.source));
	const counts = $derived({
		soundcloud: online.filter((r) => r.source === 'soundcloud').length,
		youtube: online.filter((r) => r.source === 'youtube').length
	});
	const otherSource = $derived<SearchSource>(saved.source === 'soundcloud' ? 'youtube' : 'soundcloud');

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
		nextPage = { soundcloud: 1, youtube: 1 };
		exhausted = { soundcloud: false, youtube: false };
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

	async function loadMore() {
		const source = saved.source;
		const text = onlineQuery;
		if (loadingMore || searching || exhausted[source] || !text || text !== clean) return;
		loadingMore = true;
		const id = request;
		try {
			const page = await api.searchExternal(text, source, nextPage[source]);
			if (id !== request) return;
			const before = online.length;
			online = merge(online, page.items ?? []);
			nextPage = { ...nextPage, [source]: nextPage[source] + 1 };
			if (!page.has_more || online.length === before) exhausted = { ...exhausted, [source]: true };
			saved.online = online;
		} catch {
			if (id === request) exhausted = { ...exhausted, [source]: true };
		} finally {
			loadingMore = false;
		}
	}

	// Near the bottom of the list, fetch the next page.
	$effect(() => {
		const sentinel = moreSentinel;
		if (!sentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) void loadMore();
			},
			{ rootMargin: '600px 0px' }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

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
		const r = shown[index];
		if (isCurrent(r)) return void player.togglePlay();
		const list = shown;
		void task(r, 'play', async () => {
			// The rest of the results queue up behind it.
			await api.playExternalContext(list, index);
		});
	}

	// The song menu (play next, queue, playlists, download) works on
	// library recordings, so the result gets one first.
	async function openMenu(r: ExternalSearchResult, index: number, x: number, y: number) {
		try {
			const id = await recordingFor(r);
			const track: LibraryTrack = {
				id,
				title: r.title,
				artist_name: r.artist,
				artist_id: '',
				album_title: r.album,
				album_id: null,
				duration_ms: r.duration_ms ?? null,
				cover_art_path: null,
				cover_art_url: r.cover_art_url,
				genre: null,
				year: null,
				source: r.source as LibraryTrack['source'],
				is_downloaded: r.is_downloaded || downloadedKeys.has(key(r)),
				local_file_path: null
			};
			const inLibrary = r.is_saved || savedKeys.has(key(r));
			menu.open({
				x,
				y,
				tracks: [track],
				play: () => playOnline(index),
				extras: inLibrary ? [] : [{ label: 'Add to library', run: () => save(r) }]
			});
		} catch (error) {
			toast.error(`Couldn't open “${r.title}”: ${error}`);
		}
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

<div class="flex flex-col {phone.current ? 'gap-6' : 'gap-8'}">
	<h1 class={phone.current ? '-mb-3 text-[34px] font-bold leading-tight tracking-tight' : '-mb-4 text-3xl font-bold tracking-tight'}>Search</h1>
	<div class="relative max-w-2xl {phone.current ? 'sticky top-0 z-20 -mx-4 bg-background/90 px-4 py-2 backdrop-blur-xl' : ''}">
		<Search class="pointer-events-none absolute top-1/2 size-5 -translate-y-1/2 text-muted-foreground {phone.current ? 'left-7' : 'left-4'}" />
		<input
			bind:this={input}
			bind:value={query}
			data-search-input
			type="search"
			enterkeyhint="search"
			autocomplete="off"
			autocorrect="off"
			spellcheck="false"
			placeholder={phone.current ? 'Artists, songs, albums' : 'Songs, artists, albums — your library and online'}
			class={phone.current
				? 'h-11 w-full rounded-xl bg-white/[0.09] pl-10 pr-10 text-[17px] outline-none placeholder:text-muted-foreground'
				: 'h-12 w-full rounded-full border border-white/10 bg-white/5 pl-12 pr-11 text-base outline-none placeholder:text-muted-foreground focus:border-white/30 focus:bg-white/[0.07]'}
			oninput={typed}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					void searchOnline(clean);
					if (phone.current) input?.blur();
				}
				if (e.key === 'Escape') clear();
			}}
		/>
		{#if query}
			<button
				class="absolute top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground {phone.current ? 'right-7' : 'right-4'}"
				aria-label="Clear search"
				onclick={clear}
			>
				<X class="size-5" />
			</button>
		{/if}
	</div>

	{#if !clean}
		<p class="text-sm text-muted-foreground">
			Type to search your library. Online results from SoundCloud and YouTube show up below;
			press {phone.current ? 'Search' : 'Enter'} to search right away.
		</p>
	{:else}
		{#if artists.length || albums.length}
			<section>
				<h2 class="mb-3 text-lg font-bold">In your library</h2>
				<div class={phone.current ? 'shelf' : 'tile-grid'}>
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
			<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 class="text-lg font-bold">Online</h2>
				{#if searching}
					<LoaderCircle class="size-4 animate-spin text-muted-foreground" />
				{:else if onlineQuery !== clean && clean.length >= 2}
					<button
						class="rounded-full border border-white/10 px-3 py-1 text-xs hover:bg-white/5"
						onclick={() => void searchOnline(clean)}>Search online for “{clean}”</button
					>
				{/if}
				<div class="segmented ml-auto w-full sm:w-64" role="group" aria-label="Online source">
					{#each SOURCE_TABS as source (source)}
						<button aria-pressed={saved.source === source} onclick={() => (saved.source = source)}>
							{SOURCES[source]}
							{#if onlineQuery === clean && counts[source]}
								<span class="ml-0.5 text-xs text-muted-foreground tabular-nums">{counts[source]}</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			{#if onlineError}
				<p class="py-4 text-sm text-destructive">Online search isn't working right now: {onlineError}</p>
			{:else if shown.length === 0}
				{#if searching}
					<div class="space-y-2">
						{#each Array(6) as _, i (i)}
							<div class="flex items-center gap-3 px-1">
								<div class="size-12 shrink-0 animate-pulse rounded-md bg-white/[0.06]"></div>
								<div class="flex-1 space-y-2">
									<div class="h-3.5 w-3/5 animate-pulse rounded bg-white/[0.06]"></div>
									<div class="h-3 w-2/5 animate-pulse rounded bg-white/[0.04]"></div>
								</div>
							</div>
						{/each}
					</div>
				{:else if onlineQuery === clean}
					<div class="py-6 text-center text-sm text-muted-foreground">
						{#if failed.includes(saved.source)}
							<p>{SOURCES[saved.source]} didn't answer.</p>
						{:else}
							<p>Nothing on {SOURCES[saved.source]} for “{clean}”.</p>
						{/if}
						{#if counts[otherSource]}
							<button
								class="mt-3 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-medium text-foreground"
								onclick={() => (saved.source = otherSource)}
								>Show {counts[otherSource]} on {SOURCES[otherSource]}</button
							>
						{/if}
					</div>
				{/if}
			{:else}
				{#if failed.includes(otherSource) && !searching}
					<p class="mb-2 text-xs text-muted-foreground">{SOURCES[otherSource]} didn't answer.</p>
				{/if}
				<div class="flex flex-col" data-online-results>
					{#each shown as r, index (key(r))}
						{@const current = isCurrent(r)}
						{@const pending = busy[key(r)]}
						{@const inLibrary = r.is_saved || savedKeys.has(key(r))}
						{@const downloaded = r.is_downloaded || downloadedKeys.has(key(r))}
						{#if phone.current}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								role="button"
								tabindex="0"
								class="track-row -mx-2 flex h-16 items-center gap-3 rounded-lg px-2"
								class:is-current={current}
								onclick={() => playOnline(index)}
							>
								<div class="relative size-12 shrink-0">
									<Cover src={r.cover_art_url} name={r.title} class="size-12 rounded-md" />
									{#if pending === 'play' || current}
										<span class="absolute inset-0 flex items-center justify-center rounded-md bg-black/45" aria-hidden="true">
											{#if pending === 'play'}
												<LoaderCircle class="size-5 animate-spin text-white" />
											{:else if player.state.is_playing}
												<span class="eq"><i></i><i></i><i></i></span>
											{:else}
												<Play class="size-4 fill-current text-white" />
											{/if}
										</span>
									{/if}
								</div>
								<div class="min-w-0 flex-1">
									<p class="track-title truncate text-[16px] leading-snug">{r.title}</p>
									<p class="flex items-center gap-1 text-[14px] leading-snug text-muted-foreground">
										{#if downloaded}<ArrowDownToLine class="size-3.5 shrink-0 text-primary" aria-label="Downloaded" />{/if}
										<span class="truncate">{r.artist}</span>
										{#if r.duration_ms}<span class="shrink-0">· {formatDuration(r.duration_ms)}</span>{/if}
									</p>
								</div>
								{#if inLibrary}
									<Check class="size-4 shrink-0 text-primary" aria-label="In your library" />
								{/if}
								<button
									class="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-white/10"
									aria-label="More"
									onclick={(e) => {
										e.stopPropagation();
										void openMenu(r, index, 0, 0);
									}}
								>
									{#if pending === 'save' || pending === 'download'}
										<LoaderCircle class="size-5 animate-spin" />
									{:else}
										<Ellipsis class="size-5" />
									{/if}
								</button>
							</div>
						{:else}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="track-row group grid h-[52px] grid-cols-[2.75rem_minmax(0,1fr)_4rem_6rem] items-center gap-3 rounded-md px-3"
								class:is-current={current}
								ondblclick={() => playOnline(index)}
								oncontextmenu={(e) => {
									e.preventDefault();
									void openMenu(r, index, e.clientX, e.clientY);
								}}
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
						{/if}
					{/each}
				</div>
				<div bind:this={moreSentinel} class="flex h-14 items-center justify-center text-xs text-muted-foreground">
					{#if loadingMore}
						<LoaderCircle class="size-5 animate-spin" />
					{:else if exhausted[saved.source]}
						{plural(shown.length, 'result')}
					{/if}
				</div>
			{/if}
		</section>
	{/if}
</div>
