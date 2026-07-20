# Threat Model — XPAYR Verified AgentPay for GIWA

Status: isolated GIWA Sepolia MVP threat model with Phase 4 wallet/reviewer hardening, retained historical auth-v1 evidence, and two completed profile-bound lifecycle/auth-v2 proof sets
Target: GIWA Sepolia (`giwa-testnet`, chain ID `91342`)
Asset boundary: native test ETH only

This document models the local MVP and its intended GIWA Sepolia execution. It does not assert Mainnet readiness or a completed external audit.

## Security goals

The MVP aims to preserve these properties:

1. Only authorized roles can move a job through the escrow state machine.
2. A job cannot be funded, released, or refunded more than once.
3. The contract never depends on a browser or Flashblocks observation for terminal settlement.
4. XPAYR emits exactly one policy decision—`ALLOW`, `HOLD`, or `DENY`—for a normalized intent.
5. `HOLD` requires explicit authenticated human approval and cannot authorize current `live_wallet` execution; its address-only transition is fixture-only. `DENY` cannot produce an executable escrow request.
6. Dojang verification is mandatory at contract level. Lifecycle authority accepts only aggregate `isVerified=true` through one of two distinct immutable attester IDs (`UPBIT_KOREA` or `TESTNET_FAUCET`). Before deployment, D1 additionally binds each required role to a positive UID/EAS attestation whose schema, recipient, registered attester, revocation, expiry, issue time, and `bool=true` payload are valid at one retained canonical block hash.
7. Deliverables remain off-chain; only their digest is committed.
8. Evidence is deterministic, GIWA-specific, and free of private keys, raw signed transactions, secrets, and unnecessary personal data. A checksum supports reproducibility; signed-policy, auth-v1, and auth-v2 artifacts add explicitly scoped EOA-control proof only when their signatures, exact bindings, and canonical anchors are independently verified.
9. XPAYR does not pool or custody participant funds.
10. Local mocks and fixtures are never represented as live GIWA or Dojang proof.
11. Each job binds its policy decision, exact expected amount, expiry, roles, and trusted nonce. XPAYR—not the caller—derives the nonce, and the contract recomputes the payer-bound job ID; funding with any other amount fails.
12. Terminal confirmation is derived from independently re-fetched canonical RPC data and on-chain state, never from client-supplied receipt fields alone.
13. Live browser execution requires a direct `ALLOW`; unauthenticated address-only approval/rejection is fixture-only and cannot authorize a wallet request.
14. A wallet request is shown first as immutable decoded calldata under a captured intent/job context, revalidated immediately before a one-shot user-directed send, and never auto-retried after rejection.
15. A terminal wallet hash is recorded immediately for same-process reload recovery, while only canonical receipt/event/job-state verification may produce completion evidence.
16. A reviewer package is an exact embedded-allowlist/manifest export with secret, symlink, path, non-regular-file, raw-transaction, and unsafe-replacement guards.

## Assets to protect

- Native test ETH held by an individual escrow job.
- Authorization of payer, provider, evaluator, and dispute-resolution actions.
- Policy decision and its hash/fingerprint.
- Deliverable hash and job-to-transaction binding.
- Contract address, chain ID, exact policy-bound amount/expiry, sender, recipient, receipt, decoded event, and on-chain-state agreement.
- Dojang attester allowlist and normalized verification result.
- Evidence JSON field consistency, reproducibility boundary, and privacy.
- Test-only signing keys and RPC configuration.

## Actors and trust assumptions

| Actor | Allowed capability | Not trusted for |
|---|---|---|
| Payer / merchant | Create, fund, approve where configured, cancel/refund under state rules | Rewriting receipt facts or bypassing state rules |
| Provider | Submit a deliverable digest | Approving or releasing its own payment by default |
| Evaluator / merchant approver | Human approval and configured dispute action | Autonomous AI-only release |
| XPAYR policy service | Normalize intent, decide, queue approval, build transaction request | Custody, signing on behalf of users, chain finality |
| Dojang | Address-attestation source | Delivery quality, credit, AML/KYC, or payment finality |
| GIWA RPC | Chain data transport | Single-source truth when responses are inconsistent |
| Flashblocks RPC | Faster observed/pending signal | Final or successful settlement |
| Browser / wallet-ready UI | User input, display, user-directed signing | Policy authority or completion authority |
| Evidence verifier | Recompute checksums and, when present, verify signed-policy/auth-v1/auth-v2 signatures, profile bindings, and canonical anchor bindings | Proving legal identity, independent review, organizational separation, or repairing incorrect upstream facts |
| Phase 4 policy authority | Sign a profile-bound direct-`ALLOW` policy artifact | Participant signing, evidence production, organizational independence, or completion authority |
| Phase 4 evidence producer | Sign and anchor a profile-bound auth-v2 binding | Policy issuance, participant signing, factual correctness, or independent organizational review |
| Reviewer package builder/verifier | Export and verify the exact public allowlist snapshot | Selecting arbitrary repository files, handling secrets, or proving live chain state by itself |

