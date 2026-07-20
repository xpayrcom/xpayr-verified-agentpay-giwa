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

export const AUTHENTICATED_EVIDENCE_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence-authentication.v1';
export const LIFECYCLE_EVIDENCE_SCHEMA = 'xpayr.giwa.agentpay.lifecycle-evidence.v1';
export const POLICY_ENVELOPE_SCHEMA = 'xpayr.giwa.agentpay.policy-evidence.v1';
export const EIP712_DOMAIN_NAME = 'XPAYR Verified AgentPay Evidence';
export const EIP712_DOMAIN_VERSION = '1';
export const EIP712_PRIMARY_TYPE = 'EvidenceAuthentication';
export const GIWA_CHAIN_ID = 91342;
export const GIWA_NETWORK_KEY = 'giwa-testnet';
export const ANCHOR_MAGIC = '0x58504131'; // ASCII XPA1
export const AUTHENTICATION_SCHEMA_HASH = id(AUTHENTICATED_EVIDENCE_SCHEMA).toLowerCase();

export const EVIDENCE_AUTHENTICATION_TYPES = Object.freeze({
  [EIP712_PRIMARY_TYPE]: Object.freeze([
    Object.freeze({ name: 'schemaHash', type: 'bytes32' }),
    Object.freeze({ name: 'evidenceDigest', type: 'bytes32' }),
    Object.freeze({ name: 'sourceFileSha256', type: 'bytes32' }),
    Object.freeze({ name: 'runIdHash', type: 'bytes32' }),
    Object.freeze({ name: 'jobId', type: 'bytes32' }),
    Object.freeze({ name: 'policyDecisionHash', type: 'bytes32' }),
    Object.freeze({ name: 'policyEnvelopeDigest', type: 'bytes32' }),
    Object.freeze({ name: 'outcomeHash', type: 'bytes32' }),
    Object.freeze({ name: 'terminalTxHash', type: 'bytes32' }),
    Object.freeze({ name: 'attestationId', type: 'bytes32' }),
    Object.freeze({ name: 'producer', type: 'address' }),
  ]),
});

const ABI_CODER = AbiCoder.defaultAbiCoder();
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,79}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function normalizedAddress(value, field, { nonzero = true } = {}) {
  let result;
  try {
    result = getAddress(value).toLowerCase();
  } catch {
    invariant(false, 'INVALID_AUTH_ADDRESS', `${field} must be a valid EVM address.`);
  }
  invariant(!nonzero || result !== ZERO_ADDRESS, 'ZERO_AUTH_ADDRESS', `${field} cannot be the zero address.`);
  return result;
}

function normalizedBytes32(value, field) {
  invariant(typeof value === 'string' && BYTES32_PATTERN.test(value), 'INVALID_AUTH_BYTES32', `${field} must be bytes32.`);
  return value.toLowerCase();
}

function normalizedDecimal(value, field, { allowZero = true } = {}) {
  invariant(typeof value === 'string' && DECIMAL_PATTERN.test(value), 'INVALID_AUTH_DECIMAL', `${field} must be a base-10 integer string.`);
  invariant(allowZero || BigInt(value) > 0n, 'ZERO_AUTH_DECIMAL', `${field} must be positive.`);
  return value;
}

function safeInteger(value, field, { positive = false } = {}) {
  invariant(Number.isSafeInteger(value), 'INVALID_AUTH_INTEGER', `${field} must be a safe integer.`);
  invariant(!positive || value > 0, 'INVALID_AUTH_INTEGER', `${field} must be positive.`);
  return value;
}

function parseQuantity(value, field) {
  try {
    const parsed = BigInt(value);
    invariant(parsed >= 0n, 'INVALID_AUTH_QUANTITY', `${field} cannot be negative.`);
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    invariant(false, 'INVALID_AUTH_QUANTITY', `${field} must be an integer quantity.`);
  }
}

function normalizeFileSha256(value) {
  const normalized = typeof value === 'string' && value.startsWith('0x') ? value : `0x${value ?? ''}`;
  return normalizedBytes32(normalized, 'source file SHA-256');
}

