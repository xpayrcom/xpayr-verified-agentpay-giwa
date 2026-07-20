# Security Policy and Operational Boundaries

XPAYR Verified AgentPay for GIWA is a local, testnet-targeted MVP. It is not audited production software and must not handle real customer funds.

## Supported scope

| Surface | Current status |
|---|---|
| Local policy, intent, evidence, and UI prototype | MVP scope |
| Local EVM escrow tests | MVP scope |
| GIWA Sepolia (`91342`) | Deployed test network; D1/D2/D3 evidence retained |
| Native test ETH | Only supported demo asset |
| GIWA Mainnet | Unsupported |
| Stablecoins or real-value tokens | Unsupported |
| Production merchant traffic | Unsupported |
| KYC/AML, sanctions, credit, or legal decisioning | Not provided |
| Automatic AI evaluator release | Prohibited by MVP design |
| Browser wallet execution | Phase 4 local `live_wallet` mode; participant-directed GIWA Sepolia requests only |
| Reviewer package | Exact allowlist/manifest-bound, secret-minimal local export; not yet published |
| Phase 4 authority profile | Active; two fresh profile-bound lifecycles and two canonically anchored auth-v2 artifacts retained |

Current operational checkpoint: `source_verified_partial_no_cbor_phase4_sod_auth_v2_complete`. Positive same-block D1, one GIWA Sepolia deployment, Blockscout source-visible verification, the preserved historical D3/auth-v1 records, and fresh bounded native-test-ETH Phase 4 `RELEASED` and `REFUNDED` lifecycles with auth-v2 sidecars are retained under `evidence/`. The contract is `0x7b0630cBb92be8E11512cb331b8D1aef94cEEc53`; runtime code, immutable-aware bytecode, exact creation input, and explorer/local source SHA-256 checks passed. Blockscout reports `is_verified=true`, `PARTIAL=true`, `FULL=false`, which is expected for the retained `bytecodeHash=none` / `appendCBOR=false` build; obtaining `FULL` would require a different CBOR-enabled deployment and was not attempted. The full Node suite passes `221/221`, focused lifecycle hardening passes `47/47`, and the retained Foundry result is `36/36`. Participant and authority signers were loaded from repository-external exact-`0600` files, no private key or raw signed transaction was printed or persisted, completed journals remain for audit, and active execution/authentication locks and leases are absent. The final generated package was rebuilt and independently verified from the checked-in `81`-file reviewer allowlist. Public publication and GASOK submission have not occurred, and this remains unaudited testnet software.

Phase 4 adds a separate local wallet/reviewer hardening checkpoint without changing the retained deployment or historical evidence. In `live_wallet` mode, unauthenticated local `approve` and `reject` decisions are rejected and execution bridging requires a direct policy `ALLOW` with approval status `NOT_REQUIRED`; the address-only `HOLD` decision flow remains fixture-only. Browser transactions are prepared as immutable decoded-calldata previews under a synchronous intent/job context lock. Send revalidates the exact chain, account, allowed role, reviewed escrow address/runtime bytecode, value, gas, fee, and aggregate-cost caps; each preview is one-shot, only one send may be in flight, and wallet rejection is never auto-retried. A terminal transaction hash is recorded immediately after the participant wallet returns it, before optional Flashblocks observation, while completion remains canonical-receipt/event/job-state-only. Reload recovery is available from the in-memory server record for the same running local process; it is not durable production recovery.

The active public Phase 4 profile `phase4_sod_v1` binds policy authority `0x89128251A3B46328Dc89A13B58C1339217B2fD34` and evidence producer `0x79E5c4591691a8369CE4537c25cF1aa3DDe65b45` to GIWA Sepolia, the retained escrow/deployment, and canonical profile digest `0x766385f57fa89d679c5c8fc0222f5b765baceeb9899707b5fafe8df3fc881187`. A fresh release completed `5/5` canonical steps and an independent refund completed `4/4`; their auth-v2 sidecars report `overall_authenticated=true` and canonically anchor `XPA2` bindings in transactions `0x4463689c212a93a679e8f3ce1209d2d86d1f522a6798bc6de151a63174558ba9` and `0x8696c471adf870f2268515537c7be7f6989e8c5011c38256e846b56278807650`. These records prove control of the named distinct testnet EOAs for the exact profile/policy/lifecycle/file bindings only. They do not establish separate organizations, independent review, legal identity, or production key governance. The retained auth-v1 artifacts remain unchanged and still reuse the original `0xB209dd7408FFD12A8575a429be946DeD5FbaD732` EOA as payer, policy authority, and evidence producer.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the XPAYR project maintainers through an established private project channel. Do not publish exploitable details, private keys, access tokens, customer information, or an active testnet exploit before maintainers can investigate.

