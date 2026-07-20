#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import {
  EVIDENCE_PRODUCER_KEY_NAME,
  PHASE4_SOD_PROFILE_ID,
  POLICY_AUTHORITY_KEY_NAME,
  sealAuthorityProfile,
  validateAuthorityProfile,
} from '../src/authority-profile.mjs';
import { invariant } from '../src/errors.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(MODULE_ROOT, '..');
const TESTNET_CONFIRMATION = 'GIWA_SEPOLIA_TEST_ETH_ONLY';

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function valueMap(argv) {
  const allowed = new Set([
    '--policy-env-file',
    '--evidence-env-file',
    '--confirm-profile',
    '--confirm-testnet-only',
  ]);
  const values = new Map();
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    invariant(separator > 2, 'SOD_KEYGEN_ARGUMENT_INVALID', 'Key-generation arguments must use --name=value syntax.');
    const name = argument.slice(0, separator);
    invariant(allowed.has(name) && !values.has(name),
      'SOD_KEYGEN_ARGUMENT_INVALID', `Unsupported or duplicate key-generation argument: ${name}.`);
    values.set(name, argument.slice(separator + 1));
  }
  return values;
}

export function parseKeyGenerationArgs(argv) {
  const values = valueMap(argv);
  invariant(values.get('--confirm-profile') === PHASE4_SOD_PROFILE_ID,
    'SOD_KEYGEN_CONFIRMATION_REQUIRED', 'Exact --confirm-profile=phase4_sod_v1 is required.');
  invariant(values.get('--confirm-testnet-only') === TESTNET_CONFIRMATION,
    'SOD_KEYGEN_CONFIRMATION_REQUIRED', 'Exact GIWA Sepolia test-ETH-only confirmation is required.');
  const policyEnvPath = values.get('--policy-env-file');
  const evidenceEnvPath = values.get('--evidence-env-file');
  invariant(path.isAbsolute(policyEnvPath ?? '') && path.isAbsolute(evidenceEnvPath ?? ''),
    'SOD_KEYGEN_PATH_INVALID', 'Both output files must use absolute paths.');
  invariant(path.resolve(policyEnvPath) !== path.resolve(evidenceEnvPath),
    'SOD_KEYGEN_PATH_COLLISION', 'Policy and evidence keys require two different files.');
  return Object.freeze({
    policyEnvPath: path.resolve(policyEnvPath),
    evidenceEnvPath: path.resolve(evidenceEnvPath),
  });
}