function payloadDigest(envelope, label) {
  invariant(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'INVALID_AUTH_ARTIFACT', `${label} is required.`);
  assertEvidenceSafe(envelope);
  const clean = deepClone(envelope);
  const integrity = clean.integrity;
  delete clean.integrity;
  invariant(integrity?.algorithm === 'sha256', 'INVALID_AUTH_INTEGRITY', `${label} must use SHA-256 integrity.`);
  invariant(integrity?.canonicalization === 'xpayr-canonical-json-v1', 'INVALID_AUTH_INTEGRITY', `${label} uses unsupported canonicalization.`);
  const computed = sha256Hex(canonicalJson(clean)).toLowerCase();
  invariant(hashesEqual(integrity?.digest, computed), 'INVALID_AUTH_INTEGRITY', `${label} integrity digest is invalid.`);
  return { digest: computed, payload: clean, integrity };
}

export function validateLifecycleEvidence(evidence) {
  const verified = payloadDigest(evidence, 'Lifecycle evidence');
  invariant(evidence.schema === LIFECYCLE_EVIDENCE_SCHEMA, 'INVALID_LIFECYCLE_EVIDENCE', 'Unsupported lifecycle evidence schema.');
  invariant(evidence.evidence_level === 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy',
    'SIGNED_POLICY_LIFECYCLE_REQUIRED', 'Only signed-policy lifecycle evidence may receive an auth-v1 overlay.');
  invariant(evidence.network_key === GIWA_NETWORK_KEY && Number(evidence.chain_id) === GIWA_CHAIN_ID,
    'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle evidence is not GIWA Sepolia evidence.');
  invariant(typeof evidence.run_id === 'string' && SAFE_RUN_ID_PATTERN.test(evidence.run_id),
    'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle evidence run ID is unsafe.');
  const escrow = normalizedAddress(evidence.escrow_contract, 'lifecycle escrow contract');
  const outcome = evidence.outcome;
  invariant(outcome === 'RELEASED' || outcome === 'REFUNDED', 'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle outcome is not terminal.');
  invariant(outcome === 'RELEASED'
    ? evidence.payment_completed === true && evidence.refunded === false
    : evidence.payment_completed === false && evidence.refunded === true,
  'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle payment classification is inconsistent.');
  invariant(evidence.canonical_terminal?.canonical_terminal_verified === true
    && evidence.canonical_terminal?.terminal === true
    && evidence.canonical_step_receipts?.all_steps_canonical === true,
  'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle evidence lacks canonical terminal proof.');
  invariant(evidence.boundaries?.testnet_only === true && evidence.boundaries?.real_customer_funds === false,
    'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle evidence does not preserve the testnet-only boundary.');
  const job = evidence.job ?? {};
  const evaluator = normalizedAddress(job.evaluator ?? ZERO_ADDRESS, 'lifecycle evaluator', { nonzero: false });
  const normalizedJob = canonicalValue({
    job_id: normalizedBytes32(job.job_id, 'lifecycle job ID'),
    job_nonce: normalizedBytes32(job.job_nonce, 'lifecycle job nonce'),
    payer: normalizedAddress(job.payer, 'lifecycle payer'),
    provider: normalizedAddress(job.provider, 'lifecycle provider'),
    evaluator,
    value_wei: normalizedDecimal(job.value_wei, 'lifecycle value', { allowZero: false }),
    expires_at: safeInteger(job.expires_at, 'lifecycle expiry', { positive: true }),
    policy_decision_hash: normalizedBytes32(job.policy_decision_hash, 'lifecycle policy decision hash'),
    deliverable_hash: normalizedBytes32(job.deliverable_hash, 'lifecycle deliverable hash'),
  });
  const origin = evidence.policy_origin;
  invariant(origin && typeof origin === 'object' && !Array.isArray(origin),
    'SIGNED_POLICY_ORIGIN_REQUIRED', 'Lifecycle evidence has no signed policy origin.');
  const expectedOriginKeys = [
    'artifact_digest',
    'artifact_path',
    'artifact_sha256',
    'authentication',
    'authority_address',
    'binding_digest',
    'intent_id',
    'mode',
    'policy_decision_hash',
    'producer_address',
    'record_id',
    'same_wallet_testnet_authority',
    'separation_of_duties',
    'signature_verified',
    'signed_job_expires_at',
    'typed_data_digest',
    'valid_from',
    'valid_until',
  ].sort();
  invariant(canonicalJson(Object.keys(origin).sort()) === canonicalJson(expectedOriginKeys),
    'SIGNED_POLICY_ORIGIN_INVALID', 'Lifecycle signed policy origin fields are not the exact v1 set.');
  invariant(origin.mode === 'eip712_signed_policy_artifact'
      && origin.authentication === 'eip712_configured_testnet_authority_verified'
      && origin.signature_verified === true
      && origin.same_wallet_testnet_authority === true
      && origin.separation_of_duties === false,
  'SIGNED_POLICY_ORIGIN_INVALID', 'Lifecycle signed policy origin flags are invalid.');
  invariant(typeof origin.artifact_path === 'string'
      && /^evidence\/policy\/[A-Za-z0-9][A-Za-z0-9._-]{7,79}\.policy\.json$/.test(origin.artifact_path),
  'SIGNED_POLICY_ORIGIN_INVALID', 'Lifecycle signed policy artifact path is invalid.');
  invariant(typeof origin.record_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(origin.record_id)
      && typeof origin.intent_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(origin.intent_id),
  'SIGNED_POLICY_ORIGIN_INVALID', 'Lifecycle signed policy record references are invalid.');
  const normalizedOrigin = canonicalValue({
    ...origin,
    artifact_digest: normalizedBytes32(origin.artifact_digest, 'policy origin artifact digest'),
    artifact_sha256: normalizeFileSha256(origin.artifact_sha256),
    authority_address: normalizedAddress(origin.authority_address, 'policy origin authority'),
    producer_address: normalizedAddress(origin.producer_address, 'policy origin producer'),
    typed_data_digest: normalizedBytes32(origin.typed_data_digest, 'policy origin typed-data digest'),
    binding_digest: normalizedBytes32(origin.binding_digest, 'policy origin binding digest'),
    policy_decision_hash: normalizedBytes32(origin.policy_decision_hash, 'policy origin decision hash'),
    valid_from: safeInteger(origin.valid_from, 'policy origin valid-from', { positive: true }),
    valid_until: safeInteger(origin.valid_until, 'policy origin valid-until', { positive: true }),
    signed_job_expires_at: safeInteger(origin.signed_job_expires_at, 'policy origin job expiry', { positive: true }),
  });
  invariant(normalizedOrigin.authority_address === normalizedOrigin.producer_address
      && normalizedOrigin.policy_decision_hash === normalizedJob.policy_decision_hash
      && normalizedOrigin.valid_from < normalizedOrigin.valid_until
      && normalizedOrigin.signed_job_expires_at === normalizedJob.expires_at
      && normalizedOrigin.signed_job_expires_at <= normalizedOrigin.valid_until,
  'SIGNED_POLICY_ORIGIN_INVALID', 'Lifecycle signed policy origin is internally inconsistent.');
  const binding = canonicalValue({
    evidence_digest: verified.digest,
    run_id: evidence.run_id,
    escrow_contract: escrow,
    outcome,
    terminal_transaction_hash: normalizedBytes32(
      evidence.canonical_terminal?.transaction_hash,
      'lifecycle terminal transaction hash',
    ),
    job: normalizedJob,
    policy_origin: normalizedOrigin,
  });
  invariant(binding.job.payer !== binding.job.provider, 'INVALID_LIFECYCLE_EVIDENCE', 'Lifecycle payer and provider collide.');
  return binding;
}

