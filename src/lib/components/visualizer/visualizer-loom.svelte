<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		VISUALIZER_RESPONSE_PROFILES,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import {
		LOOM_COMPOSITE_WGSL,
		LOOM_SCENE_WGSL,
		LOOM_STRANDS,
		LOOM_VERTEX_COUNT
	} from '$lib/visualizer/loom/shaders';

	const vis = useVisualizer();

	const UNIFORM_FLOATS = 52;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
	const DETAIL_BYTES = 64 * 4;
	const FRAME_INTERVAL_MS = 1000 / 60;
	const INTERNAL_SCALE = 0.78;
	const MAX_INTERNAL_PIXELS = 1600 * 900;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let internalPixels = $state(0);
	let hudSection = $state('intro');
	let hudTopology = $state('torus');
	let raf = 0;
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let initVersion = 0;
	let initializing = false;
	let schedulerTickAt = 0;
	let renderBudgetMs = FRAME_INTERVAL_MS;
	let lastRenderedAt = 0;
	let startTime = 0;
	let rendererSourceEpoch = -1;
	let rms = 0;
	let silence = 1;
	let quietFor = 0;

	type LoomTargets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		depth: GPUTexture;
		depthView: GPUTextureView;
		width: number;
		height: number;
	};

	type LoomGpu = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuffer: GPUBuffer;
		detailBuffer: GPUBuffer;
		uniforms: Float32Array;
		scenePipeline: GPURenderPipeline;
		compositePipeline: GPURenderPipeline;
		targets: LoomTargets | null;
		sceneBindGroup: GPUBindGroup;
		compositeBindGroup: GPUBindGroup | null;
	};

	let gpu: LoomGpu | null = null;

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
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

	function destroyTargets(targets: LoomTargets | null) {
		if (!targets) return;
		targets.scene.destroy();
		targets.depth.destroy();
	}

	function ensureTargets(state: LoomGpu, width: number, height: number) {
		if (state.targets?.width === width && state.targets.height === height) return;
		destroyTargets(state.targets);
		const scene = state.device.createTexture({
			size: { width, height },
			format: 'rgba16float',
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
		});
		const depth = state.device.createTexture({
			size: { width, height },
			format: 'depth24plus',
			usage: GPUTextureUsage.RENDER_ATTACHMENT
		});
		state.targets = {
			scene,
			sceneView: scene.createView(),
			depth,
			depthView: depth.createView(),
			width,
			height
		};
		state.compositeBindGroup = state.device.createBindGroup({
			layout: state.compositePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: state.uniformBuffer } },
				{ binding: 1, resource: state.sampler },
				{ binding: 2, resource: state.targets.sceneView }
			]
		});
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<LoomGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Loom needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const device = (await adapter.requestDevice()) as GPUDevice;
		let context: GPUCanvasContext | null = null;
		let uniformBuffer: GPUBuffer | null = null;
		let detailBuffer: GPUBuffer | null = null;
		try {
			context = targetCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');

			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });
			const sceneModule = device.createShaderModule({ code: LOOM_SCENE_WGSL });
			const compositeModule = device.createShaderModule({ code: LOOM_COMPOSITE_WGSL });
			const pipelines = await Promise.all([
				device.createRenderPipelineAsync({
					label: 'Loom manifold pipeline',
					layout: 'auto',
					vertex: { module: sceneModule, entryPoint: 'vs_main' },
					fragment: {
						module: sceneModule,
						entryPoint: 'fs_main',
						targets: [
							{
								format: 'rgba16float',
								blend: {
									color: {
										srcFactor: 'one',
										dstFactor: 'one-minus-src-alpha',
										operation: 'add'
									},
									alpha: {
										srcFactor: 'one',
										dstFactor: 'one-minus-src-alpha',
										operation: 'add'
									}
								}
							}
						]
					},
					primitive: { topology: 'triangle-list', cullMode: 'none' },
					depthStencil: {
						format: 'depth24plus',
						depthWriteEnabled: true,
						depthCompare: 'less'
					}
				}),
				device.createRenderPipelineAsync({
					label: 'Loom presentation pipeline',
					layout: 'auto',
					vertex: { module: compositeModule, entryPoint: 'vs_main' },
					fragment: {
						module: compositeModule,
						entryPoint: 'fs_main',
						targets: [{ format }]
					},
					primitive: { topology: 'triangle-list' }
				})
			]) as [GPURenderPipeline, GPURenderPipeline];

			uniformBuffer = device.createBuffer({
				size: UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			detailBuffer = device.createBuffer({
				size: DETAIL_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			const sceneBindGroup = device.createBindGroup({
				layout: pipelines[0].getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: detailBuffer } }
				]
			});
			const state: LoomGpu = {
				device,
				context,
				format,
				sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
				uniformBuffer,
				detailBuffer,
				uniforms: new Float32Array(UNIFORM_FLOATS),
				scenePipeline: pipelines[0],
				compositePipeline: pipelines[1],
				targets: null,
				sceneBindGroup,
				compositeBindGroup: null
			};

			void device.lost.then((info) => {
				if (gpu?.device !== device) return;
				errorMsg = `The graphics device was lost${info.message ? `: ${info.message}` : '.'}`;
				ready = false;
				gpu = null;
			});
			return state;
		} catch (error) {
			uniformBuffer?.destroy();
			detailBuffer?.destroy();
			try {
				context?.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy();
			throw error;
		}
	}

	function destroyGpuState(state: LoomGpu | null) {
		if (!state) return;
		destroyTargets(state.targets);
		state.uniformBuffer.destroy();
		state.detailBuffer.destroy();
		try {
			state.context.unconfigure();
		} catch {
			// The device may already be lost.
		}
		state.device.destroy();
	}

	function teardownGpu() {
		const state = gpu;
		gpu = null;
		ready = false;
		destroyGpuState(state);
	}

	function dominantTopology(weights: VisualizerJourneySnapshot['loom']['topologyWeights']) {
		let name: keyof typeof weights = 'torus';
		let strength = weights.torus;
		if (weights.helix > strength) [name, strength] = ['helix', weights.helix];
		if (weights.saddle > strength) [name, strength] = ['saddle', weights.saddle];
		if (weights.knot > strength) [name, strength] = ['knot', weights.knot];
		if (weights.cage > strength) name = 'cage';
		return name;
	}

	function renderFrame(state: LoomGpu, now: number, dt: number) {
		if (!canvas) return;
		const size = backingSize(canvas);
		if (canvas.width !== size.width || canvas.height !== size.height) {
			canvas.width = size.width;
			canvas.height = size.height;
			internalPixels = size.width * size.height;
		}
		ensureTargets(state, size.width, size.height);
		if (!state.targets || !state.compositeBindGroup) return;

		const feature = vis.getLatest(now);
		const shared = vis.getJourney(now);
		const loom = shared.loom;
		if (rendererSourceEpoch !== shared.sourceEpoch) {
			rendererSourceEpoch = shared.sourceEpoch;
			rms = clamp(feature?.rms ?? 0, 0, 1);
			quietFor = feature ? 0 : 0.5;
			silence = feature ? 0 : 1;
		}
		const rmsTarget = clamp(feature?.rms ?? 0, 0, 1);
		rms = approach(rms, rmsTarget, rmsTarget > rms ? 17 : 6, dt);
		if (!feature || rmsTarget < 0.009) quietFor += dt;
		else quietFor = 0;
		silence = approach(silence, quietFor > 0.45 ? 1 : 0, quietFor > 0.45 ? 4 : 12, dt);

		const directed = shared.director;
		const spectrum = shared.spectrum;
		const response = VISUALIZER_RESPONSE_PROFILES.loom[vis.response];
		const responseMotion = response.motion;
		const responseImpact = response.impact;
		const energy = clamp(loom.macroEnergy * 0.72 + rms * 0.18 + spectrum.spectralMotion * 0.1, 0, 1);
		const impact = clamp(loom.impact * responseImpact, 0, 1);
		const weights = loom.topologyWeights;
		const uniforms = state.uniforms;
		uniforms[0] = size.width;
		uniforms[1] = size.height;
		uniforms[2] = (now - startTime) / 1000;
		uniforms[3] = dt;
		uniforms[4] = directed.clock.beatPulse;
		uniforms[5] = directed.clock.beatPhase;
		uniforms[6] = loom.phrase;
		uniforms[7] = loom.tempo;
		uniforms[8] = rms;
		uniforms[9] = loom.strandEnergy.sub;
		uniforms[10] = loom.strandEnergy.kick;
		uniforms[11] = loom.strandEnergy.body;
		uniforms[12] = loom.strandEnergy.mids;
		uniforms[13] = loom.strandEnergy.presence;
		uniforms[14] = loom.strandEnergy.air;
		uniforms[15] = spectrum.centroid;
		uniforms[16] = energy;
		uniforms[17] = spectrum.spectralMotion;
		uniforms[18] = impact;
		uniforms[19] = clamp(loom.openness + loom.dropOpenness * 0.18, 0, 1);
		uniforms[20] = loom.tension;
		uniforms[21] = loom.release;
		uniforms[22] = loom.crossingOrder;
		uniforms[23] = loom.topologyPhase;
		uniforms[24] = weights.torus;
		uniforms[25] = weights.helix;
		uniforms[26] = weights.saddle;
		uniforms[27] = weights.knot;
		uniforms[28] = weights.cage;
		uniforms[29] = loom.braid;
		uniforms[30] = loom.twist;
		uniforms[31] = loom.signedAsymmetry;
		uniforms[32] = directed.palette.baseHue;
		uniforms[33] = directed.palette.accentHue;
		uniforms[34] = directed.palette.rimHue;
		uniforms[35] = directed.palette.saturation;
		// These three slots were previously renderer-inert director values. Loom's
		// phrase conductor now owns them without changing uniform size/alignment.
		uniforms[36] = loom.reweave;
		uniforms[37] = loom.sectionPulse;
		uniforms[38] = loom.depth;
		uniforms[39] = directed.context.sectionEnergy;
		uniforms[40] = loom.cameraYaw;
		uniforms[41] = loom.cameraPitch;
		uniforms[42] = loom.cameraDistance;
		uniforms[43] = loom.cameraRoll;
		uniforms[44] = clamp((0.011 + spectrum.levels.body * 0.004 + impact * 0.002) * response.width, 0.008, 0.022);
		uniforms[45] = clamp((0.55 + energy * 0.5 + impact * 0.3) * response.glow, 0.35, 1.45);
		uniforms[46] = silence;
		uniforms[47] = responseMotion;
		// Persistent phases are song time, not response-mode time. Scaling an
		// unwrapped phase here made Calm -> Surge jump to a different posture.
		uniforms[48] = loom.longPhase;
		uniforms[49] = loom.weavePhase;
		uniforms[50] = loom.phraseVariation;
		uniforms[51] = loom.key;

		state.device.queue.writeBuffer(
			state.uniformBuffer,
			0,
			uniforms.buffer,
			uniforms.byteOffset,
			uniforms.byteLength
		);
		state.device.queue.writeBuffer(
			state.detailBuffer,
			0,
			spectrum.detailBins.buffer,
			spectrum.detailBins.byteOffset,
			spectrum.detailBins.byteLength
		);

		hudSection = loom.section;
		hudTopology = dominantTopology(weights);
		const encoder = state.device.createCommandEncoder({ label: 'Loom frame' });
		{
			const pass = encoder.beginRenderPass({
				label: 'Loom manifold',
				colorAttachments: [
					{
						view: state.targets.sceneView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				],
				depthStencilAttachment: {
					view: state.targets.depthView,
					depthClearValue: 1,
					depthLoadOp: 'clear',
					depthStoreOp: 'discard'
				}
			});
			pass.setPipeline(state.scenePipeline);
			pass.setBindGroup(0, state.sceneBindGroup);
			pass.draw(LOOM_VERTEX_COUNT, LOOM_STRANDS);
			pass.end();
		}
		{
			const pass = encoder.beginRenderPass({
				label: 'Loom present',
				colorAttachments: [
					{
						view: state.context.getCurrentTexture().createView(),
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(state.compositePipeline);
			pass.setBindGroup(0, state.compositeBindGroup);
			pass.draw(3);
			pass.end();
		}
		state.device.queue.submit([encoder.finish()]);
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		if (!schedulerTickAt) {
			schedulerTickAt = now;
			renderBudgetMs = FRAME_INTERVAL_MS;
		} else {
			const elapsed = Math.max(0, now - schedulerTickAt);
			schedulerTickAt = now;
			renderBudgetMs = Math.min(FRAME_INTERVAL_MS * 4, renderBudgetMs + elapsed);
		}
		if (renderBudgetMs + 0.25 < FRAME_INTERVAL_MS) return;
		let remainder = renderBudgetMs - FRAME_INTERVAL_MS;
		if (remainder >= FRAME_INTERVAL_MS) remainder %= FRAME_INTERVAL_MS;
		renderBudgetMs = Math.max(0, remainder);
		const elapsedMs = lastRenderedAt ? now - lastRenderedAt : FRAME_INTERVAL_MS;
		lastRenderedAt = now;
		try {
			renderFrame(gpu, now, clamp(elapsedMs / 1000, 0.001, 0.25));
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
			aria-label="Loom audio visualizer"
			data-loom-section={hudSection}
			data-loom-topology={hudTopology}
			data-loom-render-passes="2"
			data-loom-strands={LOOM_STRANDS}
			data-loom-internal-pixels={internalPixels}
			data-loom-ready={String(ready)}
		></canvas>

		{#if !ready && !errorMsg}
			<div
				class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.2em] text-blue-100/40"
			>
				threading manifold
			</div>
		{/if}

		{#if errorMsg}
			<div
				class="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#01030a] px-6"
				role="alert"
			>
				<div class="max-w-md text-center">
					<p class="font-mono text-xs uppercase tracking-[0.18em] text-blue-200/80">
						Loom unavailable
					</p>
					<p class="mt-3 text-sm leading-6 text-white/55">{errorMsg}</p>
				</div>
			</div>
		{/if}
	</div>
{/if}
