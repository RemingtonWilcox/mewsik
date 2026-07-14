<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import TrackTable from '$lib/components/library/track-table.svelte';
	import SearchDiscoveryFeedView from '$lib/components/search/search-discovery-feed.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as api from '$lib/api/tauri';
	import type { PlayStats, SearchDiscoveryFeed, SearchDiscoveryItem } from '$lib/api/tauri';
	import { usePlayer } from '$lib/state/player.svelte';
	import type { LibraryTrack } from '$lib/types';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		ArrowRight,
		Clock3,
		Compass,
		FolderOpen,
		History,
		Play,
		RefreshCw,
		Search,
		Sparkles
	} from '@lucide/svelte';

	const player = usePlayer();

	let dailyMix = $state<LibraryTrack[]>([]);
	let rediscover = $state<LibraryTrack[]>([]);
	let recentlyPlayed = $state<LibraryTrack[]>([]);
	let stats = $state<PlayStats | null>(null);
	let discoveryFeed = $state<SearchDiscoveryFeed | null>(null);
	let loading = $state(true);
	let loadingFeed = $state(true);
	let loadError = $state('');
	let feedError = $state('');

	const hasSavedMusic = $derived(dailyMix.length > 0 || recentlyPlayed.length > 0 || rediscover.length > 0);
	const learningGoal = $derived(stats?.profile_track_goal ?? 5);
	const learningProgress = $derived(Math.min(stats?.unique_tracks ?? 0, learningGoal));
	const profileStage = $derived(
		!hasSavedMusic
			? 'empty'
			: stats?.profile_ready
				? 'ready'
				: 'learning'
	);

	onMount(() => {
		void loadDiscovery();
	});

	async function loadDiscovery(force = false) {
		const previousFeed = discoveryFeed;
		if (!force) loading = true;
		loadingFeed = true;
		loadError = '';
		feedError = '';

		const localTask = Promise.all([
			api.getDailyMix(),
			api.getRediscover(),
			api.getRecentlyPlayed(),
			api.getPlayStats()
		]);
		const feedTask = api
			.getSearchDiscoveryFeed(force)
			.then((feed) => ({ feed, error: null }))
			.catch((error: unknown) => ({ feed: null, error }));

		try {
			const [mix, redis, recent, playStats] = await localTask;
			dailyMix = mix;
			rediscover = redis;
			recentlyPlayed = recent;
			stats = playStats;
		} catch (error) {
			loadError = `Your listening profile could not be loaded${error ? `: ${error}` : ''}`;
		} finally {
			loading = false;
		}

		const feedResult = await feedTask;
		if (feedResult.feed) {
			discoveryFeed = feedResult.feed;
		} else {
			discoveryFeed = previousFeed;
			feedError = previousFeed
				? 'Fresh discovery signals could not be loaded, so the previous picks are still shown.'
				: `Discovery picks could not be loaded${feedResult.error ? `: ${feedResult.error}` : ''}`;
		}
		loadingFeed = false;
	}

	function playMix() {
		if (dailyMix.length === 0) return;
		void player.playAll(dailyMix.map((track) => track.id), 0);
	}

	function searchDiscoveryItem(item: SearchDiscoveryItem) {
		void goto(`/search?q=${encodeURIComponent(item.search_query)}`);
	}
</script>

