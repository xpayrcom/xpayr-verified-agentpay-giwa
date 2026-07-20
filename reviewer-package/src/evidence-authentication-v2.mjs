import {
  AbiCoder,
  Signature,
  TypedDataEncoder,
  concat,
  dataSlice,
  getAddress,
  id,
  keccak256,
  verifyTypedData,
} from 'ethers';
import { canonicalJson, canonicalValue, deepClone, hashesEqual, sha256Hex } from './canonical-json.mjs';
import { assertEvidenceSafe } from './evidence.mjs';
import { invariant } from './errors.mjs';
import { verifyPolicyEvidence } from './policy-evidence.mjs';
import { authorityProfileReference } from './authority-profile.mjs';

export const AUTHENTICATED_EVIDENCE_V2_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication.v2';
export const EIP712_DOMAIN_NAME_V2 = 'XPAYR Verified AgentPay Evidence';
export const EIP712_DOMAIN_VERSION_V2 = '2';
export const EIP712_PRIMARY_TYPE_V2 = 'EvidenceAuthenticationV2';
export const ANCHOR_MAGIC_V2 = '0x58504132'; // ASCII XPA2
export const AUTHENTICATION_SCHEMA_HASH_V2 = id(AUTHENTICATED_EVIDENCE_V2_SCHEMA).toLowerCase();
export const GIWA_CHAIN_ID_V2 = 91342;
export const GIWA_NETWORK_KEY_V2 = 'giwa-testnet';

export const EVIDENCE_AUTHENTICATION_TYPES_V2 = Object.freeze({
  [EIP712_PRIMARY_TYPE_V2]: Object.freeze([
    Object.freeze({ name: 'schemaHash', type: 'bytes32' }),
    Object.freeze({ name: 'evidenceDigest', type: 'bytes32' }),
    Object.freeze({ name: 'sourceFileSha256', type: 'bytes32' }),
    Object.freeze({ name: 'runIdHash', type: 'bytes32' }),
    Object.freeze({ name: 'jobId', type: 'bytes32' }),
    Object.freeze({ name: 'policyDecisionHash', type: 'bytes32' }),
    Object.freeze({ name: 'policyEnvelopeDigest', type: 'bytes32' }),
    Object.freeze({ name: 'authorityProfileDigest', type: 'bytes32' }),
    Object.freeze({ name: 'policyAuthority', type: 'address' }),
    Object.freeze({ name: 'outcomeHash', type: 'bytes32' }),
    Object.freeze({ name: 'terminalTxHash', type: 'bytes32' }),
    Object.freeze({ name: 'attestationId', type: 'bytes32' }),
    Object.freeze({ name: 'producer', type: 'address' }),
  ]),
});

const ABI_CODER = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,79}$/;
const LIFECYCLE_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence.v1';

function normalizedAddress(value, field, { nonzero = true } = {}) {
  let result;
  try {
    result = getAddress(value).toLowerCase();
  } catch {
    invariant(false, 'INVALID_AUTH_V2_ADDRESS', `${field} must be a valid EVM address.`);
  }
  invariant(!nonzero || result !== ZERO_ADDRESS, 'ZERO_AUTH_V2_ADDRESS', `${field} cannot be zero.`);
  return result;
}

function normalizedBytes32(value, field) {
  invariant(typeof value === 'string' && BYTES32_PATTERN.test(value),
    'INVALID_AUTH_V2_BYTES32', `${field} must be bytes32.`);
  return value.toLowerCase();
}

function normalizedDecimal(value, field, { allowZero = true } = {}) {
  invariant(typeof value === 'string' && DECIMAL_PATTERN.test(value),
    'INVALID_AUTH_V2_DECIMAL', `${field} must be a base-10 integer string.`);
  invariant(allowZero || BigInt(value) > 0n, 'ZERO_AUTH_V2_DECIMAL', `${field} must be positive.`);
  return value;
}

function safeInteger(value, field, { positive = false } = {}) {
  invariant(Number.isSafeInteger(value) && (!positive || value > 0),
    'INVALID_AUTH_V2_INTEGER', `${field} must be a safe${positive ? ' positive' : ''} integer.`);
  return value;
}

function parseQuantity(value, field) {
  try {
    const parsed = BigInt(value);
    invariant(parsed >= 0n, 'INVALID_AUTH_V2_QUANTITY', `${field} cannot be negative.`);
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    invariant(false, 'INVALID_AUTH_V2_QUANTITY', `${field} must be an integer quantity.`);
  }
}

function normalizeFileSha256(value) {
  return normalizedBytes32(typeof value === 'string' && value.startsWith('0x') ? value : `0x${value ?? ''}`,
    'source file SHA-256');
}

