// Repetition test: does an engine feel scripted? Plays the lab in song mode
// (tracks back to back) for several minutes per engine, samples the picture
// every 2 s, and measures three things the owner can feel:
//
//   recurrence  share of frames that nearly duplicate a frame from at least
//               45 s earlier (same composition, camera, palette): the
//               "it keeps going back to the same few shots" feeling
//   cadence     strongest autocorrelation of the frame-to-frame change
//               signal at lags of 10-120 s: change that arrives on a fixed
//               rhythm ("segmented patterns and rhythms") scores high
//   parked      share of 10 s windows in which the picture barely changes
//
// Each frame becomes a descriptor that sees composition, not just colour: a
// 16x9 luminance thumbnail normalised by its mean (where light sits: camera,
// framing, shape), a chroma-weighted 12-bin hue histogram (palette) and edge
// density (texture). Distances are compared against the run's own median
// pair distance, so engines with different styles are judged fairly.
//
// Engines run in parallel, one window each.
//
// Usage:  node scripts/visual-repetition-test.mjs <label>
// Env:    VIS_ENGINES  comma list (default mk1,mandala,mk2,signal,loom)
//         VIS_MINUTES  minutes per engine (default 12)
//         VIS_SEED     lab seed (default soma-qa)
//         VIS_BASE_URL dev server (default http://127.0.0.1:5173); use a
//                      non-watching server while files are being edited.
// Output: output/repetition-<label>/report.json, <engine>-recurrence.png
//         (self-similarity matrix: bright off-diagonal = returns) and
//         <engine>-sheet.jpg (every 30th sample).

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] ?? 'run';
const engines = (process.env.VIS_ENGINES ?? 'mk1,mandala,mk2,signal,loom').split(',').filter(Boolean);
const minutes = Number(process.env.VIS_MINUTES ?? 12);
const seed = process.env.VIS_SEED ?? 'soma-qa';
const baseURL = process.env.VIS_BASE_URL ?? 'http://127.0.0.1:5173';
const SAMPLE_MS = 2000;
const ENGINE_CANVAS = {
	mk1: 'Prism audio visualizer',
	mandala: 'Mandala audio visualizer',
	mk2: 'Soma audio visualizer',
	signal: 'Signal audio visualizer',
	loom: 'Loom audio visualizer'
};
const outDir = `output/repetition-${label}`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
	headless: false,
	args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});

async function record(engine) {
	const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
	const page = await context.newPage();
	let loads = 0;
	page.on('load', () => (loads += 1));
	await page.goto(`${baseURL}/visualizer-test?engine=${engine}&profile=club128&seed=${seed}&song=1&chrome=0`);
	await page.getByLabel(ENGINE_CANVAS[engine]).waitFor({ state: 'attached', timeout: 180_000 });
	await page.addStyleTag({ content: 'vite-error-overlay{display:none!important}' });
	await page.waitForTimeout(8000);
	const frames = [];
	const started = Date.now();
	while (Date.now() - started < minutes * 60_000) {
		const due = started + frames.length * SAMPLE_MS;
		const wait = due - Date.now();
		if (wait > 0) await page.waitForTimeout(wait);
		const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
		frames.push({ t: (Date.now() - started) / 1000, data: buffer.toString('base64') });
	}
	await context.close();
	return { engine, frames, reloads: Math.max(0, loads - 1) };
}

const analysis = await browser.newPage();
async function describe(frames) {
	return analysis.evaluate(async (images) => {
		const W = 64;
		const H = 36;
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
		for (const b64 of images) {
			const img = await load(b64);
			ctx.drawImage(img, 0, 0, W, H);
			const px = ctx.getImageData(0, 0, W, H).data;
			const lum = new Float32Array(W * H);
			const hue = new Array(12).fill(0);
			let mean = 0;
			let chromaSum = 0;
			for (let i = 0; i < W * H; i += 1) {
				const r = px[i * 4] / 255;
				const g = px[i * 4 + 1] / 255;
				const b = px[i * 4 + 2] / 255;
				lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				mean += lum[i] / (W * H);
				const max = Math.max(r, g, b);
				const min = Math.min(r, g, b);
				const c = max - min;
				if (c > 0.02) {
					let h;
					if (max === r) h = ((g - b) / c + 6) % 6;
					else if (max === g) h = (b - r) / c + 2;
					else h = (r - g) / c + 4;
					hue[Math.floor(h * 2) % 12] += c;
					chromaSum += c;
				}
			}
			const m = Math.max(0.02, mean);
			// 16x9 thumbnail of mean-normalised luminance (composition).
			const thumb = new Array(16 * 9).fill(0);
			for (let y = 0; y < H; y += 1) {
				for (let x = 0; x < W; x += 1) {
					thumb[Math.floor((y * 9) / H) * 16 + Math.floor((x * 16) / W)] += lum[y * W + x] / m / ((W / 16) * (H / 9));
				}
			}
			let edge = 0;
			for (let y = 0; y < H - 1; y += 1) {
				for (let x = 0; x < W - 1; x += 1) {
					const i = y * W + x;
					edge += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + W] - lum[i]);
				}
			}
			out.push({
				thumb,
				hue: hue.map((v) => (chromaSum > 0 ? v / chromaSum : 0)),
				colourful: chromaSum / (W * H),
				edge: edge / (W * H) / m
			});
		}
		return out;
	}, frames.map((f) => f.data));
}

