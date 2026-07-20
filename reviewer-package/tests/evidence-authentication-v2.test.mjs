import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { canonicalJson, sha256Hex } from '../src/canonical-json.mjs';
import {
  AUTHENTICATED_EVIDENCE_V2_SCHEMA,
  ANCHOR_MAGIC_V2,
  buildAuthenticatedSidecarV2,
  buildAuthenticationMessageV2,
  decodeAnchorCalldataV2,
  encodeAnchorCalldataV2,
  signAuthenticationMessageV2,
  validateLifecycleEvidenceV2,
  validateSignedPolicyArtifactV2,
  verifyAuthenticatedSidecarV2,
  verifyAuthenticationSignatureV2,
  verifyCanonicalAnchorV2,
} from '../src/evidence-authentication.mjs';
import { authorityProfileReference, sealAuthorityProfile, validateAuthorityProfile } from '../src/authority-profile.mjs';
import { buildPolicyEvidence, signPolicyEvidence } from '../src/policy-evidence.mjs';
import { runEvidenceAuthentication } from '../scripts/authenticate-lifecycle-evidence.mjs';
import { BLOCK_HASH, DELIVERABLE_HASH, JOB_NONCE, manifest } from './helpers.mjs';

const DEPLOYER = new Wallet(`0x${'51'.repeat(32)}`);
const PROVIDER = new Wallet(`0x${'52'.repeat(32)}`);
const POLICY = new Wallet(`0x${'53'.repeat(32)}`);
const PRODUCER = new Wallet(`0x${'54'.repeat(32)}`);
const ESCROW = new Wallet(`0x${'55'.repeat(32)}`).address;
const DEPLOY_TX = `0x${'56'.repeat(32)}`;
const JOB_ID = `0x${'57'.repeat(32)}`;
const TERMINAL_TX = `0x${'58'.repeat(32)}`;
const SOURCE_RUN_ID = 'sod-auth-v2-run-001';
const SOURCE_SHA = `0x${'59'.repeat(32)}`;
const POLICY_PATH = `evidence/policy/${SOURCE_RUN_ID}.policy.json`;
const EXPIRY = 1_800_007_200;
const VALUE = '1000000000000';

function deployment() {
  return {
    networkKey: 'giwa-testnet',
    chainId: 91342,
    mainnet: false,
    status: 'deployed_testnet',
    contractAddress: ESCROW,
    deployerAddress: DEPLOYER.address,
    deploymentTransactionHash: DEPLOY_TX,
  };
}

function profile() {
  return validateAuthorityProfile(sealAuthorityProfile({
    schema: 'xpayr.giwa.agentpay.authority-profile.v1',
    profile_id: 'phase4_sod_v1',
    status: 'active',
    network_key: 'giwa-testnet',
    chain_id: 91342,
    mainnet: false,
    deployment: {
      contract_address: ESCROW,
      deployer_address: DEPLOYER.address,
      deployment_transaction_hash: DEPLOY_TX,
    },
    authorities: {
      policy_authority_address: POLICY.address,
      evidence_producer_address: PRODUCER.address,
    },
    constraints: {
      separation_of_duties: true,
      privileged_authorities_distinct_from_operational_roles: true,
      policy_signing_key_env: 'GIWA_POLICY_AUTHORITY_PRIVATE_KEY',
      evidence_anchor_key_env: 'GIWA_EVIDENCE_PRODUCER_PRIVATE_KEY',
    },
    boundaries: {
      testnet_only: true,
      real_customer_funds: false,
      legacy_deployment_authorities_unchanged: true,
      historical_evidence_unchanged: true,
    },
  }), {
    deployment: deployment(),
    requireActive: true,
    roles: { payer: DEPLOYER.address, provider: PROVIDER.address, evaluator: null },
  });
}

function artifactBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileSha(value) {
  return `0x${createHash('sha256').update(artifactBytes(value)).digest('hex')}`;
}

