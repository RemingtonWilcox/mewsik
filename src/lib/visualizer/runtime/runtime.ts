// VisualizerRuntime — single WebGPU context that owns scene/feedback/uniform
// resources and runs N motif modules per frame. Replaces the engine-swap host.
//
// Lifecycle:
//   constructor()  — pure state, no GPU touch yet
//   init(canvas)   — acquire device, create surface + HDR target + feedback bank
//   register(m)    — add a motif module
//   setWeights(w)  — update per-motif render weights (0..1); transitions = LERP
//   update(frame)  — pack director uniform, advance per-motif state
//   render()       — encode one frame: motifs → composite → swapchain
//   dispose()      — tear down GPU resources

import type { VisualDirectorFrame } from '../director/types.js';
import {
	DIRECTOR_UNIFORM_BYTES,
	DIRECTOR_UNIFORM_FLOATS,
	packDirectorUniform
} from './uniforms.js';
import { DEFAULT_RUNTIME_CONTROLS, normalizeRuntimeControls } from './controls.js';
import { createFeedbackBank, disposeFeedbackBank, resizeFeedbackBank } from './feedback.js';
import { BloomPass } from './post/bloom.js';
import { FeedbackPass } from './post/feedback.js';
import type {
	MotifModule,
	RuntimeContext,
	MotifWeights,
	MotifId,
	RuntimeControls
} from './types.js';

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

export class VisualizerRuntime {
	private canvas: HTMLCanvasElement | null = null;
	private context: GPUCanvasContext | null = null;
	private device: GPUDevice | null = null;
	private format: GPUTextureFormat = 'bgra8unorm';
	private sceneHDR: GPUTexture | null = null;
	private sceneHDRView: GPUTextureView | null = null;
	private uniformBuf: GPUBuffer | null = null;
	private uniformLayout: GPUBindGroupLayout | null = null;
	private uniformDataF32: Float32Array;
	private uniformDataU32: Uint32Array;
	private sampler: GPUSampler | null = null;

	private feedback: ReturnType<typeof createFeedbackBank> | null = null;

	private motifs: MotifModule[] = [];
	private weights = new Map<MotifId, number>();
	private targetWeights = new Map<MotifId, number>();
	private controls: RuntimeControls = DEFAULT_RUNTIME_CONTROLS;

	private compositeModule: GPUShaderModule | null = null;
	private compositePipeline: GPURenderPipeline | null = null;
	private compositeBg: GPUBindGroup | null = null;
	private compositeLayout: GPUBindGroupLayout | null = null;

	private bloomPass: BloomPass | null = null;
	private bloomView: GPUTextureView | null = null;
	private feedbackPass: FeedbackPass | null = null;
	private feedbackPing: 0 | 1 = 0; // toggles each frame; read = ping, write = !ping
	private feedbackInitialized = false;
	private currentDirectorFrame: VisualDirectorFrame | null = null;

	private width = 1;
	private height = 1;
	private lastTime = 0;

	private context_: RuntimeContext | null = null;
	private deviceLost = false;
	get ctx(): RuntimeContext | null {
		return this.context_;
	}

	// Set by callers (host component) so it can surface device-lost as visible
	// text instead of a silent black screen. Without this the RAF loop swallows
	// validation cascades and the canvas just goes dark.
	onDeviceLost: ((reason: string) => void) | null = null;

	constructor() {
		const buf = new ArrayBuffer(DIRECTOR_UNIFORM_BYTES);
		this.uniformDataF32 = new Float32Array(buf);
		this.uniformDataU32 = new Uint32Array(buf);
	}

	async init(canvas: HTMLCanvasElement): Promise<void> {
		if (!('gpu' in navigator)) {
			throw new Error('WebGPU not available in this runtime.');
		}
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) throw new Error('No GPU adapter.');
		const device = await adapter.requestDevice();
		device.lost.then((info) => {
			this.deviceLost = true;
			const reason = `WebGPU device lost: ${info.reason ?? 'unknown'} — ${info.message ?? ''}`;
			console.error('[runtime]', reason);
			this.onDeviceLost?.(reason);
		});
		const context = canvas.getContext('webgpu');
		if (!context) throw new Error('Failed to acquire WebGPU canvas context.');

