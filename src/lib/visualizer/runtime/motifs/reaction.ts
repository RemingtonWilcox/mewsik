// Reaction-diffusion motif — Pearson 1993 Gray-Scott PDE.
// Reference parameter chart: Karl Sims, karlsims.com/rd.html
//
//   ∂U/∂t = Du·∇²U − U·V² + F·(1−U)
//   ∂V/∂t = Dv·∇²V + U·V² − (F+k)·V
//
// Different (F, k) regions of parameter space give wildly different
// patterns. We morph (F, k) by section so the same surface evolves from
// stripes (calm/intro) → fingerprint maze (verse) → spots/mitosis
// (build) → coral (chorus/drop). Bass kicks nudge F so transients land
// as new active sites. Result: a slowly-evolving organic surface that
// recognizably tracks song structure.
//
// Storage: two rgba16float textures (R=U, G=V), ping-pong each substep.
// 3 substeps per frame keeps evolution visible without melting.

import type { MotifModule, RuntimeContext } from '../types.js';
import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const FORMAT: GPUTextureFormat = 'rgba16float';
const SUBSTEPS_PER_FRAME = 2;

const SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var inTex: texture_2d<f32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var samp: sampler;

fn hash11(x: u32) -> f32 {
	var v = x * 747796405u + 2891336453u;
	v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
	v = (v >> 22u) ^ v;
	return f32(v) * (1.0 / 4294967295.0);
}

// ── INIT: seed U=1 everywhere, V=0 except a clustered disc + jitter ──────
@compute @workgroup_size(8, 8)
fn init_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let dims = textureDimensions(outTex);
	if (gid.x >= dims.x || gid.y >= dims.y) { return; }
	let cx = f32(dims.x) * 0.5;
	let cy = f32(dims.y) * 0.5;
	let r = length(vec2<f32>(f32(gid.x) - cx, f32(gid.y) - cy));
	let disc = step(r, 32.0);
	let n = hash11(gid.x * 1973u + gid.y * 9277u);
	let jitter = step(0.997, n);
	let V = max(disc * 0.5, jitter * 0.6);
	textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(1.0 - V * 0.5, V, 0.0, 1.0));
}

// Section-driven (F, k) from Karl Sims' parameter regions.
fn paramsForSection(sec: u32) -> vec2<f32> {
	// 0=calm,1=intro,2=verse,3=pre_chorus,4=build,5=drop,6=chorus,7=bridge,8=breakdown,9=outro
	switch sec {
		case 0u: { return vec2<f32>(0.0220, 0.0510); } // stripes
		case 1u: { return vec2<f32>(0.0220, 0.0510); } // stripes
		case 2u: { return vec2<f32>(0.0290, 0.0570); } // fingerprint / maze
		case 3u: { return vec2<f32>(0.0340, 0.0625); } // pre_chorus
		case 4u: { return vec2<f32>(0.0367, 0.0649); } // spots / mitosis
		case 5u: { return vec2<f32>(0.0545, 0.0620); } // coral
		case 6u: { return vec2<f32>(0.0545, 0.0620); } // coral
		case 7u: { return vec2<f32>(0.0260, 0.0510); } // chaos
		case 8u: { return vec2<f32>(0.0220, 0.0510); } // back to stripes
		case 9u: { return vec2<f32>(0.0220, 0.0510); }
		default: { return vec2<f32>(0.0367, 0.0649); }
	}
}

// ── STEP: 5-point laplacian + reaction terms ─────────────────────────────
@compute @workgroup_size(8, 8)
fn step_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let dims = textureDimensions(outTex);
	if (gid.x >= dims.x || gid.y >= dims.y) { return; }
	let p = vec2<i32>(gid.xy);

	let xN = i32(min(u32(p.x + 1), dims.x - 1u));
	let xP = i32(max(p.x - 1, 0));
	let yN = i32(min(u32(p.y + 1), dims.y - 1u));
	let yP = i32(max(p.y - 1, 0));

	let c  = textureLoad(inTex, p, 0).rg;
	let xn = textureLoad(inTex, vec2<i32>(xN, p.y), 0).rg;
	let xp = textureLoad(inTex, vec2<i32>(xP, p.y), 0).rg;
	let yn = textureLoad(inTex, vec2<i32>(p.x, yN), 0).rg;
	let yp = textureLoad(inTex, vec2<i32>(p.x, yP), 0).rg;
	let cx = textureLoad(inTex, vec2<i32>(xN, yN), 0).rg;
	let cy = textureLoad(inTex, vec2<i32>(xP, yN), 0).rg;
	let cz = textureLoad(inTex, vec2<i32>(xN, yP), 0).rg;
	let cw = textureLoad(inTex, vec2<i32>(xP, yP), 0).rg;

	// 9-point laplacian (more isotropic than the 5-point cross).
	let lap = (xn + xp + yn + yp) * 0.2 + (cx + cy + cz + cw) * 0.05 - c * 1.0;
	let lapU = lap.r;
	let lapV = lap.g;

	let U = c.r;
	let V = c.g;

	let sec = dir.section.x;
	let fk = paramsForSection(sec);
	var F = fk.x;
	var k = fk.y;
	// Bass + drop anticipation nudge F upward — transient spawns more
	// active sites, the pattern locally bifurcates into spots.
	let bassPunch = dir.mood.z;
	let antic = dir.drop.w;
	F = F + bassPunch * 0.012 + antic * 0.005;

	let Du = 1.0;
	let Dv = 0.5;
	// dt slightly higher in chorus so the surface evolves visibly faster.
	let energy = dir.energy.x;
	let dt = 0.8 + energy * 0.25;

	let UVV = U * V * V;
	let dU = (Du * lapU - UVV + F * (1.0 - U)) * dt;
	let dV = (Dv * lapV + UVV - (F + k) * V) * dt;
	let newU = clamp(U + dU, 0.0, 1.0);
	let newV = clamp(V + dV, 0.0, 1.0);

	textureStore(outTex, p, vec4<f32>(newU, newV, 0.0, 1.0));
}

