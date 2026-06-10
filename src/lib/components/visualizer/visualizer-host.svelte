<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerMk3 from './visualizer-mk3.svelte';
	import VisualizerRuntime from './visualizer-runtime.svelte';
	import { useVisualizer, type RenderVisualizerEngine } from '$lib/state/visualizer.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';

	const vis = useVisualizer();
	const director = createVisualDirector();
	let autoEngine = $state<RenderVisualizerEngine>('mk2');
	let raf = 0;
	let lastSwitchAt = 0;

	// Swapping engines tears down and reinits a full WebGPU pipeline (mk2 alone
	// is a multi-thousand-line shader compile), and the raw energy/motion
	// thresholds below have no hysteresis — without a residency floor the pick
	// can flap across a threshold frame-to-frame and thrash GPU init.
	const MIN_ENGINE_RESIDENCY_S = 6;

	function pickAutoEngine(now: number): RenderVisualizerEngine {
		const frame = director.update(vis.latest, now);
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
		if (vis.engine === 'auto') {
			const now = performance.now() / 1000;
			const pick = pickAutoEngine(now);
			if (pick !== autoEngine && now - lastSwitchAt >= MIN_ENGINE_RESIDENCY_S) {
				autoEngine = pick;
				lastSwitchAt = now;
			}
		}
		raf = requestAnimationFrame(loop);
	}

	onMount(() => {
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
	});
</script>

{#if vis.engine === 'runtime'}
	<VisualizerRuntime />
{:else if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk1'}
	<VisualizerMk1 />
{:else if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk2'}
	<VisualizerMk2 />
{:else}
	<VisualizerMk3 />
{/if}