		const format = navigator.gpu.getPreferredCanvasFormat();
		this.canvas = canvas;
		this.context = context;
		this.device = device;
		this.format = format;

		const w = Math.max(1, canvas.clientWidth | 0);
		const h = Math.max(1, canvas.clientHeight | 0);
		canvas.width = w * Math.min(2, window.devicePixelRatio || 1);
		canvas.height = h * Math.min(2, window.devicePixelRatio || 1);
		this.width = canvas.width;
		this.height = canvas.height;

		context.configure({
			device,
			format,
			alphaMode: 'premultiplied'
		});

		// Director uniform — explicit layout, no auto-pruning.
		this.uniformBuf = device.createBuffer({
			label: 'director_uniform',
			size: DIRECTOR_UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		this.uniformLayout = device.createBindGroupLayout({
			label: 'director_uniform_bgl',
			entries: [
				{
					binding: 0,
					visibility:
						GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform' }
				}
			]
		});

		this.sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});

		this.recreateSceneTarget();
		this.feedback = createFeedbackBank(device, this.width, this.height, HDR_FORMAT, 4);
		this.feedbackInitialized = false;
		this.feedbackPing = 0;

		this.bloomPass = new BloomPass({
			device,
			directorUniform: this.uniformBuf,
			directorLayout: this.uniformLayout
		});
		this.bloomPass.resize(this.width, this.height, this.uniformBuf);
		// BloomPass's first mip view is stable across frames until next resize,
		// so we can grab it now and bake it into the composite bind group.
		this.bloomView = this.bloomPass.getOutputView();

		this.feedbackPass = new FeedbackPass({
			device,
			hdrFormat: HDR_FORMAT,
			directorUniform: this.uniformBuf
		});
		this.feedbackPass.bind({
			directorUniform: this.uniformBuf,
			feedbackViews: [this.feedback.views[0], this.feedback.views[1]]
		});

		this.buildComposite();

		this.context_ = this.buildContext();