async function fixture() {
  const authorityProfile = profile();
  const unsignedPolicy = buildPolicyEvidence({
    createdAt: '2027-01-15T08:00:00.000Z',
    recordId: 'sod-auth-policy-record-001',
    intentId: 'sod-auth-policy-intent-001',
    authority: POLICY.address,
    authorityProfile: authorityProfileReference(authorityProfile),
    decision: 'ALLOW',
    validFrom: 1_800_000_000,
    validUntil: EXPIRY,
    ruleset: { max_job_value_wei: VALUE, max_expiry_seconds: 7_200 },
    job: {
      escrow: ESCROW,
      jobId: JOB_ID,
      jobNonce: JOB_NONCE,
      payer: DEPLOYER.address,
      provider: PROVIDER.address,
      evaluator: '0x0000000000000000000000000000000000000000',
      valueWei: VALUE,
      expiresAt: EXPIRY,
      outcome: 'RELEASED',
      deliverableHash: DELIVERABLE_HASH,
    },
  });
  const policyArtifact = await signPolicyEvidence(unsignedPolicy, POLICY);
  const policyFileSha = fileSha(policyArtifact);
  const payload = {
    schema: 'xpayr.giwa.agentpay.lifecycle-evidence.v1',
    evidence_level: 'canonical_giwa_sepolia_lifecycle_receipts_signed_policy_sod_v1',
    created_at: '2027-01-15T08:30:00.000Z',
    network_key: 'giwa-testnet',
    chain_id: 91342,
    escrow_contract: ESCROW,
    run_id: SOURCE_RUN_ID,
    outcome: 'RELEASED',
    payment_completed: true,
    refunded: false,
    job: {
      job_id: JOB_ID,
      job_nonce: JOB_NONCE,
      payer: DEPLOYER.address.toLowerCase(),
      provider: PROVIDER.address.toLowerCase(),
      evaluator: '0x0000000000000000000000000000000000000000',
      value_wei: VALUE,
      expires_at: EXPIRY,
      policy_decision_hash: policyArtifact.decision_hash,
      deliverable_hash: DELIVERABLE_HASH,
    },
    policy_origin: {
      mode: 'eip712_phase4_sod_policy_artifact',
      authentication: 'eip712_phase4_sod_policy_authority_verified',
      artifact_path: POLICY_PATH,
      artifact_digest: policyArtifact.integrity.digest,
      artifact_sha256: policyFileSha,
      record_id: policyArtifact.record_id,
      intent_id: policyArtifact.intent_id,
      authority_address: POLICY.address.toLowerCase(),
      producer_address: POLICY.address.toLowerCase(),
      typed_data_digest: policyArtifact.authentication.eip712.typed_data_digest,
      binding_digest: policyArtifact.binding_digest,
      signature_verified: true,
      policy_decision_hash: policyArtifact.decision_hash,
      valid_from: policyArtifact.validity.valid_from,
      valid_until: policyArtifact.validity.valid_until,
      signed_job_expires_at: policyArtifact.job.expires_at,
      same_wallet_testnet_authority: false,
      separation_of_duties: true,
      authority_profile_id: authorityProfile.profileId,
      authority_profile_digest: authorityProfile.digest,
      evidence_producer_address: PRODUCER.address.toLowerCase(),
    },
    canonical_step_receipts: { all_steps_canonical: true },
    canonical_terminal: {
      canonical_terminal_verified: true,
      terminal: true,
      transaction_hash: TERMINAL_TX,
    },
    boundaries: { testnet_only: true, real_customer_funds: false },
  };
  const source = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'xpayr-canonical-json-v1',
      digest: sha256Hex(canonicalJson(payload)),
    },
  };
  const binding = validateLifecycleEvidenceV2(source, { authorityProfile });
  const policy = validateSignedPolicyArtifactV2(policyArtifact, binding, {
    authorityProfile,
    policyArtifactPath: POLICY_PATH,
    policyFileSha256: policyFileSha,
  });
  const template = buildAuthenticationMessageV2({
    lifecycleBinding: binding,
    sourceFileSha256: SOURCE_SHA,
    policyEnvelopeDigest: policy.digest,
    producer: PRODUCER.address,
    authorityProfile,
  });
  const authentication = await signAuthenticationMessageV2(template, PRODUCER);
  return { authorityProfile, source, binding, policyArtifact, policyFileSha, policy, template, authentication };
}