<div class="flex min-w-0 flex-col gap-7 pb-8">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold">Discover</h1>
			<p class="mt-1 text-sm text-muted-foreground">Your own rotation plus honest, outside-the-library inspiration.</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => loadDiscovery(true)} disabled={loading || loadingFeed}>
			<RefreshCw class={`size-4 ${loading || loadingFeed ? 'animate-spin' : ''}`} /> Refresh
		</Button>
	</div>

	{#if loadError}
		<p class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{loadError}
		</p>
	{/if}

	{#if loading}
		<div class="space-y-3">
			<Skeleton class="h-28 w-full rounded-xl" />
			<Skeleton class="h-64 w-full rounded-xl" />
		</div>
	{:else if profileStage === 'empty'}
		<section class="overflow-hidden rounded-2xl border border-border/70 bg-[radial-gradient(circle_at_15%_10%,color-mix(in_oklab,var(--primary)_20%,transparent),transparent_42%),linear-gradient(135deg,color-mix(in_oklab,var(--card)_94%,black),var(--background))] p-6 sm:p-8">
			<div class="max-w-2xl">
				<span class="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
					<Compass class="size-3" /> Start anywhere
				</span>
				<h2 class="mt-4 text-2xl font-semibold tracking-tight">Discover does not need an existing library.</h2>
				<p class="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Search across music sources, tune into a live station, or add a folder. As you listen, this page will turn into a useful personal rotation.</p>
				<div class="mt-5 flex flex-wrap gap-2">
					<Button href="/search"><Search class="size-4" /> Search music</Button>
					<Button href="/stations" variant="outline"><Compass class="size-4" /> Browse stations</Button>
					<Button href="/settings" variant="ghost"><FolderOpen class="size-4" /> Add a folder</Button>
				</div>
			</div>
		</section>
	{:else}
		<section class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/70 bg-card px-5 py-4">
			<div class="flex min-w-0 items-center gap-3">
				<div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
					{#if profileStage === 'learning'}<Sparkles class="size-5" />{:else}<Compass class="size-5" />{/if}
				</div>
				<div class="min-w-0">
					<h2 class="text-sm font-semibold">{profileStage === 'learning' ? 'Learning your rotation' : 'Your rotation is active'}</h2>
					<p class="text-xs text-muted-foreground">
						{profileStage === 'learning'
							? `${learningProgress}/${learningGoal} different tracks played. Until then, the mix favors saved music you have not worn out.`
							: `Built from ${stats?.unique_tracks ?? 0} different played tracks, with artist repetition capped.`}
					</p>
				</div>
			</div>
			<Button size="sm" onclick={playMix} disabled={dailyMix.length === 0}>
				<Play class="size-3.5" /> Play mix
			</Button>
		</section>
	{/if}

	{#if !loading && dailyMix.length > 0}
		<Card>
			<CardHeader class="gap-1 border-b border-border/50">
				<div class="flex items-center gap-2">
					<Sparkles class="size-4 text-primary" />
					<CardTitle>{profileStage === 'ready' ? 'For your rotation' : 'Try something saved'}</CardTitle>
				</div>
				<CardDescription>
					{profileStage === 'ready'
						? 'A history-weighted mix from music you saved, balanced so one artist does not take over.'
						: 'Unplayed and recently added music from your library while Mewsik learns what sticks.'}
				</CardDescription>
			</CardHeader>
			<CardContent class="pt-2">
				<TrackTable tracks={dailyMix.slice(0, 12)} />
			</CardContent>
		</Card>
	{/if}

	{#if !loading && recentlyPlayed.length > 0}
		<Card>
			<CardHeader class="gap-1 border-b border-border/50">
				<div class="flex items-center gap-2">
					<Clock3 class="size-4 text-primary" />
					<CardTitle>Pick up where you left off</CardTitle>
				</div>
				<CardDescription>Your actual recent tracks, newest first.</CardDescription>
			</CardHeader>
			<CardContent class="pt-2">
				<TrackTable tracks={recentlyPlayed.slice(0, 8)} />
			</CardContent>
		</Card>
	{/if}

	{#if !loading && rediscover.length > 0}
		<Card>
			<CardHeader class="gap-1 border-b border-border/50">
				<div class="flex items-center gap-2">
					<History class="size-4 text-primary" />
					<CardTitle>Back in rotation</CardTitle>
				</div>
				<CardDescription>Saved tracks you played before but have not returned to in at least 30 days.</CardDescription>
			</CardHeader>
			<CardContent class="pt-2">
				<TrackTable tracks={rediscover.slice(0, 8)} />
			</CardContent>
		</Card>
	{/if}

	<div class="flex items-center gap-3 pt-1">
		<div class="h-px flex-1 bg-border/70"></div>
		<span class="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
			<ArrowRight class="size-3" /> Beyond your library
		</span>
		<div class="h-px flex-1 bg-border/70"></div>
	</div>

	{#if feedError}
		<p class="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
			{feedError}
		</p>
	{/if}

	<SearchDiscoveryFeedView
		feed={discoveryFeed}
		loading={loadingFeed}
		onselect={searchDiscoveryItem}
	/>
</div>
