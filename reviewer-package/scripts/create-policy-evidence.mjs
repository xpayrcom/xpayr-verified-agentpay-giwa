#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet } from 'ethers';
import { normalizeAddress, normalizeBytes32 } from '../src/dojang-client.mjs';
import {
  PHASE4_SOD_PROFILE_ID,
  POLICY_AUTHORITY_KEY_NAME,
  authorityProfileReference,
  loadAuthorityProfile,
  validateAuthorityProfile,
} from '../src/authority-profile.mjs';
import { invariant } from '../src/errors.mjs';
import { loadManifest } from '../src/manifest.mjs';
import {
  POLICY_CHAIN_ID,
  POLICY_NETWORK_KEY,
  buildPolicyEvidence,
  signPolicyEvidence,
  verifyPolicyEvidence,
  writePolicyEvidenceExclusive,
} from '../src/policy-evidence.mjs';
import { deriveJobId } from '../src/policy-engine.mjs';
import { loadConfiguredSecureEnvFile } from '../src/secure-env-file.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(MODULE_ROOT, '..');
const DEPLOYMENT_PATH = path.join(MODULE_ROOT, 'config', 'deployment.json');
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const AUTHORITY_KEY_NAME = 'GIWA_DEPLOYER_PRIVATE_KEY';
const TESTNET_CONFIRMATION = 'GIWA_SEPOLIA_TEST_ETH_ONLY';
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/;
const VALUE_FLAGS = new Set([
  '--confirm-chain-id',
  '--confirm-network',
  '--confirm-testnet-only',
  '--policy-run-id',
  '--record-id',
  '--intent-id',
  '--authority-address',
  '--payer-address',
  '--provider-address',
  '--evaluator-address',
  '--job-id',
  '--job-nonce',
  '--outcome',
  '--deliverable-hash',
  '--job-value-wei',
  '--max-job-value-wei',
  '--expiry-seconds',
  '--authority-profile',
]);

function valueMap(argv) {
  const values = new Map();
  let execute = false;
  for (const arg of argv) {
    if (arg === '--execute') {
      invariant(!execute, 'DUPLICATE_POLICY_ARGUMENT', '--execute may only be supplied once.');
      execute = true;
      continue;
    }
    const separator = arg.indexOf('=');
    invariant(separator > 2, 'INVALID_POLICY_ARGUMENT', 'Policy arguments must use --name=value syntax.');
    const name = arg.slice(0, separator);
    invariant(VALUE_FLAGS.has(name), 'UNKNOWN_POLICY_ARGUMENT', `Unsupported policy argument: ${name}.`);
    invariant(!values.has(name), 'DUPLICATE_POLICY_ARGUMENT', `${name} may only be supplied once.`);
    values.set(name, arg.slice(separator + 1));
  }
  return { values, execute };
}

function positiveDecimal(value, label) {
  invariant(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'INVALID_POLICY_LIMIT', `${label} must be a positive base-10 integer.`);
  return BigInt(value);
}

function positiveInteger(value, label) {
  invariant(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'INVALID_POLICY_LIMIT', `${label} must be a positive integer.`);
  const parsed = Number(value);
  invariant(Number.isSafeInteger(parsed), 'INVALID_POLICY_LIMIT', `${label} is outside the safe integer range.`);
  return parsed;
}