function payloadDigest(envelope, label) {
  invariant(envelope && typeof envelope === 'object' && !Array.isArray(envelope),
    'INVALID_AUTH_V2_ARTIFACT', `${label} is required.`);
  assertEvidenceSafe(envelope);
  const clean = deepClone(envelope);
  const integrity = clean.integrity;
  delete clean.integrity;
  invariant(integrity?.algorithm === 'sha256'
      && integrity?.canonicalization === 'xpayr-canonical-json-v1',
  'INVALID_AUTH_V2_INTEGRITY', `${label} integrity metadata is invalid.`);
  const digest = sha256Hex(canonicalJson(clean)).toLowerCase();
  invariant(hashesEqual(integrity?.digest, digest),
    'INVALID_AUTH_V2_INTEGRITY', `${label} integrity digest is invalid.`);
  return { digest, payload: clean };
}

function assertProfile(profile) {
  invariant(profile?.profileId === 'phase4_sod_v1'
      && profile?.status === 'active'
      && BYTES32_PATTERN.test(profile?.digest ?? '')
      && profile?.policyAuthorityAddress
      && profile?.evidenceProducerAddress,
  'AUTH_V2_PROFILE_REQUIRED', 'An active validated phase4_sod_v1 profile is required.');
  return profile;
}

export function validateLifecycleEvidenceV2(evidence, { authorityProfile } = {}) {
  const profile = assertProfile(authorityProfile);
  const verified = payloadDigest(evidence, 'Lifecycle evidence');
  invariant(evidence.schema === LIFECYCLE_SCHEMA
      && evidence.evidence_level === 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy_sod_v1'
      && evidence.network_key === GIWA_NETWORK_KEY_V2
      && Number(evidence.chain_id) === GIWA_CHAIN_ID_V2,
  'INVALID_AUTH_V2_LIFECYCLE', 'Lifecycle evidence is not a Phase-4 SoD GIWA Sepolia artifact.');
  invariant(typeof evidence.run_id === 'string' && SAFE_RUN_ID_PATTERN.test(evidence.run_id),
    'INVALID_AUTH_V2_LIFECYCLE', 'Lifecycle evidence run ID is unsafe.');
  const outcome = evidence.outcome;
  invariant(outcome === 'RELEASED' || outcome === 'REFUNDED',
    'INVALID_AUTH_V2_LIFECYCLE', 'Lifecycle outcome is not terminal.');
  invariant(outcome === 'RELEASED'
    ? evidence.payment_completed === true && evidence.refunded === false
    : evidence.payment_completed === false && evidence.refunded === true,
  'INVALID_AUTH_V2_LIFECYCLE', 'Lifecycle payment classification is inconsistent.');
  invariant(evidence.canonical_terminal?.canonical_terminal_verified === true
      && evidence.canonical_terminal?.terminal === true
      && evidence.canonical_step_receipts?.all_steps_canonical === true
      && evidence.boundaries?.testnet_only === true
      && evidence.boundaries?.real_customer_funds === false,
  'INVALID_AUTH_V2_LIFECYCLE', 'Lifecycle evidence lacks canonical testnet proof.');
  const job = evidence.job ?? {};
  const normalizedJob = canonicalValue({
    job_id: normalizedBytes32(job.job_id, 'lifecycle job ID'),
    job_nonce: normalizedBytes32(job.job_nonce, 'lifecycle job nonce'),
    payer: normalizedAddress(job.payer, 'lifecycle payer'),
    provider: normalizedAddress(job.provider, 'lifecycle provider'),
    evaluator: normalizedAddress(job.evaluator ?? ZERO_ADDRESS, 'lifecycle evaluator', { nonzero: false }),
    value_wei: normalizedDecimal(job.value_wei, 'lifecycle value', { allowZero: false }),
    expires_at: safeInteger(job.expires_at, 'lifecycle expiry', { positive: true }),
    policy_decision_hash: normalizedBytes32(job.policy_decision_hash, 'lifecycle policy decision hash'),
    deliverable_hash: normalizedBytes32(job.deliverable_hash, 'lifecycle deliverable hash'),
  });
  const origin = evidence.policy_origin;
  const expectedKeys = [
    'artifact_digest', 'artifact_path', 'artifact_sha256', 'authentication',
    'authority_address', 'authority_profile_digest', 'authority_profile_id',
    'binding_digest', 'evidence_producer_address', 'intent_id', 'mode',
    'policy_decision_hash', 'producer_address', 'record_id',
    'same_wallet_testnet_authority', 'separation_of_duties', 'signature_verified',
    'signed_job_expires_at', 'typed_data_digest', 'valid_from', 'valid_until',
  ].sort();
  invariant(origin && typeof origin === 'object' && !Array.isArray(origin)
      && canonicalJson(Object.keys(origin).sort()) === canonicalJson(expectedKeys),
  'AUTH_V2_POLICY_ORIGIN_INVALID', 'Lifecycle SoD policy origin fields are not the exact v2 set.');
  invariant(origin.mode === 'eip712_phase4_sod_policy_artifact'
      && origin.authentication === 'eip712_phase4_sod_policy_authority_verified'
      && origin.signature_verified === true
      && origin.same_wallet_testnet_authority === false
      && origin.separation_of_duties === true
      && origin.authority_profile_id === profile.profileId
      && normalizedBytes32(origin.authority_profile_digest, 'profile digest') === profile.digest,
  'AUTH_V2_POLICY_ORIGIN_INVALID', 'Lifecycle SoD policy origin flags or profile binding are invalid.');
  invariant(typeof origin.artifact_path === 'string'
      && /^evidence\/policy\/[A-Za-z0-9][A-Za-z0-9._-]{7,79}\.policy\.json$/.test(origin.artifact_path)
      && typeof origin.record_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(origin.record_id)
      && typeof origin.intent_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(origin.intent_id),
  'AUTH_V2_POLICY_ORIGIN_INVALID', 'Lifecycle SoD policy references are invalid.');
  const normalizedOrigin = canonicalValue({
    ...origin,
    artifact_digest: normalizedBytes32(origin.artifact_digest, 'policy artifact digest'),
    artifact_sha256: normalizeFileSha256(origin.artifact_sha256),
    authority_address: normalizedAddress(origin.authority_address, 'policy authority'),
    producer_address: normalizedAddress(origin.producer_address, 'policy signature producer'),
    evidence_producer_address: normalizedAddress(origin.evidence_producer_address, 'evidence producer'),
    authority_profile_digest: normalizedBytes32(origin.authority_profile_digest, 'authority profile digest'),
    typed_data_digest: normalizedBytes32(origin.typed_data_digest, 'policy typed-data digest'),
    binding_digest: normalizedBytes32(origin.binding_digest, 'policy binding digest'),
    policy_decision_hash: normalizedBytes32(origin.policy_decision_hash, 'policy decision hash'),
    valid_from: safeInteger(origin.valid_from, 'policy valid-from', { positive: true }),
    valid_until: safeInteger(origin.valid_until, 'policy valid-until', { positive: true }),
    signed_job_expires_at: safeInteger(origin.signed_job_expires_at, 'policy job expiry', { positive: true }),
  });
  invariant(normalizedOrigin.authority_address === profile.policyAuthorityAddress
      && normalizedOrigin.producer_address === profile.policyAuthorityAddress
      && normalizedOrigin.evidence_producer_address === profile.evidenceProducerAddress
      && normalizedOrigin.policy_decision_hash === normalizedJob.policy_decision_hash
      && normalizedOrigin.signed_job_expires_at === normalizedJob.expires_at
      && normalizedOrigin.valid_from < normalizedOrigin.valid_until
      && normalizedOrigin.signed_job_expires_at <= normalizedOrigin.valid_until,
  'AUTH_V2_POLICY_ORIGIN_INVALID', 'Lifecycle SoD policy origin is internally inconsistent.');
  const distinct = [
    normalizedJob.payer,
    normalizedJob.provider,
    ...(normalizedJob.evaluator === ZERO_ADDRESS ? [] : [normalizedJob.evaluator]),
    normalizedOrigin.authority_address,
    normalizedOrigin.evidence_producer_address,
  ];
  invariant(new Set(distinct).size === distinct.length,
    'AUTH_V2_ROLE_COLLISION', 'Lifecycle and authority roles must be mutually distinct.');
  return canonicalValue({
    evidence_digest: verified.digest,
    run_id: evidence.run_id,
    escrow_contract: normalizedAddress(evidence.escrow_contract, 'lifecycle escrow'),
    outcome,
    terminal_transaction_hash: normalizedBytes32(
      evidence.canonical_terminal?.transaction_hash,
      'terminal transaction hash',
    ),
    job: normalizedJob,
    policy_origin: normalizedOrigin,
    authority_profile: {
      profile_id: profile.profileId,
      profile_digest: profile.digest,
      policy_authority_address: profile.policyAuthorityAddress,
      evidence_producer_address: profile.evidenceProducerAddress,
    },
  });
}

