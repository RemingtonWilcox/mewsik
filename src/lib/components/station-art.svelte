<script lang="ts">
	import { untrack } from 'svelte';
	import type { StationLogoKey } from '$lib/api/tauri';
	import { loadStationLogo, peekStationLogo, stationLogoMemoKey } from '$lib/radio/logos';
	import { stationMonogram, stationSeed } from '$lib/radio/names';

	// Artwork for a station: its logo when one loads, otherwise a generated
	// tile (two-tone gradient + monogram) that is stable per station, so a
	// station without graphics never shows a blank square.
	//
	// `logo` names the station for the backend logo cache, which fetches the
	// favicon and returns a data: URL; it is requested only once the tile is
	// near the viewport. `src` still accepts an https image directly.
	let {
		name,
		identity = null,
		src = null,
		logo = null,
		class: className = 'size-12 rounded-md',
		monogramClass = 'text-sm'
	}: {
		name: string | null | undefined;
		identity?: string | null;
		src?: string | null;
		logo?: StationLogoKey | null;
		class?: string;
		monogramClass?: string;
	} = $props();

	let root = $state<HTMLDivElement | null>(null);
	let logoSrc = $state<string | null>(null);
	let failed = $state(false);
	let loaded = $state(false);

	const logoKey = $derived(stationLogoMemoKey(logo));

	$effect(() => {
		const memoKey = logoKey;
		const element = root;
		const request = untrack(() => logo);
		const known = memoKey ? peekStationLogo(memoKey) : null;
		logoSrc = known ?? null;
		if (!memoKey || !element || !request || known !== undefined) return;

		let cancelled = false;
		const start = () => {
			void loadStationLogo(request).then((url) => {
				if (!cancelled) logoSrc = url;
			});
		};
		if (typeof IntersectionObserver === 'undefined') {
			start();
			return () => {
				cancelled = true;
			};
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer.disconnect();
					start();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(element);
		return () => {
			cancelled = true;
			observer.disconnect();
		};
	});

	const imageSrc = $derived(
		logoSrc && logoSrc.startsWith('data:image/')
			? logoSrc
			: src && src.startsWith('https://')
				? src
				: null
	);
	const usable = $derived(Boolean(imageSrc && !failed));

	$effect(() => {
		void imageSrc;
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
	bind:this={root}
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
			src={imageSrc}
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
