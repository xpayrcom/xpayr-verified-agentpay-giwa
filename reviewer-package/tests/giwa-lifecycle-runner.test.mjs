import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet, hexlify, keccak256, toUtf8Bytes } from 'ethers';
import {
  ESCROW_LIFECYCLE_INTERFACE,
  LIFECYCLE_LIMITS,
  parseLifecycleArgs,
  runLifecycle,
  validateLifecycleOptions,
  verifyLifecycleStepReceipts,
  verifyRecordedDeployment,
} from '../scripts/run-giwa-lifecycle.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { deriveJobId } from '../src/policy-engine.mjs';
import { buildPolicyEvidence, signPolicyEvidence } from '../src/policy-evidence.mjs';
import { ADDRESSES, BLOCK_HASH, manifest as loadTestManifest } from './helpers.mjs';

const baseNetwork = await loadTestManifest();
const rawDeployedNetwork = JSON.parse(JSON.stringify(baseNetwork));
rawDeployedNetwork.contracts.escrow = ADDRESSES.escrow;
const deployedNetwork = validateManifest(rawDeployedNetwork);
const JOB_NONCE = `0x${'51'.repeat(32)}`;
const POLICY_HASH = `0x${'52'.repeat(32)}`;
const DELIVERABLE_HASH = `0x${'53'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ESCROW_SELECTORS = Object.freeze({
  dojang: ESCROW_LIFECYCLE_INTERFACE.getFunction('dojangScroll').selector,
  upbit: ESCROW_LIFECYCLE_INTERFACE.getFunction('upbitKoreaAttesterId').selector,
});
const SIGNED_TRANSACTION_REQUESTS = new Map();

const deployment = Object.freeze({
  networkKey: 'giwa-testnet',
  chainId: 91342,
  mainnet: false,
  status: 'deployed_testnet',
  contractAddress: ADDRESSES.escrow,
  constructor: {
    attesterIds: {
      upbitKorea: deployedNetwork.dojang.attester_allowlist[0].id,
      testnetFaucet: deployedNetwork.dojang.attester_allowlist[1].id,
    },
  },
});

test('recorded deployment verification binds receipt, canonical block, runtime, and immutables', async () => {
  const artifact = JSON.parse(await readFile(
    new URL('../artifacts/solc/XPayrVerifiedAgentEscrow.json', import.meta.url),
    'utf8',
  ));
  const receiptHash = `0x${'61'.repeat(32)}`;
  const blockHash = `0x${'62'.repeat(32)}`;
  const verifiedDeployment = {
    ...deployment,
    deploymentTransactionHash: receiptHash,
    sourceVerification: 'not_submitted',
    evidence: { runtimeCodePresent: true, runtimeBytecodeVerified: true, explorerVerified: false },
  };
  const provider = {
    async getCode() { return artifact.deployedBytecode; },
    async getTransactionReceipt(hash) {
      assert.equal(hash, receiptHash);
      return { status: 1, contractAddress: ADDRESSES.escrow, blockNumber: 88, blockHash };
    },
    async getBlock(number) {
      assert.equal(number, 88);
      return { number, hash: blockHash };
    },
    async call({ data }) {
      const functionName = data.slice(0, 10) === ESCROW_SELECTORS.dojang
        ? 'dojangScroll'
        : data.slice(0, 10) === ESCROW_SELECTORS.upbit
          ? 'upbitKoreaAttesterId'
          : 'testnetFaucetAttesterId';
      const value = functionName === 'dojangScroll'
        ? deployedNetwork.contracts.dojang_scroll
        : functionName === 'upbitKoreaAttesterId'
          ? verifiedDeployment.constructor.attesterIds.upbitKorea
          : verifiedDeployment.constructor.attesterIds.testnetFaucet;
      return ESCROW_LIFECYCLE_INTERFACE.encodeFunctionResult(functionName, [value]);
    },
  };
  const result = await verifyRecordedDeployment({
    provider,
    manifest: deployedNetwork,
    deployment: verifiedDeployment,
    escrowAddress: ADDRESSES.escrow,
  });
  assert.equal(result.deployment_transaction_hash, receiptHash);
  assert.equal(result.deployment_block_hash, blockHash);
  assert.equal(result.runtime_bytecode.matches, true);
  assert.equal(result.runtime_bytecode.byteLength, 7_527);
});

test('recorded deployment verification rejects an unproven runtime before RPC reads', async () => {
  let rpcCalled = false;
  const provider = new Proxy({}, {
    get() {
      rpcCalled = true;
      return async () => { throw new Error('must not query'); };
    },
  });
  await assert.rejects(verifyRecordedDeployment({
    provider,
    manifest: deployedNetwork,
    deployment: { ...deployment, evidence: { runtimeCodePresent: true, runtimeBytecodeVerified: false } },
    escrowAddress: ADDRESSES.escrow,
  }), { code: 'DEPLOYMENT_BYTECODE_PROOF_REQUIRED' });
  assert.equal(rpcCalled, false);
});

function options({ execute = false, resume = false, outcome = 'release', runId = `lifecycle-${outcome}-001`, overrides = {} } = {}) {
  return {
    execute,
    resume,
    confirmChainId: 91342,
    confirmNetwork: 'giwa-testnet',
    confirmTestnetOnly: 'GIWA_SEPOLIA_TEST_ETH_ONLY',
    runId,
    outcome,
    payer: ADDRESSES.payer,
    provider: ADDRESSES.provider,
    evaluator: ADDRESSES.evaluator,
    jobNonce: JOB_NONCE,
    jobId: deriveJobId(ADDRESSES.payer, JOB_NONCE),
    policyDecisionHash: POLICY_HASH,
    deliverableHash: outcome === 'release' ? DELIVERABLE_HASH : null,
    jobValueWei: 1_000_000_000_000_000n,
    maxJobValueWei: 10_000_000_000_000_000n,
    maxTotalCostWei: 2_000_000_000_000_000n,
    maxFeePerGasWei: 1_000_000_000n,
    maxGasPerTransaction: 100_000n,
    expirySeconds: 3_600,
    confirmations: 1,
    ...overrides,
  };
}

function dojangClient({ verified = true, chainId = 91_342, checkedAddresses = null } = {}) {
  return {
    async checkAddress(address) {
      checkedAddresses?.push(address);
      return {
        address: address.toLowerCase(),
        verified,
        source: 'giwa_dojang_read_only',
        accepted_attester_id: verified ? deployedNetwork.dojang.attester_allowlist[0].id : null,
        chain_id: chainId,
        block_number: 123,
        block_hash: BLOCK_HASH,
      };
    },
  };
}

function fakeSigner(address) {
  return {
    address,
    async signTransaction(transaction) {
      const serialized = hexlify(toUtf8Bytes([
        address.toLowerCase(),
        transaction.type,
        transaction.chainId,
        transaction.nonce,
        transaction.to.toLowerCase(),
        transaction.data.toLowerCase(),
        transaction.value.toString(),
        transaction.gasLimit.toString(),
        transaction.maxFeePerGas.toString(),
        transaction.maxPriorityFeePerGas.toString(),
      ].join(':')));
      SIGNED_TRANSACTION_REQUESTS.set(serialized, { ...transaction, from: address });
      return serialized;
    },
  };
}

function signers() {
  return {
    payer: fakeSigner(ADDRESSES.payer),
    provider: fakeSigner(ADDRESSES.provider),
    evaluator: fakeSigner(ADDRESSES.evaluator),
  };
}

function fakeProvider({
  onBroadcast = null,
  tamperTransactionData = false,
  seeded = [],
  initialNonces = {},
  networkMaxFeePerGas = 1_000_000_000n,
} = {}) {
  let broadcasts = 0;
  let nextBlock = 1_000;
  let canonicalHead = 999;
  const nextNonce = new Map();
  const blocks = new Map();
  const receipts = new Map();
  const transactions = new Map();
  const broadcastRequests = [];
  for (const entry of seeded) {
    blocks.set(entry.receipt.blockNumber, { number: entry.receipt.blockNumber, hash: entry.receipt.blockHash, timestamp: 1_800_000_000 + entry.receipt.blockNumber });
    receipts.set(entry.receipt.hash.toLowerCase(), entry.receipt);
    transactions.set(entry.transaction.hash.toLowerCase(), entry.transaction);
    canonicalHead = Math.max(canonicalHead, entry.receipt.blockNumber);
    nextBlock = Math.max(nextBlock, entry.receipt.blockNumber + 1);
  }
  for (const [address, nonce] of Object.entries(initialNonces)) nextNonce.set(address, nonce);
  return {
    get broadcastCount() {
      return broadcasts;
    },
    get broadcastRequests() {
      return broadcastRequests;
    },
    setNonce(address, nonce) {
      nextNonce.set(address, nonce);
    },
    async getNetwork() {
      return { chainId: 91_342n };
    },
    async getCode() {
      return '0x6000';
    },
    async getFeeData() {
      return { maxFeePerGas: networkMaxFeePerGas, maxPriorityFeePerGas: networkMaxFeePerGas / 10n };
    },
    async getBalance() {
      return 1_000_000_000_000_000_000n;
    },
    async getBlock(blockTag) {
      if (blockTag === 'latest' || Number(blockTag) === canonicalHead) return blocks.get(canonicalHead) ?? {
        number: canonicalHead,
        hash: `0x${canonicalHead.toString(16).padStart(64, '0')}`,
        timestamp: 1_800_000_000,
      };
      return blocks.get(Number(blockTag)) ?? null;
    },
    async getBlockNumber() {
      return canonicalHead;
    },
    async getTransactionReceipt(hash) {
      return receipts.get(String(hash).toLowerCase()) ?? null;
    },
    async getTransaction(hash) {
      const transaction = transactions.get(String(hash).toLowerCase()) ?? null;
      return transaction && tamperTransactionData ? { ...transaction, data: '0xdeadbeef' } : transaction;
    },
    async getTransactionCount(address) {
      return nextNonce.get(address) ?? 0;
    },
    async estimateGas() {
      return 50_000n;
    },
    async broadcastTransaction(serialized) {
      broadcasts += 1;
      const hash = keccak256(serialized).toLowerCase();
      if (onBroadcast) await onBroadcast({ hash, broadcastNumber: broadcasts });
      const request = SIGNED_TRANSACTION_REQUESTS.get(serialized);
      assert.ok(request, 'fake signer request must be retained');
      broadcastRequests.push(request);
      nextNonce.set(request.from, Number(request.nonce) + 1);
      const blockNumber = nextBlock++;
      canonicalHead = blockNumber;
      const blockHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;
      const block = { number: blockNumber, hash: blockHash, timestamp: 1_800_000_000 + blockNumber };
      const receipt = {
        hash,
        status: 1,
        blockNumber,
        blockHash,
        gasUsed: 45_000n,
        gasPrice: 900_000_000n,
      };
      blocks.set(blockNumber, block);
      receipts.set(hash, receipt);
      transactions.set(hash, {
        hash,
        from: request.from,
        to: request.to,
        nonce: request.nonce,
        value: request.value,
        data: request.data,
        chainId: request.chainId,
        type: request.type,
        gasLimit: request.gasLimit,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
        blockNumber,
        blockHash,
      });
      return {
        hash,
        async wait(confirmations) {
          assert.equal(confirmations, 1);
          return receipt;
        },
      };
    },
  };
}

function dependencies(outcome) {
  return {
    verifyDeployment: async () => ({ ok: true }),
    verifyD1Reference: async () => ({
      path: 'evidence/d1/fixture.json',
      digest: `0x${'d1'.repeat(32)}`,
      block_number: 123,
      block_hash: BLOCK_HASH,
      roles: { payer: ADDRESSES.payer, provider: ADDRESSES.provider },
      producer_authenticated: false,
    }),
    readJobStatus: async ({ step }) => step.expectedStatus,
    verifyTerminal: async ({ transactionHash }) => ({
      source: 'giwa_canonical_rpc',
      transaction_hash: transactionHash,
      canonical_terminal_verified: true,
      terminal: true,
      outcome: outcome === 'release' ? 'RELEASED' : 'REFUNDED',
      completed: outcome === 'release',
      refunded: outcome === 'refund',
      payment_completion_authority: outcome === 'release',
      checks: { fixture_terminal_verification: true, job_state_deliverable_hash: true },
      failures: [],
    }),
  };
}

function resumeFixture({ failure = null } = {}) {
  const runId = 'resume-release-001';
  const lifecycleOptions = options({
    execute: true,
    resume: true,
    runId,
    overrides: {
      evaluator: ZERO_ADDRESS,
      jobValueWei: 1_000_000_000_000n,
      maxJobValueWei: 10_000_000_000_000n,
      maxTotalCostWei: 10_000_000_000_000n,
      maxFeePerGasWei: 3_000_000n,
      maxGasPerTransaction: 500_000n,
    },
  });
  const expiresAt = 1_800_086_025;
  const workflow = [
    {
      name: 'create', signerRole: 'payer', expectedStatus: 1, value: 0n,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('createJob', [
        lifecycleOptions.jobId, lifecycleOptions.jobNonce, lifecycleOptions.provider,
        ZERO_ADDRESS, lifecycleOptions.jobValueWei, expiresAt, lifecycleOptions.policyDecisionHash,
      ]),
    },
    {
      name: 'fund', signerRole: 'payer', expectedStatus: 2, value: lifecycleOptions.jobValueWei,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('fundJob', [lifecycleOptions.jobId]),
    },
    {
      name: 'submit', signerRole: 'provider', expectedStatus: 3, value: 0n,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('submitDeliverable', [lifecycleOptions.jobId, DELIVERABLE_HASH]),
    },
    {
      name: 'approve', signerRole: 'payer', expectedStatus: 4, value: 0n,
      data: ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('approveJob', [lifecycleOptions.jobId]),
    },
  ];
  const roles = [ADDRESSES.payer, ADDRESSES.payer, ADDRESSES.provider, ADDRESSES.payer];
  const nonces = [4, 5, 3, 6];
  const seeded = workflow.map((step, index) => {
    const hash = `0x${(index + 161).toString(16).padStart(2, '0').repeat(32)}`;
    const blockNumber = 31_153_754 + index;
    const blockHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;
    return {
      receipt: {
        hash,
        status: failure === 'reverted' && step.name === 'approve' ? 0 : 1,
        blockNumber,
        blockHash,
        gasUsed: 45_000n,
        gasPrice: 1_000_502n,
      },
      transaction: {
        hash,
        from: roles[index],
        to: ADDRESSES.escrow,
        nonce: nonces[index],
        value: step.value,
        data: failure === 'tampered' && step.name === 'approve' ? '0xdeadbeef' : step.data,
        chainId: 91_342,
        type: 2,
        gasLimit: 164_739n,
        maxFeePerGas: 1_000_502n,
        blockNumber,
        blockHash,
      },
    };
  });
  const retainedSteps = seeded.slice(0, 3).map((entry, index) => ({
    step: workflow[index].name,
    signer_role: workflow[index].signerRole,
    signer_address: roles[index],
    transaction_hash: entry.transaction.hash,
    nonce: nonces[index],
    block_number: entry.receipt.blockNumber,
    block_hash: entry.receipt.blockHash,
    receipt_status: 1,
    confirmations: null,
    value_wei: workflow[index].value.toString(),
    gas_used: '45000',
    receipt_gas_price_wei: '1000502',
    observed_job_status: workflow[index].expectedStatus,
  }));
  const approve = seeded[3];
  const journal = {
    schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
    status: 'broadcast_pending_receipt',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    outcome: 'release',
    job_id: lifecycleOptions.jobId,
    job_nonce: lifecycleOptions.jobNonce,
    expires_at: expiresAt,
    policy_decision_hash: POLICY_HASH,
    transaction_preimage_persisted: false,
    private_keys_persisted: false,
    pending_transaction: {
      step: 'approve',
      signer_role: 'payer',
      signer_address: ADDRESSES.payer,
      nonce: 6,
      planned_transaction_hash: approve.transaction.hash,
      transaction_hash: approve.transaction.hash,
      value_wei: '0',
      gas_limit: '164739',
      max_fee_per_gas_wei: '1000502',
      max_reserved_cost_wei: '164821698978',
      signed_transaction_persisted: false,
    },
    steps: retainedSteps,
    created_at: '2026-07-19T22:07:30.666Z',
  };
  const lock = {
    schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
    status: 'active_fail_closed_until_clean_completion',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    payer: ADDRESSES.payer,
    created_at: '2026-07-19T22:07:30.285Z',
  };
  const provider = fakeProvider({
    seeded: failure === 'missing' ? seeded.slice(0, 3) : seeded,
    initialNonces: { [ADDRESSES.payer]: 7, [ADDRESSES.provider]: 4 },
    networkMaxFeePerGas: 1_000_502n,
  });
  if (failure === 'head_reorg') {
    const getBlock = provider.getBlock.bind(provider);
    let observedHeadNumber = null;
    provider.getBlock = async (blockTag) => {
      const block = await getBlock(blockTag);
      if (blockTag === 'latest') {
        observedHeadNumber = block.number;
        return block;
      }
      if (Number(blockTag) === observedHeadNumber) return { ...block, hash: `0x${'ff'.repeat(32)}` };
      return block;
    };
  }
  const stateReads = [];
  const readJobStatus = async ({ step, blockTag, canonicalContext }) => {
    stateReads.push({ step: step.name, blockTag, canonicalContext });
    if (failure === 'wrong_status' && step.name === 'approve' && canonicalContext === 'receipt') return 3;
    if (failure === 'already_terminal' && canonicalContext === 'head') return 5;
    if (failure === 'stale_latest' && blockTag === 'latest') return 3;
    return step.expectedStatus;
  };
  return { runId, lifecycleOptions, journal, lock, provider, readJobStatus, stateReads };
}

async function writeResumeFixture(rootDir, fixture) {
  const directory = path.join(rootDir, 'evidence', 'lifecycle');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${fixture.runId}.journal.json`), `${JSON.stringify(fixture.journal, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, 'active-execution.lock.json'), `${JSON.stringify(fixture.lock, null, 2)}\n`, { mode: 0o600 });
}

async function executeResumeFixture(rootDir, fixture, overrides = {}) {
  return runLifecycle({
    options: fixture.lifecycleOptions,
    manifest: deployedNetwork,
    deployment,
    provider: fixture.provider,
    dojangClient: dojangClient(),
    signers: { payer: fakeSigner(ADDRESSES.payer) },
    rootDir,
    ...dependencies('release'),
    readJobStatus: fixture.readJobStatus,
    ...overrides,
  });
}

async function restoreResumeLock(rootDir, fixture) {
  await writeFile(
    path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json'),
    `${JSON.stringify(fixture.lock, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
}

async function createPreparedCrash({ rootDir, provider, runId, acceptedBeforeThrow }) {
  const lifecycleOptions = options({
    execute: true,
    runId,
    overrides: { evaluator: ZERO_ADDRESS },
  });
  const originalBroadcast = provider.broadcastTransaction.bind(provider);
  let first = true;
  provider.broadcastTransaction = async (serialized) => {
    if (!first) return originalBroadcast(serialized);
    first = false;
    if (acceptedBeforeThrow) await originalBroadcast(serialized);
    throw new Error(acceptedBeforeThrow ? 'accepted-then-throw' : 'absent-before-broadcast');
  };
  try {
    await assert.rejects(runLifecycle({
      options: lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    }), new RegExp(acceptedBeforeThrow ? 'accepted-then-throw' : 'absent-before-broadcast'));
  } finally {
    provider.broadcastTransaction = originalBroadcast;
  }
  const journalPath = path.join(rootDir, 'evidence', 'lifecycle', `${runId}.journal.json`);
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(journal.status, 'prepared_before_broadcast');
  assert.equal(journal.pending_transaction.max_priority_fee_per_gas_wei, '100000000');
  assert.equal(journal.pending_transaction.transaction_type, 2);
  assert.equal(journal.pending_transaction.chain_id, 91_342);
  assert.equal(journal.pending_transaction.target, ADDRESSES.escrow.toLowerCase());
  assert.equal(journal.pending_transaction.calldata,
    ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('createJob', [
      lifecycleOptions.jobId,
      lifecycleOptions.jobNonce,
      lifecycleOptions.provider,
      ZERO_ADDRESS,
      lifecycleOptions.jobValueWei,
      journal.expires_at,
      lifecycleOptions.policyDecisionHash,
    ]).toLowerCase());
  return {
    lifecycleOptions: { ...lifecycleOptions, resume: true },
    journal,
    journalPath,
  };
}

test('CLI requires explicit chain, network, testnet, cap and execute gates', () => {
  assert.throws(() => parseLifecycleArgs([]), { code: 'CHAIN_CONFIRMATION_REQUIRED' });
  const parsed = parseLifecycleArgs([
    '--execute',
    '--resume',
    '--confirm-chain-id=91342',
    '--confirm-network=giwa-testnet',
    '--confirm-testnet-only=GIWA_SEPOLIA_TEST_ETH_ONLY',
    '--lifecycle-run-id=release-run-001',
    '--outcome=release',
    `--payer-address=${ADDRESSES.payer}`,
    `--provider-address=${ADDRESSES.provider}`,
    `--evaluator-address=${ADDRESSES.evaluator}`,
    `--job-id=${deriveJobId(ADDRESSES.payer, JOB_NONCE)}`,
    `--job-nonce=${JOB_NONCE}`,
    `--policy-decision-hash=${POLICY_HASH}`,
    `--deliverable-hash=${DELIVERABLE_HASH}`,
    '--job-value-wei=1000000000000000',
    '--max-job-value-wei=10000000000000000',
    '--max-total-cost-wei=2000000000000000',
    '--max-fee-per-gas-wei=1000000000',
    '--max-gas-per-transaction=100000',
    '--expiry-seconds=3600',
    '--confirmations=1',
  ]);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.resume, true);
  assert.equal(parsed.outcome, 'release');
  assert.equal(parsed.worstCaseCostWei, 1_500_000_000_000_000n);
});

