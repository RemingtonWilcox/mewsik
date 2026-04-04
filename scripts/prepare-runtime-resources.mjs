import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ffmpegStatic from 'ffmpeg-static';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const resourcesDir = path.join(repoRoot, 'src-tauri', 'resources', 'bin');
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

async function ensureExecutable(sourcePath, label) {
  const source = path.resolve(sourcePath);
  await stat(source).catch(() => {
    throw new Error(`Missing ${label} binary at ${source}`);
  });
  return source;
}

async function copyExecutable(sourcePath, filename) {
  const destination = path.join(resourcesDir, filename);
  await copyFile(sourcePath, destination);

  if (process.platform !== 'win32') {
    await chmod(destination, 0o755);
  }

  return destination;
}

async function copyOptionalFile(sourcePath, filename) {
  try {
    await stat(sourcePath);
  } catch {
    return null;
  }

  const destination = path.join(resourcesDir, filename);
  await copyFile(sourcePath, destination);
  return destination;
}

async function ensureFfmpegBinary() {
  const packageJsonPath = require.resolve('ffmpeg-static/package.json');
  const packageDir = path.dirname(packageJsonPath);
  const installScript = path.join(packageDir, 'install.js');
  const expectedBinary = ffmpegStatic ? path.resolve(ffmpegStatic) : null;

  if (expectedBinary) {
    try {
      await stat(expectedBinary);
      return expectedBinary;
    } catch {
      // Fall through and hydrate the package explicitly.
    }
  }

  const install = spawnSync(process.execPath, [installScript], {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env,
  });

  if (install.status !== 0) {
    throw new Error(`ffmpeg-static install.js failed with status ${install.status ?? 'unknown'}`);
  }

  if (!expectedBinary) {
    throw new Error(`ffmpeg-static does not provide a binary for ${process.platform}/${process.arch}`);
  }

  return ensureExecutable(expectedBinary, 'ffmpeg');
}

async function main() {
  await mkdir(resourcesDir, { recursive: true });

  const nodeBinary = await ensureExecutable(process.execPath, 'node');
  const ffmpegBinary = await ensureFfmpegBinary();

  const bundledNode = await copyExecutable(nodeBinary, `node${exeSuffix}`);
  const bundledFfmpeg = await copyExecutable(ffmpegBinary, `ffmpeg${exeSuffix}`);
  const nodeInstallRoot = path.resolve(path.dirname(nodeBinary), '..');

  await copyOptionalFile(path.join(nodeInstallRoot, 'LICENSE'), 'node.LICENSE');
  await copyOptionalFile(path.join(nodeInstallRoot, 'README.md'), 'node.README');
  await copyOptionalFile(`${ffmpegBinary}.LICENSE`, 'ffmpeg.LICENSE');
  await copyOptionalFile(`${ffmpegBinary}.README`, 'ffmpeg.README');

  await writeFile(
    path.join(resourcesDir, 'runtime-manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        node: {
          source: nodeBinary,
          bundledAs: path.basename(bundledNode),
        },
        ffmpeg: {
          source: ffmpegBinary,
          bundledAs: path.basename(bundledFfmpeg),
        },
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`Prepared bundled runtimes in ${resourcesDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