export function validateSignedPolicyArtifactV2(policyArtifact, lifecycleBinding, {
  authorityProfile,
  policyArtifactPath,
  policyFileSha256,
} = {}) {
  const profile = assertProfile(authorityProfile);
  const expected = lifecycleBinding.job;
  const strict = verifyPolicyEvidence(policyArtifact, {
    currentTimestamp: null,
    expected: {
      networkKey: GIWA_NETWORK_KEY_V2,
      chainId: GIWA_CHAIN_ID_V2,
      authority: profile.policyAuthorityAddress,
      authorityProfile: authorityProfileReference(profile),
      escrow: lifecycleBinding.escrow_contract,
      decisionHash: expected.policy_decision_hash,
      requireExecutable: true,
      job: {
        jobId: expected.job_id,
        jobNonce: expected.job_nonce,
        payer: expected.payer,
        provider: expected.provider,
        evaluator: expected.evaluator,
        valueWei: expected.value_wei,
        expiresAt: expected.expires_at,
        outcome: lifecycleBinding.outcome,
        deliverableHash: expected.deliverable_hash,
      },
    },
  });
  const origin = lifecycleBinding.policy_origin;
  invariant(policyArtifactPath === origin.artifact_path
      && normalizeFileSha256(policyFileSha256) === origin.artifact_sha256
      && strict.artifactDigest === origin.artifact_digest
      && strict.recordId === origin.record_id
      && strict.intentId === origin.intent_id
      && strict.authority === origin.authority_address
      && strict.producerAddress === origin.producer_address
      && strict.typedDataDigest === origin.typed_data_digest
      && strict.bindingDigest === origin.binding_digest
      && strict.policyDecisionHash === origin.policy_decision_hash
      && strict.validity.validFrom === origin.valid_from
      && strict.validity.validUntil === origin.valid_until
      && strict.job.expiresAt === origin.signed_job_expires_at,
  'AUTH_V2_POLICY_BINDING_MISMATCH', 'Signed policy artifact does not match the SoD lifecycle origin.');
  const binding = canonicalValue({
    escrow_contract: lifecycleBinding.escrow_contract,
    decision: strict.decision,
    decision_hash: strict.policyDecisionHash,
    job_id: strict.job.jobId,
    job_nonce: strict.job.jobNonce,
    payer: strict.job.payer,
    provider: strict.job.provider,
    evaluator: strict.job.evaluator,
    value_wei: strict.job.valueWei,
    expires_at: strict.job.expiresAt,
    outcome: strict.job.outcome,
    deliverable_hash: strict.job.deliverableHash,
    authority_profile: authorityProfileReference(profile),
  });
  return canonicalValue({
    schema: strict.schema,
    digest: strict.artifactDigest,
    binding_digest: sha256Hex(canonicalJson(binding)).toLowerCase(),
    signed_policy_binding_digest: strict.bindingDigest,
    binding,
    authentication: {
      producer_address: strict.producerAddress,
      recovered_address: strict.authority,
      typed_data_digest: strict.typedDataDigest,
      primary_type: policyArtifact.authentication.eip712.primary_type,
    },
    authority_profile: authorityProfileReference(profile),
  });
}

