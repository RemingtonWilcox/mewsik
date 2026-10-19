<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		VISUALIZER_TUNING,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import {
		SIGNAL_BLOOM_BLUR_H_WGSL,
		SIGNAL_BLOOM_BLUR_V_WGSL,
		SIGNAL_BLOOM_DOWN_WGSL,
		SIGNAL_COMPOSITE_WGSL,
		SIGNAL_FEEDBACK_WGSL,
		SIGNAL_RENDER_PASSES,
		SIGNAL_SCENE_WGSL,
		SIGNAL_TERRAIN_BINS,
		SIGNAL_TERRAIN_FLOATS,
		SIGNAL_TERRAIN_ROWS,
		SIGNAL_TRACE_INSTANCES,
		SIGNAL_VERTEX_COUNT
	} from '$lib/visualizer/signal/shaders';
	import {
		SIGNAL_UNIFORM_BYTES,
		SIGNAL_UNIFORM_FLOATS,
		packSignalUniforms,
		type SignalUniformValues
	} from '$lib/visualizer/signal/uniform-layout';
	import {
		SIGNAL_FAMILY_NAMES,
		SIGNAL_FIGURE_FLOATS,
		SignalFigureEngine,
		type SignalFigureInput
	} from '$lib/visualizer/signal/figures';
	import {
		SIGNAL_CAMERAS,
		SIGNAL_DISPLAYS,
		SIGNAL_LAYOUT_NAMES,
		SURFACE_FLOOR,
		SURFACE_RING,
		SURFACE_TUNNEL,
		buildSignalLayout,
		createSignalLayout,
		lerpPreset,
		lerpSignalLayout,
		type SignalLayout
	} from '$lib/visualizer/signal/layouts';
	import { SIGNAL_PALETTES, createSignalPaletteOut, resolveSignalPalette } from '$lib/visualizer/signal/palettes';
	import {
		parseSignalLookOverride,
		signalVariationFor,
		type SignalLookOverride,
		type SignalVariation
	} from '$lib/visualizer/signal/genome';

	const vis = useVisualizer();

	const DETAIL_BYTES = 64 * 4;
	const TERRAIN_FLOATS = SIGNAL_TERRAIN_FLOATS;
	const TARGET_FRAME_RATE = 60;
	const INTERNAL_SCALE = 0.75;
	const MAX_INTERNAL_PIXELS = 1920 * 1080;
	const BEATS_PER_PHRASE = 32;
	// Log-frequency position of each analyzer band edge across the 64 bins
	// (20 Hz .. 20 kHz): sub, kick, body, mids, presence, air.
	const BAND_EDGES = [0, 0.16, 0.29, 0.43, 0.66, 0.82, 1];

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let hudSection = $state('intro');
	let hudTempo = $state(0);
	let hudContext = $state<'live' | 'score'>('live');
	let hudChannels = $state(1);
	let hudLayout = $state('bench');
	let hudFamily = $state('lissajous');
	let hudPalette = $state('P31 bench');
	let hudScene = $state(0);
	let hudFrameMs = $state(0);
	let frameCpuMs = 0;
	let activeFrameStride = $state(1);
	let measuredRefreshRate = $state(60);
	let internalPixels = $state(0);
	let raf = 0;
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let initVersion = 0;
	let initializing = false;
	let schedulerTickAt = 0;
	let refreshIntervalMs = 1000 / 60;
	let framesUntilRender = 0;
	let lastRenderedAt = 0;
	let lastHudUpdateAt = 0;
	let startTime = 0;
	let rendererSourceEpoch = -1;
	let feedbackResetFrames = 2;

	// Render-rate state. The shared journey advances at analyzer cadence; these
	// ease it to the display so nothing visibly steps.
	const bands = { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 };
	const BAND_KEYS = ['sub', 'kick', 'body', 'mids', 'presence', 'air'] as const;
	let rms = 0;
	let silence = 1;
	let quietFor = 0.5;
	let renderBeats = 0;
	let renderBpm = 120;
	let beatGlow = 0;
	let sweepPhase = 0;
	let figurePhase = 0;
	let lastTracePhase = 0;
	let tickPhase = 0;
	let terrainHead = 0;
	let tickFlash = 0;
	let mode = 0;
	let asymmetry = 0;
	let spectralMotion = 0;
	let spinAngle = 0;
	let dollyTime = 0;
	const renderDetailBins = new Float32Array(64);
	const terrainRows = new Float32Array(TERRAIN_FLOATS);
	// Interleaved height, heat per bin.
	const pendingRow = new Float32Array(SIGNAL_TERRAIN_BINS * 2);
	const silhouette = new Float32Array(SIGNAL_TERRAIN_BINS);
	let pendingRowFresh = true;

	// The instrument model shared by every element on the bench.
	const figureEngine = new SignalFigureEngine();
	const paletteOut = createSignalPaletteOut();
	const layoutMix = createSignalLayout();
	const layoutCache = new Map<string, SignalLayout>();
	const headLocal: [number, number] = [0, 0];
	let lookOverride: SignalLookOverride = {};
	let variation: SignalVariation | null = null;

	function layoutFor(index: number, aspectRatio: number) {
		const key = `${index}:${aspectRatio.toFixed(3)}`;
		let layout = layoutCache.get(key);
		if (!layout) {
			if (layoutCache.size > 64) layoutCache.clear();
			layout = buildSignalLayout(index, aspectRatio);
			layoutCache.set(key, layout);
		}
		return layout;
	}

	// Band traces 2 and 3 by genome trace map: [level band, bin lo, bin hi, cycles].
	const TRACE_MAPS = [
		[
			['kick', 6, 15, 2.5],
			['sub', 0, 7, 1.25]
		],
		[
			['mids', 22, 40, 5],
			['presence', 40, 56, 13]
		],
		[
			['body', 12, 24, 3.5],
			['air', 50, 63, 17]
		]
	] as const;

	type SignalTargets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		feedback: [GPUTexture, GPUTexture];
		feedbackViews: [GPUTextureView, GPUTextureView];
		bloom: [GPUTexture, GPUTexture];
		bloomViews: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type SignalGpu = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuffer: GPUBuffer;
		detailBuffer: GPUBuffer;
		terrainBuffer: GPUBuffer;
		figureBuffer: GPUBuffer;
		uniforms: Float32Array;
		scenePipeline: GPURenderPipeline;
		feedbackPipeline: GPURenderPipeline;
		bloomDownPipeline: GPURenderPipeline;
		blurHPipeline: GPURenderPipeline;
		blurVPipeline: GPURenderPipeline;
		compositePipeline: GPURenderPipeline;
		sceneBindGroup: GPUBindGroup;
		targets: SignalTargets | null;
		feedbackBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		bloomDownBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		blurHBindGroup: GPUBindGroup | null;
		blurVBindGroup: GPUBindGroup | null;
		compositeBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		parity: 0 | 1;
	};

	let gpu: SignalGpu | null = null;

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function wrapSigned(value: number) {
		return value - Math.round(value);
	}

	function displayFrameStride(refreshMs: number, targetFrameRate: number) {
		const safeRefresh = clamp(refreshMs, 1000 / 360, 1000 / 24);
		return Math.max(1, Math.min(8, Math.round(1000 / safeRefresh / targetFrameRate)));
	}

	function observeDisplayCadence(tickElapsedMs: number) {
		if (tickElapsedMs < 1000 / 360 || tickElapsedMs > 1000 / 24) return;
		if (tickElapsedMs < refreshIntervalMs * 0.8) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.38;
		} else if (tickElapsedMs <= refreshIntervalMs * 1.35) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.08;
		}
		measuredRefreshRate = Math.round(1000 / refreshIntervalMs);
	}

	function beatAnchor(clock: VisualizerJourneySnapshot['director']['clock']) {
		if (!Number.isFinite(clock.phraseIndex) || !Number.isFinite(clock.phrasePos)) return null;
		return clock.phraseIndex * BEATS_PER_PHRASE + clock.phrasePos * BEATS_PER_PHRASE;
	}

	/** Smooth level profile: interpolate between band centres, no plateaus. */
	function bandLevelAt(position: number) {
		let previousCenter = 0;
		let previousLevel = bands.sub;
		for (let band = 0; band < 6; band += 1) {
			const center = (BAND_EDGES[band] + BAND_EDGES[band + 1]) * 0.5;
			const level = bands[BAND_KEYS[band]];
			if (position <= center) {
				if (band === 0) return level;
				const t = clamp((position - previousCenter) / (center - previousCenter), 0, 1);
				const eased = t * t * (3 - 2 * t);
				return previousLevel + (level - previousLevel) * eased;
			}
			previousCenter = center;
			previousLevel = level;
		}
		return previousLevel;
	}

	function spectrumAt(position: number) {
		const last = renderDetailBins.length - 1;
		const scaled = clamp(position, 0, 1) * last;
		const bin = Math.round(scaled);
		const detail =
			renderDetailBins[Math.max(bin - 1, 0)] * 0.25 +
			renderDetailBins[bin] * 0.5 +
			renderDetailBins[Math.min(bin + 1, last)] * 0.25;
		const drive = bandLevelAt(position) * 0.45 + detail * 1.8;
		// Soft saturation: loud bands round off instead of flat-topping.
		return drive >= 0 ? 1 - Math.exp(-drive * 1.6) : Math.max(drive, -0.3);
	}

	/**
	 * The horizon remembers the figure: each row is the figure's polar
	 * silhouette (its farthest reach per angle) shaped by the live spectrum,
	 * with the bass under the figure. Beat stamps from the beam head ride in a
	 * second channel. Peak-held between ticks so no transient is lost.
	 */
	function accumulateTerrainRow(coupling: number, headTurn: number, stamp: number) {
		figureEngine.silhouette(silhouette);
		let mean = 0;
		for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) mean += silhouette[bin];
		mean = Math.max(0.15, mean / SIGNAL_TERRAIN_BINS);
		for (let bin = 0; bin < SIGNAL_TERRAIN_BINS; bin += 1) {
			const turn = bin / SIGNAL_TERRAIN_BINS;
			// Distance round the circle from the figure's underside (0.75 turn).
			const fromBottom = Math.abs(((turn - 0.75 + 1.5) % 1) - 0.5) * 2;
			const spectral = spectrumAt(fromBottom);
			const shape = silhouette[bin] / mean;
			const figureValue = (shape * 0.75 - 0.05) * (0.6 + Math.max(spectral, 0) * 0.8);
			const value = spectral + (figureValue - spectral) * coupling;
			const heatDistance = Math.abs(((turn - headTurn + 1.5) % 1) - 0.5) * SIGNAL_TERRAIN_BINS;
			const heat = stamp * Math.exp(-heatDistance * heatDistance * 0.35);
			const o = bin * 2;
			pendingRow[o] = pendingRowFresh ? value : Math.max(pendingRow[o], value);
			pendingRow[o + 1] = pendingRowFresh ? heat : Math.max(pendingRow[o + 1], heat);
		}
		pendingRowFresh = false;
	}

	function commitTerrainRow() {
		terrainHead = (terrainHead + 1) % SIGNAL_TERRAIN_ROWS;
		terrainRows.set(pendingRow, terrainHead * SIGNAL_TERRAIN_BINS * 2);
		pendingRowFresh = true;
	}

	function resetRendererState(shared: VisualizerJourneySnapshot, live: boolean) {
		rendererSourceEpoch = shared.sourceEpoch;
		const levels = shared.spectrum.levels;
		for (const key of BAND_KEYS) bands[key] = live ? levels[key] : 0;
		rms = 0;
		silence = live ? 0 : 1;
		quietFor = live ? 0 : 0.5;
		renderBeats = beatAnchor(shared.director.clock) ?? 0;
		sweepPhase = 0;
		figurePhase = shared.signal.tracePhase * 1.6;
		lastTracePhase = shared.signal.tracePhase;
		tickPhase = 0;
		tickFlash = 0;
		terrainHead = 0;
		terrainRows.fill(0);
		pendingRow.fill(0);
		pendingRowFresh = true;
		asymmetry = shared.signal.signedAsymmetry;
		spectralMotion = shared.spectrum.spectralMotion;
		for (let index = 0; index < renderDetailBins.length; index += 1) {
			renderDetailBins[index] = shared.spectrum.detailBins[index] ?? 0;
		}
		spinAngle = 0;
		dollyTime = 0;
		figureEngine.resetAttractor();
		variation = signalVariationFor(shared.seed, shared.sourceEpoch);
		variation.setOverride(lookOverride);
		feedbackResetFrames = 2;
		lastHudUpdateAt = 0;
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

	function destroyTargets(targets: SignalTargets | null) {
		if (!targets) return;
		targets.scene.destroy();
		for (const texture of targets.feedback) texture.destroy();
		for (const texture of targets.bloom) texture.destroy();
	}

	function ensureTargets(state: SignalGpu, width: number, height: number) {
		if (state.targets?.width === width && state.targets.height === height) return;
		destroyTargets(state.targets);
		const hdr = (label: string, w: number, h: number) =>
			state.device.createTexture({
				label,
				size: { width: w, height: h },
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
			});
		const scene = hdr('Signal scene', width, height);
		const feedback: [GPUTexture, GPUTexture] = [
			hdr('Signal phosphor A', width, height),
			hdr('Signal phosphor B', width, height)
		];
		const bloomWidth = Math.max(1, Math.floor(width / 2));
		const bloomHeight = Math.max(1, Math.floor(height / 2));
		const bloom: [GPUTexture, GPUTexture] = [
			hdr('Signal bloom A', bloomWidth, bloomHeight),
			hdr('Signal bloom B', bloomWidth, bloomHeight)
		];
		const targets: SignalTargets = {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackViews: [feedback[0].createView(), feedback[1].createView()],
			bloom,
			bloomViews: [bloom[0].createView(), bloom[1].createView()],
			width,
			height
		};
		state.targets = targets;

		const uniform = { binding: 0, resource: { buffer: state.uniformBuffer } };
		const sampler = { binding: 1, resource: state.sampler };
		const bind = (pipeline: GPURenderPipeline, label: string, views: GPUTextureView[]) =>
			state.device.createBindGroup({
				label,
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					uniform,
					sampler,
					...views.map((view, index) => ({ binding: 2 + index, resource: view }))
				]
			});
		state.feedbackBindGroups = [
			bind(state.feedbackPipeline, 'Signal phosphor reads A', [
				targets.sceneView,
				targets.feedbackViews[0]
			]),
			bind(state.feedbackPipeline, 'Signal phosphor reads B', [
				targets.sceneView,
				targets.feedbackViews[1]
			])
		];
		state.bloomDownBindGroups = [
			bind(state.bloomDownPipeline, 'Signal bloom prefilter A', [targets.feedbackViews[0]]),
			bind(state.bloomDownPipeline, 'Signal bloom prefilter B', [targets.feedbackViews[1]])
		];
		state.blurHBindGroup = bind(state.blurHPipeline, 'Signal bloom blur H', [targets.bloomViews[0]]);
		state.blurVBindGroup = bind(state.blurVPipeline, 'Signal bloom blur V', [targets.bloomViews[1]]);
		state.compositeBindGroups = [
			bind(state.compositePipeline, 'Signal composite A', [
				targets.feedbackViews[0],
				targets.bloomViews[0]
			]),
			bind(state.compositePipeline, 'Signal composite B', [
				targets.feedbackViews[1],
				targets.bloomViews[0]
			])
		];
		feedbackResetFrames = 2;
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<SignalGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Signal needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const device = (await adapter.requestDevice()) as GPUDevice;
		let context: GPUCanvasContext | null = null;
		let uniformBuffer: GPUBuffer | null = null;
		let detailBuffer: GPUBuffer | null = null;
		let terrainBuffer: GPUBuffer | null = null;
		let figureBuffer: GPUBuffer | null = null;
		try {
			context = targetCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');
			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });

			const modules = {
				scene: device.createShaderModule({ label: 'Signal scene', code: SIGNAL_SCENE_WGSL }),
				feedback: device.createShaderModule({ label: 'Signal phosphor', code: SIGNAL_FEEDBACK_WGSL }),
				bloomDown: device.createShaderModule({ label: 'Signal bloom', code: SIGNAL_BLOOM_DOWN_WGSL }),
				blurH: device.createShaderModule({ label: 'Signal blur H', code: SIGNAL_BLOOM_BLUR_H_WGSL }),
				blurV: device.createShaderModule({ label: 'Signal blur V', code: SIGNAL_BLOOM_BLUR_V_WGSL }),
				composite: device.createShaderModule({ label: 'Signal composite', code: SIGNAL_COMPOSITE_WGSL })
			};
			await Promise.all(
				Object.entries(modules).map(async ([label, module]) => {
					const info = await module.getCompilationInfo();
					const errors = info.messages.filter((message) => message.type === 'error');
					if (errors.length) {
						const detail = errors
							.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
							.join(' | ');
						throw new Error(`Signal ${label} shader failed to compile: ${detail}`);
					}
				})
			);

			// Max blending: crossing beams never sum to white, the brighter wins,
			// which is how overlapping phosphor actually reads.
			const maxBlend: GPUBlendState = {
				color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
				alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
			};
			const fullscreen = (label: string, module: GPUShaderModule, targetFormat: GPUTextureFormat) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
					primitive: { topology: 'triangle-list' }
				});
			const pipelines = await Promise.all([
				device.createRenderPipelineAsync({
					label: 'Signal beams',
					layout: 'auto',
					vertex: { module: modules.scene, entryPoint: 'vs_main' },
					fragment: {
						module: modules.scene,
						entryPoint: 'fs_main',
						targets: [{ format: 'rgba16float', blend: maxBlend }]
					},
					primitive: { topology: 'triangle-list', cullMode: 'none' }
				}),
				fullscreen('Signal phosphor', modules.feedback, 'rgba16float'),
				fullscreen('Signal bloom prefilter', modules.bloomDown, 'rgba16float'),
				fullscreen('Signal bloom blur H', modules.blurH, 'rgba16float'),
				fullscreen('Signal bloom blur V', modules.blurV, 'rgba16float'),
				fullscreen('Signal present', modules.composite, format)
			]);

			uniformBuffer = device.createBuffer({
				label: 'Signal uniforms',
				size: SIGNAL_UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			detailBuffer = device.createBuffer({
				label: 'Signal detail bins',
				size: DETAIL_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			terrainBuffer = device.createBuffer({
				label: 'Signal horizon history',
				size: TERRAIN_FLOATS * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			figureBuffer = device.createBuffer({
				label: 'Signal figure polyline',
				size: SIGNAL_FIGURE_FLOATS * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			const sceneBindGroup = device.createBindGroup({
				label: 'Signal beams',
				layout: pipelines[0].getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: detailBuffer } },
					{ binding: 2, resource: { buffer: terrainBuffer } },
					{ binding: 3, resource: { buffer: figureBuffer } }
				]
			});
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
				uniformBuffer,
				detailBuffer,
				terrainBuffer,
				figureBuffer,
				uniforms: new Float32Array(SIGNAL_UNIFORM_FLOATS),
				scenePipeline: pipelines[0],
				feedbackPipeline: pipelines[1],
				bloomDownPipeline: pipelines[2],
				blurHPipeline: pipelines[3],
				blurVPipeline: pipelines[4],
				compositePipeline: pipelines[5],
				sceneBindGroup,
				targets: null,
				feedbackBindGroups: null,
				bloomDownBindGroups: null,
				blurHBindGroup: null,
				blurVBindGroup: null,
				compositeBindGroups: null,
				parity: 0
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
			terrainBuffer?.destroy();
			figureBuffer?.destroy();
			try {
				context?.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy();
			throw error;
		}
	}

	function destroyGpuState(state: SignalGpu | null) {
		if (!state) return;
		destroyTargets(state.targets);
		state.uniformBuffer.destroy();
		state.detailBuffer.destroy();
		state.terrainBuffer.destroy();
		state.figureBuffer.destroy();
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

	function renderFrame(state: SignalGpu, dt: number) {
		if (!canvas) return;
		const size = backingSize(canvas);
		if (canvas.width !== size.width || canvas.height !== size.height) {
			canvas.width = size.width;
			canvas.height = size.height;
			internalPixels = size.width * size.height;
		}

		// Sample the shared feature clock, not the rAF frame-start timestamp.
		// Analyzer frames are stamped with performance.now() when they arrive,
		// which is usually later than the frame start; reading with the rAF
		// time made every fresh frame look like it came from the future, so
		// getLatest() returned null and the whole instrument went silent.
		const sampleAt = performance.now();
		const feature = vis.getLatest(sampleAt);
		const shared = vis.getJourney(sampleAt);
		if (shared.sourceEpoch !== rendererSourceEpoch) resetRendererState(shared, feature !== null);

		ensureTargets(state, size.width, size.height);
		const targets = state.targets;
		if (
			!targets ||
			!state.feedbackBindGroups ||
			!state.bloomDownBindGroups ||
			!state.blurHBindGroup ||
			!state.blurVBindGroup ||
			!state.compositeBindGroups
		)
			return;

		const directed = shared.director;
		const spectrum = shared.spectrum;
		const journey = shared.signal;
		const response = VISUALIZER_TUNING.signal;
		const responseMotion = response.motion;
		const responseImpact = response.impact;

		// Audio envelopes at render rate.
		const rmsTarget = clamp(feature?.rms ?? 0, 0, 1);
		rms = approach(rms, rmsTarget, rmsTarget > rms ? 18 : 7, dt);
		if (!feature || rmsTarget < 0.009) quietFor += dt;
		else quietFor = 0;
		silence = approach(silence, quietFor > 0.45 ? 1 : 0, quietFor > 0.45 ? 4 : 12, dt);
		const bandMix = 1 - Math.exp(-dt / 0.05);
		for (const key of BAND_KEYS) {
			const target = feature ? spectrum.levels[key] : 0;
			bands[key] += (target - bands[key]) * bandMix;
		}
		for (let index = 0; index < renderDetailBins.length; index += 1) {
			const target = feature ? (spectrum.detailBins[index] ?? 0) : 0;
			renderDetailBins[index] += (target - renderDetailBins[index]) * bandMix;
		}
		spectralMotion = approach(spectralMotion, spectrum.spectralMotion, 10, dt);
		// Hero placement glides over bars, never per beat, so it cannot smear.
		asymmetry = approach(asymmetry, journey.signedAsymmetry, 0.3, dt);

		// Song clock: beats phase-locked to the director's phrase anchor.
		const clock = directed.clock;
		const bpmTarget = clamp(clock.tempoBpm || 0, 0, 220);
		renderBpm = approach(renderBpm, bpmTarget >= 30 ? bpmTarget : 120, 2, dt);
		const beatsPerSecond = renderBpm / 60;
		if (feature && silence < 0.5) renderBeats += dt * beatsPerSecond;
		const anchor = beatAnchor(clock);
		if (feature && anchor !== null) {
			const diff = anchor - renderBeats;
			if (Math.abs(diff) > BEATS_PER_PHRASE * 0.75) renderBeats = anchor;
			else renderBeats += diff * (1 - Math.exp(-dt / 0.45));
		}
		beatGlow = approach(
			beatGlow,
			feature ? Math.exp(-clamp(clock.beatPhase, 0, 1) * 5) : 0,
			30,
			dt
		);

		// Channel sweep: one pass per sweepBeats, locked to the bar when the
		// section's sweep length settles on a whole number of beats.
		const sweepBeats = clamp(journey.sweepBeats, 0.5, 4);
		const sweepStep = (dt * beatsPerSecond) / sweepBeats;
		sweepPhase += sweepStep;
		const wholeBeats = Math.max(1, Math.round(sweepBeats));
		const lockStrength = clamp(1 - Math.abs(sweepBeats - wholeBeats) * 3, 0, 1);
		if (feature && lockStrength > 0) {
			const lockError = wrapSigned(renderBeats / wholeBeats - sweepPhase);
			sweepPhase += lockError * (1 - Math.exp(-dt / 0.35)) * lockStrength;
		}
		sweepPhase -= Math.floor(sweepPhase);

		// Hero rotation integrates the conductor's monotonic trace phase so
		// remounts and response changes never jump the figure.
		const traceDelta = clamp(journey.tracePhase - lastTracePhase, 0, 0.5);
		lastTracePhase = journey.tracePhase;
		figurePhase += traceDelta * 1.6 * responseMotion;

		const energy = clamp(
			directed.energy * 0.58 + rms * 0.24 + bands.body * 0.08 + spectralMotion * 0.1,
			0,
			1
		);
		const impact = clamp(journey.impact * responseImpact, 0, 1);
		const ringOut = journey.ringOut;
		const modeTarget =
			(directed.context.keyMode === 'major' ? 1 : directed.context.keyMode === 'minor' ? -1 : 0) *
			clamp(0.4 + directed.context.keyConfidence, 0, 1);
		mode = approach(mode, modeTarget, 0.8, dt);
		const aspect = size.width / Math.max(size.height, 1);
		const elapsed = (performance.now() - startTime) / 1000;

		// ---- Genome: the look walks forward at musical boundaries. ----------
		if (!variation) {
			variation = signalVariationFor(shared.seed, shared.sourceEpoch);
			variation.setOverride(lookOverride);
		}
		const genome = variation;
		genome.advance({
			phraseIndex: clock.phraseIndex,
			section: directed.section,
			energy: directed.energy,
			silence: directed.silence || !feature,
			dt
		});
		const layoutChoice = genome.choice('layout');
		const familyChoice = genome.choice('family');
		const paletteChoice = genome.choice('palette');
		const cameraChoice = genome.choice('camera');
		const displayChoice = genome.choice('display');
		const traceMapChoice = genome.choice('traceMap');
		const layoutFrom = layoutFor(layoutChoice.from, aspect);
		const layoutTo = layoutFor(layoutChoice.to, aspect);
		const layout = lerpSignalLayout(layoutFrom, layoutTo, layoutChoice.mix, layoutMix);
		const camera = lerpPreset(
			SIGNAL_CAMERAS[cameraChoice.from],
			SIGNAL_CAMERAS[cameraChoice.to],
			cameraChoice.mix
		);
		const display = lerpPreset(
			SIGNAL_DISPLAYS[displayChoice.from],
			SIGNAL_DISPLAYS[displayChoice.to],
			displayChoice.mix
		);
		const gene = (name: Parameters<SignalVariation['value']>[0]) => genome.value(name);

		// ---- Camera ------------------------------------------------------------
		const freedom = layout.freedom;
		dollyTime += dt * (0.4 + journey.motion * 0.6);
		const drift = gene('drift');
		const sway = camera.sway * Math.sin(dollyTime * 0.11) + (drift - 0.5) * 0.12;
		const camPitch = layout.pitch + (camera.pitch + (drift - 0.5) * 0.06) * freedom;
		const camHeight =
			layout.camHeight *
			(1 + (camera.height - 1) * freedom) *
			(1 + camera.dolly * 0.12 * Math.sin(dollyTime * 0.07) * freedom);
		const focal = layout.focal * (1 + (camera.focal - 1) * freedom);
		const camYaw = sway * freedom;

		// ---- Figure placement ----------------------------------------------------
		const driftX = clamp(asymmetry * 0.62, -0.4, 0.4) * aspect * layout.drift;
		const conductorScale = clamp(
			0.29 +
				journey.openness * 0.21 +
				journey.release * 0.05 -
				journey.tension * 0.05 +
				ringOut * 0.03,
			0.22,
			0.56
		);
		const scaleFactor =
			clamp(conductorScale / 0.4, 0.72, 1.3) * (0.86 + gene('figureScale') * 0.26);
		const figAScale = layout.figAScale * scaleFactor;
		const figAX = layout.figAX + driftX;
		const figAY =
			layout.figAY + (journey.openness * 0.04 - journey.tension * 0.03) * layout.drift;
		const screen = clamp(layout.figBScreen, 0, 1);
		const figBX = figAX + (layout.figBX - figAX) * screen;
		const figBY = figAY + (layout.figBY - figAY) * screen;
		const figBScale = figAScale + (layout.figBScale * scaleFactor - figAScale) * screen;

		// ---- Figure polyline: the one signal everything else reads. -----------
		const spin = gene('spin');
		spinAngle += dt * spin * 0.18 * (0.4 + journey.motion);
		const spread =
			0.02 + bands.air * 0.1 + journey.release * 0.07 + ringOut * 0.25 + spectrum.flatness * 0.05;
		const figureInput: SignalFigureInput = {
			familyFrom: familyChoice.from,
			familyTo: familyChoice.to,
			familyMix: familyChoice.mix,
			phase: figurePhase,
			complexity: journey.complexity,
			mode,
			p1: gene('p1'),
			p2: gene('p2'),
			ellipse: journey.shapeWeights.ellipse,
			lissajous: journey.shapeWeights.lissajous,
			ribbon: journey.shapeWeights.ribbon,
			rosette: journey.shapeWeights.rosette,
			tension: journey.tension,
			release: journey.release,
			spread,
			sub: bands.sub,
			kick: bands.kick,
			body: bands.body,
			mids: bands.mids,
			presence: bands.presence,
			air: bands.air,
			spectralMotion,
			energy,
			detail: renderDetailBins,
			yaw: asymmetry * 0.55 + Math.sin(figurePhase * 0.23) * 0.32 + spinAngle,
			tilt:
				0.34 +
				journey.tension * 0.2 -
				journey.release * 0.08 +
				(gene('tilt') - 0.5) * 0.5 +
				camPitch * 0.35,
			roll: figurePhase * 0.05 + spinAngle * 0.6,
			partner: layout.partner,
			dt,
			pace: (beatsPerSecond / 2) * (0.5 + journey.motion)
		};
		const figurePoints = figureEngine.evaluate(figureInput);
		const headU = sweepPhase;
		figureEngine.sample(0, headU, headLocal);
		const headX = figAX + headLocal[0] * figAScale;
		const headY = figAY + headLocal[1] * figAScale;
		const headTurn = (Math.atan2(headLocal[1], headLocal[0]) / (Math.PI * 2) + 1) % 1;

		// ---- Horizon: the figure's history, written on beat ticks. ------------
		const coupling = clamp(0.5 + gene('coupling') * 0.42, 0, 1);
		const stamp = clamp(beatGlow * 1.3 + impact * 0.4 - 0.25, 0, 1.6);
		accumulateTerrainRow(coupling, headTurn, stamp);
		const tickRate = clamp(journey.tickRate, 0.125, 3);
		tickPhase += dt * beatsPerSecond * tickRate * (feature ? 1 : 0.25);
		if (tickPhase >= 1) {
			tickPhase -= Math.floor(tickPhase);
			commitTerrainRow();
			tickFlash = 0.6 + bands.kick * 0.8;
		}
		tickFlash *= Math.exp(-dt * 7);

		// Screen offsets: put each surface's anchor (vanishing point, ring
		// centre, waterfall origin) where the layout wants it.
		const anchorX = layout.anchorX + driftX * layout.anchorFollow;
		const anchorY = layout.anchorY;
		const surfaceOffset = (kind: number): [number, number] => {
			if (kind === SURFACE_RING) {
				const cp = Math.cos(camPitch);
				const sp = Math.sin(camPitch);
				const cy = Math.cos(camYaw);
				const sy = Math.sin(camYaw);
				const wy = -camHeight;
				const wz = layout.ringZ;
				const x1 = wz * sy;
				const z1 = wz * cy;
				const y2 = wy * cp + z1 * sp;
				const z2 = Math.max(0.03, -wy * sp + z1 * cp);
				return [anchorX - (x1 * focal) / z2, anchorY - (y2 * focal) / z2];
			}
			if (kind === SURFACE_FLOOR || kind === SURFACE_TUNNEL) {
				return [anchorX - focal * Math.tan(camYaw), anchorY - focal * Math.tan(camPitch)];
			}
			return [anchorX, anchorY];
		};
		const surfaceA = layoutFrom.surface;
		const surfaceB = layoutTo.surface;
		const offsetA = surfaceOffset(surfaceA);
		const offsetB = surfaceOffset(surfaceB);

		// ---- Phosphor ------------------------------------------------------------
		resolveSignalPalette(
			paletteChoice.from,
			paletteChoice.to,
			paletteChoice.mix,
			{ hueLean: gene('hueLean'), mode, energy, warmth: gene('warmth') },
			paletteOut
		);

		// Phosphor persistence per 60 Hz frame, converted to this frame's dt.
		const persistence = clamp(
			0.875 +
				journey.tension * 0.02 +
				(1 - journey.motion) * 0.012 -
				journey.release * 0.01 -
				impact * 0.04 +
				response.persistenceOffset +
				display.persist +
				(gene('persistence') - 0.5) * 0.04,
			0.8,
			0.962
		);
		const feedbackFade =
			feedbackResetFrames > 0 ? 0 : Math.pow(persistence * (1 - silence * 0.04), dt * 60);
		// Fast phosphor for channel tails and horizon rows (their tails are drawn
		// analytically, so the feedback only needs to soften them).
		const floorFade = feedbackResetFrames > 0 ? 0 : Math.pow(0.6, dt * 60);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;

		// Band traces follow the genome's trace map on the shared time base.
		const mapA = TRACE_MAPS[traceMapChoice.from];
		const mapB = TRACE_MAPS[traceMapChoice.to];
		const mapMix = traceMapChoice.mix;
		const bandParam = (slot: 0 | 1, field: 1 | 2 | 3) =>
			(mapA[slot][field] as number) +
			((mapB[slot][field] as number) - (mapA[slot][field] as number)) * mapMix;
		const bandLevel = (slot: 0 | 1) =>
			bands[mapA[slot][0]] + (bands[mapB[slot][0]] - bands[mapA[slot][0]]) * mapMix;

		const scanAxis = gene('scan');
		const values: SignalUniformValues = {
			width: size.width,
			height: size.height,
			elapsed,
			dt,
			sub: bands.sub,
			kick: bands.kick,
			body: bands.body,
			mids: bands.mids,
			presence: bands.presence,
			air: bands.air,
			rms,
			centroid: spectrum.centroid,
			impact,
			beatGlow,
			sectionPulse: clamp(journey.sectionPulse * responseImpact, 0, 1),
			ringOut,
			energy: clamp(energy * responseMotion, 0, 1),
			silence,
			stroke:
				response.stroke *
				(1 + bands.presence * 0.08) *
				display.stroke *
				(0.86 + gene('stroke') * 0.28),
			beatPhase: clamp(clock.beatPhase, 0, 1),
			heroR: paletteOut.hero[0],
			heroG: paletteOut.hero[1],
			heroB: paletteOut.hero[2],
			paletteGain: paletteOut.gain,
			traceR: paletteOut.trace[0],
			traceG: paletteOut.trace[1],
			traceB: paletteOut.trace[2],
			ghostSpread: spread,
			horizonR: paletteOut.horizon[0],
			horizonG: paletteOut.horizon[1],
			horizonB: paletteOut.horizon[2],
			coupling,
			hotR: paletteOut.hot[0],
			hotG: paletteOut.hot[1],
			hotB: paletteOut.hot[2],
			headGlow: 0.9 + energy * 0.4,
			roomR: paletteOut.room[0],
			roomG: paletteOut.room[1],
			roomB: paletteOut.room[2],
			haze: display.haze,
			figAX,
			figAY,
			figAScale,
			figAVis: 1,
			figBX,
			figBY,
			figBScale,
			figBScreen: screen,
			headU,
			headX,
			headY,
			lightLevel: (0.55 + energy * 0.35 + beatGlow * 0.35) * (1 - silence * 0.6),
			sweepPhase,
			channels: clamp(journey.channels * (0.85 + responseMotion * 0.15), 0, 4),
			feed: layout.feed,
			feedPhase: clamp(clock.beatPhase, 0, 1),
			t0ox: layout.t0ox,
			t0oy: layout.t0oy,
			t0tx: layout.t0tx,
			t0ty: layout.t0ty,
			t0vx: layout.t0vx,
			t0vy: layout.t0vy,
			t0scroll: layout.t0scroll,
			t0vis: layout.t0vis,
			t1ox: layout.t1ox,
			t1oy: layout.t1oy,
			t1tx: layout.t1tx,
			t1ty: layout.t1ty,
			t1vx: layout.t1vx,
			t1vy: layout.t1vy,
			t1scroll: layout.t1scroll,
			t1vis: layout.t1vis,
			t2ox: layout.t2ox,
			t2oy: layout.t2oy,
			t2tx: layout.t2tx,
			t2ty: layout.t2ty,
			t2vx: layout.t2vx,
			t2vy: layout.t2vy,
			t2scroll: layout.t2scroll,
			t2vis: layout.t2vis,
			t3ox: layout.t3ox,
			t3oy: layout.t3oy,
			t3tx: layout.t3tx,
			t3ty: layout.t3ty,
			t3vx: layout.t3vx,
			t3vy: layout.t3vy,
			t3scroll: layout.t3scroll,
			t3vis: layout.t3vis,
			band2Level: bandLevel(0),
			band2Lo: bandParam(0, 1),
			band2Hi: bandParam(0, 2),
			band2Cycles: bandParam(0, 3),
			band3Level: bandLevel(1),
			band3Lo: bandParam(1, 1),
			band3Hi: bandParam(1, 2),
			band3Cycles: bandParam(1, 3),
			surfaceA,
			surfaceB,
			surfaceMix: layoutChoice.mix,
			terrainVis: layout.terrainVis,
			tickPhase,
			headIndex: terrainHead,
			tickFlash,
			relief: layout.relief * (0.75 + gene('relief') * 0.5) * (0.8 + energy * 0.35),
			camHeight,
			camPitch,
			camYaw,
			focal,
			offAX: offsetA[0],
			offAY: offsetA[1],
			offBX: offsetB[0],
			offBY: offsetB[1],
			near: layout.near,
			far: layout.far,
			span: layout.span,
			rails: layout.rails,
			ringInner: layout.ringInner,
			ringOuter: layout.ringOuter,
			ringZ: layout.ringZ,
			radarArm: layout.radarArm,
			wfX: anchorX,
			wfY: anchorY,
			wfDx: layout.wfDx,
			wfDy: layout.wfDy,
			faceAX: layout.faceAX,
			faceAY: layout.faceAY,
			faceAW: layout.faceAW,
			faceAH: layout.faceAH,
			faceARadius: layout.faceARadius,
			faceARepeat: layout.faceARepeat,
			faceAGap: layout.faceAGap,
			faceAVis: layout.faceAVis,
			faceBX: layout.faceBX,
			faceBY: layout.faceBY,
			faceBW: layout.faceBW,
			faceBH: layout.faceBH,
			faceBRadius: layout.faceBRadius,
			faceABezel: layout.faceABezel,
			faceBBezel: layout.faceBBezel,
			faceBVis: layout.faceBVis,
			scanDensity: display.scanDensity,
			scanStrength: display.scanStrength * (0.5 + scanAxis),
			curvature: display.curvature * (0.6 + gene('curvature') * 0.8),
			grain: display.grain * (0.6 + gene('grain') * 0.8),
			bloomGain: display.bloom,
			aberration: display.aberration,
			vignette: display.vignette,
			glass: display.glass,
			feedbackFade,
			floorFade,
			bloomThreshold: 1.0 - energy * 0.25,
			gridLevel: 0.75 + gene('grid') * 0.5,
			reflectY: layout.reflectY,
			reflect: layout.reflect,
			seamY: layout.seamY,
			seam: layout.seam,
			gridDensity: gene('grid'),
			sectionProgress: directed.context.sectionProgress,
			figurePhase,
			tempo: journey.tempo
		};
		packSignalUniforms(state.uniforms, values);

		const queue = state.device.queue;
		queue.writeBuffer(
			state.uniformBuffer,
			0,
			state.uniforms.buffer,
			state.uniforms.byteOffset,
			state.uniforms.byteLength
		);
		queue.writeBuffer(
			state.detailBuffer,
			0,
			renderDetailBins.buffer,
			renderDetailBins.byteOffset,
			renderDetailBins.byteLength
		);
		queue.writeBuffer(
			state.terrainBuffer,
			0,
			terrainRows.buffer,
			terrainRows.byteOffset,
			terrainRows.byteLength
		);
		queue.writeBuffer(
			state.figureBuffer,
			0,
			figurePoints.buffer,
			figurePoints.byteOffset,
			figurePoints.byteLength
		);

		const now = performance.now();
		if (now - lastHudUpdateAt >= 250) {
			lastHudUpdateAt = now;
			hudSection = directed.section;
			hudTempo = directed.clock.tempoBpm;
			hudContext = directed.context.source;
			hudChannels = Math.round(journey.channels);
			hudLayout = SIGNAL_LAYOUT_NAMES[layoutChoice.to];
			hudFamily = SIGNAL_FAMILY_NAMES[familyChoice.to];
			hudPalette = SIGNAL_PALETTES[paletteChoice.to].name;
			hudScene = genome.scene;
			hudFrameMs = Math.round(frameCpuMs * 100) / 100;
		}

		const encoder = state.device.createCommandEncoder({ label: 'Signal frame' });
		{
			const pass = encoder.beginRenderPass({
				label: 'Signal beams',
				colorAttachments: [
					{
						view: targets.sceneView,
						// Alpha carries the phosphor class; empty space claims none.
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(state.scenePipeline);
			pass.setBindGroup(0, state.sceneBindGroup);
			pass.draw(SIGNAL_VERTEX_COUNT, SIGNAL_TRACE_INSTANCES);
			pass.end();
		}
		const previous = state.parity;
		const next: 0 | 1 = previous === 0 ? 1 : 0;
		const fullscreen = (
			label: string,
			view: GPUTextureView,
			pipeline: GPURenderPipeline,
			bindGroup: GPUBindGroup
		) => {
			const pass = encoder.beginRenderPass({
				label,
				colorAttachments: [
					{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }
				]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
		};
		fullscreen(
			'Signal phosphor',
			targets.feedbackViews[next],
			state.feedbackPipeline,
			state.feedbackBindGroups[previous]
		);
		fullscreen(
			'Signal bloom prefilter',
			targets.bloomViews[0],
			state.bloomDownPipeline,
			state.bloomDownBindGroups[next]
		);
		for (let iteration = 0; iteration < 2; iteration += 1) {
			fullscreen('Signal bloom blur H', targets.bloomViews[1], state.blurHPipeline, state.blurHBindGroup);
			fullscreen('Signal bloom blur V', targets.bloomViews[0], state.blurVPipeline, state.blurVBindGroup);
		}
		fullscreen(
			'Signal present',
			state.context.getCurrentTexture().createView(),
			state.compositePipeline,
			state.compositeBindGroups[next]
		);
		state.parity = next;
		queue.submit([encoder.finish()]);
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		if (!schedulerTickAt) {
			schedulerTickAt = now;
		} else {
			const elapsed = Math.max(0, now - schedulerTickAt);
			schedulerTickAt = now;
			observeDisplayCadence(elapsed);
		}
		// Whole-vsync frame stride: 60 fps on 120/144 Hz panels without the
		// uneven 2/3-vsync cadence a fractional accumulator produces.
		const nextFrameStride = displayFrameStride(refreshIntervalMs, TARGET_FRAME_RATE);
		if (nextFrameStride !== activeFrameStride) {
			activeFrameStride = nextFrameStride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender -= 1;
			return;
		}
		framesUntilRender = activeFrameStride - 1;
		const elapsedMs = lastRenderedAt ? now - lastRenderedAt : refreshIntervalMs * activeFrameStride;
		lastRenderedAt = now;
		try {
			const cpuStart = performance.now();
			renderFrame(gpu, clamp(elapsedMs / 1000, 0.001, 0.25));
			frameCpuMs += (performance.now() - cpuStart - frameCpuMs) * 0.05;
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
				refreshIntervalMs = 1000 / 60;
				activeFrameStride = 1;
				framesUntilRender = 0;
				lastRenderedAt = 0;
				rendererSourceEpoch = -1;
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
		lookOverride = parseSignalLookOverride(new URLSearchParams(location.search).get('signalLook'));
		variation?.setOverride(lookOverride);
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
			data-signal-channels={hudChannels}
			data-signal-layout={hudLayout}
			data-signal-family={hudFamily}
			data-signal-palette={hudPalette}
			data-signal-scene={hudScene}
			data-signal-frame-ms={hudFrameMs}
			data-signal-render-passes={SIGNAL_RENDER_PASSES}
			data-signal-frame-stride={activeFrameStride}
			data-signal-refresh-rate={measuredRefreshRate}
			data-signal-internal-pixels={internalPixels}
			data-signal-ready={String(ready)}
		></canvas>

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
				</div>
			</div>
		{/if}
	</div>
{/if}
