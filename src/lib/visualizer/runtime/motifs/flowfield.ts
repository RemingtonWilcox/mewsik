// Flow-field motif — Tyler Hobbs "Fidenza" aesthetic.
// Reference: tylerxhobbs.com/essays/2020/flow-fields
//
// 50k GPU particles in a storage buffer, advected through a curl-noise
// vector field (analytic 2D curl from finite-difference simplex-like
// noise — Bridson 2007 style). Each particle ages out, respawning at a
// new random screen edge with a fresh palette offset.
//
// Render is instanced quads — 6 verts × N particles via vertex pulling
// from the storage buffer. Fragment shader draws a soft circular sprite
// with palette-tinted glow, additive-blended into the HDR target so trails
// accumulate naturally without trail textures.
//
// Sits next to Physarum: Physarum gives blobs / fields / pheromone knots;
// Hobbs gives strokes / streaks / linear motion. Two different visual
// vocabularies driven from the same director uniform.

import type { MotifModule, RuntimeContext } from '../types.js';
import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const PARTICLE_COUNT = 48_000;
const PARTICLE_BYTES = 32; // 8 floats: pos(2) + vel(2) + age + life + hue + pad

const PARTICLE_STRUCT_WGSL = /* wgsl */ `
struct Particle {
	pos: vec2<f32>,
	vel: vec2<f32>,
	age: f32,
	life: f32,
	hueOffset: f32,
	_pad: f32,
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

fn hash21(p: vec2<f32>) -> f32 {
	let h = dot(p, vec2<f32>(127.1, 311.7));
	return fract(sin(h) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let a = hash21(i);
	let b = hash21(i + vec2<f32>(1.0, 0.0));
	let c = hash21(i + vec2<f32>(0.0, 1.0));
	let d = hash21(i + vec2<f32>(1.0, 1.0));
	let u = f * f * (3.0 - 2.0 * f);
	return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

fn fbm(p: vec2<f32>) -> f32 {
	return vnoise(p) * 0.6 + vnoise(p * 2.07 + vec2<f32>(13.2, 7.7)) * 0.3 + vnoise(p * 4.13 + vec2<f32>(-5.1, 21.4)) * 0.12;
}

fn curl2D(p: vec2<f32>) -> vec2<f32> {
	let eps = 0.18;
	let n1 = fbm(p + vec2<f32>(0.0, eps));
	let n2 = fbm(p - vec2<f32>(0.0, eps));
	let n3 = fbm(p + vec2<f32>(eps, 0.0));
	let n4 = fbm(p - vec2<f32>(eps, 0.0));
	return vec2<f32>((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}

fn respawn(i: u32, seed: u32) -> Particle {
	let viewport = dir.viewport.xy;
	let edge = u32(hash11(seed + 1u) * 4.0);
	var pos: vec2<f32>;
	let rJitter = hash11(seed + 2u);
	if (edge == 0u) {
		pos = vec2<f32>(rJitter * viewport.x, -0.02 * viewport.y);
	} else if (edge == 1u) {
		pos = vec2<f32>(viewport.x * 1.02, rJitter * viewport.y);
	} else if (edge == 2u) {
		pos = vec2<f32>(rJitter * viewport.x, viewport.y * 1.02);
	} else {
		pos = vec2<f32>(-0.02 * viewport.x, rJitter * viewport.y);
	}
	let life = 2.2 + hash11(seed + 3u) * 4.5;
	let hue = hash11(seed + 4u);
	var p: Particle;
	p.pos = pos;
	p.vel = vec2<f32>(0.0);
	p.age = 0.0;
	p.life = life;
	p.hueOffset = hue;
	p._pad = 0.0;
	return p;
}

// ── INIT ──────────────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn init_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	particles[i] = respawn(i, i * 11u);
	// Pre-age randomly so the field doesn't start in lock-step.
	particles[i].age = hash11(i * 17u) * particles[i].life;
}

// ── STEP ──────────────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn step_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&particles)) { return; }
	var p = particles[i];
	let dt = clamp(dir.viewport.w, 1.0 / 240.0, 1.0 / 30.0);

	let viewport = dir.viewport.xy;
	let motion = dir.energy.z;
	let energy = dir.energy.x;
	let bassPunch = dir.mood.z;
	let antic = dir.drop.w;
	let postDrop = dir.drop2.x;
	let downbeat = f32(dir.clockI.w);

	// Curl-noise field — slowly drifting time term + audio-modulated scale.
	let timePhase = dir.viewport.z * (0.06 + motion * 0.12);
	let scale = 0.0024 / (1.0 + energy * 0.5);
	let sample = p.pos * scale + vec2<f32>(timePhase, -timePhase * 0.6);
	let curl = curl2D(sample);

	let flowMag = 240.0 * (0.45 + motion * 0.7 + antic * 0.6);
	var force = curl * flowMag;

	// Bass kicks add a downward gravity-like pulse so the field "lands".
	force.y = force.y + bassPunch * 35.0;

	// Downbeat: brief radial outward impulse from screen center.
	if (downbeat > 0.5) {
		let toCenter = p.pos - viewport * 0.5;
		let d = max(length(toCenter), 1.0);
		force = force + (toCenter / d) * 90.0;
	}

	p.vel = p.vel + force * dt;
	p.vel = p.vel * (1.0 - 0.85 * dt); // damping
	p.pos = p.pos + p.vel * dt;
	p.age = p.age + dt;

	// Respawn out-of-bounds or aged-out.
	let outOfBounds = p.pos.x < -viewport.x * 0.1 || p.pos.x > viewport.x * 1.1
		|| p.pos.y < -viewport.y * 0.1 || p.pos.y > viewport.y * 1.1;
	if (p.age > p.life || outOfBounds) {
		let seed = i + u32(dir.viewport.z * 60.0) * 113u;
		p = respawn(i, seed);
	}

	// Post-drop: occasionally short-circuit lifetime so the field "blooms"
	// with fresh emission for ~1 bar after the watershed.
	if (postDrop > 0.4) {
		let r = hash11(i + u32(dir.viewport.z * 1000.0));
		if (r > 0.997) {
			p = respawn(i, i + u32(dir.viewport.z * 7919.0));
		}
	}

	particles[i] = p;
}
`;

