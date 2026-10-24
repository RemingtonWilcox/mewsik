<script lang="ts">
	// Soma: a living animal in real 3D water. One raymarched body plan whose
	// anatomy metamorphoses between species grammars (medusa, siphonophore,
	// comb jelly, radiolarian, venus girdle, nudibranch, mycelial bloom, polyp
	// colony, lantern pod, salp chain, cell colony, pyrosome), lit by its own
	// bioluminescence in an analytic world (abyss, vent field, kelp cathedral,
	// bioluminescent bay, ice cave, void) and filmed by a diver-like camera.
	// The look lives in the shared journey (persistentLook 'soma'), so a
	// remount resumes exactly and a new song continues instead of restarting.
	import { onMount, onDestroy } from 'svelte';
	import { VISUALIZER_TUNING, useVisualizer } from '$lib/state/visualizer.svelte';
	import {
		SOMA_QUALITY_PROFILES,
		SomaAutoQualityController,
		selectSomaQuality,
		somaBackingSize,
		somaFrameStride,
		somaSceneSize,
		type SomaQualityProfile,
		type SomaQualityTier
	} from '$lib/visualizer/mk2/runtime';
	import {
		SOMA_BIN_COUNT,
		SOMA_BLOOM_DOWN_WGSL,
		SOMA_BLUR_H_WGSL,
		SOMA_BLUR_V_WGSL,
		SOMA_COMPOSITE_WGSL,
		SOMA_FEEDBACK_WGSL,
		SOMA_SCENE_WGSL,
		SOMA_UNIFORM_BYTES,
		SOMA_UNIFORM_FLOATS,
		SOMA_UNIFORM_OFFSETS as O,
		type SomaUniformField
	} from '$lib/visualizer/mk2/shaders';
	import { createSomaLookState, somaSyncLook, type SomaFrame } from '$lib/visualizer/mk2/look';
	import { SOMA_ANATOMY_INDEX, SOMA_ANATOMY_SLOTS } from '$lib/visualizer/mk2/species';
	import { SOMA_PART_SLOTS } from '$lib/visualizer/mk2/parts';

	const vis = useVisualizer();

	const RENDER_PASSES = 8;
	const BINS_BYTES = SOMA_BIN_COUNT * 4;
	const DOF_TAPS: Record<SomaQualityTier, number> = { eco: 6, balanced: 10, ultra: 14 };
	const TIER_INDEX: Record<SomaQualityTier, number> = { eco: 0, balanced: 1, ultra: 2 };

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let ready = $state(false);
	let hudSection = $state('calm');
	let hudForm = $state('dormancy');
	let hudSpecies = $state('');
	let hudEnvironment = $state('');
	let hudPalette = $state('');
	let hudCamera = $state('');
	let qualityTier = $state<SomaQualityTier>('ultra');
	let renderStride = $state(1);
	let measuredRefreshRate = $state(60);
	let renderPixels = $state(0);
	let gpuSceneMs = $state(0);
	let gpuPostMs = $state(0);
	let cpuMs = 0;
	let cpuShown = $state(0);
	let raf = 0;
	let unsub: (() => void) | null = null;
	let running = false;
	let initVersion = 0;
	let initializing = false;

	// The look: the animal, its world and the camera, owned by the journey.
	const lookState = vis.persistentLook('soma', createSomaLookState);
	// Dev-only handle for QA scripts that log the look over time.
	if (import.meta.env.DEV) (globalThis as { __SOMA_LOOK__?: unknown }).__SOMA_LOOK__ = lookState;
	let rendererSourceEpoch = -1;

	// Note levels (fast attack) and onsets (positive spectral detail), uploaded per frame.
	const bins = new Float32Array(SOMA_BIN_COUNT);

	let feedbackResetFrames = 2;
	let frameIndex = 0;
	/** 0..1 after a fresh GPU start: the picture fades up instead of popping in. */
	let fadeIn = 0;

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
		scene: GPUBindGroup;
		feedback: [GPUBindGroup, GPUBindGroup];
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
			scene: GPURenderPipeline;
			feedback: GPURenderPipeline;
			bloomDown: GPURenderPipeline;
			blurH: GPURenderPipeline;
			blurV: GPURenderPipeline;
			composite: GPURenderPipeline;
		};
		targets: Targets | null;
		bindGroups: BindGroups | null;
		parity: 0 | 1;
		timer: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null;
	};

	let gpu: GPU | null = null;

	// ── Frame pacing and quality: whole-vsync strides, a slow governor.
	let qualityProfile: SomaQualityProfile = SOMA_QUALITY_PROFILES.ultra;
	const autoQuality = new SomaAutoQualityController(qualityProfile.tier);
	let autoQualityCeiling: SomaQualityTier | null = null;
	let schedulerTickAt = 0;
	let refreshIntervalMs = 1000 / 60;
	let activeFrameStride = 1;
	let framesUntilRender = 0;
	let lastRenderedAt = 0;

	function clamp(value: number, low: number, high: number) {
		return Math.min(high, Math.max(low, value));
	}

	function finite(value: number, fallback = 0) {
		return Number.isFinite(value) ? value : fallback;
	}

	function smooth01(value: number, low: number, high: number) {
		const t = clamp((value - low) / (high - low), 0, 1);
		return t * t * (3 - 2 * t);
	}

	function resetFrameScheduler() {
		schedulerTickAt = 0;
		framesUntilRender = 0;
		lastRenderedAt = 0;
	}

	function observeDisplayCadence(tickElapsedMs: number) {
		if (tickElapsedMs < 1000 / 360 || tickElapsedMs > 1000 / 24) return;
		if (tickElapsedMs < refreshIntervalMs * 0.8) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.38;
		} else if (tickElapsedMs <= refreshIntervalMs * 1.35) {
			refreshIntervalMs += (tickElapsedMs - refreshIntervalMs) * 0.08;
		}
		const nextRefreshRate = Math.round(1000 / refreshIntervalMs);
		if (nextRefreshRate !== measuredRefreshRate) measuredRefreshRate = nextRefreshRate;
	}

	function updateQualityProfile(elapsedMs: number | null): SomaQualityProfile {
		if (!canvas) return qualityProfile;
		const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
		const initial = selectSomaQuality(
			canvas.clientWidth,
			canvas.clientHeight,
			window.devicePixelRatio || 1,
			navigator.hardwareConcurrency,
			deviceMemory
		);
		let sampleMs = elapsedMs;
		if (autoQualityCeiling === null) {
			autoQuality.reset(initial.tier);
			autoQualityCeiling = initial.tier;
			sampleMs = null;
		} else if (initial.tier !== autoQualityCeiling) {
			autoQuality.setCeiling(initial.tier);
			autoQualityCeiling = initial.tier;
			sampleMs = null;
		}
		if (sampleMs !== null && document.visibilityState === 'visible') autoQuality.observeFrame(sampleMs);
		const pinned = import.meta.env.DEV ? (globalThis as { __SOMA_QUALITY__?: SomaQualityTier }).__SOMA_QUALITY__ : undefined;
		const active = pinned && pinned in SOMA_QUALITY_PROFILES ? SOMA_QUALITY_PROFILES[pinned] : autoQuality.profile;
		if (active.tier !== qualityProfile.tier) {
			qualityProfile = active;
			qualityTier = active.tier;
			resetFrameScheduler();
		}
		return qualityProfile;
	}

	// ── GPU resources
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
		const scene = createTarget(device, 'Soma scene', w, h);
		const feedback: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Soma feedback A', w, h),
			createTarget(device, 'Soma feedback B', w, h)
		];
		const bloom: [GPUTexture, GPUTexture] = [
			createTarget(device, 'Soma bloom A', halfW, halfH),
			createTarget(device, 'Soma bloom B', halfW, halfH)
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
				entries: [uniform, samplerEntry, ...views.map((view, index) => ({ binding: 2 + index, resource: view }))]
			});
		g.bindGroups = {
			scene: device.createBindGroup({
				label: 'Soma scene',
				layout: pipelines.scene.getBindGroupLayout(0),
				entries: [uniform, { binding: 1, resource: { buffer: binsBuf } }]
			}),
			feedback: [
				bind(pipelines.feedback, 'Soma feedback reads A', [t.sceneView, t.feedbackView[0]]),
				bind(pipelines.feedback, 'Soma feedback reads B', [t.sceneView, t.feedbackView[1]])
			],
			bloomDown: [
				bind(pipelines.bloomDown, 'Soma bloom prefilter A', [t.feedbackView[0]]),
				bind(pipelines.bloomDown, 'Soma bloom prefilter B', [t.feedbackView[1]])
			],
			blurH: bind(pipelines.blurH, 'Soma bloom blur H', [t.bloomView[0]]),
			blurV: bind(pipelines.blurV, 'Soma bloom blur V', [t.bloomView[1]]),
			composite: [
				bind(pipelines.composite, 'Soma present A', [t.feedbackView[0], t.bloomView[0]]),
				bind(pipelines.composite, 'Soma present B', [t.feedbackView[1], t.bloomView[0]])
			]
		};
		// Fresh history textures are undefined: never let a stale trail bleed in.
		// (A resize resets the trails; a new song never does.)
		feedbackResetFrames = 2;
	}

	async function initGpu(c: HTMLCanvasElement): Promise<GPU> {
		const gpuApi = navigator.gpu;
		if (!gpuApi) throw new Error('Soma needs WebGPU, but this WebView does not expose it.');
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
		// Dev builds time the scene and post passes when the adapter allows it.
		const timing = import.meta.env.DEV && adapter.features.has('timestamp-query');
		const device = (await adapter.requestDevice(timing ? { requiredFeatures: ['timestamp-query'] } : undefined)) as GPUDevice;
		let context: GPUCanvasContext | null = null;
		let uniformBuf: GPUBuffer | null = null;
		let binsBuf: GPUBuffer | null = null;
		try {
			context = c.getContext('webgpu') as unknown as GPUCanvasContext | null;
			if (!context) throw new Error('The WebGPU canvas context could not be created.');
			const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
			context.configure({ device, format, alphaMode: 'opaque' });
			const sources: [string, string][] = [
				['Soma scene', SOMA_SCENE_WGSL],
				['Soma feedback', SOMA_FEEDBACK_WGSL],
				['Soma bloom prefilter', SOMA_BLOOM_DOWN_WGSL],
				['Soma bloom blur H', SOMA_BLUR_H_WGSL],
				['Soma bloom blur V', SOMA_BLUR_V_WGSL],
				['Soma presentation', SOMA_COMPOSITE_WGSL]
			];
			const modules = sources.map(([label, code]) => device.createShaderModule({ label, code }));
			await Promise.all(
				modules.map(async (module, index) => {
					const info = await module.getCompilationInfo();
					const errors = info.messages.filter((message) => message.type === 'error');
					if (errors.length) {
						const detail = errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join(' | ');
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
				pipeline('Soma scene pipeline', modules[0], hdr),
				pipeline('Soma feedback pipeline', modules[1], hdr),
				pipeline('Soma bloom prefilter pipeline', modules[2], hdr),
				pipeline('Soma blur H pipeline', modules[3], hdr),
				pipeline('Soma blur V pipeline', modules[4], hdr),
				pipeline('Soma presentation pipeline', modules[5], format)
			]);
			uniformBuf = device.createBuffer({ size: SOMA_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
			binsBuf = device.createBuffer({ size: BINS_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
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
				uniformData: new Float32Array(SOMA_UNIFORM_FLOATS),
				pipelines: {
					scene: built[0],
					feedback: built[1],
					bloomDown: built[2],
					blurH: built[3],
					blurV: built[4],
					composite: built[5]
				},
				targets: null,
				bindGroups: null,
				parity: 0,
				timer: timing
					? {
							set: device.createQuerySet({ type: 'timestamp', count: 3 }),
							resolve: device.createBuffer({ size: 24, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
							read: device.createBuffer({ size: 24, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
							busy: false
						}
					: null
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
		state.timer?.set.destroy();
		state.timer?.resolve.destroy();
		state.timer?.read.destroy();
		try {
			state.context.unconfigure();
		} catch {
			// The device may already be lost.
		}
		state.device.destroy();
	}

	function teardownGpu() {
		resetFrameScheduler();
		const state = gpu;
		gpu = null;
		ready = false;
		destroyGpuState(state);
	}

	// ── Uniform packing
	function put(u: Float32Array, name: SomaUniformField, a: number, b = 0, c = 0, d = 0) {
		const offset = O[name];
		u[offset] = finite(a);
		u[offset + 1] = finite(b);
		u[offset + 2] = finite(c);
		u[offset + 3] = finite(d);
	}

	function put3(u: Float32Array, name: SomaUniformField, v: readonly number[], w = 0) {
		put(u, name, v[0], v[1], v[2], w);
	}

	/** World point to output uv, matching the shader's lens. */
	function projectUv(f: SomaFrame, aspect: number, x: readonly number[]): [number, number, number] {
		const c = f.camera3;
		const v = [x[0] - c.pos[0], x[1] - c.pos[1], x[2] - c.pos[2]];
		const z = v[0] * c.fwd[0] + v[1] * c.fwd[1] + v[2] * c.fwd[2];
		const zz = Math.max(z, 1e-3);
		const px = ((v[0] * c.right[0] + v[1] * c.right[1] + v[2] * c.right[2]) / zz) * c.focal + c.shiftX;
		const py = ((v[0] * c.up[0] + v[1] * c.up[1] + v[2] * c.up[2]) / zz) * c.focal + c.shiftY;
		return [px / aspect + 0.5, 0.5 - py, z];
	}

	// Dev-only look override for captures: window.__SOMA_FORCE__ = { species: 4, environment: 2, ... }.
	type SomaForce = Partial<Record<string, number>>;
	function forced(): SomaForce | null {
		if (!import.meta.env.DEV) return null;
		return (globalThis as { __SOMA_FORCE__?: SomaForce }).__SOMA_FORCE__ ?? null;
	}

	function renderFrame(g: GPU, now: number, dt: number, profile: SomaQualityProfile) {
		if (!canvas) return;
		const backing = somaBackingSize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, profile);
		if (canvas.width !== backing.width || canvas.height !== backing.height) {
			canvas.width = backing.width;
			canvas.height = backing.height;
		}
		const sceneSize = somaSceneSize(backing.width, backing.height, profile);
		if (renderPixels !== sceneSize.width * sceneSize.height) renderPixels = sceneSize.width * sceneSize.height;
		ensureTargets(g, sceneSize.width, sceneSize.height);
		const t = g.targets;
		const bg = g.bindGroups;
		if (!t || !bg) return;

		// One freshness-checked snapshot for the whole frame, sampled on the feature clock.
		const sampleAt = Math.max(now, performance.now());
		const feat = vis.getLatest(sampleAt);
		const journey = vis.getJourney(sampleAt);
		const tuning = VISUALIZER_TUNING.mk2;
		const look = lookState.look;
		if (journey.sourceEpoch !== rendererSourceEpoch) {
			rendererSourceEpoch = journey.sourceEpoch;
			// -1: first source of the session resets; another epoch reseeds (the
			// animal carries on into the new song); the same epoch resumes.
			somaSyncLook(lookState, journey.sourceEpoch, journey.seed);
		}
		look.setForce(forced());
		const aspect = backing.width / Math.max(1, backing.height);
		const f = look.update({
			director: journey.director,
			spectrum: journey.spectrum,
			mk2: journey.mk2,
			live: !!feat,
			dt,
			aspect,
			motionScale: tuning.motion,
			impactScale: tuning.impact,
			character: journey.character,
			ensemble: journey.ensemble
		});

		// Notes: levels with a fast attack, onsets from positive spectral detail.
		const incoming = feat?.bins ?? [];
		const detail = journey.spectrum.detailBins;
		// Calm music lets the notes swell and fade slowly; everything else stays tight.
		const calm = f.mood.calm;
		const rise = 1 - Math.exp(-dt / (0.03 + calm * 0.25));
		const fall = 1 - Math.exp(-dt / (0.22 + calm * 0.6));
		for (let i = 0; i < 64; i += 1) {
			const level = clamp(finite(incoming[i] ?? 0), 0, 1);
			bins[i] += (level - bins[i]) * (level > bins[i] ? rise : fall);
			const hit = clamp(finite(detail?.[i] ?? 0) * 2.2, 0, 1);
			bins[64 + i] = Math.max(hit, bins[64 + i] * Math.exp(-dt / 0.18));
		}

		const m = f.motion;
		const env = f.env;
		// The whole frame is no longer a dial the music turns: bloom, aberration
		// and exposure stay with the world (and silence), and only the trails
		// follow the articulation (legato long, staccato short). The music shows
		// in the organs and the water's parts instead.
		const legato = look.partsArticulation;
		const slowEnergy = f.mood.energy;
		const feedbackFade =
			feedbackResetFrames > 0 ? 0 : clamp((0.76 + legato * 0.14) * (1 - m.silence * 0.25), 0.35, 0.92);
		if (feedbackResetFrames > 0) feedbackResetFrames -= 1;
		// The kind of music (glided, fast after a genre change) still sets the
		// container: calm music opens the exposure, a pulsing groove lowers the
		// bloom knee, agitation sharpens the lens. Never the moment's loudness.
		const md = f.mood;
		const bloomThreshold = 0.7 - md.pulse * 0.1 - md.agitation * 0.06;
		const bloomGain = 0.5 + md.pulse * 0.12;
		const aberration = 1 + md.agitation * 0.8;
		fadeIn = Math.min(1, fadeIn + dt / 1.2);
		const exposure = env.exposure * (1.08 + 0.16 * md.calm - 0.06 * md.agitation) * (1 - m.silence * 0.2) * smooth01(fadeIn, 0, 1);

		const u = g.uniformData;
		const c = f.camera3;
		const o = f.organism;
		const a = f.anatomy;
		put(u, 'frame', sceneSize.width, sceneSize.height, f.time, frameIndex % 1024);
		put(u, 'outp', backing.width, backing.height, aspect, TIER_INDEX[profile.tier]);
		put(u, 'audio', m.bass, m.mid, m.treble, slowEnergy);
		put(u, 'beat', m.packetPhase, m.contraction, m.packet, m.impact);
		put(u, 'beat2', m.kick, m.sparkle, m.silence, m.beatCount % 4096);
		put3(u, 'camPos', c.pos, c.focal);
		put3(u, 'camRight', c.right, c.focusDist);
		put3(u, 'camUp', c.up, c.aperture);
		put3(u, 'camFwd', c.fwd, DOF_TAPS[profile.tier]);
		put(u, 'lens', c.shiftX, c.shiftY, env.fog * tuning.fog, exposure);
		put3(u, 'orgPos', o.pos, o.boundRadius);
		put3(u, 'orgX', o.axisX, m.sway);
		put3(u, 'orgY', o.axisY, m.fin);
		put3(u, 'orgZ', o.axisZ, m.growth);
		put3(u, 'orgBound', o.boundCenter, a[SOMA_ANATOMY_INDEX.size]);
		let lane = 0;
		for (const [name, lanes] of SOMA_ANATOMY_SLOTS) {
			const at = (i: number) => (i < lanes ? a[lane + i] : 0);
			put(u, name as SomaUniformField, at(0), at(1), at(2), at(3));
			lane += lanes;
		}
		// The app slot's two spare lanes carry integrated phases (water current,
		// comb-row light) so the shader never animates on time * constant.
		u[O.app + 2] = finite(f.flow.current);
		u[O.app + 3] = finite(f.flow.comb);
		put(u, 'counts', f.lobes, smooth01(f.lobeFade, 0, 1), f.arms, smooth01(f.armFade, 0, 1));
		put(u, 'modes', f.beatForm.from, f.beatForm.to, f.beatForm.mix, m.shed);
		put(u, 'env', f.environment.from, f.environment.to, f.environment.mix, env.floorY);
		// The mirror is the seabed, or in the bay the underside of the surface; it
		// fades out at the hand-over so the plane never jumps.
		const bayIndex = 3;
		const wBay =
			(f.environment.from === bayIndex ? 1 - f.environment.mix : 0) + (f.environment.to === bayIndex ? f.environment.mix : 0);
		const mirrorSurface = wBay > 0.5;
		const mirrorFade = Math.abs(wBay - 0.5) * 2;
		put(u, 'envB', env.surfaceY, env.reflect * mirrorFade, env.snow, env.shafts * tuning.shafts);
		put3(u, 'keyDir', env.keyDir, env.keyPower * (1 - m.silence * 0.3));
		put3(u, 'keyCol', f.keyColor, env.ambient);
		put3(u, 'water', f.colors.water);
		put3(u, 'haze', f.colors.haze);
		put3(u, 'bodyCol', f.colors.body);
		put3(u, 'glow', f.colors.glow);
		put3(u, 'accent', f.colors.accent);
		put3(u, 'organ', f.colors.organ);
		put(u, 'post', feedbackFade, bloomThreshold, aberration, bloomGain);
		const orgUv = projectUv(f, aspect, o.boundCenter);
		put(u, 'orgScreen', orgUv[0], orgUv[1], env.layerY, env.layer);
		put(u, 'mood', md.agitation, md.punch, md.calm, md.pulse);
		// The water as a medium: per-channel extinction, and how much daylight reaches this depth.
		const fog = env.fog * tuning.fog;
		put(u, 'medium', fog * env.absorb[0], fog * env.absorb[1], fog * env.absorb[2], env.down);
		put(u, 'flow', f.flow.snow, f.flow.light, f.flow.life, f.flow.shiver);
		put(u, 'march', profile.raymarchSteps, profile.shadowSteps, profile.interiorSteps, profile.particleCells);
		put3(u, 'comp', f.companion.pos, f.companion.scale);
		put3(u, 'drag', f.drag, f.flow.film);
		put(u, 'seeds', look.layoutSeed, look.layoutSeed, mirrorSurface ? env.surfaceY : env.floorY, mirrorSurface ? 1 : 0);
		put(u, 'debug', import.meta.env.DEV ? ((globalThis as { __SOMA_DEBUG__?: number }).__SOMA_DEBUG__ ?? 0) : 0);
		// The organs' own lanes: each part of the animal and its water answers its own instrument.
		const parts = f.parts;
		SOMA_PART_SLOTS.forEach((name, i) => put(u, name, parts[i * 4], parts[i * 4 + 1], parts[i * 4 + 2], parts[i * 4 + 3]));
		frameIndex += 1;

		g.device.queue.writeBuffer(g.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		g.device.queue.writeBuffer(g.binsBuf, 0, bins.buffer, bins.byteOffset, bins.byteLength);

		if (hudSection !== journey.director.section) hudSection = journey.director.section;
		if (hudForm !== f.names.form) hudForm = f.names.form;
		if (hudSpecies !== f.names.species) hudSpecies = f.names.species;
		if (hudEnvironment !== f.names.environment) hudEnvironment = f.names.environment;
		if (hudPalette !== f.names.palette) hudPalette = f.names.palette;
		if (hudCamera !== f.names.camera) hudCamera = f.names.camera;

		// ── Render graph: scene -> feedback -> prefilter -> 2x (H, V) blur -> present
		const encoder = g.device.createCommandEncoder({ label: 'Soma frame' });
		const timer = g.timer && !g.timer.busy && frameIndex % 20 === 0 ? g.timer : null;
		const fullscreen = (label: string, view: GPUTextureView, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, stamp?: GPURenderPassTimestampWrites) => {
			const pass = encoder.beginRenderPass({
				label,
				colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
				...(stamp ? { timestampWrites: stamp } : {})
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
		};
		const previous = g.parity;
		const next: 0 | 1 = previous === 0 ? 1 : 0;
		fullscreen('Soma scene', t.sceneView, g.pipelines.scene, bg.scene, timer ? { querySet: timer.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined);
		fullscreen('Soma feedback', t.feedbackView[next], g.pipelines.feedback, bg.feedback[previous]);
		fullscreen('Soma bloom prefilter', t.bloomView[0], g.pipelines.bloomDown, bg.bloomDown[next]);
		for (let round = 0; round < 2; round++) {
			fullscreen('Soma bloom blur H', t.bloomView[1], g.pipelines.blurH, bg.blurH);
			fullscreen('Soma bloom blur V', t.bloomView[0], g.pipelines.blurV, bg.blurV);
		}
		fullscreen('Soma present', g.context.getCurrentTexture().createView(), g.pipelines.composite, bg.composite[next], timer ? { querySet: timer.set, endOfPassWriteIndex: 2 } : undefined);
		if (timer) {
			encoder.resolveQuerySet(timer.set, 0, 3, timer.resolve, 0);
			encoder.copyBufferToBuffer(timer.resolve, 0, timer.read, 0, 24);
		}
		g.device.queue.submit([encoder.finish()]);
		if (timer) {
			timer.busy = true;
			void timer.read.mapAsync(GPUMapMode.READ).then(() => {
				const stamps = new BigUint64Array(timer.read.getMappedRange().slice(0));
				timer.read.unmap();
				timer.busy = false;
				const sceneMs = Number(stamps[1] - stamps[0]) / 1e6;
				const postMs = Number(stamps[2] - stamps[1]) / 1e6;
				if (sceneMs > 0 && sceneMs < 1000) gpuSceneMs = gpuSceneMs * 0.7 + sceneMs * 0.3;
				if (postMs > 0 && postMs < 1000) gpuPostMs = gpuPostMs * 0.7 + postMs * 0.3;
				cpuShown = cpuMs;
			}).catch(() => {});
		}
		g.parity = next;
	}

	function loop(frameNow = performance.now()) {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!canvas || !gpu) return;
		if (!schedulerTickAt) {
			schedulerTickAt = frameNow;
		} else {
			const tickElapsed = Math.max(0, frameNow - schedulerTickAt);
			schedulerTickAt = frameNow;
			observeDisplayCadence(tickElapsed);
		}
		const nextFrameStride = somaFrameStride(refreshIntervalMs, qualityProfile.frameRate);
		if (nextFrameStride !== activeFrameStride) {
			activeFrameStride = nextFrameStride;
			renderStride = nextFrameStride;
			framesUntilRender = 0;
		}
		if (framesUntilRender > 0) {
			framesUntilRender--;
			return;
		}
		framesUntilRender = activeFrameStride - 1;
		const hadPreviousRender = lastRenderedAt !== 0;
		const elapsedMs = hadPreviousRender ? Math.max(0, frameNow - lastRenderedAt) : refreshIntervalMs * activeFrameStride;
		lastRenderedAt = frameNow;
		const frameDt = Math.min(0.1, Math.max(0.001, elapsedMs / 1000));
		const profile = updateQualityProfile(hadPreviousRender ? elapsedMs : null);
		try {
			const cpuStart = performance.now();
			renderFrame(gpu, frameNow, frameDt, profile);
			if (import.meta.env.DEV) cpuMs = cpuMs * 0.9 + (performance.now() - cpuStart) * 0.1;
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : String(error);
			teardownGpu();
		}
	}

	// The component is mounted once in the layout; the canvas inside is
	// conditional. Each fresh canvas gets fresh GPU state, and a stale
	// initialization is destroyed rather than adopted.
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
				resetFrameScheduler();
				feedbackResetFrames = 2;
				fadeIn = 0;
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
			aria-label="Soma audio visualizer"
			data-mk2-section={hudSection}
			data-mk2-form={hudForm}
			data-mk2-uniform-bytes={SOMA_UNIFORM_BYTES}
			data-mk2-render-passes={RENDER_PASSES}
			data-soma-ready={String(ready)}
			data-soma-species={hudSpecies}
			data-soma-environment={hudEnvironment}
			data-soma-palette={hudPalette}
			data-soma-camera={hudCamera}
			data-soma-look={`${hudSpecies} ${hudEnvironment} ${hudPalette} ${hudCamera}`}
			data-soma-quality={qualityTier}
			data-soma-render-pixels={renderPixels}
			data-soma-max-pixels={SOMA_QUALITY_PROFILES[qualityTier].maxPixels}
			data-soma-scene-scale={SOMA_QUALITY_PROFILES[qualityTier].sceneScale}
			data-soma-frame-rate={SOMA_QUALITY_PROFILES[qualityTier].frameRate}
			data-soma-frame-stride={renderStride}
			data-soma-refresh-rate={measuredRefreshRate}
			data-soma-raymarch-steps={SOMA_QUALITY_PROFILES[qualityTier].raymarchSteps}
			data-soma-gpu-scene-ms={gpuSceneMs.toFixed(2)}
			data-soma-gpu-post-ms={gpuPostMs.toFixed(2)}
			data-soma-cpu-ms={cpuShown.toFixed(2)}
		></canvas>
		{#if errorMsg}
			<div class="pointer-events-none absolute left-6 top-6 z-20 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
