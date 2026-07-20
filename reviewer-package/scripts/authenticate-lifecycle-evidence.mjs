#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, getAddress, keccak256 } from 'ethers';
import { canonicalJson } from '../src/canonical-json.mjs';
import {
  AUTHENTICATED_EVIDENCE_SCHEMA,
  GIWA_CHAIN_ID,
  GIWA_NETWORK_KEY,
  buildAuthenticatedSidecar,
  buildAuthenticationMessage,
  encodeAnchorCalldata,
  signAuthenticationMessage,
  validateLifecycleEvidence,
  validateSignedPolicyArtifact,
  verifyAuthenticatedSidecar,
  verifyAuthenticationSignature,
  verifyCanonicalAnchor,
  AUTHENTICATED_EVIDENCE_V2_SCHEMA,
  buildAuthenticatedSidecarV2,
  buildAuthenticationMessageV2,
  encodeAnchorCalldataV2,
  signAuthenticationMessageV2,
  validateLifecycleEvidenceV2,
  validateSignedPolicyArtifactV2,
  verifyAuthenticatedSidecarV2,
  verifyAuthenticationSignatureV2,
  verifyCanonicalAnchorV2,
} from '../src/evidence-authentication.mjs';
import {
  EVIDENCE_PRODUCER_KEY_NAME,
  PHASE4_SOD_PROFILE_ID,
  loadAuthorityProfile,
  validateAuthorityProfile,
} from '../src/authority-profile.mjs';
import { assertEvidenceSafe } from '../src/evidence.mjs';
import { DomainError, invariant } from '../src/errors.mjs';
import { writeJsonAtomic, writeJsonExclusive } from '../src/exclusive-json-file.mjs';
import { loadManifest } from '../src/manifest.mjs';
import { loadConfiguredSecureEnvFile } from '../src/secure-env-file.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(MODULE_ROOT, '..');
const LIFECYCLE_EVIDENCE_ROOT = path.join(MODULE_ROOT, 'evidence', 'lifecycle');
const POLICY_EVIDENCE_ROOT = path.join(MODULE_ROOT, 'evidence', 'policy');
const AUTHENTICATED_EVIDENCE_ROOT = path.join(MODULE_ROOT, 'evidence', 'authenticated');
const DEPLOYMENT_PATH = path.join(MODULE_ROOT, 'config', 'deployment.json');
const PRODUCER_KEY_NAME = 'GIWA_LIFECYCLE_PAYER_PRIVATE_KEY';
const JOURNAL_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-journal.v1';
const LOCK_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-lock.v1';
const LEASE_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-resume-lease.v1';
const JOURNAL_SCHEMA_V2 = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-journal.v2';
const LOCK_SCHEMA_V2 = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-lock.v2';
const LEASE_SCHEMA_V2 = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication-resume-lease.v2';
const MAX_ANCHOR_GAS = 50_000n;
const MAX_ARTIFACT_BYTES = 2_000_000;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,79}$/;

function normalizedAddress(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    invariant(false, 'INVALID_AUTH_ADDRESS', `${label} must be a valid EVM address.`);
  }
}

function normalizedBytes32(value, label) {
  invariant(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'INVALID_AUTH_BYTES32', `${label} must be bytes32.`);
  return value.toLowerCase();
}

function positiveBigInt(value, label) {
  invariant(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'INVALID_AUTH_LIMIT', `${label} must be a positive base-10 integer.`);
  return BigInt(value);
}

