<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as api from '$lib/api/tauri';
	import { usePlayer } from '$lib/state/player.svelte';
	import { usePlaylists } from '$lib/state/playlists.svelte';
	import { useTrackMenu } from '$lib/state/track-menu.svelte';
	import { Play, ListStart, ListEnd, Disc3, User, Plus, ListMusic, Download } from '@lucide/svelte';

	const menu = useTrackMenu();
	const player = usePlayer();
	const playlists = usePlaylists();

	let element = $state<HTMLDivElement | null>(null);
	let position = $state({ left: 0, top: 0 });

	const current = $derived(menu.current);
	const single = $derived(current?.tracks.length === 1 ? current.tracks[0] : null);
	const count = $derived(current?.tracks.length ?? 0);

	// Keep the menu inside the window.
	$effect(() => {
		if (!current || !element) return;
		const { innerWidth, innerHeight } = window;
		const rect = element.getBoundingClientRect();
		position = {
			left: Math.min(current.x, innerWidth - rect.width - 8),
			top: Math.min(current.y, innerHeight - rect.height - 8)
		};
	});

	type Open = NonNullable<typeof menu.current>;

	// Capture the menu before closing it: actions run after it is gone.
	function run(action: (open: Open) => unknown) {
		const open = menu.current;
		if (!open) return;
		menu.close();
		void Promise.resolve()
			.then(() => action(open))
			.catch((error) => toast.error(String(error)));
	}

	async function queue({ tracks }: Open, next: boolean) {
		const count = tracks.length;
		// Play-next of several tracks keeps their order.
		const ordered = next ? [...tracks].reverse() : tracks;
		for (const track of ordered) {
			await (next ? player.playNext(track.id) : player.addToQueue(track.id));
		}
		toast.success(next ? 'Playing next' : `Added ${count === 1 ? '' : count + ' '}to queue`);
	}

	async function newPlaylist({ tracks }: Open) {
		const playlist = await playlists.create(tracks.length === 1 ? tracks[0].title : 'New playlist');
		await playlists.addTracks(
			playlist.id,
			tracks.map((t) => t.id)
		);
		await goto(`/playlists/${playlist.id}?rename=1`);
	}

	async function download({ tracks }: Open) {
		for (const track of tracks) {
			await api.downloadRecording(track.id);
		}
		toast.success('Download started');
	}

	const needsDownload = $derived(
		(current?.tracks ?? []).some((t) => !t.local_file_path && t.source !== 'local')
	);
</script>

<svelte:window
	onkeydown={(e) => e.key === 'Escape' && menu.close()}
	onblur={() => menu.close()}
	onresize={() => menu.close()}
/>

{#if current}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[90]"
		onpointerdown={() => menu.close()}
		oncontextmenu={(e) => {
			e.preventDefault();
			menu.close();
		}}
	></div>
	<div
		bind:this={element}
		role="menu"
		tabindex="-1"
		class="menu-surface fixed z-[91] w-60 py-1.5"
		style:left="{position.left || current.x}px"
		style:top="{position.top || current.y}px"
	>
		{#if count > 1}
			<p class="px-3 pb-1 pt-0.5 text-xs text-muted-foreground">{count} songs</p>
		{/if}
		<button class="menu-item" onclick={() => run((m) => m.play())}>
			<Play class="size-4" /> Play
		</button>
		<button class="menu-item" onclick={() => run((m) => queue(m, true))}>
			<ListStart class="size-4" /> Play next
		</button>
		<button class="menu-item" onclick={() => run((m) => queue(m, false))}>
			<ListEnd class="size-4" /> Add to queue
		</button>

		<div class="menu-sep"></div>
		<p class="px-3 pb-1 pt-1 text-xs text-muted-foreground">Add to playlist</p>
		<div class="max-h-48 overflow-y-auto">
			<button class="menu-item" onclick={() => run(newPlaylist)}>
				<Plus class="size-4" /> New playlist
			</button>
			{#each playlists.all as playlist (playlist.id)}
				<button
					class="menu-item"
					onclick={() =>
						run((m) =>
							playlists.addTracks(
								playlist.id,
								m.tracks.map((t) => t.id)
							)
						)}
				>
					<ListMusic class="size-4" />
					<span class="truncate">{playlist.name}</span>
				</button>
			{/each}
		</div>

		{#if single && (single.album_id || single.artist_id)}
			<div class="menu-sep"></div>
			{#if single.album_id}
				<button class="menu-item" onclick={() => run((m) => goto(`/albums/${m.tracks[0].album_id}`))}>
					<Disc3 class="size-4" /> Go to album
				</button>
			{/if}
			{#if single.artist_id}
				<button class="menu-item" onclick={() => run((m) => goto(`/artists/${m.tracks[0].artist_id}`))}>
					<User class="size-4" /> Go to artist
				</button>
			{/if}
		{/if}

		{#if needsDownload}
			<div class="menu-sep"></div>
			<button class="menu-item" onclick={() => run(download)}>
				<Download class="size-4" /> Download
			</button>
		{/if}

		{#if current.extras.length > 0}
			<div class="menu-sep"></div>
			{#each current.extras as extra}
				<button
					class="menu-item {extra.danger ? 'text-destructive' : ''}"
					onclick={() => run((m) => extra.run(m.tracks))}
				>
					{extra.label}
				</button>
			{/each}
		{/if}
	</div>
{/if}
