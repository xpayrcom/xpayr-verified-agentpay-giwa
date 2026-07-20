import { randomUUID } from 'node:crypto';
import { deepClone, sha256Hex } from './canonical-json.mjs';
import { DomainError, invariant } from './errors.mjs';
import { normalizeAddress } from './dojang-client.mjs';
import { normalizeTransactionHash } from './confirmation.mjs';
import { validateManifest } from './manifest.mjs';

const TRANSITIONS = Object.freeze({
  AWAITING_APPROVAL: new Set(['READY', 'REJECTED']),
  READY: new Set(['EXECUTION_PREPARED', 'REJECTED']),
  EXECUTION_PREPARED: new Set(['PENDING', 'FINALIZED', 'REFUNDED']),
  PENDING: new Set(['PENDING', 'FINALIZED', 'REFUNDED']),
  DENIED: new Set(),
  REJECTED: new Set(),
  FINALIZED: new Set(),
  REFUNDED: new Set(),
});

function createTimestamp(clock) {
  const value = clock();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  invariant(typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp)), 'INVALID_CLOCK', 'Clock must return an ISO timestamp.');
  return timestamp;
}

export class IntentStore {
  constructor({ manifest, policyEngine, clock = () => new Date(), idFactory = randomUUID }) {
    this.manifest = validateManifest(manifest);
    this.policyEngine = policyEngine;
    this.clock = clock;
    this.idFactory = idFactory;
    this.records = new Map();
  }

