// Bloom — Jimenez 2014 "Next Generation Post Processing in Call of Duty:
// Advanced Warfare" dual-Kawase progressive bloom. Halo-free, ~3× cheaper
// than UnrealBloomPass. Reference impl: LearnOpenGL Phys-Based Bloom guide.
//
// Pipeline (each pass is full-screen-triangle fragment shader):
//   1. Karis-weighted downsample scene HDR → mip[0] (half res, 13-tap,
//      threshold-free per Jimenez — the composite lerps bloom at a small
//      weight so thresholding is unnecessary and bands less)
//   2. progressively downsample mip[i] → mip[i+1] (4 passes total)
//   3. progressively upsample mip[N] → mip[N-1] with 9-tap tent,
//      additively blended onto the destination (3 passes total)
//   4. mip[0] becomes the bloom texture sampled by the composite pass
//
// Director-driven intensity: bloom amount scales with energy and drops
// pump postDropDecay into the bloom so chorus blooms visibly more.

import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const MIP_COUNT = 4;
const FORMAT: GPUTextureFormat = 'rgba16float';

const SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

// Karis average weight: 1/(1+luma). Down-weights ultra-bright single
// samples so one firefly pixel can't dominate a whole bloom mip.
fn karisWeight(c: vec3<f32>) -> f32 {
	let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
	return 1.0 / (1.0 + luma);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
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

// Jimenez 13-tap downsample. inputSize used to derive texel offset.
@fragment
fn fs_downsample(in: VsOut) -> @location(0) vec4<f32> {
	let dims = vec2<f32>(textureDimensions(src));
	let x = 1.0 / dims.x;
	let y = 1.0 / dims.y;
	let uv = in.uv;

	let a = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y + 2.0 * y)).rgb;
	let b = textureSample(src, samp, vec2<f32>(uv.x,           uv.y + 2.0 * y)).rgb;
	let c = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y + 2.0 * y)).rgb;
	let d = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y          )).rgb;
	let e = textureSample(src, samp, vec2<f32>(uv.x,           uv.y          )).rgb;
	let f = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y          )).rgb;
	let g = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y - 2.0 * y)).rgb;
	let h = textureSample(src, samp, vec2<f32>(uv.x,           uv.y - 2.0 * y)).rgb;
	let i = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y - 2.0 * y)).rgb;
	let j = textureSample(src, samp, vec2<f32>(uv.x - x,       uv.y + y      )).rgb;
	let k = textureSample(src, samp, vec2<f32>(uv.x + x,       uv.y + y      )).rgb;
	let l = textureSample(src, samp, vec2<f32>(uv.x - x,       uv.y - y      )).rgb;
	let m = textureSample(src, samp, vec2<f32>(uv.x + x,       uv.y - y      )).rgb;

	var sum = e * 0.125;
	sum = sum + (a + c + g + i) * 0.03125;
	sum = sum + (b + d + f + h) * 0.0625;
	sum = sum + (j + k + l + m) * 0.125;
	return vec4<f32>(sum, 1.0);
}

