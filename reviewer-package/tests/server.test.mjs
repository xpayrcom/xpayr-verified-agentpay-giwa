import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentPayServer } from '../src/server.mjs';
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
} from './helpers.mjs';

const network = await manifest();
const undeployedRaw = JSON.parse(JSON.stringify(network));
undeployedRaw.contracts.escrow = null;
const undeployedNetwork = validateManifest(undeployedRaw);

async function withServer(run, {
  demoFixture = true,
  selectedManifest = network,
  canonicalClient = null,
  dojangClient = null,
  reviewerIndexPath = undefined,
} = {}) {
  const publicDir = await mkdtemp(join(tmpdir(), 'xpayr-giwa-public-'));
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>AgentPay test</title>', 'utf8');
  const server = await startAgentPayServer({
    port: 0,
    manifest: selectedManifest,
    publicDir,
    demoFixture,
    canonicalClient,
    dojangClient,
    ...(reviewerIndexPath === undefined ? {} : { reviewerIndexPath }),
    logger: { error() {} },
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(publicDir, { recursive: true, force: true });
  }
}

async function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('health and config disclose safe runtime boundaries', async () => withServer(async (baseUrl) => {
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.chainId, 91342);
  assert.equal(health.chainWrites, false);
  assert.equal(health.serverChainWrites, false);
  assert.equal(health.serverTransactionSigning, false);
  assert.equal(health.mode, 'fixture');
  assert.equal(health.walletExecution, false);
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.runtime.demoFixture, true);
  assert.equal(config.runtime.mode, 'fixture');
  assert.equal(config.runtime.walletExecution, false);
  assert.equal(config.runtime.identitySource, 'demo_fixture');
  assert.equal(config.runtime.serverChainWrites, false);
  assert.equal(config.runtime.serverTransactionSigning, false);
  assert.equal(config.runtime.flashblocksCompletionAuthority, false);
  assert.deepEqual(config.runtime.limits, {
    maxJobValueWei: '1000000000000',
    maxGasPerTransaction: '500000',
    maxFeePerGasWei: '3000000',
    maxTotalRequestedCostWei: '10000000000000',
  });
}));

test('sealed reviewer proof endpoint has no caller-selected path and fails closed on tamper', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/reviewer-proof`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'sealed_checked_in_reviewer_index');
    assert.equal(body.proof.integrity.digest, '0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5');
    assert.equal(body.proof.contract.address, '0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53');

    const callerPath = await fetch(`${baseUrl}/api/reviewer-proof?path=../../private/untrusted.json`);
    assert.equal(callerPath.status, 422);
    assert.equal((await callerPath.json()).error.code, 'REVIEWER_PROOF_QUERY_FORBIDDEN');
  });

  const tamperDir = await mkdtemp(join(tmpdir(), 'xpayr-giwa-reviewer-tamper-'));
  const tamperPath = join(tamperDir, 'reviewer-index.json');
  await writeFile(tamperPath, JSON.stringify({
    schema: 'xpayr.giwa.agentpay.reviewer-index.v1',
    chain_id: 91342,
    contract: { address: '0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53' },
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      scope: 'entire_document_except_integrity',
      digest: '0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5',
    },
  }), 'utf8');
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/reviewer-proof`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'REVIEWER_PROOF_INTEGRITY_FAILED');
    }, { reviewerIndexPath: tamperPath });
  } finally {
    await rm(tamperDir, { recursive: true, force: true });
  }
});

test('static index is served with security headers', async () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /AgentPay test/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
}));

