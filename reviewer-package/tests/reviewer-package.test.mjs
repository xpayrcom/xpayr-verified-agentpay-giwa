import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/canonical-json.mjs';
import {
  REVIEWER_MANIFEST_FILENAME,
  buildReviewerPackage,
  validateReviewerRelativePath,
  verifyReviewerPackage,
} from '../src/reviewer-package.mjs';

const POLICY_PATH = 'config/reviewer-package.allowlist.json';

function sha256(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function resealManifest(manifest) {
  const { integrity: ignored, ...payload } = manifest;
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      scope: 'entire_document_except_integrity',
      digest: sha256(Buffer.from(canonicalJson(payload), 'utf8')),
    },
  };
}

async function createFixture(t, { extraFiles = {}, files = ['README.md', POLICY_PATH] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpayr-giwa-reviewer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Public reviewer fixture\n', 'utf8');
  for (const [relativePath, value] of Object.entries(extraFiles)) {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value, 'utf8');
  }
  const policy = {
    schema: 'xpayr.giwa.agentpay.reviewer-package-policy.v1',
    package_name: 'xpayr-reviewer-fixture',
    snapshot_id: 'fixture-20260720',
    snapshot_at: '2026-07-20T00:00:00.000Z',
    network_key: 'giwa-testnet',
    chain_id: 91342,
    output_directory: 'generated/reviewer-fixture',
    manifest_filename: REVIEWER_MANIFEST_FILENAME,
    limits: { max_file_bytes: 65536, max_total_bytes: 262144 },
    boundaries: {
      testnet_only: true,
      contains_private_keys: false,
      contains_raw_signed_transactions: false,
      contains_journals_or_leases: false,
      contains_private_environment_files: false,
      contains_real_customer_funds: false,
      public_repository_published: false,
      gasok_submission_completed: false,
    },
    files: [...files].sort(),
  };
  await writeFile(path.join(root, ...POLICY_PATH.split('/')), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  return root;
}

test('build is deterministic and the generated package verifies with an exact allowlisted file set', async (t) => {
  const root = await createFixture(t);
  const first = await buildReviewerPackage(root);
  const manifestPath = path.join(first.root, REVIEWER_MANIFEST_FILENAME);
  const firstManifest = await readFile(manifestPath);
  const second = await buildReviewerPackage(root);
  const secondManifest = await readFile(path.join(second.root, REVIEWER_MANIFEST_FILENAME));

  assert.deepEqual(secondManifest, firstManifest);
  assert.equal(first.manifest_digest, second.manifest_digest);
  assert.equal(second.file_count, 2);
  assert.equal((await verifyReviewerPackage(second.root)).ok, true);
});

test('verification rejects a modified allowlisted file', async (t) => {
  const root = await createFixture(t);
  const built = await buildReviewerPackage(root);
  await writeFile(path.join(built.root, 'README.md'), '# Tampered\n', 'utf8');
  await assert.rejects(() => verifyReviewerPackage(built.root), { code: 'REVIEWER_FILE_SIZE_MISMATCH' });
});

test('verification rejects an unexpected non-allowlisted file', async (t) => {
  const root = await createFixture(t);
  const built = await buildReviewerPackage(root);
  await writeFile(path.join(built.root, 'unexpected.md'), 'extra\n', 'utf8');
  await assert.rejects(() => verifyReviewerPackage(built.root), { code: 'REVIEWER_PACKAGE_FILESET_MISMATCH' });
});

test('verification rejects a recomputed manifest that adds a file absent from the embedded allowlist', async (t) => {
  const root = await createFixture(t);
  const built = await buildReviewerPackage(root);
  const unexpectedBytes = Buffer.from('recomputed-manifest attack\n', 'utf8');
  await writeFile(path.join(built.root, 'unexpected.md'), unexpectedBytes);

  const manifestPath = path.join(built.root, REVIEWER_MANIFEST_FILENAME);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.push({
    path: 'unexpected.md',
    bytes: unexpectedBytes.length,
    sha256: sha256(unexpectedBytes),
  });
  manifest.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  manifest.file_count = manifest.files.length;
  manifest.total_bytes += unexpectedBytes.length;
  await writeFile(manifestPath, `${canonicalJson(resealManifest(manifest))}\n`, 'utf8');

  await assert.rejects(() => verifyReviewerPackage(built.root), { code: 'REVIEWER_ALLOWLIST_FILESET_MISMATCH' });
});

test('build preserves and refuses to replace an unrelated existing output directory', async (t) => {
  const root = await createFixture(t);
  const existingRoot = path.join(root, 'generated', 'reviewer-fixture');
  const unrelatedPath = path.join(existingRoot, 'unrelated.md');
  await mkdir(existingRoot, { recursive: true });
  await writeFile(unrelatedPath, 'do not delete\n', 'utf8');

  await assert.rejects(() => buildReviewerPackage(root), { code: 'REVIEWER_FILE_UNAVAILABLE' });
  assert.equal(await readFile(unrelatedPath, 'utf8'), 'do not delete\n');
});

test('build rejects a symlink even when its path is allowlisted', async (t) => {
  const root = await createFixture(t, {
    extraFiles: { 'public.md': 'safe\n' },
    files: [POLICY_PATH, 'linked.md'],
  });
  await symlink(path.join(root, 'public.md'), path.join(root, 'linked.md'));
  await assert.rejects(() => buildReviewerPackage(root), { code: 'REVIEWER_SYMLINK_FORBIDDEN' });
});

test('path policy rejects journals, leases, environment files and traversal', () => {
  for (const forbidden of [
    '../secret.json',
    '.env',
    'evidence/run.journal.json',
    'evidence/run.resume.lease.json',
    'secrets/signer.key',
  ]) {
    assert.throws(() => validateReviewerRelativePath(forbidden));
  }
});

test('build rejects populated private-key fields while permitting explicit false boundary flags', async (t) => {
  const secretRoot = await createFixture(t, {
    extraFiles: { 'evidence/unsafe.json': '{"private_key":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n' },
    files: [POLICY_PATH, 'evidence/unsafe.json'],
  });
  await assert.rejects(() => buildReviewerPackage(secretRoot), { code: 'REVIEWER_SECRET_CONTENT' });

  const safeRoot = await createFixture(t, {
    extraFiles: { 'evidence/safe.json': '{"private_keys_persisted":false,"raw_signed_transaction_persisted":false}\n' },
    files: [POLICY_PATH, 'evidence/safe.json'],
  });
  assert.equal((await buildReviewerPackage(safeRoot)).ok, true);
});

test('build rejects populated angle-bracket placeholders and common password fields', async (t) => {
  const root = await createFixture(t, {
    extraFiles: {
      'evidence/unsafe.json': '{"private_key":"<populated-value>","password":"populated-value"}\n',
    },
    files: [POLICY_PATH, 'evidence/unsafe.json'],
  });
  await assert.rejects(() => buildReviewerPackage(root), { code: 'REVIEWER_SECRET_CONTENT' });
});

test('secret placeholders accept only explicit sentinels or strict uppercase environment references', async (t) => {
  const safeRoot = await createFixture(t, {
    extraFiles: { 'evidence/safe.json': '{"private_key":"${REVIEWER_PRIVATE_KEY}","password":"<redacted>"}\n' },
    files: [POLICY_PATH, 'evidence/safe.json'],
  });
  assert.equal((await buildReviewerPackage(safeRoot)).ok, true);

  const unsafeRoot = await createFixture(t, {
    extraFiles: { 'evidence/unsafe.json': '{"private_key":"${reviewer_private_key}"}\n' },
    files: [POLICY_PATH, 'evidence/unsafe.json'],
  });
  await assert.rejects(() => buildReviewerPackage(unsafeRoot), { code: 'REVIEWER_SECRET_CONTENT' });
});

test('build rejects serialized raw signed transaction fields', async (t) => {
  const root = await createFixture(t, {
    extraFiles: { 'evidence/unsafe.json': '{"raw_signed_transaction":"0x02f86b0184deadbeef"}\n' },
    files: [POLICY_PATH, 'evidence/unsafe.json'],
  });
  await assert.rejects(() => buildReviewerPackage(root), { code: 'REVIEWER_RAW_TRANSACTION_CONTENT' });
});
