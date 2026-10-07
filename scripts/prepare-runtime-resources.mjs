import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ffmpegStatic from 'ffmpeg-static';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const resourcesDir = path.join(repoRoot, 'src-tauri', 'resources', 'bin');
const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const ffmpegPackageVersion = '5.3.0';
const ffmpegReleaseTag = 'b6.1.1';
const pinnedNodeVersion = 'v24.15.0';
const nodeLicenseSha256 = '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18';
const vendoredNodeLicense = path.join(
  repoRoot,
  'scripts',
  'runtime-licenses',
  'node-v24.15.0.LICENSE',
);

// Binary hashes are for the decompressed executables produced by
// ffmpeg-static's b6.1.1 installer. Asset hashes come from GitHub's release API:
// https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
const runtimePins = Object.freeze({
  'windows/x86_64': {
    asset: 'ffmpeg-win32-x64.gz',
    assetSha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    binarySha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  },
  'darwin/aarch64': {
    asset: 'ffmpeg-darwin-arm64.gz',
    assetSha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    binarySha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  },
  'darwin/x86_64': {
    asset: 'ffmpeg-darwin-x64.gz',
    assetSha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    binarySha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
  },
  'linux/aarch64': {
    asset: 'ffmpeg-linux-arm64.gz',
    assetSha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    binarySha256: '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
  },
  'linux/x86_64': {
    asset: 'ffmpeg-linux-x64.gz',
    assetSha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    binarySha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
  },
});

function normalizePlatform(platform) {
  return {
    win32: 'windows',
    windows: 'windows',
    darwin: 'darwin',
    macos: 'darwin',
    linux: 'linux',
  }[platform];
}

function normalizeArch(arch) {
  return {
    x64: 'x86_64',
    x86_64: 'x86_64',
    arm64: 'aarch64',
    aarch64: 'aarch64',
  }[arch];
}

function resolveRuntimeTarget() {
  const hostPlatform = normalizePlatform(process.platform);
  const hostArch = normalizeArch(process.arch);
  const targetPlatform = normalizePlatform(process.env.TAURI_ENV_PLATFORM ?? process.platform);
  const targetArch = normalizeArch(process.env.TAURI_ENV_ARCH ?? process.arch);
  const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? null;

  if (!hostPlatform || !hostArch) {
    throw new Error(`Unsupported runtime build host ${process.platform}/${process.arch}`);
  }
  if (!targetPlatform || !targetArch) {
    throw new Error(
      `Unsupported Tauri runtime target ${process.env.TAURI_ENV_PLATFORM ?? 'unknown'}/${process.env.TAURI_ENV_ARCH ?? 'unknown'}`,
    );
  }
  if (targetTriple && (!process.env.TAURI_ENV_PLATFORM || !process.env.TAURI_ENV_ARCH)) {
    throw new Error('Tauri supplied a target triple without TAURI_ENV_PLATFORM and TAURI_ENV_ARCH');
  }
  if (targetPlatform !== hostPlatform || targetArch !== hostArch) {
    throw new Error(
      `Cross-target runtime packaging is not supported: host ${hostPlatform}/${hostArch}, target ${targetPlatform}/${targetArch}${targetTriple ? ` (${targetTriple})` : ''}`,
    );
  }

  const key = `${targetPlatform}/${targetArch}`;
  const pin = runtimePins[key];
  if (!pin) {
    throw new Error(
      `No pinned FFmpeg runtime is available for ${key}. Supported targets: ${Object.keys(runtimePins).join(', ')}`,
    );
  }

  return { platform: targetPlatform, arch: targetArch, triple: targetTriple, pin };
}

async function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFileSha256(filePath, expected, label) {
  const actual = await fileSha256(filePath);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function ensureExecutable(sourcePath, label) {
  const source = path.resolve(sourcePath);
  await stat(source).catch(() => {
    throw new Error(`Missing ${label} binary at ${source}`);
  });
  return source;
}

async function fileExists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false,
  );
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