export function validateSignedPolicyArtifact(policyArtifact, lifecycleBinding, {
  expectedProducer = null,
  policyArtifactPath = null,
  policyFileSha256 = null,
} = {}) {
  invariant(lifecycleBinding && typeof lifecycleBinding === 'object', 'INVALID_POLICY_BINDING', 'Lifecycle binding is required.');
  invariant(policyArtifact && typeof policyArtifact === 'object' && !Array.isArray(policyArtifact),
    'INVALID_POLICY_ARTIFACT', 'Signed policy artifact is required.');
  const expected = lifecycleBinding.job;
  const producer = expectedProducer
    ? normalizedAddress(expectedProducer, 'expected policy producer')
    : lifecycleBinding.policy_origin.authority_address;
  const strict = verifyPolicyEvidence(policyArtifact, {
    currentTimestamp: null,
    expected: {
      networkKey: GIWA_NETWORK_KEY,
      chainId: GIWA_CHAIN_ID,
      authority: producer,
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
  const normalizedBinding = canonicalValue({
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
  });
  const lifecycleBindingDigest = sha256Hex(canonicalJson(normalizedBinding)).toLowerCase();
  const origin = lifecycleBinding.policy_origin;
  invariant(typeof policyArtifactPath === 'string' && policyArtifactPath === origin.artifact_path,
    'POLICY_ORIGIN_PATH_MISMATCH', 'Selected signed policy path differs from lifecycle policy origin.');
  invariant(normalizeFileSha256(policyFileSha256) === origin.artifact_sha256
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
  'POLICY_ORIGIN_BINDING_MISMATCH', 'Selected signed policy artifact does not exactly match lifecycle policy origin.');
  return canonicalValue({
    schema: strict.schema,
    digest: strict.artifactDigest,
    binding_digest: lifecycleBindingDigest,
    signed_policy_binding_digest: strict.bindingDigest,
    binding: normalizedBinding,
    authentication: {
      producer_address: strict.producerAddress,
      recovered_address: strict.authority,
      typed_data_digest: strict.typedDataDigest,
      primary_type: policyArtifact.authentication.eip712.primary_type,
    },
  });
}

export function buildAuthenticationMessage({
  lifecycleBinding,
  sourceFileSha256,
  policyEnvelopeDigest,
  producer,
}) {
  invariant(lifecycleBinding && typeof lifecycleBinding === 'object', 'INVALID_AUTH_BINDING', 'Lifecycle binding is required.');
  const normalizedProducer = normalizedAddress(producer, 'evidence producer');
  invariant(normalizedProducer === lifecycleBinding.job.payer, 'PRODUCER_PAYER_MISMATCH', 'Evidence producer must be the lifecycle payer/deployer.');
  const sourceDigest = normalizeFileSha256(sourceFileSha256);
  const policyDigest = normalizedBytes32(policyEnvelopeDigest, 'policy envelope digest');
  const attestationId = keccak256(ABI_CODER.encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint256', 'address'],
    [
      AUTHENTICATION_SCHEMA_HASH,
      lifecycleBinding.evidence_digest,
      sourceDigest,
      policyDigest,
      normalizedProducer,
      GIWA_CHAIN_ID,
      lifecycleBinding.escrow_contract,
    ],
  )).toLowerCase();
  const message = canonicalValue({
    schemaHash: AUTHENTICATION_SCHEMA_HASH,
    evidenceDigest: lifecycleBinding.evidence_digest,
    sourceFileSha256: sourceDigest,
    runIdHash: id(lifecycleBinding.run_id).toLowerCase(),
    jobId: lifecycleBinding.job.job_id,
    policyDecisionHash: lifecycleBinding.job.policy_decision_hash,
    policyEnvelopeDigest: policyDigest,
    outcomeHash: id(lifecycleBinding.outcome).toLowerCase(),
    terminalTxHash: lifecycleBinding.terminal_transaction_hash,
    attestationId,
    producer: normalizedProducer,
  });
  const domain = canonicalValue({
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: GIWA_CHAIN_ID,
    verifyingContract: lifecycleBinding.escrow_contract,
  });
  const typedDataDigest = TypedDataEncoder.hash(domain, EVIDENCE_AUTHENTICATION_TYPES, message).toLowerCase();
  return canonicalValue({
    domain,
    primary_type: EIP712_PRIMARY_TYPE,
    types: EVIDENCE_AUTHENTICATION_TYPES,
    message,
    typed_data_digest: typedDataDigest,
    attestation_id: attestationId,
  });
}

export async function signAuthenticationMessage(authentication, signer) {
  invariant(signer && typeof signer.signTypedData === 'function', 'AUTH_SIGNER_REQUIRED', 'Evidence producer signer is required.');
  const expected = normalizedAddress(authentication?.message?.producer, 'authentication producer');
  const signerAddress = normalizedAddress(await signer.getAddress(), 'authentication signer');
  invariant(signerAddress === expected, 'AUTH_SIGNER_MISMATCH', 'Evidence producer signer does not match the authentication message.');
  const signature = await signer.signTypedData(
    authentication.domain,
    authentication.types,
    authentication.message,
  );
  return verifyAuthenticationSignature({ ...authentication, signature }, { expectedProducer: expected });
}

export function verifyAuthenticationSignature(authentication, { expectedProducer = null } = {}) {
  invariant(authentication && typeof authentication === 'object', 'INVALID_EVIDENCE_SIGNATURE', 'Evidence authentication is required.');
  invariant(authentication.primary_type === EIP712_PRIMARY_TYPE, 'INVALID_EVIDENCE_SIGNATURE', 'Evidence authentication primary type is invalid.');
  invariant(canonicalJson(authentication.types) === canonicalJson(EVIDENCE_AUTHENTICATION_TYPES),
    'INVALID_EVIDENCE_SIGNATURE', 'Evidence authentication types are invalid.');
  invariant(authentication.domain?.name === EIP712_DOMAIN_NAME
    && authentication.domain?.version === EIP712_DOMAIN_VERSION
    && Number(authentication.domain?.chainId) === GIWA_CHAIN_ID,
  'INVALID_EVIDENCE_SIGNATURE', 'Evidence authentication domain is invalid.');
  const producer = normalizedAddress(authentication.message?.producer, 'evidence authentication producer');
  if (expectedProducer !== null) {
    invariant(producer === normalizedAddress(expectedProducer, 'expected evidence producer'),
      'INVALID_EVIDENCE_SIGNATURE', 'Evidence authentication producer is unexpected.');
  }
  const digest = TypedDataEncoder.hash(
    authentication.domain,
    EVIDENCE_AUTHENTICATION_TYPES,
    authentication.message,
  ).toLowerCase();
  invariant(hashesEqual(authentication.typed_data_digest, digest), 'INVALID_EVIDENCE_SIGNATURE', 'Evidence typed-data digest is invalid.');
  const parsed = Signature.from(authentication.signature);
  invariant(parsed.isValid(), 'INVALID_EVIDENCE_SIGNATURE', 'Evidence producer signature is invalid.');
  const recovered = normalizedAddress(verifyTypedData(
    authentication.domain,
    EVIDENCE_AUTHENTICATION_TYPES,
    authentication.message,
    parsed.serialized,
  ), 'evidence recovered signer');
  invariant(recovered === producer, 'INVALID_EVIDENCE_SIGNATURE', 'Evidence signature does not recover the producer.');
  return canonicalValue({
    ...authentication,
    typed_data_digest: digest,
    signature: parsed.serialized,
    signature_hash: keccak256(parsed.serialized).toLowerCase(),
    recovered_address: recovered,
    signature_verified: true,
  });
}

export function encodeAnchorCalldata(authentication) {
  const verified = verifyAuthenticationSignature(authentication, {
    expectedProducer: authentication?.message?.producer,
  });
  return concat([
    ANCHOR_MAGIC,
    ABI_CODER.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        AUTHENTICATION_SCHEMA_HASH,
        verified.message.attestationId,
        verified.message.evidenceDigest,
        verified.message.sourceFileSha256,
        verified.typed_data_digest,
        verified.signature_hash,
      ],
    ),
  ]).toLowerCase();
}

