<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as api from '$lib/api/tauri';
	import { toast } from 'svelte-sonner';
	import type { Playlist } from '$lib/types';
	import { ListMusic, Plus } from '@lucide/svelte';

	interface Props {
		recordingId: string;
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}

	let { recordingId, open = $bindable(), onOpenChange }: Props = $props();

	let playlists = $state<Playlist[]>([]);
	let newName = $state('');

	$effect(() => {
		if (open) {
			loadPlaylists();
		}
	});

	async function loadPlaylists() {
		try {
			playlists = await api.getPlaylists();
		} catch {
			// ignore
		}
	}

	async function addTo(playlistId: string) {
		try {
			await api.addToPlaylist(playlistId, recordingId);
			toast.success('Added to playlist');
			onOpenChange(false);
		} catch {
			toast.error('Failed to add to playlist');
		}
	}

	async function createAndAdd() {
		if (!newName.trim()) return;
		try {
			const pl = await api.createPlaylist(newName.trim());
			window.dispatchEvent(new CustomEvent('playlists-changed'));
			await api.addToPlaylist(pl.id, recordingId);
			toast.success(`Added to "${pl.name}"`);
			newName = '';
			onOpenChange(false);
		} catch {
			toast.error('Failed to create playlist');
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add to Playlist</Dialog.Title>
		</Dialog.Header>

		<ScrollArea class="max-h-64">
			<div class="flex flex-col gap-1">
				{#each playlists as playlist}
					<button
						class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
						onclick={() => addTo(playlist.id)}
					>
						<ListMusic class="size-4 text-muted-foreground" />
						{playlist.name}
					</button>
				{/each}
			</div>
		</ScrollArea>

		<div class="flex gap-2 pt-2">
			<Input
				placeholder="New playlist name"
				bind:value={newName}
				onkeydown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
			/>
			<Button size="sm" onclick={createAndAdd}>
				<Plus class="mr-1 size-4" />
				Create
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
