import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanonicalReceipt, evaluateFlashblocksSignal } from '../src/confirmation.mjs';
import { IntentStore } from '../src/intent-store.mjs';
import { deriveJobId, PolicyEngine } from '../src/policy-engine.mjs';
import { validateManifest } from '../src/manifest.mjs';
import {
  ADDRESSES,
  baseIntent,
  canonicalBlock,
  canonicalJobState,
  canonicalReceipt,
  canonicalRefundReceipt,
  canonicalTransaction,
  manifest,
  TX_HASH,
  verifiedIdentity,
} from './helpers.mjs';

const network = await manifest();

function storeFactory(selectedManifest = network) {
  let id = 0;
  let second = 0;
  const clock = () => new Date(Date.UTC(2026, 6, 19, 0, 0, second++));
  const policyEngine = new PolicyEngine({ manifest: selectedManifest, now: () => '2026-07-19T00:00:00.000Z' });
  return new IntentStore({ manifest: selectedManifest, policyEngine, clock, idFactory: () => `intent-${++id}` });
}

test('ALLOW intent becomes READY', () => {
  const record = storeFactory().createIntent(baseIntent(), { identity: verifiedIdentity() });
  assert.equal(record.state, 'READY');
  assert.equal(record.policy.decision, 'ALLOW');
});

test('HOLD requires manual payer approval', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent({ requireApproval: true }), { identity: verifiedIdentity() });
  assert.equal(record.state, 'AWAITING_APPROVAL');
  const approved = store.approve(record.id, { approver: ADDRESSES.payer });
  assert.equal(approved.state, 'READY');
  assert.equal(approved.approval.mode, 'manual_local_api_action');
  assert.equal(approved.approval.actor_authentication, 'not_implemented');
  assert.equal(approved.approval.actor_role, 'payer');
});

test('configured evaluator may manually approve HOLD', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent({ requireApproval: true, evaluatorAddress: ADDRESSES.evaluator }), { identity: verifiedIdentity() });
  const approved = store.approve(record.id, { approver: ADDRESSES.evaluator });
  assert.equal(approved.state, 'READY');
  assert.equal(approved.approval.actor_role, 'evaluator');
});

test('unconfigured actor cannot approve', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent({ requireApproval: true }), { identity: verifiedIdentity() });
  assert.throws(() => store.approve(record.id, { approver: ADDRESSES.outsider }), { code: 'UNAUTHORIZED_APPROVER' });
});

test('payer can reject but execution cannot be prepared afterward', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  assert.equal(store.reject(record.id, { actor: ADDRESSES.payer }).state, 'REJECTED');
  assert.throws(() => store.prepareExecution(record.id), { code: 'EXECUTION_NOT_ALLOWED' });
});

test('DENY never produces an execution binding', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent(), { identity: {} });
  assert.equal(record.state, 'DENIED');
  assert.throws(() => store.prepareExecution(record.id), { code: 'EXECUTION_NOT_ALLOWED' });
});

test('execution binding is single-use, chain-local and never broadcast', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  const prepared = store.prepareExecution(record.id);
  assert.equal(prepared.state, 'EXECUTION_PREPARED');
  assert.equal(prepared.execution.binding.chain_id, 91342);
  assert.equal(prepared.execution.binding.verification_required, true);
  assert.equal(prepared.execution.binding.broadcast, false);
  assert.equal(prepared.execution.binding.cross_chain, false);
  assert.throws(() => store.prepareExecution(record.id), { code: 'EXECUTION_NOT_ALLOWED' });
});

test('Flashblocks moves intent to PENDING but cannot finalize it', () => {
  const deployedRaw = JSON.parse(JSON.stringify(network));
  deployedRaw.contracts.escrow = ADDRESSES.escrow;
  const store = storeFactory(validateManifest(deployedRaw));
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  store.prepareExecution(record.id);
  const pending = store.recordFlashblocks(record.id, evaluateFlashblocksSignal({ transactionHash: TX_HASH }));
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.confirmation.flashblocks.completed, false);
  assert.throws(() => store.finalize(record.id, pending.confirmation.flashblocks), { code: 'CANONICAL_FINALITY_REQUIRED' });
});

test('wallet submission persists a terminal transaction hash before optional Flashblocks observation', () => {
  const store = storeFactory();
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  store.prepareExecution(record.id);
  const pending = store.recordWalletSubmitted(record.id, { transactionHash: TX_HASH });
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.confirmation.transaction_hash, TX_HASH);
  assert.equal(pending.confirmation.wallet_submission.source, 'client_reported_wallet_submission');
  assert.equal(pending.confirmation.wallet_submission.completed, false);
  assert.equal(store.recordWalletSubmitted(record.id, { transactionHash: TX_HASH }).confirmation.transaction_hash, TX_HASH);
  assert.throws(
    () => store.recordWalletSubmitted(record.id, { transactionHash: `0x${'cd'.repeat(32)}` }),
    { code: 'TRANSACTION_HASH_MISMATCH' },
  );
});

