// Reaction test: when the music changes genre or tempo, does the picture
// answer within a couple of seconds, and without a jump cut?
//
// For each engine and each pair of contrasting lab profiles, play A for a
// while, switch to B, and capture frames every ~250 ms around the switch.
// Frames are averaged over 1 s windows (so beat flashes and motion blur out
// and what remains is palette, composition and lighting), then compared:
//   drift     window [-4 s, -3 s] vs [-1 s, 0 s]: how much the look changes
//             in 3 s on its own
//   react@1.5 [-1 s, 0 s] vs [+1 s, +2 s]
//   react@3   [-1 s, 0 s] vs [+2.5 s, +3.5 s]
// ratio = react / drift. The engine passes when react@3 >= 2.5x drift and
// react@1.5 >= 1.5x drift, and no frame pair in the capture is a cut (same
// criterion as visual-cut-detector.mjs).
//
// Two modes per pair:
//   source  __MEWSIK_LAB__.select(B): a new song (new source identity)
//   swap    __MEWSIK_LAB__.swap(B): same source, music changes (a station
//           moving from one genre to another)
//
// Usage:
//   node scripts/visual-reaction-test.mjs <label>
// Env:
//   VIS_ENGINES  comma list (default mk1,mk2,signal,loom, plus mandala when present)
//   VIS_MODES    comma list of source,swap (default both)
//   VIS_SEED     lab seed (default soma-qa)
//   VIS_BASE_URL dev server (default http://127.0.0.1:5173); use a
//                non-watching server while files are being edited.
// Output: output/reaction-<label>/report.json and one strip per run
// (<engine>-<mode>-<pair>.jpg: -3, -1, 0, +1, +2, +3, +5 s). Exit code 2 when
// any run fails.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] ?? 'run';
const seed = process.env.VIS_SEED ?? 'soma-qa';
const baseURL = process.env.VIS_BASE_URL ?? 'http://127.0.0.1:5173';
const ENGINE_CANVAS = {
	mk1: 'Prism audio visualizer',
	mk2: 'Soma audio visualizer',
	signal: 'Signal audio visualizer',
	loom: 'Loom audio visualizer',
	mandala: 'Mandala audio visualizer'
};
const engines = (process.env.VIS_ENGINES ?? 'mk1,mk2,signal,loom').split(',').filter(Boolean);
const modes = (process.env.VIS_MODES ?? 'source,swap').split(',').filter(Boolean);
const PAIRS = [
	['ambient64', 'noise172'],
	['noise172', 'acoustic94'],
	['swing86', 'club128'],
	['club128', 'cinematic72']
];
const SETTLE_MS = 12_000;
const PRE_MS = 4_500;
const POST_MS = 6_000;
const outDir = `output/reaction-${label}`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu'] });
const analysis = await browser.newPage();
const results = [];
let failed = false;

async function capture(page, durationMs, t0, into) {
	const started = Date.now();
	while (Date.now() - started < durationMs) {
		const t = (Date.now() - t0) / 1000;
		const buffer = await page.screenshot({ type: 'jpeg', quality: 55 });
		into.push({ t, data: buffer.toString('base64') });
		await page.waitForTimeout(110);
	}
}

async function shiftSerial(page) {
	return page.evaluate(() => window.__MEWSIK_LAB__?.snapshot().journey?.cachedSnapshot?.character?.shiftSerial ?? -1);
}

async function analyse(frames) {
	return analysis.evaluate(async (images) => {
		const W = 48;
		const H = 30;
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
			out.push(Array.from(ctx.getImageData(0, 0, W, H).data));
		}
		return out;
	}, frames.map((f) => f.data));
}

// Mean image over frames with t in [from, to).
function windowMean(frames, pixels, from, to) {
	const picked = frames.map((f, i) => [f, pixels[i]]).filter(([f]) => f.t >= from && f.t < to);
	if (!picked.length) return null;
	const mean = new Float32Array(picked[0][1].length);
	for (const [, px] of picked) for (let i = 0; i < mean.length; i += 1) mean[i] += px[i] / picked.length;
	return mean;
}

// Colour distance (0..255) plus brightness-normalised structure, on a common scale.
function distance(a, b) {
	if (!a || !b) return NaN;
	let colour = 0;
	let la = 0;
	let lb = 0;
	const n = a.length / 4;
	const lumA = new Float32Array(n);
	const lumB = new Float32Array(n);
	for (let i = 0; i < n; i += 1) {
		const dr = a[i * 4] - b[i * 4];
		const dg = a[i * 4 + 1] - b[i * 4 + 1];
		const db = a[i * 4 + 2] - b[i * 4 + 2];
		colour += Math.sqrt(dr * dr + dg * dg + db * db);
		lumA[i] = 0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2];
		lumB[i] = 0.2126 * b[i * 4] + 0.7152 * b[i * 4 + 1] + 0.0722 * b[i * 4 + 2];
		la += lumA[i];
		lb += lumB[i];
	}
	const ma = Math.max(24, la / n);
	const mb = Math.max(24, lb / n);
	let structure = 0;
	for (let i = 0; i < n; i += 1) structure += Math.abs(lumA[i] / ma - lumB[i] / mb);
	return colour / n + (structure / n) * 40;
}

