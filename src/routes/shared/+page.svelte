<script lang="ts">
	// A playlist someone shared: preview it, then add it as a playlist of
	// your own. Songs already in your library are used as they are; the rest
	// are found on YouTube.
	import { goto } from '$app/navigation';
	import { invoke } from '@tauri-apps/api/core';
	import { toast } from 'svelte-sonner';
	import { ListMusic, LoaderCircle, Plus } from '@lucide/svelte';
	import * as api from '$lib/api/tauri';
	import { formatDuration, plural } from '$lib/media';
	import { useSharedPlaylist } from '$lib/state/app-links.svelte';
	import { usePlaylists } from '$lib/state/playlists.svelte';
	import type { SharedTrack } from '$lib/share';

	const shared = useSharedPlaylist();
	const playlists = usePlaylists();
	const playlist = $derived(shared.current);

	let adding = $state(false);
	let done = $state(0);

	/** The closest search result: same length within 10 s when the link has it. */
	async function findOnline(track: SharedTrack): Promise<string | null> {
		const query = [track.a, track.t].filter(Boolean).join(' ');
		const page = await api.searchExternal(query, 'youtube');
		const near = (ms: number | null) => !track.d || ms == null || Math.abs(ms - track.d) <= 10_000;
		const hit = page.items.find((item) => near(item.duration_ms)) ?? page.items[0];
		if (!hit) return null;
		return (
			hit.recording_id ??
			(await api.ensureExternalRecording(
				hit.source,
				hit.source_id,
				hit.title,
				hit.artist,
				hit.duration_ms ?? undefined,
				hit.cover_art_url ?? undefined
			))
		);
	}

	async function add() {
		if (!playlist || adding) return;
		adding = true;
		done = 0;
		try {
			const ids = await invoke<(string | null)[]>('match_shared_tracks', { tracks: playlist.t });
			done = ids.filter(Boolean).length;
			const missing = ids.flatMap((id, index) => (id ? [] : [index]));
			// A few searches at a time keeps the providers happy.
			let next = 0;
			const worker = async () => {
				while (next < missing.length) {
					const index = missing[next++];
					try {
						ids[index] = await findOnline(playlist.t[index]);
					} catch {
						ids[index] = null;
					}
					done += 1;
				}
			};
			await Promise.all([worker(), worker(), worker()]);

			const found = ids.filter((id): id is string => !!id);
			const created = await invoke<{ id: string }>('create_playlist_from_recordings', {
				name: playlist.n,
				description: 'Shared with you',
				recordingIds: found
			});
			await playlists.refresh();
			const skipped = playlist.t.length - found.length;
			toast.success(`Added ${playlist.n}`, {
				description: skipped ? `${plural(skipped, 'song')} couldn’t be found` : undefined
			});
			shared.clear();
			await goto(`/playlists/${created.id}`);
		} catch (error) {
			toast.error(`Couldn’t add the playlist: ${error}`);
		} finally {
			adding = false;
		}
	}
</script>

{#if !playlist}
	<div class="flex flex-col items-center gap-3 py-20 text-center text-muted-foreground">
		<ListMusic class="size-8" />
		<p>Open a shared playlist link to see it here.</p>
	</div>
{:else}
	<div class="mx-auto flex w-full max-w-3xl flex-col gap-6" data-testid="shared-playlist">
		<header class="flex flex-col gap-1">
			<p class="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary/80">Shared playlist</p>
			<h1 class="break-words text-3xl font-bold tracking-tight">{playlist.n}</h1>
			<p class="text-sm text-muted-foreground">{plural(playlist.t.length, 'song')}</p>
		</header>

		<button
			class="flex h-11 w-fit items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-70"
			onclick={add}
			disabled={adding}
			data-testid="add-shared-playlist"
		>
			{#if adding}
				<LoaderCircle class="size-4 animate-spin" />
				Finding songs… {done}/{playlist.t.length}
			{:else}
				<Plus class="size-4" />
				Add to my playlists
			{/if}
		</button>

		<ol class="flex flex-col divide-y divide-white/5">
			{#each playlist.t as track, index (index)}
				<li class="flex items-center gap-3 py-2.5">
					<span class="w-6 text-right text-sm tabular-nums text-muted-foreground">{index + 1}</span>
					<span class="min-w-0 flex-1">
						<span class="block truncate">{track.t}</span>
						{#if track.a}<span class="block truncate text-sm text-muted-foreground">{track.a}</span>{/if}
					</span>
					{#if track.d}<span class="text-sm tabular-nums text-muted-foreground">{formatDuration(track.d)}</span>{/if}
				</li>
			{/each}
		</ol>
	</div>
{/if}
