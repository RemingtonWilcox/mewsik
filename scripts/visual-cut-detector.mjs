// Jump-cut and exposure detector. Plays the lab in song mode (tracks back to
// back, like radio), records one engine at ~5 fps, then measures how much each
// frame differs from the previous one. A visualizer should evolve; a frame
// whose *structure* changes far more than the motion around it is a jump cut.
//
// Usage:
//   VIS_ENGINE=loom node scripts/visual-cut-detector.mjs <label>
// Env:
//   VIS_ENGINE   mk1 | mk2 | signal | loom        (default loom)
//   VIS_SEED     lab seed                          (default soma-qa)
//   VIS_PROFILE  first track profile               (default club128)
//   VIS_MINUTES  how long to record                (default 3)
//   VIS_BASE_URL dev server (default http://127.0.0.1:5173). Use a
//                non-watching server while others edit files: HMR reloads
//                restart the song and are themselves cuts.
// Output: output/<engine>-cuts-<label>/report.json, cuts.jpg (each flagged
// pair side by side), and a printed summary. Exit code 2 when cuts are found.
//
// Metrics per frame pair, on 80x50 downscaled frames:
//   structural  mean |L1/mean1 - L2/mean2| x 100: brightness-normalized, so a
//               beat flash that lifts the whole frame barely registers
//   colour      mean RGB distance (0..255): palette jumps
// A cut is a pair whose structural change exceeds both an absolute floor and
// 4x the median of its neighbourhood, or whose colour jump is extreme.
// Exposure: mean luminance, fraction of clipped (>245) and black (<8) pixels.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] ?? 'run';
const engine = process.env.VIS_ENGINE ?? 'loom';
const seed = process.env.VIS_SEED ?? 'soma-qa';
const profile = process.env.VIS_PROFILE ?? 'club128';
const minutes = Number(process.env.VIS_MINUTES ?? 3);
const baseURL = process.env.VIS_BASE_URL ?? 'http://127.0.0.1:5173';
const ENGINE_CANVAS = {
	mk1: ['Prism audio visualizer', 'data-prism-ready'],
	mk2: ['Soma audio visualizer', 'data-soma-ready'],
	signal: ['Signal audio visualizer', 'data-signal-ready'],
	loom: ['Loom audio visualizer', 'data-loom-ready']
};
const [canvasLabel, readyAttribute] = ENGINE_CANVAS[engine] ?? ENGINE_CANVAS.loom;
const outDir = `output/${engine}-cuts-${label}`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu'] });
let exitCode = 0;
try {
	const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
	let loads = 0;
	page.on('load', () => (loads += 1));
	await page.goto(`${baseURL}/visualizer-test?engine=${engine}&profile=${profile}&seed=${seed}&song=1&chrome=0`);
	await page.getByLabel(canvasLabel).waitFor({ state: 'attached', timeout: 20_000 });
	await page.waitForFunction(
		([labelText, attribute]) => {
			const canvas = document.querySelector(`canvas[aria-label="${labelText}"]`);
			return !!canvas && (!canvas.hasAttribute(attribute) || canvas.getAttribute(attribute) === 'true');
		},
		[canvasLabel, readyAttribute],
		{ timeout: 20_000 }
	);
	await page.addStyleTag({ content: 'vite-error-overlay{display:none!important}' });
	await page.waitForTimeout(3000);

	const frames = [];
	const started = Date.now();
	const durationMs = minutes * 60_000;
	while (Date.now() - started < durationMs) {
		const t = (Date.now() - started) / 1000;
		const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
		const where = await page.evaluate(() => {
			const lab = document.querySelector('[data-visualizer-lab]');
			return `${lab?.getAttribute('data-lab-profile') ?? 'x'}-${lab?.getAttribute('data-lab-stage') ?? 'x'}`;
		});
		frames.push({ t, where, data: buffer.toString('base64') });
		await page.waitForTimeout(120);
	}
	const reloads = Math.max(0, loads - 1);

	// Analyse in a plain page with a 2D canvas.
	const analysis = await browser.newPage();
	const stats = await analysis.evaluate(async (images) => {
		const W = 80;
		const H = 50;
		const canvas = document.createElement('canvas');
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		const load = (b64) =>
			new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = reject;
				img.src = `data:image/jpeg;base64,${b64}`;
			});
		const out = [];
		let previous = null;
		for (const b64 of images) {
			const img = await load(b64);
			ctx.drawImage(img, 0, 0, W, H);
			const { data } = ctx.getImageData(0, 0, W, H);
			const lum = new Float32Array(W * H);
			let sum = 0;
			let clipped = 0;
			let black = 0;
			for (let i = 0; i < W * H; i += 1) {
				const r = data[i * 4];
				const g = data[i * 4 + 1];
				const b = data[i * 4 + 2];
				const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				lum[i] = l;
				sum += l;
				if (r > 245 || g > 245 || b > 245) clipped += 1;
				if (l < 8) black += 1;
			}
			const mean = sum / (W * H);
			const frame = { mean, clipped: clipped / (W * H), black: black / (W * H), structural: 0, colour: 0 };
			if (previous) {
				let s = 0;
				let c = 0;
				// Floor the normaliser: on mostly-black frames a tiny mean would
				// amplify dither and grain into fake structural change.
				const m1 = Math.max(32, previous.mean);
				const m2 = Math.max(32, mean);
				for (let i = 0; i < W * H; i += 1) {
					s += Math.abs(previous.lum[i] / m1 - lum[i] / m2);
					const dr = previous.rgb[i * 4] - data[i * 4];
					const dg = previous.rgb[i * 4 + 1] - data[i * 4 + 1];
					const db = previous.rgb[i * 4 + 2] - data[i * 4 + 2];
					c += Math.sqrt(dr * dr + dg * dg + db * db);
				}
				frame.structural = (s / (W * H)) * 100;
				frame.colour = c / (W * H);
			}
			out.push(frame);
			previous = { lum, mean, rgb: data.slice() };
		}
		return out;
	}, frames.map((f) => f.data));

	const median = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
	};
	const percentile = (values, p) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
	};
	const structural = stats.map((s) => s.structural).slice(1);
	const colour = stats.map((s) => s.colour).slice(1);
	const cuts = [];
	for (let i = 1; i < stats.length; i += 1) {
		const window = stats.slice(Math.max(1, i - 10), Math.min(stats.length, i + 11)).filter((_, k, arr) => arr[k] !== stats[i]);
		const localStructural = median(window.map((s) => s.structural));
		const localColour = median(window.map((s) => s.colour));
		const s = stats[i];
		const structuralCut = s.structural > Math.max(18, localStructural * 4);
		const colourCut = s.colour > Math.max(45, localColour * 5);
		if (structuralCut || colourCut) {
			cuts.push({
				index: i,
				t: Number(frames[i].t.toFixed(2)),
				where: frames[i].where,
				previousWhere: frames[i - 1].where,
				structural: Number(s.structural.toFixed(2)),
				colour: Number(s.colour.toFixed(2)),
				localStructural: Number(localStructural.toFixed(2)),
				localColour: Number(localColour.toFixed(2))
			});
		}
	}

	const summary = {
		engine,
		seed,
		reloads,
		frames: frames.length,
		fps: Number((frames.length / (minutes * 60)).toFixed(2)),
		structural: { median: median(structural), p95: percentile(structural, 0.95), max: Math.max(0, ...structural) },
		colour: { median: median(colour), p95: percentile(colour, 0.95), max: Math.max(0, ...colour) },
		exposure: {
			meanLuminance: median(stats.map((s) => s.mean)),
			clippedFraction: median(stats.map((s) => s.clipped)),
			clippedP95: percentile(stats.map((s) => s.clipped), 0.95),
			blackFraction: median(stats.map((s) => s.black))
		},
		cuts
	};
	await writeFile(`${outDir}/report.json`, JSON.stringify(summary, null, 2));

	if (cuts.length) {
		const pairs = cuts.slice(0, 24);
		const sheet = await browser.newPage({ viewport: { width: 960, height: pairs.length * 318 } });
		await sheet.setContent(
			'<body style="margin:0;background:#000;font:12px monospace;color:#f88">' +
				pairs
					.map(
						(cut) =>
							`<div style="display:flex;gap:4px;height:300px"><img src="data:image/jpeg;base64,${frames[cut.index - 1].data}" style="width:478px;height:300px"/><img src="data:image/jpeg;base64,${frames[cut.index].data}" style="width:478px;height:300px"/></div><div style="height:18px">t=${cut.t}s ${cut.previousWhere} -> ${cut.where} structural ${cut.structural} (local ${cut.localStructural}) colour ${cut.colour} (local ${cut.localColour})</div>`
					)
					.join('') +
				'</body>'
		);
		await sheet.screenshot({ path: `${outDir}/cuts.jpg`, type: 'jpeg', quality: 80, fullPage: true });
		exitCode = 2;
	}

	const fmt = (n) => Number(n).toFixed(2);
	console.log(`${engine}: ${frames.length} frames at ${summary.fps} fps, ${reloads} reloads`);
	console.log(`structural change median ${fmt(summary.structural.median)} p95 ${fmt(summary.structural.p95)} max ${fmt(summary.structural.max)}`);
	console.log(`colour change     median ${fmt(summary.colour.median)} p95 ${fmt(summary.colour.p95)} max ${fmt(summary.colour.max)}`);
	console.log(`exposure: mean luminance ${fmt(summary.exposure.meanLuminance)}, clipped ${fmt(summary.exposure.clippedFraction * 100)}% (p95 ${fmt(summary.exposure.clippedP95 * 100)}%), black ${fmt(summary.exposure.blackFraction * 100)}%`);
	console.log(cuts.length ? `${cuts.length} JUMP CUT(S): ${cuts.map((c) => `${c.t}s ${c.previousWhere}->${c.where}`).join(', ')} -> ${outDir}/cuts.jpg` : 'no jump cuts');
	if (reloads) console.warn('WARNING: the page reloaded during recording; reloads are cuts and restart the song.');
} finally {
	await browser.close();
}
process.exit(exitCode);
