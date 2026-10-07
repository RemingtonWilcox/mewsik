<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		VISUALIZER_RESPONSE_PROFILES,
		useVisualizer,
		type VisualizerJourneySnapshot
	} from '$lib/state/visualizer.svelte';
	import {
		LOOM_BLOOM_BLUR_H_WGSL,
		LOOM_BLOOM_BLUR_V_WGSL,
		LOOM_BLOOM_DOWN_WGSL,
		LOOM_COMPOSITE_WGSL,
		LOOM_FEEDBACK_WGSL,
		LOOM_INSTANCES,
		LOOM_SCENE_WGSL,
		LOOM_STRANDS,
		LOOM_VERTEX_COUNT
	} from '$lib/visualizer/loom/shaders';
	import {
		LOOM_UNIFORM_BYTES,
		LOOM_UNIFORM_FLOATS,
		packLoomUniforms,
		type LoomUniformValues
	} from '$lib/visualizer/loom/uniform-layout';

	const vis = useVisualizer();

	const DETAIL_BYTES = 64 * 4;
	const TARGET_FRAME_RATE = 60;
	const INTERNAL_SCALE = 0.78;
	const MAX_INTERNAL_PIXELS = 1600 * 900;
	/** One weft pick per beat; the draft re-patterns every phrase of 32 picks. */
	const BEATS_PER_PHRASE = 32;

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
	let refreshIntervalMs = 1000 / 60;
	let activeFrameStride = $state(1);
	let framesUntilRender = 0;
	let measuredRefreshRate = $state(60);
	let lastRenderedAt = 0;
	let startTime = 0;
	let rendererSourceEpoch = -1;
	let rms = 0;
	let renderCentroid = 0;
	let renderSpectralMotion = 0;
	let silence = 1;
	let quietFor = 0;
	let poseSyncRequested = true;
	let renderBeats = 0;
	let renderBpm = 120;
	let beatGlow = 0;
	let swayPhase = 0;
	let driftPhase = 0;
	let seedHi = 0;
	let seedLo = 0;
	/** Frames left during which the feedback trail is cleared (source reset, resize). */
	let feedbackResetFrames = 0;
	const renderDetailBins = new Float32Array(64);

	type LoomTargets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		depth: GPUTexture;
		depthView: GPUTextureView;
		/** Ping-pong HDR history for the temporal feedback trail. */
		feedback: [GPUTexture, GPUTexture];
		feedbackViews: [GPUTextureView, GPUTextureView];
		/** Half-resolution bloom chain: [0] prefilter/final, [1] horizontal pass. */
		bloom: [GPUTexture, GPUTexture];
		bloomViews: [GPUTextureView, GPUTextureView];
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
		feedbackPipeline: GPURenderPipeline;
		bloomDownPipeline: GPURenderPipeline;
		blurHPipeline: GPURenderPipeline;
		blurVPipeline: GPURenderPipeline;
		compositePipeline: GPURenderPipeline;
		targets: LoomTargets | null;
		sceneBindGroup: GPUBindGroup;
		/** Indexed by the parity of the frame being read (previous frame). */
		feedbackBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		/** Indexed by the parity of the frame just written. */
		bloomDownBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		blurHBindGroup: GPUBindGroup | null;
		blurVBindGroup: GPUBindGroup | null;
		compositeBindGroups: [GPUBindGroup, GPUBindGroup] | null;
		parity: 0 | 1;
	};

	let gpu: LoomGpu | null = null;

	type LoomFrame = VisualizerJourneySnapshot['loom'];
	const LOOM_POSE_KEYS = [
		'tension',
		'release',
		'openness',
		'dropOpenness',
		'braid',
		'twist',
		'curl',
		'weftSparse',
		'impact',
		'reweave',
		'sectionPulse',
		'motion',
		'macroEnergy',
		'tempo',
		'key',
		'mode',
		'spectralLean',
		'longRate',
		'cameraYaw',
		'cameraPitch',
		'cameraDistance',
		'cameraRoll'
	] as const satisfies readonly (keyof LoomFrame)[];
	type LoomPoseKey = (typeof LOOM_POSE_KEYS)[number];
	const renderPose = Object.fromEntries(LOOM_POSE_KEYS.map((key) => [key, 0])) as Record<
		LoomPoseKey,
		number
	>;
	const renderTopology = { torus: 1, helix: 0, saddle: 0, knot: 0, cage: 0 };
	const renderBands = { sub: 0, kick: 0, body: 0, mids: 0, presence: 0, air: 0 };
	const renderPalette = { baseHue: 0, accentHue: 0, rimHue: 0, saturation: 0 };
	const CAMERA_KEYS = new Set<LoomPoseKey>([
		'cameraYaw',
		'cameraPitch',
		'cameraDistance',
		'cameraRoll'
	]);
	const TRANSIENT_KEYS = new Set<LoomPoseKey>(['impact', 'reweave', 'sectionPulse']);
	const TOPOLOGY_KEYS = ['torus', 'helix', 'saddle', 'knot', 'cage'] as const;
	const BAND_KEYS = ['sub', 'kick', 'body', 'mids', 'presence', 'air'] as const;

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function approachHue(current: number, target: number, rate: number, dt: number) {
		const delta = ((((target - current + 0.5) % 1) + 1) % 1) - 0.5;
		return ((current + delta * (1 - Math.exp(-rate * dt))) % 1 + 1) % 1;
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

	function beatAnchor(loom: Readonly<LoomFrame>) {
		if (!Number.isFinite(loom.phraseIndex) || !Number.isFinite(loom.phrase)) return null;
		return loom.phraseIndex * BEATS_PER_PHRASE + loom.phrase * BEATS_PER_PHRASE;
	}

	function syncRenderPose(
		loom: Readonly<LoomFrame>,
		palette: VisualizerJourneySnapshot['director']['palette']
	) {
		for (const key of LOOM_POSE_KEYS) renderPose[key] = loom[key];
		for (const key of TOPOLOGY_KEYS) renderTopology[key] = loom.topologyWeights[key];
		for (const key of BAND_KEYS) renderBands[key] = loom.strandEnergy[key];
		renderPalette.baseHue = palette.baseHue;
		renderPalette.accentHue = palette.accentHue;
		renderPalette.rimHue = palette.rimHue;
		renderPalette.saturation = palette.saturation;
		driftPhase = loom.longPhase;
		poseSyncRequested = false;
	}

	function updateRenderPose(
		loom: Readonly<LoomFrame>,
		palette: VisualizerJourneySnapshot['director']['palette'],
		dt: number
	) {
		if (poseSyncRequested) syncRenderPose(loom, palette);
		else {
			for (const key of LOOM_POSE_KEYS) {
				const tau = CAMERA_KEYS.has(key) ? 0.24 : TRANSIENT_KEYS.has(key) ? 0.045 : 0.13;
				const rate = 1 / tau;
				if (key === 'key') renderPose[key] = approachHue(renderPose[key], loom[key], rate, dt);
				else renderPose[key] = approach(renderPose[key], loom[key], rate, dt);
			}
			const topologyMix = 1 - Math.exp(-dt / 0.18);
			const bandMix = 1 - Math.exp(-dt / 0.055);
			for (const key of TOPOLOGY_KEYS) {
				renderTopology[key] += (loom.topologyWeights[key] - renderTopology[key]) * topologyMix;
			}
			for (const key of BAND_KEYS) {
				renderBands[key] += (loom.strandEnergy[key] - renderBands[key]) * bandMix;
			}
			renderPalette.baseHue = approachHue(renderPalette.baseHue, palette.baseHue, 4.5, dt);
			renderPalette.accentHue = approachHue(renderPalette.accentHue, palette.accentHue, 4.5, dt);
			renderPalette.rimHue = approachHue(renderPalette.rimHue, palette.rimHue, 4.5, dt);
			renderPalette.saturation = approach(renderPalette.saturation, palette.saturation, 4.5, dt);
			driftPhase += renderPose.longRate * dt;
		}
		return renderPose;
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
		for (const texture of targets.feedback) texture.destroy();
		for (const texture of targets.bloom) texture.destroy();
	}

	function ensureTargets(state: LoomGpu, width: number, height: number) {
		if (state.targets?.width === width && state.targets.height === height) return;
		destroyTargets(state.targets);
		const hdr = (label: string, w: number, h: number) =>
			state.device.createTexture({
				label,
				size: { width: w, height: h },
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
			});
		const scene = hdr('Loom scene', width, height);
		const depth = state.device.createTexture({
			label: 'Loom depth',
			size: { width, height },
			format: 'depth24plus',
			usage: GPUTextureUsage.RENDER_ATTACHMENT
		});
		const feedback: [GPUTexture, GPUTexture] = [
			hdr('Loom feedback A', width, height),
			hdr('Loom feedback B', width, height)
		];
		const bloomWidth = Math.max(1, Math.floor(width / 2));
		const bloomHeight = Math.max(1, Math.floor(height / 2));
		const bloom: [GPUTexture, GPUTexture] = [
			hdr('Loom bloom A', bloomWidth, bloomHeight),
			hdr('Loom bloom B', bloomWidth, bloomHeight)
		];
		const targets: LoomTargets = {
			scene,
			sceneView: scene.createView(),
			depth,
			depthView: depth.createView(),
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
			bind(state.feedbackPipeline, 'Loom feedback reads A', [targets.sceneView, targets.feedbackViews[0]]),
			bind(state.feedbackPipeline, 'Loom feedback reads B', [targets.sceneView, targets.feedbackViews[1]])
		];
		state.bloomDownBindGroups = [
			bind(state.bloomDownPipeline, 'Loom bloom prefilter A', [targets.feedbackViews[0]]),
			bind(state.bloomDownPipeline, 'Loom bloom prefilter B', [targets.feedbackViews[1]])
		];
		state.blurHBindGroup = bind(state.blurHPipeline, 'Loom bloom blur H', [targets.bloomViews[0]]);
		state.blurVBindGroup = bind(state.blurVPipeline, 'Loom bloom blur V', [targets.bloomViews[1]]);
		state.compositeBindGroups = [
			bind(state.compositePipeline, 'Loom composite A', [targets.feedbackViews[0], targets.bloomViews[0]]),
			bind(state.compositePipeline, 'Loom composite B', [targets.feedbackViews[1], targets.bloomViews[0]])
		];
		feedbackResetFrames = 2;
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
			const feedbackModule = device.createShaderModule({ code: LOOM_FEEDBACK_WGSL });
			const bloomDownModule = device.createShaderModule({ code: LOOM_BLOOM_DOWN_WGSL });
			const blurHModule = device.createShaderModule({ code: LOOM_BLOOM_BLUR_H_WGSL });
			const blurVModule = device.createShaderModule({ code: LOOM_BLOOM_BLUR_V_WGSL });
			const compositeModule = device.createShaderModule({ code: LOOM_COMPOSITE_WGSL });
			const assertCompiled = async (module: GPUShaderModule, label: string) => {
				const info = await module.getCompilationInfo();
				const errors = info.messages.filter((message) => message.type === 'error');
				if (errors.length) {
					const detail = errors
						.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
						.join(' | ');
					throw new Error(`${label} shader failed to compile: ${detail}`);
				}
			};
			await Promise.all([
				assertCompiled(sceneModule, 'Loom instrument'),
				assertCompiled(feedbackModule, 'Loom feedback'),
				assertCompiled(bloomDownModule, 'Loom bloom prefilter'),
				assertCompiled(blurHModule, 'Loom bloom blur'),
				assertCompiled(blurVModule, 'Loom bloom blur'),
				assertCompiled(compositeModule, 'Loom presentation')
			]);
			const fullscreenPipeline = (
				label: string,
				module: GPUShaderModule,
				targetFormat: GPUTextureFormat
			) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
					primitive: { topology: 'triangle-list' }
				});
			const pipelines = (await Promise.all([
				device.createRenderPipelineAsync({
					label: 'Loom instrument pipeline',
					layout: 'auto',
					vertex: { module: sceneModule, entryPoint: 'vs_main' },
					fragment: {
						module: sceneModule,
						entryPoint: 'fs_main',
						targets: [{ format: 'rgba16float' }]
					},
					primitive: { topology: 'triangle-list', cullMode: 'none' },
					depthStencil: {
						format: 'depth24plus',
						depthWriteEnabled: true,
						depthCompare: 'less'
					}
				}),
				fullscreenPipeline('Loom feedback pipeline', feedbackModule, 'rgba16float'),
				fullscreenPipeline('Loom bloom prefilter pipeline', bloomDownModule, 'rgba16float'),
				fullscreenPipeline('Loom bloom blur H pipeline', blurHModule, 'rgba16float'),
				fullscreenPipeline('Loom bloom blur V pipeline', blurVModule, 'rgba16float'),
				fullscreenPipeline('Loom presentation pipeline', compositeModule, format)
			])) as [
				GPURenderPipeline,
				GPURenderPipeline,
				GPURenderPipeline,
				GPURenderPipeline,
				GPURenderPipeline,
				GPURenderPipeline
			];

			uniformBuffer = device.createBuffer({
				size: LOOM_UNIFORM_BYTES,
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
				uniforms: new Float32Array(LOOM_UNIFORM_FLOATS),
				scenePipeline: pipelines[0],
				feedbackPipeline: pipelines[1],
				bloomDownPipeline: pipelines[2],
				blurHPipeline: pipelines[3],
				blurVPipeline: pipelines[4],
				compositePipeline: pipelines[5],
				targets: null,
				sceneBindGroup,
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

		const feature = vis.getLatest(now);
		const shared = vis.getJourney(now);
		const loom = shared.loom;
		if (rendererSourceEpoch !== shared.sourceEpoch) {
			rendererSourceEpoch = shared.sourceEpoch;
			rms = clamp(feature?.rms ?? 0, 0, 1);
			renderCentroid = shared.spectrum.centroid;
			renderSpectralMotion = shared.spectrum.spectralMotion;
			for (let index = 0; index < renderDetailBins.length; index += 1) {
				renderDetailBins[index] = shared.spectrum.detailBins[index] ?? 0;
			}
			const seedWord = Math.floor(clamp(shared.seed, 0, 1) * 0xffffffff) >>> 0;
			seedHi = seedWord >>> 16;
			seedLo = seedWord & 0xffff;
			renderBeats = beatAnchor(loom) ?? 0;
			swayPhase = 0;
			poseSyncRequested = true;
			feedbackResetFrames = 2;
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
		const pose = updateRenderPose(loom, directed.palette, dt);
		renderCentroid = approach(renderCentroid, spectrum.centroid, 8, dt);
		renderSpectralMotion = approach(renderSpectralMotion, spectrum.spectralMotion, 11, dt);
		const detailMix = 1 - Math.exp(-dt / 0.05);
		for (let index = 0; index < renderDetailBins.length; index += 1) {
			renderDetailBins[index] +=
				((spectrum.detailBins[index] ?? 0) - renderDetailBins[index]) * detailMix;
		}

		// The weft conveyor is song time: one pick per beat, phase-locked to the
		// shared clock and gently pulled to the phrase anchor so seeks snap and
		// live drift never accumulates.
		const clock = directed.clock;
		const bpmTarget = clamp(clock.tempoBpm || 0, 0, 220);
		renderBpm = approach(renderBpm, bpmTarget >= 30 ? bpmTarget : 120, 2, dt);
		if (feature && silence < 0.5) renderBeats += (dt * renderBpm) / 60;
		const anchor = beatAnchor(loom);
		if (feature && anchor !== null) {
			const diff = anchor - renderBeats;
			if (Math.abs(diff) > BEATS_PER_PHRASE * 0.75) renderBeats = anchor;
			else renderBeats += diff * (1 - Math.exp(-dt / 0.45));
		}
		const beatPhase = clamp(clock.beatPhase, 0, 1);
		beatGlow = approach(beatGlow, feature ? Math.exp(-beatPhase * 5) : 0, 30, dt);
		const response = VISUALIZER_RESPONSE_PROFILES.loom[vis.response];
		const responseMotion = response.motion;
		const responseImpact = response.impact;
		swayPhase +=
			(0.35 + pose.motion * 0.9 + pose.tempo * 0.35) * responseMotion * dt;

		const energy = clamp(
			pose.macroEnergy * 0.72 + rms * 0.18 + renderSpectralMotion * 0.1,
			0,
			1
		);
		const impact = clamp(pose.impact * responseImpact, 0, 1);
		const cameraYaw = pose.cameraYaw + Math.sin(driftPhase * 0.5) * 0.045;

		// Post stack: trails shorten on impact and in silence; the bloom knee
		// drops with energy so drops glow and verses stay graphic.
		const feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp(
						(0.88 + energy * 0.05 - impact * 0.16 + response.feedbackFadeOffset) *
							(1 - silence * 0.35),
						0.4,
						0.95
					);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		const feedbackZoom = 1 - (0.0025 + renderBands.sub * 0.004) * responseMotion;
		const bloomThreshold = 0.75 - energy * 0.2 + response.bloomThresholdOffset;
		const aberration = 1 + impact * 1.8;

		const values: LoomUniformValues = {
			width: size.width,
			height: size.height,
			elapsed: (now - startTime) / 1000,
			responseMotion,
			impact,
			reweave: pose.reweave,
			sectionPulse: pose.sectionPulse,
			beatPhase: beatGlow,
			rms,
			sub: renderBands.sub,
			kick: renderBands.kick,
			body: renderBands.body,
			mids: renderBands.mids,
			presence: renderBands.presence,
			air: renderBands.air,
			centroid: renderCentroid,
			energy,
			spectralMotion: renderSpectralMotion,
			spectralLean: pose.spectralLean,
			tempo: pose.tempo,
			tension: pose.tension,
			release: pose.release,
			openness: clamp(pose.openness + pose.dropOpenness * 0.1, 0, 1),
			dropOpenness: pose.dropOpenness,
			curl: pose.curl,
			sway: pose.motion,
			braid: pose.braid,
			twist: pose.twist,
			knot: renderTopology.knot,
			cage: renderTopology.cage,
			saddle: renderTopology.saddle,
			helix: renderTopology.helix,
			baseHue: renderPalette.baseHue,
			accentHue: renderPalette.accentHue,
			rimHue: renderPalette.rimHue,
			saturation: renderPalette.saturation,
			yaw: cameraYaw,
			pitch: pose.cameraPitch,
			distance: pose.cameraDistance,
			roll: pose.cameraRoll,
			beatConveyor: renderBeats,
			swayPhase,
			weftSparse: pose.weftSparse,
			driftPhase,
			warpRadius: clamp(
				(0.016 + renderBands.body * 0.003 + impact * 0.001) * response.width,
				0.01,
				0.024
			),
			weftRadius: clamp(0.011 * (0.85 + response.width * 0.15), 0.007, 0.016),
			glow: clamp((0.42 + energy * 0.34) * response.glow, 0.3, 1.05),
			silence,
			seedHi,
			seedLo,
			key: pose.key,
			mode: pose.mode,
			feedbackFade,
			feedbackZoom,
			bloomThreshold,
			aberration
		};
		packLoomUniforms(state.uniforms, values);

		state.device.queue.writeBuffer(
			state.uniformBuffer,
			0,
			state.uniforms.buffer,
			state.uniforms.byteOffset,
			state.uniforms.byteLength
		);
		state.device.queue.writeBuffer(
			state.detailBuffer,
			0,
			renderDetailBins.buffer,
			renderDetailBins.byteOffset,
			renderDetailBins.byteLength
		);

		hudSection = loom.section;
		hudTopology = dominantTopology(loom.topologyWeights);
		const encoder = state.device.createCommandEncoder({ label: 'Loom frame' });
		{
			const pass = encoder.beginRenderPass({
				label: 'Loom instrument',
				colorAttachments: [
					{
						view: targets.sceneView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				],
				depthStencilAttachment: {
					view: targets.depthView,
					depthClearValue: 1,
					depthLoadOp: 'clear',
					depthStoreOp: 'discard'
				}
			});
			pass.setPipeline(state.scenePipeline);
			pass.setBindGroup(0, state.sceneBindGroup);
			pass.draw(LOOM_VERTEX_COUNT, LOOM_INSTANCES);
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
		// scene + feedback[previous] -> feedback[next]
		fullscreen(
			'Loom feedback',
			targets.feedbackViews[next],
			state.feedbackPipeline,
			state.feedbackBindGroups[previous]
		);
		// feedback[next] -> bloom[0] (half res, thresholded) -> bloom[1] -> bloom[0]
		fullscreen(
			'Loom bloom prefilter',
			targets.bloomViews[0],
			state.bloomDownPipeline,
			state.bloomDownBindGroups[next]
		);
		for (let iteration = 0; iteration < 2; iteration += 1) {
			fullscreen('Loom bloom blur H', targets.bloomViews[1], state.blurHPipeline, state.blurHBindGroup);
			fullscreen('Loom bloom blur V', targets.bloomViews[0], state.blurVPipeline, state.blurVBindGroup);
		}
		// feedback[next] + bloom[0] -> swap chain
		fullscreen(
			'Loom present',
			state.context.getCurrentTexture().createView(),
			state.compositePipeline,
			state.compositeBindGroups[next]
		);
		state.parity = next;
		state.device.queue.submit([encoder.finish()]);
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
		const nextFrameStride = displayFrameStride(refreshIntervalMs, TARGET_FRAME_RATE);
		if (nextFrameStride !== activeFrameStride) {
			activeFrameStride = nextFrameStride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender--;
			return;
		}
		framesUntilRender = activeFrameStride - 1;
		const elapsedMs = lastRenderedAt
			? now - lastRenderedAt
			: refreshIntervalMs * activeFrameStride;
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
				refreshIntervalMs = 1000 / 60;
				activeFrameStride = 1;
				framesUntilRender = 0;
				lastRenderedAt = 0;
				poseSyncRequested = true;
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
			data-loom-render-passes="8"
			data-loom-strands={LOOM_STRANDS}
			data-loom-frame-stride={activeFrameStride}
			data-loom-refresh-rate={measuredRefreshRate}
			data-loom-internal-pixels={internalPixels}
			data-loom-ready={String(ready)}
		></canvas>

		{#if !ready && !errorMsg}
			<div
				class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.2em] text-blue-100/40"
			>
				threading the warp
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
