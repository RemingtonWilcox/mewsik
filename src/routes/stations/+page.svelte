<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import StationMetrics from '$lib/components/stations/station-metrics.svelte';
	import * as api from '$lib/api/tauri';
	import type { RadioBrowserStation, RadioStationSort } from '$lib/api/tauri';
	import type { Station, StationHealthResult } from '$lib/types';
	import {
		curatedCollections,
		curatedStations,
		type CuratedCollection,
		type CuratedStation
	} from '$lib/radio/curated';
	import {
		DIRECTORY_SORT_OPTIONS,
		sortRadioStations
	} from '$lib/radio/signals';
	import { usePlayer } from '$lib/state/player.svelte';
	import { toast } from 'svelte-sonner';
	import {
		ArrowRight,
		Check,
		Globe,
		Guitar,
		Headphones,
		Heart,
		HeartOff,
		Info,
		LoaderCircle,
		MoonStar,
		Play,
		Radio,
		RefreshCw,
		Search,
		Signal,
		Sparkles,
		Square,
		Waves,
		X
	} from '@lucide/svelte';

	const player = usePlayer();

	const genres = [
		'DnB', 'Hip Hop', 'Techno', 'House', 'Jazz', 'Lo-fi',
		'Ambient', 'Classical', 'Rock', 'Metal', 'Reggae', 'Soul',
		'R&B', 'Pop', 'Trance', 'Chillout', 'Latin', 'Blues',
		'News', 'Talk Radio', 'Sports'
	];

	let query = $state('');
	let searchMode = $state<'name' | 'tag'>('name');
	let results = $state<RadioBrowserStation[]>([]);
	let favorites = $state<Station[]>([]);
	let savedStationIds = $state<Set<string>>(new Set());
	let searchStationIds = $state<Record<string, string>>({});
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout>;
	let favoritesError = $state('');
	let searchError = $state('');
	let searchRequest = 0;
	let stationHealthRequest = 0;
	let stationPlayRequest = 0;
	let verifyingStations = $state(false);
	let searchHealthByUrl = $state<Record<string, StationHealthResult['status']>>({});
	let curatedHealthByUrl = $state<Record<string, StationHealthResult['status']>>({});
	let selectedCollectionId = $state<CuratedCollection['id']>('night-drive');
	let stationView = $state<'discover' | 'favorites' | 'directory'>('discover');
	let curatedHealthRequest = 0;
	let directorySort = $state<RadioStationSort>('smart');
	let resultContext = $state<'browse' | 'search'>('browse');
	let loadingMore = $state(false);
	let directoryHasMore = $state(true);
	let directoryNextOffset = $state(0);
	let directoryStatsById = $state<Record<string, RadioBrowserStation>>({});
	let scanSummary = $state('');
	type DisplayStationHealth = 'unknown' | 'ok' | 'stale' | 'dead';
	const radioBrowserUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const MAX_LOCAL_DIRECTORY_PROBES = 12;

	const selectedCollection = $derived(
		curatedCollections.find((collection) => collection.id === selectedCollectionId) ??
			curatedCollections[0]
	);
	const selectedDirectorySort = $derived(
		DIRECTORY_SORT_OPTIONS.find((option) => option.value === directorySort) ??
			DIRECTORY_SORT_OPTIONS[0]
	);
	const displayedResults = $derived(results);

	$effect(() => {
		void loadFavorites();
	});

	$effect(() => {
		if (stationView !== 'discover') return;
		void verifyCuratedPicks(selectedCollection.stations);
	});

	function mergeDirectoryStats(stations: RadioBrowserStation[]) {
		const updates = Object.fromEntries(
			stations
				.filter((station) => radioBrowserUuidPattern.test(station.stationuuid))
				.map((station) => [station.stationuuid.toLowerCase(), station] as const)
		);
		if (Object.keys(updates).length > 0) {
			directoryStatsById = { ...directoryStatsById, ...updates };
		}
	}

	function knownDirectoryIds(extraIds: string[] = []): string[] {
		const candidates = [
			...extraIds,
			...results.map((station) => station.stationuuid)
		]
			.filter((id) => radioBrowserUuidPattern.test(id))
			.map((id) => id.toLowerCase());
		return [...new Set(candidates)].slice(0, 100);
	}

	async function refreshKnownStationDetails(extraIds: string[] = []): Promise<RadioBrowserStation[]> {
		const ids = knownDirectoryIds(extraIds);
		if (ids.length === 0) return [];
		try {
			const details = await api.getRadioStationDetails(ids);
			mergeDirectoryStats(details);
			return details;
		} catch {
			// Directory metrics are helpful context, not a reason to hide stations.
			return [];
		}
	}

	function stationDirectorySnapshot(station: RadioBrowserStation): RadioBrowserStation {
		return directoryStatsById[station.stationuuid.toLowerCase()] ?? station;
	}

	async function loadFavorites() {
		try {
			favorites = await api.getFavoriteStations();
			savedStationIds = new Set();
			searchStationIds = {
				...searchStationIds,
				...Object.fromEntries(
					favorites.flatMap((station) => {
						const keys = [station.url, station.radio_browser_id].filter(
							(key): key is string => Boolean(key)
						);
						return keys.map((key) => [key, station.id] as const);
					})
				)
			};
			favoritesError = '';
		} catch (error) {
			favorites = [];
			favoritesError = `Favorites are unavailable${error ? `: ${error}` : ''}`;
		}
	}

	async function verifyCuratedPicks(stations: CuratedStation[]) {
		const requestId = ++curatedHealthRequest;
		try {
			const verified = await api.verifyStationUrls(stations.map((station) => station.url));
			if (requestId !== curatedHealthRequest) return;
			curatedHealthByUrl = {
				...curatedHealthByUrl,
				...Object.fromEntries(verified.map((result) => [result.url, result.status] as const))
			};
		} catch {
			// Picks remain available if the advisory health pass cannot run.
		}
	}

	$effect(() => {
		const view = stationView;
		const trimmedQuery = query.trim();
		const mode = searchMode;
		const sort = directorySort;
		clearTimeout(debounceTimer);

		if (view !== 'directory') {
			searching = false;
			return () => clearTimeout(debounceTimer);
		}

		searchError = '';
		const requestId = ++searchRequest;
		stationHealthRequest += 1;
		if (trimmedQuery.length > 1) {
			searchError = '';
			debounceTimer = setTimeout(
				() => void searchStations(trimmedQuery, requestId, mode, sort),
				300
			);
		} else if (trimmedQuery.length === 0) {
			debounceTimer = setTimeout(() => void browseStations(requestId, sort), 50);
		} else {
			results = [];
			searchHealthByUrl = {};
			searching = false;
		}

		return () => clearTimeout(debounceTimer);
	});

	async function searchStations(
		searchQuery = query.trim(),
		requestId = ++searchRequest,
		mode: 'name' | 'tag' = searchMode,
		sort: RadioStationSort = directorySort
	) {
		if (!searchQuery) return;
		searching = true;
		try {
			const groups = mode === 'tag'
				? [await api.searchRadioStations(searchQuery, 'tag', sort)]
				: await Promise.all([
					api.searchRadioStations(searchQuery, 'name', sort),
					api.searchRadioStations(searchQuery, 'tag', sort)
				]);
			const nextResults = sortRadioStations(Array.from(
				new Map(groups.flat().map((station) => [station.stationuuid || station.url, station])).values()
			), sort).slice(0, 30);
			if (requestId === searchRequest) {
				results = nextResults;
				resultContext = 'search';
				directoryNextOffset = 0;
				directoryHasMore = false;
				mergeDirectoryStats(nextResults);
				searchHealthByUrl = {};
				searchError = '';
			}
		} catch (error) {
			if (requestId === searchRequest) {
				results = [];
				searchHealthByUrl = {};
				searchError = `Failed to search stations${error ? `: ${error}` : ''}`;
			}
		} finally {
			if (requestId === searchRequest) searching = false;
		}
	}

	async function browseStations(
		requestId = ++searchRequest,
		sort: RadioStationSort = directorySort
	) {
		searching = true;
		try {
			const page = await api.browseRadioStations(sort, 0, 40);
			const nextResults = sortRadioStations(page.items, sort);
			if (requestId === searchRequest) {
				results = nextResults;
				resultContext = 'browse';
				directoryNextOffset = page.next_offset;
				directoryHasMore = page.has_more;
				mergeDirectoryStats(nextResults);
				searchHealthByUrl = {};
				searchError = '';
			}
		} catch (error) {
			if (requestId === searchRequest) {
				results = [];
				searchHealthByUrl = {};
				searchError = `Failed to browse stations${error ? `: ${error}` : ''}`;
			}
		} finally {
			if (requestId === searchRequest) searching = false;
		}
	}

	async function loadMoreDirectory() {
		if (loadingMore || searching || resultContext !== 'browse' || query.trim()) return;
		loadingMore = true;
		const requestId = searchRequest;
		const requestedOffset = directoryNextOffset;
		try {
			const page = await api.browseRadioStations(directorySort, requestedOffset, 40);
			if (requestId !== searchRequest) return;
			const combined = Array.from(
				new Map([...results, ...page.items].map((station) => [station.stationuuid || station.url, station])).values()
			);
			results = sortRadioStations(combined, directorySort);
			mergeDirectoryStats(page.items);
			directoryNextOffset = page.next_offset;
			directoryHasMore = page.has_more && page.next_offset > requestedOffset;
		} catch (error) {
			toast.error(`Could not load more stations: ${error}`);
		} finally {
			loadingMore = false;
		}
	}

	async function playSearchResult(station: RadioBrowserStation) {
		const requestId = ++stationPlayRequest;
		try {
			if (isSearchStationActive(station)) {
				await stopPlaying();
				return;
			}
			const stationId = await api.playStationSearchResult(station);
			searchStationIds = {
				...searchStationIds,
				[station.stationuuid || station.url]: stationId,
				[station.url]: stationId
			};
			if (requestId === stationPlayRequest) toast.success(`Playing: ${station.name}`);
		} catch (error) {
			if (requestId === stationPlayRequest && !String(error).includes('superseded')) {
				toast.error(`Failed to play station: ${error}`);
			}
		}
	}

	async function playFavorite(station: Station) {
		const requestId = ++stationPlayRequest;
		try {
			if (isStationActive(station.id)) {
				await stopPlaying();
				return;
			}
			await api.playStation(station.id, station.url, station.name);
			if (requestId === stationPlayRequest) toast.success(`Playing: ${station.name}`);
		} catch (error) {
			if (requestId === stationPlayRequest && !String(error).includes('superseded')) {
				toast.error(`Failed to play station: ${error}`);
			}
		}
	}

	async function stopPlaying() {
		stationPlayRequest += 1;
		try {
			await player.stop();
		} catch {
			// Ignore a stop that races a source change.
		}
	}

	function isStationActive(stationId: string): boolean {
		return player.state.source === 'radio' &&
			player.state.current_station_id === stationId &&
			(player.state.is_playing || player.state.is_buffering);
	}

	function isSearchStationActive(station: RadioBrowserStation): boolean {
		const stationId = searchStationIds[station.stationuuid || station.url] ?? searchStationIds[station.url];
		return stationId ? isStationActive(stationId) : false;
	}

	async function saveToFavorites(station: RadioBrowserStation) {
		const key = station.stationuuid || station.url;
		if (isStationSaved(station)) return;
		savedStationIds = new Set([...savedStationIds, key]);
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
			toast.success(`Saved "${station.name}" to favorites`);
			await loadFavorites();
		} catch {
			savedStationIds = new Set([...savedStationIds].filter((id) => id !== key));
			toast.error('Failed to save station');
		}
	}

	function isStationSaved(station: RadioBrowserStation): boolean {
		return savedStationIds.has(station.stationuuid || station.url) ||
			favorites.some((favorite) =>
				favorite.url === station.url || favorite.radio_browser_id === station.stationuuid
			);
	}

	async function removeFavorite(station: Station) {
		try {
			await api.toggleStationFavorite(station.id);
			savedStationIds = new Set(
				[...savedStationIds].filter((key) => key !== station.url && key !== station.radio_browser_id)
			);
			toast.success(`Removed "${station.name}" from favorites`);
			await loadFavorites();
		} catch {
			toast.error('Failed to remove station');
		}
	}

	function getStationHealth(station: Station): DisplayStationHealth {
		if (!station.last_checked_at) return 'unknown';
		if (station.fail_count >= 3) return 'dead';
		if (station.fail_count >= 1) return 'stale';
		return 'ok';
	}

	function stationHealthLabel(station: Station): string {
		switch (getStationHealth(station)) {
			case 'ok': return 'Ready · checked locally';
			case 'stale': return 'Needs another local check';
			case 'dead': return 'Couldn’t connect in recent checks';
			default: return 'Not checked locally yet';
		}
	}

	function pickHealth(station: CuratedStation): StationHealthResult['status'] | null {
		return curatedHealthByUrl[station.url] ?? null;
	}

	function searchStationHealth(url: string): StationHealthResult['status'] | null {
		return searchHealthByUrl[url] ?? null;
	}

	function resultHealth(station: RadioBrowserStation): DisplayStationHealth {
		return searchStationHealth(station.url) ?? 'unknown';
	}

	function resultHealthLabel(station: RadioBrowserStation): string {
		const local = searchStationHealth(station.url);
		if (local === 'ok') return 'Playable in this test';
		if (local === 'stale' || local === 'dead') return 'Couldn’t connect in this test';
		return 'Not tested locally';
	}

	function healthDotClass(health: DisplayStationHealth): string {
		switch (health) {
			case 'ok': return 'bg-emerald-400';
			case 'stale': return 'bg-amber-400';
			case 'dead': return 'bg-red-500';
			default: return 'bg-zinc-500';
		}
	}

	function healthTextClass(health: DisplayStationHealth): string {
		switch (health) {
			case 'ok': return 'text-emerald-500';
			case 'stale': return 'text-amber-500';
			case 'dead': return 'text-red-500';
			default: return 'text-zinc-400';
		}
	}

	function resetSearchState() {
		query = '';
		searchMode = 'name';
		results = [];
		searchHealthByUrl = {};
		searchError = '';
		searching = false;
		directoryNextOffset = 0;
		directoryHasMore = true;
		searchRequest += 1;
		stationHealthRequest += 1;
	}

	function clearDirectorySearch() {
		resetSearchState();
		stationView = 'directory';
	}

	function searchGenre(genre: string) {
		stationView = 'directory';
		searchMode = 'tag';
		query = genre;
	}

	function browseDirectory() {
		stationView = 'directory';
	}

	function showDiscover() {
		resetSearchState();
		stationView = 'discover';
	}

	function showFavorites() {
		resetSearchState();
		stationView = 'favorites';
	}

	function handleSearchInput() {
		stationView = 'directory';
		searchMode = 'name';
	}

	async function verifyStations() {
		if (verifyingStations) return;
		const healthRequestId = ++stationHealthRequest;
		const scanView = stationView;
		const visiblePicks = scanView === 'discover' ? selectedCollection.stations : [];
		const visibleDirectoryStations = scanView === 'directory'
			? results.slice(0, MAX_LOCAL_DIRECTORY_PROBES)
			: [];
		verifyingStations = true;
		try {
			await refreshKnownStationDetails(
				visibleDirectoryStations.map((station) => station.stationuuid)
			);

			const favoriteResults = await api.verifyFavoriteStations();
			const favoriteHealthById = new Map(
				favoriteResults.flatMap((result) => result.station_id
					? [[result.station_id, result.status] as const]
					: [])
			);
			const favoriteByDirectoryId = new Map(
				favorites.flatMap((station) => station.radio_browser_id
					? [[station.radio_browser_id.toLowerCase(), station] as const]
					: [])
			);
			const favoriteByUrl = new Map(favorites.map((station) => [station.url, station] as const));
			const savedVisibleHealthByUrl: Record<string, StationHealthResult['status']> = {};
			for (const station of [...visiblePicks, ...visibleDirectoryStations]) {
				const favorite = favoriteByDirectoryId.get(station.stationuuid.toLowerCase()) ??
					favoriteByUrl.get(station.url);
				const status = favorite ? favoriteHealthById.get(favorite.id) : null;
				if (status) savedVisibleHealthByUrl[station.url] = status;
			}

			const savedUrls = new Set(favorites.map((station) => station.url));
			const savedDirectoryIds = new Set(
				favorites.flatMap((station) => station.radio_browser_id
					? [station.radio_browser_id.toLowerCase()]
					: [])
			);
			const visibleUrls = [...new Set(
				[...visiblePicks, ...visibleDirectoryStations]
					.filter((station) =>
						!savedUrls.has(station.url) &&
						!savedDirectoryIds.has(station.stationuuid.toLowerCase())
					)
					.map((station) => station.url)
			)].slice(0, MAX_LOCAL_DIRECTORY_PROBES);
			const visibleResults = visibleUrls.length > 0
				? await api.verifyStationUrls(visibleUrls)
				: [];
			const visibleResultsAreCurrent = healthRequestId === stationHealthRequest;
			if (visibleResultsAreCurrent) {
				if (scanView === 'discover') {
					curatedHealthByUrl = {
						...curatedHealthByUrl,
						...savedVisibleHealthByUrl,
						...Object.fromEntries(visibleResults.map((result) => [result.url, result.status] as const))
					};
				} else {
					searchHealthByUrl = {
						...savedVisibleHealthByUrl,
						...Object.fromEntries(visibleResults.map((result) => [result.url, result.status] as const))
					};
				}
			}
			const combinedResults = visibleResultsAreCurrent
				? [...favoriteResults, ...visibleResults]
				: favoriteResults;
			const deadCount = combinedResults.filter((result) => result.status === 'dead').length;
			const staleCount = combinedResults.filter((result) => result.status === 'stale').length;
			const okCount = combinedResults.filter((result) => result.status === 'ok').length;
			const repairedCount = favoriteResults.filter((result) => result.repaired).length;
			await loadFavorites();
			const summaryParts = [`${okCount} live`];
			if (repairedCount > 0) summaryParts.push(`${repairedCount} repaired`);
			if (staleCount > 0) summaryParts.push(`${staleCount} warning`);
			if (deadCount > 0) summaryParts.push(`${deadCount} couldn’t connect`);
			scanSummary = summaryParts.join(' · ');
			if (deadCount > 0 || staleCount > 0) {
				toast.warning(`Station check: ${scanSummary}`);
			} else {
				toast.success(`Station check: ${scanSummary}`);
			}
		} catch (error) {
			scanSummary = 'Last check failed';
			toast.error(`Station check failed: ${error}`);
		} finally {
			verifyingStations = false;
		}
	}
