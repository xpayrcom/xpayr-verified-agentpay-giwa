import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import {
  authorityProfileReference,
  sealAuthorityProfile,
  validateAuthorityProfile,
} from '../src/authority-profile.mjs';
import { generateSodAuthorityKeys, writeSecretFile } from '../scripts/generate-sod-authority-keys.mjs';

const DEPLOYER = new Wallet(`0x${'11'.repeat(32)}`).address;
const PROVIDER = new Wallet(`0x${'12'.repeat(32)}`).address;
const EVALUATOR = new Wallet(`0x${'13'.repeat(32)}`).address;
const POLICY = new Wallet(`0x${'14'.repeat(32)}`).address;
const PRODUCER = new Wallet(`0x${'15'.repeat(32)}`).address;
const ESCROW = new Wallet(`0x${'16'.repeat(32)}`).address;
const DEPLOY_TX = `0x${'17'.repeat(32)}`;

function deployment() {
  return {
    networkKey: 'giwa-testnet',
    chainId: 91342,
    mainnet: false,
    contractAddress: ESCROW,
    deployerAddress: DEPLOYER,
    deploymentTransactionHash: DEPLOY_TX,
  };
}

async function writeKeygenConfig(moduleRoot, pendingProfile) {
  const profileRoot = path.join(moduleRoot, 'config', 'authority-profiles');
  await mkdir(profileRoot, { recursive: true });
  await writeFile(path.join(profileRoot, 'phase4_sod_v1.json'), JSON.stringify(pendingProfile));
  await writeFile(path.join(moduleRoot, 'config', 'deployment.json'), JSON.stringify(deployment()));
}

