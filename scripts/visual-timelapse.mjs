// Visual time-lapse: plays the lab in song mode (whole tracks back to back, the
// way a radio stream runs) and screenshots one engine at a fixed interval, then
// builds a contact sheet. Judges variety over minutes instead of single stills.
//
// Usage:
//   VIS_ENGINE=mk1 node scripts/visual-timelapse.mjs <label>
// Env:
//   VIS_ENGINE   mk1 | mandala | mk2 | signal | loom (default loom)
//   VIS_SEED     lab seed                          (default soma-qa)
//   VIS_PROFILE  first track profile               (default club128)
//   VIS_MINUTES  how long to run                   (default 4)
//   VIS_EVERY    seconds between frames            (default 8)
//   VIS_NEW_SOURCE=1  every track is a new source, like songs in the app
//                (default: tracks continue one source, like a radio stream)
//   VIS_BASE_URL dev server                        (default http://127.0.0.1:5173)
//                Use a separate, non-watching server when other people or
//                agents are editing files: HMR reloads restart the lab and
//                the genome mid-run. Reloads are counted and reported.
// Output: output/<engine>-timelapse-<label>/NNN-<profile>-<stage>.jpg and sheet.jpg
//
// Headed Chromium (headless has no WebGPU on this machine); needs the dev
// server on 127.0.0.1:5173, started if missing.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const label = process.argv[2] ?? 'run';
const engine = process.env.VIS_ENGINE ?? 'loom';
const seed = process.env.VIS_SEED ?? 'soma-qa';
const profile = process.env.VIS_PROFILE ?? 'club128';
const minutes = Number(process.env.VIS_MINUTES ?? 4);
const every = Number(process.env.VIS_EVERY ?? 8);
const ENGINE_CANVAS = {
	mk1: ['Prism audio visualizer', 'data-prism-ready'],
	mk2: ['Soma audio visualizer', 'data-soma-ready'],
	signal: ['Signal audio visualizer', 'data-signal-ready'],
	loom: ['Loom audio visualizer', 'data-loom-ready'],
	mandala: ['Mandala audio visualizer', 'data-mandala-ready']
};
const [canvasLabel, readyAttribute] = ENGINE_CANVAS[engine] ?? ENGINE_CANVAS.loom;
const outDir = `output/${engine}-timelapse-${label}`;
const baseURL = process.env.VIS_BASE_URL ?? 'http://127.0.0.1:5173';

async function serverUp() {
	try {
		return (await fetch(baseURL, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;
	}
}

let devServer = null;
if (!(await serverUp())) {
	devServer = spawn('node_modules\\.bin\\vite.CMD', ['dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
		shell: true,
		stdio: 'ignore'
	});
	for (let i = 0; i < 40 && !(await serverUp()); i += 1) await new Promise((r) => setTimeout(r, 500));
	if (!(await serverUp())) throw new Error('Could not start the Vite dev server on 127.0.0.1:5173.');
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu'] });
const files = [];
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	let loads = 0;
	page.on('load', () => {
		loads += 1;
		if (loads > 1) console.warn(`WARNING: page reloaded (${loads - 1}x); frames after this restarted the song and genome`);
	});
	await page.goto(`${baseURL}/visualizer-test?engine=${engine}&profile=${profile}&seed=${seed}&song=1${process.env.VIS_NEW_SOURCE === '1' ? '&newsource=1' : ''}&chrome=0`);
	await page.getByLabel(canvasLabel).waitFor({ state: 'attached', timeout: 20_000 });
	await page.waitForFunction(
		([labelText, attribute]) => {
			const canvas = document.querySelector(`canvas[aria-label="${labelText}"]`);
			return !!canvas && (!canvas.hasAttribute(attribute) || canvas.getAttribute(attribute) === 'true');
		},
		[canvasLabel, readyAttribute],
		{ timeout: 20_000 }
	);
	// Hide any Vite error overlay so a transient HMR error does not ruin frames.
	await page.addStyleTag({ content: 'vite-error-overlay{display:none!important}' });
	await page.waitForTimeout(3000);
	const frames = Math.max(1, Math.floor((minutes * 60) / every));
	for (let index = 0; index < frames; index += 1) {
		const where = await page.evaluate(() => {
			const lab = document.querySelector('[data-visualizer-lab]');
			return `${lab?.getAttribute('data-lab-profile') ?? 'x'}-${lab?.getAttribute('data-lab-stage') ?? 'x'}`;
		});
		const path = `${outDir}/${String(index).padStart(3, '0')}-${where}.jpg`;
		await page.screenshot({ path, type: 'jpeg', quality: 72 });
		files.push(path);
		console.log(`${index + 1}/${frames} ${path}`);
		if (index < frames - 1) await page.waitForTimeout(every * 1000);
	}

	// Contact sheet: six columns, labelled.
	const cells = await Promise.all(
		files.map(async (file) => ({
			name: file.split('/').pop(),
			data: (await readFile(file)).toString('base64')
		}))
	);
	const columns = 6;
	const width = 320;
	const height = 200;
	const rows = Math.ceil(cells.length / columns);
	const sheet = await browser.newPage({ viewport: { width: columns * width, height: rows * (height + 18) } });
	await sheet.setContent(
		`<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${columns},${width}px);font:11px monospace;color:#9f9">` +
			cells
				.map(
					(cell) =>
						`<div><img src="data:image/jpeg;base64,${cell.data}" style="width:${width}px;height:${height}px;display:block"/><div style="height:18px">${cell.name}</div></div>`
				)
				.join('') +
			'</body>'
	);
	await sheet.screenshot({ path: `${outDir}/sheet.jpg`, type: 'jpeg', quality: 80, fullPage: true });
	await writeFile(`${outDir}/frames.json`, JSON.stringify(files, null, 2));
	console.log(`sheet -> ${outDir}/sheet.jpg (${Math.max(0, loads - 1)} reloads during capture)`);
} finally {
	await browser.close();
	devServer?.kill();
}
