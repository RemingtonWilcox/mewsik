// Hydra-style temporal feedback. The dead-allocated feedback bank finally
// earns its VRAM: every frame copies the scene HDR into a ping-ponged
// rgba16f texture, then the next frame samples it back with a warped UV
// and a decay multiplier, *before* motifs draw. Motifs then composite on
// top of the warped previous frame — so trails, organism growth, and
// "things bleeding into each other" emerge for free.
//
// This is the single biggest aesthetic lever per the visualizer feedback
// memo ("temporal feedback is the single biggest silk lever"). The
// previous architecture allocated the textures but never sampled them.
//
// Pipeline integration:
//   1. clear scene HDR (loadOp: 'clear')
//   2. FeedbackPass: sample feedback[read], warp + decay, write to scene
//      HDR (additive — the warped previous frame becomes the underlay)
//   3. motifs render additively on top (loadOp: 'load')
//   4. encoder.copyTextureToTexture(scene HDR → feedback[write])
//   5. swap read/write index next frame

import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

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

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
	let mix = dir.fx.w;                  // feedbackMix 0..1
	if (mix < 0.001) {
		// User dialed feedback to 0 — emit black so motifs draw on a fresh canvas.
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}
	let decay = dir.feedback.x;          // 0.5..0.999 per-frame decay
	let warpAmt = dir.feedback.y;        // 0..1.5 bass-driven zoom pump amplitude
	let rotAmt = dir.feedback.z;         // 0..1.5 rotation rate scale

	let bass = dir.bands.x;
	let antic = dir.drop.w;
	let postDrop = dir.drop2.x;
	let motion = dir.energy.z;
	let dt = clamp(dir.viewport.w, 1.0 / 240.0, 1.0 / 30.0);
	let time = dir.viewport.z;
	let downbeat = f32(dir.clockI.w);

	// Centered UV for rotation/zoom; aspect-corrected so zoom looks uniform.
	let viewport = dir.viewport.xy;
	let aspect = viewport.x / max(viewport.y, 1.0);
	var uv = (in.uv - vec2<f32>(0.5)) * vec2<f32>(aspect, 1.0);

	// Slow continuous rotation (per-frame, not per-second so the spiral feel is
	// frame-rate friendly) plus a downbeat kick. Direction biased by tonnetz
	// fifth axis so harmonic motion warps the spiral.
	let tonnetzAngle = atan2(dir.tonnetz_a.y, dir.tonnetz_a.x);
	let rot = (rotAmt * 0.012 * (1.0 + motion * 1.4))
	          + (downbeat * rotAmt * 0.025)
	          + sin(time * 0.05 + tonnetzAngle) * rotAmt * 0.004;
	let c = cos(rot);
	let s = sin(rot);
	let rotated = vec2<f32>(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

	// Zoom — bass pumps outward (radial expansion on kicks), anticipation
	// slowly contracts inward (tension building). Subtle so it doesn't melt.
	let zoom = 1.0 - bass * warpAmt * 0.030 - postDrop * warpAmt * 0.020 + antic * warpAmt * 0.010;
	let zoomed = rotated * zoom;

	// Un-correct aspect, recenter, sample.
	let sampleUv = zoomed * vec2<f32>(1.0 / aspect, 1.0) + vec2<f32>(0.5);

	// Clamp at borders so the feedback doesn't tile/wrap into the frame.
	let clamped = clamp(sampleUv, vec2<f32>(0.0), vec2<f32>(1.0));
	let prev = textureSample(src, samp, clamped).rgb;

	// Decay so trails don't pile to white. AgX downstream tone-maps
	// everything together so we keep this linear.
	let decayed = prev * decay;

	// Soft luminance cap on the underlay. The loop's steady-state gain on
	// STATIC content is 1/(1 - decay*mix) — moving particles leave decaying
	// trails, but stationary glow (atmosphere gradients, held blooms)
	// accumulates multiplicatively; this was the "fog dominating subject"
	// mechanism. Reinhard-style compression bounds accumulation (~4.5 HDR
	// luma asymptote) while leaving dim trails (<1.0) nearly untouched.
	let underLuma = dot(decayed, vec3<f32>(0.2126, 0.7152, 0.0722));
	let capped = decayed / (1.0 + 0.22 * underLuma);

	// Soft edge fade so warped pixels near the frame border don't smear in.
	let edgeUv = abs(sampleUv - vec2<f32>(0.5)) * 2.0;
	let edgeFade = 1.0 - smoothstep(0.85, 1.05, max(edgeUv.x, edgeUv.y));

	return vec4<f32>(capped * mix * edgeFade, 1.0);
}
`;

export class FeedbackPass {
	private device: GPUDevice;
	private layout: GPUBindGroupLayout;
	private pipeline: GPURenderPipeline;
	private sampler: GPUSampler;
	private bindGroups: [GPUBindGroup, GPUBindGroup] | null = null;
	readonly format: GPUTextureFormat;

	constructor(opts: {
		device: GPUDevice;
		hdrFormat: GPUTextureFormat;
		directorUniform: GPUBuffer;
	}) {
		this.device = opts.device;
		this.format = opts.hdrFormat;
		this.sampler = this.device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});
		this.layout = this.device.createBindGroupLayout({
			label: 'feedback_pass_bgl',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: 'uniform' }
				},
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
			]
		});
		const module = this.device.createShaderModule({
			label: 'feedback_pass_shader',
			code: SHADER
		});
		const pl = this.device.createPipelineLayout({
			label: 'feedback_pass_pl',
			bindGroupLayouts: [this.layout]
		});
		this.pipeline = this.device.createRenderPipeline({
			label: 'feedback_pass_pipeline',
			layout: pl,
			vertex: { module, entryPoint: 'vs' },
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [{ format: this.format }]
			},
			primitive: { topology: 'triangle-list' }
		});
		void opts.directorUniform;
	}

	bind(opts: {
		directorUniform: GPUBuffer;
		feedbackViews: [GPUTextureView, GPUTextureView];
	}): void {
		const mk = (view: GPUTextureView) =>
			this.device.createBindGroup({
				label: 'feedback_pass_bg',
				layout: this.layout,
				entries: [
					{ binding: 0, resource: { buffer: opts.directorUniform } },
					{ binding: 1, resource: this.sampler },
					{ binding: 2, resource: view }
				]
			});
		this.bindGroups = [mk(opts.feedbackViews[0]), mk(opts.feedbackViews[1])];
	}

	render(encoder: GPUCommandEncoder, sceneView: GPUTextureView, readIndex: 0 | 1): void {
		if (!this.bindGroups) return;
		const pass = encoder.beginRenderPass({
			label: 'feedback_pass',
			colorAttachments: [
				{
					view: sceneView,
					loadOp: 'load',
					storeOp: 'store',
					clearValue: { r: 0, g: 0, b: 0, a: 1 }
				}
			]
		});
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, this.bindGroups[readIndex]);
		pass.draw(3);
		pass.end();
	}

	dispose(): void {
		this.bindGroups = null;
	}
}
