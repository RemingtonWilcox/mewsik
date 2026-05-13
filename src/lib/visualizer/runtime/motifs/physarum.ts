// Physarum motif — Sage Jenson's four-parameter slime mold simulation.
// Reference: Jeff Jones, "Characteristics of Pattern Formation and Evolution
// in Approximations of Physarum Transport Networks" (2010); Sage Jenson's
// reference parameter sets at sagejenson.com/physarum.
//
// Pipeline per frame:
//   1. diffuse compute   — pheromone A → B (3x3 box blur + decay)
//   2. step compute      — agents sense A, rotate, move, deposit on B
//   3. render            — full-screen pass sampling B with palette tint
//   4. swap A <-> B
//
// Audio routing (consumed via the shared director uniform):
//   directed.motion       → sense angle (narrow → wide cone)
//   directed.density      → sense distance
//   directed.bassPunch    → rotation strength (sharper turns on kick)
//   directed.energy       → deposit magnitude (brighter trails when loud)
//   directed.drop.anticipation → forward speed (accelerates pre-drop)
//   directed.drop.postDropDecay → decay slowdown (longer trails after drop)
//   directed.clock.downbeatFlag → micro-jitter on heading (bar-locked)

import type { MotifModule, RuntimeContext } from '../types.js';
import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const AGENT_COUNT = 90_000;
const AGENT_STRIDE = 16; // vec2 pos + f32 heading + f32 species
const PHEROMONE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}

struct Agent {
	pos: vec2<f32>,
	heading: f32,
	species: f32,
};

@group(0) @binding(0) var<uniform> dir: Director;
@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var pheroIn: texture_2d<f32>;
@group(0) @binding(4) var pheroOut: texture_storage_2d<rgba8unorm, write>;

fn hash11(x: u32) -> f32 {
	var v = x * 747796405u + 2891336453u;
	v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
	v = (v >> 22u) ^ v;
	return f32(v) * (1.0 / 4294967295.0);
}

fn senseAt(pos: vec2<f32>, angle: f32, dist: f32, dims: vec2<f32>) -> f32 {
	let p = pos + vec2<f32>(cos(angle), sin(angle)) * dist;
	let uv = p / dims;
	let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
	let s = textureSampleLevel(pheroIn, samp, uv, 0.0);
	return (s.r * 0.6 + s.g * 0.3 + s.b * 0.1) * inside;
}

// ── INIT: scatter agents in a disc, random heading ─────────────────────────
@compute @workgroup_size(64)
fn init_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&agents)) { return; }
	let dims = dir.viewport.xy;
	let phero = vec2<f32>(textureDimensions(pheroOut));
	let cx = phero.x * 0.5;
	let cy = phero.y * 0.5;
	let r = sqrt(hash11(i * 7u + 11u)) * min(phero.x, phero.y) * 0.42;
	let a = hash11(i * 13u + 27u) * 6.28318;
	agents[i].pos = vec2<f32>(cx + cos(a) * r, cy + sin(a) * r);
	agents[i].heading = hash11(i * 91u + 3u) * 6.28318;
	agents[i].species = floor(hash11(i * 41u + 5u) * 3.0);
}

// ── DIFFUSE: 3x3 box blur + decay, reads pheroIn, writes pheroOut ─────────
@compute @workgroup_size(8, 8)
fn diffuse_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let pheroDims = textureDimensions(pheroOut);
	if (gid.x >= pheroDims.x || gid.y >= pheroDims.y) { return; }

	let energy = dir.energy.x;
	let postDrop = dir.drop2.x;
	// Decay rate: slower during chorus/drop so trails persist musically.
	let decay = 0.94 + postDrop * 0.045;

	var acc = vec4<f32>(0.0);
	var wsum = 0.0;
	for (var dy = -1; dy <= 1; dy = dy + 1) {
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let p = vec2<i32>(i32(gid.x) + dx, i32(gid.y) + dy);
			let inside = p.x >= 0 && p.x < i32(pheroDims.x) && p.y >= 0 && p.y < i32(pheroDims.y);
			if (inside) {
				let w = select(0.0625, 0.5, dx == 0 && dy == 0);
				let s = textureLoad(pheroIn, vec2<u32>(u32(p.x), u32(p.y)), 0);
				acc = acc + s * w;
				wsum = wsum + w;
			}
		}
	}
	let blurred = acc / max(wsum, 1.0e-5);
	textureStore(pheroOut, vec2<i32>(gid.xy), blurred * decay);
}

