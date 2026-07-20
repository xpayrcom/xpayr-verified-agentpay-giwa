import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { sealAuthorityProfile, validateAuthorityProfile } from '../src/authority-profile.mjs';
import { loadAndVerifyPolicyEvidence, verifyPolicyEvidence } from '../src/policy-evidence.mjs';
import { deriveJobId } from '../src/policy-engine.mjs';
import { runPolicyEvidence } from '../scripts/create-policy-evidence.mjs';
import { runLifecycle } from '../scripts/run-giwa-lifecycle.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { BLOCK_HASH, manifest as loadTestManifest } from './helpers.mjs';

const DEPLOYER = new Wallet(`0x${'31'.repeat(32)}`);
const PROVIDER = new Wallet(`0x${'32'.repeat(32)}`);
const EVALUATOR = new Wallet(`0x${'33'.repeat(32)}`);
const POLICY = new Wallet(`0x${'34'.repeat(32)}`);
const PRODUCER = new Wallet(`0x${'35'.repeat(32)}`);
const ESCROW = new Wallet(`0x${'36'.repeat(32)}`).address;
const DEPLOY_TX = `0x${'37'.repeat(32)}`;
const JOB_NONCE = `0x${'38'.repeat(32)}`;
const JOB_ID = deriveJobId(DEPLOYER.address, JOB_NONCE);
const DELIVERABLE = `0x${'39'.repeat(32)}`;
const NOW = 1_800_000_000;

function deployment() {
  return {
    networkKey: 'giwa-testnet',
    chainId: 91342,
    mainnet: false,
    status: 'deployed_testnet',
    contractAddress: ESCROW,
    deployerAddress: DEPLOYER.address,
    deploymentTransactionHash: DEPLOY_TX,
    authorities: {
      policyAuthorityAddress: DEPLOYER.address,
      evidenceProducerAddress: DEPLOYER.address,
    },
  };
}

function activeProfile({ policy = POLICY.address, producer = PRODUCER.address } = {}) {
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
      policy_authority_address: policy,
      evidence_producer_address: producer,
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
    roles: { payer: DEPLOYER.address, provider: PROVIDER.address, evaluator: EVALUATOR.address },
  });
}

async function manifest() {
  const value = structuredClone(await loadTestManifest());
  value.contracts.escrow = ESCROW;
  return validateManifest(value);
}

function policyOptions(execute = false) {
  return {
    execute,
    authorityProfileId: 'phase4_sod_v1',
    runId: 'sod-policy-run-001',
    recordId: 'sod-policy-record-001',
    intentId: 'sod-policy-intent-001',
    authority: POLICY.address.toLowerCase(),
    payer: DEPLOYER.address.toLowerCase(),
    provider: PROVIDER.address.toLowerCase(),
    evaluator: EVALUATOR.address.toLowerCase(),
    jobId: JOB_ID,
    jobNonce: JOB_NONCE,
    outcome: 'RELEASED',
    deliverableHash: DELIVERABLE,
    jobValueWei: 1_000_000_000_000n,
    maxJobValueWei: 100_000_000_000_000n,
    expirySeconds: 3_600,
  };
}

