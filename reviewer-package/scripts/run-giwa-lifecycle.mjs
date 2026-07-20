#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Interface, JsonRpcProvider, Wallet, keccak256 } from 'ethers';
import { canonicalJson, sha256Hex } from '../src/canonical-json.mjs';
import { CanonicalReceiptClient } from '../src/canonical-client.mjs';
import { evaluateCanonicalReceipt } from '../src/confirmation.mjs';
import { verifyD1EvidenceOnchain } from '../src/d1-evidence.mjs';
import { DojangClient, normalizeAddress, normalizeBytes32 } from '../src/dojang-client.mjs';
import { assertEvidenceSafe } from '../src/evidence.mjs';
import {
  PHASE4_SOD_PROFILE_ID,
  authorityProfileReference,
  loadAuthorityProfile,
  validateAuthorityProfile,
} from '../src/authority-profile.mjs';
import { loadManifest, validateManifest } from '../src/manifest.mjs';
import { loadAndVerifyPolicyEvidence } from '../src/policy-evidence.mjs';
import { deriveJobId } from '../src/policy-engine.mjs';
import { compareImmutableAwareRuntime } from '../src/runtime-bytecode.mjs';
import { loadConfiguredSecureEnvFile } from '../src/secure-env-file.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(MODULE_ROOT, '..');
const DEPLOYMENT_PATH = path.join(MODULE_ROOT, 'config', 'deployment.json');
const ARTIFACT_PATH = path.join(MODULE_ROOT, 'artifacts', 'solc', 'XPayrVerifiedAgentEscrow.json');
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const UINT128_MAX = 2n ** 128n - 1n;
const SIGNER_VARIABLE_BY_ROLE = Object.freeze({
  payer: 'GIWA_LIFECYCLE_PAYER_PRIVATE_KEY',
  provider: 'GIWA_LIFECYCLE_PROVIDER_PRIVATE_KEY',
  evaluator: 'GIWA_LIFECYCLE_EVALUATOR_PRIVATE_KEY',
});

export const LIFECYCLE_LIMITS = Object.freeze({
  chainId: 91342,
  networkKey: 'giwa-testnet',
  testnetConfirmation: 'GIWA_SEPOLIA_TEST_ETH_ONLY',
  hardMaxJobValueWei: 100_000_000_000_000_000n,
  hardMaxTotalCostWei: 250_000_000_000_000_000n,
  hardMaxFeePerGasWei: 100_000_000_000n,
  hardMaxGasPerTransaction: 1_000_000n,
  minExpirySeconds: 3_600,
  maxExpirySeconds: 7 * 24 * 60 * 60,
  maxConfirmations: 12,
});

export const ESCROW_LIFECYCLE_INTERFACE = new Interface([
  'error JobNotFound(bytes32 jobId)',
  'function createJob(bytes32 jobId,bytes32 jobNonce,address provider,address evaluator,uint128 expectedAmount,uint64 expiresAt,bytes32 policyDecisionHash)',
  'function fundJob(bytes32 jobId) payable',
  'function submitDeliverable(bytes32 jobId,bytes32 deliverableHash)',
  'function approveJob(bytes32 jobId)',
  'function releaseJob(bytes32 jobId)',
  'function cancelJob(bytes32 jobId)',
  'function claimRefund(bytes32 jobId)',
  'function getJob(bytes32 jobId) view returns ((address payer,address provider,address evaluator,bytes32 jobNonce,uint128 expectedAmount,uint128 amount,uint64 expiresAt,uint64 disputeOpenedAt,uint8 status,bool verificationRequired,bytes32 policyDecisionHash,bytes32 deliverableHash))',
  'function dojangScroll() view returns (address)',
  'function upbitKoreaAttesterId() view returns (bytes32)',
  'function testnetFaucetAttesterId() view returns (bytes32)',
]);

export class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

function requireGate(condition, code, message) {
  if (!condition) throw new LifecycleError(code, message);
}

function decimalBigInt(value, field) {
  requireGate(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'INVALID_NUMERIC_GATE', `${field} must be an explicit positive base-10 integer.`);
  return BigInt(value);
}

function safeInteger(value, field) {
  const numeric = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  requireGate(Number.isSafeInteger(numeric) && numeric >= 0, 'INVALID_INTEGER_GATE', `${field} must be a safe non-negative integer.`);
  return numeric;
}

function asStatus(value) {
  const numeric = Number(value);
  requireGate(Number.isSafeInteger(numeric), 'INVALID_JOB_STATUS', 'Escrow returned an invalid job status.');
  return numeric;
}

const CLI_VALUE_FLAGS = new Set([
  '--confirm-chain-id',
  '--confirm-network',
  '--confirm-testnet-only',
  '--lifecycle-run-id',
  '--outcome',
  '--payer-address',
  '--provider-address',
  '--evaluator-address',
  '--job-id',
  '--job-nonce',
  '--policy-decision-hash',
  '--policy-evidence',
  '--deliverable-hash',
  '--job-value-wei',
  '--max-job-value-wei',
  '--max-total-cost-wei',
  '--max-fee-per-gas-wei',
  '--max-gas-per-transaction',
  '--expiry-seconds',
  '--confirmations',
  '--authority-profile',
]);

export function parseLifecycleArgs(argv) {
  const values = new Map();
  let execute = false;
  let resume = false;
  for (const argument of argv) {
    if (argument === '--execute') {
      requireGate(!execute, 'DUPLICATE_ARGUMENT', '--execute may only be supplied once.');
      execute = true;
      continue;
    }
    if (argument === '--resume') {
      requireGate(!resume, 'DUPLICATE_ARGUMENT', '--resume may only be supplied once.');
      resume = true;
      continue;
    }
    const separator = argument.indexOf('=');
    requireGate(separator > 2, 'INVALID_ARGUMENT', 'Lifecycle arguments must use --name=value syntax.');
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    requireGate(CLI_VALUE_FLAGS.has(name), 'UNKNOWN_ARGUMENT', `Unsupported lifecycle argument: ${name}.`);
    requireGate(!values.has(name), 'DUPLICATE_ARGUMENT', `${name} may only be supplied once.`);
    values.set(name, value);
  }

  return validateLifecycleOptions({
    execute,
    resume,
    confirmChainId: values.get('--confirm-chain-id'),
    confirmNetwork: values.get('--confirm-network'),
    confirmTestnetOnly: values.get('--confirm-testnet-only'),
    runId: values.get('--lifecycle-run-id'),
    outcome: values.get('--outcome'),
    payer: values.get('--payer-address'),
    provider: values.get('--provider-address'),
    evaluator: values.get('--evaluator-address'),
    jobId: values.get('--job-id'),
    jobNonce: values.get('--job-nonce'),
    policyDecisionHash: values.get('--policy-decision-hash'),
    policyEvidencePath: values.get('--policy-evidence'),
    deliverableHash: values.get('--deliverable-hash') ?? null,
    jobValueWei: values.get('--job-value-wei'),
    maxJobValueWei: values.get('--max-job-value-wei'),
    maxTotalCostWei: values.get('--max-total-cost-wei'),
    maxFeePerGasWei: values.get('--max-fee-per-gas-wei'),
    maxGasPerTransaction: values.get('--max-gas-per-transaction'),
    expirySeconds: values.get('--expiry-seconds'),
    confirmations: values.get('--confirmations'),
    authorityProfileId: values.get('--authority-profile') ?? null,
  });
}

export function validateLifecycleOptions(input) {
  requireGate(input && typeof input === 'object', 'INVALID_OPTIONS', 'Lifecycle options are required.');
  requireGate(String(input.confirmChainId) === String(LIFECYCLE_LIMITS.chainId), 'CHAIN_CONFIRMATION_REQUIRED', 'Exact --confirm-chain-id=91342 confirmation is required.');
  requireGate(input.confirmNetwork === LIFECYCLE_LIMITS.networkKey, 'NETWORK_CONFIRMATION_REQUIRED', 'Exact --confirm-network=giwa-testnet confirmation is required.');
  requireGate(input.confirmTestnetOnly === LIFECYCLE_LIMITS.testnetConfirmation, 'TESTNET_CONFIRMATION_REQUIRED', 'Exact GIWA Sepolia test-ETH-only confirmation is required.');
  requireGate(/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(input.runId ?? ''), 'INVALID_RUN_ID', 'A unique safe lifecycle run ID is required.');
  requireGate(['release', 'refund'].includes(input.outcome), 'INVALID_OUTCOME', 'Outcome must be release or refund.');
  requireGate(input.resume !== true || input.execute === true, 'RESUME_EXECUTE_REQUIRED', '--resume requires the explicit --execute gate.');

  const payer = normalizeAddress(input.payer, 'payer address');
  const provider = normalizeAddress(input.provider, 'provider address');
  const evaluator = input.evaluator === undefined || input.evaluator === null || input.evaluator === ''
    ? ZERO_ADDRESS
    : normalizeAddress(input.evaluator, 'evaluator address');
  requireGate(payer !== ZERO_ADDRESS && provider !== ZERO_ADDRESS, 'ZERO_ROLE_ADDRESS', 'Payer and provider addresses cannot be zero.');
  requireGate(payer !== provider, 'ROLE_COLLISION', 'Payer and provider must be distinct addresses.');
  if (evaluator !== ZERO_ADDRESS) {
    requireGate(
      evaluator !== payer && evaluator !== provider,
      'ROLE_COLLISION',
      'A configured evaluator must be distinct from payer and provider.',
    );
  }
  const jobNonce = normalizeBytes32(input.jobNonce, 'job nonce');
  requireGate(jobNonce !== ZERO_BYTES32, 'ZERO_JOB_NONCE', 'Job nonce cannot be zero.');
  const jobId = normalizeBytes32(input.jobId, 'job ID');
  requireGate(deriveJobId(payer, jobNonce) === jobId, 'JOB_ID_DERIVATION_MISMATCH', 'Job ID must equal keccak256(abi.encode(payer, jobNonce)).');
  const hasPolicyHash = typeof input.policyDecisionHash === 'string' && input.policyDecisionHash !== '';
  const hasPolicyEvidence = typeof input.policyEvidencePath === 'string' && input.policyEvidencePath !== '';
  requireGate(hasPolicyHash !== hasPolicyEvidence, 'POLICY_ORIGIN_REQUIRED', 'Supply exactly one of a legacy policy decision hash or a signed policy evidence artifact.');
  const authorityProfileId = input.authorityProfileId ?? null;
  requireGate(authorityProfileId === null || authorityProfileId === PHASE4_SOD_PROFILE_ID,
    'AUTHORITY_PROFILE_UNKNOWN', 'Only --authority-profile=phase4_sod_v1 is supported.');
  requireGate(authorityProfileId === null || hasPolicyEvidence,
    'AUTHORITY_PROFILE_POLICY_REQUIRED', 'phase4_sod_v1 requires a signed policy evidence artifact.');
  const policyDecisionHash = hasPolicyHash
    ? normalizeBytes32(input.policyDecisionHash, 'policy decision hash')
    : null;
  if (policyDecisionHash !== null) {
    requireGate(policyDecisionHash !== ZERO_BYTES32, 'ZERO_POLICY_HASH', 'Policy decision hash cannot be zero.');
  }
  if (hasPolicyEvidence) {
    requireGate(!path.isAbsolute(input.policyEvidencePath)
      && !input.policyEvidencePath.includes('\0')
      && input.policyEvidencePath.split(/[\\/]+/).every((segment) => segment !== '..' && segment !== ''),
    'INVALID_POLICY_EVIDENCE_PATH', 'Policy evidence must be a safe repository-relative path.');
  }
  const deliverableHash = input.deliverableHash === null || input.deliverableHash === undefined
    ? null
    : normalizeBytes32(input.deliverableHash, 'deliverable hash');
  if (input.outcome === 'release') {
    requireGate(deliverableHash !== null && deliverableHash !== ZERO_BYTES32, 'DELIVERABLE_HASH_REQUIRED', 'Release lifecycle requires a non-zero deliverable hash.');
  } else {
    requireGate(deliverableHash === null || deliverableHash === ZERO_BYTES32, 'REFUND_DELIVERABLE_HASH_FORBIDDEN', 'Refund lifecycle must omit the deliverable hash or set it to zero.');
  }

  const jobValueWei = typeof input.jobValueWei === 'bigint' ? input.jobValueWei : decimalBigInt(input.jobValueWei, 'job-value-wei');
  const maxJobValueWei = typeof input.maxJobValueWei === 'bigint' ? input.maxJobValueWei : decimalBigInt(input.maxJobValueWei, 'max-job-value-wei');
  const maxTotalCostWei = typeof input.maxTotalCostWei === 'bigint' ? input.maxTotalCostWei : decimalBigInt(input.maxTotalCostWei, 'max-total-cost-wei');
  const maxFeePerGasWei = typeof input.maxFeePerGasWei === 'bigint' ? input.maxFeePerGasWei : decimalBigInt(input.maxFeePerGasWei, 'max-fee-per-gas-wei');
  const maxGasPerTransaction = typeof input.maxGasPerTransaction === 'bigint'
    ? input.maxGasPerTransaction
    : decimalBigInt(input.maxGasPerTransaction, 'max-gas-per-transaction');
  for (const [field, value] of Object.entries({
    jobValueWei,
    maxJobValueWei,
    maxTotalCostWei,
    maxFeePerGasWei,
    maxGasPerTransaction,
  })) {
    requireGate(value > 0n, 'NON_POSITIVE_VALUE_GATE', `${field} must be positive.`);
  }
  requireGate(jobValueWei <= UINT128_MAX, 'JOB_VALUE_UINT128_OVERFLOW', 'Job value exceeds the escrow uint128 limit.');
  requireGate(maxJobValueWei <= LIFECYCLE_LIMITS.hardMaxJobValueWei, 'JOB_VALUE_CAP_TOO_HIGH', 'Explicit job-value cap exceeds the runner hard ceiling.');
  requireGate(jobValueWei <= maxJobValueWei, 'JOB_VALUE_CAP_EXCEEDED', 'Job value exceeds the explicit cap.');
  requireGate(maxTotalCostWei <= LIFECYCLE_LIMITS.hardMaxTotalCostWei, 'TOTAL_COST_CAP_TOO_HIGH', 'Explicit total-cost cap exceeds the runner hard ceiling.');
  requireGate(maxFeePerGasWei <= LIFECYCLE_LIMITS.hardMaxFeePerGasWei, 'FEE_CAP_TOO_HIGH', 'Explicit fee cap exceeds the runner hard ceiling.');
  requireGate(maxGasPerTransaction <= LIFECYCLE_LIMITS.hardMaxGasPerTransaction, 'GAS_CAP_TOO_HIGH', 'Explicit per-transaction gas cap exceeds the runner hard ceiling.');

  const expirySeconds = safeInteger(input.expirySeconds, 'expiry-seconds');
  requireGate(expirySeconds >= LIFECYCLE_LIMITS.minExpirySeconds && expirySeconds <= LIFECYCLE_LIMITS.maxExpirySeconds, 'EXPIRY_OUT_OF_RANGE', 'Expiry must be between one hour and seven days.');
  const confirmations = safeInteger(input.confirmations, 'confirmations');
  requireGate(confirmations >= 1 && confirmations <= LIFECYCLE_LIMITS.maxConfirmations, 'CONFIRMATIONS_OUT_OF_RANGE', 'Confirmations must be between 1 and 12.');
  const stepCount = input.outcome === 'release' ? 5n : 4n;
  const worstCaseCostWei = jobValueWei + stepCount * maxGasPerTransaction * maxFeePerGasWei;
  requireGate(worstCaseCostWei <= maxTotalCostWei, 'TOTAL_COST_CAP_EXCEEDED', 'Worst-case lifecycle cost exceeds the explicit total cap.');

  return Object.freeze({
    execute: input.execute === true,
    resume: input.resume === true,
    confirmChainId: LIFECYCLE_LIMITS.chainId,
    confirmNetwork: LIFECYCLE_LIMITS.networkKey,
    confirmTestnetOnly: LIFECYCLE_LIMITS.testnetConfirmation,
    runId: input.runId,
    outcome: input.outcome,
    payer,
    provider,
    evaluator,
    jobId,
    jobNonce,
    policyDecisionHash,
    policyEvidencePath: hasPolicyEvidence ? input.policyEvidencePath : null,
    policyOrigin: null,
    policyExpiresAt: null,
    policyValidFrom: null,
    policyValidUntil: null,
    deliverableHash: input.outcome === 'release' ? deliverableHash : ZERO_BYTES32,
    jobValueWei,
    maxJobValueWei,
    maxTotalCostWei,
    maxFeePerGasWei,
    maxGasPerTransaction,
    expirySeconds,
    confirmations,
    worstCaseCostWei,
    authorityProfileId,
  });
}