export function decodeAnchorCalldata(calldata) {
  invariant(typeof calldata === 'string' && calldata.startsWith(ANCHOR_MAGIC), 'INVALID_ANCHOR_CALLDATA', 'Anchor calldata magic is invalid.');
  invariant((calldata.length - 2) / 2 === 196, 'INVALID_ANCHOR_CALLDATA', 'Anchor calldata length is invalid.');
  const decoded = ABI_CODER.decode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    dataSlice(calldata, 4),
  );
  const result = canonicalValue({
    schema_hash: normalizedBytes32(decoded[0], 'anchor schema hash'),
    attestation_id: normalizedBytes32(decoded[1], 'anchor attestation ID'),
    evidence_digest: normalizedBytes32(decoded[2], 'anchor evidence digest'),
    source_file_sha256: normalizedBytes32(decoded[3], 'anchor source SHA-256'),
    typed_data_digest: normalizedBytes32(decoded[4], 'anchor typed-data digest'),
    signature_hash: normalizedBytes32(decoded[5], 'anchor signature hash'),
  });
  invariant(result.schema_hash === AUTHENTICATION_SCHEMA_HASH, 'INVALID_ANCHOR_CALLDATA', 'Anchor schema hash is invalid.');
  return result;
}

function transactionData(transaction) {
  return String(transaction?.data ?? transaction?.input ?? '').toLowerCase();
}