// ── RENDER ──────────────────────────────────────────────────────────────
struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_render(@builtin(vertex_index) vi: u32) -> VsOut {
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

@group(0) @binding(0) var<uniform> dirR: Director;
@group(0) @binding(1) var sampR: sampler;
@group(0) @binding(2) var fieldR: texture_2d<f32>;

@fragment
fn fs_render(in: VsOut) -> @location(0) vec4<f32> {
	let s = textureSampleLevel(fieldR, sampR, in.uv, 0.0);
	let V = s.g;
	let U = s.r;

	let baseHue = dirR.palette.x;
	let rimHue  = dirR.palette.z;
	let sat     = dirR.palette.w;

	// Pattern intensity → color tint between base (high V) and rim (low V).
	let intensity = pow(clamp(V, 0.0, 1.0), 0.8);
	let valley = pow(clamp(1.0 - U, 0.0, 1.0), 1.2);

	let cHi = hsv2rgb(vec3<f32>(fract(baseHue),   sat * 0.85, 1.0));
	let cLo = hsv2rgb(vec3<f32>(fract(rimHue),    sat * 0.6,  0.6));
	let col = mix(cLo, cHi, intensity);
	let glow = col * (intensity * 0.56 + valley * 0.12);

	// Anticipation slightly amplifies pre-drop.
	let antic = dirR.drop.w;
	return vec4<f32>(glow * (0.28 + antic * 0.14), 1.0);
}
`;

export function createReactionMotif(): MotifModule {
	let texA: GPUTexture | null = null;
	let texB: GPUTexture | null = null;
	let viewA: GPUTextureView | null = null;
	let viewB: GPUTextureView | null = null;
	let sampler: GPUSampler | null = null;

	let initPipeline: GPUComputePipeline | null = null;
	let stepPipeline: GPUComputePipeline | null = null;
	let renderPipeline: GPURenderPipeline | null = null;

	let computeLayout: GPUBindGroupLayout | null = null;
	let renderLayout: GPUBindGroupLayout | null = null;
	let bgsCompute: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
	let bgsRender: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];

	let needsInit = true;
	let pingFlip = 0;
	let w = 0;
	let h = 0;

	function createTextures(ctx: RuntimeContext) {
		// Quarter-canvas working res — RD evolves slowly enough that 1:4 looks
		// fine after upsample, and we get 16× the throughput.
		w = Math.max(160, Math.floor(ctx.width / 4));
		h = Math.max(90, Math.floor(ctx.height / 4));
		texA = ctx.device.createTexture({
			label: 'reaction_A',
			size: [w, h, 1],
			format: FORMAT,
			usage:
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST
		});
		texB = ctx.device.createTexture({
			label: 'reaction_B',
			size: [w, h, 1],
			format: FORMAT,
			usage:
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST
		});
		viewA = texA.createView();
		viewB = texB.createView();
	}

	function buildBindGroups(ctx: RuntimeContext) {
		if (!computeLayout || !renderLayout || !viewA || !viewB || !sampler) return;
		const mkC = (inV: GPUTextureView, outV: GPUTextureView) =>
			ctx.device.createBindGroup({
				label: 'reaction_compute_bg',
				layout: computeLayout!,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: inV },
					{ binding: 2, resource: outV },
					{ binding: 3, resource: sampler! }
				]
			});
		bgsCompute = [mkC(viewA, viewB), mkC(viewB, viewA)];
		const mkR = (v: GPUTextureView) =>
			ctx.device.createBindGroup({
				label: 'reaction_render_bg',
				layout: renderLayout!,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: sampler! },
					{ binding: 2, resource: v }
				]
			});
		bgsRender = [mkR(viewB), mkR(viewA)];
	}

	return {
		id: 'lattice',
		init(ctx: RuntimeContext) {
			const { device } = ctx;
			sampler = device.createSampler({
				magFilter: 'linear',
				minFilter: 'linear',
				addressModeU: 'clamp-to-edge',
				addressModeV: 'clamp-to-edge'
			});
			createTextures(ctx);

			computeLayout = device.createBindGroupLayout({
				label: 'reaction_compute_bgl',
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.COMPUTE,
						buffer: { type: 'uniform' }
					},
					{
						binding: 1,
						visibility: GPUShaderStage.COMPUTE,
						texture: { sampleType: 'float' }
					},
					{
						binding: 2,
						visibility: GPUShaderStage.COMPUTE,
						storageTexture: { access: 'write-only', format: FORMAT }
					},
					{ binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: {} }
				]
			});
			renderLayout = device.createBindGroupLayout({
				label: 'reaction_render_bgl',
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

			const module = device.createShaderModule({ label: 'reaction_shader', code: SHADER });

			const computePL = device.createPipelineLayout({
				label: 'reaction_compute_pl',
				bindGroupLayouts: [computeLayout]
			});
			initPipeline = device.createComputePipeline({
				label: 'reaction_init',
				layout: computePL,
				compute: { module, entryPoint: 'init_main' }
			});
			stepPipeline = device.createComputePipeline({
				label: 'reaction_step',
				layout: computePL,
				compute: { module, entryPoint: 'step_main' }
			});

			const renderPL = device.createPipelineLayout({
				label: 'reaction_render_pl',
				bindGroupLayouts: [renderLayout]
			});
			renderPipeline = device.createRenderPipeline({
				label: 'reaction_render_pipeline',
				layout: renderPL,
				vertex: { module, entryPoint: 'vs_render' },
				fragment: {
					module,
					entryPoint: 'fs_render',
					targets: [
						{
							format: ctx.hdrFormat,
							blend: {
								color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
								alpha: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' }
							}
						}
					]
				},
				primitive: { topology: 'triangle-list' }
			});

			buildBindGroups(ctx);
			needsInit = true;
		},
		resize(ctx: RuntimeContext) {
			if (texA) texA.destroy();
			if (texB) texB.destroy();
			createTextures(ctx);
			buildBindGroups(ctx);
			needsInit = true;
		},
		update(_frame, _time, _dt) {},
		render(encoder, ctx, weight) {
			if (!initPipeline || !stepPipeline || !renderPipeline) return;
			const renderWeight = Math.max(0, Math.min(1, weight));

			const gx = Math.ceil(w / 8);
			const gy = Math.ceil(h / 8);

			if (needsInit) {
				// Init writes to whatever the "out" view currently is for ping 0,
				// then the next step swaps so the seeded texture becomes the input.
				const pass = encoder.beginComputePass({ label: 'reaction_init_pass' });
				pass.setPipeline(initPipeline);
				pass.setBindGroup(0, bgsCompute[0]!);
				pass.dispatchWorkgroups(gx, gy);
				pass.end();
				needsInit = false;
				pingFlip = 1; // next step reads from seeded B → writes to A
			}

			for (let s = 0; s < SUBSTEPS_PER_FRAME; s++) {
				const pass = encoder.beginComputePass({ label: `reaction_step_${s}` });
				pass.setPipeline(stepPipeline);
				pass.setBindGroup(0, bgsCompute[pingFlip]!);
				pass.dispatchWorkgroups(gx, gy);
				pass.end();
				pingFlip = pingFlip === 0 ? 1 : 0;
			}

			const rPass = encoder.beginRenderPass({
				label: 'reaction_render_pass',
				colorAttachments: [
					{
						view: ctx.sceneHDRView,
						loadOp: 'load',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			rPass.setPipeline(renderPipeline);
			// pingFlip points at the next OUT; the last written one is the inverse.
			rPass.setBindGroup(0, bgsRender[pingFlip === 0 ? 1 : 0]!);
			rPass.setBlendConstant({
				r: renderWeight,
				g: renderWeight,
				b: renderWeight,
				a: renderWeight
			});
			rPass.draw(3);
			rPass.end();
			void ctx;
		},
		dispose() {
			texA?.destroy();
			texB?.destroy();
			texA = null;
			texB = null;
			viewA = null;
			viewB = null;
			initPipeline = null;
			stepPipeline = null;
			renderPipeline = null;
			computeLayout = null;
			renderLayout = null;
			bgsCompute = [null, null];
			bgsRender = [null, null];
		}
	};
}