test('verified canonical receipt finalizes exactly once', () => {
  const deployedRaw = JSON.parse(JSON.stringify(network));
  deployedRaw.contracts.escrow = ADDRESSES.escrow;
  const deployedNetwork = validateManifest(deployedRaw);
  const store = storeFactory(deployedNetwork);
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  store.prepareExecution(record.id);
  store.recordFlashblocks(record.id, evaluateFlashblocksSignal({ transactionHash: TX_HASH }));
  const result = evaluateCanonicalReceipt({
    manifest: deployedNetwork,
    proofSource: 'canonical_rpc_refetch',
    proofChainId: 91342,
    receipt: canonicalReceipt({ jobId: record.intent.job_id }),
    transaction: canonicalTransaction({ jobId: record.intent.job_id }),
    headBlockNumber: 100,
    canonicalBlock: canonicalBlock(),
    jobState: canonicalJobState({
      job_nonce: record.intent.job_nonce,
      expires_at: record.intent.expires_at,
      policy_decision_hash: record.policy.decision_hash,
    }),
    expected: {
      transactionHash: TX_HASH,
      contractAddress: ADDRESSES.escrow,
      jobId: record.intent.job_id,
      jobNonce: record.intent.job_nonce,
      payer: ADDRESSES.payer,
      provider: ADDRESSES.provider,
      evaluator: null,
      allowedSenders: [ADDRESSES.payer, ADDRESSES.provider],
      amountAtomic: '10000000000000000',
      expiresAt: record.intent.expires_at,
      policyDecisionHash: record.policy.decision_hash,
    },
  });
  const final = store.finalize(record.id, result);
  assert.equal(final.state, 'FINALIZED');
  assert.equal(final.reconciliation.payment_session, 'completed_from_canonical_receipt');
  assert.throws(() => store.finalize(record.id, result), { code: 'FINALIZATION_NOT_ALLOWED' });
});

test('verified canonical refund terminates as REFUNDED without claiming payment completion', () => {
  const deployedRaw = JSON.parse(JSON.stringify(network));
  deployedRaw.contracts.escrow = ADDRESSES.escrow;
  const deployedNetwork = validateManifest(deployedRaw);
  const store = storeFactory(deployedNetwork);
  const record = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  store.prepareExecution(record.id);
  const result = evaluateCanonicalReceipt({
    manifest: deployedNetwork,
    proofSource: 'canonical_rpc_refetch',
    proofChainId: 91342,
    receipt: canonicalRefundReceipt({ jobId: record.intent.job_id }),
    transaction: canonicalTransaction({ jobId: record.intent.job_id, action: 'claim_refund' }),
    headBlockNumber: 100,
    canonicalBlock: canonicalBlock(),
    jobState: canonicalJobState({
      job_nonce: record.intent.job_nonce,
      expires_at: record.intent.expires_at,
      policy_decision_hash: record.policy.decision_hash,
      status: 7,
      deliverable_hash: `0x${'0'.repeat(64)}`,
    }),
    expected: {
      transactionHash: TX_HASH,
      contractAddress: ADDRESSES.escrow,
      jobId: record.intent.job_id,
      jobNonce: record.intent.job_nonce,
      payer: ADDRESSES.payer,
      provider: ADDRESSES.provider,
      evaluator: null,
      allowedSenders: [ADDRESSES.payer, ADDRESSES.provider],
      amountAtomic: '10000000000000000',
      expiresAt: record.intent.expires_at,
      policyDecisionHash: record.policy.decision_hash,
    },
  });
  const final = store.finalize(record.id, result);
  assert.equal(final.state, 'REFUNDED');
  assert.equal(final.status, 'REFUNDED');
  assert.equal(final.confirmation.canonical.completed, false);
  assert.equal(final.confirmation.canonical.refunded, true);
  assert.equal(final.reconciliation.payment_session, 'refunded_from_canonical_receipt');
});

test('returned records are defensive clones', () => {
  const store = storeFactory();
  const created = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  created.state = 'FINALIZED';
  assert.equal(store.get(created.id).state, 'READY');
});

test('identical intents receive distinct server-derived nonces and ABI-valid job IDs', () => {
  const store = storeFactory();
  const first = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  const second = store.createIntent(baseIntent(), { identity: verifiedIdentity() });
  assert.notEqual(first.intent.job_nonce, second.intent.job_nonce);
  assert.notEqual(first.intent.job_id, second.intent.job_id);
  assert.equal(first.intent.job_id, deriveJobId(first.intent.payer, first.intent.job_nonce));
  assert.equal(second.intent.job_id, deriveJobId(second.intent.payer, second.intent.job_nonce));
});

test('caller usage fields cannot bypass store-derived velocity context', () => {
  const store = storeFactory();
  for (let index = 0; index < 10; index += 1) {
    store.createIntent(baseIntent({ title: `Intent ${index}`, recentIntentCount: 0 }), { identity: verifiedIdentity() });
  }
  const limited = store.createIntent(baseIntent({ title: 'Attempted bypass', recentIntentCount: 0 }), { identity: verifiedIdentity() });
  assert.equal(limited.policy.decision, 'DENY');
  assert.ok(limited.policy.reasons.includes('VELOCITY_LIMIT_EXCEEDED'));
});

test('caller daily-spend fields cannot bypass store-derived exposure', () => {
  const store = storeFactory();
  const first = store.createIntent(baseIntent({ amountEth: '1', dailySpentAtomic: '0' }), { identity: verifiedIdentity() });
  assert.notEqual(first.policy.decision, 'DENY');
  const second = store.createIntent(baseIntent({ amountEth: '1', dailySpentAtomic: '0' }), { identity: verifiedIdentity() });
  assert.notEqual(second.policy.decision, 'DENY');
  const blocked = store.createIntent(baseIntent({ amountEth: '0.01', dailySpentAtomic: '0' }), { identity: verifiedIdentity() });
  assert.equal(blocked.policy.decision, 'DENY');
  assert.ok(blocked.policy.reasons.includes('DAILY_LIMIT_EXCEEDED'));
});
