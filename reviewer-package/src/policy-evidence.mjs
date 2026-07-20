import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  Signature,
  TypedDataEncoder,
  getAddress,
  id,
  verifyTypedData,
} from 'ethers';
import { canonicalJson, canonicalValue, deepClone, hashesEqual, sha256Hex } from './canonical-json.mjs';
import { assertEvidenceSafe } from './evidence.mjs';
import { invariant } from './errors.mjs';
import { writeJsonExclusive } from './exclusive-json-file.mjs';

export const POLICY_EVIDENCE_SCHEMA = 'xpayr.giwa.agentpay.policy-evidence.v1';
export const POLICY_RULESET_SCHEMA = 'xpayr.giwa.agentpay.policy-ruleset.v1';
export const POLICY_DOMAIN_NAME = 'XPAYR GIWA AgentPay Policy';
export const POLICY_DOMAIN_VERSION = '1';
export const POLICY_PRIMARY_TYPE = 'XPayrPolicyDecision';
export const POLICY_NETWORK_KEY = 'giwa-testnet';
export const POLICY_CHAIN_ID = 91342;

export const POLICY_EIP712_TYPES = Object.freeze({
  [POLICY_PRIMARY_TYPE]: Object.freeze([
    Object.freeze({ name: 'recordIdHash', type: 'bytes32' }),
    Object.freeze({ name: 'intentIdHash', type: 'bytes32' }),
    Object.freeze({ name: 'artifactDigest', type: 'bytes32' }),
    Object.freeze({ name: 'decisionHash', type: 'bytes32' }),
    Object.freeze({ name: 'bindingDigest', type: 'bytes32' }),
    Object.freeze({ name: 'rulesetHash', type: 'bytes32' }),
    Object.freeze({ name: 'jobId', type: 'bytes32' }),
    Object.freeze({ name: 'jobNonce', type: 'bytes32' }),
    Object.freeze({ name: 'payer', type: 'address' }),
    Object.freeze({ name: 'provider', type: 'address' }),
    Object.freeze({ name: 'evaluator', type: 'address' }),
    Object.freeze({ name: 'valueWei', type: 'uint256' }),
    Object.freeze({ name: 'expiresAt', type: 'uint64' }),
    Object.freeze({ name: 'outcomeHash', type: 'bytes32' }),
    Object.freeze({ name: 'deliverableHash', type: 'bytes32' }),
    Object.freeze({ name: 'authority', type: 'address' }),
  ]),
});

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_POLICY_FILE_BYTES = 512_000;

function normalizedAuthorityProfileReference(value, { required = false } = {}) {
  if (value === null || value === undefined) {
    invariant(!required, 'POLICY_AUTHORITY_PROFILE_REQUIRED', 'Policy authority profile binding is required.');
    return null;
  }
  invariant(value && typeof value === 'object' && !Array.isArray(value),
    'POLICY_AUTHORITY_PROFILE_INVALID', 'Policy authority profile binding is invalid.');
  const keys = Object.keys(value).sort();
  invariant(canonicalJson(keys) === canonicalJson(['profile_digest', 'profile_id']),
    'POLICY_AUTHORITY_PROFILE_INVALID', 'Policy authority profile binding must use the exact v1 field set.');
  invariant(value.profile_id === 'phase4_sod_v1',
    'POLICY_AUTHORITY_PROFILE_INVALID', 'Unsupported policy authority profile.');
  return canonicalValue({
    profile_id: value.profile_id,
    profile_digest: normalizedBytes32(value.profile_digest, 'policy authority profile digest'),
  });
}

function normalizedAddress(value, label, { allowZero = false } = {}) {
  let normalized;
  try {
    normalized = getAddress(value).toLowerCase();
  } catch {
    invariant(false, 'INVALID_POLICY_ADDRESS', `${label} must be a valid EVM address.`);
  }
  invariant(allowZero || normalized !== ZERO_ADDRESS, 'ZERO_POLICY_ADDRESS', `${label} cannot be zero.`);
  return normalized;
}

function normalizedBytes32(value, label, { allowZero = false } = {}) {
  invariant(typeof value === 'string' && BYTES32_PATTERN.test(value), 'INVALID_POLICY_BYTES32', `${label} must be bytes32.`);
  const normalized = value.toLowerCase();
  invariant(allowZero || normalized !== ZERO_BYTES32, 'ZERO_POLICY_BYTES32', `${label} cannot be zero.`);
  return normalized;
}

