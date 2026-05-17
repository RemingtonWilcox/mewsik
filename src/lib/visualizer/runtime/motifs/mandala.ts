// Mandala motif — radial sacred geometry.
// Direct nod to the research bubble: Metatron's Cube, Flower of Life,
// Tibetan sand mandala construction rules. Single fragment shader,
// polar k-fold symmetry (kaleidoscopic fold), layered concentric petal
// rings, palette-tinted.
//
// Distinct vocabulary from every other motif: this is the only place
// the runtime expresses geometric, radially-symmetric, ritual-iconography
// shapes. Reads strongly as "the song landed on a center."
//
// Audio routing:
//   chroma            → symmetry order k ∈ {4, 6, 8, 12} (key change reshapes)
//   motion            → rotation speed
//   centroid          → ring spacing (brighter songs pack more rings)
//   bassPunch         → brightness pulse on each kick
//   downbeat          → flash + ring-count tick
//   drop.anticipation → ring radius expansion (organism reaching outward)
//   drop.postDropDecay → outer halo bloom (saturates after watershed)
//   energy            → overall outer reach

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

const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
	let viewport = dir.viewport.xy;
	let aspect = viewport.x / max(viewport.y, 1.0);
	// Centered, aspect-corrected coordinates in [-1, 1].
	let p = (in.uv - vec2<f32>(0.5)) * vec2<f32>(aspect, 1.0) * 2.0;

	let r = length(p);
	var theta = atan2(p.y, p.x);

	let energy = dir.energy.x;
	let motion = dir.energy.z;
	// Fast rail — gen-1 reactivity. Kick lands → sparkle in ~30ms instead of
	// waiting for the bassPunch envelope's 120ms release tail.
	let bassRaw = dir.bands.x;
	let trebleRaw = dir.bands.z;
	let bassPunch = dir.mood.z;
	let antic = dir.drop.w;
	let postDrop = dir.drop2.x;
	let downbeat = f32(dir.clockI.w);
	let centroid = dir.bands.w;
	let chromaStrength = dir.palette.w;

	// Symmetry order — user override via motifA.x; section/chroma adjustments
	// still bias around it so the section vocabulary is preserved while the
	// user gets a direct generative knob.
	let kUser = dir.motifA.x;
	let sec = dir.section.x;
	var kBias: f32 = 0.0;
	if (sec == 0u || sec == 1u) { kBias = 2.0; }       // calm/intro → richer
	else if (sec == 4u) { kBias = 4.0; }                // build → tighter
	else if (sec == 7u || sec == 8u) { kBias = -2.0; }  // bridge/breakdown → simpler
	let k = clamp(kUser + kBias + step(0.7, chromaStrength) * 1.5, 2.0, 16.0);

	// Slow rotation; motion accelerates, downbeat flicks.
	let rotSpeed = 0.05 + motion * 0.30;
	let rot = dir.viewport.z * rotSpeed + downbeat * 0.06;
	theta = theta + rot;

	// Fold: kaleidoscopic mirror across k slices. Use fract instead of %
	// so negative theta wraps into a stable positive slice coordinate.
	let sliceWidth = TWO_PI / k;
	let sliceT = fract((theta + sliceWidth * 0.5) / sliceWidth);
	let folded = abs(sliceT * sliceWidth - sliceWidth * 0.5);

	// Ring count — user base via motifA.y; centroid/energy add audio variation
	// on top so a kick visibly inserts an extra ring band.
	let ringDensity = dir.motifA.y + centroid * 4.0 + energy * 3.0;
	let ringPhase = r * ringDensity - dir.viewport.z * (0.3 + antic * 0.4);
	let ring = 0.5 + 0.5 * cos(ringPhase * PI);

	// Petal modulation along folded angle — narrows toward the symmetry axis.
	let petalCos = max(abs(cos(folded * 2.0)), 0.0001);
	let petal = petalCos * petalCos * petalCos * petalCos;

	// Combine: ring × petal × radial falloff. r expansion grows on drops.
	let radialReach = 0.85 + antic * 0.35 + postDrop * 0.40;
	let radialFalloff = 1.0 - smoothstep(0.05, radialReach, r);
	let core = ring * petal * radialFalloff;

	// Sparkle: bright dots where rings cross petal peaks. Read RAW bass so the
	// sparkle locks to the kick frame-for-frame (gen-1 visceral feel) instead
	// of riding the bassPunch envelope's release. trebleRaw adds hi-hat shimmer.
	let sparkle = pow(core, 6.0) * (0.4 + bassRaw * 1.1 + trebleRaw * 0.35 + downbeat * 0.6);

	// Palette: base hue at center → accent in mid → rim at outer.
	let baseHue = dir.palette.x;
	let accentHue = dir.palette.y;
	let rimHue = dir.palette.z;
	let sat = dir.palette.w;
	let radialT = smoothstep(0.0, radialReach, r);
	var hue = mix(baseHue, accentHue, smoothstep(0.0, 0.5, radialT));
	hue = mix(hue, rimHue, smoothstep(0.5, 1.0, radialT));
	let col = hsv2rgb(vec3<f32>(fract(hue), sat * 0.95, 1.0));

	let glow = col * (core * 0.48 + sparkle * 0.75);

	// Subtle center pulse on the downbeat — the eye lands on the "one".
	// Add a per-kick pulse that responds to raw bass so every transient
	// reads as a hit, not just downbeats.
	let centerPulse = (downbeat * 0.22 + bassRaw * 0.35) * exp(-r * 12.0);
	return vec4<f32>(glow + vec3<f32>(centerPulse), 1.0);
}
`;

export function createMandalaMotif(): MotifModule {
	let pipeline: GPURenderPipeline | null = null;
	let bg: GPUBindGroup | null = null;

	return {
		// Reuse 'tunnel' MotifId. The mandala is the runtime's "axis of symmetry"
		// motif — analogous to a tunnel's centered vanishing point. Future
		// dedicated 3D tunnel motif can take this slot back.
		id: 'tunnel',
		init(ctx: RuntimeContext) {
			const module = ctx.device.createShaderModule({ label: 'mandala_shader', code: SHADER });
			const layout = ctx.device.createPipelineLayout({
				label: 'mandala_pl',
				bindGroupLayouts: [ctx.directorUniformLayout]
			});
			pipeline = ctx.device.createRenderPipeline({
				label: 'mandala_pipeline',
				layout,
				vertex: { module, entryPoint: 'vs_main' },
				fragment: {
					module,
					entryPoint: 'fs_main',
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
			bg = ctx.device.createBindGroup({
				label: 'mandala_bg',
				layout: ctx.directorUniformLayout,
				entries: [{ binding: 0, resource: { buffer: ctx.directorUniformBuf } }]
			});
		},
		resize(_ctx: RuntimeContext) {},
		update(_frame, _time, _dt) {},
		render(encoder, ctx, weight) {
			if (!pipeline || !bg) return;
			const renderWeight = Math.max(0, Math.min(1, weight));
			const pass = encoder.beginRenderPass({
				label: 'mandala_pass',
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
			pass.setBindGroup(0, bg);
			pass.setBlendConstant({
				r: renderWeight,
				g: renderWeight,
				b: renderWeight,
				a: renderWeight
			});
			pass.draw(3);
			pass.end();
		},
		dispose() {
			pipeline = null;
			bg = null;
		}
	};
}
