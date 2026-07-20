import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AbiCoder, id } from 'ethers';
import {
  createJsonRpcTransport,
  decodeBooleanResult,
  DojangClient,
  normalizeAddress,
  normalizeBytes32,
} from './dojang-client.mjs';
import { canonicalJson, canonicalValue, sha256Hex } from './canonical-json.mjs';
import { assertEvidenceSafe } from './evidence.mjs';
import { DomainError, invariant } from './errors.mjs';
import { GIWA_NETWORK, validateManifest } from './manifest.mjs';

export const D1_EVIDENCE_SCHEMA = 'xpayr.giwa.dojang-d1-evidence.v1';
export const VERIFIED_ADDRESS_SCHEMA_UID =
  '0x072d75e18b2be4f89a13a7147240477481c4b526d5795802acba59046b426e08';
export const DOJANG_ATTESTER_BOOK_ADDRESS = '0xda282e89244424e297ce8e78089b54d043fb28b6';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const ABI = AbiCoder.defaultAbiCoder();
const GET_ATTESTATION_UID_SELECTOR = id('getVerifiedAddressAttestationUid(address,bytes32)').slice(0, 10);
const GET_ATTESTATION_SELECTOR = id('getAttestation(bytes32)').slice(0, 10);
const GET_ATTESTER_SELECTOR = id('getAttester(bytes32)').slice(0, 10);
const POSITIVE_ATTESTATION_CHECKS = Object.freeze([
  'uid_nonzero',
  'attestation_uid_matches',
  'schema_uid_matches',
  'recipient_matches',
  'official_attester_matches',
  'not_revoked',
  'not_expired',
  'issued_not_after_block',
  'verified_data_word_valid',
  'verified_data_true',
]);

export const EAS_ATTESTATION_TUPLE =
  'tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data)';

export const OFFICIAL_D1_ATTESTERS = Object.freeze({
  [GIWA_NETWORK.attesters.upbitKorea.toLowerCase()]: Object.freeze({
    name: 'UPBIT_KOREA',
    test_only: false,
  }),
  [GIWA_NETWORK.attesters.testnetFaucet.toLowerCase()]: Object.freeze({
    name: 'TESTNET_FAUCET',
    test_only: true,
  }),
});

function quantity(value, field) {
  invariant(
    typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value),
    'INVALID_RPC_QUANTITY',
    `Invalid ${field}.`,
    { status: 502 },
  );
  const numeric = Number(BigInt(value));
  invariant(Number.isSafeInteger(numeric) && numeric >= 0, 'INVALID_RPC_QUANTITY', `${field} is outside the supported range.`, {
    status: 502,
  });
  return numeric;
}

function safeUint(value, field) {
  const numeric = BigInt(value);
  invariant(
    numeric >= 0n && numeric <= BigInt(Number.MAX_SAFE_INTEGER),
    'INVALID_EAS_UINT',
    `${field} is outside the supported range.`,
    { status: 502 },
  );
  return Number(numeric);
}

function normalizeBlock(block, expectedTag, phase) {
  invariant(block && typeof block === 'object', 'D1_BLOCK_NOT_FOUND', `Canonical block was not found ${phase}.`, {
    status: 502,
  });
  const number = quantity(block.number, 'canonical block number');
  invariant(BigInt(block.number) === BigInt(expectedTag), 'D1_BLOCK_HEIGHT_MISMATCH', `Canonical block height changed ${phase}.`, {
    status: 502,
  });
  return {
    number,
    tag: `0x${BigInt(block.number).toString(16)}`,
    hash: normalizeBytes32(block.hash, 'canonical block hash'),
    timestamp: quantity(block.timestamp, 'canonical block timestamp'),
  };
}

function normalizedRoles(input) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_D1_ROLES', 'D1 roles are required.');
  const roles = {
    payer: normalizeAddress(input.payer, 'payer address'),
    provider: normalizeAddress(input.provider, 'provider address'),
  };
  if (input.evaluator !== undefined && input.evaluator !== null && input.evaluator !== '') {
    roles.evaluator = normalizeAddress(input.evaluator, 'evaluator address');
  }
  invariant(Object.values(roles).every((address) => address !== ZERO_ADDRESS), 'ZERO_D1_ROLE', 'D1 role addresses cannot be zero.');
  invariant(new Set(Object.values(roles)).size === Object.keys(roles).length, 'D1_ROLE_COLLISION', 'D1 role addresses must be distinct.');
  return roles;
}

