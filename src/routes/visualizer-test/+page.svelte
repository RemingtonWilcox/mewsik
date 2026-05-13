<script lang="ts">
	// Browser-based visualizer lab. Run with `pnpm dev` and open
	// http://localhost:5173/visualizer-test in any Chromium browser to iterate
	// on shader code without rebuilding Tauri. Drop an audio file or paste a
	// URL; the Web Audio API analyser drives the visualizer with the same
	// feature payload the Rust analyzer emits in production (FFT bins, BPM,
	// chroma, onset etc.).
	import { onMount, onDestroy } from 'svelte';
	import VisualizerMk1 from '$lib/components/visualizer/visualizer.svelte';
	import VisualizerMk2 from '$lib/components/visualizer/visualizer-mk2.svelte';
	import VisualizerMk3 from '$lib/components/visualizer/visualizer-mk3.svelte';
	import {
		useVisualizer,
		PRESET_NAMES,
		type VisualizerEngine,
		type RenderVisualizerEngine
	} from '$lib/state/visualizer.svelte';
	import { WebAnalyzer } from '$lib/audio/web-analyzer';

	type LabEngine = VisualizerEngine;
	type LabRenderEngine = RenderVisualizerEngine;

	const vis = useVisualizer();
	const SILENT_BINS = Array.from({ length: 64 }, () => 0);

	let audioEl = $state<HTMLAudioElement | null>(null);
	let audioCtx: AudioContext | null = null;
	let analyzer: WebAnalyzer | null = null;
	let setupDone = false;
	let raf = 0;
	let urlInput = $state('');
	let engine = $state<LabEngine>('auto');
	let autoEngine = $state<LabRenderEngine>('mk2');
	let demoMode = $state(true);
	let manualPreset = $state(-1); // -1 = auto, 0..3 = force preset
	let lastFeatures = $state<{ bpm: number; chromaKey: number; chromaStrength: number } | null>(
		null
	);
	let lastObjectUrl: string | null = null;

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

	function demoFeatures(): NonNullable<typeof vis.latest> {
		const t = performance.now() / 1000;
		const arrangement = (t % 48) / 48;
		const build = arrangement < 0.44 ? arrangement / 0.44 : 0;
		const drop = arrangement >= 0.44 && arrangement < 0.70 ? 1 : 0;
		const release = arrangement >= 0.70 ? (arrangement - 0.70) / 0.30 : 0;
		const energyCurve =
			arrangement < 0.44
				? 0.18 + build * 0.64
				: arrangement < 0.70
					? 0.86 + Math.sin(t * 0.45) * 0.10
					: 0.72 * (1 - release) + 0.12;
		const phrase = Math.max(0, Math.min(1, energyCurve));
		const bpm = 96 + phrase * 34;
		const beatPhase = (t * bpm / 60) % 1;
		const kick = Math.exp(-Math.pow(beatPhase * 9, 2.0));
		const offKick = Math.exp(-Math.pow((((beatPhase + 0.5) % 1) * 10), 2.0)) * 0.55;
		const hook = Math.sin(t * 0.75) * 0.5 + 0.5;
		const pulse = Math.max(kick, offKick * (0.4 + phrase));
		const bass = Math.min(1, 0.10 + phrase * 0.42 + pulse * (0.30 + drop * 0.30));
		const mid = Math.min(1, 0.18 + phrase * 0.36 + hook * 0.24 + build * 0.18);
		const treble = Math.min(1, 0.16 + phrase * 0.26 + (Math.sin(t * 7.3) + 1) * 0.18 + drop * 0.12);
		const bins = Array.from({ length: 64 }, (_, i) => {
			const x = i / 63;
			const low = Math.exp(-x * 5.5) * bass;
			const body = Math.exp(-Math.abs(x - 0.38) * 7) * mid;
			const air = Math.exp(-Math.abs(x - 0.78) * 12) * treble;
			const ripple = (Math.sin(t * (2.2 + x * 8) + i * 0.31) + 1) * 0.055;
			return Math.min(1, low + body + air + ripple);
		});

		return {
			bins,
			rms: Math.min(1, 0.08 + phrase * 0.42 + bass * 0.20 + mid * 0.10),
			peak: Math.min(1, 0.32 + bass * 0.58),
			centroid: Math.min(1, 0.25 + treble * 0.5 + phrase * 0.18),
			onset: beatPhase < 0.055 && phrase > 0.25,
			bass,
			mid,
			treble,
			sample_rate: 44100,
			bpm,
			beat_phase: beatPhase,
			chroma_key: ((arrangement * 18 + hook * 2) % 12),
			chroma_strength: 0.34 + phrase * 0.50
		};
	}

	function silenceFeatures(): NonNullable<typeof vis.latest> {
		return {
			bins: SILENT_BINS,
			rms: 0,
			peak: 0,
			centroid: 0,
			onset: false,
			bass: 0,
			mid: 0,
			treble: 0,
			sample_rate: 44100,
			bpm: 0,
			beat_phase: 0,
			chroma_key: 0,
			chroma_strength: 0
		};
	}

	function tick() {
		let currentFeatures: NonNullable<typeof vis.latest> | null = null;
		if (demoMode) {
			const features = demoFeatures();
			currentFeatures = features;
			vis.latest = features;
			lastFeatures = {
				bpm: features.bpm,
				chromaKey: features.chroma_key,
				chromaStrength: features.chroma_strength
			};
		} else if (analyzer) {
			const features = analyzer.tick();
			if (features) {
				currentFeatures = features;
				vis.latest = features;
				lastFeatures = {
					bpm: features.bpm,
					chromaKey: features.chroma_key,
					chromaStrength: features.chroma_strength
				};
			}
		} else {
			const features = silenceFeatures();
			currentFeatures = features;
			vis.latest = features;
			lastFeatures = {
				bpm: features.bpm,
				chromaKey: features.chroma_key,
				chromaStrength: features.chroma_strength
			};
		}
		// Manual preset override via vis.forcedPreset — the visualizer loop honors
		// this and renders only that preset at full weight, skipping auto-blend.
		if (vis.forcedPreset !== manualPreset) {
			vis.forcedPreset = manualPreset;
		}
		if (vis.engine !== engine) {
			vis.setEngine(engine);
		}
		if (engine === 'auto' && currentFeatures) {
			const energy = currentFeatures.rms * 0.9 + currentFeatures.bass * 0.35 + (currentFeatures.onset ? 0.2 : 0);
			const motion = currentFeatures.bass * 0.45 + currentFeatures.mid * 0.35 + currentFeatures.treble * 0.15;
			const section = energy > 0.82 ? 'peak' : motion > 0.52 ? 'rising' : energy < 0.28 ? 'calm' : 'body';
			autoEngine = section === 'peak' ? 'mk3' : section === 'rising' || section === 'body' ? 'mk2' : 'mk1';
		}
		raf = requestAnimationFrame(tick);
	}

	function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !audioEl) return;
		if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
		lastObjectUrl = URL.createObjectURL(file);
		audioEl.src = lastObjectUrl;
		audioEl.play().catch(() => {});
		demoMode = false;
		ensureSetup();
	}

	function loadUrl() {
		if (!audioEl || !urlInput) return;
		audioEl.crossOrigin = 'anonymous';
		audioEl.src = urlInput;
		audioEl.play().catch(() => {});
		demoMode = false;
		ensureSetup();
	}

	function setEngine(next: LabEngine) {
		engine = next;
		vis.setEngine(next);
	}

	onMount(() => {
		engine = vis.engine;
		vis.active = true;
		raf = requestAnimationFrame(tick);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
		vis.active = false;
		vis.forcedPreset = -1;
		if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
		audioCtx?.close().catch(() => {});
	});
