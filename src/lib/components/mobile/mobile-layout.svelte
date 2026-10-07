<script lang="ts">
	import { onMount } from 'svelte';
	import MobileTabBar from './mobile-tab-bar.svelte';
	import MobileMiniPlayer from './mobile-mini-player.svelte';
	import MobilePlayerSheet from './mobile-player-sheet.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import * as api from '$lib/api/tauri';

	const { children } = $props();
	const player = usePlayer();

	let playerSheetOpen = $state(false);

	// On first launch (or any launch where local favorites < bundled count),
	// seed the iOS DB from the desktop favorites JSON bundled in the app. The
	// command is idempotent and skips if the user already has a sizeable list.
	onMount(() => {
		void api.seedFavoriteStationsFromBundle().then((added) => {
			if (added > 0) {
				window.dispatchEvent(new CustomEvent('favorites-changed'));
			}
		});
	});
	let hasCurrentItem = $derived(
		Boolean(
			player.state.current_title ||
				player.state.current_source_url ||
				player.state.current_recording_id
		)
	);
</script>

<div
	class="flex h-screen flex-col bg-background"
	style="padding-top: env(safe-area-inset-top);"
>
	<main
		class="flex-1 overflow-y-auto px-4 pt-2"
		style="padding-bottom: {hasCurrentItem ? '170px' : '110px'};"
	>
		{@render children()}
	</main>

	<div
		class="fixed inset-x-0 bottom-0 z-30 border-t border-border/40 bg-background/85 backdrop-blur-2xl"
		style="padding-bottom: env(safe-area-inset-bottom);"
	>
		{#if hasCurrentItem}
			<div class="border-b border-border/30">
				<MobileMiniPlayer onExpand={() => (playerSheetOpen = true)} />
			</div>
		{/if}
		<MobileTabBar />
	</div>
</div>

<MobilePlayerSheet bind:open={playerSheetOpen} />
