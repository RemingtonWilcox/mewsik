import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertProviderDistributionApproved, validateReleasePolicy } from './release-policy.mjs';

const approved = {
  schema_version: 1,
  distribution_approved: true,
  approved_release_version: '0.3.0',
  reviewed_at: '2026-07-14T23:59:00Z',
  approval_reference: 'https://github.com/RemingtonWilcox/mewsik/issues/12',
  blockers: [],
};

test('rejects the checked-in blocked distribution policy', () => {
  assert.throws(
    () => validateReleasePolicy({ ...approved, distribution_approved: false, blockers: ['open'] }, '0.3.0'),
    /distributed builds are blocked by 1 documented item/u,
  );
});

test('binds approval to the exact release version', () => {
  assert.throws(() => validateReleasePolicy(approved, '0.3.1'), /exact release version 0\.3\.1/u);
});

test('cannot approve a release while documented blockers remain', () => {
  assert.throws(
    () => validateReleasePolicy({ ...approved, blockers: ['still open'] }, '0.3.0'),
    /empty blockers list/u,
  );
});

test('requires a repository review reference and canonical UTC timestamp', () => {
  assert.throws(
    () => validateReleasePolicy({ ...approved, approval_reference: 'https://example.test/ok' }, '0.3.0'),
    /approval_reference/u,
  );
  assert.throws(
    () => validateReleasePolicy({ ...approved, reviewed_at: 'yesterday' }, '0.3.0'),
    /reviewed_at/u,
  );
});

test('accepts a version-bound reviewed policy', () => {
  assert.equal(validateReleasePolicy(approved, '0.3.0'), approved);
});

test('the checked-in policy keeps distributed builds fail-closed', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const checkedIn = JSON.parse(await readFile(path.join(root, 'release', 'provider-policy.json')));
  assert.equal(checkedIn.distribution_approved, false);
  await assert.rejects(assertProviderDistributionApproved(root, '0.2.0'), /distributed builds are blocked/u);
});
