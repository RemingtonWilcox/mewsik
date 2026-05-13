<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerMk3 from './visualizer-mk3.svelte';
	import { useVisualizer, type RenderVisualizerEngine } from '$lib/state/visualizer.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';

	const vis = useVisualizer();
	const director = createVisualDirector();
	let autoEngine = $state<RenderVisualizerEngine>('mk2');
	let raf = 0;

	function pickAutoEngine(): RenderVisualizerEngine {
		const frame = director.update(vis.latest, performance.now() / 1000);
		if (frame.silence) return 'mk1';
		// Drop / chorus / explicit peak → mk3 particle field (the loudest motif).
		if (frame.section === 'drop' || frame.section === 'chorus' || frame.energy > 0.76)
			return 'mk3';
		// Build / pre-chorus / rising motion → mk2 organism (tension, growth).
		if (
			frame.section === 'build' ||
			frame.section === 'pre_chorus' ||
			frame.drop.anticipation > 0.2 ||
			frame.motion > 0.46
		)
			return 'mk2';
		// Bridge / breakdown / calm → mk1 post-stack (atmospheric).
		if (frame.section === 'bridge' || frame.section === 'breakdown') return 'mk1';
		return frame.motif === 'organism' ? 'mk2' : 'mk1';
	}

	function loop() {
		if (vis.engine === 'auto') autoEngine = pickAutoEngine();
		raf = requestAnimationFrame(loop);
	}

	onMount(() => {
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
	});
</script>

{#if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk1'}
	<VisualizerMk1 />
{:else if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk2'}
	<VisualizerMk2 />
{:else}
	<VisualizerMk3 />
{/if}