function canonicalProvider(authentication) {
  const calldata = encodeAnchorCalldataV2(authentication);
  const transaction = {
    hash: `0x${'aa'.repeat(32)}`,
    from: PRODUCER.address.toLowerCase(),
    to: PRODUCER.address.toLowerCase(),
    value: 0n,
    type: 2,
    chainId: 91342n,
    nonce: 7,
    data: calldata,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
  };
  const receipt = {
    hash: transaction.hash,
    from: transaction.from,
    to: transaction.to,
    status: 1,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    gasUsed: 30_000n,
    gasPrice: 500_000n,
  };
  return {
    transaction,
    async getNetwork() { return { chainId: 91342n }; },
    async getTransactionReceipt(hash) { return hash === transaction.hash ? receipt : null; },
    async getTransaction(hash) { return hash === transaction.hash ? transaction : null; },
    async getBlock(number) { return { number, hash: BLOCK_HASH, timestamp: 1_800_000_100 }; },
    async getBlockNumber() { return 101; },
    async send(method, params) {
      assert.equal(method, 'eth_getCode');
      assert.equal(params[0], PRODUCER.address.toLowerCase());
      return '0x';
    },
  };
}

test('auth-v2 binds separate policy/evidence authorities, profile digest, XPA2 and canonical anchor', async () => {
  const data = await fixture();
  const verifiedSignature = verifyAuthenticationSignatureV2(data.authentication, {
    expectedProducer: PRODUCER.address,
  });
  assert.equal(verifiedSignature.recovered_address, PRODUCER.address.toLowerCase());
  assert.equal(verifiedSignature.message.policyAuthority, POLICY.address.toLowerCase());
  assert.equal(verifiedSignature.message.authorityProfileDigest, data.authorityProfile.digest);
  const calldata = encodeAnchorCalldataV2(data.authentication);
  assert.equal(calldata.startsWith(ANCHOR_MAGIC_V2), true);
  assert.equal(decodeAnchorCalldataV2(calldata).authority_profile_digest, data.authorityProfile.digest);
  const provider = canonicalProvider(data.authentication);
  const anchor = await verifyCanonicalAnchorV2({
    provider,
    transactionHash: provider.transaction.hash,
    authentication: data.authentication,
    requiredConfirmations: 2,
  });
  const sidecar = buildAuthenticatedSidecarV2({
    lifecycleEvidencePath: `evidence/lifecycle/${SOURCE_RUN_ID}.evidence.json`,
    lifecycleBinding: data.binding,
    sourceFileSha256: SOURCE_SHA,
    policyArtifactPath: POLICY_PATH,
    validatedPolicy: data.policy,
    authentication: data.authentication,
    anchor,
    authorityProfile: data.authorityProfile,
    createdAt: '2027-01-15T09:00:00.000Z',
  });
  assert.equal(sidecar.schema, AUTHENTICATED_EVIDENCE_V2_SCHEMA);
  assert.equal(sidecar.checks.producer_is_lifecycle_payer, false);
  const result = verifyAuthenticatedSidecarV2({
    sidecar,
    lifecycleBinding: data.binding,
    sourceFileSha256: SOURCE_SHA,
    validatedPolicy: data.policy,
    authorityProfile: data.authorityProfile,
  });
  assert.equal(result.valid, true);
  assert.equal(result.policy_authority_address, POLICY.address.toLowerCase());
  assert.equal(result.producer_address, PRODUCER.address.toLowerCase());
});

