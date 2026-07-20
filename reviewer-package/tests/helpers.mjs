import { readFile } from 'node:fs/promises';
import { id } from 'ethers';
import { loadManifest } from '../src/manifest.mjs';
import {
  CLAIM_DISPUTE_TIMEOUT_REFUND_SELECTOR,
  CLAIM_REFUND_SELECTOR,
  DISPUTE_RESOLVED_EVENT_TOPIC,
  JOB_REFUNDED_EVENT_TOPIC,
  JOB_RELEASED_EVENT_TOPIC,
  RELEASE_JOB_SELECTOR,
  RESOLVE_DISPUTE_SELECTOR,
} from '../src/confirmation.mjs';
import { deriveJobId } from '../src/policy-engine.mjs';

export const ADDRESSES = Object.freeze({
  payer: '0x1111111111111111111111111111111111111111',
  provider: '0x2222222222222222222222222222222222222222',
  evaluator: '0x3333333333333333333333333333333333333333',
  outsider: '0x4444444444444444444444444444444444444444',
  escrow: '0x5555555555555555555555555555555555555555',
});

export const TX_HASH = `0x${'ab'.repeat(32)}`;
export const JOB_NONCE = `0x${'11'.repeat(32)}`;
export const JOB_ID = deriveJobId(ADDRESSES.payer, JOB_NONCE);
export const EVENT_TOPIC = JOB_RELEASED_EVENT_TOPIC;
export const POLICY_HASH = `0x${'22'.repeat(32)}`;
export const BLOCK_HASH = `0x${'33'.repeat(32)}`;
export const DELIVERABLE_HASH = `0x${'44'.repeat(32)}`;
export const DEFAULT_EXPIRY = 1_784_505_600;
export const REFUND_REASONS = Object.freeze({
  claim: id('CANCELLED_OR_EXPIRED').toLowerCase(),
  dispute: id('DISPUTE_RESOLUTION').toLowerCase(),
  timeout: id('DISPUTE_TIMEOUT').toLowerCase(),
});

const uint256Word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addressTopic = (value) => `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
const encodedWords = (...values) => `0x${values.map((value) => value.slice(2)).join('')}`;

export async function manifest() {
  return loadManifest(new URL('../config/giwa-testnet.json', import.meta.url));
}

export async function rawManifest() {
  return JSON.parse(await readFile(new URL('../config/giwa-testnet.json', import.meta.url), 'utf8'));
}

export function verifiedIdentity(source = 'giwa_dojang_read_only') {
  return {
    payer: { address: ADDRESSES.payer, verified: true, source, accepted_attester_id: null },
    provider: { address: ADDRESSES.provider, verified: true, source, accepted_attester_id: null },
    evaluator: { address: ADDRESSES.evaluator, verified: true, source, accepted_attester_id: null },
  };
}

export function baseIntent(overrides = {}) {
  return {
    title: 'Translate a merchant catalog',
    networkKey: 'giwa-testnet',
    payerAddress: ADDRESSES.payer,
    providerAddress: ADDRESSES.provider,
    amountEth: '0.01',
    ...overrides,
  };
}

export function canonicalReceipt({
  status = '0x1',
  blockNumber = '0x64',
  transactionHash = TX_HASH,
  address = ADDRESSES.escrow,
  topic = EVENT_TOPIC,
  jobId = JOB_ID,
  actor = ADDRESSES.payer,
  provider = ADDRESSES.provider,
  amountAtomic = '10000000000000000',
  blockHash = BLOCK_HASH,
} = {}) {
  return {
    status,
    blockNumber,
    transactionHash,
    blockHash,
    logs: [{
      address,
      topics: [topic, jobId, addressTopic(actor), addressTopic(provider)],
      data: uint256Word(amountAtomic),
    }],
  };
}

export function canonicalTransaction(overrides = {}) {
  const {
    jobId = JOB_ID,
    action = 'release',
    payProvider = false,
    ...transactionOverrides
  } = overrides;
  const selector = action === 'resolve'
    ? RESOLVE_DISPUTE_SELECTOR
    : action === 'claim_refund'
      ? CLAIM_REFUND_SELECTOR
      : action === 'claim_dispute_timeout_refund'
        ? CLAIM_DISPUTE_TIMEOUT_REFUND_SELECTOR
        : RELEASE_JOB_SELECTOR;
  const input = action === 'resolve'
    ? `${selector}${jobId.slice(2)}${BigInt(payProvider ? 1 : 0).toString(16).padStart(64, '0')}`
    : `${selector}${jobId.slice(2)}`;
  return {
    hash: TX_HASH,
    from: ADDRESSES.payer,
    to: ADDRESSES.escrow,
    value: '0x0',
    blockHash: BLOCK_HASH,
    blockNumber: '0x64',
    input,
    ...transactionOverrides,
  };
}

export function canonicalRefundReceipt({
  status = '0x1',
  blockNumber = '0x64',
  transactionHash = TX_HASH,
  address = ADDRESSES.escrow,
  jobId = JOB_ID,
  payer = ADDRESSES.payer,
  amountAtomic = '10000000000000000',
  reason = REFUND_REASONS.claim,
  blockHash = BLOCK_HASH,
} = {}) {
  return {
    status,
    blockNumber,
    transactionHash,
    blockHash,
    logs: [{
      address,
      topics: [JOB_REFUNDED_EVENT_TOPIC, jobId, addressTopic(payer)],
      data: encodedWords(uint256Word(amountAtomic), reason),
    }],
  };
}

export function canonicalResolveReceipt({
  payProvider,
  resolver = ADDRESSES.payer,
  jobId = JOB_ID,
  ...overrides
} = {}) {
  const terminal = payProvider
    ? canonicalReceipt({ jobId, actor: resolver, ...overrides })
    : canonicalRefundReceipt({ jobId, reason: REFUND_REASONS.dispute, ...overrides });
  return {
    ...terminal,
    logs: [{
      address: overrides.address ?? ADDRESSES.escrow,
      topics: [DISPUTE_RESOLVED_EVENT_TOPIC, jobId, addressTopic(resolver)],
      data: uint256Word(payProvider ? 1 : 0),
    }, ...terminal.logs],
  };
}

export function canonicalJobState(overrides = {}) {
  return {
    payer: ADDRESSES.payer,
    provider: ADDRESSES.provider,
    evaluator: '0x0000000000000000000000000000000000000000',
    job_nonce: JOB_NONCE,
    expected_amount_atomic: '10000000000000000',
    amount_atomic: '0',
    expires_at: DEFAULT_EXPIRY,
    status: 5,
    verification_required: true,
    policy_decision_hash: POLICY_HASH,
    deliverable_hash: DELIVERABLE_HASH,
    ...overrides,
  };
}

export function canonicalBlock(overrides = {}) {
  return { hash: BLOCK_HASH, number: '0x64', ...overrides };
}