// ── STEP: sense / rotate / move / deposit ─────────────────────────────────
@compute @workgroup_size(64)
fn step_main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= arrayLength(&agents)) { return; }
	var a = agents[i];

	let pheroDims = vec2<f32>(textureDimensions(pheroOut));
	let motion = dir.energy.z;
	let density = dir.energy.y;
	let energy = dir.energy.x;
	let bassPunch = dir.mood.z;
	let antic = dir.drop.w;
	let downbeat = f32(dir.clockI.w);

	let senseAngle = 0.38 + motion * 0.55;     // 22° → 55°
	let senseDist = 6.0 + density * 14.0;      // 6px → 20px
	let rotateBase = 0.28 + bassPunch * 0.55;  // 16° → 47°
	let speed = 0.7 + motion * 1.1 + antic * 1.4;
	let depositMag = 0.04 + energy * 0.18;

	let aL = a.heading + senseAngle;
	let aR = a.heading - senseAngle;
	let aF = a.heading;
	let sL = senseAt(a.pos, aL, senseDist, pheroDims);
	let sF = senseAt(a.pos, aF, senseDist, pheroDims);
	let sR = senseAt(a.pos, aR, senseDist, pheroDims);

	let jitter = (hash11(i + u32(dir.viewport.z * 1000.0)) - 0.5) * 0.06 + downbeat * 0.08;
	if (sF > sL && sF > sR) {
		// keep heading
	} else if (sF < sL && sF < sR) {
		a.heading = a.heading + (hash11(i * 7u + 1u) - 0.5) * rotateBase * 2.0;
	} else if (sL > sR) {
		a.heading = a.heading + rotateBase;
	} else if (sR > sL) {
		a.heading = a.heading - rotateBase;
	}
	a.heading = a.heading + jitter;

	a.pos = a.pos + vec2<f32>(cos(a.heading), sin(a.heading)) * speed;

	// Wrap toroidally so agents never disappear.
	if (a.pos.x < 0.0) { a.pos.x = a.pos.x + pheroDims.x; }
	if (a.pos.y < 0.0) { a.pos.y = a.pos.y + pheroDims.y; }
	if (a.pos.x >= pheroDims.x) { a.pos.x = a.pos.x - pheroDims.x; }
	if (a.pos.y >= pheroDims.y) { a.pos.y = a.pos.y - pheroDims.y; }

	agents[i] = a;

	// Deposit on the diffused pheroOut. RGB encodes 3 species channels so
	// future polychromatic Physarum lands cleanly.
	let tx = i32(a.pos.x);
	let ty = i32(a.pos.y);
	if (tx >= 0 && tx < i32(pheroDims.x) && ty >= 0 && ty < i32(pheroDims.y)) {
		let prev = textureLoad(pheroIn, vec2<u32>(u32(tx), u32(ty)), 0);
		var rgb = prev.rgb;
		let sp = i32(a.species);
		if (sp == 0) { rgb.r = min(1.0, rgb.r + depositMag); }
		else if (sp == 1) { rgb.g = min(1.0, rgb.g + depositMag); }
		else { rgb.b = min(1.0, rgb.b + depositMag); }
		textureStore(pheroOut, vec2<i32>(tx, ty), vec4<f32>(rgb, 1.0));
	}
}

// ── RENDER: full-screen quad samples pheroOut with palette tint ──────────
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

@group(0) @binding(0) var<uniform> dir_r: Director;
@group(0) @binding(1) var sampR: sampler;
@group(0) @binding(2) var pheroR: texture_2d<f32>;