</script>

<svelte:window
	onkeydown={(e) => {
		// 0 = auto, 1-4 = force a preset (1-indexed for keyboard friendliness).
		if (e.key === '0') manualPreset = -1;
		else if (e.key >= '1' && e.key <= '4') manualPreset = parseInt(e.key, 10) - 1;
		else if (e.key.toLowerCase() === 'a') setEngine('auto');
		else if (e.key.toLowerCase() === 'q') setEngine('mk1');
		else if (e.key.toLowerCase() === 'w') setEngine('mk2');
		else if (e.key.toLowerCase() === 'e') setEngine('mk3');
	}}
/>

<div
	class="pointer-events-none fixed inset-x-0 top-0 flex flex-col gap-3 p-4 text-xs text-white"
	style="z-index: 300; background: linear-gradient(180deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0) 100%);"
>
	<div class="pointer-events-auto flex flex-wrap items-center gap-3">
		<span class="font-mono text-white/70">visualizer lab</span>
		<div class="flex overflow-hidden rounded border border-white/20">
			<button
				onclick={() => setEngine('auto')}
				class={`px-3 py-1 ${engine === 'auto' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
			>
				auto
			</button>
			<button
				onclick={() => setEngine('mk1')}
				class={`border-l border-white/20 px-3 py-1 ${engine === 'mk1' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
			>
				mk1
			</button>
			<button
				onclick={() => setEngine('mk2')}
				class={`border-l border-white/20 px-3 py-1 ${engine === 'mk2' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
			>
				mk2
			</button>
			<button
				onclick={() => setEngine('mk3')}
				class={`border-l border-white/20 px-3 py-1 ${engine === 'mk3' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
			>
				mk3
			</button>
		</div>
		<label class="flex items-center gap-2 rounded border border-white/20 bg-black/40 px-2 py-1">
			<input type="checkbox" bind:checked={demoMode} />
			synthetic signal
		</label>
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
		<button onclick={loadUrl} class="rounded border border-white/20 px-2 py-1 hover:bg-white/10">
			load
		</button>
		<audio bind:this={audioEl} controls class="h-8 w-64 max-w-full"></audio>
	</div>
	<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono text-white/80">
		{#if engine === 'mk1'}
			<span>
				preset: <strong>{PRESET_NAMES[vis.preset] ?? '?'}</strong>
				{#if manualPreset >= 0}<span class="text-amber-300">(forced)</span>{/if}
			</span>
			<span class="text-white/50">keys: a auto, q/w/e engines, 0-4 mk1 presets</span>
		{:else if engine === 'mk2'}
			<span><strong>mk2</strong> mandelbulb + volumetric section state machine</span>
			<span class="text-white/50">keys: a auto, q/w/e engines</span>
		{:else if engine === 'mk3'}
			<span><strong>mk3</strong> gpu compute particle field + camera traversal</span>
			<span class="text-white/50">keys: a auto, q/w/e engines</span>
		{:else}
			<span><strong>auto</strong> directed engine flow → {autoEngine}</span>
			<span class="text-white/50">keys: q/w/e lock engines</span>
		{/if}
		{#if lastFeatures}
			<span class="text-white/50">|</span>
			<span>bpm: {lastFeatures.bpm.toFixed(0)}</span>
			<span>key: {lastFeatures.chromaKey.toFixed(2)}</span>
			<span>tonal: {lastFeatures.chromaStrength.toFixed(2)}</span>
		{/if}
	</div>
</div>

{#if (engine === 'auto' ? autoEngine : engine) === 'mk1'}
	<VisualizerMk1 showHud={false} />
{:else if (engine === 'auto' ? autoEngine : engine) === 'mk2'}
	<VisualizerMk2 showHud={false} />
{:else}
	<VisualizerMk3 showHud={false} />
{/if}
