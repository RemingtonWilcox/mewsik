// Atmosphere motif — the ground-floor demonstration of the runtime contract.
// Renders a full-screen gradient driven by the V2 director uniform: base/accent
// hues, valence/arousal warmth, slow drift toward the rim hue, and a soft
// vignette pulsing on the downbeat. Not the final aesthetic; intentionally
// minimal so the wiring is verifiable in isolation before mk2/mk3 port over.

import type { MotifModule, RuntimeContext } from '../types.js';
import { DIRECTOR_WGSL_STRUCT } from '../uniforms.js';

const SHADER = /* wgsl */ `
${DIRECTOR_WGSL_STRUCT}

@group(0) @binding(0) var<uniform> dir: Director;

struct VsOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
	// Full-screen triangle.
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -3.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 3.0,  1.0)
	);
	let p = positions[vi];
	var out: VsOut;
	out.pos = vec4<f32>(p, 0.0, 1.0);
	out.uv = p * 0.5 + vec2<f32>(0.5);
	return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
	let uv = in.uv;
	let center = uv - vec2<f32>(0.5);
	let r = length(center);

	let baseHue = dir.palette.x;
	let accentHue = dir.palette.y;
	let rimHue = dir.palette.z;
	let sat = dir.palette.w;
	let warmth = dir.palette2.x;

	let phrase = dir.clock.w;
	let mixT = 0.5 + 0.5 * sin(phrase * 6.28318);
	let hue = mix(baseHue, accentHue, mixT * 0.5) + r * 0.08;
	let v = mix(0.18, 0.55, smoothstep(0.85, 0.0, r));

	let baseCol = hsv2rgb(vec3<f32>(fract(hue), sat * 0.7, v));
	let rimCol = hsv2rgb(vec3<f32>(fract(rimHue), sat * 0.5, v * 0.4));
	var col = mix(baseCol, rimCol, smoothstep(0.45, 1.0, r));

	// Downbeat pulse — brief radial brighten on every bar's first beat.
	let isDown = f32(dir.clockI.w);
	col = col + isDown * 0.08 * smoothstep(0.6, 0.0, r);

	// Anticipation tints toward warmth before drops.
	let antic = dir.drop.w;
	col = col + vec3<f32>(antic * 0.10, antic * 0.06 * warmth, -antic * 0.04);

	// Silence dims everything.
	let silence = dir.phrase.z;
	col = col * (1.0 - silence * 0.6);

	return vec4<f32>(max(col, vec3<f32>(0.0)), 1.0);
}
`;

export function createAtmosphereMotif(): MotifModule {
	let pipeline: GPURenderPipeline | null = null;
	let bindGroup: GPUBindGroup | null = null;

	return {
		id: 'atmosphere',
		init(ctx: RuntimeContext) {
			const module = ctx.device.createShaderModule({
				label: 'atmosphere_shader',
				code: SHADER
			});
			const layout = ctx.device.createPipelineLayout({
				label: 'atmosphere_pl',
				bindGroupLayouts: [ctx.directorUniformLayout]
			});
			pipeline = ctx.device.createRenderPipeline({
				label: 'atmosphere_pipeline',
				layout,
				vertex: { module, entryPoint: 'vs_main' },
				fragment: {
					module,
					entryPoint: 'fs_main',
					targets: [{ format: ctx.hdrFormat }]
				},
				primitive: { topology: 'triangle-list' }
			});
			bindGroup = ctx.device.createBindGroup({
				label: 'atmosphere_bg',
				layout: ctx.directorUniformLayout,
				entries: [{ binding: 0, resource: { buffer: ctx.directorUniformBuf } }]
			});
		},
		resize(_ctx: RuntimeContext) {
			// No own resources to resize; the runtime's HDR target is recreated for us.
		},
		update(_frame, _time, _dt) {
			// All state lives in the shared director uniform; nothing per-frame here.
		},
		render(encoder, ctx, _weight) {
			if (!pipeline || !bindGroup) return;
			const pass = encoder.beginRenderPass({
				label: 'atmosphere_pass',
				colorAttachments: [
					{
						view: ctx.sceneHDRView,
						loadOp: 'load',
						storeOp: 'store',
						clearValue: { r: 0, g: 0, b: 0, a: 1 }
					}
				]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
		},
		dispose() {
			pipeline = null;
			bindGroup = null;
		}
	};
}
