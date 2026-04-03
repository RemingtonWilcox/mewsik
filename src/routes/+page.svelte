<script lang="ts">
	import * as api from '$lib/api/tauri';
	import { useLibrary } from '$lib/state/library.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import Logo from '$lib/components/logo.svelte';
	import TrackTable from '$lib/components/library/track-table.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Badge } from '$lib/components/ui/badge';
	import type { LibraryTrack } from '$lib/types';
	import { Library, FolderOpen, Search, Compass, Play, Pause, Radio, Clock3, Square, LoaderCircle } from '@lucide/svelte';

	const library = useLibrary();
	const player = usePlayer();

	let recentTracks = $state<LibraryTrack[]>([]);
	let quickPicks = $state<LibraryTrack[]>([]);
	let stats = $state<{ total_plays: number; total_time_ms: number; unique_tracks: number } | null>(null);
	let loadingHome = $state(true);
	let lastPlaybackRefreshKey = $state('');

	$effect(() => {
		void loadHome();
	});

	$effect(() => {
		const playbackKey = player.state.current_recording_id ?? player.state.current_source_url ?? '';
		if (!playbackKey || playbackKey === lastPlaybackRefreshKey || loadingHome) {
			return;
		}
		lastPlaybackRefreshKey = playbackKey;
		void loadHome();
	});

	async function loadHome() {
		loadingHome = true;
		try {
			await library.loadAll();
			const [recent, mix, playStats] = await Promise.all([
				api.getRecentlyPlayed(),
				api.getDailyMix(),
				api.getPlayStats()
			]);
			recentTracks = recent.slice(0, 10);
			quickPicks = mix.slice(0, 8);
			stats = playStats;
		} finally {
			loadingHome = false;
		}
	}

	function formatHours(ms: number): string {
		const hours = Math.floor(ms / 3600000);
		const minutes = Math.floor((ms % 3600000) / 60000);
		return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
	}
</script>

