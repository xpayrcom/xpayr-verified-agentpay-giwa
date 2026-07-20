import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAddress } from 'ethers';
import { canonicalJson, canonicalValue, deepClone, hashesEqual, sha256Hex } from './canonical-json.mjs';
import { invariant } from './errors.mjs';

export const AUTHORITY_PROFILE_SCHEMA = 'xpayr.giwa.agentpay.authority-profile.v1';
export const PHASE4_SOD_PROFILE_ID = 'phase4_sod_v1';
export const AUTHORITY_PROFILE_STATUS_PENDING = 'pending_addresses';
export const AUTHORITY_PROFILE_STATUS_ACTIVE = 'active';
export const POLICY_AUTHORITY_KEY_NAME = 'GIWA_POLICY_AUTHORITY_PRIVATE_KEY';
export const EVIDENCE_PRODUCER_KEY_NAME = 'GIWA_EVIDENCE_PRODUCER_PRIVATE_KEY';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function normalizedAddress(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  let address;
  try {
    address = getAddress(value).toLowerCase();
  } catch {
    invariant(false, 'AUTHORITY_PROFILE_ADDRESS_INVALID', `${label} must be a valid EVM address.`);
  }
  invariant(address !== ZERO_ADDRESS, 'AUTHORITY_PROFILE_ADDRESS_INVALID', `${label} cannot be zero.`);
  return address;
}

function normalizedBytes32(value, label) {
  invariant(typeof value === 'string' && BYTES32_PATTERN.test(value),
    'AUTHORITY_PROFILE_BINDING_INVALID', `${label} must be bytes32.`);
  return value.toLowerCase();
}

function profilePayload(profile) {
  const clean = deepClone(profile);
  delete clean.integrity;
  return canonicalValue(clean);
}

export function sealAuthorityProfile(profile) {
  invariant(profile && typeof profile === 'object' && !Array.isArray(profile),
    'AUTHORITY_PROFILE_REQUIRED', 'Authority profile is required.');
  const payload = profilePayload(profile);
  return canonicalValue({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      digest_scope: 'canonical_profile_without_integrity',
      digest: sha256Hex(canonicalJson(payload)).toLowerCase(),
    },
  });
}