async function assertNewRepoExternalPath(filePath, repositoryRoot) {
  const [root, parent] = await Promise.all([
    realpath(repositoryRoot),
    realpath(path.dirname(filePath)),
  ]);
  invariant(!isInside(root, parent),
    'SOD_KEYGEN_PATH_INSIDE_REPOSITORY', 'Authority key files must stay outside the entire xpayr.com repository.');
  try {
    await lstat(filePath);
    invariant(false, 'SOD_KEYGEN_OUTPUT_EXISTS', 'Authority key output already exists; refusing overwrite or symlink replacement.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return parent;
}

export async function writeSecretFile(filePath, variableName, privateKey, {
  openFile = open,
  unlinkFile = unlink,
} = {}) {
  const handle = await openFile(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let operationError = null;
  try {
    await handle.writeFile(`${variableName}=${privateKey}\n`, 'utf8');
    await handle.sync();
    const metadata = await handle.stat();
    invariant(metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600,
      'SOD_KEYGEN_OUTPUT_UNSAFE', 'Generated authority key file did not retain exact 0600 single-link safety.');
    if (typeof process.getuid === 'function') {
      invariant(metadata.uid === process.getuid(),
        'SOD_KEYGEN_OUTPUT_UNSAFE', 'Generated authority key file is not owned by the current user.');
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== null) {
    try {
      await unlinkFile(filePath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') operationError.cleanupError = cleanupError;
    }
    throw operationError;
  }
}

export async function generateSodAuthorityKeys({
  policyEnvPath,
  evidenceEnvPath,
  moduleRoot = MODULE_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
  walletFactory = () => Wallet.createRandom(),
} = {}) {
  invariant(path.isAbsolute(policyEnvPath ?? '') && path.isAbsolute(evidenceEnvPath ?? ''),
    'SOD_KEYGEN_PATH_INVALID', 'Two absolute output paths are required.');
  invariant(path.resolve(policyEnvPath) !== path.resolve(evidenceEnvPath),
    'SOD_KEYGEN_PATH_COLLISION', 'Policy and evidence keys require two different files.');
  await Promise.all([
    assertNewRepoExternalPath(policyEnvPath, repositoryRoot),
    assertNewRepoExternalPath(evidenceEnvPath, repositoryRoot),
  ]);
  const profilePath = path.join(moduleRoot, 'config', 'authority-profiles', `${PHASE4_SOD_PROFILE_ID}.json`);
  const deploymentPath = path.join(moduleRoot, 'config', 'deployment.json');
  const [pendingProfile, deployment] = await Promise.all([
    readFile(profilePath, 'utf8').then(JSON.parse),
    readFile(deploymentPath, 'utf8').then(JSON.parse),
  ]);
  validateAuthorityProfile(pendingProfile, { deployment, requireActive: false });
  invariant(pendingProfile.status === 'pending_addresses',
    'SOD_KEYGEN_PROFILE_NOT_PENDING', 'Key generation requires the sealed pending Phase-4 profile template.');
  const policyWallet = walletFactory('policy');
  const evidenceWallet = walletFactory('evidence');
  invariant(policyWallet?.address && evidenceWallet?.address
      && /^0x[0-9a-fA-F]{64}$/.test(policyWallet.privateKey ?? '')
      && /^0x[0-9a-fA-F]{64}$/.test(evidenceWallet.privateKey ?? '')
      && policyWallet.address.toLowerCase() !== evidenceWallet.address.toLowerCase(),
  'SOD_KEYGEN_WALLET_INVALID', 'Two distinct valid EVM wallets are required.');
  let policyCreated = false;
  let evidenceCreated = false;
  try {
    await writeSecretFile(policyEnvPath, POLICY_AUTHORITY_KEY_NAME, policyWallet.privateKey);
    policyCreated = true;
    await writeSecretFile(evidenceEnvPath, EVIDENCE_PRODUCER_KEY_NAME, evidenceWallet.privateKey);
    evidenceCreated = true;
  } catch (error) {
    if (evidenceCreated) await unlink(evidenceEnvPath);
    if (policyCreated) await unlink(policyEnvPath);
    throw error;
  }
  const [policyMetadata, evidenceMetadata] = await Promise.all([stat(policyEnvPath), stat(evidenceEnvPath)]);
  const activatedProfile = sealAuthorityProfile({
    ...pendingProfile,
    status: 'active',
    authorities: {
      policy_authority_address: policyWallet.address,
      evidence_producer_address: evidenceWallet.address,
    },
  });
  validateAuthorityProfile(activatedProfile, { deployment, requireActive: true });
  return Object.freeze({
    ok: true,
    network_key: 'giwa-testnet',
    chain_id: 91342,
    profile_id: PHASE4_SOD_PROFILE_ID,
    policy_authority_address: policyWallet.address,
    evidence_producer_address: evidenceWallet.address,
    outputs: {
      policy_env_file: policyEnvPath,
      evidence_env_file: evidenceEnvPath,
      policy_env_permissions: (policyMetadata.mode & 0o777).toString(8).padStart(4, '0'),
      evidence_env_permissions: (evidenceMetadata.mode & 0o777).toString(8).padStart(4, '0'),
      one_key_per_file: true,
      private_keys_printed: false,
    },
    profile_patch: activatedProfile,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseKeyGenerationArgs(argv);
  return generateSodAuthorityKeys(options);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'SOD_KEYGEN_FAILED',
      message: error?.message ?? 'Phase-4 authority key generation failed.',
      files_written: false,
      private_keys_printed: false,
    })}\n`);
    process.exitCode = 1;
  }
}
