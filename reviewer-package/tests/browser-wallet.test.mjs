import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Interface, keccak256 } from 'ethers';
import {
  EXPECTED_ESCROW,
  WALLET_LIMITS,
  createJob,
  deriveJobId,
  getSession,
  GIWA_CHAIN,
  resolveDispute,
  submitDeliverable,
  watchSession,
} from '../browser/agentpay-wallet.mjs';

const PAYER = '0x1111111111111111111111111111111111111111';
const OUTSIDER = '0x2222222222222222222222222222222222222222';
const NONCE = `0x${'ab'.repeat(32)}`;
const POLICY_HASH = `0x${'cd'.repeat(32)}`;
const TX_HASH = `0x${'ef'.repeat(32)}`;
const execFileAsync = promisify(execFile);

async function reviewedRuntimeCode() {
  const artifact = JSON.parse(await readFile(new URL('../artifacts/solc/XPayrVerifiedAgentEscrow.json', import.meta.url), 'utf8'));
  const values = {
    55: '0x000000000000000000000000d5077b67dcb56cac8b270c7788fc3e6ee03f17b9',
    57: '0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034',
    59: '0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678',
  };
  const bytes = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  for (const [slot, references] of Object.entries(artifact.immutableReferences)) {
    for (const reference of references) {
      Buffer.from(values[slot].slice(2), 'hex').copy(bytes, reference.start);
    }
  }
  return `0x${bytes.toString('hex')}`;
}

class MockEthereum {
  constructor(code) {
    this.accounts = [PAYER];
    this.chainId = GIWA_CHAIN.chainId;
    this.code = code;
    this.calls = [];
    this.handlers = new Map();
    this.sendCalls = 0;
    this.holdNextSend = false;
    this.cancelNextSend = false;
    this.sendStarted = null;
    this.resolveHeldSend = null;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
  }

