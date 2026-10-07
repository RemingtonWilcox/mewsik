<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import * as api from '$lib/api/tauri';
	import { usePlayer } from '$lib/state/player.svelte';
	import { goto } from '$app/navigation';
	import { Music, User, Disc } from '@lucide/svelte';
	import type { SearchResult } from '$lib/types';

	const player = usePlayer();

	let open = $state(false);
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let debounceTimer: ReturnType<typeof setTimeout>;
	let searchRequest = 0;
	const artistResults = $derived.by(() => {
		const seen = new Set<string>();
		return results.filter((result) => {
			if (!result.artist_id || seen.has(result.artist_id)) {
				return false;
			}
			seen.add(result.artist_id);
			return true;
		});
	});
	const albumResults = $derived.by(() => {
		const seen = new Set<string>();
		return results.filter((result) => {
			if (!result.album_id || !result.album_title || seen.has(result.album_id)) {
				return false;
			}
			seen.add(result.album_id);
			return true;
		});
	});

	$effect(() => {
		const handler = () => {
			open = !open;
		};
		window.addEventListener('toggle-command', handler);
		return () => window.removeEventListener('toggle-command', handler);
	});

	$effect(() => {
		if (!open) {
			query = '';
			results = [];
		}
	});

	$effect(() => {
		const trimmedQuery = query.trim();
		clearTimeout(debounceTimer);

		if (!open || !trimmedQuery) {
			searchRequest += 1;
			results = [];
			return;
		}

		const requestId = ++searchRequest;
		debounceTimer = setTimeout(async () => {
			try {
				const nextResults = await api.searchLibrary(trimmedQuery);
				if (requestId === searchRequest) {
					results = nextResults;
				}
			} catch {
				if (requestId === searchRequest) {
					results = [];
				}
			}
		}, 150);

		return () => clearTimeout(debounceTimer);
	});

	function handleSelect(index: number) {
		const ids = results.map((result) => result.recording_id);
		if (index < 0 || index >= ids.length) return;
		void player.playAll(ids, index);
		open = false;
		query = '';
	}

	async function handleArtistSelect(artistId: string) {
		await goto(`/library?artist=${artistId}`);
		open = false;
	}

	async function handleAlbumSelect(albumId: string) {
		await goto(`/library?album=${albumId}`);
		open = false;
	}
</script>

<Command.Dialog bind:open>
	<Command.Input placeholder="Search songs, artists, albums..." bind:value={query} />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>
		{#if results.length > 0}
			<Command.Group heading="Songs">
				{#each results as result, index}
					<Command.Item
						value={result.title}
						onSelect={() => handleSelect(index)}
					>
						<Music class="mr-2 size-4" />
						<div class="flex flex-col">
							<span>{result.title}</span>
							<span class="text-xs text-muted-foreground">{result.artist_name}</span>
						</div>
					</Command.Item>
				{/each}
			</Command.Group>

			{#if artistResults.length > 0}
				<Command.Group heading="Artists">
					{#each artistResults as result}
						<Command.Item
							value={`${result.artist_name} artist`}
							onSelect={() => result.artist_id && handleArtistSelect(result.artist_id)}
						>
							<User class="mr-2 size-4" />
							<div class="flex flex-col">
								<span>{result.artist_name}</span>
								<span class="text-xs text-muted-foreground">Open artist</span>
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}

			{#if albumResults.length > 0}
				<Command.Group heading="Albums">
					{#each albumResults as result}
						<Command.Item
							value={`${result.album_title} album`}
							onSelect={() => result.album_id && handleAlbumSelect(result.album_id)}
						>
							<Disc class="mr-2 size-4" />
							<div class="flex flex-col">
								<span>{result.album_title}</span>
								<span class="text-xs text-muted-foreground">{result.artist_name}</span>
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/if}
		{/if}
	</Command.List>
</Command.Dialog>
