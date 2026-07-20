import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder } from 'ethers';
import { canonicalJson, sha256Hex } from '../src/canonical-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'evidence', 'giwa-sepolia-reviewer-index-20260720.json');

async function readArtifact(relativePath) {
  const bytes = await readFile(path.join(ROOT, relativePath));
  return {
    bytes,
    value: JSON.parse(bytes.toString('utf8')),
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function verifyEnvelopeIntegrity(value) {
  const { integrity, ...payload } = value;
  assert.equal(integrity?.algorithm, 'sha256');
  assert.equal(integrity?.canonicalization, 'xpayr-canonical-json-v1');
  assert.equal(integrity?.digest, sha256Hex(canonicalJson(payload)));
  return integrity.digest;
}

test('sealed GIWA Sepolia reviewer index exactly reconciles source, historical proof and Phase-4 SoD artifacts', async () => {
  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  const { integrity, ...indexPayload } = index;
  assert.equal(index.schema, 'xpayr.giwa.agentpay.reviewer-index.v1');
  assert.equal(index.chain_id, 91342);
  assert.equal(integrity.scope, 'entire_document_except_integrity');
  assert.equal(integrity.digest, sha256Hex(canonicalJson(indexPayload)));

  const deployment = await readArtifact(index.contract.deployment_artifact);
  const source = await readArtifact(index.contract.source_verification.artifact);
  const sourceLevel = await readArtifact(index.contract.source_verification.level_recheck_artifact);
  assert.equal(deployment.value.contractAddress.toLowerCase(), index.contract.address.toLowerCase());
  assert.equal(source.value.submissionResult, 'Pass - Verified');
  assert.equal(source.value.sourceMatchesLocal, true);
  assert.equal(source.value.localSourceSha256, index.contract.source_verification.local_and_explorer_source_sha256);
  assert.equal(source.value.explorerSourceSha256, index.contract.source_verification.local_and_explorer_source_sha256);
  assert.equal(sourceLevel.fileSha256, index.contract.source_verification.level_recheck_artifact_file_sha256);
  verifyEnvelopeIntegrity(sourceLevel.value);
  assert.equal(sourceLevel.value.schema, 'xpayr.giwa.agentpay.source-verification-level-recheck.v1');
  assert.equal(sourceLevel.value.networkKey, index.network_key);
  assert.equal(sourceLevel.value.chainId, index.chain_id);
  assert.equal(sourceLevel.value.contractAddress.toLowerCase(), index.contract.address.toLowerCase());
  assert.equal(sourceLevel.value.deploymentTransactionHash, index.contract.deployment_transaction_hash);
  assert.equal(sourceLevel.value.priorVerification.artifact, index.contract.source_verification.artifact);
  assert.equal(sourceLevel.value.priorVerification.submissionGuid,
    index.contract.source_verification.submission_guid);
  assert.equal(sourceLevel.value.blockscoutLive.addressIsVerified, true);
  assert.equal(sourceLevel.value.blockscoutLive.isChangedBytecode, false);
  assert.equal(sourceLevel.value.localAndOnchainParity.sourceSha256,
    index.contract.source_verification.local_and_explorer_source_sha256);
  assert.equal(sourceLevel.value.localAndOnchainParity.explorerSourceMatchesLocal, true);
  assert.equal(sourceLevel.value.localAndOnchainParity.immutableAwareRuntimeVerified, true);
  assert.equal(sourceLevel.value.classification.explorerLevel,
    index.contract.source_verification.verification_level);
  assert.equal(sourceLevel.value.blockscoutLive.smartContractIsPartiallyVerified,
    index.contract.source_verification.is_partially_verified);
  assert.equal(sourceLevel.value.blockscoutLive.smartContractIsFullyVerified,
    index.contract.source_verification.is_fully_verified);
  assert.equal(sourceLevel.value.localAndOnchainParity.creationInputMatchesByteForByte,
    index.contract.source_verification.exact_creation_input_match);
  assert.equal(sourceLevel.value.localAndOnchainParity.localCreationInputSha256,
    index.contract.source_verification.exact_creation_input_sha256);
  assert.equal(sourceLevel.value.localAndOnchainParity.onchainCreationInputSha256,
    index.contract.source_verification.exact_creation_input_sha256);
  assert.equal(sourceLevel.value.localAndOnchainParity.compilerSettings.metadataBytecodeHash, 'none');
  assert.equal(sourceLevel.value.localAndOnchainParity.compilerSettings.appendCbor, false);
  assert.equal(sourceLevel.value.localAndOnchainParity.cborAuxdataPresent, false);
  assert.equal(sourceLevel.value.standardJsonUpgradeAttempt.blindRetryPerformed, false);
  assert.equal(sourceLevel.value.standardJsonUpgradeAttempt.submitted, true);
  assert.equal(sourceLevel.value.standardJsonUpgradeAttempt.httpStatus, 200);
  assert.equal(sourceLevel.value.standardJsonUpgradeAttempt.fullLevelObservedAfterProcessingWindow, false);
  assert.equal(sourceLevel.value.classification.sourceVerificationGapClosed, true);
  assert.equal(sourceLevel.value.classification.fullExplorerLevelAchievableForCurrentDeployment, false);
  assert.equal(sourceLevel.value.classification.fullExplorerLevelWouldRequireNewDeployment, true);
  assert.equal(sourceLevel.value.classification.newDeploymentPerformed, false);

  const solcArtifact = await readArtifact('artifacts/solc/XPayrVerifiedAgentEscrow.json');
  const sourceBytes = await readFile(path.join(ROOT, solcArtifact.value.sourceName));
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  assert.equal(solcArtifact.value.sourceSha256, index.contract.source_verification.local_and_explorer_source_sha256);
  assert.equal(sourceSha256, index.contract.source_verification.local_and_explorer_source_sha256);
  assert.equal(solcArtifact.value.metadata.settings.metadata.bytecodeHash, 'none');
  assert.equal(solcArtifact.value.metadata.settings.metadata.appendCBOR, false);
  const constructorArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'bytes32'],
    [
      deployment.value.immutableBindings.dojangScroll,
      deployment.value.immutableBindings.upbitKoreaAttesterId,
      deployment.value.immutableBindings.testnetFaucetAttesterId,
    ],
  );
  const localCreationInput = `${solcArtifact.value.bytecode}${constructorArgs.slice(2)}`;
  const localCreationBytes = Buffer.from(localCreationInput.slice(2), 'hex');
  assert.equal(localCreationBytes.length, sourceLevel.value.localAndOnchainParity.creationInputBytes);
  assert.equal(createHash('sha256').update(localCreationBytes).digest('hex'),
    index.contract.source_verification.exact_creation_input_sha256);
  assert.equal((solcArtifact.value.deployedBytecode.length - 2) / 2,
    sourceLevel.value.localAndOnchainParity.runtimeBytes);

  const deploymentConfig = await readArtifact('config/deployment.json');
  assert.equal(deploymentConfig.value.evidence.sourceVerificationLevel,
    index.contract.source_verification.verification_level);
  assert.equal(deploymentConfig.value.evidence.sourceVerificationLevelRecheckArtifact,
    index.contract.source_verification.level_recheck_artifact);
  assert.equal(deploymentConfig.value.evidence.sourceVerificationLevelRecheckFileSha256,
    index.contract.source_verification.level_recheck_artifact_file_sha256);
  assert.equal(deploymentConfig.value.evidence.creationInputByteForByteVerified, true);

  for (const historical of index.historical_original_d3) {
    const lifecycle = await readArtifact(historical.evidence_path);
    assert.equal(verifyEnvelopeIntegrity(lifecycle.value), historical.evidence_digest);
    assert.equal(lifecycle.value.policy_origin?.authentication ?? lifecycle.value.boundaries.policy_origin_authentication,
      historical.policy_origin_authentication);
    assert.equal(lifecycle.value.boundaries.producer_authentication, historical.producer_authentication);
  }

  for (const record of index.signed_policy_authenticated_d3) {
    const [lifecycle, policy, sidecar] = await Promise.all([
      readArtifact(record.lifecycle_evidence_path),
      readArtifact(record.policy_path),
      readArtifact(record.auth_sidecar_path),
    ]);
    assert.equal(verifyEnvelopeIntegrity(lifecycle.value), record.lifecycle_evidence_digest);
    assert.equal(lifecycle.fileSha256, record.lifecycle_file_sha256);
    assert.equal(policy.value.integrity.digest, record.policy_digest);
    assert.equal(policy.value.decision_hash, record.policy_decision_hash);
    assert.equal(policy.value.authentication.eip712.typed_data_digest, record.policy_typed_data_digest);
    assert.equal(lifecycle.value.policy_origin.mode, 'eip712_signed_policy_artifact');
    assert.equal(lifecycle.value.policy_origin.artifact_path, record.policy_path);
    assert.equal(lifecycle.value.policy_origin.artifact_digest, record.policy_digest);
    assert.equal(verifyEnvelopeIntegrity(sidecar.value), record.auth_sidecar_digest);
    assert.equal(sidecar.fileSha256, record.auth_sidecar_file_sha256);
    assert.equal(sidecar.value.producer.typed_data_digest, record.producer_typed_data_digest);
    assert.equal(sidecar.value.anchor.transaction_hash, record.anchor_transaction_hash);
    assert.equal(sidecar.value.anchor.block_number, record.anchor_block_number);
    assert.equal(sidecar.value.anchor.block_hash, record.anchor_block_hash);
    assert.equal(sidecar.value.producer.signature_verified, record.producer_signature_verified);
    assert.equal(sidecar.value.checks.anchor_transaction_canonical, record.anchor_canonical_verified);
    assert.equal(sidecar.value.overall_authenticated, true);
  }

  const phase4 = index.phase4_separation_of_duties;
  const [authorityProfile, funding] = await Promise.all([
    readArtifact(phase4.authority_profile_path),
    readArtifact(phase4.authority_funding.artifact_path),
  ]);
  const { integrity: profileIntegrity, ...profilePayload } = authorityProfile.value;
  assert.equal(profileIntegrity.digest, sha256Hex(canonicalJson(profilePayload)));
  assert.equal(profileIntegrity.digest, phase4.authority_profile_digest);
  assert.equal(authorityProfile.value.profile_id, 'phase4_sod_v1');
  assert.equal(authorityProfile.value.constraints.separation_of_duties, true);
  assert.equal(authorityProfile.value.authorities.policy_authority_address.toLowerCase(),
    phase4.policy_authority.toLowerCase());
  assert.equal(authorityProfile.value.authorities.evidence_producer_address.toLowerCase(),
    phase4.evidence_producer.toLowerCase());

  assert.equal(verifyEnvelopeIntegrity(funding.value), phase4.authority_funding.artifact_digest);
  assert.equal(funding.value.transaction.hash, phase4.authority_funding.transaction_hash);
  assert.equal(funding.value.transaction.from.toLowerCase(), index.identity.payer_deployer.toLowerCase());
  assert.equal(funding.value.transaction.to.toLowerCase(), phase4.evidence_producer.toLowerCase());
  assert.equal(funding.value.transaction.value_wei, phase4.authority_funding.value_wei);
  assert.equal(funding.value.canonical_receipt.block_number, phase4.authority_funding.block_number);
  assert.equal(funding.value.canonical_receipt.block_hash, phase4.authority_funding.block_hash);
  assert.equal(funding.value.checks.transaction_block_membership_exact, true);
  assert.equal(funding.value.checks.receipt_block_hash_canonical, true);
  assert.equal(funding.value.boundaries.faucet_dependency, false);
  assert.equal(
    BigInt(funding.value.recipient_state.balance_after_wei)
      - BigInt(funding.value.recipient_state.balance_before_wei),
    BigInt(funding.value.transaction.value_wei),
  );

  for (const record of phase4.authenticated_lifecycles) {
    const [lifecycle, policy, sidecar] = await Promise.all([
      readArtifact(record.lifecycle_evidence_path),
      readArtifact(record.policy_path),
      readArtifact(record.auth_sidecar_path),
    ]);
    assert.equal(verifyEnvelopeIntegrity(lifecycle.value), record.lifecycle_evidence_digest);
    assert.equal(lifecycle.fileSha256, record.lifecycle_file_sha256);
    assert.equal(lifecycle.value.run_id, record.run_id);
    assert.equal(lifecycle.value.outcome, record.outcome);
    assert.equal(lifecycle.value.payment_completed, record.payment_completed);
    assert.equal(lifecycle.value.job.job_id, record.job_id);
    assert.equal(lifecycle.value.steps.length, record.step_count);
    assert.equal(lifecycle.value.canonical_terminal.transaction_hash, record.terminal_transaction_hash);
    assert.equal(lifecycle.value.canonical_terminal.canonical_terminal_verified, true);
    assert.equal(lifecycle.value.policy_origin.mode, 'eip712_phase4_sod_policy_artifact');
    assert.equal(lifecycle.value.policy_origin.artifact_path, record.policy_path);
    assert.equal(lifecycle.value.policy_origin.artifact_digest, record.policy_digest);
    assert.equal(lifecycle.value.policy_origin.authority_profile_id, authorityProfile.value.profile_id);
    assert.equal(lifecycle.value.policy_origin.authority_profile_digest, phase4.authority_profile_digest);
    assert.equal(lifecycle.value.policy_origin.authority_address.toLowerCase(), phase4.policy_authority.toLowerCase());
    assert.equal(lifecycle.value.policy_origin.evidence_producer_address.toLowerCase(), phase4.evidence_producer.toLowerCase());
    assert.equal(lifecycle.value.policy_origin.separation_of_duties, true);

    assert.equal(policy.fileSha256, record.policy_file_sha256);
    assert.equal(policy.value.integrity.digest, record.policy_digest);
    assert.equal(policy.value.decision_hash, record.policy_decision_hash);
    assert.equal(policy.value.authentication.eip712.typed_data_digest, record.policy_typed_data_digest);
    assert.equal(policy.value.authentication.eip712.producer_address.toLowerCase(), phase4.policy_authority.toLowerCase());
    assert.equal(policy.value.authority_profile.profile_digest, phase4.authority_profile_digest);

    assert.equal(verifyEnvelopeIntegrity(sidecar.value), record.auth_sidecar_digest);
    assert.equal(sidecar.fileSha256, record.auth_sidecar_file_sha256);
    assert.equal(sidecar.value.schema, 'xpayr.giwa.agentpay.lifecycle-evidence-authentication.v2');
    assert.equal(sidecar.value.source.path, record.lifecycle_evidence_path);
    assert.equal(sidecar.value.source.evidence_digest, record.lifecycle_evidence_digest);
    assert.equal(sidecar.value.source.terminal_transaction_hash, record.terminal_transaction_hash);
    assert.equal(sidecar.value.policy.path, record.policy_path);
    assert.equal(sidecar.value.policy.artifact_digest, record.policy_digest);
    assert.equal(sidecar.value.policy.authority_address.toLowerCase(), phase4.policy_authority.toLowerCase());
    assert.equal(sidecar.value.producer.address.toLowerCase(), phase4.evidence_producer.toLowerCase());
    assert.equal(sidecar.value.producer.typed_data_digest, record.producer_typed_data_digest);
    assert.equal(sidecar.value.authority_profile.profile_digest, phase4.authority_profile_digest);
    assert.equal(sidecar.value.authority_profile.separation_of_duties, true);
    assert.equal(sidecar.value.anchor.transaction_hash, record.anchor_transaction_hash);
    assert.equal(sidecar.value.anchor.block_number, record.anchor_block_number);
    assert.equal(sidecar.value.anchor.block_hash, record.anchor_block_hash);
    assert.equal(sidecar.value.producer.signature_verified, record.producer_signature_verified);
    assert.equal(sidecar.value.checks.anchor_transaction_canonical, record.anchor_canonical_verified);
    assert.equal(sidecar.value.checks.policy_authority_distinct, true);
    assert.equal(sidecar.value.checks.evidence_producer_distinct, true);
    assert.equal(sidecar.value.overall_authenticated, true);
  }

  assert.equal(index.authority_model.deployer_payer.toLowerCase(), index.identity.payer_deployer.toLowerCase());
  assert.equal(index.authority_model.policy_authority.toLowerCase(), phase4.policy_authority.toLowerCase());
  assert.equal(index.authority_model.evidence_producer.toLowerCase(), phase4.evidence_producer.toLowerCase());
  assert.equal(index.authority_model.historical_auth_v1_same_testnet_eoa, true);
  assert.equal(index.authority_model.same_testnet_eoa, false);
  assert.equal(index.authority_model.separation_of_duties, true);
  assert.equal(index.boundaries.organization_identity_claimed, false);
  assert.equal(index.boundaries.legal_non_repudiation_claimed, false);
  assert.equal(index.boundaries.public_repository_or_demo_published, false);
  assert.equal(index.boundaries.gasok_submission_completed, false);
  assert.equal(index.boundaries.arc_artifacts_accepted_as_giwa_evidence, false);
});
