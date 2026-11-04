<script lang="ts">
	import '../app.css';
	import { Toaster } from '$lib/components/ui/sonner';
	import Sidebar from '$lib/components/shell/sidebar.svelte';
	import PlayerBar from '$lib/components/player/player-bar.svelte';
	import TrackMenu from '$lib/components/tracks/track-menu.svelte';
	import MobileLayout from '$lib/components/mobile/mobile-layout.svelte';
	import UpdateNotice from '$lib/components/update/update-notice.svelte';
	import VisualizerHost from '$lib/components/visualizer/visualizer-host.svelte';
	import { useAppUpdater } from '$lib/state/app-updater.svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';
	import { page } from '$app/state';
	import { goto, afterNavigate } from '$app/navigation';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';

	let { children } = $props();
	const visualizer = useVisualizer();
	const updater = useAppUpdater();

	// Phones and iPad portrait get the tab-bar layout.
	const isMobile = new IsMobile();

	let scroller = $state<HTMLElement | null>(null);

	onMount(() => {
		updater.startLaunchCheck();
	});

	// Each page starts at the top.
	afterNavigate(({ type }) => {
		if (type !== 'popstate' && scroller) scroller.scrollTop = 0;
	});

	const isVisualizerLab = $derived(page.url.pathname.startsWith('/visualizer-test'));

	// Space belongs to whatever control has focus; anywhere else (including
	// the song list) it plays and pauses.
	const ownsSpace =
		'a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),' +
		'[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],' +
		'[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="textbox"]';

	function typingInto(event: KeyboardEvent): boolean {
		const target = event.target as HTMLElement | null;
		return Boolean(target?.closest?.(ownsSpace));
	}

	function onKey(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'f')) {
			if (visualizer.active) return;
			event.preventDefault();
			if (page.url.pathname.startsWith('/search')) {
				document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
			} else {
				void goto('/search');
			}
			return;
		}
		if (event.key === ' ' && !event.altKey && !event.ctrlKey && !event.metaKey) {
			if (typingInto(event)) return;
			// Space on a focused button should not also click it.
			event.preventDefault();
			window.dispatchEvent(new CustomEvent('toggle-playback'));
		}
	}
</script>

<ModeWatcher />

<svelte:window onkeydown={onKey} />

{#if isVisualizerLab}
	{@render children()}
{:else if isMobile.current}
	<MobileLayout>
		{@render children()}
	</MobileLayout>
	<TrackMenu />
	<Toaster />
{:else}
	<div class="flex h-screen flex-col">
		<div
			data-app-content
			class="flex min-h-0 flex-1"
			inert={visualizer.active}
			aria-hidden={visualizer.active ? 'true' : undefined}
		>
			<UpdateNotice />
			<Sidebar />
			<main bind:this={scroller} data-scroll-root class="min-w-0 flex-1 overflow-y-auto">
				<div class="mx-auto w-full max-w-[1400px] px-8 pb-10 pt-6">
					{@render children()}
				</div>
			</main>
		</div>
		<PlayerBar />
	</div>

	<TrackMenu />
	<VisualizerHost />
	<Toaster position="bottom-right" offset={104} />
{/if}