test('CLI accepts one signed policy evidence path and rejects ambiguous policy origin', () => {
  const signed = validateLifecycleOptions(options({
    overrides: {
      policyDecisionHash: undefined,
      policyEvidencePath: 'evidence/policy/signed-release.json',
    },
  }));
  assert.equal(signed.policyDecisionHash, null);
  assert.equal(signed.policyEvidencePath, 'evidence/policy/signed-release.json');
  assert.throws(() => validateLifecycleOptions(options({
    overrides: { policyEvidencePath: 'evidence/policy/ambiguous.json' },
  })), { code: 'POLICY_ORIGIN_REQUIRED' });
  assert.throws(() => validateLifecycleOptions(options({
    overrides: { policyDecisionHash: undefined, policyEvidencePath: '../outside.json' },
  })), { code: 'INVALID_POLICY_EVIDENCE_PATH' });
});

test('options reject role collisions, unbound job IDs, and unsafe caps', () => {
  assert.throws(() => validateLifecycleOptions(options({ resume: true })), { code: 'RESUME_EXECUTE_REQUIRED' });
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { evaluator: ADDRESSES.provider } })),
    { code: 'ROLE_COLLISION' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { jobId: `0x${'99'.repeat(32)}` } })),
    { code: 'JOB_ID_DERIVATION_MISMATCH' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { maxJobValueWei: LIFECYCLE_LIMITS.hardMaxJobValueWei + 1n } })),
    { code: 'JOB_VALUE_CAP_TOO_HIGH' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { maxTotalCostWei: 1_000_000_000_000_000n } })),
    { code: 'TOTAL_COST_CAP_EXCEEDED' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { jobValueWei: 0n } })),
    { code: 'NON_POSITIVE_VALUE_GATE' },
  );
  const omittedEvaluator = options();
  delete omittedEvaluator.evaluator;
  assert.equal(validateLifecycleOptions(omittedEvaluator).evaluator, ZERO_ADDRESS);
  assert.equal(validateLifecycleOptions(options({ overrides: { evaluator: '' } })).evaluator, ZERO_ADDRESS);
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { maxFeePerGasWei: -1n } })),
    { code: 'NON_POSITIVE_VALUE_GATE' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { payer: ZERO_ADDRESS } })),
    { code: 'ZERO_ROLE_ADDRESS' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: { provider: ZERO_ADDRESS } })),
    { code: 'ZERO_ROLE_ADDRESS' },
  );
  const zeroNonce = `0x${'0'.repeat(64)}`;
  assert.throws(
    () => validateLifecycleOptions(options({ overrides: {
      jobNonce: zeroNonce,
      jobId: deriveJobId(ADDRESSES.payer, zeroNonce),
    } })),
    { code: 'ZERO_JOB_NONCE' },
  );
  assert.throws(
    () => validateLifecycleOptions(options({ outcome: 'refund', overrides: { deliverableHash: DELIVERABLE_HASH } })),
    { code: 'REFUND_DELIVERABLE_HASH_FORBIDDEN' },
  );
  assert.equal(validateLifecycleOptions(options({ outcome: 'refund' })).deliverableHash, `0x${'0'.repeat(64)}`);
});

