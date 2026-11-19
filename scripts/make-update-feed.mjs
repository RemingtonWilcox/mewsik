// Signs this release's update packages and writes latest.json, the feed that
// installed desktop apps check (see src-tauri/tauri.updater.conf.json).
//
// Usage (normally through scripts/make-update-feed.ps1, which unlocks the key):
//   node scripts/make-update-feed.mjs <version> <release-dir> <notes.md>
//
// <release-dir> must hold mewsik_<version>_x64-setup.exe and/or
// mewsik_<version>_aarch64.app.tar.gz. Each gets a .sig next to it, every
// signature is checked against the public key the apps trust, and latest.json
// is written to the same folder. Upload all of them to the GitHub release.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const [version, dir, notesFile] = process.argv.slice(2);
if (!version || !dir) {
	console.error('usage: node scripts/make-update-feed.mjs <version> <release-dir> [notes.md]');
	process.exit(1);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PATH && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
	console.error('No updater key: run scripts/make-update-feed.ps1, which unlocks it.');
	process.exit(1);
}

const base = `https://github.com/RemingtonWilcox/mewsik/releases/download/v${version}`;
const packages = [
	{ file: `mewsik_${version}_x64-setup.exe`, keys: ['windows-x86_64-nsis', 'windows-x86_64'] },
	{ file: `mewsik_${version}_aarch64.app.tar.gz`, keys: ['darwin-aarch64-app', 'darwin-aarch64'] }
];

const config = JSON.parse(readFileSync(path.join(repoRoot, 'src-tauri/tauri.updater.conf.json'), 'utf8'));
const publicKey = parseMinisignKey(config.plugins.updater.pubkey);

const platforms = {};
for (const pkg of packages) {
	const filePath = path.join(dir, pkg.file);
	if (!existsSync(filePath)) {
		console.log(`skip ${pkg.file} (not in ${dir})`);
		continue;
	}
	const result = spawnSync('pnpm', ['tauri', 'signer', 'sign', '--app-version', version, filePath], {
		cwd: repoRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		// The CLI never prints the key or password; show its error as is.
		console.error(result.stderr || result.stdout);
		process.exit(1);
	}
	const signature = readFileSync(`${filePath}.sig`, 'utf8').trim();
	checkSignature(readFileSync(filePath), signature);
	for (const key of pkg.keys) platforms[key] = { signature, url: `${base}/${pkg.file}` };
	console.log(`signed and verified ${pkg.file}`);
}
if (Object.keys(platforms).length === 0) {
	console.error('Nothing to sign.');
	process.exit(1);
}

const feed = {
	version,
	notes: notesFile ? readFileSync(notesFile, 'utf8').trim() : `mewsik ${version}`,
	pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
	platforms
};
writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
console.log(`wrote latest.json for ${Object.keys(platforms).join(', ')}`);

// Minisign, as the Tauri updater checks it: a base64 wrapper around the
// minisign text file, Ed25519 over the BLAKE2b-512 hash of the file ("ED").
function parseMinisignKey(wrapped) {
	const line = Buffer.from(wrapped, 'base64').toString('utf8').split('\n')[1];
	const raw = Buffer.from(line, 'base64');
	return {
		id: raw.subarray(2, 10),
		key: createPublicKey({
			key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(10, 42)]),
			format: 'der',
			type: 'spki'
		})
	};
}

function checkSignature(payload, wrapped) {
	const lines = Buffer.from(wrapped, 'base64').toString('utf8').split('\n');
	const sig = Buffer.from(lines[1], 'base64');
	const trusted = lines[2].replace(/^trusted comment: /, '');
	const globalSig = Buffer.from(lines[3], 'base64');
	if (sig.subarray(0, 2).toString() !== 'ED') throw new Error('expected a prehashed (ED) signature');
	if (!sig.subarray(2, 10).equals(publicKey.id)) throw new Error('signed with a different key than the apps trust');
	const digest = createHash('blake2b512').update(payload).digest();
	if (!verify(null, digest, publicKey.key, sig.subarray(10, 74))) throw new Error('file signature does not verify');
	const comment = Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted)]);
	if (!verify(null, comment, publicKey.key, globalSig)) throw new Error('trusted comment does not verify');
}