## Trust boundaries

```text
Untrusted input
  -> local API validation
  -> XPAYR policy (`live_wallet`: direct `ALLOW` only; local decisions: fixture only)
  -> immutable decoded-calldata preview + captured intent/job context
  -> authenticated wallet/user signature boundary for any real chain action
  -> immediate exact transaction-hash registration
  -> GIWA escrow contract
  -> canonical receipt + transaction + head + event + job-state verifier
  -> evidence envelope

Dojang read ----------------------^ identity signal
Flashblocks read ---------> UI pending state only
```

The API, UI, RPC, Dojang read, contract, and evidence verifier are separate boundaries. Success in one does not automatically satisfy another.

## Threats and mitigations

### T1 — Unauthorized state transition

**Threat:** An attacker calls submit, approve, release, dispute, cancel, or refund without the required role.

**Mitigation:** Contract-level role checks; explicit allowed-state checks; negative tests for every privileged transition; no API response treated as an authorization substitute.

**Residual risk:** Incorrect role configuration at deployment. Constructor arguments and role addresses must be reviewed and captured in deployment evidence.

### T2 — Reentrancy during payout or refund

**Threat:** A recipient contract re-enters before state is finalized.

**Mitigation:** Checks-effects-interactions ordering, a reentrancy guard, state terminalization before value transfer, and adversarial recipient tests.

**Residual risk:** Future token adapters introduce callbacks or non-standard behavior. ERC-20 support is outside this native-test-ETH MVP.

### T3 — Double funding, release, or refund

**Threat:** Replayed calls or duplicated application requests move value twice.

**Mitigation:** Unique job IDs, exact state gates, terminal states, on-chain amount accounting, intent consumption, and idempotency/replay tests.

### T4 — Policy bypass or decision substitution

**Threat:** A client changes network, recipient, amount, asset, roles, or deadline after XPAYR evaluated the intent.

**Mitigation:** Normalize before evaluation; reject caller-supplied `jobId/jobNonce`; derive a trusted nonce in XPAYR; derive `jobId = keccak256(abi.encode(payer, jobNonce))`; hash the execution-relevant fields, including `expectedAmount`, `expiresAt`, network, roles, destination, job ID, and nonce; compare the decision fingerprint with the escrow request and on-chain job. In fixture mode, an address-only `HOLD` decision may demonstrate the local domain transition. In `live_wallet`, the server rejects local `approve`/`reject` actions and permits bridge construction only for a direct `ALLOW` whose approval status is `NOT_REQUIRED`.

**Residual risk:** The local in-memory prototype is not a production persistence or authentication layer.

### T5 — Approval spoofing

**Threat:** A caller invokes an unauthenticated local approval/rejection route while pretending to be the merchant or evaluator, then attempts to turn that decision into a live wallet request.

**Mitigation:** Supplying an address proves neither wallet ownership nor user consent. The address-only decision endpoints remain fixture-only. `live_wallet` rejects both local `approve` and `reject`, rejects execution of a locally overridden `HOLD`, and requires a direct `ALLOW` before it will create an execution binding. The participant wallet still performs the relevant on-chain role action. A future live `HOLD` flow requires a separately reviewed replay-resistant wallet authorization, tenant/merchant authentication, CSRF protection where applicable, and an authenticated audit record.

**Residual risk:** That authenticated live approval protocol does not exist. Local `HOLD -> approved` remains fixture UI/domain evidence only and must not authorize or be cited as real payment approval.

### T6 — Stale, lifecycle-invalid, wrong-attester, or spoofed Dojang status

**Threat:** A lifecycle-invalid aggregate result, non-allowlisted attester, wrong chain, unpinned read, or attacker-controlled contract is accepted as “verified.”