export function buildAuthenticationMessageV2({
  lifecycleBinding,
  sourceFileSha256,
  policyEnvelopeDigest,
  producer,
  authorityProfile,
}) {
  const profile = assertProfile(authorityProfile);
  const normalizedProducer = normalizedAddress(producer, 'evidence producer');
  invariant(normalizedProducer === profile.evidenceProducerAddress,
    'AUTH_V2_PRODUCER_MISMATCH', 'Evidence producer differs from the sealed SoD profile.');
  const sourceDigest = normalizeFileSha256(sourceFileSha256);
  const policyDigest = normalizedBytes32(policyEnvelopeDigest, 'policy envelope digest');
  const attestationId = keccak256(ABI_CODER.encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'address', 'address', 'uint256', 'address'],
    [
      AUTHENTICATION_SCHEMA_HASH_V2,
      lifecycleBinding.evidence_digest,
      sourceDigest,
      policyDigest,
      profile.digest,
      profile.policyAuthorityAddress,
      normalizedProducer,
      GIWA_CHAIN_ID_V2,
      lifecycleBinding.escrow_contract,
    ],
  )).toLowerCase();
  const message = canonicalValue({
    schemaHash: AUTHENTICATION_SCHEMA_HASH_V2,
    evidenceDigest: lifecycleBinding.evidence_digest,
    sourceFileSha256: sourceDigest,
    runIdHash: id(lifecycleBinding.run_id).toLowerCase(),
    jobId: lifecycleBinding.job.job_id,
    policyDecisionHash: lifecycleBinding.job.policy_decision_hash,
    policyEnvelopeDigest: policyDigest,
    authorityProfileDigest: profile.digest,
    policyAuthority: profile.policyAuthorityAddress,
    outcomeHash: id(lifecycleBinding.outcome).toLowerCase(),
    terminalTxHash: lifecycleBinding.terminal_transaction_hash,
    attestationId,
    producer: normalizedProducer,
  });
  const domain = canonicalValue({
    name: EIP712_DOMAIN_NAME_V2,
    version: EIP712_DOMAIN_VERSION_V2,
    chainId: GIWA_CHAIN_ID_V2,
    verifyingContract: lifecycleBinding.escrow_contract,
  });
  return canonicalValue({
    domain,
    primary_type: EIP712_PRIMARY_TYPE_V2,
    types: EVIDENCE_AUTHENTICATION_TYPES_V2,
    message,
    typed_data_digest: TypedDataEncoder.hash(domain, EVIDENCE_AUTHENTICATION_TYPES_V2, message).toLowerCase(),
    attestation_id: attestationId,
  });
}