function distance(a, b) {
	let thumb = 0;
	for (let i = 0; i < a.thumb.length; i += 1) thumb += Math.abs(a.thumb[i] - b.thumb[i]);
	thumb /= a.thumb.length;
	let hue = 0;
	for (let i = 0; i < 12; i += 1) hue += Math.abs(a.hue[i] - b.hue[i]);
	const hueWeight = Math.min(1, Math.min(a.colourful, b.colourful) * 20);
	const edge = Math.abs(a.edge - b.edge) / Math.max(0.15, a.edge, b.edge);
	return 0.5 * thumb + 0.3 * (hue / 2) * hueWeight + 0.2 * edge;
}

function median(values) {
	const s = [...values].sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

async function matrixImage(D, n, path) {
	const page = await browser.newPage({ viewport: { width: n, height: n } });
	await page.setContent('<body style="margin:0"><canvas id="c"></canvas></body>');
	const max = Math.max(...D.flat());
	await page.evaluate(
		([rows, size, top]) => {
			const c = document.getElementById('c');
			c.width = size;
			c.height = size;
			const ctx = c.getContext('2d');
			const img = ctx.createImageData(size, size);
			for (let y = 0; y < size; y += 1) {
				for (let x = 0; x < size; x += 1) {
					const v = 255 * (1 - Math.min(1, rows[y][x] / top));
					const k = (y * size + x) * 4;
					img.data[k] = v;
					img.data[k + 1] = v * 0.85;
					img.data[k + 2] = v * 0.6;
					img.data[k + 3] = 255;
				}
			}
			ctx.putImageData(img, 0, 0);
		},
		[D, n, max]
	);
	await page.screenshot({ path, clip: { x: 0, y: 0, width: n, height: n } });
	await page.close();
}

async function sheet(frames, path) {
	const picks = frames.filter((_, i) => i % 30 === 0);
	const page = await browser.newPage({ viewport: { width: 6 * 240, height: Math.ceil(picks.length / 6) * 156 } });
	await page.setContent(
		'<body style="margin:0;background:#000;display:flex;flex-wrap:wrap;font:11px monospace;color:#9f9">' +
			picks.map((f) => `<div style="width:240px;height:156px"><img src="data:image/jpeg;base64,${f.data}" style="width:240px;height:135px;display:block"/>${f.t.toFixed(0)}s</div>`).join('') +
			'</body>'
	);
	await page.screenshot({ path, type: 'jpeg', quality: 75, fullPage: true });
	await page.close();
}

const results = [];
try {
	const recordings = await Promise.all(engines.map((engine) => record(engine)));
	for (const { engine, frames, reloads } of recordings) {
		const d = await describe(frames);
		const n = d.length;
		const D = Array.from({ length: n }, () => new Array(n).fill(0));
		for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) D[i][j] = D[j][i] = distance(d[i], d[j]);
		const all = [];
		for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) all.push(D[i][j]);
		const typical = median(all);
		const gapFrames = Math.ceil(45_000 / SAMPLE_MS);
		// Recurrence: frames whose nearest frame >= 45 s earlier is a near-duplicate.
		let recurrent = 0;
		let considered = 0;
		for (let i = gapFrames; i < n; i += 1) {
			let nearest = Infinity;
			for (let j = 0; j <= i - gapFrames; j += 1) nearest = Math.min(nearest, D[i][j]);
			considered += 1;
			if (nearest < typical * 0.35) recurrent += 1;
		}
		// Cadence: autocorrelation of the change signal at 10..120 s lags.
		const change = [];
		for (let i = 1; i < n; i += 1) change.push(D[i][i - 1]);
		const mean = change.reduce((a, b) => a + b, 0) / Math.max(1, change.length);
		const c = change.map((x) => x - mean);
		const var0 = c.reduce((a, b) => a + b * b, 0) || 1;
		let cadence = 0;
		let cadenceLag = 0;
		for (let lag = 5; lag <= 60 && lag < c.length / 2; lag += 1) {
			let sum = 0;
			for (let i = 0; i + lag < c.length; i += 1) sum += c[i] * c[i + lag];
			const r = (sum / var0) * (c.length / (c.length - lag));
			if (r > cadence) {
				cadence = r;
				cadenceLag = lag * (SAMPLE_MS / 1000);
			}
		}
		// Parked: 10 s windows whose start and end frames barely differ.
		const win = Math.round(10_000 / SAMPLE_MS);
		let parked = 0;
		let windows = 0;
		for (let i = 0; i + win < n; i += win) {
			windows += 1;
			if (D[i][i + win] < typical * 0.2) parked += 1;
		}
		const result = {
			engine,
			frames: n,
			reloads,
			typicalDistance: Number(typical.toFixed(4)),
			recurrence: Number((recurrent / Math.max(1, considered)).toFixed(3)),
			cadence: Number(cadence.toFixed(3)),
			cadenceLagSeconds: cadenceLag,
			parked: Number((parked / Math.max(1, windows)).toFixed(3))
		};
		results.push(result);
		await matrixImage(D, n, `${outDir}/${engine}-recurrence.png`);
		await sheet(frames, `${outDir}/${engine}-sheet.jpg`);
		console.log(
			`${engine.padEnd(8)} recurrence ${(result.recurrence * 100).toFixed(1).padStart(5)}%  cadence ${result.cadence.toFixed(2)} @${String(cadenceLag).padStart(3)}s  parked ${(result.parked * 100).toFixed(1).padStart(5)}%${reloads ? `  (${reloads} reloads!)` : ''}`
		);
	}
	await writeFile(`${outDir}/report.json`, JSON.stringify(results, null, 2));
	console.log(`-> ${outDir}`);
} finally {
	await browser.close();
}
