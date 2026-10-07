import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required release value: ${name}`);
  }
  return value;
}

function decodeCanonicalBase64(value, label) {
  const compact = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(compact, 'base64');
  if (
    decoded.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed${output ? `:\n${output}` : ''}`);
  }
  if (result.stdout?.trim()) {
    console.log(result.stdout.trim());
  }
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'mewsik-updater-keypair-'));
try {
  requiredEnv('TAURI_SIGNING_PRIVATE_KEY');
  requiredEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  const publicKey = requiredEnv('MEWSIK_UPDATER_PUBLIC_KEY');

  const payloadPath = path.join(temporaryDirectory, 'challenge.bin');
  const encodedSignaturePath = `${payloadPath}.sig`;
  const decodedPublicKeyPath = path.join(temporaryDirectory, 'updater.pub');
  const decodedSignaturePath = path.join(temporaryDirectory, 'challenge.minisig');
  await writeFile(payloadPath, randomBytes(64), { mode: 0o600 });

  const tauriCli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  run(process.execPath, [tauriCli, 'signer', 'sign', payloadPath]);

  const encodedSignature = (await readFile(encodedSignaturePath, 'utf8')).trim();
  await Promise.all([
    writeFile(
      decodedPublicKeyPath,
      decodeCanonicalBase64(publicKey, 'MEWSIK_UPDATER_PUBLIC_KEY'),
      { mode: 0o600 },
    ),
    writeFile(
      decodedSignaturePath,
      decodeCanonicalBase64(encodedSignature, 'generated updater signature'),
      { mode: 0o600 },
    ),
  ]);

  const verificationEnv = { ...process.env };
  delete verificationEnv.TAURI_SIGNING_PRIVATE_KEY;
  delete verificationEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  run(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--example',
      'verify_minisign',
      '--',
      decodedPublicKeyPath,
      payloadPath,
      decodedSignaturePath,
    ],
    verificationEnv,
  );
} catch (error) {
  console.error(
    `Updater keypair verification failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