export async function signAuthenticationMessageV2(authentication, signer) {
  invariant(signer && typeof signer.signTypedData === 'function' && typeof signer.getAddress === 'function',
    'AUTH_V2_SIGNER_REQUIRED', 'Evidence producer signer is required.');
  const expected = normalizedAddress(authentication?.message?.producer, 'authentication producer');
  invariant(normalizedAddress(await signer.getAddress(), 'authentication signer') === expected,
    'AUTH_V2_SIGNER_MISMATCH', 'Evidence producer signer does not match the authentication message.');
  const signature = await signer.signTypedData(authentication.domain, authentication.types, authentication.message);
  return verifyAuthenticationSignatureV2({ ...authentication, signature }, { expectedProducer: expected });
}

export function verifyAuthenticationSignatureV2(authentication, { expectedProducer = null } = {}) {
  invariant(authentication?.primary_type === EIP712_PRIMARY_TYPE_V2
      && canonicalJson(authentication?.types) === canonicalJson(EVIDENCE_AUTHENTICATION_TYPES_V2)
      && authentication?.domain?.name === EIP712_DOMAIN_NAME_V2
      && authentication?.domain?.version === EIP712_DOMAIN_VERSION_V2
      && Number(authentication?.domain?.chainId) === GIWA_CHAIN_ID_V2,
  'INVALID_AUTH_V2_SIGNATURE', 'Evidence authentication typed data is invalid.');
  const producer = normalizedAddress(authentication.message?.producer, 'authentication producer');
  if (expectedProducer !== null) {
    invariant(producer === normalizedAddress(expectedProducer, 'expected evidence producer'),
      'INVALID_AUTH_V2_SIGNATURE', 'Evidence authentication producer is unexpected.');
  }
  const digest = TypedDataEncoder.hash(authentication.domain, EVIDENCE_AUTHENTICATION_TYPES_V2, authentication.message).toLowerCase();
  invariant(hashesEqual(authentication.typed_data_digest, digest),
    'INVALID_AUTH_V2_SIGNATURE', 'Evidence authentication typed-data digest is invalid.');
  let parsed;
  let recovered;
  try {
    parsed = Signature.from(authentication.signature);
    invariant(parsed.isValid(), 'INVALID_AUTH_V2_SIGNATURE', 'Evidence producer signature is invalid.');
    recovered = normalizedAddress(verifyTypedData(
      authentication.domain,
      EVIDENCE_AUTHENTICATION_TYPES_V2,
      authentication.message,
      parsed.serialized,
    ), 'recovered evidence producer');
  } catch (error) {
    if (error?.code === 'INVALID_AUTH_V2_SIGNATURE') throw error;
    invariant(false, 'INVALID_AUTH_V2_SIGNATURE', 'Evidence producer signature is invalid.');
  }
  invariant(recovered === producer, 'INVALID_AUTH_V2_SIGNATURE', 'Evidence signature does not recover its producer.');
  return canonicalValue({
    ...authentication,
    typed_data_digest: digest,
    signature: parsed.serialized,
    signature_hash: keccak256(parsed.serialized).toLowerCase(),
    recovered_address: recovered,
    signature_verified: true,
  });
}

export function encodeAnchorCalldataV2(authentication) {
  const verified = verifyAuthenticationSignatureV2(authentication, {
    expectedProducer: authentication?.message?.producer,
  });
  return concat([
    ANCHOR_MAGIC_V2,
    ABI_CODER.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        AUTHENTICATION_SCHEMA_HASH_V2,
        verified.message.attestationId,
        verified.message.evidenceDigest,
        verified.message.sourceFileSha256,
        verified.message.authorityProfileDigest,
        verified.typed_data_digest,
        verified.signature_hash,
      ],
    ),
  ]).toLowerCase();
}