		// Init any motifs registered before init() finished.
		for (const m of this.motifs) await m.init(this.context_);
	}

	private buildContext(): RuntimeContext {
		if (
			!this.device ||
			!this.uniformBuf ||
			!this.uniformLayout ||
			!this.sceneHDR ||
			!this.sceneHDRView ||
			!this.canvas ||
			!this.feedback ||
			!this.sampler
		) {
			throw new Error('Runtime not initialized.');
		}
		return {
			device: this.device,
			format: this.format,
			hdrFormat: HDR_FORMAT,
			canvas: this.canvas,
			width: this.width,
			height: this.height,
			directorUniformBuf: this.uniformBuf,
			directorUniformLayout: this.uniformLayout,
			sceneHDR: this.sceneHDR,
			sceneHDRView: this.sceneHDRView,
			feedback: this.feedback,
			sampler: this.sampler
		};
	}

	private recreateSceneTarget() {
		if (!this.device) return;
		if (this.sceneHDR) this.sceneHDR.destroy();
		this.sceneHDR = this.device.createTexture({
			label: 'scene_hdr',
			size: [this.width, this.height, 1],
			format: HDR_FORMAT,
			// COPY_SRC required so we can copy scene → feedback texture each frame.
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC
		});
		this.sceneHDRView = this.sceneHDR.createView();
	}

	private buildComposite() {
		if (!this.device || !this.uniformLayout) return;
		const code = /* wgsl */ `
			struct Director {
				viewport: vec4<f32>,
				energy: vec4<f32>,
				bands: vec4<f32>,
				palette: vec4<f32>,
				palette2: vec4<f32>,
				mood: vec4<f32>,
				clock: vec4<f32>,
				clockI: vec4<u32>,
				drop: vec4<f32>,
				drop2: vec4<f32>,
				section: vec4<u32>,
				tonnetz_a: vec4<f32>,
				tonnetz_b: vec4<f32>,
				phrase: vec4<f32>,
				controls: vec4<f32>, post: vec4<f32>, fx: vec4<f32>, feedback: vec4<f32>,
				motifA: vec4<f32>, motifB: vec4<f32>, _pad6: vec4<f32>, _pad7: vec4<f32>,
				_pad8: vec4<f32>, _pad9: vec4<f32>, _pad10: vec4<f32>, _pad11: vec4<f32>,
				_pad12: vec4<f32>, _pad13: vec4<f32>, _pad14: vec4<f32>, _pad15: vec4<f32>,
				_pad16: vec4<f32>, _pad17: vec4<f32>,
			};

			@group(0) @binding(0) var samp: sampler;
			@group(0) @binding(1) var sceneTex: texture_2d<f32>;
			@group(0) @binding(2) var bloomTex: texture_2d<f32>;
			@group(0) @binding(3) var<uniform> dir: Director;

			struct VsOut {
				@builtin(position) pos: vec4<f32>,
				@location(0) uv: vec2<f32>,
			};

			@vertex
			fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
				var positions = array<vec2<f32>, 3>(
					vec2<f32>(-1.0, -3.0),
					vec2<f32>(-1.0,  1.0),
					vec2<f32>( 3.0,  1.0)
				);
				let p = positions[vi];
				var out: VsOut;
				out.pos = vec4<f32>(p, 0.0, 1.0);
				out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
				return out;
			}

			// AgX tone-map approximation (Troy Sobotka). Smoother than ACES,
			// preserves saturation in bright hues better than Khronos Neutral.
			fn agx(c: vec3<f32>) -> vec3<f32> {
				let m = mat3x3<f32>(
					0.842479062253094, 0.0423282422610123, 0.0423756549057051,
					0.0784335999999992, 0.878468636469772, 0.0784336,
					0.0792237451477643, 0.0791661274605434, 0.879142973793104
				);
				let x = m * c;
				let lo = vec3<f32>(0.0001);
				let mapped = clamp((log2(max(x, lo)) + 12.47393) / (12.47393 + 4.026069), vec3<f32>(0.0), vec3<f32>(1.0));
				let m2 = mapped * mapped;
				let m4 = m2 * m2;
				return -17.86 * m4 * m2 + 78.01 * m4 * mapped - 126.7 * m4 + 92.06 * m2 * mapped - 28.72 * m2 + 4.361 * mapped - vec3<f32>(0.1718);
			}

			// IGN hash for cheap per-pixel film grain. From Jorge Jimenez.
			fn ign(pixel: vec2<f32>) -> f32 {
				let m = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
				return fract(m.z * fract(dot(pixel, m.xy)));
			}

			@fragment
			fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
				let energy = dir.energy.x;
				let bassPunch = dir.mood.z;
				let trebleSparkle = dir.mood.w;
				let postDrop = dir.drop2.x;
				let antic = dir.drop.w;
				let masterCtl = dir.controls.x;
				let exposureCtl = dir.controls.y;
				let bloomCtl = dir.controls.z;
				let contrastCtl = dir.post.x;
				let saturationCtl = dir.post.y;
				let vignetteCtl = dir.post.z;
				let edgeCtl = dir.post.w;
				let chromaCtl = dir.fx.x;
				let grainCtl = dir.fx.y;

				// Stage mask: keep the outer frame dark and structured so edge content
				// does not read as blurry corner distortion.
				let uv = in.uv - vec2<f32>(0.5);
				let r2 = dot(uv, uv);
				let edgeDist = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
				let edgeMask = smoothstep(0.018, 0.16, edgeDist);
				let radialMask = 1.0 - smoothstep(0.26, 0.66, r2) * (0.40 - postDrop * 0.08);
				let edgeFloor = mix(0.65, 0.16, clamp(edgeCtl, 0.0, 1.0));
				let edgeVig = mix(edgeFloor, 1.0, edgeMask);
				let vig = mix(1.0, edgeVig * radialMask, clamp(vignetteCtl, 0.0, 1.5));

				// Chromatic aberration: split RGB sample offsets in the edge zone.
				// Amount scales with anticipation + bass — kicks visibly fringe.
				let caAmount = (0.0008 + antic * 0.0028 + bassPunch * 0.0016) * smoothstep(0.16, 0.58, r2) * chromaCtl;
				let dir2 = normalize(uv + vec2<f32>(0.00001));
				let off = dir2 * caAmount;
				let sceneR = textureSample(sceneTex, samp, in.uv + off).r;
				let sceneG = textureSample(sceneTex, samp, in.uv).g;
				let sceneB = textureSample(sceneTex, samp, in.uv - off).b;
				let bloomR = textureSample(bloomTex, samp, in.uv + off * 1.5).r;
				let bloomG = textureSample(bloomTex, samp, in.uv).g;
				let bloomB = textureSample(bloomTex, samp, in.uv - off * 1.5).b;

				let scene = vec3<f32>(sceneR, sceneG, sceneB);
				let bloom = vec3<f32>(bloomR, bloomG, bloomB);

				// Bloom intensity rides energy and pumps on the drop watershed,
				// but stays restrained so the runtime keeps contrast.
				let bloomAmount = (0.12 + energy * 0.20 + postDrop * 0.26) * bloomCtl;

				let exposure = (0.66 + postDrop * 0.08) * exposureCtl;
				let combined = scene * exposure + bloom * bloomAmount;
				var mapped = agx(combined) * vig;

				// Contrast and saturation trim: recover black space after AgX so the
				// runtime does not collapse into a pale full-screen overlay.
				mapped = max(mapped - vec3<f32>(0.040 * contrastCtl), vec3<f32>(0.0));
				mapped = pow(mapped, vec3<f32>(1.0 + 0.20 * contrastCtl));
				let mappedLuma = dot(mapped, vec3<f32>(0.299, 0.587, 0.114));
				mapped = mix(vec3<f32>(mappedLuma), mapped, clamp(saturationCtl * 1.10, 0.0, 2.0));

				// Film grain — luma-aware (less grain in highlights) so blacks
				// get the gritty 16mm feel and bright cores stay clean.
				let pixelPos = in.pos.xy + vec2<f32>(dir.viewport.z * 137.0, dir.viewport.z * 271.0);
				let g = ign(pixelPos) - 0.5;
				let luma = dot(mapped, vec3<f32>(0.299, 0.587, 0.114));
				let grainAmount = (0.012 + trebleSparkle * 0.024 + bassPunch * 0.012) * (1.0 - smoothstep(0.5, 1.0, luma)) * grainCtl;
				mapped = mapped + vec3<f32>(g * grainAmount);

				return vec4<f32>(clamp(mapped * masterCtl, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
			}
		`;
		this.compositeModule = this.device.createShaderModule({ label: 'composite_shader', code });
		this.compositeLayout = this.device.createBindGroupLayout({
			label: 'composite_bgl',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: 'float' }
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: 'float' }
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: 'uniform' }
				}
			]
		});
		const pipelineLayout = this.device.createPipelineLayout({
			label: 'composite_pl',
			bindGroupLayouts: [this.compositeLayout]
		});
		this.compositePipeline = this.device.createRenderPipeline({
			label: 'composite_pipeline',
			layout: pipelineLayout,
			vertex: { module: this.compositeModule, entryPoint: 'vs_main' },
			fragment: {
				module: this.compositeModule,
				entryPoint: 'fs_main',
				targets: [{ format: this.format }]
			},
			primitive: { topology: 'triangle-list' }
		});
		this.rebuildCompositeBindGroup();
	}

	private rebuildCompositeBindGroup() {
		if (
			!this.device ||
			!this.compositeLayout ||
			!this.sceneHDRView ||
			!this.sampler ||
			!this.uniformBuf
		)
			return;
		// If bloom hasn't run yet, bind scene as a placeholder so the
		// layout is satisfied — first frame will overwrite once render() runs.
		const bloomView = this.bloomView ?? this.sceneHDRView;
		this.compositeBg = this.device.createBindGroup({
			label: 'composite_bg',
			layout: this.compositeLayout,
			entries: [
				{ binding: 0, resource: this.sampler },
				{ binding: 1, resource: this.sceneHDRView },
				{ binding: 2, resource: bloomView },
				{ binding: 3, resource: { buffer: this.uniformBuf } }
			]
		});
	}

	register(motif: MotifModule, initialWeight = 0): void {
		this.motifs.push(motif);
		this.weights.set(motif.id, initialWeight);
		this.targetWeights.set(motif.id, initialWeight);
		if (this.context_) {
			void motif.init(this.context_);
		}
	}

	setWeights(weights: MotifWeights): void {
		for (const [id, w] of Object.entries(weights)) {
			this.targetWeights.set(id as MotifId, w ?? 0);
		}
	}

	setControls(controls: Partial<RuntimeControls> | null | undefined): void {
		this.controls = normalizeRuntimeControls(controls);
	}

	resize(width: number, height: number) {
		if (!this.device || !this.canvas || !this.feedback || !this.uniformBuf) return;
		const w = Math.max(1, width | 0);
		const h = Math.max(1, height | 0);
		if (w === this.width && h === this.height) return;
		this.width = w;
		this.height = h;
		this.canvas.width = w;
		this.canvas.height = h;
		this.recreateSceneTarget();
		resizeFeedbackBank(this.feedback, this.device, w, h, HDR_FORMAT);
		this.feedbackInitialized = false;
		this.feedbackPing = 0;
		if (this.bloomPass) {
			this.bloomPass.resize(w, h, this.uniformBuf);
			this.bloomView = this.bloomPass.getOutputView();
		}
		if (this.feedbackPass && this.feedback) {
			this.feedbackPass.bind({
				directorUniform: this.uniformBuf,
				feedbackViews: [this.feedback.views[0], this.feedback.views[1]]
			});
		}
		this.rebuildCompositeBindGroup();
		this.context_ = this.buildContext();
		for (const m of this.motifs) m.resize(this.context_);
	}

	update(frame: VisualDirectorFrame, time: number): void {
		if (!this.device || !this.uniformBuf || !this.context_) return;
		// Clamp dt at the source: rAF pauses while backgrounded, so the first
		// frame back (and the very first frame, lastTime=0) can be seconds long.
		// flowfield/feedback re-clamp in-shader, but new motifs shouldn't have
		// to remember to. mk3 does the same (Math.min(0.05, ...)).
		const dt = Math.min(1 / 30, Math.max(0, time - this.lastTime));
		this.lastTime = time;

		// Two-rail weight LERP — fast attack so kicks/drops can promote a motif
		// in real time, slow release so the field doesn't flicker between events.
		// Old behaviour (symmetric 0.08) had a 200ms half-life that swallowed
		// transient promotions; this gets to 80%+ of target inside ~3 frames on
		// the way up, 14 frames on the way down.
		for (const [id, target] of this.targetWeights) {
			const current = this.weights.get(id) ?? 0;
			const a = target > current ? 0.45 : 0.06;
			this.weights.set(id, current + (target - current) * a);
		}

		packDirectorUniform(
			this.uniformDataF32,
			this.uniformDataU32,
			frame,
			this.width,
			this.height,
			time,
			dt,
			this.controls
		);
		this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformDataF32.buffer, 0, DIRECTOR_UNIFORM_BYTES);

		for (const m of this.motifs) m.update(frame, time, dt);
	}

	render(): void {
		if (
			this.deviceLost ||
			!this.device ||
			!this.context ||
			!this.context_ ||
			!this.compositePipeline ||
			!this.compositeBg ||
			!this.sceneHDRView
		)
			return;

		const encoder = this.device.createCommandEncoder({ label: 'runtime_frame' });

		// Clear the scene HDR target first.
		{
			const clearPass = encoder.beginRenderPass({
				label: 'scene_clear',
				colorAttachments: [
					{
						view: this.sceneHDRView,
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			clearPass.end();
		}

		// Hydra-style temporal feedback: write the warped+decayed previous
		// frame into the scene HDR as the underlay. Skipped on the very first
		// frame because the feedback textures are uninitialized garbage at that
		// point — the first frame paints clean, subsequent frames blend with
		// history. Motifs then render additively on top.
		if (this.feedbackPass && this.feedbackInitialized && this.feedback) {
			this.feedbackPass.render(encoder, this.sceneHDRView, this.feedbackPing);
		}

		// Render each motif at its current weight. Threshold raised from 0.005
		// → 0.06: anything below that is invisible but still pays full overdraw
		// and dilutes the lead motif's read. Skipping clears the "pale soup"
		// failure mode where 5+ motifs each contribute 0.10-0.30.
		for (const m of this.motifs) {
			const w = this.weights.get(m.id) ?? 0;
			if (w > 0.06) m.render(encoder, this.context_, w);
		}

		// Snapshot the post-motif scene HDR into the WRITE feedback texture so
		// next frame can sample it. Pre-bloom: we want trails of motif state,
		// not trails of bloom on bloom (which would compound to white). Bloom
		// re-derives from current scene HDR every frame.
		if (this.feedback && this.feedback.textures.length >= 2 && this.sceneHDR) {
			const writeIndex = this.feedbackPing === 0 ? 1 : 0;
			encoder.copyTextureToTexture(
				{ texture: this.sceneHDR },
				{ texture: this.feedback.textures[writeIndex] },
				[this.width, this.height, 1]
			);
			// Next frame reads what we just wrote.
			this.feedbackPing = writeIndex as 0 | 1;
			this.feedbackInitialized = true;
		}

		// Bloom post-pass: scene HDR → threshold + downsample chain →
		// progressive upsample. The output view is stable across frames so
		// the composite bind group was already built against it in init/resize.
		if (this.bloomPass && this.uniformBuf) {
			this.bloomPass.render(encoder, this.sceneHDRView, this.uniformBuf);
		}

		// Composite scene + bloom → swapchain with AgX tonemap + vignette.
		{
			const swapView = this.context.getCurrentTexture().createView();
			const pass = encoder.beginRenderPass({
				label: 'composite_pass',
				colorAttachments: [
					{
						view: swapView,
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			pass.setPipeline(this.compositePipeline);
			pass.setBindGroup(0, this.compositeBg);
			pass.draw(3);
			pass.end();
		}

		this.device.queue.submit([encoder.finish()]);
	}

	dispose(): void {
		for (const m of this.motifs) m.dispose();
		this.motifs.length = 0;
		this.weights.clear();
		this.targetWeights.clear();
		if (this.bloomPass) {
			this.bloomPass.dispose();
			this.bloomPass = null;
		}
		this.bloomView = null;
		if (this.feedbackPass) {
			this.feedbackPass.dispose();
			this.feedbackPass = null;
		}
		this.feedbackInitialized = false;
		if (this.feedback) {
			disposeFeedbackBank(this.feedback);
			this.feedback = null;
		}
		if (this.sceneHDR) {
			this.sceneHDR.destroy();
			this.sceneHDR = null;
			this.sceneHDRView = null;
		}
		if (this.uniformBuf) {
			this.uniformBuf.destroy();
			this.uniformBuf = null;
		}
		this.compositePipeline = null;
		this.compositeBg = null;
		this.compositeLayout = null;
		this.compositeModule = null;
		this.uniformLayout = null;
		this.context_ = null;
		this.context = null;
		this.device = null;
	}
}
