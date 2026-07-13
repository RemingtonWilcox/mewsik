<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { useVisualizer, type AudioFeatures } from '$lib/state/visualizer.svelte';
	import {
		SIGNAL_COMPOSITE_WGSL,
		SIGNAL_DECAY_WGSL,
		SIGNAL_TRACE_WGSL,
		SIGNAL_VERTEX_COUNT
	} from '$lib/visualizer/signal/shaders';

	const vis = useVisualizer();
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
	const UNIFORM_FLOATS = 20;
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

	function smoothAudio(dt: number, feature: AudioFeatures | null) {
		const incomingBins = feature?.bins ?? [];
		for (let i = 0; i < BIN_COUNT; i += 1) {
			const target = clamp(incomingBins[i] ?? 0, 0, 1);
			const rate = target > smoothed.bins[i] ? 24 : 7;
			smoothed.bins[i] = approach(smoothed.bins[i], target, rate, dt);
		}

		const bassTarget = clamp(feature?.bass ?? 0, 0, 1);
		const midTarget = clamp(feature?.mid ?? 0, 0, 1);
		const trebleTarget = clamp(feature?.treble ?? 0, 0, 1);
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
			clamp(feature?.centroid ?? 0.42, 0, 1),
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

		if (feature?.onset && !onsetLatched) {
			smoothed.transient = 1;
			onsetLatched = true;
		} else if (!feature?.onset) {
			onsetLatched = false;
		}
		smoothed.transient *= Math.exp(-7.2 * dt);

		if (!feature || rmsTarget < 0.009) quietFor += dt;
		else quietFor = 0;
		const silenceTarget = quietFor > 0.45 ? 1 : 0;
		smoothed.silence = approach(smoothed.silence, silenceTarget, silenceTarget ? 4.5 : 11, dt);

		const audible = 1 - smoothed.silence;
		const phaseSpeed = 0.028 + smoothed.mid * 0.13 + smoothed.rms * 0.035;
		smoothed.phase = (smoothed.phase + dt * phaseSpeed * audible) % (Math.PI * 2);
	}

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
		ensureTargets(state, width, height);
		if (!state.targets || !state.bindGroups) return;

		// Signal uses the same single, freshness-checked snapshot for smoothing and
		// beat phase so one rendered frame cannot mix two analyzer deliveries.
		const feature = vis.getLatest();
		smoothAudio(dt, feature);
		const energy = clamp(
			smoothed.rms * 0.78 + smoothed.bass * 0.24 + smoothed.mid * 0.18 + smoothed.treble * 0.08,
			0,
			1
		);
		const persistenceAt60Hz = clamp(
			0.929 - energy * 0.019 - smoothed.transient * 0.058,
			0.84,
			0.935
		);
		const lineWidth = 1.15 + smoothed.treble * 0.42 + smoothed.transient * 0.28;
		const beatPhase = clamp(feature?.beat_phase ?? 0, 0, 1);

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
		uniforms[9] = beatPhase;
		uniforms[10] = smoothed.centroid;
		uniforms[11] = smoothed.chroma;
		uniforms[12] = smoothed.chromaStrength;
		uniforms[13] = persistenceAt60Hz;
		uniforms[14] = smoothed.silence;
		uniforms[15] = smoothed.phase;
		uniforms[16] = lineWidth;
		uniforms[17] = energy;
		uniforms[18] = 0;
		uniforms[19] = 0;

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
			pass.draw(SIGNAL_VERTEX_COUNT, 2);
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
		<canvas bind:this={canvas} class="h-full w-full" aria-label="Signal audio visualizer"></canvas>

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
				signal · vectorscope · 60 fps cap
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