// First downsample — threshold-free per Jimenez 2014 ("when using HDR you
// don't need to threshold"); the composite lerps bloom in at a small weight
// so only genuinely bright HDR pixels bloom noticeably. Karis-style luma
// weighting suppresses fireflies (single ultra-bright particles flickering
// the whole mip chain).
@fragment
fn fs_karis_downsample(in: VsOut) -> @location(0) vec4<f32> {
	let dims = vec2<f32>(textureDimensions(src));
	let x = 1.0 / dims.x;
	let y = 1.0 / dims.y;
	let uv = in.uv;

	let a = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y + 2.0 * y)).rgb;
	let b = textureSample(src, samp, vec2<f32>(uv.x,           uv.y + 2.0 * y)).rgb;
	let c = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y + 2.0 * y)).rgb;
	let d = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y          )).rgb;
	let e = textureSample(src, samp, vec2<f32>(uv.x,           uv.y          )).rgb;
	let f = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y          )).rgb;
	let g = textureSample(src, samp, vec2<f32>(uv.x - 2.0 * x, uv.y - 2.0 * y)).rgb;
	let h = textureSample(src, samp, vec2<f32>(uv.x,           uv.y - 2.0 * y)).rgb;
	let i = textureSample(src, samp, vec2<f32>(uv.x + 2.0 * x, uv.y - 2.0 * y)).rgb;
	let j = textureSample(src, samp, vec2<f32>(uv.x - x,       uv.y + y      )).rgb;
	let k = textureSample(src, samp, vec2<f32>(uv.x + x,       uv.y + y      )).rgb;
	let l = textureSample(src, samp, vec2<f32>(uv.x - x,       uv.y - y      )).rgb;
	let m = textureSample(src, samp, vec2<f32>(uv.x + x,       uv.y - y      )).rgb;

	let wa = karisWeight(a) * 0.03125;
	let wb = karisWeight(b) * 0.0625;
	let wc = karisWeight(c) * 0.03125;
	let wd = karisWeight(d) * 0.0625;
	let we = karisWeight(e) * 0.125;
	let wf = karisWeight(f) * 0.0625;
	let wg = karisWeight(g) * 0.03125;
	let wh = karisWeight(h) * 0.0625;
	let wi = karisWeight(i) * 0.03125;
	let wj = karisWeight(j) * 0.125;
	let wk = karisWeight(k) * 0.125;
	let wl = karisWeight(l) * 0.125;
	let wm = karisWeight(m) * 0.125;

	let sum = a * wa + b * wb + c * wc + d * wd + e * we + f * wf + g * wg
		+ h * wh + i * wi + j * wj + k * wk + l * wl + m * wm;
	let totalWeight = wa + wb + wc + wd + we + wf + wg + wh + wi + wj + wk + wl + wm;
	return vec4<f32>(sum / max(totalWeight, 0.0001), 1.0);
}

