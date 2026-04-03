<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as api from '$lib/api/tauri';
	import type { RadioBrowserStation } from '$lib/api/tauri';
	import type { Station } from '$lib/types';
	import { usePlayer } from '$lib/state/player.svelte';
	import { toast } from 'svelte-sonner';
	import { Radio, Search, Heart, HeartOff, Play, Square, Globe, LoaderCircle, RefreshCw } from '@lucide/svelte';

	const player = usePlayer();

	const genres = [
		'DnB', 'Hip Hop', 'Techno', 'House', 'Jazz', 'Lo-fi',
		'Ambient', 'Classical', 'Rock', 'Metal', 'Reggae', 'Soul',
		'R&B', 'Pop', 'Trance', 'Chillout', 'Latin', 'Blues'
	];

	let query = $state('');
	let results = $state<RadioBrowserStation[]>([]);
	let favorites = $state<Station[]>([]);
	let savedStationIds = $state<Set<string>>(new Set());
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout>;
	let favoritesError = $state('');
	let searchError = $state('');
	let searchRequest = 0;
	let verifyingStations = $state(false);

	$effect(() => {
		loadFavorites();
	});

	async function loadFavorites() {
		try {
			favorites = await api.getFavoriteStations();
			favoritesError = '';
		} catch (error) {
			favorites = [];
			favoritesError = `Favorites are unavailable${error ? `: ${error}` : ''}`;
		}
	}

	$effect(() => {
		const trimmedQuery = query.trim();
		clearTimeout(debounceTimer);

		if (trimmedQuery.length > 1) {
			searchError = '';
			const requestId = ++searchRequest;
			debounceTimer = setTimeout(() => void searchStations(trimmedQuery, requestId), 300);
		} else {
			searchRequest += 1;
			results = [];
			searchError = '';
			searching = false;
		}

		return () => clearTimeout(debounceTimer);
	});

	async function searchStations(searchQuery = query.trim(), requestId = ++searchRequest) {
		if (!searchQuery) return;
		searching = true;
		try {
			const nextResults = await api.searchRadioStations(searchQuery);
			if (requestId === searchRequest) {
				results = nextResults;
				searchError = '';
			}
		} catch (e) {
			if (requestId === searchRequest) {
				results = [];
				searchError = `Failed to search stations${e ? `: ${e}` : ''}`;
			}
		} finally {
			if (requestId === searchRequest) {
				searching = false;
			}
		}
	}

	async function playSearchResult(station: RadioBrowserStation) {
		try {
			if (isStationActive(station.url)) {
				await stopPlaying();
				return;
			}
			await api.playStationSearchResult(station);
			toast.success(`Playing: ${station.name}`);
		} catch (e) {
			toast.error(`Failed to play station: ${e}`);
		}
	}

	async function playFavorite(station: Station) {
		try {
			if (isStationActive(station.url)) {
				await stopPlaying();
				return;
			}
			await api.playStation(
				station.id,
				station.url,
				station.name,
				station.favicon_url ?? undefined
			);
			toast.success(`Playing: ${station.name}`);
		} catch (e) {
			toast.error(`Failed to play station: ${e}`);
		}
	}

	async function stopPlaying() {
		try {
			await player.stop();
		} catch {
			// ignore
		}
	}

	function isStationActive(url: string): boolean {
		return player.state.source === 'radio' &&
			player.state.current_source_url === url &&
			(player.state.is_playing || player.state.is_buffering);
	}

	async function saveToFavorites(station: RadioBrowserStation) {
		const key = station.stationuuid || station.url;
		savedStationIds = new Set([...savedStationIds, key]);
		try {
			await api.saveStation(
				station.name,
				station.url,
				station.homepage ?? undefined,
				station.favicon ?? undefined,
				station.country ?? undefined,
				station.language ?? undefined,
				station.tags ?? undefined,
				station.codec ?? undefined,
				station.bitrate ?? undefined,
				station.stationuuid
			);
			toast.success(`Saved "${station.name}" to favorites`);
			loadFavorites();
		} catch {
			savedStationIds = new Set([...savedStationIds].filter(id => id !== key));
			toast.error('Failed to save station');
		}
	}

	function isStationSaved(station: RadioBrowserStation): boolean {
		return savedStationIds.has(station.stationuuid || station.url);
	}

	async function removeFavorite(station: Station) {
		try {
			await api.toggleStationFavorite(station.id);
			toast.success(`Removed "${station.name}" from favorites`);
			loadFavorites();
		} catch {
			toast.error('Failed to remove station');
		}
	}

	function getStationHealth(station: Station): 'ok' | 'stale' | 'dead' {
		if (station.fail_count >= 3) {
			return 'dead';
		}
		if (station.fail_count >= 1) {
			return 'stale';
		}
		return 'ok';
	}

	function stationHealthLabel(station: Station): string | null {
		switch (getStationHealth(station)) {
			case 'stale':
				return 'Station check warning';
			case 'dead':
				return 'Station may be offline';
			default:
				return null;
		}
	}

	async function verifyStations() {
		if (verifyingStations) return;

		verifyingStations = true;
		toast.info('Checking favorite stations...');
		try {
			const results = await api.verifyFavoriteStations();
			const deadCount = results.filter((result: any) => result.status === 'dead').length;
			const staleCount = results.filter((result: any) => result.status === 'stale').length;
			const okCount = results.filter((result: any) => result.status === 'ok').length;
			await loadFavorites();

			if (deadCount > 0 || staleCount > 0) {
				toast.warning(
					`Station check: ${okCount} ok, ${staleCount} stale, ${deadCount} offline`
				);
			} else {
				toast.success(`All ${okCount} stations are healthy`);
			}
		} catch (error) {
			toast.error(`Verify failed: ${error}`);
		} finally {
			verifyingStations = false;
		}
	}