function roleTransactionCounts(outcome, evaluator) {
  if (outcome === 'release') {
    return evaluator === ZERO_ADDRESS
      ? { payer: 4n, provider: 1n }
      : { payer: 2n, provider: 1n, evaluator: 2n };
  }
  return evaluator === ZERO_ADDRESS
    ? { payer: 4n, provider: 0n }
    : { payer: 4n, provider: 0n, evaluator: 0n };
}

function buildWorkflow(options, expiresAt) {
  const create = {
    name: 'create',
    signerRole: 'payer',
    expectedStatus: 1,
    value: 0n,
    data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('createJob', [
      options.jobId,
      options.jobNonce,
      options.provider,
      options.evaluator,
      options.jobValueWei,
      expiresAt,
      options.policyDecisionHash,
    ]),
  };
  const fund = {
    name: 'fund',
    signerRole: 'payer',
    expectedStatus: 2,
    value: options.jobValueWei,
    data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('fundJob', [options.jobId]),
  };
  if (options.outcome === 'release') {
    const approverRole = options.evaluator === ZERO_ADDRESS ? 'payer' : 'evaluator';
    return [
      create,
      fund,
      {
        name: 'submit',
        signerRole: 'provider',
        expectedStatus: 3,
        value: 0n,
        data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('submitDeliverable', [options.jobId, options.deliverableHash]),
      },
      {
        name: 'approve',
        signerRole: approverRole,
        expectedStatus: 4,
        value: 0n,
        data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('approveJob', [options.jobId]),
      },
      {
        name: 'release',
        signerRole: approverRole,
        expectedStatus: 5,
        value: 0n,
        data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('releaseJob', [options.jobId]),
      },
    ];
  }
  return [
    create,
    fund,
    {
      name: 'cancel',
      signerRole: 'payer',
      expectedStatus: 9,
      value: 0n,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('cancelJob', [options.jobId]),
    },
    {
      name: 'claim_refund',
      signerRole: 'payer',
      expectedStatus: 7,
      value: 0n,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('claimRefund', [options.jobId]),
    },
  ];
}

export async function verifyRecordedDeployment({ provider, manifest, deployment, escrowAddress }) {
  requireGate(
    deployment?.evidence?.runtimeCodePresent === true
      && deployment?.evidence?.runtimeBytecodeVerified === true,
    'DEPLOYMENT_BYTECODE_PROOF_REQUIRED',
    'Lifecycle execution requires a recorded immutable-aware runtime bytecode proof.',
  );
  requireGate(
    /^0x[0-9a-fA-F]{64}$/.test(deployment.deploymentTransactionHash ?? ''),
    'DEPLOYMENT_TRANSACTION_REQUIRED',
    'Deployment transaction hash is missing or invalid.',
  );
  const [artifact, runtimeCode, deploymentReceipt] = await Promise.all([
    readJson(ARTIFACT_PATH),
    provider.getCode(escrowAddress),
    provider.getTransactionReceipt(deployment.deploymentTransactionHash),
  ]);
  requireGate(deploymentReceipt && Number(deploymentReceipt.status) === 1, 'DEPLOYMENT_RECEIPT_REQUIRED', 'Canonical deployment receipt is missing or failed.');
  requireGate(
    normalizeAddress(deploymentReceipt.contractAddress, 'deployment receipt contract') === escrowAddress,
    'DEPLOYMENT_RECEIPT_CONTRACT_MISMATCH',
    'Deployment receipt contract address does not match the deployment record.',
  );
  const deploymentBlock = await provider.getBlock(deploymentReceipt.blockNumber);
  requireGate(
    normalizeBytes32(deploymentBlock?.hash, 'deployment block hash')
      === normalizeBytes32(deploymentReceipt.blockHash, 'deployment receipt block hash'),
    'DEPLOYMENT_BLOCK_NOT_CANONICAL',
    'Deployment receipt block is not canonical.',
  );
  const runtimeComparison = compareImmutableAwareRuntime(
    runtimeCode,
    artifact.deployedBytecode,
    artifact.immutableReferences,
  );
  requireGate(runtimeComparison.matches, 'DEPLOYMENT_RUNTIME_MISMATCH', 'Escrow runtime bytecode does not match the compile artifact.');

  const call = async (functionName) => {
    const data = ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData(functionName);
    const result = await provider.call({ to: escrowAddress, data });
    return ESCROW_LIFECYCLE_INTERFACE.decodeFunctionResult(functionName, result)[0];
  };
  const [boundDojang, boundUpbit, boundFaucet] = await Promise.all([
    call('dojangScroll'),
    call('upbitKoreaAttesterId'),
    call('testnetFaucetAttesterId'),
  ]);
  requireGate(normalizeAddress(boundDojang) === normalizeAddress(manifest.contracts.dojang_scroll), 'DEPLOYMENT_IMMUTABLE_MISMATCH', 'Escrow Dojang immutable does not match the manifest.');
  requireGate(
    normalizeBytes32(boundUpbit) === normalizeBytes32(deployment.constructor.attesterIds.upbitKorea)
      && normalizeBytes32(boundFaucet) === normalizeBytes32(deployment.constructor.attesterIds.testnetFaucet),
    'DEPLOYMENT_IMMUTABLE_MISMATCH',
    'Escrow attester immutables do not match the deployment record.',
  );
  return {
    deployment_transaction_hash: deployment.deploymentTransactionHash.toLowerCase(),
    deployment_block_number: Number(deploymentReceipt.blockNumber),
    deployment_block_hash: normalizeBytes32(deploymentReceipt.blockHash, 'deployment receipt block hash'),
    runtime_bytecode: runtimeComparison,
    source_verification: deployment.sourceVerification ?? 'unknown',
    explorer_verified: deployment.evidence?.explorerVerified === true,
    explorer_source_verification_required_for_lifecycle: false,
    immutable_bindings: {
      dojang_scroll: normalizeAddress(boundDojang),
      upbit_korea_attester_id: normalizeBytes32(boundUpbit),
      testnet_faucet_attester_id: normalizeBytes32(boundFaucet),
    },
  };
}

export async function verifyRecordedD1Evidence({
  manifest,
  deployment,
  expectedRoles,
  provider,
  rootDir = MODULE_ROOT,
}) {
  const recordedPath = deployment?.evidence?.d1Artifact;
  const recordedDigest = deployment?.evidence?.d1Digest;
  const recordedReconstructionDigest = deployment?.evidence?.d1ReconstructionDigest;
  requireGate(typeof recordedPath === 'string' && recordedPath !== '' && !path.isAbsolute(recordedPath), 'D1_ARTIFACT_REFERENCE_REQUIRED', 'Deployment record does not retain a repository-relative D1 artifact.');
  requireGate(/^0x[0-9a-fA-F]{64}$/.test(recordedDigest ?? ''), 'D1_ARTIFACT_REFERENCE_REQUIRED', 'Deployment record does not retain a valid D1 digest.');
  requireGate(
    deployment?.evidence?.d1OnchainReconstructed === true
      && /^0x[0-9a-fA-F]{64}$/.test(recordedReconstructionDigest ?? ''),
    'D1_ONCHAIN_RECONSTRUCTION_REQUIRED',
    'Deployment record does not retain a canonical on-chain D1 reconstruction proof.',
  );
  requireGate(typeof provider?.send === 'function', 'D1_RPC_REQUIRED', 'Canonical provider cannot reconstruct the recorded D1 artifact.');
  const candidate = path.resolve(rootDir, recordedPath);
  const lexical = await lstat(candidate);
  requireGate(lexical.isFile() && !lexical.isSymbolicLink(), 'D1_ARTIFACT_UNSAFE_PATH', 'Recorded D1 artifact must be a regular non-symlink file.');
  const [evidenceRoot, resolved] = await Promise.all([
    realpath(path.join(rootDir, 'evidence', 'd1')),
    realpath(candidate),
  ]);
  const relative = path.relative(evidenceRoot, resolved);
  requireGate(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'D1_ARTIFACT_UNSAFE_PATH', 'Recorded D1 artifact escaped evidence/d1.');
  const evidence = await readJson(resolved);
  const reference = await verifyD1EvidenceOnchain(evidence, {
    manifest,
    roles: expectedRoles,
    transport: (method, params) => provider.send(method, params),
  });
  requireGate(reference.digest === recordedDigest.toLowerCase(), 'D1_ARTIFACT_DIGEST_MISMATCH', 'Recorded D1 digest does not match the validated artifact.');
  requireGate(
    reference.reconstruction_digest === recordedReconstructionDigest.toLowerCase(),
    'D1_RECONSTRUCTION_DIGEST_MISMATCH',
    'Recorded D1 reconstruction digest does not match the canonical artifact.',
  );
  return {
    path: path.relative(rootDir, resolved),
    digest: reference.digest,
    block_number: reference.block_number,
    block_hash: reference.block_hash,
    roles: reference.roles,
    producer_authenticated: reference.producer_authenticated,
    onchain_reconstructed: reference.onchain_reconstructed,
    reconstruction_digest: reference.reconstruction_digest,
  };
}

async function defaultReadJobStatus({ provider, escrowAddress, jobId, blockTag = 'latest' }) {
  const data = ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('getJob', [jobId]);
  const result = blockTag && typeof blockTag === 'object' && blockTag.blockHash
    ? await provider.send('eth_call', [{ to: escrowAddress, data }, {
      blockHash: normalizeBytes32(blockTag.blockHash, 'job state block hash'),
      requireCanonical: true,
    }])
    : await provider.call({ to: escrowAddress, data, blockTag });
  const [job] = ESCROW_LIFECYCLE_INTERFACE.decodeFunctionResult('getJob', result);
  return asStatus(job.status);
}

function exactJobNotFound(error, jobId) {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.cause?.data,
  ];
  const data = candidates.find((candidate) => typeof candidate === 'string' && /^0x[0-9a-fA-F]+$/.test(candidate));
  if (!data) return false;
  try {
    const expected = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [
      normalizeBytes32(jobId, 'expected missing job ID'),
    ]);
    return data.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

