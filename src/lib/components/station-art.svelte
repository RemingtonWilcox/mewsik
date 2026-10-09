<script lang="ts">
	import { stationMonogram, stationSeed } from '$lib/radio/names';

	// Artwork for a station: the favicon when one loads, otherwise a generated
	// tile (two-tone gradient + monogram) that is stable per station, so a
	// station without graphics never shows a blank square.
	let {
		name,
		identity = null,
		src = null,
		class: className = 'size-12 rounded-md',
		monogramClass = 'text-sm'
	}: {
		name: string | null | undefined;
		identity?: string | null;
		src?: string | null;
		class?: string;
		monogramClass?: string;
	} = $props();

	let failed = $state(false);
	let loaded = $state(false);
	const usable = $derived(Boolean(src && src.startsWith('https://') && !failed));

	$effect(() => {
		void src;
		failed = false;
		loaded = false;
	});

	const seed = $derived(stationSeed(identity || name || ''));
	const hueA = $derived(Math.round(seed * 360));
	const hueB = $derived(Math.round((seed * 360 + 38 + seed * 70) % 360));
	const angle = $derived(Math.round(120 + seed * 120));
	const background = $derived(
		`linear-gradient(${angle}deg, hsl(${hueA} 58% 30%), hsl(${hueB} 62% 16%))`
	);
	const monogram = $derived(stationMonogram(name));
</script>

<div
	class="relative shrink-0 overflow-hidden {className}"
	style:background
	aria-hidden="true"
	data-station-art={usable && loaded ? 'image' : 'generated'}
>
	<div
		class="absolute inset-0 opacity-40"
		style:background={`radial-gradient(circle at ${Math.round(20 + seed * 60)}% 18%, hsl(${hueB} 80% 60% / 0.55), transparent 60%)`}
	></div>
	<span
		class="absolute inset-0 grid place-items-center font-semibold tracking-tight text-white/85 {monogramClass}"
		class:opacity-0={usable && loaded}
	>
		{monogram}
	</span>
	{#if usable}
		<img
			{src}
			alt=""
			class="absolute inset-0 size-full object-cover transition-opacity duration-300"
			class:opacity-0={!loaded}
			loading="lazy"
			referrerpolicy="no-referrer"
			onload={() => (loaded = true)}
			onerror={() => (failed = true)}
		/>
	{/if}
</div>