test('POST intent supports wallet UI aliases and returns stable presenter fields', async () => withServer(async (baseUrl) => {
  const response = await post(baseUrl, '/api/intents', baseIntent({ asset: 'TEST_ETH' }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.decision, 'ALLOW');
  assert.equal(body.state, 'READY');
  assert.equal(body.intent.payer, ADDRESSES.payer);
  assert.equal(body.intent.amount_wei, '10000000000000000');
  assert.equal(body.intent.decision, 'ALLOW');
  assert.equal(body.intent.status, 'READY');
  assert.equal(body.intent.verification.allVerified, true);
  assert.equal(body.verification.payer.source, 'demo_fixture');
  assert.match(body.evidenceUrl, /^\/api\/intents\//);
}));

test('HOLD can be manually approved and bridged to a non-broadcast undeployed binding', async () => withServer(async (baseUrl) => {
  const created = await (await post(baseUrl, '/api/intents', baseIntent({ requireApproval: true }))).json();
  assert.equal(created.state, 'AWAITING_APPROVAL');
  const approved = await (await post(baseUrl, `/api/intents/${created.id}/approve`, { approver: ADDRESSES.payer })).json();
  assert.equal(approved.state, 'READY');
  const bridged = await (await post(baseUrl, `/api/intents/${created.id}/bridge`, {})).json();
  assert.equal(bridged.state, 'EXECUTION_PREPARED');
  assert.equal(bridged.execution.binding.broadcast, false);
  assert.equal(bridged.execution.binding.requires_contract_deployment, true);
}, { selectedManifest: undeployedNetwork }));

test('caller-supplied identity verdict is rejected', async () => withServer(async (baseUrl) => {
  const response = await post(baseUrl, '/api/intents', { ...baseIntent(), identity: { payer: { verified: true } } });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.error.code, 'UNTRUSTED_IDENTITY_OVERRIDE');
}));

test('caller cannot override trusted usage or server-derived job binding fields', async () => withServer(async (baseUrl) => {
  for (const [field, value, code] of [
    ['recentIntentCount', 0, 'UNTRUSTED_USAGE_OVERRIDE'],
    ['daily_spent_atomic', '0', 'UNTRUSTED_USAGE_OVERRIDE'],
    ['jobId', `0x${'11'.repeat(32)}`, 'UNTRUSTED_JOB_BINDING_OVERRIDE'],
    ['job_nonce', `0x${'22'.repeat(32)}`, 'UNTRUSTED_JOB_BINDING_OVERRIDE'],
  ]) {
    const response = await post(baseUrl, '/api/intents', { ...baseIntent(), [field]: value });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, code);
  }
}));

test('invalid API JSON and unknown route return structured errors', async () => withServer(async (baseUrl) => {
  const invalid = await fetch(`${baseUrl}/api/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_JSON');
  const missing = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'API_NOT_FOUND');
}));

test('static path traversal is blocked', async () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/%2e%2e%2fconfig%2fgiwa-testnet.json`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'PATH_TRAVERSAL');
}));

test('default runtime reports live fail-closed Dojang source', async () => withServer(async (baseUrl, server) => {
  assert.equal(server.runtime.demoFixture, false);
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(config.runtime.identitySource, 'giwa_dojang_live_rpc');
  assert.equal(config.runtime.mode, 'live_wallet');
  assert.equal(config.runtime.walletExecution, true);
}, { demoFixture: false }));

test('live mode exposes wallet execution only for the exact reviewed escrow', async () => {
  const wrongEscrowRaw = JSON.parse(JSON.stringify(network));
  wrongEscrowRaw.contracts.escrow = ADDRESSES.escrow;
  const wrongEscrowNetwork = validateManifest(wrongEscrowRaw);
  await withServer(async (baseUrl) => {
    const config = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.equal(config.runtime.mode, 'live_wallet');
    assert.equal(config.runtime.exactReviewedDeployment, false);
    assert.equal(config.runtime.walletExecution, false);
  }, { demoFixture: false, selectedManifest: wrongEscrowNetwork });
});

test('live mode forbids unauthenticated local decisions and bridges only direct ALLOW intents', async () => {
  const dojangClient = {
    async checkAddress(address) {
      return {
        address: address.toLowerCase(),
        verified: true,
        accepted_attester_id: null,
        checks: [],
        source: 'test_live_dojang_stub',
        checked_at: '2026-07-20T00:00:00.000Z',
      };
    },
  };
  await withServer(async (baseUrl) => {
    const held = await (await post(baseUrl, '/api/intents', baseIntent({ requireApproval: true }))).json();
    assert.equal(held.state, 'AWAITING_APPROVAL');
    for (const [action, body] of [
      ['approve', { approver: ADDRESSES.payer }],
      ['reject', { actor: ADDRESSES.payer }],
    ]) {
      const response = await post(baseUrl, `/api/intents/${held.id}/${action}`, body);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'LIVE_LOCAL_DECISION_FORBIDDEN');
    }
    const heldBridge = await post(baseUrl, `/api/intents/${held.id}/bridge`, {});
    assert.equal(heldBridge.status, 409);
    assert.equal((await heldBridge.json()).error.code, 'LIVE_POLICY_ALLOW_REQUIRED');

    const allowed = await (await post(baseUrl, '/api/intents', baseIntent({ requireApproval: false }))).json();
    assert.equal(allowed.state, 'READY');
    const bridge = await post(baseUrl, `/api/intents/${allowed.id}/bridge`, {});
    assert.equal(bridge.status, 200);
    assert.equal((await bridge.json()).state, 'EXECUTION_PREPARED');
  }, { demoFixture: false, dojangClient });
});

