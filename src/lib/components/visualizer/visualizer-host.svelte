<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerSignal from '$lib/components/visualizer/visualizer-signal.svelte';
	import { useVisualizer, VISUALIZER_ENGINES } from '$lib/state/visualizer.svelte';

	const vis = useVisualizer();
	let engineHydrated = $state(false);

	// Transient on-screen label when the user cycles engines with the V key.
	let engineFlash = $state('');
	let engineFlashTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		// Hydration is synchronous, and the render gate below guarantees no
		// temporary Mk1 instance mounts while a saved Mk2/Signal choice is loaded.
		vis.hydrateEngine();
		engineHydrated = true;
	});

	function cycleEngine(dirn: 1 | -1) {
		const order = VISUALIZER_ENGINES;
		const idx = order.indexOf(vis.engine);
		const next = order[(idx + dirn + order.length) % order.length];
		vis.setEngine(next);
		engineFlash = next === 'mk2' ? 'mk2 (experimental)' : next;
		if (engineFlashTimer) clearTimeout(engineFlashTimer);
		engineFlashTimer = setTimeout(() => (engineFlash = ''), 1800);
	}

	onDestroy(() => {
		if (engineFlashTimer) clearTimeout(engineFlashTimer);
	});
</script>

<!-- Escape must ALWAYS exit, regardless of which engine renders or where
     keyboard focus sits. The per-engine overlays also handle click/Esc, but
     their handlers only fire when the overlay itself has focus — which it
     never does after toggling via the player-bar button. -->
<svelte:window
	onkeydown={(e) => {
		if (!vis.active) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			vis.toggle();
			return;
		}
		const target = e.target as HTMLElement;
		const isInput =
			target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
		if (isInput) return;
		// V / Shift+V cycles engines: mk1 → mk2 → signal.
		if (e.key === 'v' || e.key === 'V') {
			e.preventDefault();
			cycleEngine(e.shiftKey ? -1 : 1);
		}
	}}
/>

{#if vis.active && engineHydrated}
	{#if engineFlash}
		<div
			class="pointer-events-none fixed left-1/2 top-8 z-[106] -translate-x-1/2 rounded border border-white/20 bg-black/60 px-3 py-1.5 font-mono text-sm tracking-wide text-white/90"
		>
			engine: {engineFlash}
		</div>
	{/if}
	<div class="pointer-events-none fixed bottom-24 right-6 z-[106] font-mono text-[11px] text-white/35">
		esc exit · v next engine{vis.engine === 'mk2' ? ' · experimental' : ''}
	</div>
	<div data-visualizer-host data-render-engine={vis.engine}>
		{#if vis.engine === 'mk1'}
			<VisualizerMk1 showHud={true} />
		{:else if vis.engine === 'mk2'}
			<VisualizerMk2 showHud={true} />
		{:else}
			<VisualizerSignal showHud={true} />
		{/if}
	</div>
{/if}