**Mitigation:** Pin chain ID and Dojang/EAS contracts in configuration, then independently query live `eth_chainId` and fail closed unless it is `91342`; bind the distinct `UPBIT_KOREA` and `TESTNET_FAUCET` attester IDs as immutable constructor arguments; make verification mandatory with no per-job bypass; use the Dojang contract's aggregate `isVerified` result as lifecycle authority; and fail closed on false, unknown, unavailable, malformed, unpinned, or ambiguous reads. The D1 recorder resolves each official attester address from `DojangAttesterBook.getAttester` at the same EIP-1898-pinned canonical block, then validates the positive UID against EAS for schema, recipient, official attester, revocation time, expiration, issue time, and encoded `true`. Before signer loading, D2 and D3 independently reconstruct the complete artifact from canonical RPC at its retained block and require canonical equality for the exact role addresses; a self-asserted/resealed JSON is insufficient. D3 also performs fresh live aggregate checks.

**Residual risk:** D1 is a point-in-time attestation observation, not a promise that verification remains valid forever. A status may change after the retained block; the execution-time live check and contract call reduce but do not eliminate that timing window. Testnet issuance/access may be unavailable. Mock verification may support local tests but must remain visibly labeled `mock` or `fixture`.

### T7 — Flashblocks mistaken for finality

**Threat:** A pending observation is shown or recorded as completed payment.

**Mitigation:** Separate status fields for wallet-submitted, Flashblocks observed/pending, and terminal outcomes. Immediately after the participant wallet returns a terminal transaction hash, the UI records that exact hash in the intent store before optional Flashblocks observation. The same running local server can rehydrate that pending hash after a browser reload and retry proof. Terminal confirmation independently re-fetches the receipt, transaction, canonical receipt block, and chain head; checks successful status and confirmation depth; recognizes the `releaseJob`, `resolveDispute`, `claimRefund`, or `claimDisputeTimeoutRefund` calldata; validates the outcome-specific `JobReleased`, `JobRefunded`, and when applicable `DisputeResolved` events; and reads the contract job before accepting the job ID, roles, exact amount, policy hash, expiry, mandatory verification, zero balance, and `RELEASED`/`REFUNDED` state. Refund is terminal recovery but never payment completion.

**Residual risk:** The local intent store is process memory, so server restart loses this recovery record. Persistence, authenticated tenancy, and crash-consistent production recovery remain out of scope.

### T8 — RPC equivocation, outage, or wrong-chain response

**Threat:** A compromised or misconfigured endpoint returns the wrong chain, receipt, or code.

**Mitigation:** Query live `eth_chainId` during canonical proof and require `91342`; pin expected contract/address data; never trust caller-provided receipt/transaction/head fields as canonical; reject missing code or inconsistent receipt, transaction, event, head, or job-state data; retain chain ID, contract address, transaction sender/target/hash, block number/hash, receipt status, and explorer URL; support independent explorer/manual comparison for demo evidence.

**Residual risk:** The MVP does not operate a full node and inherits testnet availability.

### T9 — Front-running or job-ID collision

**Threat:** An attacker copies a transaction or pre-creates a predictable job ID.

**Mitigation:** XPAYR derives a trusted per-record nonce and rejects caller `jobId/jobNonce` overrides. The contract recomputes `keccak256(abi.encode(msg.sender, jobNonce))`, requires it to equal the supplied job ID, rejects existing IDs, and stores the nonce for canonical verification. This prevents a different payer from pre-creating the victim's intended job ID.

### T10 — Deadline manipulation and stuck funds

**Threat:** Invalid deadlines, timestamp edge cases, or missing terminal actions leave funds locked.

**Mitigation:** Bounded future expiry at creation; explicit cancel/expire/refund transitions; tests immediately before and after expiry; no operator-only escape hatch outside documented state rules.

**Residual risk:** A participant can delay required human action until timeout. The UI must surface deadlines and refund eligibility.

### T11 — Malicious or misleading deliverable digest

**Threat:** A provider commits an unrelated digest, or a merchant claims that a hash proves quality.

**Mitigation:** The digest proves only byte-level commitment to an off-chain deliverable. A human evaluator approves the business outcome; the UI and evidence must not call the hash a quality verdict.

### T12 — Autonomous evaluator releases funds incorrectly

**Threat:** An AI model makes an irreversible release decision on its own.