async function readCanonicalJobStatusAtReceipt({
  provider,
  escrowAddress,
  jobId,
  step,
  blockNumber,
  blockHash,
  readJobStatus,
}) {
  const blockBefore = await provider.getBlock(blockNumber);
  requireGate(
    Number(blockBefore?.number) === blockNumber
      && normalizeBytes32(blockBefore?.hash, `${step.name} canonical state block hash`) === blockHash,
    'STEP_BLOCK_NOT_CANONICAL',
    `${step.name} receipt block is not canonical before its state read.`,
  );
  const observedStatus = await readJobStatus({
    provider,
    escrowAddress,
    jobId,
    step,
    blockTag: { blockHash, requireCanonical: true },
    canonicalContext: 'receipt',
    blockNumber,
    blockHash,
  });
  const blockAfter = await provider.getBlock(blockNumber);
  requireGate(
    Number(blockAfter?.number) === blockNumber
      && normalizeBytes32(blockAfter?.hash, `${step.name} canonical state block recheck hash`) === blockHash,
    'STEP_BLOCK_CHANGED',
    `${step.name} canonical block changed across its pinned state read.`,
  );
  requireGate(observedStatus === step.expectedStatus, 'UNEXPECTED_JOB_STATUS', `${step.name} produced an unexpected escrow status at its canonical receipt block.`);
  return observedStatus;
}

async function readCanonicalJobStatusAtFreshHead({
  provider,
  escrowAddress,
  jobId,
  step,
  readJobStatus,
  allowExactMissingJob = false,
}) {
  const headBefore = await provider.getBlock('latest');
  const blockNumber = Number(headBefore?.number);
  requireGate(Number.isSafeInteger(blockNumber) && blockNumber > 0,
    'CANONICAL_HEAD_INVALID', 'Fresh canonical state head number is invalid.');
  const blockHash = normalizeBytes32(headBefore?.hash, 'fresh canonical state head hash');
  let observedStatus;
  try {
    observedStatus = await readJobStatus({
      provider,
      escrowAddress,
      jobId,
      step,
      blockTag: { blockHash, requireCanonical: true },
      canonicalContext: 'head',
      blockNumber,
      blockHash,
    });
  } catch (error) {
    if (!allowExactMissingJob || !exactJobNotFound(error, jobId)) throw error;
    observedStatus = 0;
  }
  const headAfter = await provider.getBlock(blockNumber);
  requireGate(Number(headAfter?.number) === blockNumber
      && normalizeBytes32(headAfter?.hash, 'fresh canonical state head recheck hash') === blockHash,
    'CANONICAL_HEAD_CHANGED', 'Fresh canonical head changed across its EIP-1898 state read.');
  return { observedStatus, blockNumber, blockHash };
}

function journalBigInt(value, code, message) {
  try {
    requireGate(
      typeof value === 'bigint'
        || (typeof value === 'string' && /^[0-9]+$/.test(value))
        || (Number.isSafeInteger(value) && value >= 0),
      code,
      message,
    );
    return BigInt(value);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError(code, message);
  }
}

function validateJournaledTransactionFields({ pending, step, expectedSigner, escrowAddress, requirePreparedFields = false }) {
  requireGate(pending.step === step.name && pending.signer_role === step.signerRole,
    'RESUME_PENDING_STEP_MISMATCH', 'Pending journal step does not match the next workflow step.');
  requireGate(normalizeAddress(pending.signer_address, 'pending signer address') === expectedSigner,
    'RESUME_PENDING_SIGNER_MISMATCH', 'Pending signer does not match the workflow role.');
  requireGate(Number.isSafeInteger(pending.nonce) && pending.nonce >= 0,
    'RESUME_PENDING_NONCE_INVALID', 'Pending transaction nonce is invalid.');
  const valueWei = journalBigInt(pending.value_wei,
    'RESUME_PENDING_VALUE_MISMATCH', 'Pending journal value is invalid.');
  const gasLimit = journalBigInt(pending.gas_limit,
    'RESUME_PENDING_GAS_INVALID', 'Pending journal gas limit is invalid.');
  const maxFeePerGas = journalBigInt(pending.max_fee_per_gas_wei,
    'RESUME_PENDING_FEE_INVALID', 'Pending journal max fee is invalid.');
  requireGate(valueWei === step.value,
    'RESUME_PENDING_VALUE_MISMATCH', 'Pending journal value does not match the workflow.');
  requireGate(gasLimit > 0n,
    'RESUME_PENDING_GAS_INVALID', 'Pending journal gas limit is invalid.');
  requireGate(maxFeePerGas > 0n,
    'RESUME_PENDING_FEE_INVALID', 'Pending journal max fee is invalid.');
  if (pending.max_priority_fee_per_gas_wei !== undefined) {
    const maxPriorityFeePerGas = journalBigInt(pending.max_priority_fee_per_gas_wei,
      'RESUME_PENDING_FEE_INVALID', 'Pending journal priority fee is invalid.');
    requireGate(maxPriorityFeePerGas <= maxFeePerGas,
    'RESUME_PENDING_FEE_INVALID', 'Pending journal priority fee is invalid.');
  }
  if (requirePreparedFields) {
    requireGate(pending.transaction_type === 2 && Number(pending.chain_id) === LIFECYCLE_LIMITS.chainId,
      'RESUME_PREPARED_TRANSACTION_FORMAT_MISMATCH', 'Prepared transaction type or chain ID is invalid.');
    requireGate(normalizeAddress(pending.target, 'prepared transaction target') === escrowAddress,
      'RESUME_TRANSACTION_TARGET_MISMATCH', 'Prepared transaction target does not match the escrow.');
    requireGate(typeof pending.calldata === 'string' && pending.calldata.toLowerCase() === step.data.toLowerCase(),
      'RESUME_TRANSACTION_INPUT_MISMATCH', 'Prepared transaction calldata does not match the workflow.');
    requireGate(pending.max_priority_fee_per_gas_wei !== undefined,
      'RESUME_PREPARED_TRANSACTION_FIELDS_REQUIRED', 'Prepared transaction priority fee is missing.');
    const reserved = gasLimit * maxFeePerGas + valueWei;
    const journaledReservation = journalBigInt(pending.max_reserved_cost_wei,
      'RESUME_PREPARED_RESERVATION_MISMATCH', 'Prepared transaction reservation is invalid.');
    requireGate(reserved === journaledReservation,
      'RESUME_PREPARED_RESERVATION_MISMATCH', 'Prepared transaction reservation does not match its exact fields.');
    requireGate(pending.signed_transaction_persisted === false,
      'RESUME_PREPARED_TRANSACTION_FIELDS_REQUIRED', 'Prepared journal must not retain signed transaction bytes.');
  }
}

function validateCanonicalTransactionAgainstJournal({ transaction, transactionHash, pending, step, expectedSigner, escrowAddress }) {
  requireGate(transaction && normalizeBytes32(transaction.hash, 'pending canonical transaction hash') === transactionHash,
    'RESUME_TRANSACTION_HASH_MISMATCH', 'Pending canonical transaction hash does not match the journal.');
  requireGate(Number(transaction.chainId) === LIFECYCLE_LIMITS.chainId,
    'RESUME_TRANSACTION_CHAIN_MISMATCH', 'Pending transaction is from the wrong chain.');
  requireGate(Number(transaction.type) === 2,
    'RESUME_TRANSACTION_TYPE_MISMATCH', 'Pending transaction is not an EIP-1559 type-2 transaction.');
  requireGate(normalizeAddress(transaction.from, 'pending transaction sender') === expectedSigner,
    'RESUME_TRANSACTION_SENDER_MISMATCH', 'Pending canonical sender does not match the workflow.');
  requireGate(normalizeAddress(transaction.to, 'pending transaction target') === escrowAddress,
    'RESUME_TRANSACTION_TARGET_MISMATCH', 'Pending canonical target does not match the escrow.');
  requireGate(Number(transaction.nonce) === pending.nonce,
    'RESUME_TRANSACTION_NONCE_MISMATCH', 'Pending canonical nonce does not match the journal.');
  requireGate(BigInt(transaction.value) === step.value,
    'RESUME_TRANSACTION_VALUE_MISMATCH', 'Pending canonical value does not match the workflow.');
  requireGate(String(transaction.data).toLowerCase() === step.data.toLowerCase(),
    'RESUME_TRANSACTION_INPUT_MISMATCH', 'Pending canonical calldata does not match the workflow.');
  requireGate(BigInt(transaction.gasLimit) === BigInt(pending.gas_limit),
    'RESUME_TRANSACTION_GAS_MISMATCH', 'Pending canonical gas limit does not match the journal.');
  requireGate(BigInt(transaction.maxFeePerGas) === BigInt(pending.max_fee_per_gas_wei),
    'RESUME_TRANSACTION_FEE_MISMATCH', 'Pending canonical max fee does not match the journal.');
  if (pending.max_priority_fee_per_gas_wei !== undefined) {
    requireGate(BigInt(transaction.maxPriorityFeePerGas) === BigInt(pending.max_priority_fee_per_gas_wei),
      'RESUME_TRANSACTION_PRIORITY_FEE_MISMATCH', 'Pending canonical priority fee does not match the journal.');
  }
}

export async function inspectPreparedLifecycleStep({
  provider,
  journal,
  workflow,
  roleAddresses,
  escrowAddress,
  maxGasPerTransaction,
  maxFeePerGasWei,
}) {
  requireGate(journal?.status === 'prepared_before_broadcast' && journal.pending_transaction,
    'RESUME_PREPARED_TRANSACTION_REQUIRED', 'Prepared recovery requires one exact planned transaction.');
  requireGate(Array.isArray(journal.steps) && journal.steps.length < workflow.length,
    'RESUME_STEP_PREFIX_INVALID', 'Prepared recovery journal steps are not a strict workflow prefix.');
  const pending = journal.pending_transaction;
  const step = workflow[journal.steps.length];
  const expectedSigner = roleAddresses[step.signerRole];
  validateJournaledTransactionFields({ pending, step, expectedSigner, escrowAddress, requirePreparedFields: true });
  const plannedHash = normalizeBytes32(pending.planned_transaction_hash, 'prepared planned transaction hash');
  requireGate(pending.transaction_hash === undefined || pending.transaction_hash === null,
    'RESUME_PREPARED_TRANSACTION_FORMAT_MISMATCH', 'Prepared journal unexpectedly claims a completed broadcast.');

  const [receipt, transaction] = await Promise.all([
    provider.getTransactionReceipt(plannedHash),
    provider.getTransaction(plannedHash),
  ]);
  if (receipt && transaction) {
    validateCanonicalTransactionAgainstJournal({
      transaction,
      transactionHash: plannedHash,
      pending,
      step,
      expectedSigner,
      escrowAddress,
    });
    return { mode: 'canonical', step, plannedHash };
  }
  requireGate(!receipt, 'RESUME_CANONICAL_DATA_REQUIRED', 'Prepared transaction receipt exists but its canonical transaction is missing.');
  if (transaction) {
    validateCanonicalTransactionAgainstJournal({
      transaction,
      transactionHash: plannedHash,
      pending,
      step,
      expectedSigner,
      escrowAddress,
    });
    throw new LifecycleError(
      'RESUME_PREPARED_TRANSACTION_PENDING',
      'The exact prepared transaction is already visible without a receipt; refusing duplicate broadcast.',
    );
  }

  requireGate(BigInt(pending.gas_limit) <= maxGasPerTransaction,
    'RESUME_PREPARED_GAS_CAP_EXCEEDED', 'Prepared transaction gas limit exceeds the current explicit per-transaction cap.');
  requireGate(BigInt(pending.max_fee_per_gas_wei) <= maxFeePerGasWei,
    'RESUME_PREPARED_FEE_CAP_EXCEEDED', 'Prepared transaction max fee exceeds the current explicit fee cap.');

  const [latestNonce, pendingNonce] = await Promise.all([
    provider.getTransactionCount(expectedSigner, 'latest'),
    provider.getTransactionCount(expectedSigner, 'pending'),
  ]);
  requireGate(latestNonce === pending.nonce && pendingNonce === pending.nonce,
    latestNonce > pending.nonce || pendingNonce > pending.nonce
      ? 'RESUME_PREPARED_NONCE_CONSUMED'
      : 'RESUME_PREPARED_NONCE_MISMATCH',
    'Prepared transaction nonce is no longer exactly available for same-hash rebroadcast.');
  return { mode: 'rebroadcast', step, plannedHash, pending };
}