export function encodeAttestationUidCall(address, attesterId) {
  const wallet = normalizeAddress(address, 'wallet address');
  const attester = normalizeBytes32(attesterId, 'attester ID');
  return `${GET_ATTESTATION_UID_SELECTOR}${ABI.encode(['address', 'bytes32'], [wallet, attester]).slice(2)}`;
}

export function encodeGetAttestationCall(uid) {
  const normalizedUid = normalizeBytes32(uid, 'attestation UID');
  return `${GET_ATTESTATION_SELECTOR}${normalizedUid.slice(2)}`;
}

export function encodeGetAttesterCall(attesterId) {
  const normalizedId = normalizeBytes32(attesterId, 'attester ID');
  return `${GET_ATTESTER_SELECTOR}${normalizedId.slice(2)}`;
}

function decodeUid(result) {
  try {
    return normalizeBytes32(ABI.decode(['bytes32'], result)[0], 'attestation UID');
  } catch (error) {
    throw new DomainError('INVALID_ATTESTATION_UID_RESULT', 'Dojang returned an invalid attestation UID.', {
      status: 502,
      cause: error,
    });
  }
}

function decodeAttesterAddress(result) {
  try {
    return normalizeAddress(ABI.decode(['address'], result)[0], 'Dojang attester address');
  } catch (error) {
    throw new DomainError('INVALID_ATTESTER_BOOK_RESULT', 'DojangAttesterBook returned an invalid address.', {
      status: 502,
      cause: error,
    });
  }
}

function decodeAttestation(result) {
  try {
    const [decoded] = ABI.decode([EAS_ATTESTATION_TUPLE], result);
    return {
      uid: normalizeBytes32(decoded.uid, 'EAS attestation UID'),
      schema: normalizeBytes32(decoded.schema, 'EAS schema UID'),
      time: safeUint(decoded.time, 'EAS attestation time'),
      expirationTime: safeUint(decoded.expirationTime, 'EAS expiration time'),
      revocationTime: safeUint(decoded.revocationTime, 'EAS revocation time'),
      recipient: normalizeAddress(decoded.recipient, 'EAS recipient'),
      attester: normalizeAddress(decoded.attester, 'EAS attester'),
      data: decoded.data,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_EAS_ATTESTATION_RESULT', 'EAS returned invalid attestation metadata.', {
      status: 502,
      cause: error,
    });
  }
}

function dataVerdict(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data)) {
    return { word_valid: false, is_verified: false };
  }
  try {
    return { word_valid: true, is_verified: decodeBooleanResult(data) };
  } catch {
    return { word_valid: false, is_verified: false };
  }
}

async function readPositiveAttestation({
  transport,
  manifest,
  wallet,
  attesterId,
  officialAttesterAddress,
  block,
}) {
  const blockSelector = { blockHash: block.hash, requireCanonical: true };
  const uid = decodeUid(await transport('eth_call', [
    {
      to: manifest.contracts.dojang_scroll,
      data: encodeAttestationUidCall(wallet, attesterId),
    },
    blockSelector,
  ]));
  const attestation = decodeAttestation(await transport('eth_call', [
    {
      to: manifest.contracts.eas,
      data: encodeGetAttestationCall(uid),
    },
    blockSelector,
  ]));
  const decodedData = dataVerdict(attestation.data);
  const checks = {
    uid_nonzero: uid !== ZERO_BYTES32,
    attestation_uid_matches: attestation.uid === uid,
    schema_uid_matches: attestation.schema === VERIFIED_ADDRESS_SCHEMA_UID,
    recipient_matches: attestation.recipient === wallet,
    official_attester_matches: attestation.attester === officialAttesterAddress,
    not_revoked: attestation.revocationTime === 0,
    not_expired: attestation.expirationTime === 0 || attestation.expirationTime > block.timestamp,
    issued_not_after_block: attestation.time > 0 && attestation.time <= block.timestamp,
    verified_data_word_valid: decodedData.word_valid,
    verified_data_true: decodedData.is_verified,
  };

  return {
    uid,
    schema_uid: attestation.schema,
    recipient: attestation.recipient,
    attester_address: attestation.attester,
    issued_at: attestation.time,
    expires_at: attestation.expirationTime === 0 ? null : attestation.expirationTime,
    revocation_time: attestation.revocationTime,
    data_is_verified: decodedData.is_verified,
    raw_attestation_data_retained: false,
    checks,
    valid: Object.values(checks).every(Boolean),
  };
}

