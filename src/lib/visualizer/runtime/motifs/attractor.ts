// Strange-attractor motif — 2D iterated maps (De Jong + Clifford).
// Reference: Pickover, "Computers, Pattern, Chaos and Beauty" (1990);
// catalogued by Paul Bourke (paulbourke.net/fractals/peterdejong/).
//
//   De Jong:   x' = sin(a·y) − cos(b·x)
//              y' = sin(c·x) − cos(d·y)
//   Clifford:  x' = sin(a·y) + c·cos(a·x)
//              y' = sin(b·x) + d·cos(b·y)
//
// 80k particles each run one iteration per frame. The attractor is the
// long-term distribution of orbits, painted into the HDR target by
// additive blend over time. (a, b, c, d) are driven by the tonnetz
// 6-vector so harmonic key changes warp the topology — minor third
// shifts vs perfect-fifth shifts produce different filament patterns.

import type { MotifModule, RuntimeContext } from '../types.js';
import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const PARTICLE_COUNT = 80_000;
const PARTICLE_BYTES = 16; // pos vec2 + seed f32 + flavor f32

// Two shader modules — WebGPU forbids 'storage' (read_write) bindings in
// the vertex stage. Compute needs read_write to update particles; render
// only reads. Splitting modules avoids the access-mode mismatch that
// invalidates the entire frame.
const PARTICLE_STRUCT_WGSL = /* wgsl */ `
struct Particle {
	pos: vec2<f32>,
	seed: f32,
	flavor: f32,
};
`;

const COMPUTE_SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}
${PARTICLE_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn hash11(x: u32) -> f32 {
	var v = x * 747796405u + 2891336453u;
	v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
	v = (v >> 22u) ^ v;
	return f32(v) * (1.0 / 4294967295.0);
}

fn paramsFromTonnetz() -> vec4<f32> {
	let t = dir.tonnetz_a;
	let u = dir.tonnetz_b;
	let bass = dir.mood.z;
	let antic = dir.drop.w;
	let a = 1.8 + t.x * 1.1 + bass * 0.3;
	let b = -1.6 + t.y * 1.2 + antic * 0.2;
	let c = 1.4 + t.z * 0.9;
	let d = -1.2 + t.w * 0.9 + u.x * 0.6;
	return vec4<f32>(a, b, c, d);
}

@compute @workgroup_size(64)
fn init_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	let x = (hash11(i * 5u + 1u) - 0.5) * 2.0;
	let y = (hash11(i * 11u + 3u) - 0.5) * 2.0;
	let flavor = floor(hash11(i * 23u + 7u) * 2.0);
	particles[i].pos = vec2<f32>(x, y);
	particles[i].seed = hash11(i * 7u + 13u);
	particles[i].flavor = flavor;
}

@compute @workgroup_size(64)
fn step_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	var p = particles[i];
	let abcd = paramsFromTonnetz();
	let a = abcd.x;
	let b = abcd.y;
	let c = abcd.z;
	let d = abcd.w;
	var nx: f32;
	var ny: f32;
	if (p.flavor < 0.5) {
		nx = sin(a * p.pos.y) - cos(b * p.pos.x);
		ny = sin(c * p.pos.x) - cos(d * p.pos.y);
	} else {
		nx = sin(a * p.pos.y) + c * cos(a * p.pos.x);
		ny = sin(b * p.pos.x) + d * cos(b * p.pos.y);
	}
	p.pos = vec2<f32>(nx, ny);

	let downbeat = f32(dir.clockI.w);
	let postDrop = dir.drop2.x;
	let reseedProb = downbeat * 0.02 + postDrop * 0.06;
	let r = hash11(i + u32(dir.viewport.z * 1733.0));
	if (r < reseedProb) {
		let rx = (hash11(i * 7u + u32(dir.viewport.z * 911.0)) - 0.5) * 2.0;
		let ry = (hash11(i * 11u + u32(dir.viewport.z * 1933.0)) - 0.5) * 2.0;
		p.pos = vec2<f32>(rx, ry);
	}
	particles[i] = p;
}
`;

const RENDER_SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}
${PARTICLE_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) col: vec3<f32>,
};

@vertex
fn vs_render(
	@builtin(vertex_index) vi: u32,
	@builtin(instance_index) ii: u32
) -> VsOut {
	let p = particles[ii];

	var corners = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>( 1.0,  1.0)
	);
	let corner = corners[vi];

	let viewport = dir.viewport.xy;
	let aspect = viewport.x / max(viewport.y, 1.0);

	let world = p.pos * 0.35;
	let ndc = vec2<f32>(world.x / aspect, world.y);

	let baseHue = dir.palette.x;
	let accentHue = dir.palette.y;
	let rimHue = dir.palette.z;
	let sat = dir.palette.w;
	let hue = mix(baseHue, rimHue, p.flavor) + (p.seed - 0.5) * 0.06 + accentHue * 0.04;
	let col = hsv2rgb(vec3<f32>(fract(hue), sat * 0.9, 1.0));

	let radiusPx = 1.6 + dir.energy.x * 1.4 + dir.drop2.x * 1.2;
	let radiusNdc = radiusPx * 2.0 / max(viewport.y, 1.0);

	var out: VsOut;
	out.pos = vec4<f32>(ndc + corner * radiusNdc, 0.0, 1.0);
	out.uv = corner;
	out.col = col;
	return out;
}

@fragment
fn fs_render(in: VsOut) -> @location(0) vec4<f32> {
	let d = length(in.uv);
	let glow = exp(-d * d * 4.0);
	let intensity = glow * (0.18 + dir.energy.x * 0.18);
	return vec4<f32>(in.col * intensity, intensity);
}
`;

