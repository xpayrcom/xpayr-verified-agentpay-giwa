import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const SECURE_ENV_PATH_VARIABLE = 'GIWA_AGENTPAY_ENV_FILE';
export const SIGNER_ENV_KEYS = Object.freeze([
  'GIWA_DEPLOYER_PRIVATE_KEY',
  'GIWA_LIFECYCLE_PAYER_PRIVATE_KEY',
  'GIWA_LIFECYCLE_PROVIDER_PRIVATE_KEY',
  'GIWA_LIFECYCLE_EVALUATOR_PRIVATE_KEY',
  'GIWA_POLICY_AUTHORITY_PRIVATE_KEY',
  'GIWA_EVIDENCE_PRODUCER_PRIVATE_KEY',
]);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseStrictAssignments(source) {
  const parsed = {};
  const keys = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([A-Za-z0-9_./:+-]*)$/);
    if (!match) {
      throw new Error(`Signer environment file contains invalid syntax on line ${index + 1}; use unquoted KEY=VALUE assignments only.`);
    }
    const [, key, value] = match;
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error('Signer environment file contains duplicate variable assignments.');
    }
    parsed[key] = value;
    keys.push(key);
  }
  return { keys, parsed };
}

export async function loadSecureEnvFile(filePath, {
  forbiddenRoot,
  allowedKeys = SIGNER_ENV_KEYS,
  requiredKeys = [],
} = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error(`${SECURE_ENV_PATH_VARIABLE} must be an absolute path.`);
  }
  if (!path.isAbsolute(filePath)) throw new Error(`${SECURE_ENV_PATH_VARIABLE} must be an absolute path.`);
  const absolutePath = path.resolve(filePath);
  if (typeof forbiddenRoot !== 'string' || !path.isAbsolute(forbiddenRoot)) {
    throw new Error('A valid absolute repository root is required for signer-file isolation.');
  }
  const lexicalMetadata = await lstat(absolutePath);
  if (!lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink()) {
    throw new Error('Signer environment path must be a regular non-symlink file.');
  }

  const [root, resolvedPath] = await Promise.all([
    realpath(path.resolve(forbiddenRoot)),
    realpath(absolutePath),
  ]);
  if (isInside(root, resolvedPath)) {
    throw new Error('The populated signer environment file must stay outside the entire repository.');
  }

  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Signer environment path must be a regular non-symlink file.');
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error('Signer environment file permissions must be exactly chmod 600.');
    }
    if (metadata.nlink !== 1) throw new Error('Signer environment file must not have additional hard links.');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('Signer environment file must be owned by the current user.');
    }
    if (metadata.size <= 0 || metadata.size > 16_384) {
      throw new Error('Signer environment file size is outside the accepted range.');
    }
    source = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  const { keys: declaredKeys, parsed } = parseStrictAssignments(source);
  const allowed = new Set(allowedKeys);
  const unknown = declaredKeys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Signer environment file contains unsupported variables: ${unknown.join(', ')}.`);
  for (const key of requiredKeys) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') {
      throw new Error(`Signer environment file is missing required variable ${key}.`);
    }
  }
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new Error(`Signer environment file contains unsupported variable ${key}.`);
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      throw new Error(`Ambient signer variable collision detected for ${key}; unset it and use only the secure file.`);
    }
  }
  for (const [key, value] of Object.entries(parsed)) process.env[key] = value;

  return {
    loaded: true,
    path: resolvedPath,
    permissions: '0600',
    loadedKeys: Object.keys(parsed).sort(),
  };
}

export async function loadConfiguredSecureEnvFile({
  forbiddenRoot,
  allowedKeys = SIGNER_ENV_KEYS,
  requiredKeys = [],
  required = false,
} = {}) {
  const filePath = process.env[SECURE_ENV_PATH_VARIABLE];
  if (!filePath) {
    if (required) throw new Error(`${SECURE_ENV_PATH_VARIABLE} is required for execute mode.`);
    return { loaded: false, path: null, permissions: null, loadedKeys: [] };
  }
  return loadSecureEnvFile(filePath, { forbiddenRoot, allowedKeys, requiredKeys });
}
