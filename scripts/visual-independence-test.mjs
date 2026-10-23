// Independence test: does the picture move as one block (turning a whole face
// of the Rubik's cube), or do its parts answer different parts of the music
// (each cubie turning on its own)?
//
// Plays the lab in song mode, records one engine at ~7 fps together with the
// journey's musical channels, splits every frame into a 4x4 grid, and
// measures:
//
//   faceness     mean |correlation| between the 16 regions' change signals.
//                1 = every region changes together (global pulses, whole-look
//                switches); low = regions change on their own
//   drivers      for each region, the musical channel its change follows most
//                closely (lagged up to 0.3 s); `distinctDrivers` is how many
//                different channels lead at least one region, and
//                `driverStrength` the mean of those best correlations (are
//                the parts actually musical, or just independent noise?)
//   globalShare  share of total change explained by the frame-wide mean
//                change (camera moves and global flashes)
//
// Channels: every numeric leaf of the journey snapshot's `ensemble` (when the
// ensemble layer exists) plus a few director and spectrum basics.
//
// Usage:  VIS_ENGINES=mk1,loom node scripts/visual-independence-test.mjs <label>
// Env:    VIS_ENGINES (default mk1,mandala,mk2,signal,loom), VIS_MINUTES (3),
//         VIS_SEED (soma-qa), VIS_BASE_URL (http://127.0.0.1:5173)
// Output: output/independence-<label>/report.json and a printed table.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2] ?? 'run';
const engines = (process.env.VIS_ENGINES ?? 'mk1,mandala,mk2,signal,loom').split(',').filter(Boolean);
const minutes = Number(process.env.VIS_MINUTES ?? 3);
const seed = process.env.VIS_SEED ?? 'soma-qa';
const baseURL = process.env.VIS_BASE_URL ?? 'http://127.0.0.1:5173';
const ENGINE_CANVAS = {
	mk1: 'Prism audio visualizer',
	mandala: 'Mandala audio visualizer',
	mk2: 'Soma audio visualizer',
	signal: 'Signal audio visualizer',
	loom: 'Loom audio visualizer'
};
const GRID = 4;
const outDir = `output/independence-${label}`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
	headless: false,
	args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
});

async function record(engine) {
	const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
	const page = await context.newPage();
	for (let attempt = 0; ; attempt += 1) {
		await page.goto(`${baseURL}/visualizer-test?engine=${engine}&profile=club128&seed=${seed}&song=1&chrome=0`);
		try {
			await page.getByLabel(ENGINE_CANVAS[engine]).waitFor({ state: 'attached', timeout: 60_000 });
			break;
		} catch (error) {
			if (attempt >= 3) throw error;
		}
	}
	await page.addStyleTag({ content: 'vite-error-overlay{display:none!important}' });
	await page.waitForTimeout(6000);
	const samples = [];
	const started = Date.now();
	const FRAME_MS = 125; // 8 fps: enough to follow hits, small enough to analyse
	while (Date.now() - started < minutes * 60_000) {
		const due = started + samples.length * FRAME_MS;
		if (due > Date.now()) await page.waitForTimeout(due - Date.now());
		const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
		const channels = await page.evaluate(() => {
			const j = window.__MEWSIK_LAB__?.snapshot().journey;
			if (!j) return {};
			const out = {};
			const walk = (obj, prefix, depth) => {
				if (!obj || depth > 3) return;
				for (const [key, value] of Object.entries(obj)) {
					const name = prefix ? `${prefix}.${key}` : key;
					if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
					else if (typeof value === 'boolean') out[name] = value ? 1 : 0;
					else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)) walk(value, name, depth + 1);
				}
			};
			walk(j.ensemble, 'ensemble', 0);
			out['director.energy'] = j.director?.energy ?? 0;
			out['director.bassPunch'] = j.director?.bassPunch ?? 0;
			out['director.trebleSparkle'] = j.director?.trebleSparkle ?? 0;
			out['director.beatPulse'] = j.director?.clock?.beatPulse ?? 0;
			for (const band of ['sub', 'kick', 'body', 'mids', 'presence', 'air']) out[`spectrum.${band}`] = j.spectrum?.levels?.[band] ?? 0;
			out['spectrum.novelty'] = j.spectrum?.novelty ?? 0;
			return out;
		});
		samples.push({ t: (Date.now() - started) / 1000, data: shot.toString('base64'), channels });
	}
	await context.close();
	return { engine, samples };
}

const analysis = await browser.newPage();
async function regions(samples) {
	// In chunks: one evaluate with thousands of images exhausts the page.
	const out = [];
	for (let i = 0; i < samples.length; i += 300) out.push(...(await regionChunk(samples.slice(i, i + 300))));
	return out;
}

