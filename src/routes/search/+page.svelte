<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import SourceIcon from '$lib/components/source-icon.svelte';
	import SearchDiscoveryFeedView from '$lib/components/search/search-discovery-feed.svelte';
	import * as api from '$lib/api/tauri';
	import type {
		ExternalSearchResult,
		SearchDiscoveryFeed,
		SearchDiscoveryItem
	} from '$lib/api/tauri';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import { Search, Play, Pause, Heart, Download, LoaderCircle, X, CheckCircle2 } from '@lucide/svelte';

	const player = usePlayer();
	import { useSearchState } from '$lib/state/search.svelte';

	type SearchSourcePreference = 'all' | 'youtube' | 'soundcloud' | 'bandcamp';
	type ProviderSource = Exclude<SearchSourcePreference, 'all'>;

	const SEARCH_SOURCES: ProviderSource[] = ['youtube', 'soundcloud', 'bandcamp'];
	const SOURCE_LABELS: Record<SearchSourcePreference, string> = {
		all: 'Best',
		youtube: 'YouTube',
		soundcloud: 'SoundCloud',
		bandcamp: 'Bandcamp'
	};

	const searchState = useSearchState();
	let query = $state(searchState.query);
	let externalResults = $state<ExternalSearchResult[]>(searchState.results as ExternalSearchResult[]);
	let searchingExternal = $state(false);
	let loadingMore = $state(false);
	let externalSearchRequest = 0;
	let pendingExternalActions = $state<Record<string, 'play' | 'save' | 'download'>>({});
	let savedIds = $state<Set<string>>(new Set());
	let externalError = $state('');
	let sidecarReady = $state(false);
	let sidecarStartPromise: Promise<void> | null = null;
	let activeExternalQuery = '';
	let handledUrlQuery = '';
	let completedExternalQuery = $state(
		searchState.results.length > 0 ? searchState.query.trim() : ''
	);
	let sourcePreference = $state<SearchSourcePreference>(searchState.sourcePreference as SearchSourcePreference || 'all');
	let loadMoreSentinel = $state<HTMLDivElement | null>(null);
	let nextPageBySource = $state<Record<ProviderSource, number>>({
		youtube: 1,
		soundcloud: 1,
		bandcamp: 1
	});
	let sourceHasMore = $state<Record<ProviderSource, boolean>>({
		youtube: true,
		soundcloud: true,
		bandcamp: true
	});
	let discoveryFeed = $state<SearchDiscoveryFeed | null>(null);
	let loadingDiscoveryFeed = $state(true);
	let queueAppendGeneration = 0;
	let activeQueueSelection:
		| {
			recordingId: string | null;
				source: string;
				title: string;
				artist: string;
				previous: {
					recordingId: string | null;
					source: string | null;
					title: string | null;
					artist: string | null;
				};
			  }
		| null = null;

	const MIN_QUERY_LENGTH = 2;
	onMount(() => {
		let disposed = false;
		const cleanups: Array<() => void> = [];

		void api.getSearchDiscoveryFeed()
			.then((feed) => {
				if (!disposed) discoveryFeed = feed;
			})
			.catch(() => {
				if (!disposed) discoveryFeed = null;
			})
			.finally(() => {
				if (!disposed) loadingDiscoveryFeed = false;
			});

		void ensureSidecarReady().catch(() => {
			sidecarReady = false;
		});

		void api.listenExternalSearchPartial((payload) => {
			if (
				disposed ||
				payload.request_id !== String(externalSearchRequest) ||
				payload.query !== query.trim()
			) return;
			externalResults = mergeExternalResults(externalResults, payload.results);
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			cleanups.push(unlisten);
		});

		void api.listenExternalSearchComplete((payload) => {
			if (
				disposed ||
				payload.request_id !== String(externalSearchRequest) ||
				payload.query !== query.trim()
			) return;
			externalResults = payload.results;
			completedExternalQuery = payload.query;
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			cleanups.push(unlisten);
		});

		return () => {
			disposed = true;
			invalidateQueueAppender();
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	});

	let currentPage = $state(1);

	// Sync state to persistent store
	$effect(() => { searchState.query = query; });
	$effect(() => { searchState.results = externalResults; });
	$effect(() => { searchState.sourcePreference = sourcePreference; });
	$effect(() => {
		const urlQuery = (page.url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
		if (urlQuery.length < MIN_QUERY_LENGTH || urlQuery === handledUrlQuery) return;
		handledUrlQuery = urlQuery;
		if (query.trim() === urlQuery && completedExternalQuery === urlQuery && externalResults.length > 0) {
			return;
		}
		startNewSearch(urlQuery, false);
	});
	$effect(() => {
		const selection = {
			recordingId: player.state.current_recording_id,
			source: player.state.source,
			title: player.state.current_title,
			artist: player.state.current_artist
		};

		if (!activeQueueSelection) return;

		const isActiveSearchSelection = activeQueueSelection.recordingId !== null
			? selection.recordingId === activeQueueSelection.recordingId
			: selection.source === activeQueueSelection.source &&
				selection.title === activeQueueSelection.title &&
				selection.artist === activeQueueSelection.artist;
		const isPreviousSelectionWhileResolving = activeQueueSelection.recordingId === null &&
			selection.recordingId === activeQueueSelection.previous.recordingId &&
			selection.source === activeQueueSelection.previous.source &&
			selection.title === activeQueueSelection.previous.title &&
			selection.artist === activeQueueSelection.previous.artist;

		if (!isActiveSearchSelection && !isPreviousSelectionWhileResolving) {
			invalidateQueueAppender();
		}
	});


	function resetPaginationState() {
		nextPageBySource = {
			youtube: 1,
			soundcloud: 1,
			bandcamp: 1
		};
		sourceHasMore = {
			youtube: true,
			soundcloud: true,
			bandcamp: true
		};
	}

	function mergeExternalResults(
		current: ExternalSearchResult[],
		incoming: ExternalSearchResult[]
	): ExternalSearchResult[] {
		if (incoming.length === 0) {
			return current;
		}

		const merged = [...current];
		const positions = new Map(
			merged.map((result, index) => [externalResultKey(result), index] as const)
		);

		for (const result of incoming) {
			const key = externalResultKey(result);
			const existingIndex = positions.get(key);
			if (existingIndex === undefined) {
				positions.set(key, merged.length);
				merged.push(result);
				continue;
			}

			merged[existingIndex] = result;
		}

		return merged;
	}

	function preferredSourceOrder(): ProviderSource[] {
		if (sourcePreference === 'all') {
			return SEARCH_SOURCES;
		}

		return [sourcePreference, ...SEARCH_SOURCES.filter((source) => source !== sourcePreference)];
	}

	function displayedResults(): ExternalSearchResult[] {
		if (sourcePreference === 'all') {
			return externalResults;
		}

		const order = preferredSourceOrder();
		const positions = new Map(order.map((source, index) => [source, index] as const));

		return [...externalResults].sort((left, right) => {
			return (positions.get(left.source as ProviderSource) ?? 99)
				- (positions.get(right.source as ProviderSource) ?? 99);
		});
	}

	function sourceResultCount(source: ProviderSource): number {
		return externalResults.filter((result) => result.source === source).length;
	}

	function sourcePreferenceLabel(source: SearchSourcePreference): string {
		const label = SOURCE_LABELS[source];
		if (source === 'all') {
			return label;
		}
		return `${label} ${sourceResultCount(source)}`;
	}

	function canLoadMore(): boolean {
		return SEARCH_SOURCES.some((source) => sourceHasMore[source]);
	}

	async function ensureSidecarReady() {
		if (sidecarReady) return;
		if (!sidecarStartPromise) {
			sidecarStartPromise = api
				.startSidecar()
				.then(() => { sidecarReady = true; })
				.finally(() => { sidecarStartPromise = null; });
		}
		await sidecarStartPromise;
	}

	function formatExternalSearchError(error: unknown, hasResults: boolean): string {
		const detail = error instanceof Error ? error.message : String(error ?? '').trim();
		if (hasResults) {
			return `Some music sources could not finish. Showing the results that did arrive${detail ? `: ${detail}` : '.'}`;
		}
		return `Search is unavailable${detail ? `: ${detail}` : ''}`;
	}

	function formatProviderWarning(failedSources: string[]): string {
		const labels = [...new Set(failedSources)]
			.map((source) => SOURCE_LABELS[source as ProviderSource] ?? source)
			.sort();
		const joined = labels.length > 2
			? `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
			: labels.join(' and ');
		const verb = labels.length === 1 ? 'is' : 'are';
		return `Some music sources could not finish. Showing the results that did arrive: ${joined || 'another provider'} ${verb} temporarily unavailable.`;
	}

	async function searchExternal(searchQuery = query.trim()) {
		searchQuery = searchQuery.trim().replace(/\s+/g, ' ');
		if (!searchQuery || searchQuery.length < MIN_QUERY_LENGTH) return;
		if (activeExternalQuery === searchQuery) return;

		const requestId = ++externalSearchRequest;
		activeExternalQuery = searchQuery;
		searchingExternal = true;
		externalError = '';
		completedExternalQuery = '';
		resetPaginationState();
		try {
			await ensureSidecarReady();
			const response = await api.searchAllSources(searchQuery, String(requestId));
			if (requestId === externalSearchRequest) {
				externalResults = response.items;
				externalError = response.failed_sources.length > 0 && response.items.length > 0
					? formatProviderWarning(response.failed_sources)
					: '';
				completedExternalQuery = searchQuery;
			}
		} catch (e) {
			if (requestId === externalSearchRequest) {
				// The managed provider process may have exited after it was first
				// started. Force the next attempt to health-check it, and never erase
				// useful partial results that arrived before another provider failed.
				sidecarReady = false;
				externalError = formatExternalSearchError(e, externalResults.length > 0);
				completedExternalQuery = externalResults.length > 0 ? searchQuery : '';
			}
		} finally {
			if (requestId === externalSearchRequest) {
				activeExternalQuery = '';
				searchingExternal = false;
			}
		}
	}

	const RESULTS_PER_PAGE = 40;
	let totalPages = $derived(Math.max(1, Math.ceil(displayedResults().length / RESULTS_PER_PAGE)));
	let pagedResults = $derived(displayedResults().slice((currentPage - 1) * RESULTS_PER_PAGE, currentPage * RESULTS_PER_PAGE));

	function goToPage(page: number) {
		const requestedPage = Number.isFinite(page) ? Math.trunc(page) : 1;
		currentPage = Math.min(Math.max(1, requestedPage), totalPages);
		// Scroll to top of results
		document.querySelector('[data-slot="search-results"]')?.scrollIntoView({ behavior: 'smooth' });
	}

	async function loadMoreResults(): Promise<number | null> {
		const searchQuery = query.trim();
		if (loadingMore || !searchQuery || searchQuery.length < MIN_QUERY_LENGTH) return null;

		const sourcesToLoad = SEARCH_SOURCES.filter((source) => sourceHasMore[source]);
		if (sourcesToLoad.length === 0) return null;

		const previousTotalPages = totalPages;
		loadingMore = true;
		try {
			await ensureSidecarReady();
			let addedCount = 0;

			// Load each source independently — merge results as each arrives
			await Promise.all(
				sourcesToLoad.map(async (source) => {
					try {
						const page = nextPageBySource[source];
						const response = await api.searchExternal(searchQuery, source, page);
						if (query.trim() !== searchQuery) return;

						const beforeKeys = new Set(externalResults.map((r) => externalResultKey(r)));
						externalResults = mergeExternalResults(externalResults, response.items);
						addedCount += response.items.filter((r) => !beforeKeys.has(externalResultKey(r))).length;
						sourceHasMore = { ...sourceHasMore, [source]: response.has_more && response.items.length > 0 };
						nextPageBySource = { ...nextPageBySource, [source]: page + 1 };
					} catch {
						// Individual source failure — don't block others
						sourceHasMore = { ...sourceHasMore, [source]: false };
					}
				})
			);

			if (addedCount === 0) {
				toast.info('No more results available');
				return null;
			}

			const nextTotalPages = Math.max(1, Math.ceil(displayedResults().length / RESULTS_PER_PAGE));
			return nextTotalPages > previousTotalPages ? previousTotalPages + 1 : null;
		} catch (error) {
			toast.error(`Failed to load more: ${error}`);
			return null;
		} finally {
			loadingMore = false;
		}
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		const trimmedQuery = query.trim();
		if (trimmedQuery.length < MIN_QUERY_LENGTH) return;
		startNewSearch(trimmedQuery, true);
	}

	function syncSearchUrl(searchQuery: string) {
		handledUrlQuery = searchQuery;
		void goto(`/search?q=${encodeURIComponent(searchQuery)}`, {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	}

	function startNewSearch(searchQuery: string, updateUrl: boolean) {
		const nextQuery = searchQuery.trim().replace(/\s+/g, ' ');
		if (nextQuery.length < MIN_QUERY_LENGTH) return;
		query = nextQuery;
		sourcePreference = 'all';
		externalResults = [];
		externalError = '';
		completedExternalQuery = '';
		currentPage = 1;
		resetPaginationState();
		if (updateUrl) syncSearchUrl(nextQuery);
		void searchExternal(nextQuery);
	}

	function clearSearch() {
		query = '';
		externalResults = [];
		externalError = '';
		searchingExternal = false;
		completedExternalQuery = '';
		activeExternalQuery = '';
		currentPage = 1;
		resetPaginationState();
		externalSearchRequest += 1;
		handledUrlQuery = '';
		void goto('/search', { replaceState: true, noScroll: true, keepFocus: true });
	}

	function searchDiscoveryItem(item: SearchDiscoveryItem) {
		const nextQuery = item.search_query.trim();
		if (nextQuery.length < MIN_QUERY_LENGTH) return;

		startNewSearch(nextQuery, true);
	}

	async function playExternalTrack(result: ExternalSearchResult) {
		const generation = invalidateQueueAppender();
		activeQueueSelection = {
			recordingId: null,
			source: result.source,
			title: result.title,
			artist: result.artist,
			previous: {
				recordingId: player.state.current_recording_id,
				source: player.state.source,
				title: player.state.current_title,
				artist: player.state.current_artist
			}
		};

		await runExternalAction(result, 'play', async () => {
			// Play the clicked track immediately
			const recordingId = await api.playExternal(
				result.source,
				result.source_id,
				result.title,
				result.artist,
				result.duration_ms ?? undefined,
				result.cover_art_url ?? undefined
			);
			if (generation !== queueAppendGeneration) return;
			if (activeQueueSelection) activeQueueSelection.recordingId = recordingId;
			toast.success(`Playing: ${result.title}`);

			// Queue the rest of the visible page in the background
			const currentResults = pagedResults;
			const clickedIndex = currentResults.findIndex(r => externalResultKey(r) === externalResultKey(result));
			const tracksAfter = currentResults.slice(clickedIndex + 1);
			if (tracksAfter.length > 0) {
				// Fire and forget — don't block playback
				void queueRemainingTracks(tracksAfter, generation);
			}
		});
	}

	function invalidateQueueAppender(): number {
		activeQueueSelection = null;
		return ++queueAppendGeneration;
	}

	async function queueRemainingTracks(tracks: ExternalSearchResult[], generation: number) {
		for (const track of tracks) {
			if (generation !== queueAppendGeneration) return;
			try {
				const recordingId = await api.ensureExternalRecording(
					track.source,
					track.source_id,
					track.title,
					track.artist,
					track.duration_ms ?? undefined,
					track.cover_art_url ?? undefined
				);
				if (generation !== queueAppendGeneration) return;
				await player.addToQueue(recordingId);
			} catch {
				// Skip tracks that fail to resolve — don't break the queue
			}
		}
	}

	async function saveExternal(result: ExternalSearchResult) {
		const key = externalResultKey(result);
		// Optimistic: immediately show as saved
		savedIds = new Set([...savedIds, key]);
		try {
			const recordingId = await api.ensureExternalRecording(
				result.source,
				result.source_id,
				result.title,
				result.artist,
				result.duration_ms ?? undefined,
				result.cover_art_url ?? undefined
			);
			await api.saveToLibrary(recordingId);
			toast.success(`Saved "${result.title}" to library`);
		} catch (e) {
			// Rollback on failure
			savedIds = new Set([...savedIds].filter(id => id !== key));
			toast.error(`Failed to save: ${e}`);
		}
	}

	let downloadedIds = $state<Set<string>>(new Set());

	async function downloadExternal(result: ExternalSearchResult) {
		const key = externalResultKey(result);
		// Optimistic: immediately show as downloaded + saved
		downloadedIds = new Set([...downloadedIds, key]);
		savedIds = new Set([...savedIds, key]);
		try {
			const recordingId = await api.ensureExternalRecording(
				result.source,
				result.source_id,
				result.title,
				result.artist,
				result.duration_ms ?? undefined,
				result.cover_art_url ?? undefined
			);
			await api.downloadRecording(recordingId);
			toast.success(`Download queued: ${result.title}`);
		} catch (e) {
			downloadedIds = new Set([...downloadedIds].filter(id => id !== key));
			toast.error(`Failed to download: ${e}`);
		}
	}

	function isDownloadedLocal(result: ExternalSearchResult): boolean {
		return downloadedIds.has(externalResultKey(result));
	}

	function externalResultKey(result: ExternalSearchResult): string {
		return `${result.source}:${result.source_id}`;
	}

	function isExternalActionPending(result: ExternalSearchResult): boolean {
		return Boolean(pendingExternalActions[externalResultKey(result)]);
	}

	function isSaved(result: ExternalSearchResult): boolean {
		return result.is_saved || savedIds.has(externalResultKey(result));
	}

	function isDownloaded(result: ExternalSearchResult): boolean {
		return Boolean(result.is_downloaded);
	}

	async function runExternalAction(
		result: ExternalSearchResult,
		action: 'play' | 'save' | 'download',
		task: () => Promise<void>
	) {
		const key = externalResultKey(result);
		if (pendingExternalActions[key]) return;
		pendingExternalActions = { ...pendingExternalActions, [key]: action };
		try {
			await task();
		} catch (e) {
			const label = action === 'download' ? 'queue download' : action;
			toast.error(`Failed to ${label}: ${e}`);
		} finally {
			const { [key]: _removed, ...rest } = pendingExternalActions;
			pendingExternalActions = rest;
		}
	}
</script>

<style>
	@keyframes heart-pulse {
		0% { transform: scale(1); }
		50% { transform: scale(1.3); }
		100% { transform: scale(1); }
	}
	:global(.heart-saved) {
		animation: heart-pulse 0.3s ease-out;
	}
	@keyframes searchbar {
		0% { transform: translateX(0); }
		100% { transform: translateX(150%); }
	}
</style>

<div class="flex min-w-0 flex-col gap-4">
	<h1 class="text-2xl font-bold">Search</h1>

	<div class="relative">
		<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
		<Input
			placeholder="Search songs, artists..."
			class="pl-10 pr-44"
			bind:value={query}
			onkeydown={handleSearchKeydown}
			autofocus
		/>
		{#if query.length > 0}
			<button
				class="absolute right-24 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
				onclick={clearSearch}
				aria-label="Clear search"
			>
				<X class="size-4" />
			</button>
		{/if}
		{#if searchingExternal}
			<span class="absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 text-xs text-primary">
				<LoaderCircle class="size-3.5 animate-spin" />
				Searching...
			</span>
		{:else if query.trim().length >= MIN_QUERY_LENGTH}
			<span class="absolute right-3 top-1/2 -translate-y-1/2 rounded bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">Enter to search</span>
		{/if}
	</div>

	{#if searchingExternal}
		<div style="height: 3px; border-radius: 9999px; overflow: hidden; background: #2a2a3a;">
			<div style="height: 100%; width: 40%; background: oklch(0.75 0.18 160); border-radius: 9999px; animation: searchbar 1s ease-in-out infinite alternate;"></div>
		</div>
	{/if}

	{#if query.trim().length >= MIN_QUERY_LENGTH && externalResults.length > 0}
		<div class="flex items-center gap-1.5">
			{#each (['all', 'youtube', 'soundcloud', 'bandcamp'] as SearchSourcePreference[]) as source}
				<button
					class="rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors {sourcePreference === source
						? 'bg-primary text-primary-foreground'
						: 'bg-muted/50 text-muted-foreground hover:text-foreground'}"
					onclick={() => { sourcePreference = source; }}
				>
					{#if source === 'all'}
						All {externalResults.length}
					{:else}
						<span class="inline-flex items-center gap-1">
							<SourceIcon {source} size={12} />
							{sourceResultCount(source)}
						</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}

	{#if externalError && externalResults.length > 0}
		<div class="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2" role="status">
			<p class="text-xs text-muted-foreground">{externalError}</p>
			<Button variant="outline" size="sm" onclick={() => void searchExternal(query.trim())}>
				Retry missing sources
			</Button>
		</div>
	{/if}

	{#if externalResults.length > 0}
		<div data-slot="search-results"></div>
		<Table.Root class="table-fixed">
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-10"></Table.Head>
					<Table.Head>Title</Table.Head>
					<Table.Head class="w-[20%]">Artist</Table.Head>
					<Table.Head class="w-16 text-right">Duration</Table.Head>
					<Table.Head class="w-28">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each pagedResults as result}
					{@const isPlaying = player.state.current_title === result.title && player.state.current_artist === result.artist && player.state.is_playing}
					{@const isCurrent = player.state.current_title === result.title && player.state.current_artist === result.artist}
					<Table.Row class="cursor-pointer hover:bg-muted/50" ondblclick={() => playExternalTrack(result)}>
						<Table.Cell>
							{#if isCurrent}
								<button
									class="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground"
									onclick={() => player.togglePlay()}
								>
									{#if isPlaying}
										<Pause class="size-3.5" />
									{:else}
										<Play class="size-3.5 pl-0.5" />
									{/if}
								</button>
							{:else}
								<SourceIcon source={result.source} size={18} />
							{/if}
						</Table.Cell>
						<Table.Cell class="overflow-hidden">
							<div class="flex min-w-0 items-center gap-2">
								{#if result.cover_art_url}
									<img src={result.cover_art_url} alt="" class="size-8 shrink-0 rounded object-cover" loading="lazy" decoding="async" width="32" height="32" />
								{/if}
								<span class="block flex-1 truncate font-medium {isCurrent ? 'text-primary' : ''}">{result.title}</span>
							</div>
						</Table.Cell>
						<Table.Cell class="text-muted-foreground">
							<div class="truncate">{result.artist}</div>
						</Table.Cell>
						<Table.Cell class="text-right text-muted-foreground">
							{result.duration_ms ? formatTime(result.duration_ms) : '--:--'}
						</Table.Cell>
						<Table.Cell>
							<div class="flex gap-1">
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									disabled={isExternalActionPending(result)}
									onclick={() => playExternalTrack(result)}
								>
									<Play class="size-3" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7 {isSaved(result) ? 'heart-saved' : ''}"
									disabled={isExternalActionPending(result)}
									onclick={() => saveExternal(result)}
								>
									<Heart class="size-3 {isSaved(result) ? 'fill-primary text-primary' : ''}" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									disabled={isExternalActionPending(result) || isDownloaded(result) || isDownloadedLocal(result)}
									onclick={() => downloadExternal(result)}
									title={isDownloaded(result) || isDownloadedLocal(result) ? 'Downloaded' : 'Download'}
								>
									{#if isDownloaded(result) || isDownloadedLocal(result)}
										<CheckCircle2 class="size-3 text-primary" />
									{:else}
										<Download class="size-3" />
									{/if}
								</Button>
							</div>
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
		<!-- Pagination -->
		<div class="flex items-center justify-center gap-3 py-3">
			<button
				class="rounded-md px-3 py-1 text-sm transition-colors {currentPage > 1 ? 'text-foreground hover:bg-muted' : 'text-muted-foreground/40 cursor-default'}"
				disabled={currentPage <= 1}
				onclick={() => goToPage(currentPage - 1)}
			>
				Previous
			</button>
			<span class="text-xs text-muted-foreground">Page {currentPage} of {totalPages}</span>
			{#if currentPage < totalPages}
				<button
					class="rounded-md px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted"
					onclick={() => goToPage(currentPage + 1)}
				>
					Next
				</button>
			{:else if canLoadMore()}
				<button
					class="rounded-md px-3 py-1 text-sm text-primary transition-colors hover:bg-primary/10"
					disabled={loadingMore}
					onclick={async () => {
						const firstNewPage = await loadMoreResults();
						if (firstNewPage !== null) goToPage(firstNewPage);
					}}
				>
					{#if loadingMore}
						<span class="inline-flex items-center gap-1"><LoaderCircle class="size-3 animate-spin" /> Loading...</span>
					{:else}
						Load more results
					{/if}
				</button>
			{:else}
				<span class="text-xs text-muted-foreground">End of results</span>
			{/if}
		</div>
	{:else if searchingExternal}
		<div class="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
			<LoaderCircle class="size-5 animate-spin text-primary" />
			<p>Searching YouTube, SoundCloud, and Bandcamp for “{query}”…</p>
		</div>
	{:else if externalError}
		<div class="flex flex-col items-center gap-3 py-8 text-center">
			<p class="max-w-xl text-sm text-destructive">{externalError}</p>
			<Button variant="outline" size="sm" onclick={() => void searchExternal(query.trim())}>
				Retry search
			</Button>
		</div>
	{:else if query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH}
		<p class="py-8 text-center text-muted-foreground">
			Type at least {MIN_QUERY_LENGTH} characters to search.
		</p>
	{:else if query.trim().length >= MIN_QUERY_LENGTH && completedExternalQuery === query.trim()}
		<p class="py-8 text-center text-muted-foreground">
			No results for "{query}".
		</p>
	{:else if query.trim().length >= MIN_QUERY_LENGTH}
		<p class="py-8 text-center text-sm text-muted-foreground">
			Press Enter to search every music source.
		</p>
	{:else}
		<SearchDiscoveryFeedView
			feed={discoveryFeed}
			loading={loadingDiscoveryFeed}
			onselect={searchDiscoveryItem}
		/>
	{/if}
</div>
