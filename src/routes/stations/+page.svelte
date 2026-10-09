<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import StationMetrics from '$lib/components/stations/station-metrics.svelte';
	import StationArt from '$lib/components/station-art.svelte';
	import * as api from '$lib/api/tauri';
	import type {
		RadioBrowserStation,
		RadioStationSort,
		SceneInfo,
		StationDiscoveryFeed,
		StationPick,
		StationShelf
	} from '$lib/api/tauri';
	import type { Station, StationHealthResult } from '$lib/types';
	import {
		curatedCollections,
		curatedStations,
		type CuratedCollection
	} from '$lib/radio/curated';
	import { SCENE_CATALOG } from '$lib/radio/scenes';
	import { DIRECTORY_GENRES, genreTagsFor } from '$lib/radio/genres';
	import { cleanStationName } from '$lib/radio/names';
	import {
		DIRECTORY_SORT_OPTIONS,
		sortRadioStations
	} from '$lib/radio/signals';
	import { usePlayer } from '$lib/state/player.svelte';
	import { toast } from 'svelte-sonner';
	import { tick, untrack } from 'svelte';
	import {
		ArrowRight,
		Check,
		ChevronDown,
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
	let discoverHealthByUrl = $state<Record<string, StationHealthResult['status']>>({});
	let probedUrls = $state<Set<string>>(new Set());
	// Stations that failed in the play path this session. The backend has
	// already taken them off the shelves; this drops the card immediately.
	let deadStationIds = $state<Set<string>>(new Set());
	let selectedCollectionId = $state<CuratedCollection['id']>('night-drive');
	let editorPicksOpen = $state(false);
	let stationView = $state<'discover' | 'favorites' | 'directory'>('discover');
	let feed = $state<StationDiscoveryFeed>({
		generatedAt: '',
		status: 'empty',
		cacheAgeSeconds: null,
		shelves: [],
		scenes: []
	});
	let feedLoading = $state(true);
	let feedRefreshing = $state(false);
	let feedError = $state('');
	let feedFetchedAt = $state(0);
	let feedRequest = 0;
	let feedPollDeadline = 0;
	let clock = $state(Date.now());
	type SceneExpansion = { status: 'loading' | 'ready' | 'error'; items: StationPick[] };
	let sceneExpansions = $state<Record<string, SceneExpansion>>({});
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

	// Scene catalog: the backend's list when the feed carries one, otherwise the
	// frontend copy so chips render without a cache (or without a backend).
	const scenes = $derived<SceneInfo[]>(feed.scenes.length > 0 ? feed.scenes : SCENE_CATALOG);
	const sceneById = $derived(new Map(scenes.map((scene) => [scene.id, scene] as const)));
	// Shelves as shown: dead picks dropped, and a shelf only survives while it
	// can still lead with a verified pick (the backend orders verified first).
	const visibleShelves = $derived.by<StationShelf[]>(() =>
		feed.shelves.flatMap((shelf) => {
			const items = shelf.items.filter((pick) => !isPickHidden(pick));
			return items.length > 0 && items[0].verified ? [{ ...shelf, items }] : [];
		})
	);
	const feedSceneIds = $derived(
		new Set(visibleShelves.flatMap((shelf) => (shelf.sceneId ? [shelf.sceneId] : [])))
	);
	const standaloneScenes = $derived(
		scenes.filter((scene) => sceneExpansions[scene.id] && !feedSceneIds.has(scene.id))
	);
	// The hero is the first verified pick in feed order that no local check
	// has flagged. Unverified stations never take the hero.
	const heroChoice = $derived.by(() => {
		for (const shelf of visibleShelves) {
			const pick = shelf.items.find(
				(item) => item.verified && discoverHealthByUrl[item.station.url] !== 'stale'
			);
			if (pick) return { shelf, pick };
		}
		return null;
	});
	const heroShelf = $derived<StationShelf | null>(heroChoice?.shelf ?? null);
	const heroPick = $derived<StationPick>(
		heroChoice?.pick ?? {
			station: curatedStations[0],
			sceneId: null,
			reason: 'Editor pick while the live feed fills',
			score: 0,
			bailRate: 0,
			plays: 0,
			verified: false,
			lastCheckedAt: null
		}
	);
	const heroName = $derived(cleanStationName(heroPick.station.name));
	// Verified picks were probed by the backend. Local probes cover only the
	// first 12 unverified picks on screen, in feed order.
	const probeTargetStations = $derived.by(() => {
		const seen = new Set<string>();
		const stations: RadioBrowserStation[] = [];
		for (const shelf of visibleShelves) {
			for (const pick of shelf.items) {
				if (pick.verified || seen.has(pick.station.url)) continue;
				seen.add(pick.station.url);
				stations.push(pick.station);
				if (stations.length >= MAX_LOCAL_DIRECTORY_PROBES) return stations;
			}
		}
		return stations;
	});
	const showFeedSkeleton = $derived(
		feedLoading || (feed.status === 'refreshing' && visibleShelves.length === 0)
	);
	const cacheAgeLabel = $derived.by(() => {
		if (feed.cacheAgeSeconds === null) {
			return feed.shelves.length === 0 ? 'Nothing cached yet' : 'Updated just now';
		}
		const elapsed = feedFetchedAt > 0 ? Math.max(0, Math.floor((clock - feedFetchedAt) / 1000)) : 0;
		const seconds = feed.cacheAgeSeconds + elapsed;
		if (seconds < 60) return 'Updated just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `Updated ${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `Updated ${hours} h ago`;
		return `Updated ${Math.floor(hours / 24)} d ago`;
	});

	$effect(() => {
		void loadFavorites();
		void loadFeed();
	});

	$effect(() => {
		const timer = setInterval(() => {
			clock = Date.now();
		}, 30_000);
		return () => clearInterval(timer);
	});

	// While the backend is still building the cache, re-query every 2 s for up
	// to 60 s. `get_station_discovery` spawns a background refresh when the
	// cache is empty, so an empty feed is polled too until it reports ready.
	$effect(() => {
		const status = feed.status;
		const view = stationView;
		if (feedLoading || view !== 'discover' || status === 'ready') {
			feedPollDeadline = 0;
			return;
		}
		if (feedPollDeadline === 0) feedPollDeadline = Date.now() + 60_000;
		if (Date.now() >= feedPollDeadline) return;
		const timer = setTimeout(() => void loadFeed(), 2_000);
		return () => clearTimeout(timer);
	});

	// Keyed by the URL list itself (URLs never contain spaces): probe results
	// reshape the shelves as dead picks drop out, and an unchanged list must
	// not re-trigger probing.
	const probeTargetKey = $derived(probeTargetStations.map((station) => station.url).join(' '));

	$effect(() => {
		if (stationView !== 'discover') return;
		const key = probeTargetKey;
		if (!key) return;
		untrack(() => void verifyDiscoverPicks(key.split(' ')));
	});

	$effect(() => {
		if (stationView !== 'discover' || !editorPicksOpen) return;
		const stations = selectedCollection.stations;
		untrack(() => void verifyDiscoverPicks(stations.map((station) => station.url)));
	});

	async function loadFeed() {
		const requestId = ++feedRequest;
		try {
			const next = await api.getStationDiscovery();
			if (requestId !== feedRequest) return;
			feed = next;
			feedFetchedAt = Date.now();
			feedError = '';
		} catch (error) {
			if (requestId !== feedRequest) return;
			feedError = `Station picks are unavailable${error ? `: ${error}` : ''}`;
		} finally {
			if (requestId === feedRequest) feedLoading = false;
		}
	}

	async function refreshFeed() {
		if (feedRefreshing) return;
		feedRefreshing = true;
		try {
			const summary = await api.refreshStationScenes(true);
			await loadFeed();
			if (summary.stations > 0) {
				toast.success(`Refreshed ${summary.scenes} scenes · ${summary.stations} stations`);
			} else {
				toast.warning('Refresh returned no stations. Nothing new was cached.');
			}
		} catch (error) {
			toast.error(`Could not refresh station picks: ${error}`);
		} finally {
			feedRefreshing = false;
		}
	}

	async function openScene(sceneId: string) {
		if (sceneExpansions[sceneId]) return;
		sceneExpansions = { ...sceneExpansions, [sceneId]: { status: 'loading', items: [] } };
		try {
			const items = await api.getSceneStations(sceneId, 40, 0);
			if (!sceneExpansions[sceneId]) return;
			sceneExpansions = { ...sceneExpansions, [sceneId]: { status: 'ready', items } };
		} catch {
			if (!sceneExpansions[sceneId]) return;
			sceneExpansions = { ...sceneExpansions, [sceneId]: { status: 'error', items: [] } };
		}
	}

	function closeScene(sceneId: string) {
		const { [sceneId]: _closed, ...rest } = sceneExpansions;
		sceneExpansions = rest;
	}

	function scrollToElement(id: string) {
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// A scene chip scrolls to its shelf when the feed has one, otherwise it
	// opens the ranked "See all" list for that scene in place.
	async function focusScene(sceneId: string) {
		if (feedSceneIds.has(sceneId)) {
			scrollToElement(`shelf-scene:${sceneId}`);
			return;
		}
		if (sceneExpansions[sceneId]) {
			scrollToElement(`scene-${sceneId}`);
			return;
		}
		void openScene(sceneId);
		await tick();
		scrollToElement(`scene-${sceneId}`);
	}

	function toggleSceneExpansion(sceneId: string) {
		if (sceneExpansions[sceneId]) {
			closeScene(sceneId);
		} else {
			void openScene(sceneId);
		}
	}

	function sceneTitle(sceneId: string | null): string {
		return sceneId ? (sceneById.get(sceneId)?.title ?? sceneId) : '';
	}

	function sceneAccent(sceneId: string | null): string {
		return (
			(sceneId ? sceneById.get(sceneId)?.accent : null) ??
			'from-primary/20 via-primary/5 to-transparent'
		);
	}

	function shelfEyebrow(shelf: StationShelf): string {
		if (shelf.kind === 'for_you') return 'Made for you';
		if (shelf.kind === 'fresh') return 'New today';
		return (shelf.sceneId ? sceneById.get(shelf.sceneId)?.eyebrow : null) ?? 'Scene';
	}

	function stationMeta(station: RadioBrowserStation): string {
		const stream = [station.codec, station.bitrate ? `${station.bitrate} kbps` : null]
			.filter(Boolean)
			.join(' ');
		return [station.country, stream].filter(Boolean).join(' · ');
	}

	function stationKey(station: RadioBrowserStation): string {
		return (station.stationuuid || station.url).toLowerCase();
	}

	// A pick is hidden once it failed to play or a local probe found it dead.
	function isPickHidden(pick: StationPick): boolean {
		return deadStationIds.has(stationKey(pick.station)) || discoverHealthByUrl[pick.station.url] === 'dead';
	}

	function markStationDead(station: RadioBrowserStation) {
		deadStationIds = new Set([...deadStationIds, stationKey(station)]);
	}

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

	async function verifyDiscoverPicks(urls: string[]) {
		const pending = [...new Set(urls)]
			.filter((url) => !probedUrls.has(url))
			.slice(0, MAX_LOCAL_DIRECTORY_PROBES);
		if (pending.length === 0) return;
		probedUrls = new Set([...probedUrls, ...pending]);
		try {
			const verified = await api.verifyStationUrls(pending);
			if (verified.length === 0) return;
			// Results are keyed by URL, so a late batch can only add information.
			discoverHealthByUrl = {
				...discoverHealthByUrl,
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
			// A genre (chip label or a typed genre word) maps to the real tags
			// stations use, queried together; anything else is a tag lookup.
			const genreTags = genreTagsFor(searchQuery);
			const tagSearch = genreTags
				? api.searchRadioStationsByTags(genreTags, sort)
				: api.searchRadioStations(searchQuery, 'tag', sort);
			const groups = mode === 'tag'
				? [await tagSearch]
				: await Promise.all([api.searchRadioStations(searchQuery, 'name', sort), tagSearch]);
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
			// The player shows "Connecting to …" right away while the stream check runs.
			const stationId = await player.playStation(
				{ name: cleanStationName(station.name), url: station.url },
				() => api.playStationSearchResult(station)
			);
			searchStationIds = {
				...searchStationIds,
				[station.stationuuid || station.url]: stationId,
				[station.url]: stationId
			};
		} catch (error) {
			if (api.isStationUnavailableError(error)) {
				// The backend marked it failed; drop the card now and let the
				// hero move on to the next verified pick.
				markStationDead(station);
				if (requestId === stationPlayRequest) {
					toast.error(`${cleanStationName(station.name)} is off the air. Removed from picks.`);
				}
				return;
			}
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
			await player.playStation(
				{ id: station.id, name: cleanStationName(station.name), url: station.url },
				() => api.playStation(station.id, station.url, station.name)
			);
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
			toast.success(`Saved "${cleanStationName(station.name)}" to favorites`);
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
			toast.success(`Removed "${cleanStationName(station.name)}" from favorites`);
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

	type PickHealth = StationHealthResult['status'] | 'checking' | 'unknown';

	function pickHealth(station: RadioBrowserStation, verified = false): PickHealth {
		const status = discoverHealthByUrl[station.url];
		if (status) return status;
		if (verified) return 'ok';
		return probedUrls.has(station.url) ? 'checking' : 'unknown';
	}

	function pickHealthLabel(health: PickHealth): string {
		switch (health) {
			case 'ok': return 'Stream checked';
			case 'stale': return 'Connection issue';
			case 'dead': return 'Couldn’t connect';
			case 'checking': return 'Checking stream';
			default: return 'Not checked yet';
		}
	}

	function pickHealthDotClass(health: PickHealth): string {
		switch (health) {
			case 'ok': return 'bg-emerald-400';
			case 'stale': return 'bg-amber-400';
			case 'dead': return 'bg-zinc-500';
			case 'checking': return 'bg-white/40 animate-pulse';
			default: return 'bg-white/25';
		}
	}

	function pickHealthPillClass(health: PickHealth): string {
		switch (health) {
			case 'ok': return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
			case 'stale': return 'border-amber-400/25 bg-amber-400/10 text-amber-300';
			case 'dead': return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-400';
			default: return 'border-white/10 bg-white/5 text-white/45';
		}
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
		const visiblePicks: RadioBrowserStation[] = scanView === 'discover'
			? [...probeTargetStations, ...(editorPicksOpen ? selectedCollection.stations : [])]
			: [];
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
					probedUrls = new Set([...probedUrls, ...visibleUrls]);
					discoverHealthByUrl = {
						...discoverHealthByUrl,
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

	{#snippet pickCard(pick: StationPick, accent: string, railCard: boolean)}
		{@const station = pick.station}
		{@const health = pickHealth(station, pick.verified)}
		<article
			class={`group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background/70 p-3.5 transition duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-xl hover:shadow-black/15 ${railCard ? 'w-[72vw] max-w-[300px] shrink-0 snap-start lg:w-auto lg:max-w-none' : ''}`}
		>
			<div class={`pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b ${accent}`}></div>
			<div class="relative flex items-start gap-3">
				<StationArt
					name={cleanStationName(station.name)}
					src={station.favicon}
					class="size-12 rounded-lg border border-white/10"
					monogramClass="text-base"
				/>
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 items-center gap-2">
						<p class="truncate text-sm font-semibold text-white">{cleanStationName(station.name)}</p>
						<span class={`size-2 shrink-0 rounded-full ${pickHealthDotClass(health)}`} title={pickHealthLabel(health)}></span>
					</div>
					<p class="mt-0.5 truncate text-[11px] text-white/45">{stationMeta(station)}</p>
				</div>
			</div>
			<p class="relative mt-3 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{pick.reason}</p>
			<div class="relative mt-3 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-3">
				<p class={`truncate text-[10px] ${health === 'ok' ? 'text-emerald-400/80' : health === 'stale' ? 'text-amber-400/80' : health === 'dead' ? 'text-zinc-400' : 'text-white/35'}`}>
					{health === 'unknown' ? (pick.plays > 0 ? `${pick.plays} ${pick.plays === 1 ? 'play' : 'plays'}` : sceneTitle(pick.sceneId)) : pickHealthLabel(health)}
				</p>
				<div class="flex shrink-0 items-center gap-1.5">
					{#if isStationSaved(station)}
						<span class="flex size-8 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary" title="Saved to favorites" aria-label={`${cleanStationName(station.name)} is saved`}>
							<Check class="size-3.5" />
						</span>
					{:else}
						<button
							class="flex size-8 items-center justify-center rounded-full border border-white/10 bg-black/15 text-white/55 transition hover:border-primary/30 hover:text-primary"
							onclick={() => saveToFavorites(station)}
							title="Save to favorites"
							aria-label={`Save ${cleanStationName(station.name)}`}
						>
							<Heart class="size-3.5" />
						</button>
					{/if}
					<button
						class="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/10 transition hover:scale-105 hover:bg-primary/90 active:scale-95"
						onclick={() => playSearchResult(station)}
						aria-label={isSearchStationActive(station) ? `Stop ${cleanStationName(station.name)}` : `Play ${cleanStationName(station.name)}`}
					>
						{#if isSearchStationActive(station)}
							{#if player.state.is_buffering}
								<LoaderCircle class="size-4 animate-spin" />
							{:else}
								<Square class="size-3.5 fill-current" />
							{/if}
						{:else}
							<Play class="size-3.5 fill-current pl-0.5" />
						{/if}
					</button>
				</div>
			</div>
		</article>
	{/snippet}

	{#snippet sceneExpansionPanel(sceneId: string)}
		{@const expansion = sceneExpansions[sceneId]}
		{@const scene = sceneById.get(sceneId)}
		{#if expansion}
			<div class="mt-3 rounded-2xl border border-border/60 bg-card/30 p-3 sm:p-4" aria-live="polite">
				{#if expansion.status === 'loading'}
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						{#each Array(8) as _}<Skeleton class="h-36 w-full rounded-xl" />{/each}
					</div>
				{:else if expansion.status === 'error'}
					<p class="px-1 py-4 text-sm text-destructive">Couldn’t load the full {scene?.title ?? sceneId} list.</p>
				{:else if expansion.items.filter((pick) => !isPickHidden(pick)).length === 0}
					<p class="px-1 py-4 text-sm text-muted-foreground">No cached stations for {scene?.title ?? sceneId} yet. Refresh picks once the desktop app can reach radio-browser.info.</p>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						{#each expansion.items.filter((pick) => !isPickHidden(pick)) as pick (pick.station.stationuuid || pick.station.url)}
							{@render pickCard(pick, sceneAccent(sceneId), false)}
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/snippet}

	{@const heroHealth = pickHealth(heroPick.station, heroPick.verified)}
	<section class="relative isolate overflow-hidden rounded-2xl border border-white/10 bg-[#101817] px-5 py-5 shadow-xl shadow-black/20 sm:px-7 sm:py-6" aria-labelledby="hero-heading">
		<div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_22%,rgba(74,222,128,0.17),transparent_31%),radial-gradient(circle_at_16%_110%,rgba(34,211,238,0.12),transparent_40%)]"></div>
		<div class="pointer-events-none absolute -right-8 -top-16 size-64 rounded-full border border-primary/10"></div>
		<div class="pointer-events-none absolute right-10 top-2 size-40 rounded-full border border-white/5"></div>
		<div class="relative grid items-end gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
			<div class="max-w-2xl">
				<div class="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
					<Sparkles class="size-3.5" />
					{heroShelf ? heroShelf.title : 'Live radio'} · {cacheAgeLabel}
				</div>
				<div class="flex items-center gap-3">
					<StationArt
						name={cleanStationName(heroPick.station.name)}
						src={heroPick.station.favicon}
						class="size-14 rounded-xl border border-white/10 lg:hidden"
						monogramClass="text-lg"
					/>
					<h2 id="hero-heading" class="min-w-0 text-balance text-2xl font-semibold leading-tight tracking-[-0.025em] text-white sm:text-3xl">
						{heroName}
					</h2>
				</div>
				<p class="mt-2 max-w-xl text-sm leading-6 text-white/62">{heroPick.reason}</p>
				<p class="mt-1 text-xs text-white/40">{stationMeta(heroPick.station)}</p>
				<div class="mt-4 flex flex-col gap-2 min-[420px]:flex-row">
					<Button
						class="h-11 rounded-full px-5"
						onclick={() => playSearchResult(heroPick.station)}
					>
						{#if isSearchStationActive(heroPick.station)}
							{#if player.state.is_buffering}
								<LoaderCircle class="mr-2 size-4 animate-spin" />
							{:else}
								<Square class="mr-2 size-4 fill-current" />
							{/if}
							Stop {heroName}
						{:else}
							<Play class="mr-2 size-4 fill-current" />
							Play {heroName}
						{/if}
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
					<span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${pickHealthPillClass(heroHealth)}`}>
						<span class={`size-1.5 rounded-full ${pickHealthDotClass(heroHealth)}`}></span>
						{pickHealthLabel(heroHealth)}
					</span>
				</div>
				<div class="mt-5 flex items-center gap-4">
					<StationArt
						name={cleanStationName(heroPick.station.name)}
						src={heroPick.station.favicon}
						class="size-12 rounded-lg border border-white/10"
						monogramClass="text-lg"
					/>
					<div class="min-w-0">
						<p class="truncate font-medium text-white">{heroName}</p>
						<p class="mt-1 truncate text-xs text-white/45">
							{heroPick.sceneId ? sceneTitle(heroPick.sceneId) : (heroShelf?.subtitle ?? 'Editor pick')}
						</p>
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

	<section aria-labelledby="scenes-heading">
		<div class="mb-3 flex items-end justify-between gap-4">
			<div>
				<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Pick a lane</p>
				<h2 id="scenes-heading" class="mt-1 text-lg font-semibold sm:text-xl">Scenes</h2>
			</div>
			<div class="flex shrink-0 items-center gap-3">
				<span class="hidden text-[11px] text-muted-foreground sm:block">{cacheAgeLabel}</span>
				<Button
					variant="outline"
					size="sm"
					class="h-9 rounded-full border-border/70 bg-card/60 px-3"
					disabled={feedRefreshing}
					onclick={refreshFeed}
					title="Pull fresh stations for every scene"
					aria-label="Refresh picks"
				>
					{#if feedRefreshing}
						<LoaderCircle class="size-4 shrink-0 animate-spin text-primary" />
					{:else}
						<RefreshCw class="size-4 shrink-0" />
					{/if}
					<span class="ml-2">{feedRefreshing ? 'Refreshing…' : 'Refresh'}</span>
				</Button>
			</div>
		</div>
		<div class="station-rail -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
			{#each scenes as scene (scene.id)}
				{@const active = feedSceneIds.has(scene.id) || Boolean(sceneExpansions[scene.id])}
				<button
					class={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary'}`}
					onclick={() => focusScene(scene.id)}
					aria-pressed={Boolean(sceneExpansions[scene.id])}
					title={scene.description}
				>
					{scene.title}
				</button>
			{/each}
		</div>
	</section>

	{#if feedError}
		<Card class="border-dashed">
			<CardContent class="py-6 text-sm text-destructive">{feedError}</CardContent>
		</Card>
	{:else if showFeedSkeleton}
		<div class="flex flex-col gap-8" aria-busy="true" aria-label="Loading station picks">
			{#each Array(2) as _}
				<section>
					<Skeleton class="mb-3 h-6 w-48 rounded-md" />
					<div class="station-rail -mx-4 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
						{#each Array(4) as _}
							<Skeleton class="h-36 w-[72vw] max-w-[300px] shrink-0 rounded-xl lg:w-auto lg:max-w-none" />
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else if visibleShelves.length === 0}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-12 text-center">
				<div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<Radio class="size-5" />
				</div>
				<div class="max-w-md">
					<h2 class="font-semibold">No station picks yet</h2>
					<p class="mt-1 text-sm text-muted-foreground">
						The feed is built by the desktop app from radio-browser.info and nothing has been cached on this device. Refresh to pull the first batch, or start with a scene above or the Editor picks below.
					</p>
				</div>
				<Button variant="outline" class="rounded-full" disabled={feedRefreshing} onclick={refreshFeed}>
					{#if feedRefreshing}<LoaderCircle class="mr-2 size-4 animate-spin" />{/if}
					Refresh picks now
				</Button>
			</CardContent>
		</Card>
	{:else}
		{#each visibleShelves as shelf (shelf.id)}
			{@const accent = sceneAccent(shelf.sceneId)}
			<section id={`shelf-${shelf.id}`} class="scroll-mt-28" aria-labelledby={`shelf-${shelf.id}-heading`}>
				<div class="mb-3 flex items-end justify-between gap-4">
					<div class="min-w-0">
						<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{shelfEyebrow(shelf)}</p>
						<h2 id={`shelf-${shelf.id}-heading`} class="mt-1 truncate text-lg font-semibold sm:text-xl">{shelf.title}</h2>
						<p class="mt-0.5 truncate text-xs text-muted-foreground">{shelf.subtitle}</p>
					</div>
					{#if shelf.sceneId}
						{@const sceneId = shelf.sceneId}
						<Button variant="ghost" size="sm" class="shrink-0 text-xs text-muted-foreground hover:text-primary" onclick={() => toggleSceneExpansion(sceneId)} aria-expanded={Boolean(sceneExpansions[sceneId])}>
							{sceneExpansions[sceneId] ? 'Show less' : 'See all'}
							<ArrowRight class="ml-1.5 size-3.5" />
						</Button>
					{/if}
				</div>
				<div class="station-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
					{#each shelf.items as pick (pick.station.stationuuid || pick.station.url)}
						{@render pickCard(pick, accent, true)}
					{/each}
				</div>
				{#if shelf.sceneId}
					{@render sceneExpansionPanel(shelf.sceneId)}
				{/if}
			</section>
		{/each}
	{/if}

	{#each standaloneScenes as scene (scene.id)}
		<section id={`scene-${scene.id}`} class="scroll-mt-28" aria-labelledby={`scene-${scene.id}-heading`}>
			<div class="mb-1 flex items-end justify-between gap-4">
				<div class="min-w-0">
					<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{scene.eyebrow}</p>
					<h2 id={`scene-${scene.id}-heading`} class="mt-1 truncate text-lg font-semibold sm:text-xl">{scene.title}</h2>
					<p class="mt-0.5 text-xs text-muted-foreground">{scene.description}</p>
				</div>
				<Button variant="ghost" size="sm" class="shrink-0 text-xs text-muted-foreground hover:text-primary" onclick={() => closeScene(scene.id)} aria-label={`Hide ${scene.title}`}>
					<X class="size-4" />
				</Button>
			</div>
			{@render sceneExpansionPanel(scene.id)}
		</section>
	{/each}

	<section class="rounded-2xl border border-border/70 bg-card/35" aria-labelledby="editor-picks-heading">
		<button
			class="flex w-full items-center justify-between gap-4 rounded-2xl p-4 text-left transition hover:bg-white/[0.03] sm:p-5"
			onclick={() => (editorPicksOpen = !editorPicksOpen)}
			aria-expanded={editorPicksOpen}
			aria-controls="editor-picks-panel"
		>
			<div class="min-w-0">
				<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Hand-picked</p>
				<h2 id="editor-picks-heading" class="mt-1 text-lg font-semibold sm:text-xl">Editor picks</h2>
				<p class="mt-0.5 text-xs text-muted-foreground">{curatedStations.length} researched streams in {curatedCollections.length} collections</p>
			</div>
			<ChevronDown class={`size-5 shrink-0 text-muted-foreground transition-transform ${editorPicksOpen ? 'rotate-180' : ''}`} />
		</button>

		{#if editorPicksOpen}
			<div id="editor-picks-panel" class="border-t border-border/60 p-3 sm:p-5">
				<div class="station-rail -mx-3 flex gap-2 overflow-x-auto px-3 pb-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
					{#each curatedCollections as collection (collection.id)}
						<button
							class={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${selectedCollectionId === collection.id ? 'border-primary/45 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-primary'}`}
							onclick={() => (selectedCollectionId = collection.id)}
							aria-pressed={selectedCollectionId === collection.id}
						>
							{#if collection.id === 'night-drive'}
								<MoonStar class="size-3.5" />
							{:else if collection.id === 'deep-focus'}
								<Waves class="size-3.5" />
							{:else if collection.id === 'after-hours'}
								<Signal class="size-3.5" />
							{:else if collection.id === 'global-dial'}
								<Globe class="size-3.5" />
							{:else if collection.id === 'jazz-soul' || collection.id === 'human-radio'}
								<Headphones class="size-3.5" />
							{:else}
								<Guitar class="size-3.5" />
							{/if}
							{collection.title}
							<span class="text-[10px] opacity-60">{collection.stations.length}</span>
						</button>
					{/each}
				</div>

				<div class="mb-4 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
					<div class="max-w-2xl">
						<p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{selectedCollection.eyebrow}</p>
						<h3 class="mt-1 text-lg font-semibold">{selectedCollection.title}</h3>
						<p class="mt-1 text-sm leading-5 text-muted-foreground">{selectedCollection.description}</p>
					</div>
					<Button variant="ghost" size="sm" class="w-fit shrink-0 text-xs text-muted-foreground hover:text-primary" onclick={() => searchGenre(selectedCollection.tag)}>
						More like this <ArrowRight class="ml-1.5 size-3.5" />
					</Button>
				</div>

				<div class="grid gap-3 lg:grid-cols-3">
					{#each selectedCollection.stations as station, index (station.stationuuid)}
						{@const health = pickHealth(station)}
						<article class="group relative min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/70 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-xl hover:shadow-black/15">
							<div class={`pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b ${selectedCollection.accent}`}></div>
							<div class="relative flex items-start justify-between gap-3">
								<div class="flex items-center gap-2">
									<span class="font-mono text-[10px] text-white/30">0{index + 1}</span>
									<span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${pickHealthPillClass(health)}`}>
										<span class={`size-1.5 rounded-full ${pickHealthDotClass(health)}`}></span>
										{pickHealthLabel(health)}
									</span>
								</div>
								{#if isStationSaved(station)}
									<span
										class="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary"
										title="Saved to favorites"
										aria-label={`${cleanStationName(station.name)} is saved`}
									>
										<Check class="size-4" />
									</span>
								{:else}
									<button
										class="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/15 text-white/55 transition hover:border-primary/30 hover:text-primary"
										onclick={() => saveToFavorites(station)}
										title="Save to favorites"
										aria-label={`Save ${cleanStationName(station.name)}`}
									>
										<Heart class="size-4" />
									</button>
								{/if}
							</div>

							<div class="relative mt-7">
								<p class="truncate text-base font-semibold text-white">{cleanStationName(station.name)}</p>
								<p class="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{station.editorial}</p>
							</div>

							<div class="relative mt-5 flex items-end justify-between gap-3 border-t border-white/[0.07] pt-3">
								<div class="min-w-0">
									<p class="truncate text-[11px] font-medium text-white/70">{station.quality}</p>
									<p class="mt-1 truncate text-[10px] text-primary/65">Station profile · {station.adLabel}</p>
									<p class="mt-1 truncate text-[10px] text-white/35">{stationMeta(station)}</p>
								</div>
								<button
									class="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/10 transition hover:scale-105 hover:bg-primary/90 active:scale-95"
									onclick={() => playSearchResult(station)}
									aria-label={isSearchStationActive(station) ? `Stop ${cleanStationName(station.name)}` : `Play ${cleanStationName(station.name)}`}
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
			</div>
		{/if}
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
								aria-label={isStationActive(station.id) ? `Stop ${cleanStationName(station.name)}` : `Play ${cleanStationName(station.name)}`}
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
									<p class="truncate text-sm font-medium">{cleanStationName(station.name)}</p>
									<span class={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} title={stationHealthLabel(station)}></span>
									{#if isStationActive(station.id) && !player.state.is_buffering}<span class="size-2 shrink-0 animate-pulse rounded-full bg-primary"></span>{/if}
								</div>
								<p class="mt-0.5 truncate text-xs text-muted-foreground">
									{[station.country, station.codec, station.bitrate ? `${station.bitrate} kbps` : null].filter(Boolean).join(' · ')}
								</p>
								<p class={`mt-1 truncate text-[11px] ${healthTextClass(health)}`}>{stationHealthLabel(station)}</p>
							</div>
							<Button variant="ghost" size="icon" class="size-9 shrink-0 text-muted-foreground hover:text-destructive" onclick={() => removeFavorite(station)} title="Remove from favorites" aria-label={`Remove ${cleanStationName(station.name)} from favorites`}>
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
				{#each DIRECTORY_GENRES as genre (genre.label)}
					<button class="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary" onclick={() => searchGenre(genre.label)} title={genre.tags.join(', ')}>
						{genre.label}
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
								<button class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:scale-105 hover:bg-primary/90 active:scale-95" onclick={() => playSearchResult(station)} aria-label={isSearchStationActive(station) ? `Stop ${cleanStationName(station.name)}` : `Play ${cleanStationName(station.name)}`}>
									{#if isSearchStationActive(station)}
										{#if player.state.is_buffering}<LoaderCircle class="size-4 animate-spin" />{:else}<Square class="size-4 fill-current" />{/if}
									{:else}<Play class="size-4 fill-current pl-0.5" />{/if}
								</button>
								<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-[10px] text-muted-foreground max-[420px]:hidden">
									{#if resultContext === 'browse'}#{String(index + 1).padStart(2, '0')}{:else}<Radio class="size-4" />{/if}
								</div>
								<div class="min-w-0 flex-1 overflow-hidden">
									<div class="flex min-w-0 items-center gap-2">
										<p class="truncate text-sm font-medium">{cleanStationName(station.name)}</p>
										<span class={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} title={resultHealthLabel(station)}></span>
									</div>
									<p class="mt-0.5 truncate text-xs text-muted-foreground">{[snapshot.country, snapshot.language, snapshot.codec, directorySort !== 'quality' && snapshot.bitrate ? `${snapshot.bitrate} kbps` : null].filter(Boolean).join(' · ')}</p>
									<StationMetrics station={snapshot} metric={directorySort} className="mt-1" />
									{#if health !== 'unknown'}
										<p class={`mt-1 truncate text-[11px] ${healthTextClass(health)}`}>{resultHealthLabel(station)}</p>
									{/if}
								</div>
								{#if isStationSaved(station)}
									<span class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-[11px] font-medium text-primary" title="Saved to favorites" aria-label={`${cleanStationName(station.name)} is saved`}>
										<Check class="size-3.5" />
										<span class="hidden sm:inline">Saved</span>
									</span>
								{:else}
									<Button variant="ghost" size="icon" class="size-9 shrink-0 text-muted-foreground" onclick={() => saveToFavorites(station)} title="Save to favorites" aria-label={`Save ${cleanStationName(station.name)}`}>
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

	.station-rail {
		scrollbar-width: none;
	}

	.station-rail::-webkit-scrollbar {
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
