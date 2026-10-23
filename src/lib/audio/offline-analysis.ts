// Run the lab's file-playback analyzer (WebAnalyzer) over a buffer of audio
// faster than real time: an OfflineAudioContext renders the buffer and is
// suspended every 1/60 s so the analyzer reads its nodes exactly as it would
// on a live frame. Used by the ensemble specs and the lab to put real
// signals (synthesised test music, decoded files) through the same path as
// file and URL playback, deterministically.

import type { AudioFeatures } from '$lib/state/visualizer.svelte';
import { WebAnalyzer } from './web-analyzer';

export type OfflineFeatureFrame = { atMs: number; features: AudioFeatures };

export async function analyzeOffline(
	left: Float32Array,
	right: Float32Array,
	sampleRate: number,
	frameHz = 60
): Promise<OfflineFeatureFrame[]> {
	const length = left.length;
	const ctx = new OfflineAudioContext(2, length, sampleRate);
	const buffer = ctx.createBuffer(2, length, sampleRate);
	buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
	buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	const analyzer = new WebAnalyzer(ctx, source);
	analyzer['analyser'].connect(ctx.destination);
	source.start(0);
	const frames: OfflineFeatureFrame[] = [];
	const duration = length / sampleRate;
	const step = 1 / frameHz;
	for (let k = 1; k * step < duration - 0.01; k += 1) {
		const at = k * step;
		ctx.suspend(at).then(() => {
			const atMs = ctx.currentTime * 1000;
			const features = analyzer.tick(atMs);
			if (features) frames.push({ atMs, features });
			ctx.resume();
		});
	}
	await ctx.startRendering();
	return frames;
}
