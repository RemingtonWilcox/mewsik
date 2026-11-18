<script lang="ts">
	// Stations on the phone, built for anyone who opens it (no history
	// needed): a featured hand-picked station, genres to browse, a few
	// shelves, one search box, and saved stations as a plain list.
	import { onMount, tick } from 'svelte';
	import * as api from '$lib/api/tauri';
	import type {
		RadioBrowserStation,
		SceneInfo,
		StationDiscoveryFeed,
		StationPick,
		StationShelf
	} from '$lib/api/tauri';
	import type { Station } from '$lib/types';
	import StationArt from '$lib/components/station-art.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import { curatedCollections, curatedStations } from '$lib/radio/curated';
	import { SCENE_CATALOG } from '$lib/radio/scenes';
	import { genreTagsFor } from '$lib/radio/genres';
	import { cleanStationName } from '$lib/radio/names';
	import { sortRadioStations } from '$lib/radio/signals';
	import { genreTags, isMusicStation, shortCountry } from '$lib/radio/display';
	import { toast } from 'svelte-sonner';
	import {
		ChevronLeft,
		ChevronRight,
		Heart,
		LoaderCircle,
		Play,
		Radio,
		RefreshCw,
		Search,
		Square,
		X
	} from '@lucide/svelte';

	const player = usePlayer();

	type View = 'discover' | 'favorites';
	type FavoriteSort = 'recent' | 'name';
	const VIEW_KEY = 'mewsik.stations.view';
	const SORT_KEY = 'mewsik.stations.favoriteSort';

	function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
		try {
			const value = localStorage.getItem(key);
			return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
		} catch {
			return fallback;
		}
	}
	function store(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// private mode; the choice just isn't remembered
		}
	}

	let view = $state<View>(readStored(VIEW_KEY, ['discover', 'favorites'] as const, 'discover'));
	let favoriteSort = $state<FavoriteSort>(
		readStored(SORT_KEY, ['recent', 'name'] as const, 'recent')
	);
	$effect(() => store(VIEW_KEY, view));
	$effect(() => store(SORT_KEY, favoriteSort));

	// ---- data ----
	let feed = $state<StationDiscoveryFeed>({
		generatedAt: '',
		status: 'empty',
		cacheAgeSeconds: null,
		shelves: [],
		scenes: []
	});
	let feedLoading = $state(true);
	let favorites = $state<Station[]>([]);
	let popular = $state<RadioBrowserStation[]>([]);
	let deadKeys = $state<Set<string>>(new Set());
	// Saved-station ids for stations started from a pick, so the row knows
	// it's the one playing.
	let playedIds = $state<Record<string, string>>({});

	const scenes = $derived<SceneInfo[]>(feed.scenes.length > 0 ? feed.scenes : SCENE_CATALOG);
	const sceneById = $derived(new Map(scenes.map((scene) => [scene.id, scene] as const)));

	function key(station: RadioBrowserStation): string {
		return (station.stationuuid || station.url).toLowerCase();
	}
	function alive(pick: StationPick): boolean {
		return !deadKeys.has(key(pick.station));
	}
	function shelfOf(kind: StationShelf['kind']): StationPick[] {
		return feed.shelves.find((shelf) => shelf.kind === kind)?.items.filter(alive) ?? [];
	}
	const forYou = $derived(shelfOf('for_you'));
	const fresh = $derived(shelfOf('fresh'));

	// One hand-picked station a day, the same for everyone.
	const featured = $derived.by(() => {
		const day = Math.floor(Date.now() / 86_400_000);
		const live = curatedStations.filter((station) => !deadKeys.has(key(station)));
		return live[day % Math.max(1, live.length)] ?? curatedStations[0];
	});
	const featuredCollection = $derived(
		curatedCollections.find((collection) =>
			collection.stations.some((station) => station.stationuuid === featured.stationuuid)
		)
	);
	let pickedCollectionId = $state(curatedCollections[0]?.id);
	const pickedCollection = $derived(
		curatedCollections.find((collection) => collection.id === pickedCollectionId) ??
			curatedCollections[0]
	);

	let showAllGenres = $state(false);
	const GENRE_PREVIEW = 8;
	const genreTiles = $derived(showAllGenres ? scenes : scenes.slice(0, GENRE_PREVIEW));

	onMount(() => {
		void loadFeed();
		void loadFavorites();
		void loadPopular();
	});

	async function loadFeed() {
		try {
			feed = await api.getStationDiscovery();
		} catch {
			// shelves just stay empty; genres and hand-picked still work
		} finally {
			feedLoading = false;
		}
	}

	async function loadFavorites() {
		try {
			favorites = await api.getFavoriteStations();
		} catch {
			favorites = [];
		}
	}

	async function loadPopular() {
		try {
			const page = await api.browseRadioStations('smart', 0, 80);
			popular = page.items.filter(isMusicStation).slice(0, 24);
		} catch {
			popular = [];
		}
	}

	const sortedFavorites = $derived.by(() => {
		const list = [...favorites];
		if (favoriteSort === 'name') {
			return list.sort((a, b) =>
				cleanStationName(a.name).localeCompare(cleanStationName(b.name), undefined, {
					sensitivity: 'base'
				})
			);
		}
		// Most recently played first; never-played ones after, newest saved first.
		return list.sort((a, b) => {
			const pa = a.last_played_at ?? '';
			const pb = b.last_played_at ?? '';
			if (pa !== pb) return pb.localeCompare(pa);
			return (b.created_at ?? '').localeCompare(a.created_at ?? '');
		});
	});

	// ---- saving ----
	function savedFor(station: RadioBrowserStation): Station | undefined {
		const uuid = station.stationuuid?.toLowerCase();
		return favorites.find(
			(fav) =>
				fav.url === station.url || (uuid && fav.radio_browser_id?.toLowerCase() === uuid)
		);
	}

	let saving = $state<Set<string>>(new Set());

	async function toggleSave(station: RadioBrowserStation) {
		const existing = savedFor(station);
		if (existing) {
			await unsave(existing);
			return;
		}
		const k = key(station);
		if (saving.has(k)) return;
		saving = new Set([...saving, k]);
		try {
			await api.saveStation(
				station.name,
				station.url,
				station.homepage ?? undefined,
				station.country ?? undefined,
				station.language ?? undefined,
				station.tags ?? undefined,
				station.codec ?? undefined,
				station.bitrate ?? undefined,
				station.stationuuid
			);
			await loadFavorites();
			toast.success(`Saved ${cleanStationName(station.name)}`);
		} catch {
			toast.error('Couldn’t save that station');
		} finally {
			saving = new Set([...saving].filter((item) => item !== k));
		}
	}

	async function unsave(station: Station) {
		try {
			await api.toggleStationFavorite(station.id);
			await loadFavorites();
			toast(`Removed ${cleanStationName(station.name)}`, {
				action: {
					label: 'Undo',
					onClick: async () => {
						await api.toggleStationFavorite(station.id);
						await loadFavorites();
					}
				}
			});
		} catch {
			toast.error('Couldn’t remove that station');
		}
	}

	// ---- playing ----
	function activeId(stationId: string | null | undefined): boolean {
		return (
			!!stationId &&
			player.state.source === 'radio' &&
			player.state.current_station_id === stationId &&
			(player.state.is_playing || player.state.is_buffering)
		);
	}
	function pickIsActive(station: RadioBrowserStation): boolean {
		return activeId(playedIds[station.url] ?? savedFor(station)?.id);
	}

	let playRequest = 0;

	async function playPick(station: RadioBrowserStation) {
		const request = ++playRequest;
		if (pickIsActive(station)) {
			await player.stop().catch(() => {});
			return;
		}
		try {
			const id = await player.playStation(
				{ name: cleanStationName(station.name), url: station.url },
				() => api.playStationSearchResult(station)
			);
			playedIds = { ...playedIds, [station.url]: id };
		} catch (error) {
			if (api.isStationUnavailableError(error)) {
				deadKeys = new Set([...deadKeys, key(station)]);
				if (request === playRequest) toast.error(`${cleanStationName(station.name)} is off the air`);
				return;
			}
			if (request === playRequest && !String(error).includes('superseded')) {
				toast.error(`Couldn’t play ${cleanStationName(station.name)}`);
			}
		}
	}

	async function playFavorite(station: Station) {
		const request = ++playRequest;
		if (activeId(station.id)) {
			await player.stop().catch(() => {});
			return;
		}
		try {
			await player.playStation(
				{ id: station.id, name: cleanStationName(station.name), url: station.url },
				() => api.playStation(station.id, station.url, station.name)
			);
		} catch (error) {
			if (request === playRequest && !String(error).includes('superseded')) {
				toast.error(`Couldn’t play ${cleanStationName(station.name)}`);
			}
		}
	}

	// ---- checking saved stations ----
	let checking = $state(false);
	let checkSummary = $state('');

	async function checkFavorites() {
		if (checking) return;
		checking = true;
		try {
			const results = await api.verifyFavoriteStations();
			await loadFavorites();
			const dead = results.filter((r) => r.status === 'dead').length;
			const stale = results.filter((r) => r.status === 'stale').length;
			const repaired = results.filter((r) => r.repaired).length;
			const parts = [`${results.length - dead - stale} playing`];
			if (repaired) parts.push(`${repaired} fixed`);
			if (stale) parts.push(`${stale} shaky`);
			if (dead) parts.push(`${dead} off the air`);
			checkSummary = parts.join(' · ');
		} catch {
			checkSummary = 'The check didn’t finish';
		} finally {
			checking = false;
		}
	}

	// ---- one genre ----
	let openScene = $state<SceneInfo | null>(null);
	let sceneItems = $state<StationPick[]>([]);
	let sceneLoading = $state(false);
	let sceneDone = $state(false);
	let sceneSentinel = $state<HTMLDivElement | null>(null);
	const SCENE_PAGE = 40;

	async function showScene(scene: SceneInfo) {
		openScene = scene;
		sceneItems = [];
		sceneDone = false;
		await tick();
		document.querySelector('[data-scroll-root]')?.scrollTo({ top: 0 });
		await loadSceneMore();
	}

	async function loadSceneMore() {
		const scene = openScene;
		if (!scene || sceneLoading || sceneDone) return;
		sceneLoading = true;
		try {
			const page = await api.getSceneStations(scene.id, SCENE_PAGE, sceneItems.length);
			if (openScene?.id !== scene.id) return;
			const seen = new Set(sceneItems.map((pick) => key(pick.station)));
			sceneItems = [...sceneItems, ...page.filter((pick) => !seen.has(key(pick.station)))];
			if (page.length < SCENE_PAGE) sceneDone = true;
		} catch {
			sceneDone = true;
		} finally {
			sceneLoading = false;
		}
	}

	function closeScene() {
		openScene = null;
		sceneItems = [];
	}

	$effect(() => {
		const sentinel = sceneSentinel;
		if (!sentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) void loadSceneMore();
			},
			{ rootMargin: '600px' }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	// ---- search ----
	let query = $state('');
	let results = $state<RadioBrowserStation[]>([]);
	let searching = $state(false);
	let searchFailed = $state(false);
	let searchRequest = 0;
	const searchText = $derived(query.trim());
	const isSearching = $derived(searchText.length > 0);

	$effect(() => {
		const text = searchText;
		const request = ++searchRequest;
		if (text.length < 2) {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(async () => {
			try {
				const genre = genreTagsFor(text);
				const groups = await Promise.all([
					api.searchRadioStations(text, 'name', 'smart'),
					genre
						? api.searchRadioStationsByTags(genre, 'smart')
						: api.searchRadioStations(text, 'tag', 'smart')
				]);
				if (request !== searchRequest) return;
				const merged = new Map(groups.flat().map((station) => [key(station), station]));
				results = sortRadioStations([...merged.values()], 'smart');
				searchFailed = false;
			} catch {
				if (request === searchRequest) {
					results = [];
					searchFailed = true;
				}
			} finally {
				if (request === searchRequest) searching = false;
			}
		}, 300);
		return () => clearTimeout(timer);
	});

	// ---- labels ----
	function pickLine(station: RadioBrowserStation, sceneId?: string | null): string {
		const genre = sceneId ? sceneById.get(sceneId)?.title : genreTags(station.tags, 2).join(', ');
		return [genre, shortCountry(station.country, station.countrycode)].filter(Boolean).join(' · ');
	}
	function favoriteLine(station: Station): string {
		if (station.fail_count >= 3) return 'Hasn’t connected lately';
		return [genreTags(station.tags, 2).join(', '), shortCountry(station.country)]
			.filter(Boolean)
			.join(' · ');
	}
</script>

{#snippet stationRow(
	station: RadioBrowserStation,
	line: string,
	active: boolean,
	saved: boolean,
	onplay: () => void,
	onsave: () => void,
	dim = false,
	logo: api.StationLogoKey | null = null
)}
	{@const name = cleanStationName(station.name)}
	<div class="station-row flex h-16 min-w-0 items-center gap-3" class:opacity-50={dim} data-station-row>
		<button
			class="flex min-w-0 flex-1 items-center gap-3 text-left"
			onclick={onplay}
			aria-label={active ? `Stop ${name}` : `Play ${name}`}
		>
			<span class="relative shrink-0">
				<StationArt {name} identity={station.stationuuid || station.url} logo={logo ?? api.stationLogoKeyForPick(station)} class="size-12 rounded-lg" monogramClass="text-sm" />
				{#if active}
					<span class="absolute inset-0 flex items-center justify-center rounded-lg bg-black/55 text-primary">
						{#if player.state.is_buffering}
							<LoaderCircle class="size-5 animate-spin" />
						{:else}
							<Square class="size-4 fill-current" />
						{/if}
					</span>
				{/if}
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-[15px] font-medium" class:text-primary={active}>{name}</span>
				{#if line}<span class="block truncate text-[13px] text-muted-foreground">{line}</span>{/if}
			</span>
		</button>
		<button
			class="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground"
			class:text-primary={saved}
			onclick={onsave}
			aria-label={saved ? `Remove ${name} from saved stations` : `Save ${name}`}
			aria-pressed={saved}
		>
			<Heart class="size-5 {saved ? 'fill-current' : ''}" />
		</button>
	</div>
{/snippet}

{#snippet pickRow(pick: StationPick, showScene = true)}
	{@const station = pick.station}
	{@render stationRow(
		station,
		pickLine(station, showScene ? pick.sceneId : null),
		pickIsActive(station),
		!!savedFor(station),
		() => playPick(station),
		() => toggleSave(station)
	)}
{/snippet}

{#snippet directoryRow(station: RadioBrowserStation)}
	{@render stationRow(
		station,
		pickLine(station),
		pickIsActive(station),
		!!savedFor(station),
		() => playPick(station),
		() => toggleSave(station)
	)}
{/snippet}

{#snippet shelf(title: string, note: string, picks: StationPick[])}
	{#if picks.length > 0}
		<section>
			<h2 class="text-[22px] font-bold tracking-tight">{title}</h2>
			{#if note}<p class="text-[13px] text-muted-foreground">{note}</p>{/if}
			<div class="row-pages mt-2" data-rail>
				{#each picks.slice(0, 12) as pick (key(pick.station))}
					{@render pickRow(pick)}
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

<div class="flex flex-col gap-5 pb-4" data-mobile-stations>
	{#if openScene}
		<!-- one genre -->
		<div class="flex flex-col gap-4">
			<button class="-ml-1 flex w-fit items-center gap-0.5 text-[17px] text-primary" onclick={closeScene}>
				<ChevronLeft class="size-6" /> Stations
			</button>
			<div class="relative overflow-hidden rounded-2xl bg-white/[0.06] p-5">
				<div class="pointer-events-none absolute inset-0 bg-gradient-to-br {openScene.accent}"></div>
				<p class="relative text-[13px] font-medium text-muted-foreground">{openScene.eyebrow}</p>
				<h1 class="relative text-[30px] font-bold leading-tight tracking-tight">{openScene.title}</h1>
				<p class="relative mt-1 text-[15px] text-foreground/75">{openScene.description}</p>
			</div>
			<div class="rows flex flex-col">
				{#each sceneItems.filter(alive) as pick (key(pick.station))}
					{@render pickRow(pick, false)}
				{/each}
			</div>
			{#if sceneLoading}
				<div class="flex justify-center py-4"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
			{:else if sceneDone && sceneItems.length === 0}
				<p class="py-6 text-center text-[15px] text-muted-foreground">No stations for {openScene.title} yet. Try again in a bit.</p>
			{/if}
			{#if !sceneDone}<div bind:this={sceneSentinel} class="h-px"></div>{/if}
		</div>
	{:else}
		<h1 class="text-[34px] font-bold leading-tight tracking-tight">Stations</h1>

		<div class="relative">
			<Search class="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />
			<input
				type="search"
				bind:value={query}
				placeholder="Stations, genres, cities"
				aria-label="Search stations"
				enterkeyhint="search"
				autocomplete="off"
				class="h-10 w-full rounded-xl bg-white/[0.08] pl-10 pr-10 text-[16px] outline-none placeholder:text-muted-foreground"
			/>
			{#if query}
				<button
					class="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center text-muted-foreground"
					onclick={() => (query = '')}
					aria-label="Clear search"
				>
					<X class="size-4" />
				</button>
			{/if}
		</div>

		{#if isSearching}
			<!-- search results -->
			<div class="rows flex flex-col">
				{#if searchText.length < 2}
					<p class="py-6 text-center text-[15px] text-muted-foreground">Keep typing…</p>
				{:else if searching && results.length === 0}
					<div class="flex justify-center py-6"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
				{:else if searchFailed}
					<p class="py-6 text-center text-[15px] text-muted-foreground">Search isn’t reachable right now.</p>
				{:else if results.length === 0}
					<p class="py-6 text-center text-[15px] text-muted-foreground">No stations match “{searchText}”.</p>
				{:else}
					{#each results.filter((station) => !deadKeys.has(key(station))) as station (key(station))}
						{@render directoryRow(station)}
					{/each}
				{/if}
			</div>
		{:else}
			<div class="segmented" role="group" aria-label="Station view">
				<button aria-pressed={view === 'discover'} onclick={() => (view = 'discover')}>Discover</button>
				<button aria-pressed={view === 'favorites'} onclick={() => (view = 'favorites')}>
					Saved{#if favorites.length > 0}<span class="ml-1 text-muted-foreground tabular-nums">{favorites.length}</span>{/if}
				</button>
			</div>

			{#if view === 'discover'}
				<!-- featured: one hand-picked station a day -->
				{@const featuredName = cleanStationName(featured.name)}
				{@const featuredActive = pickIsActive(featured)}
				<section class="relative overflow-hidden rounded-2xl bg-white/[0.06] p-4" aria-label="Featured station">
					<div class="pointer-events-none absolute inset-0 bg-gradient-to-br {featuredCollection?.accent ?? 'from-primary/25 via-primary/5 to-transparent'}"></div>
					<p class="relative text-[12px] font-semibold uppercase tracking-wide text-primary">Today’s pick</p>
					<div class="relative mt-2 flex items-center gap-3">
						<StationArt name={featuredName} identity={featured.stationuuid} logo={api.stationLogoKeyForPick(featured)} class="size-16 rounded-xl" monogramClass="text-lg" />
						<div class="min-w-0">
							<h2 class="truncate text-[22px] font-bold leading-tight tracking-tight">{featuredName}</h2>
							<p class="truncate text-[13px] text-muted-foreground">{pickLine(featured)}</p>
						</div>
					</div>
					<p class="relative mt-3 line-clamp-3 text-[15px] leading-snug text-foreground/80">{featured.editorial}</p>
					<div class="relative mt-4 flex gap-2">
						<button class="press flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary font-semibold text-primary-foreground" onclick={() => playPick(featured)}>
							{#if featuredActive}
								{#if player.state.is_buffering}<LoaderCircle class="size-4 animate-spin" />{:else}<Square class="size-4 fill-current" />{/if}
								Stop
							{:else}
								<Play class="size-4 fill-current" /> Play
							{/if}
						</button>
						<button
							class="press flex size-11 items-center justify-center rounded-xl bg-white/[0.1]"
							class:text-primary={!!savedFor(featured)}
							onclick={() => toggleSave(featured)}
							aria-label={savedFor(featured) ? `Remove ${featuredName} from saved stations` : `Save ${featuredName}`}
							aria-pressed={!!savedFor(featured)}
						>
							<Heart class="size-5 {savedFor(featured) ? 'fill-current' : ''}" />
						</button>
					</div>
				</section>

				<!-- genres -->
				<section aria-labelledby="genres-heading">
					<h2 id="genres-heading" class="text-[22px] font-bold tracking-tight">Genres</h2>
					<div class="mt-2 grid grid-cols-2 gap-2">
						{#each genreTiles as scene (scene.id)}
							<button
								class="press relative h-[72px] overflow-hidden rounded-xl bg-white/[0.07] px-3 text-left"
								onclick={() => showScene(scene)}
							>
								<span class="pointer-events-none absolute inset-0 bg-gradient-to-br {scene.accent}"></span>
								<span class="relative block truncate text-[16px] font-semibold">{scene.title}</span>
								<span class="relative block truncate text-[12px] text-foreground/60">{scene.eyebrow}</span>
							</button>
						{/each}
					</div>
					{#if scenes.length > GENRE_PREVIEW}
						<button class="mt-2 w-full py-2 text-[15px] text-primary" onclick={() => (showAllGenres = !showAllGenres)}>
							{showAllGenres ? 'Show fewer' : `All ${scenes.length} genres`}
						</button>
					{/if}
				</section>

				{#if feedLoading}
					<div class="flex justify-center py-4"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
				{/if}

				{@render shelf('For you', 'From what you’ve been listening to', forYou)}
				{@render shelf('New today', 'A fresh handful from every genre, changing daily', fresh)}

				{#if popular.length > 0}
					<section>
						<h2 class="text-[22px] font-bold tracking-tight">Popular right now</h2>
						<p class="text-[13px] text-muted-foreground">Most played music stations worldwide today</p>
						<div class="row-pages mt-2" data-rail>
							{#each popular.filter((station) => !deadKeys.has(key(station))) as station (key(station))}
								{@render directoryRow(station)}
							{/each}
						</div>
					</section>
				{/if}

				<!-- hand-picked collections -->
				<section aria-labelledby="handpicked-heading">
					<h2 id="handpicked-heading" class="text-[22px] font-bold tracking-tight">Hand-picked</h2>
					<p class="text-[13px] text-muted-foreground">Stations we checked by ear, grouped by mood</p>
					<div class="chip-rail mt-3" data-rail>
						{#each curatedCollections as collection (collection.id)}
							<button
								class="shrink-0 rounded-full px-3.5 py-1.5 text-[14px] font-medium {pickedCollectionId === collection.id ? 'bg-foreground text-background' : 'bg-white/[0.08] text-foreground/85'}"
								onclick={() => (pickedCollectionId = collection.id)}
								aria-pressed={pickedCollectionId === collection.id}
							>
								{collection.title}
							</button>
						{/each}
					</div>
					{#if pickedCollection}
						<p class="mt-3 text-[13px] text-muted-foreground">{pickedCollection.description}</p>
						<div class="rows mt-1 flex flex-col">
							{#each pickedCollection.stations.filter((station) => !deadKeys.has(key(station))) as station (key(station))}
								{@render directoryRow(station)}
							{/each}
						</div>
					{/if}
				</section>
			{:else}
				<!-- saved stations -->
				{#if favorites.length === 0}
					<div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
						<div class="flex size-14 items-center justify-center rounded-full bg-white/[0.08] text-muted-foreground">
							<Radio class="size-6" />
						</div>
						<h2 class="text-[20px] font-semibold">No saved stations yet</h2>
						<p class="text-[15px] text-muted-foreground">Tap the heart on any station and it will be here.</p>
						<button class="mt-1 text-[16px] text-primary" onclick={() => (view = 'discover')}>Find stations</button>
					</div>
				{:else}
					<div class="flex items-center justify-between">
						<p class="text-[13px] text-muted-foreground">{favorites.length} saved</p>
						<div class="segmented w-44" role="group" aria-label="Sort saved stations">
							<button aria-pressed={favoriteSort === 'recent'} onclick={() => (favoriteSort = 'recent')}>Recent</button>
							<button aria-pressed={favoriteSort === 'name'} onclick={() => (favoriteSort = 'name')}>A–Z</button>
						</div>
					</div>
					<div class="rows flex flex-col">
						{#each sortedFavorites as station (station.id)}
							{@const asDirectory = {
								name: station.name,
								url: station.url,
								homepage: station.homepage,
								favicon: null,
								country: station.country,
								language: station.language,
								tags: station.tags,
								codec: station.codec,
								bitrate: station.bitrate,
								stationuuid: station.radio_browser_id ?? station.id
							}}
							{@render stationRow(
								asDirectory,
								favoriteLine(station),
								activeId(station.id),
								true,
								() => playFavorite(station),
								() => unsave(station),
								station.fail_count >= 3,
								api.stationLogoKeyForSaved(station)
							)}
						{/each}
					</div>
					<div class="ios-group mt-2">
						<button class="ios-row" onclick={checkFavorites} disabled={checking}>
							{#if checking}
								<LoaderCircle class="size-5 animate-spin text-primary" />
							{:else}
								<RefreshCw class="size-5 text-primary" />
							{/if}
							<span class="flex-1">{checking ? 'Checking…' : 'Check they still play'}</span>
							{#if checkSummary && !checking}<span class="truncate text-[13px] text-muted-foreground">{checkSummary}</span>{/if}
							<ChevronRight class="size-4 text-muted-foreground" />
						</button>
					</div>
					<p class="ios-footnote">Stations that moved get fixed automatically when possible.</p>
				{/if}
			{/if}
		{/if}
	{/if}
</div>

<style>
	/* Rows of stations, three to a column, that swipe sideways a page at a
	   time (like Apple Music's shelves). */
	.row-pages {
		display: grid;
		grid-auto-flow: column;
		grid-template-rows: repeat(3, auto);
		grid-auto-columns: 88%;
		column-gap: 1rem;
		overflow-x: auto;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: 1rem;
		margin: 0 -1rem;
		padding: 0 1rem;
		scrollbar-width: none;
	}
	.row-pages::-webkit-scrollbar,
	.chip-rail::-webkit-scrollbar {
		display: none;
	}
	.row-pages > :global(*) {
		scroll-snap-align: start;
	}
	.chip-rail {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		margin: 0 -1rem;
		padding: 0 1rem;
		scrollbar-width: none;
	}
	.rows > .station-row + .station-row {
		border-top: 0.5px solid oklch(1 0 0 / 0.08);
	}
</style>