function decimal(value, label, { positive = false } = {}) {
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  invariant(DECIMAL_PATTERN.test(normalized), 'INVALID_POLICY_DECIMAL', `${label} must be a base-10 integer.`);
  invariant(!positive || BigInt(normalized) > 0n, 'ZERO_POLICY_DECIMAL', `${label} must be positive.`);
  return normalized;
}

function safeTimestamp(value, label) {
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  invariant(Number.isSafeInteger(parsed) && parsed > 0, 'INVALID_POLICY_TIMESTAMP', `${label} must be a positive safe integer.`);
  return parsed;
}

function safeId(value, label) {
  invariant(typeof value === 'string' && SAFE_ID_PATTERN.test(value), 'INVALID_POLICY_ID', `${label} must be a safe stable identifier.`);
  return value;
}

function normalizedOutcome(value) {
  invariant(value === 'RELEASED' || value === 'REFUNDED', 'INVALID_POLICY_OUTCOME', 'Policy outcome must be RELEASED or REFUNDED.');
  return value;
}

function normalizedJob(job) {
  invariant(job && typeof job === 'object' && !Array.isArray(job), 'INVALID_POLICY_JOB', 'Policy job binding is required.');
  const outcome = normalizedOutcome(job.outcome);
  const deliverableHash = normalizedBytes32(job.deliverableHash ?? job.deliverable_hash, 'policy deliverable hash', {
    allowZero: outcome === 'REFUNDED',
  });
  if (outcome === 'REFUNDED') {
    invariant(deliverableHash === ZERO_BYTES32, 'REFUND_POLICY_DELIVERABLE_FORBIDDEN', 'Refund policy must bind the zero deliverable hash.');
  } else {
    invariant(deliverableHash !== ZERO_BYTES32, 'RELEASE_POLICY_DELIVERABLE_REQUIRED', 'Release policy requires a non-zero deliverable hash.');
  }
  const payer = normalizedAddress(job.payer, 'policy payer');
  const provider = normalizedAddress(job.provider, 'policy provider');
  const evaluator = normalizedAddress(job.evaluator ?? ZERO_ADDRESS, 'policy evaluator', { allowZero: true });
  invariant(payer !== provider, 'POLICY_ROLE_COLLISION', 'Policy payer and provider must be distinct.');
  invariant(evaluator === ZERO_ADDRESS || (evaluator !== payer && evaluator !== provider),
    'POLICY_ROLE_COLLISION', 'Policy evaluator must be distinct when present.');
  return canonicalValue({
    escrow_contract: normalizedAddress(job.escrow ?? job.escrow_contract, 'policy escrow contract'),
    job_id: normalizedBytes32(job.jobId ?? job.job_id, 'policy job ID'),
    job_nonce: normalizedBytes32(job.jobNonce ?? job.job_nonce, 'policy job nonce'),
    payer,
    provider,
    evaluator,
    value_wei: decimal(job.valueWei ?? job.value_wei, 'policy job value', { positive: true }),
    expires_at: safeTimestamp(job.expiresAt ?? job.expires_at, 'policy job expiry'),
    outcome,
    deliverable_hash: deliverableHash,
  });
}

function normalizedRuleset(ruleset = {}) {
  const payload = canonicalValue({
    schema: POLICY_RULESET_SCHEMA,
    version: ruleset.version ?? '1',
    asset_mode: ruleset.asset_mode ?? 'native_giwa_sepolia_test_eth_only',
    required_verified_roles: ruleset.required_verified_roles ?? ['payer', 'provider'],
    autonomous_release_allowed: false,
    max_job_value_wei: decimal(ruleset.max_job_value_wei ?? '100000000000000000', 'ruleset max job value', { positive: true }),
    max_expiry_seconds: safeTimestamp(ruleset.max_expiry_seconds ?? 604_800, 'ruleset max expiry'),
  });
  invariant(Array.isArray(payload.required_verified_roles)
      && payload.required_verified_roles.length >= 2
      && payload.required_verified_roles.includes('payer')
      && payload.required_verified_roles.includes('provider'),
  'INVALID_POLICY_RULESET', 'Policy ruleset must require verified payer and provider roles.');
  return canonicalValue({ ...payload, hash: sha256Hex(canonicalJson(payload)).toLowerCase() });
}

