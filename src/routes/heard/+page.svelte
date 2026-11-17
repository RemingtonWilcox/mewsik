<script lang="ts">
	import { onMount } from 'svelte';
	import { Search, Copy, Trash2, Radio, History } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import * as api from '$lib/api/tauri';
	import type { StationSong } from '$lib/types';
	import StationArt from '$lib/components/station-art.svelte';
	import { cleanStationName } from '$lib/radio/names';
	import { usePlayer } from '$lib/state/player.svelte';

	const player = usePlayer();

	let songs = $state<StationSong[]>([]);
	let loading = $state(true);
	let filter = $state('');

	onMount(() => {
		void load();
		// New songs land while the page is open.
		const interval = setInterval(() => void load(), 10_000);
		return () => clearInterval(interval);
	});

	async function load() {
		try {
			songs = await api.getStationSongs(2000);
		} finally {
			loading = false;
		}
	}

	const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
	const shown = $derived.by(() => {
		const words = fold(filter.trim()).split(/\s+/).filter(Boolean);
		if (!words.length) return songs;
		return songs.filter((song) => {
			const text = fold(`${song.title} ${song.station_name}`);
			return words.every((word) => text.includes(word));
		});
	});

	function dayLabel(date: Date) {
		const today = new Date();
		const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const days = Math.round((start(today) - start(date)) / 86_400_000);
		if (days === 0) return 'Today';
		if (days === 1) return 'Yesterday';
		return date.toLocaleDateString(undefined, {
			weekday: 'long',
			month: 'short',
			day: 'numeric',
			year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
		});
	}

	const groups = $derived.by(() => {
		const out: { label: string; songs: StationSong[] }[] = [];
		for (const song of shown) {
			const label = dayLabel(new Date(song.started_at));
			if (out.at(-1)?.label !== label) out.push({ label, songs: [] });
			out.at(-1)!.songs.push(song);
		}
		return out;
	});

	const time = (iso: string) =>
		new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

	function tempo(song: StationSong) {
		const parts = [song.bpm ? `${Math.round(song.bpm)} BPM` : null, song.musical_key].filter(Boolean);
		if (!parts.length) return null;
		return (song.tempo_source === 'measured' ? '≈ ' : '') + parts.join(' · ');
	}

	const nowId = $derived(player.state.stream?.log_id ?? null);

	async function copy(song: StationSong) {
		try {
			await navigator.clipboard.writeText(song.title);
			toast.success('Copied');
		} catch {
			toast.error('Could not copy');
		}
	}

	async function remove(song: StationSong) {
		songs = songs.filter((s) => s.id !== song.id);
		try {
			await api.deleteStationSong(song.id);
		} catch (error) {
			toast.error(`Could not remove it: ${error}`);
			void load();
		}
	}
</script>

<svelte:head>
	<title>Heard on radio · mewsik</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-6 pb-6">
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<p class="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary/80">Live radio</p>
			<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Heard on radio</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Every song a station announced while you listened. Find one to save or download it.
			</p>
		</div>
		<label class="relative w-full max-w-xs">
			<Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<input
				bind:value={filter}
				placeholder="Filter songs or stations"
				class="h-10 w-full rounded-full border border-border/70 bg-card/60 pl-9 pr-4 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/60"
			/>
		</label>
	</header>

	{#if loading}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
			<History class="size-8 text-muted-foreground" />
			<p class="font-medium">Nothing yet</p>
			<p class="max-w-sm text-sm text-muted-foreground">
				Play a station and the songs it announces will show up here, with the time and the station.
			</p>
			<a href="/stations" class="mt-1 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
				<Radio class="size-4" /> Stations
			</a>
		</div>
	{:else if shown.length === 0}
		<p class="text-sm text-muted-foreground">No songs match “{filter}”.</p>
	{:else}
		{#each groups as group (group.label)}
			<section class="flex flex-col gap-1" aria-label={group.label}>
				<h2 class="sticky top-0 z-10 bg-background/90 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
					{group.label}
				</h2>
				{#each group.songs as song (song.id)}
					{@const live = song.id === nowId && !song.ended_at}
					<div
						class="group grid grid-cols-[3.5rem_2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]"
						data-station-song
					>
						<span class="text-right text-xs tabular-nums text-muted-foreground">{time(song.started_at)}</span>
						<StationArt
							name={song.station_name}
							src={song.artwork_url}
							class="size-10 rounded"
							monogramClass="text-xs"
						/>
						<div class="min-w-0">
							<a
								href="/search?q={encodeURIComponent(song.title)}"
								class="block truncate text-sm font-medium hover:underline"
								title="Find “{song.title}”"
							>
								{song.track ?? song.title}
								{#if live}
									<span class="ml-1.5 rounded-sm bg-primary/20 px-1 py-px align-middle text-[10px] font-semibold uppercase tracking-wider text-primary">Now</span>
								{/if}
							</a>
							<p class="truncate text-xs text-muted-foreground">
								{[song.artist, cleanStationName(song.station_name)].filter(Boolean).join(' · ')}
								{#if tempo(song)}
									<span
										class="ml-2 tabular-nums text-foreground/70"
										title={song.tempo_source === 'station' ? 'Published by the station' : 'Measured by mewsik from the audio'}
										>{tempo(song)}</span
									>
								{/if}
							</p>
						</div>
						<div class="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
							<a
								href="/search?q={encodeURIComponent(song.title)}"
								class="act"
								aria-label="Find {song.title}"
								title="Find it to play, save or download"
							>
								<Search class="size-4" />
							</a>
							<button class="act" aria-label="Copy {song.title}" title="Copy" onclick={() => copy(song)}>
								<Copy class="size-4" />
							</button>
							<button class="act" aria-label="Remove {song.title}" title="Remove from this list" onclick={() => remove(song)}>
								<Trash2 class="size-4" />
							</button>
						</div>
					</div>
				{/each}
			</section>
		{/each}
	{/if}
</div>

<style>
	.act {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 9999px;
		color: var(--color-muted-foreground);
	}
	.act:hover {
		background: rgb(255 255 255 / 0.08);
		color: var(--color-foreground);
	}
</style>