test('remaining API routes are wired and an explicit undeployed fixture fails canonical finality closed', async () => withServer(async (baseUrl) => {
  const dojang = await (await fetch(`${baseUrl}/api/dojang/${ADDRESSES.payer}`)).json();
  assert.equal(dojang.verdict.verified, true);
  assert.equal(dojang.identitySource, 'demo_fixture');

  const created = await (await post(baseUrl, '/api/intents', baseIntent())).json();
  const detail = await (await fetch(`${baseUrl}/api/intents/${created.id}`)).json();
  assert.equal(detail.id, created.id);
  const list = await (await fetch(`${baseUrl}/api/intents?state=READY`)).json();
  assert.equal(list.count, 1);
  const evidence = await (await fetch(`${baseUrl}/api/intents/${created.id}/evidence`)).json();
  assert.equal(evidence.evidence.integrity.algorithm, 'sha256');

  const rejected = await (await post(baseUrl, `/api/intents/${created.id}/reject`, { actor: ADDRESSES.payer })).json();
  assert.equal(rejected.state, 'REJECTED');

  const executionIntent = await (await post(baseUrl, '/api/intents', baseIntent({ title: 'Confirmation route demo' }))).json();
  await post(baseUrl, `/api/intents/${executionIntent.id}/bridge`, {});
  const submitted = await (await post(baseUrl, `/api/intents/${executionIntent.id}/confirmations/wallet-submitted`, {
    transactionHash: TX_HASH,
  })).json();
  assert.equal(submitted.state, 'PENDING');
  assert.equal(submitted.confirmation.wallet_submission.source, 'client_reported_wallet_submission');
  assert.equal(submitted.confirmation.wallet_submission.completed, false);
  const pending = await (await post(baseUrl, `/api/intents/${executionIntent.id}/confirmations/flashblocks`, {
    transactionHash: TX_HASH,
  })).json();
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.confirmation.flashblocks.completed, false);
  assert.equal(pending.confirmation.flashblocks.source, 'client_reported_flashblocks_pending');

  const canonical = await post(baseUrl, `/api/intents/${executionIntent.id}/confirmations/canonical`, {
    transactionHash: TX_HASH,
  });
  assert.equal(canonical.status, 409);
  assert.equal((await canonical.json()).error.code, 'ESCROW_NOT_DEPLOYED');
}, { selectedManifest: undeployedNetwork }));

