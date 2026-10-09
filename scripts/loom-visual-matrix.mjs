// Loom visual-matrix capture: screenshots the browser visualizer lab across
// the recommended profile/stage matrix so visual changes can be audited.
//
// Usage:
//   node scripts/loom-visual-matrix.mjs [outputLabel]
//
// - Starts `vite dev` on 127.0.0.1:5173 unless one is already listening.
// - Launches a HEADED Chromium because headless Chromium on this machine has
//   no usable WebGPU adapter. A browser window flashes by; that is expected.
// - Writes output/loom-<label>/<profile>-<stage>.png (label defaults to
//   "matrix"). Set LOOM_SHOT_DIR instead of the positional arg if preferred.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const label = process.argv[2] ?? process.env.LOOM_SHOT_DIR ?? 'matrix';
// VIS_ENGINE=mk1|mk2|signal|loom captures another engine with the same matrix.
const engine = process.env.VIS_ENGINE ?? 'loom';
const seed = process.env.VIS_SEED ?? 'loom-audit';
const outDir = `output/${engine}-${label}`;
const baseURL = 'http://127.0.0.1:5173';

const CASES = [
	{ profile: 'club128', stage: 'verse' },
	{ profile: 'club128', stage: 'build' },
	{ profile: 'club128', stage: 'drop' },
	{ profile: 'club128', stage: 'breakdown' },
	{ profile: 'ambient64', stage: 'bridge' },
	{ profile: 'acoustic94', stage: 'chorus' },
	{ profile: 'noise172', stage: 'drop' },
	{ profile: 'cinematic72', stage: 'build' }
];

async function serverUp() {
	try {
		const response = await fetch(baseURL, { signal: AbortSignal.timeout(1500) });
		return response.ok;
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
	for (let i = 0; i < 40 && !(await serverUp()); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	if (!(await serverUp())) {
		devServer.kill();
		throw new Error('Could not start the Vite dev server on 127.0.0.1:5173.');
	}
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
	headless: false,
	args: ['--enable-unsafe-webgpu']
});
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	for (const { profile, stage } of CASES) {
		await page.goto(
			`${baseURL}/visualizer-test?engine=${engine}&profile=${profile}&stage=${stage}&seed=${seed}&chrome=0`
		);
		await page.getByLabel('Loom audio visualizer').waitFor({ state: 'attached', timeout: 15_000 });
		const ready = await page
			.waitForFunction(
				() =>
					document
						.querySelector('canvas[aria-label="Loom audio visualizer"]')
						?.getAttribute('data-loom-ready') === 'true',
				null,
				{ timeout: 15_000 }
			)
			.then(() => true)
			.catch(() => false);
		if (!ready) {
			console.error(`${profile}/${stage}: WebGPU unavailable or shader error — skipped`);
			continue;
		}
		await page.evaluate(async () => {
			const lab = window.__MEWSIK_LAB__;
			await lab?.settle?.(240);
		});
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${outDir}/${profile}-${stage}.png` });
		console.log(`${profile}/${stage} -> ${outDir}/${profile}-${stage}.png`);
	}
} finally {
	await browser.close();
	devServer?.kill();
}
