<script lang="ts">
	import { usePlayer } from '$lib/state/player.svelte';
	import { useLibrary } from '$lib/state/library.svelte';
	import { formatDuration } from '$lib/media';
	import Cover from '$lib/components/tracks/cover.svelte';
	import type { QueueItem, QueueSnapshot } from '$lib/types';
	import { toast } from 'svelte-sonner';
	import { X } from '@lucide/svelte';
	import { fly } from 'svelte/transition';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const player = usePlayer();
	const library = useLibrary();

	let queue = $state<QueueSnapshot | null>(null);

	async function load() {
		try {
			queue = await player.getQueue();
		} catch {
			// keep what we have
		}
	}

	// Reload when opened, when the track changes, and gently while open.
	$effect(() => {
		if (!open) return;
		void player.state.current_recording_id;
		void load();
		const timer = setInterval(load, 3000);
		return () => clearInterval(timer);
	});

	function cover(item: QueueItem) {
		const track = library.trackById(item.recording_id);
		return track?.cover_art_path || track?.cover_art_url || item.cover_art_url;
	}

	async function act(action: () => Promise<unknown>) {
		try {
			await action();
			await load();
		} catch (error) {
			toast.error(String(error));
		}
	}
</script>

{#if open}
	<aside
		transition:fly={{ x: 24, duration: 160 }}
		class="fixed bottom-[88px] right-0 top-0 z-40 flex w-80 flex-col border-l border-white/5 bg-sidebar/98 shadow-2xl backdrop-blur"
	>
		<header class="flex items-center justify-between px-4 pb-2 pt-4">
			<h2 class="text-base font-semibold">Queue</h2>
			<div class="flex items-center gap-1">
				{#if queue && queue.upcoming.length > 0}
					<button
						class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground"
						onclick={() => act(() => player.clearQueue())}>Clear</button
					>
				{/if}
				<button
					class="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
					aria-label="Close queue"
					onclick={() => (open = false)}
				>
					<X class="size-4" />
				</button>
			</div>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
			{#if queue?.now_playing}
				{@const item = queue.now_playing}
				<p class="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Now playing</p>
				<div class="flex items-center gap-3 rounded-md px-2 py-2">
					<Cover src={cover(item)} name={item.title} class="size-10 rounded" />
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium text-primary">{item.title}</p>
						<p class="truncate text-xs text-muted-foreground">{item.artist_name}</p>
					</div>
				</div>
			{/if}

			<p class="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">Next up</p>
			{#if !queue || queue.upcoming.length === 0}
				<p class="px-2 py-6 text-center text-sm text-muted-foreground">Nothing queued.</p>
			{:else}
				{#each queue.upcoming as item (item.entry_id)}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div
						class="group flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/5"
						ondblclick={() => act(() => player.playQueueEntry(queue!.session_id, item.entry_id))}
					>
						<Cover src={cover(item)} name={item.title} class="size-9 rounded" />
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm">{item.title}</p>
							<p class="truncate text-xs text-muted-foreground">{item.artist_name}</p>
						</div>
						<span class="text-xs tabular-nums text-muted-foreground">
							{formatDuration(item.duration_ms)}
						</span>
						<button
							class="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
							aria-label="Remove {item.title} from queue"
							title="Remove"
							onclick={() => act(() => player.removeQueueEntry(queue!.session_id, item.entry_id))}
						>
							<X class="size-3.5" />
						</button>
					</div>
				{/each}
			{/if}
		</div>
	</aside>
{/if}
