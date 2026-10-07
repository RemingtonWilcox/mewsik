import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

function cargoPackageVersion(contents) {
  const packageSection = contents.match(/\[package\]([\s\S]*?)(?:\r?\n\[|$)/)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    throw new Error('Could not read [package].version from src-tauri/Cargo.toml');
  }
  return version;
}

const [rootPackage, sidecarPackage, tauriConfig, cargoToml] = await Promise.all([
  readJson('package.json'),
  readJson('sidecar/package.json'),
  readJson('src-tauri/tauri.conf.json'),
  readFile(path.join(repoRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
]);

const versions = new Map([
  ['package.json', rootPackage.version],
  ['sidecar/package.json', sidecarPackage.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', cargoPackageVersion(cargoToml)],
]);
const expected = versions.get('package.json');
const mismatches = [...versions].filter(([, version]) => version !== expected);

if (!expected || mismatches.length > 0) {
  const details = [...versions].map(([file, version]) => `  ${file}: ${version ?? '<missing>'}`).join('\n');
  throw new Error(`Release versions are inconsistent:\n${details}`);
}

console.log(`Release version ${expected} is consistent across ${versions.size} manifests.`);
