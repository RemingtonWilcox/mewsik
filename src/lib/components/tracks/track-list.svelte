<script lang="ts">
	import type { LibraryTrack } from '$lib/types';
	import { usePlayer } from '$lib/state/player.svelte';
	import { useTrackMenu, type TrackMenuExtra } from '$lib/state/track-menu.svelte';
	import { formatDuration } from '$lib/media';
	import Cover from './cover.svelte';
	import { Play, Pause, Ellipsis, Clock3 } from '@lucide/svelte';
	import { onMount } from 'svelte';

	const ROW = 52;
	const OVERSCAN = 12;

	let {
		tracks,
		showAlbum = true,
		showCover = true,
		/** Album pages number by track position instead of showing covers. */
		numbered = false,
		extras = [],
		emptyText = 'No songs here yet.',
		onplay
	}: {
		tracks: LibraryTrack[];
		showAlbum?: boolean;
		showCover?: boolean;
		numbered?: boolean;
		extras?: TrackMenuExtra[];
		emptyText?: string;
		/** Defaults to playing the whole list from `index`. */
		onplay?: (index: number) => void;
	} = $props();

	const player = usePlayer();
	const menu = useTrackMenu();

	let listEl = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);
	let viewport = $state(800);
	let listTop = $state(0);
	let selected = $state<Set<number>>(new Set());
	let anchor = $state<number | null>(null);

	// Rows are positioned inside one tall box; only the visible slice exists
	// in the DOM, so a 5,000-song library scrolls like a 50-song playlist.
	const first = $derived(Math.max(0, Math.floor((scrollTop - listTop) / ROW) - OVERSCAN));
	const last = $derived(
		Math.min(tracks.length, Math.ceil((scrollTop - listTop + viewport) / ROW) + OVERSCAN)
	);
	const visible = $derived(tracks.slice(first, last));

	$effect(() => {
		void tracks;
		selected = new Set();
		anchor = null;
	});

	onMount(() => {
		const scroller = listEl?.closest<HTMLElement>('[data-scroll-root]');
		if (!scroller || !listEl) return;
		const measure = () => {
			if (!listEl) return;
			const a = listEl.getBoundingClientRect().top;
			const b = scroller.getBoundingClientRect().top;
			listTop = a - b + scroller.scrollTop;
			viewport = scroller.clientHeight;
		};
		const onScroll = () => (scrollTop = scroller.scrollTop);
		measure();
		onScroll();
		scroller.addEventListener('scroll', onScroll, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		observer.observe(listEl);
		return () => {
			scroller.removeEventListener('scroll', onScroll);
			observer.disconnect();
		};
	});

	function play(index: number) {
		if (onplay) onplay(index);
		else void player.playAll(tracks.map((t) => t.id), index);
	}

	function toggle(index: number) {
		const track = tracks[index];
		if (player.state.current_recording_id === track.id) void player.togglePlay();
		else play(index);
	}

	function select(index: number, event: MouseEvent) {
		if (event.shiftKey && anchor !== null) {
			const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
			const next = new Set(event.ctrlKey || event.metaKey ? selected : []);
			for (let i = a; i <= b; i++) next.add(i);
			selected = next;
			return;
		}
		if (event.ctrlKey || event.metaKey) {
			const next = new Set(selected);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			selected = next;
		} else {
			selected = new Set([index]);
		}
		anchor = index;
	}

	function openMenu(index: number, x: number, y: number) {
		if (!selected.has(index)) {
			selected = new Set([index]);
			anchor = index;
		}
		const indices = [...selected].sort((a, b) => a - b);
		const chosen = indices.map((i) => tracks[i]);
		menu.open({
			x,
			y,
			tracks: chosen,
			extras,
			play: () =>
				chosen.length === 1
					? play(indices[0])
					: void player.playAll(
							chosen.map((t) => t.id),
							0
						)
		});
	}

	function onKey(event: KeyboardEvent) {
		if (tracks.length === 0) return;
		const current = anchor ?? -1;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const next = Math.max(
				0,
				Math.min(tracks.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))
			);
			selected = new Set([next]);
			anchor = next;
			const scroller = listEl?.closest<HTMLElement>('[data-scroll-root]');
			if (scroller) {
				const top = listTop + next * ROW;
				if (top < scroller.scrollTop + 40) scroller.scrollTop = top - 40;
				else if (top + ROW > scroller.scrollTop + scroller.clientHeight)
					scroller.scrollTop = top + ROW - scroller.clientHeight;
			}
		} else if (event.key === 'Enter' && anchor !== null) {
			event.preventDefault();
			play(anchor);
		} else if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
			event.preventDefault();
			selected = new Set(tracks.map((_, i) => i));
		}
	}

	const columns = $derived(
		showAlbum
			? 'grid-template-columns: 2.75rem minmax(0,1.4fr) minmax(0,1fr) 4.5rem 2.25rem'
			: 'grid-template-columns: 2.75rem minmax(0,1fr) 4.5rem 2.25rem'
	);
