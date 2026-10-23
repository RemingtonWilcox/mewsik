<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { VISUALIZER_TUNING, useVisualizer } from '$lib/state/visualizer.svelte';
	import {
		MANDALA_BIN_COUNT,
		MANDALA_BLOOM_DOWN_WGSL,
		MANDALA_BLUR_H_WGSL,
		MANDALA_BLUR_V_WGSL,
		MANDALA_COMPOSITE_WGSL,
		MANDALA_EXPOSURE_WGSL,
		MANDALA_FEEDBACK_WGSL,
		MANDALA_SCENE_WGSL
	} from '$lib/visualizer/mandala/shaders';
	import {
		MANDALA_UNIFORM_BYTES,
		MANDALA_UNIFORM_FLOATS,
		packMandalaUniforms,
		type MandalaUniformValues
	} from '$lib/visualizer/mandala/uniform-layout';
	import {
		MANDALA_AXES,
		MANDALA_FOLDS,
		MANDALA_PALETTES,
		MANDALA_RAYMARCHED,
		MANDALA_VARIANT_NAMES,
		MANDALA_WORLDS,
		MandalaFollower,
		mandalaAnswer,
		mandalaApplyCharacter,
		mandalaPaletteFit,
		mandalaPullCharacter,
		mandalaSlot,
		mandalaSlotParts,
		mandalaWorldFit,
		mixRgb,
		turnHue,
		type Rgb
	} from '$lib/visualizer/mandala/look';
	import { FoldSpring, JuliaTrack, MandalaVoyage } from '$lib/visualizer/mandala/flight';
	import { HeardPulse } from '$lib/visualizer/mandala/pulse';
	import { VariationGenome, type ContinuousAxis } from '$lib/visualizer/variation';
	import { Wander } from '$lib/visualizer/motion';
	import type { MusicCharacter } from '$lib/visualizer/character';

	const vis = useVisualizer();

	const TARGET_FRAME_RATE = 60;
	const RENDER_PASSES = 9;
	const WORLD_INDEX = Object.fromEntries(MANDALA_WORLDS.map((name, index) => [name, index])) as Record<
		(typeof MANDALA_WORLDS)[number],
		number
	>;

	/**
	 * Quality tiers. Desktop GPUs take the full march; phones and tablets
	 * march fewer steps and fewer fractal iterations at a lower internal
	 * resolution, and skip ambient occlusion. A governor scales resolution
	 * down further if frames run long.
	 */
	const QUALITY_TIERS = {
		high: { steps: 120, detail: 1, scale: 0.78, maxPixels: 1600 * 900, occlusion: 1 },
		low: { steps: 60, detail: 0.7, scale: 0.55, maxPixels: 1024 * 576, occlusion: 0 }
	} as const;
	type QualityTier = keyof typeof QUALITY_TIERS;

	function pickTier(): QualityTier {
		if (typeof navigator === 'undefined') return 'high';
		const forcedTier = forced()?.quality;
		if (forcedTier === 0) return 'low';
		if (forcedTier === 1) return 'high';
		return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 'low' : 'high';
	}

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let internalPixels = $state(0);
	let hudWorld = $state('');
	let hudVariant = $state('');
	let hudFold = $state(8);
	let hudPalette = $state('');
	let hudShifts = $state(0);
	let hudHits = $state(0);
	let hudHeard = $state('');
	let hudTier = $state<QualityTier>('high');
	let hudScale = $state('1.00');
	let raf = 0;
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let initVersion = 0;
	let initializing = false;
	let schedulerTickAt = 0;
	let refreshIntervalMs = 1000 / 60;
	let activeFrameStride = $state(1);
	let framesUntilRender = 0;
	let lastRenderedAt = 0;
	let frameIndex = 0;
	let rendererSourceEpoch = -1;
	/** Frames left during which the feedback trail and the exposure meter restart. */
	let feedbackResetFrames = 2;
	let tier: QualityTier = 'high';
	/** Resolution governor: fraction of the tier's internal scale in use. */
	let governor = 1;
	let slowFor = 0;
	let fastFor = 0;
	/** Smoothed submit-to-done time of recent frames, ms. */
	let gpuFrameMs = 0;

	type Palette = { stops: [Rgb, Rgb, Rgb, Rgb]; spark: Rgb; sheen: number };

	function freshEnv() {
		return {
			rms: 0,
			energy: 0,
			bass: 0,
			mid: 0,
			treble: 0,
			silence: 1,
			quietFor: 0.5,
			// Character rails: always follow what kind of music it is, through
			// glides of about a second that speed up after a shift.
			tempo: 0.5,
			harsh: 0,
			punch: 0.4,
			bright: 0.4,
			valence: 0.5,
			weight: 0.3,
			drive: 0.3,
			// Spectral tilt and hiss, measured here from the band levels: the
			// shared character's noise and brightness saturate on many sources.
			tilt: 0.5,
			hiss: 0.3
		};
	}

	/**
	 * Everything the picture is made of beyond the genome. Lives in the
	 * journey's persistent look next to the genome, so a new song continues
	 * the voyage and a remount resumes it exactly.
	 */
	type MandalaRun = {
		voyage: MandalaVoyage;
		spring: FoldSpring;
		pulse: HeardPulse;
		julia: JuliaTrack[];
		env: ReturnType<typeof freshEnv>;
		/** World x variant x fold, morphed on the GPU. */
		scene: MandalaFollower;
		palette: MandalaFollower;
		colours: Palette;
		lastShiftSerial: number;
		lastHits: number;
		/** Seconds until the character weights are refreshed. */
		weightsIn: number;
		/**
		 * Mandala's own ear for a change of music, on the features it reads
		 * itself (tempo, tilt, hiss, punch, weight, drive): a fast and a slow
		 * envelope, and seconds since the last shift either ear answered.
		 */
		earFast: number[];
		earSlow: number[];
		sinceShift: number;
		/** Seconds the ear has heard a change it has not answered yet (-1: none). */
		earPending: number;
		earPeak: number;
		/**
		 * Re-checks left for the answer to the latest change of music: the
		 * character lags the music by a second or so, so the first pick is
		 * checked again at 1.4 s and at 3 s after that.
		 */
		settleChecks: number;
		/** Seconds since the shift at which the next settle check runs. */
		nextCheck: number;
		/** Recent peak of the character's contrast (how different the music is). */
		contrastPeak: number;
		/** Eased continuous targets (see glideValues), before the wander. */
		base: Record<string, number>;
		/** What the picture reads: the eased targets plus their continuous wander. */
		vals: Record<string, number>;
		/** Mandala's own wander of every continuous axis (it glides targets itself). */
		wander: Wander;
		/** Seconds of transient surge left over from the last kick. */
		surge: number;
		/**
		 * Mandala's own answers to the latest change of music (see answered()),
		 * held until the genome's next boundary that may move that axis.
		 */
		answers: Record<'world' | 'palette', { option: number; boundary: number } | null>;
		/** Worlds and palettes shown lately, newest last: answers prefer other good fits. */
		recent: Record<'world' | 'palette', number[]>;
		/** Seconds the running world and palette morphs take (fixed at their start). */
		sceneTau: number;
		/** The world the scene is heading to, to notice a change of world once. */
		worldTarget: number;
		paletteTau: number;
	};

	const lookState = vis.persistentLook('mandala', () => ({
		genome: new VariationGenome(MANDALA_AXES, 0.5),
		epoch: -1,
		run: null as MandalaRun | null
	}));
	const genome = lookState.genome;
	const bins = new Float32Array(MANDALA_BIN_COUNT);

	function clamp(value: number, low: number, high: number) {
		return Math.min(high, Math.max(low, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function finite(value: number, fallback = 0) {
		return Number.isFinite(value) ? value : fallback;
	}

	function approachRgb(current: Rgb, target: Rgb, rate: number, dt: number) {
		for (let i = 0; i < 3; i++) current[i] = approach(current[i], target[i], rate, dt);
	}

	// Dev-only look override for the lab and capture scripts:
	// window.__MANDALA_FORCE__ = { world: 3, variant: 1, fold: 5, palette: 2, formA: 0.4, quality: 0 }.
	type MandalaForce = Partial<Record<string, number>>;
	function forced(): MandalaForce | null {
		if (!import.meta.env.DEV) return null;
		return (globalThis as { __MANDALA_FORCE__?: MandalaForce }).__MANDALA_FORCE__ ?? null;
	}

	function choiceTarget(name: string): number {
		const value = forced()?.[name];
		return value === undefined ? genome.choice(name).to : value;
	}

	function val(name: string): number {
		const value = forced()?.[name];
		if (value !== undefined) return value;
		return lookState.run?.vals[name] ?? genome.value(name);
	}

	const CONTINUOUS = MANDALA_AXES.flatMap((axis, index) =>
		axis.kind === 'continuous' ? [{ axis: axis as ContinuousAxis, index }] : []
	);
	/** Seconds per wander undulation, by the axis's scale (as the genome's). */
	const WANDER_PERIODS = CONTINUOUS.map(
		({ axis }) => axis.wanderPeriod ?? (axis.scale === 'phrase' ? 24 : axis.scale === 'section' ? 50 : 110)
	);

	/**
	 * Mandala glides the genome's continuous targets itself: patiently after a
	 * boundary (the axis's own tau), but within about two seconds of a shift,
	 * so the answer to new music lands and then holds instead of creeping on.
	 */
	function glideValues(run: MandalaRun, dt: number) {
		const targets = genome.targetVector();
		const hurry = run.sinceShift < 3.5 ? 5 : 1;
		// Between boundaries nothing parks: every axis wanders on smooth,
		// never-repeating noise around its eased target.
		const drift = run.wander.update(dt, (0.75 + env01(run.env.energy) * 0.5) * (1 - run.env.silence * 0.6));
		CONTINUOUS.forEach(({ axis, index }, lane) => {
			const range = axis.max - axis.min;
			const target = axis.min + (targets[index] ?? 0.5) * range;
			const current = run.base[axis.name] ?? target;
			const k = 1 - Math.exp((-dt * hurry) / Math.max(0.3, axis.tau));
			const amount = (axis.wander ?? Math.min(0.12, axis.step * 0.6)) * range;
			if (axis.wrap) {
				let delta = (target - current) % range;
				if (delta > range / 2) delta -= range;
				if (delta < -range / 2) delta += range;
				const base = axis.min + ((((current + delta * k - axis.min) % range) + range) % range);
				run.base[axis.name] = base;
				run.vals[axis.name] = axis.min + ((((base + drift[lane] * amount - axis.min) % range) + range) % range);
			} else {
				const base = current + (target - current) * k;
				run.base[axis.name] = base;
				// Reflect at the bounds so the drift never sticks to an edge.
				let v = base + drift[lane] * amount;
				if (v > axis.max) v = axis.max - (v - axis.max);
				if (v < axis.min) v = axis.min + (axis.min - v);
				run.vals[axis.name] = clamp(v, axis.min, axis.max);
			}
		});
	}

	function env01(value: number) {
		return clamp(finite(value), 0, 1);
	}

	/**
	 * World and palette: the genome's choice, except right after a change of
	 * music, when Mandala's own answer (keep what fits, else the best fit)
	 * holds until the genome next moves that axis at a boundary.
	 */
	function answered(name: 'world' | 'palette'): number {
		const run = lookState.run;
		const forcedValue = forced()?.[name];
		if (forcedValue !== undefined || !run) return choiceTarget(name);
		const answer = run.answers[name];
		if (answer && boundaryCount(name) === answer.boundary) return answer.option;
		run.answers[name] = null;
		return genome.choice(name).to;
	}

	/** The genome boundaries that may move an axis: sections for worlds, eras for palettes. */
	function boundaryCount(name: 'world' | 'palette'): number {
		const boundaries = genome.boundaries;
		return name === 'world' ? boundaries.sections : boundaries.eras;
	}

	let answerSerial = 0;
	/** A deterministic 0..1 roll per answer (golden-ratio sequence). */
	function answerRoll(run: MandalaRun): number {
		answerSerial += 1;
		return (run.voyage.phase[0] * 0.37 + answerSerial * 0.6180339887) % 1;
	}

	/** How many recently shown worlds / palettes an answer steps away from. */
	const RECENT = { world: 4, palette: 6 } as const;

	function answerFor(run: MandalaRun, axis: 'world' | 'palette', current: number, heard: MusicCharacter, leave: boolean) {
		return mandalaAnswer(axis, current, heard, answerRoll(run), leave, undefined, run.recent[axis]);
	}

	/** Remember what is on screen, so a later change of music prefers something else. */
	function noteShown(run: MandalaRun, axis: 'world' | 'palette', option: number) {
		const list = run.recent[axis];
		if (list[list.length - 1] === option) return;
		const at = list.indexOf(option);
		if (at >= 0) list.splice(at, 1);
		list.push(option);
		if (list.length > RECENT[axis]) list.shift();
	}

	function sceneTarget(): number {
		const world = clamp(Math.round(answered('world')), 0, MANDALA_WORLDS.length - 1);
		const variant = clamp(Math.round(choiceTarget('variant')), 0, 3);
		const fold = clamp(Math.round(choiceTarget('fold')), 0, MANDALA_FOLDS.length - 1);
		return mandalaSlot(world, variant, fold);
	}

	function paletteFrom(index: number): Palette {
		const p = MANDALA_PALETTES[clamp(Math.round(index), 0, MANDALA_PALETTES.length - 1)];
		return {
			stops: [[...p.stops[0]], [...p.stops[1]], [...p.stops[2]], [...p.stops[3]]],
			spark: [...p.spark],
			sheen: p.sheen
		};
	}

	function createRun(seed: number, hasAudio: boolean, shiftSerial: number): MandalaRun {
		const env = freshEnv();
		env.silence = hasAudio ? 0 : 1;
		env.quietFor = hasAudio ? 0 : 0.5;
		const palette = new MandalaFollower(choiceTarget('palette'));
		return {
			voyage: new MandalaVoyage(seed),
			spring: new FoldSpring(),
			pulse: new HeardPulse(),
			julia: [2, 3, 4, 5].map((power) => new JuliaTrack(power)),
			env,
			scene: new MandalaFollower(sceneTarget()),
			palette,
			colours: paletteFrom(palette.to),
			lastShiftSerial: shiftSerial,
			lastHits: 0,
			weightsIn: 0,
			earFast: [],
			earSlow: [],
			// Long enough ago that the first shift (the music arriving) is answered.
			sinceShift: 10,
			earPending: -1,
			earPeak: 0,
			settleChecks: 0,
			nextCheck: 0,
			contrastPeak: 0,
			base: Object.fromEntries(CONTINUOUS.map(({ axis }) => [axis.name, genome.value(axis.name)])),
			vals: Object.fromEntries(CONTINUOUS.map(({ axis }) => [axis.name, genome.value(axis.name)])),
			wander: new Wander(CONTINUOUS.length, seed + 0.291, WANDER_PERIODS),
			surge: 0,
			answers: { world: null, palette: null },
			recent: { world: [], palette: [] },
			sceneTau: 6.5,
			worldTarget: mandalaSlotParts(sceneTarget()).world,
			paletteTau: 5
		};
	}

	/** The journey's first source seeds the look; later sources only reseed its future. */
	function enterSource(sourceEpoch: number, seed: number, hasAudio: boolean, shiftSerial: number, sinceShift: number) {
		if (lookState.epoch === -1 || !lookState.run) {
			genome.reset(seed);
			genome.settle();
			// A shift that fired just before this renderer existed is still news.
			lookState.run = createRun(seed, hasAudio, sinceShift < 2 ? shiftSerial - 1 : shiftSerial);
			lookState.epoch = sourceEpoch;
			return;
		}
		if (lookState.epoch !== sourceEpoch) {
			genome.reseed(seed);
			lookState.run.voyage.continueSource();
			lookState.epoch = sourceEpoch;
		}
	}

	type Targets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		feedback: [GPUTexture, GPUTexture];
		feedbackView: [GPUTextureView, GPUTextureView];
		exposure: [GPUTexture, GPUTexture];
		exposureView: [GPUTextureView, GPUTextureView];
		bloom: [GPUTexture, GPUTexture];
		bloomView: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type BindGroups = {
		scene: GPUBindGroup;
		/** Indexed by the parity of the frame being read. */
		feedback: [GPUBindGroup, GPUBindGroup];
		/** Indexed by the parity of the frame just written. */
		exposure: [GPUBindGroup, GPUBindGroup];
		bloomDown: [GPUBindGroup, GPUBindGroup];
		blurH: GPUBindGroup;
		blurV: GPUBindGroup;
		composite: [GPUBindGroup, GPUBindGroup];
	};

	type MandalaGpu = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuffer: GPUBuffer;
		binsBuffer: GPUBuffer;
		uniforms: Float32Array;
		pipelines: {
			scene: GPURenderPipeline;
			feedback: GPURenderPipeline;
			exposure: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			blurH: GPURenderPipeline;
			blurV: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: Targets | null;
		/** Targets replaced by a resize, read once by the next frame and then destroyed. */
		retired: Targets | null;
		bindGroups: BindGroups | null;
		parity: 0 | 1;
	};

	let gpu: MandalaGpu | null = null;

	function backingSize(targetCanvas: HTMLCanvasElement) {
		const quality = QUALITY_TIERS[tier];
		const cssWidth = Math.max(1, targetCanvas.clientWidth);
		const cssHeight = Math.max(1, targetCanvas.clientHeight);
		const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
		const scale = quality.scale * governor * (forced()?.scale ?? 1);
		let width = Math.max(1, Math.floor(cssWidth * pixelRatio * scale));
		let height = Math.max(1, Math.floor(cssHeight * pixelRatio * scale));
		const pixels = width * height;
		const maxPixels = forced()?.maxPixels ?? quality.maxPixels;
		if (pixels > maxPixels) {
			const reduction = Math.sqrt(maxPixels / pixels);
			width = Math.max(1, Math.floor(width * reduction));
			height = Math.max(1, Math.floor(height * reduction));
		}
		return { width, height };
	}

	function disposeTargets(t: Targets | null) {
		if (!t) return;
		t.scene.destroy();
		for (const texture of [...t.feedback, ...t.exposure, ...t.bloom]) texture.destroy();
	}

	function ensureTargets(g: MandalaGpu, width: number, height: number) {
		if (g.targets && g.targets.width === width && g.targets.height === height) return;
		// A resize (window, or the governor) keeps the old trail and meter
		// alive for one frame so the new targets start from them: clearing
		// the trail would be a cut. Only the very first targets start fresh.
		const previous = g.targets;
		disposeTargets(g.retired);
		g.retired = previous;
		const { device, pipelines } = g;
		const hdr = (label: string, w: number, h: number) =>
			device.createTexture({
				label,
				size: { width: Math.max(1, w), height: Math.max(1, h) },
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
			});
		const halfW = Math.max(1, Math.floor(width / 2));
		const halfH = Math.max(1, Math.floor(height / 2));
		const scene = hdr('Mandala scene', width, height);
		const feedback: [GPUTexture, GPUTexture] = [
			hdr('Mandala feedback A', width, height),
			hdr('Mandala feedback B', width, height)
		];
		const exposure: [GPUTexture, GPUTexture] = [hdr('Mandala exposure A', 1, 1), hdr('Mandala exposure B', 1, 1)];
		const bloom: [GPUTexture, GPUTexture] = [
			hdr('Mandala bloom A', halfW, halfH),
			hdr('Mandala bloom B', halfW, halfH)
		];
		const t: Targets = {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackView: [feedback[0].createView(), feedback[1].createView()],
			exposure,
			exposureView: [exposure[0].createView(), exposure[1].createView()],
			bloom,
			bloomView: [bloom[0].createView(), bloom[1].createView()],
			width,
			height
		};
		g.targets = t;
		const uniform = { binding: 0, resource: { buffer: g.uniformBuffer } };
		const sampler = { binding: 1, resource: g.sampler };
		const bind = (pipeline: GPURenderPipeline, label: string, views: GPUTextureView[]) =>
			device.createBindGroup({
				label,
				layout: pipeline.getBindGroupLayout(0),
				entries: [uniform, sampler, ...views.map((view, index) => ({ binding: 2 + index, resource: view }))]
			});
		g.bindGroups = {
			scene: device.createBindGroup({
				label: 'Mandala scene',
				layout: pipelines.scene.getBindGroupLayout(0),
				entries: [uniform, { binding: 1, resource: { buffer: g.binsBuffer } }]
			}),
			feedback: [
				bind(pipelines.feedback, 'Mandala feedback reads A', [t.sceneView, t.feedbackView[0]]),
				bind(pipelines.feedback, 'Mandala feedback reads B', [t.sceneView, t.feedbackView[1]])
			],
			exposure: [
				bind(pipelines.exposure, 'Mandala exposure writes A', [t.feedbackView[0], t.exposureView[1]]),
				bind(pipelines.exposure, 'Mandala exposure writes B', [t.feedbackView[1], t.exposureView[0]])
			],
			bloomDown: [
				bind(pipelines.bloomDown, 'Mandala bloom prefilter A', [t.feedbackView[0]]),
				bind(pipelines.bloomDown, 'Mandala bloom prefilter B', [t.feedbackView[1]])
			],
			blurH: bind(pipelines.blurH, 'Mandala bloom blur H', [t.bloomView[0]]),
			blurV: bind(pipelines.blurV, 'Mandala bloom blur V', [t.bloomView[1]]),
			composite: [
				bind(pipelines.composite, 'Mandala present A', [t.feedbackView[0], t.bloomView[0], t.exposureView[0]]),
				bind(pipelines.composite, 'Mandala present B', [t.feedbackView[1], t.bloomView[0], t.exposureView[1]])
			]
		};
		if (!previous) feedbackResetFrames = 2;
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<MandalaGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Mandala needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const device = (await adapter.requestDevice()) as GPUDevice;
		let context: GPUCanvasContext | null = null;
		let uniformBuffer: GPUBuffer | null = null;
		let binsBuffer: GPUBuffer | null = null;
		try {
			context = targetCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');
			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });
			const sources: [string, string][] = [
				['Mandala worlds', MANDALA_SCENE_WGSL],
				['Mandala feedback', MANDALA_FEEDBACK_WGSL],
				['Mandala exposure', MANDALA_EXPOSURE_WGSL],
				['Mandala bloom prefilter', MANDALA_BLOOM_DOWN_WGSL],
				['Mandala bloom blur H', MANDALA_BLUR_H_WGSL],
				['Mandala bloom blur V', MANDALA_BLUR_V_WGSL],
				['Mandala presentation', MANDALA_COMPOSITE_WGSL]
			];
			const modules = sources.map(([label, code]) => device.createShaderModule({ label, code }));
			await Promise.all(
				modules.map(async (module, index) => {
					const info = await module.getCompilationInfo();
					const errors = info.messages.filter((message) => message.type === 'error');
					if (errors.length) {
						const detail = errors
							.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
							.join(' | ');
						throw new Error(`${sources[index][0]} shader failed to compile: ${detail}`);
					}
				})
			);
			const hdr: GPUTextureFormat = 'rgba16float';
			const pipeline = (label: string, module: GPUShaderModule, targetFormat: GPUTextureFormat) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
					primitive: { topology: 'triangle-list' }
				});
			const built = await Promise.all([
				pipeline('Mandala worlds pipeline', modules[0], hdr),
				pipeline('Mandala feedback pipeline', modules[1], hdr),
				pipeline('Mandala exposure pipeline', modules[2], hdr),
				pipeline('Mandala bloom prefilter pipeline', modules[3], hdr),
				pipeline('Mandala blur H pipeline', modules[4], hdr),
				pipeline('Mandala blur V pipeline', modules[5], hdr),
				pipeline('Mandala presentation pipeline', modules[6], format)
			]);
			uniformBuffer = device.createBuffer({
				size: MANDALA_UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			binsBuffer = device.createBuffer({
				size: MANDALA_BIN_COUNT * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			const state: MandalaGpu = {
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
				binsBuffer,
				uniforms: new Float32Array(MANDALA_UNIFORM_FLOATS),
				pipelines: {
					scene: built[0],
					feedback: built[1],
					exposure: built[2],
					bloomDown: built[3],
					blurH: built[4],
					blurV: built[5],
					composite: built[6]
				},
				targets: null,
				retired: null,
				bindGroups: null,
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
			binsBuffer?.destroy();
			try {
				context?.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy();
			throw error;
		}
	}

	function destroyGpuState(state: MandalaGpu | null) {
		if (!state) return;
		disposeTargets(state.targets);
		disposeTargets(state.retired);
		state.uniformBuffer.destroy();
		state.binsBuffer.destroy();
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

	const values = {} as MandalaUniformValues;

	/**
	 * The Julia dives, one per spiral variant (power 2..5): multiplier angle
	 * (turns), |lambda| range, window size. Near these angles with |lambda|
	 * ~1.25 the set is a spiral galaxy of rosettes, dense at every phase of
	 * the dive (the connected dives at 1/2 and 1/3 were tried: their windows
	 * empty to near black for part of each period). A dive never glides into
	 * another (the path between them crosses dust where the picture empties):
	 * a new dive is a new variant, which morphs on the GPU like any slot.
	 *
	 * Inside each dive the multiplier drifts, so the self-similar loop never
	 * shows the same set twice: |lambda| across 1.16..1.38 and the angle
	 * within a small window around its rest (the last two numbers, in turns),
	 * both swept by eye to keep the set's topology. The 0.31 dive turns
	 * from dust into connected filaments just above its rest, so it only
	 * drifts below it.
	 */
	const JULIA_DIVES: readonly [number, number, number, number, number, number][] = [
		[0.4, 1.16, 1.38, 0.35, -0.012, 0.012],
		[0.31, 1.16, 1.38, 0.35, -0.012, 0],
		[0.13, 1.16, 1.38, 0.35, -0.01, 0.01],
		[0.6, 1.16, 1.38, 0.35, -0.012, 0.012]
	];

	// The 3D flights are paced to their own scale: the sponge's period is a
	// whole x3 descent with three turns, the cavern's phase unit a quarter of
	// its lattice, so they take several log units of travel per period.
	// Bloom zooms e^1.1 per layer but takes its layers at 0.7 of the travel:
	// slower turnover lets each Kaliset layer be seen before the next arrives.
	const BLOOM_PACE = 0.7;
	const PERIOD_LOG = [1.1 / BLOOM_PACE, 1, Math.log(1.6180339887) * 3, 4.5, 3.2, 6.5, 0.25, 0.33];

	// Dev-only probe for the beat-timing evidence: one entry per rendered frame.
	type ProbeFrame = {
		t: number;
		kick: number;
		delta: number;
		hit: number;
		hits: number;
		spark: number;
		sparks: number;
		onset: number;
		novelty: number;
		surge: number;
		snap: number;
		phase: number;
		width: number;
		gpu: number;
		scene: string;
		look: string;
	};
	const probe: ProbeFrame[] = [];

	function slotUniforms(slot: number, run: MandalaRun, which: 'A' | 'B') {
		const { world, variant, fold } = mandalaSlotParts(slot);
		const voyage = run.voyage;
		const phase = voyage.phase[world];
		values[`world${which}` as const] = world;
		values[`variant${which}` as const] = variant;
		values[`fold${which}` as const] = MANDALA_FOLDS[fold];
		values[`phase${which}` as const] = phase;
		values[`turn${which}` as const] = voyage.turn[world];
		values[`yaw${which}` as const] = voyage.yaw;
		values[`pitch${which}` as const] = voyage.pitch;
		// The integer zoom count, so colour by depth carries across a wrap.
		values[which === 'A' ? 'levelA' : 'levelB'] = Math.floor(phase) % 8;
		const track = run.julia[variant];
		const f = phase - Math.floor(phase);
		const view = track.window(f, JULIA_DIVES[variant][3]);
		values[`jcx${which}` as const] = track.c[0];
		values[`jcy${which}` as const] = track.c[1];
		values[`jzx${which}` as const] = track.z[0];
		values[`jzy${which}` as const] = track.z[1];
		values[`jsx${which}` as const] = view.scale[0];
		values[`jsy${which}` as const] = view.scale[1];
		values[`jtx${which}` as const] = 0;
		values[`jty${which}` as const] = 0;
		values[which === 'A' ? 'jnA' : 'jnB'] = track.power;
		values[which === 'A' ? 'jwA' : 'jwB'] = view.lead;
	}

	function renderFrame(g: MandalaGpu, now: number, dt: number) {
		if (!canvas) return;
		const size = backingSize(canvas);
		if (canvas.width !== size.width || canvas.height !== size.height) {
			canvas.width = size.width;
			canvas.height = size.height;
			internalPixels = size.width * size.height;
		}
		ensureTargets(g, size.width, size.height);
		const t = g.targets;
		const bg = g.bindGroups;
		if (!t || !bg) return;

		// Sample on the feature clock, not the rAF timestamp (see Prism).
		const sampleAt = Math.max(now, performance.now());
		const feat = vis.getLatest(sampleAt);
		const journey = vis.getJourney(sampleAt);
		const directed = journey.director;
		const spectrum = journey.spectrum;
		const character = journey.character;
		const clock = directed.clock;
		const response = VISUALIZER_TUNING.mandala;

		if (journey.sourceEpoch !== rendererSourceEpoch || !lookState.run) {
			rendererSourceEpoch = journey.sourceEpoch;
			enterSource(journey.sourceEpoch, journey.seed, !!feat, character.shiftSerial, character.sinceShift);
		}
		const run = lookState.run;
		if (!run) return;
		const env = run.env;

		// ── Envelopes. The spectrum is held as timbre (which bands are alive),
		// slow enough that a kick does not flash the scales it lights.
		const incoming = feat?.bins ?? [];
		for (let i = 0; i < MANDALA_BIN_COUNT; i++) {
			const target = clamp(finite(incoming[i] ?? 0), 0, 1);
			bins[i] = approach(bins[i], target, target > bins[i] ? 1 / 0.3 : 1 / 0.7, dt);
		}
		const rmsTarget = clamp(finite(feat?.rms ?? 0), 0, 1);
		env.rms = approach(env.rms, rmsTarget, rmsTarget > env.rms ? 6 : 3, dt);
		if (!feat || rmsTarget < 0.009) env.quietFor += dt;
		else env.quietFor = 0;
		const quiet = env.quietFor > 0.45;
		env.silence = approach(env.silence, quiet ? 1 : 0, quiet ? 1.2 : 2.4, dt);
		const levels = spectrum.levels;
		env.bass = approach(env.bass, feat ? spectrum.bass : 0, 1.5, dt);
		env.mid = approach(env.mid, feat ? spectrum.mid : 0, 1.5, dt);
		env.treble = approach(env.treble, feat ? spectrum.treble : 0, 1.5, dt);
		const sectionEnergy = clamp(finite(directed.context.sectionEnergy), 0, 1);
		// Light follows the song's arc over seconds, never the beat.
		env.energy = approach(env.energy, clamp(character.energy * 0.65 + sectionEnergy * 0.35, 0, 1), 0.8, dt);

		// ── Character: Mandala hears tilt (bright vs dark spectrum) and hiss
		// (bright, sub-less, fast) itself, then answers each shift exactly once.
		if (feat && env.silence < 0.5) {
			const high = (levels.air + levels.presence) * 0.5;
			const low = (levels.sub + levels.kick) * 0.5;
			const fast = clamp((character.tempo - 0.45) / 0.4, 0, 1);
			const tiltRate = 1 / 0.45;
			env.tilt = approach(env.tilt, clamp(0.5 + (high - low) * 0.7, 0, 1), tiltRate, dt);
			env.hiss = approach(env.hiss, clamp((high - levels.sub * 0.5) * fast * fast * (3 - 2 * fast) * 1.15, 0, 1), tiltRate, dt);
		}
		const heard: MusicCharacter = { ...character, noise: env.hiss, brightness: env.tilt };
		run.sinceShift += dt;
		// The tracker's contrast resets when it fires, so remember its recent peak.
		run.contrastPeak = Math.max(run.contrastPeak * Math.exp(-dt / 1.2), finite(character.contrast));
		let shiftStrength = 0;
		let earHeard = false;
		if (character.shiftSerial !== run.lastShiftSerial) {
			run.lastShiftSerial = character.shiftSerial;
			// Every change of music deserves a new world and palette family,
			// unless Mandala's own ear already answered this change.
			shiftStrength = run.sinceShift < 3 ? 0 : Math.max(0.75, character.shiftStrength);
		}
		const ear = [character.tempo, env.tilt, env.hiss, character.punch, character.bass, character.energy];
		if (run.earFast.length !== ear.length) {
			run.earFast = [...ear];
			run.earSlow = [...ear];
		}
		if (feat && env.silence < 0.5) {
			let contrast = 0;
			for (let i = 0; i < ear.length; i++) {
				run.earFast[i] = approach(run.earFast[i], ear[i], 1 / 0.5, dt);
				// Right after a shift the new music is still settling (tempo
				// re-locks for seconds): the memory follows it, so one change
				// fires once.
				const settling = run.sinceShift < 6;
				run.earSlow[i] = approach(run.earSlow[i], settling ? run.earFast[i] : ear[i], settling ? 2 : 1 / 20, dt);
				contrast += Math.abs(run.earFast[i] - run.earSlow[i]);
			}
			contrast /= ear.length;
			// The shared tracker misses changes that live in tilt and hiss. The
			// ear answers at the peak of the change (or within 0.5 s), so its
			// picks fit the new music rather than the moment between.
			if (run.earPending < 0 && run.sinceShift > 8 && contrast > 0.085) {
				run.earPending = 0;
				run.earPeak = contrast;
			} else if (run.earPending >= 0) {
				run.earPending += dt;
				const falling = contrast < run.earPeak * 0.97;
				run.earPeak = Math.max(run.earPeak, contrast);
				if (!shiftStrength && (falling || run.earPending > 0.35)) {
					shiftStrength = clamp(0.75 + (run.earPeak - 0.1) * 3, 0, 1);
					earHeard = true;
				}
			}
		}
		// While the new music settles (the character lags it by a second or
		// more, longer for tempo), a world or palette that does not fit it is
		// replaced: checked every half second for six seconds, at most twice.
		let settling = false;
		if (!shiftStrength && run.settleChecks > 0 && run.sinceShift > 1.2 && run.sinceShift < 6 && run.sinceShift >= run.nextCheck) {
			run.nextCheck = run.sinceShift + 0.5;
			for (const axis of ['world', 'palette'] as const) {
				const current = answered(axis);
				const fit = axis === 'world' ? mandalaWorldFit(current, heard) : mandalaPaletteFit(current, heard);
				if (fit < 0.3) {
					settling = true;
					run.answers[axis] = { option: answerFor(run, axis, current, heard, true), boundary: boundaryCount(axis) };
				}
			}
			if (settling) run.settleChecks -= 1;
		}
		if (settling) hudShifts += 1;
		if (shiftStrength > 0) {
			hudShifts += 1;
			// A new change of music earns two corrections while it settles.
			run.settleChecks = 2;
			run.nextCheck = 1.2;
			// Did the music really change (not just a new song of the same
			// kind)? Then the world and palette must move, to the best fit.
			// A shift that is not a new song's arrival (strength 1) always is.
			const changed = earHeard || run.contrastPeak > 0.08 || character.shiftStrength < 0.99;
			run.sinceShift = 0;
			run.earPending = -1;
			run.earSlow = [...run.earFast];
			const keptWorld = answered('world');
			const keptPalette = answered('palette');
			mandalaApplyCharacter(genome, heard, 8, run.recent);
			genome.shift(shiftStrength, character.energy);
			// The genome moved every axis; world and palette answer for themselves.
			run.answers.world = { option: answerFor(run, 'world', keptWorld, heard, changed), boundary: boundaryCount('world') };
			run.answers.palette = { option: answerFor(run, 'palette', keptPalette, heard, changed), boundary: boundaryCount('palette') };
			mandalaPullCharacter(genome, heard, 0.75 * shiftStrength);
			// New music: the camera heads somewhere new now.
			run.voyage.redirect();
			run.weightsIn = 0.5;
		}
		run.weightsIn -= dt;
		if (run.weightsIn <= 0) {
			run.weightsIn = 0.5;
			mandalaApplyCharacter(genome, heard, 6, run.recent);
		}
		if (feat) mandalaPullCharacter(genome, heard, Math.min(1, dt * 0.12));
		const glide = 1.4 * genome.glideSpeed;
		env.tempo = approach(env.tempo, character.tempo, glide, dt);
		env.harsh = approach(env.harsh, env.hiss, glide, dt);
		env.punch = approach(env.punch, character.punch, glide, dt);
		env.bright = approach(env.bright, env.tilt, glide, dt);
		env.valence = approach(env.valence, character.valence, glide, dt);
		env.weight = approach(env.weight, character.bass, glide, dt);
		env.drive = approach(env.drive, character.energy, glide, dt);

		// ── Variety: boundaries mutate, glides carry it. Silence holds the look.
		const phraseIndex = Math.max(0, Math.floor(finite(clock.phraseIndex)));
		if (feat) genome.advance({ phraseIndex, sectionKey: directed.section, energy: env.energy, dt });
		glideValues(run, dt);
		const speedUp = genome.glideSpeed;
		// Boundary changes are patient; a shift makes them land in a second or two.
		const leap = Math.pow(speedUp, 1.6);
		// A morph's length is fixed when it starts: right after a shift it is
		// short, and it stays short even as the speed-up eases back, so the
		// answer lands and then holds.
		const nextScene = sceneTarget();
		if (nextScene !== run.scene.to || run.scene.mix >= 1) {
			const worldMove = mandalaSlotParts(nextScene).world !== mandalaSlotParts(run.scene.to).world;
			// Never quicker than two seconds for a new world: faster reads as a cut.
			run.sceneTau = Math.max(worldMove ? 2.0 : 1.2, (worldMove ? 6.5 : 4.5) / leap);
		}
		// A new world brings its own light: another palette that fits the
		// music nearly as well, so a change of world never wears the last
		// world's colour. Right after a change of music the answer already
		// chose the palette.
		const nextWorld = mandalaSlotParts(nextScene).world;
		if (nextWorld !== run.worldTarget) {
			run.worldTarget = nextWorld;
			if (forced()?.palette === undefined && run.sinceShift > 1.5) {
				const current = answered('palette');
				const alt = mandalaAnswer('palette', current, heard, answerRoll(run), true, undefined, run.recent.palette);
				if (alt !== current && mandalaPaletteFit(alt, heard) >= 0.45) {
					run.answers.palette = { option: alt, boundary: boundaryCount('palette') };
				}
			}
		}
		run.scene.update(nextScene, run.sceneTau, dt);
		if (run.scene.mix >= 1) noteShown(run, 'world', mandalaSlotParts(run.scene.to).world);
		const paletteTarget = answered('palette');
		if (paletteTarget !== run.palette.to || run.palette.mix >= 1) run.paletteTau = Math.max(0.8, 5 / leap);
		run.palette.update(paletteTarget, run.paletteTau, dt);
		if (run.palette.mix >= 1) noteShown(run, 'palette', run.palette.to);

		// Palette: the family crossfades, warmth leans it, the result glides
		// (fast right after a shift).
		const pa = paletteFrom(run.palette.from);
		const pb = paletteFrom(run.palette.to);
		const pw = run.palette.weight;
		const lean = clamp(val('warmth') * 0.5 + env.valence * 0.5, 0, 1);
		const colourRate = 1.2 * leap;
		const warmTint: Rgb = [1 + (lean - 0.5) * 0.14, 1, 1 - (lean - 0.5) * 0.18];
		const colours = run.colours;
		// The family's stops turn slowly round the wheel: a palette is a
		// continuum the look drifts through, never the same colouring twice.
		const tint = run.voyage.tint;
		for (let i = 0; i < 4; i++) {
			const c = turnHue(mixRgb(pa.stops[i], pb.stops[i], pw), tint);
			approachRgb(colours.stops[i], [c[0] * warmTint[0], c[1] * warmTint[1], c[2] * warmTint[2]], colourRate, dt);
		}
		approachRgb(colours.spark, turnHue(mixRgb(pa.spark, pb.spark, pw), tint), colourRate, dt);
		colours.sheen = approach(colours.sheen, pa.sheen + (pb.sheen - pa.sheen) * pw, colourRate, dt);

		// ── Beats, heard: the kick band's own transient, never the predicted
		// clock. A kick surges the travel, rings the fold spring and lights a
		// sparse scatter; it never lifts the frame.
		const loudness = clamp(env.rms * 4, 0, 1) * (1 - env.silence);
		run.pulse.update({
			dt,
			kickDelta: feat ? finite(spectrum.deltas.kick) : 0,
			subDelta: feat ? finite(spectrum.deltas.sub) : 0,
			kickLevel: feat ? finite(levels.kick) : 0,
			subLevel: feat ? finite(levels.sub) : 0,
			onset: !!feat?.onset,
			novelty: feat ? finite(spectrum.novelty) : 0,
			loudness,
			tempo: env.tempo
		});
		const punchiness = clamp(0.35 + env.punch * 0.5 + env.weight * 0.35, 0, 1.2);
		if (run.pulse.hits !== run.lastHits) {
			run.lastHits = run.pulse.hits;
			const strength = run.pulse.lastStrength * response.impact;
			// The spring rings to about +-0.5 on a strong kick; each world turns
			// that into a flex of its folds (see the shaders' motion.x).
			if (!forced()?.nosnap) run.spring.kick(strength * punchiness);
			if (!forced()?.nosurge) run.surge = Math.max(run.surge, strength * punchiness);
			// The roaming camera leans in on a heard kick.
			run.voyage.kick(strength * punchiness * 0.6);
		}
		run.surge *= Math.exp(-dt / 0.16);
		run.spring.update(dt, 2.6 + env.tempo * 1.6, 0.45);

		// ── Travel: tempo sets the pace continuously; the clock never flashes.
		const speed = (0.06 + Math.pow(env.tempo, 1.4) * 0.5 + env.drive * 0.12) * response.motion * (forced()?.speed ?? 1);
		const morph = run.scene.mix < 1 ? Math.sin(Math.PI * run.scene.mix) * 0.25 : 0;
		const sceneTo = mandalaSlotParts(run.scene.to);
		const spiralTrack = run.julia[sceneTo.world === WORLD_INDEX.spiral ? sceneTo.variant : 0];
		const rates = PERIOD_LOG.map((period, world) =>
			// The spiral turns arg(lambda) per period: cap the turn rate, not just the zoom.
			world === WORLD_INDEX.spiral ? 1 / Math.max(0.15, spiralTrack.periodLog, spiralTrack.periodTurn / 0.8) : 1 / period
		);
		run.voyage.update({
			dt,
			speed: speed + morph,
			rates,
			spin: val('spin') * (0.05 + env.tempo * 0.12),
			surge: run.surge * (0.35 + env.tempo * 0.4),
			restless: clamp(env.tempo * 0.7 + finite(directed.motion) * 0.3 + env.harsh * 0.2, 0, 1),
			drift: clamp(val('drift'), 0, 1) * (0.5 + env.harsh * 0.3),
			tempo: env.tempo,
			silence: env.silence
		});

		// Julia dives are chosen by their spiral: the multiplier rests near a
		// rational angle p/q (a q-armed rosette). Gliding through the angles
		// would cross bifurcations every second and read as flicker, so the
		// angle only drifts inside the dive's own safe window, on slow noise;
		// |lambda| (how far the rosettes have broken into dust) drifts with
		// formC and a noise lane.
		const voyage = run.voyage;
		const juliaGrowth = clamp(val('formC') * 0.7 + env.harsh * 0.15 + voyage.morph[1] * 0.3 + 0.1, 0, 1);
		const juliaLean = clamp(voyage.morph[2] * 0.8 + (val('formB') - 0.5) * 0.6, -1, 1) * 0.5 + 0.5;
		run.julia.forEach((track, variant) => {
			const [turns, low, high, , lowTurn, highTurn] = JULIA_DIVES[variant];
			const radius = (forced()?.jr ?? low + (high - low) * juliaGrowth) + run.spring.value * 0.003;
			const lean = forced()?.jt ?? lowTurn + (highTurn - lowTurn) * juliaLean;
			track.steer((turns + lean) * Math.PI * 2, radius, dt, 0.35 * Math.sqrt(leap));
		});

		const forcedPhase = forced()?.phase;
		if (forcedPhase !== undefined) run.voyage.phase[mandalaSlotParts(run.scene.to).world] = forcedPhase;
		const sceneFrom = run.scene.from;
		const sceneB = run.scene.to;
		const mixing = run.scene.mix < 1;
		slotUniforms(mixing ? sceneFrom : sceneB, run, 'A');
		slotUniforms(sceneB, run, 'B');
		values.mix = mixing ? run.scene.weight : 0;
		values.revealSeed = (run.scene.to * 0.618) % 1;

		const quality = QUALITY_TIERS[tier];
		values.width = size.width;
		values.height = size.height;
		values.frame = frameIndex % 64;
		values.time = (now / 1000) % 1000;
		values.steps = quality.steps;
		values.detail = quality.detail * (1 + env.harsh * 0.15);
		values.focal = 1.25 * voyage.focal;
		values.panX = voyage.panX;
		values.panY = voyage.panY;
		values.zoomLog = voyage.zoom;
		values.roll = voyage.roll;
		values.dolly = voyage.dolly;
		values.orbit = voyage.orbit;
		values.paint = voyage.paint;
		values.eye = voyage.eye;
		values.lampX = voyage.lampX;
		values.lampY = voyage.lampY;
		values.lampReach = voyage.lampReach;
		values.extent = voyage.extent;
		[values.morphA, values.morphB, values.morphC, values.morphD] = voyage.morph;
		values.occlusion = quality.occlusion;
		values.formA = clamp(val('formA'), 0, 1);
		values.formB = clamp(val('formB'), 0, 1);
		values.formC = clamp(val('formC'), 0, 1);
		values.formD = clamp(val('formD'), 0, 1);
		values.energy = env.energy;
		values.bass = env.bass;
		values.mid = env.mid;
		values.treble = env.treble;
		values.hit = forced()?.nospark ? 0 : run.pulse.hit * response.impact * (1 - env.silence);
		values.hitSeed = run.pulse.hitSeed;
		values.spark = run.pulse.spark * (1 - env.silence);
		values.sparkSeed = run.pulse.sparkSeed;
		values.snap = run.spring.value;
		values.surge = run.surge;
		values.silence = env.silence;
		values.drive = env.drive;
		values.harsh = env.harsh;
		values.warmth = lean;
		values.punch = env.punch;
		values.tempo = env.tempo;
		values.glow = clamp(val('glow'), 0, 1);
		values.sheen = clamp(colours.sheen * (0.5 + val('sheen') * 0.7), 0, 1);
		values.hue = val('hue');
		// Light follows the song's arc and the silence, never the beat.
		values.gain = (0.75 + env.energy * 0.55) * (1 - env.silence * 0.55);
		[values.pal0r, values.pal0g, values.pal0b] = colours.stops[0];
		[values.pal1r, values.pal1g, values.pal1b] = colours.stops[1];
		[values.pal2r, values.pal2g, values.pal2b] = colours.stops[2];
		[values.pal3r, values.pal3g, values.pal3b] = colours.stops[3];
		[values.sparkR, values.sparkG, values.sparkB] = colours.spark;
		values.sparkGain = 1;
		// Ambient air is clear and vast; dense music closes the distance in.
		values.fogDensity = 0.35 + env.drive * 0.25 + env.harsh * 0.25;
		values.saturation = 1.15 + env.punch * 0.1 - env.harsh * 0.05;

		// Feedback: the trail streams outward with the zoom and turns with the roll.
		const trail = clamp(val('trail'), 0, 1);
		const raymarched = (slot: number) => MANDALA_RAYMARCHED.has(MANDALA_WORLDS[mandalaSlotParts(slot).world]);
		const zoomShare = (slot: number) => {
			const world = mandalaSlotParts(slot).world;
			// Planes zoom; flights turn as they travel, so their trail barely zooms.
			if (world === WORLD_INDEX.crystal || world === WORLD_INDEX.bulb) return 0.15;
			// Bloom dives at BLOOM_PACE of the travel (see PERIOD_LOG): its trail follows suit.
			if (world === WORLD_INDEX.bloom) return BLOOM_PACE;
			return MANDALA_RAYMARCHED.has(MANDALA_WORLDS[world]) ? 0.3 : 1;
		};
		const zoomWeight = mixing
			? zoomShare(sceneFrom) * (1 - run.scene.weight) + zoomShare(sceneB) * run.scene.weight
			: zoomShare(sceneB);
		const marchWeight = mixing
			? (raymarched(sceneFrom) ? 1 - run.scene.weight : 0) + (raymarched(sceneB) ? run.scene.weight : 0)
			: raymarched(sceneB)
				? 1
				: 0;
		// The spiral turns by arg(lambda) as it dives, which the trail cannot
		// follow exactly: it keeps a shorter one.
		const isSpiral = (slot: number) => (mandalaSlotParts(slot).world === WORLD_INDEX.spiral ? 1 : 0);
		const spiralWeight = mixing
			? isSpiral(sceneFrom) * (1 - run.scene.weight) + isSpiral(sceneB) * run.scene.weight
			: isSpiral(sceneB);
		values.feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp(
						(0.55 + trail * 0.33 - env.harsh * 0.12 - marchWeight * 0.3 - spiralWeight * 0.2) * (1 - env.silence * 0.3),
						0.3,
						0.9
					);
		values.feedbackZoom = Math.exp(-run.voyage.stepLog * zoomWeight);
		values.feedbackRoll = -run.voyage.stepTurn * (1 - marchWeight);
		values.bloomThreshold = 0.9 - env.energy * 0.2;
		values.aberration = 0.8 + env.harsh * 1.4 + run.surge * 0.5;
		// The planes zoom about their own centre, wherever the camera has
		// drifted it; the flights stream from the middle of the frame.
		const planeWeight = 1 - marchWeight;
		values.vanishX = 0.5 + (voyage.panX * planeWeight * size.height) / Math.max(1, size.width);
		values.vanishY = 0.5 - voyage.panY * planeWeight;
		values.exposure = 1;
		values.bloomWeight = 0.45 + val('glow') * 0.35;
		values.contrast = 1.04 + env.punch * 0.08;
		values.vignette = 1;
		values.grain = forced()?.debug ? -1 : 1.4;
		values.exposureCeil = 2.6;
		values.meterRate = feedbackResetFrames > 0 ? 1 : 0.06;
		values.debug = forced()?.debug ?? 0;
		// A wall the camera passes close to fills the frame: the meter brings it
		// down rather than letting the whole picture swell.
		values.meanCeil = 0.22;
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		packMandalaUniforms(g.uniforms, values);
		frameIndex += 1;

		g.device.queue.writeBuffer(g.uniformBuffer, 0, g.uniforms.buffer, g.uniforms.byteOffset, g.uniforms.byteLength);
		g.device.queue.writeBuffer(g.binsBuffer, 0, bins.buffer, bins.byteOffset, bins.byteLength);

		const shown = mandalaSlotParts(sceneB);
		const worldName = MANDALA_WORLDS[shown.world];
		hudWorld = worldName;
		hudVariant = MANDALA_VARIANT_NAMES[worldName][shown.variant] ?? '';
		hudFold = MANDALA_FOLDS[shown.fold];
		hudPalette = MANDALA_PALETTES[run.palette.to]?.name ?? '';
		hudHits = run.pulse.hits;
		if (import.meta.env.DEV) hudHeard = `t${heard.tempo.toFixed(2)} n${heard.noise.toFixed(2)} b${heard.brightness.toFixed(2)} p${heard.punch.toFixed(2)} e${heard.energy.toFixed(2)} bass${heard.bass.toFixed(2)} v${heard.valence.toFixed(2)} c${heard.contrast.toFixed(2)}`;

		if (import.meta.env.DEV && forced()?.probe) {
			probe.push({
				t: performance.now(),
				kick: feat ? levels.kick : 0,
				delta: feat ? spectrum.deltas.kick : 0,
				hit: run.pulse.hit,
				hits: run.pulse.hits,
				spark: run.pulse.spark,
				sparks: run.pulse.sparks,
				onset: feat?.onset ? 1 : 0,
				novelty: feat ? spectrum.novelty : 0,
				surge: run.surge,
				snap: run.spring.value,
				phase: run.voyage.phase[mandalaSlotParts(run.scene.to).world],
				width: size.width,
				gpu: gpuFrameMs,
				scene: `${run.scene.from}>${run.scene.to}@${run.scene.mix.toFixed(2)}`,
				look: genome.signature()
			});
			if (probe.length > 4000) probe.splice(0, probe.length - 4000);
			(globalThis as { __MANDALA_PROBE__?: ProbeFrame[] }).__MANDALA_PROBE__ = probe;
		}

		// ── Render graph: scene -> feedback -> exposure -> prefilter -> 2x(H, V) blur -> present
		const encoder = g.device.createCommandEncoder({ label: 'Mandala frame' });
		const fullscreen = (label: string, view: GPUTextureView, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup) => {
			const pass = encoder.beginRenderPass({
				label,
				colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
		};
		const previous = g.parity;
		const next: 0 | 1 = previous === 0 ? 1 : 0;
		fullscreen('Mandala worlds', t.sceneView, g.pipelines.scene, bg.scene);
		// Right after a resize the trail and the meter are read from the
		// retired targets (the feedback pass resamples by uv), so nothing resets.
		const retired = g.retired;
		let feedbackGroup = bg.feedback[previous];
		let exposureGroup = bg.exposure[next];
		if (retired) {
			const carry = (pipeline: GPURenderPipeline, frame: GPUTextureView, prior: GPUTextureView) =>
				g.device.createBindGroup({
					label: 'Mandala resize carry',
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: g.uniformBuffer } },
						{ binding: 1, resource: g.sampler },
						{ binding: 2, resource: frame },
						{ binding: 3, resource: prior }
					]
				});
			feedbackGroup = carry(g.pipelines.feedback, t.sceneView, retired.feedbackView[previous]);
			exposureGroup = carry(g.pipelines.exposure, t.feedbackView[next], retired.exposureView[previous]);
		}
		fullscreen('Mandala feedback', t.feedbackView[next], g.pipelines.feedback, feedbackGroup);
		fullscreen('Mandala exposure', t.exposureView[next], g.pipelines.exposure, exposureGroup);
		fullscreen('Mandala bloom prefilter', t.bloomView[0], g.pipelines.bloomDown, bg.bloomDown[next]);
		for (let round = 0; round < 2; round++) {
			fullscreen('Mandala bloom blur H', t.bloomView[1], g.pipelines.blurH, bg.blurH);
			fullscreen('Mandala bloom blur V', t.bloomView[0], g.pipelines.blurV, bg.blurV);
		}
		fullscreen('Mandala present', g.context.getCurrentTexture().createView(), g.pipelines.composite, bg.composite[next]);
		const submittedAt = performance.now();
		g.device.queue.submit([encoder.finish()]);
		g.parity = next;
		if (retired) {
			disposeTargets(retired);
			g.retired = null;
		}
		void g.device.queue.onSubmittedWorkDone().then(() => {
			const ms = performance.now() - submittedAt;
			gpuFrameMs += (ms - gpuFrameMs) * 0.1;
			if (import.meta.env.DEV && forced()?.perf) {
				const store = globalThis as { __MANDALA_GPU_MS__?: number[] };
				(store.__MANDALA_GPU_MS__ ??= []).push(ms);
			}
		});
	}

	/**
	 * Resolution governor, driven by how long the GPU takes to finish a frame
	 * (submit to done), not by rAF intervals, which also stretch for reasons
	 * that have nothing to do with the GPU. Sustained overload steps the
	 * internal resolution down; long headroom steps it back up. A step is a
	 * resize, which carries the trail and meter over (see ensureTargets).
	 */
	function governFrame(dt: number) {
		const budget = refreshIntervalMs * activeFrameStride;
		if (gpuFrameMs > budget * 0.9) {
			slowFor += dt;
			fastFor = 0;
		} else if (gpuFrameMs < budget * 0.45) {
			fastFor += dt;
			slowFor = Math.max(0, slowFor - dt * 0.5);
		} else {
			slowFor = Math.max(0, slowFor - dt * 0.5);
		}
		if (slowFor > 3 && governor > 0.5) {
			governor = Math.max(0.5, governor * 0.88);
			slowFor = 0;
		} else if (fastFor > 20 && governor < 1) {
			governor = Math.min(1, governor * 1.06);
			fastFor = 0;
		}
		hudScale = governor.toFixed(2);
	}

	function displayFrameStride(refreshMs: number) {
		const safeRefresh = clamp(refreshMs, 1000 / 360, 1000 / 24);
		return Math.max(1, Math.min(8, Math.round(1000 / safeRefresh / TARGET_FRAME_RATE)));
	}

	function observeDisplayCadence(tickElapsedMs: number) {
		if (tickElapsedMs < 1000 / 360 || tickElapsedMs > 1000 / 24) return;
		if (tickElapsedMs < refreshIntervalMs * 0.8) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.38;
		} else if (tickElapsedMs <= refreshIntervalMs * 1.35) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.08;
		}
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		if (!schedulerTickAt) schedulerTickAt = now;
		else {
			observeDisplayCadence(Math.max(0, now - schedulerTickAt));
			schedulerTickAt = now;
		}
		const stride = displayFrameStride(refreshIntervalMs);
		if (stride !== activeFrameStride) {
			activeFrameStride = stride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender--;
			return;
		}
		framesUntilRender = activeFrameStride - 1;
		const elapsedMs = lastRenderedAt ? now - lastRenderedAt : refreshIntervalMs * activeFrameStride;
		lastRenderedAt = now;
		if (frameIndex > 30 && document.visibilityState === 'visible') governFrame(elapsedMs / 1000);
		try {
			renderFrame(gpu, now, clamp(elapsedMs / 1000, 0.001, 0.25));
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : String(error);
			teardownGpu();
		}
	}

	// The engine component is mounted by the host; each fresh canvas gets fresh
	// GPU state, and a stale initialization is destroyed rather than adopted.
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
		tier = pickTier();
		hudTier = tier;
		initGpu(targetCanvas)
			.then((state) => {
				if (version !== initVersion || canvas !== targetCanvas) {
					destroyGpuState(state);
					return;
				}
				gpu = state;
				schedulerTickAt = 0;
				refreshIntervalMs = 1000 / 60;
				activeFrameStride = 1;
				framesUntilRender = 0;
				lastRenderedAt = 0;
				feedbackResetFrames = 2;
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

	onMount(() => {
		running = true;
		void vis.subscribe().then((stop) => {
			if (!running) {
				stop();
				return;
			}
			unsubscribe = stop;
			raf = requestAnimationFrame(loop);
		});
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
			aria-label="Mandala audio visualizer"
			data-mandala-world={hudWorld}
			data-mandala-variant={hudVariant}
			data-mandala-fold={hudFold}
			data-mandala-palette={hudPalette}
			data-mandala-shifts={hudShifts}
			data-mandala-hits={hudHits}
			data-mandala-heard={hudHeard}
			data-mandala-quality={hudTier}
			data-mandala-governor={hudScale}
			data-mandala-render-passes={RENDER_PASSES}
			data-mandala-uniform-bytes={MANDALA_UNIFORM_BYTES}
			data-mandala-frame-stride={activeFrameStride}
			data-mandala-internal-pixels={internalPixels}
			data-mandala-ready={String(ready)}
		></canvas>

		{#if !ready && !errorMsg}
			<div
				class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.2em] text-amber-100/40"
			>
				folding the mandala
			</div>
		{/if}

		{#if errorMsg}
			<div
				class="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#05030a] px-6"
				role="alert"
			>
				<div class="max-w-md text-center">
					<p class="font-mono text-xs uppercase tracking-[0.18em] text-amber-200/80">Mandala unavailable</p>
					<p class="mt-3 text-sm leading-6 text-white/55">{errorMsg}</p>
				</div>
			</div>
		{/if}
	</div>
{/if}
