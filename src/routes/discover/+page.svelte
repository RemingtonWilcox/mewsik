<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import TrackTable from '$lib/components/library/track-table.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as api from '$lib/api/tauri';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import type { LibraryTrack } from '$lib/types';
	import { Compass, RefreshCw, Clock, Music, TrendingUp } from '@lucide/svelte';

	const player = usePlayer();

	let dailyMix = $state<LibraryTrack[]>([]);
	let rediscover = $state<LibraryTrack[]>([]);
	let stats = $state<{ total_plays: number; total_time_ms: number; unique_tracks: number } | null>(null);
	let loading = $state(true);
	let lastPlaybackRefreshKey = $state('');
	let loadError = $state('');

	$effect(() => {
		loadDiscovery();
	});

	$effect(() => {
		const playbackKey = player.state.current_recording_id ?? player.state.current_source_url ?? '';
		if (!playbackKey || playbackKey === lastPlaybackRefreshKey || loading) {
			return;
		}
		lastPlaybackRefreshKey = playbackKey;
		void loadDiscovery();
	});

	async function loadDiscovery() {
		loading = true;
		try {
			const [mix, redis, s] = await Promise.all([
				api.getDailyMix(),
				api.getRediscover(),
				api.getPlayStats()
			]);
			dailyMix = mix;
			rediscover = redis;
			stats = s;
			loadError = '';
		} catch (e) {
			loadError = `Failed to load discovery${e ? `: ${e}` : ''}`;
		} finally {
			loading = false;
		}
	}

	function formatHours(ms: number): string {
		const hours = Math.floor(ms / 3600000);
		const minutes = Math.floor((ms % 3600000) / 60000);
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}
</script>

<div class="flex flex-col gap-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Discover</h1>
		<Button variant="outline" size="sm" onclick={loadDiscovery}>
			<RefreshCw class="mr-1 size-4" />
			Refresh
		</Button>
	</div>

	{#if loadError}
		<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{loadError}
		</p>
	{/if}

	<!-- Stats -->
	{#if stats}
		<div class="grid gap-4 sm:grid-cols-3">
			<Card>
				<CardContent class="flex items-center gap-3 pt-6">
					<TrendingUp class="size-8 text-primary" />
					<div>
						<p class="text-2xl font-bold">{stats.total_plays}</p>
						<p class="text-xs text-muted-foreground">Total plays</p>
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex items-center gap-3 pt-6">
					<Clock class="size-8 text-primary" />
					<div>
						<p class="text-2xl font-bold">{formatHours(stats.total_time_ms)}</p>
						<p class="text-xs text-muted-foreground">Listening time</p>
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex items-center gap-3 pt-6">
					<Music class="size-8 text-primary" />
					<div>
						<p class="text-2xl font-bold">{stats.unique_tracks}</p>
						<p class="text-xs text-muted-foreground">Unique tracks</p>
					</div>
				</CardContent>
			</Card>
		</div>
	{/if}

	<!-- Daily Mix -->
	<Card>
		<CardHeader>
			<CardTitle>Daily Mix</CardTitle>
			<CardDescription>
				A personalized mix based on your listening history and favorite genres.
			</CardDescription>
		</CardHeader>
		<CardContent>
			{#if loading}
				<div class="space-y-2">
					{#each Array(5) as _}
						<Skeleton class="h-12 w-full" />
					{/each}
				</div>
			{:else if dailyMix.length > 0}
				<TrackTable tracks={dailyMix} />
			{:else}
				<div class="flex flex-col items-center gap-2 py-6">
					<Compass class="size-8 text-muted-foreground" />
					<p class="text-sm text-muted-foreground">
						Play some music to generate your Daily Mix!
					</p>
				</div>
			{/if}
		</CardContent>
	</Card>

	<!-- Rediscover -->
	<Card>
		<CardHeader>
			<CardTitle>Rediscover</CardTitle>
			<CardDescription>
				Songs you haven't listened to in over 30 days. Remember these?
			</CardDescription>
		</CardHeader>
		<CardContent>
			{#if loading}
				<div class="space-y-2">
					{#each Array(3) as _}
						<Skeleton class="h-12 w-full" />
					{/each}
				</div>
			{:else if rediscover.length > 0}
				<TrackTable tracks={rediscover} />
			{:else}
				<p class="py-4 text-center text-sm text-muted-foreground">
					No forgotten tracks yet. Keep listening!
				</p>
			{/if}
		</CardContent>
	</Card>
</div>