Include:

- affected commit and file;
- expected and observed behavior;
- minimal reproduction using local tests or valueless test ETH;
- impact and prerequisite roles;
- whether any secret or fund exposure may have occurred;
- suggested mitigation, if known.

No public bug-bounty or reward is promised by this MVP documentation.

## Security invariants

- Wrong chain is a hard failure; canonical terminal proof and Dojang reads each query live `eth_chainId` and require `91342` rather than trusting configuration alone.
- `DENY` never produces an executable escrow request.
- `HOLD` never becomes live executable authority without authenticated human approval. Phase 4 has not implemented that authentication boundary, so `live_wallet` rejects local `approve` and `reject` routes and permits execution bridging only from a direct `ALLOW` decision.
- The local address-only approval/rejection actions are fixture-only demonstrations. They do not authenticate wallet ownership and cannot authorize a live wallet request or real chain action.
- Browser wallet preparation captures the selected intent ID and job ID before asynchronous work begins, permits only one preparation/send context at a time, and invalidates the preview if the active intent, account, chain, or wallet session changes.
- Every wallet preview contains immutable decoded calldata plus exact sender, escrow, chain, value, gas, fee, and maximum requested cost. The send path rechecks account, chain, role, reviewed escrow runtime bytecode, and all caps before requesting `eth_sendTransaction`.
- A prepared wallet request is one-shot; concurrent sends are rejected, a used or rejected preview cannot be replayed, and error code `4001` or equivalent user cancellation is not automatically retried.
- Flashblocks never means completed or settled.
- Only an independent canonical-RPC re-fetch of the receipt, transaction, canonical receipt block, and head; recognized release/refund/resolve/timeout calldata; outcome-specific `JobReleased`/`JobRefunded`/`DisputeResolved` events; and a matching zero-balance `RELEASED`/`REFUNDED` on-chain job can confirm a terminal action.
- A verified release may set payment `completed=true`; a verified refund is terminal recovery with `refunded=true` and must always preserve `completed=false`.
- Aggregate Dojang `isVerified=false`, unknown/unavailable, malformed, unpinned, or non-allowlisted results are not verified.
- The contract and lifecycle adapter authorize only from block-hash-pinned aggregate Dojang `isVerified`. The dedicated D1 recorder separately validates positive UID/EAS recipient, schema, official attester, revocation, expiration, issue time, and decoded value at the same block. Aggregate-only lifecycle evidence must keep unavailable EAS fields `not_separately_queried`.
- Contract-level Dojang verification is mandatory and has no per-job disable mode.
- Exactly two distinct immutable constructor attesters are accepted: `UPBIT_KOREA` and `TESTNET_FAUCET`.
- Each job binds `expectedAmount`, `expiresAt`, roles, and `policyDecisionHash`; funding must equal `expectedAmount` exactly.
- A signed-policy execution must verify the configured authority EOA, exact `ALLOW` decision, validity window, record/intent IDs, network, escrow, roles, job ID/nonce, amount, expiry, outcome, and deliverable before signer loading. Fresh execution checks validity again immediately before lock/broadcast; resume may skip only current freshness and must retain every signature and exact journal binding.
- XPAYR derives the trusted `jobNonce`; callers cannot supply `jobId/jobNonce`; the contract requires the job ID to equal `keccak256(abi.encode(msg.sender, jobNonce))` and stores the nonce for canonical verification.
- Payer/provider and job nonce cannot be zero. A release must canonically match the exact submitted deliverable hash; a refund must retain the zero deliverable hash and rejects a non-zero CLI claim.
- No job may be funded, released, or refunded twice.
- The provider cannot unilaterally approve and pay itself.
- XPAYR does not pool funds or keep participant private keys.
- Evidence must identify `giwa-testnet`, chain ID `91342`, and its evidence level.
- A bare evidence checksum is an internal reproducibility/out-of-sync-mutation check only; it is not a signature, producer-authentication proof, on-chain anchor, non-repudiation mechanism, or general tamper guarantee.
- An auth-v1 sidecar is valid only when its source file SHA-256, lifecycle digest, signed-policy digest, EIP-712 producer signature, expected EOA sender/recipient, zero value, canonical receipt/block, and decoded `XPA1` anchor calldata all agree. It proves control of that configured testnet EOA for the signed/anchored binding only.
- The retained auth-v1 testnet evidence intentionally reuses one EOA as deployer, payer, policy authority, and evidence producer. It has no separation of duties and must not be presented as independent attestation, XPAYR legal identity, or legal non-repudiation.
- The active Phase 4 profile uses distinct policy-authority and evidence-producer EOAs and validates their separation from runtime roles. Two fresh policy/lifecycle/auth-v2 proof sets and their canonical `XPA2` anchors now exist. They prove only the exact cryptographic EOA-role bindings represented by those artifacts, not independent organizational control, factual correctness, legal identity, or production custody.
- Terminal wallet submission records only the exact returned transaction hash immediately. Flashblocks remains pending-only; canonical completion still requires the independently fetched transaction, receipt, canonical block/head, decoded terminal event, and matching zero-balance terminal job state. A same-process reload may recover the stored pending hash, but the in-memory store is not durable.
- The reviewer export must match its embedded allowlist and manifest exactly: metadata, limits, boundaries, ordered file set, per-file byte counts/digests, total bytes, and canonical manifest digest. Extra or missing files fail verification.
- Reviewer packaging rejects symlinks, non-regular files, path traversal, forbidden private/runtime paths, populated secret fields/assignments, private-key-shaped content, and serialized raw transactions. A staged package is verified before publication, and an existing output is replaced only after it verifies as the same package and snapshot; an unverified or differently identified directory is preserved and causes failure.
- Arc artifacts and transactions are invalid as GIWA success proof.
- Native test ETH must never be labeled as USDC, KRW stablecoin, or production money.

