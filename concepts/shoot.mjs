import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const concepts = ['terrain', 'nebula', 'sculpture'];
const states = ['calm', 'drop'];
const outDir = new URL('../output/concepts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(outDir, { recursive: true });

const pageUrl = (concept, state) =>
  pathToFileURL(new URL('./index.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href +
  `?concept=${concept}&state=${state}`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });

for (const c of concepts) {
  for (const s of states) {
    await page.goto(pageUrl(c, s));
    await page.waitForFunction(() => window.__ready === true || !!window.__error, { timeout: 30000 });
    const err = await page.evaluate(() => window.__error || null);
    if (err) { console.error(`FAIL ${c}/${s}: ${err}`); process.exitCode = 1; continue; }
    const luma = await page.evaluate(() => window.__luma);
    const file = `${outDir}/${c}-${s}.png`;
    await page.screenshot({ path: file });
    console.log(`OK ${c}/${s} luma=${luma.toFixed(1)} -> ${file}`);
  }
}
await browser.close();
