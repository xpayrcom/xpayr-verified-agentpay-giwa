# Demo Script — XPAYR Verified AgentPay for GIWA

Target length: **2 minutes 45 seconds**
Format: captioned silent screen capture; no audio stream
Status: historical local fixture artifact reconciled and not published; Phase 4 chain evidence complete, but no separate real-wallet evidence-mode video has been recorded
Artifact: `artifacts/demo/xpayr-giwa-agentpay-local-fixture.mp4`
Validation: SHA-256 `3d80fda5ee8064abd499b1a5d8fa27739f8217aa33d84b7bfa3a298531a6f1e5`; H.264 video-only with exactly one video stream and no audio; `1280x720`; `25` fps; `125.960` seconds; `2,069,692` bytes; clean decode; three sampled frames visually checked

Current recorded video mode: **Local fixture mode only.** That pre-deployment fixture snapshot uses `deployment.status == not_deployed`; it contains no signer, broadcast transaction, fund/faucet action, or positive live Dojang proof. The checked-in deployment state is separately `deployed_testnet`, with retained D1/D2/D3/auth-v1 and completed Phase 4 SoD lifecycle/auth-v2 chain evidence; the existing fixture video demonstrates none of those live transactions. The live-mode browser rehearsal still uses a deterministic EIP-1193 stub, decodes a bounded transaction preview, cancels, and asserts `sendCount=0`; it is not a real wallet session, broadcast transaction, receipt, or recorded demo. Any future live-wallet evidence-mode recording must remain separate and cite only the independently verified canonical artifacts below.

## Evidence mode rule

Before recording, keep each continuous product-flow sequence in exactly one visible mode. A single submission video may hard-cut to a separately titled retained-evidence section, but it must never imply that the fixture created the retained chain transactions:

- **Local fixture mode:** the UI demonstrates policy, an address-labeled approval state, and evidence formatting with mocked identity. The reconciled Foundry `36/36` result may be shown separately as local EVM proof. Keep “local fixture” visible on screen and in captions. Chain-action controls remain gated when no escrow deployment is recorded. The current UI can also render a separately loaded retained-proof panel with explorer links; if that panel appears, introduce it only after a hard visual transition labeled `Retained GIWA Sepolia evidence — not produced by this fixture`. Never call a retained link a transaction created by the fixture.
- **GIWA Sepolia evidence mode:** use only after a real contract address, authenticated wallet actions, independently re-fetched transaction/receipt/receipt-block/head data, recognized terminal calldata, outcome-specific events, matching `RELEASED`/`REFUNDED` on-chain state, and positive live Dojang query evidence have been verified. Keep “testnet” and “native test ETH” visible.

The Phase 4 stub rehearsal is a third, test-only browser state and must not be presented as either evidence mode. Live server policy permits transaction preparation only for direct `ALLOW`; local `HOLD` approve/reject is fixture-only and rejected in live mode. Preview is not consent or execution: show target, decoded function, roles, value, gas and maximum cost, then require a separate wallet send action.

Never mix the two modes into one apparent live proof chain. For the recommended no-new-transaction submission recording, use a visibly labeled local-fixture UX segment followed by a hard-cut, read-only retained-evidence walkthrough.

## Pre-record checklist

- [ ] No private key, mnemonic, token, cookie, local path containing sensitive data, or terminal history is visible.
- [ ] The UI says `LOCAL MVP`, `GIWA Sepolia target`, and `native test ETH`.
- [ ] No stablecoin, KYC/AML, Mainnet, audit, partnership, grant, or production claim appears.
- [ ] If using GIWA Sepolia evidence mode, chain ID is `91342` and explorer links are opened once before recording.
- [ ] If the fixture UI shows retained explorer links, a hard visual transition and `not produced by this fixture` caption separate them from the fixture flow.
- [ ] Evidence JSON has passed the secret/PII scan.
- [x] Final UI/browser results have been reconciled; the tested `HOLD -> READY` flow remains labeled as local intent with no chain job, repeat approval is disabled, and all chain controls remain disabled.
- [x] Separate Phase 4 live-mode stub run reached a decoded preview and cancelled with `sendCount=0`; it is labeled as test harness evidence, not a real wallet/transaction/video result.
- [x] Instrumented desktop `1440x1100` and mobile `390x844` runs have horizontal overflow `0`, console/page errors `0`, request failures `0`, and HTTP responses `>=400` `0`.
- [ ] Keyboard-only navigation has not been separately measured and must not be claimed.
- [x] The stable video path/hash and media metadata have been reconciled.
- [x] Recording length is `125.960` seconds, within the 2–3 minute target.