function payloadWithoutAuthentication(evidence) {
  const payload = deepClone(evidence);
  delete payload.integrity;
  delete payload.authentication;
  return payload;
}

function expectedValue(expected, camel, snake = camel) {
  if (!expected || typeof expected !== 'object') return undefined;
  return expected[camel] ?? expected[snake];
}

function assertExpected(actual, expected, code, message) {
  if (expected !== undefined && expected !== null) invariant(actual === expected, code, message);
}

function typedDataForEvidence(evidence, artifactDigest) {
  const authority = normalizedAddress(
    evidence.authentication?.producer_address ?? evidence.authentication?.eip712?.producer_address ?? evidence.authority_address,
    'policy authority',
  );
  const job = normalizedJob(evidence.job);
  const domain = canonicalValue({
    name: POLICY_DOMAIN_NAME,
    version: POLICY_DOMAIN_VERSION,
    chainId: POLICY_CHAIN_ID,
    verifyingContract: job.escrow_contract,
  });
  const message = canonicalValue({
    recordIdHash: id(evidence.record_id).toLowerCase(),
    intentIdHash: id(evidence.intent_id).toLowerCase(),
    artifactDigest,
    decisionHash: evidence.decision_hash,
    bindingDigest: evidence.binding_digest,
    rulesetHash: evidence.ruleset.hash,
    jobId: job.job_id,
    jobNonce: job.job_nonce,
    payer: job.payer,
    provider: job.provider,
    evaluator: job.evaluator,
    valueWei: job.value_wei,
    expiresAt: job.expires_at,
    outcomeHash: id(job.outcome).toLowerCase(),
    deliverableHash: job.deliverable_hash,
    authority,
  });
  return canonicalValue({ domain, types: POLICY_EIP712_TYPES, primary_type: POLICY_PRIMARY_TYPE, message });
}

export function buildPolicyEvidence({
  createdAt,
  recordId,
  intentId,
  authority,
  decision = 'ALLOW',
  validFrom,
  validUntil,
  ruleset = {},
  job,
  authorityProfile = null,
} = {}) {
  const normalizedAuthority = normalizedAddress(authority, 'policy authority');
  invariant(decision === 'ALLOW' || decision === 'HOLD' || decision === 'DENY', 'INVALID_POLICY_DECISION', 'Unsupported policy decision.');
  const normalizedRecordId = safeId(recordId, 'policy record ID');
  const normalizedIntentId = safeId(intentId, 'policy intent ID');
  const normalizedJobBinding = normalizedJob(job);
  const from = safeTimestamp(validFrom, 'policy valid-from');
  const until = safeTimestamp(validUntil, 'policy valid-until');
  invariant(from < until && normalizedJobBinding.expires_at <= until,
    'INVALID_POLICY_VALIDITY', 'Policy validity must cover the bound job expiry.');
  const normalizedPolicyRuleset = normalizedRuleset(ruleset);
  const normalizedAuthorityProfile = normalizedAuthorityProfileReference(authorityProfile);
  invariant(BigInt(normalizedJobBinding.value_wei) <= BigInt(normalizedPolicyRuleset.max_job_value_wei),
    'POLICY_JOB_VALUE_EXCEEDED', 'Policy job value exceeds its signed ruleset cap.');
  invariant(normalizedJobBinding.expires_at - from <= normalizedPolicyRuleset.max_expiry_seconds,
    'POLICY_JOB_EXPIRY_EXCEEDED', 'Policy job expiry exceeds its signed ruleset window.');
  const binding = canonicalValue({
    record_id: normalizedRecordId,
    intent_id: normalizedIntentId,
    decision,
    authority_address: normalizedAuthority,
    ruleset_hash: normalizedPolicyRuleset.hash,
    validity: { valid_from: from, valid_until: until },
    job: normalizedJobBinding,
    ...(normalizedAuthorityProfile === null ? {} : { authority_profile: normalizedAuthorityProfile }),
  });
  const bindingDigest = sha256Hex(canonicalJson(binding)).toLowerCase();
  const decisionHash = sha256Hex(canonicalJson({
    schema: POLICY_EVIDENCE_SCHEMA,
    network_key: POLICY_NETWORK_KEY,
    chain_id: POLICY_CHAIN_ID,
    binding_digest: bindingDigest,
  })).toLowerCase();
  const payload = canonicalValue({
    schema: POLICY_EVIDENCE_SCHEMA,
    network_key: POLICY_NETWORK_KEY,
    chain_id: POLICY_CHAIN_ID,
    created_at: new Date(createdAt).toISOString(),
    record_id: normalizedRecordId,
    intent_id: normalizedIntentId,
    decision,
    decision_hash: decisionHash,
    binding_digest: bindingDigest,
    ruleset: normalizedPolicyRuleset,
    validity: { valid_from: from, valid_until: until },
    job: normalizedJobBinding,
    authority_address: normalizedAuthority,
    ...(normalizedAuthorityProfile === null ? {} : { authority_profile: normalizedAuthorityProfile }),
  });
  invariant(!Number.isNaN(Date.parse(payload.created_at)), 'INVALID_POLICY_CREATED_AT', 'Policy created-at timestamp is invalid.');
  const digest = sha256Hex(canonicalJson(payload)).toLowerCase();
  return canonicalValue({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      digest_scope: 'canonical_payload_without_integrity_and_authentication',
      digest,
    },
    authentication: null,
  });
}