export async function collectD1Evidence({
  manifest: rawManifest,
  roles: rawRoles,
  transport = null,
  now = () => Math.floor(Date.now() / 1000),
  blockNumber = null,
} = {}) {
  const manifest = validateManifest(rawManifest);
  const roles = normalizedRoles(rawRoles);
  const rpc = transport ?? createJsonRpcTransport(manifest.rpc.canonical);
  const observedAt = now();
  invariant(Number.isSafeInteger(observedAt) && observedAt > 0, 'INVALID_D1_TIME', 'D1 observation time is invalid.');

  if (blockNumber !== null) {
    invariant(Number.isSafeInteger(blockNumber) && blockNumber > 0, 'INVALID_D1_BLOCK_NUMBER', 'Fixed D1 block number is invalid.');
  }
  const [chainIdResult, blockTagResult] = await Promise.all([
    rpc('eth_chainId', []),
    blockNumber === null ? rpc('eth_blockNumber', []) : Promise.resolve(`0x${blockNumber.toString(16)}`),
  ]);
  const chainId = quantity(chainIdResult, 'chain ID');
  invariant(chainId === manifest.chain_id, 'D1_CHAIN_ID_MISMATCH', 'D1 RPC returned the wrong chain ID.', { status: 502 });
  invariant(typeof blockTagResult === 'string' && /^0x[0-9a-fA-F]+$/.test(blockTagResult), 'INVALID_D1_BLOCK_TAG', 'D1 block tag is invalid.', {
    status: 502,
  });
  const blockTag = `0x${BigInt(blockTagResult).toString(16)}`;
  const before = normalizeBlock(
    await rpc('eth_getBlockByNumber', [blockTag, false]),
    blockTag,
    'before D1 reads',
  );
  const dojang = new DojangClient({ manifest, transport: rpc, now });
  const blockSelector = { blockHash: before.hash, requireCanonical: true };
  const attesterRegistry = [];
  for (const configured of manifest.dojang.attester_allowlist) {
    const attesterId = normalizeBytes32(configured.id, 'attester ID');
    const metadata = OFFICIAL_D1_ATTESTERS[attesterId];
    invariant(metadata, 'D1_ATTESTER_MAPPING_MISSING', 'Official attester metadata is missing.');
    const attesterAddress = decodeAttesterAddress(await rpc('eth_call', [
      {
        to: DOJANG_ATTESTER_BOOK_ADDRESS,
        data: encodeGetAttesterCall(attesterId),
      },
      blockSelector,
    ]));
    invariant(attesterAddress !== ZERO_ADDRESS, 'D1_ATTESTER_NOT_REGISTERED', 'Dojang attester is not registered at the pinned block.', {
      status: 502,
    });
    attesterRegistry.push({
      attester_id: attesterId,
      attester_name: metadata.name,
      attester_address: attesterAddress,
      test_only: metadata.test_only,
      source: 'dojang_attester_book_getAttester',
    });
  }
  const registryById = new Map(attesterRegistry.map((entry) => [entry.attester_id, entry]));
  const roleEvidence = {};

  for (const [role, wallet] of Object.entries(roles)) {
    const attesterEvidence = [];
    for (const configured of manifest.dojang.attester_allowlist) {
      const attesterId = normalizeBytes32(configured.id, 'attester ID');
      const registry = registryById.get(attesterId);
      invariant(registry, 'D1_ATTESTER_MAPPING_MISSING', 'Pinned attester registry entry is missing.');
      const aggregate = await dojang.checkAttester(wallet, attesterId, {
        blockTag,
        blockHash: before.hash,
        chainId,
        contextManaged: true,
      });
      const metadata = aggregate.verified
        ? await readPositiveAttestation({
          transport: rpc,
          manifest,
          wallet,
          attesterId,
          officialAttesterAddress: registry.attester_address,
          block: before,
        })
        : null;
      attesterEvidence.push({
        attester_id: attesterId,
        attester_name: registry.attester_name,
        official_attester_address: registry.attester_address,
        attester_registry_source: registry.source,
        test_only: registry.test_only,
        aggregate_is_verified: aggregate.verified,
        aggregate_source: aggregate.source,
        attestation: metadata,
        verified: aggregate.verified && metadata?.valid === true,
      });
    }
    const accepted = attesterEvidence.filter((entry) => entry.verified).map((entry) => entry.attester_id);
    roleEvidence[role] = {
      address: wallet,
      verified: accepted.length > 0,
      accepted_attester_ids: accepted,
      attesters: attesterEvidence,
    };
  }

  const after = normalizeBlock(
    await rpc('eth_getBlockByNumber', [blockTag, false]),
    blockTag,
    'after D1 reads',
  );
  invariant(
    after.hash === before.hash && after.timestamp === before.timestamp,
    'D1_CANONICAL_BLOCK_CHANGED',
    'Canonical block changed during D1 evidence collection.',
    { status: 502 },
  );

  const roleChecks = Object.fromEntries(
    Object.entries(roleEvidence).map(([role, result]) => [`${role}_verified`, result.verified]),
  );
  const payload = canonicalValue({
    schema: D1_EVIDENCE_SCHEMA,
    evidence_status: Object.values(roleChecks).every(Boolean) ? 'verified' : 'not_verified',
    overall_pass: Object.values(roleChecks).every(Boolean),
    checked_at: new Date(observedAt * 1000).toISOString(),
    mode: 'canonical_read_only',
    network: {
      network_key: manifest.network_key,
      chain_id: chainId,
      environment: manifest.environment,
      canonical_rpc_origin: new URL(manifest.rpc.canonical).origin,
      explorer_origin: new URL(manifest.explorer).origin,
      dojang_scroll: normalizeAddress(manifest.contracts.dojang_scroll, 'DojangScroll address'),
      dojang_attester_book: DOJANG_ATTESTER_BOOK_ADDRESS,
      eas: normalizeAddress(manifest.contracts.eas, 'EAS address'),
      verified_address_schema_uid: VERIFIED_ADDRESS_SCHEMA_UID,
    },
    canonical_observation: {
      block_number: before.number,
      block_tag: before.tag,
      block_hash: before.hash,
      block_timestamp: before.timestamp,
      eip_1898_hash_pinned: true,
      post_read_canonical_recheck: true,
    },
    required_roles: Object.keys(roles),
    attester_registry: attesterRegistry,
    roles: roleEvidence,
    checks: {
      chain_id_matches_manifest: true,
      attester_registry_read_at_pinned_block: true,
      one_canonical_block_for_all_reads: true,
      ...roleChecks,
    },
    privacy: {
      public_wallet_addresses_only: true,
      sensitive_credentials_retained: false,
      personal_contact_fields_retained: false,
      raw_attestation_data_retained: false,
    },
    authority: {
      transaction_sent: false,
      wallet_connected: false,
      signature_requested: false,
      mutation_rpc_methods_used: [],
      checksum_is_producer_signature: false,
    },
  });
  const evidence = canonicalValue({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      digest: sha256Hex(payload),
      digest_scope: 'canonical_payload_without_integrity',
      producer_signature: null,
    },
  });
  assertEvidenceSafe(evidence);
  return evidence;
}

