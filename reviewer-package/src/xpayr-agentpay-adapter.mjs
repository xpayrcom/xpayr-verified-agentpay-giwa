import { DojangClient, normalizeAddress } from './dojang-client.mjs';
import { buildIntentEvidence, sealEvidence } from './evidence.mjs';
import { DomainError, invariant } from './errors.mjs';
import { IntentStore } from './intent-store.mjs';
import { PolicyEngine } from './policy-engine.mjs';
import { validateManifest } from './manifest.mjs';

function present(record, { includeEvidence = false, evidence = null } = {}) {
  const roleVerification = Object.fromEntries(
    Object.entries(record.verification ?? {}).map(([role, verdict]) => [role, {
      address: verdict.address ?? record.intent?.[role] ?? null,
      verified: verdict.verified === true,
      source: verdict.source ?? 'unknown',
      acceptedAttesterId: verdict.accepted_attester_id ?? null,
    }]),
  );
  const allVerified = Object.values(roleVerification).length > 0
    && Object.values(roleVerification).every((entry) => entry.verified === true);
  const verification = {
    verified: allVerified,
    allVerified,
    ...roleVerification,
  };
  const intent = {
    id: record.id,
    jobId: record.intent.job_id,
    jobNonce: record.intent.job_nonce,
    title: record.intent.title,
    networkKey: record.intent.network_key,
    network_key: record.intent.network_key,
    job_id: record.intent.job_id,
    job_nonce: record.intent.job_nonce,
    payer: record.intent.payer,
    provider: record.intent.provider,
    evaluator: record.intent.evaluator,
    asset: record.intent.asset,
    amountAtomic: record.intent.amount_atomic,
    amount_wei: record.intent.amount_atomic,
    expiresAt: record.intent.expires_at,
    expires_at: record.intent.expires_at,
    decision: record.policy.decision,
    verdict: record.policy.verdict,
    state: record.state,
    status: record.state,
    policyHash: record.policy.policy_hash,
    fingerprint: record.policy.execution_fingerprint,
    reasons: record.policy.reasons,
    verification,
    execution: record.execution,
  };
  return {
    id: record.id,
    jobId: record.intent.job_id,
    decision: record.policy.decision,
    verdict: record.policy.verdict,
    state: record.state,
    status: record.state,
    policyHash: record.policy.policy_hash,
    fingerprint: record.policy.execution_fingerprint,
    reasons: record.policy.reasons,
    intent,
    title: intent.title,
    payer: intent.payer,
    provider: intent.provider,
    evaluator: intent.evaluator,
    amountAtomic: intent.amountAtomic,
    verification,
    approval: record.approval,
    execution: record.execution,
    confirmation: record.confirmation,
    reconciliation: record.reconciliation,
    evidence: includeEvidence ? evidence : null,
    evidenceUrl: `/api/intents/${encodeURIComponent(record.id)}/evidence`,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class XpayrGiwaAgentPayService {
  constructor({ manifest, dojangClient = null, policyEngine = null, store = null, clock, idFactory }) {
    this.manifest = validateManifest(manifest);
    this.dojangClient = dojangClient ?? new DojangClient({ manifest: this.manifest });
    const policyNow = clock
      ? () => {
          const value = clock();
          return value instanceof Date ? value.toISOString() : value;
        }
      : undefined;
    this.policyEngine = policyEngine ?? new PolicyEngine({
      manifest: this.manifest,
      ...(policyNow ? { now: policyNow } : {}),
    });
    this.store = store ?? new IntentStore({ manifest: this.manifest, policyEngine: this.policyEngine, clock, idFactory });
  }

  async verifyRoles(input) {
    invariant(input?.identity === undefined && input?.verification === undefined, 'UNTRUSTED_IDENTITY_OVERRIDE', 'Identity verdicts cannot be supplied by the caller.', { status: 422 });
    const usageOverrides = [
      'recent_intent_count',
      'recentIntentCount',
      'daily_spent_atomic',
      'dailySpentAtomic',
      'usage',
      'usage_context',
      'usageContext',
    ]
      .filter((field) => input?.[field] !== undefined);
    invariant(usageOverrides.length === 0, 'UNTRUSTED_USAGE_OVERRIDE', 'Policy usage context is derived by XPAYR and cannot be supplied by the caller.', {
      status: 422,
      details: usageOverrides,
    });
    const jobOverrides = ['job_id', 'jobId', 'job_nonce', 'jobNonce'].filter((field) => input?.[field] !== undefined);
    invariant(jobOverrides.length === 0, 'UNTRUSTED_JOB_BINDING_OVERRIDE', 'jobId and jobNonce are derived by XPAYR and cannot be supplied by the caller.', {
      status: 422,
      details: jobOverrides,
    });
    const roles = {
      payer: input.payer ?? input.payerAddress,
      provider: input.provider ?? input.providerAddress,
      evaluator: input.evaluator ?? input.evaluatorAddress,
    };
    const result = {};
    for (const [role, address] of Object.entries(roles)) {
      if (!address) continue;
      result[role] = await this.dojangClient.checkAddress(normalizeAddress(address, `${role} address`));
    }
    return result;
  }

  async createIntent(input) {
    const identity = await this.verifyRoles(input);
    return present(this.store.createIntent(input, { identity }));
  }

  listIntents(query = {}) {
    return this.store.list(query).map((record) => present(record));
  }

  getIntent(id) {
    return present(this.store.get(id));
  }

  approveIntent(id, input) {
    return present(this.store.approve(id, { approver: input?.approver ?? input?.approverAddress }));
  }

  rejectIntent(id, input) {
    return present(this.store.reject(id, { actor: input?.actor ?? input?.actorAddress ?? input?.approver ?? input?.approverAddress }));
  }

  prepareExecution(id) {
    return present(this.store.prepareExecution(id));
  }

  recordFlashblocks(id, result) {
    return present(this.store.recordFlashblocks(id, result));
  }

  recordWalletSubmitted(id, result) {
    return present(this.store.recordWalletSubmitted(id, result));
  }

  finalize(id, result) {
    return present(this.store.finalize(id, result));
  }

  evidence(id, options = {}) {
    const record = this.store.get(id);
    const envelope = sealEvidence(buildIntentEvidence({ manifest: this.manifest, record, ...options }));
    return envelope;
  }
}

export function createDemoFixtureDojangClient({ now = () => new Date().toISOString() } = {}) {
  return {
    async checkAddress(address) {
      const wallet = normalizeAddress(address);
      return {
        address: wallet,
        verified: true,
        accepted_attester_id: null,
        checks: [],
        source: 'demo_fixture',
        checked_at: now(),
        disclaimer: 'Local deterministic fixture; not a Dojang chain attestation.',
      };
    },
  };
}

export function assertLiveIdentitySource(service) {
  if (service.dojangClient?.checkAddress === undefined) {
    throw new DomainError('DOJANG_CLIENT_REQUIRED', 'A Dojang client is required.', { status: 500 });
  }
}
