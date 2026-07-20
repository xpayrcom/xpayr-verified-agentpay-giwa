# Test and Evidence Report — XPAYR Verified AgentPay for GIWA

Report status: **RETAINED TESTNET SCOPE PASS; PHASE 4 LIVE SOD/AUTH-V2 EVIDENCE COMPLETE** — positive D1, source-visible `PARTIAL` no-CBOR D2 with exact creation/runtime proof, historical auth-v1 evidence, and a fresh separated-authority release/refund pair with producer-signed, canonically anchored auth-v2 `XPA2` sidecars are retained.
Scope: isolated local MVP targeting GIWA Sepolia (`giwa-testnet`, chain ID `91342`)
Asset: native test ETH only

This report is fail-closed. Operational phases `D1/D2/D3` map to evidence classes positive Dojang `D1`, GIWA deployment `G2`, and GIWA lifecycle `G3`. Each live claim below is backed by a retained artifact and canonical GIWA Sepolia transaction, receipt, block, event and state checks where applicable.

The previously approved testnet execution and auth-v1 closure are complete and unchanged. The contract was deployed once. Blockscout exposes the matching retained source and reports `Pass - Verified` / `is_verified=true`, while its v2 level is the expected `PARTIAL` (`is_partially_verified=true`, `is_fully_verified=false`) because this deployment intentionally has no CBOR metadata. Exact source SHA, full creation input, and immutable-aware runtime parity are independently retained. The original release/refund D3 files remain historical CLI-hash/checksum-only records, and the later auth-v1 pair remains under the disclosed same-EOA model. Phase 4 then executed a fresh `RELEASED` lifecycle and a separate `REFUNDED` lifecycle under `phase4_sod_v1`; each has an EIP-712 signed `ALLOW` policy and an auth-v2 sidecar binding the distinct policy authority, distinct evidence producer, profile digest, lifecycle digest, producer signature, and canonical zero-value `XPA2` self-anchor. Participant and authority signers were loaded only from repository-external exact-`0600` files; private keys and raw signed transactions were not printed or persisted. The local-fixture video and deterministic wallet stub remain local presentation/test evidence only. Public repository/demo publication and GASOK submission are still not completed.

## Run metadata