export function validateD1EvidenceReference(evidence, {
  manifest: rawManifest,
  roles: rawRoles,
} = {}) {
  const manifest = validateManifest(rawManifest);
  const roles = normalizedRoles(rawRoles);
  invariant(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'INVALID_D1_EVIDENCE', 'D1 evidence object is required.');
  invariant(evidence.schema === D1_EVIDENCE_SCHEMA, 'INVALID_D1_EVIDENCE', 'Unexpected D1 evidence schema.');
  invariant(evidence.evidence_status === 'verified' && evidence.overall_pass === true, 'D1_EVIDENCE_NOT_POSITIVE', 'D1 evidence is not positive for every required role.');
  invariant(evidence.mode === 'canonical_read_only', 'INVALID_D1_EVIDENCE', 'D1 evidence mode is invalid.');
  invariant(
    evidence.network?.network_key === manifest.network_key
      && evidence.network?.chain_id === manifest.chain_id
      && normalizeAddress(evidence.network?.dojang_scroll, 'D1 Dojang address') === normalizeAddress(manifest.contracts.dojang_scroll)
      && normalizeAddress(evidence.network?.eas, 'D1 EAS address') === normalizeAddress(manifest.contracts.eas),
    'D1_NETWORK_MISMATCH',
    'D1 evidence does not match the GIWA manifest.',
  );
  invariant(
    Number.isSafeInteger(evidence.canonical_observation?.block_number)
      && evidence.canonical_observation.block_number > 0
      && /^0x[0-9a-fA-F]{64}$/.test(evidence.canonical_observation?.block_hash ?? '')
      && evidence.canonical_observation?.eip_1898_hash_pinned === true
      && evidence.canonical_observation?.post_read_canonical_recheck === true,
    'INVALID_D1_CANONICAL_OBSERVATION',
    'D1 evidence lacks a retained canonical block observation.',
  );
  invariant(
    evidence.authority?.transaction_sent === false
      && evidence.authority?.signature_requested === false
      && Array.isArray(evidence.authority?.mutation_rpc_methods_used)
      && evidence.authority.mutation_rpc_methods_used.length === 0,
    'INVALID_D1_AUTHORITY_BOUNDARY',
    'D1 evidence authority boundary is invalid.',
  );

  const expectedRoleNames = Object.keys(roles).sort();
  const retainedRoleNames = [...(evidence.required_roles ?? [])].sort();
  invariant(JSON.stringify(retainedRoleNames) === JSON.stringify(expectedRoleNames), 'D1_ROLE_SET_MISMATCH', 'D1 evidence role set does not match the requested roles.');
  const allowedAttesters = new Set(manifest.dojang.attester_allowlist.map(({ id: attesterId }) => normalizeBytes32(attesterId, 'attester ID')));
  invariant(
    Array.isArray(evidence.attester_registry)
      && evidence.attester_registry.length === allowedAttesters.size,
    'D1_ATTESTER_REGISTRY_INVALID',
    'D1 evidence must retain every configured attester registry entry exactly once.',
  );
  const registryById = new Map((evidence.attester_registry ?? []).map((entry) => [
    normalizeBytes32(entry.attester_id, 'D1 registry attester ID'),
    entry,
  ]));
  invariant(
    registryById.size === allowedAttesters.size
      && [...registryById.keys()].every((attesterId) => allowedAttesters.has(attesterId)),
    'D1_ATTESTER_REGISTRY_INVALID',
    'D1 evidence attester registry does not exactly match the configured allowlist.',
  );
  for (const [role, expectedAddress] of Object.entries(roles)) {
    const retained = evidence.roles?.[role];
    invariant(retained?.verified === true, 'D1_ROLE_NOT_VERIFIED', `${role} is not verified in the D1 evidence.`);
    invariant(normalizeAddress(retained.address, `D1 ${role} address`) === expectedAddress, 'D1_ROLE_ADDRESS_MISMATCH', `${role} address does not match the D1 evidence.`);
    invariant(evidence.checks?.[`${role}_verified`] === true, 'D1_ROLE_NOT_VERIFIED', `${role} verification check is false.`);
    invariant(Array.isArray(retained.accepted_attester_ids) && retained.accepted_attester_ids.length > 0, 'D1_ATTESTER_REQUIRED', `${role} has no accepted D1 attester.`);
    for (const acceptedIdValue of retained.accepted_attester_ids) {
      const acceptedId = normalizeBytes32(acceptedIdValue, 'accepted D1 attester ID');
      invariant(allowedAttesters.has(acceptedId), 'D1_ATTESTER_NOT_ALLOWED', `${role} D1 attester is not allowlisted.`);
      const registry = registryById.get(acceptedId);
      invariant(registry && normalizeAddress(registry.attester_address, 'D1 registry attester address') !== ZERO_ADDRESS, 'D1_ATTESTER_NOT_REGISTERED', 'D1 attester registry entry is invalid.');
      const result = retained.attesters?.find((entry) => normalizeBytes32(entry.attester_id, 'D1 attester ID') === acceptedId);
      const attestation = result?.attestation;
      invariant(
        result?.aggregate_is_verified === true
          && result?.verified === true
          && normalizeAddress(result.official_attester_address, 'D1 official attester') === normalizeAddress(registry.attester_address)
          && attestation?.valid === true
          && normalizeBytes32(attestation.uid, 'D1 attestation UID') !== ZERO_BYTES32
          && normalizeBytes32(attestation.schema_uid, 'D1 attestation schema') === VERIFIED_ADDRESS_SCHEMA_UID
          && normalizeAddress(attestation.recipient, 'D1 attestation recipient') === expectedAddress
          && normalizeAddress(attestation.attester_address, 'D1 attestation attester') === normalizeAddress(registry.attester_address)
          && Number.isSafeInteger(attestation.issued_at)
          && attestation.issued_at > 0
          && (attestation.expires_at === null || (Number.isSafeInteger(attestation.expires_at) && attestation.expires_at > evidence.canonical_observation.block_timestamp))
          && attestation.revocation_time === 0
          && attestation.data_is_verified === true
          && attestation.raw_attestation_data_retained === false
          && POSITIVE_ATTESTATION_CHECKS.every((check) => attestation.checks?.[check] === true),
        'D1_ATTESTATION_INVALID',
        `${role} positive D1 attestation metadata is invalid.`,
      );
    }
  }

  const { integrity, ...payload } = evidence;
  invariant(
    integrity?.algorithm === 'sha256'
      && integrity?.digest_scope === 'canonical_payload_without_integrity'
      && integrity?.producer_signature === null
      && sha256Hex(payload) === integrity.digest,
    'D1_INTEGRITY_MISMATCH',
    'D1 evidence checksum does not match its payload.',
  );
  return Object.freeze({
    schema: evidence.schema,
    digest: integrity.digest,
    block_number: evidence.canonical_observation.block_number,
    block_hash: normalizeBytes32(evidence.canonical_observation.block_hash, 'D1 canonical block hash'),
    roles,
    producer_authenticated: false,
  });
}

