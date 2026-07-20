import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical-json.mjs';
import { DomainError, invariant } from './errors.mjs';

export const REVIEWER_POLICY_PATH = 'config/reviewer-package.allowlist.json';
export const REVIEWER_MANIFEST_FILENAME = 'reviewer-manifest.json';

const POLICY_SCHEMA = 'xpayr.giwa.agentpay.reviewer-package-policy.v1';
const MANIFEST_SCHEMA = 'xpayr.giwa.agentpay.reviewer-package-manifest.v1';
const HARD_MAX_FILE_BYTES = 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.sol', '.svg']);
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:node_modules|generated|\.git)(?:\/|$)/i,
  /(^|\/).*journal.*(?:\/|$)/i,
  /(^|\/).*resume[._-]?lease.*(?:\/|$)/i,
  /(^|\/).*active[._-]?execution[._-]?lock.*(?:\/|$)/i,
  /(^|\/).*private[._-]?key.*(?:\/|$)/i,
  /(^|\/).*raw[._-]?(?:signed[._-]?)?(?:transaction|tx).*(?:\/|$)/i,
  /(^|\/).*signer.*(?:\/|$)/i,
  /(^|\/).*mnemonic.*(?:\/|$)/i,
  /(^|\/).*keystore.*(?:\/|$)/i,
  /\.(?:key|keystore)$/i,
];
const SECRET_JSON_KEYS = new Set([
  'privatekey',
  'signerkey',
  'signingkey',
  'mnemonic',
  'seedphrase',
  'password',
  'passphrase',
  'secret',
  'secretkey',
  'clientsecret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'bearertoken',
]);
const RAW_TRANSACTION_JSON_KEYS = new Set([
  'rawtransaction',
  'rawsignedtransaction',
  'signedtransaction',
  'serializedtransaction',
  'rawtx',
]);
const REDACTED_SENTINELS = new Set([
  '',
  'false',
  'null',
  'not_provided',
  'not_applicable',
  'redacted',
  '[redacted]',
  '<redacted>',
  '<payer_testnet_private_key>',
  '<provider_testnet_private_key>',
]);

