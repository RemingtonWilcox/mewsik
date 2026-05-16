import type { RuntimeControls } from './types.js';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export const DEFAULT_RUNTIME_CONTROLS: RuntimeControls = {
	master: 1,
	exposure: 1,
	bloom: 1,
	background: 1,
	contrast: 1,
	saturation: 1,
	vignette: 1,
	edge: 1,
	chromaticAberration: 1,
	grain: 1,
	bloomThreshold: 1.35
};

export function normalizeRuntimeControls(input?: Partial<RuntimeControls> | null): RuntimeControls {
	return {
		master: clamp(input?.master ?? DEFAULT_RUNTIME_CONTROLS.master, 0, 2),
		exposure: clamp(input?.exposure ?? DEFAULT_RUNTIME_CONTROLS.exposure, 0, 2),
		bloom: clamp(input?.bloom ?? DEFAULT_RUNTIME_CONTROLS.bloom, 0, 2),
		background: clamp(input?.background ?? DEFAULT_RUNTIME_CONTROLS.background, 0, 2),
		contrast: clamp(input?.contrast ?? DEFAULT_RUNTIME_CONTROLS.contrast, 0, 2),
		saturation: clamp(input?.saturation ?? DEFAULT_RUNTIME_CONTROLS.saturation, 0, 2),
		vignette: clamp(input?.vignette ?? DEFAULT_RUNTIME_CONTROLS.vignette, 0, 1.5),
		edge: clamp(input?.edge ?? DEFAULT_RUNTIME_CONTROLS.edge, 0, 1.5),
		chromaticAberration: clamp(
			input?.chromaticAberration ?? DEFAULT_RUNTIME_CONTROLS.chromaticAberration,
			0,
			2
		),
		grain: clamp(input?.grain ?? DEFAULT_RUNTIME_CONTROLS.grain, 0, 2),
		bloomThreshold: clamp(
			input?.bloomThreshold ?? DEFAULT_RUNTIME_CONTROLS.bloomThreshold,
			0.2,
			3
		)
	};
}