**Mitigation:** Explicit non-goal. AI output may inform a `HOLD` queue, but a human merchant/evaluator performs the release-authorizing action.

### T13 — Dispute authority abuse

**Threat:** A single evaluator unfairly routes funds.

**Mitigation:** MVP authority and outcomes are explicit, events are auditable, and users know the evaluator before funding. Multi-party arbitration and decentralized courts are future work, not implied safety.

### T14 — Evidence mutation, checksum recomputation, or cross-rail substitution

**Threat:** A field is changed after export, the internal checksum is recomputed by the editor, or an Arc transaction is inserted as GIWA proof.

**Mitigation:** Canonical serialization and internal checksums make exports reproducible and help detect accidental or out-of-sync mutation relative to separately trusted digests. Required chain ID/network key, positive D1 reference validation, independently re-fetched receipt/transaction/head data, decoded-event and contract-state checks, exact release deliverable-hash binding, signed policy/job binding, and dedicated D1/D2/D3/policy/auth-v1/auth-v2 schemas reject cross-rail or cross-phase substitution. Auth-v1 binds the exact lifecycle file SHA-256/digest, signed-policy digest, producer EIP-712 signature, and decoded `XPA1` anchor payload. Auth-v2 additionally binds the exact active profile digest, distinct policy/evidence authority EOAs, terminal transaction, and decoded `XPA2` anchor payload. Canonical receipt/block checks require a zero-value self-transaction from the configured producer EOA.

**Residual risk:** A checksum-only artifact remains recomputable. Auth-v1/auth-v2 prove only that the configured testnet EOA or EOAs controlled the signatures/anchors for the exact bound artifacts; they do not prove XPAYR corporate identity, factual correctness of every upstream statement, independent organizational attestation, legal non-repudiation, or production custody. The local fixture and original D3 files remain checksum-only.

### T15 — Secret or personal-data leakage

**Threat:** Private keys, bearer tokens, RPC credentials, names, raw deliverables, or webhook secrets enter logs/evidence.

**Mitigation:** Secret-pattern and forbidden-field checks; store only wallet addresses and digests required for verification; mask signer data; and review video frames and evidence before publication. The execute tools accept signer variables only from an explicitly named absolute file whose resolved path is outside the entire `xpayr.com` repository, whose final component is not a symlink, whose owner is the current user, whose mode is exactly `0600`, whose hard-link count is one, and whose size/keys are allowlisted. Ambient signer-variable collisions are rejected, and the derived signer must match the independently supplied public role/deployer address. The Phase 4 policy and evidence keys live in two separate repository-external `0600` files. Reviewer packaging separately rejects symlinks, non-regular files, forbidden paths, populated secret fields or assignments, private-key-shaped content, and serialized raw transactions.

### T16 — Native value transfer failure

**Threat:** A payout/refund recipient rejects ETH, causing a terminal action to fail.

**Mitigation:** Transfer success is checked and state rolls back on failure. Tests include a rejecting recipient. A later pull-payment design may reduce receiver-driven denial of service.

### T17 — Misleading production, stablecoin, or partnership claims

**Threat:** Testnet behavior is presented as Mainnet, native test ETH is presented as USDC/KRW stablecoin, or the demo implies GIWA/Upbit endorsement.

**Mitigation:** Persistent testnet labels, native-test-ETH asset display, evidence-level labels, and an application/demo copy review. No production or partnership language without separate written evidence.

### T18 — Blind deployment retry or cost/nonce drift

**Threat:** A timed-out deploy is retried without reconciling whether the first transaction was broadcast, or a changed nonce/gas/fee causes an unintended second deployment or exceeds the approved test-ETH cap.

**Mitigation:** Deployment preflight is read-only by default. Execute requires exact chain/network confirmations, a unique safe deployment run ID, an explicit positive decimal maximum-cost cap, a positive D1 artifact for the exact public roles, a separately confirmed public deployer address, and a testnet-only key. The script fixes the pending nonce, buffered gas limit, and fee fields; records the predicted address; creates the initial `prepared_not_broadcast` recovery journal with a true exclusive `wx` write before sending; checks journal ownership on every update; writes `broadcast_pending_receipt` immediately after sending; and refuses execute while any recovery journal exists.

**Residual risk:** RPC failure can still leave the operator uncertain about broadcast/receipt state. Reconcile the journal's nonce, predicted address, transaction hash, canonical receipt, and deployed code before any retry. The completed D2 journal and broadcast evidence now exist and must be preserved as audit records; they are not authority for another deployment.