function digestBytes(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestCanonical(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function normalizeSensitiveKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isRedactedValue(value) {
  if (value === false || value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const unquoted = value.trim().replace(/^['"]|['"]$/g, '');
  const normalized = unquoted.toLowerCase();
  if (REDACTED_SENTINELS.has(normalized)) return true;
  return /^\$\{[A-Z][A-Z0-9_]*\}$/.test(unquoted);
}

function inspectJsonSecrets(value, relativePath, jsonPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectJsonSecrets(entry, relativePath, `${jsonPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizeSensitiveKey(key);
    if (SECRET_JSON_KEYS.has(normalizedKey)) {
      invariant(
        isRedactedValue(entry),
        'REVIEWER_SECRET_CONTENT',
        `Allowlisted file contains a populated secret field: ${relativePath}.`,
        { details: { path: `${jsonPath}.${key}` } },
      );
    }
    if (RAW_TRANSACTION_JSON_KEYS.has(normalizedKey)) {
      invariant(
        isRedactedValue(entry),
        'REVIEWER_RAW_TRANSACTION_CONTENT',
        `Allowlisted file contains serialized raw transaction material: ${relativePath}.`,
        { details: { path: `${jsonPath}.${key}` } },
      );
    }
    inspectJsonSecrets(entry, relativePath, `${jsonPath}.${key}`);
  }
}

function inspectTextSecrets(relativePath, text) {
  invariant(
    !/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(text),
    'REVIEWER_SECRET_CONTENT',
    `Allowlisted file contains private-key material: ${relativePath}.`,
  );
  invariant(
    !/(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?:[^A-Z0-9]|$)/.test(text),
    'REVIEWER_SECRET_CONTENT',
    `Allowlisted file contains an access-key-shaped value: ${relativePath}.`,
  );
  invariant(
    !/(?:^|[^a-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}(?:[^A-Za-z0-9_]|$)/i.test(text),
    'REVIEWER_SECRET_CONTENT',
    `Allowlisted file contains an access-token-shaped value: ${relativePath}.`,
  );
  invariant(
    !/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text),
    'REVIEWER_SECRET_CONTENT',
    `Allowlisted file contains credentials embedded in a URL: ${relativePath}.`,
  );
  invariant(
    !/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//.test(text)
      && !/[A-Za-z]:\\Users\\[^\\\s]+\\/i.test(text),
    'REVIEWER_LOCAL_PATH_DISCLOSURE',
    `Allowlisted file contains a local user-home path: ${relativePath}.`,
  );
  invariant(
    !/(?:private[_ -]?key|signer[_ -]?key|raw[_ -]?(?:signed[_ -]?)?(?:transaction|tx))\s*[:=]\s*["']?0x[0-9a-f]{64,}/i.test(text),
    'REVIEWER_SECRET_OR_RAW_TRANSACTION_CONTENT',
    `Allowlisted file contains secret or raw-transaction-shaped material: ${relativePath}.`,
  );

  const assignmentPattern = /\b(?:[A-Z0-9_]*PRIVATE_KEY|[A-Z0-9_]*SIGNING_KEY|MNEMONIC|SEED_PHRASE|PASSWORD|PASSPHRASE|SECRET|SECRET_KEY|CLIENT_SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|BEARER_TOKEN)\b[ \t]*(?:=|:)[ \t]*([^\s,;]+)/gi;
  for (const match of text.matchAll(assignmentPattern)) {
    invariant(
      isRedactedValue(match[1]),
      'REVIEWER_SECRET_CONTENT',
      `Allowlisted file contains a populated secret assignment: ${relativePath}.`,
    );
  }
}

function assertSafeContent(relativePath, bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DomainError(
      'REVIEWER_NON_TEXT_FILE',
      `Allowlisted reviewer file must be UTF-8 text: ${relativePath}.`,
      { cause: error },
    );
  }
  invariant(!text.includes('\0'), 'REVIEWER_NON_TEXT_FILE', `Allowlisted file contains NUL bytes: ${relativePath}.`);
  inspectTextSecrets(relativePath, text);
  if (path.posix.extname(relativePath).toLowerCase() === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DomainError(
        'REVIEWER_INVALID_JSON',
        `Allowlisted JSON is invalid: ${relativePath}.`,
        { cause: error },
      );
    }
    inspectJsonSecrets(parsed, relativePath);
  }
}

export function validateReviewerRelativePath(relativePath) {
  invariant(typeof relativePath === 'string' && relativePath.length > 0, 'REVIEWER_INVALID_PATH', 'Reviewer path must be a non-empty string.');
  invariant(relativePath === relativePath.trim(), 'REVIEWER_INVALID_PATH', 'Reviewer path cannot contain outer whitespace.');
  invariant(!relativePath.includes('\\') && !relativePath.includes('\0'), 'REVIEWER_INVALID_PATH', 'Reviewer paths must use safe POSIX separators.');
  invariant(!path.posix.isAbsolute(relativePath), 'REVIEWER_INVALID_PATH', 'Reviewer path must be relative.');
  invariant(path.posix.normalize(relativePath) === relativePath, 'REVIEWER_INVALID_PATH', 'Reviewer path must be normalized.');
  const parts = relativePath.split('/');
  invariant(parts.every((part) => part && part !== '.' && part !== '..'), 'REVIEWER_INVALID_PATH', 'Reviewer path traversal is forbidden.');
  invariant(
    !FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(relativePath)),
    'REVIEWER_FORBIDDEN_PATH',
    `Reviewer path belongs to a forbidden private/runtime class: ${relativePath}.`,
  );
  invariant(
    ALLOWED_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()),
    'REVIEWER_FILE_TYPE_FORBIDDEN',
    `Reviewer file type is not allowlisted: ${relativePath}.`,
  );
  return relativePath;
}

async function assertRootDirectory(rootPath) {
  const resolved = path.resolve(rootPath);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    throw new DomainError('REVIEWER_ROOT_UNAVAILABLE', 'Reviewer root is unavailable.', { cause: error });
  }
  invariant(info.isDirectory() && !info.isSymbolicLink(), 'REVIEWER_ROOT_UNSAFE', 'Reviewer root must be a real directory.');
  // Canonicalize operating-system aliases such as macOS /var -> /private/var.
  // The selected root entry itself and every package descendant are still
  // checked with lstat, so an attacker-controlled symlink remains forbidden.
  return realpath(resolved);
}

async function readSafeRegularFile(rootPath, relativePath, limits = {}) {
  validateReviewerRelativePath(relativePath);
  const root = await assertRootDirectory(rootPath);
  const target = path.resolve(root, ...relativePath.split('/'));
  invariant(target.startsWith(`${root}${path.sep}`), 'REVIEWER_PATH_ESCAPE', 'Reviewer path escapes the package root.');

  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      throw new DomainError('REVIEWER_FILE_UNAVAILABLE', `Reviewer file is unavailable: ${relativePath}.`, { cause: error });
    }
    invariant(!info.isSymbolicLink(), 'REVIEWER_SYMLINK_FORBIDDEN', `Symlink is forbidden in reviewer path: ${relativePath}.`);
  }

  const info = await lstat(target);
  invariant(info.isFile(), 'REVIEWER_NOT_REGULAR_FILE', `Reviewer entry must be a regular file: ${relativePath}.`);
  invariant(await realpath(target) === target, 'REVIEWER_SYMLINK_FORBIDDEN', `Reviewer file cannot resolve through a symlink: ${relativePath}.`);
  if (Number.isSafeInteger(limits.maxFileBytes)) {
    invariant(info.size <= limits.maxFileBytes, 'REVIEWER_FILE_TOO_LARGE', `Reviewer file exceeds its size cap: ${relativePath}.`);
  }
  const bytes = await readFile(target);
  assertSafeContent(relativePath, bytes);
  return bytes;
}

function validatePolicy(policy) {
  invariant(policy && typeof policy === 'object' && !Array.isArray(policy), 'REVIEWER_INVALID_POLICY', 'Reviewer policy must be an object.');
  invariant(policy.schema === POLICY_SCHEMA, 'REVIEWER_INVALID_POLICY', 'Unsupported reviewer package policy schema.');
  invariant(typeof policy.package_name === 'string' && /^[a-z0-9][a-z0-9-]+$/.test(policy.package_name), 'REVIEWER_INVALID_POLICY', 'Reviewer package name is invalid.');
  invariant(typeof policy.snapshot_id === 'string' && /^[a-z0-9][a-z0-9-]+$/.test(policy.snapshot_id), 'REVIEWER_INVALID_POLICY', 'Reviewer snapshot ID is invalid.');
  invariant(Number.isFinite(Date.parse(policy.snapshot_at)), 'REVIEWER_INVALID_POLICY', 'Reviewer snapshot time is invalid.');
  invariant(policy.network_key === 'giwa-testnet', 'REVIEWER_INVALID_POLICY', 'Reviewer package must remain GIWA testnet-only.');
  invariant(policy.chain_id === 91342, 'REVIEWER_INVALID_POLICY', 'Reviewer package chain ID must be 91342.');
  invariant(policy.manifest_filename === REVIEWER_MANIFEST_FILENAME, 'REVIEWER_INVALID_POLICY', 'Reviewer manifest filename is fixed.');
  invariant(/^generated\/[a-z0-9][a-z0-9-]+$/.test(policy.output_directory), 'REVIEWER_INVALID_OUTPUT', 'Reviewer output must be one direct child of generated/.');
  invariant(Number.isSafeInteger(policy.limits?.max_file_bytes) && policy.limits.max_file_bytes > 0, 'REVIEWER_INVALID_POLICY', 'Reviewer per-file cap is invalid.');
  invariant(policy.limits.max_file_bytes <= HARD_MAX_FILE_BYTES, 'REVIEWER_INVALID_POLICY', 'Reviewer per-file cap exceeds the hard safety limit.');
  invariant(Number.isSafeInteger(policy.limits?.max_total_bytes) && policy.limits.max_total_bytes >= policy.limits.max_file_bytes, 'REVIEWER_INVALID_POLICY', 'Reviewer total cap is invalid.');
  invariant(policy.limits.max_total_bytes <= HARD_MAX_TOTAL_BYTES, 'REVIEWER_INVALID_POLICY', 'Reviewer total cap exceeds the hard safety limit.');
  invariant(Array.isArray(policy.files) && policy.files.length > 0, 'REVIEWER_INVALID_POLICY', 'Reviewer allowlist must contain files.');
  policy.files.forEach(validateReviewerRelativePath);
  const sorted = [...policy.files].sort();
  invariant(new Set(policy.files).size === policy.files.length, 'REVIEWER_DUPLICATE_PATH', 'Reviewer allowlist paths must be unique.');
  invariant(JSON.stringify(policy.files) === JSON.stringify(sorted), 'REVIEWER_UNSORTED_PATHS', 'Reviewer allowlist must be sorted.');
  invariant(policy.files.includes(REVIEWER_POLICY_PATH), 'REVIEWER_POLICY_NOT_INCLUDED', 'Reviewer policy must include itself.');
  invariant(policy.boundaries?.testnet_only === true, 'REVIEWER_INVALID_BOUNDARY', 'Reviewer package must be testnet-only.');
  for (const boundary of [
    'contains_private_keys',
    'contains_raw_signed_transactions',
    'contains_journals_or_leases',
    'contains_private_environment_files',
    'contains_real_customer_funds',
    'public_repository_published',
    'gasok_submission_completed',
  ]) {
    invariant(policy.boundaries?.[boundary] === false, 'REVIEWER_INVALID_BOUNDARY', `Reviewer boundary must remain false: ${boundary}.`);
  }
  return policy;
}

export async function loadReviewerPackagePolicy(rootPath, policyRelativePath = REVIEWER_POLICY_PATH) {
  const bytes = await readSafeRegularFile(rootPath, policyRelativePath, { maxFileBytes: 128 * 1024 });
  let policy;
  try {
    policy = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new DomainError('REVIEWER_INVALID_POLICY_JSON', 'Reviewer package policy is not valid JSON.', { cause: error });
  }
  return { policy: validatePolicy(policy), bytes };
}

function manifestWithIntegrity(payload) {
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      scope: 'entire_document_except_integrity',
      digest: digestCanonical(payload),
    },
  };
}

async function listPackageFiles(rootPath, relativeDirectory = '') {
  const directory = relativeDirectory
    ? path.join(rootPath, ...relativeDirectory.split('/'))
    : rootPath;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    invariant(!info.isSymbolicLink(), 'REVIEWER_SYMLINK_FORBIDDEN', `Symlink is forbidden in reviewer package: ${relativePath}.`);
    if (info.isDirectory()) {
      files.push(...await listPackageFiles(rootPath, relativePath));
    } else {
      invariant(info.isFile(), 'REVIEWER_NOT_REGULAR_FILE', `Reviewer package contains a non-regular entry: ${relativePath}.`);
      files.push(relativePath);
    }
  }
  return files.sort();
}

function validateManifestShape(manifest) {
  invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest must be an object.');
  invariant(manifest.schema === MANIFEST_SCHEMA, 'REVIEWER_INVALID_MANIFEST', 'Unsupported reviewer manifest schema.');
  invariant(typeof manifest.package_name === 'string' && /^[a-z0-9][a-z0-9-]+$/.test(manifest.package_name), 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest package name is invalid.');
  invariant(typeof manifest.snapshot_id === 'string' && /^[a-z0-9][a-z0-9-]+$/.test(manifest.snapshot_id), 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest snapshot ID is invalid.');
  invariant(Number.isFinite(Date.parse(manifest.snapshot_at)), 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest snapshot time is invalid.');
  invariant(manifest.network_key === 'giwa-testnet' && manifest.chain_id === 91342, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest network binding is invalid.');
  invariant(Number.isSafeInteger(manifest.limits?.max_file_bytes) && manifest.limits.max_file_bytes > 0 && manifest.limits.max_file_bytes <= HARD_MAX_FILE_BYTES, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest per-file cap is invalid.');
  invariant(Number.isSafeInteger(manifest.limits?.max_total_bytes) && manifest.limits.max_total_bytes >= manifest.limits.max_file_bytes && manifest.limits.max_total_bytes <= HARD_MAX_TOTAL_BYTES, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest total cap is invalid.');
  invariant(Array.isArray(manifest.files) && manifest.files.length > 0, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest has no files.');
  const manifestPaths = manifest.files.map((entry) => entry?.path);
  manifestPaths.forEach(validateReviewerRelativePath);
  invariant(new Set(manifestPaths).size === manifestPaths.length, 'REVIEWER_DUPLICATE_PATH', 'Reviewer manifest paths must be unique.');
  invariant(JSON.stringify(manifestPaths) === JSON.stringify([...manifestPaths].sort()), 'REVIEWER_UNSORTED_PATHS', 'Reviewer manifest paths must be sorted.');
  invariant(manifest.file_count === manifest.files.length, 'REVIEWER_FILE_COUNT_MISMATCH', 'Reviewer manifest file count is invalid.');
  invariant(Number.isSafeInteger(manifest.total_bytes) && manifest.total_bytes >= 0 && manifest.total_bytes <= manifest.limits.max_total_bytes, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest total byte count is invalid.');
  invariant(manifest.allowlist?.path === REVIEWER_POLICY_PATH, 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest allowlist binding is invalid.');
  invariant(/^0x[0-9a-f]{64}$/.test(manifest.allowlist?.sha256), 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest allowlist digest is invalid.');
  invariant(manifest.integrity?.algorithm === 'sha256', 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest integrity algorithm is invalid.');
  invariant(manifest.integrity?.canonicalization === 'xpayr-canonical-json-v1', 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest canonicalization is invalid.');
  invariant(manifest.integrity?.scope === 'entire_document_except_integrity', 'REVIEWER_INVALID_MANIFEST', 'Reviewer manifest integrity scope is invalid.');
  const { integrity, ...payload } = manifest;
  invariant(integrity.digest === digestCanonical(payload), 'REVIEWER_MANIFEST_DIGEST_MISMATCH', 'Reviewer manifest canonical digest does not match.');
  invariant(manifest.boundaries?.testnet_only === true, 'REVIEWER_INVALID_BOUNDARY', 'Reviewer manifest must remain testnet-only.');
  for (const boundary of [
    'contains_private_keys',
    'contains_raw_signed_transactions',
    'contains_journals_or_leases',
    'contains_private_environment_files',
    'contains_real_customer_funds',
    'public_repository_published',
    'gasok_submission_completed',
  ]) {
    invariant(manifest.boundaries?.[boundary] === false, 'REVIEWER_INVALID_BOUNDARY', `Reviewer manifest boundary must remain false: ${boundary}.`);
  }
  return manifest;
}

export async function verifyReviewerPackage(packageRoot) {
  const root = await assertRootDirectory(packageRoot);
  const manifestBytes = await readSafeRegularFile(root, REVIEWER_MANIFEST_FILENAME, { maxFileBytes: 1024 * 1024 });
  let manifest;
  try {
    manifest = validateManifestShape(JSON.parse(manifestBytes.toString('utf8')));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('REVIEWER_INVALID_MANIFEST_JSON', 'Reviewer manifest is not valid JSON.', { cause: error });
  }

  const actualFiles = await listPackageFiles(root);
  const expectedFiles = [...manifest.files.map((entry) => entry.path), REVIEWER_MANIFEST_FILENAME].sort();
  invariant(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), 'REVIEWER_PACKAGE_FILESET_MISMATCH', 'Reviewer package contains a missing or unexpected file.');

  let totalBytes = 0;
  for (const entry of manifest.files) {
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, 'REVIEWER_INVALID_MANIFEST', `Reviewer file byte count is invalid: ${entry.path}.`);
    invariant(/^0x[0-9a-f]{64}$/.test(entry.sha256), 'REVIEWER_INVALID_MANIFEST', `Reviewer file digest is invalid: ${entry.path}.`);
    const bytes = await readSafeRegularFile(root, entry.path, { maxFileBytes: manifest.limits.max_file_bytes });
    invariant(bytes.length === entry.bytes, 'REVIEWER_FILE_SIZE_MISMATCH', `Reviewer file size does not match: ${entry.path}.`);
    invariant(digestBytes(bytes) === entry.sha256, 'REVIEWER_FILE_DIGEST_MISMATCH', `Reviewer file digest does not match: ${entry.path}.`);
    totalBytes += bytes.length;
  }
  invariant(totalBytes === manifest.total_bytes, 'REVIEWER_TOTAL_SIZE_MISMATCH', 'Reviewer package total byte count does not match.');
  invariant(totalBytes <= manifest.limits.max_total_bytes, 'REVIEWER_TOTAL_TOO_LARGE', 'Reviewer package exceeds its total size cap.');
  const allowlistEntry = manifest.files.find((entry) => entry.path === manifest.allowlist.path);
  invariant(allowlistEntry?.sha256 === manifest.allowlist.sha256, 'REVIEWER_ALLOWLIST_DIGEST_MISMATCH', 'Reviewer allowlist digest binding does not match.');

  const { policy: embeddedPolicy, bytes: embeddedPolicyBytes } = await loadReviewerPackagePolicy(root, manifest.allowlist.path);
  invariant(digestBytes(embeddedPolicyBytes) === manifest.allowlist.sha256, 'REVIEWER_ALLOWLIST_DIGEST_MISMATCH', 'Embedded reviewer allowlist digest does not match the manifest binding.');
  invariant(embeddedPolicy.package_name === manifest.package_name, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist package name does not match the manifest.');
  invariant(embeddedPolicy.snapshot_id === manifest.snapshot_id, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist snapshot ID does not match the manifest.');
  invariant(embeddedPolicy.snapshot_at === manifest.snapshot_at, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist snapshot time does not match the manifest.');
  invariant(embeddedPolicy.network_key === manifest.network_key, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist network does not match the manifest.');
  invariant(embeddedPolicy.chain_id === manifest.chain_id, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist chain ID does not match the manifest.');
  invariant(embeddedPolicy.manifest_filename === REVIEWER_MANIFEST_FILENAME, 'REVIEWER_ALLOWLIST_METADATA_MISMATCH', 'Reviewer allowlist manifest filename is not canonical.');
  invariant(canonicalJson(embeddedPolicy.limits) === canonicalJson(manifest.limits), 'REVIEWER_ALLOWLIST_LIMITS_MISMATCH', 'Reviewer allowlist limits do not match the manifest.');
  invariant(canonicalJson(embeddedPolicy.boundaries) === canonicalJson(manifest.boundaries), 'REVIEWER_ALLOWLIST_BOUNDARIES_MISMATCH', 'Reviewer allowlist boundaries do not match the manifest.');
  invariant(
    JSON.stringify(embeddedPolicy.files) === JSON.stringify(manifest.files.map((entry) => entry.path)),
    'REVIEWER_ALLOWLIST_FILESET_MISMATCH',
    'Reviewer allowlist file set does not match the manifest.',
  );

  return {
    ok: true,
    root,
    package_name: manifest.package_name,
    snapshot_id: manifest.snapshot_id,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    manifest_digest: manifest.integrity.digest,
  };
}

async function setDeterministicTimes(rootPath, timestamp) {
  const files = await listPackageFiles(rootPath);
  for (const relativePath of files) {
    await chmod(path.join(rootPath, ...relativePath.split('/')), 0o644);
    await utimes(path.join(rootPath, ...relativePath.split('/')), timestamp, timestamp);
  }
  const directories = new Set(['']);
  for (const relativePath of files) {
    const parts = relativePath.split('/');
    parts.pop();
    while (parts.length) {
      directories.add(parts.join('/'));
      parts.pop();
    }
  }
  for (const relativeDirectory of [...directories].sort((left, right) => right.length - left.length)) {
    const target = relativeDirectory ? path.join(rootPath, ...relativeDirectory.split('/')) : rootPath;
    await chmod(target, 0o755);
    await utimes(target, timestamp, timestamp);
  }
}

export async function buildReviewerPackage(sourceRoot, policyRelativePath = REVIEWER_POLICY_PATH) {
  const root = await assertRootDirectory(sourceRoot);
  const { policy, bytes: policyBytes } = await loadReviewerPackagePolicy(root, policyRelativePath);
  const sourceFiles = [];
  let totalBytes = 0;
  for (const relativePath of policy.files) {
    const bytes = await readSafeRegularFile(root, relativePath, { maxFileBytes: policy.limits.max_file_bytes });
    totalBytes += bytes.length;
    invariant(totalBytes <= policy.limits.max_total_bytes, 'REVIEWER_TOTAL_TOO_LARGE', 'Reviewer package exceeds its total size cap.');
    sourceFiles.push({ path: relativePath, bytes, sha256: digestBytes(bytes) });
  }

  const manifest = manifestWithIntegrity({
    schema: MANIFEST_SCHEMA,
    package_name: policy.package_name,
    snapshot_id: policy.snapshot_id,
    snapshot_at: policy.snapshot_at,
    network_key: policy.network_key,
    chain_id: policy.chain_id,
    allowlist: {
      path: policyRelativePath,
      sha256: digestBytes(policyBytes),
    },
    limits: {
      max_file_bytes: policy.limits.max_file_bytes,
      max_total_bytes: policy.limits.max_total_bytes,
    },
    boundaries: policy.boundaries,
    file_count: sourceFiles.length,
    total_bytes: totalBytes,
    files: sourceFiles.map(({ path: filePath, bytes, sha256 }) => ({
      path: filePath,
      bytes: bytes.length,
      sha256,
    })),
  });
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');

  const generatedRoot = path.join(root, 'generated');
  await mkdir(generatedRoot, { recursive: true, mode: 0o755 });
  const generatedInfo = await lstat(generatedRoot);
  invariant(generatedInfo.isDirectory() && !generatedInfo.isSymbolicLink(), 'REVIEWER_INVALID_OUTPUT', 'Generated root must be a real directory.');
  invariant(await realpath(generatedRoot) === generatedRoot, 'REVIEWER_INVALID_OUTPUT', 'Generated root cannot resolve through a symlink.');

  const outputRoot = path.join(root, ...policy.output_directory.split('/'));
  invariant(path.dirname(outputRoot) === generatedRoot, 'REVIEWER_INVALID_OUTPUT', 'Reviewer output escaped generated/.');
  const stagingRoot = await mkdtemp(path.join(generatedRoot, `.${path.basename(outputRoot)}.tmp-`));
  try {
    for (const entry of sourceFiles) {
      const target = path.join(stagingRoot, ...entry.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, entry.bytes, { flag: 'wx', mode: 0o644 });
    }
    await writeFile(path.join(stagingRoot, REVIEWER_MANIFEST_FILENAME), manifestBytes, { flag: 'wx', mode: 0o644 });
    await verifyReviewerPackage(stagingRoot);
    await setDeterministicTimes(stagingRoot, new Date(policy.snapshot_at));

    try {
      const existing = await lstat(outputRoot);
      invariant(existing.isDirectory() && !existing.isSymbolicLink(), 'REVIEWER_INVALID_OUTPUT', 'Existing reviewer output must be a real directory.');
      invariant(await realpath(outputRoot) === outputRoot, 'REVIEWER_INVALID_OUTPUT', 'Existing reviewer output cannot resolve through a symlink.');
      const verifiedExisting = await verifyReviewerPackage(outputRoot);
      invariant(
        verifiedExisting.package_name === policy.package_name
          && verifiedExisting.snapshot_id === policy.snapshot_id,
        'REVIEWER_OUTPUT_IDENTITY_MISMATCH',
        'Existing reviewer output belongs to a different package or snapshot.',
      );
      await rm(outputRoot, { recursive: true, force: false });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return verifyReviewerPackage(outputRoot);
}