| Field | Value |
|---|---|
| Report date | 2026-07-20 |
| Git commit | Uncommitted workspace snapshot; no commit claimed |
| Current Phase 4 test observation | Full Node suite `221/221`; focused lifecycle hardening `47/47` |
| Target network | GIWA Sepolia, chain ID `91342` |
| Demo asset | Native test ETH only |
| Deployment record | `deployed_testnet`; runtime, immutables and exact creation input verified; source-visible `verified_blockscout`; level `verified_partial_expected_no_cbor`; local/explorer source SHA-256 equal |
| Contract address / deployment transaction | `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53` / `0x1fda4860da932d6beab0bedd10046d4dc01a21908c5a2ce969a197bce0006908` |
| Deployment block / actual gas cost | `31153615`, hash `0x62d8f330609beb986c8795882c926d535a68357e1b6b3b179b92666b620de0c9`; `1,709,513,980,335 wei` |
| Signer / transaction boundary | Test-only payer/provider and separate policy/evidence signers loaded from repository-external exact-`0600` files; no secret or signed raw transaction retained |
| Positive live Dojang proof | `evidence/d1/giwa-sepolia-d1-xpayr-mbo-20260719T220311Z.json`; block `31153475`, hash `0xc89cddeed490aaf8e95b099d6677f4c3b72bf24dcfa1898224871e60cfe1a624`, digest `0x3f15cacd2a712f419d8fb220d6840bfe484504df5d0278a8e57da7a58020fe9c`; payer/provider positive |
| Contract tests | Foundry `36/36` |
| Contract compiler/artifact | Foundry/solc-js `0.8.30`; optimizer `200`; EVM `paris`; metadata hash none/CBOR false; warnings `0`; ABI `54`; creation/runtime `7,871/7,527` bytes |
| Contract source SHA-256 | `4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09` |
| Contract artifact SHA-256 | `4e89c6db0e9cf3bff175ffd0ec3e97206c72f8096e5bec549eaa10b800bcaed3` |
| Source-level recheck | `evidence/deployment/giwa-testnet-source-verification-level-recheck-20260720T005420Z.json`; canonical digest `0x00f73d87a383e425f2c179d776dc7f76c3fb9b13bd0c9374d624f125593497ca`; file SHA-256 `345bcd3f8d17aa8d750264df135e4c6e189de0fc164424af57d3631b51539986` |
| Sealed reviewer index | `evidence/giwa-sepolia-reviewer-index-20260720.json`; canonical payload digest `0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5` |
| Offline / live read-only preflight | `31/31` / `36/36`; final rerun canonical/Flashblocks heads `31164630/31164630` |
| Reviewer export | Exact `81`-file allowlist includes the Phase 4 policy/lifecycle/auth-v2 set, bounded funding evidence, reviewer index, and lifecycle/reviewer tests; final post-documentation build and independent verification passed |
| Retained prior backend/domain/API/syntax aggregate | `184/184`; `0` fail/skip/todo; not the final Phase 4 aggregate |
| Retained prior JSON/integrity reconciliation | JSON parse `24/24` (`22` evidence, `2` config); source-level/reviewer canonical digests and all referenced file SHA-256 values matched at the prior closure |
| Historical lifecycle artifacts | Original release digest `0x38a655e5642ebbc035d275d1c50ac2a90b83f5a3eddf87d49a66627a1e1acc49`; original refund digest `0xec8a4d32d0fde921f8295d0530dfe6057757e5d884e5f90a0d653e22e930743b`; policy origin `not_provided_cli_hash_only`; producer `not_provided` |
| Signed-policy lifecycle artifacts | Release digest `0x80fb1c283d09476bf8caa78c097af17666e9f275688a8b9e628122a3c276b903`; refund digest `0x306e041fa5ad2ee337dccc84fe86f3f3973e940d6a1dae410b725a0c932374a3` |
| Authentication overlays | Release anchor `0x6e1cbe55b2a964388339a1f2912953707a0881c289e2579c92f384384909da5d`; refund anchor `0xbef25cd50a0d5582718a20b818bba43acd587ea69758005689362b2fc82f2be3`; both signature/canonical-anchor verified and `overall_authenticated=true` |
| Historical retained authority model | Deployer, payer, policy authority and evidence producer used the same testnet EOA; historical separation of duties `false` |
| Phase 4 authority profile | `phase4_sod_v1`, status `active`, digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`; policy `0x89128251A3B46328Dc89A13B58C1339217B2fD34`; evidence `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45`; separation-of-duties checks true |
| Phase 4 release lifecycle | `evidence/lifecycle/phase4-sod-release-20260720t134245599z-efaa5ce2-lifecycle.evidence.json`; job `0x9df3f7d659991dfa95ac7ca89e4c531b09a497d65070cd4856db4a9f51eac740`; lifecycle digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc`; terminal tx `0x66695b08f17e9be7838ec1ab1cb08bb25259e0a9dc496ee1dc1070eca554c92e`; `5/5` canonical, `RELEASED`, `payment_completed=true` |
| Phase 4 refund lifecycle | `evidence/lifecycle/phase4-sod-refund-20260720t134245599z-cd885085-lifecycle.evidence.json`; job `0x774f6daa21eb143b12f03e964b21ec5863f509f5f96b0f4b6ace50675204cff6`; lifecycle digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e`; terminal tx `0x3f58ca24da8c6f5a729212207feeb14514dbb624be6ddd21e2189230137d6355`; `4/4` canonical, `REFUNDED`, `payment_completed=false`, `refunded=true` |
| Phase 4 auth-v2 overlays | Release sidecar digest `0xc845c36b59294271b91ac5cf4780e4f276aa362fe7ad7f0e61c0cec571e7ded7`, anchor `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9`; refund sidecar digest `0xffd002fbc16b56752559a2483c7bacd5766fffc2ad53a61f7e0db8774053a1d4`, anchor `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650`; both `overall_authenticated=true` |
| Recovery state | Lifecycle/authentication journals retained; no active lifecycle/authentication lock or lease |
| Retained fixture UI/browser smoke | `HOLD`; desktop `1440x1100`, mobile `390x844`; overflow `0` on both; console/page errors, request failures, HTTP `>=400` responses all `0`; historical fixture result |
| Phase 4 live-wallet smoke | Deterministic EIP-1193 stub, direct `ALLOW`, bounded decoded `createJob` preview and cancel; `eth_sendTransaction=0`; no real wallet transaction or new chain proof |
| UI screenshots | `artifacts/ui/agentpay-desktop.png`; `artifacts/ui/agentpay-mobile.png` |
| Video artifact | `artifacts/demo/xpayr-giwa-agentpay-local-fixture.mp4`; SHA-256 `3d80fda5ee8064abd499b1a5d8fa27739f8217aa33d84b7bfa3a298531a6f1e5`; H.264 video-only/no-audio; `1280x720`; `25` fps; `125.960` s; `2,069,692` bytes; not published/not chain proof |
| Local evidence | `valid=true`; `overall_pass=false`; unauthenticated/local-only |

## Retained result summary and Phase 4 checkpoint

Current Phase 4 results are listed first. Rows labeled retained preserve the earlier chain-evidence closure and are not substituted for current source validation. The post-documentation full Node and regenerated-package checks are recorded below.

| Suite | Intended command or check | Evidence level | Current status |
|---|---|---|---|
| Current Node validation | full suite plus focused lifecycle suite under Node `24.14.0` | `L1` local domain | Current `PASS`: full `221/221`; focused lifecycle `47/47` |
| Retained full Node domain/API/source suite | Node `24.14.0` prior full test | `L1` local domain | Prior `PASS`: `184/184`, `0` fail/skip/todo |
| Solidity escrow | `forge test -vv` | `L2` local EVM | `PASS`: `36/36` |
| Contract artifact | compile, source/artifact SHA-256, ABI and bytecode inspection | `L2` local artifact | `PASS`: Foundry/solc-js `0.8.30`, optimizer `200`, EVM `paris`, metadata hash none/CBOR false, ABI `54`, `7,871/7,527` bytes |
| Offline preflight | `npm run preflight -- --offline` | Local config/source | `PASS`: `31/31` |
| Live read-only preflight | `npm run preflight` | `G1` GIWA RPC read | `PASS`: `36/36`; chain `91342`, canonical/Flashblocks heads `31164630/31164630`, Dojang/EAS/escrow code present |
| D1 recorder and live artifact | EIP-1898 same-block record and reconstruction | `D1` | `PASS`: both exact roles positive through official `TESTNET_FAUCET` attester; artifact and reconstruction digests equal |
| D2 deployment/source | retained-block D1 reconstruction, signer binding, canonical receipt, code/immutable/runtime/creation-input checks and independent Blockscout verification | `G2` | `PASS`: contract deployed in block `31153615`; exact creation/runtime proof; source-visible `Pass - Verified`, expected no-CBOR `PARTIAL` level |
| Signed-policy D3 release | signed `ALLOW` binding plus create/fund/submit/approve/release and canonical terminal verification | `G3` + signed policy | `PASS`: `5/5` canonical steps; job `0xa3e3…d0a9`; terminal tx `0xacc9…7ce2`; `payment_completed=true` |
| Signed-policy D3 refund | signed `ALLOW` binding plus create/fund/cancel/claim-refund and canonical terminal verification | `G3` + signed policy | `PASS`: `4/4` canonical steps; job `0x5f7f…baf5`; terminal tx `0x12b6…fa6`; `payment_completed=false` |
| D3 resume safety | strict-prefix canonical reconciliation and idempotent finalization | Local + live recovery | `PASS`: focused lifecycle tests `47/47`; transient block visibility fails closed; a visible unreceipted planned transaction causes zero duplicate broadcasts and releases only the owned resume lease; later receipt visibility reconciles the exact hash; absent transactions can use exact same-hash recovery only within current gas/fee caps; exact `JobNotFound(expectedJobId)` is accepted only for a legitimate pre-create state |
| Policy-origin proof | EIP-712 signature, freshness, `ALLOW`, record/intent and exact job binding | Signed policy | `PASS`: release/refund artifacts verified; policy tests `5/5` |
| Producer authentication/anchor | EIP-712 producer signature plus canonical zero-value `XPA1` self-transaction | Auth-v1 | `PASS`: both sidecars `overall_authenticated=true`; auth tests `10/10`; arbitrary typed-policy, `HOLD`, legacy-upgrade and policy-origin substitution attempts fail closed; idempotent preflight broadcast count `0` |
| Phase 4 signed-policy D3 release | profile-bound signed `ALLOW` plus create/fund/submit/approve/release | `G3` + signed policy + SoD | `PASS`: job `0x9df3…c740`; lifecycle digest `0x9558…1fbc`; terminal tx `0x6669…c92e`; `5/5` canonical; `RELEASED`, `payment_completed=true` |
| Phase 4 signed-policy D3 refund | profile-bound signed `ALLOW` plus create/fund/cancel/claim-refund | `G3` + signed policy + SoD | `PASS`: job `0x774f…cff6`; lifecycle digest `0x04a6…447e`; terminal tx `0x3f58…6355`; `4/4` canonical; `REFUNDED`, `payment_completed=false` |
| Phase 4 producer authentication/anchor | distinct producer EIP-712 signature plus canonical zero-value `XPA2` self-transaction | Auth-v2 | `PASS`: release/refund sidecars bind the exact profile/policy/lifecycle/file digests; anchors `0x4463…8ba9` / `0x8696…7650`; both `overall_authenticated=true` |
| Browser flow | Desktop/mobile local smoke | `U1` local UI | `PASS`: `HOLD`; `1440x1100` and `390x844`; overflow `0`; console/page errors `0`; request failures `0`; HTTP `>=400` `0`; chain controls gated |
| Local demo video | SHA/media/decode/frame inspection | Local presentation artifact | `PASS`: exact SHA/media facts reconciled; clean decode; three sampled frames visually checked; captioned silent fixture only |
| GIWA Sepolia deployment/lifecycle | Approved D2/D3 execution commands | `G2`/`G3` | `PASS`; deployment plus release/refund evidence retained |
| Positive live Dojang read | Block-hash-pinned aggregate and same-block EAS/attester validation | `D1` | `PASS`; exact payer/provider artifact retained |
| Evidence generation/verification | regenerated local JSON plus internal verifier | `L1` local evidence | `PASS` for local classification: `valid=true`, `overall_pass=false`; unauthenticated and not chain proof |
| Live-wallet authorization boundary | API/runtime and deterministic browser instrumentation | Local implementation | `PASS` at implementation level: live local `approve`/`reject` return `403`; live `bridge` accepts direct `ALLOW` only; preview is immutable and intent/job-bound |
| Wallet terminal recovery | Immediate `/confirmations/wallet-submitted` hash registration plus canonical retry | Local implementation | `PASS` at implementation level: exact wallet-returned hash is recorded in the in-memory intent before Flashblocks and can be rehydrated after a browser reload in the same server process; it is not durable across server restart and never grants completion authority |
| Phase 4 separated authorities/auth-v2 | Active sealed authority profile, fresh lifecycles, and canonical `XPA2` anchors | `G3` + Auth-v2 | `PASS`: distinct policy/evidence EOAs, two completed lifecycles, two verified sidecars, two canonical anchors; cryptographic role separation only, not organizational independence |
| Reviewer package hardening | Embedded allowlist/manifest/file-set verification and safe replacement checks | Local reviewer tooling | `PASS`: the exact checked-in `81`-file allowlist includes the Phase 4 policy/lifecycle/auth-v2 artifacts, funding evidence, reviewer index, and lifecycle/reviewer tests; final post-documentation package build and independent verification succeeded |

## Current evidence outcome

| Item | Result |
|---|---|
| Overall approved testnet scope | `PASS`; D1, source-visible `PARTIAL` no-CBOR G2 with exact bytecode proof, historical auth-v1 records, and Phase 4 signed-policy release/refund G3 plus auth-v2 overlays retained; production, publication and submission remain outside this result |
| Highest retained chain evidence | `G3` canonical lifecycle plus profile-bound, producer-signed/on-chain-anchored auth-v2 `XPA2` overlay |
| GIWA Sepolia deployment/lifecycle | One `G2` deployment and two separate `G3` terminal paths |
| Positive live Dojang | Positive `D1` for exact payer/provider at retained canonical block |
| Authenticated chain actions | Sender-bound EIP-1559 transactions from the configured test-only signers; local address-only UI action is still not wallet proof |
| Deployment state | `deployed_testnet` |
| Local evidence artifact | `evidence/local-domain-demo.json`; current local-only artifact |
| Public/reviewer evidence | Blockscout source and transaction URLs exist; sealed local reviewer index exists; no public source repository/demo publication or GASOK submission |

The local artifact has internal digest `0x7f21b84c7f592d52b65a502aed4b18b0af56b6671bc341924f37b5ca466e67ba` and file SHA-256 `74d53739e635a6dceac90089a0298a55c3699cd558584c7c8e34a516329b461f`. It has transaction hash null and labels fixture lifecycle/expiry/revocation metadata `not_applicable`. It correctly preserves false values for absent chain, wallet-authentication, and live-identity proof. `valid=true` means internal checksum/schema checks pass; `producer_authenticated=false`, `non_repudiation=false`, and `overall_pass=false` preserve the authenticity and chain-evidence boundary.

## Contract hardening verified by the retained contract run

The reconciled `36/36` contract run covers these properties:

- [x] Constructor rejects zero, duplicate, or otherwise invalid Dojang attester IDs.
- [x] `UPBIT_KOREA` and `TESTNET_FAUCET` remain distinct immutable accepted attesters.
- [x] Payer, provider, and any configured evaluator are subject to mandatory Dojang checks; there is no optional/legacy bypass.
- [x] Job creation binds payer, provider, evaluator, `expectedAmount`, `expiresAt`, and `policyDecisionHash`.
- [x] XPAYR derives the trusted `jobNonce`; callers cannot override `jobId/jobNonce`; the contract requires `jobId == keccak256(abi.encode(msg.sender, jobNonce))`.
- [x] Funding rejects both underpayment and overpayment; only exact `expectedAmount` succeeds.
- [x] Unauthorized fund, submit, approve/release, and dispute-resolution paths are exercised and revert.
- [x] Nonce/preemption and replay paths cannot replace or consume a different approved intent/job.
- [x] Successful release, cancel/refund, expiry/refund, dispute release/refund, and timeout recovery paths remain valid.
- [x] Double funding and terminal release fail; the reentrant refund attempt is blocked.
- [x] Reentrancy and rejecting-recipient paths do not create a false terminal state or corrupt accounting.
- [x] Required events expose deterministic fields for canonical evidence mapping.
- [x] Final compiler version, source SHA-256, artifact SHA-256, ABI entry count, and creation/runtime bytecode sizes are captured from the same terminal build.

Terminal artifact facts:

- Foundry/solc-js compiler: `0.8.30`;
- optimizer: enabled, runs `200`; EVM target: `paris`;
- metadata: `bytecodeHash=none`, `appendCBOR=false`;
- source SHA-256: `4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09`;
- artifact SHA-256: `4e89c6db0e9cf3bff175ffd0ec3e97206c72f8096e5bec549eaa10b800bcaed3`;
- ABI entries: `54`;
- creation/runtime bytecode: `7,871/7,527` bytes.

## Backend and API hardening verified by the current Node observation

- [x] Only `giwa-testnet` and chain ID `91342` are accepted.
- [x] Wrong chain, malformed manifest, missing deployed code, and unsafe capability claims fail closed.
- [x] Dojang uses the configured contract and exactly the two immutable-compatible attester IDs; caller-supplied identity verdicts are rejected.
- [x] Dojang queries live `eth_chainId`, fails closed unless it is `91342`, and retains observed chain ID plus block number/hash.
- [x] Aggregate Dojang `isVerified=false`, unknown/unavailable, malformed, wrong-attester, and unpinned results are rejected. The lifecycle adapter keeps unqueried EAS metadata labeled `not_separately_queried`; the D1 recorder separately validates UID/EAS recipient, schema, same-block official attester, revocation, expiration, issue time, and decoded `bool=true` for positive results.
- [x] Policy returns exactly one of `ALLOW`, `HOLD`, or `DENY`.
- [x] `DENY` cannot produce an escrow request.
- [x] The exact amount, expiry, network, roles, destination, job ID, and policy decision are bound against substitution.
- [x] An intent/job cannot be consumed or preempted through nonce/replay manipulation.
- [x] Zero payer/provider addresses and zero job nonce are rejected before RPC mutation; refund rejects a non-zero deliverable hash.
- [x] A local `HOLD` approval is explicitly confined to fixture mode and classified as address-only state demonstration, not wallet authentication.
- [x] Live mode rejects unauthenticated local `approve` and `reject` with HTTP `403`; live `bridge` requires the original direct `ALLOW` and rejects a manually overridden `HOLD`.
- [x] Live wallet preparation binds an immutable decoded preview to the active intent/job, reviewed deployment, role, chain, runtime bytecode, value, gas and fee caps; concurrent preparation and context substitution fail closed.
- [x] A terminal wallet hash is recorded immediately through `confirmations/wallet-submitted`, then rehydrated after a browser reload in the same server process for canonical retry. This in-memory record is not durable across server restart and is pending/recovery metadata, never completion proof.
- [x] Live D3 actions were authorized by sender-bound test-wallet signatures and exact nonces; the local address-only API action was not used as chain authority. Production wallet/session authorization remains out of scope.
- [x] Flashblocks can produce only optional client-reported observed/pending state and never terminal completion.
- [x] Canonical confirmation independently re-fetches receipt, transaction, receipt block, and head through the canonical RPC.
- [x] Canonical confirmation independently queries live `eth_chainId`, fails closed unless it is `91342`, and retains portable chain ID, contract, transaction sender/target/hash, block number/hash, receipt status, and explorer URL facts.
- [x] Canonical confirmation recognizes release/refund/dispute-resolution/timeout-refund calldata, validates outcome-specific `JobReleased`/`JobRefunded`/`DisputeResolved` events, reads block-hash-pinned on-chain job state, and binds contract, job, outcome, policy, roles, exact amount, expiry, mandatory verification, zero balance, receipt status, canonical block hash, and confirmation depth.
- [x] D3 requires the canonical job-state deliverable hash to equal the release input exactly; refund requires and records zero. New runs verify a signed policy artifact before signer access and bind its authority, `ALLOW`, validity, record/intent IDs, network, escrow, roles, job, amount, expiry, outcome, and deliverable. The original D3 pair remains explicitly `not_provided_cli_hash_only`.
- [x] A verified `RELEASED` outcome sets `completed=true`; a verified `REFUNDED` outcome is terminal with `refunded=true` and always keeps `completed=false`.
- [x] Client-supplied receipt/transaction/head/event fields cannot substitute for canonical RPC facts.
- [x] Evidence rejects secrets, unnecessary personal data, and Arc identifiers, and preserves absent proof as false.
- [x] D2 binds a validated positive D1 path/digest and confirmed payer/deployer/provider addresses before secret loading; signer address must match. Initial journal creation is real `wx` exclusive, updates verify ownership, and a concurrency test permits exactly one owner.
- [x] Deploy evidence retains canonical receipt block/hash/confirmation count, artifact SHA, effective gas price, actual cost, runtime comparison, and immutables. Blockscout source visibility and its expected no-CBOR `PARTIAL` classification are separately evidenced and never inferred from runtime proof; exact deployment input parity is independently recorded.
- [x] Execute-only secret loading accepts only a current-user-owned absolute real path outside the whole repository, with no symlink/hard-link, exact `0600`, supported unique variables, and no ambient collision; read-only preflight does not load it.
- [x] D2 and D3 independently reconstruct the recorded D1 artifact from canonical RPC at its retained block and require exact canonical parity before signer loading. D3 also revalidates the deployment transaction/receipt/block/runtime/immutables, uses a global execution lock plus one exclusive per-run journal and resume lease, verifies every lifecycle step's canonical transaction/receipt/block/calldata/value/nonce and actual confirmations, and enforces bounded job/gas/total costs. Resume accepts only a strict canonical prefix, exact nonce continuity and block-hash-pinned state, then broadcasts only the missing suffix; evidence/journal finalization is idempotent.
- [x] A zero-step `ready_before_first_broadcast` or exact validated prepared-create resume maps absence to pre-create status only when pinned RPC revert bytes exactly equal `JobNotFound(expectedJobId)`. Wrong job IDs, trailing bytes, missing/malformed data, inconsistent zero-step statuses, any later-step `JobNotFound`, and pinned-head changes retain the lease and broadcast nothing; the exact legitimate pre-create case exercises the positive cleanup path.
- [x] Auth-v1 verifies the source lifecycle file SHA-256/digest, signed-policy digest, configured producer EOA and EIP-712 signature, then decodes and canonically verifies the zero-value `XPA1` anchor self-transaction. Resume/complete preflight is idempotent and broadcasts nothing once the sidecar is complete.
- [x] Auth-v2 additionally binds the exact `phase4_sod_v1` digest, distinct policy/evidence authorities, policy envelope, lifecycle/file digests, producer signature, terminal transaction, and decoded canonical `XPA2` self-anchor. Both Phase 4 sidecars report every required check true and `overall_authenticated=true`.

## UI smoke results and remaining gaps

- [x] The retained fixture decision path is `HOLD`; fixture local approval remains explicitly non-authoritative.
- [x] The Phase 4 `live_wallet` smoke uses a deterministic EIP-1193 stub and direct `ALLOW`, prepares an immutable decoded bounded `createJob` preview, cancels it, and records `eth_sendTransaction=0`.
- [x] The live-wallet smoke exercises account-change invalidation and preview context locking; it is not a real wallet signature, broadcast, receipt, Dojang proof, or new `G3` lifecycle.
- [x] The retained local-fixture smoke was captured before deployment and correctly kept wallet/chain controls disabled while `deployment.status == not_deployed`; it is not evidence of the later live execution UI.
- [x] That local-fixture `READY` state explicitly described a local intent and said that no chain job was created.
- [x] Repeat approval is disabled.
- [x] Downloaded evidence preserves the unauthenticated, local-only, non-chain-proof boundary.
- [x] Desktop `1440x1100` and mobile `390x844` each have horizontal overflow `0`.
- [x] Console errors `0`, page errors `0`, request failures `0`, and HTTP responses `>=400` `0`.
- [x] The Phase 4 live-wallet smoke uses keyboard `Tab`/`Space` to cancel the prepared preview and verifies focus returns to the originating action. This is a bounded local interaction check, not a complete accessibility audit.
- [ ] The final smoke did not separately exercise a `DENY` browser action or measure the visual pending-versus-confirmed distinction; backend/finality enforcement is covered by the Node suite, not asserted here as UI evidence.

## Evidence classification

| Code | Evidence class | Minimum required material | Permitted claim |
|---|---|---|---|
| `L1` | Local domain | command, version, exact assertions, labeled fixtures | local policy/adapter behavior |
| `L2` | Local EVM | reconciled source/artifact hashes, compiler settings, command, exact tests | local contract behavior |
| `G1` | GIWA RPC preflight | endpoint role, chain ID, block, code read | target endpoint/config connectivity |
| `G2` | GIWA Sepolia deployment | contract, transaction, successful receipt, verified constructor inputs, bytecode match | testnet contract deployed |
| `G3` | GIWA Sepolia lifecycle | authenticated wallet actions plus fund/submit/release or refund transactions/events/state | testnet escrow path executed |
| `D1` | Positive live Dojang read | configured contract, subject, retained block number/hash, aggregate `isVerified=true`, UID/EAS metadata, and same-block official attester-registry match | positive address signal and attestation validity were observed at the pinned block; not wallet control, KYC/AML, or legal identity |
| `S1` | Signed XPAYR policy | exact artifact digest, configured authority, EIP-712 signature, `ALLOW`, validity and job binding | named testnet EOA authorized that exact policy/job binding |
| `A1` | Authenticated lifecycle overlay | source file SHA/digest, signed-policy digest, EIP-712 producer signature, canonical decoded anchor transaction | named testnet EOA signed and anchored the exact artifact binding |
| `A2` | Profile-bound authenticated lifecycle overlay | `A1` material plus exact active authority-profile digest, distinct policy/evidence EOAs and decoded canonical `XPA2` anchor | configured distinct testnet EOAs signed policy and evidence roles for the exact binding; not organizational independence |
| `U1` | Local browser | viewport, screenshot, accessibility/error/network report | local UI behavior |
| `P1` | Public/reviewer proof | stable URLs and reproducible instructions | externally inspectable demo |

Rules:

- `L1`/`L2` never imply `G2` or `G3`.
- `G1` never implies deployment, transaction success, or a positive Dojang result.
- `G3` without `D1` does not prove a live verified-address path.
- A caller-supplied address or Dojang fixture is local evidence, not authenticated wallet proof or `D1`.
- Flashblocks observation is supporting UX metadata, not `G3` completion.
- Arc transaction, contract, or evidence is invalid for every GIWA evidence class.

Schema map: local intent/session envelope `xpayr.giwa.verified-agentpay.evidence.v1`; D1 `xpayr.giwa.dojang-d1-evidence.v1`; D2 `xpayr.giwa.agentpay.deployment-evidence.v1`; signed policy `xpayr.giwa.agentpay.policy-evidence.v1`; D3 `xpayr.giwa.agentpay.lifecycle-evidence.v1`; auth overlay `xpayr.giwa.agentpay.lifecycle-evidence-authentication.v1` or `.v2`. Checksums remain reproducibility fields; only the explicitly verified signature/anchor layers add EOA-control evidence.

## GIWA Sepolia evidence record

Recorded after separately approved execution:

| Field | Recorded value |
|---|---|
| Standard RPC chain ID | `91342`; final live preflight `36/36` |
| Read-only heads | Canonical `31164630`; Flashblocks `31164630` at final rerun snapshot |
| Escrow contract / code | `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`; code size `7,527` bytes; balance `0` |
| Constructor attesters | Distinct immutable `UPBIT_KOREA` and `TESTNET_FAUCET`, getter-verified |
| Deployment transaction / receipt | `0x1fda4860da932d6beab0bedd10046d4dc01a21908c5a2ce969a197bce0006908`; success at block `31153615` |
| Source verification / bytecode match | Blockscout `Pass - Verified`, `is_verified=true`, `PARTIAL=true`, `FULL=false`; GUID `7b0630cbb92be8e11512cb331b8d1aef94ceec536a5d5b82`; expected no-CBOR classification; local/explorer source SHA-256 equal; exact `7,967`-byte creation input SHA-256 `36bb86676e4f148342e23177c205bda68bf70b595b48c1a2ad021d0a288ece37`; runtime/getter checks true; level-recheck artifact `evidence/deployment/giwa-testnet-source-verification-level-recheck-20260720T005420Z.json` |
| Positive Dojang result and retained block | Exact payer/provider positive at block `31153475`; digest/reconstruction digest `0x3f15cacd2a712f419d8fb220d6840bfe484504df5d0278a8e57da7a58020fe9c` |
| Signed release job / terminal | Job `0xa3e3f4a98d9a6c28c6be6f42159eb8950c347b5ca520636cf16c99e6ed6cd0a9`; `1,000,000,000,000 wei`; tx `0xacc9adae988c5094459dec4ff097b4641b608de03a6f0ab820367a6521c87ce2`; `RELEASED`, `payment_completed=true` |
| Signed refund job / terminal | Job `0x5f7f7075eac19ed40139af4de22d905d34f67303a8d7564599ea86c480dcbaf5`; `1,000,000,000,000 wei`; tx `0x12b65cd22071206fc9a0bfdf62efad91a1eee526fb83cb21dfa0f8fb99104fa6`; `REFUNDED`, `payment_completed=false` |
| Canonical reconciliation | Release `5/5`, refund `4/4`; all receipt/transaction/block/calldata/value/nonce/event/state checks passed |
| Recovery state | Completed lifecycle/authentication journals retained; no active lifecycle/authentication lock or lease; reconciled stale refund lease preserved under its explicit audit filename |
| Flashblocks observation | Used only as non-authoritative pending/read signal; canonical RPC is terminal authority |
| Local evidence JSON / checksum | `evidence/local-domain-demo.json`; internally `valid=true`, `overall_pass=false`; no chain proof |
| Producer authenticity proof | Auth-v1 release/refund sidecars verified; anchors `0x6e1c…da5d` and `0xbef2…2be3`; claim limited to configured testnet EOA control |
| Phase 4 release / auth-v2 | Job `0x9df3f7d659991dfa95ac7ca89e4c531b09a497d65070cd4856db4a9f51eac740`; policy digest `0xe1ca302e6b264b18c9057cfb9913b511909aaf447b5fbb1b2d168d344b0b14d6`; lifecycle digest `0x9558da912bcba7998a65585aeaa61f2b11edd1e45bbfdbb42386f090542f1fbc`; [terminal tx](https://sepolia-explorer.giwa.io/tx/0x66695b08f17e9be7838ec1ab1cb08bb25259e0a9dc496ee1dc1070eca554c92e); auth-v2 digest `0xc845c36b59294271b91ac5cf4780e4f276aa362fe7ad7f0e61c0cec571e7ded7`; [`XPA2` anchor](https://sepolia-explorer.giwa.io/tx/0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9), block `31211004`; `overall_authenticated=true` |
| Phase 4 refund / auth-v2 | Job `0x774f6daa21eb143b12f03e964b21ec5863f509f5f96b0f4b6ace50675204cff6`; policy digest `0x7eb13796f588f77d9115a851b87b4e02419b1e21a40dc04df6df7492b4a1e0cd`; lifecycle digest `0x04a6552104ef92927ed7327669aa20f060672036cd3a3e2d794cdd13e938447e`; [terminal tx](https://sepolia-explorer.giwa.io/tx/0x3f58ca24da8c6f5a729212207feeb14514dbb624be6ddd21e2189230137d6355); auth-v2 digest `0xffd002fbc16b56752559a2483c7bacd5766fffc2ad53a61f7e0db8774053a1d4`; [`XPA2` anchor](https://sepolia-explorer.giwa.io/tx/0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650), block `31211036`; `overall_authenticated=true` |
| Final canonical receipt re-read | Head `31164668`; signed release/refund and both anchors status `1`, block/transaction membership true; confirmations `4191/3824/3754/3692` |
| Explorer links | Contract, deployment, release and refund transaction URLs recorded in D2/D3 artifacts |

## Evidence checksum and authenticity boundary

Base evidence schemas use canonical JSON and SHA-256 as deterministic checksums. This supports reproducibility and can detect accidental or out-of-sync mutation when the result is compared with a separately trusted checksum.

A checksum alone does **not** authenticate the producer or prevent recomputation. The retained auth-v1 sidecars add an EIP-712 producer signature and canonical GIWA anchor over the exact source/policy/file binding under the historical same-EOA model. The Phase 4 auth-v2 sidecars additionally prove control of distinct configured policy-authority and evidence-producer EOAs for the exact profile/policy/lifecycle/file bindings and canonical `XPA2` anchors. Neither version proves legal identity, independent audit, factual correctness of upstream claims, legal non-repudiation, separate organizations, or production key governance.

The regenerated local evidence verifies:

- [x] `network_key == giwa-testnet` and `chain_id == 91342`.
- [x] Asset is native test ETH and is never labeled as stablecoin or real-value production money.
- [x] Policy decision/hash, exact amount, expiry, roles, job ID, and execution binding agree for the local fixture.
- [x] Identity mode clearly labels the artifact `demo_fixture`; it does not claim positive `D1` evidence.
- [x] Separate D3 artifacts provide real canonical receipt/transaction/block/head, terminal calldata, outcome event and on-chain-state confirmation. The local fixture file itself remains non-chain proof.
- [x] Flashblocks is never used as terminal completion.
- [x] Absent deployment, wallet authentication, transaction, or positive Dojang evidence remains false and keeps `overall_pass=false`.
- [x] No secret, raw deliverable, unnecessary personal data, fabricated explorer link, or Arc identifier is present.
- [x] Internal digest is `0x7f21b84c7f592d52b65a502aed4b18b0af56b6671bc341924f37b5ca466e67ba`; file SHA-256 is `74d53739e635a6dceac90089a0298a55c3699cd558584c7c8e34a516329b461f`; verifier returns `valid=true`, `producer_authenticated=false`, and `non_repudiation=false`.
- [x] Producer authentication remains absent in the local fixture and original D3 pair; that historical boundary is preserved.
- [x] Separate auth-v1 sidecars authenticate and anchor only the two newer signed-policy lifecycle files.
- [x] Separate auth-v2 sidecars authenticate and anchor the two Phase 4 profile-bound lifecycle files with distinct policy/evidence EOAs.

## Remaining boundaries at this checkpoint

- The original D3 pair and local fixture remain checksum-only; the newer proof set does not retroactively change them.
- The retained signed-policy/auth-v1 D3 pair used the historical same-EOA model; those artifacts are not retroactively upgraded by the Phase 4 profile.
- Phase 4 profile-bound release/refund and both auth-v2 anchors are complete; this proves cryptographic control of the named distinct testnet EOAs for the exact retained bindings, not independent organizations or production custody.
- Signed-policy/auth-v1 proves control of the historical configured same EOA only. Auth-v2 proves the configured separated EOA roles for its two fresh artifacts; neither version establishes XPAYR legal/organizational identity, independent human review, or legal non-repudiation.
- The exact checked-in `81`-file reviewer allowlist includes the Phase 4 policy/lifecycle/auth-v2 artifacts and their supporting funding/test files. The final reviewer package was rebuilt and independently verified; its manifest is authoritative for the generated digest, byte count, and exact file hashes.
- UP IDs are readable labels only and were not used as authorization proof.
- The Phase 4 smoke includes the bounded keyboard preview-cancel/focus-restoration check above; it is not a complete accessibility audit, and the retained local video is not live-chain UI proof.
- There is no public source/demo publication or GASOK submission.
- Mainnet, real customer funds, stablecoins, production wallet/session security and independent contract audit remain out of scope.

## Retained prior-closure sign-off

The block below preserves the pre-Phase-4 closure's historical counts and same-EOA boundary; only its reviewer-index pointer is refreshed to the current resealed Phase 4 index. The historical counts must not be reused as the final Phase 4 validation result. Current full-suite and regenerated reviewer-package results appear above.

```text
status: PASS_APPROVED_TESTNET_SCOPE
executed_at: 2026-07-20
commit: uncommitted_workspace_snapshot
node: 24.14.0; full_node_test_184/184; focused_policy_lifecycle_auth_55/55; reviewer_index_1/1; fail_skip_todo_0
contract_tests: 36/36
compiler: foundry_and_solc-js_0.8.30; optimizer_200; evm_paris; metadata_hash_none_cbor_false; warnings_0
contract_source_sha256: 4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09
contract_artifact_sha256: 4e89c6db0e9cf3bff175ffd0ec3e97206c72f8096e5bec549eaa10b800bcaed3
contract_abi_creation_runtime: 54; 7871/7527_bytes
preflight: offline_31/31; live_read_only_36/36; canonical_flashblocks_heads_31164630/31164630
d1: positive_payer_provider; block_31153475; digest_0x3f15cacd2a712f419d8fb220d6840bfe484504df5d0278a8e57da7a58020fe9c; reconstructed_true
deployment: deployed_testnet; contract_0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53; tx_0x1fda4860da932d6beab0bedd10046d4dc01a21908c5a2ce969a197bce0006908; block_31153615; runtime_true; creation_input_exact_true; source_verified_blockscout_partial_expected_no_cbor
source_level: canonical_digest_0x00f73d87a383e425f2c179d776dc7f76c3fb9b13bd0c9374d624f125593497ca; file_sha256_345bcd3f8d17aa8d750264df135e4c6e189de0fc164424af57d3631b51539986
reviewer_index_current: canonical_digest_0x30e5f155ac7b4caeee4a8b149ff653f9c4b82b220b777c09a6344f4cf99e2be5; post_phase4_resealed
signed_release: job_0xa3e3f4a98d9a6c28c6be6f42159eb8950c347b5ca520636cf16c99e6ed6cd0a9; tx_0xacc9adae988c5094459dec4ff097b4641b608de03a6f0ab820367a6521c87ce2; payment_completed_true; canonical_steps_5/5
signed_refund: job_0x5f7f7075eac19ed40139af4de22d905d34f67303a8d7564599ea86c480dcbaf5; tx_0x12b65cd22071206fc9a0bfdf62efad91a1eee526fb83cb21dfa0f8fb99104fa6; payment_completed_false; refunded_true; canonical_steps_4/4
auth_v1: release_anchor_0x6e1cbe55b2a964388339a1f2912953707a0881c289e2579c92f384384909da5d; refund_anchor_0xbef25cd50a0d5582718a20b818bba43acd587ea69758005689362b2fc82f2be3; overall_authenticated_true
recovery: completed_journals_retained; active_lifecycle_auth_lock_none; active_lifecycle_auth_lease_none
backend_assertions: 184/184
browser_assertions: HOLD; desktop_1440x1100_mobile_390x844; overflow_0_both; console_errors_0; page_errors_0; request_failures_0; http_ge_400_0; local_READY_no_chain_job; repeat_approve_disabled; chain_controls_disabled; keyboard_not_separately_measured
video: artifacts/demo/xpayr-giwa-agentpay-local-fixture.mp4; sha256_3d80fda5ee8064abd499b1a5d8fa27739f8217aa33d84b7bfa3a298531a6f1e5; h264_video_only_no_audio; 1280x720; 25fps; 125.960s; 2069692_bytes; clean_decode; three_sampled_frames_checked; local_fixture_not_chain_proof; not_published
evidence: valid_true; producer_authenticated_false; non_repudiation_false; overall_pass_false; digest_0x7f21b84c7f592d52b65a502aed4b18b0af56b6671bc341924f37b5ca466e67ba; file_sha256_74d53739e635a6dceac90089a0298a55c3699cd558584c7c8e34a516329b461f
giwa_evidence_level: G3_release_and_refund
dojang_evidence_level: positive_D1
remaining_boundaries: original_d3_and_local_fixture_unauthenticated; same_eoa_no_separation_of_duties; eoa_control_not_legal_identity; keyboard_navigation_not_separately_measured; no_publication_submission
reviewer: local project verification only; not an independent security audit
```

Do not mark `PASS` if a required suite is pending or skipped, a checksum is described as producer authenticity, an evidence distinction is ambiguous, or a live claim lacks its corresponding wallet, chain, event/state, and attestation material.
