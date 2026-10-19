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
		MANDALA_DIVERGENCE,
		MANDALA_FAMILIES,
		MANDALA_FOLDS,
		MANDALA_PALETTES,
		MANDALA_RAW_SECTORS,
		MANDALA_SHAPES,
		MANDALA_SHAPE_NAMES,
		MANDALA_VARIANT_NAMES,
		MANDALA_VARIANTS,
		MandalaFollower,
		mandalaApplyCharacter,
		mandalaPaletteFit,
		mandalaPullCharacter,
		mixRgb,
		phyllotaxisBasis,
		type Rgb
	} from '$lib/visualizer/mandala/look';
	import { MandalaFlight, hyperbolicPeriod } from '$lib/visualizer/mandala/flight';
	import { VariationGenome, type ContinuousAxis } from '$lib/visualizer/variation';
	import type { MusicCharacter } from '$lib/visualizer/character';

	const vis = useVisualizer();

	const TARGET_FRAME_RATE = 60;
	const INTERNAL_SCALE = 0.78;
	const MAX_INTERNAL_PIXELS = 1600 * 900;
	const RENDER_PASSES = 9;
	const FOLD_COUNT = MANDALA_FOLDS.length;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let internalPixels = $state(0);
	let hudSection = $state('intro');
	let hudWall = $state('');
	let hudScreen = $state('');
	let hudFold = $state(8);
	let hudShape = $state('round');
	let hudPalette = $state('');
	let hudShifts = $state(0);
	let earContrast = 0;
	let hudEar = $state('0');
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

	type Palette = {
		stone: Rgb;
		metal: Rgb;
		glow: Rgb;
		accent: Rgb;
		rig: Rgb;
		sconce: Rgb;
		fog: Rgb;
		iridescence: number;
		stoneGloss: number;
	};

	function freshEnv() {
		return {
			rms: 0,
			energy: 0,
			bass: 0,
			treble: 0,
			impact: 0,
			kick: 0,
			beatGlow: 0,
			silence: 1,
			quietFor: 0.5,
			sub: 0,
			kickBand: 0,
			body: 0,
			presence: 0,
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
	 * the flight and a remount resumes it exactly.
	 */
	type MandalaRun = {
		flight: MandalaFlight;
		env: ReturnType<typeof freshEnv>;
		/** Grammar x fold slots, cross-faded on the GPU. */
		wall: MandalaFollower;
		screen: MandalaFollower;
		shape: MandalaFollower;
		palette: MandalaFollower;
		colours: Palette;
		lastShiftSerial: number;
		lastBeatCount: number;
		resyncBeat: boolean;
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
		/** The answer to a shift is re-checked once the new music has settled. */
		settleChecked: boolean;
		/** Eased continuous look values (see glideValues). */
		vals: Record<string, number>;
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
	// window.__MANDALA_FORCE__ = { wall: 26, screen: 4, fold: 5, shape: 0, palette: 1, density: 1.4 }.
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

	/**
	 * Mandala glides the genome's continuous targets itself: patiently after a
	 * boundary (the axis's own tau), but within about two seconds of a shift,
	 * so the answer to new music lands and then holds instead of creeping on.
	 */
	function glideValues(run: MandalaRun, dt: number) {
		const targets = genome.targetVector();
		const hurry = run.sinceShift < 3.5 ? 5 : 1;
		for (const { axis, index } of CONTINUOUS) {
			const target = axis.min + (targets[index] ?? 0.5) * (axis.max - axis.min);
			const current = run.vals[axis.name] ?? target;
			const k = 1 - Math.exp((-dt * hurry) / Math.max(0.3, axis.tau));
			if (axis.wrap) {
				const range = axis.max - axis.min;
				let delta = (target - current) % range;
				if (delta > range / 2) delta -= range;
				if (delta < -range / 2) delta += range;
				run.vals[axis.name] = axis.min + ((((current + delta * k - axis.min) % range) + range) % range);
			} else {
				run.vals[axis.name] = current + (target - current) * k;
			}
		}
	}

	function slotId(grammarAxis: string): number {
		return choiceTarget(grammarAxis) * FOLD_COUNT + choiceTarget('fold');
	}

	function paletteFrom(index: number): Palette {
		const p = MANDALA_PALETTES[clamp(Math.round(index), 0, MANDALA_PALETTES.length - 1)];
		return {
			stone: [...p.stone],
			metal: [...p.metal],
			glow: [...p.glow],
			accent: [...p.accent],
			rig: [...p.rig],
			sconce: [...p.sconce],
			fog: [...p.fog],
			iridescence: p.iridescence,
			stoneGloss: 0.25
		};
	}

	function createRun(seed: number, hasAudio: boolean, shiftSerial: number): MandalaRun {
		const env = freshEnv();
		env.silence = hasAudio ? 0 : 1;
		env.quietFor = hasAudio ? 0 : 0.5;
		const palette = new MandalaFollower(choiceTarget('palette'));
		return {
			flight: new MandalaFlight(seed),
			env,
			wall: new MandalaFollower(slotId('wall')),
			screen: new MandalaFollower(slotId('screen')),
			shape: new MandalaFollower(choiceTarget('shape')),
			palette,
			colours: paletteFrom(palette.to),
			lastShiftSerial: shiftSerial,
			lastBeatCount: -1,
			resyncBeat: true,
			weightsIn: 0,
			earFast: [],
			earSlow: [],
			sinceShift: 0,
			earPending: -1,
			earPeak: 0,
			settleChecked: true,
			vals: Object.fromEntries(CONTINUOUS.map(({ axis }) => [axis.name, genome.value(axis.name)]))
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
			lookState.run.flight.continueSource(seed);
			lookState.run.resyncBeat = true;
			lookState.epoch = sourceEpoch;
		}
	}

	function grammarName(slot: number) {
		const grammar = Math.floor(slot / FOLD_COUNT);
		const family = MANDALA_FAMILIES[Math.floor(grammar / MANDALA_VARIANTS)] ?? 'truchet';
		return `${family}:${MANDALA_VARIANT_NAMES[family][grammar % MANDALA_VARIANTS]}`;
	}

	function slotGrammar(slot: number) {
		return Math.floor(slot / FOLD_COUNT);
	}

	function slotFold(slot: number) {
		return MANDALA_FOLDS[slot % FOLD_COUNT];
	}

	function hyperPeriods(follower: MandalaFollower): number[] {
		const out: number[] = [];
		const visible = follower.mix >= 1 ? [follower.to] : [follower.from, follower.to];
		for (const slot of visible) {
			const grammar = slotGrammar(slot);
			if (Math.floor(grammar / MANDALA_VARIANTS) === 6) out.push(hyperbolicPeriod(grammar % MANDALA_VARIANTS));
		}
		return out;
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
		bindGroups: BindGroups | null;
		parity: 0 | 1;
	};

	let gpu: MandalaGpu | null = null;

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

	function disposeTargets(t: Targets | null) {
		if (!t) return;
		t.scene.destroy();
		for (const texture of [...t.feedback, ...t.exposure, ...t.bloom]) texture.destroy();
	}

	function ensureTargets(g: MandalaGpu, width: number, height: number) {
		if (g.targets && g.targets.width === width && g.targets.height === height) return;
		disposeTargets(g.targets);
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
		feedbackResetFrames = 2;
	}

	async function initGpu(targetCanvas: HTMLCanvasElement): Promise<MandalaGpu> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Mandala needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
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
				['Mandala tunnel', MANDALA_SCENE_WGSL],
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
				pipeline('Mandala tunnel pipeline', modules[0], hdr),
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
		const flight = run.flight;

		// ── Envelopes: beats and bands answer at once.
		const incoming = feat?.bins ?? [];
		const binMix = 1 - Math.exp(-dt / 0.07);
		for (let i = 0; i < MANDALA_BIN_COUNT; i++) {
			const target = clamp(finite(incoming[i] ?? 0), 0, 1);
			bins[i] += (target - bins[i]) * (target > bins[i] ? Math.min(1, binMix * 2.5) : binMix);
		}
		const rmsTarget = clamp(finite(feat?.rms ?? 0), 0, 1);
		env.rms = approach(env.rms, rmsTarget, rmsTarget > env.rms ? 14 : 5, dt);
		if (!feat || rmsTarget < 0.009) env.quietFor += dt;
		else env.quietFor = 0;
		const quiet = env.quietFor > 0.45;
		env.silence = approach(env.silence, quiet ? 1 : 0, quiet ? 1.2 : 2.4, dt);
		const levels = spectrum.levels;
		const bandRate = 1 / 0.06;
		env.sub = approach(env.sub, feat ? levels.sub : 0, bandRate, dt);
		env.kickBand = approach(env.kickBand, feat ? levels.kick : 0, bandRate, dt);
		env.body = approach(env.body, feat ? levels.body : 0, bandRate, dt);
		env.presence = approach(env.presence, feat ? levels.presence : 0, bandRate, dt);
		env.bass = approach(env.bass, feat ? spectrum.bass : 0, 9, dt);
		env.treble = approach(env.treble, feat ? spectrum.treble : 0, 12, dt);
		const sectionEnergy = clamp(finite(directed.context.sectionEnergy), 0, 1);
		env.energy = approach(
			env.energy,
			clamp(directed.energy * 0.6 + sectionEnergy * 0.25 + env.rms * 0.15, 0, 1),
			3,
			dt
		);

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
		let shiftStrength = 0;
		if (character.shiftSerial !== run.lastShiftSerial) {
			run.lastShiftSerial = character.shiftSerial;
			// Every change of music deserves a new palette family (an era move),
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
			earContrast = contrast;
			// The shared tracker misses changes that live in tilt and hiss. The
			// ear answers at the peak of the change (or within 0.5 s), so its
			// picks fit the new music rather than the moment between.
			if (run.earPending < 0 && run.sinceShift > 8 && contrast > 0.1) {
				run.earPending = 0;
				run.earPeak = contrast;
			} else if (run.earPending >= 0) {
				run.earPending += dt;
				const falling = contrast < run.earPeak * 0.97;
				run.earPeak = Math.max(run.earPeak, contrast);
				if (!shiftStrength && (falling || run.earPending > 0.5)) {
					shiftStrength = clamp(0.75 + (run.earPeak - 0.1) * 3, 0, 1);
				}
			}
		}
		// Once the new music has settled, a palette that no longer fits it moves on.
		if (!shiftStrength && !run.settleChecked && run.sinceShift > 2.2) {
			run.settleChecked = true;
			if (mandalaPaletteFit(choiceTarget('palette'), heard) < 0.3) shiftStrength = 0.8;
		}
		if (shiftStrength > 0) {
			hudShifts += 1;
			// A settle re-check is itself the last word on this change.
			run.settleChecked = run.sinceShift < 3;
			run.sinceShift = 0;
			run.earPending = -1;
			run.earSlow = [...run.earFast];
			mandalaApplyCharacter(genome, heard, 8);
			genome.shift(shiftStrength, character.energy);
			mandalaPullCharacter(genome, heard, 0.75 * shiftStrength);
			run.weightsIn = 0.5;
		}
		run.weightsIn -= dt;
		if (run.weightsIn <= 0) {
			run.weightsIn = 0.5;
			mandalaApplyCharacter(genome, heard, 6);
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
		run.wall.update(slotId('wall'), 8 / leap, dt);
		run.screen.update(slotId('screen'), 7 / leap, dt);
		run.shape.update(choiceTarget('shape'), 6 / leap, dt);
		run.palette.update(choiceTarget('palette'), 5 / leap, dt);

		// Palette: the family crossfades, warmth and brightness lean it, the
		// result glides (fast right after a shift).
		const pa = paletteFrom(run.palette.from);
		const pb = paletteFrom(run.palette.to);
		const pw = run.palette.weight;
		const lean = clamp(val('warmth') * 0.5 + env.valence * 0.5, 0, 1);
		const value = 0.8 + env.bright * 0.45;
		const colourRate = 1.2 * leap;
		const warmTint: Rgb = [1 + (lean - 0.5) * 0.18, 1, 1 - (lean - 0.5) * 0.22];
		const role = (a: Rgb, b: Rgb, gain = 1): Rgb => {
			const c = mixRgb(a, b, pw);
			return [c[0] * warmTint[0] * gain, c[1] * warmTint[1] * gain, c[2] * warmTint[2] * gain];
		};
		const colours = run.colours;
		approachRgb(colours.stone, role(pa.stone, pb.stone), colourRate, dt);
		approachRgb(colours.metal, role(pa.metal, pb.metal, value), colourRate, dt);
		approachRgb(colours.glow, role(pa.glow, pb.glow, value), colourRate, dt);
		approachRgb(colours.accent, role(pa.accent, pb.accent, value), colourRate, dt);
		approachRgb(colours.rig, role(pa.rig, pb.rig), colourRate, dt);
		approachRgb(colours.sconce, role(pa.sconce, pb.sconce), colourRate, dt);
		approachRgb(colours.fog, role(pa.fog, pb.fog), colourRate, dt);
		colours.iridescence = approach(
			colours.iridescence,
			pa.iridescence + (pb.iridescence - pa.iridescence) * pw,
			colourRate,
			dt
		);

		// ── Beats: a ring rises out of the depths and the camera is pushed.
		const beatCount = Math.max(
			0,
			Math.floor(finite(clock.barIndex)) * 4 + Math.floor(finite(clock.beatIndex))
		);
		if (run.resyncBeat) {
			run.lastBeatCount = beatCount;
			run.resyncBeat = false;
		}
		const punchiness = clamp(0.25 + env.punch * 0.55 + env.weight * 0.45, 0, 1.2);
		if (beatCount !== run.lastBeatCount) {
			run.lastBeatCount = beatCount;
			if (feat && env.silence < 0.6) {
				const downbeat = Math.floor(finite(clock.beatIndex)) === 0;
				const strength =
					(0.35 + directed.bassPunch * 0.8 + (downbeat ? 0.3 : 0)) * response.impact * (1 - env.silence);
				flight.launchRing(strength);
				env.kick = Math.max(env.kick, clamp((0.45 + directed.bassPunch * 0.55) * punchiness, 0, 1));
			}
		}
		env.kick *= Math.exp(-dt / 0.2);
		const beatPhase = clamp(finite(clock.beatPhase), 0, 1);
		env.beatGlow = approach(env.beatGlow, feat ? Math.exp(-beatPhase * 5) * (0.4 + env.punch) : 0, 30, dt);
		const impactTarget = feat
			? clamp(clock.beatPulse * (0.35 + directed.bassPunch * 0.75) + spectrum.novelty * 0.3, 0, 1)
			: 0;
		env.impact = approach(env.impact, impactTarget * response.impact, impactTarget > env.impact ? 30 : 6, dt);

		// ── Geometry and travel.
		const density = clamp(val('density'), 0.5, 4);
		const wallCells = (MANDALA_RAW_SECTORS * density) / Math.PI;
		const screenDensity = density * clamp(val('screenDensity'), 0.3, 2);
		const screenCells = (MANDALA_RAW_SECTORS * screenDensity) / Math.PI;
		const wallAround = wallCells * Math.PI * 2;
		const screenAround = screenCells * Math.PI * 2;
		const wallRise = 1.2 / wallAround;
		const screenRise = 1.2 / screenAround;
		const wallBasis = phyllotaxisBasis(wallAround, MANDALA_DIVERGENCE, wallRise);
		const screenBasis = phyllotaxisBasis(screenAround, MANDALA_DIVERGENCE, screenRise);
		const wallHyperScale = (0.94 * Math.PI) / density;
		const screenHyperScale = (0.94 * Math.PI) / screenDensity;
		// Ambient drifts, club cruises, noise races; energy leans on it.
		const speed =
			(0.035 + Math.pow(env.tempo, 1.5) * 0.55 + env.drive * 0.1 + env.energy * 0.05) * response.motion;
		const restless = clamp(env.tempo * 0.7 + finite(directed.motion) * 0.3 + env.harsh * 0.2, 0, 1);
		flight.update({
			dt,
			speed,
			kick: env.kick * (0.15 + env.punch * 0.55),
			wallCells,
			screenCells,
			screenRate: 1.35,
			wallHyperScale,
			screenHyperScale,
			wallHyperPeriods: hyperPeriods(run.wall),
			screenHyperPeriods: hyperPeriods(run.screen),
			divergence: MANDALA_DIVERGENCE,
			wallRise,
			screenRise,
			corkscrew: val('corkscrew') * (0.6 + env.tempo * 0.6),
			wander: val('wander') * (0.7 + env.harsh * 0.5),
			offset: val('offset'),
			restless,
			silence: env.silence,
			sconceSpacing: 0.55,
			sconceTurn: 2.39996
		});

		const focal = (1.05 + env.weight * 0.15) * (1 - env.kick * 0.06 * response.impact);
		const yaw = flight.yaw;
		const pitch = flight.pitch;
		// Where the tunnel axis lands on screen (feedback zooms about it).
		const axisX = (-Math.sin(yaw) / Math.max(1e-3, Math.cos(yaw) * Math.cos(pitch))) * focal;
		const axisY = -Math.tan(pitch) * focal;
		const aspect = size.width / Math.max(1, size.height);
		const vanishX = clamp(axisX / aspect + 0.5, -0.5, 1.5);
		const vanishY = clamp(0.5 - axisY, -0.5, 1.5);

		const trail = clamp(val('trail'), 0, 1);
		const feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp((0.6 + trail * 0.3 - env.impact * 0.1 - env.harsh * 0.08) * (1 - env.silence * 0.3), 0.35, 0.93);
		// The trail follows the flight exactly, so it deepens the light
		// instead of smearing the carving.
		const feedbackZoom = Math.exp(-flight.stepLog);
		const feedbackRoll = flight.stepRoll;

		const wallSlotA = run.wall.from;
		const wallSlotB = run.wall.to;
		const screenSlotA = run.screen.from;
		const screenSlotB = run.screen.to;
		const rigTurn = val('rigTurn') * Math.PI * 2 + flight.rigPhase;
		const offX = flight.offsetX;
		const offY = flight.offsetY;
		const lightLevel = (0.55 + env.energy * 0.7 + env.beatGlow * 0.25) * (1 - env.silence * 0.6);
		const fog = clamp(val('fog'), 0.02, 0.3);

		values.width = size.width;
		values.height = size.height;
		values.frame = frameIndex % 64;
		values.focal = focal;
		values.yaw = yaw;
		values.pitch = pitch;
		values.offsetX = offX;
		values.offsetY = offY;
		values.roll = flight.roll;
		values.spin = val('spin');
		values.kick = env.kick;
		values.silence = env.silence;
		values.wallRow = flight.wall.row;
		values.wallFrac = flight.wall.frac;
		values.wallPhylloX = flight.wall.phylloTurn;
		values.wallPhylloY = flight.wall.phylloY;
		values.wallHyper = flight.wall.hyper;
		values.wallCells = wallCells;
		values.wallHalf = density;
		values.wallSeedRow = flight.wall.seedRow;
		values.screenRow = flight.screen.row;
		values.screenFrac = flight.screen.frac;
		values.screenPhylloX = flight.screen.phylloTurn;
		values.screenPhylloY = flight.screen.phylloY;
		values.screenHyper = flight.screen.hyper;
		values.screenCells = screenCells;
		values.screenHalf = screenDensity;
		values.screenSeedRow = flight.screen.seedRow;
		values.wallGrammarA = slotGrammar(wallSlotA);
		values.wallFoldA = slotFold(wallSlotA);
		values.wallGrammarB = slotGrammar(wallSlotB);
		values.wallFoldB = slotFold(wallSlotB);
		values.screenGrammarA = slotGrammar(screenSlotA);
		values.screenFoldA = slotFold(screenSlotA);
		values.screenGrammarB = slotGrammar(screenSlotB);
		values.screenFoldB = slotFold(screenSlotB);
		// The A slot alone when a fade is complete: one evaluation, not two.
		const wallMix = run.wall.mix >= 1 ? 0 : run.wall.weight;
		if (run.wall.mix >= 1) {
			values.wallGrammarA = values.wallGrammarB;
			values.wallFoldA = values.wallFoldB;
		}
		values.wallMix = wallMix;
		const screenMix = run.screen.mix >= 1 ? 0 : run.screen.weight;
		if (run.screen.mix >= 1) {
			values.screenGrammarA = values.screenGrammarB;
			values.screenFoldA = values.screenFoldB;
		}
		values.screenMix = screenMix;
		values.screenAmount = clamp((val('screenAmount') - 0.42) / 0.35, 0, 1);
		values.screenRadius = clamp(val('screenRadius') + env.kick * 0.02, 0.4, 0.85);
		const shapeA = MANDALA_SHAPES[run.shape.from] ?? 0;
		const shapeB = MANDALA_SHAPES[run.shape.to] ?? 0;
		values.shapeA = run.shape.mix >= 1 ? shapeB : shapeA;
		values.shapeB = shapeB;
		values.shapeMix = run.shape.mix >= 1 ? 0 : run.shape.weight;
		values.shapeTurn = val('shapeTurn');
		values.lineWidth = clamp(val('lineWidth') * (1.15 - env.harsh * 0.4), 0.009, 0.06);
		values.relief = clamp(val('relief') * (0.7 + env.weight * 0.6), 0, 2);
		values.morph = clamp(val('morph') + env.bass * 0.08, 0, 1);
		values.fracture = Math.pow(clamp((env.harsh - 0.45) / 0.4, 0, 1), 1.3) * 1.1;
		values.wallE1x = wallBasis.e1[0];
		values.wallE1y = wallBasis.e1[1];
		values.wallE2x = wallBasis.e2[0];
		values.wallE2y = wallBasis.e2[1];
		values.screenE1x = screenBasis.e1[0];
		values.screenE1y = screenBasis.e1[1];
		values.screenE2x = screenBasis.e2[0];
		values.screenE2y = screenBasis.e2[1];
		values.wallN1 = wallBasis.n1;
		values.wallN2 = wallBasis.n2;
		values.screenN1 = screenBasis.n1;
		values.screenN2 = screenBasis.n2;
		[values.stoneR, values.stoneG, values.stoneB] = colours.stone;
		values.stoneGloss = colours.stoneGloss;
		[values.metalR, values.metalG, values.metalB] = colours.metal;
		values.metalGain = 1;
		[values.glowR, values.glowG, values.glowB] = colours.glow;
		// Harsh music burns its thin lines brighter.
		values.glowGain = (0.5 + env.energy * 0.9 + env.harsh * 0.9) * (1 - env.silence * 0.5);
		[values.accentR, values.accentG, values.accentB] = colours.accent;
		values.accentGain = 1.3 * response.impact;
		[values.rigR, values.rigG, values.rigB] = colours.rig;
		values.rigGain = 0.6 * lightLevel;
		[values.sconceR, values.sconceG, values.sconceB] = colours.sconce;
		values.sconceGain = clamp(val('sconces'), 0, 1) * 0.9 * lightLevel;
		[values.fogR, values.fogG, values.fogB] = colours.fog;
		values.fogDensity = fog;
		values.rigAx = offX + Math.cos(rigTurn) * 0.3;
		values.rigAy = offY + Math.sin(rigTurn) * 0.3;
		values.rigAz = 0.16;
		values.rigSoft = 0.35;
		values.rigBx = offX + Math.cos(rigTurn + 2.6) * 0.24;
		values.rigBy = offY + Math.sin(rigTurn + 2.6) * 0.24;
		values.rigBz = 0.34;
		values.rigBalance = 0.5 + Math.sin(flight.rigPhase * 1.7) * 0.3;
		// The spots sweep round the tunnel; slow music aims them deep and wide.
		values.spotA = rigTurn + Math.sin(flight.rigPhase * 2.3) * 0.7;
		values.spotB = rigTurn + 2.6 + Math.sin(flight.rigPhase * 1.9 + 1.3) * 0.7;
		values.spotReach = 0.9 + (1 - env.tempo) * 1.1;
		values.spotCone = 0.62 + env.punch * 0.2;
		values.sconceSpacing = 0.55;
		values.sconcePhase = flight.sconcePhase;
		values.sconceTurn = 2.39996;
		values.sconceAngle = flight.sconceAngle;
		values.ring0z = flight.ringZ[0];
		values.ring0s = flight.ringS[0];
		values.ring1z = flight.ringZ[1];
		values.ring1s = flight.ringS[1];
		values.ring2z = flight.ringZ[2];
		values.ring2s = flight.ringS[2];
		values.ring3z = flight.ringZ[3];
		values.ring3s = flight.ringS[3];
		values.ring4z = flight.ringZ[4];
		values.ring4s = flight.ringS[4];
		values.ring5z = flight.ringZ[5];
		values.ring5s = flight.ringS[5];
		values.energy = env.energy;
		values.bass = env.bass;
		values.treble = env.treble;
		values.beatGlow = env.beatGlow;
		values.sub = env.sub;
		values.kickBand = env.kickBand;
		values.body = env.body;
		values.presence = env.presence;
		values.harsh = env.harsh;
		values.warmth = lean;
		values.punch = env.punch;
		values.iridescence = colours.iridescence;
		values.feedbackFade = feedbackFade;
		values.feedbackZoom = feedbackZoom;
		values.bloomThreshold = 0.95 - env.energy * 0.25;
		values.aberration = 1 + env.harsh * 1.2 + env.impact * 0.9;
		values.vanishX = vanishX;
		values.vanishY = vanishY;
		values.feedbackRoll = feedbackRoll;
		values.exposure = 1;
		values.bloomWeight = 0.55;
		values.contrast = 1.06 + env.punch * 0.1 + env.harsh * 0.08;
		values.vignette = 1;
		values.grain = forced()?.debug ? -1 : 1.4;
		// Ambient is soft and vast, harsh music sharp; quiet music stays dark.
		values.softness = clamp((1 - env.punch) * (1 - env.tempo) * (1 - env.harsh) * 1.3 - 0.15, 0, 1);
		values.depthFade = 0.6 + (1 - env.drive) * 0.8;
		values.bounce = 0.35 + env.drive * 0.4;
		values.exposureKey = 0.032 + env.drive * 0.03 + env.tilt * 0.012;
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		packMandalaUniforms(g.uniforms, values);
		frameIndex += 1;

		g.device.queue.writeBuffer(g.uniformBuffer, 0, g.uniforms.buffer, g.uniforms.byteOffset, g.uniforms.byteLength);
		g.device.queue.writeBuffer(g.binsBuffer, 0, bins.buffer, bins.byteOffset, bins.byteLength);

		hudSection = directed.section;
		hudWall = grammarName(wallSlotB);
		hudScreen = grammarName(screenSlotB);
		hudFold = slotFold(wallSlotB);
		hudShape = MANDALA_SHAPE_NAMES[run.shape.to] ?? 'round';
		hudPalette = MANDALA_PALETTES[run.palette.to]?.name ?? '';
		hudEar = earContrast.toFixed(3);

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
		fullscreen('Mandala tunnel', t.sceneView, g.pipelines.scene, bg.scene);
		fullscreen('Mandala feedback', t.feedbackView[next], g.pipelines.feedback, bg.feedback[previous]);
		fullscreen('Mandala exposure', t.exposureView[next], g.pipelines.exposure, bg.exposure[next]);
		fullscreen('Mandala bloom prefilter', t.bloomView[0], g.pipelines.bloomDown, bg.bloomDown[next]);
		for (let round = 0; round < 2; round++) {
			fullscreen('Mandala bloom blur H', t.bloomView[1], g.pipelines.blurH, bg.blurH);
			fullscreen('Mandala bloom blur V', t.bloomView[0], g.pipelines.blurV, bg.blurV);
		}
		fullscreen('Mandala present', g.context.getCurrentTexture().createView(), g.pipelines.composite, bg.composite[next]);
		g.device.queue.submit([encoder.finish()]);
		g.parity = next;
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
			data-mandala-section={hudSection}
			data-mandala-wall={hudWall}
			data-mandala-screen={hudScreen}
			data-mandala-fold={hudFold}
			data-mandala-shape={hudShape}
			data-mandala-palette={hudPalette}
			data-mandala-shifts={hudShifts}
			data-mandala-ear={hudEar}
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