export async function reconcilePendingLifecycleStep({
  provider,
  journal,
  workflow,
  roleAddresses,
  escrowAddress,
  jobId,
  requiredConfirmations,
  readJobStatus = defaultReadJobStatus,
}) {
  requireGate(journal?.status === 'broadcast_pending_receipt' && journal.pending_transaction,
    'RESUME_PENDING_TRANSACTION_REQUIRED', 'Resume requires one broadcast-pending transaction in the retained journal.');
  requireGate(Array.isArray(journal.steps) && journal.steps.length < workflow.length,
    'RESUME_STEP_PREFIX_INVALID', 'Resume journal steps are not a strict workflow prefix.');
  const pending = journal.pending_transaction;
  const step = workflow[journal.steps.length];
  const expectedSigner = roleAddresses[step.signerRole];
  validateJournaledTransactionFields({ pending, step, expectedSigner, escrowAddress });
  const plannedHash = normalizeBytes32(pending.planned_transaction_hash, 'planned pending transaction hash');
  const transactionHash = normalizeBytes32(pending.transaction_hash, 'pending transaction hash');
  requireGate(plannedHash === transactionHash, 'RESUME_PENDING_HASH_MISMATCH', 'Pending planned and broadcast transaction hashes differ.');

  const [receipt, transaction] = await Promise.all([
    provider.getTransactionReceipt(transactionHash),
    provider.getTransaction(transactionHash),
  ]);
  requireGate(receipt && transaction, 'RESUME_CANONICAL_DATA_REQUIRED', 'Pending receipt or transaction is missing from canonical RPC.');
  requireGate(Number(receipt.status) === 1, 'RESUME_CANONICAL_RECEIPT_FAILED', 'Pending canonical receipt is reverted or failed.');
  requireGate(normalizeBytes32(receipt.hash ?? receipt.transactionHash, 'pending receipt hash') === transactionHash,
    'RESUME_RECEIPT_HASH_MISMATCH', 'Pending canonical receipt hash does not match the journal.');
  validateCanonicalTransactionAgainstJournal({
    transaction,
    transactionHash,
    pending,
    step,
    expectedSigner,
    escrowAddress,
  });
  const blockNumber = Number(receipt.blockNumber);
  requireGate(Number.isSafeInteger(blockNumber) && blockNumber > 0, 'RESUME_BLOCK_INVALID', 'Pending receipt block number is invalid.');
  const blockHash = normalizeBytes32(receipt.blockHash, 'pending receipt block hash');
  requireGate(Number(transaction.blockNumber) === blockNumber
      && normalizeBytes32(transaction.blockHash, 'pending transaction block hash') === blockHash,
    'RESUME_TRANSACTION_BLOCK_MISMATCH', 'Pending transaction block membership does not match its receipt.');
  const observedStatus = await readCanonicalJobStatusAtReceipt({
    provider,
    escrowAddress,
    jobId,
    step,
    blockNumber,
    blockHash,
    readJobStatus,
  });
  const latestState = await readCanonicalJobStatusAtFreshHead({ provider, escrowAddress, jobId, step, readJobStatus });
  requireGate(latestState.observedStatus === step.expectedStatus, 'RESUME_LATEST_STATUS_MISMATCH', 'Latest canonical job status does not match the reconciled pending step; refusing duplicate execution.');
  const head = Number(await provider.getBlockNumber());
  requireGate(Number.isSafeInteger(head) && head >= blockNumber, 'CANONICAL_HEAD_INVALID', 'Canonical head for pending reconciliation is invalid.');
  const confirmations = head - blockNumber + 1;
  requireGate(confirmations >= requiredConfirmations, 'STEP_CONFIRMATIONS_INSUFFICIENT', 'Pending transaction has insufficient canonical confirmations.');
  const gasUsed = BigInt(receipt.gasUsed ?? 0n);
  const receiptGasPrice = BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return {
    step: step.name,
    signer_role: step.signerRole,
    signer_address: expectedSigner,
    transaction_hash: transactionHash,
    nonce: pending.nonce,
    block_number: blockNumber,
    block_hash: blockHash,
    receipt_status: 1,
    confirmations,
    value_wei: step.value.toString(),
    gas_used: gasUsed.toString(),
    receipt_gas_price_wei: receiptGasPrice.toString(),
    observed_job_status: observedStatus,
    reconciled_from_pending_transaction: true,
    state_read_block_number: blockNumber,
    state_read_block_hash: blockHash,
    state_read_pinned_to_receipt_block: true,
  };
}

export async function verifyLifecycleStepReceipts({
  provider,
  steps,
  workflow,
  escrowAddress,
  requiredConfirmations,
}) {
  requireGate(Array.isArray(steps) && Array.isArray(workflow) && steps.length === workflow.length && steps.length > 0,
    'LIFECYCLE_STEP_SET_MISMATCH', 'Lifecycle journal and workflow steps do not match.');
  const headBefore = Number(await provider.getBlockNumber());
  requireGate(Number.isSafeInteger(headBefore) && headBefore > 0, 'CANONICAL_HEAD_INVALID', 'Canonical head before step verification is invalid.');
  const observed = [];

  for (let index = 0; index < steps.length; index += 1) {
    const retained = steps[index];
    const expectedStep = workflow[index];
    requireGate(retained.step === expectedStep.name, 'LIFECYCLE_STEP_ORDER_MISMATCH', 'Lifecycle journal step order does not match the selected workflow.');
    const [receipt, transaction] = await Promise.all([
      provider.getTransactionReceipt(retained.transaction_hash),
      provider.getTransaction(retained.transaction_hash),
    ]);
    requireGate(receipt && transaction, 'STEP_CANONICAL_DATA_REQUIRED', `${retained.step} receipt or transaction is missing from canonical RPC.`);
    const transactionHash = normalizeBytes32(receipt.hash ?? receipt.transactionHash, `${retained.step} receipt transaction hash`);
    requireGate(transactionHash === retained.transaction_hash, 'STEP_RECEIPT_HASH_MISMATCH', `${retained.step} canonical receipt hash changed.`);
    requireGate(normalizeBytes32(transaction.hash, `${retained.step} transaction hash`) === retained.transaction_hash,
      'STEP_TRANSACTION_HASH_MISMATCH', `${retained.step} canonical transaction hash changed.`);
    const blockNumber = Number(receipt.blockNumber);
    requireGate(Number.isSafeInteger(blockNumber) && blockNumber > 0, 'STEP_BLOCK_INVALID', `${retained.step} receipt block number is invalid.`);
    const blockHash = normalizeBytes32(receipt.blockHash, `${retained.step} receipt block hash`);
    const blockBefore = await provider.getBlock(blockNumber);
    requireGate(
      Number(blockBefore?.number) === blockNumber
        && normalizeBytes32(blockBefore?.hash, `${retained.step} canonical block hash`) === blockHash,
      'STEP_BLOCK_NOT_CANONICAL',
      `${retained.step} receipt block is not canonical.`,
    );
    requireGate(Number(receipt.status) === 1, 'STEP_CANONICAL_RECEIPT_FAILED', `${retained.step} canonical receipt failed.`);
    requireGate(
      Number(transaction.blockNumber) === blockNumber
        && normalizeBytes32(transaction.blockHash, `${retained.step} transaction block hash`) === blockHash,
      'STEP_TRANSACTION_BLOCK_MISMATCH',
      `${retained.step} transaction block membership does not match its receipt.`,
    );
    requireGate(Number(transaction.chainId) === LIFECYCLE_LIMITS.chainId, 'STEP_TRANSACTION_CHAIN_MISMATCH', `${retained.step} transaction is from the wrong chain.`);
    requireGate(normalizeAddress(transaction.from, `${retained.step} transaction sender`) === retained.signer_address,
      'STEP_TRANSACTION_SENDER_MISMATCH', `${retained.step} canonical sender does not match the journal.`);
    requireGate(normalizeAddress(transaction.to, `${retained.step} transaction target`) === escrowAddress,
      'STEP_TRANSACTION_TARGET_MISMATCH', `${retained.step} canonical target does not match the escrow.`);
    requireGate(Number(transaction.nonce) === retained.nonce, 'STEP_TRANSACTION_NONCE_MISMATCH', `${retained.step} canonical nonce does not match the journal.`);
    requireGate(BigInt(transaction.value) === expectedStep.value, 'STEP_TRANSACTION_VALUE_MISMATCH', `${retained.step} canonical value does not match the workflow.`);
    requireGate(String(transaction.data).toLowerCase() === expectedStep.data.toLowerCase(),
      'STEP_TRANSACTION_INPUT_MISMATCH', `${retained.step} canonical calldata does not match the workflow.`);
    observed.push({ retained, receipt, transaction, blockNumber, blockHash });
  }

  const headAfter = Number(await provider.getBlockNumber());
  requireGate(Number.isSafeInteger(headAfter) && headAfter >= headBefore, 'CANONICAL_HEAD_REGRESSED', 'Canonical head regressed during lifecycle step verification.');
  const canonicalSteps = [];
  for (const entry of observed) {
    const blockAfter = await provider.getBlock(entry.blockNumber);
    requireGate(
      Number(blockAfter?.number) === entry.blockNumber
        && normalizeBytes32(blockAfter?.hash, `${entry.retained.step} canonical block recheck hash`) === entry.blockHash,
      'STEP_BLOCK_CHANGED',
      `${entry.retained.step} canonical block changed during evidence finalization.`,
    );
    const confirmations = headAfter - entry.blockNumber + 1;
    requireGate(confirmations >= requiredConfirmations, 'STEP_CONFIRMATIONS_INSUFFICIENT', `${entry.retained.step} has insufficient observed canonical confirmations.`);
    const gasUsed = BigInt(entry.receipt.gasUsed ?? 0n);
    const receiptGasPrice = BigInt(entry.receipt.gasPrice ?? entry.receipt.effectiveGasPrice ?? 0n);
    canonicalSteps.push({
      ...entry.retained,
      block_number: entry.blockNumber,
      block_hash: entry.blockHash,
      receipt_status: Number(entry.receipt.status),
      confirmations,
      confirmations_required: requiredConfirmations,
      confirmation_source: 'canonical_head_minus_receipt_block_plus_one',
      gas_used: gasUsed.toString(),
      receipt_gas_price_wei: receiptGasPrice.toString(),
      actual_gas_cost_wei: (gasUsed * receiptGasPrice).toString(),
      canonical_receipt_refetched: true,
      canonical_transaction_refetched: true,
      canonical_block_refetched_twice: true,
      transaction_input_verified: true,
    });
  }
  return {
    canonical_head_before: headBefore,
    canonical_head_after: headAfter,
    confirmations_required: requiredConfirmations,
    all_steps_canonical: true,
    steps: canonicalSteps,
  };
}

async function defaultVerifyTerminal({ manifest, transactionHash, expected }) {
  const client = new CanonicalReceiptClient({ manifest });
  const proof = await client.fetchTerminalProof({
    transactionHash,
    escrowAddress: expected.contract_address,
    jobId: expected.job_id,
  });
  return evaluateCanonicalReceipt({ manifest, ...proof, expected });
}

function summarizeDojang(verdict) {
  return {
    address: verdict.address,
    verified: verdict.verified === true,
    source: verdict.source,
    accepted_attester_id: verdict.accepted_attester_id,
    chain_id: verdict.chain_id,
    block_number: verdict.block_number,
    block_hash: verdict.block_hash,
  };
}

function validateDojangProof(verdict, address, allowedAttesters) {
  return verdict?.verified === true
    && verdict?.source === 'giwa_dojang_read_only'
    && normalizeAddress(verdict.address) === address
    && allowedAttesters.has(verdict.accepted_attester_id)
    && verdict.chain_id === LIFECYCLE_LIMITS.chainId
    && Number.isSafeInteger(verdict.block_number)
    && verdict.block_number > 0
    && /^0x[0-9a-fA-F]{64}$/.test(verdict.block_hash ?? '');
}

function publicOptions(options) {
  return {
    run_id: options.runId,
    resume: options.resume,
    outcome: options.outcome,
    payer: options.payer,
    provider: options.provider,
    evaluator: options.evaluator,
    job_id: options.jobId,
    job_nonce: options.jobNonce,
    policy_decision_hash: options.policyDecisionHash,
    policy_evidence_path: options.policyEvidencePath,
    policy_origin_mode: options.policyOrigin?.mode ?? 'legacy_cli_hash',
    authority_profile_id: options.authorityProfileId,
    deliverable_hash: options.deliverableHash,
    job_value_wei: options.jobValueWei.toString(),
    max_job_value_wei: options.maxJobValueWei.toString(),
    max_total_cost_wei: options.maxTotalCostWei.toString(),
    max_fee_per_gas_wei: options.maxFeePerGasWei.toString(),
    max_gas_per_transaction: options.maxGasPerTransaction.toString(),
    expiry_seconds: options.expirySeconds,
    confirmations: options.confirmations,
    worst_case_cost_wei: options.worstCaseCostWei.toString(),
  };
}

function policyTerminalOutcome(outcome) {
  return outcome === 'release' ? 'RELEASED' : 'REFUNDED';
}

function legacyPolicyOrigin(options) {
  return Object.freeze({
    mode: 'legacy_cli_hash',
    authentication: 'not_provided_cli_hash_only',
    artifact_path: null,
    artifact_digest: null,
    artifact_sha256: null,
    record_id: null,
    intent_id: null,
    authority_address: null,
    producer_address: null,
    typed_data_digest: null,
    binding_digest: null,
    signature_verified: false,
    policy_decision_hash: options.policyDecisionHash,
    signed_job_expires_at: null,
  });
}