export async function verifyD1EvidenceOnchain(evidence, {
  manifest: rawManifest,
  roles: rawRoles,
  transport = null,
} = {}) {
  const manifest = validateManifest(rawManifest);
  const roles = normalizedRoles(rawRoles);
  const reference = validateD1EvidenceReference(evidence, { manifest, roles });
  const checkedAtMilliseconds = Date.parse(evidence.checked_at);
  invariant(
    Number.isSafeInteger(checkedAtMilliseconds)
      && checkedAtMilliseconds > 0
      && checkedAtMilliseconds % 1000 === 0
      && new Date(checkedAtMilliseconds).toISOString() === evidence.checked_at,
    'INVALID_D1_TIME',
    'D1 evidence checked_at must be a canonical whole-second ISO timestamp.',
  );
  const reconstructed = await collectD1Evidence({
    manifest,
    roles,
    transport,
    now: () => checkedAtMilliseconds / 1000,
    blockNumber: reference.block_number,
  });
  invariant(
    canonicalJson(reconstructed) === canonicalJson(evidence),
    'D1_ONCHAIN_RECONSTRUCTION_MISMATCH',
    'D1 evidence does not match an independent canonical on-chain reconstruction at its retained block.',
    { status: 409 },
  );
  return Object.freeze({
    ...reference,
    onchain_reconstructed: true,
    reconstruction_digest: reconstructed.integrity.digest,
  });
}

export async function writeD1EvidenceAtomic(outputPath, evidence) {
  invariant(evidence?.schema === D1_EVIDENCE_SCHEMA, 'INVALID_D1_EVIDENCE', 'Only D1 evidence can be written by this recorder.');
  assertEvidenceSafe(evidence);
  invariant(typeof outputPath === 'string' && outputPath.trim() !== '', 'INVALID_D1_OUTPUT', 'D1 evidence output path is required.');
  const absolutePath = resolve(outputPath);
  const directory = dirname(absolutePath);
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, absolutePath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DomainError('D1_EVIDENCE_EXISTS', 'D1 evidence output already exists; refusing to overwrite it.', {
        status: 409,
        cause: error,
      });
    }
    if (error instanceof DomainError) throw error;
    throw new DomainError('D1_EVIDENCE_WRITE_FAILED', 'D1 evidence could not be written atomically.', {
      status: 500,
      cause: error,
    });
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }

  return absolutePath;
}