## Secret handling

Never commit or expose:

- private keys, mnemonics, keystore passwords, or wallet backup material;
- API keys, bearer tokens, webhook secrets, cookies, or session values;
- private RPC credentials;
- raw confidential deliverables or customer records.

Use dedicated test-only wallets. Keep signer values in an absolute real path outside the entire repository, in a current-user-owned regular file with no symlink or additional hard links and exact `0600` permissions; pass only that path through `GIWA_AGENTPAY_ENV_FILE`. The execute-only loader also rejects duplicate/unsupported variables, missing active-role keys, oversized files, and any ambient signer collision. Read-only preflights do not load it, and D3 delays loading until deployment/D1/fee/balance/journal gates pass. Do not pass a key as a visible CLI argument, print or paste it into chat/preflight output, embed it in frontend JavaScript, record it in demo video, or copy it into evidence.

The Phase 4 policy/evidence authority keys and the participant keys were used only from repository-external, owner-only exact-`0600` files; no private value or serialized signed transaction was retained in source, evidence, logs, the browser bundle, or the reviewer package. The checked-in profile contains public addresses and a canonical digest only. Do not reconstruct, copy, or substitute operational keys through documentation or reviewer-package tooling; any future testnet funding or transaction still requires an explicitly authorized, bounded flow.

If a secret is exposed, stop using it immediately, rotate/revoke it where possible, preserve only masked incident evidence, and do not attempt to “clean” Git history without project-owner coordination.

## Safe local operation

1. Confirm the repository has no unexpected changes in files you will modify.
2. Run Node and Solidity tests before starting the demo server.
3. Bind the prototype to localhost unless a separately reviewed access layer is added.
4. Treat the in-memory intent store as disposable and non-authoritative.
5. Use fixtures/mocks only in visibly labeled local mode.
6. Keep browser wallet prompts user-directed; the service must not sign silently. Never treat a caller-supplied address alone as proof that its owner approved. In `live_wallet`, use only a direct `ALLOW` intent until a separately reviewed authenticated approval protocol exists.
7. Review immutable decoded calldata and caps before the single explicit send action. Cancel and prepare again after any account, chain, intent, or role change; never reuse a consumed preview or auto-retry a rejected wallet prompt.
8. Record a terminal wallet hash before preconfirmation, but never mark completion until canonical verification succeeds. On reload, recover only the exact same-process stored hash and re-run canonical verification.
9. Build reviewer output from the checked-in exact allowlist, verify the generated manifest/package independently, and refuse to replace an existing unverified or differently identified output.
10. Export only secret-free, minimal evidence.