  removeListener(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  async request({ method, params }) {
    this.calls.push({ method, params });
    switch (method) {
      case 'eth_requestAccounts': return [...this.accounts];
      case 'eth_accounts': return [...this.accounts];
      case 'wallet_switchEthereumChain':
        this.chainId = params[0].chainId;
        return null;
      case 'wallet_addEthereumChain': return null;
      case 'eth_chainId': return this.chainId;
      case 'eth_getCode': return this.code;
      case 'eth_estimateGas': return '0x186a0';
      case 'eth_gasPrice': return '0xf4240';
      case 'eth_maxPriorityFeePerGas': return '0xf4240';
      case 'eth_sendTransaction': {
        this.sendCalls += 1;
        if (this.cancelNextSend) {
          this.cancelNextSend = false;
          throw Object.assign(new Error('User rejected'), { code: 4001 });
        }
        if (this.holdNextSend) {
          this.holdNextSend = false;
          return new Promise((resolve) => {
            this.resolveHeldSend = resolve;
            this.sendStarted?.();
          });
        }
        return TX_HASH;
      }
      default: throw new Error(`Unexpected mock RPC method: ${method}`);
    }
  }
}

test('browser derives the same payer-bound job ID shape enforced by Solidity', () => {
  assert.equal(
    deriveJobId(PAYER, NONCE),
    '0xb7ff36d697a6fde72de475d4417893b0f76c6eac829e7ab1c9495780e0158e43',
  );
  assert.equal(GIWA_CHAIN.chainId, '0x164ce');
});

test('wallet ABI and role gate contain no legacy verification downgrade', async () => {
  const source = await readFile(new URL('../browser/agentpay-wallet.mjs', import.meta.url), 'utf8');
  const createJobSignature = source.match(/function createJob\([^']+\)/)?.[0] ?? '';
  assert.equal(
    createJobSignature,
    'function createJob(bytes32 jobId,bytes32 jobNonce,address provider,address evaluator,uint128 expectedAmount,uint64 expiresAt,bytes32 policyDecisionHash)',
  );
  assert.doesNotMatch(createJobSignature, /bool verificationRequired/);
  assert.match(source, /allowedAddresses: \[payer\], roleLabel: 'payer'/);
  assert.match(source, /eth_sendTransaction/);
  assert.doesNotMatch(source, /sendTransaction\([^)]*\)\.catch|code\) === 4001[^}]+send/);
});

test('wallet produces immutable capped previews and re-verifies exact chain, account, escrow and bytecode before a one-shot send', async () => {
  const code = await reviewedRuntimeCode();
  assert.equal((code.length - 2) / 2, EXPECTED_ESCROW.runtimeCodeBytes);
  assert.equal(keccak256(code), EXPECTED_ESCROW.runtimeCodeKeccak256);
  const wallet = new MockEthereum(code);
  globalThis.window = { ethereum: wallet };

  const sessions = [];
  const unwatch = watchSession((value) => sessions.push(value));
  const connection = await (await import('../browser/agentpay-wallet.mjs')).connect();
  assert.deepEqual(connection, { address: PAYER, chainId: 91342 });
  assert.equal(getSession().status, 'connected');

  const jobId = deriveJobId(PAYER, NONCE);
  const actionInput = {
    contractAddress: EXPECTED_ESCROW.address,
    jobId,
    jobNonce: NONCE,
    payer: PAYER,
    provider: OUTSIDER,
    evaluator: null,
    amountAtomic: WALLET_LIMITS.maxJobValueWei,
    expiresAt: 1_800_000_000,
    policyDecisionHash: POLICY_HASH,
  };
  const prepared = await createJob(actionInput);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.preview));
  assert.deepEqual(Object.keys(prepared.preview), [
    'action', 'to', 'from', 'chainId', 'decoded', 'data', 'valueWei', 'gasLimit',
    'maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'maxTotalRequestedCostWei',
  ]);
  assert.equal(prepared.preview.action, 'createJob');
  assert.equal(prepared.preview.to, EXPECTED_ESCROW.address);
  assert.equal(prepared.preview.from, PAYER);
  assert.equal(prepared.preview.chainId, 91342);
  assert.ok(Object.isFrozen(prepared.preview.decoded));
  assert.deepEqual(prepared.preview.decoded, {
    method: 'createJob',
    jobId,
    jobNonce: NONCE,
    provider: OUTSIDER,
    evaluator: '0x0000000000000000000000000000000000000000',
    expectedAmountWei: WALLET_LIMITS.maxJobValueWei,
    expiresAt: '1800000000',
    policyDecisionHash: POLICY_HASH,
  });
  const decodedCalldata = new Interface([
    'function createJob(bytes32 jobId,bytes32 jobNonce,address provider,address evaluator,uint128 expectedAmount,uint64 expiresAt,bytes32 policyDecisionHash)',
  ]).decodeFunctionData('createJob', prepared.preview.data);
  assert.equal(decodedCalldata.jobId, prepared.preview.decoded.jobId);
  assert.equal(decodedCalldata.jobNonce, prepared.preview.decoded.jobNonce);
  assert.equal(decodedCalldata.provider, prepared.preview.decoded.provider);
  assert.equal(decodedCalldata.evaluator, prepared.preview.decoded.evaluator);
  assert.equal(decodedCalldata.expectedAmount.toString(), prepared.preview.decoded.expectedAmountWei);
  assert.equal(decodedCalldata.expiresAt.toString(), prepared.preview.decoded.expiresAt);
  assert.equal(decodedCalldata.policyDecisionHash, prepared.preview.decoded.policyDecisionHash);

  const deliverableHash = `0x${'12'.repeat(32)}`;
  const submitted = await submitDeliverable({
    contractAddress: EXPECTED_ESCROW.address,
    jobId,
    provider: PAYER,
    deliverableHash,
  });
  assert.deepEqual(submitted.preview.decoded, {
    method: 'submitDeliverable',
    jobId,
    deliverableHash,
  });
  const resolved = await resolveDispute({
    contractAddress: EXPECTED_ESCROW.address,
    jobId,
    resolver: PAYER,
    payProvider: false,
  });
  assert.deepEqual(resolved.preview.decoded, {
    method: 'resolveDispute',
    jobId,
    payProvider: false,
  });
  assert.equal(prepared.preview.valueWei, '0');
  assert.equal(prepared.preview.gasLimit, '120000');
  assert.equal(prepared.preview.maxFeePerGasWei, '1000000');
  assert.equal(prepared.preview.maxPriorityFeePerGasWei, '1000000');
  assert.equal(prepared.preview.maxTotalRequestedCostWei, '120000000000');

