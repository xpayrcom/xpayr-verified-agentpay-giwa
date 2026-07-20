# GASOK Application Draft — XPAYR Verified AgentPay for GIWA

Status: approved local MVP direction implemented; application draft not submitted
Selected form track: **Track 04. AI / WEB3**
Secondary product positioning: **Track 03. GIWA-NATIVE IDEAS** — emphasize the fit in the written answers, but do not present it as a second form selection
Not selected: **Track 05. MASS ADOPTION** — discuss adoption only as a future market/KPI thesis; do not present it as a second or future form selection while the current form permits exactly one track

Official application deadline: **2026-07-31 23:59:59**, as stated in the [Upbit notice](https://www.upbit.com/service_center/notice?id=6386). Neither that notice nor the [GASOK landing page](https://giwa.io/gasok?lang=ko) states the time zone, so the time zone remains unverified; obtain written support confirmation or submit at least 24 hours early. Official application form: [GASOK Application — MVP Build Phase](https://ds.fdback.me/r/bLHPv694o6Au3).

The GASOK landing page says projects may participate in multiple tracks, but the current official application form schema enforces one choice (`minSelection=1`, `maxSelection=1`). The form is the submission authority for this application, so the prepared English branch selects only `Track 04. AI / WEB3` and uses the narrative to demonstrate GIWA-native fit.

## Project name

**XPAYR Verified AgentPay for GIWA**

## One-line description

A policy-controlled, non-custodial escrow layer for AI-agent work that binds mandatory Dojang address verification, an EIP-712-signed exact spend policy, human wallet/release approval, GIWA Sepolia settlement, and producer-signed/on-chain-anchored payment evidence, with a Phase 4 separation-of-duties profile for policy and evidence authorities.

## Problem

AI agents can initiate purchases and paid tasks, but four facts are usually fragmented across separate systems:

- whether the payer, provider, and evaluator are using the expected verified addresses;
- whether the agent is authorized to spend the requested amount;
- whether a deliverable was committed before release;
- who approved the irreversible payment and how that payment can be audited.

This fragmentation makes agent commerce difficult for merchants to control and difficult for users to trust.

## Solution

XPAYR Verified AgentPay joins those facts into one bounded workflow:

1. A merchant creates an AI job/payment request.
2. Before deployment, XPAYR records a D1 proof at one canonical block: it reads the configured Dojang aggregate `isVerified` signal, resolves the attester from `DojangAttesterBook`, and validates the positive UID/EAS attestation's schema, recipient, attester, revocation, expiry, issue time, and encoded `true`. The escrow independently requires every configured participant to pass one of two immutable accepted attesters at lifecycle time. The retained D1 uses the `TESTNET_FAUCET` attester with `test_only=true`; it is a testnet Verified Address attestation, not Upbit Korea KYC, legal identity, AML, sanctions, or credit proof.
3. The agent submits a normalized payment intent.
4. XPAYR returns `ALLOW`, `HOLD`, or `DENY` using merchant policy. An executable run requires an EIP-712-signed `ALLOW` artifact whose authority, validity, record/intent IDs, ruleset, chain, escrow, roles, job, amount, expiry, outcome, and deliverable are verified before signer access.
5. XPAYR derives a trusted job nonce and payer-bound job ID that callers cannot override. An eligible intent is then bound to a non-custodial GIWA escrow job whose policy fixes the roles, exact expected native-test-ETH amount, expiry, and decision hash.
6. The provider commits a deliverable hash.
7. A human merchant/evaluator approves release or follows a dispute/refund path.
8. XPAYR queries live `eth_chainId` and requires `91342`, independently re-fetches the canonical receipt, transaction, receipt block, and chain head; recognizes release/refund/dispute-resolution/timeout-refund calldata; validates outcome-specific `JobReleased`, `JobRefunded`, and `DisputeResolved` events; and compares the on-chain `RELEASED`/`REFUNDED` job state with the policy, roles, amount, expiry, and mandatory-verification bindings. Refund is terminal recovery, not payment completion.
9. A GIWA-only lifecycle JSON records the available policy, identity signal, roles, amount, transaction, receipt, events, and webhook/demo result. Historical auth-v1 sidecars remain retained. Completed Phase 4 auth-v2 sidecars bind new release/refund evidence, the distinct policy authority, the distinct evidence producer, and the active authority-profile digest to EIP-712 signatures and canonical zero-value `XPA2` GIWA anchors.

Flashblocks improves pending feedback but never decides settlement. The AI evaluator does not autonomously release funds.

## Why GIWA is necessary

The project is designed around GIWA-specific product advantages rather than a generic chain adapter:

- **Dojang Verified Address:** gives the payment workflow a chain-native participant-verification signal.
- **GIWA-local escrow:** keeps identity, job state, and settlement in one chain context for the MVP.
- **Flashblocks:** enables fast “transaction observed” feedback while the verifier separately waits for the normal receipt.
- **Wallet-ready actions:** the lifecycle maps naturally to pending jobs, approve, release, dispute, refund, and history screens.
- **Future ecosystem extensions:** `up.id` payment targets, Verified Code, GIWA Wallet integration, ERC-4337 session permissions, and paymaster sponsorship are clear next steps, but are not claimed as implemented.

The MVP uses an independent `giwa-testnet` manifest, contract, tests, and evidence schema. Arc transactions or artifacts cannot satisfy GIWA proof requirements.

## What is original

Most escrow demos prove that value moved. XPAYR Verified AgentPay also binds:

- a normalized agent intent;
- an XPAYR-derived trusted nonce and payer-bound job ID, protected from caller override/preemption;
- a persisted, EIP-712-signed merchant policy decision and fingerprint;
- a mandatory identity signal from one of two immutable accepted attesters;
- a deliverable commitment;
- explicit human approval;
- an independently re-fetched canonical receipt/transaction/block/head, recognized terminal action, outcome-specific events, and matching `RELEASED`/`REFUNDED` on-chain state;
- a portable evidence JSON with an internal reproducibility checksum plus a separately verifiable producer-signature/on-chain-anchor sidecar.

The differentiator is not “AI plus escrow.” It is a verifiable control and evidence layer that makes delegated AI spending reviewable before and after settlement. A bare checksum is deliberately not presented as authenticity proof; only the selected signed-policy D3 files receive the separately verified auth-v1 layer.

## MVP architecture

```text
AI agent / merchant
  -> local XPAYR intent API
  -> Dojang read + ALLOW/HOLD/DENY policy
  -> fixture HOLD approval state or live direct-ALLOW-only gate
  -> authenticated-wallet boundary for any real chain action
  -> GIWA escrow transaction request with exact amount + expiry
  -> native test ETH fund / submit / release or refund
  -> canonical receipt + transaction + block + head + terminal calldata + outcome-specific event/job verification
  -> GIWA lifecycle evidence envelope
  -> historical auth-v1 or Phase 4 auth-v2 producer signature + canonical GIWA anchor sidecar

Flashblocks -> pending UI only
```

State model:

```text
CREATED -> FUNDED -> SUBMITTED -> APPROVED -> RELEASED
CREATED -> CANCELLED
CREATED/FUNDED/SUBMITTED -> EXPIRED -> REFUNDED
FUNDED -> CANCELLED -> REFUNDED
SUBMITTED/APPROVED -> DISPUTED -> RELEASED/REFUNDED
```

## Current MVP scope

Included:

- isolated GIWA Sepolia network adapter and chain guards;
- block-hash-pinned read-only D1 recorder for exactly two distinct immutable accepted attesters (`UPBIT_KOREA` and `TESTNET_FAUCET`), including same-block attester-registry resolution and positive UID/EAS schema, recipient, attester, revocation, expiry, issue-time, and encoded-value validation;
- escrow creation fixed to require Dojang verification for the payer, provider, and any configured evaluator, with no optional bypass;
- deterministic `ALLOW` / `HOLD` / `DENY` policy;
- policy-bound `expectedAmount`, `expiresAt`, roles, and decision hash, with exact-value funding;
- XPAYR-derived `jobNonce` and `jobId = keccak256(abi.encode(payer, jobNonce))`, re-derived by the contract from `msg.sender`;
- native-test-ETH escrow state machine and adversarial local tests;
- merchant approval queue and intent-to-escrow binding;
- separated Flashblocks pending and independent canonical confirmation states;
- wallet-ready single-page local demo;
- downloadable GIWA evidence JSON with a deterministic internal checksum;
- EIP-712-signed policy-origin artifacts with exact execution binding and fail-closed freshness/recovery rules;
- auth-v1 producer-signature and canonical on-chain-anchor sidecars for the selected release/refund lifecycle files;
- active `phase4_sod_v1` profile with distinct policy authority and evidence producer, completed `RELEASED`/`REFUNDED` SoD lifecycles, and producer-signed canonical `XPA2` auth-v2 anchors;
- two-step live-wallet request handling that decodes and displays target, function, roles, value, gas and bounded maximum cost before an explicit send action;
- threat model, security boundaries, test report, and demo script.

Not included or claimed:

- GIWA Mainnet or real customer funds;
- USDC, KRW stablecoin, or any canonical stablecoin integration;
- KYC/AML, sanctions, credit, or legal decisioning;
- automatic AI-only release;
- cross-chain bridge or cross-chain identity;
- production paymaster/account abstraction;
- full decentralized dispute court;
- a completed GIWA Wallet SDK integration;
- GIWA/Upbit partnership, endorsement, grant, or audit.

The address-labeled `HOLD` approval route exists only in fixture mode to demonstrate local state flow; it does not prove wallet ownership or authenticate a merchant/evaluator. Live mode rejects local approve/reject actions and permits transaction preparation only from a direct `ALLOW` policy result. The browser still requires an explicit wallet send and later role-correct human release approval. A deterministic EIP-1193 stub test decoded a bounded preview and cancelled it with `sendCount=0`; this verifies browser behavior only, not a real wallet, transaction, chain receipt, or video.

## Demonstration

The 2–3 minute demo shows:

1. the visible local/testnet and native-test-ETH boundary;
2. participant verification status and evidence mode;
3. an agent intent and policy result;
4. fixture-only merchant approval when the result is `HOLD`, or a separate live-mode direct-`ALLOW` decoded transaction preview with an explicit send/cancel boundary;
5. escrow funding, deliverable digest, and human approval only when canonical chain evidence exists;
6. Flashblocks “observed” versus normal receipt “confirmed”;
7. release or refund;
8. a downloadable evidence JSON whose internal checksum supports reproducibility.

Any locally mocked Dojang or EVM step is labeled as a fixture and is not shown as a GIWA explorer transaction. GIWA Sepolia transaction and live Dojang claims are added only when their independent evidence exists.

The retained 2–3 minute video is the local fixture recording. Phase 4's live-mode browser check uses a deterministic wallet stub: it reaches a decoded `createJob` preview, exercises cancel, and records `sendCount=0`. It is neither a real wallet session nor a broadcast/receipt/video artifact and will not be spliced into the historical D1/D2/D3 proof chain.

At the current `source_verified_partial_no_cbor_phase4_sod_d3_auth_v2_complete` checkpoint, positive D1 binds the exact payer/provider at canonical block `31153475`, and `XPayrVerifiedAgentEscrow` is live on GIWA Sepolia at `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`. Blockscout source evidence reports `Pass - Verified`; explorer/local source SHA-256 values are identical, exact creation input and immutable-aware runtime match, and the smart-contract level is the expected no-CBOR `PARTIAL`. Historical D3/auth-v1 artifacts remain unchanged.

Phase 4's active profile is `phase4_sod_v1`: policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34`, evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`, profile digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`. Separate repository-external exact-`0600` one-key files were used without retaining private signer material in evidence. The release lifecycle reached canonical `RELEASED` with `5/5` successful steps and `payment_completed=true`; evidence digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc` is producer-signed and anchored by `XPA2` transaction `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9` in block `31211004`. The refund lifecycle reached canonical `REFUNDED` with `4/4` successful steps, `refunded=true`, and `payment_completed=false`; evidence digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e` is producer-signed and anchored by `XPA2` transaction `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650` in block `31211036`.

The exact public evidence pairs are `evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json` with `evidence/authenticated/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.auth-v2.json`, and `evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json` with `evidence/authenticated/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.auth-v2.json`. Bounded evidence-producer funding is separately recorded at `evidence/funding/phase4-sod-evidence-producer-funding-20260720.json`: `1,000,000,000,000 wei` native test ETH, tx `0x0fecdfdd511b78d1a3b00f818348fc457d242f1f42725eab1d135ae8e42ef6e4`, block `31209759`, canonical-verified. Blockscout source verification remains independently recorded at `evidence/deployment/giwa-testnet-source-verification-20260719T231930Z.json` with `submissionResult="Pass - Verified"` and `sourceMatchesLocal=true`. The current reviewer index digest is `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5`, and its explicit reviewer allowlist contains `81` files including the Phase 4 policy/lifecycle/auth-v2 and funding artifacts.

A checksum by itself is not a signature or broad tamper guarantee. Historical auth-v1 proves control by the same configured testnet payer/deployer EOA and remains non-SoD. Phase 4 provides executed technical separation between policy signing and evidence production: both lifecycle origins set `separation_of_duties=true`, both auth-v2 sidecars recover the distinct evidence producer, and both canonical anchors decode to the exact lifecycle and profile digests. This is technical testnet address-role separation, not independent organizational attestation, XPAYR legal identity, or legal non-repudiation. The retained fixture video and stub wallet rehearsal remain presentation/browser artifacts and are not substitutes for these lifecycle/auth-v2 JSON files or explorer records. Public publication and GASOK submission have not occurred.

## User and market

Initial users:

- AI-agent service marketplaces;
- merchants delegating bounded purchases or operational tasks to agents;
- freelancer and agency workflows that require delivery-before-payment;
- API-first platforms that need proof of authorization and settlement;
- teams experimenting with verified wallets and agent session permissions.

The wedge is a developer-friendly escrow/evidence primitive. The broader opportunity is a merchant control plane for repeatable agent commerce.

## Natural GIWA Wallet fit

The product can be represented with a compact action surface:

- Jobs awaiting funding
- Deliverables awaiting review
- Approve and release
- Dispute or refund
- Verification status
- Pending versus confirmed transaction state
- Evidence and explorer history

This is a wallet-ready interaction model. A live GIWA Wallet SDK integration is contingent on official access and is not part of the current claim.

Test-only signer-bound chain transactions, bounded fund movement, positive live Dojang D1, Blockscout source-visible `PARTIAL` verification plus exact bytecode proof, signed policy origins, historical auth-v1 anchors, and completed Phase 4 SoD lifecycle/auth-v2 evidence now exist in the module's retained evidence set. Policy authority and evidence producer remain distinct from each other and from operational payer/provider roles. Private signer material and raw signed transactions are not retained in evidence or reviewer artifacts. The verified local video remains a fixture demonstration only; the deterministic wallet-stub preview remains browser-test evidence only. No public repository/demo publication or GASOK submission exists at this checkpoint.

## Feasibility

The MVP is deliberately narrow:

- one chain: GIWA Sepolia;
- one asset: native test ETH;
- explicit roles and state transitions;
- human approval before release;
- local in-memory intent API for demonstration;
- independent contract, domain, API, and UI tests;
- no bridge, oracle-priced asset, production custody, or automated arbitration.

This keeps the first milestone testable while leaving clear interfaces for later wallet, name, token, and account-abstraction work.

## Track fit

### Selected — Track 04. AI / WEB3

The agent initiates a bounded economic intent, while XPAYR policy and a human approval boundary constrain the irreversible Web3 action. The evidence envelope makes that delegation auditable.

### Secondary positioning — Track 03. GIWA-NATIVE IDEAS

Dojang identity, GIWA-local escrow, Flashblocks pending UX, and wallet-ready lifecycle actions are central to the product—not decorative integrations.

### Future adoption thesis — not a form track selection

Users see a familiar job/payment flow instead of raw transaction mechanics. Verified participant signals, explicit approval, refunds, readable states, and evidence reduce the trust gap for AI-mediated work.

This is currently a market thesis and KPI plan, not demonstrated mass adoption. The current form remains fixed to `Track 04. AI / WEB3`; do not select or imply `Track 05. MASS ADOPTION`, even if later pilot evidence is added to the narrative.

## Selection-criteria response

| GASOK consideration | Response |
|---|---|
| Real reason to use GIWA | Dojang identity plus GIWA-local escrow and wallet-ready approval/release flow |
| Originality | Policy-bound exact amount/expiry + mandatory verified participants + delivery commitment + human release + reproducible evidence |
| Can it be built? | Single-chain, single-asset, explicit-state MVP with local adversarial tests |
| Users and market | Agent marketplaces, merchants, API platforms, freelancers, and agencies |
| Can the team execute? | The package is structured around reproducible code, tests, threat model, and evidence; prior work is not substituted for GIWA proof |
| Natural Wallet integration | Pending jobs, review, approve, release, dispute/refund, and history |

## Program-aligned five-plus-month roadmap

This plan follows the published GASOK sequence: MVP Build in June–July 2026, Productize/private-mainnet readiness in August–September, the in-person KBW Demo Day in October, and ongoing Growth. Mainnet and GIWA Wallet integration remain future program-dependent work, not current product claims.

### Month 1 — Testnet MVP and evidence

- retain the verified historical D1/D2/D3/auth-v1 baseline without rewriting it;
- retain and independently re-verify the completed Phase 4 SoD release/refund/auth-v2 artifacts and explorer anchors;
- record a separate retained-evidence walkthrough for the completed Phase 4 proof; no new transaction is required, and any future real-wallet recording remains a distinct artifact;
- keep public push and GASOK submission behind applicant/account/content review and explicit approval.

### Month 2 — Developer pilot

- package the intent and evidence interfaces;
- onboard a small set of test merchants/agents;
- measure completion, failure, approval, and refund paths;
- improve wallet-ready mobile UX.

### Month 3 — Private-network readiness

- adapt to the program’s confirmed private-network requirements;
- add durable authenticated merchant storage;
- harden webhooks, replay protection, monitoring, and reconciliation;
- commission focused contract/security review.

### Month 4 — Wallet and identity depth

- integrate official wallet capabilities if access is provided;
- evaluate `up.id` and Verified Code against documented interfaces;
- prototype bounded session permissions and sponsored gas only if official support is available.

### Month 5 — Demo Day and growth readiness

- publish reproducible non-sensitive evidence;
- demonstrate repeat jobs and merchant retention;
- finalize metrics, incident runbook, and controlled-pilot plan;
- prepare a Mainnet proposal, not a Mainnet release.

## KPI plan

Primary:

- verified active test wallets;
- completed verified jobs;
- native test-ETH settled volume, clearly labeled non-economic;
- active merchants and providers;
- repeat-job rate;
- median fund-to-release time;
- dispute/refund rate;
- wallet-ready flow completion rate.

TVL is secondary. The product should reward completed work, not unnecessary lockup.

## Use of support

If selected and if the applicable program conditions are met, the relevant support would be directed to contract review, authenticated merchant/approval infrastructure, official GIWA integration work, developer documentation, pilot onboarding, and measurement. The public program describes support worth up to USD 100K rather than a guaranteed award: the USD 20K and any later KPI-based support of up to USD 80K remain subject to Demo Day/program completion, KPI, tax, fee, and other program conditions. Proposed KPIs would reward verified job completion, active users, repeat use, and settlement quality—not raw testnet transaction spam.

## Applicant-supplied fields before submission

- Applicant/team legal names, individual-versus-team status, member roles, short biographies, and prior shipping evidence
- Active notification email and phone; country, tax residence, and eligibility confirmations
- Form selection is fixed to `Track 04. AI / WEB3`; describe `Track 03. GIWA-NATIVE IDEAS` as product fit, not a second selected track, and do not select `Track 05. MASS ADOPTION`
- Repository, demo/video, contract explorer, and public evidence-package URLs after publication approval
- Market validation: pilot, interview, LOI, waitlist, or user evidence; otherwise an explicit `pre-pilot` statement
- Team availability for the August–October program and confirmation that an authorized presenter can attend the October KBW Demo Day in Korea in person
- Existing IP, repository-level license, and third-party dependency declaration
- Program agreement, data sharing, publicity, withholding-tax/fee, and grant-condition review
- Grant-use budget and milestone allocation
- Written deadline time-zone confirmation, or a recorded decision to submit at least 24 hours before the published date/time

This draft must be reviewed by the applicant before it is copied into or submitted through any external form.
