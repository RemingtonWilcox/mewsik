<script lang="ts">
	import { Card, CardContent } from '$lib/components/ui/card';
	import type { Album } from '$lib/types';
	import { Disc } from '@lucide/svelte';

	interface Props {
		albums: Album[];
	}

	let { albums }: Props = $props();
</script>

<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
	{#each albums as album}
		<a href={`/library?album=${album.id}`} class="group">
			<Card class="overflow-hidden transition-colors hover:bg-muted/50">
				<div class="aspect-square overflow-hidden">
					{#if album.cover_art_path || album.cover_art_url}
						<img
							src={album.cover_art_path ?? album.cover_art_url}
							alt={album.title}
							class="size-full object-cover transition-transform group-hover:scale-105"
						/>
					{:else}
						<div class="flex size-full items-center justify-center bg-muted">
							<Disc class="size-12 text-muted-foreground" />
						</div>
					{/if}
				</div>
				<CardContent class="p-3">
					<p class="truncate text-sm font-medium">{album.title}</p>
					<p class="truncate text-xs text-muted-foreground">
						{album.year ?? ''}
					</p>
				</CardContent>
			</Card>
		</a>
	{/each}
</div>