export async function signPolicyEvidence(unsignedEvidence, signer) {
  invariant(unsignedEvidence?.authentication === null, 'POLICY_ALREADY_SIGNED', 'Policy evidence is already signed.');
  const verifiedUnsigned = verifyPolicyPayload(unsignedEvidence);
  invariant(signer && typeof signer.signTypedData === 'function' && typeof signer.getAddress === 'function',
    'POLICY_SIGNER_REQUIRED', 'Policy authority signer is required.');
  const signerAddress = normalizedAddress(await signer.getAddress(), 'policy signer');
  invariant(signerAddress === verifiedUnsigned.authority, 'POLICY_SIGNER_MISMATCH', 'Policy signer does not match the configured authority.');
  const typed = typedDataForEvidence(unsignedEvidence, verifiedUnsigned.artifactDigest);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  const typedDataDigest = TypedDataEncoder.hash(typed.domain, typed.types, typed.message).toLowerCase();
  const signed = canonicalValue({
    ...payloadWithoutAuthentication(unsignedEvidence),
    integrity: unsignedEvidence.integrity,
    authentication: {
      scheme: 'eip712',
      producer_address: signerAddress,
      eip712: {
        domain: typed.domain,
        types: typed.types,
        primary_type: typed.primary_type,
        message: typed.message,
        typed_data_digest: typedDataDigest,
        signature,
        producer_address: signerAddress,
      },
    },
  });
  verifyPolicyEvidence(signed, { expected: { authority: signerAddress } });
  return signed;
}