async function resolvePolicyOrigin({
  options,
  deployment,
  escrowAddress,
  provider,
  rootDir,
  verifyPolicyReference,
  authorityProfile,
}) {
  if (options.policyEvidencePath === null) {
    return Object.freeze({
      options: Object.freeze({ ...options, policyOrigin: legacyPolicyOrigin(options) }),
      chainTimestamp: null,
    });
  }

  const sodEnabled = options.authorityProfileId === PHASE4_SOD_PROFILE_ID;
  const authority = sodEnabled
    ? authorityProfile.policyAuthorityAddress
    : normalizeAddress(deployment?.authorities?.policyAuthorityAddress, 'configured policy authority');
  if (sodEnabled) {
    requireGate(authorityProfile?.profileId === PHASE4_SOD_PROFILE_ID,
      'AUTHORITY_PROFILE_REQUIRED', 'A validated phase4_sod_v1 authority profile is required.');
  } else {
    requireGate(
      authority === normalizeAddress(deployment.deployerAddress, 'deployment authority'),
      'POLICY_AUTHORITY_CONFIGURATION_MISMATCH',
      'The signed-policy authority must match the explicitly configured GIWA testnet deployer authority.',
    );
    requireGate(authority === options.payer,
      'POLICY_AUTHORITY_PAYER_MISMATCH',
      'This testnet authority model requires the policy authority to equal the confirmed payer/deployer.');
  }
  const latestBlock = await provider.getBlock('latest');
  requireGate(
    Number.isSafeInteger(latestBlock?.timestamp) && latestBlock.timestamp > 0,
    'CHAIN_TIMESTAMP_REQUIRED',
    'Canonical RPC did not return a safe latest-block timestamp for policy verification.',
  );
  const verified = await verifyPolicyReference({
    filePath: options.policyEvidencePath,
    rootDir,
    currentTimestamp: options.resume ? null : latestBlock.timestamp,
    expected: {
      authority,
      escrow: escrowAddress,
      chainId: LIFECYCLE_LIMITS.chainId,
      networkKey: LIFECYCLE_LIMITS.networkKey,
      requireExecutable: true,
      ...(sodEnabled ? { authorityProfile: authorityProfileReference(authorityProfile) } : {}),
      job: {
        jobId: options.jobId,
        jobNonce: options.jobNonce,
        payer: options.payer,
        provider: options.provider,
        evaluator: options.evaluator,
        valueWei: options.jobValueWei.toString(),
        outcome: policyTerminalOutcome(options.outcome),
        deliverableHash: options.deliverableHash,
      },
    },
  });
  requireGate((verified?.decision ?? verified?.evidence?.decision) === 'ALLOW',
    'POLICY_DECISION_NOT_ALLOW', 'Lifecycle execution requires an authenticated ALLOW decision.');
  const signedJob = verified.job ?? verified.evidence?.job;
  const signedExpiresAt = Number(signedJob?.expiresAt ?? signedJob?.expires_at);
  requireGate(Number.isSafeInteger(signedExpiresAt) && signedExpiresAt > 0,
    'SIGNED_POLICY_EXPIRY_INVALID', 'Signed policy evidence has an invalid job expiry.');
  if (!options.resume) {
    const remainingLifetime = signedExpiresAt - latestBlock.timestamp;
    requireGate(remainingLifetime >= LIFECYCLE_LIMITS.minExpirySeconds,
      'SIGNED_POLICY_EXPIRY_TOO_SOON', 'Signed policy job expiry is too close for a new lifecycle run.');
    requireGate(remainingLifetime <= options.expirySeconds
        && remainingLifetime <= LIFECYCLE_LIMITS.maxExpirySeconds,
      'SIGNED_POLICY_EXPIRY_OUT_OF_RANGE', 'Signed policy job expiry exceeds the confirmed lifecycle window.');
  }
  const policyDecisionHash = normalizeBytes32(verified.policyDecisionHash, 'signed policy decision hash');
  requireGate(policyDecisionHash !== ZERO_BYTES32, 'ZERO_POLICY_HASH', 'Signed policy decision hash cannot be zero.');
  const verifiedAuthority = normalizeAddress(verified.authority, 'verified policy authority');
  const producerAddress = normalizeAddress(verified.producerAddress, 'verified policy producer');
  requireGate(verifiedAuthority === authority && producerAddress === authority,
    'POLICY_AUTHORITY_MISMATCH', 'Signed policy evidence was not produced by the configured testnet authority.');
  const artifactPath = verified.repositoryRelativePath;
  const expectedArtifactPath = options.policyEvidencePath.split(path.sep).join('/');
  requireGate(typeof artifactPath === 'string'
      && !path.isAbsolute(artifactPath)
      && artifactPath === expectedArtifactPath
      && artifactPath.startsWith('evidence/policy/')
      && artifactPath.split('/').every((segment) => segment !== '' && segment !== '..'),
  'POLICY_ARTIFACT_PATH_MISMATCH', 'Verified policy artifact path differs from the confirmed repository-relative path.');
  const artifactDigest = normalizeBytes32(verified.artifactDigest, 'signed policy artifact digest');
  const artifactSha256 = normalizeBytes32(verified.artifactSha256, 'signed policy artifact file SHA-256');
  const typedDataDigest = normalizeBytes32(verified.typedDataDigest, 'signed policy typed-data digest');
  const bindingDigest = normalizeBytes32(verified.bindingDigest, 'signed policy binding digest');
  requireGate(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(verified.recordId ?? '')
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(verified.intentId ?? ''),
  'POLICY_RECORD_REFERENCE_INVALID', 'Verified policy record or intent reference is invalid.');
  const policyValidFrom = Number(verified.validity?.validFrom);
  const policyValidUntil = Number(verified.validity?.validUntil);
  requireGate(Number.isSafeInteger(policyValidFrom) && Number.isSafeInteger(policyValidUntil)
      && policyValidFrom < policyValidUntil
      && signedExpiresAt <= policyValidUntil,
  'SIGNED_POLICY_VALIDITY_INVALID', 'Verified policy validity window is invalid or does not cover the job expiry.');
  const origin = Object.freeze({
    mode: sodEnabled ? 'eip712_phase4_sod_policy_artifact' : 'eip712_signed_policy_artifact',
    authentication: sodEnabled
      ? 'eip712_phase4_sod_policy_authority_verified'
      : 'eip712_configured_testnet_authority_verified',
    artifact_path: artifactPath,
    artifact_digest: artifactDigest,
    artifact_sha256: artifactSha256,
    record_id: verified.recordId,
    intent_id: verified.intentId,
    authority_address: verifiedAuthority,
    producer_address: producerAddress,
    typed_data_digest: typedDataDigest,
    binding_digest: bindingDigest,
    signature_verified: true,
    policy_decision_hash: policyDecisionHash,
    valid_from: policyValidFrom,
    valid_until: policyValidUntil,
    signed_job_expires_at: signedExpiresAt,
    same_wallet_testnet_authority: !sodEnabled,
    separation_of_duties: sodEnabled,
    ...(sodEnabled ? {
      authority_profile_id: authorityProfile.profileId,
      authority_profile_digest: authorityProfile.digest,
      evidence_producer_address: authorityProfile.evidenceProducerAddress,
    } : {}),
  });
  return Object.freeze({
    options: Object.freeze({
      ...options,
      policyDecisionHash,
      policyOrigin: origin,
      policyExpiresAt: signedExpiresAt,
      policyValidFrom,
      policyValidUntil,
    }),
    chainTimestamp: latestBlock.timestamp,
  });
}

async function readPrivateResumeJson(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LifecycleError('RESUME_ARTIFACT_REQUIRED', `${label} is required for explicit resume.`);
    }
    throw error;
  }
  requireGate(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    'RESUME_ARTIFACT_UNSAFE', `${label} must be one regular non-linked file.`);
  requireGate((metadata.mode & 0o777) === 0o600,
    'RESUME_ARTIFACT_UNSAFE', `${label} must retain exact 0600 permissions.`);
  if (typeof process.getuid === 'function') {
    requireGate(metadata.uid === process.getuid(), 'RESUME_ARTIFACT_UNSAFE', `${label} must be owned by the current user.`);
  }
  return readJson(filePath);
}

function policyOriginsMatch(retained, expected) {
  if (retained === undefined || retained === null) return expected?.mode === 'legacy_cli_hash';
  return canonicalJson(retained) === canonicalJson(expected);
}

function validateResumeOwnership({ lock, journal, options, manifest, escrowAddress }) {
  requireGate(lock?.schema === 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1'
      && lock.status === 'active_fail_closed_until_clean_completion'
      && lock.run_id === options.runId
      && lock.network_key === manifest.network_key
      && Number(lock.chain_id) === manifest.chain_id
      && normalizeAddress(lock.escrow_contract, 'resume lock escrow') === escrowAddress
      && normalizeAddress(lock.payer, 'resume lock payer') === options.payer,
    'RESUME_LOCK_OWNERSHIP_MISMATCH', 'Global execution lock is not owned by this exact lifecycle run.');
  requireGate(journal?.schema === 'xpayr.giwa.agentpay.lifecycle-journal.v1'
      && journal.run_id === options.runId
      && journal.network_key === manifest.network_key
      && Number(journal.chain_id) === manifest.chain_id
      && normalizeAddress(journal.escrow_contract, 'resume journal escrow') === escrowAddress
      && journal.outcome === options.outcome
      && normalizeBytes32(journal.job_id, 'resume journal job ID') === options.jobId
      && normalizeBytes32(journal.job_nonce, 'resume journal job nonce') === options.jobNonce
      && normalizeBytes32(journal.policy_decision_hash, 'resume journal policy hash') === options.policyDecisionHash
      && policyOriginsMatch(journal.policy_origin, options.policyOrigin)
      && (options.policyExpiresAt === null || journal.expires_at === options.policyExpiresAt)
      && journal.private_keys_persisted === false
      && journal.transaction_preimage_persisted === false,
    'RESUME_JOURNAL_OWNERSHIP_MISMATCH', 'Recovery journal is not bound to this exact lifecycle run.');
  requireGate(Number.isSafeInteger(journal.expires_at) && journal.expires_at > 0,
    'RESUME_JOURNAL_EXPIRY_INVALID', 'Recovery journal expiry is invalid.');
}

function validateExistingLifecycleEvidence({ evidence, options, manifest, escrowAddress, expiresAt, canonicalSteps, canonicalTerminal }) {
  requireGate(evidence && typeof evidence === 'object', 'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence is invalid.');
  assertEvidenceSafe(evidence);
  const { integrity, ...payload } = evidence;
  requireGate(integrity?.algorithm === 'sha256'
      && integrity.canonicalization === 'xpayr-canonical-json-v1'
      && integrity.digest === sha256Hex(canonicalJson(payload)),
    'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence digest is invalid.');
  requireGate(evidence.schema === 'xpayr.giwa.agentpay.lifecycle-evidence.v1'
      && evidence.run_id === options.runId
      && evidence.network_key === manifest.network_key
      && Number(evidence.chain_id) === manifest.chain_id
      && normalizeAddress(evidence.escrow_contract, 'existing evidence escrow') === escrowAddress
      && evidence.job?.job_id === options.jobId
      && evidence.job?.job_nonce === options.jobNonce
      && normalizeAddress(evidence.job?.payer, 'existing evidence payer') === options.payer
      && normalizeAddress(evidence.job?.provider, 'existing evidence provider') === options.provider
      && normalizeAddress(evidence.job?.evaluator, 'existing evidence evaluator') === options.evaluator
      && evidence.job?.value_wei === options.jobValueWei.toString()
      && evidence.job?.expires_at === expiresAt
      && evidence.job?.policy_decision_hash === options.policyDecisionHash
      && evidence.job?.deliverable_hash === options.deliverableHash,
    'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence is not bound to this run.');
  requireGate(policyOriginsMatch(evidence.policy_origin, options.policyOrigin),
    'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence policy origin differs from this run.');
  requireGate(Array.isArray(evidence.steps) && evidence.steps.length === canonicalSteps.length,
    'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence step set differs from canonical recovery.');
  for (let index = 0; index < canonicalSteps.length; index += 1) {
    const retained = evidence.steps[index];
    const canonical = canonicalSteps[index];
    requireGate(retained.step === canonical.step
        && retained.transaction_hash === canonical.transaction_hash
        && retained.nonce === canonical.nonce
        && retained.block_number === canonical.block_number
        && retained.block_hash === canonical.block_hash
        && retained.receipt_status === 1,
      'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence contains a non-canonical step.');
  }
  requireGate(evidence.outcome === canonicalTerminal.outcome
      && evidence.payment_completed === (canonicalTerminal.completed === true)
      && evidence.refunded === (canonicalTerminal.refunded === true)
      && evidence.canonical_terminal?.transaction_hash === canonicalTerminal.transaction_hash
      && evidence.canonical_terminal?.canonical_terminal_verified === true,
    'LIFECYCLE_EVIDENCE_MISMATCH', 'Existing lifecycle evidence terminal proof differs from canonical recovery.');
  return evidence;
}