function transactionHash(transaction) {
  return String(transaction?.hash ?? '').toLowerCase();
}

function receiptHash(receipt) {
  return String(receipt?.hash ?? receipt?.transactionHash ?? '').toLowerCase();
}

export async function verifyCanonicalAnchor({
  provider,
  transactionHash: expectedTransactionHash,
  authentication,
  requiredConfirmations = 1,
  expectedNonce = null,
}) {
  invariant(provider && typeof provider.getNetwork === 'function', 'ANCHOR_PROVIDER_REQUIRED', 'Canonical provider is required.');
  const verifiedAuthentication = verifyAuthenticationSignature(authentication, {
    expectedProducer: authentication?.message?.producer,
  });
  const expectedHash = normalizedBytes32(expectedTransactionHash, 'anchor transaction hash');
  safeInteger(requiredConfirmations, 'required anchor confirmations', { positive: true });
  const [network, receipt, transaction] = await Promise.all([
    provider.getNetwork(),
    provider.getTransactionReceipt(expectedHash),
    provider.getTransaction(expectedHash),
  ]);
  invariant(Number(network.chainId) === GIWA_CHAIN_ID, 'ANCHOR_CHAIN_MISMATCH', 'Canonical RPC returned a non-GIWA chain ID.');
  invariant(receipt && transaction, 'ANCHOR_TRANSACTION_NOT_FOUND', 'Anchor transaction or receipt is not available.');
  invariant(receiptHash(receipt) === expectedHash && transactionHash(transaction) === expectedHash,
    'ANCHOR_TRANSACTION_HASH_MISMATCH', 'Anchor transaction hash is inconsistent.');
  const producer = normalizedAddress(verifiedAuthentication.message.producer, 'anchor producer');
  invariant(normalizedAddress(transaction.from, 'anchor sender') === producer
    && normalizedAddress(transaction.to, 'anchor recipient') === producer,
  'ANCHOR_PARTY_MISMATCH', 'Anchor must be an EOA self-transaction by the producer.');
  if (receipt.from !== undefined && receipt.from !== null) {
    invariant(normalizedAddress(receipt.from, 'anchor receipt sender') === producer,
      'ANCHOR_PARTY_MISMATCH', 'Anchor receipt sender is invalid.');
  }
  if (receipt.to !== undefined && receipt.to !== null) {
    invariant(normalizedAddress(receipt.to, 'anchor receipt recipient') === producer,
      'ANCHOR_PARTY_MISMATCH', 'Anchor receipt recipient is invalid.');
  }
  invariant(parseQuantity(transaction.value ?? 0, 'anchor transaction value') === 0n,
    'ANCHOR_VALUE_NONZERO', 'Anchor transaction value must be zero.');
  invariant(Number(transaction.type) === 2, 'ANCHOR_TRANSACTION_TYPE_INVALID', 'Anchor must be an EIP-1559 type-2 transaction.');
  if (transaction.chainId !== undefined && transaction.chainId !== null) {
    invariant(Number(transaction.chainId) === GIWA_CHAIN_ID, 'ANCHOR_CHAIN_MISMATCH', 'Anchor transaction chain ID is invalid.');
  }
  if (expectedNonce !== null) {
    invariant(Number(transaction.nonce) === Number(expectedNonce), 'ANCHOR_NONCE_MISMATCH', 'Anchor transaction nonce is invalid.');
  }
  const expectedCalldata = encodeAnchorCalldata(verifiedAuthentication);
  invariant(transactionData(transaction) === expectedCalldata, 'ANCHOR_CALLDATA_MISMATCH', 'Anchor calldata does not match the evidence signature.');
  const decoded = decodeAnchorCalldata(transactionData(transaction));
  invariant(decoded.attestation_id === verifiedAuthentication.message.attestationId
    && decoded.evidence_digest === verifiedAuthentication.message.evidenceDigest
    && decoded.source_file_sha256 === verifiedAuthentication.message.sourceFileSha256
    && decoded.typed_data_digest === verifiedAuthentication.typed_data_digest
    && decoded.signature_hash === verifiedAuthentication.signature_hash,
  'ANCHOR_CALLDATA_MISMATCH', 'Anchor calldata fields do not match the evidence signature.');
  invariant(Number(receipt.status) === 1, 'ANCHOR_RECEIPT_REVERTED', 'Anchor receipt reverted.');
  const blockNumber = Number(receipt.blockNumber);
  safeInteger(blockNumber, 'anchor block number', { positive: true });
  const blockHash = normalizedBytes32(receipt.blockHash, 'anchor receipt block hash');
  invariant(Number(transaction.blockNumber) === blockNumber
    && normalizedBytes32(transaction.blockHash, 'anchor transaction block hash') === blockHash,
  'ANCHOR_BLOCK_MEMBERSHIP_MISMATCH', 'Anchor transaction block membership is invalid.');
  const blockBefore = await provider.getBlock(blockNumber);
  invariant(Number(blockBefore?.number) === blockNumber
    && normalizedBytes32(blockBefore?.hash, 'anchor canonical block hash') === blockHash,
  'ANCHOR_BLOCK_NOT_CANONICAL', 'Anchor receipt block is not canonical.');
  const producerCode = await provider.send('eth_getCode', [producer, { blockHash, requireCanonical: true }]);
  invariant(producerCode === '0x', 'ANCHOR_PRODUCER_NOT_EOA', 'Anchor producer had contract/delegated code at the receipt block.');
  const blockAfter = await provider.getBlock(blockNumber);
  invariant(Number(blockAfter?.number) === blockNumber
    && normalizedBytes32(blockAfter?.hash, 'anchor canonical block recheck hash') === blockHash,
  'ANCHOR_BLOCK_NOT_CANONICAL', 'Anchor block changed during canonical verification.');
  const head = Number(await provider.getBlockNumber());
  safeInteger(head, 'anchor canonical head', { positive: true });
  invariant(head >= blockNumber, 'ANCHOR_HEAD_INVALID', 'Canonical head is behind the anchor receipt.');
  const confirmations = head - blockNumber + 1;
  invariant(confirmations >= requiredConfirmations, 'ANCHOR_CONFIRMATIONS_INSUFFICIENT', 'Anchor receipt lacks required confirmations.');
  return canonicalValue({
    scheme: 'giwa_eoa_self_transaction_calldata_v1',
    transaction_hash: expectedHash,
    from: producer,
    to: producer,
    value_wei: '0',
    transaction_type: 2,
    nonce: Number(transaction.nonce),
    calldata: expectedCalldata,
    calldata_bytes: (expectedCalldata.length - 2) / 2,
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

export function buildAuthenticatedSidecar({
  lifecycleEvidencePath,
  lifecycleBinding,
  sourceFileSha256,
  policyArtifactPath,
  validatedPolicy,
  authentication,
  anchor,
  createdAt = new Date().toISOString(),
}) {
  const verifiedAuthentication = verifyAuthenticationSignature(authentication, {
    expectedProducer: lifecycleBinding?.job?.payer,
  });
  invariant(validatedPolicy?.digest === verifiedAuthentication.message.policyEnvelopeDigest,
    'POLICY_AUTH_DIGEST_MISMATCH', 'Authenticated evidence does not bind the signed policy artifact.');
  invariant(anchor?.decoded?.attestation_id === verifiedAuthentication.message.attestationId
    && anchor?.decoded?.typed_data_digest === verifiedAuthentication.typed_data_digest
    && anchor?.receipt_status === 1,
  'ANCHOR_AUTH_BINDING_MISMATCH', 'Canonical anchor does not bind the evidence signature.');
  const payload = canonicalValue({
    schema: AUTHENTICATED_EVIDENCE_SCHEMA,
    evidence_level: 'canonical_giwa_sepolia_lifecycle_receipts_producer_signed_and_onchain_anchored',
    created_at: new Date(createdAt).toISOString(),
    network_key: GIWA_NETWORK_KEY,
    chain_id: GIWA_CHAIN_ID,
    escrow_contract: lifecycleBinding.escrow_contract,
    run_id: lifecycleBinding.run_id,
    source: {
      path: lifecycleEvidencePath,
      schema: LIFECYCLE_EVIDENCE_SCHEMA,
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
      producer_address: validatedPolicy.authentication.producer_address,
      producer_signature_verified: true,
    },
    producer: {
      address: verifiedAuthentication.message.producer,
      role: 'configured_deployer_payer_testnet_eoa',
      identity_claim: 'address_control_only',
      up_id_is_authentication: false,
      signature_scheme: 'eip712_secp256k1',
      domain: verifiedAuthentication.domain,
      primary_type: verifiedAuthentication.primary_type,
      types: verifiedAuthentication.types,
      message: verifiedAuthentication.message,
      typed_data_digest: verifiedAuthentication.typed_data_digest,
      signature: verifiedAuthentication.signature,
      signature_hash: verifiedAuthentication.signature_hash,
      recovered_address: verifiedAuthentication.recovered_address,
      signature_verified: true,
    },
    anchor,
    checks: {
      source_integrity_valid: true,
      source_exact_file_hash_bound: true,
      signed_policy_artifact_valid: true,
      policy_lifecycle_binding_exact: true,
      producer_signature_valid: true,
      producer_is_lifecycle_payer: true,
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
      producer_claim: 'control_of_named_eoa_at_signature_and_anchor_time',
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

export function verifyAuthenticatedSidecar({
  sidecar,
  lifecycleBinding,
  sourceFileSha256,
  validatedPolicy,
}) {
  const verified = payloadDigest(sidecar, 'Authenticated evidence sidecar');
  invariant(sidecar.schema === AUTHENTICATED_EVIDENCE_SCHEMA
    && sidecar.network_key === GIWA_NETWORK_KEY
    && Number(sidecar.chain_id) === GIWA_CHAIN_ID
    && sidecar.overall_authenticated === true,
  'INVALID_AUTHENTICATED_SIDECAR', 'Authenticated evidence sidecar metadata is invalid.');
  invariant(sidecar.source?.evidence_digest === lifecycleBinding.evidence_digest
    && sidecar.source?.file_sha256 === normalizeFileSha256(sourceFileSha256)
    && sidecar.source?.job_id === lifecycleBinding.job.job_id
    && sidecar.source?.terminal_transaction_hash === lifecycleBinding.terminal_transaction_hash
    && sidecar.policy?.artifact_digest === validatedPolicy.digest
    && sidecar.policy?.binding_digest === validatedPolicy.binding_digest,
  'INVALID_AUTHENTICATED_SIDECAR', 'Authenticated evidence source or policy binding is invalid.');
  const authentication = verifyAuthenticationSignature({
    domain: sidecar.producer?.domain,
    primary_type: sidecar.producer?.primary_type,
    types: sidecar.producer?.types,
    message: sidecar.producer?.message,
    typed_data_digest: sidecar.producer?.typed_data_digest,
    signature: sidecar.producer?.signature,
  }, { expectedProducer: lifecycleBinding.job.payer });
  invariant(sidecar.anchor?.decoded?.attestation_id === authentication.message.attestationId
    && sidecar.anchor?.decoded?.typed_data_digest === authentication.typed_data_digest
    && sidecar.anchor?.transaction_hash
    && sidecar.anchor?.receipt_status === 1,
  'INVALID_AUTHENTICATED_SIDECAR', 'Authenticated evidence anchor binding is invalid.');
  return canonicalValue({
    valid: true,
    digest: verified.digest,
    producer_authenticated: true,
    producer_address: authentication.recovered_address,
    anchor_transaction_hash: sidecar.anchor.transaction_hash,
    attestation_id: authentication.message.attestationId,
  });
}

// Phase-4 SoD is an opt-in v2 protocol. Re-exporting keeps a single public
// evidence-authentication entrypoint while leaving every auth-v1 constant and
// verifier above byte-for-byte behaviorally compatible.
export {
  ANCHOR_MAGIC_V2,
  AUTHENTICATED_EVIDENCE_V2_SCHEMA,
  AUTHENTICATION_SCHEMA_HASH_V2,
  EVIDENCE_AUTHENTICATION_TYPES_V2,
  buildAuthenticatedSidecarV2,
  buildAuthenticationMessageV2,
  decodeAnchorCalldataV2,
  encodeAnchorCalldataV2,
  signAuthenticationMessageV2,
  validateLifecycleEvidenceV2,
  validateSignedPolicyArtifactV2,
  verifyAuthenticatedSidecarV2,
  verifyAuthenticationSignatureV2,
  verifyCanonicalAnchorV2,
} from './evidence-authentication-v2.mjs';
