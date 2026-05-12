<script lang="ts">
	// Browser-based visualizer lab. Run with `pnpm dev` and open
	// http://localhost:5173/visualizer-test in any Chromium browser to iterate
	// on shader code without rebuilding Tauri. Drop an audio file or paste a
	// URL; the Web Audio API analyser drives the visualizer with the same
	// feature payload the Rust analyzer emits in production (FFT bins, BPM,
	// chroma, onset etc.).
	import { onMount, onDestroy } from 'svelte';
	import Visualizer from '$lib/components/visualizer/visualizer.svelte';
	import { useVisualizer, PRESET_NAMES } from '$lib/state/visualizer.svelte';
	import { WebAnalyzer } from '$lib/audio/web-analyzer';

	const vis = useVisualizer();

	let audioEl = $state<HTMLAudioElement | null>(null);
	let audioCtx: AudioContext | null = null;
	let analyzer: WebAnalyzer | null = null;
	let setupDone = false;
	let raf = 0;
	let urlInput = $state('');
	let manualPreset = $state(-1); // -1 = auto, 0..3 = force preset
	let lastFeatures = $state<{ bpm: number; chromaKey: number; chromaStrength: number } | null>(
		null
	);

	function ensureSetup(): boolean {
		if (setupDone || !audioEl) return setupDone;
		audioCtx = new AudioContext();
		const source = audioCtx.createMediaElementSource(audioEl);
		analyzer = new WebAnalyzer(audioCtx, source);
		// Route to speakers too so we hear playback.
		analyzer['analyser'].connect(audioCtx.destination);
		setupDone = true;
		return true;
	}

	function tick() {
		if (analyzer) {
			const features = analyzer.tick();
			if (features) {
				vis.latest = features;
				lastFeatures = {
					bpm: features.bpm,
					chromaKey: features.chroma_key,
					chromaStrength: features.chroma_strength
				};
			}
		}
		// Manual preset override via vis.forcedPreset — the visualizer loop honors
		// this and renders only that preset at full weight, skipping auto-blend.
		if (vis.forcedPreset !== manualPreset) {
			vis.forcedPreset = manualPreset;
		}
		raf = requestAnimationFrame(tick);
	}

	function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !audioEl) return;
		audioEl.src = URL.createObjectURL(file);
		audioEl.play().catch(() => {});
		ensureSetup();
	}

	function loadUrl() {
		if (!audioEl || !urlInput) return;
		audioEl.crossOrigin = 'anonymous';
		audioEl.src = urlInput;
		audioEl.play().catch(() => {});
		ensureSetup();
	}

	onMount(() => {
		vis.active = true;
		raf = requestAnimationFrame(tick);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
		vis.active = false;
		audioCtx?.close().catch(() => {});
	});
</script>

<svelte:window
	onkeydown={(e) => {
		// 0 = auto, 1-4 = force a preset (1-indexed for keyboard friendliness).
		if (e.key === '0') manualPreset = -1;
		else if (e.key >= '1' && e.key <= '4') manualPreset = parseInt(e.key, 10) - 1;
	}}
/>

<div
	class="pointer-events-none fixed inset-x-0 top-0 z-[200] flex flex-col gap-3 p-4 text-xs text-white"
	style="background: linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%);"
>
	<div class="pointer-events-auto flex flex-wrap items-center gap-4">
		<span class="font-mono opacity-70">visualizer lab</span>
		<input
			type="file"
			accept="audio/*"
			onchange={onFile}
			class="text-xs file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-white"
		/>
		<input
			type="text"
			bind:value={urlInput}
			placeholder="or paste audio URL"
			class="w-72 rounded border border-white/20 bg-black/40 px-2 py-1 placeholder-white/40 outline-none"
		/>
		<button
			onclick={loadUrl}
			class="rounded border border-white/20 px-2 py-1 hover:bg-white/10"
		>
			load
		</button>
		<audio bind:this={audioEl} controls class="ml-auto h-8 w-72"></audio>
	</div>
	<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono opacity-80">
		<span>
			preset: <strong>{PRESET_NAMES[vis.preset] ?? '?'}</strong>
			{#if manualPreset >= 0}<span class="text-amber-300">(forced)</span>{/if}
		</span>
		<span class="opacity-60">|</span>
		<span class="opacity-70">keys: 0=auto, 1=kaleido, 2=cathedral, 3=voronoi, 4=nebulae</span>
		{#if lastFeatures}
			<span class="opacity-60">|</span>
			<span>bpm: {lastFeatures.bpm.toFixed(0)}</span>
			<span>key: {lastFeatures.chromaKey.toFixed(2)}</span>
			<span>tonal: {lastFeatures.chromaStrength.toFixed(2)}</span>
		{/if}
	</div>
</div>

<Visualizer />