export function createAttractorMotif(): MotifModule {
	let particleBuf: GPUBuffer | null = null;
	let computeLayout: GPUBindGroupLayout | null = null;
	let renderLayout: GPUBindGroupLayout | null = null;
	let initPipeline: GPUComputePipeline | null = null;
	let stepPipeline: GPUComputePipeline | null = null;
	let renderPipeline: GPURenderPipeline | null = null;
	let computeBg: GPUBindGroup | null = null;
	let renderBg: GPUBindGroup | null = null;
	let needsInit = true;

	return {
		// Re-use 'organism' MotifId — the strange attractor stands in for the
		// future Lomas-mesh "organism" until that lands. Weight policy treats
		// it as the "structure" motif (active in verses + bridges, quieter
		// during drops where physarum dominates).
		id: 'organism',
		init(ctx: RuntimeContext) {
			const { device } = ctx;
			particleBuf = device.createBuffer({
				label: 'attractor_particles',
				size: PARTICLE_COUNT * PARTICLE_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});

			computeLayout = device.createBindGroupLayout({
				label: 'attractor_compute_bgl',
				entries: [
					{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
					{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
				]
			});
			renderLayout = device.createBindGroupLayout({
				label: 'attractor_render_bgl',
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
						buffer: { type: 'uniform' }
					},
					{
						binding: 1,
						visibility: GPUShaderStage.VERTEX,
						buffer: { type: 'read-only-storage' }
					}
				]
			});

			const computeModule = device.createShaderModule({
				label: 'attractor_compute_shader',
				code: COMPUTE_SHADER
			});
			const renderModule = device.createShaderModule({
				label: 'attractor_render_shader',
				code: RENDER_SHADER
			});

			const computePL = device.createPipelineLayout({
				label: 'attractor_compute_pl',
				bindGroupLayouts: [computeLayout]
			});
			initPipeline = device.createComputePipeline({
				label: 'attractor_init',
				layout: computePL,
				compute: { module: computeModule, entryPoint: 'init_main' }
			});
			stepPipeline = device.createComputePipeline({
				label: 'attractor_step',
				layout: computePL,
				compute: { module: computeModule, entryPoint: 'step_main' }
			});

			const renderPL = device.createPipelineLayout({
				label: 'attractor_render_pl',
				bindGroupLayouts: [renderLayout]
			});
			renderPipeline = device.createRenderPipeline({
				label: 'attractor_render_pipeline',
				layout: renderPL,
				vertex: { module: renderModule, entryPoint: 'vs_render' },
				fragment: {
					module: renderModule,
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

			computeBg = device.createBindGroup({
				label: 'attractor_compute_bg',
				layout: computeLayout,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: { buffer: particleBuf } }
				]
			});
			renderBg = device.createBindGroup({
				label: 'attractor_render_bg',
				layout: renderLayout,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: { buffer: particleBuf } }
				]
			});
			needsInit = true;
		},
		resize(_ctx: RuntimeContext) {
			needsInit = true;
		},
		update(_frame, _time, _dt) {},
		render(encoder, ctx, weight) {
			if (!initPipeline || !stepPipeline || !renderPipeline || !computeBg || !renderBg) return;
			const renderWeight = Math.max(0, Math.min(1, weight));
			const groups = Math.ceil(PARTICLE_COUNT / 64);
			if (needsInit) {
				const pass = encoder.beginComputePass({ label: 'attractor_init_pass' });
				pass.setPipeline(initPipeline);
				pass.setBindGroup(0, computeBg);
				pass.dispatchWorkgroups(groups);
				pass.end();
				needsInit = false;
			}
			const stepPass = encoder.beginComputePass({ label: 'attractor_step_pass' });
			stepPass.setPipeline(stepPipeline);
			stepPass.setBindGroup(0, computeBg);
			stepPass.dispatchWorkgroups(groups);
			stepPass.end();

			const rPass = encoder.beginRenderPass({
				label: 'attractor_render_pass',
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
			rPass.setBindGroup(0, renderBg);
			rPass.setBlendConstant({
				r: renderWeight,
				g: renderWeight,
				b: renderWeight,
				a: renderWeight
			});
			rPass.draw(6, PARTICLE_COUNT);
			rPass.end();
		},
		dispose() {
			particleBuf?.destroy();
			particleBuf = null;
			initPipeline = null;
			stepPipeline = null;
			renderPipeline = null;
			computeLayout = null;
			renderLayout = null;
			computeBg = null;
			renderBg = null;
		}
	};
}
