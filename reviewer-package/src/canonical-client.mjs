import { Interface } from 'ethers';
import { createJsonRpcTransport, normalizeAddress, normalizeBytes32 } from './dojang-client.mjs';
import { invariant } from './errors.mjs';
import { validateManifest } from './manifest.mjs';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const ESCROW_READ_INTERFACE = new Interface([
  'function getJob(bytes32 jobId) view returns ((address payer,address provider,address evaluator,bytes32 jobNonce,uint128 expectedAmount,uint128 amount,uint64 expiresAt,uint64 disputeOpenedAt,uint8 status,bool verificationRequired,bytes32 policyDecisionHash,bytes32 deliverableHash))',
]);

function transactionHash(value) {
  invariant(typeof value === 'string' && HASH_PATTERN.test(value), 'INVALID_TRANSACTION_HASH', 'Invalid transaction hash.');
  return value.toLowerCase();
}

function safeInteger(value, field) {
  const numeric = Number(value);
  invariant(Number.isSafeInteger(numeric) && numeric >= 0, 'INVALID_ESCROW_JOB_STATE', `Escrow ${field} is outside the supported integer range.`, { status: 502 });
  return numeric;
}

function observedChainId(value) {
  invariant(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), 'INVALID_CANONICAL_CHAIN_ID', 'Canonical RPC returned an invalid chain ID.', { status: 502 });
  const numeric = Number(BigInt(value));
  invariant(Number.isSafeInteger(numeric) && numeric > 0, 'INVALID_CANONICAL_CHAIN_ID', 'Canonical RPC chain ID is outside the supported range.', { status: 502 });
  return numeric;
}

function assertCanonicalBlock(block, { blockNumber, blockHash, phase }) {
  invariant(block && typeof block === 'object', 'CANONICAL_BLOCK_NOT_FOUND', `Canonical GIWA block was not found ${phase}.`, { status: 422 });
  const actualHash = normalizeBytes32(block.hash, 'canonical block hash');
  invariant(BigInt(block.number) === BigInt(blockNumber), 'CANONICAL_BLOCK_HEIGHT_MISMATCH', `Canonical GIWA block height changed ${phase}.`, { status: 422 });
  invariant(actualHash === normalizeBytes32(blockHash, 'receipt block hash'), 'CANONICAL_BLOCK_CHANGED', `Canonical GIWA block hash changed ${phase}.`, { status: 422 });
  return actualHash;
}

export class CanonicalReceiptClient {
  constructor({ manifest, transport = null }) {
    this.manifest = validateManifest(manifest);
    this.transport = transport ?? createJsonRpcTransport(this.manifest.rpc.canonical);
  }

  async fetchTerminalProof({ transactionHash: hash, escrowAddress, jobId }) {
    const normalizedHash = transactionHash(hash);
    const escrow = normalizeAddress(escrowAddress, 'escrow address');
    const normalizedJobId = normalizeBytes32(jobId, 'job ID');
    const [receipt, transaction, headBlockNumber, chainIdQuantity] = await Promise.all([
      this.transport('eth_getTransactionReceipt', [normalizedHash]),
      this.transport('eth_getTransactionByHash', [normalizedHash]),
      this.transport('eth_blockNumber', []),
      this.transport('eth_chainId', []),
    ]);
    const proofChainId = observedChainId(chainIdQuantity);
    invariant(proofChainId === this.manifest.chain_id, 'CANONICAL_CHAIN_ID_MISMATCH', 'Canonical RPC returned the wrong chain ID.', { status: 502 });
    invariant(receipt && typeof receipt === 'object', 'CANONICAL_RECEIPT_NOT_FOUND', 'Canonical GIWA receipt was not found.', { status: 422 });
    invariant(transaction && typeof transaction === 'object', 'CANONICAL_TRANSACTION_NOT_FOUND', 'Canonical GIWA transaction was not found.', { status: 422 });
    invariant(typeof receipt.blockNumber === 'string', 'CANONICAL_BLOCK_REQUIRED', 'Canonical receipt has no block number.', { status: 422 });
    invariant(typeof receipt.blockHash === 'string' && HASH_PATTERN.test(receipt.blockHash), 'CANONICAL_BLOCK_REQUIRED', 'Canonical receipt has no block hash.', { status: 422 });

    const canonicalBlockBefore = await this.transport('eth_getBlockByNumber', [receipt.blockNumber, false]);
    assertCanonicalBlock(canonicalBlockBefore, {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      phase: 'before the escrow state read',
    });
    const callData = ESCROW_READ_INTERFACE.encodeFunctionData('getJob', [normalizedJobId]);
    const encodedJob = await this.transport('eth_call', [
      { to: escrow, data: callData },
      { blockHash: receipt.blockHash.toLowerCase(), requireCanonical: true },
    ]);
    const canonicalBlock = await this.transport('eth_getBlockByNumber', [receipt.blockNumber, false]);
    assertCanonicalBlock(canonicalBlock, {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      phase: 'after the escrow state read',
    });
    let job;
    try {
      [job] = ESCROW_READ_INTERFACE.decodeFunctionResult('getJob', encodedJob);
    } catch (error) {
      invariant(false, 'INVALID_ESCROW_JOB_STATE', 'Escrow getJob response could not be decoded.', { status: 502, cause: error });
    }

    return {
      proofSource: 'canonical_rpc_refetch',
      proofChainId,
      receipt,
      transaction,
      headBlockNumber,
      canonicalBlock,
      jobState: {
        payer: job.payer,
        provider: job.provider,
        evaluator: job.evaluator,
        job_nonce: job.jobNonce.toLowerCase(),
        expected_amount_atomic: job.expectedAmount.toString(),
        amount_atomic: job.amount.toString(),
        expires_at: safeInteger(job.expiresAt, 'expiry'),
        status: safeInteger(job.status, 'status'),
        verification_required: job.verificationRequired,
        policy_decision_hash: job.policyDecisionHash.toLowerCase(),
        deliverable_hash: job.deliverableHash.toLowerCase(),
      },
    };
  }
}