</script>

<svelte:head>
	<title>Stations · mewsik</title>
	<meta name="description" content="Hand-picked internet radio, plus the whole world when you want to dig." />
</svelte:head>

<div class="mx-auto flex w-full max-w-[1440px] min-w-0 flex-col gap-8 pb-6">
	<header class="flex items-center justify-between gap-4">
		<div>
			<p class="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary/80">Live radio</p>
			<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Stations</h1>
		</div>
		<div class="flex min-w-0 items-center gap-3">
			{#if scanSummary}
				<span class="hidden max-w-48 truncate text-right text-[11px] text-muted-foreground md:block" title={scanSummary}>
					Last check: {scanSummary}
				</span>
			{/if}
			<Button
				variant="outline"
				size="sm"
				class="h-10 shrink-0 rounded-full border-border/70 bg-card/60 px-3"
				disabled={verifyingStations}
				onclick={verifyStations}
				title="Test saved stations and a small set of stations in the current view"
				aria-label="Check stations"
			>
				{#if verifyingStations}
					<LoaderCircle class="size-4 shrink-0 animate-spin text-primary" />
				{:else}
					<RefreshCw class="size-4 shrink-0" />
				{/if}
				<span class="ml-2">{verifyingStations ? 'Checking…' : 'Check stations'}</span>
			</Button>
		</div>
	</header>

	<section class="sticky top-0 z-30 rounded-2xl border border-border/80 bg-background/90 p-2.5 shadow-lg shadow-black/10 backdrop-blur-xl" aria-label="Station discovery and search">
		<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
			<div class="inline-flex shrink-0 rounded-xl bg-muted/70 p-1" aria-label="Station view">
				<button
					class={`rounded-lg px-3 py-2 text-xs font-semibold transition ${stationView === 'discover' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
					onclick={showDiscover}
					aria-pressed={stationView === 'discover'}
				>
					Discover
				</button>
				<button
					class={`rounded-lg px-3 py-2 text-xs font-semibold transition ${stationView === 'favorites' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
					onclick={showFavorites}
					aria-pressed={stationView === 'favorites'}
					aria-label="Favorites"
				>
					Favorites
					{#if favorites.length > 0}<span class="ml-1 text-[10px] text-muted-foreground" aria-hidden="true">{favorites.length}</span>{/if}
				</button>
				<button
					class={`rounded-lg px-3 py-2 text-xs font-semibold transition ${stationView === 'directory' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
					onclick={browseDirectory}
					aria-pressed={stationView === 'directory'}
				>
					Directory
				</button>
			</div>
			<div class="relative min-w-0 flex-1">
				<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					placeholder="Search station names or genres..."
					aria-label="Search radio stations"
					class="h-11 rounded-xl bg-card pl-10 pr-10"
					bind:value={query}
					oninput={handleSearchInput}
				/>
				{#if query.length > 0}
					<button class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground" onclick={clearDirectorySearch} aria-label="Clear station search">
						<X class="size-4" />
					</button>
				{/if}
			</div>
		</div>
	</section>

	{#if stationView === 'discover'}

	<section class="relative isolate overflow-hidden rounded-2xl border border-white/10 bg-[#101817] px-5 py-5 shadow-xl shadow-black/20 sm:px-7 sm:py-6">
		<div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_22%,rgba(74,222,128,0.17),transparent_31%),radial-gradient(circle_at_16%_110%,rgba(34,211,238,0.12),transparent_40%)]"></div>
		<div class="pointer-events-none absolute -right-8 -top-16 size-64 rounded-full border border-primary/10"></div>
		<div class="pointer-events-none absolute right-10 top-2 size-40 rounded-full border border-white/5"></div>
		<div class="relative grid items-end gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
			<div class="max-w-2xl">
				<div class="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
					<Sparkles class="size-3.5" />
					Mewsik Picks · {curatedStations.length} researched streams
				</div>
				<h2 class="text-balance text-2xl font-semibold leading-tight tracking-[-0.025em] text-white sm:text-3xl">
					Radio with a point of view.
				</h2>
				<p class="mt-2 max-w-xl text-sm leading-6 text-white/62">
					Independent, public, and listener-supported stations chosen for flow, identity, and a working stream.
				</p>
				<div class="mt-4 flex flex-col gap-2 min-[420px]:flex-row">
					<Button
						class="h-11 rounded-full px-5"
						onclick={() => playSearchResult(selectedCollection.stations[0])}
					>
						<Play class="mr-2 size-4 fill-current" />
						Play {selectedCollection.stations[0].name}
					</Button>
					<Button
						variant="outline"
						class="h-11 rounded-full border-white/15 bg-white/5 px-5 text-white hover:bg-white/10 hover:text-white"
						onclick={browseDirectory}
					>
						Search every station
						<ArrowRight class="ml-2 size-4" />
					</Button>
				</div>
			</div>

			<div class="hidden rounded-xl border border-white/10 bg-black/20 p-4 backdrop-blur-sm lg:block">
				<div class="flex items-center justify-between text-xs text-white/50">
					<span>Currently featured</span>
					<span class="inline-flex items-center gap-1.5 text-primary"><span class="size-1.5 animate-pulse rounded-full bg-primary"></span>Live</span>
				</div>
				<div class="mt-5 flex items-center gap-4">
					<div class="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_30px_rgba(74,222,128,0.2)]">
						<Headphones class="size-5" />
					</div>
					<div class="min-w-0">
						<p class="truncate font-medium text-white">{selectedCollection.stations[0].name}</p>
						<p class="mt-1 truncate text-xs text-white/45">{selectedCollection.stations[0].quality}</p>
					</div>
				</div>
				<div class="mt-5 flex h-8 items-end gap-1" aria-hidden="true">
					{#each [38, 68, 48, 86, 58, 74, 42, 66, 34, 80, 52, 72, 44, 62, 35, 76] as height, index}
						<span class="signal-bar flex-1 rounded-full bg-primary/55" style={`height:${height}%; animation-delay:${index * -70}ms`}></span>
					{/each}
				</div>
			</div>
		</div>
	</section>

	<section aria-labelledby="collections-heading">
		<div class="mb-3 flex items-end justify-between gap-4">
			<div>
				<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Start with a feeling</p>
				<h2 id="collections-heading" class="mt-1 text-lg font-semibold sm:text-xl">Curated collections</h2>
			</div>
			<p class="hidden text-xs text-muted-foreground sm:block">Updated as better stations surface</p>
		</div>

		<div class="collection-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4">
			{#each curatedCollections as collection}
				<button
					class={`group relative min-h-28 min-w-[68vw] snap-center overflow-hidden rounded-xl border p-4 text-left transition duration-300 sm:min-w-0 ${selectedCollectionId === collection.id ? 'border-primary/45 bg-primary/[0.07] shadow-[0_0_0_1px_rgba(74,222,128,0.08)]' : 'border-border/70 bg-card hover:-translate-y-0.5 hover:border-white/20'}`}
					onclick={() => selectedCollectionId = collection.id}
					aria-pressed={selectedCollectionId === collection.id}
				>
					<div class={`pointer-events-none absolute inset-0 bg-gradient-to-br ${collection.accent}`}></div>
					<div class="relative flex h-full flex-col">
						<div class="flex items-start justify-between">
							<div class={`flex size-9 items-center justify-center rounded-lg border ${selectedCollectionId === collection.id ? 'border-primary/25 bg-primary/15 text-primary' : 'border-white/10 bg-black/15 text-white/70'}`}>
								{#if collection.id === 'night-drive'}
									<MoonStar class="size-4" />
								{:else if collection.id === 'deep-focus'}
									<Waves class="size-4" />
								{:else if collection.id === 'after-hours'}
									<Signal class="size-4" />
								{:else if collection.id === 'global-dial'}
									<Globe class="size-4" />
								{:else if collection.id === 'jazz-soul' || collection.id === 'human-radio'}
									<Headphones class="size-4" />
								{:else}
									<Guitar class="size-4" />
								{/if}
							</div>
							<span class="text-[11px] font-medium text-white/45">{collection.stations.length} picks</span>
						</div>
						<p class="mt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{collection.eyebrow}</p>
						<h3 class="mt-1 text-base font-semibold text-white">{collection.title}</h3>
					</div>
				</button>
			{/each}
		</div>
	</section>

	<section class="rounded-2xl border border-border/70 bg-card/35 p-3 sm:p-5" aria-live="polite">
		<div class="mb-4 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
			<div class="max-w-2xl">
				<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{selectedCollection.eyebrow}</p>
				<h2 class="mt-1 text-xl font-semibold">{selectedCollection.title}</h2>
				<p class="mt-1 text-sm leading-5 text-muted-foreground">{selectedCollection.description}</p>
			</div>
			<Button variant="ghost" size="sm" class="w-fit shrink-0 text-xs text-muted-foreground hover:text-primary" onclick={() => searchGenre(selectedCollection.tag)}>
				More like this <ArrowRight class="ml-1.5 size-3.5" />
			</Button>
		</div>

		<div class="grid gap-3 lg:grid-cols-3">
			{#each selectedCollection.stations as station, index}
				{@const health = pickHealth(station)}
				<article class="group relative min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/70 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-xl hover:shadow-black/15">
					<div class={`pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b ${selectedCollection.accent}`}></div>
					<div class="relative flex items-start justify-between gap-3">
						<div class="flex items-center gap-2">
							<span class="font-mono text-[10px] text-white/30">0{index + 1}</span>
							<span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${health === 'dead' ? 'border-zinc-500/25 bg-zinc-500/10 text-zinc-400' : health === 'stale' ? 'border-amber-400/25 bg-amber-400/10 text-amber-300' : health === 'ok' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-white/45'}`}>
								<span class={`size-1.5 rounded-full ${health === 'dead' ? 'bg-zinc-500' : health === 'stale' ? 'bg-amber-400' : health === 'ok' ? 'bg-emerald-400' : 'bg-white/30'}`}></span>
								{health === 'dead' ? 'Couldn’t connect' : health === 'stale' ? 'Connection issue' : health === 'ok' ? 'Stream checked' : 'Checking stream'}
							</span>
						</div>
						{#if isStationSaved(station)}
							<span
								class="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary"
								title="Saved to favorites"
								aria-label={`${station.name} is saved`}
							>
								<Check class="size-4" />
							</span>
						{:else}
							<button
								class="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/15 text-white/55 transition hover:border-primary/30 hover:text-primary"
								onclick={() => saveToFavorites(station)}
								title="Save to favorites"
								aria-label={`Save ${station.name}`}
							>
								<Heart class="size-4" />
							</button>
						{/if}
					</div>

					<div class="relative mt-7">
						<p class="truncate text-base font-semibold text-white">{station.name}</p>
						<p class="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{station.editorial}</p>
					</div>

					<div class="relative mt-5 flex items-end justify-between gap-3 border-t border-white/[0.07] pt-3">
						<div class="min-w-0">
							<p class="truncate text-[11px] font-medium text-white/70">{station.quality}</p>
							<p class="mt-1 truncate text-[10px] text-primary/65">{station.adLabel}</p>
							<p class="mt-1 truncate text-[10px] text-white/35">
								{station.country} · {station.codec} {station.bitrate ? `· ${station.bitrate} kbps` : ''}
							</p>
						</div>
						<button
							class="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/10 transition hover:scale-105 hover:bg-primary/90 active:scale-95"
							onclick={() => playSearchResult(station)}
							aria-label={isSearchStationActive(station) ? `Stop ${station.name}` : `Play ${station.name}`}
						>
							{#if isSearchStationActive(station)}
								{#if player.state.is_buffering}
									<LoaderCircle class="size-4 animate-spin" />
								{:else}
									<Square class="size-4 fill-current" />
								{/if}
							{:else}
								<Play class="size-4 fill-current pl-0.5" />
							{/if}
						</button>
					</div>
				</article>
			{/each}
		</div>
	</section>

	{:else if stationView === 'favorites'}
	{#if favoritesError}
		<Card class="border-dashed">
			<CardContent class="py-6 text-sm text-destructive">{favoritesError}</CardContent>
		</Card>
	{:else if favorites.length > 0}
		<section aria-labelledby="favorites-heading">
			<div class="mb-3 flex items-center justify-between">
				<div>
					<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Your dial</p>
					<h2 id="favorites-heading" class="mt-1 text-lg font-semibold sm:text-xl">Favorites</h2>
				</div>
				<span class="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{favorites.length} saved</span>
			</div>
			<div class="grid gap-2 xl:grid-cols-2">
				{#each favorites as station}
					{@const health = getStationHealth(station)}
					<Card class={`transition-colors hover:border-border hover:bg-muted/40 ${health === 'dead' ? 'border-border/60 bg-muted/30 opacity-65' : ''}`}>
						<CardContent class="flex min-w-0 items-center gap-3 p-3">
							<button
								class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:scale-105 hover:bg-primary/90 active:scale-95"
								onclick={() => isStationActive(station.id) ? stopPlaying() : playFavorite(station)}
								aria-label={isStationActive(station.id) ? `Stop ${station.name}` : `Play ${station.name}`}
							>
								{#if isStationActive(station.id)}
									{#if player.state.is_buffering}<LoaderCircle class="size-4 animate-spin" />{:else}<Square class="size-4 fill-current" />{/if}
								{:else}
									<Play class="size-4 fill-current pl-0.5" />
								{/if}
							</button>
							<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground max-[420px]:hidden">
								<Radio class="size-4" />
							</div>
							<div class="min-w-0 flex-1 overflow-hidden">
								<div class="flex min-w-0 items-center gap-2">
									<p class="truncate text-sm font-medium">{station.name}</p>
									<span class={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} title={stationHealthLabel(station)}></span>
									{#if isStationActive(station.id) && !player.state.is_buffering}<span class="size-2 shrink-0 animate-pulse rounded-full bg-primary"></span>{/if}
								</div>
								<p class="mt-0.5 truncate text-xs text-muted-foreground">
									{[station.country, station.codec, station.bitrate ? `${station.bitrate} kbps` : null].filter(Boolean).join(' · ')}
								</p>
								<p class={`mt-1 truncate text-[11px] ${healthTextClass(health)}`}>{stationHealthLabel(station)}</p>
							</div>
							<Button variant="ghost" size="icon" class="size-9 shrink-0 text-muted-foreground hover:text-destructive" onclick={() => removeFavorite(station)} title="Remove from favorites" aria-label={`Remove ${station.name} from favorites`}>
								<HeartOff class="size-4" />
							</Button>
						</CardContent>
					</Card>
				{/each}
			</div>
		</section>
	{:else}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-12 text-center">
				<div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<Heart class="size-5" />
				</div>
				<div>
					<h2 class="font-semibold">Your dial is empty</h2>
					<p class="mt-1 text-sm text-muted-foreground">Save a station from Discover or Directory and it will live here.</p>
				</div>
				<Button variant="outline" class="rounded-full" onclick={browseDirectory}>Browse the directory</Button>
			</CardContent>
		</Card>
	{/if}

	{:else}
	<section class="rounded-2xl border border-border/70 bg-card/25 p-4 sm:p-6" aria-labelledby="directory-heading">
		<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
			<div class="max-w-2xl">
				<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">The open dial</p>
				<h2 id="directory-heading" class="mt-1 text-lg font-semibold sm:text-xl">
					{query.trim().length > 1 ? 'Search every station' : 'Station directory'}
				</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					{query.trim().length > 1
						? `Name and tag matches for “${query.trim()}”, ranked by ${selectedDirectorySort.label.toLowerCase()}.`
						: `Browse the worldwide directory, ranked by ${selectedDirectorySort.label.toLowerCase()}.`}
				</p>
			</div>
			<label class="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
				<span class="inline-flex items-center gap-1.5">
					Rank by
					<span
						class="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground/70"
						title="Radio Browser starts and votes are activity signals, not live listener counts."
						aria-label="About station ranking"
					>
						<Info class="size-3.5" />
					</span>
				</span>
				<select
					bind:value={directorySort}
					aria-label="Sort stations"
					class="h-9 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
					title={selectedDirectorySort.title}
				>
					{#each DIRECTORY_SORT_OPTIONS as option}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
		</div>

		{#if query.trim().length <= 1}
			<div class="flex gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible">
				{#each genres as genre}
					<button class="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary" onclick={() => searchGenre(genre)}>
						{genre}
					</button>
				{/each}
			</div>
		{/if}

		<div class="mt-4">
			{#if searching}
				<div class="space-y-2">{#each Array(5) as _}<Skeleton class="h-16 w-full rounded-xl" />{/each}</div>
			{:else if searchError}
				<Card class="border-dashed"><CardContent class="py-6 text-sm text-destructive">{searchError}</CardContent></Card>
			{:else if displayedResults.length > 0}
				<div class="grid gap-2 xl:grid-cols-2">
					{#each displayedResults as station, index}
						{@const snapshot = stationDirectorySnapshot(station)}
						{@const health = resultHealth(station)}
						<Card class={`overflow-hidden transition-colors hover:border-border hover:bg-muted/40 ${health === 'dead' ? 'border-red-500/15 bg-red-500/[0.025]' : ''}`}>
							<CardContent class="flex min-w-0 items-center gap-3 p-3">
								<button class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:scale-105 hover:bg-primary/90 active:scale-95" onclick={() => playSearchResult(station)} aria-label={isSearchStationActive(station) ? `Stop ${station.name}` : `Play ${station.name}`}>
									{#if isSearchStationActive(station)}
										{#if player.state.is_buffering}<LoaderCircle class="size-4 animate-spin" />{:else}<Square class="size-4 fill-current" />{/if}
									{:else}<Play class="size-4 fill-current pl-0.5" />{/if}
								</button>
								<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-[10px] text-muted-foreground max-[420px]:hidden">
									{#if resultContext === 'browse'}#{String(index + 1).padStart(2, '0')}{:else}<Radio class="size-4" />{/if}
								</div>
								<div class="min-w-0 flex-1 overflow-hidden">
									<div class="flex min-w-0 items-center gap-2">
										<p class="truncate text-sm font-medium">{station.name}</p>
										<span class={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} title={resultHealthLabel(station)}></span>
									</div>
									<p class="mt-0.5 truncate text-xs text-muted-foreground">{[snapshot.country, snapshot.language, snapshot.codec, directorySort !== 'quality' && snapshot.bitrate ? `${snapshot.bitrate} kbps` : null].filter(Boolean).join(' · ')}</p>
									<StationMetrics station={snapshot} metric={directorySort} className="mt-1" />
									{#if health !== 'unknown'}
										<p class={`mt-1 truncate text-[11px] ${healthTextClass(health)}`}>{resultHealthLabel(station)}</p>
									{/if}
								</div>
								{#if isStationSaved(station)}
									<span class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-[11px] font-medium text-primary" title="Saved to favorites" aria-label={`${station.name} is saved`}>
										<Check class="size-3.5" />
										<span class="hidden sm:inline">Saved</span>
									</span>
								{:else}
									<Button variant="ghost" size="icon" class="size-9 shrink-0 text-muted-foreground" onclick={() => saveToFavorites(station)} title="Save to favorites" aria-label={`Save ${station.name}`}>
										<Heart class="size-4" />
									</Button>
								{/if}
							</CardContent>
						</Card>
					{/each}
				</div>
				{#if resultContext === 'browse' && query.trim().length === 0 && directoryHasMore}
					<div class="mt-4 flex justify-center">
						<Button variant="outline" class="rounded-full px-5" disabled={loadingMore} onclick={loadMoreDirectory}>
							{#if loadingMore}<LoaderCircle class="mr-2 size-4 animate-spin" />{/if}
							Load more stations
						</Button>
					</div>
				{/if}
			{:else if query.trim().length > 1}
				<Card class="border-dashed"><CardContent class="flex flex-col items-center gap-3 py-10 text-center"><Radio class="size-9 text-muted-foreground" /><div><h3 class="font-semibold">No stations found</h3><p class="text-sm text-muted-foreground">Try a broader station name or genre.</p></div></CardContent></Card>
			{:else if query.trim().length === 1}
				<Card class="border-dashed"><CardContent class="flex flex-col items-center gap-3 py-8 text-center"><Search class="size-8 text-muted-foreground" /><div><h3 class="font-semibold">Keep typing</h3><p class="text-sm text-muted-foreground">Use at least two characters for a useful directory search.</p></div></CardContent></Card>
			{:else}
				<div class="flex items-center gap-3 rounded-xl border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
					<Globe class="size-5 shrink-0" />
					<span>The ranked directory is available in the desktop app when the live service is reachable.</span>
				</div>
			{/if}
		</div>
	</section>
	{/if}
</div>

<style>
	.signal-bar {
		transform-origin: bottom;
		animation: signal-pulse 1.6s ease-in-out infinite alternate;
	}

	.collection-rail {
		scrollbar-width: none;
	}

	.collection-rail::-webkit-scrollbar {
		display: none;
	}

	@keyframes signal-pulse {
		0% { transform: scaleY(0.35); opacity: 0.4; }
		100% { transform: scaleY(1); opacity: 0.85; }
	}

	@media (prefers-reduced-motion: reduce) {
		.signal-bar { animation: none; }
		* { scroll-behavior: auto !important; }
	}
</style>
