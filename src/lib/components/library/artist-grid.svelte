<script lang="ts">
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import type { Artist } from '$lib/types';

	interface Props {
		artists: Artist[];
	}

	let { artists }: Props = $props();
</script>

<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
	{#each artists as artist}
		<a href={`/library?artist=${artist.id}`} class="group">
			<Card class="overflow-hidden transition-colors hover:bg-muted/50">
				<CardContent class="flex flex-col items-center gap-3 p-4">
					<Avatar class="size-20">
						{#if artist.image_path || artist.image_url}
							<AvatarImage src={artist.image_path ?? artist.image_url} alt={artist.name} />
						{/if}
						<AvatarFallback class="text-lg">
							{artist.name.slice(0, 2).toUpperCase()}
						</AvatarFallback>
					</Avatar>
					<p class="truncate text-center text-sm font-medium">{artist.name}</p>
				</CardContent>
			</Card>
		</a>
	{/each}
</div>