  await assert.rejects(
    createJob({ ...actionInput, amountAtomic: (BigInt(WALLET_LIMITS.maxJobValueWei) + 1n).toString() }),
    { code: 'MAX_JOB_VALUE_EXCEEDED' },
  );
  await assert.rejects(createJob({ ...actionInput, payer: OUTSIDER, jobId: deriveJobId(OUTSIDER, NONCE) }), { code: 'WALLET_ROLE_FORBIDDEN' });
  await assert.rejects(createJob({ ...actionInput, contractAddress: OUTSIDER }), { code: 'UNRECOGNIZED_ESCROW' });
  wallet.code = '0x6000';
  await assert.rejects(createJob(actionInput), { code: 'ESCROW_BYTECODE_MISMATCH' });
  wallet.code = code;

  const first = await createJob(actionInput);
  const second = await createJob(actionInput);
  let markSendStarted;
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  wallet.sendStarted = markSendStarted;
  wallet.holdNextSend = true;
  const firstSend = first.send();
  await sendStarted;
  await assert.rejects(second.send(), { code: 'WALLET_TRANSACTION_IN_FLIGHT' });
  wallet.resolveHeldSend(TX_HASH);
  assert.equal((await firstSend).hash, TX_HASH);
  await assert.rejects(first.send(), { code: 'WALLET_PREVIEW_ALREADY_USED' });

  const cancelled = await createJob(actionInput);
  const sendCallsBeforeCancel = wallet.sendCalls;
  wallet.cancelNextSend = true;
  await assert.rejects(cancelled.send(), { code: 4001 });
  assert.equal(wallet.sendCalls, sendCallsBeforeCancel + 1);
  await assert.rejects(cancelled.send(), { code: 'WALLET_PREVIEW_ALREADY_USED' });
  assert.equal(wallet.sendCalls, sendCallsBeforeCancel + 1);

  wallet.accounts = [OUTSIDER];
  wallet.emit('accountsChanged', wallet.accounts);
  assert.equal(getSession().status, 'invalidated');
  assert.equal(getSession().reason, 'accounts_changed_reconnect_required');
  wallet.accounts = [PAYER];
  await (await import('../browser/agentpay-wallet.mjs')).connect();
  wallet.chainId = '0x1';
  wallet.emit('chainChanged', wallet.chainId);
  assert.equal(getSession().chainId, 1);
  assert.equal(getSession().reason, 'chain_changed_reconnect_required');
  wallet.chainId = GIWA_CHAIN.chainId;
  await (await import('../browser/agentpay-wallet.mjs')).connect();
  wallet.emit('disconnect');
  assert.equal(getSession().status, 'disconnected');
  assert.equal(sessions.at(-1).reason, 'wallet_disconnected');
  unwatch();
  delete globalThis.window;
});

test('checked-in browser bundle is generated from the wallet source', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/build-wallet-client.mjs', '--check'], {
    cwd: new URL('..', import.meta.url),
  });
  assert.match(stdout, /Checked public\/agentpay-wallet\.js/);
});

test('terminal browser handoff supplies only a transaction hash to canonical verification', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const terminalFunction = source.slice(
    source.indexOf('async function finalizeTerminalEvidence'),
    source.indexOf('async function prepareAndCreateJob'),
  );
  assert.match(terminalFunction, /JSON\.stringify\(\{ transactionHash(?:\s*[:,}])/);
  assert.doesNotMatch(terminalFunction, /headBlockNumber|body\.expected|receipt:\s*\{/);
});

test('reviewer UI prefers Phase-4 SoD lifecycles and exposes their XPA2 anchors', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const reviewerFunction = source.slice(
    source.indexOf('function renderReviewerProof'),
    source.indexOf('async function loadReviewerProof'),
  );
  assert.ok(
    reviewerFunction.indexOf('phase4_separation_of_duties.authenticated_lifecycles')
      < reviewerFunction.indexOf('signed_policy_authenticated_d3'),
  );
  assert.match(reviewerFunction, /D3 \+ XPA2/);
  assert.match(reviewerFunction, /Separated duties/);
});