### T19 — Concurrent lifecycle execution or exact-output substitution

**Threat:** Two differently named lifecycle runs race for the same signer nonce or combined spend cap, or a release evidence envelope records a deliverable hash different from the one committed on-chain.

**Mitigation:** D3 creates one global exclusive execution lock across all run IDs before signer loading and retains a per-run journal for every planned/broadcast transaction. Explicit resume requires an exclusive per-run lease, validates lock/journal ownership and a strict workflow prefix, reconciles every recorded transaction/receipt against sender, target, type, chain, calldata, value, exact nonce, gas and fee bindings, and pins state to the canonical receipt block with before/after hash checks. Already canonical steps are never re-signed or rebroadcast; only a missing suffix may proceed. A missing pre-create job maps to `Status.NONE` only when pinned revert bytes exactly equal `JobNotFound(expectedJobId)` and the journal is an exact zero-step `ready_before_first_broadcast` state with no pending transaction or a validated prepared-create rebroadcast state. Wrong IDs, trailing bytes, missing/malformed revert data, inconsistent zero-step status, any later-step `JobNotFound`, and pinned-head changes fail closed and retain the lease; the exact legitimate pre-create case is the positive cleanup path. Evidence and completed-journal finalization are idempotent. Release requires an explicit non-zero deliverable hash and exact terminal equality with on-chain state; refund requires absent/zero deliverable hash. Zero role addresses and zero job nonces are rejected before execution.

**Residual risk:** A crashed process still requires deliberate reconciliation or the guarded resume path. Deleting an active lock/lease without reconciling pending nonces and journals can reintroduce replacement or accounting risk. Completed journals are retained; the current completed runs have no active lock or lease.

### T20 — Policy-origin substitution, expiry bypass, or recovery abuse

**Threat:** A valid-looking hash is supplied without a persisted policy record, a signed policy is substituted across jobs, an expired policy starts a fresh execution, or resume weakens more than the freshness check.

**Mitigation:** Fresh signed-policy runs verify the configured authority EOA, EIP-712 signature, `ALLOW`, validity interval, record/intent IDs, chain, escrow, all roles, payer-bound job ID/nonce, exact amount/expiry, outcome, and deliverable before signer access. A second canonical timestamp gate runs before lock/broadcast. Resume accepts the exact journal-bound policy and may skip only current freshness; signature, `ALLOW`, digest, and job bindings remain mandatory. The original CLI-hash D3 files are explicitly historical and are never relabeled as signed-policy proof.

**Residual risk:** The retained auth-v1 artifacts configured the policy authority and payer as the same testnet EOA, so those historical signatures are not independent policy review. The two fresh Phase 4 policies are signed by the distinct configured policy-authority EOA and are exactly bound to their completed lifecycles, but EOA separation still does not prove independent people, organizations, review procedures, or production custody.

### T21 — Authority concentration mistaken for independent attestation

**Threat:** Reviewers infer organizational independence because evidence has both a policy signature and a producer signature/anchor, or because the active Phase 4 profile lists distinct public addresses.

