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
import { createFeedbackBank, disposeFeedbackBank, resizeFeedbackBank } from './feedback.js';
import type { MotifModule, RuntimeContext, MotifWeights, MotifId } from './types.js';

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

	private compositeModule: GPUShaderModule | null = null;
	private compositePipeline: GPURenderPipeline | null = null;
	private compositeBg: GPUBindGroup | null = null;
	private compositeLayout: GPUBindGroupLayout | null = null;

	private width = 1;
	private height = 1;
	private lastTime = 0;

	private context_: RuntimeContext | null = null;
	get ctx(): RuntimeContext | null {
		return this.context_;
	}

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
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
		});
		this.sceneHDRView = this.sceneHDR.createView();
	}

	private buildComposite() {
		if (!this.device || !this.uniformLayout) return;
		const code = /* wgsl */ `
			@group(0) @binding(0) var samp: sampler;
			@group(0) @binding(1) var sceneTex: texture_2d<f32>;

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

			@fragment
			fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
				let hdr = textureSample(sceneTex, samp, in.uv).rgb;
				let mapped = agx(hdr);
				return vec4<f32>(clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
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
		if (!this.device || !this.compositeLayout || !this.sceneHDRView || !this.sampler) return;
		this.compositeBg = this.device.createBindGroup({
			label: 'composite_bg',
			layout: this.compositeLayout,
			entries: [
				{ binding: 0, resource: this.sampler },
				{ binding: 1, resource: this.sceneHDRView }
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

	resize(width: number, height: number) {
		if (!this.device || !this.canvas || !this.feedback) return;
		const w = Math.max(1, width | 0);
		const h = Math.max(1, height | 0);
		if (w === this.width && h === this.height) return;
		this.width = w;
		this.height = h;
		this.canvas.width = w;
		this.canvas.height = h;
		this.recreateSceneTarget();
		resizeFeedbackBank(this.feedback, this.device, w, h, HDR_FORMAT);
		this.rebuildCompositeBindGroup();
		this.context_ = this.buildContext();
		for (const m of this.motifs) m.resize(this.context_);
	}

	update(frame: VisualDirectorFrame, time: number): void {
		if (!this.device || !this.uniformBuf || !this.context_) return;
		const dt = Math.max(0, time - this.lastTime);
		this.lastTime = time;

		// LERP weights toward targets (parameter morph, not component swap).
		for (const [id, target] of this.targetWeights) {
			const current = this.weights.get(id) ?? 0;
			this.weights.set(id, current + (target - current) * 0.08);
		}

		packDirectorUniform(
			this.uniformDataF32,
			this.uniformDataU32,
			frame,
			this.width,
			this.height,
			time,
			dt
		);
		this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformDataF32.buffer, 0, DIRECTOR_UNIFORM_BYTES);

		for (const m of this.motifs) m.update(frame, time, dt);
	}

	render(): void {
		if (
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

		// Render each motif into the HDR target at its current weight.
		for (const m of this.motifs) {
			const w = this.weights.get(m.id) ?? 0;
			if (w > 0.005) m.render(encoder, this.context_, w);
		}

		// Composite HDR → swapchain with AgX tonemap.
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