function valueOf(args, name) {
  return args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

export function parseAuthenticationArgs(argv) {
  invariant(Array.isArray(argv), 'INVALID_AUTH_ARGS', 'Authentication arguments are required.');
  const allowedFlags = new Set(['--execute', '--resume']);
  const allowedValues = new Set([
    '--source-evidence',
    '--signed-policy',
    '--producer-address',
    '--confirm-chain-id',
    '--confirm-network',
    '--confirm-evidence-digest',
    '--confirm-policy-digest',
    '--max-fee-per-gas-wei',
    '--max-cost-wei',
    '--authority-profile',
  ]);
  const seen = new Set();
  for (const entry of argv) {
    if (allowedFlags.has(entry)) continue;
    const key = entry.includes('=') ? entry.slice(0, entry.indexOf('=')) : entry;
    invariant(allowedValues.has(key), 'UNKNOWN_AUTH_ARG', `Unsupported evidence authentication argument: ${key}`);
    invariant(!seen.has(key), 'DUPLICATE_AUTH_ARG', `Duplicate evidence authentication argument: ${key}`);
    seen.add(key);
    invariant(entry.includes('=') && entry.slice(entry.indexOf('=') + 1).length > 0,
      'INVALID_AUTH_ARGS', `${key} requires a value.`);
  }
  const execute = argv.includes('--execute');
  const resume = argv.includes('--resume');
  invariant(!resume || execute, 'INVALID_AUTH_ARGS', '--resume requires --execute.');
  const sourceEvidence = valueOf(argv, '--source-evidence');
  const signedPolicy = valueOf(argv, '--signed-policy');
  const producerAddress = valueOf(argv, '--producer-address');
  invariant(sourceEvidence && signedPolicy && producerAddress,
    'AUTH_ARTIFACTS_REQUIRED', '--source-evidence, --signed-policy and --producer-address are required.');
  const authorityProfileId = valueOf(argv, '--authority-profile');
  invariant(authorityProfileId === null || authorityProfileId === PHASE4_SOD_PROFILE_ID,
    'AUTHORITY_PROFILE_UNKNOWN', 'Only --authority-profile=phase4_sod_v1 is supported.');
  return {
    execute,
    resume,
    sourceEvidence,
    signedPolicy,
    producerAddress: normalizedAddress(producerAddress, 'producer address'),
    confirmChainId: valueOf(argv, '--confirm-chain-id'),
    confirmNetwork: valueOf(argv, '--confirm-network'),
    confirmEvidenceDigest: valueOf(argv, '--confirm-evidence-digest'),
    confirmPolicyDigest: valueOf(argv, '--confirm-policy-digest'),
    maxFeePerGasWei: valueOf(argv, '--max-fee-per-gas-wei'),
    maxCostWei: valueOf(argv, '--max-cost-wei'),
    authorityProfileId,
  };
}

function authenticationRuntime(authorityProfile = null) {
  if (authorityProfile === null) {
    return Object.freeze({
      version: 'v1',
      sidecarSchema: AUTHENTICATED_EVIDENCE_SCHEMA,
      journalSchema: JOURNAL_SCHEMA,
      lockSchema: LOCK_SCHEMA,
      leaseSchema: LEASE_SCHEMA,
      suffix: 'auth-v1',
      validateLifecycle: (value) => validateLifecycleEvidence(value),
      validatePolicy: (value, binding, options) => validateSignedPolicyArtifact(value, binding, options),
      buildMessage: (options) => buildAuthenticationMessage(options),
      signMessage: signAuthenticationMessage,
      verifySignature: verifyAuthenticationSignature,
      encodeCalldata: encodeAnchorCalldata,
      verifyAnchor: verifyCanonicalAnchor,
      buildSidecar: (options) => buildAuthenticatedSidecar(options),
      verifySidecar: (options) => verifyAuthenticatedSidecar(options),
      authorityProfile: null,
      policyAuthority: null,
    });
  }
  return Object.freeze({
    version: 'v2',
    sidecarSchema: AUTHENTICATED_EVIDENCE_V2_SCHEMA,
    journalSchema: JOURNAL_SCHEMA_V2,
    lockSchema: LOCK_SCHEMA_V2,
    leaseSchema: LEASE_SCHEMA_V2,
    suffix: 'auth-v2',
    validateLifecycle: (value) => validateLifecycleEvidenceV2(value, { authorityProfile }),
    validatePolicy: (value, binding, options) => validateSignedPolicyArtifactV2(value, binding, {
      ...options,
      authorityProfile,
    }),
    buildMessage: (options) => buildAuthenticationMessageV2({ ...options, authorityProfile }),
    signMessage: signAuthenticationMessageV2,
    verifySignature: verifyAuthenticationSignatureV2,
    encodeCalldata: encodeAnchorCalldataV2,
    verifyAnchor: verifyCanonicalAnchorV2,
    buildSidecar: (options) => buildAuthenticatedSidecarV2({ ...options, authorityProfile }),
    verifySidecar: (options) => verifyAuthenticatedSidecarV2({ ...options, authorityProfile }),
    authorityProfile,
    policyAuthority: authorityProfile.policyAuthorityAddress,
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveArtifactPath(inputPath, allowedRoot, suffix, label) {
  invariant(typeof inputPath === 'string' && inputPath.length > 0, 'AUTH_ARTIFACT_REQUIRED', `${label} path is required.`);
  const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(MODULE_ROOT, inputPath);
  const lexical = await lstat(absolute);
  invariant(lexical.isFile() && !lexical.isSymbolicLink(), 'AUTH_ARTIFACT_UNSAFE_PATH', `${label} path must not be a symlink.`);
  const [root, resolved] = await Promise.all([realpath(allowedRoot), realpath(absolute)]);
  invariant(isInside(root, resolved) && resolved !== root && resolved.endsWith(suffix),
    'AUTH_ARTIFACT_UNSAFE_PATH', `${label} must be an exact ${suffix} file under ${path.relative(MODULE_ROOT, root)}.`);
  return resolved;
}

async function readStableArtifact(filePath, label, { allowedModes = [0o600, 0o644] } = {}) {
  const lexical = await lstat(filePath);
  invariant(lexical.isFile() && !lexical.isSymbolicLink() && lexical.nlink === 1,
    'AUTH_ARTIFACT_UNSAFE', `${label} must be one regular non-linked file.`);
  invariant(allowedModes.includes(lexical.mode & 0o777), 'AUTH_ARTIFACT_UNSAFE', `${label} permissions are invalid.`);
  if (typeof process.getuid === 'function') {
    invariant(lexical.uid === process.getuid(), 'AUTH_ARTIFACT_UNSAFE', `${label} must be owned by the current user.`);
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    invariant(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
      'AUTH_ARTIFACT_UNSAFE', `${label} changed to a linked or non-regular file.`);
    invariant(allowedModes.includes(before.mode & 0o777), 'AUTH_ARTIFACT_UNSAFE', `${label} permissions changed.`);
    if (typeof process.getuid === 'function') {
      invariant(before.uid === process.getuid(), 'AUTH_ARTIFACT_UNSAFE', `${label} ownership changed.`);
    }
    invariant(before.size > 0 && before.size <= MAX_ARTIFACT_BYTES, 'AUTH_ARTIFACT_UNSAFE', `${label} size is invalid.`);
    const source = await handle.readFile();
    const after = await handle.stat();
    invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs,
    'AUTH_ARTIFACT_CHANGED', `${label} changed while it was read.`);
    let value;
    try {
      value = JSON.parse(source.toString('utf8'));
    } catch {
      throw new DomainError('AUTH_ARTIFACT_JSON_INVALID', `${label} is not valid JSON.`);
    }
    assertEvidenceSafe(value);
    return {
      value,
      file_sha256: `0x${createHash('sha256').update(source).digest('hex')}`,
      size: source.length,
      metadata: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtime_ms: before.mtimeMs,
      },
    };
  } finally {
    await handle.close();
  }
}

function authenticationFromSidecar(sidecar) {
  return {
    domain: sidecar.producer?.domain,
    primary_type: sidecar.producer?.primary_type,
    types: sidecar.producer?.types,
    message: sidecar.producer?.message,
    typed_data_digest: sidecar.producer?.typed_data_digest,
    signature: sidecar.producer?.signature,
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readStableArtifactIfExists(filePath, label, options) {
  try {
    return await readStableArtifact(filePath, label, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readPrivateJson(filePath, label) {
  try {
    return (await readStableArtifact(filePath, label, { allowedModes: [0o600] })).value;
  } catch (error) {
    if (error?.code?.startsWith?.('AUTH_')) throw error;
    throw new DomainError('AUTH_RECOVERY_ARTIFACT_UNSAFE', `${label} could not be read safely.`, { cause: error });
  }
}

async function writePrivateAtomic(filePath, value) {
  assertEvidenceSafe(value);
  await writeJsonAtomic(filePath, value, { mode: 0o600 });
}

async function writePrivateExclusive(filePath, value, code, message) {
  assertEvidenceSafe(value);
  try {
    await writeJsonExclusive(filePath, value, { mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new DomainError(code, message);
    throw error;
  }
}

function validateJournalOwnership({ journal, lock, binding, policy, producer, paths, runtime }) {
  const profileBindingValid = runtime.version === 'v1'
    ? lock?.authority_profile_id === undefined && journal?.authority_profile_id === undefined
    : lock?.authority_profile_id === runtime.authorityProfile.profileId
      && lock?.authority_profile_digest === runtime.authorityProfile.digest
      && journal?.authority_profile_id === runtime.authorityProfile.profileId
      && journal?.authority_profile_digest === runtime.authorityProfile.digest
      && journal?.policy_authority === runtime.policyAuthority;
  invariant(lock?.schema === runtime.lockSchema
    && lock.status === 'active_fail_closed_until_clean_completion'
    && lock.run_id === binding.run_id
    && lock.producer === producer
    && lock.evidence_digest === binding.evidence_digest
    && lock.policy_digest === policy.digest
    && profileBindingValid,
  'AUTH_LOCK_OWNERSHIP_MISMATCH', 'Authentication lock is not owned by this exact evidence run.');
  invariant(journal?.schema === runtime.journalSchema
    && journal.run_id === binding.run_id
    && journal.producer === producer
    && journal.chain_id === GIWA_CHAIN_ID
    && journal.escrow_contract === binding.escrow_contract
    && journal.source_evidence_path === paths.sourceRelative
    && journal.source_file_sha256 === paths.sourceFileSha256
    && journal.evidence_digest === binding.evidence_digest
    && journal.signed_policy_path === paths.policyRelative
    && journal.policy_digest === policy.digest
    && journal.auth_artifact_path === paths.sidecarRelative
    && journal.private_keys_persisted === false
    && journal.raw_signed_transaction_persisted === false,
  'AUTH_JOURNAL_OWNERSHIP_MISMATCH', 'Authentication journal is not bound to this exact evidence run.');
}

function validateRetainedAuthentication(journal, expectedAuthentication, producer, runtime) {
  invariant(journal.authentication, 'AUTH_SIGNATURE_REQUIRED', 'Authentication journal has no retained signature.');
  const retained = runtime.verifySignature(journal.authentication, { expectedProducer: producer });
  invariant(retained.typed_data_digest === expectedAuthentication.typed_data_digest
    && retained.message.attestationId === expectedAuthentication.message.attestationId
    && canonicalJson(retained.domain) === canonicalJson(expectedAuthentication.domain)
    && canonicalJson(retained.types) === canonicalJson(expectedAuthentication.types)
    && canonicalJson(retained.message) === canonicalJson(expectedAuthentication.message),
  'AUTH_SIGNATURE_BINDING_MISMATCH', 'Retained producer signature does not match the source artifacts.');
  return retained;
}

function journalTransactionRequest(journal) {
  const transaction = journal.transaction;
  invariant(transaction && transaction.type === 2 && transaction.chain_id === GIWA_CHAIN_ID,
    'AUTH_TRANSACTION_JOURNAL_INVALID', 'Authentication journal transaction is invalid.');
  return {
    type: 2,
    chainId: GIWA_CHAIN_ID,
    nonce: transaction.nonce,
    to: transaction.to,
    value: 0n,
    data: transaction.calldata,
    gasLimit: BigInt(transaction.gas_limit),
    maxFeePerGas: BigInt(transaction.max_fee_per_gas_wei),
    maxPriorityFeePerGas: BigInt(transaction.max_priority_fee_per_gas_wei),
  };
}

async function sourceStillStable({
  sourcePath,
  sourceSnapshot,
  policyPath,
  policySnapshot,
  policyRelative,
  producer,
  runtime,
}) {
  const [sourceAgain, policyAgain] = await Promise.all([
    readStableArtifact(sourcePath, 'Lifecycle evidence', { allowedModes: [0o644] }),
    readStableArtifact(policyPath, 'Signed policy evidence'),
  ]);
  const binding = runtime.validateLifecycle(sourceAgain.value);
  const policy = runtime.validatePolicy(policyAgain.value, binding, {
    ...(runtime.version === 'v1' ? { expectedProducer: producer } : {}),
    policyArtifactPath: policyRelative,
    policyFileSha256: policyAgain.file_sha256,
  });
  invariant(sourceAgain.file_sha256 === sourceSnapshot.file_sha256
    && policyAgain.file_sha256 === policySnapshot.file_sha256,
  'AUTH_ARTIFACT_CHANGED', 'Source evidence or signed policy artifact changed during authentication.');
  return { binding, policy };
}

function report({
  mode,
  paths,
  binding,
  producer,
  policy,
  signatureVerified = false,
  anchor = null,
  canonicalVerified = false,
  transactionBroadcast = false,
  transactionBroadcastCount = 0,
  status,
  runtime,
}) {
  return {
    ok: true,
    mode,
    status,
    network_key: GIWA_NETWORK_KEY,
    chain_id: GIWA_CHAIN_ID,
    source_evidence_path: paths.sourceRelative,
    signed_policy_path: paths.policyRelative,
    auth_artifact_path: paths.sidecarRelative,
    evidence_digest: binding.evidence_digest,
    policy_digest: policy.digest,
    producer,
    authentication_version: runtime.version,
    authority_profile_id: runtime.authorityProfile?.profileId ?? null,
    authority_profile_digest: runtime.authorityProfile?.digest ?? null,
    policy_authority: runtime.policyAuthority ?? producer,
    signature_verified: signatureVerified,
    anchor_tx_hash: anchor?.transaction_hash ?? null,
    anchor_block_number: anchor?.block_number ?? null,
    anchor_block_hash: anchor?.block_hash ?? null,
    anchor_confirmations: anchor?.confirmations ?? null,
    canonical_verified: canonicalVerified,
    transaction_broadcast: transactionBroadcast,
    transaction_broadcast_count: transactionBroadcastCount,
    private_keys_persisted: false,
    raw_signed_transaction_persisted: false,
  };
}

async function verifyExistingSidecar({ sidecar, provider, binding, sourceSnapshot, policy, confirmations, producer, runtime }) {
  const local = runtime.verifySidecar({
    sidecar,
    lifecycleBinding: binding,
    sourceFileSha256: sourceSnapshot.file_sha256,
    validatedPolicy: policy,
  });
  const authentication = authenticationFromSidecar(sidecar);
  const anchor = await runtime.verifyAnchor({
    provider,
    transactionHash: local.anchor_transaction_hash,
    authentication,
    requiredConfirmations: confirmations,
    expectedNonce: sidecar.anchor?.nonce,
  });
  const stableFields = [
    'scheme',
    'transaction_hash',
    'from',
    'to',
    'value_wei',
    'transaction_type',
    'nonce',
    'calldata',
    'calldata_bytes',
    'receipt_status',
    'block_number',
    'block_hash',
    'block_timestamp',
    'confirmations_required',
    'canonical_block_refetched_twice',
    'producer_code_at_receipt_block',
    'producer_was_eoa_at_receipt_block',
    'explorer_url',
    'gas_used',
    'effective_gas_price_wei',
  ];
  invariant(stableFields.every((field) => canonicalJson(anchor[field]) === canonicalJson(sidecar.anchor?.[field]))
    && canonicalJson(anchor.decoded) === canonicalJson(sidecar.anchor?.decoded)
    && anchor.confirmations >= sidecar.anchor.confirmations,
  'AUTH_SIDECAR_CANONICAL_MISMATCH', 'Authenticated sidecar anchor differs from canonical RPC evidence.');
  return { local, authentication: runtime.verifySignature(authentication, { expectedProducer: producer }), anchor };
}

async function loadProducerSigner({ provider, producer, signerLoader }) {
  const signer = await signerLoader({ provider, expectedAddress: producer });
  invariant(normalizedAddress(await signer.getAddress(), 'producer signer') === producer,
    'AUTH_SIGNER_MISMATCH', 'Configured producer signer does not match the selected evidence producer address.');
  invariant(typeof signer.signTypedData === 'function' && typeof signer.signTransaction === 'function',
    'AUTH_SIGNER_REQUIRED', 'Configured producer signer cannot sign typed data and transactions.');
  return signer;
}

export async function runEvidenceAuthentication({
  options,
  manifest,
  deployment,
  provider,
  rootDir = MODULE_ROOT,
  signerLoader,
  authorityProfile = null,
  clock = () => new Date(),
} = {}) {
  invariant(options && typeof options === 'object', 'INVALID_AUTH_ARGS', 'Authentication options are required.');
  invariant(manifest?.network_key === GIWA_NETWORK_KEY && manifest?.chain_id === GIWA_CHAIN_ID
    && manifest?.environment === 'testnet' && manifest?.capabilities?.mainnet === false,
    'AUTH_NETWORK_MISMATCH', 'GIWA Sepolia manifest is required.');
  invariant(deployment?.status === 'deployed_testnet' && deployment?.networkKey === GIWA_NETWORK_KEY
    && deployment?.chainId === GIWA_CHAIN_ID,
  'AUTH_DEPLOYMENT_REQUIRED', 'A recorded GIWA Sepolia deployment is required.');
  const producer = normalizedAddress(options.producerAddress, 'producer address');
  const lifecycleRoot = path.join(rootDir, 'evidence', 'lifecycle');
  const policyRoot = path.join(rootDir, 'evidence', 'policy');
  const authRoot = path.join(rootDir, 'evidence', 'authenticated');
  const sourcePath = await resolveArtifactPath(options.sourceEvidence, lifecycleRoot, '.evidence.json', 'Lifecycle evidence');
  const policyPath = await resolveArtifactPath(options.signedPolicy, policyRoot, '.policy.json', 'Signed policy evidence');
  const [sourceSnapshot, policySnapshot] = await Promise.all([
    readStableArtifact(sourcePath, 'Lifecycle evidence', { allowedModes: [0o644] }),
    readStableArtifact(policyPath, 'Signed policy evidence'),
  ]);
  const resolvedRootDir = await realpath(rootDir);
  const sourceRelative = path.relative(resolvedRootDir, sourcePath);
  const policyRelative = path.relative(resolvedRootDir, policyPath);
  const profileId = options.authorityProfileId ?? null;
  invariant(profileId === null || profileId === PHASE4_SOD_PROFILE_ID,
    'AUTHORITY_PROFILE_UNKNOWN', 'Only phase4_sod_v1 is supported.');
  let validatedProfile = null;
  if (profileId === PHASE4_SOD_PROFILE_ID) {
    validatedProfile = validateAuthorityProfile(authorityProfile?.profile ?? authorityProfile, {
      deployment,
      requireActive: true,
      roles: {
        payer: sourceSnapshot.value?.job?.payer,
        provider: sourceSnapshot.value?.job?.provider,
        evaluator: sourceSnapshot.value?.job?.evaluator,
      },
    });
  } else {
    invariant(authorityProfile === null,
      'AUTHORITY_PROFILE_UNEXPECTED', 'Legacy auth-v1 flow must not receive an authority profile.');
  }
  const runtime = authenticationRuntime(validatedProfile);
  const binding = runtime.validateLifecycle(sourceSnapshot.value);
  if (runtime.version === 'v1') {
    invariant(binding.job.payer === producer, 'PRODUCER_PAYER_MISMATCH', 'Producer must equal the lifecycle payer/deployer.');
  } else {
    invariant(producer === validatedProfile.evidenceProducerAddress,
      'AUTH_V2_PRODUCER_MISMATCH', 'Producer must equal the sealed independent evidence producer.');
  }
  invariant(binding.escrow_contract === normalizedAddress(deployment.contractAddress, 'deployment contract'),
    'AUTH_DEPLOYMENT_MISMATCH', 'Lifecycle evidence escrow does not match the deployment record.');
  const policy = runtime.validatePolicy(policySnapshot.value, binding, {
    ...(runtime.version === 'v1' ? { expectedProducer: producer } : {}),
    policyArtifactPath: policyRelative,
    policyFileSha256: policySnapshot.file_sha256,
  });
  const authenticationTemplate = runtime.buildMessage({
    lifecycleBinding: binding,
    sourceFileSha256: sourceSnapshot.file_sha256,
    policyEnvelopeDigest: policy.digest,
    producer,
  });
  const sidecarPath = path.join(authRoot, `${binding.run_id}.${runtime.suffix}.json`);
  const journalPath = path.join(authRoot, `${binding.run_id}.${runtime.suffix}.journal.json`);
  const lockPath = path.join(authRoot, `active-anchor-${producer.slice(2)}.lock.json`);
  const leasePath = path.join(authRoot, `${binding.run_id}.${runtime.suffix}.resume.lease.json`);
  const paths = {
    sourceRelative,
    policyRelative,
    sidecarRelative: path.relative(rootDir, sidecarPath),
    sourceFileSha256: sourceSnapshot.file_sha256,
  };
  invariant(RUN_ID_PATTERN.test(binding.run_id), 'INVALID_AUTH_RUN_ID', 'Lifecycle evidence run ID is unsafe.');
  const confirmations = Number(manifest.confirmation_policy?.required_confirmations);
  invariant(Number.isSafeInteger(confirmations) && confirmations > 0, 'AUTH_CONFIRMATIONS_INVALID', 'Manifest confirmations are invalid.');
  const network = await provider.getNetwork();
  invariant(Number(network.chainId) === GIWA_CHAIN_ID, 'AUTH_NETWORK_MISMATCH', 'Canonical RPC returned the wrong chain ID.');
  const [producerCode, latestNonce, pendingNonce, existingSidecarSnapshot, existingJournal, existingLock] = await Promise.all([
    provider.getCode(producer),
    provider.getTransactionCount(producer, 'latest'),
    provider.getTransactionCount(producer, 'pending'),
    readStableArtifactIfExists(sidecarPath, 'Authenticated evidence sidecar', { allowedModes: [0o644] }),
    readJsonIfExists(journalPath),
    readJsonIfExists(lockPath),
  ]);
  const existingSidecar = existingSidecarSnapshot?.value ?? null;
  invariant(producerCode === '0x', 'ANCHOR_PRODUCER_NOT_EOA', 'Producer address currently contains contract/delegated code.');
  if (existingSidecar !== null) {
    const verified = await verifyExistingSidecar({
      sidecar: existingSidecar,
      provider,
      binding,
      sourceSnapshot,
      policy,
      confirmations,
      producer,
      runtime,
    });
    if (existingLock !== null) {
      if (!options.execute) {
        return report({
          mode: 'read-only-preflight',
          paths,
          binding,
          producer,
          policy,
          signatureVerified: true,
          anchor: verified.anchor,
          canonicalVerified: true,
          status: 'completed_sidecar_cleanup_requires_explicit_resume',
          runtime,
        });
      }
      invariant(options.resume, 'AUTH_FINALIZATION_RESUME_REQUIRED', 'Canonical sidecar exists with an active lock; explicit --resume is required for cleanup.');
      const [retainedLock, retainedJournal] = await Promise.all([
        readPrivateJson(lockPath, 'Evidence authentication lock'),
        readPrivateJson(journalPath, 'Evidence authentication journal'),
      ]);
      validateJournalOwnership({ journal: retainedJournal, lock: retainedLock, binding, policy, producer, paths, runtime });
      invariant(retainedJournal.transaction?.planned_transaction_hash === verified.anchor.transaction_hash,
        'AUTH_FINALIZATION_MISMATCH', 'Retained journal transaction does not match the canonical sidecar.');
      await writePrivateExclusive(leasePath, {
        schema: runtime.leaseSchema,
        status: 'exclusive_resume_in_progress_fail_closed_on_crash',
        run_id: binding.run_id,
        producer,
        evidence_digest: binding.evidence_digest,
        policy_digest: policy.digest,
        ...(runtime.version === 'v2' ? {
          authority_profile_id: runtime.authorityProfile.profileId,
          authority_profile_digest: runtime.authorityProfile.digest,
        } : {}),
        created_at: new Date(clock()).toISOString(),
        recovery_instruction: 'Inspect the canonical sidecar, journal, and lock before operator-authorized removal.',
      }, 'AUTH_RESUME_LEASE_EXISTS', 'An authentication resume lease already exists; refusing concurrent finalization.');
      const completedJournal = {
        ...retainedJournal,
        status: 'completed',
        anchor: verified.anchor,
        auth_artifact_digest: existingSidecar.integrity.digest,
        completed_at: retainedJournal.completed_at ?? new Date(clock()).toISOString(),
        updated_at: new Date(clock()).toISOString(),
      };
      await writePrivateAtomic(journalPath, completedJournal);
      const completionLock = await readPrivateJson(lockPath, 'Evidence authentication lock');
      validateJournalOwnership({ journal: completedJournal, lock: completionLock, binding, policy, producer, paths, runtime });
      await unlink(leasePath);
      await unlink(lockPath);
      return report({
        mode: 'execute',
        paths,
        binding,
        producer,
        policy,
        signatureVerified: true,
        anchor: verified.anchor,
        canonicalVerified: true,
        status: 'completed_finalization_recovered',
        runtime,
      });
    }
    invariant(existingJournal?.status === 'completed', 'AUTH_FINALIZATION_MISMATCH', 'Canonical sidecar exists without a completed journal.');
    return report({
      mode: options.execute ? 'execute' : 'read-only-preflight',
      paths,
      binding,
      producer,
      policy,
      signatureVerified: true,
      anchor: verified.anchor,
      canonicalVerified: true,
      status: 'already_complete',
      runtime,
    });
  }
  if (!options.execute) {
    return {
      ...report({
        mode: 'read-only-preflight',
        paths,
        binding,
        producer,
        policy,
        status: existingJournal ? 'recovery_required' : 'ready',
        runtime,
      }),
      producer_code: producerCode,
      producer_latest_nonce: latestNonce,
      producer_pending_nonce: pendingNonce,
      signed_policy_verified: true,
      attestation_id: authenticationTemplate.attestation_id,
      typed_data_digest: authenticationTemplate.typed_data_digest,
      recovery_journal_status: existingJournal?.status ?? null,
      execute_requirements: [
        '--execute',
        ...(runtime.version === 'v2' ? [`--authority-profile=${PHASE4_SOD_PROFILE_ID}`] : []),
        '--confirm-chain-id=91342',
        '--confirm-network=giwa-testnet',
        `--confirm-evidence-digest=${binding.evidence_digest}`,
        `--confirm-policy-digest=${policy.digest}`,
        '--max-fee-per-gas-wei=<explicit-cap>',
        '--max-cost-wei=<explicit-cap>',
        runtime.version === 'v2'
          ? `GIWA_AGENTPAY_ENV_FILE pointing to a repository-external exact-0600 file containing only ${EVIDENCE_PRODUCER_KEY_NAME}`
          : `GIWA_AGENTPAY_ENV_FILE pointing to a repository-external exact-0600 file containing only ${PRODUCER_KEY_NAME}`,
      ],
    };
  }

  invariant(options.confirmChainId === String(GIWA_CHAIN_ID) && options.confirmNetwork === GIWA_NETWORK_KEY,
    'AUTH_EXECUTION_CONFIRMATION_REQUIRED', 'Exact GIWA Sepolia confirmations are required.');
  invariant(normalizedBytes32(options.confirmEvidenceDigest, 'confirmed evidence digest') === binding.evidence_digest,
    'AUTH_EXECUTION_CONFIRMATION_REQUIRED', 'Confirmed evidence digest does not match.');
  invariant(normalizedBytes32(options.confirmPolicyDigest, 'confirmed policy digest') === policy.digest,
    'AUTH_EXECUTION_CONFIRMATION_REQUIRED', 'Confirmed policy digest does not match.');
  const feeCap = positiveBigInt(options.maxFeePerGasWei, 'max-fee-per-gas-wei');
  const costCap = positiveBigInt(options.maxCostWei, 'max-cost-wei');
  await mkdir(authRoot, { recursive: true });

  let journal;
  let lock;
  let resumeLeaseAcquired = false;
  if (options.resume) {
    [lock, journal] = await Promise.all([
      readPrivateJson(lockPath, 'Evidence authentication lock'),
      readPrivateJson(journalPath, 'Evidence authentication journal'),
    ]);
    validateJournalOwnership({ journal, lock, binding, policy, producer, paths, runtime });
    await writePrivateExclusive(leasePath, {
      schema: runtime.leaseSchema,
      status: 'exclusive_resume_in_progress_fail_closed_on_crash',
      run_id: binding.run_id,
      producer,
      evidence_digest: binding.evidence_digest,
      policy_digest: policy.digest,
      ...(runtime.version === 'v2' ? {
        authority_profile_id: runtime.authorityProfile.profileId,
        authority_profile_digest: runtime.authorityProfile.digest,
      } : {}),
      created_at: new Date(clock()).toISOString(),
      recovery_instruction: 'Inspect the journal, lock, canonical transaction, and producer nonce before operator-authorized removal.',
    }, 'AUTH_RESUME_LEASE_EXISTS', 'An authentication resume lease already exists; refusing concurrent or blind resume.');
    resumeLeaseAcquired = true;
  } else {
    invariant(existingJournal === null, 'AUTH_RECOVERY_REQUIRED', 'An authentication journal already exists; use explicit --resume after reconciliation.');
    await writePrivateExclusive(lockPath, {
      schema: runtime.lockSchema,
      status: 'active_fail_closed_until_clean_completion',
      run_id: binding.run_id,
      producer,
      evidence_digest: binding.evidence_digest,
      policy_digest: policy.digest,
      ...(runtime.version === 'v2' ? {
        authority_profile_id: runtime.authorityProfile.profileId,
        authority_profile_digest: runtime.authorityProfile.digest,
      } : {}),
      created_at: new Date(clock()).toISOString(),
      recovery_instruction: 'Inspect the journal, canonical transaction, and producer nonce before any retry.',
    }, 'AUTH_GLOBAL_LOCK_EXISTS', 'Another evidence anchor owns this producer nonce lock.');
    lock = await readPrivateJson(lockPath, 'Evidence authentication lock');
    journal = {
      schema: runtime.journalSchema,
      status: 'ready_before_signature',
      run_id: binding.run_id,
      network_key: GIWA_NETWORK_KEY,
      chain_id: GIWA_CHAIN_ID,
      escrow_contract: binding.escrow_contract,
      producer,
      source_evidence_path: sourceRelative,
      source_file_sha256: sourceSnapshot.file_sha256,
      evidence_digest: binding.evidence_digest,
      signed_policy_path: policyRelative,
      signed_policy_file_sha256: policySnapshot.file_sha256,
      policy_digest: policy.digest,
      ...(runtime.version === 'v2' ? {
        authority_profile_id: runtime.authorityProfile.profileId,
        authority_profile_digest: runtime.authorityProfile.digest,
        policy_authority: runtime.policyAuthority,
      } : {}),
      auth_artifact_path: paths.sidecarRelative,
      authentication: null,
      transaction: null,
      anchor: null,
      private_keys_persisted: false,
      raw_signed_transaction_persisted: false,
      transaction_fields_persisted: true,
      created_at: new Date(clock()).toISOString(),
    };
    await writePrivateExclusive(journalPath, journal, 'AUTH_RECOVERY_REQUIRED', 'Authentication journal already exists.');
  }

  let signer = null;
  let authentication;
  if (journal.authentication) {
    authentication = validateRetainedAuthentication(journal, authenticationTemplate, producer, runtime);
  } else {
    await sourceStillStable({
      sourcePath,
      sourceSnapshot,
      policyPath,
      policySnapshot,
      policyRelative,
      producer,
      runtime,
    });
    signer = await loadProducerSigner({ provider, producer, signerLoader });
    authentication = await runtime.signMessage(authenticationTemplate, signer);
    journal = {
      ...journal,
      status: 'signature_created',
      authentication,
      updated_at: new Date(clock()).toISOString(),
    };
    await writePrivateAtomic(journalPath, journal);
  }
  const calldata = runtime.encodeCalldata(authentication);
  let transactionBroadcastCount = 0;

  if (!journal.transaction) {
    const [feeData, balance, nonceLatest, noncePending, gasEstimate] = await Promise.all([
      provider.getFeeData(),
      provider.getBalance(producer),
      provider.getTransactionCount(producer, 'latest'),
      provider.getTransactionCount(producer, 'pending'),
      provider.estimateGas({ from: producer, to: producer, value: 0n, data: calldata }),
    ]);
    invariant(nonceLatest === noncePending, 'AUTH_PENDING_NONCE_EXISTS', 'Producer has a pending transaction; refusing to reserve an ambiguous nonce.');
    invariant(gasEstimate <= MAX_ANCHOR_GAS, 'AUTH_GAS_ESTIMATE_EXCEEDED', 'Anchor gas estimate exceeds the hard cap.');
    invariant(feeData.maxFeePerGas !== null && feeData.maxFeePerGas !== undefined,
      'AUTH_EIP1559_REQUIRED', 'Canonical RPC did not return EIP-1559 fee data.');
    const maxFeePerGas = BigInt(feeData.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas ?? 0n);
    invariant(maxPriorityFeePerGas <= maxFeePerGas && maxFeePerGas <= feeCap,
      'AUTH_FEE_CAP_EXCEEDED', 'Anchor fee data exceeds the explicit cap.');
    const maxReservedCost = MAX_ANCHOR_GAS * maxFeePerGas;
    invariant(maxReservedCost <= costCap, 'AUTH_COST_CAP_EXCEEDED', 'Anchor maximum reserved cost exceeds the explicit cap.');
    invariant(balance >= maxReservedCost, 'AUTH_BALANCE_INSUFFICIENT', 'Producer lacks bounded test ETH for the evidence anchor.');
    if (!signer) signer = await loadProducerSigner({ provider, producer, signerLoader });
    let rawSignedTransaction = await signer.signTransaction({
      type: 2,
      chainId: GIWA_CHAIN_ID,
      nonce: noncePending,
      to: producer,
      value: 0n,
      data: calldata,
      gasLimit: MAX_ANCHOR_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const plannedHash = keccak256(rawSignedTransaction).toLowerCase();
    journal = {
      ...journal,
      status: 'broadcast_prepared',
      transaction: {
        type: 2,
        chain_id: GIWA_CHAIN_ID,
        nonce: noncePending,
        from: producer,
        to: producer,
        value_wei: '0',
        calldata,
        gas_limit: MAX_ANCHOR_GAS.toString(),
        max_fee_per_gas_wei: maxFeePerGas.toString(),
        max_priority_fee_per_gas_wei: maxPriorityFeePerGas.toString(),
        max_reserved_cost_wei: maxReservedCost.toString(),
        planned_transaction_hash: plannedHash,
        raw_signed_transaction_persisted: false,
      },
      updated_at: new Date(clock()).toISOString(),
    };
    await writePrivateAtomic(journalPath, journal);
    const response = await provider.broadcastTransaction(rawSignedTransaction);
    rawSignedTransaction = null;
    invariant(String(response.hash).toLowerCase() === plannedHash,
      'AUTH_BROADCAST_HASH_MISMATCH', 'Broadcast anchor hash does not match the journal.');
    transactionBroadcastCount += 1;
    journal = {
      ...journal,
      status: 'broadcast_pending_receipt',
      transaction: { ...journal.transaction, broadcast_at: new Date(clock()).toISOString() },
      updated_at: new Date(clock()).toISOString(),
    };
    await writePrivateAtomic(journalPath, journal);
    const receipt = await provider.waitForTransaction(plannedHash, confirmations, 120_000);
    invariant(receipt, 'AUTH_RECEIPT_TIMEOUT', 'Anchor receipt was not confirmed before timeout; use explicit resume.');
  } else {
    const retainedRequest = journalTransactionRequest(journal);
    invariant(retainedRequest.to === producer && retainedRequest.data === calldata && retainedRequest.value === 0n
      && retainedRequest.gasLimit <= MAX_ANCHOR_GAS
      && retainedRequest.maxFeePerGas <= feeCap
      && retainedRequest.gasLimit * retainedRequest.maxFeePerGas <= costCap,
    'AUTH_TRANSACTION_JOURNAL_INVALID', 'Retained anchor transaction violates current bindings or caps.');
    const plannedHash = normalizedBytes32(journal.transaction.planned_transaction_hash, 'planned anchor transaction hash');
    const [retainedTransaction, retainedReceipt] = await Promise.all([
      provider.getTransaction(plannedHash),
      provider.getTransactionReceipt(plannedHash),
    ]);
    if (!retainedReceipt && retainedTransaction) {
      if (resumeLeaseAcquired) await unlink(leasePath);
      return report({
        mode: 'execute',
        paths,
        binding,
        producer,
        policy,
        signatureVerified: true,
        anchor: { transaction_hash: plannedHash },
        canonicalVerified: false,
        status: 'anchor_pending_no_rebroadcast',
        runtime,
      });
    }
    if (!retainedReceipt && !retainedTransaction) {
      const [nonceLatest, noncePending] = await Promise.all([
        provider.getTransactionCount(producer, 'latest'),
        provider.getTransactionCount(producer, 'pending'),
      ]);
      invariant(nonceLatest === retainedRequest.nonce && noncePending === retainedRequest.nonce,
        'AUTH_NONCE_CONSUMED_OR_AMBIGUOUS', 'Planned anchor is absent but its nonce is no longer exactly available.');
      if (!signer) signer = await loadProducerSigner({ provider, producer, signerLoader });
      let rawSignedTransaction = await signer.signTransaction(retainedRequest);
      invariant(keccak256(rawSignedTransaction).toLowerCase() === plannedHash,
        'AUTH_RESUME_HASH_MISMATCH', 'Reconstructed anchor transaction differs from the journal.');
      const response = await provider.broadcastTransaction(rawSignedTransaction);
      rawSignedTransaction = null;
      invariant(String(response.hash).toLowerCase() === plannedHash,
        'AUTH_BROADCAST_HASH_MISMATCH', 'Resumed anchor hash does not match the journal.');
      transactionBroadcastCount += 1;
      journal = {
        ...journal,
        status: 'broadcast_pending_receipt',
        transaction: { ...journal.transaction, rebroadcast_same_hash_at: new Date(clock()).toISOString() },
        updated_at: new Date(clock()).toISOString(),
      };
      await writePrivateAtomic(journalPath, journal);
      const receipt = await provider.waitForTransaction(plannedHash, confirmations, 120_000);
      invariant(receipt, 'AUTH_RECEIPT_TIMEOUT', 'Resumed anchor receipt was not confirmed before timeout.');
    }
  }

  await sourceStillStable({
    sourcePath,
    sourceSnapshot,
    policyPath,
    policySnapshot,
    policyRelative,
    producer,
    runtime,
  });
  const anchor = await runtime.verifyAnchor({
    provider,
    transactionHash: journal.transaction.planned_transaction_hash,
    authentication,
    requiredConfirmations: confirmations,
    expectedNonce: journal.transaction.nonce,
  });
  journal = {
    ...journal,
    status: 'anchor_confirmed',
    anchor,
    updated_at: new Date(clock()).toISOString(),
  };
  await writePrivateAtomic(journalPath, journal);
  const sidecar = runtime.buildSidecar({
    lifecycleEvidencePath: sourceRelative,
    lifecycleBinding: binding,
    sourceFileSha256: sourceSnapshot.file_sha256,
    policyArtifactPath: policyRelative,
    validatedPolicy: policy,
    authentication,
    anchor,
    createdAt: clock(),
  });
  assertEvidenceSafe(sidecar);
  try {
    await writeJsonExclusive(sidecarPath, sidecar, { mode: 0o644 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const retainedSidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
    runtime.verifySidecar({
      sidecar: retainedSidecar,
      lifecycleBinding: binding,
      sourceFileSha256: sourceSnapshot.file_sha256,
      validatedPolicy: policy,
    });
    invariant(canonicalJson(retainedSidecar) === canonicalJson(sidecar),
      'AUTH_SIDECAR_EXISTS_MISMATCH', 'Existing authenticated sidecar differs from canonical finalization.');
  }
  journal = {
    ...journal,
    status: 'completed',
    auth_artifact_digest: sidecar.integrity.digest,
    completed_at: new Date(clock()).toISOString(),
    updated_at: new Date(clock()).toISOString(),
  };
  await writePrivateAtomic(journalPath, journal);
  const completionLock = await readPrivateJson(lockPath, 'Evidence authentication lock');
  validateJournalOwnership({ journal, lock: completionLock, binding, policy, producer, paths, runtime });
  if (resumeLeaseAcquired) await unlink(leasePath);
  await unlink(lockPath);
  return report({
    mode: 'execute',
    paths,
    binding,
    producer,
    policy,
    signatureVerified: true,
    anchor,
    canonicalVerified: true,
    transactionBroadcast: transactionBroadcastCount > 0,
    transactionBroadcastCount,
    status: 'completed',
    runtime,
  });
}

async function loadExecutionSigner({ provider, expectedAddress, keyName = PRODUCER_KEY_NAME }) {
  invariant(keyName === PRODUCER_KEY_NAME || keyName === EVIDENCE_PRODUCER_KEY_NAME,
    'AUTH_SIGNER_REQUIRED', 'Unsupported evidence producer key selection.');
  await loadConfiguredSecureEnvFile({
    forbiddenRoot: REPOSITORY_ROOT,
    allowedKeys: [keyName],
    requiredKeys: [keyName],
    required: true,
  });
  const privateKey = process.env[keyName] ?? '';
  try {
    invariant(/^0x[0-9a-fA-F]{64}$/.test(privateKey), 'AUTH_SIGNER_REQUIRED', 'Configured producer testnet key is invalid.');
    const wallet = new Wallet(privateKey, provider);
    invariant(wallet.address.toLowerCase() === expectedAddress, 'AUTH_SIGNER_MISMATCH', 'Configured producer signer address is invalid.');
    return wallet;
  } finally {
    delete process.env[keyName];
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseAuthenticationArgs(argv);
  const [manifest, deployment] = await Promise.all([
    loadManifest(),
    readJson(DEPLOYMENT_PATH),
  ]);
  const authorityProfile = options.authorityProfileId === null
    ? null
    : await loadAuthorityProfile(options.authorityProfileId, {
      moduleRoot: MODULE_ROOT,
      deployment,
      requireActive: true,
    });
  const provider = new JsonRpcProvider(manifest.rpc.canonical, {
    chainId: GIWA_CHAIN_ID,
    name: GIWA_NETWORK_KEY,
  }, { staticNetwork: true });
  return runEvidenceAuthentication({
    options,
    manifest,
    deployment,
    provider,
    authorityProfile,
    rootDir: MODULE_ROOT,
    signerLoader: ({ provider: signerProvider, expectedAddress }) => loadExecutionSigner({
      provider: signerProvider,
      expectedAddress,
      keyName: authorityProfile === null ? PRODUCER_KEY_NAME : EVIDENCE_PRODUCER_KEY_NAME,
    }),
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'EVIDENCE_AUTHENTICATION_FAILED',
      message: error?.message ?? 'Evidence authentication failed.',
      transaction_broadcast: 'unknown_inspect_authentication_journal',
      private_keys_persisted: false,
      raw_signed_transaction_persisted: false,
    })}\n`);
    process.exitCode = 1;
  }
}