async function regionChunk(samples) {
	return analysis.evaluate(
		async ([images, grid]) => {
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
				const cells = new Array(grid * grid * 3).fill(0);
				const counts = new Array(grid * grid).fill(0);
				for (let y = 0; y < H; y += 1) {
					for (let x = 0; x < W; x += 1) {
						const c = Math.floor((y * grid) / H) * grid + Math.floor((x * grid) / W);
						const k = (y * W + x) * 4;
						cells[c * 3] += px[k];
						cells[c * 3 + 1] += px[k + 1];
						cells[c * 3 + 2] += px[k + 2];
						counts[c] += 1;
					}
				}
				out.push(cells.map((v, i) => v / counts[Math.floor(i / 3)] / 255));
			}
			return out;
		},
		[samples.map((s) => s.data), GRID]
	);
}

function pearson(a, b) {
	const n = Math.min(a.length, b.length);
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i += 1) {
		ma += a[i] / n;
		mb += b[i] / n;
	}
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i += 1) {
		sab += (a[i] - ma) * (b[i] - mb);
		saa += (a[i] - ma) ** 2;
		sbb += (b[i] - mb) ** 2;
	}
	return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
}

const results = [];
try {
	const recordings = await Promise.all(engines.map((engine) => record(engine)));
	for (const { engine, samples } of recordings) {
		const cells = await regions(samples);
		const n = cells.length;
		const R = GRID * GRID;
		// Per-region change signal: RGB distance between consecutive samples.
		const change = Array.from({ length: R }, () => []);
		const globalChange = [];
		for (let t = 1; t < n; t += 1) {
			let mean = 0;
			for (let r = 0; r < R; r += 1) {
				const d = Math.hypot(cells[t][r * 3] - cells[t - 1][r * 3], cells[t][r * 3 + 1] - cells[t - 1][r * 3 + 1], cells[t][r * 3 + 2] - cells[t - 1][r * 3 + 2]);
				change[r].push(d);
				mean += d / R;
			}
			globalChange.push(mean);
		}
		let corrSum = 0;
		let pairs = 0;
		for (let a = 0; a < R; a += 1) for (let b = a + 1; b < R; b += 1) {
			corrSum += Math.abs(pearson(change[a], change[b]));
			pairs += 1;
		}
		const faceness = corrSum / Math.max(1, pairs);
		// Share of region change explained by the global mean (R^2 averaged).
		let explained = 0;
		for (let r = 0; r < R; r += 1) explained += pearson(change[r], globalChange) ** 2 / R;
		// Musical drivers: each region's best-matching channel (activity of the
		// channel = |delta| for continuous channels), lag 0..2 samples.
		const names = Object.keys(samples[0]?.channels ?? {});
		const channelActivity = {};
		for (const name of names) {
			const series = samples.map((s) => s.channels[name] ?? 0);
			const act = [];
			for (let t = 1; t < n; t += 1) act.push(Math.abs(series[t] - series[t - 1]) + Math.max(0, series[t]) * 0.25);
			channelActivity[name] = act;
		}
		const drivers = [];
		for (let r = 0; r < R; r += 1) {
			let best = { name: null, corr: 0 };
			for (const name of names) {
				const act = channelActivity[name];
				for (let lag = 0; lag <= 2; lag += 1) {
					const c = pearson(change[r].slice(lag), act.slice(0, act.length - lag));
					if (c > best.corr) best = { name, corr: c };
				}
			}
			drivers.push(best);
		}
		const distinct = new Set(drivers.filter((d) => d.name && d.corr > 0.15).map((d) => d.name));
		const result = {
			engine,
			samples: n,
			fps: Number((n / (minutes * 60)).toFixed(2)),
			faceness: Number(faceness.toFixed(3)),
			globalShare: Number(explained.toFixed(3)),
			distinctDrivers: distinct.size,
			driverStrength: Number((drivers.reduce((s, d) => s + d.corr, 0) / R).toFixed(3)),
			drivers: drivers.map((d) => `${d.name ?? '-'}:${d.corr.toFixed(2)}`),
			channels: names.length
		};
		results.push(result);
		await writeFile(`${outDir}/report.json`, JSON.stringify(results, null, 2));
		console.log(
			`${engine.padEnd(8)} faceness ${result.faceness.toFixed(2)}  global ${(result.globalShare * 100).toFixed(0).padStart(3)}%  drivers ${String(result.distinctDrivers).padStart(2)} of ${names.length} channels  strength ${result.driverStrength.toFixed(2)}  (${result.fps} fps)`
		);
	}
	console.log(`-> ${outDir}`);
} finally {
	await browser.close();
}