// 9-tap tent upsample — additive blend handled by the pipeline.
@fragment
fn fs_upsample(in: VsOut) -> @location(0) vec4<f32> {
	let dims = vec2<f32>(textureDimensions(src));
	let x = 1.0 / dims.x;
	let y = 1.0 / dims.y;
	let uv = in.uv;

	let a = textureSample(src, samp, vec2<f32>(uv.x - x, uv.y + y)).rgb;
	let b = textureSample(src, samp, vec2<f32>(uv.x,     uv.y + y)).rgb;
	let c = textureSample(src, samp, vec2<f32>(uv.x + x, uv.y + y)).rgb;
	let d = textureSample(src, samp, vec2<f32>(uv.x - x, uv.y    )).rgb;
	let e = textureSample(src, samp, vec2<f32>(uv.x,     uv.y    )).rgb;
	let f = textureSample(src, samp, vec2<f32>(uv.x + x, uv.y    )).rgb;
	let g = textureSample(src, samp, vec2<f32>(uv.x - x, uv.y - y)).rgb;
	let h = textureSample(src, samp, vec2<f32>(uv.x,     uv.y - y)).rgb;
	let i = textureSample(src, samp, vec2<f32>(uv.x + x, uv.y - y)).rgb;

	var sum = e * 4.0;
	sum = sum + (b + d + f + h) * 2.0;
	sum = sum + (a + c + g + i);
	sum = sum / 16.0;
	return vec4<f32>(sum, 1.0);
}
`;

export type BloomResources = {
	mips: GPUTexture[];
	mipViews: GPUTextureView[];
	widths: number[];
	heights: number[];
};

export class BloomPass {
	private device: GPUDevice;
	private layout: GPUBindGroupLayout;
	private pipelineThreshold: GPURenderPipeline;
	private pipelineDownsample: GPURenderPipeline;
	private pipelineUpsample: GPURenderPipeline;
	private sampler: GPUSampler;
	private res: BloomResources | null = null;
	private bgsDown: GPUBindGroup[] = [];
	private bgsUp: GPUBindGroup[] = [];
	readonly bloomFormat = FORMAT;

	constructor(opts: {
		device: GPUDevice;
		directorUniform: GPUBuffer;
		directorLayout: GPUBindGroupLayout;
	}) {
		this.device = opts.device;
		this.sampler = this.device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});

		this.layout = this.device.createBindGroupLayout({
			label: 'bloom_bgl',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: 'uniform' }
				},
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: 'float' }
				}
			]
		});

		const module = this.device.createShaderModule({ label: 'bloom_shader', code: SHADER });
		const pl = this.device.createPipelineLayout({
			label: 'bloom_pl',
			bindGroupLayouts: [this.layout]
		});

		const makePipeline = (entry: string, blend?: GPUBlendState) =>
			this.device.createRenderPipeline({
				label: `bloom_${entry}`,
				layout: pl,
				vertex: { module, entryPoint: 'vs' },
				fragment: {
					module,
					entryPoint: entry,
					targets: [
						{
							format: FORMAT,
							blend
						}
					]
				},
				primitive: { topology: 'triangle-list' }
			});

		this.pipelineThreshold = makePipeline('fs_karis_downsample');
		this.pipelineDownsample = makePipeline('fs_downsample');
		this.pipelineUpsample = makePipeline('fs_upsample', {
			color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
			alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
		});

		// directorUniform/Layout reserved for any future bloom shader that wants
		// to read director state (e.g. anticipation-modulated intensity inside
		// the shader). Currently driven via composite-pass intensity instead.
		void opts.directorUniform;
		void opts.directorLayout;
	}

	resize(width: number, height: number, directorUniform: GPUBuffer) {
		this.dispose();
		const mips: GPUTexture[] = [];
		const widths: number[] = [];
		const heights: number[] = [];
		let w = Math.max(2, Math.floor(width / 2));
		let h = Math.max(2, Math.floor(height / 2));
		for (let i = 0; i < MIP_COUNT; i++) {
			mips.push(
				this.device.createTexture({
					label: `bloom_mip_${i}`,
					size: [w, h, 1],
					format: FORMAT,
					usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
				})
			);
			widths.push(w);
			heights.push(h);
			w = Math.max(2, Math.floor(w / 2));
			h = Math.max(2, Math.floor(h / 2));
		}
		const mipViews = mips.map((t) => t.createView());
		this.res = { mips, mipViews, widths, heights };

		// Bind groups built lazily inside render() each frame against the
		// current source view (scene → mip0 → mip1 → ...). Cheap enough to
		// not cache, and avoids stale-view bugs across resize.
		this.bgsDown = [];
		this.bgsUp = [];
		void directorUniform;
	}

	/**
	 * Output view sampled by the composite pass. Stable across frames until
	 * the next resize(); the composite bind group can bake it in.
	 */
	getOutputView(): GPUTextureView | null {
		return this.res?.mipViews[0] ?? null;
	}

	private buildBindGroup(
		texView: GPUTextureView,
		directorUniform: GPUBuffer
	): GPUBindGroup {
		return this.device.createBindGroup({
			layout: this.layout,
			entries: [
				{ binding: 0, resource: { buffer: directorUniform } },
				{ binding: 1, resource: this.sampler },
				{ binding: 2, resource: texView }
			]
		});
	}

	/**
	 * Runs all bloom passes inside `encoder`. Returns the view sampleable by
	 * the composite pass as the final bloom texture.
	 */
	render(
		encoder: GPUCommandEncoder,
		sceneView: GPUTextureView,
		directorUniform: GPUBuffer
	): GPUTextureView | null {
		if (!this.res) return null;
		const { mipViews, mips } = this.res;

		// Downsample chain: scene → mip0 (threshold), mip0 → mip1, ...
		{
			const bg = this.buildBindGroup(sceneView, directorUniform);
			const pass = encoder.beginRenderPass({
				label: 'bloom_threshold',
				colorAttachments: [
					{
						view: mipViews[0],
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			pass.setPipeline(this.pipelineThreshold);
			pass.setBindGroup(0, bg);
			pass.draw(3);
			pass.end();
		}
		for (let i = 0; i < MIP_COUNT - 1; i++) {
			const bg = this.buildBindGroup(mipViews[i], directorUniform);
			const pass = encoder.beginRenderPass({
				label: `bloom_down_${i}`,
				colorAttachments: [
					{
						view: mipViews[i + 1],
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			pass.setPipeline(this.pipelineDownsample);
			pass.setBindGroup(0, bg);
			pass.draw(3);
			pass.end();
		}
		// Upsample chain (additive): mipN → mipN-1, ... → mip0
		for (let i = MIP_COUNT - 1; i > 0; i--) {
			const bg = this.buildBindGroup(mipViews[i], directorUniform);
			const pass = encoder.beginRenderPass({
				label: `bloom_up_${i}`,
				colorAttachments: [
					{
						view: mipViews[i - 1],
						loadOp: 'load', // additive blend
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(this.pipelineUpsample);
			pass.setBindGroup(0, bg);
			pass.draw(3);
			pass.end();
		}
		// mip0 now holds the final bloom result.
		void mips;
		return mipViews[0];
	}

	dispose() {
		if (this.res) {
			for (const t of this.res.mips) t.destroy();
			this.res = null;
		}
		this.bgsDown = [];
		this.bgsUp = [];
	}
}