export function parsePolicyArgs(argv) {
  const { values, execute } = valueMap(argv);
  invariant(values.get('--confirm-chain-id') === String(POLICY_CHAIN_ID), 'POLICY_CHAIN_CONFIRMATION_REQUIRED', 'Exact --confirm-chain-id=91342 is required.');
  invariant(values.get('--confirm-network') === POLICY_NETWORK_KEY, 'POLICY_NETWORK_CONFIRMATION_REQUIRED', 'Exact --confirm-network=giwa-testnet is required.');
  invariant(values.get('--confirm-testnet-only') === TESTNET_CONFIRMATION, 'POLICY_TESTNET_CONFIRMATION_REQUIRED', 'Exact GIWA Sepolia test-ETH-only confirmation is required.');
  const runId = values.get('--policy-run-id');
  invariant(SAFE_RUN_ID.test(runId ?? ''), 'INVALID_POLICY_RUN_ID', 'A unique safe policy run ID is required.');
  const recordId = values.get('--record-id');
  const intentId = values.get('--intent-id');
  invariant(typeof recordId === 'string' && typeof intentId === 'string', 'POLICY_IDS_REQUIRED', 'Policy record and intent IDs are required.');
  const authority = normalizeAddress(values.get('--authority-address'), 'policy authority');
  const payer = normalizeAddress(values.get('--payer-address'), 'policy payer');
  const provider = normalizeAddress(values.get('--provider-address'), 'policy provider');
  const evaluator = values.get('--evaluator-address')
    ? normalizeAddress(values.get('--evaluator-address'), 'policy evaluator')
    : ZERO_ADDRESS;
  const authorityProfileId = values.get('--authority-profile') ?? null;
  invariant(authorityProfileId === null || authorityProfileId === PHASE4_SOD_PROFILE_ID,
    'POLICY_AUTHORITY_PROFILE_UNKNOWN', 'Only --authority-profile=phase4_sod_v1 is supported.');
  if (authorityProfileId === null) {
    invariant(authority === payer, 'POLICY_AUTHORITY_PAYER_MISMATCH', 'This testnet policy authority must equal the payer/deployer.');
  } else {
    invariant(authority !== payer && authority !== provider && (evaluator === ZERO_ADDRESS || authority !== evaluator),
      'POLICY_AUTHORITY_ROLE_COLLISION', 'SoD policy authority must be distinct from payer, provider and evaluator.');
  }
  invariant(payer !== provider && (evaluator === ZERO_ADDRESS || (evaluator !== payer && evaluator !== provider)),
    'POLICY_ROLE_COLLISION', 'Policy roles must be distinct.');
  const jobNonce = normalizeBytes32(values.get('--job-nonce'), 'policy job nonce');
  invariant(jobNonce !== ZERO_BYTES32, 'ZERO_POLICY_JOB_NONCE', 'Policy job nonce cannot be zero.');
  const jobId = normalizeBytes32(values.get('--job-id'), 'policy job ID');
  invariant(deriveJobId(payer, jobNonce) === jobId, 'POLICY_JOB_ID_MISMATCH', 'Policy job ID must equal keccak256(abi.encode(payer, jobNonce)).');
  const outcomeArg = values.get('--outcome');
  invariant(outcomeArg === 'release' || outcomeArg === 'refund', 'INVALID_POLICY_OUTCOME', 'Policy outcome must be release or refund.');
  const outcome = outcomeArg === 'release' ? 'RELEASED' : 'REFUNDED';
  const deliverableHash = values.get('--deliverable-hash')
    ? normalizeBytes32(values.get('--deliverable-hash'), 'policy deliverable hash')
    : ZERO_BYTES32;
  invariant(outcome === 'RELEASED' ? deliverableHash !== ZERO_BYTES32 : deliverableHash === ZERO_BYTES32,
    'POLICY_DELIVERABLE_MISMATCH', 'Release requires a non-zero deliverable; refund requires zero.');
  const jobValueWei = positiveDecimal(values.get('--job-value-wei'), 'job value');
  const maxJobValueWei = positiveDecimal(values.get('--max-job-value-wei'), 'max job value');
  invariant(jobValueWei <= maxJobValueWei && maxJobValueWei <= 100_000_000_000_000_000n,
    'POLICY_JOB_VALUE_CAP_EXCEEDED', 'Policy job value exceeds its explicit or hard testnet cap.');
  const expirySeconds = positiveInteger(values.get('--expiry-seconds'), 'expiry seconds');
  invariant(expirySeconds >= 3_600 && expirySeconds <= 604_800,
    'POLICY_EXPIRY_OUT_OF_RANGE', 'Policy expiry must be between one hour and seven days.');
  return Object.freeze({
    execute,
    runId,
    recordId,
    intentId,
    authority,
    payer,
    provider,
    evaluator,
    jobId,
    jobNonce,
    outcome,
    deliverableHash,
    jobValueWei,
    maxJobValueWei,
    expirySeconds,
    authorityProfileId,
  });
}

function outputPathFor(rootDir, runId) {
  return path.join(rootDir, 'evidence', 'policy', `${runId}.policy.json`);
}