test('auth-v2 rejects profile, policy authority and producer substitution', async () => {
  const data = await fixture();
  const tamperedSource = structuredClone(data.source);
  tamperedSource.policy_origin.evidence_producer_address = POLICY.address;
  assert.throws(() => validateLifecycleEvidenceV2(tamperedSource, {
    authorityProfile: data.authorityProfile,
  }), { code: 'INVALID_AUTH_V2_INTEGRITY' });
  const wrongProfile = {
    ...data.authorityProfile,
    digest: `0x${'ff'.repeat(32)}`,
  };
  assert.throws(() => validateLifecycleEvidenceV2(data.source, {
    authorityProfile: wrongProfile,
  }), { code: 'AUTH_V2_POLICY_ORIGIN_INVALID' });
  await assert.rejects(signAuthenticationMessageV2(data.template, POLICY), {
    code: 'AUTH_V2_SIGNER_MISMATCH',
  });
});

test('auth-v2 runner preflight selects auth-v2 output and never loads a signer', async () => {
  const data = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'giwa-auth-v2-runner-'));
  const lifecycleRoot = path.join(root, 'evidence', 'lifecycle');
  const policyRoot = path.join(root, 'evidence', 'policy');
  await mkdir(lifecycleRoot, { recursive: true });
  await mkdir(policyRoot, { recursive: true });
  await writeFile(path.join(lifecycleRoot, `${SOURCE_RUN_ID}.evidence.json`), artifactBytes(data.source), { mode: 0o644 });
  await writeFile(path.join(policyRoot, `${SOURCE_RUN_ID}.policy.json`), artifactBytes(data.policyArtifact), { mode: 0o600 });
  let signerLoads = 0;
  const provider = {
    async getNetwork() { return { chainId: 91342n }; },
    async getCode(address) { assert.equal(address, PRODUCER.address.toLowerCase()); return '0x'; },
    async getTransactionCount() { return 7; },
  };
  try {
    const report = await runEvidenceAuthentication({
      options: {
        execute: false,
        resume: false,
        sourceEvidence: path.join(lifecycleRoot, `${SOURCE_RUN_ID}.evidence.json`),
        signedPolicy: path.join(policyRoot, `${SOURCE_RUN_ID}.policy.json`),
        producerAddress: PRODUCER.address.toLowerCase(),
        authorityProfileId: 'phase4_sod_v1',
      },
      manifest: await manifest(),
      deployment: deployment(),
      provider,
      rootDir: root,
      authorityProfile: data.authorityProfile,
      signerLoader: async () => { signerLoads += 1; return PRODUCER; },
    });
    assert.equal(report.status, 'ready');
    assert.equal(report.authentication_version, 'v2');
    assert.match(report.auth_artifact_path, /\.auth-v2\.json$/);
    assert.equal(report.policy_authority, POLICY.address.toLowerCase());
    assert.equal(report.producer, PRODUCER.address.toLowerCase());
    assert.equal(signerLoads, 0);
    await assert.rejects(runEvidenceAuthentication({
      options: {
        execute: true,
        resume: false,
        sourceEvidence: path.join(lifecycleRoot, `${SOURCE_RUN_ID}.evidence.json`),
        signedPolicy: path.join(policyRoot, `${SOURCE_RUN_ID}.policy.json`),
        producerAddress: PRODUCER.address.toLowerCase(),
        authorityProfileId: 'phase4_sod_v1',
        confirmChainId: '91342',
        confirmNetwork: 'giwa-testnet',
        confirmEvidenceDigest: `0x${'ff'.repeat(32)}`,
        confirmPolicyDigest: data.policy.digest,
        maxFeePerGasWei: '1000000',
        maxCostWei: '50000000000',
      },
      manifest: await manifest(),
      deployment: deployment(),
      provider,
      rootDir: root,
      authorityProfile: data.authorityProfile,
      signerLoader: async () => { signerLoads += 1; return PRODUCER; },
    }), { code: 'AUTH_EXECUTION_CONFIRMATION_REQUIRED' });
    assert.equal(signerLoads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