function profile({ status = 'active', policy = POLICY, producer = PRODUCER } = {}) {
  return sealAuthorityProfile({
    schema: 'xpayr.giwa.agentpay.authority-profile.v1',
    profile_id: 'phase4_sod_v1',
    status,
    network_key: 'giwa-testnet',
    chain_id: 91342,
    mainnet: false,
    deployment: {
      contract_address: ESCROW,
      deployer_address: DEPLOYER,
      deployment_transaction_hash: DEPLOY_TX,
    },
    authorities: {
      policy_authority_address: status === 'active' ? policy : null,
      evidence_producer_address: status === 'active' ? producer : null,
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
  });
}

test('sealed authority profile binds its canonical digest and permits historical deployer=payer', () => {
  const sealed = profile();
  const validated = validateAuthorityProfile(sealed, {
    deployment: deployment(),
    requireActive: true,
    roles: { payer: DEPLOYER, provider: PROVIDER, evaluator: EVALUATOR },
  });
  const reference = authorityProfileReference(validated);
  assert.equal(reference.profile_digest, sealed.integrity.digest);
  assert.equal(reference.profile_id, 'phase4_sod_v1');
  const tampered = structuredClone(sealed);
  tampered.authorities.policy_authority_address = new Wallet(`0x${'18'.repeat(32)}`).address;
  assert.throws(() => validateAuthorityProfile(tampered), { code: 'AUTHORITY_PROFILE_DIGEST_INVALID' });
});

test('profile rejects authority substitution and every privileged/operational collision', () => {
  const roleSet = { payer: DEPLOYER, provider: PROVIDER, evaluator: EVALUATOR };
  for (const collision of [DEPLOYER, PROVIDER, EVALUATOR]) {
    assert.throws(() => validateAuthorityProfile(profile({ policy: collision }), {
      deployment: deployment(), requireActive: true, roles: roleSet,
    }), { code: 'AUTHORITY_PROFILE_ROLE_COLLISION' });
    assert.throws(() => validateAuthorityProfile(profile({ producer: collision }), {
      deployment: deployment(), requireActive: true, roles: roleSet,
    }), { code: 'AUTHORITY_PROFILE_ROLE_COLLISION' });
  }
  assert.throws(() => validateAuthorityProfile(profile({ producer: POLICY }), {
    deployment: deployment(), requireActive: true, roles: roleSet,
  }), { code: 'AUTHORITY_PROFILE_ROLE_COLLISION' });
});

test('checked-in Phase-4 profile is sealed and active after public-address activation', async () => {
  const checkedIn = JSON.parse(await readFile(
    new URL('../config/authority-profiles/phase4_sod_v1.json', import.meta.url),
    'utf8',
  ));
  const validated = validateAuthorityProfile(checkedIn, { requireActive: true });
  assert.equal(validated.status, 'active');
  assert.match(validated.policyAuthorityAddress, /^0x[0-9a-f]{40}$/);
  assert.match(validated.evidenceProducerAddress, /^0x[0-9a-f]{40}$/);
  assert.notEqual(validated.policyAuthorityAddress, validated.evidenceProducerAddress);
  assert.notEqual(validated.policyAuthorityAddress, checkedIn.deployment.deployer_address.toLowerCase());
  assert.notEqual(validated.evidenceProducerAddress, checkedIn.deployment.deployer_address.toLowerCase());
});

test('key generator creates two repo-external exact-0600 one-key files and returns no secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'giwa-sod-keygen-'));
  const repositoryRoot = path.join(root, 'repo');
  const moduleRoot = path.join(repositoryRoot, 'giwa-agentpay');
  const secretRoot = path.join(root, 'secrets');
  const policyPath = path.join(secretRoot, 'policy.env');
  const producerPath = path.join(secretRoot, 'producer.env');
  await mkdir(secretRoot);
  const pending = profile({ status: 'pending_addresses' });
  await writeKeygenConfig(moduleRoot, pending);
  const wallets = {
    policy: new Wallet(`0x${'21'.repeat(32)}`),
    evidence: new Wallet(`0x${'22'.repeat(32)}`),
  };
  try {
    const report = await generateSodAuthorityKeys({
      policyEnvPath: policyPath,
      evidenceEnvPath: producerPath,
      moduleRoot,
      repositoryRoot,
      walletFactory: (role) => wallets[role],
    });
    assert.equal((await stat(policyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(producerPath)).mode & 0o777, 0o600);
    const policySource = await readFile(policyPath, 'utf8');
    const producerSource = await readFile(producerPath, 'utf8');
    const assignmentSuffix = '=0x[0-9a-f]{64}\\n$';
    assert.match(policySource, new RegExp(`^GIWA_POLICY_AUTHORITY_PRIVATE_KEY${assignmentSuffix}`, 'i'));
    assert.match(producerSource, new RegExp(`^GIWA_EVIDENCE_PRODUCER_PRIVATE_KEY${assignmentSuffix}`, 'i'));
    const publicReport = JSON.stringify(report);
    assert.equal(publicReport.includes(wallets.policy.privateKey), false);
    assert.equal(publicReport.includes(wallets.evidence.privateKey), false);
    assert.equal(validateAuthorityProfile(report.profile_patch, { requireActive: true }).status, 'active');
    await assert.rejects(generateSodAuthorityKeys({
      policyEnvPath: policyPath,
      evidenceEnvPath: producerPath,
      moduleRoot,
      repositoryRoot,
    }), { code: 'SOD_KEYGEN_OUTPUT_EXISTS' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('key generator refuses symlink outputs before any file creation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'giwa-sod-keygen-link-'));
  const repositoryRoot = path.join(root, 'repo');
  const moduleRoot = path.join(repositoryRoot, 'giwa-agentpay');
  const secretRoot = path.join(root, 'secrets');
  await mkdir(secretRoot);
  await writeKeygenConfig(moduleRoot, profile({ status: 'pending_addresses' }));
  const target = path.join(secretRoot, 'target');
  const link = path.join(secretRoot, 'policy.env');
  const producerPath = path.join(secretRoot, 'producer.env');
  await writeFile(target, 'do-not-touch');
  await symlink(target, link);
  try {
    await assert.rejects(generateSodAuthorityKeys({
      policyEnvPath: link,
      evidenceEnvPath: producerPath,
      moduleRoot,
      repositoryRoot,
    }), { code: 'SOD_KEYGEN_OUTPUT_EXISTS' });
    await assert.rejects(stat(producerPath), { code: 'ENOENT' });
    assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('secret writer removes its own partial file when a post-open sync gate fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'giwa-sod-keygen-partial-'));
  const filePath = path.join(root, 'partial.env');
  try {
    await assert.rejects(writeSecretFile(
      filePath,
      'GIWA_POLICY_AUTHORITY_PRIVATE_KEY',
      `0x${'23'.repeat(32)}`,
      {
        openFile: async (...args) => {
          const handle = await open(...args);
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => { throw new Error('injected sync failure'); },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          };
        },
      },
    ), /injected sync failure/);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