**Mitigation:** Historical deployment configuration and auth-v1 reviewer records explicitly state that deployer, payer, policy authority, and evidence producer reused `0xB209dd7408FFD12A8575a429be946DeD5FbaD732` and had no separation of duties. The active Phase 4 profile separately binds policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34` and evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`, with canonical profile digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`. Reports describe this as configured cryptographic role separation only. UP IDs remain labels; distinct EOAs do not prove separate organizations, independent review, legal identity, or production governance.

**Residual risk:** Two live auth-v2 artifacts and canonical `XPA2` anchors now authenticate the exact fresh release/refund bindings under the named distinct EOAs. Repository-external exact-`0600` storage and on-chain EOA separation reduce accidental exposure and role confusion, but do not prove independent custody or organizations. Production design still requires durable authorization, separate operational control, rotation/revocation, and independent review.

### T22 — Mutable wallet preview, stale intent context, or duplicate send

**Threat:** Asynchronous preparation completes after the user changes intent/account/chain, decoded terms differ from the actual calldata, a cap changes, two send prompts race, or a rejected preview is silently retried.

**Mitigation:** The UI sets a synchronous preparation lock before awaiting the transaction factory and captures immutable intent ID/job ID context. The wallet client constructs and freezes the exact calldata, decoded terms, sender, target, chain, value, gas, fee, and maximum-cost preview. Before `eth_sendTransaction`, it revalidates the live chain, account, allowed role, reviewed escrow address/runtime-bytecode hash, and all caps. Only one preparation/send context may be active; each preview is consumed once, concurrent sends fail, and a wallet rejection consumes the preview without automatic retry. Account/chain/session changes invalidate prepared state and require a fresh preview.

**Residual risk:** A malicious browser extension or compromised wallet can still misrepresent its own prompt or sign a transaction the user did not intend. Users must compare the wallet prompt with the XPAYR preview; hardware-wallet and transaction-simulation guarantees are outside this MVP.

### T23 — Reviewer package expansion, secret leakage, or destructive replacement

**Threat:** A recomputed manifest smuggles extra files beyond the reviewed policy, a symlink/path escape includes private material, serialized raw transactions or secrets enter the export, or a build deletes an unrelated existing directory.

**Mitigation:** Verification loads the embedded allowlist and requires exact equality with the manifest for package/snapshot/network metadata, limits, boundaries, and ordered file set, in addition to per-file byte counts/digests, total bytes, and canonical manifest digest. Paths must be normalized allowlisted UTF-8 regular files with no symlink components or forbidden private/runtime classes. Content guards reject populated secret fields/assignments, private-key-shaped material, credential URLs, and raw signed transactions. Build occurs in a staged directory and verifies before replacement. Existing output is removed only if it independently verifies and has the same package and snapshot identity; otherwise the build fails without deleting it.

**Residual risk:** Pattern-based secret detection cannot identify every possible confidential value, and an allowlisted public document may still disclose non-secret operational details. Human review remains required before any publication; the package has not been published or submitted to GASOK.

### T24 — Profile configuration or bounded auth-v2 proof overclaimed

**Threat:** A checked-in active profile is cited without its signed/anchored artifacts, or the two completed auth-v2 records are generalized into organization-wide independence, production custody, or future-transaction authority.

**Mitigation:** The profile is validated as testnet-only, bound to chain `91342`, the retained escrow/deployment, distinct authority EOAs, operational-role separation, and canonical digest. Each auth-v2 verification additionally binds one fresh direct-`ALLOW` signed policy, exact lifecycle/file digests, terminal transaction, evidence-producer signature, and decoded canonical zero-value `XPA2` GIWA Sepolia anchor. The retained release/refund sidecars meet those checks and report `overall_authenticated=true`; documentation limits the result to their exact bindings.

**Residual risk:** Profile status `active` alone is still not proof. The two completed sidecars prove cryptographic control only for their exact testnet bindings; they do not prove independent people or organizations, factual correctness, production governance, or authority over a future lifecycle.

## Out of scope

- GIWA Mainnet and real-value assets.
- Canonical stablecoin settlement.
- Cross-chain bridge or cross-chain identity.
- Production authentication, tenancy, database durability, rate limiting, and key management.
- Automated KYC/AML, sanctions, credit, or legal decisions.
- Fully decentralized dispute resolution.
- Formal verification or an independent smart-contract audit.
- Production paymaster, account abstraction, session keys, or GIWA Wallet SDK integration.

## Phase 4 current evidence boundary

- [x] `phase4_sod_v1` is active and its public addresses/profile digest are checked in; its two authority key files are repository-external and owner-only `0600`.
- [x] Historical auth-v1 evidence remains unchanged and explicitly retains the original same-EOA authority concentration.
- [x] `live_wallet` rejects unauthenticated local approval/rejection and requires a direct `ALLOW` for execution bridging.
- [x] Wallet preparation provides immutable decoded calldata, captured intent/job context, synchronous prepare/send locks, pre-send account/chain/role/bytecode/cap revalidation, one-shot use, and no automatic retry.
- [x] Terminal wallet submission stores the exact hash immediately; canonical verification remains the sole completion authority and same-process browser reload can recover the pending hash.
- [x] Reviewer verification enforces exact embedded-allowlist/manifest equality and secret/symlink/raw-transaction/path/file-set guards; replacement refuses unverified or differently identified existing output.
- [x] Fresh live direct-`ALLOW` policy/lifecycle artifacts exist under the Phase 4 profile: release `5/5` canonical and refund `4/4` canonical.
- [x] Producer-signed, canonically anchored auth-v2 sidecars exist for both lifecycles and report `overall_authenticated=true`.
- [x] Bounded testnet funding needed for the evidence-producer's two zero-value anchors was recorded; the policy authority signs off-chain and required no transaction funding for these runs.
- [x] Payer/provider and authority signers were available only through repository-external exact-`0600` files during execution; no private key or raw signed transaction was persisted.

The Phase 4 live-evidence checks above are complete for the two retained jobs. This is bounded cryptographic role-separation evidence, not an independent-organization, production-governance, publication, or GASOK-submission claim.

## Required checks before any GIWA Sepolia transaction

- [x] Exact source and compiler settings are frozen in the deployment artifact: source SHA-256 `4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09`; artifact SHA-256 `4e89c6db0e9cf3bff175ffd0ec3e97206c72f8096e5bec549eaa10b800bcaed3`; solc `0.8.30`, optimizer runs `200`, EVM `paris`, metadata bytecode hash disabled.
- [x] Current validation passes the full Node suite `221/221`, retained contract tests pass Foundry `36/36`, and focused lifecycle hardening passes `47/47`, including positive and negative exact-`JobNotFound` recovery cases. The earlier evidence closure's `184/184` aggregate and focused policy/lifecycle/authentication `55/55` (`5/40/10`) remain historical only.
- [x] Chain ID `91342` was re-read from the selected standard RPC before and after execution; final live preflight is `36/36`.
- [x] Deployer/payer and provider public addresses were reviewed; UP IDs are labels only.
- [x] Signers are test-only; the key file remained outside the repository with exact `0600` permissions and key values were not logged or copied into evidence.
- [x] Balance and maximum native test ETH spend were checked before execution; each lifecycle job was capped at `1,000,000,000,000 wei`.
- [x] Dojang contract plus both distinct immutable constructor attesters (`UPBIT_KOREA` and `TESTNET_FAUCET`) match the dated network snapshot and deployed immutables.
- [x] Positive D1 binds the exact payer/provider addresses at canonical block `31153475`; D2/D3 reconstructed its digest `0x3f15cacd2a712f419d8fb220d6840bfe484504df5d0278a8e57da7a58020fe9c` before signer loading.
- [x] Both job creations bind the reviewed policy hash, exact amount, expiry, payer, provider, evaluator and outcome-specific deliverable hash.
- [x] The newer release/refund jobs also bind EIP-712-signed `ALLOW` policy artifacts with exact authority, validity, record/intent, chain, escrow, role, job, value, expiry, outcome, and deliverable checks.
- [x] The nonce is XPAYR-derived, caller job-binding overrides are rejected, and the contract re-derives the job ID from `msg.sender` plus nonce.
- [x] The canonical verifier independently re-fetched every receipt, transaction, block/head, decoded terminal event, and on-chain job state.
- [x] The release approval was a payer-signed on-chain action; the local address-only `HOLD` route was not used as chain authority.
- [x] Deployment and bounded test-ETH execution were separately approved by the user.
- [x] Runtime bytecode, immutable bindings, and the full creation input match the frozen artifact. Blockscout source visibility is `verified_blockscout` at `verified_partial_expected_no_cbor`: explorer/local source SHA-256 values match, while `PARTIAL=true` / `FULL=false` is expected because no CBOR metadata was deployed. Source verification is still not lifecycle authority.
- [x] No unresolved active deployment/lifecycle lock or resume lease exists; completed journals are retained as audit evidence.
- [x] Evidence output is secret-minimal and contains no private key or signed raw transaction.
- [x] Both newer lifecycle files have producer-signature and canonical-anchor auth-v1 sidecars; the same-EOA authority concentration and lack of separation of duties are explicit.
- [x] Both Phase 4 lifecycles bind the exact active profile digest, distinct policy/evidence authorities, signed-policy/lifecycle/file digests, producer signature, terminal transaction, and canonical zero-value `XPA2` anchor; both auth-v2 sidecars report `overall_authenticated=true`.
- [x] The exact checked-in `81`-file reviewer allowlist includes the Phase 4 policies, lifecycles, auth-v2 sidecars, bounded funding evidence, reviewer index, and lifecycle/reviewer tests; the final generated package was rebuilt and independently verified from that set.

## Review cadence

Revisit this model whenever the contract changes, an ERC-20 is added, approval authentication is implemented, a new Dojang schema/attester is allowed, GIWA Wallet or paymaster integration begins, or a Mainnet release is proposed.