test('SoD policy runner signs with the profile authority and binds the profile digest', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'giwa-sod-policy-'));
  const selectedProfile = activeProfile();
  let signerLoads = 0;
  const canonicalProvider = {
    async getNetwork() { return { chainId: 91342n }; },
    async getCode() { return '0x6000'; },
    async getBlock() { return { number: 100, hash: BLOCK_HASH, timestamp: NOW }; },
  };
  try {
    const result = await runPolicyEvidence({
      options: policyOptions(true),
      manifest: await manifest(),
      deployment: deployment(),
      authorityProfile: selectedProfile,
      provider: canonicalProvider,
      rootDir,
      signerLoader: async ({ expectedAddress, keyName }) => {
        signerLoads += 1;
        assert.equal(expectedAddress, POLICY.address.toLowerCase());
        assert.equal(keyName, 'GIWA_POLICY_AUTHORITY_PRIVATE_KEY');
        return POLICY;
      },
      clock: () => new Date('2027-01-15T08:00:00.000Z'),
    });
    assert.equal(result.signature_verified, true);
    assert.equal(signerLoads, 1);
    const verified = await loadAndVerifyPolicyEvidence({
      filePath: result.artifact_path,
      rootDir,
      currentTimestamp: NOW + 1,
      expected: {
        authority: POLICY.address,
        authorityProfile: {
          profile_id: 'phase4_sod_v1',
          profile_digest: selectedProfile.digest,
        },
      },
    });
    assert.equal(verified.authorityProfile.profile_digest, selectedProfile.digest);
    const artifact = JSON.parse(await readFile(path.join(rootDir, result.artifact_path), 'utf8'));
    const substituted = structuredClone(artifact);
    substituted.authority_profile.profile_digest = `0x${'ff'.repeat(32)}`;
    assert.throws(() => verifyPolicyEvidence(substituted), { code: 'POLICY_INTEGRITY_INVALID' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('SoD policy runner rejects profile collisions and RPC gates before signer loading', async () => {
  let signerLoads = 0;
  const signerLoader = async () => { signerLoads += 1; return POLICY; };
  const canonicalProvider = {
    async getNetwork() { return { chainId: 91342n }; },
    async getCode() { return '0x'; },
    async getBlock() { throw new Error('must not reach timestamp'); },
  };
  await assert.rejects(runPolicyEvidence({
    options: policyOptions(true),
    manifest: await manifest(),
    deployment: deployment(),
    authorityProfile: activeProfile(),
    provider: canonicalProvider,
    signerLoader,
  }), { code: 'POLICY_ESCROW_CODE_MISSING' });
  assert.equal(signerLoads, 0);
});

test('lifecycle preflight emits the SoD policy-origin mode without loading lifecycle signers', async () => {
  const selectedProfile = activeProfile();
  const expiresAt = NOW + 3_600;
  let signerLoads = 0;
  let expectedProfileDigest = null;
  const provider = {
    async getNetwork() { return { chainId: 91342n }; },
    async getCode() { return '0x6000'; },
    async getBlock() { return { number: 1_000, hash: BLOCK_HASH, timestamp: NOW }; },
    async getFeeData() { return { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1n }; },
    async getBalance() { return 10_000_000_000_000_000n; },
  };
  const dojangClient = {
    async checkAddress(address) {
      const testManifest = await manifest();
      return {
        address: address.toLowerCase(),
        verified: true,
        source: 'giwa_dojang_read_only',
        accepted_attester_id: testManifest.dojang.attester_allowlist[0].id,
        chain_id: 91342,
        block_number: 100,
        block_hash: BLOCK_HASH,
      };
    },
  };
  const result = await runLifecycle({
    options: {
      execute: false,
      resume: false,
      authorityProfileId: 'phase4_sod_v1',
      confirmChainId: 91342,
      confirmNetwork: 'giwa-testnet',
      confirmTestnetOnly: 'GIWA_SEPOLIA_TEST_ETH_ONLY',
      runId: 'sod-lifecycle-run-001',
      outcome: 'release',
      payer: DEPLOYER.address,
      provider: PROVIDER.address,
      evaluator: EVALUATOR.address,
      jobNonce: JOB_NONCE,
      jobId: JOB_ID,
      policyDecisionHash: null,
      policyEvidencePath: 'evidence/policy/sod-policy-run-001.policy.json',
      deliverableHash: DELIVERABLE,
      jobValueWei: 1_000_000_000_000n,
      maxJobValueWei: 100_000_000_000_000n,
      maxTotalCostWei: 1_000_000_000_000_000n,
      maxFeePerGasWei: 1_000_000_000n,
      maxGasPerTransaction: 100_000n,
      expirySeconds: 3_600,
      confirmations: 1,
    },
    manifest: await manifest(),
    deployment: deployment(),
    authorityProfile: selectedProfile,
    provider,
    dojangClient,
    signerLoader: async () => { signerLoads += 1; throw new Error('must not load'); },
    verifyDeployment: async () => ({ ok: true }),
    verifyD1Reference: async () => ({ ok: true }),
    verifyPolicyReference: async ({ expected }) => {
      expectedProfileDigest = expected.authorityProfile.profile_digest;
      return {
        decision: 'ALLOW',
        policyDecisionHash: `0x${'41'.repeat(32)}`,
        authority: POLICY.address.toLowerCase(),
        producerAddress: POLICY.address.toLowerCase(),
        repositoryRelativePath: 'evidence/policy/sod-policy-run-001.policy.json',
        artifactDigest: `0x${'42'.repeat(32)}`,
        artifactSha256: `0x${'43'.repeat(32)}`,
        typedDataDigest: `0x${'44'.repeat(32)}`,
        bindingDigest: `0x${'45'.repeat(32)}`,
        recordId: 'sod-policy-record-001',
        intentId: 'sod-policy-intent-001',
        validity: { validFrom: NOW, validUntil: expiresAt },
        job: { expiresAt },
      };
    },
  });
  assert.equal(result.mode, 'read-only-preflight');
  assert.equal(result.policy_origin.mode, 'eip712_phase4_sod_policy_artifact');
  assert.equal(result.policy_origin.separation_of_duties, true);
  assert.equal(result.policy_origin.evidence_producer_address, PRODUCER.address.toLowerCase());
  assert.equal(expectedProfileDigest, selectedProfile.digest);
  assert.equal(signerLoads, 0);
});
