<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Button } from '$lib/components/ui/button';
	import { usePlayer, formatTime } from '$lib/state/player.svelte';
	import { Music, ListMusic, Trash2, Play } from '@lucide/svelte';
	import type { QueueSnapshot } from '$lib/types';
	import { toast } from 'svelte-sonner';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}

	let { open = $bindable(), onOpenChange }: Props = $props();

	const player = usePlayer();
	let queue = $state<QueueSnapshot>({
		session_id: '',
		revision: 0,
		now_playing: null,
		upcoming: []
	});
	let loading = $state(false);
	let queueError = $state('');
	let currentItem = $derived(queue.now_playing);
	let upcoming = $derived(queue.upcoming);

	$effect(() => {
		if (!open) return;

		void loadQueue();
		const interval = setInterval(() => {
			void loadQueue();
		}, 1000);

		return () => clearInterval(interval);
	});

	async function loadQueue() {
		loading = true;
		try {
			queue = await player.getQueue();
			queueError = '';
		} catch (error) {
			queueError = `Failed to load queue${error ? `: ${error}` : ''}`;
		} finally {
			loading = false;
		}
	}

	async function removeItem(entryId: string) {
		try {
			await player.removeQueueEntry(queue.session_id, entryId);
			await loadQueue();
		} catch (error) {
			toast.error(`Failed to remove track: ${error}`);
		}
	}

	async function clearAll() {
		try {
			await player.clearQueue();
			await loadQueue();
		} catch (error) {
			toast.error(`Failed to clear queue: ${error}`);
		}
	}

	async function playItem(entryId: string) {
		try {
			await player.playQueueEntry(queue.session_id, entryId);
			await loadQueue();
		} catch (error) {
			toast.error(`Failed to play track: ${error}`);
		}
	}
</script>

<Sheet.Root bind:open {onOpenChange}>
	<Sheet.Content side="right" class="w-80">
		<Sheet.Header class="pr-8">
			<Sheet.Title>
				<div class="flex items-center gap-2">
					<ListMusic class="size-4" />
					Queue
				</div>
			</Sheet.Title>
			{#if queue.now_playing || queue.upcoming.length > 0}
				<div class="pt-2">
					<Button variant="ghost" size="sm" onclick={clearAll}>Clear Upcoming</Button>
				</div>
			{/if}
		</Sheet.Header>
		<ScrollArea class="h-full pr-4">
			<div class="flex flex-col gap-1 py-4">
				{#if player.state.current_title}
					<div class="mb-2 rounded-md bg-primary/10 p-2">
						<p class="text-xs font-semibold text-primary">Now Playing</p>
						<p class="truncate text-sm font-medium">{player.state.current_title}</p>
						<p class="truncate text-xs text-muted-foreground">{player.state.current_artist ?? ''}</p>
						<p class="text-[11px] text-muted-foreground">
							{player.state.is_buffering ? 'Buffering…' : player.state.is_playing ? 'Playing' : 'Paused'}
						</p>
						{#if currentItem?.duration_ms}
							<p class="text-[11px] text-muted-foreground">{formatTime(currentItem.duration_ms)}</p>
						{/if}
					</div>
				{/if}

				{#if loading}
					<p class="py-8 text-center text-sm text-muted-foreground">Loading queue...</p>
				{:else if queueError}
					<p class="py-8 text-center text-sm text-destructive">{queueError}</p>
				{:else if upcoming.length === 0}
					<p class="py-8 text-center text-sm text-muted-foreground">Queue is empty</p>
				{:else}
					<p class="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
						Up Next
					</p>
					{#each upcoming as item}
						<div class="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
							{#if item.cover_art_url}
								<img src={item.cover_art_url} alt="" class="size-10 rounded object-cover" />
							{:else}
								<div class="flex size-10 items-center justify-center rounded bg-muted">
									<Music class="size-4 text-muted-foreground" />
								</div>
							{/if}
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{item.title}</p>
								<p class="truncate text-xs text-muted-foreground">{item.artist_name}</p>
								{#if item.duration_ms}
									<p class="text-[11px] text-muted-foreground">{formatTime(item.duration_ms)}</p>
								{/if}
							</div>
							<Button
								variant="ghost"
								size="icon"
								class="size-7"
								title={`Play ${item.title}`}
								aria-label={`Play ${item.title}`}
								onclick={() => playItem(item.entry_id)}
							>
								<Play class="size-3.5 pl-0.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="size-7"
								title={`Remove ${item.title} from Up Next`}
								aria-label={`Remove ${item.title} from Up Next`}
								onclick={() => removeItem(item.entry_id)}
							>
								<Trash2 class="size-3.5" />
							</Button>
						</div>
					{/each}
				{/if}
			</div>
		</ScrollArea>
	</Sheet.Content>
</Sheet.Root>