async function ensureFfmpegBinary(pin) {
  const packageJsonPath = require.resolve('ffmpeg-static/package.json');
  const packageDir = path.dirname(packageJsonPath);
  const installScript = path.join(packageDir, 'install.js');
  const expectedBinary = ffmpegStatic ? path.resolve(ffmpegStatic) : null;
  const packageMetadata = require(packageJsonPath);
  const ffmpegMetadata = packageMetadata['ffmpeg-static'];

  if (
    packageMetadata.version !== ffmpegPackageVersion ||
    ffmpegMetadata?.['binary-release-tag'] !== ffmpegReleaseTag
  ) {
    throw new Error(
      `ffmpeg-static provenance changed: expected package ${ffmpegPackageVersion} / release ${ffmpegReleaseTag}`,
    );
  }

  if (expectedBinary && (await fileExists(expectedBinary))) {
    const sha256 = await verifyFileSha256(expectedBinary, pin.binarySha256, 'FFmpeg binary');
    return { path: expectedBinary, sha256 };
  }

  if (!expectedBinary) {
    throw new Error(`ffmpeg-static does not provide a binary for ${process.platform}/${process.arch}`);
  }

  const releaseEnvVar = ffmpegMetadata['binary-release-tag-env-var'];

  const install = spawnSync(process.execPath, [installScript], {
    cwd: packageDir,
    stdio: 'inherit',
    env: { ...process.env, [releaseEnvVar]: ffmpegReleaseTag },
  });

  if (install.status !== 0) {
    throw new Error(`ffmpeg-static install.js failed with status ${install.status ?? 'unknown'}`);
  }

  const binaryPath = await ensureExecutable(expectedBinary, 'ffmpeg');
  const sha256 = await verifyFileSha256(binaryPath, pin.binarySha256, 'FFmpeg binary');
  return { path: binaryPath, sha256 };
}

async function resolveNodeLicense(nodeBinary) {
  if (process.version !== pinnedNodeVersion) {
    throw new Error(
      `Release runtime Node must be exactly ${pinnedNodeVersion}; current process is ${process.version}`,
    );
  }

  const executableDir = path.dirname(nodeBinary);
  const candidates = [
    process.env.NODE_LICENSE_PATH,
    path.join(executableDir, 'LICENSE'),
    path.join(executableDir, '..', 'LICENSE'),
    vendoredNodeLicense,
  ].filter(Boolean);

  const mismatches = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      await stat(resolved);
    } catch {
      continue;
    }

    const actual = await fileSha256(resolved);
    if (actual === nodeLicenseSha256) {
      return { path: resolved, sha256: actual };
    }
    mismatches.push(`${resolved} (${actual})`);
  }

  throw new Error(
    `Unable to find the pinned Node ${pinnedNodeVersion} LICENSE (SHA-256 ${nodeLicenseSha256})${mismatches.length ? `; mismatched candidates: ${mismatches.join(', ')}` : ''}`,
  );
}

async function cleanRuntimeOutputs() {
  const names = [
    'node',
    'node.exe',
    'ffmpeg',
    'ffmpeg.exe',
    'node.LICENSE',
    'node.README',
    'ffmpeg.LICENSE',
    'ffmpeg.README',
    'runtime-manifest.json',
  ];
  await Promise.all(names.map((name) => rm(path.join(resourcesDir, name), { force: true })));
}

async function main() {
  const target = resolveRuntimeTarget();
  await mkdir(resourcesDir, { recursive: true });
  await cleanRuntimeOutputs();

  const nodeBinary = await ensureExecutable(process.execPath, 'node');
  const nodeSha256 = await fileSha256(nodeBinary);
  const nodeLicense = await resolveNodeLicense(nodeBinary);
  const ffmpegBinary = await ensureFfmpegBinary(target.pin);

  const bundledNode = await copyExecutable(nodeBinary, `node${exeSuffix}`);
  const bundledFfmpeg = await copyExecutable(ffmpegBinary.path, `ffmpeg${exeSuffix}`);

  await copyFile(nodeLicense.path, path.join(resourcesDir, 'node.LICENSE'));
  await copyOptionalFile(path.join(path.dirname(nodeBinary), 'README.md'), 'node.README');
  await copyOptionalFile(`${ffmpegBinary.path}.LICENSE`, 'ffmpeg.LICENSE');
  await copyOptionalFile(`${ffmpegBinary.path}.README`, 'ffmpeg.README');

  await writeFile(
    path.join(resourcesDir, 'runtime-manifest.json'),
    JSON.stringify(
      {
        target: {
          platform: target.platform,
          arch: target.arch,
          triple: target.triple,
        },
        node: {
          version: process.version,
          sha256: nodeSha256,
          bundledAs: path.basename(bundledNode),
          license: {
            upstream: `https://github.com/nodejs/node/blob/${pinnedNodeVersion}/LICENSE`,
            sha256: nodeLicense.sha256,
            bundledAs: 'node.LICENSE',
          },
        },
        ffmpeg: {
          packageVersion: ffmpegPackageVersion,
          releaseTag: ffmpegReleaseTag,
          upstreamAsset: target.pin.asset,
          upstreamAssetSha256: target.pin.assetSha256,
          sha256: ffmpegBinary.sha256,
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