function cutsIn(frames, pixels) {
	const steps = [];
	for (let i = 1; i < pixels.length; i += 1) {
		const a = pixels[i - 1];
		const b = pixels[i];
		let s = 0;
		let la = 0;
		let lb = 0;
		const n = a.length / 4;
		for (let k = 0; k < n; k += 1) {
			la += 0.2126 * a[k * 4] + 0.7152 * a[k * 4 + 1] + 0.0722 * a[k * 4 + 2];
			lb += 0.2126 * b[k * 4] + 0.7152 * b[k * 4 + 1] + 0.0722 * b[k * 4 + 2];
		}
		const ma = Math.max(32, la / n);
		const mb = Math.max(32, lb / n);
		for (let k = 0; k < n; k += 1) {
			const l1 = 0.2126 * a[k * 4] + 0.7152 * a[k * 4 + 1] + 0.0722 * a[k * 4 + 2];
			const l2 = 0.2126 * b[k * 4] + 0.7152 * b[k * 4 + 1] + 0.0722 * b[k * 4 + 2];
			s += Math.abs(l1 / ma - l2 / mb);
		}
		steps.push((s / n) * 100);
	}
	const median = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;
	const cuts = [];
	steps.forEach((value, i) => {
		const local = median(steps.slice(Math.max(0, i - 10), i).concat(steps.slice(i + 1, i + 11)));
		if (value > Math.max(18, local * 4)) cuts.push({ t: Number(frames[i + 1].t.toFixed(2)), structural: Number(value.toFixed(1)), local: Number(local.toFixed(1)) });
	});
	return cuts;
}

async function strip(frames, path) {
	const marks = [-3, -1, 0, 1, 2, 3, 5];
	const picks = marks.map((m) => frames.reduce((best, f) => (Math.abs(f.t - m) < Math.abs(best.t - m) ? f : best), frames[0]));
	const sheet = await browser.newPage({ viewport: { width: marks.length * 240, height: 170 } });
	await sheet.setContent(
		'<body style="margin:0;background:#000;font:12px monospace;color:#ccc;display:flex">' +
			picks.map((f, i) => `<div><img src="data:image/jpeg;base64,${f.data}" style="width:240px;height:150px;display:block"/><div style="height:20px;text-align:center">${marks[i] >= 0 ? '+' : ''}${marks[i]}s</div></div>`).join('') +
			'</body>'
	);
	await sheet.screenshot({ path, type: 'jpeg', quality: 80 });
	await sheet.close();
}

try {
	for (const engine of engines) {
		const canvasLabel = ENGINE_CANVAS[engine];
		if (!canvasLabel) throw new Error(`unknown engine ${engine}`);
		const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
		let loads = 0;
		page.on('load', () => (loads += 1));
		await page.goto(`${baseURL}/visualizer-test?engine=${engine}&profile=${PAIRS[0][0]}&seed=${seed}&chrome=0`);
		await page.getByLabel(canvasLabel).waitFor({ state: 'attached', timeout: 20_000 });
		await page.addStyleTag({ content: 'vite-error-overlay{display:none!important}' });
		await page.waitForFunction(() => !!window.__MEWSIK_LAB__, null, { timeout: 20_000 });
		for (const mode of modes) {
			for (const [from, to] of PAIRS) {
				await page.evaluate((p) => window.__MEWSIK_LAB__.select(p), from);
				await page.waitForTimeout(SETTLE_MS - PRE_MS);
				const frames = [];
				const t0 = Date.now() + PRE_MS;
				await capture(page, PRE_MS, t0, frames);
				const serialBefore = await shiftSerial(page);
				const switchedAt = (Date.now() - t0) / 1000;
				await page.evaluate(([m, p]) => (m === 'swap' ? window.__MEWSIK_LAB__.swap(p) : window.__MEWSIK_LAB__.select(p)), [mode, to]);
				await capture(page, POST_MS, t0, frames);
				const serialAfter = await shiftSerial(page);
				for (const f of frames) f.t -= switchedAt;
				const pixels = await analyse(frames);
				const base = windowMean(frames, pixels, -1, 0);
				const drift = distance(windowMean(frames, pixels, -4, -3), base);
				const react15 = distance(base, windowMean(frames, pixels, 1, 2));
				const react3 = distance(base, windowMean(frames, pixels, 2.5, 3.5));
				const floor = Math.max(drift, 2);
				const cuts = cutsIn(frames, pixels);
				const result = {
					engine,
					mode,
					pair: `${from}->${to}`,
					drift: Number(drift.toFixed(2)),
					react15: Number(react15.toFixed(2)),
					react3: Number(react3.toFixed(2)),
					ratio15: Number((react15 / floor).toFixed(2)),
					ratio3: Number((react3 / floor).toFixed(2)),
					shiftFired: serialAfter > serialBefore,
					cuts
				};
				result.pass = result.ratio3 >= 2.5 && result.ratio15 >= 1.5 && cuts.length === 0;
				if (!result.pass) failed = true;
				results.push(result);
				await strip(frames, `${outDir}/${engine}-${mode}-${from}-${to}.jpg`);
				console.log(
					`${engine.padEnd(7)} ${mode.padEnd(6)} ${result.pair.padEnd(24)} drift ${result.drift.toFixed(1).padStart(5)}  @1.5s ${result.ratio15.toFixed(1).padStart(4)}x  @3s ${result.ratio3.toFixed(1).padStart(4)}x  shift ${result.shiftFired ? 'yes' : 'NO '}  ${cuts.length ? `CUTS ${cuts.map((c) => c.t).join(',')}` : 'no cuts'}  ${result.pass ? 'PASS' : 'FAIL'}`
				);
			}
		}
		if (loads > 1) console.warn(`WARNING: ${engine} page reloaded ${loads - 1}x during the test; results are unreliable.`);
		await page.close();
	}
	await writeFile(`${outDir}/report.json`, JSON.stringify(results, null, 2));
	const passed = results.filter((r) => r.pass).length;
	console.log(`${passed}/${results.length} passed -> ${outDir}`);
} finally {
	await browser.close();
}
process.exit(failed ? 2 : 0);