export function decodeAnchorCalldataV2(calldata) {
  invariant(typeof calldata === 'string' && calldata.startsWith(ANCHOR_MAGIC_V2)
      && (calldata.length - 2) / 2 === 228,
  'INVALID_AUTH_V2_ANCHOR_CALLDATA', 'XPA2 anchor calldata is invalid.');
  const decoded = ABI_CODER.decode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    dataSlice(calldata, 4),
  );
  const result = canonicalValue({
    schema_hash: normalizedBytes32(decoded[0], 'anchor schema hash'),
    attestation_id: normalizedBytes32(decoded[1], 'anchor attestation ID'),
    evidence_digest: normalizedBytes32(decoded[2], 'anchor evidence digest'),
    source_file_sha256: normalizedBytes32(decoded[3], 'anchor source SHA-256'),
    authority_profile_digest: normalizedBytes32(decoded[4], 'anchor authority profile digest'),
    typed_data_digest: normalizedBytes32(decoded[5], 'anchor typed-data digest'),
    signature_hash: normalizedBytes32(decoded[6], 'anchor signature hash'),
  });
  invariant(result.schema_hash === AUTHENTICATION_SCHEMA_HASH_V2,
    'INVALID_AUTH_V2_ANCHOR_CALLDATA', 'XPA2 anchor schema hash is invalid.');
  return result;
}

function transactionData(transaction) {
  return String(transaction?.data ?? transaction?.input ?? '').toLowerCase();
}

export async function verifyCanonicalAnchorV2({
  provider,
  transactionHash,
  authentication,
  requiredConfirmations = 1,
  expectedNonce = null,
}) {
  const verified = verifyAuthenticationSignatureV2(authentication, {
    expectedProducer: authentication?.message?.producer,
  });
  const expectedHash = normalizedBytes32(transactionHash, 'anchor transaction hash');
  safeInteger(requiredConfirmations, 'required confirmations', { positive: true });
  const [network, receipt, transaction] = await Promise.all([
    provider.getNetwork(),
    provider.getTransactionReceipt(expectedHash),
    provider.getTransaction(expectedHash),
  ]);
  invariant(Number(network.chainId) === GIWA_CHAIN_ID_V2 && receipt && transaction,
    'AUTH_V2_ANCHOR_NOT_FOUND', 'Canonical XPA2 anchor is unavailable on GIWA Sepolia.');
  invariant(String(receipt.hash ?? receipt.transactionHash).toLowerCase() === expectedHash
      && String(transaction.hash).toLowerCase() === expectedHash,
  'AUTH_V2_ANCHOR_HASH_MISMATCH', 'XPA2 anchor hash is inconsistent.');
  const producer = normalizedAddress(verified.message.producer, 'anchor producer');
  invariant(normalizedAddress(transaction.from, 'anchor sender') === producer
      && normalizedAddress(transaction.to, 'anchor recipient') === producer
      && (receipt.from === undefined || normalizedAddress(receipt.from, 'receipt sender') === producer)
      && (receipt.to === undefined || receipt.to === null || normalizedAddress(receipt.to, 'receipt recipient') === producer),
  'AUTH_V2_ANCHOR_PARTY_MISMATCH', 'XPA2 anchor must be the producer EOA self-transaction.');
  invariant(parseQuantity(transaction.value ?? 0, 'anchor value') === 0n
      && Number(transaction.type) === 2
      && (transaction.chainId === undefined || Number(transaction.chainId) === GIWA_CHAIN_ID_V2),
  'AUTH_V2_ANCHOR_TRANSACTION_INVALID', 'XPA2 anchor transaction fields are invalid.');
  if (expectedNonce !== null) {
    invariant(Number(transaction.nonce) === Number(expectedNonce),
      'AUTH_V2_ANCHOR_NONCE_MISMATCH', 'XPA2 anchor nonce is invalid.');
  }
  const calldata = encodeAnchorCalldataV2(verified);
  invariant(transactionData(transaction) === calldata,
    'AUTH_V2_ANCHOR_CALLDATA_MISMATCH', 'XPA2 anchor calldata does not match the producer signature.');
  const decoded = decodeAnchorCalldataV2(calldata);
  invariant(decoded.attestation_id === verified.message.attestationId
      && decoded.evidence_digest === verified.message.evidenceDigest
      && decoded.source_file_sha256 === verified.message.sourceFileSha256
      && decoded.authority_profile_digest === verified.message.authorityProfileDigest
      && decoded.typed_data_digest === verified.typed_data_digest
      && decoded.signature_hash === verified.signature_hash
      && Number(receipt.status) === 1,
  'AUTH_V2_ANCHOR_CALLDATA_MISMATCH', 'XPA2 decoded fields or receipt status are invalid.');
  const blockNumber = safeInteger(Number(receipt.blockNumber), 'anchor block number', { positive: true });
  const blockHash = normalizedBytes32(receipt.blockHash, 'anchor block hash');
  invariant(Number(transaction.blockNumber) === blockNumber
      && normalizedBytes32(transaction.blockHash, 'transaction block hash') === blockHash,
  'AUTH_V2_ANCHOR_BLOCK_MISMATCH', 'XPA2 transaction block membership is invalid.');
  const blockBefore = await provider.getBlock(blockNumber);
  invariant(Number(blockBefore?.number) === blockNumber
      && normalizedBytes32(blockBefore?.hash, 'canonical block hash') === blockHash,
  'AUTH_V2_ANCHOR_NOT_CANONICAL', 'XPA2 receipt block is not canonical.');
  const producerCode = await provider.send('eth_getCode', [producer, { blockHash, requireCanonical: true }]);
  invariant(producerCode === '0x', 'AUTH_V2_PRODUCER_NOT_EOA', 'Evidence producer was not an EOA at the anchor block.');
  const blockAfter = await provider.getBlock(blockNumber);
  invariant(Number(blockAfter?.number) === blockNumber
      && normalizedBytes32(blockAfter?.hash, 'canonical block recheck hash') === blockHash,
  'AUTH_V2_ANCHOR_NOT_CANONICAL', 'XPA2 anchor block changed during verification.');
  const head = safeInteger(Number(await provider.getBlockNumber()), 'canonical head', { positive: true });
  const confirmations = head - blockNumber + 1;
  invariant(confirmations >= requiredConfirmations,
    'AUTH_V2_CONFIRMATIONS_INSUFFICIENT', 'XPA2 anchor lacks required confirmations.');
  return canonicalValue({
    scheme: 'giwa_eoa_self_transaction_calldata_v2',
    transaction_hash: expectedHash,
    from: producer,
    to: producer,
    value_wei: '0',
    transaction_type: 2,
    nonce: Number(transaction.nonce),
    calldata,
    calldata_bytes: (calldata.length - 2) / 2,
    decoded,
    receipt_status: 1,
    block_number: blockNumber,
    block_hash: blockHash,
    block_timestamp: safeInteger(Number(blockBefore.timestamp), 'anchor block timestamp', { positive: true }),
    confirmations,
    confirmations_required: requiredConfirmations,
    canonical_block_refetched_twice: true,
    producer_code_at_receipt_block: '0x',
    producer_was_eoa_at_receipt_block: true,
    explorer_url: `https://sepolia-explorer.giwa.io/tx/${expectedHash}`,
    gas_used: parseQuantity(receipt.gasUsed ?? 0, 'anchor gas used').toString(),
    effective_gas_price_wei: parseQuantity(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0, 'anchor gas price').toString(),
  });
}