export async function runPolicyEvidence({
  options: rawOptions,
  manifest,
  deployment,
  provider,
  signerLoader = null,
  authorityProfile = null,
  rootDir = MODULE_ROOT,
  clock = () => new Date(),
} = {}) {
  const options = rawOptions?.jobValueWei === undefined ? parsePolicyArgs(rawOptions ?? []) : rawOptions;
  const authorityProfileId = options.authorityProfileId ?? null;
  invariant(manifest?.network_key === POLICY_NETWORK_KEY && manifest?.chain_id === POLICY_CHAIN_ID
      && manifest?.environment === 'testnet' && manifest?.capabilities?.mainnet === false,
  'POLICY_MANIFEST_MISMATCH', 'GIWA Sepolia manifest is required.');
  invariant(deployment?.networkKey === POLICY_NETWORK_KEY && Number(deployment?.chainId) === POLICY_CHAIN_ID
      && deployment?.mainnet === false && deployment?.status === 'deployed_testnet',
  'POLICY_DEPLOYMENT_MISMATCH', 'Recorded GIWA Sepolia deployment is required.');
  const escrow = normalizeAddress(deployment.contractAddress, 'policy escrow');
  invariant(normalizeAddress(manifest.contracts.escrow, 'manifest escrow') === escrow,
    'POLICY_ESCROW_MISMATCH', 'Manifest and deployment escrow addresses differ.');
  let configuredAuthority;
  let validatedProfile = null;
  if (authorityProfileId === PHASE4_SOD_PROFILE_ID) {
    validatedProfile = validateAuthorityProfile(authorityProfile?.profile ?? authorityProfile, {
      deployment,
      requireActive: true,
      roles: {
        payer: options.payer,
        provider: options.provider,
        evaluator: options.evaluator,
      },
    });
    configuredAuthority = validatedProfile.policyAuthorityAddress;
    invariant(configuredAuthority === options.authority,
      'POLICY_AUTHORITY_CONFIGURATION_MISMATCH', 'Confirmed policy authority differs from the sealed SoD profile.');
  } else {
    invariant(authorityProfileId === null && authorityProfile === null,
      'POLICY_AUTHORITY_PROFILE_UNEXPECTED', 'Legacy policy flow must not receive an authority profile.');
    configuredAuthority = normalizeAddress(deployment?.authorities?.policyAuthorityAddress, 'configured policy authority');
    invariant(configuredAuthority === options.authority
        && configuredAuthority === normalizeAddress(deployment.deployerAddress, 'deployment authority'),
    'POLICY_AUTHORITY_CONFIGURATION_MISMATCH', 'Confirmed policy authority differs from deployment configuration.');
  }
  const network = await provider.getNetwork();
  invariant(Number(network.chainId) === POLICY_CHAIN_ID, 'POLICY_RPC_CHAIN_MISMATCH', 'Canonical RPC returned the wrong chain ID.');
  invariant(await provider.getCode(escrow) !== '0x', 'POLICY_ESCROW_CODE_MISSING', 'Canonical RPC returned no escrow bytecode.');
  const latestBlock = await provider.getBlock('latest');
  invariant(Number.isSafeInteger(latestBlock?.timestamp) && latestBlock.timestamp > 0,
    'POLICY_CHAIN_TIMESTAMP_REQUIRED', 'Canonical RPC returned no safe latest-block timestamp.');
  const createdAtValue = clock();
  const createdAt = (createdAtValue instanceof Date ? createdAtValue : new Date(createdAtValue)).toISOString();
  const expiresAt = latestBlock.timestamp + options.expirySeconds;
  const unsigned = buildPolicyEvidence({
    createdAt,
    recordId: options.recordId,
    intentId: options.intentId,
    authority: options.authority,
    decision: 'ALLOW',
    validFrom: latestBlock.timestamp,
    validUntil: expiresAt,
    ruleset: {
      max_job_value_wei: options.maxJobValueWei.toString(),
      max_expiry_seconds: options.expirySeconds,
    },
    job: {
      escrow,
      jobId: options.jobId,
      jobNonce: options.jobNonce,
      payer: options.payer,
      provider: options.provider,
      evaluator: options.evaluator,
      valueWei: options.jobValueWei.toString(),
      expiresAt,
      outcome: options.outcome,
      deliverableHash: options.deliverableHash,
    },
    authorityProfile: validatedProfile === null ? null : authorityProfileReference(validatedProfile),
  });
  const report = {
    ok: true,
    mode: options.execute ? 'execute' : 'read-only-preflight',
    network_key: POLICY_NETWORK_KEY,
    chain_id: POLICY_CHAIN_ID,
    escrow_contract: escrow,
    authority_address: options.authority,
    authority_profile: validatedProfile === null ? null : authorityProfileReference(validatedProfile),
    record_id: options.recordId,
    intent_id: options.intentId,
    policy_decision_hash: unsigned.decision_hash,
    artifact_digest: unsigned.integrity.digest,
    job_id: options.jobId,
    job_nonce: options.jobNonce,
    deliverable_hash: options.deliverableHash,
    outcome: options.outcome,
    value_wei: options.jobValueWei.toString(),
    valid_from: latestBlock.timestamp,
    expires_at: expiresAt,
    artifact_path: path.relative(rootDir, outputPathFor(rootDir, options.runId)),
    signature_created: false,
    file_written: false,
  };
  if (!options.execute) return report;
  invariant(typeof signerLoader === 'function', 'POLICY_SIGNER_LOADER_REQUIRED', 'Policy execute mode requires a secure signer loader.');
  const signer = await signerLoader({
    provider,
    expectedAddress: options.authority,
    keyName: validatedProfile === null ? AUTHORITY_KEY_NAME : POLICY_AUTHORITY_KEY_NAME,
  });
  const signed = await signPolicyEvidence(unsigned, signer);
  const verified = verifyPolicyEvidence(signed, {
    currentTimestamp: latestBlock.timestamp,
    expected: {
      authority: options.authority,
      ...(validatedProfile === null ? {} : { authorityProfile: authorityProfileReference(validatedProfile) }),
      escrow,
      chainId: POLICY_CHAIN_ID,
      networkKey: POLICY_NETWORK_KEY,
      requireExecutable: true,
      recordId: options.recordId,
      intentId: options.intentId,
      job: {
        jobId: options.jobId,
        jobNonce: options.jobNonce,
        payer: options.payer,
        provider: options.provider,
        evaluator: options.evaluator,
        valueWei: options.jobValueWei.toString(),
        expiresAt,
        outcome: options.outcome,
        deliverableHash: options.deliverableHash,
      },
    },
  });
  const outputPath = outputPathFor(rootDir, options.runId);
  await writePolicyEvidenceExclusive(outputPath, signed);
  return {
    ...report,
    mode: 'execute',
    policy_decision_hash: verified.policyDecisionHash,
    artifact_digest: verified.artifactDigest,
    typed_data_digest: verified.typedDataDigest,
    producer_address: verified.producerAddress,
    artifact_path: path.relative(rootDir, outputPath),
    signature_created: true,
    signature_verified: true,
    file_written: true,
    permissions: '0600',
  };
}

