<script lang="ts">
	import DesktopStations from '$lib/components/stations/desktop-stations.svelte';
	import MobileStations from '$lib/components/mobile/mobile-stations.svelte';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';

	const isMobile = new IsMobile();
</script>

<svelte:head>
	<title>Stations · mewsik</title>
	<meta name="description" content="Hand-picked internet radio, plus the whole world when you want to dig." />
</svelte:head>

{#if isMobile.current}
	<MobileStations />
{:else}
	<DesktopStations />
{/if}
