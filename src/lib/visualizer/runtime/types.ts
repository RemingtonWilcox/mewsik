// Unified runtime contract — what a motif module is, what the runtime provides.
//
// Big idea: replace the engine-swap host (mk1/mk2/mk3 as separate Svelte
// components) with a single WebGPU runtime that owns the device/surface/
// post-stack/feedback-FBOs/director-uniform, and runs *motif modules* behind
// the same uniform. Transitions = parameter morphs (weights/uniform LERPs),
// not component swaps. This is the architectural lift from HANDOFF.md §2.
//
// A MotifModule is a black box that:
//   1. Initializes its GPU resources once, given the runtime context
//   2. Updates each frame from the V2 director frame + time
//   3. Renders into the runtime's HDR scene target with a given weight (0..1)
//   4. Disposes its GPU resources on teardown
//
// Multiple motifs can render in the same frame, weighted by the runtime.
// The post-stack composes the HDR target → feedback FBOs → final swapchain.

import type { VisualDirectorFrame } from '../director/types.js';

export type MotifId =
	| 'atmosphere'
	| 'organism'
	| 'particles'
	| 'lattice'
	| 'ribbon'
	| 'tunnel';

export type RuntimeContext = {
	device: GPUDevice;
	format: GPUTextureFormat;
	hdrFormat: GPUTextureFormat;
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
	directorUniformBuf: GPUBuffer;
	directorUniformLayout: GPUBindGroupLayout;
	sceneHDR: GPUTexture;
	sceneHDRView: GPUTextureView;
	feedback: FeedbackBank;
	sampler: GPUSampler;
};

export type FeedbackBank = {
	textures: GPUTexture[];
	views: GPUTextureView[];
	clearOnNextFrame: boolean[];
	bindingLayout: GPUBindGroupLayout;
	count: number;
};

export type MotifModule = {
	id: MotifId;
	init(ctx: RuntimeContext): void | Promise<void>;
	resize(ctx: RuntimeContext): void;
	update(frame: VisualDirectorFrame, time: number, dt: number): void;
	render(encoder: GPUCommandEncoder, ctx: RuntimeContext, weight: number): void;
	dispose(): void;
};

export type MotifWeights = Partial<Record<MotifId, number>>;
