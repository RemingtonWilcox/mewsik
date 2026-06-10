<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import VisualizerMk1 from './visualizer.svelte';
	import VisualizerMk2 from './visualizer-mk2.svelte';
	import VisualizerMk3 from './visualizer-mk3.svelte';
	import VisualizerRuntime from './visualizer-runtime.svelte';
	import {
		useVisualizer,
		VISUALIZER_ENGINES,
		type RenderVisualizerEngine
	} from '$lib/state/visualizer.svelte';
	import { createVisualDirector } from '$lib/visualizer/visual-director';

	const vis = useVisualizer();
	const director = createVisualDirector();
	let autoEngine = $state<RenderVisualizerEngine>('mk2');
	let raf = 0;
	let lastSwitchAt = 0;

	// Transient on-screen label when the user cycles engines with the V key.
	let engineFlash = $state('');
	let engineFlashTimer: ReturnType<typeof setTimeout> | null = null;

	function cycleEngine(dirn: 1 | -1) {
		const order = VISUALIZER_ENGINES;
		const idx = order.indexOf(vis.engine);
		const next = order[(idx + dirn + order.length) % order.length];
		vis.setEngine(next);
		engineFlash = next === 'auto' ? 'auto (director picks)' : next;
		if (engineFlashTimer) clearTimeout(engineFlashTimer);
		engineFlashTimer = setTimeout(() => (engineFlash = ''), 1800);
	}

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
		// V / Shift+V cycles engines: auto → mk1 → mk2 → mk3 → runtime.
		if (e.key === 'v' || e.key === 'V') {
			e.preventDefault();
			cycleEngine(e.shiftKey ? -1 : 1);
		}
	}}
/>

{#if vis.active}
	{#if engineFlash}
		<div
			class="pointer-events-none fixed left-1/2 top-8 z-[106] -translate-x-1/2 rounded border border-white/20 bg-black/60 px-3 py-1.5 font-mono text-sm tracking-wide text-white/90"
		>
			engine: {engineFlash}
		</div>
	{/if}
	<div class="pointer-events-none fixed bottom-24 right-6 z-[106] font-mono text-[11px] text-white/35">
		esc exit · v next engine
	</div>
	{#if vis.engine === 'runtime'}
		<!-- The runtime component fills its parent and has no exit affordance of
		     its own, so the host provides the fullscreen layer + click-to-exit. -->
		<div
			class="fixed inset-0 z-[100] bg-black"
			role="button"
			aria-label="Close visualizer"
			tabindex="0"
			onclick={() => vis.toggle()}
			onkeydown={(e) => {
				if (e.key === 'Escape') vis.toggle();
			}}
		>
			<VisualizerRuntime showHud={false} />
			<div class="pointer-events-none absolute right-6 top-6 text-xs text-white/40">
				click anywhere or press esc to exit
			</div>
		</div>
	{:else if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk1'}
		<VisualizerMk1 showHud={true} />
	{:else if (vis.engine === 'auto' ? autoEngine : vis.engine) === 'mk2'}
		<VisualizerMk2 showHud={true} />
	{:else}
		<VisualizerMk3 showHud={true} />
	{/if}
{/if}
