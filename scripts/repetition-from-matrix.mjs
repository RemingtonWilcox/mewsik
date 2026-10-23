// Recompute repetition metrics from a finished run without re-recording:
// reads <engine>-distances.json, or falls back to the <engine>-recurrence.png
// matrix image (distance / max encoded in the red channel; the metrics are
// scale-free, so the normalisation does not matter).
//
// Usage: node scripts/repetition-from-matrix.mjs output/repetition-<label>
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { formatResult, repetitionMetrics } from './lib/repetition-metrics.mjs';

const dir = process.argv[2];
const engines = (process.env.VIS_ENGINES ?? 'mk1,mandala,mk2,signal,loom').split(',');
let browser = null;
for (const engine of engines) {
	let D = null;
	if (existsSync(`${dir}/${engine}-distances.json`)) {
		D = JSON.parse(readFileSync(`${dir}/${engine}-distances.json`, 'utf8'));
	} else if (existsSync(`${dir}/${engine}-recurrence.png`)) {
		browser ??= await chromium.launch();
		const page = await browser.newPage();
		const b64 = readFileSync(`${dir}/${engine}-recurrence.png`).toString('base64');
		D = await page.evaluate(async (data) => {
			const img = new Image();
			img.src = `data:image/png;base64,${data}`;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.width;
			c.height = img.height;
			const ctx = c.getContext('2d');
			ctx.drawImage(img, 0, 0);
			const px = ctx.getImageData(0, 0, c.width, c.height).data;
			const rows = [];
			for (let y = 0; y < c.height; y += 1) {
				const row = [];
				for (let x = 0; x < c.width; x += 1) row.push(1 - px[(y * c.width + x) * 4] / 255);
				rows.push(row);
			}
			return rows;
		}, b64);
		await page.close();
	}
	if (!D) continue;
	console.log(formatResult({ engine, ...repetitionMetrics(D, 2000) }));
}
await browser?.close();