<div class="flex flex-col gap-6">
	<div class="flex items-center gap-5">
		<Logo size={64} class="text-primary" />
		<div>
			<h1 class="text-3xl font-bold tracking-tight">mewsik</h1>
			<p class="text-muted-foreground">Library, search, radio, and recommendations in one player.</p>
		</div>
	</div>

	{#if library.error}
		<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{library.error}
		</p>
	{/if}

	{#if player.state.current_title}
		<Card class="overflow-hidden">
			<CardContent class="flex flex-col gap-4 p-5 md:flex-row md:items-center">
				{#if player.state.current_album_art}
					<img
						src={player.state.current_album_art}
						alt=""
						class="size-20 rounded-xl object-cover"
					/>
				{:else}
					<div class="flex size-20 items-center justify-center rounded-xl bg-muted">
						<Radio class="size-8 text-muted-foreground" />
					</div>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Now Playing</p>
					<h2 class="truncate text-2xl font-semibold">{player.state.current_title}</h2>
					<p class="truncate text-sm text-muted-foreground">{player.state.current_artist ?? ''}</p>
					<div class="mt-2 flex flex-wrap gap-2">
						{#if player.state.source}
							<Badge variant="outline">{player.state.source}</Badge>
						{/if}
						{#if player.state.duration_ms > 0}
							<Badge variant="secondary">{Math.round(player.state.duration_ms / 60000)} min</Badge>
						{/if}
						{#if player.state.is_buffering}
							<Badge variant="secondary" class="gap-1">
								<LoaderCircle class="size-3 animate-spin" />
								Buffering
							</Badge>
						{/if}
					</div>
				</div>
				<div class="flex gap-2">
					<Button size="sm" onclick={() => player.togglePlay()}>
						{#if player.state.is_buffering}
							<Square class="mr-1 size-4" />
							Stop
						{:else if player.state.is_playing}
							<Pause class="mr-1 size-4" />
							Pause
						{:else}
							<Play class="mr-1 size-4" />
							Resume
						{/if}
					</Button>
					<Button variant="outline" size="sm" href="/discover">
						<Compass class="mr-1 size-4" />
						Discover
					</Button>
				</div>
			</CardContent>
		</Card>
	{/if}

	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		<Card>
			<CardHeader class="flex flex-row items-center justify-between pb-2">
				<CardTitle class="text-sm font-medium">Songs</CardTitle>
				<Library class="size-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div class="text-2xl font-bold">{library.tracks.length}</div>
			</CardContent>
		</Card>
		<Card>
			<CardHeader class="flex flex-row items-center justify-between pb-2">
				<CardTitle class="text-sm font-medium">Artists</CardTitle>
				<Library class="size-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div class="text-2xl font-bold">{library.artists.length}</div>
			</CardContent>
		</Card>
		<Card>
			<CardHeader class="flex flex-row items-center justify-between pb-2">
				<CardTitle class="text-sm font-medium">Albums</CardTitle>
				<Library class="size-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div class="text-2xl font-bold">{library.albums.length}</div>
			</CardContent>
		</Card>
		<Card>
			<CardHeader class="flex flex-row items-center justify-between pb-2">
				<CardTitle class="text-sm font-medium">Listening Time</CardTitle>
				<Clock3 class="size-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div class="text-2xl font-bold">{stats ? formatHours(stats.total_time_ms) : '0m'}</div>
			</CardContent>
		</Card>
	</div>

	<div class="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
		<Card>
			<CardHeader class="flex flex-row items-center justify-between">
				<div>
					<CardTitle>Recently Played</CardTitle>
					<CardDescription>Jump back into what you were listening to.</CardDescription>
				</div>
				<Button variant="outline" size="sm" href="/search">
					<Search class="mr-1 size-4" />
					Search
				</Button>
			</CardHeader>
			<CardContent>
				{#if loadingHome}
					<div class="space-y-2">
						{#each Array(6) as _}
							<Skeleton class="h-12 w-full" />
						{/each}
					</div>
				{:else if recentTracks.length > 0}
					<TrackTable tracks={recentTracks} />
				{:else}
					<div class="flex flex-col items-center gap-3 py-10 text-center">
						<Compass class="size-10 text-muted-foreground" />
						<div>
							<p class="font-medium">Nothing played yet</p>
							<p class="text-sm text-muted-foreground">Start with local tracks, external search, or radio stations.</p>
						</div>
					</div>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="flex flex-row items-center justify-between">
				<div>
					<CardTitle>Quick Picks</CardTitle>
					<CardDescription>Fresh recommendations from your listening history.</CardDescription>
				</div>
				<Button variant="outline" size="sm" href="/discover">
					<Compass class="mr-1 size-4" />
					Open Discover
				</Button>
			</CardHeader>
			<CardContent>
				{#if loadingHome}
					<div class="space-y-2">
						{#each Array(6) as _}
							<Skeleton class="h-14 w-full" />
						{/each}
					</div>
				{:else if quickPicks.length > 0}
					<div class="flex flex-col gap-2">
						{#each quickPicks as track, index}
							<button
								class="flex items-center gap-3 rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-muted/60"
								onclick={() => player.play(track.id)}
							>
								<div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
									<Play class="size-4 pl-0.5" />
								</div>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{track.title}</p>
									<p class="truncate text-xs text-muted-foreground">{track.artist_name}</p>
								</div>
								<span class="text-xs text-muted-foreground">{index + 1}</span>
							</button>
						{/each}
					</div>
				{:else}
					<div class="flex flex-col items-center gap-3 py-10 text-center">
						<FolderOpen class="size-10 text-muted-foreground" />
						<div>
							<p class="font-medium">Build your taste profile</p>
							<p class="text-sm text-muted-foreground">Play a few tracks and this space will start surfacing better picks.</p>
						</div>
					</div>
				{/if}
			</CardContent>
		</Card>
	</div>

	{#if library.tracks.length === 0 && !library.loading && !loadingHome}
		<Card class="border-dashed">
			<CardContent class="flex flex-col items-center gap-4 py-8">
				<FolderOpen class="size-12 text-muted-foreground" />
				<div class="text-center">
					<h3 class="font-semibold">No music yet</h3>
					<p class="text-sm text-muted-foreground">
						Go to Settings to add a music folder and scan your library.
					</p>
				</div>
				<Button href="/settings">Open Settings</Button>
			</CardContent>
		</Card>
	{/if}
</div>