## Timeline and captions

### 0:00–0:15 — Title and boundary

**Screen:** Product title, network badge, evidence-mode badge, and state rail.

**On-screen caption:**

> This is XPAYR Verified AgentPay for GIWA: a local MVP targeting GIWA Sepolia. It uses native test ETH only and does not handle Mainnet or real customer funds.

### 0:15–0:35 — Problem

**Screen:** Four trust questions: verified counterparty, spending authority, delivery, approval.

**On-screen caption:**

> An AI agent can request a payment, but merchants still need to know who is receiving it, whether the agent is allowed to spend, whether delivery was committed, and who approved release. Today those facts are usually separated.

### 0:35–0:55 — Create job and identity check

**Screen:** Payer, provider, optional evaluator; Dojang status with source/mode label.

**Action:** Enter or select the three demo addresses. Run verification.

**On-screen caption:**

> The merchant creates a job, and every configured participant address must pass the mandatory Dojang aggregate isVerified check through one of two fixed attesters at a retained block hash. This is an address signal—not proof of wallet control, KYC, credit scoring, or delivery. The MVP does not separately claim EAS expiry or revocation metadata.

If fixture mode is active, add:

> For this local run, the identity response is a labeled fixture and is not presented as live Dojang evidence.

### 0:55–1:18 — Agent intent and policy

**Screen:** Intent amount, purpose, deadline, decision, policy reasons, trusted job nonce, and payer-derived job ID.

**Action in local fixture mode:** Submit an intent configured to return `HOLD`, then click the visibly labeled local approval-state action.

**Action in a future GIWA Sepolia evidence-mode recording:** Submit an intent that receives direct `ALLOW`; show the decoded transaction preview and explicitly send or cancel from the connected role-correct wallet. Never use the fixture `HOLD` approval action to unlock a live request.

**On-screen caption:**

> The agent submits a normalized intent. XPAYR—not the caller—derives a trusted nonce and a payer-bound job ID, then returns exactly one decision: allow, hold, or deny, binding the exact expected amount and expiry. The contract re-derives that job ID from the payer and nonce to prevent preemption. In this local fixture, a held request and entered address demonstrate approval state only; they do not authenticate a wallet or authorize a real transaction. Live mode requires direct allow, a decoded bounded preview, and a separate wallet confirmation.

### 1:18–1:42 — Fund and pending-versus-confirmed

**Screen:** Escrow lifecycle panel, amount labeled native test ETH, and two distinct status indicators: observed/pending and receipt confirmed.

**Action in local fixture mode:** Show the deployment gate as closed and briefly show the passing Foundry lifecycle result. Do not click a chain action or animate a fake receipt.

**Action in GIWA Sepolia evidence mode:** With a recorded deployment and connected participant wallet, fund the prepared job. Pause briefly on pending, then show receipt-confirmed.

**On-screen caption:**

> The payer funds a job-specific, non-custodial escrow with exactly the policy-bound amount. Flashblocks can make a transaction feel immediate, but XPAYR records that only as observed. A terminal outcome independently re-fetches the canonical receipt, transaction, receipt block, and head, then matches the terminal call, outcome-specific events, and on-chain job state. Release can complete payment; refund is terminal recovery but never payment completion.

In local fixture mode, add:

> No contract is deployed in this run. The lifecycle is proven separately by local Foundry tests, so the wallet controls correctly remain gated.

### 1:42–2:02 — Deliverable commitment

**Screen:** Deliverable digest and state transition `FUNDED -> SUBMITTED`.

**Action in local fixture mode:** Show the digest/state assertions in the local contract test result; do not imply an on-chain submission.

**Action in GIWA Sepolia evidence mode:** Submit the prepared digest with the connected provider wallet; do not expose the raw confidential deliverable.

**On-screen caption:**

> The provider commits a hash of the off-chain deliverable. The hash proves commitment to specific bytes; it does not prove quality. That remains a human review decision.

### 2:02–2:23 — Approve and release

**Screen:** Evaluator review, approval, release, and `RELEASED` terminal state.

**Action in local fixture mode:** Show the tested transition and keep live wallet actions disabled.

**Action in GIWA Sepolia evidence mode:** Approve, then release with the authorized connected wallets. Show the successful receipt/event panel.

**On-screen caption:**

> An authenticated human merchant or evaluator approves the submission and releases the escrow. The AI cannot unilaterally pay itself, and the same job cannot be released or refunded twice.

