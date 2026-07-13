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
	import VisualizerRuntime from '$lib/components/visualizer/visualizer-runtime.svelte';
	import {
		useVisualizer,
		PRESET_NAMES,
		type VisualizerEngine,
		type RenderVisualizerEngine
	} from '$lib/state/visualizer.svelte';
	import { WebAnalyzer } from '$lib/audio/web-analyzer';
	import {
		DEFAULT_RUNTIME_CONTROLS,
		type MotifWeights,
		type RuntimeControls
	} from '$lib/visualizer/runtime';

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

	// Runtime motif override — when manualMotifMode is on, the runtime uses
	// these sliders instead of the section-driven weight policy. Lets us
	// inspect each motif in isolation while iterating.
	let manualMotifMode = $state(false);
	let motifAtmosphere = $state(1.0);
	let motifReaction = $state(0.4);
	let motifAttractor = $state(0.45);
	let motifMandala = $state(0.35);
	let motifPhysarum = $state(0.5);
	let motifFlow = $state(0.5);
	let ctlMaster = $state(DEFAULT_RUNTIME_CONTROLS.master);
	let ctlExposure = $state(DEFAULT_RUNTIME_CONTROLS.exposure);
	let ctlBloom = $state(DEFAULT_RUNTIME_CONTROLS.bloom);
	let ctlBackground = $state(DEFAULT_RUNTIME_CONTROLS.background);
	let ctlContrast = $state(DEFAULT_RUNTIME_CONTROLS.contrast);
	let ctlSaturation = $state(DEFAULT_RUNTIME_CONTROLS.saturation);
	let ctlVignette = $state(DEFAULT_RUNTIME_CONTROLS.vignette);
	let ctlEdge = $state(DEFAULT_RUNTIME_CONTROLS.edge);
	let ctlChromatic = $state(DEFAULT_RUNTIME_CONTROLS.chromaticAberration);
	let ctlGrain = $state(DEFAULT_RUNTIME_CONTROLS.grain);
	// Feedback bank — the "live together" controls.
	let ctlFeedbackMix = $state(DEFAULT_RUNTIME_CONTROLS.feedbackMix);
	let ctlFeedbackDecay = $state(DEFAULT_RUNTIME_CONTROLS.feedbackDecay);
	let ctlFeedbackWarp = $state(DEFAULT_RUNTIME_CONTROLS.feedbackWarp);
	let ctlFeedbackRotation = $state(DEFAULT_RUNTIME_CONTROLS.feedbackRotation);
	// Per-motif generative controls.
	let ctlMandalaK = $state(DEFAULT_RUNTIME_CONTROLS.mandalaKFold);
	let ctlMandalaRings = $state(DEFAULT_RUNTIME_CONTROLS.mandalaRingDensity);
	let ctlFlowStrength = $state(DEFAULT_RUNTIME_CONTROLS.flowStrength);
	let ctlFlowCurl = $state(DEFAULT_RUNTIME_CONTROLS.flowCurlScale);
	let ctlPhysarumSense = $state(DEFAULT_RUNTIME_CONTROLS.physarumSense);
	const runtimeOverride = $derived<MotifWeights | null>(
		manualMotifMode
			? {
					atmosphere: motifAtmosphere,
					lattice: motifReaction,
					organism: motifAttractor,
					tunnel: motifMandala,
					particles: motifPhysarum,
					ribbon: motifFlow
				}
			: null
	);
	const runtimeControls = $derived<RuntimeControls>({
		master: ctlMaster,
		exposure: ctlExposure,
		bloom: ctlBloom,
		background: ctlBackground,
		contrast: ctlContrast,
		saturation: ctlSaturation,
		vignette: ctlVignette,
		edge: ctlEdge,
		chromaticAberration: ctlChromatic,
		grain: ctlGrain,
		feedbackMix: ctlFeedbackMix,
		feedbackDecay: ctlFeedbackDecay,
		feedbackWarp: ctlFeedbackWarp,
		feedbackRotation: ctlFeedbackRotation,
		mandalaKFold: ctlMandalaK,
		mandalaRingDensity: ctlMandalaRings,
		flowStrength: ctlFlowStrength,
		flowCurlScale: ctlFlowCurl,
		physarumSense: ctlPhysarumSense
	});

	function resetRuntimeControls() {
		ctlMaster = DEFAULT_RUNTIME_CONTROLS.master;
		ctlExposure = DEFAULT_RUNTIME_CONTROLS.exposure;
		ctlBloom = DEFAULT_RUNTIME_CONTROLS.bloom;
		ctlBackground = DEFAULT_RUNTIME_CONTROLS.background;
		ctlContrast = DEFAULT_RUNTIME_CONTROLS.contrast;
		ctlSaturation = DEFAULT_RUNTIME_CONTROLS.saturation;
		ctlVignette = DEFAULT_RUNTIME_CONTROLS.vignette;
		ctlEdge = DEFAULT_RUNTIME_CONTROLS.edge;
		ctlChromatic = DEFAULT_RUNTIME_CONTROLS.chromaticAberration;
		ctlGrain = DEFAULT_RUNTIME_CONTROLS.grain;
		ctlFeedbackMix = DEFAULT_RUNTIME_CONTROLS.feedbackMix;
		ctlFeedbackDecay = DEFAULT_RUNTIME_CONTROLS.feedbackDecay;
		ctlFeedbackWarp = DEFAULT_RUNTIME_CONTROLS.feedbackWarp;
		ctlFeedbackRotation = DEFAULT_RUNTIME_CONTROLS.feedbackRotation;
		ctlMandalaK = DEFAULT_RUNTIME_CONTROLS.mandalaKFold;
		ctlMandalaRings = DEFAULT_RUNTIME_CONTROLS.mandalaRingDensity;
		ctlFlowStrength = DEFAULT_RUNTIME_CONTROLS.flowStrength;
		ctlFlowCurl = DEFAULT_RUNTIME_CONTROLS.flowCurlScale;
		ctlPhysarumSense = DEFAULT_RUNTIME_CONTROLS.physarumSense;
	}

	function soloMotif(
		name: 'atmosphere' | 'reaction' | 'attractor' | 'mandala' | 'physarum' | 'flow'
	) {
		manualMotifMode = true;
		motifAtmosphere = name === 'atmosphere' ? 1 : 0;
		motifReaction = name === 'reaction' ? 1 : 0;
		motifAttractor = name === 'attractor' ? 1 : 0;
		motifMandala = name === 'mandala' ? 1 : 0;
		motifPhysarum = name === 'physarum' ? 1 : 0;
		motifFlow = name === 'flow' ? 1 : 0;
	}
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
		else if (e.key.toLowerCase() === 'r') setEngine('runtime');
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
			<button
				onclick={() => setEngine('runtime')}
				class={`border-l border-white/20 px-3 py-1 ${engine === 'runtime' ? 'bg-white text-black' : 'bg-black/40 hover:bg-white/10'}`}
			>
				runtime
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
			<span class="text-white/50">keys: a auto, q/w/e/r engines</span>
		{:else if engine === 'runtime'}
			<span><strong>runtime</strong> unified director-driven runtime</span>
			<span class="text-white/50">atm · rd · phy · flow + bloom + AgX</span>
		{:else}
			<span><strong>auto</strong> directed engine flow → {autoEngine}</span>
			<span class="text-white/50">keys: q/w/e/r lock engines</span>
		{/if}
		{#if lastFeatures}
			<span class="text-white/50">|</span>
			<span>bpm: {lastFeatures.bpm.toFixed(0)}</span>
			<span>key: {lastFeatures.chromaKey.toFixed(2)}</span>
			<span>tonal: {lastFeatures.chromaStrength.toFixed(2)}</span>
		{/if}
	</div>
	{#if engine === 'runtime'}
		<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono text-xs">
			<label class="flex items-center gap-1 rounded border border-white/20 bg-black/40 px-2 py-1">
				<input type="checkbox" bind:checked={manualMotifMode} />
				<span>manual</span>
			</label>
			<div class="flex flex-1 flex-wrap items-center gap-3" class:opacity-40={!manualMotifMode}>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('atmosphere')}
					>
						solo atm
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifAtmosphere}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifAtmosphere.toFixed(2)}</span>
				</div>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('reaction')}
					>
						solo rd
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifReaction}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifReaction.toFixed(2)}</span>
				</div>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('attractor')}
					>
						solo att
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifAttractor}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifAttractor.toFixed(2)}</span>
				</div>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('mandala')}
					>
						solo man
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifMandala}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifMandala.toFixed(2)}</span>
				</div>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('physarum')}
					>
						solo phy
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifPhysarum}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifPhysarum.toFixed(2)}</span>
				</div>
				<div class="flex items-center gap-1">
					<button
						class="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10"
						onclick={() => soloMotif('flow')}
					>
						solo flow
					</button>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={motifFlow}
						disabled={!manualMotifMode}
						class="w-24"
					/>
					<span class="w-10 text-white/70">{motifFlow.toFixed(2)}</span>
				</div>
			</div>
		</div>
		<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono text-xs">
			<button
				class="rounded border border-white/20 bg-black/40 px-2 py-1 hover:bg-white/10"
				onclick={resetRuntimeControls}
			>
				reset image
			</button>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">master</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlMaster} class="w-24" />
				<span class="w-10 text-white/70">{ctlMaster.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">expose</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlExposure} class="w-24" />
				<span class="w-10 text-white/70">{ctlExposure.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">bloom</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlBloom} class="w-24" />
				<span class="w-10 text-white/70">{ctlBloom.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">bg</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlBackground} class="w-24" />
				<span class="w-10 text-white/70">{ctlBackground.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">contrast</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlContrast} class="w-24" />
				<span class="w-10 text-white/70">{ctlContrast.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">sat</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlSaturation} class="w-24" />
				<span class="w-10 text-white/70">{ctlSaturation.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">vign</span>
				<input type="range" min="0" max="1.5" step="0.01" bind:value={ctlVignette} class="w-24" />
				<span class="w-10 text-white/70">{ctlVignette.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">edge</span>
				<input type="range" min="0" max="1.5" step="0.01" bind:value={ctlEdge} class="w-24" />
				<span class="w-10 text-white/70">{ctlEdge.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">ca</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlChromatic} class="w-24" />
				<span class="w-10 text-white/70">{ctlChromatic.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">grain</span>
				<input type="range" min="0" max="2" step="0.01" bind:value={ctlGrain} class="w-24" />
				<span class="w-10 text-white/70">{ctlGrain.toFixed(2)}</span>
			</div>
		</div>
		<div class="pointer-events-auto flex flex-wrap items-center gap-3 font-mono text-xs">
			<span class="font-bold text-white/80">feedback</span>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">mix</span>
				<input type="range" min="0" max="1" step="0.01" bind:value={ctlFeedbackMix} class="w-24" />
				<span class="w-10 text-white/70">{ctlFeedbackMix.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">decay</span>
				<input
					type="range"
					min="0.5"
					max="0.999"
					step="0.001"
					bind:value={ctlFeedbackDecay}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlFeedbackDecay.toFixed(3)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">warp</span>
				<input
					type="range"
					min="0"
					max="1.5"
					step="0.01"
					bind:value={ctlFeedbackWarp}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlFeedbackWarp.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">rot</span>
				<input
					type="range"
					min="0"
					max="1.5"
					step="0.01"
					bind:value={ctlFeedbackRotation}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlFeedbackRotation.toFixed(2)}</span>
			</div>
			<span class="font-bold text-white/80">motif gen</span>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">man k</span>
				<input
					type="range"
					min="2"
					max="16"
					step="1"
					bind:value={ctlMandalaK}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlMandalaK.toFixed(0)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">man rings</span>
				<input
					type="range"
					min="2"
					max="14"
					step="0.1"
					bind:value={ctlMandalaRings}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlMandalaRings.toFixed(1)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">flow</span>
				<input
					type="range"
					min="0.2"
					max="3"
					step="0.01"
					bind:value={ctlFlowStrength}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlFlowStrength.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">curl</span>
				<input
					type="range"
					min="0.3"
					max="4"
					step="0.01"
					bind:value={ctlFlowCurl}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlFlowCurl.toFixed(2)}</span>
			</div>
			<div class="flex items-center gap-1">
				<span class="w-12 text-white/60">phy sense</span>
				<input
					type="range"
					min="0.1"
					max="1.2"
					step="0.01"
					bind:value={ctlPhysarumSense}
					class="w-24"
				/>
				<span class="w-10 text-white/70">{ctlPhysarumSense.toFixed(2)}</span>
			</div>
		</div>
	{/if}
</div>

{#if engine === 'runtime'}
	<VisualizerRuntime showHud={false} overrideWeights={runtimeOverride} controls={runtimeControls} />
{:else if (engine === 'auto' ? autoEngine : engine) === 'mk1'}
	<VisualizerMk1 showHud={false} />
{:else if (engine === 'auto' ? autoEngine : engine) === 'mk2'}
	<VisualizerMk2 showHud={false} />
{:else}
	<VisualizerMk3 showHud={false} />
{/if}