</script>

{#if tracks.length === 0}
	<p class="px-3 py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
{:else}
	<div
		class="track-list outline-none"
		role="grid"
		tabindex="0"
		aria-rowcount={tracks.length}
		onkeydown={onKey}
	>
		<div
			class="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground backdrop-blur"
			style={columns}
		>
			<span class="text-center">#</span>
			<span>Title</span>
			{#if showAlbum}<span>Album</span>{/if}
			<span class="flex justify-end"><Clock3 class="size-3.5" /></span>
			<span></span>
		</div>

		<div bind:this={listEl} class="relative" style:height="{tracks.length * ROW}px">
			{#each visible as track, offset (track.playlist_track_id ?? track.id + ':' + (first + offset))}
				{@const index = first + offset}
				{@const isCurrent = player.state.current_recording_id === track.id}
				{@const isPlaying = isCurrent && player.state.is_playing}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					role="row"
					tabindex="-1"
					aria-selected={selected.has(index)}
					class="track-row group absolute inset-x-0 grid items-center gap-3 rounded-md px-3"
					class:is-selected={selected.has(index)}
					class:is-current={isCurrent}
					style="{columns}; top: {index * ROW}px; height: {ROW}px"
					onclick={(e) => select(index, e)}
					ondblclick={() => play(index)}
					oncontextmenu={(e) => {
						e.preventDefault();
						openMenu(index, e.clientX, e.clientY);
					}}
				>
					<button
						class="relative flex size-8 items-center justify-center justify-self-center text-sm tabular-nums text-muted-foreground"
						aria-label={isPlaying ? 'Pause' : 'Play'}
						onclick={(e) => {
							e.stopPropagation();
							toggle(index);
						}}
					>
						<span class="group-hover:invisible" class:invisible={isCurrent}>
							{numbered ? (track.playlist_position ?? index + 1) : index + 1}
						</span>
						<span
							class="absolute inset-0 flex items-center justify-center text-foreground group-hover:visible {isCurrent
								? ''
								: 'invisible'}"
						>
							{#if isPlaying}
								<span class="eq group-hover:hidden" aria-hidden="true"><i></i><i></i><i></i></span>
								<Pause class="hidden size-4 fill-current group-hover:block" />
							{:else}
								<Play class="size-4 fill-current" />
							{/if}
						</span>
					</button>

					<div class="flex min-w-0 items-center gap-3">
						{#if showCover && !numbered}
							<Cover src={track.cover_art_path || track.cover_art_url} name={track.album_title || track.title} class="size-9 rounded" />
						{/if}
						<div class="min-w-0">
							<p class="track-title truncate text-sm font-medium" title={track.title}>{track.title}</p>
							<a
								href="/artists/{track.artist_id}"
								class="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
								onclick={(e) => e.stopPropagation()}
								ondblclick={(e) => e.stopPropagation()}>{track.artist_name}</a
							>
						</div>
					</div>

					{#if showAlbum}
						{#if track.album_id}
							<a
								href="/albums/{track.album_id}"
								class="truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
								onclick={(e) => e.stopPropagation()}
								ondblclick={(e) => e.stopPropagation()}>{track.album_title}</a
							>
						{:else}
							<span></span>
						{/if}
					{/if}

					<span class="text-right text-sm tabular-nums text-muted-foreground">
						{formatDuration(track.duration_ms)}
					</span>

					<button
						class="flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-white/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
						aria-label="More"
						onclick={(e) => {
							e.stopPropagation();
							const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
							openMenu(index, rect.right - 240, rect.bottom + 4);
						}}
					>
						<Ellipsis class="size-4" />
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}
