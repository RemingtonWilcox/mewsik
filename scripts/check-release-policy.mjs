import path from 'node:path';
import { assertProviderDistributionApproved } from './release-policy.mjs';

const releaseVersion = process.argv[2]?.trim();
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(releaseVersion ?? '')) {
  process.stderr.write('Provider release policy check requires an exact X.Y.Z version.\n');
  process.exitCode = 1;
} else {
  try {
    await assertProviderDistributionApproved(path.resolve(import.meta.dirname, '..'), releaseVersion);
    process.stdout.write(`Provider release policy approved for v${releaseVersion}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
