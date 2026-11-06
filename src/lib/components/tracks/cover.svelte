<script lang="ts">
	import { coverSrc } from '$lib/media';
	import { stationMonogram, stationSeed } from '$lib/radio/names';

	// Album art, or a stable two-tone tile with initials when there is none
	// (or it fails to load), so nothing ever shows as a blank square.
	let {
		src = null,
		name = '',
		class: className = 'size-10 rounded-md',
		textClass = 'text-xs',
		eager = false
	}: {
		src?: string | null;
		name?: string | null;
		class?: string;
		textClass?: string;
		eager?: boolean;
	} = $props();

	let failed = $state(false);
	const url = $derived(coverSrc(src));
	$effect(() => {
		void url;
		failed = false;
	});

	const seed = $derived(stationSeed(name || '?'));
	const background = $derived(
		`linear-gradient(${Math.round(120 + seed * 120)}deg, hsl(${Math.round(seed * 360)} 45% 32%), hsl(${Math.round((seed * 360 + 50) % 360)} 50% 14%))`
	);
</script>

<div class="relative shrink-0 overflow-hidden bg-muted {className}">
	{#if url && !failed}
		<img
			src={url}
			alt=""
			loading={eager ? 'eager' : 'lazy'}
			decoding="async"
			draggable="false"
			class="size-full object-cover"
			onerror={() => (failed = true)}
		/>
	{:else}
		<div
			class="flex size-full items-center justify-center font-semibold text-white/80 {textClass}"
			style:background
		>
			{stationMonogram(name)}
		</div>
	{/if}
</div>
