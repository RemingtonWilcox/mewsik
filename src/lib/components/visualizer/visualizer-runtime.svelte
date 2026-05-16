<script lang="ts">
	// Unified-runtime visualizer host. Mounts a single WebGPU context and runs
	// motif modules behind the shared director uniform. Replaces the engine-
	// swap host for users who opt into the 'runtime' engine.
	//
	// Currently registers a single demonstration motif (atmosphere). mk2's
	// organism and mk3's particle field will land here as further motif
	// modules in subsequent commits.

	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';
	import {
		VisualizerRuntime,
		createAtmosphereMotif,
		createPhysarumMotif,
		createFlowFieldMotif,
		createReactionMotif,
		createAttractorMotif,
		createMandalaMotif,
		weightsForFrame,
		type MotifWeights,
		type RuntimeControls
	} from '$lib/visualizer/runtime';

	let {
		showHud = true,
		overrideWeights = null,
		controls = null
	} = $props<{
		showHud?: boolean;
		overrideWeights?: MotifWeights | null;
		controls?: Partial<RuntimeControls> | null;
	}>();

	const vis = useVisualizer();
	const director = createVisualDirector();
	const runtime = new VisualizerRuntime();
	let activeSection = $state<string>('intro');
	let activeMotifWeights = $state<string>('');

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let unsub: (() => void) | null = null;
	let raf = 0;
	let resizeObserver: ResizeObserver | null = null;
	let started = false;

	async function start() {
		if (!canvas) return;
		try {
			await runtime.init(canvas);
			// Atmosphere → backdrop. Reaction-diffusion → biological texture.
			// Attractor → geometric filaments. Mandala → radial sacred geometry.
			// Physarum + flow-field stack additively on top.
			runtime.register(createAtmosphereMotif(), 1);
			runtime.register(createReactionMotif(), 0.4);
			runtime.register(createAttractorMotif(), 0.45);
			runtime.register(createMandalaMotif(), 0.35);
			runtime.register(createPhysarumMotif(), 0.5);
			runtime.register(createFlowFieldMotif(), 0.5);
			started = true;
			tick();
		} catch (e) {
			errorMsg = (e as Error).message ?? String(e);
		}
	}

	function tick() {
		if (!started) return;
		try {
			const time = performance.now() / 1000;
			const frame = director.update(vis.latest, time);
			const weights = overrideWeights ?? weightsForFrame(frame);
			runtime.setWeights(weights);
			runtime.setControls(controls);
			runtime.update(frame, time);
			runtime.render();
			activeSection = frame.section;
			const tag = overrideWeights ? 'manual' : frame.section;
			activeMotifWeights = `${tag} · atm ${(weights.atmosphere ?? 0).toFixed(2)} · rd ${(weights.lattice ?? 0).toFixed(2)} · att ${(weights.organism ?? 0).toFixed(2)} · man ${(weights.tunnel ?? 0).toFixed(2)} · phy ${(weights.particles ?? 0).toFixed(2)} · flow ${(weights.ribbon ?? 0).toFixed(2)}`;
		} catch (e) {
			errorMsg = `tick: ${(e as Error).message ?? String(e)}`;
			console.error('[runtime tick]', e);
			started = false;
			return;
		}
		raf = requestAnimationFrame(tick);
	}

	function onResize() {
		if (!canvas) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const w = Math.max(1, canvas.clientWidth * dpr);
		const h = Math.max(1, canvas.clientHeight * dpr);
		runtime.resize(w, h);
	}

	onMount(() => {
		(async () => {
			unsub = await vis.subscribe();
			await start();
			if (canvas) {
				resizeObserver = new ResizeObserver(onResize);
				resizeObserver.observe(canvas);
			}
		})();
	});

	onDestroy(() => {
		started = false;
		cancelAnimationFrame(raf);
		resizeObserver?.disconnect();
		runtime.dispose();
		unsub?.();
	});
</script>

<div class="runtime-host">
	<canvas bind:this={canvas} aria-label="Music visualizer runtime"></canvas>
	{#if errorMsg}
		<div class="error">Runtime error: {errorMsg}</div>
	{/if}
	{#if showHud && !errorMsg}
		<div class="hud">runtime · {activeMotifWeights}</div>
	{/if}
</div>

<style>
	.runtime-host {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: #000;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	.hud {
		position: absolute;
		top: 12px;
		left: 14px;
		font: 11px/1 ui-monospace, monospace;
		color: rgba(255, 255, 255, 0.55);
		letter-spacing: 0.06em;
		text-transform: lowercase;
		pointer-events: none;
	}
	.error {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font: 12px/1.4 ui-monospace, monospace;
		color: #ffb3b3;
		background: rgba(0, 0, 0, 0.78);
		padding: 24px;
		text-align: center;
	}
</style>