@fragment
fn fs_render(in: VsOut) -> @location(0) vec4<f32> {
	let p = textureSampleLevel(pheroR, sampR, in.uv, 0.0).rgb;
	let baseHue = dir_r.palette.x;
	let accentHue = dir_r.palette.y;
	let rimHue = dir_r.palette.z;
	let sat = dir_r.palette.w;

	// Each species gets a tonnetz-neighbor hue. Brightness is exponential
	// in pheromone density so faint trails read alongside dense knots.
	let cR = hsv2rgb(vec3<f32>(fract(baseHue),   sat * 0.85, 1.0));
	let cG = hsv2rgb(vec3<f32>(fract(accentHue), sat * 0.85, 1.0));
	let cB = hsv2rgb(vec3<f32>(fract(rimHue),    sat * 0.85, 1.0));

	let lit = cR * p.r + cG * p.g + cB * p.b;
	let glow = pow(max(p.r + p.g + p.b, 0.0), 1.4);

	// Drop release pumps a brief broadband flare into the field.
	let postDrop = dir_r.drop2.x;
	let flare = postDrop * 0.45;

	let final_col = lit * (0.85 + glow * 0.35) + vec3<f32>(flare) * (p.r + p.g + p.b);
	return vec4<f32>(final_col, 1.0);
}
`;

export function createPhysarumMotif(): MotifModule {
	let agentBuf: GPUBuffer | null = null;
	let pheroA: GPUTexture | null = null;
	let pheroB: GPUTexture | null = null;
	let pheroAView: GPUTextureView | null = null;
	let pheroBView: GPUTextureView | null = null;
	let nearestSampler: GPUSampler | null = null;
	let linearSampler: GPUSampler | null = null;

	let initPipeline: GPUComputePipeline | null = null;
	let diffusePipeline: GPUComputePipeline | null = null;
	let stepPipeline: GPUComputePipeline | null = null;
	let renderPipeline: GPURenderPipeline | null = null;

	let computeLayout: GPUBindGroupLayout | null = null;
	let renderLayout: GPUBindGroupLayout | null = null;
	// 0 = A→B, 1 = B→A. We swap each frame.
	let bgCompute: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
	let bgRender: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];

	let needsInit = true;
	let pingFlip = 0;
	let pheroWidth = 1280;
	let pheroHeight = 720;

	function createTextures(ctx: RuntimeContext) {
		const { device } = ctx;
		// Pheromone field at a fixed working resolution — cheaper than full
		// canvas and keeps trail density consistent across DPRs.
		pheroWidth = Math.min(1920, Math.max(640, Math.floor(ctx.width / 2)));
		pheroHeight = Math.min(1080, Math.max(360, Math.floor(ctx.height / 2)));

		pheroA = device.createTexture({
			label: 'physarum_pheroA',
			size: [pheroWidth, pheroHeight, 1],
			format: PHEROMONE_FORMAT,
			usage:
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST
		});
		pheroB = device.createTexture({
			label: 'physarum_pheroB',
			size: [pheroWidth, pheroHeight, 1],
			format: PHEROMONE_FORMAT,
			usage:
				GPUTextureUsage.STORAGE_BINDING |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST
		});
		pheroAView = pheroA.createView();
		pheroBView = pheroB.createView();
	}

	function buildBindGroups(ctx: RuntimeContext) {
		if (
			!computeLayout ||
			!renderLayout ||
			!agentBuf ||
			!pheroAView ||
			!pheroBView ||
			!nearestSampler ||
			!linearSampler
		)
			return;
		const { device } = ctx;
		// Compute bind groups: in/out pheromone views swap each frame.
		const mkCompute = (inView: GPUTextureView, outView: GPUTextureView) =>
			device.createBindGroup({
				label: 'physarum_compute_bg',
				layout: computeLayout!,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: { buffer: agentBuf! } },
					{ binding: 2, resource: nearestSampler! },
					{ binding: 3, resource: inView },
					{ binding: 4, resource: outView }
				]
			});
		bgCompute = [mkCompute(pheroAView, pheroBView), mkCompute(pheroBView, pheroAView)];

		const mkRender = (view: GPUTextureView) =>
			device.createBindGroup({
				label: 'physarum_render_bg',
				layout: renderLayout!,
				entries: [
					{ binding: 0, resource: { buffer: ctx.directorUniformBuf } },
					{ binding: 1, resource: linearSampler! },
					{ binding: 2, resource: view }
				]
			});
		bgRender = [mkRender(pheroBView), mkRender(pheroAView)];
	}

	return {
		id: 'particles',
		init(ctx: RuntimeContext) {
			const { device } = ctx;

			agentBuf = device.createBuffer({
				label: 'physarum_agents',
				size: AGENT_COUNT * AGENT_STRIDE,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
			});

			nearestSampler = device.createSampler({
				magFilter: 'nearest',
				minFilter: 'nearest',
				addressModeU: 'clamp-to-edge',
				addressModeV: 'clamp-to-edge'
			});
			linearSampler = device.createSampler({
				magFilter: 'linear',
				minFilter: 'linear',
				addressModeU: 'clamp-to-edge',
				addressModeV: 'clamp-to-edge'
			});

			createTextures(ctx);

			computeLayout = device.createBindGroupLayout({
				label: 'physarum_compute_bgl',
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.COMPUTE,
						buffer: { type: 'uniform' }
					},
					{
						binding: 1,
						visibility: GPUShaderStage.COMPUTE,
						buffer: { type: 'storage' }
					},
					{ binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
					{
						binding: 3,
						visibility: GPUShaderStage.COMPUTE,
						texture: { sampleType: 'float' }
					},
					{
						binding: 4,
						visibility: GPUShaderStage.COMPUTE,
						storageTexture: { access: 'write-only', format: PHEROMONE_FORMAT }
					}
				]
			});

			renderLayout = device.createBindGroupLayout({
				label: 'physarum_render_bgl',
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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

			const module = device.createShaderModule({ label: 'physarum_shader', code: SHADER });

			const computePL = device.createPipelineLayout({
				label: 'physarum_compute_pl',
				bindGroupLayouts: [computeLayout]
			});
			initPipeline = device.createComputePipeline({
				label: 'physarum_init',
				layout: computePL,
				compute: { module, entryPoint: 'init_main' }
			});
			diffusePipeline = device.createComputePipeline({
				label: 'physarum_diffuse',
				layout: computePL,
				compute: { module, entryPoint: 'diffuse_main' }
			});
			stepPipeline = device.createComputePipeline({
				label: 'physarum_step',
				layout: computePL,
				compute: { module, entryPoint: 'step_main' }
			});

			const renderPL = device.createPipelineLayout({
				label: 'physarum_render_pl',
				bindGroupLayouts: [renderLayout]
			});
			renderPipeline = device.createRenderPipeline({
				label: 'physarum_render_pipeline',
				layout: renderPL,
				vertex: { module, entryPoint: 'vs_render' },
				fragment: {
					module,
					entryPoint: 'fs_render',
					targets: [
						{
							format: ctx.hdrFormat,
							blend: {
								color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
								alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
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
			if (pheroA) pheroA.destroy();
			if (pheroB) pheroB.destroy();
			createTextures(ctx);
			buildBindGroups(ctx);
			needsInit = true;
		},
		update(_frame, _time, _dt) {
			// All state lives in GPU buffers + the shared uniform.
		},
		render(encoder, ctx, weight) {
			if (
				!agentBuf ||
				!diffusePipeline ||
				!stepPipeline ||
				!initPipeline ||
				!renderPipeline ||
				!bgCompute[pingFlip] ||
				!bgRender[pingFlip]
			)
				return;

			const groupsAgents = Math.ceil(AGENT_COUNT / 64);
			const groupsX = Math.ceil(pheroWidth / 8);
			const groupsY = Math.ceil(pheroHeight / 8);
			const bg = bgCompute[pingFlip]!;

			if (needsInit) {
				const initPass = encoder.beginComputePass({ label: 'physarum_init_pass' });
				initPass.setPipeline(initPipeline);
				initPass.setBindGroup(0, bg);
				initPass.dispatchWorkgroups(groupsAgents);
				initPass.end();
				needsInit = false;
			}

			const diffusePass = encoder.beginComputePass({ label: 'physarum_diffuse_pass' });
			diffusePass.setPipeline(diffusePipeline);
			diffusePass.setBindGroup(0, bg);
			diffusePass.dispatchWorkgroups(groupsX, groupsY);
			diffusePass.end();

			const stepPass = encoder.beginComputePass({ label: 'physarum_step_pass' });
			stepPass.setPipeline(stepPipeline);
			stepPass.setBindGroup(0, bg);
			stepPass.dispatchWorkgroups(groupsAgents);
			stepPass.end();

			// Render the current "output" pheromone (the one we just wrote).
			const renderPass = encoder.beginRenderPass({
				label: 'physarum_render_pass',
				colorAttachments: [
					{
						view: ctx.sceneHDRView,
						loadOp: 'load',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			renderPass.setPipeline(renderPipeline);
			renderPass.setBindGroup(0, bgRender[pingFlip]!);
			renderPass.draw(3);
			renderPass.end();

			// Weight gates per-frame visibility; below threshold we still simulate
			// (so trails don't snap when the motif fades back in).
			void weight;

			pingFlip = pingFlip === 0 ? 1 : 0;
		},
		dispose() {
			agentBuf?.destroy();
			pheroA?.destroy();
			pheroB?.destroy();
			agentBuf = null;
			pheroA = null;
			pheroB = null;
			pheroAView = null;
			pheroBView = null;
			initPipeline = null;
			diffusePipeline = null;
			stepPipeline = null;
			renderPipeline = null;
			computeLayout = null;
			renderLayout = null;
			bgCompute = [null, null];
			bgRender = [null, null];
		}
	};
}
