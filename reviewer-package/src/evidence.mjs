import { canonicalJson, deepClone, hashesEqual, sha256Hex } from './canonical-json.mjs';
import { DomainError, invariant } from './errors.mjs';
import { assertGiwaIsolation, validateManifest } from './manifest.mjs';

export const EVIDENCE_SCHEMA = 'xpayr.giwa.verified-agentpay.evidence.v1';

const PRIVATE_KEY_NAMES = /(^|_)(secret|private_key|mnemonic|seed_phrase|password|bearer|authorization|cookie|api_key|access_token|refresh_token)($|_)/i;
const PII_NAMES = /(^|_)(email|phone|full_name|first_name|last_name|ip_address|postal_address)($|_)/i;
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/i,
];

function normalizedKeyName(key) {
  return String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

function inspectPrivacy(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    if (SECRET_VALUES.some((pattern) => pattern.test(value))) findings.push({ path, type: 'secret_value' });
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectPrivacy(entry, `${path}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = normalizedKeyName(key);
      if (PRIVATE_KEY_NAMES.test(normalizedKey)) findings.push({ path: `${path}.${key}`, type: 'secret_key' });
      if (PII_NAMES.test(normalizedKey)) findings.push({ path: `${path}.${key}`, type: 'pii_key' });
      inspectPrivacy(entry, `${path}.${key}`, findings);
    }
  }
  return findings;
}

export function assertEvidenceSafe(value) {
  const findings = inspectPrivacy(value);
  invariant(findings.length === 0, 'EVIDENCE_PRIVACY_VIOLATION', 'Evidence contains secret or PII fields.', {
    details: findings,
  });
  assertGiwaIsolation(value);
}

function acceptedDojangCheck(verdict) {
  if (!Array.isArray(verdict?.checks) || verdict.checks.length === 0) return null;
  const acceptedId = verdict.accepted_attester_id ?? verdict.attester_id ?? null;
  return verdict.checks.find((entry) => entry?.attester_id === acceptedId)
    ?? verdict.checks.find((entry) => entry?.verified === true)
    ?? verdict.checks[0];
}

function metadataQueryStatus(flag, source) {
  if (source === 'demo_fixture') return 'not_applicable';
  if (flag === false) return 'not_separately_queried';
  if (flag === true) return 'queried';
  return 'unknown';
}

function identitySummary(record) {
  return Object.fromEntries(
    Object.entries(record.verification ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([role, verdict]) => {
      const lifecycleCheck = acceptedDojangCheck(verdict);
      const source = verdict.source ?? 'unknown';
      return [role, {
        address: verdict.address ?? record.intent[role] ?? null,
        verified: verdict.verified === true,
        accepted_attester_id: verdict.accepted_attester_id ?? verdict.attester_id ?? null,
        source,
        checked_at: verdict.checked_at ?? null,
        chain_id: verdict.chain_id ?? null,
        block_number: verdict.block_number ?? null,
        block_hash: verdict.block_hash ?? null,
        lifecycle_validation: source === 'demo_fixture'
          ? 'not_applicable'
          : lifecycleCheck?.lifecycle_validation ?? verdict.lifecycle_validation ?? 'unknown',
        revocation_metadata: metadataQueryStatus(
          lifecycleCheck?.revocation_metadata_queried ?? verdict.revocation_metadata_queried,
          source,
        ),
        expiry_metadata: metadataQueryStatus(
          lifecycleCheck?.expiry_metadata_queried ?? verdict.expiry_metadata_queried,
          source,
        ),
      }];
    }),
  );
}

export function buildIntentEvidence({ manifest, record, sourceSnapshotDate = '2026-07-19', createdAt = new Date().toISOString() }) {
  const network = validateManifest(manifest);
  invariant(record && typeof record === 'object', 'INVALID_EVIDENCE_RECORD', 'Intent record is required.');
  const canonical = record.confirmation?.canonical ?? null;
  const canonicalTerminal = canonical?.canonical_terminal_verified === true && canonical?.terminal === true;
  const releasedOutcome = canonicalTerminal
    && canonical?.outcome === 'RELEASED'
    && canonical?.completed === true
    && canonical?.refunded === false;
  const refundedOutcome = canonicalTerminal
    && canonical?.outcome === 'REFUNDED'
    && canonical?.refunded === true
    && canonical?.completed === false;
  const fixtureIdentity = Object.values(record.verification ?? {}).some((entry) => entry?.source === 'demo_fixture');
  const canonicalChecks = record.confirmation?.canonical?.checks ?? {};
  const allowedAttesters = new Set(network.dojang.attester_allowlist.map((entry) => entry.id));
  const requiredRoles = Object.keys(record.policy?.snapshot?.identity_checks ?? {});
  const liveDojangIdentity = requiredRoles.length > 0 && requiredRoles.every((role) => {
    const verdict = record.verification?.[role];
    const acceptedCheck = acceptedDojangCheck(verdict);
    return verdict?.verified === true
      && verdict?.source === 'giwa_dojang_read_only'
      && allowedAttesters.has(verdict?.accepted_attester_id)
      && verdict?.chain_id === network.chain_id
      && acceptedCheck?.verified === true
      && acceptedCheck?.lifecycle_validation === 'enforced_by_dojang_isVerified_aggregate'
      && acceptedCheck?.revocation_metadata_queried === false
      && acceptedCheck?.expiry_metadata_queried === false
      && Number.isSafeInteger(verdict?.block_number)
      && verdict.block_number > 0
      && typeof verdict?.block_hash === 'string'
      && /^0x[0-9a-fA-F]{64}$/.test(verdict.block_hash);
  });
  const requiredChecks = {
    network_is_giwa_testnet: record.intent?.network_key === network.network_key && network.chain_id === 91342,
    policy_decision_bound: typeof record.policy?.decision_hash === 'string' && typeof record.policy?.execution_fingerprint === 'string',
    required_identity_verified: Object.values(record.policy?.snapshot?.identity_checks ?? {}).every(Boolean),
    identity_attestations_bound: liveDojangIdentity,
    execution_requires_verification: record.execution === null
      || record.execution?.binding?.verification_required === true,
    expiry_bound_to_fingerprint: Number.isSafeInteger(record.intent?.expires_at)
      && record.execution?.binding?.expires_at === record.intent.expires_at,
    local_api_approval_not_wallet_proof: record.approval?.actor_authentication === 'not_implemented',
    contract_terminal_path_enforced: record.approval?.required !== true
      || (canonicalTerminal
        && canonicalChecks.terminal_call_job_id === true
        && canonicalChecks.job_state_terminal_status === true),
    flashblocks_not_completion: record.confirmation?.flashblocks?.completed !== true,
    canonical_terminal_receipt_verified: canonicalTerminal,
    canonical_terminal_outcome_bound: releasedOutcome || refundedOutcome,
    canonical_terminal_event_bound: releasedOutcome
      ? canonicalChecks.release_job_id === true
        && canonicalChecks.release_actor_is_sender === true
        && canonicalChecks.release_provider === true
        && canonicalChecks.release_amount === true
      : refundedOutcome
        ? canonicalChecks.refund_job_id === true
          && canonicalChecks.refund_payer === true
          && canonicalChecks.refund_amount === true
          && canonicalChecks.refund_reason === true
        : false,
    canonical_job_state_bound: canonicalTerminal
      && canonicalChecks.job_state_terminal_status === true
      && canonicalChecks.job_id_derived_from_nonce === true
      && canonicalChecks.job_state_job_nonce === true
      && canonicalChecks.job_state_policy_hash === true
      && canonicalChecks.job_state_verification_required === true
      && canonicalChecks.job_state_expected_amount === true
      && canonicalChecks.job_state_deliverable_sufficient === true,
    reconciliation_outcome_truthful: releasedOutcome
      ? record.reconciliation?.payment_session === 'completed_from_canonical_receipt'
      : refundedOutcome
        ? record.reconciliation?.payment_session === 'refunded_from_canonical_receipt'
        : false,
    real_dojang_source: !fixtureIdentity && liveDojangIdentity,
    onchain_deployment_present: network.contracts.escrow !== null,
  };
  const overallPass = Object.values(requiredChecks).every(Boolean);

  const payload = {
    schema: EVIDENCE_SCHEMA,
    created_at: createdAt,
    source_snapshot_date: sourceSnapshotDate,
    evidence_status: overallPass
      ? releasedOutcome
        ? 'giwa_testnet_release_checks_passed_unsigned'
        : 'giwa_testnet_refund_checks_passed_unsigned'
      : 'local_domain_demo_not_chain_proof',
    scope: {
      product: 'XPAYR Verified AgentPay for GIWA',
      network_key: network.network_key,
      chain_id: network.chain_id,
      environment: 'testnet',
      test_only_asset: true,
      economic_value: false,
      endorsement_claimed: false,
    },
    subject: {
      intent_id: record.id,
      job_id: record.intent?.job_id,
      job_nonce: record.intent?.job_nonce,
      expires_at: record.intent?.expires_at,
      state: record.state,
      payer: record.intent?.payer,
      provider: record.intent?.provider,
      evaluator: record.intent?.evaluator ?? null,
      asset: record.intent?.asset,
      amount_atomic: record.intent?.amount_atomic,
      terminal_outcome: canonicalTerminal ? canonical?.outcome : null,
      payment_completed: releasedOutcome,
    },
    policy: {
      decision: record.policy?.decision,
      reasons: record.policy?.reasons ?? [],
      decision_hash: record.policy?.decision_hash,
      execution_fingerprint: record.policy?.execution_fingerprint,
      merchant_approval: record.approval,
    },
    identity: identitySummary(record),
    execution: record.execution,
    confirmation: record.confirmation,
    reconciliation: record.reconciliation,
    required_checks: requiredChecks,
    overall_pass: overallPass,
    boundaries: {
      non_custodial: true,
      server_signed_transaction: false,
      server_broadcast_transaction: false,
      mainnet: false,
      stablecoin_claim: false,
      wallet_sdk_claim: false,
      cross_chain: false,
      automatic_ai_release: false,
      local_api_approval_is_wallet_proof: false,
      refund_is_payment_completion: false,
    },
  };
  assertEvidenceSafe(payload);
  return payload;
}

export function sealEvidence(payload) {
  invariant(payload?.schema === EVIDENCE_SCHEMA, 'INVALID_EVIDENCE_SCHEMA', 'Unsupported evidence schema.');
  assertEvidenceSafe(payload);
  const clean = deepClone(payload);
  invariant(clean.integrity === undefined, 'EVIDENCE_ALREADY_SEALED', 'Evidence already contains an integrity seal.');
  const digest = sha256Hex(canonicalJson(clean));
  return {
    ...clean,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      digest,
      producer_authentication: 'not_provided',
      signature: null,
      anchor: null,
    },
  };
}

export function verifyEvidence(envelope) {
  invariant(envelope && typeof envelope === 'object', 'INVALID_EVIDENCE', 'Evidence envelope is required.');
  assertEvidenceSafe(envelope);
  invariant(envelope.schema === EVIDENCE_SCHEMA, 'INVALID_EVIDENCE_SCHEMA', 'Unsupported evidence schema.');
  const clean = deepClone(envelope);
  const seal = clean.integrity;
  delete clean.integrity;
  const checks = {
    algorithm: seal?.algorithm === 'sha256',
    canonicalization: seal?.canonicalization === 'xpayr-canonical-json-v1',
    digest: hashesEqual(seal?.digest, sha256Hex(canonicalJson(clean))),
    network_key: clean.scope?.network_key === 'giwa-testnet',
    chain_id: clean.scope?.chain_id === 91342,
    testnet_only: clean.scope?.environment === 'testnet' && clean.scope?.economic_value === false,
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    digest: seal?.digest ?? null,
    producer_authenticated: false,
    non_repudiation: false,
  };
}

export function requireValidEvidence(envelope) {
  const result = verifyEvidence(envelope);
  if (!result.valid) {
    throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Evidence integrity verification failed.', {
      status: 422,
      details: result.checks,
    });
  }
  return result;
}
