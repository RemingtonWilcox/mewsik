<script lang="ts">
	// The phone has no sidebar, so the Library tab opens with the places the
	// sidebar lists on the desktop: songs heard on stations, downloads and
	// playlists.
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { usePlaylists } from '$lib/state/playlists.svelte';
	import { useActiveDownloads } from '$lib/state/downloads.svelte';
	import { History, Download, ListMusic, Plus, ChevronRight } from '@lucide/svelte';

	const playlists = usePlaylists();
	const downloads = useActiveDownloads();

	async function newPlaylist() {
		try {
			const playlist = await playlists.create('New playlist');
			await goto(`/playlists/${playlist.id}?rename=1`);
		} catch (error) {
			toast.error(`Couldn't create a playlist: ${error}`);
		}
	}
</script>

<section class="flex flex-col gap-4" data-mobile-shortcuts>
	<div class="grid grid-cols-2 gap-2">
		<a href="/heard" class="shortcut">
			<History class="size-5 text-primary" />
			<span>Heard on radio</span>
		</a>
		<a href="/downloads" class="shortcut">
			<Download class="size-5 text-primary" />
			<span>Downloads</span>
			{#if downloads.count > 0}
				<span
					class="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground"
					>{downloads.count}</span
				>
			{/if}
		</a>
	</div>

	<div class="flex flex-col">
		<div class="flex items-center justify-between pb-1">
			<h2 class="text-lg font-bold tracking-tight">Playlists</h2>
			<button
				class="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
				aria-label="New playlist"
				onclick={newPlaylist}
			>
				<Plus class="size-5" />
			</button>
		</div>
		{#if playlists.all.length === 0}
			<p class="py-2 text-sm text-muted-foreground">
				No playlists yet. Use a song's … menu to start one.
			</p>
		{:else}
			{#each playlists.all as playlist (playlist.id)}
				<a
					href="/playlists/{playlist.id}"
					class="flex items-center gap-3 border-b border-white/5 py-3 text-[15px] last:border-0"
				>
					<ListMusic class="size-5 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1 truncate">{playlist.name}</span>
					<ChevronRight class="size-4 shrink-0 text-muted-foreground" />
				</a>
			{/each}
		{/if}
	</div>
</section>

<style>
	.shortcut {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		border-radius: 0.75rem;
		background: rgb(255 255 255 / 0.05);
		padding: 0.85rem 0.9rem;
		font-size: 0.875rem;
		font-weight: 600;
	}
	.shortcut:active {
		background: rgb(255 255 255 / 0.1);
	}
</style>