## Testnet deployment gate

A local test pass is not deployment authorization. Before a GIWA Sepolia deployment or transaction, record:

- dated official network/contract snapshot;
- exact chain ID and RPC preflight;
- reconciled source/artifact hashes, exact Foundry/solc-js compiler parity, optimizer settings, EVM target, metadata settings, constructor arguments—including both distinct immutable Dojang attesters—and expected bytecode; current compiler lock is `0.8.30`, optimizer enabled/runs `200`, EVM `paris`, metadata `bytecodeHash=none`/`appendCBOR=false`; source/artifact SHA-256 values are `4ff7ce24715191f79772ecaed517a39e24a0dadc90695be38bdaec809f9dec09` and `4e89c6db0e9cf3bff175ffd0ec3e97206c72f8096e5bec549eaa10b800bcaed3`;
- confirmed non-zero and distinct deployer/payer and provider public addresses, their positive D1 artifact path/digest, canonical retained-block reconstruction result, balance, and maximum spend;
- explicit approval for deployment/funding;
- contract address, deployment transaction, successful receipt, and explorer link after execution;
- immutable-aware exact runtime-bytecode comparison and immutable-getter validation inside the deploy execution before `evidence.runtimeCodePresent=true` and `evidence.runtimeBytecodeVerified=true` may be recorded; Blockscout source verification is a separate reviewer-visibility action and is independently recorded as top-level `sourceVerification=verified_blockscout` plus `evidence.sourceVerificationLevel=verified_partial_expected_no_cbor`, with matching local/explorer source SHA-256 and byte-for-byte deployment input proof;
- independent canonical receipt, transaction, head, decoded-event, and on-chain-job-state comparison;
- authenticated wallet evidence for any approval used to authorize a chain action;
- native test ETH amount and terminal release/refund event evidence.

`npm run preflight:deploy` is read-only unless explicit execute mode is selected. Execution approval never bypasses positive D1, confirmed-address, balance, secret-file, cost-cap, or journal gates. Execute requires exact chain/network confirmation, reviewed public roles, a validated D1 artifact, a unique run ID, and an explicit maximum-cost cap. Before signer loading, D2 reconstructs the full D1 artifact at its canonical retained block; the signer must match the confirmed deployer. The completed D2 evidence records a successful canonical receipt and exact runtime/immutable checks. D3 independently revalidates D1 and D2, performs fresh Dojang checks, applies job/gas/aggregate caps, and uses one global private lock plus an exclusive per-run journal. Explicit resume accepts only a strict canonical journal prefix, pins receipt-state reads by block hash with canonicality checks before and after, requires exact nonce continuity, and broadcasts only the missing suffix. A pre-create absence is accepted only when pinned revert bytes exactly equal `JobNotFound(expectedJobId)` and the journal is an exact legitimate zero-step/prepared-create state; wrong IDs, trailing bytes, missing/malformed data, later-step `JobNotFound`, inconsistent zero-step status, and pinned-head changes fail closed without broadcast. Completed evidence and journal finalization are idempotent. Any retained active lock still means failure/crash recovery and must not be manually removed before journal and canonical nonce reconciliation; at this checkpoint there is no active lock or resume lease.

Never deploy to Mainnet, guess a token address, reuse an Arc receipt as GIWA proof, or retry a faucet without a bounded plan.

The approved Phase 4 testnet release/refund and both auth-v2 anchors are complete. Profile activation alone is still not transaction authorization: every future live claim independently requires a fresh direct-`ALLOW` policy artifact, exact lifecycle binding, producer signature, zero-value canonical GIWA Sepolia anchor, successful verification, bounded funding, and the secret/journal/cost gates above. The completed Phase 4 artifacts grant no reusable Mainnet, production, publication, or submission authority.

## Evidence and privacy

Evidence should include only data required to reproduce a technical claim:

- schema/version and generation time;
- network key, chain ID, block/transaction/contract identifiers when real;
- normalized policy decision and decision hash;
- XPAYR-derived trusted job nonce, payer-derived job ID, and contract-side derivation result;
- masked or public role addresses;
- Dojang query source, observed live chain ID, attester ID, aggregate `isVerified` lifecycle status, block number/hash, and evidence mode; a dedicated positive D1 artifact must also retain same-block UID/EAS recipient, schema, official registry attester, revocation, expiration, issue time, and decoded value, while aggregate-only lifecycle evidence labels unqueried metadata `not_separately_queried`;
- for a real terminal proof: chain ID, contract address, transaction sender/target/hash, block number/hash, receipt status, and explorer URL;
- asset label `native test ETH`, exact amount, terminal action/outcome, receipt/event/state result, and the release-versus-refund completion distinction;
- local test commands and exact pass/fail counts after final reconciliation;
- required-check booleans and the internal envelope checksum.
- for signed-policy execution: policy artifact path/digest, policy decision hash, authority, typed-data digest, validity interval, record/intent IDs, and exact job binding;
- for auth-v1: source file SHA-256/digest, signed-policy digest, configured producer address, producer typed-data digest/signature verification result, attestation ID, anchor transaction/block/hash, and canonical anchor verification result.
- for auth-v2: the exact active authority-profile ID/digest, distinct configured policy/evidence public addresses, signed-policy/lifecycle/file bindings, producer typed-data proof, terminal transaction binding, decoded `XPA2` payload, and canonical zero-value anchor result. The public profile by itself is not an auth-v2 artifact.

The two original 2026-07-19 D3 files prove only that a CLI-supplied `policyDecisionHash` was bound to each on-chain job; they remain unchanged and explicitly retain `not_provided_cli_hash_only`. The newer `signed-release-*` and `signed-refund-*` D3 files instead require a persisted EIP-712-signed XPAYR policy artifact and exact policy/job binding before execution. Historical evidence is never rewritten to imply a later proof level.

Evidence must not include secrets, raw deliverables, unneeded personal data, or fabricated explorer links. A local fixture must say `local_fixture`; an RPC connectivity check must not say `deployed`; a transaction without a confirmed receipt must remain `pending` or `unconfirmed`.

Canonical serialization plus SHA-256 makes each export deterministic and can expose accidental or out-of-sync mutation when compared with a separately trusted checksum. Anyone who edits a checksum-only payload can recompute it. The two newer auth-v1 sidecars add verified testnet-EOA producer signatures and canonical GIWA anchors for their exact lifecycle/policy/file bindings. The local fixture and original D3 files remain unauthenticated. The Phase 4 auth-v2 sidecars additionally bind the active profile, distinct policy/evidence EOAs, signed policy, lifecycle/file digests, producer signature, terminal transaction, and canonical `XPA2` anchor. Neither version proves corporate identity, independent audit, factual correctness, legal non-repudiation, separate organizations, or production key governance.

## Dependency and contract changes

- Pin dependencies where practical and review lockfile changes.
- Re-run all local tests after changes to policy fields, hashing, state transitions, role checks, Dojang decoding, receipt verification, or evidence canonicalization.
- Treat an asset adapter, external callback, proxy/upgrade mechanism, paymaster, session key, or wallet SDK as a new security boundary requiring a threat-model update.
- An independent audit is required before any proposal to handle real value.

## Incident response

For an unexpected local or testnet result:

1. Stop new transactions; do not hide or overwrite the evidence.
2. Record chain, contract, job, transaction, block, expected state, and observed state without secrets.
3. Determine whether the signal is Flashblocks-only, standard-RPC confirmed, or merely UI state.
4. Independently re-read the receipt, transaction, current head, decoded event, and on-chain job state from the standard GIWA Sepolia RPC.
5. Preserve the relevant evidence envelope and test output.
6. If a test key may be compromised, retire it and use a new test-only wallet.
7. Patch locally, add a regression test, and repeat the release gate before any further transaction.

There is no production pause authority or customer-support promise in this MVP.

## Security limitations

Passing tests does not constitute an audit. Testnet value may still have operational sensitivity, RPC responses may be unavailable, human evaluators may make poor decisions, and a deliverable hash proves commitment—not correctness or quality. See [THREAT_MODEL.md](THREAT_MODEL.md) for detailed threats and residual risks.