export function buildAuthenticatedSidecarV2({
  lifecycleEvidencePath,
  lifecycleBinding,
  sourceFileSha256,
  policyArtifactPath,
  validatedPolicy,
  authentication,
  anchor,
  authorityProfile,
  createdAt = new Date().toISOString(),
}) {
  const profile = assertProfile(authorityProfile);
  const verified = verifyAuthenticationSignatureV2(authentication, {
    expectedProducer: profile.evidenceProducerAddress,
  });
  invariant(validatedPolicy?.digest === verified.message.policyEnvelopeDigest
      && verified.message.authorityProfileDigest === profile.digest
      && verified.message.policyAuthority === profile.policyAuthorityAddress
      && anchor?.decoded?.attestation_id === verified.message.attestationId
      && anchor?.decoded?.typed_data_digest === verified.typed_data_digest
      && anchor?.decoded?.authority_profile_digest === profile.digest
      && anchor?.receipt_status === 1,
  'AUTH_V2_SIDECAR_BINDING_MISMATCH', 'Authenticated evidence does not bind its policy, profile, signature and anchor.');
  const payload = canonicalValue({
    schema: AUTHENTICATED_EVIDENCE_V2_SCHEMA,
    evidence_level: 'canonical_giwa_sepolia_lifecycle_receipts_sod_producer_signed_and_onchain_anchored',
    created_at: new Date(createdAt).toISOString(),
    network_key: GIWA_NETWORK_KEY_V2,
    chain_id: GIWA_CHAIN_ID_V2,
    escrow_contract: lifecycleBinding.escrow_contract,
    run_id: lifecycleBinding.run_id,
    authority_profile: {
      profile_id: profile.profileId,
      profile_digest: profile.digest,
      policy_authority_address: profile.policyAuthorityAddress,
      evidence_producer_address: profile.evidenceProducerAddress,
      separation_of_duties: true,
    },
    source: {
      path: lifecycleEvidencePath,
      schema: LIFECYCLE_SCHEMA,
      file_sha256: normalizeFileSha256(sourceFileSha256),
      evidence_digest: lifecycleBinding.evidence_digest,
      terminal_transaction_hash: lifecycleBinding.terminal_transaction_hash,
      outcome: lifecycleBinding.outcome,
      job_id: lifecycleBinding.job.job_id,
    },
    policy: {
      path: policyArtifactPath,
      schema: validatedPolicy.schema,
      artifact_digest: validatedPolicy.digest,
      binding_digest: validatedPolicy.binding_digest,
      decision: validatedPolicy.binding.decision,
      decision_hash: validatedPolicy.binding.decision_hash,
      authority_address: profile.policyAuthorityAddress,
      producer_signature_verified: true,
    },
    producer: {
      address: profile.evidenceProducerAddress,
      role: 'independent_evidence_producer_testnet_eoa',
      identity_claim: 'address_control_only',
      up_id_is_authentication: false,
      signature_scheme: 'eip712_secp256k1',
      domain: verified.domain,
      primary_type: verified.primary_type,
      types: verified.types,
      message: verified.message,
      typed_data_digest: verified.typed_data_digest,
      signature: verified.signature,
      signature_hash: verified.signature_hash,
      recovered_address: verified.recovered_address,
      signature_verified: true,
    },
    anchor,
    checks: {
      source_integrity_valid: true,
      source_exact_file_hash_bound: true,
      signed_policy_artifact_valid: true,
      authority_profile_digest_bound: true,
      policy_authority_distinct: true,
      evidence_producer_distinct: true,
      policy_lifecycle_binding_exact: true,
      producer_signature_valid: true,
      producer_is_lifecycle_payer: false,
      anchor_transaction_canonical: true,
      anchor_self_transaction_exact: true,
      anchor_value_zero: true,
      anchor_producer_was_eoa: true,
      anchor_calldata_signature_bound: true,
    },
    overall_authenticated: true,
    boundaries: {
      testnet_only: true,
      real_customer_funds: false,
      source_evidence_modified: false,
      raw_signed_transaction_persisted: false,
      private_keys_persisted: false,
      producer_claim: 'control_of_separate_named_eoa_at_signature_and_anchor_time',
      organization_identity_claimed: false,
      legal_non_repudiation_claimed: false,
      searchable_registry_claimed: false,
    },
  });
  assertEvidenceSafe(payload);
  return canonicalValue({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      digest: sha256Hex(canonicalJson(payload)).toLowerCase(),
    },
  });
}

