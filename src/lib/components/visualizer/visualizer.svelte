<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { VISUALIZER_TUNING, useVisualizer } from '$lib/state/visualizer.svelte';
	import {
		FixedFrameScheduler,
		PRISM_FRAME_RATE,
		PRISM_MAX_INTERNAL_PIXELS,
		prismBackingSize
	} from '$lib/visualizer/prism/runtime';
	import {
		PRISM_BIN_COUNT,
		PRISM_BLOOM_DOWN_WGSL,
		PRISM_BLUR_H_WGSL,
		PRISM_BLUR_V_WGSL,
		PRISM_CATHEDRAL_WGSL,
		PRISM_COMPOSITE_WGSL,
		PRISM_FEEDBACK_WGSL,
		PRISM_NEBULAE_WGSL,
		PRISM_ROSE_WGSL,
		PRISM_UNIFORM_BYTES,
		PRISM_UNIFORM_FLOATS,
		PRISM_UNIFORM_OFFSETS as O,
		PRISM_VORONOI_WGSL
	} from '$lib/visualizer/prism/shaders';
	import {
		PRISM_AXES,
		PRISM_CAMERAS,
		PRISM_ENVIRONMENTS,
		PRISM_FAMILY_DRIVE,
		PRISM_GRAMMARS,
		PRISM_PALETTES,
		PRISM_ROSE_R,
		PRISM_ROSE_Y,
		prismBaySpacing,
		prismCamera,
		prismCameraBasis,
		prismDaylight,
		prismFamily,
		prismFold,
		prismGrammarIsRadial,
		prismLive,
		prismPalette,
		prismProject,
		prismStructure,
		prismStructureKey,
		type PrismFamily,
		type PrismStructure,
		type Rgb
	} from '$lib/visualizer/prism/composition';
	import { VariationGenome, type ChoiceState } from '$lib/visualizer/variation';

	const vis = useVisualizer();

	const BINS_BYTES = PRISM_BIN_COUNT * 4;
	/** Rose radii per second that a section's re-leading wave travels. */
	const TRANSITION_SPEED = 0.78;
	/** The wave keeps going past the rose so the wall re-cuts its voussoirs too. */
	const TRANSITION_END = 2.4;
	const RENDER_PASSES = 8;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let hudSection = $state('intro');
	let hudFold = $state(8);
	let raf = 0;
	let unsub: (() => void) | null = null;
	let running = false;
	let initVersion = 0;
	let initializing = false;
	const frameScheduler = new FixedFrameScheduler();

	// ── Render-rate state. Audio only ever moves targets that these envelopes
	// ease toward; nothing in the shader reads a raw analyzer value.
	const bins = new Float32Array(PRISM_BIN_COUNT);
	const env = {
		bass: 0,
		mid: 0,
		treble: 0,
		centroid: 0.5,
		rms: 0,
		energy: 0,
		impact: 0,
		growth: 0,
		backlight: 0,
		air: 0.8,
		silence: 1,
		quietFor: 0,
		packetStrength: 0,
		rotation: 0,
		previousRotation: 0,
		dollyPhase: 0
	};
	const palette = {
		hero: [0.3, 0.02, 0.04] as Rgb,
		support: [0.01, 0.2, 0.22] as Rgb,
		accent: [0.4, 0.2, 0.03] as Rgb,
		field: [0.02, 0.05, 0.2] as Rgb
	};

	/** A composition the re-leading wave carries: structure plus proportions. */
	type Comp = PrismStructure & { petalWidth: number; petalReach: number; outerLit: number };

	// The variation genome: Prism's look walks through it at musical boundaries.
	// It is owned by the shared journey, so leaving and re-entering the
	// visualizer resumes the look and a new song carries it on.
	const lookState = vis.persistentLook('prism', () => ({
		genome: new VariationGenome(PRISM_AXES, 0.5),
		epoch: -1
	}));
	const genome = lookState.genome;

	// The far view and the candle-lit apse and crypt shrink the window to a
	// small light in a black frame. Keep them in the space but rarer, and lift
	// their exposure so a dark regime still reads as lit glass.
	const CAMERA_WEIGHTS: Record<(typeof PRISM_CAMERAS)[number], number> = {
		straight: 1.4,
		receding: 1,
		low: 1,
		macro: 1.1,
		gallery: 1,
		flooded: 1,
		far: 0.35
	};
	const ENVIRONMENT_WEIGHTS: Record<(typeof PRISM_ENVIRONMENTS)[number], number> = {
		nave: 1.3,
		crypt: 0.55,
		ruin: 1,
		apse: 0.5,
		void: 1
	};
	const CAMERA_EXPOSURE: Record<(typeof PRISM_CAMERAS)[number], number> = {
		straight: 1,
		receding: 1.05,
		low: 1.05,
		macro: 1,
		gallery: 1.08,
		flooded: 1.05,
		far: 1.5
	};
	const ENVIRONMENT_EXPOSURE: Record<(typeof PRISM_ENVIRONMENTS)[number], number> = {
		nave: 1,
		crypt: 1.3,
		ruin: 1.05,
		apse: 1.35,
		void: 1.1
	};

	function applyLookWeights() {
		genome.setWeights('camera', PRISM_CAMERAS.map((name) => CAMERA_WEIGHTS[name]));
		genome.setWeights('environment', PRISM_ENVIRONMENTS.map((name) => ENVIRONMENT_WEIGHTS[name]));
	}
	applyLookWeights();

	/** Exposure lift for the current camera/environment crossfade (>= 1). */
	function regimeExposure(energy: number): number {
		const camera = genome.choice('camera');
		const environment = genome.choice('environment');
		const cam =
			CAMERA_EXPOSURE[PRISM_CAMERAS[camera.from]] * (1 - camera.mix) +
			CAMERA_EXPOSURE[PRISM_CAMERAS[camera.to]] * camera.mix;
		const room =
			ENVIRONMENT_EXPOSURE[PRISM_ENVIRONMENTS[environment.from]] * (1 - environment.mix) +
			ENVIRONMENT_EXPOSURE[PRISM_ENVIRONMENTS[environment.to]] * environment.mix;
		// Quiet passages stay dimmer than drops, but never collapse to black.
		const quietFloor = 1 + 0.18 * (1 - clamp(energy, 0, 1));
		return cam * room * quietFloor;
	}
	let songSeed = 0.5;
	let seedSalt = 0;
	let rendererSourceEpoch = -1;
	let lastBeatCount = -1;
	let compA: Comp = makeComp(prismStructure(genome, 'quiet'), 'quiet');
	let compB: Comp = { ...compA };
	let compKey = prismStructureKey(compA);
	let compFamily: PrismFamily = 'quiet';
	let transitionFront = TRANSITION_END;
	let transitionGlow = 0;
	let feedbackResetFrames = 2;
	let frameIndex = 0;
	let hudLook = $state('');

	function makeComp(structure: PrismStructure, family: PrismFamily): Comp {
		const live = prismLive(genome);
		return {
			...structure,
			petalWidth: live.petalWidth,
			petalReach: live.petalReach,
			outerLit: PRISM_FAMILY_DRIVE[family].outerLit
		};
	}

	function clamp(value: number, low: number, high: number) {
		return Math.min(high, Math.max(low, value));
	}

	function approach(current: number, target: number, rate: number, dt: number) {
		return current + (target - current) * (1 - Math.exp(-rate * dt));
	}

	function approachRgb(current: Rgb, target: Rgb, rate: number, dt: number) {
		for (let i = 0; i < 3; i++) current[i] = approach(current[i], target[i], rate, dt);
	}

	function finite(value: number, fallback = 0) {
		return Number.isFinite(value) ? value : fallback;
	}

	type Targets = {
		scene: GPUTexture;
		sceneView: GPUTextureView;
		feedback: [GPUTexture, GPUTexture];
		feedbackView: [GPUTextureView, GPUTextureView];
		bloom: [GPUTexture, GPUTexture];
		bloomView: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type BindGroups = {
		scenes: GPUBindGroup[];
		/** Indexed by the parity of the frame being read. */
		feedback: [GPUBindGroup, GPUBindGroup];
		/** Indexed by the parity of the frame just written. */
		bloomDown: [GPUBindGroup, GPUBindGroup];
		blurH: GPUBindGroup;
		blurV: GPUBindGroup;
		composite: [GPUBindGroup, GPUBindGroup];
	};

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		sampler: GPUSampler;
		uniformBuf: GPUBuffer;
		binsBuf: GPUBuffer;
		uniformData: Float32Array;
		pipelines: {
			scenes: GPURenderPipeline[];
			feedback: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			blurH: GPURenderPipeline;
			blurV: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: Targets | null;
		bindGroups: BindGroups | null;
		parity: 0 | 1;
	};

	let gpu: GPU | null = null;

	function createTarget(device: GPUDevice, label: string, w: number, h: number) {
		return device.createTexture({
			label,
			size: { width: Math.max(1, w), height: Math.max(1, h) },
			format: 'rgba16float',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	function disposeTargets(t: Targets | null) {
		if (!t) return;
		t.scene.destroy();
		for (const texture of t.feedback) texture.destroy();
		for (const texture of t.bloom) texture.destroy();
	}

	function ensureTargets(g: GPU, w: number, h: number) {
		if (g.targets && g.targets.width === w && g.targets.height === h) return;
		disposeTargets(g.targets);
		const { device, pipelines, uniformBuf, binsBuf, sampler } = g;
		const halfW = Math.max(1, Math.floor(w / 2));
		const halfH = Math.max(1, Math.floor(h / 2));
		const scene = createTarget(device, 'Prism scene', w, h);
		const feedback: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Prism feedback A', w, h),
			createTarget(device, 'Prism feedback B', w, h)
		];
		const bloom: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Prism bloom A', halfW, halfH),
			createTarget(device, 'Prism bloom B', halfW, halfH)
		];
		const t: Targets = {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackView: [feedback[0].createView(), feedback[1].createView()],
			bloom,
			bloomView: [bloom[0].createView(), bloom[1].createView()],
			width: w,
			height: h
		};
		g.targets = t;

		const uniform = { binding: 0, resource: { buffer: uniformBuf } };
		const samplerEntry = { binding: 1, resource: sampler };
		const bind = (pipeline: GPURenderPipeline, label: string, views: GPUTextureView[]) =>
			device.createBindGroup({
				label,
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					uniform,
					samplerEntry,
					...views.map((view, index) => ({ binding: 2 + index, resource: view }))
				]
			});
		g.bindGroups = {
			scenes: pipelines.scenes.map((pipeline, index) =>
				device.createBindGroup({
					label: `Prism scene ${index}`,
					layout: pipeline.getBindGroupLayout(0),
					entries: [uniform, { binding: 1, resource: { buffer: binsBuf } }]
				})
			),
			feedback: [
				bind(pipelines.feedback, 'Prism feedback reads A', [t.sceneView, t.feedbackView[0]]),
				bind(pipelines.feedback, 'Prism feedback reads B', [t.sceneView, t.feedbackView[1]])
			],
			bloomDown: [
				bind(pipelines.bloomDown, 'Prism bloom prefilter A', [t.feedbackView[0]]),
				bind(pipelines.bloomDown, 'Prism bloom prefilter B', [t.feedbackView[1]])
			],
			blurH: bind(pipelines.blurH, 'Prism bloom blur H', [t.bloomView[0]]),
			blurV: bind(pipelines.blurV, 'Prism bloom blur V', [t.bloomView[1]]),
			composite: [
				bind(pipelines.composite, 'Prism present A', [t.feedbackView[0], t.bloomView[0]]),
				bind(pipelines.composite, 'Prism present B', [t.feedbackView[1], t.bloomView[0]])
			]
		};
		// Fresh history textures are undefined; never let a stale trail bleed in.
		feedbackResetFrames = 2;
	}

	async function initGpu(c: HTMLCanvasElement): Promise<GPU> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Prism needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		const device = (await adapter.requestDevice()) as GPUDevice;
		let context: GPUCanvasContext | null = null;
		let uniformBuf: GPUBuffer | null = null;
		let binsBuf: GPUBuffer | null = null;
		try {
			context = c.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');
			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });

			const sources: [string, string][] = [
				['Prism rose', PRISM_ROSE_WGSL],
				['Prism cathedral (lab)', PRISM_CATHEDRAL_WGSL],
				['Prism voronoi (lab)', PRISM_VORONOI_WGSL],
				['Prism nebulae (lab)', PRISM_NEBULAE_WGSL],
				['Prism feedback', PRISM_FEEDBACK_WGSL],
				['Prism bloom prefilter', PRISM_BLOOM_DOWN_WGSL],
				['Prism bloom blur H', PRISM_BLUR_H_WGSL],
				['Prism bloom blur V', PRISM_BLUR_V_WGSL],
				['Prism presentation', PRISM_COMPOSITE_WGSL]
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
			const pipeline = (label: string, module: GPUShaderModule, targetFormat: GPUTextureFormat) =>
				device.createRenderPipelineAsync({
					label,
					layout: 'auto',
					vertex: { module, entryPoint: 'vs_main' },
					fragment: { module, entryPoint: 'fs_main', targets: [{ format: targetFormat }] },
					primitive: { topology: 'triangle-list' }
				});
			const hdr: GPUTextureFormat = 'rgba16float';
			const built = await Promise.all([
				pipeline('Prism rose pipeline', modules[0], hdr),
				pipeline('Prism cathedral pipeline', modules[1], hdr),
				pipeline('Prism voronoi pipeline', modules[2], hdr),
				pipeline('Prism nebulae pipeline', modules[3], hdr),
				pipeline('Prism feedback pipeline', modules[4], hdr),
				pipeline('Prism bloom prefilter pipeline', modules[5], hdr),
				pipeline('Prism blur H pipeline', modules[6], hdr),
				pipeline('Prism blur V pipeline', modules[7], hdr),
				pipeline('Prism presentation pipeline', modules[8], format)
			]);

			uniformBuf = device.createBuffer({
				size: PRISM_UNIFORM_BYTES,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			});
			binsBuf = device.createBuffer({
				size: BINS_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});
			const state: GPU = {
				device,
				context,
				format,
				sampler: device.createSampler({
					magFilter: 'linear',
					minFilter: 'linear',
					addressModeU: 'clamp-to-edge',
					addressModeV: 'clamp-to-edge'
				}),
				uniformBuf,
				binsBuf,
				uniformData: new Float32Array(PRISM_UNIFORM_FLOATS),
				pipelines: {
					scenes: built.slice(0, 4),
					feedback: built[4],
					bloomDown: built[5],
					blurH: built[6],
					blurV: built[7],
					composite: built[8]
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
			uniformBuf?.destroy();
			binsBuf?.destroy();
			try {
				context?.unconfigure();
			} catch {
				// A failed configure may also make unconfigure unavailable.
			}
			device.destroy();
			throw error;
		}
	}

	function destroyGpuState(state: GPU | null) {
		if (!state) return;
		disposeTargets(state.targets);
		state.uniformBuf.destroy();
		state.binsBuf.destroy();
		try {
			state.context.unconfigure();
		} catch {
			// The device may already be lost.
		}
		state.device.destroy();
	}

	function teardownGpu() {
		frameScheduler.reset();
		const state = gpu;
		gpu = null;
		ready = false;
		destroyGpuState(state);
	}

	function writeVec4(u: Float32Array, offset: number, a: number, b: number, c: number, d: number) {
		u[offset] = a;
		u[offset + 1] = b;
		u[offset + 2] = c;
		u[offset + 3] = d;
	}

	// Dev-only look override for the lab and capture scripts:
	// window.__PRISM_FORCE__ = { grammar: 5, camera: 3, palette: 12, ... }.
	type PrismForce = Partial<Record<string, number>>;
	function forced(): PrismForce | null {
		if (!import.meta.env.DEV) return null;
		return (globalThis as { __PRISM_FORCE__?: PrismForce }).__PRISM_FORCE__ ?? null;
	}

	function pick(name: string): ChoiceState {
		const value = forced()?.[name];
		return value === undefined ? genome.choice(name) : { from: value, to: value, mix: 1 };
	}

	function val(name: string): number {
		const value = forced()?.[name];
		return value === undefined ? genome.value(name) : value;
	}

	function forceStructure(structure: PrismStructure): PrismStructure {
		const force = forced();
		if (!force) return structure;
		const grammar = force.grammar ?? structure.grammar;
		return {
			...structure,
			grammar,
			fold: force.fold !== undefined ? prismFold(grammar, force.fold) : force.grammar !== undefined ? prismFold(grammar, 3) : structure.fold,
			mosaic: force.mosaic ?? structure.mosaic,
			tiers: force.tiers ?? structure.tiers,
			outline: force.outline ?? structure.outline
		};
	}

	function writeShape(u: Float32Array, offset: number, comp: Comp) {
		writeVec4(u, offset, comp.petalWidth, comp.petalReach, comp.cellScale, comp.outerLit);
	}

	function writeGrammar(u: Float32Array, offset: number, comp: Comp) {
		writeVec4(u, offset, comp.grammar, comp.mosaic, comp.tiers, comp.outline);
	}

	function smooth01(value: number, low: number, high: number) {
		const t = clamp((value - low) / (high - low), 0, 1);
		return t * t * (3 - 2 * t);
	}
	function renderFrame(g: GPU, now: number, dt: number) {
		if (!canvas) return;
		const { width: w, height: h } = prismBackingSize(
			canvas.clientWidth,
			canvas.clientHeight,
			window.devicePixelRatio || 1
		);
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ensureTargets(g, w, h);
		const t = g.targets;
		const bg = g.bindGroups;
		if (!t || !bg) return;

		// One freshness-checked snapshot for the whole frame. Sample on the
		// feature clock, not the rAF timestamp: a frame published earlier in this
		// same vsync carries a later performance.now() than the rAF start time,
		// and a negative age would read as silence.
		const sampleAt = Math.max(now, performance.now());
		const feat = vis.getLatest(sampleAt);
		const journey = vis.getJourney(sampleAt);
		const response = VISUALIZER_TUNING.mk1;
		const directed = journey.director;
		const spectrum = journey.spectrum;
		const clock = directed.clock;
		const sectionNow = directed.section;
		const family = prismFamily(sectionNow);
		const drive = PRISM_FAMILY_DRIVE[family];
		const phrasePos = clamp(finite(clock.phrasePos), 0, 1);
		const phraseIndex = Math.max(0, Math.floor(finite(clock.phraseIndex)));

		if (journey.sourceEpoch !== rendererSourceEpoch) {
			rendererSourceEpoch = journey.sourceEpoch;
			songSeed = journey.seed;
			seedSalt = Math.floor(clamp(songSeed, 0, 1) * 65_535);
			if (lookState.epoch === -1) genome.reset(songSeed);
			else if (lookState.epoch !== journey.sourceEpoch) genome.reseed(songSeed);
			// Same epoch: a renderer remount resumes the look exactly where it was.
			lookState.epoch = journey.sourceEpoch;
			applyLookWeights();
			compA = makeComp(prismStructure(genome, family), family);
			compB = { ...compA };
			compKey = prismStructureKey(compA);
			compFamily = family;
			transitionFront = TRANSITION_END;
			transitionGlow = 0;
			env.air = drive.air;
			env.silence = feat ? 0 : 1;
			env.quietFor = feat ? 0 : 0.5;
			env.packetStrength = 0;
			env.dollyPhase = songSeed * 6.28;
			lastBeatCount = -1;
			const roles = prismPalette(pick('palette'), pick('roles'), val('tint'), {
				keyPitchClass: directed.context.keyPitchClass,
				keyMinor: directed.context.keyMode === 'minor',
				keyConfidence: directed.context.keyConfidence,
				energy: 0
			});
			palette.hero = [...roles.hero];
			palette.support = [...roles.support];
			palette.accent = [...roles.accent];
			palette.field = [...roles.field];
			feedbackResetFrames = 2;
		}

		// ── Envelopes
		const incoming = feat?.bins ?? [];
		const binMix = 1 - Math.exp(-dt / 0.07);
		for (let i = 0; i < PRISM_BIN_COUNT; i++) {
			const target = clamp(finite(incoming[i] ?? 0), 0, 1);
			bins[i] += (target - bins[i]) * (target > bins[i] ? Math.min(1, binMix * 2.5) : binMix);
		}
		const rmsTarget = clamp(finite(feat?.rms ?? 0), 0, 1);
		env.rms = approach(env.rms, rmsTarget, rmsTarget > env.rms ? 14 : 5, dt);
		if (!feat || rmsTarget < 0.009) env.quietFor += dt;
		else env.quietFor = 0;
		const quiet = env.quietFor > 0.45;
		env.silence = approach(env.silence, quiet ? 1 : 0, quiet ? 3 : 10, dt);
		env.bass = approach(env.bass, feat ? spectrum.bass : 0, 9, dt);
		env.mid = approach(env.mid, feat ? spectrum.mid : 0, 7, dt);
		env.treble = approach(env.treble, feat ? spectrum.treble : 0, 12, dt);
		env.centroid = approach(env.centroid, spectrum.centroid, 2.5, dt);
		const sectionEnergy = clamp(finite(directed.context.sectionEnergy), 0, 1);
		const energyTarget = clamp(
			directed.energy * 0.6 + sectionEnergy * 0.25 + env.rms * 0.15,
			0,
			1
		);
		env.energy = approach(env.energy, energyTarget, 3, dt);

		const impactTarget = feat
			? clamp(clock.beatPulse * (0.35 + directed.bassPunch * 0.75) + spectrum.novelty * 0.3, 0, 1)
			: 0;
		env.impact = approach(env.impact, impactTarget * response.impact, impactTarget > env.impact ? 30 : 6, dt);

		// ── Variety: the genome only moves at phrase and section boundaries and
		// glides from there. Silence holds the look where it is.
		if (feat) {
			genome.advance({ phraseIndex, sectionKey: sectionNow, energy: env.energy, dt });
		}

		// Section choreography: a new structure (grammar, fold, cut, tiers,
		// outline) or a new section family re-leads the window with an outward
		// wave. One wave at a time; a change that lands mid-wave waits for it.
		const structure = forceStructure(prismStructure(genome, family));
		const key = prismStructureKey(structure);
		if (transitionFront < TRANSITION_END) {
			transitionFront = Math.min(TRANSITION_END, transitionFront + dt * TRANSITION_SPEED);
			if (transitionFront >= TRANSITION_END) {
				compA = { ...compB };
				transitionGlow = 0;
			}
		}
		if (transitionFront >= TRANSITION_END && (key !== compKey || family !== compFamily)) {
			compA = { ...compB };
			compB = makeComp(structure, family);
			compKey = key;
			compFamily = family;
			transitionFront = 0;
			transitionGlow = 1;
		}
		// The live composition keeps breathing with the genome's proportions.
		const live = prismLive(genome);
		compB.petalWidth = approach(compB.petalWidth, live.petalWidth, 2, dt);
		compB.petalReach = approach(compB.petalReach, live.petalReach, 2, dt);
		compB.outerLit = approach(compB.outerLit, drive.outerLit, 1.2, dt);
		const radial = prismGrammarIsRadial(compB.grammar);

		// Organism: cells divide as a phrase builds and as the section climbs,
		// then fold back and re-draft when the next phrase begins.
		const growthTarget =
			clamp(
				0.08 +
					sectionEnergy * 0.32 +
					directed.drop.buildProgress * 0.22 +
					phrasePos * 0.38 +
					directed.density * 0.12,
				0,
				1
			) *
			(1 - env.silence * 0.6);
		env.growth = approach(env.growth, growthTarget, 0.9, dt);

		const daylight = prismDaylight(val('timeOfDay'));
		const lightTarget =
			(drive.light * (0.55 + env.energy * 0.6) + directed.drop.anticipation * 0.12) *
			(1 - env.silence * 0.72) *
			daylight.power;
		env.backlight = approach(env.backlight, lightTarget, 1.4, dt);
		env.air = approach(env.air, drive.air * (1 - env.silence * 0.4), 0.8, dt);

		// Beat light: strength is latched as each beat starts and then carried
		// through the window by the shader over the beat's own phase.
		const beatCount = Math.max(0, Math.floor(finite(clock.barIndex)) * 4 + Math.floor(finite(clock.beatIndex)));
		if (beatCount !== lastBeatCount) {
			const isDownbeat = Math.floor(finite(clock.beatIndex)) === 0;
			env.packetStrength = feat
				? clamp(
						(0.3 + directed.bassPunch * 0.7 + env.energy * 0.35 + (isDownbeat ? 0.25 : 0)) *
							response.impact *
							drive.packet *
							(1 - env.silence),
						0,
						1.6
					)
				: 0;
			lastBeatCount = beatCount;
		}
		const beatForm = pick('beatForm');

		// Suns behind the glass: where they sit and how many are phrase moves.
		const sunAngle = val('sunAngle') * Math.PI * 2;
		const sunX = Math.cos(sunAngle) * 0.2;
		const sunY = 0.06 + Math.sin(sunAngle) * 0.15;
		const sunPower = 0.45 + env.energy * 0.7;

		// Palette: family (era) and roles (section) crossfade in the genome;
		// harmony and energy lean it; the result glides.
		const roles = prismPalette(
			pick('palette'),
			pick('roles'),
			val('tint'),
			{
				keyPitchClass: directed.context.keyPitchClass,
				keyMinor: directed.context.keyMode === 'minor',
				keyConfidence: directed.context.keyConfidence,
				energy: env.energy
			},
			pick('guest'),
			smooth01(val('guestMix'), 0.3, 0.75)
		);
		approachRgb(palette.hero, roles.hero, 1.2, dt);
		approachRgb(palette.support, roles.support, 1.2, dt);
		approachRgb(palette.accent, roles.accent, 1.2, dt);
		approachRgb(palette.field, roles.field, 1.2, dt);

		// The rose turns with the shared trace phase (music-driven, stops in
		// silence) plus a slow seeded sway; switching engines resumes the pose.
		const tSec = journey.timelineSeconds;
		const turnSign = songSeed > 0.5 ? 1 : -1;
		const sway =
			Math.sin(tSec * 0.041 + songSeed * 6.28) * 0.05 + Math.sin(tSec * 0.017 + songSeed * 11) * 0.04;
		env.previousRotation = env.rotation;
		env.rotation = (journey.signal.tracePhase * 0.22 * turnSign + sway) * response.motion;
		const rotationDelta = clamp(env.rotation - env.previousRotation, -0.02, 0.02);
		const driftX =
			(Math.sin(tSec * 0.043 + songSeed * 9) * 0.011 + Math.sin(tSec * 0.019 + 1.3) * 0.007) *
			response.motion;
		const driftY = Math.cos(tSec * 0.031 + songSeed * 4) * 0.006 * response.motion;

		// ── Camera: the regime crossfade in the genome is a real camera move.
		// The gallery dolly advances with the music and stops in silence.
		const spacing = prismBaySpacing(val('baySpacing'));
		env.dollyPhase += dt * (0.035 + env.energy * 0.05) * (1 - env.silence) * response.motion;
		const camSide = val('camSide');
		const cam = prismCamera(
			pick('camera'),
			camSide,
			val('camFocus'),
			val('camDrift'),
			Math.sin(env.dollyPhase) * 1.4 * spacing
		);
		cam.tx += driftX * 1.6;
		cam.ty += driftY * 1.6;
		cam.yaw += driftX * 0.6;
		const basis = prismCameraBasis(cam);
		const heroBay = Math.round(cam.tx / spacing) * spacing;
		const heroCentre = prismProject(basis, [heroBay, PRISM_ROSE_Y, 0]) ?? [0, 4];
		const heroEdge = prismProject(basis, [heroBay + PRISM_ROSE_R, PRISM_ROSE_Y, 0]) ?? [heroCentre[0] + 0.32, heroCentre[1]];
		const heroRadius = Math.max(0.02, Math.hypot(heroEdge[0] - heroCentre[0], heroEdge[1] - heroCentre[1]));
		// Trails follow the rose's turn only when the camera sees it square-on.
		const squareOn = Math.pow(Math.cos(cam.yaw), 6) * Math.pow(Math.cos(cam.pitch), 2);
		const trailTurn = radial ? rotationDelta * squareOn : 0;

		// ── World: the building, the hour, the weather, the air.
		const environment = pick('environment');
		const rain = smooth01(val('rain'), 0.55, 0.9);
		const wetness = clamp(Math.max(val('wetness') * 0.55, cam.wet, rain * 0.85), 0, 1);
		const sideShaft = smooth01(val('sideShaft'), 0.55, 0.98);

		// Post: trails shorten on impact and in silence; the bloom knee drops
		// with energy so peaks glow and quiet sections stay graphic.
		const feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp(
						(0.86 + env.energy * 0.05 - env.impact * 0.08 + response.feedbackFadeOffset) *
							(1 - env.silence * 0.3),
						0.4,
						0.95
					);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		const feedbackZoom = 1 - (0.0012 + env.bass * 0.0022) * response.motion;
		const bloomThreshold = 0.82 - env.energy * 0.18 + response.bloomThresholdOffset;
		const aberration = 1 + env.impact * 1.5;

		// Lab-only preset override; production is always the rose.
		const selectedPreset = Math.max(0, Math.min(3, vis.forcedPreset >= 0 ? vis.forcedPreset : 0));
		if (vis.preset !== selectedPreset) vis.setPreset(selectedPreset);

		// ── Uniforms
		const u = g.uniformData;
		u[0] = w;
		u[1] = h;
		u[2] = tSec;
		u[3] = env.bass;
		u[4] = env.mid;
		u[5] = env.treble;
		u[6] = env.centroid;
		u[7] = env.rms;
		u[8] = env.impact;
		u[9] = bloomThreshold;
		u[10] = feedbackFade;
		u[11] = env.rotation;
		u[12] = feedbackZoom;
		u[13] = 1;
		u[14] = 0;
		u[15] = clamp(finite(clock.beatPhase), 0, 1);
		u[16] = clamp(finite(directed.context.keyPitchClass), 0, 1);
		u[17] = clamp(finite(directed.context.keyConfidence), 0, 1);
		u[18] = clamp((finite(clock.tempoBpm) - 60) / 120, 0, 1);
		u[19] = songSeed;
		u[20] = 0;
		u[21] = 1;
		u[22] = journey.signal.tracePhase;
		u[23] = sectionEnergy;
		writeVec4(u, O.comp, compA.fold, compB.fold, transitionFront, transitionGlow * Math.min(1, (TRANSITION_END - transitionFront) * 2));
		writeShape(u, O.shapeA, compA);
		writeShape(u, O.shapeB, compB);
		writeGrammar(u, O.gramA, compA);
		writeGrammar(u, O.gramB, compB);
		writeVec4(u, O.detail, live.tracery, live.cusp, live.sprinkle, cam.bays);
		writeVec4(u, O.organism, env.growth, phraseIndex, phrasePos, seedSalt);
		writeVec4(u, O.light, env.backlight, env.packetStrength, clamp(finite(clock.beatPhase), 0, 1), beatCount);
		writeVec4(u, O.modes, beatForm.from, beatForm.to, beatForm.mix, family === 'drift' ? 1 : 0);
		writeVec4(u, O.sun, sunX, sunY, sunPower, env.air);
		writeVec4(u, O.heroCol, ...palette.hero, 0);
		writeVec4(u, O.supportCol, ...palette.support, 0);
		writeVec4(u, O.accentCol, ...palette.accent, 0);
		writeVec4(u, O.fieldCol, ...palette.field, 0);
		writeVec4(u, O.post, feedbackFade, feedbackZoom, bloomThreshold, aberration);
		writeVec4(u, O.env, driftX, driftY, env.silence, env.rotation);
		writeVec4(u, O.bands, env.bass, env.mid, env.treble, env.impact);
		writeVec4(u, O.motion, trailTurn, frameIndex % 60, env.energy, regimeExposure(env.energy));
		writeVec4(u, O.camPos, basis.pos[0], basis.pos[1], basis.pos[2], basis.focal);
		writeVec4(u, O.camRight, basis.right[0], basis.right[1], basis.right[2], spacing);
		writeVec4(u, O.camUp, basis.up[0], basis.up[1], basis.up[2], 0);
		writeVec4(u, O.camFwd, basis.fwd[0], basis.fwd[1], basis.fwd[2], wetness);
		writeVec4(u, O.roseScreen, heroCentre[0], heroCentre[1], heroRadius, 0);
		writeVec4(u, O.world, environment.from, environment.to, environment.mix, rain);
		writeVec4(u, O.sky, daylight.color[0], daylight.color[1], daylight.color[2], daylight.night);
		writeVec4(
			u,
			O.atmos,
			val('fog'),
			clamp(val('dust') + env.energy * 0.2, 0, 1),
			val('caustics'),
			val('sunCount')
		);
		writeVec4(u, O.shaft, sideShaft, val('shaftAngle'), -Math.sign(camSide || 1) * 0.7, 0);
		frameIndex += 1;

		g.device.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		g.device.queue.writeBuffer(g.binsBuf, 0, bins.buffer, bins.byteOffset, bins.byteLength);

		hudSection = directed.section;
		hudFold = compB.fold;
		hudLook = [
			PRISM_GRAMMARS[compB.grammar],
			PRISM_CAMERAS[pick('camera').to],
			PRISM_PALETTES[pick('palette').to].name,
			PRISM_ENVIRONMENTS[pick('environment').to]
		].join(' ');

		// ── Render graph: scene → feedback → prefilter → 2× (H, V) blur → present
		const encoder = g.device.createCommandEncoder({ label: 'Prism frame' });
		const fullscreen = (
			label: string,
			view: GPUTextureView,
			pipeline: GPURenderPipeline,
			bindGroup: GPUBindGroup,
			vertices: number
		) => {
			const pass = encoder.beginRenderPass({
				label,
				colorAttachments: [
					{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }
				]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(vertices);
			pass.end();
		};
		const previous = g.parity;
		const next: 0 | 1 = previous === 0 ? 1 : 0;
		fullscreen(
			'Prism scene',
			t.sceneView,
			g.pipelines.scenes[selectedPreset],
			bg.scenes[selectedPreset],
			6
		);
		fullscreen('Prism feedback', t.feedbackView[next], g.pipelines.feedback, bg.feedback[previous], 3);
		fullscreen('Prism bloom prefilter', t.bloomView[0], g.pipelines.bloomDown, bg.bloomDown[next], 3);
		for (let round = 0; round < 2; round++) {
			fullscreen('Prism bloom blur H', t.bloomView[1], g.pipelines.blurH, bg.blurH, 3);
			fullscreen('Prism bloom blur V', t.bloomView[0], g.pipelines.blurV, bg.blurV, 3);
		}
		fullscreen(
			'Prism present',
			g.context.getCurrentTexture().createView(),
			g.pipelines.composite,
			bg.composite[next],
			3
		);
		g.device.queue.submit([encoder.finish()]);
		g.parity = next;
	}

	function loop(now: number) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		const frameDt = frameScheduler.next(now);
		if (frameDt === null) return;
		try {
			renderFrame(gpu, now, clamp(frameDt, 0.001, 0.25));
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : String(error);
			teardownGpu();
		}
	}

	// The visualizer component is mounted once in the layout; the canvas inside
	// is conditionally rendered. Each fresh canvas gets fresh GPU state, and a
	// stale initialization is destroyed rather than adopted.
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
				frameScheduler.reset();
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
			unsub = stop;
			raf = requestAnimationFrame(loop);
		});
	});

	onDestroy(() => {
		running = false;
		initVersion += 1;
		cancelAnimationFrame(raf);
		if (unsub) {
			unsub();
			unsub = null;
		}
		teardownGpu();
	});
</script>

{#if vis.active}
	<div class="fixed inset-0 z-[100] bg-black">
		<canvas
			bind:this={canvas}
			class="h-full w-full"
			aria-label="Prism audio visualizer"
			data-prism-frame-rate={PRISM_FRAME_RATE}
			data-prism-max-internal-pixels={PRISM_MAX_INTERNAL_PIXELS}
			data-prism-render-passes={RENDER_PASSES}
			data-prism-section={hudSection}
			data-prism-fold={hudFold}
			data-prism-look={hudLook}
			data-prism-ready={String(ready)}
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-6 z-20 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
