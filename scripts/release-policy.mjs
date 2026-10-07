import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_POLICY_PATH = path.join('release', 'provider-policy.json');

function policyError(message) {
  return new Error(`Provider release policy: ${message}`);
}

export function validateReleasePolicy(policy, releaseVersion) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw policyError('the policy file must contain a JSON object');
  }
  if (policy.schema_version !== 1) {
    throw policyError('unsupported or missing schema_version');
  }
  if (policy.distribution_approved !== true) {
    const blockers = Array.isArray(policy.blockers)
      ? policy.blockers.filter((value) => typeof value === 'string' && value.trim()).length
      : 0;
    throw policyError(
      `distributed builds are blocked${blockers ? ` by ${blockers} documented item${blockers === 1 ? '' : 's'}` : ''}; see ${RELEASE_POLICY_PATH}`,
    );
  }
  if (policy.approved_release_version !== releaseVersion) {
    throw policyError(`approval must target the exact release version ${releaseVersion}`);
  }
  if (!Array.isArray(policy.blockers) || policy.blockers.length !== 0) {
    throw policyError('an approved policy must have an empty blockers list');
  }
  if (
    typeof policy.reviewed_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(policy.reviewed_at) ||
    Number.isNaN(Date.parse(policy.reviewed_at))
  ) {
    throw policyError('reviewed_at must be a valid UTC timestamp with whole seconds');
  }
  if (
    typeof policy.approval_reference !== 'string' ||
    !/^https:\/\/github\.com\/RemingtonWilcox\/mewsik\/(?:issues|pull)\/\d+$/u.test(
      policy.approval_reference,
    )
  ) {
    throw policyError('approval_reference must link to a mewsik GitHub issue or pull request');
  }
  return policy;
}

export async function assertProviderDistributionApproved(repoRoot, releaseVersion) {
  let policy;
  try {
    policy = JSON.parse(await readFile(path.join(repoRoot, RELEASE_POLICY_PATH), 'utf8'));
  } catch (error) {
    throw policyError(
      `could not read ${RELEASE_POLICY_PATH}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return validateReleasePolicy(policy, releaseVersion);
}