export function verifyAuthenticatedSidecarV2({
  sidecar,
  lifecycleBinding,
  sourceFileSha256,
  validatedPolicy,
  authorityProfile,
}) {
  const profile = assertProfile(authorityProfile);
  const verifiedPayload = payloadDigest(sidecar, 'Authenticated evidence v2 sidecar');
  invariant(sidecar.schema === AUTHENTICATED_EVIDENCE_V2_SCHEMA
      && sidecar.network_key === GIWA_NETWORK_KEY_V2
      && Number(sidecar.chain_id) === GIWA_CHAIN_ID_V2
      && sidecar.overall_authenticated === true
      && sidecar.authority_profile?.profile_id === profile.profileId
      && sidecar.authority_profile?.profile_digest === profile.digest
      && sidecar.authority_profile?.policy_authority_address === profile.policyAuthorityAddress
      && sidecar.authority_profile?.evidence_producer_address === profile.evidenceProducerAddress
      && sidecar.source?.evidence_digest === lifecycleBinding.evidence_digest
      && sidecar.source?.file_sha256 === normalizeFileSha256(sourceFileSha256)
      && sidecar.source?.job_id === lifecycleBinding.job.job_id
      && sidecar.source?.terminal_transaction_hash === lifecycleBinding.terminal_transaction_hash
      && sidecar.policy?.artifact_digest === validatedPolicy.digest
      && sidecar.policy?.binding_digest === validatedPolicy.binding_digest,
  'INVALID_AUTH_V2_SIDECAR', 'Authenticated evidence v2 metadata or binding is invalid.');
  const authentication = verifyAuthenticationSignatureV2({
    domain: sidecar.producer?.domain,
    primary_type: sidecar.producer?.primary_type,
    types: sidecar.producer?.types,
    message: sidecar.producer?.message,
    typed_data_digest: sidecar.producer?.typed_data_digest,
    signature: sidecar.producer?.signature,
  }, { expectedProducer: profile.evidenceProducerAddress });
  invariant(sidecar.anchor?.decoded?.attestation_id === authentication.message.attestationId
      && sidecar.anchor?.decoded?.typed_data_digest === authentication.typed_data_digest
      && sidecar.anchor?.decoded?.authority_profile_digest === profile.digest
      && sidecar.anchor?.transaction_hash
      && sidecar.anchor?.receipt_status === 1,
  'INVALID_AUTH_V2_SIDECAR', 'Authenticated evidence v2 anchor binding is invalid.');
  return canonicalValue({
    valid: true,
    schema: AUTHENTICATED_EVIDENCE_V2_SCHEMA,
    digest: verifiedPayload.digest,
    producer_authenticated: true,
    producer_address: authentication.recovered_address,
    policy_authority_address: profile.policyAuthorityAddress,
    authority_profile_digest: profile.digest,
    anchor_transaction_hash: sidecar.anchor.transaction_hash,
    attestation_id: authentication.message.attestationId,
  });
}