export async function runLifecycle({
  options: rawOptions,
  manifest: rawManifest,
  deployment,
  provider,
  dojangClient,
  signers = null,
  signerLoader = null,
  authorityProfile = null,
  rootDir = MODULE_ROOT,
  clock = () => new Date(),
  verifyDeployment = verifyRecordedDeployment,
  verifyD1Reference = verifyRecordedD1Evidence,
  verifyPolicyReference = loadAndVerifyPolicyEvidence,
  readJobStatus = defaultReadJobStatus,
  verifySteps = verifyLifecycleStepReceipts,
  verifyTerminal = defaultVerifyTerminal,
} = {}) {
  let options = validateLifecycleOptions(rawOptions);
  const manifest = validateManifest(rawManifest);
  requireGate(deployment?.networkKey === LIFECYCLE_LIMITS.networkKey && deployment?.chainId === LIFECYCLE_LIMITS.chainId, 'DEPLOYMENT_NETWORK_MISMATCH', 'Deployment record is not GIWA Sepolia.');
  requireGate(deployment?.mainnet === false && deployment?.status === 'deployed_testnet', 'ESCROW_NOT_DEPLOYED', 'Lifecycle execution requires a recorded GIWA Sepolia escrow deployment.');
  const escrowAddress = normalizeAddress(deployment.contractAddress, 'deployed escrow address');
  requireGate(normalizeAddress(manifest.contracts.escrow, 'manifest escrow address') === escrowAddress, 'ESCROW_MANIFEST_MISMATCH', 'Manifest escrow address does not match the deployment record.');
  const network = await provider.getNetwork();
  requireGate(Number(network.chainId) === LIFECYCLE_LIMITS.chainId, 'RPC_CHAIN_MISMATCH', 'Canonical RPC returned a non-GIWA chain ID.');
  requireGate(await provider.getCode(escrowAddress) !== '0x', 'ESCROW_CODE_MISSING', 'Canonical RPC returned no escrow bytecode.');
  let validatedAuthorityProfile = null;
  if (options.authorityProfileId === PHASE4_SOD_PROFILE_ID) {
    validatedAuthorityProfile = validateAuthorityProfile(authorityProfile?.profile ?? authorityProfile, {
      deployment,
      requireActive: true,
      roles: { payer: options.payer, provider: options.provider, evaluator: options.evaluator },
    });
  } else {
    requireGate(authorityProfile === null,
      'AUTHORITY_PROFILE_UNEXPECTED', 'Legacy lifecycle flow must not receive an authority profile.');
  }
  const policyResolution = await resolvePolicyOrigin({
    options,
    deployment,
    escrowAddress,
    provider,
    rootDir,
    verifyPolicyReference,
    authorityProfile: validatedAuthorityProfile,
  });
  options = policyResolution.options;
  const deploymentVerification = await verifyDeployment({ provider, manifest, deployment, escrowAddress });
  const d1Reference = await verifyD1Reference({
    manifest,
    deployment,
    expectedRoles: { payer: options.payer, provider: options.provider },
    provider,
    rootDir,
  });

  const allowedAttesters = new Set(manifest.dojang.attester_allowlist.map((entry) => entry.id));
  const roleAddresses = {
    payer: options.payer,
    provider: options.provider,
    ...(options.evaluator === ZERO_ADDRESS ? {} : { evaluator: options.evaluator }),
  };
  const dojangEntries = await Promise.all(Object.entries(roleAddresses).map(async ([role, address]) => {
    const verdict = await dojangClient.checkAddress(address);
    requireGate(validateDojangProof(verdict, address, allowedAttesters), 'DOJANG_ROLE_NOT_VERIFIED', `${role} does not have a retained positive Dojang verification at a canonical block hash.`);
    return [role, summarizeDojang(verdict)];
  }));
  const dojang = Object.fromEntries(dojangEntries);

  let maxFeePerGas = null;
  let maxPriorityFeePerGas = null;
  const counts = roleTransactionCounts(options.outcome, options.evaluator);
  let requiredBalances = {};
  if (!options.resume) {
    const feeData = await provider.getFeeData();
    requireGate(feeData.maxFeePerGas !== null && feeData.maxFeePerGas !== undefined, 'EIP1559_FEE_REQUIRED', 'Canonical RPC did not return an EIP-1559 max fee.');
    maxFeePerGas = BigInt(feeData.maxFeePerGas);
    maxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas ?? 0n);
    requireGate(maxFeePerGas <= options.maxFeePerGasWei, 'NETWORK_FEE_CAP_EXCEEDED', 'Current max fee per gas exceeds the explicit cap.');
    requireGate(maxPriorityFeePerGas <= maxFeePerGas, 'INVALID_NETWORK_FEE', 'Priority fee exceeds max fee per gas.');
    requiredBalances = Object.fromEntries(Object.entries(counts).map(([role, count]) => [
      role,
      count * options.maxGasPerTransaction * maxFeePerGas + (role === 'payer' ? options.jobValueWei : 0n),
    ]));
    const balances = Object.fromEntries(await Promise.all(Object.entries(roleAddresses).map(async ([role, address]) => [
      role,
      BigInt(await provider.getBalance(address)),
    ])));
    for (const role of Object.keys(roleAddresses)) {
      requireGate(balances[role] >= requiredBalances[role], 'INSUFFICIENT_TEST_ETH', `${role} has insufficient test ETH for its capped lifecycle steps.`);
    }
  }
  const activeSignerAddresses = Object.fromEntries(
    Object.entries(roleAddresses).filter(([role]) => counts[role] > 0n),
  );

  const preflight = {
    ok: true,
    mode: options.execute ? 'execute' : 'read-only-preflight',
    network_key: manifest.network_key,
    chain_id: Number(network.chainId),
    escrow_contract: escrowAddress,
    transaction_broadcast: false,
    roles_distinct: true,
    active_signer_roles: Object.keys(activeSignerAddresses),
    deployment_verification: deploymentVerification,
    policy_origin: options.policyOrigin,
    d1_reference: d1Reference,
    dojang,
    fee: options.resume ? {
      gate_mode: 'deferred_until_exact_resume_suffix_is_known',
      max_fee_per_gas_wei: null,
      max_priority_fee_per_gas_wei: null,
      explicit_fee_cap_wei: options.maxFeePerGasWei.toString(),
    } : {
      gate_mode: 'full_confirmed_workflow',
      max_fee_per_gas_wei: maxFeePerGas.toString(),
      max_priority_fee_per_gas_wei: maxPriorityFeePerGas.toString(),
      explicit_fee_cap_wei: options.maxFeePerGasWei.toString(),
    },
    required_balance_wei: Object.fromEntries(Object.entries(requiredBalances).map(([role, value]) => [role, value.toString()])),
    options: publicOptions(options),
  };
  if (!options.execute) return preflight;

  const journalDir = path.join(rootDir, 'evidence', 'lifecycle');
  const journalPath = path.join(journalDir, `${options.runId}.journal.json`);
  const evidencePath = path.join(journalDir, `${options.runId}.evidence.json`);
  const executionLockPath = path.join(journalDir, 'active-execution.lock.json');
  const resumeLeasePath = path.join(journalDir, `${options.runId}.resume.lease.json`);
  const existingEvidence = await readJsonIfExists(evidencePath);
  requireGate(options.resume || existingEvidence === null, 'LIFECYCLE_EVIDENCE_EXISTS', 'Lifecycle evidence already exists; refusing to overwrite it.');
  let journal;
  let workflow;
  let expiresAt;
  let executionSigners;
  let resumeLeaseAcquired = false;
  let preparedRecovery = null;
  if (options.resume) {
    const [lock, retainedJournal] = await Promise.all([
      readPrivateResumeJson(executionLockPath, 'Global lifecycle lock'),
      readPrivateResumeJson(journalPath, 'Lifecycle recovery journal'),
    ]);
    validateResumeOwnership({ lock, journal: retainedJournal, options, manifest, escrowAddress });
    await writeSafeExclusive(resumeLeasePath, {
      schema: 'xpayr.giwa.agentpay.lifecycle-resume-lease.v1',
      status: 'exclusive_resume_in_progress_fail_closed_on_crash',
      run_id: options.runId,
      network_key: manifest.network_key,
      chain_id: manifest.chain_id,
      escrow_contract: escrowAddress,
      payer: options.payer,
      created_at: timestamp(clock),
      recovery_instruction: 'If this lease remains, inspect the journal, lock, canonical state, and signer nonces before operator-authorized removal.',
    }, 0o600, {
      existsCode: 'RESUME_LEASE_EXISTS',
      existsMessage: 'An exclusive resume lease already exists; refusing concurrent or blind resume.',
    });
    resumeLeaseAcquired = true;
    expiresAt = retainedJournal.expires_at;
    workflow = buildWorkflow(options, expiresAt);
    const retainedPrefix = retainedJournal.steps.length === 0
      ? { steps: [] }
      : await verifySteps({
        provider,
        steps: retainedJournal.steps,
        workflow: workflow.slice(0, retainedJournal.steps.length),
        escrowAddress,
        requiredConfirmations: options.confirmations,
      });
    let journalToReconcile = retainedJournal.status === 'broadcast_pending_receipt'
      ? retainedJournal
      : null;
    let reconciledFromPrepared = false;
    if (retainedJournal.status === 'prepared_before_broadcast') {
      let inspection;
      try {
        inspection = await inspectPreparedLifecycleStep({
          provider,
          journal: retainedJournal,
          workflow,
          roleAddresses,
          escrowAddress,
          maxGasPerTransaction: options.maxGasPerTransaction,
          maxFeePerGasWei: options.maxFeePerGasWei,
        });
      } catch (error) {
        if (error?.code !== 'RESUME_PREPARED_TRANSACTION_PENDING') throw error;
        const ownedLease = await readPrivateResumeJson(resumeLeasePath, 'Lifecycle resume lease');
        requireGate(ownedLease.schema === 'xpayr.giwa.agentpay.lifecycle-resume-lease.v1'
            && ownedLease.status === 'exclusive_resume_in_progress_fail_closed_on_crash'
            && ownedLease.run_id === options.runId
            && ownedLease.network_key === manifest.network_key
            && Number(ownedLease.chain_id) === manifest.chain_id
            && normalizeAddress(ownedLease.escrow_contract, 'pending-hold resume lease escrow') === escrowAddress
            && normalizeAddress(ownedLease.payer, 'pending-hold resume lease payer') === options.payer,
        'RESUME_LEASE_OWNERSHIP_MISMATCH', 'Resume lease ownership changed before pending-transaction hold cleanup.');
        await unlink(resumeLeasePath);
        resumeLeaseAcquired = false;
        throw error;
      }
      if (inspection.mode === 'canonical') {
        journalToReconcile = {
          ...retainedJournal,
          status: 'broadcast_pending_receipt',
          pending_transaction: {
            ...retainedJournal.pending_transaction,
            transaction_hash: inspection.plannedHash,
          },
        };
        reconciledFromPrepared = true;
      } else {
        preparedRecovery = inspection;
        journal = { ...retainedJournal, steps: retainedPrefix.steps };
      }
    }
    if (journalToReconcile !== null) {
      const reconciledStep = await reconcilePendingLifecycleStep({
        provider,
        journal: journalToReconcile,
        workflow,
        roleAddresses,
        escrowAddress,
        jobId: options.jobId,
        requiredConfirmations: options.confirmations,
        readJobStatus,
      });
      const reconciledPrefix = await verifySteps({
        provider,
        steps: [...retainedPrefix.steps, reconciledStep],
        workflow: workflow.slice(0, retainedPrefix.steps.length + 1),
        escrowAddress,
        requiredConfirmations: options.confirmations,
      });
      journal = {
        ...retainedJournal,
        status: 'resume_pending_step_canonically_reconciled',
        pending_transaction: null,
        steps: reconciledPrefix.steps,
        recovery: {
          explicit_resume: true,
          reconciled_step: reconciledStep.step,
          reconciled_transaction_hash: reconciledStep.transaction_hash,
          reconciled_from_prepared_planned_hash: reconciledFromPrepared,
          canonical_prefix_reverified: true,
          reconciled_at: timestamp(clock),
        },
        updated_at: timestamp(clock),
      };
      await writeSafeAtomic(journalPath, journal, 0o600);
    } else if (preparedRecovery === null) {
      const cleanResumeStatuses = new Set([
        'ready_before_first_broadcast',
        'resume_pending_step_canonically_reconciled',
        'step_confirmed',
        'all_steps_canonically_reverified',
        'completed',
      ]);
      requireGate(cleanResumeStatuses.has(retainedJournal.status) && retainedJournal.pending_transaction === null,
        'RESUME_PENDING_TRANSACTION_REQUIRED', 'Resume journal is neither broadcast-pending nor a canonical clean prefix.');
      if (['all_steps_canonically_reverified', 'completed'].includes(retainedJournal.status)) {
        requireGate(retainedJournal.steps.length === workflow.length,
          'RESUME_STEP_PREFIX_INVALID', 'Finalization resume requires the complete canonical workflow.');
      }
      journal = { ...retainedJournal, steps: retainedPrefix.steps };
    }
  } else {
    requireGate(await readJsonIfExists(journalPath) === null, 'RECOVERY_JOURNAL_EXISTS', 'A lifecycle recovery journal already exists; inspect every recorded transaction before any retry.');
    const latestBlock = await provider.getBlock('latest');
    requireGate(Number.isSafeInteger(latestBlock?.timestamp) && latestBlock.timestamp > 0, 'CHAIN_TIMESTAMP_REQUIRED', 'Canonical RPC did not return a safe latest-block timestamp.');
    expiresAt = options.policyExpiresAt ?? latestBlock.timestamp + options.expirySeconds;
    if (options.policyExpiresAt !== null) {
      requireGate(latestBlock.timestamp >= policyResolution.chainTimestamp
          && latestBlock.timestamp >= options.policyValidFrom
          && latestBlock.timestamp < options.policyValidUntil,
      'SIGNED_POLICY_NOT_CURRENTLY_VALID', 'Signed policy validity changed before execution began.');
      requireGate(expiresAt - latestBlock.timestamp >= LIFECYCLE_LIMITS.minExpirySeconds,
        'SIGNED_POLICY_EXPIRY_TOO_SOON', 'Signed policy job expiry became too close before execution began.');
      requireGate(expiresAt - latestBlock.timestamp <= options.expirySeconds,
        'SIGNED_POLICY_EXPIRY_OUT_OF_RANGE', 'Signed policy job expiry exceeds the confirmed lifecycle window.');
    }
    workflow = buildWorkflow(options, expiresAt);
    await mkdir(journalDir, { recursive: true });
    await writeSafeExclusive(executionLockPath, {
      schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
      status: 'active_fail_closed_until_clean_completion',
      run_id: options.runId,
      network_key: manifest.network_key,
      chain_id: manifest.chain_id,
      escrow_contract: escrowAddress,
      payer: options.payer,
      created_at: timestamp(clock),
      recovery_instruction: 'If this lock remains, inspect all lifecycle journals and canonical pending nonces before manual removal.',
    }, 0o600, {
      existsCode: 'GLOBAL_EXECUTION_LOCK_EXISTS',
      existsMessage: 'Another lifecycle execution lock exists; inspect all journals and canonical pending nonces before any new run.',
    });
    journal = {
      schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
      status: 'ready_before_first_broadcast',
      run_id: options.runId,
      network_key: manifest.network_key,
      chain_id: manifest.chain_id,
      escrow_contract: escrowAddress,
      outcome: options.outcome,
      job_id: options.jobId,
      job_nonce: options.jobNonce,
      expires_at: expiresAt,
      policy_decision_hash: options.policyDecisionHash,
      policy_origin: options.policyOrigin,
      transaction_preimage_persisted: false,
      private_keys_persisted: false,
      pending_transaction: null,
      steps: [],
      created_at: timestamp(clock),
    };
    try {
      await writeSafeExclusive(journalPath, journal, 0o600);
    } catch (error) {
      const ownedLock = await readPrivateResumeJson(executionLockPath, 'Global lifecycle lock');
      requireGate(ownedLock.schema === 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1'
          && ownedLock.status === 'active_fail_closed_until_clean_completion'
          && ownedLock.run_id === options.runId
          && ownedLock.network_key === manifest.network_key
          && Number(ownedLock.chain_id) === manifest.chain_id
          && normalizeAddress(ownedLock.escrow_contract, 'pre-broadcast cleanup lock escrow') === escrowAddress
          && normalizeAddress(ownedLock.payer, 'pre-broadcast cleanup lock payer') === options.payer,
      'RESUME_LOCK_OWNERSHIP_MISMATCH', 'Global execution lock ownership changed during pre-broadcast journal creation.');
      await unlink(executionLockPath);
      throw error;
    }
    executionSigners = signers ?? await signerLoader?.({ provider, expectedAddresses: activeSignerAddresses });
  }

  const remainingWorkflow = workflow.slice(journal.steps.length);
  const remainingSignerAddresses = Object.fromEntries([...new Set(remainingWorkflow.map((step) => step.signerRole))]
    .map((role) => [role, roleAddresses[role]]));
  preflight.active_signer_roles = Object.keys(remainingSignerAddresses);
  preflight.resume = options.resume;
  if (options.resume) {
    const freshWorkflow = preparedRecovery?.mode === 'rebroadcast'
      ? remainingWorkflow.slice(1)
      : remainingWorkflow;
    if (freshWorkflow.length > 0) {
      const feeData = await provider.getFeeData();
      requireGate(feeData.maxFeePerGas !== null && feeData.maxFeePerGas !== undefined,
        'EIP1559_FEE_REQUIRED', 'Canonical RPC did not return an EIP-1559 max fee for the remaining resume suffix.');
      maxFeePerGas = BigInt(feeData.maxFeePerGas);
      maxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas ?? 0n);
      requireGate(maxFeePerGas <= options.maxFeePerGasWei,
        'NETWORK_FEE_CAP_EXCEEDED', 'Current max fee per gas exceeds the explicit cap for the remaining resume suffix.');
      requireGate(maxPriorityFeePerGas <= maxFeePerGas,
        'INVALID_NETWORK_FEE', 'Priority fee exceeds max fee per gas for the remaining resume suffix.');
    }
    requiredBalances = {};
    for (const step of freshWorkflow) {
      requiredBalances[step.signerRole] = (requiredBalances[step.signerRole] ?? 0n)
        + options.maxGasPerTransaction * maxFeePerGas
        + step.value;
    }
    if (preparedRecovery?.mode === 'rebroadcast') {
      const role = preparedRecovery.step.signerRole;
      requiredBalances[role] = (requiredBalances[role] ?? 0n)
        + BigInt(preparedRecovery.pending.max_reserved_cost_wei);
    }
    const resumeBalanceEntries = await Promise.all(Object.entries(requiredBalances).map(async ([role, value]) => {
      const balance = BigInt(await provider.getBalance(roleAddresses[role]));
      requireGate(balance >= value, 'INSUFFICIENT_TEST_ETH', `${role} has insufficient test ETH for the exact remaining resume suffix.`);
      return [role, value.toString()];
    }));
    preflight.required_balance_wei = Object.fromEntries(resumeBalanceEntries);
    preflight.fee = freshWorkflow.length > 0 ? {
      gate_mode: 'remaining_resume_suffix_only',
      max_fee_per_gas_wei: maxFeePerGas.toString(),
      max_priority_fee_per_gas_wei: maxPriorityFeePerGas.toString(),
      explicit_fee_cap_wei: options.maxFeePerGasWei.toString(),
      prepared_same_hash_rebroadcast_uses_persisted_fee: preparedRecovery?.mode === 'rebroadcast',
    } : {
      gate_mode: preparedRecovery?.mode === 'rebroadcast'
        ? 'persisted_prepared_transaction_only'
        : 'not_required_canonical_finalization_only',
      max_fee_per_gas_wei: null,
      max_priority_fee_per_gas_wei: null,
      explicit_fee_cap_wei: options.maxFeePerGasWei.toString(),
      prepared_same_hash_rebroadcast_uses_persisted_fee: preparedRecovery?.mode === 'rebroadcast',
    };
  }
  if (options.resume) {
    executionSigners = remainingWorkflow.length === 0
      ? {}
      : signers ?? await signerLoader?.({ provider, expectedAddresses: remainingSignerAddresses });
  }
  requireGate(executionSigners && typeof executionSigners === 'object', 'SIGNERS_REQUIRED', 'The remaining lifecycle roles require separately controlled testnet signers.');
  for (const [role, address] of Object.entries(remainingSignerAddresses)) {
    requireGate(normalizeAddress(executionSigners[role]?.address, `${role} signer address`) === address, 'SIGNER_ADDRESS_MISMATCH', `${role} signer does not match the confirmed public address.`);
    requireGate(typeof executionSigners[role]?.signTransaction === 'function', 'SIGNERS_REQUIRED', `${role} signer cannot sign transactions.`);
  }

  let reservedCostWei = journal.steps.reduce((total, retained) => (
    total + BigInt(retained.value_wei) + BigInt(retained.gas_used) * BigInt(retained.receipt_gas_price_wei)
  ), 0n);
  let transactionBroadcastCount = 0;
  for (const step of remainingWorkflow) {
    const signer = executionSigners[step.signerRole];
    const recoveringPrepared = preparedRecovery?.mode === 'rebroadcast'
      && preparedRecovery.step.name === step.name
      && journal.steps.length === workflow.indexOf(step);
    let nonce;
    if (options.resume) {
      const workflowIndex = workflow.indexOf(step);
      const expectedPreviousStatus = workflow[workflowIndex - 1]?.expectedStatus ?? 0;
      const latestState = await readCanonicalJobStatusAtFreshHead({
        provider,
        escrowAddress,
        jobId: options.jobId,
        step: { ...step, expectedStatus: expectedPreviousStatus },
        readJobStatus,
        allowExactMissingJob: workflowIndex === 0
          && step.name === 'create'
          && journal.steps.length === 0
          && expectedPreviousStatus === 0
          && (recoveringPrepared || (
            journal.status === 'ready_before_first_broadcast'
            && journal.pending_transaction === null
          )),
      });
      requireGate(latestState.observedStatus === expectedPreviousStatus, 'RESUME_LATEST_STATUS_MISMATCH', 'Latest job status changed before the remaining transaction; refusing duplicate execution.');
      const [latestNonce, pendingNonce] = await Promise.all([
        provider.getTransactionCount(signer.address, 'latest'),
        provider.getTransactionCount(signer.address, 'pending'),
      ]);
      requireGate(latestNonce === pendingNonce, 'RESUME_NONCE_DIVERGENCE', 'Latest and pending signer nonces differ; refusing resume broadcast.');
      const retainedRoleStep = [...journal.steps].reverse().find((entry) => entry.signer_role === step.signerRole);
      requireGate(!retainedRoleStep || pendingNonce === retainedRoleStep.nonce + 1,
        'RESUME_NONCE_NOT_CONTIGUOUS', 'Remaining transaction nonce is not exactly one after the reconciled signer nonce.');
      nonce = pendingNonce;
    } else {
      nonce = await provider.getTransactionCount(signer.address, 'pending');
    }
    let gasLimit;
    let stepMaxFeePerGas;
    let stepMaxPriorityFeePerGas;
    let stepReservedCost;
    if (recoveringPrepared) {
      const pending = preparedRecovery.pending;
      requireGate(nonce === pending.nonce, 'RESUME_PREPARED_NONCE_MISMATCH', 'Prepared nonce changed before exact same-hash rebroadcast.');
      gasLimit = BigInt(pending.gas_limit);
      stepMaxFeePerGas = BigInt(pending.max_fee_per_gas_wei);
      stepMaxPriorityFeePerGas = BigInt(pending.max_priority_fee_per_gas_wei);
      stepReservedCost = BigInt(pending.max_reserved_cost_wei);
      requireGate(gasLimit <= options.maxGasPerTransaction,
        'RESUME_PREPARED_GAS_CAP_EXCEEDED', 'Prepared transaction gas limit exceeds the current explicit per-transaction cap.');
      requireGate(stepMaxFeePerGas <= options.maxFeePerGasWei,
        'RESUME_PREPARED_FEE_CAP_EXCEEDED', 'Prepared transaction max fee exceeds the current explicit fee cap.');
    } else {
      const estimatedGas = await provider.estimateGas({ from: signer.address, to: escrowAddress, data: step.data, value: step.value });
      const gasEstimate = BigInt(estimatedGas);
      gasLimit = (gasEstimate * 120n + 99n) / 100n;
      requireGate(gasLimit <= options.maxGasPerTransaction, 'STEP_GAS_CAP_EXCEEDED', `${step.name} buffered gas exceeds the explicit per-transaction cap.`);
      stepMaxFeePerGas = maxFeePerGas;
      stepMaxPriorityFeePerGas = maxPriorityFeePerGas;
      stepReservedCost = gasLimit * stepMaxFeePerGas + step.value;
    }
    reservedCostWei += stepReservedCost;
    requireGate(reservedCostWei <= options.maxTotalCostWei, 'TOTAL_COST_CAP_EXCEEDED', 'Accumulated lifecycle reservation exceeds the explicit total cap.');
    const transactionRequest = {
      type: 2,
      chainId: LIFECYCLE_LIMITS.chainId,
      nonce,
      to: escrowAddress,
      data: step.data,
      value: step.value,
      gasLimit,
      maxFeePerGas: stepMaxFeePerGas,
      maxPriorityFeePerGas: stepMaxPriorityFeePerGas,
    };
    const signedTransaction = await signer.signTransaction(transactionRequest);
    requireGate(/^0x[0-9a-fA-F]+$/.test(signedTransaction), 'INVALID_SIGNED_TRANSACTION', `${step.name} signer returned an invalid serialized transaction.`);
    const plannedHash = keccak256(signedTransaction).toLowerCase();
    if (recoveringPrepared) {
      requireGate(plannedHash === preparedRecovery.plannedHash,
        'RESUME_PREPARED_SIGNATURE_HASH_MISMATCH', 'Re-signed prepared transaction does not reproduce the exact planned hash.');
    } else {
      journal = {
        ...journal,
        status: 'prepared_before_broadcast',
        pending_transaction: {
          step: step.name,
          signer_role: step.signerRole,
          signer_address: normalizeAddress(signer.address),
          transaction_type: 2,
          chain_id: LIFECYCLE_LIMITS.chainId,
          nonce,
          target: escrowAddress,
          calldata: step.data.toLowerCase(),
          planned_transaction_hash: plannedHash,
          value_wei: step.value.toString(),
          gas_limit: gasLimit.toString(),
          max_fee_per_gas_wei: stepMaxFeePerGas.toString(),
          max_priority_fee_per_gas_wei: stepMaxPriorityFeePerGas.toString(),
          max_reserved_cost_wei: stepReservedCost.toString(),
          signed_transaction_persisted: false,
          recovery_instruction: 'Query the planned hash, then use explicit resume for canonical reconciliation, pending hold, or exact same-hash rebroadcast.',
          prepared_at: timestamp(clock),
        },
      };
      await writeSafeAtomic(journalPath, journal, 0o600);
    }
    const transaction = await provider.broadcastTransaction(signedTransaction);
    transactionBroadcastCount += 1;
    requireGate(String(transaction.hash).toLowerCase() === plannedHash, 'BROADCAST_HASH_MISMATCH', `${step.name} broadcast hash does not match the pre-broadcast journal.`);
    journal = {
      ...journal,
      status: 'broadcast_pending_receipt',
      pending_transaction: {
        ...journal.pending_transaction,
        transaction_hash: plannedHash,
        exact_same_hash_rebroadcast: recoveringPrepared,
        broadcast_at: timestamp(clock),
      },
    };
    await writeSafeAtomic(journalPath, journal, 0o600);
    const receipt = await transaction.wait(options.confirmations);
    requireGate(receipt && Number(receipt.status) === 1, 'CANONICAL_RECEIPT_FAILED', `${step.name} canonical receipt failed.`);
    requireGate(String(receipt.hash ?? receipt.transactionHash).toLowerCase() === plannedHash, 'RECEIPT_HASH_MISMATCH', `${step.name} receipt hash does not match the journal.`);
    const receiptBlockNumber = Number(receipt.blockNumber);
    requireGate(Number.isSafeInteger(receiptBlockNumber) && receiptBlockNumber > 0, 'STEP_BLOCK_INVALID', `${step.name} receipt block number is invalid.`);
    const receiptBlockHash = normalizeBytes32(receipt.blockHash, `${step.name} receipt block hash`);
    const observedStatus = await readCanonicalJobStatusAtReceipt({
      provider,
      escrowAddress,
      jobId: options.jobId,
      step,
      blockNumber: receiptBlockNumber,
      blockHash: receiptBlockHash,
      readJobStatus,
    });
    const gasUsed = BigInt(receipt.gasUsed ?? 0n);
    const receiptGasPrice = BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? stepMaxFeePerGas);
    const stepEvidence = {
      step: step.name,
      signer_role: step.signerRole,
      signer_address: normalizeAddress(signer.address),
      transaction_hash: plannedHash,
      nonce,
      block_number: receiptBlockNumber,
      block_hash: receiptBlockHash,
      receipt_status: Number(receipt.status),
      confirmations: null,
      value_wei: step.value.toString(),
      gas_used: gasUsed.toString(),
      receipt_gas_price_wei: receiptGasPrice.toString(),
      observed_job_status: observedStatus,
      state_read_block_number: receiptBlockNumber,
      state_read_block_hash: receiptBlockHash,
      state_read_pinned_to_receipt_block: true,
    };
    journal = {
      ...journal,
      status: 'step_confirmed',
      pending_transaction: null,
      steps: [...journal.steps, stepEvidence],
      recovery: recoveringPrepared ? {
        ...(journal.recovery ?? {}),
        explicit_resume: true,
        exact_same_hash_rebroadcast: true,
        rebroadcast_step: step.name,
        rebroadcast_transaction_hash: plannedHash,
        rebroadcasted_at: timestamp(clock),
      } : journal.recovery,
      updated_at: timestamp(clock),
    };
    await writeSafeAtomic(journalPath, journal, 0o600);
  }

  const canonicalStepReceipts = await verifySteps({
    provider,
    steps: journal.steps,
    workflow,
    escrowAddress,
    requiredConfirmations: options.confirmations,
  });
  requireGate(canonicalStepReceipts?.all_steps_canonical === true, 'CANONICAL_STEP_PROOF_REQUIRED', 'Every lifecycle step requires independent canonical proof.');
  journal = {
    ...journal,
    status: 'all_steps_canonically_reverified',
    steps: canonicalStepReceipts.steps,
    canonical_step_receipts: {
      canonical_head_before: canonicalStepReceipts.canonical_head_before,
      canonical_head_after: canonicalStepReceipts.canonical_head_after,
      confirmations_required: canonicalStepReceipts.confirmations_required,
      all_steps_canonical: true,
    },
    updated_at: timestamp(clock),
  };
  await writeSafeAtomic(journalPath, journal, 0o600);

  const finalTransactionHash = canonicalStepReceipts.steps.at(-1).transaction_hash;
  const expected = {
    transaction_hash: finalTransactionHash,
    contract_address: escrowAddress,
    job_id: options.jobId,
    job_nonce: options.jobNonce,
    payer: options.payer,
    provider: options.provider,
    evaluator: options.evaluator,
    allowed_senders: Object.values(roleAddresses),
    amount_atomic: options.jobValueWei.toString(),
    expires_at: expiresAt,
    policy_decision_hash: options.policyDecisionHash,
    deliverable_hash: options.deliverableHash,
  };
  const canonicalTerminal = await verifyTerminal({ manifest, transactionHash: finalTransactionHash, expected });
  const requiredOutcome = options.outcome === 'release' ? 'RELEASED' : 'REFUNDED';
  requireGate(canonicalTerminal?.canonical_terminal_verified === true && canonicalTerminal?.terminal === true, 'CANONICAL_TERMINAL_PROOF_REQUIRED', 'Independent canonical terminal verification failed.');
  requireGate(canonicalTerminal?.checks?.job_state_deliverable_hash === true, 'CANONICAL_DELIVERABLE_HASH_MISMATCH', 'Canonical job deliverable hash does not match the selected lifecycle evidence.');
  requireGate(canonicalTerminal.outcome === requiredOutcome, 'CANONICAL_OUTCOME_MISMATCH', 'Canonical terminal outcome does not match the selected lifecycle.');
  requireGate(
    options.outcome === 'release'
      ? canonicalTerminal.completed === true && canonicalTerminal.refunded === false
      : canonicalTerminal.completed === false && canonicalTerminal.refunded === true,
    'CANONICAL_PAYMENT_CLASSIFICATION_MISMATCH',
    'Canonical payment-completion classification is inconsistent with the terminal outcome.',
  );

  const evidencePayload = {
    schema: 'xpayr.giwa.agentpay.lifecycle-evidence.v1',
    evidence_level: options.policyOrigin.mode === 'eip712_phase4_sod_policy_artifact'
      ? 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy_sod_v1'
      : options.policyOrigin.mode === 'eip712_signed_policy_artifact'
        ? 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy'
      : 'canonical_giwa_sepolia_lifecycle_receipts_unsigned',
    created_at: timestamp(clock),
    network_key: manifest.network_key,
    chain_id: manifest.chain_id,
    escrow_contract: escrowAddress,
    run_id: options.runId,
    outcome: canonicalTerminal.outcome,
    payment_completed: canonicalTerminal.completed === true,
    refunded: canonicalTerminal.refunded === true,
    job: {
      job_id: options.jobId,
      job_nonce: options.jobNonce,
      payer: options.payer,
      provider: options.provider,
      evaluator: options.evaluator,
      value_wei: options.jobValueWei.toString(),
      expires_at: expiresAt,
      policy_decision_hash: options.policyDecisionHash,
      deliverable_hash: options.deliverableHash,
    },
    policy_origin: options.policyOrigin,
    dojang,
    d1_reference: d1Reference,
    deployment_verification: deploymentVerification,
    caps: publicOptions(options),
    steps: canonicalStepReceipts.steps,
    canonical_step_receipts: {
      canonical_head_before: canonicalStepReceipts.canonical_head_before,
      canonical_head_after: canonicalStepReceipts.canonical_head_after,
      confirmations_required: canonicalStepReceipts.confirmations_required,
      all_steps_canonical: true,
    },
    canonical_terminal: canonicalTerminal,
    boundaries: {
      testnet_only: true,
      real_customer_funds: false,
      private_keys_persisted: false,
      signed_transactions_persisted: false,
      refund_is_payment_completion: false,
      producer_authentication: 'not_provided',
      policy_origin_authentication: options.policyOrigin.authentication,
      d1_artifact_binding: 'deployment_record_digest_validated_and_live_dojang_rechecked',
    },
  };
  assertEvidenceSafe(evidencePayload);
  let evidence;
  let evidenceReused = false;
  if (existingEvidence !== null) {
    evidence = validateExistingLifecycleEvidence({
      evidence: existingEvidence,
      options,
      manifest,
      escrowAddress,
      expiresAt,
      canonicalSteps: canonicalStepReceipts.steps,
      canonicalTerminal,
    });
    evidenceReused = true;
  } else {
    evidence = {
      ...evidencePayload,
      integrity: {
        algorithm: 'sha256',
        canonicalization: 'xpayr-canonical-json-v1',
        digest: sha256Hex(canonicalJson(evidencePayload)),
        producer_authentication: 'not_provided',
        signature: null,
        anchor: null,
      },
    };
    await writeSafeExclusive(evidencePath, evidence, 0o644, {
      existsCode: 'LIFECYCLE_EVIDENCE_EXISTS',
      existsMessage: 'Lifecycle evidence already exists; refusing to overwrite it.',
    });
  }
  journal = {
    ...journal,
    status: 'completed',
    terminal_outcome: canonicalTerminal.outcome,
    payment_completed: canonicalTerminal.completed === true,
    refunded: canonicalTerminal.refunded === true,
    reserved_cost_wei: reservedCostWei.toString(),
    evidence_path: path.relative(rootDir, evidencePath),
    evidence_digest: evidence.integrity.digest,
    evidence_reused_during_resume: evidenceReused,
    completed_at: timestamp(clock),
  };
  await writeSafeAtomic(journalPath, journal, 0o600);
  const completionLock = await readPrivateResumeJson(executionLockPath, 'Global lifecycle lock');
  requireGate(completionLock.schema === 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1'
      && completionLock.status === 'active_fail_closed_until_clean_completion'
      && completionLock.run_id === options.runId
      && completionLock.network_key === manifest.network_key
      && Number(completionLock.chain_id) === manifest.chain_id
      && normalizeAddress(completionLock.escrow_contract, 'completion lock escrow') === escrowAddress
      && normalizeAddress(completionLock.payer, 'completion lock payer') === options.payer,
    'RESUME_LOCK_OWNERSHIP_MISMATCH', 'Global execution lock ownership changed before terminal cleanup.');
  if (resumeLeaseAcquired) await unlink(resumeLeasePath);
  await unlink(executionLockPath);

  return {
    ...preflight,
    mode: 'execute',
    transaction_broadcast: transactionBroadcastCount > 0,
    transaction_broadcast_count: transactionBroadcastCount,
    terminal_outcome: canonicalTerminal.outcome,
    payment_completed: canonicalTerminal.completed === true,
    refunded: canonicalTerminal.refunded === true,
    step_count: journal.steps.length,
    journal_path: journalPath,
    evidence_path: evidencePath,
    evidence_digest: evidence.integrity.digest,
    evidence_reused_during_resume: evidenceReused,
    resume_lease_released: !options.resume || resumeLeaseAcquired,
    global_execution_lock_released: true,
  };
}

