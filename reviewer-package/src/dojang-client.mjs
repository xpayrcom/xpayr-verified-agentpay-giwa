import { DomainError, invariant } from './errors.mjs';
import { validateManifest } from './manifest.mjs';

const IS_VERIFIED_SELECTOR = 'ba03e205';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function normalizeAddress(value, field = 'address') {
  invariant(typeof value === 'string' && ADDRESS_PATTERN.test(value), 'INVALID_ADDRESS', `Invalid ${field}.`);
  return value.toLowerCase();
}

export function normalizeBytes32(value, field = 'bytes32') {
  invariant(typeof value === 'string' && BYTES32_PATTERN.test(value), 'INVALID_BYTES32', `Invalid ${field}.`);
  return value.toLowerCase();
}

export function encodeIsVerifiedCall(address, attesterId) {
  const normalizedAddress = normalizeAddress(address);
  const normalizedAttester = normalizeBytes32(attesterId, 'attester ID');
  return `0x${IS_VERIFIED_SELECTOR}${normalizedAddress.slice(2).padStart(64, '0')}${normalizedAttester.slice(2)}`;
}

export function decodeBooleanResult(value) {
  invariant(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'INVALID_RPC_RESULT', 'Invalid eth_call result.');
  const decoded = BigInt(value);
  invariant(decoded === 0n || decoded === 1n, 'INVALID_RPC_RESULT', 'Dojang result is not boolean.');
  return decoded === 1n;
}

export function createJsonRpcTransport(url, { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  invariant(typeof url === 'string' && url.startsWith('https://'), 'INVALID_RPC_URL', 'RPC URL must use HTTPS.');
  invariant(typeof fetchImpl === 'function', 'FETCH_UNAVAILABLE', 'A fetch implementation is required.');
  let sequence = 0;

  return async function jsonRpc(method, params) {
    const id = ++sequence;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DomainError('RPC_UNAVAILABLE', 'GIWA RPC request failed.', { status: 502, cause: error });
    }

    invariant(response.ok, 'RPC_HTTP_ERROR', `GIWA RPC returned HTTP ${response.status}.`, { status: 502 });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DomainError('RPC_INVALID_JSON', 'GIWA RPC returned invalid JSON.', { status: 502, cause: error });
    }
    invariant(payload?.jsonrpc === '2.0' && payload.id === id, 'RPC_PROTOCOL_ERROR', 'Invalid JSON-RPC response.', { status: 502 });
    invariant(!payload.error, 'RPC_CALL_ERROR', 'GIWA RPC call reverted or failed.', {
      status: 502,
      details: payload.error ? { code: payload.error.code, message: payload.error.message } : null,
    });
    return payload.result;
  };
}

function normalizeExpiry(value) {
  if (value === null || value === undefined || value === '0' || value === 0) return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  invariant(Number.isSafeInteger(numeric) && numeric > 0, 'INVALID_ATTESTATION_EXPIRY', 'Invalid attestation expiry.');
  return numeric;
}

function normalizeBlockTag(value) {
  invariant(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), 'INVALID_BLOCK_TAG', 'Dojang block tag is invalid.', { status: 502 });
  return value.toLowerCase();
}

function blockNumberFromTag(blockTag) {
  const numeric = Number(BigInt(blockTag));
  invariant(Number.isSafeInteger(numeric) && numeric >= 0, 'INVALID_BLOCK_TAG', 'Dojang block number is outside the supported range.', { status: 502 });
  return numeric;
}

function observedChainId(value) {
  invariant(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), 'INVALID_DOJANG_CHAIN_ID', 'Dojang RPC returned an invalid chain ID.', { status: 502 });
  const numeric = Number(BigInt(value));
  invariant(Number.isSafeInteger(numeric) && numeric > 0, 'INVALID_DOJANG_CHAIN_ID', 'Dojang RPC chain ID is outside the supported range.', { status: 502 });
  return numeric;
}

async function canonicalBlockAt(transport, blockTag, phase) {
  const block = await transport('eth_getBlockByNumber', [blockTag, false]);
  invariant(block && typeof block === 'object', 'DOJANG_BLOCK_NOT_FOUND', `Dojang canonical block was not found ${phase}.`, { status: 502 });
  const blockHash = normalizeBytes32(block.hash, 'Dojang block hash');
  invariant(typeof block.number === 'string' && BigInt(block.number) === BigInt(blockTag), 'DOJANG_BLOCK_HEIGHT_MISMATCH', `Dojang canonical block height changed ${phase}.`, { status: 502 });
  return { block, blockHash };
}