</script>

<div class="flex min-w-0 flex-col gap-4">
	<h1 class="text-2xl font-bold">Radio Stations</h1>

	<div class="flex items-center gap-3">
		<div class="relative flex-1">
			<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				placeholder="Search 30,000+ stations..."
				class="pl-10"
				bind:value={query}
			/>
		</div>
		<Button
			variant="outline"
			class="shrink-0"
			disabled={verifyingStations}
			onclick={verifyStations}
		>
			{#if verifyingStations}
				<LoaderCircle class="size-4 animate-spin" />
				Verifying
			{:else}
				<RefreshCw class="size-4" />
				Verify Favorites
			{/if}
		</Button>
	</div>

	<!-- Genre presets — show when not searching -->
	{#if query.trim().length <= 1}
		<div class="flex flex-wrap gap-2">
			{#each genres as genre}
				<button
					class="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
					onclick={() => { query = genre; }}
				>
					{genre}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Favorites section -->
	{#if favoritesError && query.trim().length === 0}
		<Card class="border-dashed">
			<CardContent class="py-6 text-sm text-destructive">{favoritesError}</CardContent>
		</Card>
	{:else if favorites.length > 0 && results.length === 0}
		<div>
			<h2 class="mb-3 text-lg font-semibold">Favorites</h2>
			<div class="flex flex-col gap-2">
				{#each favorites as station}
					<Card class={`transition-colors hover:border-border hover:bg-muted/50 ${getStationHealth(station) === 'dead' ? 'border-border/60 bg-muted/30 opacity-65' : ''}`}>
						<CardContent class="flex min-w-0 items-center gap-3 p-3">
							<button
								class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
								onclick={() => isStationActive(station.url) ? stopPlaying() : playFavorite(station)}
							>
								{#if isStationActive(station.url)}
									<Square class="size-4" />
								{:else}
									<Play class="size-4 pl-0.5" />
								{/if}
							</button>

							{#if station.favicon_url}
								<img src={station.favicon_url} alt="" class="size-10 rounded-lg object-cover" />
							{:else}
								<div class="flex size-10 items-center justify-center rounded-lg bg-muted">
									<Radio class="size-5 text-muted-foreground" />
								</div>
							{/if}

							<div class="min-w-0 flex-1 overflow-hidden">
								<div class="flex min-w-0 items-center gap-2">
									<p class="truncate text-sm font-medium">{station.name}</p>
									{#if getStationHealth(station) !== 'ok'}
										<span
											class={`size-2 shrink-0 rounded-full ${getStationHealth(station) === 'dead' ? 'bg-zinc-500' : 'bg-amber-400'}`}
										></span>
									{/if}
									{#if isStationActive(station.url)}
										{#if player.state.is_buffering}
											<LoaderCircle class="size-3 shrink-0 animate-spin text-primary" />
										{:else}
											<span class="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_6px_rgba(74,222,128,0.5)]"></span>
										{/if}
									{/if}
								</div>
								<p class="mt-0.5 truncate text-xs text-muted-foreground">
									{[station.country, station.codec, station.bitrate ? `${station.bitrate}kbps` : null]
										.filter(Boolean)
										.join(' · ')}
								</p>
								{#if stationHealthLabel(station)}
									<p class={`mt-1 truncate text-[11px] ${getStationHealth(station) === 'dead' ? 'text-zinc-400' : 'text-amber-500'}`}>
										{stationHealthLabel(station)}
									</p>
								{/if}
							</div>

							<Button variant="ghost" size="icon" class="size-8 shrink-0 text-destructive" onclick={() => removeFavorite(station)}>
								<HeartOff class="size-4" />
							</Button>
						</CardContent>
					</Card>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Search results -->
	{#if searching}
		<div class="space-y-2">
			{#each Array(5) as _}
				<Skeleton class="h-16 w-full" />
			{/each}
		</div>
	{:else if searchError}
		<Card class="border-dashed">
			<CardContent class="py-6 text-sm text-destructive">{searchError}</CardContent>
		</Card>
	{:else if results.length > 0}
		<div class="flex flex-col gap-2">
			{#each results as station}
				<Card class="transition-colors hover:border-border hover:bg-muted/50">
					<CardContent class="flex min-w-0 items-center gap-3 p-3">
						<button
							class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
							onclick={() => playSearchResult(station)}
						>
							{#if isStationActive(station.url)}
								<Square class="size-4" />
							{:else}
								<Play class="size-4 pl-0.5" />
							{/if}
						</button>

						{#if station.favicon}
							<img src={station.favicon} alt="" class="size-10 rounded-lg object-cover" />
						{:else}
							<div class="flex size-10 items-center justify-center rounded-lg bg-muted">
								<Radio class="size-5 text-muted-foreground" />
							</div>
						{/if}

						<div class="min-w-0 flex-1 overflow-hidden">
							<div class="flex min-w-0 items-center gap-2">
								<p class="truncate text-sm font-medium">{station.name}</p>
								{#if isStationActive(station.url)}
									{#if player.state.is_buffering}
										<LoaderCircle class="size-3 shrink-0 animate-spin text-primary" />
									{:else}
										<span class="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_6px_rgba(74,222,128,0.5)]"></span>
									{/if}
								{/if}
							</div>
							<p class="mt-0.5 truncate text-xs text-muted-foreground">
								{[station.country, station.language, station.codec, station.bitrate ? `${station.bitrate}kbps` : null]
									.filter(Boolean)
									.join(' · ')}
							</p>
						</div>

						<Button variant="ghost" size="icon" class="size-8 shrink-0" onclick={() => saveToFavorites(station)} title="Save to favorites">
							<Heart class="size-4 {isStationSaved(station) ? 'fill-primary text-primary' : ''}" />
						</Button>
					</CardContent>
				</Card>
			{/each}
		</div>
	{:else if query.trim().length > 1}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-3 py-10 text-center">
				<Radio class="size-10 text-muted-foreground" />
				<div>
					<h3 class="font-semibold">No stations found</h3>
					<p class="text-sm text-muted-foreground">Try a genre, city, or country instead.</p>
				</div>
			</CardContent>
		</Card>
	{:else if query.length === 0 && favorites.length === 0}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-12">
				<Globe class="size-12 text-muted-foreground" />
				<div class="text-center">
					<h3 class="font-semibold">Discover Radio</h3>
					<p class="text-sm text-muted-foreground">
						Search 30,000+ internet radio stations from around the world.
					</p>
				</div>
			</CardContent>
		</Card>
	{/if}
</div>