test('read-only preflight checks Dojang and balances without signer access or broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-preflight-'));
  const provider = fakeProvider();
  try {
    const result = await runLifecycle({
      options: options(),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(result.mode, 'read-only-preflight');
    assert.equal(result.transaction_broadcast, false);
    assert.equal(result.roles_distinct, true);
    assert.equal(result.dojang.payer.verified, true);
    assert.equal(provider.broadcastCount, 0);
    await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', 'lifecycle-release-001.journal.json')),
      { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('negative Dojang verification fails before signer loading, journal creation, or broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-dojang-'));
  const provider = fakeProvider();
  let signerLoaderCalled = false;
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient({ verified: false }),
      signerLoader: async () => {
        signerLoaderCalled = true;
        return signers();
      },
      rootDir,
      ...dependencies('release'),
    }), { code: 'DOJANG_ROLE_NOT_VERIFIED' });
    assert.equal(signerLoaderCalled, false);
    assert.equal(provider.broadcastCount, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('wrong-chain Dojang proof fails before signer loading, journal creation, or broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-dojang-chain-'));
  const provider = fakeProvider();
  let signerLoaderCalled = false;
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient({ chainId: 1 }),
      signerLoader: async () => {
        signerLoaderCalled = true;
        return signers();
      },
      rootDir,
      ...dependencies('release'),
    }), { code: 'DOJANG_ROLE_NOT_VERIFIED' });
    assert.equal(signerLoaderCalled, false);
    assert.equal(provider.broadcastCount, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('release lifecycle journals every transaction before broadcast and produces canonical evidence', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-release-'));
  const runId = 'release-proof-001';
  const journalPath = path.join(rootDir, 'evidence', 'lifecycle', `${runId}.journal.json`);
  const observedPreparedSteps = [];
  const provider = fakeProvider({
    onBroadcast: async ({ hash }) => {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(journal.status, 'prepared_before_broadcast');
      assert.equal(journal.pending_transaction.planned_transaction_hash, hash);
      assert.equal(journal.pending_transaction.signed_transaction_persisted, false);
      assert.equal(journal.pending_transaction.transaction_type, 2);
      assert.equal(journal.pending_transaction.chain_id, 91_342);
      assert.equal(journal.pending_transaction.target, ADDRESSES.escrow.toLowerCase());
      assert.equal(journal.pending_transaction.max_priority_fee_per_gas_wei, '100000000');
      observedPreparedSteps.push(journal.pending_transaction.step);
    },
  });
  try {
    const result = await runLifecycle({
      options: options({ execute: true, runId }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(result.terminal_outcome, 'RELEASED');
    assert.equal(result.payment_completed, true);
    assert.equal(result.refunded, false);
    assert.equal(result.step_count, 5);
    assert.equal(provider.broadcastCount, 5);
    assert.deepEqual(observedPreparedSteps, ['create', 'fund', 'submit', 'approve', 'release']);
    const journal = JSON.parse(await readFile(result.journal_path, 'utf8'));
    const evidence = JSON.parse(await readFile(result.evidence_path, 'utf8'));
    assert.equal(journal.status, 'completed');
    assert.equal(journal.private_keys_persisted, false);
    assert.equal(journal.transaction_preimage_persisted, false);
    assert.equal(evidence.outcome, 'RELEASED');
    assert.equal(evidence.payment_completed, true);
    assert.equal(evidence.dojang.payer.chain_id, 91_342);
    assert.equal(evidence.integrity.producer_authentication, 'not_provided');
    assert.equal(evidence.integrity.signature, null);
    assert.equal(evidence.job.deliverable_hash, DELIVERABLE_HASH);
    assert.equal(evidence.d1_reference.digest, `0x${'d1'.repeat(32)}`);
    assert.equal(evidence.boundaries.policy_origin_authentication, 'not_provided_cli_hash_only');
    assert.equal(evidence.canonical_step_receipts.all_steps_canonical, true);
    assert.deepEqual(evidence.steps.map((step) => step.confirmations), [5, 4, 3, 2, 1]);
    assert.ok(evidence.steps.every((step) => (
      step.canonical_receipt_refetched === true
        && step.canonical_transaction_refetched === true
        && step.canonical_block_refetched_twice === true
        && step.transaction_input_verified === true
    )));
    await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('signed policy artifact is verified before execution and bound into lifecycle evidence', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-signed-policy-'));
  const runId = 'signed-policy-release-001';
  const policyPath = 'evidence/policy/signed-release.json';
  const artifactDigest = `0x${'54'.repeat(32)}`;
  const artifactSha256 = `0x${'55'.repeat(32)}`;
  const typedDataDigest = `0x${'56'.repeat(32)}`;
  const bindingDigest = `0x${'57'.repeat(32)}`;
  const expiresAt = 1_800_006_000;
  const provider = fakeProvider();
  const signedOptions = options({
    execute: true,
    runId,
    overrides: {
      policyDecisionHash: undefined,
      policyEvidencePath: policyPath,
      expirySeconds: 7_200,
    },
  });
  const signedDeployment = {
    ...deployment,
    deployerAddress: ADDRESSES.payer,
    authorities: {
      policyAuthorityAddress: ADDRESSES.payer,
      evidenceProducerAddress: ADDRESSES.payer,
      model: 'same_testnet_eoa_demo_only',
      separationOfDuties: false,
    },
  };
  let verificationCalls = 0;
  try {
    const result = await runLifecycle({
      options: signedOptions,
      manifest: deployedNetwork,
      deployment: signedDeployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      verifyPolicyReference: async ({ filePath, expected, currentTimestamp }) => {
        verificationCalls += 1;
        assert.equal(filePath, policyPath);
        assert.equal(expected.authority, ADDRESSES.payer.toLowerCase());
        assert.equal(expected.requireExecutable, true);
        assert.equal(expected.job.outcome, 'RELEASED');
        assert.equal(expected.job.deliverableHash, DELIVERABLE_HASH);
        assert.equal(currentTimestamp, 1_800_000_000);
        return {
          recordId: 'policy-record-release-001',
          intentId: 'intent-release-001',
          policyDecisionHash: POLICY_HASH,
          bindingDigest,
          artifactDigest,
          artifactSha256,
          typedDataDigest,
          authority: ADDRESSES.payer,
          producerAddress: ADDRESSES.payer,
          validity: { validFrom: 1_800_000_000, validUntil: expiresAt },
          job: { expiresAt },
          repositoryRelativePath: policyPath,
          decision: 'ALLOW',
          evidence: { decision: 'ALLOW' },
        };
      },
      ...dependencies('release'),
    });
    assert.equal(verificationCalls, 1);
    assert.equal(provider.broadcastCount, 5);
    const [journal, evidence] = await Promise.all([
      readFile(result.journal_path, 'utf8').then(JSON.parse),
      readFile(result.evidence_path, 'utf8').then(JSON.parse),
    ]);
    assert.equal(journal.policy_decision_hash, POLICY_HASH);
    assert.equal(journal.expires_at, expiresAt);
    assert.equal(journal.policy_origin.artifact_digest, artifactDigest);
    assert.equal(evidence.evidence_level, 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy');
    assert.equal(evidence.job.policy_decision_hash, POLICY_HASH);
    assert.equal(evidence.job.expires_at, expiresAt);
    assert.equal(evidence.policy_origin.artifact_path, policyPath);
    assert.equal(evidence.policy_origin.signature_verified, true);
    assert.equal(evidence.policy_origin.separation_of_duties, false);
    assert.equal(evidence.boundaries.policy_origin_authentication, 'eip712_configured_testnet_authority_verified');
    assert.equal(evidence.integrity.producer_authentication, 'not_provided');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('real signed policy module is accepted in read-only lifecycle preflight before signer access', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-real-policy-'));
  const authorityWallet = new Wallet(`0x${'03'.repeat(32)}`);
  const authority = authorityWallet.address.toLowerCase();
  const jobNonce = `0x${'58'.repeat(32)}`;
  const jobId = deriveJobId(authority, jobNonce);
  const policyPath = 'evidence/policy/real-policy-preflight.policy.json';
  const expiresAt = 1_800_006_000;
  const provider = fakeProvider();
  const unsigned = buildPolicyEvidence({
    createdAt: '2027-01-15T08:00:00.000Z',
    recordId: 'real-policy-record-001',
    intentId: 'real-policy-intent-001',
    authority,
    validFrom: 1_800_000_000,
    validUntil: expiresAt,
    ruleset: { max_job_value_wei: '10000000000000000', max_expiry_seconds: 7_200 },
    job: {
      escrow: ADDRESSES.escrow,
      jobId,
      jobNonce,
      payer: authority,
      provider: ADDRESSES.provider,
      evaluator: ADDRESSES.evaluator,
      valueWei: '1000000000000000',
      expiresAt,
      outcome: 'RELEASED',
      deliverableHash: DELIVERABLE_HASH,
    },
  });
  const signed = await signPolicyEvidence(unsigned, authorityWallet);
  await mkdir(path.join(rootDir, 'evidence', 'policy'), { recursive: true });
  await writeFile(path.join(rootDir, policyPath), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  let signerLoaderCalled = false;
  try {
    const result = await runLifecycle({
      options: options({
        execute: false,
        runId: 'real-policy-preflight-001',
        overrides: {
          payer: authority,
          jobNonce,
          jobId,
          policyDecisionHash: undefined,
          policyEvidencePath: policyPath,
          expirySeconds: 7_200,
        },
      }),
      manifest: deployedNetwork,
      deployment: {
        ...deployment,
        deployerAddress: authority,
        authorities: {
          policyAuthorityAddress: authority,
          evidenceProducerAddress: authority,
          model: 'same_testnet_eoa_demo_only',
          separationOfDuties: false,
        },
      },
      provider,
      dojangClient: dojangClient(),
      signerLoader: async () => {
        signerLoaderCalled = true;
        throw new Error('must remain read-only');
      },
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(result.mode, 'read-only-preflight');
    assert.equal(result.transaction_broadcast, false);
    assert.equal(result.policy_origin.signature_verified, true);
    assert.equal(result.policy_origin.policy_decision_hash, signed.decision_hash);
    assert.equal(result.options.policy_decision_hash, signed.decision_hash);
    assert.equal(signerLoaderCalled, false);
    await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('lifecycle evidence fails closed when canonical intermediate calldata differs from the signed workflow', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-step-tamper-'));
  const runId = 'step-tamper-001';
  const provider = fakeProvider({ tamperTransactionData: true });
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true, runId }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      ...dependencies('release'),
    }), { code: 'STEP_TRANSACTION_INPUT_MISMATCH' });
    assert.equal(provider.broadcastCount, 5);
    await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', `${runId}.evidence.json`)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json'), 'utf8')).run_id, runId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('global lifecycle lock blocks a different run before signer loading or broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-global-lock-'));
  const provider = fakeProvider();
  const lockDir = path.join(rootDir, 'evidence', 'lifecycle');
  let signerLoaderCalled = false;
  try {
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, 'active-execution.lock.json'), '{"run_id":"other"}\n', { mode: 0o600 });
    await assert.rejects(runLifecycle({
      options: options({ execute: true, runId: 'blocked-run-001' }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signerLoader: async () => {
        signerLoaderCalled = true;
        return signers();
      },
      rootDir,
      ...dependencies('release'),
    }), { code: 'GLOBAL_EXECUTION_LOCK_EXISTS' });
    assert.equal(signerLoaderCalled, false);
    assert.equal(provider.broadcastCount, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('explicit resume accepts a clean ready-before-first-broadcast journal', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-ready-'));
  const runId = 'resume-ready-release-001';
  const lifecycleOptions = options({
    execute: true,
    resume: true,
    runId,
    overrides: { evaluator: ZERO_ADDRESS },
  });
  const directory = path.join(rootDir, 'evidence', 'lifecycle');
  const expiresAt = 1_800_003_600;
  const lock = {
    schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
    status: 'active_fail_closed_until_clean_completion',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    payer: ADDRESSES.payer,
  };
  const journal = {
    schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
    status: 'ready_before_first_broadcast',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    outcome: 'release',
    job_id: lifecycleOptions.jobId,
    job_nonce: lifecycleOptions.jobNonce,
    expires_at: expiresAt,
    policy_decision_hash: POLICY_HASH,
    transaction_preimage_persisted: false,
    private_keys_persisted: false,
    pending_transaction: null,
    steps: [],
  };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'active-execution.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 }),
    writeFile(path.join(directory, `${runId}.journal.json`), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 }),
  ]);
  const provider = fakeProvider();
  let exactMissingJobReads = 0;
  const readyResumeDependencies = dependencies('release');
  readyResumeDependencies.readJobStatus = async ({ step, canonicalContext }) => {
    if (canonicalContext === 'head' && step.name === 'create' && step.expectedStatus === 0) {
      exactMissingJobReads += 1;
      const error = new Error('execution reverted');
      error.data = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [lifecycleOptions.jobId]);
      throw error;
    }
    return step.expectedStatus;
  };
  try {
    const result = await runLifecycle({
      options: lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...readyResumeDependencies,
    });
    assert.equal(result.transaction_broadcast_count, 5);
    assert.equal(result.terminal_outcome, 'RELEASED');
    assert.equal(result.fee.gate_mode, 'remaining_resume_suffix_only');
    assert.deepEqual(provider.broadcastRequests.map((request) => request.nonce), [0, 1, 0, 2, 3]);
    assert.equal(exactMissingJobReads, 1);
    await assert.rejects(readFile(path.join(directory, 'active-execution.lock.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(directory, `${runId}.resume.lease.json`)), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const invalidMissingJob of [
  {
    name: 'trailing revert bytes',
    mutate: ({ canonical }) => `${canonical}00`,
  },
  {
    name: 'wrong job ID',
    mutate: () => ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [`0x${'99'.repeat(32)}`]),
  },
  {
    name: 'missing revert data',
    mutate: () => null,
  },
  {
    name: 'malformed revert data',
    mutate: () => '0x1234',
  },
]) {
  test(`ready-before-first-broadcast resume rejects JobNotFound with ${invalidMissingJob.name}`, async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-ready-invalid-missing-'));
    const runId = `resume-ready-invalid-${invalidMissingJob.name.replaceAll(' ', '-')}`;
    const lifecycleOptions = options({
      execute: true,
      resume: true,
      runId,
      overrides: { evaluator: ZERO_ADDRESS },
    });
    const directory = path.join(rootDir, 'evidence', 'lifecycle');
    const lock = {
      schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
      status: 'active_fail_closed_until_clean_completion',
      run_id: runId,
      network_key: 'giwa-testnet',
      chain_id: 91_342,
      escrow_contract: ADDRESSES.escrow,
      payer: ADDRESSES.payer,
    };
    const journal = {
      schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
      status: 'ready_before_first_broadcast',
      run_id: runId,
      network_key: 'giwa-testnet',
      chain_id: 91_342,
      escrow_contract: ADDRESSES.escrow,
      outcome: 'release',
      job_id: lifecycleOptions.jobId,
      job_nonce: lifecycleOptions.jobNonce,
      expires_at: 1_800_003_600,
      policy_decision_hash: POLICY_HASH,
      transaction_preimage_persisted: false,
      private_keys_persisted: false,
      pending_transaction: null,
      steps: [],
    };
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, 'active-execution.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 }),
      writeFile(path.join(directory, `${runId}.journal.json`), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 }),
    ]);
    const provider = fakeProvider();
    const invalidDependencies = dependencies('release');
    invalidDependencies.readJobStatus = async ({ step, canonicalContext }) => {
      if (canonicalContext === 'head' && step.name === 'create' && step.expectedStatus === 0) {
        const error = new Error('execution reverted');
        const canonical = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [lifecycleOptions.jobId]);
        const data = invalidMissingJob.mutate({ canonical });
        if (data !== null) error.data = data;
        throw error;
      }
      return step.expectedStatus;
    };
    try {
      await assert.rejects(runLifecycle({
        options: lifecycleOptions,
        manifest: deployedNetwork,
        deployment,
        provider,
        dojangClient: dojangClient(),
        signers: {
          payer: fakeSigner(ADDRESSES.payer),
          provider: fakeSigner(ADDRESSES.provider),
        },
        rootDir,
        ...invalidDependencies,
      }), /execution reverted/);
      assert.equal(provider.broadcastCount, 0);
      const lease = JSON.parse(await readFile(path.join(directory, `${runId}.resume.lease.json`), 'utf8'));
      assert.equal(lease.status, 'exclusive_resume_in_progress_fail_closed_on_crash');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('zero-step step-confirmed journal cannot treat JobNotFound as a legitimate pre-create state', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-zero-step-confirmed-'));
  const runId = 'resume-zero-step-confirmed-001';
  const lifecycleOptions = options({
    execute: true,
    resume: true,
    runId,
    overrides: { evaluator: ZERO_ADDRESS },
  });
  const directory = path.join(rootDir, 'evidence', 'lifecycle');
  const lock = {
    schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
    status: 'active_fail_closed_until_clean_completion',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    payer: ADDRESSES.payer,
  };
  const journal = {
    schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
    status: 'step_confirmed',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    outcome: 'release',
    job_id: lifecycleOptions.jobId,
    job_nonce: lifecycleOptions.jobNonce,
    expires_at: 1_800_003_600,
    policy_decision_hash: POLICY_HASH,
    transaction_preimage_persisted: false,
    private_keys_persisted: false,
    pending_transaction: null,
    steps: [],
  };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'active-execution.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 }),
    writeFile(path.join(directory, `${runId}.journal.json`), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 }),
  ]);
  const provider = fakeProvider();
  const invalidDependencies = dependencies('release');
  invalidDependencies.readJobStatus = async ({ step, canonicalContext }) => {
    if (canonicalContext === 'head' && step.name === 'create' && step.expectedStatus === 0) {
      const error = new Error('execution reverted');
      error.data = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [lifecycleOptions.jobId]);
      throw error;
    }
    return step.expectedStatus;
  };
  try {
    await assert.rejects(runLifecycle({
      options: lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...invalidDependencies,
    }), /execution reverted/);
    assert.equal(provider.broadcastCount, 0);
    const lease = JSON.parse(await readFile(path.join(directory, `${runId}.resume.lease.json`), 'utf8'));
    assert.equal(lease.status, 'exclusive_resume_in_progress_fail_closed_on_crash');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('JobNotFound on a subsequent resume step is never treated as an empty pre-create state', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-subsequent-missing-'));
  const fixture = resumeFixture();
  await writeResumeFixture(rootDir, fixture);
  const exactMissingDependencies = dependencies('release');
  exactMissingDependencies.readJobStatus = async ({ step, canonicalContext }) => {
    if (canonicalContext === 'head' && step.name === 'release') {
      const error = new Error('execution reverted');
      error.data = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [fixture.lifecycleOptions.jobId]);
      throw error;
    }
    return step.expectedStatus;
  };
  try {
    await assert.rejects(runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider: fixture.provider,
      dojangClient: dojangClient(),
      signers: { payer: fakeSigner(ADDRESSES.payer) },
      rootDir,
      ...exactMissingDependencies,
    }), /execution reverted/);
    assert.equal(fixture.provider.broadcastCount, 0);
    const directory = path.join(rootDir, 'evidence', 'lifecycle');
    const lease = JSON.parse(await readFile(path.join(directory, `${fixture.runId}.resume.lease.json`), 'utf8'));
    assert.equal(lease.status, 'exclusive_resume_in_progress_fail_closed_on_crash');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'active-execution.lock.json'), 'utf8')).run_id, fixture.runId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('exact pre-create JobNotFound still fails closed when the pinned canonical head changes', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-ready-head-change-'));
  const runId = 'resume-ready-head-change-001';
  const lifecycleOptions = options({
    execute: true,
    resume: true,
    runId,
    overrides: { evaluator: ZERO_ADDRESS },
  });
  const directory = path.join(rootDir, 'evidence', 'lifecycle');
  const lock = {
    schema: 'xpayr.giwa.agentpay.lifecycle-execution-lock.v1',
    status: 'active_fail_closed_until_clean_completion',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    payer: ADDRESSES.payer,
  };
  const journal = {
    schema: 'xpayr.giwa.agentpay.lifecycle-journal.v1',
    status: 'ready_before_first_broadcast',
    run_id: runId,
    network_key: 'giwa-testnet',
    chain_id: 91_342,
    escrow_contract: ADDRESSES.escrow,
    outcome: 'release',
    job_id: lifecycleOptions.jobId,
    job_nonce: lifecycleOptions.jobNonce,
    expires_at: 1_800_003_600,
    policy_decision_hash: POLICY_HASH,
    transaction_preimage_persisted: false,
    private_keys_persisted: false,
    pending_transaction: null,
    steps: [],
  };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'active-execution.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 }),
    writeFile(path.join(directory, `${runId}.journal.json`), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 }),
  ]);
  const provider = fakeProvider();
  const originalGetBlock = provider.getBlock.bind(provider);
  let pinnedHeadNumber = null;
  provider.getBlock = async (blockTag) => {
    const block = await originalGetBlock(blockTag);
    if (blockTag === 'latest') {
      pinnedHeadNumber = block.number;
      return block;
    }
    if (Number(blockTag) === pinnedHeadNumber) return { ...block, hash: `0x${'fe'.repeat(32)}` };
    return block;
  };
  const exactMissingDependencies = dependencies('release');
  exactMissingDependencies.readJobStatus = async ({ step, canonicalContext }) => {
    if (canonicalContext === 'head' && step.name === 'create' && step.expectedStatus === 0) {
      const error = new Error('execution reverted');
      error.data = ESCROW_LIFECYCLE_INTERFACE.encodeErrorResult('JobNotFound', [lifecycleOptions.jobId]);
      throw error;
    }
    return step.expectedStatus;
  };
  try {
    await assert.rejects(runLifecycle({
      options: lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...exactMissingDependencies,
    }), { code: 'CANONICAL_HEAD_CHANGED' });
    assert.equal(provider.broadcastCount, 0);
    const lease = JSON.parse(await readFile(path.join(directory, `${runId}.resume.lease.json`), 'utf8'));
    assert.equal(lease.status, 'exclusive_resume_in_progress_fail_closed_on_crash');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'active-execution.lock.json'), 'utf8')).run_id, runId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('prepared recovery reconciles an accepted-then-throw transaction without duplicate broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-prepared-canonical-'));
  const provider = fakeProvider();
  try {
    const fixture = await createPreparedCrash({
      rootDir,
      provider,
      runId: 'prepared-canonical-001',
      acceptedBeforeThrow: true,
    });
    assert.equal(provider.broadcastCount, 1);
    const result = await runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(provider.broadcastCount, 5);
    assert.equal(result.transaction_broadcast_count, 4);
    const completed = JSON.parse(await readFile(result.journal_path, 'utf8'));
    assert.equal(completed.steps[0].transaction_hash, fixture.journal.pending_transaction.planned_transaction_hash);
    assert.equal(completed.recovery.reconciled_from_prepared_planned_hash, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('prepared recovery holds an already-visible pending transaction without rebroadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-prepared-pending-'));
  const provider = fakeProvider();
  try {
    const fixture = await createPreparedCrash({
      rootDir,
      provider,
      runId: 'prepared-pending-001',
      acceptedBeforeThrow: true,
    });
    const originalReceipt = provider.getTransactionReceipt.bind(provider);
    const originalFeeData = provider.getFeeData.bind(provider);
    const originalBalance = provider.getBalance.bind(provider);
    const resumeLeasePath = path.join(rootDir, 'evidence', 'lifecycle', `${fixture.lifecycleOptions.runId}.resume.lease.json`);
    const executionLockPath = path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json');
    provider.getTransactionReceipt = async (hash) => (
      String(hash).toLowerCase() === fixture.journal.pending_transaction.planned_transaction_hash
        ? null
        : originalReceipt(hash)
    );
    provider.getFeeData = async () => { throw new Error('pending recovery must not inspect current fees'); };
    provider.getBalance = async () => { throw new Error('pending recovery must not inspect balances'); };
    await assert.rejects(runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    }), { code: 'RESUME_PREPARED_TRANSACTION_PENDING' });
    assert.equal(provider.broadcastCount, 1);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, 'utf8')).status, 'prepared_before_broadcast');
    assert.equal(JSON.parse(await readFile(executionLockPath, 'utf8')).run_id, fixture.lifecycleOptions.runId);
    await assert.rejects(readFile(resumeLeasePath), { code: 'ENOENT' });

    provider.getTransactionReceipt = originalReceipt;
    provider.getFeeData = originalFeeData;
    provider.getBalance = originalBalance;
    const resumed = await runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(resumed.transaction_broadcast_count, 4);
    assert.equal(provider.broadcastCount, 5);
    const completed = JSON.parse(await readFile(resumed.journal_path, 'utf8'));
    assert.equal(completed.steps[0].transaction_hash, fixture.journal.pending_transaction.planned_transaction_hash);
    assert.equal(completed.recovery.reconciled_from_prepared_planned_hash, true);
    await assert.rejects(readFile(resumeLeasePath), { code: 'ENOENT' });
    await assert.rejects(readFile(executionLockPath), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('prepared recovery re-signs and rebroadcasts an absent transaction with the exact planned hash', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-prepared-rebroadcast-'));
  const provider = fakeProvider();
  try {
    const fixture = await createPreparedCrash({
      rootDir,
      provider,
      runId: 'prepared-rebroadcast-001',
      acceptedBeforeThrow: false,
    });
    assert.equal(provider.broadcastCount, 0);
    const result = await runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    });
    assert.equal(result.transaction_broadcast_count, 5);
    assert.equal(provider.broadcastCount, 5);
    const completed = JSON.parse(await readFile(result.journal_path, 'utf8'));
    assert.equal(completed.steps[0].transaction_hash, fixture.journal.pending_transaction.planned_transaction_hash);
    assert.equal(completed.recovery.exact_same_hash_rebroadcast, true);
    assert.equal(completed.recovery.rebroadcast_transaction_hash, fixture.journal.pending_transaction.planned_transaction_hash);
    assert.equal(provider.broadcastRequests[0].maxPriorityFeePerGas,
      BigInt(fixture.journal.pending_transaction.max_priority_fee_per_gas_wei));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('prepared recovery fails closed when the exact planned nonce was consumed', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-prepared-consumed-'));
  const provider = fakeProvider();
  try {
    const fixture = await createPreparedCrash({
      rootDir,
      provider,
      runId: 'prepared-consumed-001',
      acceptedBeforeThrow: false,
    });
    provider.setNonce(ADDRESSES.payer, fixture.journal.pending_transaction.nonce + 1);
    await assert.rejects(runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
    }), { code: 'RESUME_PREPARED_NONCE_CONSUMED' });
    assert.equal(provider.broadcastCount, 0);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, 'utf8')).status, 'prepared_before_broadcast');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const [field, expectedCode] of [
  ['gas_limit', 'RESUME_PREPARED_GAS_CAP_EXCEEDED'],
  ['max_fee_per_gas_wei', 'RESUME_PREPARED_FEE_CAP_EXCEEDED'],
]) {
  test(`prepared recovery rejects a tampered ${field} above the current explicit cap`, async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), `giwa-lifecycle-prepared-${field}-cap-`));
    const provider = fakeProvider();
    try {
      const fixture = await createPreparedCrash({
        rootDir,
        provider,
        runId: `prepared-${field.replaceAll('_', '-')}-cap-001`,
        acceptedBeforeThrow: false,
      });
      const pending = fixture.journal.pending_transaction;
      if (field === 'gas_limit') {
        pending.gas_limit = (fixture.lifecycleOptions.maxGasPerTransaction + 1n).toString();
      } else {
        pending.max_fee_per_gas_wei = (fixture.lifecycleOptions.maxFeePerGasWei + 1n).toString();
      }
      pending.max_reserved_cost_wei = (
        BigInt(pending.gas_limit) * BigInt(pending.max_fee_per_gas_wei) + BigInt(pending.value_wei)
      ).toString();
      await writeFile(fixture.journalPath, `${JSON.stringify(fixture.journal, null, 2)}\n`, { mode: 0o600 });

      await assert.rejects(runLifecycle({
        options: fixture.lifecycleOptions,
        manifest: deployedNetwork,
        deployment,
        provider,
        dojangClient: dojangClient(),
        signers: {
          payer: fakeSigner(ADDRESSES.payer),
          provider: fakeSigner(ADDRESSES.provider),
        },
        rootDir,
        ...dependencies('release'),
      }), { code: expectedCode });
      assert.equal(provider.broadcastCount, 0);
      assert.equal(JSON.parse(await readFile(fixture.journalPath, 'utf8')).pending_transaction[field], pending[field]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('explicit resume reconciles nonce 6 approve and broadcasts only nonce 7 release', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-success-'));
  const fixture = resumeFixture();
  const terminalDependency = dependencies('release').verifyTerminal;
  await writeResumeFixture(rootDir, fixture);
  try {
    const result = await runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider: fixture.provider,
      dojangClient: dojangClient(),
      signers: { payer: fakeSigner(ADDRESSES.payer) },
      rootDir,
      ...dependencies('release'),
      readJobStatus: fixture.readJobStatus,
      verifyTerminal: async (input) => {
        const lock = JSON.parse(await readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json'), 'utf8'));
        assert.equal(lock.run_id, fixture.runId);
        return terminalDependency(input);
      },
    });
    assert.equal(fixture.provider.broadcastCount, 1);
    assert.equal(fixture.provider.broadcastRequests[0].nonce, 7);
    assert.equal(fixture.provider.broadcastRequests[0].data,
      ESCROW_LIFECYCLE_INTERFACE.encodeFunctionData('releaseJob', [fixture.lifecycleOptions.jobId]));
    const journal = JSON.parse(await readFile(result.journal_path, 'utf8'));
    assert.deepEqual(journal.steps.map((step) => step.step), ['create', 'fund', 'submit', 'approve', 'release']);
    assert.equal(journal.steps[3].nonce, 6);
    assert.equal(journal.steps[3].reconciled_from_pending_transaction, true);
    assert.equal(journal.steps[3].state_read_pinned_to_receipt_block, true);
    assert.equal(journal.recovery.reconciled_step, 'approve');
    assert.ok(fixture.stateReads.some((entry) => entry.step === 'approve' && entry.canonicalContext === 'receipt' && entry.blockTag.requireCanonical === true));
    assert.ok(fixture.stateReads.some((entry) => entry.step === 'release' && entry.canonicalContext === 'receipt' && entry.blockTag.requireCanonical === true));
    assert.equal(result.terminal_outcome, 'RELEASED');
    await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('resume requires exact existing global lock ownership before any broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-lock-owner-'));
  const fixture = resumeFixture();
  fixture.lock.run_id = 'different-run-owner';
  await writeResumeFixture(rootDir, fixture);
  try {
    await assert.rejects(runLifecycle({
      options: fixture.lifecycleOptions,
      manifest: deployedNetwork,
      deployment,
      provider: fixture.provider,
      dojangClient: dojangClient(),
      signers: { payer: fakeSigner(ADDRESSES.payer) },
      rootDir,
      ...dependencies('release'),
      readJobStatus: fixture.readJobStatus,
    }), { code: 'RESUME_LOCK_OWNERSHIP_MISMATCH' });
    assert.equal(fixture.provider.broadcastCount, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('hash-pinned fresh head ignores a stale unpinned latest-state backend', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-pinned-head-'));
  const fixture = resumeFixture({ failure: 'stale_latest' });
  await writeResumeFixture(rootDir, fixture);
  try {
    const result = await executeResumeFixture(rootDir, fixture);
    assert.equal(result.terminal_outcome, 'RELEASED');
    assert.equal(fixture.provider.broadcastCount, 1);
    assert.ok(fixture.stateReads.filter((entry) => entry.canonicalContext === 'head')
      .every((entry) => entry.blockTag?.requireCanonical === true && /^0x[0-9a-f]{64}$/.test(entry.blockTag.blockHash)));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const crashStatus of ['all_steps_canonically_reverified', 'completed']) {
  test(`finalization resume from ${crashStatus} reuses evidence with zero duplicate broadcast`, async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), `giwa-lifecycle-finalize-${crashStatus}-`));
    const fixture = resumeFixture();
    await writeResumeFixture(rootDir, fixture);
    try {
      const first = await executeResumeFixture(rootDir, fixture);
      const journal = JSON.parse(await readFile(first.journal_path, 'utf8'));
      journal.status = crashStatus;
      journal.pending_transaction = null;
      await writeFile(first.journal_path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      await restoreResumeLock(rootDir, fixture);
      const evidenceBefore = await readFile(first.evidence_path, 'utf8');
      const broadcastsBefore = fixture.provider.broadcastCount;
      fixture.provider.getFeeData = async () => { throw new Error('canonical-only resume must not inspect current fees'); };
      fixture.provider.getBalance = async () => { throw new Error('canonical-only resume must not inspect current balances'); };
      let signerLoaded = false;
      const resumed = await executeResumeFixture(rootDir, fixture, {
        signers: null,
        signerLoader: async () => {
          signerLoaded = true;
          throw new Error('finalization resume must not load a signer');
        },
      });
      assert.equal(signerLoaded, false);
      assert.equal(fixture.provider.broadcastCount, broadcastsBefore);
      assert.equal(resumed.transaction_broadcast_count, 0);
      assert.equal(resumed.evidence_reused_during_resume, true);
      assert.equal(resumed.fee.gate_mode, 'not_required_canonical_finalization_only');
      assert.deepEqual(resumed.required_balance_wei, {});
      assert.equal(await readFile(first.evidence_path, 'utf8'), evidenceBefore);
      await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(rootDir, 'evidence', 'lifecycle', `${fixture.runId}.resume.lease.json`)), { code: 'ENOENT' });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('finalization resume rejects mismatched existing evidence without broadcast or cleanup', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-finalize-evidence-mismatch-'));
  const fixture = resumeFixture();
  await writeResumeFixture(rootDir, fixture);
  try {
    const first = await executeResumeFixture(rootDir, fixture);
    await restoreResumeLock(rootDir, fixture);
    const evidence = JSON.parse(await readFile(first.evidence_path, 'utf8'));
    evidence.job.value_wei = '999';
    await writeFile(first.evidence_path, `${JSON.stringify(evidence, null, 2)}\n`);
    const broadcastsBefore = fixture.provider.broadcastCount;
    await assert.rejects(executeResumeFixture(rootDir, fixture), { code: 'LIFECYCLE_EVIDENCE_MISMATCH' });
    assert.equal(fixture.provider.broadcastCount, broadcastsBefore);
    assert.equal(JSON.parse(await readFile(path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json'), 'utf8')).run_id, fixture.runId);
    assert.equal(JSON.parse(await readFile(path.join(rootDir, 'evidence', 'lifecycle', `${fixture.runId}.resume.lease.json`), 'utf8')).run_id, fixture.runId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('concurrent resume grants one exclusive lease and one release broadcaster', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-resume-concurrent-'));
  const fixture = resumeFixture();
  await writeResumeFixture(rootDir, fixture);
  let enteredResolve;
  let continueResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const continuation = new Promise((resolve) => { continueResolve = resolve; });
  let verifyCallCount = 0;
  const delayedVerifySteps = async (input) => {
    verifyCallCount += 1;
    if (verifyCallCount === 1) {
      enteredResolve();
      await continuation;
    }
    return verifyLifecycleStepReceipts(input);
  };
  try {
    const owner = executeResumeFixture(rootDir, fixture, { verifySteps: delayedVerifySteps });
    await entered;
    await assert.rejects(executeResumeFixture(rootDir, fixture), { code: 'RESUME_LEASE_EXISTS' });
    continueResolve();
    const result = await owner;
    assert.equal(result.terminal_outcome, 'RELEASED');
    assert.equal(fixture.provider.broadcastCount, 1);
  } finally {
    continueResolve?.();
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const [failure, expectedCode] of [
  ['tampered', 'RESUME_TRANSACTION_INPUT_MISMATCH'],
  ['reverted', 'RESUME_CANONICAL_RECEIPT_FAILED'],
  ['missing', 'RESUME_CANONICAL_DATA_REQUIRED'],
  ['wrong_status', 'UNEXPECTED_JOB_STATUS'],
  ['already_terminal', 'RESUME_LATEST_STATUS_MISMATCH'],
  ['head_reorg', 'CANONICAL_HEAD_CHANGED'],
]) {
  test(`resume fails closed with zero broadcast for ${failure} pending proof`, async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), `giwa-lifecycle-resume-${failure}-`));
    const fixture = resumeFixture({ failure });
    await writeResumeFixture(rootDir, fixture);
    const journalPath = path.join(rootDir, 'evidence', 'lifecycle', `${fixture.runId}.journal.json`);
    const lockPath = path.join(rootDir, 'evidence', 'lifecycle', 'active-execution.lock.json');
    const [journalBefore, lockBefore] = await Promise.all([readFile(journalPath, 'utf8'), readFile(lockPath, 'utf8')]);
    try {
      await assert.rejects(runLifecycle({
        options: fixture.lifecycleOptions,
        manifest: deployedNetwork,
        deployment,
        provider: fixture.provider,
        dojangClient: dojangClient(),
        signers: { payer: fakeSigner(ADDRESSES.payer) },
        rootDir,
        ...dependencies('release'),
        readJobStatus: fixture.readJobStatus,
      }), { code: expectedCode });
      assert.equal(fixture.provider.broadcastCount, 0);
      assert.equal(await readFile(journalPath, 'utf8'), journalBefore);
      assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('release without evaluator uses payer approval and only two active signers', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-two-wallet-release-'));
  const checkedAddresses = [];
  let terminalExpected;
  const terminalDependency = dependencies('release').verifyTerminal;
  try {
    const result = await runLifecycle({
      options: options({
        execute: true,
        runId: 'two-wallet-release-001',
        overrides: { evaluator: ZERO_ADDRESS },
      }),
      manifest: deployedNetwork,
      deployment,
      provider: fakeProvider(),
      dojangClient: dojangClient({ checkedAddresses }),
      signers: {
        payer: fakeSigner(ADDRESSES.payer),
        provider: fakeSigner(ADDRESSES.provider),
      },
      rootDir,
      ...dependencies('release'),
      verifyTerminal: async (input) => {
        terminalExpected = input.expected;
        return terminalDependency(input);
      },
    });
    const evidence = JSON.parse(await readFile(result.evidence_path, 'utf8'));
    assert.deepEqual(result.active_signer_roles, ['payer', 'provider']);
    assert.deepEqual(checkedAddresses, [ADDRESSES.payer, ADDRESSES.provider]);
    assert.deepEqual(evidence.steps.map((step) => step.signer_role), ['payer', 'payer', 'provider', 'payer', 'payer']);
    assert.equal(evidence.job.evaluator, ZERO_ADDRESS);
    assert.equal(evidence.dojang.evaluator, undefined);
    assert.equal(terminalExpected.evaluator, ZERO_ADDRESS);
    assert.equal(terminalExpected.deliverable_hash, DELIVERABLE_HASH);
    assert.deepEqual(terminalExpected.allowed_senders, [ADDRESSES.payer, ADDRESSES.provider]);
    assert.equal(terminalExpected.allowed_senders.includes(ZERO_ADDRESS), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('refund lifecycle is terminal but never classified as payment completion', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-refund-'));
  const provider = fakeProvider();
  try {
    const result = await runLifecycle({
      options: options({ execute: true, outcome: 'refund', runId: 'refund-proof-001' }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      ...dependencies('refund'),
    });
    assert.equal(result.terminal_outcome, 'REFUNDED');
    assert.equal(result.payment_completed, false);
    assert.equal(result.refunded, true);
    assert.equal(result.step_count, 4);
    assert.equal(provider.broadcastCount, 4);
    const evidence = JSON.parse(await readFile(result.evidence_path, 'utf8'));
    assert.deepEqual(evidence.steps.map((step) => step.step), ['create', 'fund', 'cancel', 'claim_refund']);
    assert.equal(evidence.boundaries.refund_is_payment_completion, false);
    assert.equal(evidence.job.deliverable_hash, `0x${'0'.repeat(64)}`);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('refund without evaluator needs only payer signer but retains provider D1 proof', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-two-wallet-refund-'));
  const checkedAddresses = [];
  try {
    const result = await runLifecycle({
      options: options({
        execute: true,
        outcome: 'refund',
        runId: 'two-wallet-refund-001',
        overrides: { evaluator: '' },
      }),
      manifest: deployedNetwork,
      deployment,
      provider: fakeProvider(),
      dojangClient: dojangClient({ checkedAddresses }),
      signers: { payer: fakeSigner(ADDRESSES.payer) },
      rootDir,
      ...dependencies('refund'),
    });
    const evidence = JSON.parse(await readFile(result.evidence_path, 'utf8'));
    assert.deepEqual(result.active_signer_roles, ['payer']);
    assert.deepEqual(checkedAddresses, [ADDRESSES.payer, ADDRESSES.provider]);
    assert.deepEqual(evidence.steps.map((step) => step.signer_role), ['payer', 'payer', 'payer', 'payer']);
    assert.equal(evidence.dojang.provider.verified, true);
    assert.equal(evidence.dojang.evaluator, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('an existing recovery journal prevents blind retry before any broadcast', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-recovery-'));
  const runId = 'recovery-proof-001';
  const journalDir = path.join(rootDir, 'evidence', 'lifecycle');
  const journalPath = path.join(journalDir, `${runId}.journal.json`);
  const provider = fakeProvider();
  await mkdir(journalDir, { recursive: true });
  await writeFile(journalPath, '{"status":"broadcast_pending_receipt"}\n', 'utf8');
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true, runId }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      ...dependencies('release'),
    }), { code: 'RECOVERY_JOURNAL_EXISTS' });
    assert.equal(provider.broadcastCount, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('existing lifecycle evidence is never overwritten', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-evidence-exists-'));
  const runId = 'evidence-exists-001';
  const evidenceDir = path.join(rootDir, 'evidence', 'lifecycle');
  const evidencePath = path.join(evidenceDir, `${runId}.evidence.json`);
  const provider = fakeProvider();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, '{"preserve":true}\n', 'utf8');
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true, runId }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signers: signers(),
      rootDir,
      ...dependencies('release'),
    }), { code: 'LIFECYCLE_EVIDENCE_EXISTS' });
    assert.equal(provider.broadcastCount, 0);
    assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), { preserve: true });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('exclusive journal creation closes the pre-broadcast concurrent-run race', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-lifecycle-race-'));
  const runId = 'recovery-race-001';
  const journalDir = path.join(rootDir, 'evidence', 'lifecycle');
  const journalPath = path.join(journalDir, `${runId}.journal.json`);
  const underlyingProvider = fakeProvider();
  let injected = false;
  const provider = new Proxy(underlyingProvider, {
    get(target, property, receiver) {
      if (property === 'getBlock') {
        return async (blockTag) => {
          if (blockTag === 'latest' && !injected) {
            injected = true;
            await mkdir(journalDir, { recursive: true });
            await writeFile(journalPath, '{"status":"competing_runner"}\n', 'utf8');
          }
          return target.getBlock(blockTag);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await assert.rejects(runLifecycle({
      options: options({ execute: true, runId }),
      manifest: deployedNetwork,
      deployment,
      provider,
      dojangClient: dojangClient(),
      signerLoader: async () => signers(),
      rootDir,
      ...dependencies('release'),
    }), { code: 'RECOVERY_JOURNAL_EXISTS' });
    assert.equal(underlyingProvider.broadcastCount, 0);
    assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), { status: 'competing_runner' });
    await assert.rejects(readFile(path.join(journalDir, 'active-execution.lock.json')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('runner source never emits or persists private keys or signed transaction bytes', async () => {
  const source = await readFile(new URL('../scripts/run-giwa-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(source, /--execute/);
  assert.match(source, /--confirm-chain-id/);
  assert.match(source, /--confirm-network/);
  assert.match(source, /prepared_before_broadcast/);
  assert.match(source, /flag: 'wx'/);
  assert.match(source, /signed_transaction_persisted: false/);
  assert.match(source, /private_keys_persisted: false/);
  assert.doesNotMatch(source, /JSON\.stringify\(process\.env/);
  assert.doesNotMatch(source, /process\.(?:stdout|stderr).*privateKey/);
  assert.doesNotMatch(source, /signed_transaction:\s*signedTransaction/);
});