### 2:23–2:40 — Evidence envelope

**Screen:** Evidence drawer: network, chain, decision hash, Dojang mode/status, job, exact amount, expiry, receipt level, required checks, and internal checksum. Click download.

**On-screen caption:**

> XPAYR exports the available policy, identity, role, amount, confirmation, and evidence-level facts as deterministic JSON. Its internal checksum supports reproducibility and accidental-change detection, but it is not a signature or proof of who produced the file. Arc data cannot satisfy this GIWA evidence schema.

In local fixture mode, add:

> This envelope is explicitly local: it contains no deployment, transaction, or live Dojang claim.

Do not call the downloaded lifecycle JSON itself “sealed,” “signed,” “tamper-proof,” or “tamper-evident.” Anyone editing its payload can recompute the internal checksum. Historical selected D3 files have separate auth-v1 signature/anchor sidecars. Completed Phase 4 release/refund lifecycle files have distinct-producer auth-v2 sidecars and canonical `XPA2` anchors bound to profile digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`. Show those as separately verified files/transactions; the fixture video and wallet-stub rehearsal must not imply that they were recorded on screen.

### 2:40–2:45 — Close

**Screen:** Primary track, GIWA-native product fit, and future adoption roadmap.

**On-screen caption:**

> Verified identity, bounded agent spending, human release, and auditable settlement: built for the AI/Web3 track, with GIWA-native product fit and a measurable adoption roadmap.

## Phase 4 completed evidence and recording gate

The active profile is `phase4_sod_v1`:

- policy authority: `0x89128251A3B46328Dc89A13B58C1339217B2fD34`;
- evidence producer: `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`;
- profile digest: `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`.

Separate repository-external one-key files have exact `0600` permissions; never show their paths or contents in a recording. The completed public evidence is:

- release lifecycle: `RELEASED`, `5/5` successful steps, `payment_completed=true`, digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc`;
- release auth-v2: producer signature verified; canonical `XPA2` anchor `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9`, block `31211004`;
- refund lifecycle: `REFUNDED`, `4/4` successful steps, `refunded=true`, `payment_completed=false`, digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e`;
- refund auth-v2: producer signature verified; canonical `XPA2` anchor `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650`, block `31211036`;
- bounded funding: `1,000,000,000,000 wei` native test ETH to the evidence producer, canonical tx `0x0fecdfdd511b78d1a3b00f818348fc457d242f1f42725eab1d135ae8e42ef6e4`, block `31209759`;
- source visibility: Blockscout `Pass - Verified`, with local/explorer source SHA equality and expected no-CBOR `PARTIAL` classification.

Exact retained pairs:

- `evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json` + `evidence/authenticated/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.auth-v2.json`;
- `evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json` + `evidence/authenticated/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.auth-v2.json`.

The reviewer index binds these records at digest `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5`; its explicit allowlist contains `81` files including both Phase 4 policy/lifecycle/auth-v2 pairs and the funding artifact.

Before recording a Phase 4 evidence-mode clip:

1. re-run read-only verification of the exact lifecycle/auth-v2 files and open both anchor explorer URLs immediately before capture;
2. choose either a retained-evidence walkthrough or a new uniquely bound real-wallet job; never replay or mutate the completed jobs;
3. if executing a new job, keep all signer files repo-external exact-`0600` and out of the screen, clipboard, shell history, captions and exported assets;
4. keep preview, explicit send, Flashblocks pending and canonical confirmation visually distinct; never present the prior `sendCount=0` stub rehearsal as the live transaction;
5. keep repository push, video publication and GASOK form submission blocked until applicant/account/content review and explicit user approval.

## Optional alternate ending: refund path

Record as a separate clip, not by extending the main demo beyond three minutes:

1. fund a second test job;
2. cancel or expire it under the documented state rule;
3. claim the refund;
4. show that release is now impossible;
5. export a separate refund evidence envelope.

The refund clip must show `terminal=true`, `refunded=true`, and `completed=false`; never label refund as a completed payment.

## Editing rules

- Do not accelerate or cut across the pending-to-confirmed distinction.
- Do not splice a local Dojang fixture into a real GIWA transaction as if both came from one live run.
- Mask public wallet addresses only if the application package does not require them; never mask chain ID, amount, state, or evidence level.
- Captions should repeat `testnet`, `native test ETH`, and `human approval` at the relevant moments.
- Link only to evidence that a reviewer can independently open and reproduce.
