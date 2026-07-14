import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertProviderDistributionApproved } from './release-policy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(repoRoot, 'src-tauri', 'tauri.release.generated.conf.json');
const checkOnly = process.argv.slice(2).includes('--check');

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
    throw new Error(`${label} must be base64-encoded key-file content, not a path or placeholder`);
  }

  const decoded = Buffer.from(compact, 'base64');
  const canonicalInput = compact.replace(/=+$/, '');
  const canonicalOutput = decoded.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalOutput) {
    throw new Error(`${label} is not valid base64-encoded key-file content`);
  }
  return decoded.toString('utf8');
}

function validateKeyFile(text, expectedComment, label) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  if (
    !(lines[0] === expectedComment || lines[0].startsWith(`${expectedComment}: `)) ||
    !/^RW[A-Za-z0-9+/=]{40,}$/.test(lines[1] ?? '')
  ) {
    throw new Error(`${label} is not a Tauri minisign key in the expected format`);
  }
}

function validateUpdaterPublicKey(value) {
  const decoded = decodeCanonicalBase64(value, 'MEWSIK_UPDATER_PUBLIC_KEY');
  validateKeyFile(decoded, 'untrusted comment: minisign public key', 'MEWSIK_UPDATER_PUBLIC_KEY');
  return value.replace(/\s/g, '');
}

function validateUpdaterPrivateKey(value) {
  const decoded = decodeCanonicalBase64(value, 'TAURI_SIGNING_PRIVATE_KEY');
  validateKeyFile(
    decoded,
    'untrusted comment: rsign encrypted secret key',
    'TAURI_SIGNING_PRIVATE_KEY',
  );
}

function validateSemver(value) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!semver.test(value)) {
    throw new Error('RELEASE_VERSION must be a stable X.Y.Z version without a leading v');
  }
}

function stableVersionParts(value) {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? match.slice(1).map((part) => BigInt(part)) : null;
}

function compareVersionParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function validateMonotonicStableVersion(version) {
  const tags = spawnSync('git', ['tag', '--list', 'v*'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (tags.error) throw tags.error;
  if (tags.status !== 0) {
    throw new Error('Could not inspect existing release tags');
  }

  const requested = stableVersionParts(version);
  const published = tags.stdout
    .split(/\r?\n/)
    .map((tag) => ({ tag: tag.trim(), parts: stableVersionParts(tag.trim()) }))
    .filter(({ parts }) => parts !== null)
    .sort((left, right) => compareVersionParts(right.parts, left.parts));
  const newest = published[0];
  if (newest && compareVersionParts(requested, newest.parts) <= 0) {
    throw new Error(
      `RELEASE_VERSION v${version} must be newer than the highest stable tag (${newest.tag})`,
    );
  }
}

function validateIdentifier(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${name} contains characters that are unsafe for the signing command`);
  }
  return value;
}

function validateArtifactSigningEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AZURE_ARTIFACT_SIGNING_ENDPOINT must be a valid HTTPS URL');
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.codesigning.azure.net') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      'AZURE_ARTIFACT_SIGNING_ENDPOINT must be a bare HTTPS *.codesigning.azure.net endpoint',
    );
  }
  return url.origin;
}

async function readManifestVersions() {
  const readJson = async (relativePath) =>
    JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
  const [rootPackage, sidecarPackage, tauriConfig, cargoToml] = await Promise.all([
    readJson('package.json'),
    readJson('sidecar/package.json'),
    readJson('src-tauri/tauri.conf.json'),
    readFile(path.join(repoRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
  ]);
  const cargoPackage = cargoToml.match(/\[package\]([\s\S]*?)(?:\r?\n\[|$)/)?.[1];
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

  return new Map([
    ['package.json', rootPackage.version],
    ['sidecar/package.json', sidecarPackage.version],
    ['src-tauri/tauri.conf.json', tauriConfig.version],
    ['src-tauri/Cargo.toml', cargoVersion],
  ]);
}

async function validateReleaseContract() {
  const version = requiredEnv('RELEASE_VERSION');
  validateSemver(version);
  validateMonotonicStableVersion(version);

  const versions = await readManifestVersions();
  const mismatches = [...versions].filter(([, manifestVersion]) => manifestVersion !== version);
  if (mismatches.length > 0) {
    const details = [...versions]
      .map(([file, manifestVersion]) => `  ${file}: ${manifestVersion ?? '<missing>'}`)
      .join('\n');
    throw new Error(`RELEASE_VERSION does not match every manifest:\n${details}`);
  }

  const confirmation = requiredEnv('RELEASE_CONFIRMATION');
  if (confirmation !== `CREATE DRAFT v${version}`) {
    throw new Error(`RELEASE_CONFIRMATION must exactly equal: CREATE DRAFT v${version}`);
  }

  const releaseRef = requiredEnv('RELEASE_REF');
  const defaultBranch = requiredEnv('RELEASE_DEFAULT_BRANCH');
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (releaseRef !== expectedRef) {
    throw new Error(`Release workflow must run from the default branch (${expectedRef})`);
  }

  const repository = requiredEnv('RELEASE_REPOSITORY');
  if (repository.toLowerCase() !== 'remingtonwilcox/mewsik') {
    throw new Error('Stable releases may only be created in RemingtonWilcox/mewsik');
  }

  // This checked-in fail-closed review gate cannot be bypassed by adding a
  // repository secret or dispatching the workflow with different inputs.
  await assertProviderDistributionApproved(repoRoot, version);

  const updaterPublicKey = validateUpdaterPublicKey(requiredEnv('MEWSIK_UPDATER_PUBLIC_KEY'));
  validateUpdaterPrivateKey(requiredEnv('TAURI_SIGNING_PRIVATE_KEY'));
  requiredEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');

  // The current Tauri Windows signing integration authenticates through these
  // standard Azure environment variables. Values are checked but never logged.
  requiredEnv('AZURE_CLIENT_ID');
  requiredEnv('AZURE_CLIENT_SECRET');
  requiredEnv('AZURE_TENANT_ID');

  const signingEndpoint = validateArtifactSigningEndpoint(
    requiredEnv('AZURE_ARTIFACT_SIGNING_ENDPOINT'),
  );
  const signingAccount = validateIdentifier(
    requiredEnv('AZURE_ARTIFACT_SIGNING_ACCOUNT'),
    'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  );
  const signingProfile = validateIdentifier(
    requiredEnv('AZURE_ARTIFACT_SIGNING_PROFILE'),
    'AZURE_ARTIFACT_SIGNING_PROFILE',
  );

  return {
    version,
    updaterPublicKey,
    signingEndpoint,
    signingAccount,
    signingProfile,
  };
}

async function writeReleaseConfig(contract) {
  const config = {
    bundle: {
      createUpdaterArtifacts: true,
      windows: {
        signCommand:
          `artifact-signing-cli -e ${contract.signingEndpoint}` +
          ` -a ${contract.signingAccount}` +
          ` -c ${contract.signingProfile} -d mewsik %1`,
      },
    },
    plugins: {
      updater: {
        pubkey: contract.updaterPublicKey,
        endpoints: [
          'https://github.com/RemingtonWilcox/mewsik/releases/latest/download/latest.json',
        ],
        windows: {
          installMode: 'passive',
        },
      },
    },
  };

  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

try {
  const contract = await validateReleaseContract();
  if (!checkOnly) {
    await writeReleaseConfig(contract);
  }
  console.log(
    checkOnly
      ? `Release preflight passed for v${contract.version}; no files were written.`
      : `Generated credential-free release config for v${contract.version}.`,
  );
} catch (error) {
  console.error(`Release preflight failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