export function validateAuthorityProfile(profile, {
  deployment = null,
  requireActive = false,
  roles = null,
} = {}) {
  invariant(profile && typeof profile === 'object' && !Array.isArray(profile),
    'AUTHORITY_PROFILE_REQUIRED', 'Authority profile is required.');
  invariant(profile.schema === AUTHORITY_PROFILE_SCHEMA
      && profile.profile_id === PHASE4_SOD_PROFILE_ID
      && profile.network_key === 'giwa-testnet'
      && Number(profile.chain_id) === 91342
      && profile.mainnet === false,
  'AUTHORITY_PROFILE_INVALID', 'Unsupported authority profile metadata.');
  invariant(profile.status === AUTHORITY_PROFILE_STATUS_PENDING || profile.status === AUTHORITY_PROFILE_STATUS_ACTIVE,
    'AUTHORITY_PROFILE_INVALID', 'Authority profile status is invalid.');
  const payload = profilePayload(profile);
  const digest = sha256Hex(canonicalJson(payload)).toLowerCase();
  invariant(profile.integrity?.algorithm === 'sha256'
      && profile.integrity?.canonicalization === 'xpayr-canonical-json-v1'
      && profile.integrity?.digest_scope === 'canonical_profile_without_integrity'
      && hashesEqual(profile.integrity?.digest, digest),
  'AUTHORITY_PROFILE_DIGEST_INVALID', 'Authority profile canonical digest is invalid.');
  invariant(profile.constraints?.separation_of_duties === true
      && profile.constraints?.privileged_authorities_distinct_from_operational_roles === true
      && profile.constraints?.policy_signing_key_env === POLICY_AUTHORITY_KEY_NAME
      && profile.constraints?.evidence_anchor_key_env === EVIDENCE_PRODUCER_KEY_NAME,
  'AUTHORITY_PROFILE_INVALID', 'Authority profile constraints are invalid.');
  const deploymentBinding = canonicalValue({
    contract_address: normalizedAddress(profile.deployment?.contract_address, 'profile escrow contract'),
    deployer_address: normalizedAddress(profile.deployment?.deployer_address, 'profile deployer'),
    deployment_transaction_hash: normalizedBytes32(
      profile.deployment?.deployment_transaction_hash,
      'profile deployment transaction hash',
    ),
  });
  if (deployment !== null) {
    invariant(deployment?.networkKey === 'giwa-testnet'
        && Number(deployment?.chainId) === 91342
        && deployment?.mainnet === false
        && normalizedAddress(deployment.contractAddress, 'deployment escrow') === deploymentBinding.contract_address
        && normalizedAddress(deployment.deployerAddress, 'deployment deployer') === deploymentBinding.deployer_address
        && normalizedBytes32(deployment.deploymentTransactionHash, 'deployment transaction hash')
          === deploymentBinding.deployment_transaction_hash,
    'AUTHORITY_PROFILE_DEPLOYMENT_MISMATCH', 'Authority profile is not sealed to this deployment.');
  }
  const policyAuthority = normalizedAddress(
    profile.authorities?.policy_authority_address,
    'policy authority',
    { nullable: profile.status === AUTHORITY_PROFILE_STATUS_PENDING },
  );
  const evidenceProducer = normalizedAddress(
    profile.authorities?.evidence_producer_address,
    'evidence producer',
    { nullable: profile.status === AUTHORITY_PROFILE_STATUS_PENDING },
  );
  if (profile.status === AUTHORITY_PROFILE_STATUS_PENDING) {
    invariant(policyAuthority === null && evidenceProducer === null,
      'AUTHORITY_PROFILE_PENDING_INVALID', 'Pending authority profile must not contain partial addresses.');
  } else {
    invariant(policyAuthority !== null && evidenceProducer !== null,
      'AUTHORITY_PROFILE_ACTIVE_INVALID', 'Active authority profile requires both authority addresses.');
    invariant(new Set([deploymentBinding.deployer_address, policyAuthority, evidenceProducer]).size === 3,
      'AUTHORITY_PROFILE_ROLE_COLLISION', 'Policy authority, evidence producer and deployer must be mutually distinct.');
  }
  if (requireActive) {
    invariant(profile.status === AUTHORITY_PROFILE_STATUS_ACTIVE,
      'AUTHORITY_PROFILE_NOT_ACTIVE', 'phase4_sod_v1 is sealed but remains pending until two distinct public addresses are activated.');
  }
  if (roles !== null) {
    invariant(profile.status === AUTHORITY_PROFILE_STATUS_ACTIVE,
      'AUTHORITY_PROFILE_NOT_ACTIVE', 'Role separation requires an active authority profile.');
    const payer = normalizedAddress(roles.payer, 'profile payer');
    const provider = normalizedAddress(roles.provider, 'profile provider');
    const evaluator = roles.evaluator === null || roles.evaluator === undefined || roles.evaluator === ZERO_ADDRESS
      ? null
      : normalizedAddress(roles.evaluator, 'profile evaluator');
    const operationalRoles = [
      deploymentBinding.deployer_address,
      payer,
      provider,
      ...(evaluator === null ? [] : [evaluator]),
    ];
    invariant(!operationalRoles.includes(policyAuthority)
        && !operationalRoles.includes(evidenceProducer)
        && policyAuthority !== evidenceProducer,
    'AUTHORITY_PROFILE_ROLE_COLLISION', 'Policy authority and evidence producer must be distinct from each other and every operational role.');
  }
  return Object.freeze({
    schema: AUTHORITY_PROFILE_SCHEMA,
    profileId: PHASE4_SOD_PROFILE_ID,
    status: profile.status,
    digest,
    deployment: Object.freeze(deploymentBinding),
    policyAuthorityAddress: policyAuthority,
    evidenceProducerAddress: evidenceProducer,
    profile,
  });
}

export function authorityProfileReference(validatedProfile) {
  invariant(validatedProfile?.profileId === PHASE4_SOD_PROFILE_ID
      && typeof validatedProfile?.digest === 'string',
  'AUTHORITY_PROFILE_REQUIRED', 'A validated authority profile is required.');
  return canonicalValue({
    profile_id: validatedProfile.profileId,
    profile_digest: validatedProfile.digest,
  });
}

export async function loadAuthorityProfile(profileId, {
  moduleRoot,
  deployment = null,
  requireActive = false,
  roles = null,
} = {}) {
  invariant(profileId === PHASE4_SOD_PROFILE_ID,
    'AUTHORITY_PROFILE_UNKNOWN', `Unsupported authority profile: ${profileId ?? '(missing)'}.`);
  invariant(typeof moduleRoot === 'string' && path.isAbsolute(moduleRoot),
    'AUTHORITY_PROFILE_ROOT_REQUIRED', 'An absolute module root is required.');
  const profilePath = path.join(moduleRoot, 'config', 'authority-profiles', `${PHASE4_SOD_PROFILE_ID}.json`);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  return validateAuthorityProfile(profile, { deployment, requireActive, roles });
}
