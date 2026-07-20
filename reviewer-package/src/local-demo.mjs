import { buildIntentEvidence, sealEvidence, verifyEvidence } from './evidence.mjs';
import { loadManifest } from './manifest.mjs';
import {
  createDemoFixtureDojangClient,
  XpayrGiwaAgentPayService,
} from './xpayr-agentpay-adapter.mjs';

const DEMO_TIMESTAMP = '2026-07-19T12:00:00.000Z';

export async function createLocalDemo({ manifest = null } = {}) {
  const network = manifest ?? await loadManifest();
  const service = new XpayrGiwaAgentPayService({
    manifest: network,
    dojangClient: createDemoFixtureDojangClient({ now: () => DEMO_TIMESTAMP }),
    clock: () => new Date(DEMO_TIMESTAMP),
    idFactory: () => 'giwa-local-demo-intent-001',
  });
  const created = await service.createIntent({
    title: 'Local catalog localization demo',
    networkKey: 'giwa-testnet',
    payerAddress: '0x1111111111111111111111111111111111111111',
    providerAddress: '0x2222222222222222222222222222222222222222',
    evaluatorAddress: '0x3333333333333333333333333333333333333333',
    amountEth: '0.05',
    requireApproval: true,
    requireVerification: true,
  });
  const approved = service.approveIntent(created.id, {
    approver: '0x3333333333333333333333333333333333333333',
  });
  const prepared = service.prepareExecution(approved.id);
  const record = service.store.get(prepared.id);
  const evidence = sealEvidence(buildIntentEvidence({
    manifest: network,
    record,
    createdAt: DEMO_TIMESTAMP,
    sourceSnapshotDate: '2026-07-19',
  }));
  const verification = verifyEvidence(evidence);

  return {
    service,
    record,
    evidence,
    verification,
    summary: {
      intent_id: record.id,
      decision: record.policy.decision,
      manual_approval_actor_role: record.approval.actor_role,
      state: record.state,
      identity_source: 'demo_fixture',
      evidence_status: evidence.evidence_status,
      evidence_integrity_valid: verification.valid,
      escrow_deployed: false,
      chain_transaction_sent: false,
    },
  };
}
