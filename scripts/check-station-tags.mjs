#!/usr/bin/env node
// Checks that every Directory genre chip tag (src/lib/radio/genres.ts) and
// every discovery scene tag term (src-tauri/src/stations/scenes.rs) returns
// enough playable stations from radio-browser.info: non-HLS, bitrate >= 64.
// A tag under the threshold is flagged; a chip or scene whose tags are all
// thin will show users an empty list. Run by hand, not in CI:
//
//   node scripts/check-station-tags.mjs [--min 5] [--json]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const API = 'https://all.api.radio-browser.info';
const USER_AGENT = 'mewsik/0.2';
const MIN_BITRATE = 64;
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const minIndex = args.indexOf('--min');
const threshold = minIndex >= 0 ? Number(args[minIndex + 1]) : 5;
const asJson = args.includes('--json');

/** Parse `id` + `tags` out of every SceneDef in scenes.rs. */
async function sceneTags() {
	const source = await readFile(
		path.join(repoRoot, 'src-tauri', 'src', 'stations', 'scenes.rs'),
		'utf8'
	);
	const catalog = source.split('pub static SCENES')[1]?.split('];')[0] ?? '';
	const scenes = [];
	for (const block of catalog.split('SceneDef {').slice(1)) {
		const id = block.match(/\bid:\s*"([^"]+)"/)?.[1];
		const tagList = block.match(/\btags:\s*&\[([\s\S]*?)\]/)?.[1];
		if (!id || tagList === undefined) continue;
		const tags = [...tagList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		scenes.push({ owner: `scene:${id}`, tags });
	}
	if (scenes.length === 0) throw new Error('No scenes parsed from scenes.rs');
	return scenes;
}

async function chipTags() {
	const genres = await import(
		pathToFileURL(path.join(repoRoot, 'src', 'lib', 'radio', 'genres.ts')).href
	);
	return genres.DIRECTORY_GENRES.map((genre) => ({ owner: `chip:${genre.label}`, tags: genre.tags }));
}

async function countTag(tag) {
	const url = `${API}/json/stations/bytagexact/${encodeURIComponent(tag)}?hidebroken=true&limit=200`;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const stations = await response.json();
			const playable = stations.filter(
				(station) => Number(station.hls) !== 1 && Number(station.bitrate) >= MIN_BITRATE
			);
			return { total: stations.length, playable: playable.length, error: null };
		} catch (error) {
			if (attempt === 2) return { total: 0, playable: 0, error: String(error) };
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
	return { total: 0, playable: 0, error: 'unreachable' };
}

async function mapLimited(items, limit, task) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

const groups = [...(await chipTags()), ...(await sceneTags())];
const uniqueTags = [...new Set(groups.flatMap((group) => group.tags))];
const counts = new Map(
	(await mapLimited(uniqueTags, CONCURRENCY, countTag)).map((count, index) => [
		uniqueTags[index],
		count
	])
);

const rows = groups.flatMap((group) =>
	group.tags.map((tag) => ({ owner: group.owner, tag, ...counts.get(tag) }))
);

if (asJson) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	const ownerWidth = Math.max(...rows.map((row) => row.owner.length), 5);
	const tagWidth = Math.max(...rows.map((row) => row.tag.length), 3);
	console.log(
		`${'owner'.padEnd(ownerWidth)}  ${'tag'.padEnd(tagWidth)}  playable  total  flag`
	);
	for (const row of rows) {
		const flag = row.error ? `ERROR ${row.error}` : row.playable < threshold ? 'LOW' : '';
		console.log(
			`${row.owner.padEnd(ownerWidth)}  ${row.tag.padEnd(tagWidth)}  ${String(row.playable).padStart(8)}  ${String(row.total).padStart(5)}  ${flag}`
		);
	}
}

const flagged = rows.filter((row) => row.error || row.playable < threshold);
const thinGroups = groups.filter((group) =>
	group.tags.every((tag) => (counts.get(tag)?.playable ?? 0) < threshold)
);
console.error(
	`\n${rows.length} tag checks, ${flagged.length} under ${threshold} playable stations` +
		(thinGroups.length > 0
			? `; chips/scenes with no healthy tag: ${thinGroups.map((group) => group.owner).join(', ')}`
			: '')
);
process.exitCode = flagged.length > 0 ? 1 : 0;
