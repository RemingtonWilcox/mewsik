// Hydra-style feedback FBO bank: o0..o3 reserved at startup, sampleable as
// named WGSL textures, write-target rotates each frame so a motif can
// sample LAST frame's contents while writing THIS frame. The bedrock of
// the required temporal-feedback look in mewsik's post-stack.

import type { FeedbackBank } from './types.js';

export function createFeedbackBank(
	device: GPUDevice,
	width: number,
	height: number,
	format: GPUTextureFormat,
	count = 4
): FeedbackBank {
	const textures: GPUTexture[] = [];
	const views: GPUTextureView[] = [];
	for (let i = 0; i < count; i++) {
		const tex = device.createTexture({
			label: `feedback_o${i}`,
			size: [width, height, 1],
			format,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST
		});
		textures.push(tex);
		views.push(tex.createView());
	}

	// Explicit bind group layout — every consumer must declare reachable
	// bindings, otherwise WGSL `layout: 'auto'` will prune them.
	const bindingLayout = device.createBindGroupLayout({
		label: 'feedback_bgl',
		entries: [
			{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			{
				binding: 1,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float' }
			},
			{
				binding: 2,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float' }
			},
			{
				binding: 3,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float' }
			},
			{
				binding: 4,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'float' }
			}
		]
	});

	return {
		textures,
		views,
		clearOnNextFrame: new Array(count).fill(true),
		bindingLayout,
		count
	};
}

export function resizeFeedbackBank(
	bank: FeedbackBank,
	device: GPUDevice,
	width: number,
	height: number,
	format: GPUTextureFormat
) {
	for (let i = 0; i < bank.count; i++) {
		bank.textures[i].destroy();
		const tex = device.createTexture({
			label: `feedback_o${i}`,
			size: [width, height, 1],
			format,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST
		});
		bank.textures[i] = tex;
		bank.views[i] = tex.createView();
		bank.clearOnNextFrame[i] = true;
	}
}

export function disposeFeedbackBank(bank: FeedbackBank) {
	for (const t of bank.textures) t.destroy();
	bank.textures.length = 0;
	bank.views.length = 0;
}