export function validateAttestationVerdict(verdict, { allowlist, now = Math.floor(Date.now() / 1000) }) {
  invariant(verdict && typeof verdict === 'object', 'INVALID_ATTESTATION', 'Invalid Dojang attestation verdict.');
  const attesterId = normalizeBytes32(verdict.attester_id ?? verdict.attesterId, 'attester ID');
  const allowed = new Set(allowlist.map((entry) => normalizeBytes32(entry.id ?? entry, 'allowlisted attester ID')));
  const expiresAt = normalizeExpiry(verdict.expires_at ?? verdict.expiresAt);
  const lifecycleViaAggregate = verdict.lifecycle_checked_by_contract === true;
  const hasExplicitRevocation = typeof verdict.revoked === 'boolean';
  const hasExplicitExpirySemantics = Object.hasOwn(verdict, 'expires_at') || Object.hasOwn(verdict, 'expiresAt');
  const metadataLifecycleValid = hasExplicitRevocation
    && hasExplicitExpirySemantics
    && verdict.revoked === false
    && (expiresAt === null || expiresAt > now);
  const checks = {
    allowlisted_attester: allowed.has(attesterId),
    contract_verified: verdict.verified === true,
    lifecycle_valid_via_isVerified: lifecycleViaAggregate ? verdict.verified === true : metadataLifecycleValid,
  };

  return {
    ...verdict,
    attester_id: attesterId,
    expires_at: expiresAt,
    lifecycle_validation: lifecycleViaAggregate ? 'enforced_by_dojang_isVerified_aggregate' : 'provided_metadata',
    verified: Object.values(checks).every(Boolean),
    checks,
  };
}

export class DojangClient {
  constructor({ manifest, transport, now = () => Math.floor(Date.now() / 1000) }) {
    this.manifest = validateManifest(manifest);
    this.transport = transport ?? createJsonRpcTransport(this.manifest.rpc.canonical);
    this.now = now;
  }

  async checkAttester(address, attesterId, {
    blockTag = null,
    blockHash = null,
    chainId = null,
    contextManaged = false,
  } = {}) {
    const wallet = normalizeAddress(address, 'wallet address');
    const attester = normalizeBytes32(attesterId, 'attester ID');
    const allowed = this.manifest.dojang.attester_allowlist.some((entry) => entry.id === attester);
    invariant(allowed, 'ATTESTER_NOT_ALLOWED', 'Requested Dojang attester is not allowlisted.', { status: 422 });

    const liveChainId = chainId ?? observedChainId(await this.transport('eth_chainId', []));
    invariant(liveChainId === this.manifest.chain_id, 'DOJANG_CHAIN_ID_MISMATCH', 'Dojang RPC returned the wrong chain ID.', { status: 502 });
    const pinnedBlock = normalizeBlockTag(blockTag ?? await this.transport('eth_blockNumber', []));
    const before = blockHash
      ? { blockHash: normalizeBytes32(blockHash, 'Dojang block hash') }
      : await canonicalBlockAt(this.transport, pinnedBlock, 'before the attestation read');
    const result = await this.transport('eth_call', [
      {
        to: this.manifest.contracts.dojang_scroll,
        data: encodeIsVerifiedCall(wallet, attester),
      },
      { blockHash: before.blockHash, requireCanonical: true },
    ]);
    if (!contextManaged) {
      const after = await canonicalBlockAt(this.transport, pinnedBlock, 'after the attestation read');
      invariant(after.blockHash === before.blockHash, 'DOJANG_BLOCK_CHANGED', 'Dojang canonical block changed during the attestation read.', { status: 502 });
    }

    return validateAttestationVerdict(
      {
        address: wallet,
        attester_id: attester,
        verified: decodeBooleanResult(result),
        revoked: null,
        expires_at: null,
        source: 'dojang_contract_isVerified',
        chain_id: liveChainId,
        lifecycle_checked_by_contract: true,
        block_number: blockNumberFromTag(pinnedBlock),
        block_tag: pinnedBlock.toLowerCase(),
        block_hash: before.blockHash,
        revocation_metadata_queried: false,
        expiry_metadata_queried: false,
      },
      { allowlist: this.manifest.dojang.attester_allowlist, now: this.now() },
    );
  }

  async checkAddress(address, { attesterId = null } = {}) {
    const wallet = normalizeAddress(address, 'wallet address');
    const attesters = attesterId
      ? [normalizeBytes32(attesterId, 'attester ID')]
      : this.manifest.dojang.attester_allowlist.map((entry) => entry.id);
    const results = [];
    const [chainIdQuantity, latestBlockTag] = await Promise.all([
      this.transport('eth_chainId', []),
      this.transport('eth_blockNumber', []),
    ]);
    const chainId = observedChainId(chainIdQuantity);
    invariant(chainId === this.manifest.chain_id, 'DOJANG_CHAIN_ID_MISMATCH', 'Dojang RPC returned the wrong chain ID.', { status: 502 });
    const blockTag = normalizeBlockTag(latestBlockTag);
    const before = await canonicalBlockAt(this.transport, blockTag, 'before the address verification');

    for (const id of attesters) {
      results.push(await this.checkAttester(wallet, id, {
        blockTag,
        blockHash: before.blockHash,
        chainId,
        contextManaged: true,
      }));
    }
    const after = await canonicalBlockAt(this.transport, blockTag, 'after the address verification');
    invariant(after.blockHash === before.blockHash, 'DOJANG_BLOCK_CHANGED', 'Dojang canonical block changed during address verification.', { status: 502 });

    const accepted = results.find((entry) => entry.verified) ?? null;
    return {
      address: wallet,
      verified: accepted !== null,
      accepted_attester_id: accepted?.attester_id ?? null,
      checks: results,
      source: 'giwa_dojang_read_only',
      chain_id: chainId,
      block_number: blockNumberFromTag(blockTag),
      block_tag: blockTag.toLowerCase(),
      block_hash: before.blockHash,
      checked_at: new Date(this.now() * 1000).toISOString(),
    };
  }
}