  #event(record, type, details = {}) {
    record.audit.push({ type, at: createTimestamp(this.clock), ...details });
  }

  #transition(record, next, event, details = {}) {
    const allowed = TRANSITIONS[record.state];
    invariant(allowed?.has(next), 'INVALID_INTENT_TRANSITION', `Cannot transition ${record.state} to ${next}.`, { status: 409 });
    record.state = next;
    record.status = next;
    record.updated_at = createTimestamp(this.clock);
    this.#event(record, event, details);
  }

  createIntent(input, { identity }) {
    const now = createTimestamp(this.clock);
    const payer = normalizeAddress(input.payer ?? input.payerAddress, 'payer address');
    const usage = this.#usageFor(payer, now);
    const id = String(this.idFactory());
    invariant(id.length >= 4 && id.length <= 128, 'INVALID_INTENT_ID', 'Generated intent ID is invalid.');
    invariant(!this.records.has(id), 'DUPLICATE_INTENT_ID', 'Generated intent ID already exists.', { status: 409 });
    const jobNonce = sha256Hex(`xpayr.giwa.job-nonce.v1:${id}`);
    const evaluation = this.policyEngine.evaluate(input, { identity, usage, jobNonce });
    const state = evaluation.decision === 'DENY'
      ? 'DENIED'
      : evaluation.decision === 'HOLD'
        ? 'AWAITING_APPROVAL'
        : 'READY';
    const record = {
      id,
      schema: 'xpayr.giwa.agentpay.intent.v1',
      state,
      status: state,
      intent: evaluation.normalized_intent,
      policy: {
        decision: evaluation.decision,
        verdict: evaluation.verdict,
        reasons: evaluation.reasons,
        decision_hash: evaluation.decision_hash,
        policy_hash: evaluation.policy_hash,
        execution_fingerprint: evaluation.execution_fingerprint,
        snapshot: evaluation.policy_snapshot,
        evaluated_at: evaluation.evaluated_at,
      },
      verification: deepClone(identity),
      approval: {
        required: evaluation.decision === 'HOLD',
        status: evaluation.decision === 'HOLD' ? 'PENDING' : evaluation.decision === 'DENY' ? 'NOT_APPLICABLE' : 'NOT_REQUIRED',
        mode: evaluation.decision === 'HOLD' ? 'manual_local_api_action' : 'not_applicable',
        actor_authentication: 'not_implemented',
        actor: null,
        decided_at: null,
      },
      execution: null,
      confirmation: {
        status: 'NOT_SUBMITTED',
        transaction_hash: null,
        wallet_submission: null,
        flashblocks: null,
        canonical: null,
      },
      reconciliation: {
        payment_session: 'not_completed',
        webhook: 'not_dispatched_local_prototype',
      },
      created_at: now,
      updated_at: now,
      audit: [],
    };
    this.#event(record, 'INTENT_CREATED', { decision: evaluation.decision, state });
    this.records.set(id, record);
    return deepClone(record);
  }

  get(id) {
    const record = this.records.get(String(id));
    if (!record) throw new DomainError('INTENT_NOT_FOUND', 'Intent was not found.', { status: 404 });
    return deepClone(record);
  }

  list({ state = null } = {}) {
    const records = [...this.records.values()]
      .filter((record) => state === null || record.state === state)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    return deepClone(records);
  }

  approve(id, { approver }) {
    const record = this.#mutable(id);
    invariant(record.state === 'AWAITING_APPROVAL', 'APPROVAL_NOT_ALLOWED', 'Intent is not awaiting approval.', { status: 409 });
    const actor = normalizeAddress(approver, 'approver address');
    const actorRole = actor === record.intent.payer
      ? 'payer'
      : record.intent.evaluator && actor === record.intent.evaluator
        ? 'evaluator'
        : null;
    invariant(actorRole !== null, 'UNAUTHORIZED_APPROVER', 'Only the payer/merchant or configured evaluator can approve this intent.', { status: 403 });
    record.approval = {
      required: true,
      status: 'APPROVED',
      mode: 'manual_local_api_action',
      actor_authentication: 'not_implemented',
      actor,
      actor_role: actorRole,
      decided_at: createTimestamp(this.clock),
    };
    this.#transition(record, 'READY', 'MANUAL_APPROVAL_RECORDED', { actor, actor_role: actorRole });
    return deepClone(record);
  }

  reject(id, { actor }) {
    const record = this.#mutable(id);
    invariant(['AWAITING_APPROVAL', 'READY'].includes(record.state), 'REJECTION_NOT_ALLOWED', 'Intent can no longer be rejected.', { status: 409 });
    const normalizedActor = normalizeAddress(actor, 'rejecting actor');
    invariant(normalizedActor === record.intent.payer, 'UNAUTHORIZED_REJECTOR', 'Only the payer/merchant can reject this intent.', { status: 403 });
    record.approval = {
      required: record.approval.required,
      status: 'REJECTED',
      mode: 'manual_local_api_action',
      actor_authentication: 'not_implemented',
      actor: normalizedActor,
      decided_at: createTimestamp(this.clock),
    };
    this.#transition(record, 'REJECTED', 'MERCHANT_REJECTED', { actor: normalizedActor });
    return deepClone(record);
  }

  prepareExecution(id) {
    const record = this.#mutable(id);
    invariant(record.state === 'READY', 'EXECUTION_NOT_ALLOWED', 'Intent is not ready for execution.', { status: 409 });
    invariant(record.policy.decision === 'ALLOW' || record.approval.status === 'APPROVED', 'POLICY_NOT_EXECUTABLE', 'Policy decision is not executable.', { status: 409 });
    const binding = {
      schema: 'xpayr.giwa.execution-binding.v1',
      network_key: this.manifest.network_key,
      chain_id: this.manifest.chain_id,
      job_id: record.intent.job_id,
      job_nonce: record.intent.job_nonce,
      escrow_contract: this.manifest.contracts.escrow,
      requires_contract_deployment: this.manifest.contracts.escrow === null,
      payer: record.intent.payer,
      provider: record.intent.provider,
      evaluator: record.intent.evaluator,
      asset: record.intent.asset,
      amount_atomic: record.intent.amount_atomic,
      expires_at: record.intent.expires_at,
      policy_decision_hash: record.policy.decision_hash,
      execution_fingerprint: record.policy.execution_fingerprint,
      verification_required: true,
      signature_required: true,
      broadcast: false,
      cross_chain: false,
    };
    record.execution = {
      binding,
      binding_hash: sha256Hex(binding),
      consumed_at: createTimestamp(this.clock),
    };
    this.#transition(record, 'EXECUTION_PREPARED', 'EXECUTION_BINDING_CREATED', {
      binding_hash: record.execution.binding_hash,
    });
    return deepClone(record);
  }

  recordFlashblocks(id, signal) {
    const record = this.#mutable(id);
    invariant(['EXECUTION_PREPARED', 'PENDING'].includes(record.state), 'FLASHBLOCKS_NOT_ALLOWED', 'Intent has no prepared execution.', { status: 409 });
    invariant(signal?.source === 'client_reported_flashblocks_pending', 'INVALID_FLASHBLOCKS_SOURCE', 'Flashblocks pending input must remain labeled as client-reported.', { status: 422 });
    invariant(signal?.completed === false && signal?.terminal === false, 'FLASHBLOCKS_CANNOT_COMPLETE', 'Flashblocks cannot complete a payment.', { status: 422 });
    const transactionHash = normalizeTransactionHash(signal.transaction_hash);
    if (record.confirmation.transaction_hash) {
      invariant(record.confirmation.transaction_hash === transactionHash, 'TRANSACTION_HASH_MISMATCH', 'Signal is bound to another transaction.', { status: 409 });
    }
    record.confirmation = {
      ...record.confirmation,
      status: 'PENDING',
      transaction_hash: transactionHash,
      flashblocks: deepClone(signal),
    };
    this.#transition(record, 'PENDING', 'FLASHBLOCKS_PENDING_OBSERVED', { transaction_hash: transactionHash });
    return deepClone(record);
  }

  recordWalletSubmitted(id, { transactionHash, transaction_hash: transactionHashAlias } = {}) {
    const record = this.#mutable(id);
    invariant(['EXECUTION_PREPARED', 'PENDING'].includes(record.state), 'WALLET_SUBMISSION_NOT_ALLOWED', 'Intent has no prepared terminal execution.', { status: 409 });
    const transactionHashValue = normalizeTransactionHash(transactionHash ?? transactionHashAlias);
    if (record.confirmation.transaction_hash) {
      invariant(record.confirmation.transaction_hash === transactionHashValue, 'TRANSACTION_HASH_MISMATCH', 'Wallet submission is bound to another transaction.', { status: 409 });
    }
    if (record.confirmation.wallet_submission?.transaction_hash === transactionHashValue) {
      return deepClone(record);
    }
    const submittedAt = createTimestamp(this.clock);
    record.confirmation = {
      ...record.confirmation,
      status: 'PENDING',
      transaction_hash: transactionHashValue,
      wallet_submission: {
        source: 'client_reported_wallet_submission',
        transaction_hash: transactionHashValue,
        completed: false,
        terminal: false,
        submitted_at: submittedAt,
      },
    };
    this.#transition(record, 'PENDING', 'WALLET_TRANSACTION_SUBMITTED', { transaction_hash: transactionHashValue });
    return deepClone(record);
  }

  finalize(id, result) {
    const record = this.#mutable(id);
    invariant(['EXECUTION_PREPARED', 'PENDING'].includes(record.state), 'FINALIZATION_NOT_ALLOWED', 'Intent cannot be finalized.', { status: 409 });
    invariant(record.execution?.binding?.escrow_contract !== null, 'ESCROW_NOT_DEPLOYED', 'Canonical finalization is disabled until the GIWA escrow deployment is recorded.', { status: 409 });
    invariant(
      result?.source === 'giwa_canonical_rpc'
        && result.canonical_terminal_verified === true
        && result.terminal === true,
      'CANONICAL_FINALITY_REQUIRED',
      'A verified canonical GIWA terminal receipt is required.',
      { status: 422 },
    );
    const released = result.outcome === 'RELEASED' && result.completed === true && result.refunded === false;
    const refunded = result.outcome === 'REFUNDED' && result.refunded === true && result.completed === false;
    invariant(released !== refunded, 'CANONICAL_OUTCOME_REQUIRED', 'Canonical outcome must be exactly RELEASED or REFUNDED.', { status: 422 });
    const transactionHash = normalizeTransactionHash(result.transaction_hash);
    if (record.confirmation.transaction_hash) {
      invariant(record.confirmation.transaction_hash === transactionHash, 'TRANSACTION_HASH_MISMATCH', 'Receipt is bound to another transaction.', { status: 409 });
    }
    record.confirmation = {
      ...record.confirmation,
      status: released ? 'FINALIZED' : 'REFUNDED',
      transaction_hash: transactionHash,
      canonical: deepClone(result),
    };
    record.reconciliation = {
      payment_session: released ? 'completed_from_canonical_receipt' : 'refunded_from_canonical_receipt',
      webhook: 'not_dispatched_local_prototype',
    };
    this.#transition(
      record,
      released ? 'FINALIZED' : 'REFUNDED',
      released ? 'CANONICAL_RELEASE_FINALIZED' : 'CANONICAL_REFUND_FINALIZED',
      { transaction_hash: transactionHash, outcome: result.outcome },
    );
    return deepClone(record);
  }

  #mutable(id) {
    const record = this.records.get(String(id));
    if (!record) throw new DomainError('INTENT_NOT_FOUND', 'Intent was not found.', { status: 404 });
    return record;
  }

  #usageFor(payer, at) {
    const nowMs = Date.parse(at);
    const day = at.slice(0, 10);
    let recentIntentCount = 0;
    let dailyExposure = 0n;
    for (const record of this.records.values()) {
      if (record.intent.payer !== payer) continue;
      const createdMs = Date.parse(record.created_at);
      if (createdMs <= nowMs && nowMs - createdMs < 60 * 60 * 1000) recentIntentCount += 1;
      if (record.created_at.slice(0, 10) === day && !['DENIED', 'REJECTED'].includes(record.state)) {
        dailyExposure += BigInt(record.intent.amount_atomic);
      }
    }
    return {
      recent_intent_count: recentIntentCount,
      daily_spent_atomic: dailyExposure.toString(),
    };
  }
}
