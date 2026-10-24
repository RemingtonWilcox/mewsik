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
		PRISM_EXPOSURE_WGSL,
		PRISM_FEEDBACK_WGSL,
		PRISM_LIGHTMAP_HEIGHT,
		PRISM_LIGHTMAP_WGSL,
		PRISM_LIGHTMAP_WIDTH,
		PRISM_NEBULAE_WGSL,
		PRISM_ROSE_WGSL,
		PRISM_UNIFORM_BYTES,
		PRISM_UNIFORM_FLOATS,
		PRISM_UNIFORM_OFFSETS as O,
		PRISM_VOLUME_WGSL,
		PRISM_VORONOI_WGSL
	} from '$lib/visualizer/prism/shaders';
	import {
		PRISM_AXES,
		PRISM_BEAT_FORM_PROTOTYPES,
		PRISM_CAMERAS,
		PRISM_CAMERA_PROTOTYPES,
		PRISM_ENVIRONMENTS,
		PRISM_ENVIRONMENT_PROTOTYPES,
		PRISM_FAMILY_DRIVE,
		PRISM_FLOOR_Y,
		PRISM_GRAMMARS,
		PRISM_GRAMMAR_PROTOTYPES,
		PRISM_MOSAIC_PROTOTYPES,
		PRISM_PALETTES,
		PRISM_PALETTE_PROTOTYPES,
		PRISM_ROSE_R,
		PRISM_ROSE_Y,
		prismBaySpacing,
		prismCameraBasis,
		prismDaylight,
		prismFamily,
		prismFeel,
		prismFold,
		prismGrammarIsRadial,
		prismHueAway,
		prismLive,
		prismPalette,
		prismProject,
		prismSoftSign,
		prismStructure,
		prismTemper,
		type PrismCameraBasis,
		type PrismFamily,
		type PrismPrototype,
		type PrismStructure,
		type Rgb
	} from '$lib/visualizer/prism/composition';
	import { PrismCameraRig } from '$lib/visualizer/prism/camera';
	import { PrismVoices } from '$lib/visualizer/prism/voices';
	import {
		CHARACTER_FEATURES,
		characterWeights,
		type CharacterFeature,
		type MusicCharacter
	} from '$lib/visualizer/character';
	import {
		ChoiceFollower,
		HeardKick,
		MosaicDraft,
		PRISM_FOLLOWED_CHOICES,
		PrismMotion,
		StructureMorph,
		prismEnterSource,
		type PrismComp,
		type PrismFollowedChoice
	} from '$lib/visualizer/prism/continuity';
	import { VariationGenome, type ChoiceState, type ChoiceAxis } from '$lib/visualizer/variation';
	import { Wander, noise1 } from '$lib/visualizer/motion';

	const vis = useVisualizer();

	const BINS_BYTES = PRISM_BIN_COUNT * 4;
	const RENDER_PASSES = 11;

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
	function freshEnv() {
		return {
			bass: 0,
			mid: 0,
			treble: 0,
			centroid: 0.5,
			rms: 0,
			energy: 0,
			growth: 0,
			backlight: 0,
			air: 0.8,
			silence: 1,
			quietFor: 0
		};
	}

	/** Discrete axes the renderer shows as crossfades (structure rides the morph). */
	const FOLLOWED = PRISM_FOLLOWED_CHOICES;
	type Followed = PrismFollowedChoice;
	const FOLLOW_TAU = Object.fromEntries(
		FOLLOWED.map((name) => [name, (PRISM_AXES.find((axis) => axis.name === name) as ChoiceAxis).tau])
	) as Record<Followed, number>;

	/**
	 * Everything the picture is made of beyond the genome: envelopes, palette,
	 * the structure morph, the mosaic draft, motion and every crossfade. It
	 * lives in the journey's persistent look next to the genome, so a new song
	 * continues it and a remount resumes it exactly.
	 */
	type PrismRun = {
		env: ReturnType<typeof freshEnv>;
		palette: { hero: Rgb; support: Rgb; accent: Rgb; field: Rgb };
		morph: StructureMorph;
		draft: MosaicDraft;
		motion: PrismMotion;
		choices: Record<Followed, ChoiceFollower>;
		/** The roaming camera. */
		rig: PrismCameraRig;
		/** Kicks as the audio played them: they push the camera, never the beat clock. */
		kick: HeardKick;
		/**
		 * Slow non-repeating drift of the window's own motion: how beat light
		 * travels (ring width, spiral twist, wheel spread), how the cells
		 * divide, where the dust sways, how the glass leans in hue inside its
		 * family and in temperature. Never a fixed-rate loop.
		 */
		flow: Wander;
		/** The music character, smoothed into glides of a second or two. */
		feel: Record<CharacterFeature, number>;
		/** 1 right after a shift, easing to 0: every smoother hurries in step. */
		hurry: number;
		/**
		 * Seconds a new source holds the window's structure, so the morph it
		 * runs is the one that answers the new music's shift (about a second
		 * later), not a section-family change that would make it wait.
		 */
		holdMorph: number;
		/** Seconds the hurry holds at full before it starts to ease off. */
		hurryHold: number;
		/** Crossfades started by an answered change of music: they stay fast until they land. */
		fastFades: Record<Followed, boolean>;
		/** Which fade (ChoiceFollower.starts) of each axis is an answering one, shown eased out. */
		eagerFade: Record<Followed, number>;
		/** The running structure morph answers a change of music. */
		morphFast: boolean;
		/**
		 * Seconds after an answer during which the look keeps tracking the new
		 * music closely, while its tempo estimate and envelopes are still
		 * settling, so the new look has fully arrived before it starts to drift.
		 */
		feelSettle: number;
		/** Seconds since character weights and pulls were last refreshed. */
		weightClock: number;
		/**
		 * Prism's own memory of the music's pace, weight and grain (about 20 s),
		 * so a change of tempo the shared detector does not count as a change
		 * of character still reads as a new piece of music, and a mild answer
		 * can be upgraded when the change turns out to be a whole new genre.
		 */
		pace: {
			memory: Record<PaceFeature, number>;
			/** The memory as it was before the latest answer. */
			before: Record<PaceFeature, number>;
			/** Seconds left in which a mild answer may become a new reel. */
			upgradeFor: number;
			primed: boolean;
			since: number;
		};
		/** Look salt for clouds; compositions carry their own. */
		salt: number;
		/**
		 * The ensemble's voices: every part of the window answers its own part
		 * of the band (heard drums as packets in their own ring, chords voicing
		 * the rings one at a time, the bass walking the low light, and a
		 * modulation matrix routing the rest of the nave). Its packets age on
		 * the look's own clock, so a new song's counters never jump them.
		 */
		voices: PrismVoices;
		/** Set by a new source; nothing on the beat clock reads it any more. */
		resyncBeat: boolean;
	};

	// The variation genome: Prism's look walks through it at musical boundaries.
	// It is owned by the shared journey, so leaving and re-entering the
	// visualizer resumes the look and a new song carries it on.
	const lookState = vis.persistentLook('prism', () => ({
		genome: new VariationGenome(PRISM_AXES, 0.5),
		epoch: -1,
		run: null as PrismRun | null,
		/** The music-character shift this look last answered (null: not seen yet). */
		answeredShift: null as number | null
	}));
	const genome = lookState.genome;

	// The far nave and the candle-lit apse and crypt shrink the window to a
	// small light in a dark frame. Keep them in the space but rarer, and lift
	// their exposure so a dark regime still reads as lit glass.
	const CAMERA_WEIGHTS: Record<(typeof PRISM_CAMERAS)[number], number> = {
		orbit: 1.3,
		arcade: 1,
		crane: 1,
		glass: 1.1,
		gallery: 1,
		flooded: 1,
		nave: 0.7,
		dutch: 0.8
	};
	const ENVIRONMENT_WEIGHTS: Record<(typeof PRISM_ENVIRONMENTS)[number], number> = {
		nave: 1.3,
		crypt: 0.55,
		ruin: 1,
		apse: 0.5,
		void: 1
	};
	const CAMERA_EXPOSURE: Record<(typeof PRISM_CAMERAS)[number], number> = {
		orbit: 1,
		arcade: 1.05,
		crane: 1.04,
		glass: 1,
		gallery: 1.08,
		flooded: 1.05,
		nave: 1.35,
		dutch: 1.02
	};
	const ENVIRONMENT_EXPOSURE: Record<(typeof PRISM_ENVIRONMENTS)[number], number> = {
		nave: 1,
		crypt: 1.3,
		ruin: 1.05,
		apse: 1.35,
		void: 1.1
	};
	// The arcade in front of the wall, per room: presence, plane depth, column
	// radius, capital height. The apse and the void stand open.
	const ARCADE: Record<(typeof PRISM_ENVIRONMENTS)[number], [number, number, number, number]> = {
		nave: [1, -0.52, 0.05, 0.44],
		crypt: [1, -0.44, 0.075, 0.25],
		ruin: [0.9, -0.52, 0.055, 0.44],
		apse: [0, -0.52, 0.05, 0.44],
		void: [0, -0.52, 0.05, 0.44]
	};

	const CAMERA_PROTOS = PRISM_CAMERAS.map((name) => PRISM_CAMERA_PROTOTYPES[name]);
	const ENVIRONMENT_PROTOS = PRISM_ENVIRONMENTS.map((name) => PRISM_ENVIRONMENT_PROTOTYPES[name]);

	/** Character weights times the authored weights for one choice axis. */
	function weighted(prototypes: readonly PrismPrototype[], character: MusicCharacter, base?: readonly number[]) {
		return characterWeights(prototypes, character, 3.5, 0.08).map((weight, index) => weight * (base?.[index] ?? 1));
	}

	/**
	 * Bias future picks toward options that fit the music: the camera regime,
	 * the room, the window grammar, the mosaic cut, the beat form and both
	 * palette families. With no character yet, only the authored weights.
	 */
	function applyLookWeights(character?: MusicCharacter, awayFrom?: Rgb) {
		const cameraBase = PRISM_CAMERAS.map((name) => CAMERA_WEIGHTS[name]);
		const environmentBase = PRISM_ENVIRONMENTS.map((name) => ENVIRONMENT_WEIGHTS[name]);
		if (!character) {
			genome.setWeights('camera', cameraBase);
			genome.setWeights('environment', environmentBase);
			return;
		}
		genome.setWeights('camera', weighted(CAMERA_PROTOS, character, cameraBase));
		genome.setWeights('environment', weighted(ENVIRONMENT_PROTOS, character, environmentBase));
		genome.setWeights('grammar', weighted(PRISM_GRAMMAR_PROTOTYPES, character));
		genome.setWeights('mosaic', weighted(PRISM_MOSAIC_PROTOTYPES, character));
		genome.setWeights('beatForm', weighted(PRISM_BEAT_FORM_PROTOTYPES, character));
		// Answering a change of music, steer away from the hue on screen too.
		const away = awayFrom ? prismHueAway(awayFrom) : null;
		const palettes = weighted(PRISM_PALETTE_PROTOTYPES, character, away ?? undefined);
		genome.setWeights('palette', palettes);
		genome.setWeights('guest', palettes);
	}
	applyLookWeights();

	/**
	 * Steer the continuous axes the music's character should own: how finely
	 * the glass is cut, the hour of the light, haze, dust and the clerestory.
	 */
	function pullToCharacter(c: Record<CharacterFeature, number>, amount: number) {
		genome.pull('cellScale', clamp(0.1 + c.tempo * 0.6 + c.punch * 0.3, 0, 1), amount);
		genome.pull('fog', clamp(0.85 - c.tempo * 0.5 - c.punch * 0.25, 0, 1), amount);
		genome.pull('dust', clamp(0.15 + c.tempo * 0.5 + c.energy * 0.3, 0, 1), amount);
		genome.pull('timeOfDay', clamp(0.86 - c.tempo * 0.4 - c.punch * 0.25, 0, 1), amount);
		genome.pull('sideShaft', clamp(c.energy * 0.7 + c.punch * 0.4, 0, 1), amount);
		genome.pull('sunCount', clamp(c.energy * 0.8 + c.tempo * 0.2, 0, 1), amount);
		genome.pull('tint', clamp(0.5 + (c.tempo - 0.45) * 0.8, 0, 1), amount * 0.6);
		genome.pull('petalWidth', clamp(0.8 - c.tempo * 0.6, 0, 1), amount * 0.5);
		genome.pull('tracery', clamp(c.bass * 0.8, 0, 1), amount * 0.5);
	}

	/** What Prism's own change detector listens to, and how much each counts. */
	const PACE_WEIGHTS = { tempo: 1, punch: 0.6, bass: 0.4, noise: 0.4, brightness: 0.3 } as const;
	type PaceFeature = keyof typeof PACE_WEIGHTS;
	const PACE_FEATURES = Object.keys(PACE_WEIGHTS) as PaceFeature[];

	function paceRecord(): Record<PaceFeature, number> {
		return { tempo: 0.5, punch: 0.3, bass: 0.4, noise: 0.4, brightness: 0.5 };
	}

	/**
	 * How far the music has moved from a memory. The tempo-only reading is what
	 * Prism answers on its own (a new tempo is new music even when the timbre
	 * stays, and the shared detector weighs timbre); the full reading decides
	 * whether a mild answer was really a new genre.
	 */
	function paceDistance(memory: Record<PaceFeature, number>, c: MusicCharacter, paceOnly = false): number {
		let d = 0;
		for (const name of PACE_FEATURES) {
			if (paceOnly && (name === 'noise' || name === 'brightness')) continue;
			d += Math.abs(finite(c[name], memory[name]) - memory[name]) * PACE_WEIGHTS[name];
		}
		return d;
	}

	/** True once the music has been quiet long enough to hold the look. */
	function silenceHeld(env: { silence: number }) {
		return env.silence > 0.5;
	}

	function characterRecord(c: MusicCharacter | undefined): Record<CharacterFeature, number> {
		const out = {} as Record<CharacterFeature, number>;
		for (const name of CHARACTER_FEATURES) out[name] = finite(c?.[name] ?? 0.5, 0.5);
		return out;
	}

	/** Exposure lift for the current camera/environment crossfade (>= 1). */
	function regimeExposure(
		camera: ChoiceState,
		environment: ChoiceState,
		energy: number,
		excursion: { region: number; away: number }
	): number {
		const home =
			CAMERA_EXPOSURE[PRISM_CAMERAS[camera.from]] * (1 - camera.mix) +
			CAMERA_EXPOSURE[PRISM_CAMERAS[camera.to]] * camera.mix;
		const away = CAMERA_EXPOSURE[PRISM_CAMERAS[excursion.region]] ?? 1;
		const cam = home + (away - home) * clamp(excursion.away, 0, 1);
		const room =
			ENVIRONMENT_EXPOSURE[PRISM_ENVIRONMENTS[environment.from]] * (1 - environment.mix) +
			ENVIRONMENT_EXPOSURE[PRISM_ENVIRONMENTS[environment.to]] * environment.mix;
		// Quiet passages stay dimmer than drops, but never collapse to black.
		const quietFloor = 1 + 0.18 * (1 - clamp(energy, 0, 1));
		return cam * room * quietFloor;
	}
	let songSeed = 0.5;
	let rendererSourceEpoch = -1;
	let run: PrismRun | null = lookState.run;
	let feedbackResetFrames = 2;
	/** Fade from black after the GPU (re)starts. */
	let fadeIn = 0;
	/** The previous frame's camera, for reprojected history (not part of the look). */
	let prevBasis: PrismCameraBasis | null = null;
	let frameIndex = 0;
	let hudLook = $state('');
	let hudDebug = $state('');
	let localAnswers = 0;

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
		/** The nave's air at half resolution, ping-ponged for its history. */
		volume: [GPUTexture, GPUTexture];
		volumeView: [GPUTextureView, GPUTextureView];
		/** What the glass transmits, in wall coordinates. */
		lightmap: GPUTexture;
		lightmapView: GPUTextureView;
		/** The metered exposure, 1x1, ping-ponged so it adapts over time. */
		exposure: [GPUTexture, GPUTexture];
		exposureView: [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	};

	type BindGroups = {
		lightmap: GPUBindGroup;
		scenes: GPUBindGroup[];
		/** Indexed by the parity of the frame being read. */
		volume: [GPUBindGroup, GPUBindGroup];
		/** Indexed by the parity of the frame just written. */
		exposure: [GPUBindGroup, GPUBindGroup];
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
			lightmap: GPURenderPipeline;
			scenes: GPURenderPipeline[];
			volume: GPURenderPipeline;
			exposure: GPURenderPipeline;
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
		for (const texture of t.volume) texture.destroy();
		for (const texture of t.exposure) texture.destroy();
		t.lightmap.destroy();
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
		const volume: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Prism air A', halfW, halfH),
			createTarget(device, 'Prism air B', halfW, halfH)
		];
		const lightmap = createTarget(device, 'Prism light map', PRISM_LIGHTMAP_WIDTH, PRISM_LIGHTMAP_HEIGHT);
		const exposure: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Prism exposure A', 1, 1),
			createTarget(device, 'Prism exposure B', 1, 1)
		];
		const t: Targets = {
			scene,
			sceneView: scene.createView(),
			feedback,
			feedbackView: [feedback[0].createView(), feedback[1].createView()],
			bloom,
			bloomView: [bloom[0].createView(), bloom[1].createView()],
			volume,
			volumeView: [volume[0].createView(), volume[1].createView()],
			lightmap,
			lightmapView: lightmap.createView(),
			exposure,
			exposureView: [exposure[0].createView(), exposure[1].createView()],
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
		const binsEntry = { binding: 1, resource: { buffer: binsBuf } };
		g.bindGroups = {
			lightmap: device.createBindGroup({
				label: 'Prism light map',
				layout: pipelines.lightmap.getBindGroupLayout(0),
				entries: [uniform, binsEntry]
			}),
			// The rose reads the light map for the arcade and the clerestory
			// beams; the legacy lab scenes only take the uniforms and bins.
			scenes: pipelines.scenes.map((pipeline, index) =>
				device.createBindGroup({
					label: `Prism scene ${index}`,
					layout: pipeline.getBindGroupLayout(0),
					entries:
						index === 0
							? [uniform, binsEntry, { binding: 2, resource: t.lightmapView }, { binding: 3, resource: sampler }]
							: [uniform, binsEntry]
				})
			),
			volume: [
				bind(pipelines.volume, 'Prism air reads A', [t.lightmapView, t.volumeView[0]]),
				bind(pipelines.volume, 'Prism air reads B', [t.lightmapView, t.volumeView[1]])
			],
			exposure: [
				bind(pipelines.exposure, 'Prism exposure writes A', [t.feedbackView[0], t.exposureView[1]]),
				bind(pipelines.exposure, 'Prism exposure writes B', [t.feedbackView[1], t.exposureView[0]])
			],
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
				bind(pipelines.composite, 'Prism present A', [
					t.feedbackView[0],
					t.bloomView[0],
					t.volumeView[0],
					t.lightmapView,
					t.exposureView[0]
				]),
				bind(pipelines.composite, 'Prism present B', [
					t.feedbackView[1],
					t.bloomView[0],
					t.volumeView[1],
					t.lightmapView,
					t.exposureView[1]
				])
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
				['Prism light map', PRISM_LIGHTMAP_WGSL],
				['Prism air', PRISM_VOLUME_WGSL],
				['Prism rose', PRISM_ROSE_WGSL],
				['Prism cathedral (lab)', PRISM_CATHEDRAL_WGSL],
				['Prism voronoi (lab)', PRISM_VORONOI_WGSL],
				['Prism nebulae (lab)', PRISM_NEBULAE_WGSL],
				['Prism feedback', PRISM_FEEDBACK_WGSL],
				['Prism bloom prefilter', PRISM_BLOOM_DOWN_WGSL],
				['Prism bloom blur H', PRISM_BLUR_H_WGSL],
				['Prism bloom blur V', PRISM_BLUR_V_WGSL],
				['Prism presentation', PRISM_COMPOSITE_WGSL],
				['Prism exposure', PRISM_EXPOSURE_WGSL]
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
				pipeline('Prism light map pipeline', modules[0], hdr),
				pipeline('Prism air pipeline', modules[1], hdr),
				pipeline('Prism rose pipeline', modules[2], hdr),
				pipeline('Prism cathedral pipeline', modules[3], hdr),
				pipeline('Prism voronoi pipeline', modules[4], hdr),
				pipeline('Prism nebulae pipeline', modules[5], hdr),
				pipeline('Prism feedback pipeline', modules[6], hdr),
				pipeline('Prism bloom prefilter pipeline', modules[7], hdr),
				pipeline('Prism blur H pipeline', modules[8], hdr),
				pipeline('Prism blur V pipeline', modules[9], hdr),
				pipeline('Prism presentation pipeline', modules[10], format),
				pipeline('Prism exposure pipeline', modules[11], hdr)
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
					lightmap: built[0],
					volume: built[1],
					scenes: built.slice(2, 6),
					feedback: built[6],
					bloomDown: built[7],
					blurH: built[8],
					blurV: built[9],
					composite: built[10],
					exposure: built[11]
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

	function pick(r: PrismRun, name: Followed): ChoiceState {
		const value = forced()?.[name];
		if (value !== undefined) return { from: value, to: value, mix: 1 };
		const follower = r.choices[name];
		// An answering fade shows from its first frame (the camera keeps its
		// smoothstep: a reframing should ease in, not lurch).
		const eager = name !== 'camera' && follower.starts === r.eagerFade[name] && follower.mix < 1;
		return eager ? follower.stateEagerly() : follower.state();
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

	/** The first frame of a journey: a picture that already shows the genome. */
	function createRun(
		seed: number,
		family: PrismFamily,
		hasAudio: boolean,
		context: { keyPitchClass: number; keyMode: string; keyConfidence: number }
	): PrismRun {
		const salt = Math.floor(clamp(seed, 0, 1) * 65_535);
		const choices = Object.fromEntries(
			FOLLOWED.map((name) => [name, new ChoiceFollower(genome.choice(name).to)])
		) as Record<Followed, ChoiceFollower>;
		const roles = prismPalette(choices.palette.state(), choices.roles.state(), genome.value('tint'), {
			keyPitchClass: context.keyPitchClass,
			keyMinor: context.keyMode === 'minor',
			keyConfidence: context.keyConfidence,
			energy: 0
		});
		const env = freshEnv();
		env.air = PRISM_FAMILY_DRIVE[family].air;
		env.silence = hasAudio ? 0 : 1;
		env.quietFor = hasAudio ? 0 : 0.5;
		return {
			env,
			palette: {
				hero: [...roles.hero],
				support: [...roles.support],
				accent: [...roles.accent],
				field: [...roles.field]
			},
			morph: new StructureMorph(forceStructure(prismStructure(genome, family)), family, prismLive(genome), salt),
			draft: new MosaicDraft(),
			motion: new PrismMotion(seed),
			choices,
			rig: new PrismCameraRig(seed),
			kick: new HeardKick(),
			flow: new Wander(8, `prism-flow:${salt}`, [37, 53, 29, 71, 43, 61, 97, 131]),
			feel: characterRecord(undefined),
			hurry: 0,
			holdMorph: 0,
			hurryHold: 0,
			fastFades: Object.fromEntries(FOLLOWED.map((name) => [name, false])) as Record<Followed, boolean>,
			eagerFade: Object.fromEntries(FOLLOWED.map((name) => [name, -1])) as Record<Followed, number>,
			morphFast: false,
			feelSettle: 0,
			weightClock: 0,
			pace: { memory: paceRecord(), before: paceRecord(), upgradeFor: 0, primed: false, since: 0 },
			salt,
			voices: new PrismVoices(seed),
			resyncBeat: true
		};
	}

	/** Shape uniforms; the music's fragmentation scales the mosaic live. */
	function writeShape(u: Float32Array, offset: number, comp: PrismComp, frag: number) {
		writeVec4(u, offset, comp.petalWidth, comp.petalReach, comp.cellScale * frag, comp.outerLit);
	}

	function writeGrammar(u: Float32Array, offset: number, comp: PrismComp) {
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
		const ensemble = journey.ensemble;
		const clock = directed.clock;
		const sectionNow = directed.section;
		const family = prismFamily(sectionNow);
		const drive = PRISM_FAMILY_DRIVE[family];
		const phrasePos = clamp(finite(clock.phrasePos), 0, 1);
		const phraseIndex = Math.max(0, Math.floor(finite(clock.phraseIndex)));

		if (journey.sourceEpoch !== rendererSourceEpoch || !run) {
			rendererSourceEpoch = journey.sourceEpoch;
			songSeed = journey.seed;
			// The journey's first source seeds the look and its first picture. A
			// new song only reseeds future mutations: the picture, its clock, its
			// turn, its mosaic draft, its trails and every crossfade carry on. The
			// same source again is a remount and resumes exactly where it was.
			prismEnterSource(lookState, journey.sourceEpoch, songSeed, () => {
				applyLookWeights(journey.character);
				return createRun(songSeed, family, !!feat, directed.context);
			});
			applyLookWeights(journey.character);
			run = lookState.run;
			// A new source answers through the shared shift that follows it;
			// the pace detector waits so the same change is not answered twice.
			// Its music is heard within a second, though: let the character-driven
			// glides hurry from the first frame.
			if (run) {
				run.pace.since = Math.min(run.pace.since, 4);
				run.hurry = Math.max(run.hurry, 0.6);
				run.holdMorph = 1.6;
			}
		}
		const r = run;
		if (!r) return;
		// A look persisted before the ensemble existed (dev reload) gains its voices.
		r.voices ??= new PrismVoices(songSeed);
		const env = r.env;
		const palette = r.palette;
		const motion = r.motion;

		// ── Music character. The look follows what kind of music it is through
		// glides of a second or two, and answers a change of character (a new
		// song, a station moving genre) at once: weights that fit the new music
		// first, then an immediate genome shift, a camera surge, and every
		// smoother hurrying in step. One answer per shift serial, remembered in
		// the look so a remount never answers the same change twice.
		const character = journey.character;
		r.hurryHold = Math.max(0, r.hurryHold - dt);
		if (r.hurryHold <= 0) r.hurry = Math.max(0, r.hurry - dt / 3);
		const pace = r.pace;
		pace.since += dt;
		/** A change of music this frame re-routes the voices too. */
		let reroute = 0;
		const reelAnswer = (strength: number) => {
			genome.shift(Math.max(strength, 0.8), Math.max(env.energy, character.energy));
			r.hurry = Math.max(r.hurry, 0.4 + strength * 0.6);
			r.hurryHold = 2.2;
		};
		const answer = (strength: number) => {
			applyLookWeights(character, palette.hero);
			pullToCharacter(characterRecord(character), 0.5 + strength * 0.4);
			// A change of genre is a new reel, not just a new scene: a clear shift
			// also moves the era (palette family, room, hour). A milder one (the
			// music changing character inside a song) re-sets the scene only,
			// unless the music keeps moving away over the next seconds.
			const reel = strength >= 0.62;
			if (reel) reelAnswer(strength);
			else {
				genome.shift(strength, Math.max(env.energy, character.energy));
				r.hurry = Math.max(r.hurry, 0.5);
				r.hurryHold = 1;
			}
			r.rig.shift(strength);
			reroute = Math.max(reroute, strength);
			r.weightClock = 0;
			r.holdMorph = 0;
			r.feelSettle = 6;
			// Remember what was playing before this change (the memory as it was),
			// then start remembering the new music.
			if (pace.upgradeFor <= 0) Object.assign(pace.before, pace.memory);
			pace.upgradeFor = reel ? 0 : 2.5;
			for (const name of PACE_FEATURES) pace.memory[name] = character[name];
			pace.since = 0;
		};
		if (lookState.answeredShift === null) {
			lookState.answeredShift = character.shiftSerial;
		} else if (character.shiftSerial !== lookState.answeredShift) {
			lookState.answeredShift = character.shiftSerial;
			// Already answered a moment ago by Prism's own pace detector: the
			// look is mid-change, so only refresh the weights for what follows.
			if (pace.since < 3) applyLookWeights(character);
			else answer(clamp(finite(character.shiftStrength, 1), 0, 1));
		} else if (pace.upgradeFor > 0) {
			// A mild answer that turns out to be the start of a whole new piece of
			// music (an early detection, the change still under way): make it a
			// new reel while the first crossfades are still running.
			pace.upgradeFor -= dt;
			if (paceDistance(pace.before, character) > 0.35) {
				applyLookWeights(character, palette.hero);
				reelAnswer(0.8);
				r.rig.shift(0.6);
				pace.upgradeFor = 0;
				localAnswers += 1;
			}
		} else if (feat && pace.primed && pace.since > 10 && character.sinceShift > 4) {
			// A new tempo (or a new weight of beat) is new music even when the
			// timbre stays: answer it the same way, scaled by how far it moved.
			const moved = paceDistance(pace.memory, character, true);
			if (moved > 0.18) {
				answer(clamp(0.45 + (moved - 0.18) * 2, 0.45, 0.9));
				localAnswers += 1;
			}
		}
		if (feat && !silenceHeld(env)) {
			if (!pace.primed) {
				for (const name of PACE_FEATURES) pace.memory[name] = character[name];
				pace.primed = true;
			}
			// Right after an answer the tempo estimate is still re-locking onto
			// the new music; let the memory catch up quickly, then slow down.
			const k = 1 - Math.exp(-dt / (pace.since < 7 ? 1.5 : 20));
			for (const name of PACE_FEATURES) pace.memory[name] += (character[name] - pace.memory[name]) * k;
		}
		// Within a piece the look follows its character slowly (a couple of
		// seconds), so the music's moment-to-moment texture does not churn the
		// glass; answering a change of music it follows within half a second.
		r.feelSettle = Math.max(0, r.feelSettle - dt);
		const feelRate = 0.45 + Math.max(r.hurry * 4, r.feelSettle > 0 ? 2.5 : 0);
		for (const name of CHARACTER_FEATURES) {
			r.feel[name] = approach(r.feel[name], finite(character[name], r.feel[name]), feelRate, dt);
		}
		r.weightClock += dt;
		if (r.weightClock > 1.5 && feat) {
			r.weightClock = 0;
			applyLookWeights(character);
			pullToCharacter(r.feel, 0.06);
		}
		const feel = prismFeel(r.feel);
		const feelForce = forced();
		if (feelForce) {
			for (const key of Object.keys(feel) as (keyof typeof feel)[]) {
				const value = feelForce[key];
				if (value !== undefined) feel[key] = value;
			}
		}
		const glide = Math.max(1, genome.glideSpeed);

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
		// The window's own slow drift (beat-light shapes, division, dust): faster
		// in loud music, never still, never periodic.
		const flow = r.flow.update(dt, 0.7 + env.energy * 0.6);
		// The music sets the glass's temperature; the look's own slow drift
		// leans it, so quiet passages in different songs are not all one cold
		// blue (the lean moves over minutes; a change of music still reads).
		if (feelForce?.temperature === undefined) feel.temperature = clamp(feel.temperature + flow[7] * 0.4, -1, 1);

		// ── The ensemble's voices: each part of the window answers its own
		// instrument (voices.ts). Heard drums only, never the predicted clock.
		const playing = !!feat && !directed.silence && env.silence < 0.5;
		const voice = r.voices.update({ ensemble, dt, live: playing, energy: env.energy, reroute });

		// ── Variety: the genome only moves at phrase and section boundaries and
		// glides from there. Silence holds the look where it is.
		if (feat) {
			genome.advance({ phraseIndex, sectionKey: sectionNow, energy: env.energy, dt });
		}
		// Every discrete axis is shown through a follower that owns its own
		// crossfade, so a retarget mid-fade can never drop a half-shown option.
		// Natural changes (phrase, section, era) take their time; a crossfade
		// that starts while Prism is answering a change of music runs several
		// times faster, and keeps that pace until it lands, so the answer is
		// complete within a few seconds instead of trailing on for half a minute.
		const answering = r.hurry > 0.2;
		for (const name of FOLLOWED) {
			const follower = r.choices[name];
			const target = genome.choice(name).to;
			if (target !== follower.to && answering) {
				r.fastFades[name] = true;
				// The next fade this axis starts is the answering one.
				r.eagerFade[name] = follower.starts + 1;
			}
			if (follower.mix >= 1 && target === follower.to) r.fastFades[name] = false;
			// The camera keeps a longer blend even when hurried: a reframing, not a
			// whip. A section recolouring the glass (roles, guest) drifts in slowly.
			const natural = (FOLLOW_TAU[name] * (name === 'roles' || name === 'guest' ? 2.4 : 1.4)) / glide;
			// Fast, but never a flick: at least 1.6 s (2.6 s for the camera).
			const fast = name === 'camera' ? Math.max(2.6, FOLLOW_TAU[name] * 0.26) : Math.max(1.6, FOLLOW_TAU[name] * 0.17);
			follower.update(target, r.fastFades[name] ? Math.min(fast, natural) : natural, dt);
		}

		// Section choreography: a new structure (grammar, fold, cut, tiers,
		// outline) or a new section family re-sets the window piece by piece in
		// a lit dissolve that washes outward. One morph at a time; a change that
		// lands mid-morph waits for it. A morph that answers a change of music
		// (or that such a change is waiting on) runs at twice the pace.
		const live = prismLive(genome);
		r.holdMorph = Math.max(0, r.holdMorph - dt);
		const held = r.holdMorph > 0;
		const serialBefore = r.morph.serial;
		if (answering && r.morph.morphing) r.morphFast = true;
		r.morph.update(
			held ? r.morph.b : forceStructure(prismStructure(genome, family)),
			held ? r.morph.family : family,
			live,
			// A natural morph (a new section) washes slowly, so the window re-sets
			// region by region; one that answers a change of music runs fast.
			dt * (r.morphFast ? 1.6 : 0.5)
		);
		if (r.morph.serial !== serialBefore) r.morphFast = answering;
		if (!r.morph.morphing) r.morphFast = false;
		const compA = r.morph.a;
		const compB = r.morph.b;
		const morph = r.morph.uniforms();
		const radial = prismGrammarIsRadial(compB.grammar);
		// The glass re-drafts at some phrase ends (irregularly); a phrase-clock jump glides.
		r.draft.update(phraseIndex, phrasePos, dt);

		// Organism: cells divide as the section climbs and a build rises, and
		// breathe on their own slow drift (not a ramp per phrase, which every
		// phrase would repeat). Noisy, punchy music keeps the glass more divided.
		const growthTarget =
			clamp(
				0.08 +
					sectionEnergy * 0.32 +
					directed.drop.buildProgress * 0.22 +
					(0.5 + 0.5 * flow[3]) * 0.22 +
					directed.density * 0.12 +
					feel.divide * 0.45 +
					voice.growth * 0.3,
				0,
				1
			) *
			(1 - env.silence * 0.6);
		env.growth = approach(env.growth, growthTarget, 0.3 * (1 + r.hurry * 3), dt);

		const daylight = prismDaylight(val('timeOfDay'));
		// Quiet passages keep the glass legible (the camera also comes closer
		// in them); loud ones still burn brightest.
		const lightTarget =
			(drive.light * (0.64 + env.energy * 0.51) + directed.drop.anticipation * 0.12) *
			(1 - env.silence * 0.72) *
			daylight.power *
			feel.light;
		// The whole window's light is the slow container (section, energy, the
		// hour); the music shows in its parts, so this only glides.
		env.backlight = approach(env.backlight, lightTarget, 0.6 * (1 + r.hurry * 3), dt);
		env.air = approach(env.air, drive.air * (1 - env.silence * 0.4), 0.8, dt);

		// Heard hits light the glass, each instrument in its own ring: kicks
		// travel the inner ring in the look's beat form, snares crack the middle,
		// hats glint on the outer panes, fills cascade round the rose. Very fast
		// music lands them a little lighter, so 170 bpm reads as a pulse in the
		// glass rather than a strobe.
		r.resyncBeat = false;
		const beatWeight = 1 - 0.35 * smooth01(r.feel.tempo, 0.6, 1);
		const hitGain = beatWeight * response.impact * drive.packet * (1 - env.silence);
		const kickStrength = clamp(voice.kick.strength * (0.6 + env.energy * 0.4) * hitGain, 0, 1.6);
		const beatForm = pick(r, 'beatForm');
		// Kicks as heard give the camera only a small push: the weight of the
		// kick is in the inner ring, not in a whole-frame lurch.
		const hit = r.kick.update(
			dt,
			feat ? finite(spectrum.levels.kick) : 0,
			feat ? finite(spectrum.deltas.kick) : 0,
			feat ? clamp(env.energy * 0.7 + env.rms * 2, 0, 1) * (1 - env.silence) : 0
		);
		if (hit > 0) r.rig.punch(hit * (0.3 + directed.bassPunch * 0.45) * response.motion * 0.25);

		// Suns behind the glass: where they sit and how many are phrase moves.
		// The light itself is a direction: it sets where the shafts fall, and it
		// wanders slowly, so the beams sweep the nave between phrases too.
		const sunAngle = val('sunAngle') * Math.PI * 2;
		const sunX = Math.cos(sunAngle) * 0.2;
		const sunY = 0.06 + Math.sin(sunAngle) * 0.15;
		const sunPower = (0.45 + env.energy * 0.7) * voice.sun.hotspot;
		const lightX = -Math.cos(sunAngle) * 0.42 + 0.14 * noise1(0x11a7, r.salt, motion.clock / 52);
		const lightY = 0.52 + Math.sin(sunAngle) * 0.16 + 0.05 * noise1(0x11a7, r.salt + 1, motion.clock / 77);
		const lightLen = Math.hypot(lightX, lightY, 1);

		// Palette: family (era) and roles (section) crossfade; harmony and
		// energy lean it; the music tempers it (warm or cold, bright or deep,
		// greyed by noise); the result glides, faster right after a shift.
		// The glass also leans slowly in hue inside its family (up to ~25
		// degrees, a rotation that keeps the family's relationships), so a long
		// era never sits on one colour.
		const roles = prismPalette(
			pick(r, 'palette'),
			pick(r, 'roles'),
			val('tint') + flow[6] * 1.8,
			{
				keyPitchClass: directed.context.keyPitchClass,
				keyMinor: directed.context.keyMode === 'minor',
				keyConfidence: directed.context.keyConfidence,
				energy: env.energy
			},
			pick(r, 'guest'),
			smooth01(val('guestMix'), 0.3, 0.75)
		);
		const paletteRate = 1.2 * (1 + r.hurry * 2.5);
		approachRgb(palette.hero, prismTemper(roles.hero, feel), paletteRate, dt);
		approachRgb(palette.support, prismTemper(roles.support, feel), paletteRate, dt);
		approachRgb(palette.accent, prismTemper(roles.accent, feel), paletteRate, dt);
		approachRgb(palette.field, prismTemper(roles.field, feel, 0.4), paletteRate, dt);
		// The light behind the glass takes the music's temperature too.
		const sky = prismTemper(daylight.color, { temperature: feel.temperature * 0.7, value: 1, saturation: 1 }, 1);

		// The rose turns with the shared trace phase (music-driven, stops in
		// silence) plus a slow sway. The look integrates the phase's increments
		// on its own clock, so a new song (whose phase and timeline restart)
		// and a remount both carry the pose on.
		motion.update({
			tracePhase: journey.signal.tracePhase,
			dt,
			motion: response.motion * voice.turn,
			energy: env.energy,
			silence: env.silence
		});
		const tSec = motion.clock;
		const rotationDelta = clamp(motion.rotation - motion.previousRotation, -0.02, 0.02);

		// ── Camera: always roaming. The regime crossfade blends two regions of
		// viewpoint space under one roaming shot; tempo sets the roam rate, a
		// shift redirects and surges it, heard kicks push it.
		const spacing = prismBaySpacing(val('baySpacing'));
		const camSide = val('camSide');
		const camera = pick(r, 'camera');
		const cam = r.rig.update({
			// Lab diagnostics can hold the shot (window.__PRISM_FORCE__.camFreeze).
			dt: forced()?.camFreeze ? 0 : dt,
			regime: camera,
			side: camSide,
			focus: val('camFocus'),
			drift: val('camDrift'),
			spacing,
			tempo: r.feel.tempo,
			energy: clamp(env.energy * 0.75 + (voice.cameraRestless - 0.5) * 0.5, 0, 1),
			silence: env.silence,
			motion: response.motion
		});
		const basis = prismCameraBasis(cam);
		const anchorX = r.rig.anchorBay * spacing;
		const heroCentre = prismProject(basis, [anchorX, PRISM_ROSE_Y, 0]) ?? [0, 4];
		const heroEdge = prismProject(basis, [anchorX + PRISM_ROSE_R, PRISM_ROSE_Y, 0]);
		const heroRadius = heroEdge ? Math.max(0.02, Math.hypot(heroEdge[0] - heroCentre[0], heroEdge[1] - heroCentre[1])) : 0.32;
		// Trails follow the rose's turn only when the camera sees it square-on.
		const squareOn = Math.pow(Math.cos(cam.yaw), 6) * Math.pow(Math.cos(cam.pitch), 2);
		const trailTurn = radial ? rotationDelta * squareOn : 0;

		// ── World: the building, the hour, the weather, the air.
		const environment = pick(r, 'environment');
		const rain = smooth01(val('rain'), 0.55, 0.9);
		const wetness = clamp(Math.max(val('wetness') * 0.55, cam.wet, rain * 0.85), 0, 1);
		const sideShaft = smooth01(val('sideShaft'), 0.35, 0.95);
		const roomWeight = (index: number) =>
			(environment.from === index ? 1 - environment.mix : 0) + (environment.to === index ? environment.mix : 0);
		const arcade = [0, 0, 0, 0];
		PRISM_ENVIRONMENTS.forEach((name, index) => {
			const weight = roomWeight(index);
			if (weight <= 0) return;
			const params = ARCADE[name];
			for (let k = 0; k < 4; k++) arcade[k] += params[k] * weight;
		});
		// Haze: the music's own (thick and soft for slow quiet music, gritty for
		// noise) times the section's fog; it thins in silence but never clears.
		const haze = (0.1 + feel.haze * 0.55) * (0.55 + val('fog') * 0.9) * (1 - env.silence * 0.3);
		const dust = clamp((val('dust') * 0.45 + feel.dust * 0.65) * voice.dust.density, 0, 1.6);
		const shaftPower = (0.45 + env.energy * 0.55) * daylight.power * (1 - env.silence * 0.5) * voice.sun.power;
		// The clerestory light comes from behind the camera on the side away
		// from the camera's wall, so its beams cross the nave toward the glass.
		const sideX = -prismSoftSign(camSide) * 0.32 + val('shaftAngle') * 0.25;
		const sideLen = Math.hypot(sideX, 0.62, 0.8);
		const sideStrength = sideShaft * (0.25 + env.energy * 0.4) * (1 - env.silence * 0.6) * voice.clerestory;

		// Post: trails lengthen with legato and shorten in silence; the bloom
		// knee drops with energy so peaks glow and quiet sections stay graphic;
		// punchy music keeps a higher knee so edges stay crisp. No whole-frame
		// beat pulse: the trails and the lens never flash on a hit. History is
		// only cleared for fresh render targets (a resize or a new canvas).
		const historyValid = feedbackResetFrames > 0 || !prevBasis ? 0 : 1;
		const feedbackFade =
			feedbackResetFrames > 0
				? 0
				: clamp(
						(0.86 + env.energy * 0.05 + voice.trails * 0.08 + response.feedbackFadeOffset) *
							(1 - env.silence * 0.3),
						0.4,
						0.95
					);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		const feedbackZoom = 1 - (0.0012 + env.bass * 0.0022) * response.motion;
		const bloomThreshold = 0.82 - env.energy * 0.18 + feel.edge * 0.08 + response.bloomThresholdOffset;
		const aberration = 1 + env.energy * 0.3;
		const prev = prevBasis ?? basis;

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
		u[8] = 0;
		u[9] = bloomThreshold;
		u[10] = feedbackFade;
		u[11] = motion.rotation;
		u[12] = feedbackZoom;
		u[13] = 1;
		fadeIn = Math.min(1, fadeIn + dt / 2.5);
		u[14] = fadeIn * fadeIn * (3 - 2 * fadeIn);
		u[15] = clamp(finite(clock.beatPhase), 0, 1);
		u[16] = clamp(finite(directed.context.keyPitchClass), 0, 1);
		u[17] = clamp(finite(directed.context.keyConfidence), 0, 1);
		u[18] = clamp((finite(clock.tempoBpm) - 60) / 120, 0, 1);
		u[19] = songSeed;
		u[20] = forced()?.debugView ?? 0;
		u[21] = 1;
		u[22] = journey.signal.tracePhase;
		u[23] = sectionEnergy;
		writeVec4(u, O.comp, compA.fold, compB.fold, morph.front, morph.glow);
		writeShape(u, O.shapeA, compA, feel.frag);
		writeShape(u, O.shapeB, compB, feel.frag);
		writeGrammar(u, O.gramA, compA);
		writeGrammar(u, O.gramB, compB);
		writeVec4(u, O.detail, clamp(live.tracery * 0.5 + feel.weight * 0.6, 0, 1), live.cusp, live.sprinkle, Math.min(5, cam.bays + voice.bays.spread));
		writeVec4(u, O.organism, env.growth, r.draft.phrase, r.draft.mix, r.salt);
		writeVec4(u, O.light, env.backlight, kickStrength, voice.kick.progress, voice.kick.serial);
		writeVec4(u, O.modes, beatForm.from, beatForm.to, beatForm.mix, family === 'drift' ? 1 : 0);
		writeVec4(u, O.sun, sunX, sunY, sunPower, env.air);
		writeVec4(u, O.heroCol, ...palette.hero, 0);
		writeVec4(u, O.supportCol, ...palette.support, 0);
		writeVec4(u, O.accentCol, ...palette.accent, 0);
		writeVec4(u, O.fieldCol, ...palette.field, 0);
		writeVec4(u, O.post, feedbackFade, feedbackZoom, bloomThreshold, aberration);
		writeVec4(u, O.env, flow[4] * 0.04, flow[5], env.silence, motion.rotation);
		writeVec4(u, O.bands, env.bass, env.mid, env.treble, 0);
		writeVec4(u, O.motion, trailTurn, frameIndex % 60, env.energy, regimeExposure(camera, environment, env.energy, { region: r.rig.excursion, away: r.rig.away }));
		writeVec4(u, O.camPos, basis.pos[0], basis.pos[1], basis.pos[2], basis.focal);
		writeVec4(u, O.camRight, basis.right[0], basis.right[1], basis.right[2], spacing);
		writeVec4(u, O.camUp, basis.up[0], basis.up[1], basis.up[2], 0);
		writeVec4(u, O.camFwd, basis.fwd[0], basis.fwd[1], basis.fwd[2], wetness);
		writeVec4(u, O.roseScreen, heroCentre[0], heroCentre[1], heroRadius, 0);
		writeVec4(u, O.world, environment.from, environment.to, environment.mix, rain);
		writeVec4(u, O.sky, sky[0], sky[1], sky[2], daylight.night);
		writeVec4(u, O.atmos, val('fog'), dust, val('caustics'), val('sunCount'));
		writeVec4(u, O.shaft, sideShaft, val('shaftAngle'), -prismSoftSign(camSide) * 0.7, flow[0]);
		writeVec4(u, O.morph, compA.salt, compB.salt, morph.globalMix, flow[1]);
		writeVec4(u, O.prevPos, prev.pos[0], prev.pos[1], prev.pos[2], historyValid);
		writeVec4(u, O.prevRight, prev.right[0], prev.right[1], prev.right[2], 0);
		writeVec4(u, O.prevUp, prev.up[0], prev.up[1], prev.up[2], 0);
		writeVec4(u, O.prevFwd, prev.fwd[0], prev.fwd[1], prev.fwd[2], 0);
		writeVec4(u, O.sunDir, lightX / lightLen, lightY / lightLen, 1 / lightLen, shaftPower);
		writeVec4(u, O.vol, haze, 0.55 + feel.edge * 0.2, dust, 0.9 + env.energy * 0.4);
		writeVec4(u, O.lightBox, anchorX - 3.6, PRISM_FLOOR_Y - 0.01, 7.2, 1.35);
		writeVec4(u, O.arcade, arcade[0], arcade[1], arcade[2], arcade[3]);
		writeVec4(u, O.side, sideX / sideLen, 0.62 / sideLen, -0.8 / sideLen, sideStrength);
		writeVec4(u, O.feel, clamp(feel.edge * 0.7 + (voice.tracery.edge - 0.5) * 0.6, 0, 1), roomWeight(2), 0.22, frameIndex % 64);
		writeVec4(u, O.rig, anchorX, dt, r.rig.kick, flow[2]);
		const rings = voice.rings;
		const prevRings = voice.ringsPrev;
		writeVec4(u, O.ringPrevIn, prevRings[0].hue, prevRings[0].warmth, prevRings[0].sat, prevRings[0].value);
		writeVec4(u, O.ringPrevMid, prevRings[1].hue, prevRings[1].warmth, prevRings[1].sat, prevRings[1].value);
		writeVec4(u, O.ringPrevOut, prevRings[2].hue, prevRings[2].warmth, prevRings[2].sat, prevRings[2].value);
		writeVec4(u, O.ringSweep, voice.ringSweep[0], voice.ringSweep[1], voice.ringSweep[2], 0);
		writeVec4(u, O.ringStart, voice.ringStart[0], voice.ringStart[1], voice.ringStart[2], 0);
		writeVec4(u, O.ringIn, rings[0].hue, rings[0].warmth, rings[0].sat, rings[0].value);
		writeVec4(u, O.ringMid, rings[1].hue, rings[1].warmth, rings[1].sat, rings[1].value);
		writeVec4(u, O.ringOut, rings[2].hue, rings[2].warmth, rings[2].sat, rings[2].value);
		writeVec4(u, O.ringLight, voice.ringLight[0], voice.ringLight[1], voice.ringLight[2], voice.petalContrast);
		const chroma = voice.chroma;
		writeVec4(u, O.chromaA, chroma[0], chroma[1], chroma[2], chroma[3]);
		writeVec4(u, O.chromaB, chroma[4], chroma[5], chroma[6], chroma[7]);
		writeVec4(u, O.chromaC, chroma[8], chroma[9], chroma[10], chroma[11]);
		writeVec4(u, O.snarePk, clamp(voice.snare.strength * hitGain, 0, 1.4), voice.snare.progress, voice.snare.serial, voice.snare.angle);
		writeVec4(u, O.hatPk, clamp(voice.hat.strength * hitGain, 0, 1.4), voice.hat.progress, voice.hat.serial, voice.hat.density);
		writeVec4(u, O.fillPk, clamp(voice.fill.strength * hitGain, 0, 1.4), voice.fill.progress, voice.fill.angle, voice.fill.direction);
		writeVec4(u, O.low, voice.low.x, voice.low.z, voice.low.power, voice.low.haze);
		writeVec4(u, O.parts, voice.bays.left, voice.bays.right, voice.hazeHigh, voice.caustic);
		writeVec4(u, O.parts2, voice.dust.glint * (1 - env.silence), voice.candles, voice.tracery.glow, voice.swingLean);
		const flare = voice.bayFlare;
		writeVec4(u, O.bayPk, flare.left * (1 - env.silence), flare.right * (1 - env.silence), flare.leftAngle, flare.rightAngle);
		writeVec4(u, O.arcs, voice.kick.angle, voice.kick.width, voice.hat.angle, voice.hat.width);
		writeVec4(u, O.notePk, clamp(voice.note.strength * (1 - env.silence) * response.impact, 0, 1.4), voice.note.progress, voice.note.fifths, voice.withdraw);
		prevBasis = basis;
		frameIndex += 1;

		g.device.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		g.device.queue.writeBuffer(g.binsBuf, 0, bins.buffer, bins.byteOffset, bins.byteLength);

		hudSection = directed.section;
		hudFold = compB.fold;
		hudLook = [
			PRISM_GRAMMARS[compB.grammar],
			PRISM_CAMERAS[camera.to],
			PRISM_PALETTES[pick(r, 'palette').to].name,
			PRISM_ENVIRONMENTS[environment.to]
		].join(' ');
		if (frameIndex % (forced()?.debugEvery ?? 15) === 0) {
			hudDebug = [
				`cam ${PRISM_CAMERAS[camera.from]}>${PRISM_CAMERAS[camera.to]}@${camera.mix.toFixed(2)} pal ${PRISM_PALETTES[pick(r, 'palette').from].name}>${PRISM_PALETTES[pick(r, 'palette').to].name}@${pick(r, 'palette').mix.toFixed(2)} env ${environment.from}>${environment.to}@${environment.mix.toFixed(2)} morph ${morph.front.toFixed(2)}`,
				`travel ${r.rig.travel.toFixed(2)} rate ${r.rig.rate.toFixed(3)} surge ${r.rig.surge.toFixed(2)} away ${PRISM_CAMERAS[r.rig.excursion]}@${r.rig.away.toFixed(2)}`,
				`shift ${lookState.answeredShift}+${localAnswers} hurry ${r.hurry.toFixed(2)} pace ${PACE_FEATURES.map((name) => r.pace.memory[name].toFixed(2)).join(',')}`,
				`temp ${feel.temperature.toFixed(2)} frag ${feel.frag.toFixed(2)} haze ${haze.toFixed(2)}`,
				`pose ${[cam.yaw, cam.pitch, cam.roll, cam.dist, cam.tx, cam.ty].map((v) => v.toFixed(3)).join(',')}`,
				`hero ${heroCentre[0].toFixed(2)},${heroCentre[1].toFixed(2)},${heroRadius.toFixed(2)}`
			].join(' | ');
		}

		// ── Render graph: light map → scene → air → feedback → exposure →
		// prefilter → 2× (H, V) blur → present
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
		fullscreen('Prism light map', t.lightmapView, g.pipelines.lightmap, bg.lightmap, 6);
		fullscreen(
			'Prism scene',
			t.sceneView,
			g.pipelines.scenes[selectedPreset],
			bg.scenes[selectedPreset],
			6
		);
		fullscreen('Prism air', t.volumeView[next], g.pipelines.volume, bg.volume[previous], 3);
		fullscreen('Prism feedback', t.feedbackView[next], g.pipelines.feedback, bg.feedback[previous], 3);
		fullscreen('Prism exposure', t.exposureView[next], g.pipelines.exposure, bg.exposure[next], 3);
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
				fadeIn = 0;
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
			data-prism-debug={hudDebug}
			data-prism-ready={String(ready)}
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-6 z-20 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