async function loadExecutionSigners({ provider, expectedAddresses }) {
  const result = {};
  for (const [role, expectedAddress] of Object.entries(expectedAddresses)) {
    const name = SIGNER_VARIABLE_BY_ROLE[role];
    requireGate(name, 'SIGNERS_REQUIRED', `Unsupported active signer role: ${role}.`);
    const privateKey = process.env[name] ?? '';
    requireGate(/^0x[0-9a-fA-F]{64}$/.test(privateKey), 'TESTNET_SIGNER_KEY_REQUIRED', `${name} must contain the active role's separately controlled testnet-only key.`);
    const wallet = new Wallet(privateKey, provider);
    requireGate(normalizeAddress(wallet.address) === expectedAddress, 'SIGNER_ADDRESS_MISMATCH', `${role} signer does not match its confirmed address.`);
    result[role] = wallet;
  }
  return result;
}

async function loadExecutionSignersFromSecureFile({ provider, expectedAddresses }) {
  const requiredKeys = Object.keys(expectedAddresses).map((role) => SIGNER_VARIABLE_BY_ROLE[role]);
  requireGate(requiredKeys.every(Boolean), 'SIGNERS_REQUIRED', 'An active lifecycle role has no supported signer variable.');
  await loadConfiguredSecureEnvFile({
    forbiddenRoot: REPOSITORY_ROOT,
    allowedKeys: requiredKeys,
    required: true,
    requiredKeys,
  });
  return loadExecutionSigners({ provider, expectedAddresses });
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  requireGate(!Number.isNaN(date.getTime()), 'INVALID_CLOCK', 'Lifecycle clock returned an invalid timestamp.');
  return date.toISOString();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSafeAtomic(filePath, value, mode) {
  assertEvidenceSafe(value);
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await rename(temporaryPath, filePath);
}

async function writeSafeExclusive(filePath, value, mode, {
  existsCode = 'RECOVERY_JOURNAL_EXISTS',
  existsMessage = 'A lifecycle recovery journal already exists; inspect every recorded transaction before any retry.',
} = {}) {
  assertEvidenceSafe(value);
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode,
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new LifecycleError(
        existsCode,
        existsMessage,
      );
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseLifecycleArgs(argv);
  const [manifest, deployment] = await Promise.all([
    loadManifest(),
    readJson(DEPLOYMENT_PATH),
  ]);
  const provider = new JsonRpcProvider(manifest.rpc.canonical, {
    chainId: LIFECYCLE_LIMITS.chainId,
    name: LIFECYCLE_LIMITS.networkKey,
  }, { staticNetwork: true });
  const dojangClient = new DojangClient({ manifest });
  const authorityProfile = options.authorityProfileId === null
    ? null
    : await loadAuthorityProfile(options.authorityProfileId, {
      moduleRoot: MODULE_ROOT,
      deployment,
      requireActive: true,
      roles: { payer: options.payer, provider: options.provider, evaluator: options.evaluator },
    });
  return runLifecycle({
    options,
    manifest,
    deployment,
    provider,
    dojangClient,
    authorityProfile,
    rootDir: MODULE_ROOT,
    signerLoader: loadExecutionSignersFromSecureFile,
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const report = await main();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'LIFECYCLE_FAILED',
      message: error?.message ?? 'Lifecycle runner failed.',
      transaction_broadcast: 'unknown_inspect_recovery_journal',
    })}\n`);
    process.exitCode = 1;
  }
}
