<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import SourceIcon from '$lib/components/source-icon.svelte';
	import * as api from '$lib/api/tauri';
	import type { ExternalSearchResult } from '$lib/api/tauri';
	import { formatTime } from '$lib/state/player.svelte';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Search, Play, Heart, Download } from '@lucide/svelte';

	let query = $state('');
	let externalResults = $state<ExternalSearchResult[]>([]);
	let searchingExternal = $state(false);
	let externalDebounceTimer: ReturnType<typeof setTimeout>;
	let externalSearchRequest = 0;
	let pendingExternalActions = $state<Record<string, 'play' | 'save' | 'download'>>({});
	let savedIds = $state<Set<string>>(new Set());
	let externalError = $state('');
	let sidecarReady = $state(false);
	let sidecarStartPromise: Promise<void> | null = null;
	let activeExternalQuery = '';
	let queuedExternalQuery = '';
	let lastCompletedExternalQuery = '';

	const MIN_QUERY_LENGTH = 2;
	const EXTERNAL_SEARCH_DEBOUNCE_MS = 520;

	onMount(() => {
		let disposed = false;
		const cleanups: Array<() => void> = [];

		void ensureSidecarReady().catch(() => {
			sidecarReady = false;
		});

		void api.listenExternalSearchPartial((payload) => {
			if (disposed || payload.query !== query.trim()) return;
			externalError = '';
			externalResults = mergeExternalResults(externalResults, payload.results);
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			cleanups.push(unlisten);
		});

		void api.listenExternalSearchComplete((payload) => {
			if (disposed || payload.query !== query.trim()) return;
			externalResults = payload.results;
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			cleanups.push(unlisten);
		});

		return () => {
			disposed = true;
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	});

	$effect(() => {
		const trimmedQuery = query.trim();
		clearTimeout(externalDebounceTimer);

		if (trimmedQuery.length < MIN_QUERY_LENGTH) {
			externalSearchRequest += 1;
			externalResults = [];
			searchingExternal = false;
			externalError = '';
			activeExternalQuery = '';
			queuedExternalQuery = '';
			lastCompletedExternalQuery = '';
			return;
		}

		externalError = '';
		scheduleExternalSearch(trimmedQuery);

		return () => clearTimeout(externalDebounceTimer);
	});

	function computeExternalSearchDelay(searchQuery: string): number {
		if (searchQuery.length >= 24) return 820;
		if (searchQuery.length >= 12) return 680;
		return EXTERNAL_SEARCH_DEBOUNCE_MS;
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

	function scheduleExternalSearch(searchQuery: string) {
		clearTimeout(externalDebounceTimer);
		externalDebounceTimer = setTimeout(() => {
			if (activeExternalQuery) {
				queuedExternalQuery = searchQuery;
				return;
			}
			void searchExternal(searchQuery);
		}, computeExternalSearchDelay(searchQuery));
	}

	async function searchExternal(searchQuery = query.trim()) {
		if (!searchQuery || searchQuery.length < MIN_QUERY_LENGTH) return;
		if (searchQuery === lastCompletedExternalQuery && !externalError) return;

		const requestId = ++externalSearchRequest;
		activeExternalQuery = searchQuery;
		queuedExternalQuery = '';
		searchingExternal = true;
		externalResults = [];
		try {
			await ensureSidecarReady();
			const results = await api.searchAllSources(searchQuery);
			if (requestId === externalSearchRequest && query.trim() === searchQuery) {
				externalResults = results;
				externalError = '';
			}
			lastCompletedExternalQuery = searchQuery;
		} catch (e) {
			if (requestId === externalSearchRequest && query.trim() === searchQuery) {
				externalResults = [];
				externalError = `Search is unavailable${e ? `: ${e}` : ''}`;
			}
		} finally {
			if (activeExternalQuery === searchQuery) activeExternalQuery = '';
			if (queuedExternalQuery && queuedExternalQuery !== searchQuery) {
				const nextQuery = queuedExternalQuery;
				queuedExternalQuery = '';
				void searchExternal(nextQuery);
				return;
			}
			if (requestId === externalSearchRequest) searchingExternal = false;
		}
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		const trimmedQuery = query.trim();
		if (trimmedQuery.length < MIN_QUERY_LENGTH) return;
		clearTimeout(externalDebounceTimer);
		queuedExternalQuery = '';
		lastCompletedExternalQuery = '';
		if (activeExternalQuery) {
			queuedExternalQuery = trimmedQuery;
			return;
		}
		void searchExternal(trimmedQuery);
	}

	async function playExternalTrack(result: ExternalSearchResult) {
		await runExternalAction(result, 'play', async () => {
			await api.playExternal(
				result.source,
				result.source_id,
				result.title,
				result.artist,
				result.duration_ms ?? undefined,
				result.cover_art_url ?? undefined
			);
			toast.success(`Playing: ${result.title}`);
		});
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

	async function downloadExternal(result: ExternalSearchResult) {
		await runExternalAction(result, 'download', async () => {
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
		});
	}

	function externalResultKey(result: ExternalSearchResult): string {
		return `${result.source}:${result.source_id}`;
	}

	function isExternalActionPending(result: ExternalSearchResult): boolean {
		return Boolean(pendingExternalActions[externalResultKey(result)]);
	}

	function isSaved(result: ExternalSearchResult): boolean {
		return savedIds.has(externalResultKey(result));
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
</style>

<div class="flex min-w-0 flex-col gap-4">
	<h1 class="text-2xl font-bold">Search</h1>

	<div class="relative">
		<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
		<Input
			placeholder="Search YouTube, SoundCloud, Bandcamp..."
			class="pl-10"
			bind:value={query}
			onkeydown={handleSearchKeydown}
			autofocus
		/>
	</div>

	{#if searchingExternal}
		<p class="py-8 text-center text-muted-foreground">Searching...</p>
	{:else if externalError}
		<p class="py-8 text-center text-sm text-destructive">{externalError}</p>
	{:else if externalResults.length > 0}
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
				{#each externalResults as result}
					<Table.Row class="cursor-pointer hover:bg-muted/50" ondblclick={() => playExternalTrack(result)}>
						<Table.Cell>
							<SourceIcon source={result.source} size={18} />
						</Table.Cell>
						<Table.Cell class="overflow-hidden">
							<div class="flex min-w-0 items-center gap-2">
								{#if result.cover_art_url}
									<img src={result.cover_art_url} alt="" class="size-8 shrink-0 rounded object-cover" loading="lazy" decoding="async" width="32" height="32" />
								{/if}
								<span class="block flex-1 truncate font-medium">{result.title}</span>
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
									disabled={isExternalActionPending(result)}
									onclick={() => downloadExternal(result)}
								>
									<Download class="size-3" />
								</Button>
							</div>
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{:else if query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH}
		<p class="py-8 text-center text-muted-foreground">
			Type at least {MIN_QUERY_LENGTH} characters to search.
		</p>
	{:else if query.trim().length >= MIN_QUERY_LENGTH}
		<p class="py-8 text-center text-muted-foreground">
			No results for "{query}".
		</p>
	{:else}
		<p class="py-8 text-center text-muted-foreground">
			Search YouTube, SoundCloud, and Bandcamp from one place.
		</p>
	{/if}
</div>