function verifyPolicyPayload(evidence) {
  invariant(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'INVALID_POLICY_EVIDENCE', 'Policy evidence is required.');
  assertEvidenceSafe(evidence);
  invariant(evidence.schema === POLICY_EVIDENCE_SCHEMA
      && evidence.network_key === POLICY_NETWORK_KEY
      && Number(evidence.chain_id) === POLICY_CHAIN_ID,
  'POLICY_NETWORK_MISMATCH', 'Policy evidence is not GIWA Sepolia evidence.');
  const payload = payloadWithoutAuthentication(evidence);
  const artifactDigest = sha256Hex(canonicalJson(payload)).toLowerCase();
  invariant(evidence.integrity?.algorithm === 'sha256'
      && evidence.integrity?.canonicalization === 'xpayr-canonical-json-v1'
      && evidence.integrity?.digest_scope === 'canonical_payload_without_integrity_and_authentication'
      && hashesEqual(evidence.integrity?.digest, artifactDigest),
  'POLICY_INTEGRITY_INVALID', 'Policy evidence integrity digest is invalid.');
  const authority = normalizedAddress(evidence.authority_address, 'policy authority');
  const recordId = safeId(evidence.record_id, 'policy record ID');
  const intentId = safeId(evidence.intent_id, 'policy intent ID');
  invariant(['ALLOW', 'HOLD', 'DENY'].includes(evidence.decision), 'INVALID_POLICY_DECISION', 'Unsupported policy decision.');
  const job = normalizedJob(evidence.job);
  const validity = {
    valid_from: safeTimestamp(evidence.validity?.valid_from, 'policy valid-from'),
    valid_until: safeTimestamp(evidence.validity?.valid_until, 'policy valid-until'),
  };
  invariant(validity.valid_from < validity.valid_until && job.expires_at <= validity.valid_until,
    'INVALID_POLICY_VALIDITY', 'Policy validity is inconsistent with the bound job.');
  const ruleset = normalizedRuleset(evidence.ruleset);
  const authorityProfile = normalizedAuthorityProfileReference(evidence.authority_profile);
  invariant(hashesEqual(ruleset.hash, evidence.ruleset?.hash), 'POLICY_RULESET_HASH_INVALID', 'Policy ruleset hash is invalid.');
  const binding = canonicalValue({
    record_id: recordId,
    intent_id: intentId,
    decision: evidence.decision,
    authority_address: authority,
    ruleset_hash: ruleset.hash,
    validity,
    job,
    ...(authorityProfile === null ? {} : { authority_profile: authorityProfile }),
  });
  const bindingDigest = sha256Hex(canonicalJson(binding)).toLowerCase();
  invariant(hashesEqual(evidence.binding_digest, bindingDigest), 'POLICY_BINDING_DIGEST_INVALID', 'Policy binding digest is invalid.');
  const decisionHash = sha256Hex(canonicalJson({
    schema: POLICY_EVIDENCE_SCHEMA,
    network_key: POLICY_NETWORK_KEY,
    chain_id: POLICY_CHAIN_ID,
    binding_digest: bindingDigest,
  })).toLowerCase();
  invariant(hashesEqual(evidence.decision_hash, decisionHash), 'POLICY_DECISION_HASH_INVALID', 'Policy decision hash is invalid.');
  return { artifactDigest, authority, authorityProfile, recordId, intentId, decisionHash, bindingDigest, ruleset, validity, job };
}

