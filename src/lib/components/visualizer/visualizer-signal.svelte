<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { useVisualizer, type AudioFeatures } from '$lib/state/visualizer.svelte';
	import { usePlayer } from '$lib/state/player.svelte';
	import {
		SIGNAL_COMPOSITE_WGSL,
		SIGNAL_DECAY_WGSL,
		SIGNAL_TRACE_WGSL,
		SIGNAL_TRACE_INSTANCES,
		SIGNAL_VERTEX_COUNT
	} from '$lib/visualizer/signal/shaders';
	import {
		SignalSpectrumTracker,
		type SignalSpectrumProfile
	} from '$lib/visualizer/signal/spectrum';
	import { SignalConductor } from '$lib/visualizer/signal/conductor';

	const vis = useVisualizer();
	const player = usePlayer();
	let { showHud = false } = $props<{ showHud?: boolean }>();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let raf = 0;
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let initVersion = 0;
	let initializing = false;

	const BIN_COUNT = 64;
	const UNIFORM_FLOATS = 48;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
	const BINS_BYTES = BIN_COUNT * 4;
	const FRAME_INTERVAL_MS = 1000 / 60;
	const INTERNAL_SCALE = 0.75;
	const MAX_INTERNAL_PIXELS = 1920 * 1080;

	const smoothed = {
		bins: new Float32Array(BIN_COUNT),
		bass: 0,
		mid: 0,
		treble: 0,
		rms: 0,
		centroid: 0.42,
		chroma: 0,
		chromaStrength: 0,
		transient: 0,
		silence: 1,
		phase: 0
	};

	type Targets = {
		feedback: [GPUTexture, GPUTexture];
		views: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type SignalGpu = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuffer: GPUBuffer;
		binsBuffer: GPUBuffer;
		uniformData: Float32Array;
		pipelines: {
			decay: GPURenderPipeline;
			trace: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: Targets | null;
		bindGroups: {
			decay: [GPUBindGroup, GPUBindGroup];
			trace: GPUBindGroup;
			composite: [GPUBindGroup, GPUBindGroup];
		} | null;
		frame: number;
	};

	let gpu: SignalGpu | null = null;
	let startTime = 0;
	let schedulerTickAt = 0;
	let renderBudgetMs = FRAME_INTERVAL_MS;
	let lastRenderedAt = 0;
	let quietFor = 0;
	let onsetLatched = false;
	const sessionSeed = Math.random();
	const spectrumTracker = new SignalSpectrumTracker();
	const conductor = new SignalConductor(sessionSeed);
	let signalTrackKey: string | null = null;
	let audioWarmupFrames = 0;
	let feedbackResetRequested = true;
	let hudSection = $state('intro');
	let hudTempo = $state(0);
	let hudContext = $state<'live' | 'score'>('live');
	let lastHudUpdateAt = 0;

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function approachCircular(current: number, target: number, rate: number, dt: number) {
		// Wrap into [-0.5, 0.5) before easing so B -> C takes the short route
		// across the pitch-class boundary instead of sweeping through every key.
		const delta = ((((target - current + 0.5) % 1) + 1) % 1) - 0.5;
		return (((current + delta * (1 - Math.exp(-rate * dt))) % 1) + 1) % 1;
	}

	function normalizeChroma(value: number) {
		if (!Number.isFinite(value)) return 0;
		// Native audio emits 0..1. The browser lab historically used pitch-class
		// values 0..11, so accepting both keeps Signal useful in either runtime.
		return value > 1 ? (((value % 12) + 12) % 12) / 12 : clamp(value, 0, 1);
	}

	function smoothAudio(
		dt: number,
		feature: AudioFeatures | null,
		spectrum: Readonly<SignalSpectrumProfile>
	) {
		const incomingBins = feature?.bins ?? [];
		for (let i = 0; i < BIN_COUNT; i += 1) {
			const target = clamp(incomingBins[i] ?? 0, 0, 1);
			const rate = target > smoothed.bins[i] ? 24 : 7;
			smoothed.bins[i] = approach(smoothed.bins[i], target, rate, dt);
		}

		// The payload's historical bass/mid/treble fields slice logarithmic bins by
		// index, so they do not describe musical bands. Signal derives real Hz
		// ranges and adaptive levels in SignalSpectrumTracker instead.
		const bassTarget = clamp(feature ? spectrum.bass : 0, 0, 1);
		const midTarget = clamp(feature ? spectrum.mid : 0, 0, 1);
		const trebleTarget = clamp(feature ? spectrum.treble : 0, 0, 1);
		const rmsTarget = clamp(feature?.rms ?? 0, 0, 1);
		smoothed.bass = approach(smoothed.bass, bassTarget, bassTarget > smoothed.bass ? 18 : 6, dt);
		smoothed.mid = approach(smoothed.mid, midTarget, midTarget > smoothed.mid ? 14 : 5, dt);
		smoothed.treble = approach(
			smoothed.treble,
			trebleTarget,
			trebleTarget > smoothed.treble ? 22 : 8,
			dt
		);
		smoothed.rms = approach(smoothed.rms, rmsTarget, rmsTarget > smoothed.rms ? 18 : 7, dt);
		smoothed.centroid = approach(
			smoothed.centroid,
			clamp(feature ? spectrum.centroid : 0.42, 0, 1),
			2.5,
			dt
		);
		smoothed.chroma = approachCircular(
			smoothed.chroma,
			normalizeChroma(feature?.chroma_key ?? 0),
			1.8,
			dt
		);
		smoothed.chromaStrength = approach(
			smoothed.chromaStrength,
			clamp(feature?.chroma_strength ?? 0, 0, 1),
			2.8,
			dt
		);

		const transientHit = feature?.onset === true || (feature !== null && spectrum.novelty > 0.62);
		if (transientHit && !onsetLatched) {
			smoothed.transient = 1;
			onsetLatched = true;
		} else if (!transientHit) {
			onsetLatched = false;
		}
		smoothed.transient *= Math.exp(-7.2 * dt);

		if (!feature || rmsTarget < 0.009) quietFor += dt;
		else quietFor = 0;
		const silenceTarget = quietFor > 0.45 ? 1 : 0;
		smoothed.silence = approach(smoothed.silence, silenceTarget, silenceTarget ? 4.5 : 11, dt);

	}

	function resetSignalState(seed: string | number) {
		spectrumTracker.reset();
		conductor.reset(seed);
		smoothed.bins.fill(0);
		smoothed.bass = 0;
		smoothed.mid = 0;
		smoothed.treble = 0;
		smoothed.rms = 0;
		smoothed.centroid = 0.42;
		smoothed.chroma = 0;
		smoothed.chromaStrength = 0;
		smoothed.transient = 0;
		smoothed.silence = 1;
		smoothed.phase = 0;
		quietFor = 0;
		onsetLatched = false;
		audioWarmupFrames = 3;
		feedbackResetRequested = true;
		lastRenderedAt = 0;
		lastHudUpdateAt = 0;
	}

	$effect(() => {
		const playback = player.state;
		const hasIdentity =
			playback.source !== null ||
			playback.current_recording_id !== null ||
			playback.current_source_url !== null ||
			playback.current_station_id !== null;
		const key = hasIdentity
			? JSON.stringify([
					playback.source,
					playback.current_recording_id,
					playback.current_source_url,
					playback.current_station_id
				])
			: null;
		if (key === signalTrackKey) return;
		signalTrackKey = key;
		resetSignalState(key ?? sessionSeed);
	});

	function createFeedbackTexture(device: GPUDevice, width: number, height: number) {
		return device.createTexture({
			size: { width, height },
			format: 'rgba16float',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	function destroyTargets(targets: Targets | null) {
		if (!targets) return;
		targets.feedback[0].destroy();
		targets.feedback[1].destroy();
	}

	function rebuildBindGroups(state: SignalGpu) {
		if (!state.targets) return null;
		const { device, pipelines, sampler, targets, uniformBuffer, binsBuffer } = state;
		const makeTextureGroup = (pipeline: GPURenderPipeline, view: GPUTextureView) =>
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: view }
				]
			});

		return {
			decay: [
				makeTextureGroup(pipelines.decay, targets.views[0]),
				makeTextureGroup(pipelines.decay, targets.views[1])
			] as [GPUBindGroup, GPUBindGroup],
			trace: device.createBindGroup({
				layout: pipelines.trace.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: binsBuffer } }
				]
			}),
			composite: [
				makeTextureGroup(pipelines.composite, targets.views[0]),
				makeTextureGroup(pipelines.composite, targets.views[1])
			] as [GPUBindGroup, GPUBindGroup]
		};
	}

	function ensureTargets(state: SignalGpu, width: number, height: number) {
		if (state.targets?.width === width && state.targets.height === height) return;
		destroyTargets(state.targets);
		const first = createFeedbackTexture(state.device, width, height);
		const second = createFeedbackTexture(state.device, width, height);
		state.targets = {
			feedback: [first, second],
			views: [first.createView(), second.createView()],
			width,
			height
		};
		state.bindGroups = rebuildBindGroups(state);
		state.frame = 0;
	}

	async function createPipeline(
		device: GPUDevice,
		code: string,
		format: GPUTextureFormat,
		blend?: GPUBlendState
	) {
		const module = device.createShaderModule({ code });
		return device.createRenderPipelineAsync({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_main' },
			fragment: {
				module,
				entryPoint: 'fs_main',
				targets: [{ format, blend }]
			},
			primitive: { topology: 'triangle-list' }
		});
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<SignalGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) {
			throw new Error('Signal needs WebGPU, but this WebView does not expose it.');
		}
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const device = (await adapter.requestDevice()) as GPUDevice;
		const context = targetCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
		if (!context) {
			device.destroy();
			throw new Error('The WebGPU canvas context could not be created.');
		}

		const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
		context.configure({ device, format, alphaMode: 'opaque' });

		const additiveBlend: GPUBlendState = {
			color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
			alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
		};
		let builtPipelines: [GPURenderPipeline, GPURenderPipeline, GPURenderPipeline];
		try {
			builtPipelines = await Promise.all([
				createPipeline(device, SIGNAL_DECAY_WGSL, 'rgba16float'),
				createPipeline(device, SIGNAL_TRACE_WGSL, 'rgba16float', additiveBlend),
				createPipeline(device, SIGNAL_COMPOSITE_WGSL, format)
			]);
		} catch (error) {
			// Pipeline validation is asynchronous. If WGSL compilation fails, release
			// the device immediately instead of leaving a half-initialized engine.
			device.destroy();
			throw error;
		}
		const [decay, trace, composite] = builtPipelines;

		const state: SignalGpu = {
			device,
			context,
			format,
			sampler: device.createSampler({
				magFilter: 'linear',
				minFilter: 'linear',
				addressModeU: 'clamp-to-edge',
				addressModeV: 'clamp-to-edge'
			}),
			uniformBuffer: device.createBuffer({
				size: UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			}),
			binsBuffer: device.createBuffer({
				size: BINS_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			}),
			uniformData: new Float32Array(UNIFORM_FLOATS),
			pipelines: { decay, trace, composite },
			targets: null,
			bindGroups: null,
			frame: 0
		};

		void device.lost.then((info) => {
			if (gpu?.device !== device) return;
			errorMsg = `The graphics device was lost${info.message ? `: ${info.message}` : '.'}`;
			ready = false;
			gpu = null;
		});

		return state;
	}

	function destroyGpuState(state: SignalGpu | null) {
		if (!state) return;
		destroyTargets(state.targets);
		state.uniformBuffer.destroy();
		state.binsBuffer.destroy();
		state.device.destroy();
	}

	function teardownGpu() {
		const state = gpu;
		gpu = null;
		ready = false;
		destroyGpuState(state);
	}

	function backingSize(targetCanvas: HTMLCanvasElement) {
		const cssWidth = Math.max(1, targetCanvas.clientWidth);
		const cssHeight = Math.max(1, targetCanvas.clientHeight);
		const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
		let width = Math.max(1, Math.floor(cssWidth * pixelRatio * INTERNAL_SCALE));
		let height = Math.max(1, Math.floor(cssHeight * pixelRatio * INTERNAL_SCALE));
		const pixels = width * height;
		if (pixels > MAX_INTERNAL_PIXELS) {
			const reduction = Math.sqrt(MAX_INTERNAL_PIXELS / pixels);
			width = Math.max(1, Math.floor(width * reduction));
			height = Math.max(1, Math.floor(height * reduction));
		}
		return { width, height };
	}

	function renderFrame(state: SignalGpu, now: number, dt: number) {
		if (!canvas) return;
		const { width, height } = backingSize(canvas);
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		if (feedbackResetRequested) {
			destroyTargets(state.targets);
			state.targets = null;
			state.bindGroups = null;
			state.frame = 0;
			feedbackResetRequested = false;
		}
		ensureTargets(state, width, height);
		if (!state.targets || !state.bindGroups) return;

		// The persistent director is advanced once per analyzer delivery. Signal
		// samples that shared song timeline and one freshness-checked raw frame at
		// the same timestamp, then translates it through its own visual language.
		const freshFeature = vis.getLatest(now);
		const feature = audioWarmupFrames > 0 ? null : freshFeature;
		if (audioWarmupFrames > 0) audioWarmupFrames -= 1;
		const directed = vis.getPerformance(now);
		const spectrum = spectrumTracker.update(feature, dt);
		smoothAudio(dt, feature, spectrum);
		const journey = conductor.update(directed, spectrum, dt);

		const audible = 1 - smoothed.silence;
		const phaseSpeed =
			0.012 + journey.tempo * 0.052 + journey.motion * 0.118 + smoothed.mid * 0.038;
		smoothed.phase = (smoothed.phase + dt * phaseSpeed * audible) % (Math.PI * 2);

		const energy = clamp(
			directed.energy * 0.52 +
				smoothed.rms * 0.3 +
				spectrum.levels.kick * 0.11 +
				spectrum.spectralMotion * 0.09,
			0,
			1
		);
		const persistenceAt60Hz = clamp(
			0.928 +
				journey.tension * 0.015 +
				(1 - journey.motion) * 0.006 -
				journey.release * 0.026 -
				journey.sectionPulse * 0.024 -
				smoothed.transient * 0.052,
			0.83,
			0.95
		);
		const lineWidth =
			1.02 +
			smoothed.treble * 0.3 +
			spectrum.crestFactor * 0.22 +
			journey.impact * 0.28 +
			energy * 0.16;
		const contextKeyStrength =
			directed.context.source === 'score' ? directed.context.keyConfidence : 0;
		const harmonicKey =
			contextKeyStrength > 0.1 ? directed.context.keyPitchClass : smoothed.chroma;
		const harmonicStrength = clamp(
			Math.max(smoothed.chromaStrength, contextKeyStrength * 0.86),
			0,
			1
		);
		const boundaryImpact = Math.max(journey.impact, journey.sectionPulse * 0.76);
		const asymmetrySign = journey.phraseVariation >= 0.5 ? 1 : -1;
		const signedAsymmetry = clamp(
			journey.asymmetry * asymmetrySign + spectrum.spectralDirection * 0.16,
			-1,
			1
		);

		if (now - lastHudUpdateAt >= 250) {
			lastHudUpdateAt = now;
			hudSection = directed.section;
			hudTempo = directed.clock.tempoBpm;
			hudContext = directed.context.source;
		}

		const uniforms = state.uniformData;
		uniforms[0] = width;
		uniforms[1] = height;
		uniforms[2] = (now - startTime) / 1000;
		uniforms[3] = dt;
		uniforms[4] = smoothed.bass;
		uniforms[5] = smoothed.mid;
		uniforms[6] = smoothed.treble;
		uniforms[7] = smoothed.rms;
		uniforms[8] = smoothed.transient;
		uniforms[9] = directed.clock.beatPhase;
		uniforms[10] = smoothed.centroid;
		uniforms[11] = harmonicKey;
		uniforms[12] = harmonicStrength;
		uniforms[13] = persistenceAt60Hz;
		uniforms[14] = smoothed.silence;
		uniforms[15] = smoothed.phase;
		uniforms[16] = lineWidth;
		uniforms[17] = energy;
		uniforms[18] = spectrum.crestFactor;
		uniforms[19] = spectrum.spectralMotion;
		uniforms[20] = directed.clock.beatPulse;
		uniforms[21] = journey.phrase;
		uniforms[22] = journey.tempo;
		uniforms[23] = directed.clock.downbeatFlag ? 1 : 0;
		uniforms[24] = journey.tension;
		uniforms[25] = journey.release;
		uniforms[26] = journey.openness;
		uniforms[27] = boundaryImpact;
		uniforms[28] = journey.shapeWeights.ellipse;
		uniforms[29] = journey.shapeWeights.lissajous;
		uniforms[30] = journey.shapeWeights.ribbon;
		uniforms[31] = journey.shapeWeights.rosette;
		uniforms[32] = directed.palette.baseHue;
		uniforms[33] = directed.palette.accentHue;
		uniforms[34] = directed.palette.rimHue;
		uniforms[35] = directed.palette.saturation;
		uniforms[36] = spectrum.levels.sub;
		uniforms[37] = spectrum.levels.kick;
		uniforms[38] = spectrum.levels.body;
		uniforms[39] = spectrum.levels.mids;
		uniforms[40] = spectrum.levels.presence;
		uniforms[41] = spectrum.levels.air;
		uniforms[42] = spectrum.centroidVelocity;
		uniforms[43] = signedAsymmetry;
		uniforms[44] = directed.context.sectionProgress;
		uniforms[45] = directed.context.energySlope;
		uniforms[46] = directed.context.energyLookahead;
		uniforms[47] = directed.context.sectionEnergy;

		state.device.queue.writeBuffer(
			state.uniformBuffer,
			0,
			uniforms.buffer,
			uniforms.byteOffset,
			uniforms.byteLength
		);
		state.device.queue.writeBuffer(
			state.binsBuffer,
			0,
			smoothed.bins.buffer,
			smoothed.bins.byteOffset,
			smoothed.bins.byteLength
		);

		const previous = (state.frame % 2) as 0 | 1;
		const next = (1 - previous) as 0 | 1;
		const encoder = state.device.createCommandEncoder({ label: 'Signal frame' });

		// Pass one: decay the previous phosphor state, then add the current trace.
		{
			const pass = encoder.beginRenderPass({
				label: 'Signal phosphor',
				colorAttachments: [
					{
						view: state.targets.views[next],
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(state.pipelines.decay);
			pass.setBindGroup(0, state.bindGroups.decay[previous]);
			pass.draw(3);
			pass.setPipeline(state.pipelines.trace);
			pass.setBindGroup(0, state.bindGroups.trace);
			pass.draw(SIGNAL_VERTEX_COUNT, SIGNAL_TRACE_INSTANCES);
			pass.end();
		}

		// Pass two: add the single scope graticule and present. No bloom pyramid,
		// particles, compute simulation, or stacked full-screen effects.
		{
			const pass = encoder.beginRenderPass({
				label: 'Signal present',
				colorAttachments: [
					{
						view: state.context.getCurrentTexture().createView(),
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(state.pipelines.composite);
			pass.setBindGroup(0, state.bindGroups.composite[next]);
			pass.draw(3);
			pass.end();
		}

		state.device.queue.submit([encoder.finish()]);
		state.frame += 1;
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;

		if (!schedulerTickAt) {
			schedulerTickAt = now;
			renderBudgetMs = FRAME_INTERVAL_MS;
		} else {
			const tickElapsed = Math.max(0, now - schedulerTickAt);
			schedulerTickAt = now;
			// Keep only a small catch-up budget. We render one current frame after a
			// stalled/backgrounded tab, never a burst of obsolete catch-up frames.
			renderBudgetMs = Math.min(
				FRAME_INTERVAL_MS * 4,
				renderBudgetMs + tickElapsed
			);
		}
		if (renderBudgetMs + 0.25 < FRAME_INTERVAL_MS) return;
		// Carry the fractional remainder forward. Subtracting first (rather than
		// taking budget % interval directly) avoids floating-point values just
		// below one interval wrapping back to a nearly-full budget. Drop whole
		// catch-up intervals after a stall; only the fractional remainder matters.
		let remainderMs = renderBudgetMs - FRAME_INTERVAL_MS;
		if (remainderMs >= FRAME_INTERVAL_MS) remainderMs %= FRAME_INTERVAL_MS;
		renderBudgetMs = Math.max(0, remainderMs);

		const elapsedMs = lastRenderedAt ? now - lastRenderedAt : FRAME_INTERVAL_MS;
		lastRenderedAt = now;
		const dt = Math.min(1, Math.max(0.001, elapsedMs / 1000));
		try {
			renderFrame(gpu, now, dt);
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : String(error);
			teardownGpu();
		}
	}

	$effect(() => {
		const targetCanvas = canvas;
		if (!targetCanvas) {
			initVersion += 1;
			initializing = false;
			teardownGpu();
			return;
		}
		if (gpu || initializing) return;

		const version = ++initVersion;
		initializing = true;
		errorMsg = null;
		ready = false;
		initGpu(targetCanvas)
			.then((state) => {
				if (version !== initVersion || canvas !== targetCanvas) {
					destroyGpuState(state);
					return;
				}
				gpu = state;
				startTime = performance.now();
				schedulerTickAt = 0;
				renderBudgetMs = FRAME_INTERVAL_MS;
				lastRenderedAt = 0;
				ready = true;
			})
			.catch((error) => {
				if (version !== initVersion) return;
				errorMsg = error instanceof Error ? error.message : String(error);
				ready = false;
			})
			.finally(() => {
				if (version === initVersion) initializing = false;
			});
	});

	onMount(async () => {
		running = true;
		startTime = performance.now();
		unsubscribe = await vis.subscribe();
		if (!running) {
			unsubscribe();
			unsubscribe = null;
			return;
		}
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		running = false;
		initVersion += 1;
		cancelAnimationFrame(raf);
		unsubscribe?.();
		unsubscribe = null;
		teardownGpu();
	});
</script>

{#if vis.active}
	<div class="fixed inset-0 z-[100] overflow-hidden bg-black">
		<canvas
			bind:this={canvas}
			class="h-full w-full"
			aria-label="Signal audio visualizer"
			data-signal-section={hudSection}
			data-signal-context={hudContext}
			data-signal-tempo={Math.round(hudTempo)}
		></canvas>

		{#if showHud}
			<button
				type="button"
				class="absolute inset-0 z-10 cursor-default border-0 bg-transparent p-0"
				aria-label="Close visualizer"
				onclick={() => vis.toggle()}
				onkeydown={(event) => {
					if (event.key === 'Escape') vis.toggle();
				}}
			></button>
			<div
				class="pointer-events-none absolute left-6 top-6 z-20 rounded border border-emerald-200/15 bg-black/45 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-emerald-100/65"
			>
				signal · {hudSection} · {hudTempo > 30 ? `${Math.round(hudTempo)} bpm` : 'tempo seeking'} · {hudContext}
			</div>
			<div class="pointer-events-none absolute right-6 top-6 z-20 text-xs text-white/40">
				click anywhere or press esc to exit
			</div>
		{/if}

		{#if !ready && !errorMsg}
			<div
				class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-100/40"
			>
				warming phosphor
			</div>
		{/if}

		{#if errorMsg}
			<div
				class="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#010508] px-6"
				role="alert"
			>
				<div class="max-w-md text-center">
					<p class="font-mono text-xs uppercase tracking-[0.18em] text-orange-200/80">
						Signal unavailable
					</p>
					<p class="mt-3 text-sm leading-6 text-white/55">{errorMsg}</p>
					{#if showHud}
						<p class="mt-5 text-xs text-white/35">Click or press Escape to return.</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
