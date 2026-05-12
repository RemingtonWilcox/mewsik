<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { useVisualizer } from '$lib/state/visualizer.svelte';

	const vis = useVisualizer();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let errorMsg = $state<string | null>(null);
	let raf = 0;
	let unsub: (() => void) | null = null;

	const BIN_COUNT = 64;

	const smoothed = {
		bins: new Float32Array(BIN_COUNT),
		bass: 0,
		mid: 0,
		treble: 0,
		centroid: 0.5,
		rms: 0,
		flash: 0
	};

	function lerp(a: number, b: number, t: number) {
		return a + (b - a) * t;
	}

	// Uniform layout (std140-ish, manually padded):
	//   vec2 resolution  (8B + 8B pad to align next vec4 boundary... actually we just need 16B total here)
	//   f32 time
	//   f32 bass
	//   f32 mid
	//   f32 treble
	//   f32 centroid
	//   f32 rms
	//   f32 flash
	//   f32 _pad
	// Total: 2 + 8 floats = 10 floats = 40 bytes; round to 48 for alignment safety.
	const UNIFORM_FLOATS = 12;
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
	const BINS_BYTES = BIN_COUNT * 4;

	const WGSL = /* wgsl */ `
struct Uniforms {
	resolution: vec2<f32>,
	time: f32,
	bass: f32,
	mid: f32,
	treble: f32,
	centroid: f32,
	rms: f32,
	flash: f32,
	_pad0: f32,
	_pad1: f32,
	_pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bins: array<f32, ${BIN_COUNT}>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
	var pos = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 1.0, -1.0),
		vec2<f32>( 1.0,  1.0)
	);
	return vec4<f32>(pos[idx], 0.0, 1.0);
}

// Hash → 2D value noise → 5-octave fbm
fn hash21(p: vec2<f32>) -> f32 {
	let h = dot(p, vec2<f32>(127.1, 311.7));
	return fract(sin(h) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let u = f * f * (3.0 - 2.0 * f);
	let a = hash21(i);
	let b = hash21(i + vec2<f32>(1.0, 0.0));
	let c = hash21(i + vec2<f32>(0.0, 1.0));
	let d = hash21(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p_in: vec2<f32>) -> f32 {
	var p = p_in;
	var v = 0.0;
	var a = 0.5;
	for (var i: i32 = 0; i < 5; i = i + 1) {
		v = v + a * noise2(p);
		p = p * 2.05 + vec2<f32>(13.7, 17.3);
		a = a * 0.5;
	}
	return v;
}

// Smooth oklab-ish iridescent gradient — not the RGB cosine bands.
// Tunes between deep indigo → teal → magenta → warm gold by centroid + audio.
fn iridescent(t: f32, shift: f32) -> vec3<f32> {
	let s = fract(t + shift);
	let indigo = vec3<f32>(0.10, 0.05, 0.35);
	let teal   = vec3<f32>(0.10, 0.55, 0.65);
	let magenta = vec3<f32>(0.85, 0.25, 0.75);
	let gold   = vec3<f32>(0.95, 0.55, 0.30);
	let x = s * 4.0;
	if (x < 1.0) { return mix(indigo, teal, smoothstep(0.0, 1.0, x)); }
	if (x < 2.0) { return mix(teal, magenta, smoothstep(0.0, 1.0, x - 1.0)); }
	if (x < 3.0) { return mix(magenta, gold, smoothstep(0.0, 1.0, x - 2.0)); }
	return mix(gold, indigo, smoothstep(0.0, 1.0, x - 3.0));
}

fn rot(a: f32) -> mat2x2<f32> {
	let c = cos(a);
	let s = sin(a);
	return mat2x2<f32>(c, -s, s, c);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
	let uv = (frag.xy - 0.5 * u.resolution) / u.resolution.y;
	let r = length(uv);
	let theta = atan2(uv.y, uv.x);

	// Deep navy base — never pure black, keeps the image alive in silence.
	var col = vec3<f32>(0.012, 0.014, 0.028);

	// ── Aurora background: large slow domain-warped fbm
	let bassDrive = u.bass * 0.85 + u.rms * 0.4;
	let warpA = vec2<f32>(
		fbm(uv * 0.9 + vec2<f32>(u.time * 0.05, 0.0)),
		fbm(uv * 0.9 + vec2<f32>(0.0, u.time * 0.04 + 100.0))
	);
	let warped = uv * 1.6 + warpA * (1.4 + bassDrive * 0.6);
	let n = fbm(warped + u.time * 0.025);
	let auroraMask = smoothstep(0.30, 0.95, n);
	let auroraT = u.centroid * 0.7 + n * 0.35;
	let auroraCol = iridescent(auroraT, 0.0);
	col = col + auroraCol * auroraMask * (0.18 + u.rms * 0.55);

	// Secondary slower layer for depth — different palette offset
	let n2 = fbm(uv * 2.2 - warpA * 0.8 + u.time * 0.02);
	let auroraCol2 = iridescent(auroraT + 0.45, 0.25);
	col = col + auroraCol2 * smoothstep(0.55, 0.95, n2) * 0.12;

	// ── Central pulsing orb
	let orbBase = 0.16;
	let orbR = orbBase + u.bass * 0.07 + u.rms * 0.02;
	// Soft outer halo
	let halo = exp(-pow(r / (orbR + 0.55), 2.0) * 1.4);
	let haloCol = iridescent(u.centroid + u.time * 0.03, 0.15);
	col = col + haloCol * halo * (0.35 + bassDrive * 0.9);
	// Core glow — falls off sharply
	let core = exp(-pow(r / orbR, 2.0) * 6.0);
	let coreCol = iridescent(u.centroid + 0.5, 0.4);
	col = col + coreCol * core * (0.5 + u.bass * 0.6);
	// Hot center
	let hot = exp(-pow(r / (orbR * 0.45), 2.0) * 14.0);
	col = col + vec3<f32>(1.0, 0.95, 0.9) * hot * (0.6 + u.mid * 0.4);

	// ── Radial spectrum arcs around the orb
	let baseArcR = orbR + 0.18;
	let arcSpan = 0.55;
	for (var i: i32 = 0; i < ${BIN_COUNT}; i = i + 2) {
		let v = bins[i];
		if (v < 0.02) { continue; }
		let frac = f32(i) / f32(${BIN_COUNT});
		let arcR = baseArcR + frac * arcSpan + v * 0.025;
		let arcWidth = 0.0035 + v * 0.012;
		let arcStrength = smoothstep(arcWidth, 0.0, abs(r - arcR));
		// Faint angular falloff so arcs aren't perfectly uniform rings
		let angMod = 0.7 + 0.3 * sin(theta * 3.0 + frac * 18.0 + u.time * 0.5);
		let arcCol = iridescent(frac + u.centroid * 0.5, 0.6);
		col = col + arcCol * arcStrength * v * angMod * (0.5 + u.rms * 0.8);
	}

	// ── Sparkle stars (treble-reactive bright noise points)
	let starUV = uv * 14.0 + vec2<f32>(u.time * 0.1, -u.time * 0.07);
	let starN = noise2(starUV);
	let star = smoothstep(0.95 - u.treble * 0.15, 0.99, starN);
	col = col + vec3<f32>(1.0, 0.95, 0.85) * star * (0.4 + u.treble * 0.6);

	// ── Onset shimmer (subtle whole-frame lift)
	col = col + iridescent(u.centroid + 0.3, 0.7) * u.flash * 0.18;

	// Soft vignette
	let vig = smoothstep(1.5, 0.45, length(uv));
	col = col * (0.55 + 0.45 * vig);

	// Slight chromatic feather at edges for depth
	let edge = pow(length(uv) * 0.65, 2.0);
	col.r = col.r + edge * 0.02;
	col.b = col.b + edge * 0.04;

	// Filmic-ish tone curve
	col = col / (1.0 + col);
	col = pow(max(col, vec3<f32>(0.0)), vec3<f32>(0.75));

	return vec4<f32>(col, 1.0);
}
`;

	type GPU = {
		device: GPUDevice;
		context: GPUCanvasContext;
		format: GPUTextureFormat;
		pipeline: GPURenderPipeline;
		uniformBuf: GPUBuffer;
		binsBuf: GPUBuffer;
		bindGroup: GPUBindGroup;
		uniformData: Float32Array;
	};

	let gpu: GPU | null = null;
	const t0 = performance.now();

	async function initGpu(c: HTMLCanvasElement): Promise<GPU | null> {
		// @ts-expect-error -- DOM lib in some TS versions lacks navigator.gpu typing
		const gpuApi = navigator.gpu as GPU['device']['adapterInfo'] extends never ? never : any;
		if (!gpuApi) {
			errorMsg = 'WebGPU not available in this WebView2 build.';
			return null;
		}
		const adapter = await gpuApi.requestAdapter();
		if (!adapter) {
			errorMsg = 'No WebGPU adapter found.';
			return null;
		}
		const device = (await adapter.requestDevice()) as GPUDevice;

		const context = c.getContext('webgpu') as unknown as GPUCanvasContext;
		if (!context) {
			errorMsg = 'WebGPU canvas context unavailable.';
			return null;
		}
		const format = gpuApi.getPreferredCanvasFormat() as GPUTextureFormat;
		context.configure({ device, format, alphaMode: 'premultiplied' });

		const module = device.createShaderModule({ code: WGSL });
		const pipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_main' },
			fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
			primitive: { topology: 'triangle-list' }
		});

		const uniformBuf = device.createBuffer({
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const binsBuf = device.createBuffer({
			size: BINS_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuf } },
				{ binding: 1, resource: { buffer: binsBuf } }
			]
		});

		return {
			device,
			context,
			format,
			pipeline,
			uniformBuf,
			binsBuf,
			bindGroup,
			uniformData: new Float32Array(UNIFORM_FLOATS)
		};
	}

	function loop() {
		if (!canvas || !gpu) {
			raf = requestAnimationFrame(loop);
			return;
		}

		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr;
			canvas.height = h * dpr;
		}

		const feat = vis.latest;
		const incoming = feat?.bins ?? [];
		const attack = 0.55;
		const release = 0.16;
		for (let i = 0; i < BIN_COUNT; i++) {
			const target = incoming[i] ?? 0;
			const tt = target > smoothed.bins[i] ? attack : release;
			smoothed.bins[i] = lerp(smoothed.bins[i], target, tt);
		}
		smoothed.bass = lerp(smoothed.bass, feat?.bass ?? 0, 0.32);
		smoothed.mid = lerp(smoothed.mid, feat?.mid ?? 0, 0.3);
		smoothed.treble = lerp(smoothed.treble, feat?.treble ?? 0, 0.45);
		smoothed.centroid = lerp(smoothed.centroid, feat?.centroid ?? 0.5, 0.08);
		smoothed.rms = lerp(smoothed.rms, feat?.rms ?? 0, 0.25);
		if (feat?.onset) smoothed.flash = 1.0;
		smoothed.flash *= 0.88;

		// Pack uniforms (must match WGSL struct layout exactly).
		const u = gpu.uniformData;
		u[0] = canvas.width;
		u[1] = canvas.height;
		u[2] = (performance.now() - t0) / 1000;
		u[3] = smoothed.bass;
		u[4] = smoothed.mid;
		u[5] = smoothed.treble;
		u[6] = smoothed.centroid;
		u[7] = smoothed.rms;
		u[8] = smoothed.flash;
		// 9..11 are pads, leave 0.

		gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, u.buffer, u.byteOffset, u.byteLength);
		gpu.device.queue.writeBuffer(
			gpu.binsBuf,
			0,
			smoothed.bins.buffer,
			smoothed.bins.byteOffset,
			smoothed.bins.byteLength
		);

		const encoder = gpu.device.createCommandEncoder();
		const view = gpu.context.getCurrentTexture().createView();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view,
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}
			]
		});
		pass.setPipeline(gpu.pipeline);
		pass.setBindGroup(0, gpu.bindGroup);
		pass.draw(6);
		pass.end();
		gpu.device.queue.submit([encoder.finish()]);

		raf = requestAnimationFrame(loop);
	}

	$effect(() => {
		if (canvas && !gpu && !errorMsg) {
			initGpu(canvas).then((g) => {
				if (g) gpu = g;
			}).catch((e) => {
				errorMsg = e instanceof Error ? e.message : String(e);
			});
		}
	});

	onMount(async () => {
		unsub = await vis.subscribe();
		raf = requestAnimationFrame(loop);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
		if (unsub) unsub();
		if (gpu) {
			gpu.uniformBuf.destroy();
			gpu.binsBuf.destroy();
			gpu.device.destroy?.();
			gpu = null;
		}
	});
</script>

{#if vis.active}
	<div
		class="fixed inset-0 z-[100] bg-black"
		role="presentation"
		onclick={() => vis.toggle()}
		onkeydown={(e) => {
			if (e.key === 'Escape') vis.toggle();
		}}
		tabindex="0"
	>
		<canvas bind:this={canvas} class="h-full w-full"></canvas>
		<div class="pointer-events-none absolute right-6 top-6 text-xs text-white/40">
			click anywhere or press esc to exit
		</div>
		{#if errorMsg}
			<div class="absolute left-6 top-6 max-w-md text-xs text-red-300/80">
				Visualizer error: {errorMsg}
			</div>
		{/if}
	</div>
{/if}