async function loadPolicySigner({ provider, expectedAddress, keyName = AUTHORITY_KEY_NAME }) {
  invariant(keyName === AUTHORITY_KEY_NAME || keyName === POLICY_AUTHORITY_KEY_NAME,
    'POLICY_SIGNER_KEY_REQUIRED', 'Unsupported policy signer key selection.');
  const loaded = await loadConfiguredSecureEnvFile({
    forbiddenRoot: REPOSITORY_ROOT,
    allowedKeys: [keyName],
    required: true,
    requiredKeys: [keyName],
  });
  const privateKey = process.env[keyName] ?? '';
  invariant(/^0x[0-9a-fA-F]{64}$/.test(privateKey), 'POLICY_SIGNER_KEY_REQUIRED', `${keyName} must contain a testnet-only key.`);
  for (const key of loaded.loadedKeys) delete process.env[key];
  const signer = new Wallet(privateKey, provider);
  invariant(normalizeAddress(signer.address, 'policy signer') === expectedAddress,
    'POLICY_SIGNER_MISMATCH', 'Policy signer does not match the confirmed authority address.');
  return signer;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePolicyArgs(argv);
  const [manifest, deployment] = await Promise.all([loadManifest(), readJson(DEPLOYMENT_PATH)]);
  const authorityProfile = options.authorityProfileId === null
    ? null
    : await loadAuthorityProfile(options.authorityProfileId, {
      moduleRoot: MODULE_ROOT,
      deployment,
      requireActive: true,
      roles: { payer: options.payer, provider: options.provider, evaluator: options.evaluator },
    });
  const provider = new JsonRpcProvider(manifest.rpc.canonical, {
    chainId: POLICY_CHAIN_ID,
    name: POLICY_NETWORK_KEY,
  }, { staticNetwork: true });
  return runPolicyEvidence({ options, manifest, deployment, authorityProfile, provider, signerLoader: loadPolicySigner });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'POLICY_EVIDENCE_FAILED',
      message: error?.message ?? 'Policy evidence creation failed.',
      signature_created: false,
      file_written: false,
    })}\n`);
    process.exitCode = 1;
  }
}