export function verifyPolicyEvidence(evidence, { expected = {}, currentTimestamp = null } = {}) {
  const verified = verifyPolicyPayload(evidence);
  invariant(evidence.authentication?.scheme === 'eip712', 'POLICY_AUTHENTICATION_REQUIRED', 'Signed EIP-712 policy authentication is required.');
  const eip712 = evidence.authentication.eip712;
  invariant(eip712 && canonicalJson(eip712.types) === canonicalJson(POLICY_EIP712_TYPES)
      && eip712.primary_type === POLICY_PRIMARY_TYPE,
  'POLICY_TYPED_DATA_INVALID', 'Policy typed-data type declaration is invalid.');
  const expectedTyped = typedDataForEvidence(evidence, verified.artifactDigest);
  invariant(canonicalJson(eip712.domain) === canonicalJson(expectedTyped.domain)
      && canonicalJson(eip712.message) === canonicalJson(expectedTyped.message),
  'POLICY_TYPED_DATA_INVALID', 'Policy typed-data domain or message is invalid.');
  const typedDataDigest = TypedDataEncoder.hash(eip712.domain, eip712.types, eip712.message).toLowerCase();
  invariant(hashesEqual(eip712.typed_data_digest, typedDataDigest), 'POLICY_TYPED_DATA_DIGEST_INVALID', 'Policy typed-data digest is invalid.');
  let parsedSignature;
  let recovered;
  try {
    parsedSignature = Signature.from(eip712.signature);
    invariant(parsedSignature.isValid(), 'POLICY_SIGNATURE_INVALID', 'Policy signature is invalid.');
    recovered = normalizedAddress(
      verifyTypedData(eip712.domain, eip712.types, eip712.message, eip712.signature),
      'recovered policy authority',
    );
  } catch (error) {
    if (error?.code === 'POLICY_SIGNATURE_INVALID') throw error;
    invariant(false, 'POLICY_SIGNATURE_INVALID', 'Policy signature is invalid.');
  }
  const producer = normalizedAddress(evidence.authentication.producer_address, 'policy producer');
  invariant(recovered === verified.authority && producer === verified.authority,
    'POLICY_SIGNATURE_AUTHORITY_MISMATCH', 'Policy signature does not recover the configured authority.');

  if (currentTimestamp !== null && currentTimestamp !== undefined) {
    const current = safeTimestamp(currentTimestamp, 'policy verification timestamp');
    invariant(current >= verified.validity.valid_from && current < verified.validity.valid_until,
      'POLICY_NOT_CURRENTLY_VALID', 'Policy evidence is outside its signed validity window.');
    invariant(current < verified.job.expires_at, 'POLICY_JOB_EXPIRED', 'Policy-bound job has already expired.');
  }
  assertExpected(evidence.network_key, expected.networkKey, 'POLICY_EXPECTED_NETWORK_MISMATCH', 'Policy network differs from the expected network.');
  if (expected.chainId !== undefined) assertExpected(Number(evidence.chain_id), Number(expected.chainId), 'POLICY_EXPECTED_CHAIN_MISMATCH', 'Policy chain differs from the expected chain.');
  if (expected.authority !== undefined) assertExpected(verified.authority, normalizedAddress(expected.authority, 'expected policy authority'), 'POLICY_EXPECTED_AUTHORITY_MISMATCH', 'Policy authority differs from the configured authority.');
  if (expected.authorityProfile !== undefined) {
    const expectedProfile = normalizedAuthorityProfileReference(expected.authorityProfile, { required: true });
    invariant(verified.authorityProfile !== null
        && canonicalJson(verified.authorityProfile) === canonicalJson(expectedProfile),
    'POLICY_EXPECTED_AUTHORITY_PROFILE_MISMATCH', 'Policy authority profile differs from the configured profile.');
  }
  if (expected.escrow !== undefined) assertExpected(verified.job.escrow_contract, normalizedAddress(expected.escrow, 'expected policy escrow'), 'POLICY_EXPECTED_ESCROW_MISMATCH', 'Policy escrow differs from the expected escrow.');
  if (expected.decisionHash !== undefined) assertExpected(verified.decisionHash, normalizedBytes32(expected.decisionHash, 'expected decision hash'), 'POLICY_EXPECTED_DECISION_HASH_MISMATCH', 'Policy decision hash differs from the expected hash.');
  if (expected.recordId !== undefined) assertExpected(verified.recordId, expected.recordId, 'POLICY_EXPECTED_RECORD_MISMATCH', 'Policy record ID differs from the expected record.');
  if (expected.intentId !== undefined) assertExpected(verified.intentId, expected.intentId, 'POLICY_EXPECTED_INTENT_MISMATCH', 'Policy intent ID differs from the expected intent.');
  if (expected.requireExecutable === true) invariant(evidence.decision === 'ALLOW', 'POLICY_NOT_EXECUTABLE', 'Only an authenticated ALLOW policy is executable.');
  const expectedJob = expected.job ?? {};
  const comparisons = [
    ['jobId', 'job_id', (v) => normalizedBytes32(v, 'expected job ID')],
    ['jobNonce', 'job_nonce', (v) => normalizedBytes32(v, 'expected job nonce')],
    ['payer', 'payer', (v) => normalizedAddress(v, 'expected payer')],
    ['provider', 'provider', (v) => normalizedAddress(v, 'expected provider')],
    ['evaluator', 'evaluator', (v) => normalizedAddress(v ?? ZERO_ADDRESS, 'expected evaluator', { allowZero: true })],
    ['valueWei', 'value_wei', (v) => decimal(v, 'expected value', { positive: true })],
    ['expiresAt', 'expires_at', (v) => safeTimestamp(v, 'expected expiry')],
    ['outcome', 'outcome', normalizedOutcome],
    ['deliverableHash', 'deliverable_hash', (v) => normalizedBytes32(v, 'expected deliverable', { allowZero: true })],
  ];
  for (const [camel, snake, normalize] of comparisons) {
    const supplied = expectedValue(expectedJob, camel, snake);
    if (supplied !== undefined && supplied !== null) {
      assertExpected(verified.job[snake], normalize(supplied), 'POLICY_EXPECTED_JOB_MISMATCH', `Policy job ${snake} differs from the expected value.`);
    }
  }
  return Object.freeze({
    schema: POLICY_EVIDENCE_SCHEMA,
    recordId: verified.recordId,
    intentId: verified.intentId,
    decision: evidence.decision,
    policyDecisionHash: verified.decisionHash,
    bindingDigest: verified.bindingDigest,
    artifactDigest: verified.artifactDigest,
    artifactSha256: null,
    typedDataDigest,
    authority: verified.authority,
    authorityProfile: verified.authorityProfile === null ? null : Object.freeze(verified.authorityProfile),
    producerAddress: producer,
    validity: Object.freeze({
      validFrom: verified.validity.valid_from,
      validUntil: verified.validity.valid_until,
    }),
    job: Object.freeze({
      escrow: verified.job.escrow_contract,
      jobId: verified.job.job_id,
      jobNonce: verified.job.job_nonce,
      payer: verified.job.payer,
      provider: verified.job.provider,
      evaluator: verified.job.evaluator,
      valueWei: verified.job.value_wei,
      expiresAt: verified.job.expires_at,
      outcome: verified.job.outcome,
      deliverableHash: verified.job.deliverable_hash,
    }),
    evidence,
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function loadAndVerifyPolicyEvidence({ filePath, expected = {}, currentTimestamp = null, rootDir } = {}) {
  invariant(typeof rootDir === 'string' && path.isAbsolute(rootDir), 'POLICY_ROOT_REQUIRED', 'An absolute module root is required.');
  invariant(typeof filePath === 'string' && filePath !== '' && !path.isAbsolute(filePath)
      && filePath.split(/[\\/]+/).every((part) => part !== '' && part !== '..'),
  'INVALID_POLICY_EVIDENCE_PATH', 'Policy evidence path must be safe and repository-relative.');
  const policyRoot = path.join(rootDir, 'evidence', 'policy');
  const candidate = path.resolve(rootDir, filePath);
  invariant(isInside(policyRoot, candidate), 'POLICY_EVIDENCE_OUTSIDE_ROOT', 'Policy evidence must be under evidence/policy.');
  const lexical = await lstat(candidate);
  invariant(lexical.isFile() && !lexical.isSymbolicLink() && lexical.nlink === 1,
    'POLICY_EVIDENCE_UNSAFE_FILE', 'Policy evidence must be one regular non-linked file.');
  invariant((lexical.mode & 0o777) === 0o600, 'POLICY_EVIDENCE_UNSAFE_MODE', 'Policy evidence permissions must be exactly 0600.');
  const [resolvedRoot, resolvedPolicyRoot, resolved] = await Promise.all([realpath(rootDir), realpath(policyRoot), realpath(candidate)]);
  invariant(isInside(resolvedRoot, resolved) && isInside(resolvedPolicyRoot, resolved),
    'POLICY_EVIDENCE_OUTSIDE_ROOT', 'Resolved policy evidence escaped its allowed root.');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const metadata = await handle.stat();
    invariant(metadata.isFile() && metadata.nlink === 1 && metadata.size > 0 && metadata.size <= MAX_POLICY_FILE_BYTES,
      'POLICY_EVIDENCE_UNSAFE_FILE', 'Policy evidence size or link count is unsafe.');
    invariant((metadata.mode & 0o777) === 0o600, 'POLICY_EVIDENCE_UNSAFE_MODE', 'Policy evidence permissions must remain exactly 0600.');
    raw = await handle.readFile();
  } finally {
    await handle.close();
  }
  let evidence;
  try {
    evidence = JSON.parse(raw.toString('utf8'));
  } catch {
    invariant(false, 'POLICY_EVIDENCE_JSON_INVALID', 'Policy evidence is not valid JSON.');
  }
  const verified = verifyPolicyEvidence(evidence, { expected, currentTimestamp });
  return Object.freeze({
    ...verified,
    artifactSha256: `0x${createHash('sha256').update(raw).digest('hex')}`,
    artifactPath: resolved,
    repositoryRelativePath: path.relative(resolvedRoot, resolved).split(path.sep).join('/'),
  });
}

export async function writePolicyEvidenceExclusive(filePath, evidence) {
  invariant(typeof filePath === 'string' && path.isAbsolute(filePath), 'POLICY_OUTPUT_PATH_REQUIRED', 'An absolute policy output path is required.');
  assertEvidenceSafe(evidence);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonExclusive(filePath, evidence, { mode: 0o600 });
  return filePath;
}