test('canonical endpoint ignores no caller proof, refetches bound data, and rejects adversarial releases', async () => {
  const deployedRaw = JSON.parse(JSON.stringify(network));
  deployedRaw.contracts.escrow = ADDRESSES.escrow;
  const deployedNetwork = validateManifest(deployedRaw);
  let proof = null;
  let calls = 0;
  const canonicalClient = {
    async fetchTerminalProof() {
      calls += 1;
      return proof;
    },
  };

  await withServer(async (baseUrl, server) => {
    const created = await (await post(baseUrl, '/api/intents', baseIntent())).json();
    await post(baseUrl, `/api/intents/${created.id}/bridge`, {});
    await post(baseUrl, `/api/intents/${created.id}/confirmations/flashblocks`, { transactionHash: TX_HASH });
    const stored = server.agentPay.store.get(created.id);
    const validProof = {
      proofSource: 'canonical_rpc_refetch',
      proofChainId: 91342,
      receipt: canonicalReceipt({ jobId: stored.intent.job_id }),
      transaction: canonicalTransaction({ jobId: stored.intent.job_id }),
      headBlockNumber: '0x64',
      canonicalBlock: canonicalBlock(),
      jobState: canonicalJobState({
        job_nonce: stored.intent.job_nonce,
        expires_at: stored.intent.expires_at,
        policy_decision_hash: stored.policy.decision_hash,
      }),
    };

    const browserProof = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, {
      transactionHash: TX_HASH,
      receipt: validProof.receipt,
    });
    assert.equal(browserProof.status, 422);
    assert.equal((await browserProof.json()).error.code, 'CANONICAL_REQUEST_OVERRIDE_FORBIDDEN');
    assert.equal(calls, 0);

    const otherHash = `0x${'cd'.repeat(32)}`;
    const replacedHash = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, {
      transactionHash: otherHash,
    });
    assert.equal(replacedHash.status, 409);
    assert.equal((await replacedHash.json()).error.code, 'TRANSACTION_HASH_MISMATCH');
    assert.equal(calls, 0);

    proof = {
      ...validProof,
      receipt: canonicalReceipt({ jobId: stored.intent.job_id, actor: ADDRESSES.outsider }),
      transaction: canonicalTransaction({ jobId: stored.intent.job_id, from: ADDRESSES.outsider }),
    };
    const outsider = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, { transactionHash: TX_HASH });
    assert.equal(outsider.status, 422);
    assert.equal((await outsider.json()).error.code, 'CANONICAL_FINALITY_REQUIRED');

    proof = {
      ...validProof,
      receipt: canonicalReceipt({ jobId: `0x${'99'.repeat(32)}` }),
    };
    const wrongJob = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, { transactionHash: TX_HASH });
    assert.equal(wrongJob.status, 422);
    assert.equal((await wrongJob.json()).error.code, 'CANONICAL_FINALITY_REQUIRED');

    proof = validProof;
    const finalized = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, { transactionHash: TX_HASH });
    assert.equal(finalized.status, 200);
    const finalBody = await finalized.json();
    assert.equal(finalBody.state, 'FINALIZED');
    assert.equal(finalBody.confirmation.canonical.checks.job_state_job_nonce, true);
    assert.equal(calls, 3);
  }, { selectedManifest: deployedNetwork, canonicalClient });
});

test('canonical verification succeeds without a Flashblocks observation and preserves refund semantics', async () => {
  const deployedRaw = JSON.parse(JSON.stringify(network));
  deployedRaw.contracts.escrow = ADDRESSES.escrow;
  const deployedNetwork = validateManifest(deployedRaw);
  let proof = null;
  let request = null;
  const canonicalClient = {
    async fetchTerminalProof(input) {
      request = input;
      return proof;
    },
  };

  await withServer(async (baseUrl, server) => {
    const created = await (await post(baseUrl, '/api/intents', baseIntent())).json();
    await post(baseUrl, `/api/intents/${created.id}/bridge`, {});
    const stored = server.agentPay.store.get(created.id);
    proof = {
      proofSource: 'canonical_rpc_refetch',
      proofChainId: 91342,
      receipt: canonicalRefundReceipt({ jobId: stored.intent.job_id }),
      transaction: canonicalTransaction({ jobId: stored.intent.job_id, action: 'claim_refund' }),
      headBlockNumber: '0x64',
      canonicalBlock: canonicalBlock(),
      jobState: canonicalJobState({
        job_nonce: stored.intent.job_nonce,
        expires_at: stored.intent.expires_at,
        policy_decision_hash: stored.policy.decision_hash,
        status: 7,
        deliverable_hash: `0x${'0'.repeat(64)}`,
      }),
    };

    const response = await post(baseUrl, `/api/intents/${created.id}/confirmations/canonical`, {
      transactionHash: TX_HASH,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, 'REFUNDED');
    assert.equal(body.confirmation.canonical.outcome, 'REFUNDED');
    assert.equal(body.confirmation.canonical.completed, false);
    assert.equal(body.confirmation.canonical.refunded, true);
    assert.equal(body.reconciliation.payment_session, 'refunded_from_canonical_receipt');
    assert.deepEqual(request, {
      transactionHash: TX_HASH,
      escrowAddress: ADDRESSES.escrow,
      jobId: stored.intent.job_id,
    });
  }, { selectedManifest: deployedNetwork, canonicalClient });
});