const RENDER_SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}
${PARTICLE_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

// ── RENDER ───────────────────────────────────────────────────────────────
struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) col: vec3<f32>,
	@location(2) lifeT: f32,
};

@vertex
fn vs_render(
	@builtin(vertex_index) vi: u32,
	@builtin(instance_index) ii: u32
) -> VsOut {
	let p = particles[ii];
	let viewport = dir.viewport.xy;

	// Quad corners (two triangles via 6-vertex degenerate strip).
	var corners = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>( 1.0,  1.0)
	);
	let corner = corners[vi];

	let lifeT = clamp(p.age / max(p.life, 0.0001), 0.0, 1.0);
	let fade = 1.0 - lifeT;
	// Radius scales with energy + bass punch + slight age-out shrink.
	let radiusBase = 1.8 + dir.energy.x * 2.4 + dir.mood.z * 1.8;
	let radius = radiusBase * (0.52 + fade * 0.42 + dir.drop2.x * 0.16);

	let worldPos = p.pos + corner * radius;
	// Map pixel coordinates → NDC.
	let ndc = vec2<f32>(
		worldPos.x / viewport.x * 2.0 - 1.0,
		1.0 - worldPos.y / viewport.y * 2.0
	);

	let baseHue = dir.palette.x + p.hueOffset * 0.08 + dir.palette2.y * 0.05;
	let sat = dir.palette.w * 0.95;
	let col = hsv2rgb(vec3<f32>(fract(baseHue), sat, 1.0));

	var out: VsOut;
	out.pos = vec4<f32>(ndc, 0.0, 1.0);
	out.uv = corner;
	out.col = col;
	out.lifeT = lifeT;
	return out;
}

@fragment
fn fs_render(in: VsOut) -> @location(0) vec4<f32> {
	// Soft circle — Gaussian-ish falloff with a tight core.
	let d = length(in.uv);
	let core = exp(-d * d * 3.0);
	let halo = exp(-d * d * 1.6) * 0.18;
	let intensity = (core + halo) * (1.0 - in.lifeT);

	let postDrop = dir.drop2.x;
	let glow = in.col * intensity * (0.32 + postDrop * 0.22);
	return vec4<f32>(glow, intensity);
}
`;

export function createFlowFieldMotif(): MotifModule {
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
		id: 'ribbon',
		init(ctx: RuntimeContext) {
			const { device } = ctx;
			particleBuf = device.createBuffer({
				label: 'flowfield_particles',
				size: PARTICLE_COUNT * PARTICLE_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});

			computeLayout = device.createBindGroupLayout({
				label: 'flowfield_compute_bgl',
				entries: [
					{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
					{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
				]
			});
			renderLayout = device.createBindGroupLayout({
				label: 'flowfield_render_bgl',
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
				label: 'flowfield_compute_shader',
				code: COMPUTE_SHADER
			});
			const renderModule = device.createShaderModule({
				label: 'flowfield_render_shader',
				code: RENDER_SHADER
			});

			const computePL = device.createPipelineLayout({
				label: 'flowfield_compute_pl',
				bindGroupLayouts: [computeLayout]
			});
			initPipeline = device.createComputePipeline({
				label: 'flowfield_init',
				layout: computePL,
				compute: { module: computeModule, entryPoint: 'init_main' }
			});
			stepPipeline = device.createComputePipeline({
				label: 'flowfield_step',
				layout: computePL,
				compute: { module: computeModule, entryPoint: 'step_main' }
			});

			const renderPL = device.createPipelineLayout({
				label: 'flowfield_render_pl',
				bindGroupLayouts: [renderLayout]
			});
			renderPipeline = device.createRenderPipeline({
				label: 'flowfield_render_pipeline',
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
				label: 'flowfield_compute_bg',
				layout: computeLayout,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: { buffer: particleBuf } }
				]
			});
			renderBg = device.createBindGroup({
				label: 'flowfield_render_bg',
				layout: renderLayout,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: { buffer: particleBuf } }
				]
			});
			needsInit = true;
		},
		resize(_ctx: RuntimeContext) {
			// Particle positions are in pixel space — viewport change just re-spreads them.
			needsInit = true;
		},
		update(_frame, _time, _dt) {},
		render(encoder, ctx, weight) {
			if (!initPipeline || !stepPipeline || !renderPipeline || !computeBg || !renderBg) return;
			const renderWeight = Math.max(0, Math.min(1, weight));

			const groups = Math.ceil(PARTICLE_COUNT / 64);

			if (needsInit) {
				const pass = encoder.beginComputePass({ label: 'flowfield_init_pass' });
				pass.setPipeline(initPipeline);
				pass.setBindGroup(0, computeBg);
				pass.dispatchWorkgroups(groups);
				pass.end();
				needsInit = false;
			}

			const stepPass = encoder.beginComputePass({ label: 'flowfield_step_pass' });
			stepPass.setPipeline(stepPipeline);
			stepPass.setBindGroup(0, computeBg);
			stepPass.dispatchWorkgroups(groups);
			stepPass.end();

			const rPass = encoder.beginRenderPass({
				label: 'flowfield_render_pass',
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
			computeBg = null;
			renderBg = null;
			computeLayout = null;
			renderLayout = null;
		}
	};
}
